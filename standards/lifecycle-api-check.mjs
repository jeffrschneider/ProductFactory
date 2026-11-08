#!/usr/bin/env node
// Checks a running service against the lifecycle API (lifecycle-api.schema.json,
// version 0.4.1): every answer against the schema, and the rules a schema cannot
// say. It only reads. It asks who the key belongs to, reads who holds each
// role and which stages the lifecycle uses, lists the builds, reads each one, reads its tries, and opens the first
// file each build handed back (every file with --all-files).
//
// The rules beyond the schema:
//   - a build lists every stage of stages.json, once each, and no other;
//   - an action acts at a stage the build lists and offers (not not_offered,
//     not_bound, not_applicable or not_used); a state this check does not know
//     reads as not_offered, as a client draws it (the rule since 0.2);
//   - a stage's rounds are newest first (each round's n below the one before);
//   - a build in the list is at a stage of stages.json;
//   - reading a build by its id answers with that build;
//   - every time is ISO 8601 with a zone, and a real date;
//   - the roles answer lists every role of stages.json once, and no other, each
//     with the contract, offering and stages stages.json gives it;
//   - the requester is always held by a person;
//   - a role is unbound exactly when it has no binding, and a project or org
//     binding says that scope;
//   - a role bound to a your_agent or contracted holder names its handle, and
//     one bound to a person or an outside_tool names none;
//   - a not_bound stage has no holder, and one of its roles is unbound in the
//     roles answer for the build's project (or the organization's);
//   - a not_used stage has no holder and has run 0 times;
//   - a build's lifecycle names the build's own project, or null when it has none;
//   - the stages answer lists every stage of stages.json once, in its order, and
//     no other, each with the name, phase and roles stages.json gives it;
//   - it names the project asked about, or null, and a choice comes from the
//     project only when one was asked about;
//   - a stage the service cannot leave out says why not, and is used;
//   - a stage at the default is used.
//
// Version 0.4's answers are checked by the functions below (checkArtifacts,
// checkProducts, checkProduct, checkStageWorkspace, checkMessages,
// checkMessageReply), which a service's own tests and a client call; run()
// reads the 0.3 operations, so a service that does not offer 0.4 still passes.
// Their rules beyond the schema:
//   - an artifact is made at a stage of stages.json, its id is used once in a
//     build, and its summary has its kind's shape (WordsSummary when not made);
//   - a stage workspace's outputs are artifacts of that stage, and what it was
//     given are artifacts the build made;
//   - an open gate's actions are actions the build offers at that stage;
//   - a chat is oldest first, each message at the stage asked about, and a
//     proposal names an action the build offers now.
// Version 0.4.1's boss answers are checked by checkBossMessages, checkBossReply
// and checkBossCommitments. Their rules beyond the schema:
//   - the boss's conversation is oldest first; a route, a drop and each step of
//     a plan are at stages of stages.json, and a plan is in the lifecycle's
//     order with each stage once;
//   - a start_version proposal names the version; a proposal of a build's
//     action names one the build offers now, with its needs, or says when
//     the build will offer it;
//   - a build is started only on a message that confirms a proposal;
//   - commitments are oldest first; a route or a drop names the stage and the
//     message posted there, a proposal carries the person's answer, and a
//     started build carries the confirmation it was started on.
//
//   node standards/lifecycle-api-check.mjs <base> [--key-file <path>] [--stages <path>] [--limit <n>] [--all-files]
//
//   <base>        the service's lifecycle address, e.g. https://example.com/v1/lifecycle/
//   --key-file    a file holding the key; otherwise the key is read from ADLC_API_KEY.
//                 The key is never taken from the command line and never printed.
//   --stages      stages.json; by default the one beside this file
//   --limit       read at most this many builds (default 50)
//   --all-files   open every file each build handed back, not only its first
//
//   exits 0 when nothing is wrong, 1 on any problem, 2 when it could not start
//   needs: node >= 22
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCHEMA = JSON.parse(readFileSync(join(HERE, "lifecycle-api.schema.json"), "utf8"));
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const isType = (v, t) => t === typeOf(v) || (t === "number" && typeof v === "number");
export const isTime = (v) => typeof v === "string" && TIME.test(v) && !Number.isNaN(Date.parse(v));

