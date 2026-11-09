// The local service: the lifecycle API, version 0.4.8, at /v1/lifecycle on
// 127.0.0.1, answered from the file store and the lifecycle document. Every
// request carries a key as Authorization: Bearer <key>: a person's own, or the
// service's, which acts as an admin. Who may do what is people.mjs's.
//
//   GET  /me
//   GET  /builds[?archived=1]            POST /builds
//   GET  /builds/:id                     GET  /builds/:id/files?path=<path>
//   POST /builds/:id/actions/:name       also a product's when-needed action, on the build its list names (added in 0.4.4)
//   GET  /builds/:id/stages/:stage       one stage's workspace: given, outputs, gate (added in 0.4)
//   GET  /products[?archived=1]          every product (builds of one name) (added in 0.4)
//   GET  /products/:name                 its builds, run plan and activity (added in 0.4); its setup
//                                        stages and when-needed actions (added in 0.4.2); each setup
//                                        item's form, each action's confirm card, and which version
//                                        runs (added in 0.4.4)
//   GET|POST /products/:name/stages/:stage/messages   the chat with the agent holding a stage (added in 0.4)
//   GET|POST /products/:name/boss/messages   the product's boss: answers, routes, plans, proposals (added in 0.4.1)
//   GET  /products/:name/boss/commitments    everything the boss committed, in full (added in 0.4.1)
//   GET  /builds/:id/features            the build's features matrix (added in 0.4.3)
//   POST /builds/:id/features/:feature/approve|not_now|ask   an answer to one feature proposal (added in 0.4.3)
//   GET  /products/:name/features[?version=]   the product's features matrix, for a version (added in 0.4.3)
//   GET  /products/:name/features/:feature     one feature and its history (added in 0.4.3)
//   POST /builds/:id/features/backfill   the spec writer lists the features of a build made before them (added in 0.4.5)
//   POST /builds/:id/features/approve_all   Approve all: several feature proposals at once (added in 0.4.5)
//   A build's stages and a stage's workspace carry the stage's features (added in 0.4.5)
//   POST /builds with starting_point existing-code and source: a build enters at Reverse engineering (added in 0.4.6)
//   POST /builds/:id/features/:feature/bug|drop   a behavior as built called a bug (a fix item) or dropped (added in 0.4.6)
//   A build's source and a product's source: the commit each build knew, and drift (added in 0.4.6)
//   POST /builds with starting_point as-built-record and source: a build enters at Requirements with the record brought (added in 0.4.7)
//   POST /builds/:id/actions/back_to_requirements { changes }   Code sends the build back to the spec writer (added in 0.4.7)
//   POST /builds/:id/try                 GET  /builds/:id/tries        (no tries in milestone 1)
//   GET  /stages[?project=]              PUT|DELETE /stages/:stage[?project=]
//   GET  /roles[?project=]               PUT|DELETE /roles/:role[?project=]
//   GET  /people                         the organization's people, teams and projects (Product Factory's own)
//   GET  /analytics?window=7d|30d|all[&project=]   Product Factory's own, not part of the
//                                        lifecycle API standard; answered only with a history
//   POST /intake/issues/:number          Product Factory's own, not part of the lifecycle API
//                                        standard: starts the build for one labelled issue now,
//                                        when intake is on (intake.mjs startIssue)

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { localPerson } from "./config.mjs";
import { buildView, listItem, link } from "./view.mjs";
import { artifactsOf, reviewFiles } from "./artifacts.mjs";
import { productList, productView, buildsOf, gateOf, stageWorkspace } from "./products.mjs";
import { createThread, chatOf, answererAt, BACKFILL_TEXT } from "./thread.mjs";
import { createBoss } from "./boss.mjs";
import { stageById } from "./standards.mjs";
import { Refused } from "./lifecycle.mjs";
import { createPeople } from "./people.mjs";
import { createFeatures, registerOf, eventsOf, buildsUpTo, matrixOf, historyOf, proposalView, gateFeatures, entryOf, statementFeatures, slicesOf, countsOf, keepKnownTests, openAsBuilt } from "./features.mjs";
import { createActions } from "./actions.mjs";
import { withForms } from "./setup.mjs";

const BODY_LIMIT = 1024 * 1024;
const BASE = "/v1/lifecycle";
const TEXT = /\.(md|mjs|js|txt|json|ya?ml|log)$/i;

