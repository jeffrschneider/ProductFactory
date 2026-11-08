// The lifecycle document (CommonAgent/adlc standards/lifecycle-document.schema.json,
// version 0.1), kept in one file. Product Factory keeps no lifecycle store of
// its own: it uses the adlc console's (CommonAgent/adlc-console
// lib/lifecycle-file.mjs, a pinned git dependency), which reads, checks and
// writes the document, atomically, for the organization and each project.
//
// What this module adds is what a service says and a file does not:
//
//   - which stages this service cannot build without (can_leave_out false, why_not),
//     and the refusal to leave one out;
//   - the stages and roles answers hold only the stages and roles of stages.json,
//     as lifecycle API 0.3 says; stages of the document's own stay in the file and
//     are named to a build that starts under them, which milestone 1 does not run;
//   - the lifecycle in effect when a build starts, which the build keeps;
//   - the fields of the document this service's copy of the schema has and the
//     pinned console's copy does not know yet (none at the pinned console; this
//     is how approvers were kept before it knew them): the console's store is
//     handed the file without them, and they are put back whenever it writes,
//     so neither copy loses what the other keeps. A field both copies know is
//     checked by the console's store like any other: a wrong entry makes the
//     file invalid, named in words.

import { readFile, writeFile, rename, mkdir, unlink } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createLifecycleFile } from "adlc-console/lib/lifecycle-file.mjs";
import { STAGES_DOC, DOCUMENT_SCHEMA } from "./standards.mjs";

const CONSOLE_SCHEMA = JSON.parse(readFileSync(createRequire(import.meta.url).resolve("adlc-console/standards/lifecycle-document.schema.json"), "utf8"));
/** Fields of a scope this service reads that the console's file store does not know yet. */
export const NEWER = Object.keys(DOCUMENT_SCHEMA.$defs.Scope.properties).filter((k) => !(k in CONSOLE_SCHEMA.$defs.Scope.properties));

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const scopesOf = (doc) => [["", doc.organization], ...Object.entries(isObj(doc.projects) ? doc.projects : {})].filter(([, sc]) => isObj(sc));

/** The file system the console's store is given: it reads the document without NEWER, and writes them back in. */
function keepingNewer(path) {
  const file = resolve(path);
  const parse = (text) => { try { const d = JSON.parse(String(text).replace(/^﻿/, "")); return isObj(d) ? d : null; } catch { return null; } };
  return {
    rename, mkdir, unlink,
    async readFile(f, enc) {
      const text = await readFile(f, enc);
      const doc = resolve(f) === file && NEWER.length ? parse(text) : null;
      if (!doc) return text;
      for (const [, sc] of scopesOf(doc)) for (const k of NEWER) delete sc[k];
      return JSON.stringify(doc);
    },
    async writeFile(f, text, enc) {
      const doc = String(f).startsWith(`${file}.`) && NEWER.length ? parse(text) : null;
      const now = doc ? parse(await readFile(file, "utf8").catch(() => "")) : null;
      if (!now) return writeFile(f, text, enc);
      for (const [name, sc] of scopesOf(now)) {
        const keep = Object.fromEntries(NEWER.filter((k) => k in sc).map((k) => [k, sc[k]]));
        if (!Object.keys(keep).length) continue;
        const into = name ? ((doc.projects ??= {})[name] ??= {}) : (doc.organization ??= {});
        Object.assign(into, keep);
      }
      return writeFile(f, `${JSON.stringify(doc, null, 2)}\n`, enc);
    },
  };
}

/** The stages this service cannot run a build without, and why, in words. */
export const NEEDED = {
  requirements: "Every build starts at Requirements: Test and Code are written from the spec it hands back, so this service cannot build without it.",
  test: "Code is written to Test's suite, and the suite is Code's gate, so this service cannot build without it.",
  code: "Code is what a build makes, so this service cannot build without it.",
};

export class Refused extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const IDS = new Set(STAGES_DOC.stages.map((s) => s.id));

/** The console's stages answer as this service gives it. */
function ourStages(body) {
  return {
    ...body,
    stages: body.stages.filter((s) => !s.added && IDS.has(s.stage)).map((s) => {
      const out = { stage: s.stage, name: s.name, phase: s.phase, roles: s.roles, used: s.used, from: s.from, can_leave_out: true };
      if (!NEEDED[s.stage]) return out;
      // A stage this service cannot build without is always used; a false in the file is not followed.
      return { ...out, used: true, from: s.used ? s.from : "default", can_leave_out: false, why_not: NEEDED[s.stage] };
    }),
  };
}

/** The console's roles answer as this service gives it: the roles of stages.json. */
function ourRoles(body) {
  return { ...body, roles: body.roles.filter((r) => !r.added) };
}

/** path: the lifecycle document. */
export function createLifecycle({ path }) {
  const file = createLifecycleFile({ path, stagesDoc: STAGES_DOC, fsImpl: keepingNewer(path) });
  const query = (project) => new URLSearchParams(project ? { project } : {});

  async function call(method, rest, project, body = {}) {
    const r = await file.handle(method, `/v1/lifecycle/${rest}`, query(project), body);
    if (r.status !== 200) throw new Refused(r.status, r.body?.error ?? "The lifecycle file could not be read.");
    return r.body;
  }

  return {
    file: file.file,
    /** Reads the file, making it when it is missing. Resolves to the problem in words, or null. */
    check: () => file.check(),
    stages: async (project) => ourStages(await call("GET", "stages", project)),
    roles: async (project) => ourRoles(await call("GET", "roles", project)),
    async setStage(stage, project, used) {
      if (!IDS.has(stage)) throw new Refused(400, "There is no stage by that name in stages.json.");
      if (used === false && NEEDED[stage]) throw new Refused(400, NEEDED[stage]);
      return ourStages(await call("PUT", `stages/${encodeURIComponent(stage)}`, project, { used }));
    },
    async clearStage(stage, project) {
      if (!IDS.has(stage)) throw new Refused(400, "There is no stage by that name in stages.json.");
      return ourStages(await call("DELETE", `stages/${encodeURIComponent(stage)}`, project));
    },
    async setRole(role, project, holder) {
      if (!STAGES_DOC.roles.some((r) => r.id === role)) throw new Refused(400, "There is no role by that name in stages.json.");
      if (role === "requester") throw new Refused(400, "The requester is always the person who asked, so it cannot be given to anything else.");
      return ourRoles(await call("PUT", `roles/${encodeURIComponent(role)}`, project, { holder }));
    },
    async clearRole(role, project) {
      if (!STAGES_DOC.roles.some((r) => r.id === role)) throw new Refused(400, "There is no role by that name in stages.json.");
      return ourRoles(await call("DELETE", `roles/${encodeURIComponent(role)}`, project));
    },

    /** The lifecycle in effect now, for a build starting under this project: kept with the build, never read again. */
    async snapshot(project) {
      const all = await call("GET", "stages", project);
      const stages = ourStages(all).stages;
      const roles = ourRoles(await call("GET", "roles", project)).roles;
      return {
        project: project ?? null,
        used: Object.fromEntries(stages.map((s) => [s.stage, { used: s.used, from: s.from }])),
        holders: Object.fromEntries(roles.map((r) => [r.role, r.binding?.holder ?? null])),
        added: all.stages.filter((s) => s.added && s.used).map((s) => ({ id: s.stage, name: s.name })),
      };
    },
  };
}