// The part of JSON Schema 2020-12 the lifecycle API's schema uses, and no more.
function walk(schema, v, at, out) {
  if (schema.$ref) {
    const name = schema.$ref.replace(/^#\/\$defs\//, "");
    const def = SCHEMA.$defs[name];
    if (!def) throw new Error(`the schema has no definition ${schema.$ref}`);
    walk(def, v, at, out);
  }
  if (schema.anyOf) {
    const fits = schema.anyOf.some((s) => { const o = []; walk(s, v, at, o); return o.length === 0; });
    if (!fits) {
      const tried = []; walk(schema.anyOf[schema.anyOf.length - 1], v, at, tried);
      out.push(...(tried.length ? tried : [`${at}: is none of the shapes it may be`]));
    }
  }
  if (schema.type !== undefined) {
    const types = [].concat(schema.type);
    if (!types.some((t) => isType(v, t))) { out.push(`${at}: is ${typeOf(v)}, not ${types.join(" or ")}`); return; }
  }
  if (schema.enum && !schema.enum.includes(v)) out.push(`${at}: is ${JSON.stringify(v)}, not one of ${schema.enum.join(", ")}`);
  if ("const" in schema && v !== schema.const) out.push(`${at}: is ${JSON.stringify(v)}, not ${JSON.stringify(schema.const)}`);
  if (typeof v === "string") {
    if (schema.minLength !== undefined && v.length < schema.minLength) out.push(`${at}: is empty`);
    if (schema.format === "date-time" && !isTime(v)) out.push(`${at}: is ${JSON.stringify(v)}, not an ISO 8601 time with a zone`);
  }
  if (typeof v === "number" && schema.minimum !== undefined && v < schema.minimum) out.push(`${at}: is below ${schema.minimum}`);
  if (isObj(v)) {
    for (const k of schema.required ?? []) if (!(k in v)) out.push(`${at}: has no ${k}`);
    for (const [k, s] of Object.entries(schema.properties ?? {})) if (k in v) walk(s, v[k], `${at}.${k}`, out);
    if (isObj(schema.additionalProperties)) {
      for (const [k, x] of Object.entries(v)) if (!(k in (schema.properties ?? {}))) walk(schema.additionalProperties, x, `${at}.${k}`, out);
    }
  }
  if (Array.isArray(v) && schema.items) v.forEach((x, i) => walk(schema.items, x, `${at}[${i}]`, out));
}

/** The problems with value as the named definition; empty when it fits. */
export function validate(def, value, at = "body") {
  const out = [];
  walk({ $ref: `#/$defs/${def}` }, value, at, out);
  return out;
}

/** The stage ids of a stages.json, in order. */
export function stageIds(path = join(HERE, "stages.json")) {
  return JSON.parse(readFileSync(path, "utf8")).stages.map((s) => s.id);
}

/** The stages of a stages.json, in order, each with its id, name, phase and role_ids. */
export function stageFacts(path = join(HERE, "stages.json")) {
  return JSON.parse(readFileSync(path, "utf8")).stages.map((s) => ({ id: s.id, name: s.name, phase: s.phase, role_ids: s.role_ids ?? [] }));
}

/** The roles of a stages.json, and the roles that hold each stage (added in 1.1.0). */
export function stageRoles(path = join(HERE, "stages.json")) {
  const d = JSON.parse(readFileSync(path, "utf8"));
  return { roles: d.roles ?? [], byStage: Object.fromEntries(d.stages.map((s) => [s.id, s.role_ids ?? []])) };
}

// Who has a handle: an agent on the mesh does, a person and an outside tool do not.
const NEEDS_HANDLE = new Set(["your_agent", "contracted"]);
const NO_HANDLE = new Set(["person", "outside_tool"]);
// The states at which nobody may act on a stage.
const NOT_OFFERED = new Set(["not_offered", "not_bound", "not_applicable", "not_used"]);
// The states this version of the schema names.
export const STATES = SCHEMA.$defs.State.enum;

/**
 * The state a client draws: the state itself when it knows it, and
 * not_offered when it does not (the rule since 0.2). known is the list of
 * states the client knows, this version's by default.
 */
export function drawnState(state, known = STATES) {
  return known.includes(state) ? state : "not_offered";
}

function checkHolder(h, at, p) {
  if (!isObj(h) || typeof h.kind !== "string") return;
  if (NEEDS_HANDLE.has(h.kind) && !(typeof h.handle === "string" && h.handle.length > 0)) p.push(`${at}: a ${h.kind} holder names its handle`);
  if (NO_HANDLE.has(h.kind) && "handle" in h) p.push(`${at}: ${h.kind === "person" ? "a" : "an"} ${h.kind} holder has no handle`);
}

/**
 * The roles answer, against the roles of stages.json (sr, from stageRoles).
 * Returns the problems, and fills `unbound` with the roles nobody holds.
 */
export function checkRoles(body, sr, unbound = new Set()) {
  const p = validate("RolesAnswer", body);
  const list = isObj(body) && Array.isArray(body.roles) ? body.roles.filter(isObj) : [];
  const want = new Map(sr.roles.map((r) => [r.id, r]));
  const listed = list.map((r) => r.role);
  for (const id of new Set(listed)) {
    if (!want.has(id)) p.push(`body.roles: "${id}" is not a role in stages.json`);
    if (listed.filter((x) => x === id).length > 1) p.push(`body.roles: "${id}" appears more than once`);
  }
  const missing = [...want.keys()].filter((id) => !listed.includes(id));
  if (missing.length) p.push(`body.roles: does not list ${missing.join(", ")}`);
  const sorted = (a) => JSON.stringify([...a].sort());
  list.forEach((r, i) => {
    const at = `body.roles[${i}]`;
    const w = want.get(r.role);
    if (w) {
      if (r.contract !== w.contract) p.push(`${at}.contract: is ${JSON.stringify(r.contract)}, not ${w.contract}`);
      if (r.offering !== w.offering) p.push(`${at}.offering: is ${JSON.stringify(r.offering)}, not ${w.offering}`);
      if (Array.isArray(r.stages) && sorted(r.stages) !== sorted(w.stages)) p.push(`${at}.stages: are ${r.stages.join(", ")}, not ${w.stages.join(", ")}`);
    }
    const b = isObj(r.binding) ? r.binding : null;
    if (r.from === "unbound") unbound.add(r.role);
    if (r.from === "unbound" && b) p.push(`${at}: is unbound, but it has a binding`);
    if (r.from !== "unbound" && r.binding === null) p.push(`${at}: has no binding, so it is unbound, not ${r.from}`);
    if (b) {
      if (b.role !== undefined && b.role !== r.role) p.push(`${at}.binding.role: is ${JSON.stringify(b.role)}, not ${r.role}`);
      checkHolder(b.holder, `${at}.binding.holder`, p);
      if (r.from === "project" && !(isObj(b.scope) && typeof b.scope.project === "string")) p.push(`${at}.binding.scope: a project binding names its project`);
      if (r.from === "org" && !(isObj(b.scope) && b.scope.org === true)) p.push(`${at}.binding.scope: an org binding says { "org": true }`);
    }
    if (r.role === "requester" && !(b && isObj(b.holder) && b.holder.kind === "person")) p.push(`${at}: the requester is always held by a person`);
    checkHolder(r.reference_agent, `${at}.reference_agent`, p);
  });
  return p;
}

/**
 * The stages answer (added in 0.3), against the stages of stages.json (facts,
 * from stageFacts), for the project asked about (undefined for none).
 */
export function checkStages(body, facts, project) {
  const p = validate("StagesAnswer", body);
  if (!isObj(body)) return p;
  const asked = project ?? null;
  if ("project" in body && body.project !== asked) p.push(`body.project: is ${JSON.stringify(body.project)}, not the project asked about (${JSON.stringify(asked)})`);
  const list = Array.isArray(body.stages) ? body.stages.filter(isObj) : [];
  const want = new Map(facts.map((s) => [s.id, s]));
  const listed = list.map((s) => s.stage);
  for (const id of new Set(listed)) {
    if (!want.has(id)) p.push(`body.stages: "${id}" is not a stage in stages.json`);
    if (listed.filter((x) => x === id).length > 1) p.push(`body.stages: "${id}" appears more than once`);
  }
  const missing = facts.map((s) => s.id).filter((id) => !listed.includes(id));
  if (missing.length) p.push(`body.stages: does not list ${missing.join(", ")}`);
  const known = [...new Set(listed)].filter((id) => want.has(id));
  const order = facts.map((s) => s.id).filter((id) => known.includes(id));
  if (known.join() !== order.join()) p.push("body.stages: are not in stages.json's order");
  const sorted = (a) => JSON.stringify([...a].sort());
  list.forEach((s, i) => {
    const at = `body.stages[${i}]`;
    const w = want.get(s.stage);
    if (w) {
      if (s.name !== w.name) p.push(`${at}.name: is ${JSON.stringify(s.name)}, not ${w.name}`);
      if (s.phase !== w.phase) p.push(`${at}.phase: is ${JSON.stringify(s.phase)}, not ${w.phase}`);
      if (Array.isArray(s.roles) && sorted(s.roles) !== sorted(w.role_ids)) p.push(`${at}.roles: are ${s.roles.join(", ")}, not ${w.role_ids.join(", ")}`);
    }
    if (s.from === "project" && asked === null) p.push(`${at}: comes from a project, but no project was asked about`);
    if (s.from === "default" && s.used === false) p.push(`${at}: is at the default, which uses every stage, but it is not used`);
    if (s.can_leave_out === false) {
      if (!(typeof s.why_not === "string" && s.why_not.trim())) p.push(`${at}: this service cannot leave out ${s.stage}, so it says why not`);
      if (s.used === false) p.push(`${at}: this service cannot leave out ${s.stage}, so it is used`);
    }
  });
  return p;
}

export function checkMe(body) {
  return validate("MeAnswer", body);
}

export function checkBuildList(body, ids) {
  const p = validate("BuildListAnswer", body);
  if (isObj(body) && Array.isArray(body.builds)) {
    body.builds.forEach((b, i) => {
      if (isObj(b?.at) && typeof b.at.stage === "string" && !ids.includes(b.at.stage)) p.push(`body.builds[${i}].at.stage: "${b.at.stage}" is not a stage in stages.json`);
    });
  }
  return p;
}

/**
 * One build. Given roles ({ unbound, byStage }), a not_bound stage is checked
 * against the roles answer for the build's project.
 */
export function checkBuild(body, ids, id, roles) {
  const p = validate("BuildAnswer", body);
  const b = isObj(body) ? body.build : null;
  if (!isObj(b)) return p;
  if (id !== undefined && b.id !== id) p.push(`body.build.id: is ${JSON.stringify(b.id)}, not the build asked for (${id})`);
  const stages = Array.isArray(b.stages) ? b.stages.filter(isObj) : [];
  const listed = stages.map((s) => s.stage);
  for (const s of new Set(listed)) {
    if (!ids.includes(s)) p.push(`body.build.stages: "${s}" is not a stage in stages.json`);
    if (listed.filter((x) => x === s).length > 1) p.push(`body.build.stages: "${s}" appears more than once`);
  }
  const missing = ids.filter((s) => !listed.includes(s));
  if (missing.length) p.push(`body.build.stages: does not list ${missing.join(", ")} (a stage the service does not run is listed as not_offered)`);
  stages.forEach((s, i) => {
    if (!Array.isArray(s.rounds)) return;
    s.rounds.forEach((r, j) => {
      if (j > 0 && Number.isInteger(r?.n) && Number.isInteger(s.rounds[j - 1]?.n) && !(r.n < s.rounds[j - 1].n)) p.push(`body.build.stages[${i}].rounds[${j}]: rounds are newest first, and n ${r.n} follows n ${s.rounds[j - 1].n}`);
    });
  });
  // The timeline (added in 0.1): bars ordered by start, each ending no earlier than it began.
  (Array.isArray(b.timeline) ? b.timeline : []).forEach((t, i, all) => {
    if (!isObj(t)) return;
    const start = Date.parse(t.start), end = t.end ? Date.parse(t.end) : NaN;
    if (i > 0 && isObj(all[i - 1]) && Date.parse(all[i - 1].start) > start) p.push(`body.build.timeline[${i}]: bars are ordered by start, and this one starts before the bar above it`);
    if (Number.isFinite(end) && end < start) p.push(`body.build.timeline[${i}]: ends before it starts`);
  });
  // A not_bound stage (added in 0.2): nobody holds it, and the roles answer agrees. A build
  // stage's holder may be your coding agent on the pull request, which has no handle, so the
  // handle rule is held only on bindings.
  stages.forEach((s, i) => {
    if (s.state !== "not_bound") return;
    if (s.holder !== null && s.holder !== undefined) p.push(`body.build.stages[${i}]: is not_bound, so nobody holds it, but it names a holder`);
    const held = roles?.byStage?.[s.stage];
    if (roles?.unbound && held?.length && !held.some((r) => roles.unbound.has(r))) p.push(`body.build.stages[${i}]: ${s.stage} is not_bound, but the roles answer${b.project ? ` for project ${b.project}` : ""} has ${held.join(" and ")} held`);
  });
  // A not_used stage (added in 0.3): the build's lifecycle leaves it out, so nobody holds it and it never ran.
  stages.forEach((s, i) => {
    if (s.state !== "not_used") return;
    if (s.holder !== null && s.holder !== undefined) p.push(`body.build.stages[${i}]: is not_used, so nobody holds it, but it names a holder`);
    if (Number.isInteger(s.runs) && s.runs !== 0) p.push(`body.build.stages[${i}]: is not_used, so it has run 0 times, not ${s.runs}`);
  });
  // The build's lifecycle (added in 0.3) is its own project's.
  if (isObj(b.lifecycle) && "project" in b.lifecycle) {
    const own = typeof b.project === "string" && b.project ? b.project : null;
    if (b.lifecycle.project !== own) p.push(`body.build.lifecycle.project: is ${JSON.stringify(b.lifecycle.project)}, not the build's project (${JSON.stringify(own)})`);
  }
  // A state the check does not know reads as not_offered, as a client draws it.
  const offered = new Set(stages.filter((s) => !NOT_OFFERED.has(drawnState(s.state))).map((s) => s.stage));
  (Array.isArray(b.actions) ? b.actions : []).forEach((a, i) => {
    if (isObj(a) && typeof a.stage === "string" && !offered.has(a.stage)) p.push(`body.build.actions[${i}]: "${a.name}" acts at ${a.stage}, a stage the build does not offer`);
  });
  // The build's artifacts (added in 0.4).
  if (Array.isArray(b.artifacts)) p.push(...checkArtifacts(b.artifacts, ids, "body.build.artifacts"));
  return p;
}

// The summary's shape for each kind of artifact (added in 0.4).
const SUMMARY_OF = { statement: "StatementSummary", suite: "SuiteSummary", programs: "ProgramsSummary", findings: "FindingsSummary", security: "SecuritySummary", package: "PackageSummary", run_plan: "RunPlanSummary" };

/** A build's artifacts (added in 0.4): each at a stage of stages.json, each id once, each summary in its kind's shape. */
export function checkArtifacts(list, ids, at = "body.artifacts") {
  const p = [];
  const seen = new Set();
  (Array.isArray(list) ? list : []).forEach((a, i) => {
    const here = `${at}[${i}]`;
    p.push(...validate("Artifact", a, here));
    if (!isObj(a)) return;
    if (typeof a.stage === "string" && !ids.includes(a.stage)) p.push(`${here}.stage: "${a.stage}" is not a stage in stages.json`);
    if (seen.has(a.id)) p.push(`${here}.id: "${a.id}" is used twice`);
    seen.add(a.id);
    if (isObj(a.summary)) {
      const def = a.state === "made" ? SUMMARY_OF[a.kind] ?? "WordsSummary" : "WordsSummary";
      if (a.state === "made" || a.state === "not_made" || a.state === "not_run") p.push(...validate(def, a.summary, `${here}.summary`));
    } else if (a.state === "not_made" || a.state === "not_run") p.push(`${here}: is ${a.state}, so its summary says why in words`);
  });
  return p;
}

/** GET /products (added in 0.4). */
export function checkProducts(body) {
  const p = validate("ProductsAnswer", body);
  const names = (isObj(body) && Array.isArray(body.products) ? body.products : []).map((x) => x?.name);
  for (const n of new Set(names)) if (names.filter((x) => x === n).length > 1) p.push(`body.products: "${n}" appears more than once`);
  return p;
}

/** GET /products/{name} (added in 0.4): the product asked for, its activity newest first. */
export function checkProduct(body, name) {
  const p = validate("ProductAnswer", body);
  if (!isObj(body)) return p;
  if (name !== undefined && body.name !== name) p.push(`body.name: is ${JSON.stringify(body.name)}, not the product asked for (${name})`);
  (Array.isArray(body.activity) ? body.activity : []).forEach((e, i, all) => {
    if (i > 0 && isObj(e) && isObj(all[i - 1]) && Date.parse(all[i - 1].at) < Date.parse(e.at)) p.push(`body.activity[${i}]: the feed is newest first, and this line is newer than the one above it`);
  });
  return p;
}

/**
 * GET /builds/{id}/stages/{stage} (added in 0.4). build: the build's answer
 * ({ build }), when the caller has it, to hold the workspace to it.
 */
export function checkStageWorkspace(body, ids, stage, build) {
  const p = validate("StageWorkspace", body);
  if (!isObj(body)) return p;
  if (stage !== undefined && body.stage !== stage) p.push(`body.stage: is ${JSON.stringify(body.stage)}, not the stage asked for (${stage})`);
  if (Array.isArray(body.outputs)) {
    p.push(...checkArtifacts(body.outputs, ids, "body.outputs"));
    body.outputs.forEach((a, i) => { if (isObj(a) && a.stage !== body.stage) p.push(`body.outputs[${i}]: is made at ${a.stage}, not at ${body.stage}`); });
  }
  const b = isObj(build) ? build.build : null;
  if (isObj(b)) {
    const made = new Set((Array.isArray(b.artifacts) ? b.artifacts : []).filter((a) => isObj(a) && a.state === "made").map((a) => a.id));
    (Array.isArray(body.given) ? body.given : []).forEach((id, i) => { if (!made.has(id)) p.push(`body.given[${i}]: "${id}" is not an artifact the build made`); });
    if (isObj(body.gate) && body.gate.state === "open" && Array.isArray(body.gate.actions)) {
      const offered = new Set((Array.isArray(b.actions) ? b.actions : []).filter((a) => isObj(a) && a.stage === body.stage).map((a) => a.name));
      body.gate.actions.forEach((n, i) => { if (!offered.has(n)) p.push(`body.gate.actions[${i}]: "${n}" is not an action the build offers at ${body.stage}`); });
    }
  }
  return p;
}

/** GET /products/{name}/stages/{stage}/messages (added in 0.4): oldest first, each at the stage asked about. */
export function checkMessages(body, stage) {
  const p = validate("MessagesAnswer", body);
  (isObj(body) && Array.isArray(body.messages) ? body.messages : []).forEach((m, i, all) => {
    if (!isObj(m)) return;
    if (i > 0 && isObj(all[i - 1]) && Date.parse(all[i - 1].at) > Date.parse(m.at)) p.push(`body.messages[${i}]: the chat is oldest first, and this message is older than the one above it`);
    if (stage !== undefined && isObj(m.from) && m.from.stage !== stage) p.push(`body.messages[${i}].from.stage: is ${JSON.stringify(m.from.stage)}, not the stage asked about (${stage})`);
  });
  return p;
}

/** POST /products/{name}/stages/{stage}/messages (added in 0.4). build: the build's answer, to hold a proposal to its actions. */
export function checkMessageReply(body, build) {
  const p = validate("MessageReplyAnswer", body);
  const prop = isObj(body) && isObj(body.reply) && isObj(body.reply.proposes) ? body.reply.proposes : null;
  const b = isObj(build) ? build.build : null;
  if (prop && isObj(b)) {
    const action = (Array.isArray(b.actions) ? b.actions : []).find((a) => isObj(a) && a.name === prop.action);
    if (!action) p.push(`body.reply.proposes.action: "${prop.action}" is not an action the build offers now`);
    else for (const n of action.needs ?? []) if (isObj(n) && !n.optional && !(n.name in (prop.needs ?? {}))) p.push(`body.reply.proposes.needs: has no ${n.name}, which "${prop.action}" needs`);
  }
  return p;
}

// ---------- the boss (added in 0.4.1) ----------

/** A boss message's routes and plan: stages of stages.json, the plan in the lifecycle's order with each stage once, and a start_version proposal naming its version. */
function bossMessageRules(m, ids, at) {
  const p = [];
  if (!isObj(m)) return p;
  for (const [k, r] of [["routed", m.routed], ...(Array.isArray(m.dropped) ? m.dropped.map((d, i) => [`dropped[${i}]`, d]) : [])]) {
    if (isObj(r) && typeof r.stage === "string" && !ids.includes(r.stage)) p.push(`${at}.${k}.stage: "${r.stage}" is not a stage in stages.json`);
  }
  if (Array.isArray(m.plan)) {
    let last = -1;
    const seen = new Set();
    m.plan.forEach((s, i) => {
      if (!isObj(s) || typeof s.stage !== "string") return;
      const n = ids.indexOf(s.stage);
      if (n < 0) p.push(`${at}.plan[${i}].stage: "${s.stage}" is not a stage in stages.json`);
      else if (n < last) p.push(`${at}.plan[${i}]: ${s.stage} comes before the stage above it in the lifecycle, and a plan is in the lifecycle's order`);
      if (seen.has(s.stage)) p.push(`${at}.plan[${i}]: ${s.stage} is in the plan twice`);
      seen.add(s.stage);
      last = Math.max(last, n);
    });
  }
  const prop = isObj(m.proposes) ? m.proposes : null;
  if (prop?.action === "start_version" && !(isObj(prop.needs) && typeof prop.needs.version === "string" && prop.needs.version)) p.push(`${at}.proposes.needs: has no version, which start_version needs`);
  return p;
}

/** GET /products/{name}/boss/messages (added in 0.4.1): oldest first, with routes and plans at stages of stages.json. */
export function checkBossMessages(body, ids) {
  const p = validate("BossMessagesAnswer", body);
  (isObj(body) && Array.isArray(body.messages) ? body.messages : []).forEach((m, i, all) => {
    if (!isObj(m)) return;
    if (i > 0 && isObj(all[i - 1]) && Date.parse(all[i - 1].at) > Date.parse(m.at)) p.push(`body.messages[${i}]: the conversation is oldest first, and this message is older than the one above it`);
    if (ids) p.push(...bossMessageRules(m, ids, `body.messages[${i}]`));
  });
  return p;
}

/**
 * POST /products/{name}/boss/messages (added in 0.4.1). A build is started only
 * on a message that confirms a proposal, and a proposal of a build's action
 * names one the build offers now, with its needs, when the caller has that
 * build's answer (build, as { build }).
 */
export function checkBossReply(body, ids, build) {
  const p = validate("BossReplyAnswer", body);
  if (!isObj(body)) return p;
  const reply = isObj(body.reply) ? body.reply : null;
  if (ids && reply) p.push(...bossMessageRules(reply, ids, "body.reply"));
  if (reply?.started && !(isObj(body.message) && typeof body.message.confirms === "string")) p.push("body.reply.started: the boss started a build, and the person's message confirmed no proposal");
  const prop = isObj(reply?.proposes) ? reply.proposes : null;
  const b = isObj(build) ? build.build : null;
  if (prop && prop.action !== "start_version" && isObj(b) && b.id === prop.build) {
    const action = (Array.isArray(b.actions) ? b.actions : []).find((a) => isObj(a) && a.name === prop.action);
    if (!action && !(typeof prop.when === "string" && prop.when)) p.push(`body.reply.proposes.action: "${prop.action}" is not an action the build offers now, and the proposal does not say when it will be`);
    else for (const n of action?.needs ?? []) if (isObj(n) && !n.optional && !(n.name in (prop.needs ?? {}))) p.push(`body.reply.proposes.needs: has no ${n.name}, which "${prop.action}" needs`);
  }
  return p;
}

/** GET /products/{name}/boss/commitments (added in 0.4.1): oldest first, each kind carrying what makes it checkable against the record. */
export function checkBossCommitments(body, ids) {
  const p = validate("BossCommitmentsAnswer", body);
  (isObj(body) && Array.isArray(body.commitments) ? body.commitments : []).forEach((c, i, all) => {
    if (!isObj(c)) return;
    const at = `body.commitments[${i}]`;
    if (i > 0 && isObj(all[i - 1]) && Date.parse(all[i - 1].at) > Date.parse(c.at)) p.push(`${at}: the list is oldest first, and this one is older than the one above it`);
    if ((c.kind === "routed" || c.kind === "dropped") && (typeof c.stage !== "string" || typeof c.message_id !== "string")) p.push(`${at}: is ${c.kind}, so it names the stage and the message posted there`);
    if (c.kind === "proposed" && (!isObj(c.proposal) || !isObj(c.answer))) p.push(`${at}: is proposed, so it carries the proposal and the person's answer`);
    if (c.kind === "started" && !isObj(c.confirmation)) p.push(`${at}: is started, so it carries the confirmation it was started on`);
    if (ids && typeof c.stage === "string" && !ids.includes(c.stage)) p.push(`${at}.stage: "${c.stage}" is not a stage in stages.json`);
  });
  return p;
}

export function checkTries(body) {
  return validate("TriesAnswer", body);
}

export function checkError(body) {
  return validate("ErrorAnswer", body);
}

/**
 * Reads the service and checks every answer. Returns { calls, problems }, each
 * problem in words with the call it came from. `say` hears one line per call.
 */
export async function run({ base, key, ids, roles: sr = stageRoles(), stages: facts = stageFacts(), limit = 50, allFiles = false, fetch: get = globalThis.fetch, say = () => {} }) {
  const root = new URL(base.endsWith("/") ? base : `${base}/`);
  const problems = [];
  let calls = 0;
  const hide = (s) => (key ? String(s).split(key).join("[key]") : String(s));
  const note = (what, list) => {
    for (const x of list) problems.push(hide(`${what}: ${x}`));
    say(hide(`${list.length ? "FAIL" : "ok  "} ${what}${list.length ? ` (${list.length} problem${list.length === 1 ? "" : "s"})` : ""}`));
  };
  const call = async (path, json = true) => {
    calls++;
    const url = new URL(path, root);
    let r;
    try {
      r = await get(url, { headers: { authorization: `Bearer ${key}`, accept: json ? "application/json" : "*/*" }, signal: AbortSignal.timeout(120_000) });
    } catch (e) {
      return { failed: `could not be reached: ${e?.message ?? e}` };
    }
    const text = await r.text();
    if (!json) return { status: r.status, text };
    let body;
    try { body = JSON.parse(text); } catch { return { status: r.status, failed: `answered ${r.status} with something that is not JSON` }; }
    return { status: r.status, body };
  };
  const answered = async (what, path, check) => {
    const got = await call(path);
    if (got.failed) { note(what, [got.failed]); return null; }
    if (got.status !== 200) {
      const shape = checkError(got.body);
      note(what, [`answered ${got.status}${typeof got.body?.error === "string" ? `: ${got.body.error}` : ""}`, ...shape]);
      return null;
    }
    note(what, await check(got.body));
    return got.body;
  };

  await answered("GET me", "me", checkMe);
  // Who holds each role, for the organization and for each project a build names.
  const unboundIn = new Map();
  const rolesFor = async (project) => {
    const k = project ?? "";
    if (!unboundIn.has(k)) {
      const unbound = new Set();
      const got = await answered(project ? `GET roles?project=${project}` : "GET roles", project ? `roles?project=${encodeURIComponent(project)}` : "roles", (b) => checkRoles(b, sr, unbound));
      unboundIn.set(k, got ? unbound : null);
    }
    return unboundIn.get(k);
  };
  await rolesFor(undefined);
  // Which stages the lifecycle uses, for the organization and for each project a build names.
  const stagesRead = new Set();
  const stagesFor = async (project) => {
    const k = project ?? "";
    if (stagesRead.has(k)) return;
    stagesRead.add(k);
    await answered(project ? `GET stages?project=${project}` : "GET stages", project ? `stages?project=${encodeURIComponent(project)}` : "stages", (b) => checkStages(b, facts, project));
  };
  await stagesFor(undefined);
  const list = await answered("GET builds", "builds", (b) => checkBuildList(b, ids));
  const builds = Array.isArray(list?.builds) ? list.builds.filter((b) => isObj(b) && typeof b.id === "string") : [];
  if (builds.length > limit) say(`reading the first ${limit} of ${builds.length} builds`);
  for (const item of builds.slice(0, limit)) {
    const id = encodeURIComponent(item.id);
    const one = await answered(`GET builds/${item.id}`, `builds/${id}`, async (b) => {
      const project = typeof b?.build?.project === "string" && b.build.project ? b.build.project : undefined;
      const unbound = await rolesFor(project);
      await stagesFor(project);
      return checkBuild(b, ids, item.id, unbound ? { unbound, byStage: sr.byStage } : undefined);
    });
    await answered(`GET builds/${item.id}/tries`, `builds/${id}/tries`, checkTries);
    const files = (one?.build?.stages ?? []).flatMap((s) => (isObj(s?.handed_back) && Array.isArray(s.handed_back.files) ? s.handed_back.files : []));
    const links = [...new Set(files.filter((f) => typeof f?.link === "string" && f.link).map((f) => f.link))].slice(0, allFiles ? undefined : 1);
    for (const link of links) {
      let url;
      try { url = new URL(link, root); } catch { note(`file ${link}`, ["the link is not an address or a path"]); continue; }
      if (url.origin !== root.origin) { say(`skip ${link} (another site, not sent the key)`); continue; }
      const got = await call(url, false);
      note(`GET ${url.pathname}${url.search}`, got.failed ? [got.failed] : got.status === 200 ? [] : [`answered ${got.status}`]);
    }
  }
  return { calls, problems };
}

function args(argv) {
  const out = { base: undefined, keyFile: undefined, stages: undefined, limit: 50, allFiles: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--key-file") out.keyFile = argv[++i];
    else if (a === "--stages") out.stages = argv[++i];
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--all-files") out.allFiles = true;
    else if (a === "--key" || a.startsWith("--key=")) throw new Error("Give the key in a file (--key-file) or in ADLC_API_KEY, never on the command line.");
    else if (a.startsWith("--")) throw new Error(`There is no option ${a}.`);
    else if (out.base === undefined) out.base = a;
    else throw new Error("Give one address. The key goes in a file (--key-file) or in ADLC_API_KEY.");
  }
  if (!out.base) throw new Error("Give the service's lifecycle address, e.g. https://example.com/v1/lifecycle/");
  if (!/^https?:\/\//.test(out.base)) throw new Error("The address starts with https:// (or http:// for a service on this machine).");
  if (!Number.isInteger(out.limit) || out.limit < 1) throw new Error("--limit is a whole number above 0.");
  return out;
}

async function main() {
  let o, key, ids, roles, facts;
  try {
    o = args(process.argv.slice(2));
    key = (o.keyFile ? readFileSync(resolve(o.keyFile), "utf8") : process.env.ADLC_API_KEY ?? "").trim();
    if (!key) throw new Error("No key: put it in a file and give --key-file, or set ADLC_API_KEY.");
    ids = stageIds(o.stages ? resolve(o.stages) : undefined);
    roles = stageRoles(o.stages ? resolve(o.stages) : undefined);
    facts = stageFacts(o.stages ? resolve(o.stages) : undefined);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const { calls, problems } = await run({ base: o.base, key, ids, roles, stages: facts, limit: o.limit, allFiles: o.allFiles, say: (s) => console.log(s) });
  if (problems.length) {
    console.log("");
    for (const p of problems) console.log(`- ${p}`);
  }
  console.log(`\n${calls} call${calls === 1 ? "" : "s"}, ${problems.length} problem${problems.length === 1 ? "" : "s"}, against lifecycle API ${SCHEMA.version}.`);
  process.exit(problems.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
