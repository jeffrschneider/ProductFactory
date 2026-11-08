// The local service: the lifecycle API, version 0.3, at /v1/lifecycle on
// 127.0.0.1, answered from the file store and the lifecycle document. Every
// request carries a key as Authorization: Bearer <key>: a person's own, or the
// service's, which acts as an admin. Who may do what is people.mjs's.
//
//   GET  /me
//   GET  /builds[?archived=1]            POST /builds
//   GET  /builds/:id                     GET  /builds/:id/files?path=<path>
//   POST /builds/:id/actions/:name
//   POST /builds/:id/try                 GET  /builds/:id/tries        (no tries in milestone 1)
//   GET  /stages[?project=]              PUT|DELETE /stages/:stage[?project=]
//   GET  /roles[?project=]               PUT|DELETE /roles/:role[?project=]
//   GET  /people                         the organization's people, teams and projects (Product Factory's own)
//   GET  /analytics?window=7d|30d|all[&project=]   Product Factory's own, not part of the
//                                        lifecycle API standard; answered only with a history

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { localPerson } from "./config.mjs";
import { buildView, listItem } from "./view.mjs";
import { Refused } from "./lifecycle.mjs";
import { createPeople } from "./people.mjs";

const BODY_LIMIT = 1024 * 1024;
const BASE = "/v1/lifecycle";
const TEXT = /\.(md|mjs|js|txt|json|ya?ml|log)$/i;