export function createService({ store, lifecycle, runner, key, person = null, people = null, version = "0.0.0", history = null, config = null, env = process.env, thread = null, intake = null }) {
  const me = person ?? localPerson();
  const access = people ?? createPeople({ serviceKey: key, admin: me });
  const chat = thread ?? (config ? createThread({ store, config, env }) : null);
  const boss = createBoss({ store, runner, chat: chat ?? { newId: () => "t_000000000000" } });
  const features = createFeatures({ store });
  // The when-needed actions on a product (added in 0.4.4): actions.mjs.
  const whenNeeded = createActions({ store, config, lifecycle, access, env, startDrift: (prev, version, who) => runner.startDrift(prev, version, who) });

  function send(res, status, body, type = "application/json; charset=utf-8") {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    res.writeHead(status, { "content-type": type, "content-length": buf.length, "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(buf);
  }
  const fail = (res, status, error, extra = {}) => send(res, status, { error, ...extra });
  /** The builds of r's product, from the store (r itself when it is not kept yet). */
  const productBuilds = (r) => { const all = store.list().filter((b) => b.name === r.name); return all.some((b) => b.id === r.id) ? all : [...all, r]; };
  /** The product's features as of build r (features.mjs), folded from every build up to it. */
  const registerAt = (r, builds = productBuilds(r)) => registerOf(eventsOf(buildsUpTo(builds, r)));
  const artifactsFor = (r) => {
    const reg = registerAt(r);
    return artifactsOf(r, { dir: store.folder(r.id), link: (p) => link(r.id, p), features: reg.size ? statementFeatures(reg) : null });
  };
  /** What Requirements handed back, made: the spec (0.4.8), else, for a build from before it, the statement of the job. */
  const specOf = (arts) => arts.find((a) => a.id === "spec" && a.state === "made") ?? arts.find((a) => a.id === "statement" && a.state === "made") ?? null;
  /** Whether this person may answer Requirements on build r, so may approve a feature: people.mjs's word. */
  const requirementsGate = (r, who) => access.gate(who, "requirements", r.lifecycle?.project ?? null);
  /** A message's feature proposals as this person sees them now: their state, and whether they may approve. */
  const withFeatures = (messages, builds, who) => {
    if (!messages.some((m) => Array.isArray(m.features) && m.features.length)) return messages;
    const events = eventsOf(builds);
    const reg = registerOf(events);
    return messages.map((m) => {
      if (!Array.isArray(m.features) || !m.features.length) return m;
      const b = builds.find((x) => x.id === m.build) ?? builds[0];
      const gate = requirementsGate(b, who);
      return { ...m, features: m.features.map((x) => { const p = events.find((e) => e.kind === "proposed" && e.id === x.proposal); return p ? proposalView(p, reg, gate) : x; }) };
    });
  };
  /**
   * Keeps the features a reply proposes on build r, and shows them as this
   * person sees them. known: the suite's test names when the features are
   * listed after the build (0.4.5); a test mapped to a feature is kept only when
   * the suite has it, and outside a listing no reply maps tests.
   */
  const proposeOn = (r, who, { known = null } = {}) => async (said, from, by) => {
    const builds = productBuilds(store.read(r.id) ?? r);
    const offerings = artifactsFor(r).find((a) => a.id === "statement" && a.state === "made")?.summary?.offerings ?? [];
    const checked = known ? keepKnownTests(said, known) : said.map(({ tests, ...f }) => f);
    const kept = await features.propose(r, builds, checked, { by: by ?? "The boss", from: { ...from, build: r.id }, offerings, listed: Boolean(known) });
    if (!kept.length) return [];
    const after = productBuilds(store.read(r.id));
    const reg = registerOf(eventsOf(after));
    const gate = requirementsGate(r, who);
    return kept.map((p) => proposalView({ ...p, build: r.id, version: r.version }, reg, gate));
  };
  /** The features matrix of build b as this person sees it: each pending proposal with whether they may approve it, and whether the features can be listed after the build (0.4.5). */
  const matrixFor = (builds, b, who) => {
    const gate = requirementsGate(b, who);
    return matrixOf(builds, b, { artifactsFor, pendingView: (p, reg) => proposalView(p, reg, gate), backfill: backfillOf(b) });
  };
  /** The product's features as a prompt reads them: id, words, state. */
  const featureList = (r) => [...registerAt(r).values()].sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  /** The product's builds started before r, newest first, for the setup stages it carries forward (0.4.2). */
  const earlierOf = (r) => { const all = buildsOf(store.list(), r.name); const i = all.findIndex((b) => b.id === r.id); return i < 0 ? [] : all.slice(i + 1); };
  /** A file the build handed back, or a reviewer's document, by its path: its place in the build folder, or null. */
  const fileAt = (r, want) => {
    const f = [...Object.values(r.stages).flatMap((s) => s.handed_back.files), ...reviewFiles(r, store.folder(r.id))].find((x) => x.path === want);
    return f ? store.fileIn(r.id, f.at) : null;
  };
  /** Each every-build stage's features on build r (0.4.5): features.mjs slicesOf. */
  const slicesFor = (r) => slicesOf(productBuilds(r), r, { artifactsFor, textOf: (p) => { const at = fileAt(r, p); if (!at) return null; try { return readFileSync(at, "utf8"); } catch { return null; } } });
  const shown = (r, who) => access.shape(buildView(r, { timeline: runner.timelineOf?.(r) ?? [], artifacts: artifactsFor(r), earlier: earlierOf(r), featureCounts: countsOf(slicesFor(r)) }), who);
  /**
   * Whether the product's features can be listed after build r was made
   * (0.4.5): { offered, words }. Only for a product with no features yet, a
   * spec (or, from before 0.4.8, a statement of the job) to list them from, and a spec writer that answers.
   */
  const backfillOf = (r) => {
    if (registerAt(r).size) return { offered: false, words: "The product has features already. They change in a chat, one at a time." };
    const arts = artifactsFor(r);
    const statement = specOf(arts);
    if (!statement) return { offered: false, words: "There is no spec yet. Once the spec writer makes it, it can list the features from it." };
    if (!chat) return { offered: false, words: "This service was started without its settings, so the spec writer cannot answer." };
    const at = answererAt(r, "requirements");
    if (at.refused) return { offered: false, words: at.refused };
    const suite = arts.find((a) => a.id === "suite" && a.state === "made");
    const n = suite?.summary?.tests?.length ?? 0;
    return { offered: true, words: `The spec writer lists the features of the spec ${statement.version ?? ""}${n ? `, and maps the ${n} tests already in the build to them where their names or content make it clear. A test it cannot tie to a feature is left unmapped` : ""}. They arrive as proposed, for you to approve.`.replace(" ,", ",").replace("  ", " ") };
  };
  /**
   * Lists the product's features after build r was made (0.4.5): the person
   * asks the spec writer in the Requirements chat, and its reply proposes every
   * feature of the statement with the tests that check it. Resolves to
   * { message, reply }. Throws Refused 409 in words when it is not offered.
   */
  const backfill = async (r, who) => {
    const can = backfillOf(r);
    if (!can.offered) throw new Refused(409, can.words);
    const suite = artifactsFor(r).find((a) => a.id === "suite" && a.state === "made") ?? null;
    const tests = suite?.summary?.tests ?? null;
    return stagePost(r, productBuilds(r), "requirements", who, { text: BACKFILL_TEXT }, { backfill: { tests }, extraGiven: suite ? [suite] : [] });
  };
  /** A person's name by email, from people.json, or the email. */
  const personName = (email) => {
    if (!email) return "someone";
    if (String(email).toLowerCase() === String(me.email).toLowerCase()) return me.name;
    return access.list().people.find((p) => p.email.toLowerCase() === String(email).toLowerCase())?.name ?? email;
  };
  /** One stage's workspace, as this person sees it. */
  const workspace = (r, stage, who) => {
    const v = shown(r, who);
    const raw = buildView(r);
    const project = r.lifecycle?.project ?? null;
    const gate = gateOf(r, stage, { dir: store.folder(r.id), actions: v.actions, offered: raw.actions, whoMay: (s) => access.gate(who, s, project).words, personName });
    // At Requirements, with features (0.4.3): the gate shrinks to what the spec leaves open, and the features it starts building with.
    const gf = stage === "requirements" && gate?.state === "open" ? gateFeatures(productBuilds(r), r) : null;
    const asBuilt = gf ? openAsBuilt(productBuilds(r), r) : [];
    const open = gf ? [
      ...(specOf(v.artifacts)?.summary?.open ?? []),
      // 0.4.6: behaviors as built still to answer, which the gate does not approve.
      ...(asBuilt.length ? [`${asBuilt.map((x) => x.id).join(", ")} as built ${asBuilt.length === 1 ? "waits" : "wait"} for your answer in Features: approve each one you want kept, call it a bug, or drop it. The spec is approved after that.`] : []),
    ] : null;
    const out = stageWorkspace(r, stage, { stageView: v.stages.find((s) => s.stage === stage), artifacts: v.artifacts, gate: gf ? { ...gate, open, features: gf } : gate });
    // 0.4.5: the stage's features, for its Artifacts tab.
    const slice = slicesFor(r)[stage];
    if (slice) out.features = slice;
    return out;
  };
  /** A message to the agent holding a stage of build r, from the person or, with boss, from the product's boss on their behalf (thread.mjs post). */
  const stagePost = (r, builds, stage, who, b, { boss: fromBoss = false, backfill: listing = null, extraGiven = [] } = {}) => {
    const v = shown(r, who);
    const raw = buildView(r);
    const project = r.lifecycle?.project ?? null;
    const gateWords = Object.fromEntries(raw.actions.map((a) => [a.stage, access.gate(who, a.stage, project).words]));
    const artifacts = v.artifacts;
    const given = new Set(workspace(r, stage, who).given);
    return chat.post(r, stage, who, b, {
      view: v, offered: raw.actions, gateWords,
      // At Requirements the spec writer made the spec and, from it, the agent's own files (0.4.8): it is shown both.
      given: [...artifacts.filter((a) => given.has(a.id)), ...extraGiven.filter((a) => !given.has(a.id))], outputs: artifacts.filter((a) => a.stage === stage || (stage === "requirements" && a.kind === "statement")),
      history: chatOf(builds, stage), fileAt: (p) => fileAt(r, p), boss: fromBoss,
      features: featureList(r), offerings: artifacts.find((a) => a.id === "statement" && a.state === "made")?.summary?.offerings ?? [],
      proposeFeatures: proposeOn(r, who, { known: listing ? (listing.tests ?? []) : null }),
      backfill: listing,
    });
  };
  const bearer = (req) =>/^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ""))?.[1] ?? null;

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

    // Product Factory's own: start the build for one issue now, rather than at the next poll (intake.mjs).
    // The lifecycle API's start request has no issue, so this is a route of its own, like analytics.
    if (parts[0] === "intake" && parts[1] === "issues" && parts.length === 3) {
      if (m !== "POST") return fail(res, 405, "Not allowed.");
      if (!intake) return fail(res, 409, "This service was started without intake, so no issue can start a build here.");
      if (!/^\d{1,9}$/.test(parts[2])) return fail(res, 400, "An issue is named by its number, such as 12.");
      try {
        const r = await intake.startIssue(Number(parts[2]), who);
        return send(res, 201, { build: view(r) });
      } catch (e) {
        if (e instanceof Refused && e.build) return fail(res, e.status, e.message, { build: view(e.build) });
        throw e;
      }
    }

    if (parts[0] === "products") {
      const all = store.list().filter((r) => url.searchParams.get("archived") === "1" || !r.archived);
      if (parts.length === 1) return m === "GET" ? send(res, 200, { products: productList(all) }) : fail(res, 405, "Not allowed.");
      const name = parts[1];
      const builds = buildsOf(all, name);
      if (!builds.length) return fail(res, 404, "There is no product with that name. A product is every build of one name.");
      if (parts.length === 2) {
        if (m !== "GET") return fail(res, 405, "Not allowed.");
        const current = await lifecycle.snapshot(builds[0].lifecycle?.project ?? undefined);
        const out = productView(all, name, { current, runPlanOf: (r) => { const a = artifactsFor(r).find((x) => x.kind === "run_plan" && x.state === "made"); return a ? { at: a.at ?? null, summary: a.summary, files: a.files } : null; } });
        // 0.4.4: each setup item's form, the when-needed actions with their confirm cards, and which version runs.
        const every = buildsOf(store.list(), name);
        out.setup = withForms(out.setup, { product: name, people: access.list() });
        // 0.4.6: the codebase and the last commit any build knew, which turns Reverse engineering on when the code moved.
        const src = await whenNeeded.source(every);
        out.when_needed = whenNeeded.list(every, current, who, src);
        if (src) out.source = src;
        Object.assign(out, whenNeeded.stateFields(every));
        return send(res, 200, out);
      }
      if (parts[2] === "stages" && parts.length === 5 && parts[4] === "messages") {
        const stage = parts[3];
        if (!stageById.has(stage)) return fail(res, 404, `There is no stage "${stage}" in stages.json.`);
        if (m === "GET") return send(res, 200, { messages: withFeatures(chatOf(builds, stage), builds, who) });
        if (m !== "POST") return fail(res, 405, "Not allowed.");
        const b = await body(req);
        if (b.build !== undefined && typeof b.build !== "string") return fail(res, 400, "build is a build id, as words.");
        const r = b.build ? builds.find((x) => x.id === b.build) : builds[0];
        if (!r) return fail(res, 400, `${name} has no build ${b.build}.`);
        if (!chat) return fail(res, 409, "This service was started without its settings, so no agent can answer.");
        return send(res, 200, await stagePost(r, builds, stage, who, b));
      }
      // The product's boss (added in 0.4.1): boss.mjs.
      if (parts[2] === "boss" && parts.length === 4) {
        if (parts[3] === "commitments") return m === "GET" ? send(res, 200, boss.commitments(builds)) : fail(res, 405, "Not allowed.");
        if (parts[3] !== "messages") return fail(res, 404, "Nothing here.");
        if (m === "GET") return send(res, 200, { messages: withFeatures(boss.messages(builds).messages, builds, who) });
        if (m !== "POST") return fail(res, 405, "Not allowed.");
        const b = await body(req);
        if (!chat) return fail(res, 409, "This service was started without its settings, so the boss cannot answer.");
        const out = await boss.post(name, builds, who, b, {
          view: (r) => shown(r, who),
          offered: (r) => buildView(r).actions,
          gate: (stage, project) => access.gate(who, stage, project),
          artifacts: artifactsFor,
          toStage: (r, stage, text) => stagePost(store.read(r.id), buildsOf(store.list(), name), stage, who, { text }, { boss: true }),
          features: featureList(builds[0]),
          proposeFeatures: (said, from) => proposeOn(builds[0], who)(said, from, "The boss"),
        });
        return send(res, 200, out);
      }
      // Features (added in 0.4.3): the matrix for a version, and one feature's history.
      if (parts[2] === "features" && (parts.length === 3 || parts.length === 4)) {
        if (m !== "GET") return fail(res, 405, "Not allowed.");
        if (parts.length === 4) {
          const one = historyOf(builds, parts[3], { artifactsFor });
          if (!one) return fail(res, 404, `${name} has no feature ${parts[3]}.`);
          const reg = registerOf(eventsOf(builds));
          const f = reg.get(parts[3]);
          const pending = f.pending ? proposalView(f.pending, reg, requirementsGate(builds[0], who)) : null;
          return send(res, 200, { ...one, feature: entryOf(f, pending) });
        }
        const want = (url.searchParams.get("version") ?? "").trim();
        const at = want ? builds.find((b) => b.version === want) : builds[0];
        if (!at) return fail(res, 404, `${name} has no version ${want}.`);
        return send(res, 200, matrixFor(builds, at, who));
      }
      return fail(res, 404, "Nothing here.");
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
      const at = fileAt(r, want);
      if (!at) return fail(res, 404, "This build handed back no file at that path.");
      return send(res, 200, readFileSync(at), TEXT.test(want) ? "text/plain; charset=utf-8" : "application/octet-stream");
    }

    if (parts[2] === "actions" && parts.length === 4 && m === "POST") {
      const needs = await body(req);
      try {
        // A when-needed action on the product (added in 0.4.4), taken on the build its list names.
        if (whenNeeded.isAction(parts[3])) {
          const result = await whenNeeded.run(r.id, parts[3], needs, who);
          return send(res, 200, { build: view(store.read(r.id)), result });
        }
        access.mustAnswer(who, r, parts[3]);
        const after = await runner.act(r.id, parts[3], needs, who);
        // The person's answer to any proposal of this action the boss made on this build.
        await boss.taken(after, parts[3], who, buildsOf(store.list(), r.name));
        // Approving the spec starts building with the features it carries (0.4.3): each one waiting is approved with the gate.
        if (parts[3] === "approve" && r.at === "requirements") await features.gateApproved(store.read(r.id), productBuilds(r), who);
        return send(res, 200, { build: view(store.read(r.id) ?? after) });
      } catch (e) {
        if (e instanceof Refused && e.build) return fail(res, e.status, e.message, { build: view(e.build) });
        throw e;
      }
    }

    // Features (added in 0.4.3): the build's matrix, and an answer to one feature proposal.
    if (parts[2] === "features" && parts.length === 3) return m === "GET" ? send(res, 200, matrixFor(productBuilds(r), r, who)) : fail(res, 405, "Not allowed.");
    // Added in 0.4.5: list the features of a build made before features, and approve several proposals at once.
    if (parts[2] === "features" && parts.length === 4 && parts[3] === "backfill") {
      if (m !== "POST") return fail(res, 405, "Not allowed.");
      await body(req);
      return send(res, 200, await backfill(r, who));
    }
    if (parts[2] === "features" && parts.length === 4 && parts[3] === "approve_all") {
      if (m !== "POST") return fail(res, 405, "Not allowed.");
      const b = await body(req);
      const gate = requirementsGate(r, who);
      const { events: kept, builds: touched } = await features.approveAll(r, productBuilds(r), b.proposals, b, who, gate);
      let statement;
      for (const id of touched) {
        const v = specOf(artifactsFor(store.read(id)))?.version;
        for (const e of kept) await features.noteStatement(id, e.id, v);
        if (id === r.id || !statement) statement = v;
      }
      const after = productBuilds(store.read(r.id));
      const events = eventsOf(after);
      const reg = registerOf(events);
      const approved = kept.map((e) => proposalView(events.find((x) => x.kind === "proposed" && x.id === e.proposal), reg, gate));
      const list = kept.map((e) => { const f = reg.get(e.feature); return entryOf(f, f.pending ? proposalView(f.pending, reg, gate) : null); });
      return send(res, 200, { approved, features: list, ...(statement ? { statement } : {}) });
    }
    if (parts[2] === "features" && parts.length === 5) {
      if (m !== "POST") return fail(res, 405, "Not allowed.");
      const b = await body(req);
      const gate = requirementsGate(r, who);
      const { event, proposalBuild } = await features.decide(r, productBuilds(r), parts[3], parts[4], b, who, gate);
      let statement;
      if (event.kind === "approved") {
        statement = specOf(artifactsFor(store.read(proposalBuild)))?.version;
        await features.noteStatement(proposalBuild, event.id, statement);
      }
      const after = productBuilds(store.read(r.id));
      const events = eventsOf(after);
      const reg = registerOf(events);
      const f = reg.get(parts[3]);
      const p = events.find((e) => e.kind === "proposed" && e.id === event.proposal);
      return send(res, 200, { feature: entryOf(f, f.pending ? proposalView(f.pending, reg, gate) : null), proposal: proposalView(p, reg, gate), ...(statement ? { statement } : {}), ...(event.kind === "asked" ? { told: event.to } : {}), ...(event.kind === "bug" ? { fix: event.fix } : {}) });
    }

    if (parts[2] === "stages" && parts.length === 4) {
      if (m !== "GET") return fail(res, 405, "Not allowed.");
      if (!stageById.has(parts[3])) return fail(res, 404, `There is no stage "${parts[3]}" in stages.json.`);
      return send(res, 200, workspace(r, parts[3], who));
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
    /**
     * Lists the features of a product made before features (0.4.5), on its
     * newest build, as the person who: the command line's
     * `product-factory features backfill <product>`. Resolves to { message, reply }.
     */
    async backfill(name, who = me) {
      const builds = buildsOf(store.list(), name);
      if (!builds.length) throw new Refused(404, `There is no product ${name}. A product is every build of one name.`);
      return backfill(builds[0], who);
    },
    async listen(port = 0, host = "127.0.0.1") {
      await new Promise((ok, no) => { server.once("error", no); server.listen(port, host, ok); });
      return `http://${host}:${server.address().port}`;
    },
    close: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(() => ok()); }),
  };
}