export function createService({ store, lifecycle, runner, key, person = null, people = null, version = "0.0.0", history = null }) {
  const me = person ?? localPerson();
  const access = people ?? createPeople({ serviceKey: key, admin: me });

  function send(res, status, body, type = "application/json; charset=utf-8") {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    res.writeHead(status, { "content-type": type, "content-length": buf.length, "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(buf);
  }
  const fail = (res, status, error, extra = {}) => send(res, status, { error, ...extra });
  const shown = (r, who) => access.shape(buildView(r, { timeline: runner.timelineOf?.(r) ?? [] }), who);
  const bearer = (req) => /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ""))?.[1] ?? null;

  async function body(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > BODY_LIMIT) throw new Refused(413, "That request is too big.");
      chunks.push(c);
    }
    if (!size) return {};
    let v;
    try { v = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Refused(400, "That request is not JSON."); }
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Refused(400, "That request is not a JSON object.");
    return v;
  }

  async function route(req, res) {
    const url = new URL(req.url, "http://local");
    if (!url.pathname.startsWith(`${BASE}/`) && url.pathname !== BASE) return fail(res, 404, "Nothing here. The lifecycle API is at /v1/lifecycle.");
    const id = access.identify(bearer(req));
    if (!id.person) return fail(res, 401, id.refused);
    const who = id.person;
    const view = (r) => shown(r, who);
    const parts = url.pathname.slice(BASE.length).split("/").filter(Boolean).map((p) => decodeURIComponent(p));
    const m = req.method;
    const project = (url.searchParams.get("project") ?? "").trim() || null;
    if (project && project.length > 200) return fail(res, 400, "A project name is at most 200 characters.");

    if (parts[0] === "me" && parts.length === 1 && m === "GET") {
      return send(res, 200, { account: { email: who.email, name: who.name }, service: { name: "Product Factory" }, version, role: who.role, teams: who.teams });
    }

    if (parts[0] === "people" && parts.length === 1) return m === "GET" ? send(res, 200, access.list()) : fail(res, 405, "People are changed with the command line, not through the API.");

    if ((parts[0] === "stages" || parts[0] === "roles") && parts.length === 2 && (m === "PUT" || m === "DELETE")) access.mustBeAdmin(who);

    if (parts[0] === "stages" && parts.length <= 2) {
      if (parts.length === 1) return m === "GET" ? send(res, 200, await lifecycle.stages(project)) : fail(res, 405, "Not allowed.");
      if (m === "PUT") { const b = await body(req); return send(res, 200, await lifecycle.setStage(parts[1], project, b.used)); }
      if (m === "DELETE") return send(res, 200, await lifecycle.clearStage(parts[1], project));
      return fail(res, 405, "Not allowed.");
    }

    if (parts[0] === "roles" && parts.length <= 2) {
      if (parts.length === 1) return m === "GET" ? send(res, 200, await lifecycle.roles(project)) : fail(res, 405, "Not allowed.");
      if (m === "PUT") { const b = await body(req); return send(res, 200, await lifecycle.setRole(parts[1], project, b.holder)); }
      if (m === "DELETE") return send(res, 200, await lifecycle.clearRole(parts[1], project));
      return fail(res, 405, "Not allowed.");
    }

    // Product Factory's analytics, from its history (history.mjs). Not part of the lifecycle API standard.
    if (parts[0] === "analytics" && parts.length === 1 && history) {
      if (m !== "GET") return fail(res, 405, "Not allowed.");
      return send(res, 200, history.analytics({ window: url.searchParams.get("window"), project }));
    }

    if (parts[0] !== "builds") return fail(res, 404, "Nothing here.");

    if (parts.length === 1) {
      if (m === "GET") {
        const all = url.searchParams.get("archived") === "1";
        return send(res, 200, { builds: store.list().filter((r) => all || !r.archived).map(listItem) });
      }
      if (m === "POST") {
        const r = await runner.start(await body(req), who);
        return send(res, 201, { build: view(r) });
      }
      return fail(res, 405, "Not allowed.");
    }

    const r = store.read(parts[1]);
    if (!r) return fail(res, 404, "There is no build with that id.");

    if (parts.length === 2) return m === "GET" ? send(res, 200, { build: view(r) }) : fail(res, 405, "Not allowed.");

    if (parts[2] === "files" && parts.length === 3 && m === "GET") {
      const want = url.searchParams.get("path") ?? "";
      const f = Object.values(r.stages).flatMap((s) => s.handed_back.files).find((x) => x.path === want);
      const at = f ? store.fileIn(r.id, f.at) : null;
      if (!at) return fail(res, 404, "This build handed back no file at that path.");
      return send(res, 200, readFileSync(at), TEXT.test(want) ? "text/plain; charset=utf-8" : "application/octet-stream");
    }

    if (parts[2] === "actions" && parts.length === 4 && m === "POST") {
      const needs = await body(req);
      try {
        access.mustAnswer(who, r, parts[3]);
        const after = await runner.act(r.id, parts[3], needs, who);
        return send(res, 200, { build: view(after) });
      } catch (e) {
        if (e instanceof Refused && e.build) return fail(res, e.status, e.message, { build: view(e.build) });
        throw e;
      }
    }

    if (parts[2] === "tries" && parts.length === 3 && m === "GET") return send(res, 200, { tries: [] });
    if ((parts[2] === "try" && parts.length === 3) || (parts[2] === "tries" && parts.length === 5)) {
      if (m !== "POST") return fail(res, 405, "Not allowed.");
      return fail(res, 409, "Product Factory has nothing to try yet: trying a build on its pull request, or installed, comes in a later milestone.");
    }
    if (parts[2] === "evidence" && parts.length === 3) {
      if (m !== "POST") return fail(res, 405, "Not allowed.");
      return fail(res, 409, "Product Factory milestone 1 takes no evidence from outside holders yet.");
    }
    return fail(res, 404, "Nothing here.");
  }

  const server = createServer((req, res) => {
    route(req, res).catch((e) => {
      if (res.headersSent) return res.destroy();
      if (e instanceof Refused) return fail(res, e.status, e.message);
      fail(res, 500, `Something went wrong in Product Factory: ${e.message}`);
    });
  });

  return {
    server,
    async listen(port = 0, host = "127.0.0.1") {
      await new Promise((ok, no) => { server.once("error", no); server.listen(port, host, ok); });
      return `http://${host}:${server.address().port}`;
    },
    close: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(() => ok()); }),
  };
}
