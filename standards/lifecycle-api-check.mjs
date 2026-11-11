#!/usr/bin/env node
// Checks a running service against the lifecycle API (lifecycle-api.schema.json,
// version 0.4.10): every answer against the schema, and the rules a schema cannot
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
// Version 0.4.2 adds each stage's cadence (stages.json 1.3.0), carried, and a
// product's setup and when_needed lists. Their rules beyond the schema, held by
// checkBuild, checkStageWorkspace and checkProduct against the stages.json
// beside this file (or the cadences a caller passes):
//   - a stage's cadence, when given, is its cadence in stages.json;
//   - carried is only on a setup stage;
//   - setup lists every setup stage once, in stages.json's order, and no other,
//     each with one of its own roles; a chosen one names its holder, and one
//     not chosen or not used names none and no since; a since is a version of
//     one of the product's builds;
//   - when_needed lists every when_needed stage once, in order, and no other;
//     one the service cannot run says why, and one it can run names the action
//     that runs it.
// Version 0.4.4 adds a setup item's form, a when-needed item's needs, confirm
// card and last run, and the product's running and retired. Their rules
// beyond the schema, held by checkProduct:
//   - a choice lists its options and its default is one of them; a number's
//     default is a number; a form names each field once;
//   - only an item that can run has a confirm card; its action names one of
//     the product's builds;
//   - a rollback's card names the version it goes back to, one of the
//     product's, and what can't be undone;
//   - a last run's version and the running build are the product's own;
//   - a retired product runs nothing, and none of its when-needed actions can run.
// Version 0.4.3's features are checked by checkFeatures, checkFeature and
// checkFeatureDecision, and by the 0.4, 0.4.1 and 0.4.2 checks where a message, a
// round or a gate carries them. Their rules beyond the schema:
//   - a matrix's columns are spec, tests, code, review and docs, in that
//     order; each feature is a row once; its version is one of its versions;
//   - a tests or code cell that is failing has fewer tests passed than it
//     has, and one that is done with tests run has them all passed;
//   - a cell opens its artifact at its own feature;
//   - a feature never approved has a spec cell that is missing;
//   - a feature's history is oldest first, an entry linked to a message names
//     it and one linked to an artifact names it, and an approved feature has
//     an approval in its history;
//   - a proposal that is approved or not_now says who answered it and how,
//     one that is asked says who asked whom, and a changed one says what the
//     feature was;
//   - a round's results per feature never pass more tests than it has;
//   - a gate's features are only at Requirements, each feature once.
// Version 0.4.5 adds each stage's features, a matrix row's pending proposal,
// where it came from and its tests, the matrix's unmapped tests and backfill,
// and approve_all, checked by checkBuild, checkStageWorkspace, checkFeatures
// and checkFeatureApproveAll. Their rules beyond the schema:
//   - a stage never covers more features than it has, and a stage workspace's
//     features are its own stage's, with the same count as the build's stage;
//   - a stage lists each feature once; at Test a feature with tests is not to
//     do and one without is; at Code a feature never passes more tests than
//     check it, and one with findings open at Review names one;
//   - a row's pending proposal is a proposal of that feature; a test that
//     checks a feature is not unmapped; backfill is offered only with no features;
//   - approve_all lists every proposal it was asked to approve, each approved,
//     and names the statement's new version.
// Version 0.4.6 adds starting from existing code: the as_built artifact, the
// as-built mark on a feature and a proposal, the bug and drop answers with the
// fix item, and the commit each build knew, checked by checkArtifacts,
// checkFeatures, checkFeatureDecision and checkProduct. Their rules beyond the schema:
//   - an as_built artifact's summary lists its five parts once each, in order,
//     and a drift record names the commit it is described against;
//   - a proposal answered bug or dropped is marked as built and says who answered
//     it; one answered bug carries its fix item, for the same feature;
//   - a product's drift is true exactly when the commit it reads now differs from
//     the last one any build knew.
// Version 0.4.7 adds starting from an as-built record and the action
// back_to_requirements, checked by checkBuild. Its rules beyond the schema:
//   - a build started from an as-built record says where the record was read
//     (source.record);
//   - back_to_requirements acts at Code, and asks for the person's words.
// Version 0.4.9 adds the holder's skills, checked by checkStageWorkspace and
// wherever a holder is checked. Its rules beyond the schema:
//   - a holder lists each skill once, by name;
//   - a holder lists its skills or says why it cannot (skills_note), not both.
// Version 0.4.10 adds feature runs: each feature of a version made in a run of
// its own, on the build (feature_runs) and as a card on the build list, an
// action's run and a timeline bar's run, checked by checkBuild and
// checkBuildList. Their rules beyond the schema:
//   - a build and a list item name each feature run once, and a run's stages
//     are stages of stages.json, each once, with its rounds newest first;
//   - a run's actions each name that run, and are offered only while it is open;
//   - an action or a timeline bar that names a run names one of the build's,
//     and an action that does is on that run's own list too.
// Version 0.4.13 adds each artifact's Common Agent checks, checked by
// checkArtifacts. Their rules beyond the schema, for a made artifact:
//   - each check names its section by number alone, such as 12.6;
//   - a check that is not_checked says why in its detail;
//   - the same section, rule and asks appear once on one artifact.
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
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(v)) out.push(`${at}: is ${JSON.stringify(v)}, which is not in the form ${schema.pattern}`);
  }
  if (typeof v === "number" && schema.minimum !== undefined && v < schema.minimum) out.push(`${at}: is below ${schema.minimum}`);
  if (isObj(v)) {
    for (const k of schema.required ?? []) if (!(k in v)) out.push(`${at}: has no ${k}`);
    for (const [k, s] of Object.entries(schema.properties ?? {})) if (k in v) walk(s, v[k], `${at}.${k}`, out);
    if (isObj(schema.additionalProperties)) {
      for (const [k, x] of Object.entries(v)) if (!(k in (schema.properties ?? {}))) walk(schema.additionalProperties, x, `${at}.${k}`, out);
    }
  }
  if (Array.isArray(v) && schema.minItems !== undefined && v.length < schema.minItems) out.push(`${at}: has ${v.length} items, fewer than ${schema.minItems}`);
  if (Array.isArray(v) && schema.maxItems !== undefined && v.length > schema.maxItems) out.push(`${at}: has ${v.length} items, more than ${schema.maxItems}`);
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

/** Each stage's cadence in a stages.json, by id (added in 1.3.0); empty for an older file. */
export function stageCadences(path = join(HERE, "stages.json")) {
  return Object.fromEntries(JSON.parse(readFileSync(path, "utf8")).stages.filter((s) => typeof s.cadence === "string").map((s) => [s.id, s.cadence]));
}
let cadencesBeside = null;
const CADENCES = () => (cadencesBeside ??= stageCadences());
const ofCadence = (cadences, c) => Object.keys(cadences).filter((id) => cadences[id] === c);

/** A stage's cadence and carried (added in 0.4.2), held to stages.json. */
function cadenceRules(s, at, cadences, p) {
  if (!isObj(s)) return;
  const want = cadences[s.stage];
  if (s.cadence !== undefined && want !== undefined && s.cadence !== want) p.push(`${at}.cadence: is ${JSON.stringify(s.cadence)}, but stages.json gives ${s.stage} the cadence ${want}`);
  if (s.carried !== undefined && want !== undefined && want !== "setup") p.push(`${at}.carried: ${s.stage} is not set up once (its cadence is ${want}), so nothing is carried forward`);
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
  skillRules(h, at, p);
}

/** A holder's skills (added in 0.4.9): each once, and never beside the note that says they cannot be seen. */
function skillRules(h, at, p) {
  if (!isObj(h)) return;
  const names = Array.isArray(h.skills) ? h.skills.filter(isObj).map((s) => s.name) : [];
  for (const n of new Set(names)) if (names.filter((x) => x === n).length > 1) p.push(`${at}.skills: "${n}" is listed more than once`);
  if (Array.isArray(h.skills) && "skills_note" in h) p.push(`${at}: lists its skills and also says they cannot be seen (skills_note); it says one or the other`);
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
      // A card per feature run (added in 0.4.10).
      const cards = Array.isArray(b?.feature_runs) ? b.feature_runs.filter(isObj) : [];
      p.push(...onceEach(cards.map((c) => c.id), `body.builds[${i}].feature_runs`, "feature run"));
      cards.forEach((c, j) => { if (isObj(c.at) && typeof c.at.stage === "string" && !ids.includes(c.at.stage)) p.push(`body.builds[${i}].feature_runs[${j}].at.stage: "${c.at.stage}" is not a stage in stages.json`); });
    });
  }
  return p;
}

/** A name listed more than once, said once for each. */
function onceEach(names, at, what) {
  const out = [];
  for (const n of new Set(names)) if (names.filter((x) => x === n).length > 1) out.push(`${at}: the ${what} ${JSON.stringify(n)} is listed more than once`);
  return out;
}

/** Rounds newest first, n falling, and no feature passing more tests than it has. */
function roundRules(s, at, p) {
  if (!Array.isArray(s.rounds)) return;
  s.rounds.forEach((r, j) => {
    if (j > 0 && Number.isInteger(r?.n) && Number.isInteger(s.rounds[j - 1]?.n) && !(r.n < s.rounds[j - 1].n)) p.push(`${at}.rounds[${j}]: rounds are newest first, and n ${r.n} follows n ${s.rounds[j - 1].n}`);
    // Results per feature (added in 0.4.3).
    (Array.isArray(r?.by_feature) ? r.by_feature : []).forEach((x, k) => {
      if (isObj(x) && Number.isInteger(x.passed) && Number.isInteger(x.total) && x.passed > x.total) p.push(`${at}.rounds[${j}].by_feature[${k}]: ${x.feature} passed ${x.passed} of ${x.total} tests, more than it has`);
    });
  });
}

/**
 * A build's feature runs (added in 0.4.10): each named once, with its own
 * stages, each a stage of stages.json listed once; each of its actions names
 * it and none is offered once it ended; and every action and timeline bar of
 * the build that names a run names one of these, an action being on that
 * run's own list too.
 */
function featureRunRules(b, ids, p) {
  const runs = Array.isArray(b.feature_runs) ? b.feature_runs.filter(isObj) : [];
  p.push(...onceEach(runs.map((x) => x.id), "body.build.feature_runs", "feature run"));
  runs.forEach((fr, i) => {
    const at = `body.build.feature_runs[${i}]`;
    const stages = Array.isArray(fr.stages) ? fr.stages.filter(isObj) : [];
    for (const s of stages) if (typeof s.stage === "string" && !ids.includes(s.stage)) p.push(`${at}.stages: "${s.stage}" is not a stage in stages.json`);
    p.push(...onceEach(stages.map((s) => s.stage), `${at}.stages`, "stage"));
    stages.forEach((s, j) => roundRules(s, `${at}.stages[${j}]`, p));
    (Array.isArray(fr.actions) ? fr.actions : []).forEach((a, j) => {
      if (!isObj(a)) return;
      if (a.run !== fr.id) p.push(`${at}.actions[${j}]: "${a.name}" is this run's, so it names it as run (${JSON.stringify(fr.id)})`);
      if (fr.ended === true) p.push(`${at}.actions[${j}]: "${a.name}" is offered on a run that has ended`);
    });
  });
  const byId = new Map(runs.map((x) => [x.id, x]));
  (Array.isArray(b.actions) ? b.actions : []).forEach((a, i) => {
    if (!isObj(a) || a.run === undefined) return;
    const fr = byId.get(a.run);
    if (!fr) { p.push(`body.build.actions[${i}]: "${a.name}" names the feature run ${JSON.stringify(a.run)}, which the build does not have`); return; }
    if (!(Array.isArray(fr.actions) ? fr.actions : []).some((x) => isObj(x) && x.name === a.name && x.stage === a.stage)) p.push(`body.build.actions[${i}]: "${a.name}" names the feature run ${a.run}, which does not offer it`);
  });
  (Array.isArray(b.timeline) ? b.timeline : []).forEach((x, i) => {
    if (isObj(x) && x.run !== undefined && !byId.has(x.run)) p.push(`body.build.timeline[${i}]: names the feature run ${JSON.stringify(x.run)}, which the build does not have`);
  });
}

/**
 * One build. Given roles ({ unbound, byStage }), a not_bound stage is checked
 * against the roles answer for the build's project.
 */
export function checkBuild(body, ids, id, roles, cadences = CADENCES()) {
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
  stages.forEach((s, i) => roundRules(s, `body.build.stages[${i}]`, p));
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
  // Each feature in a run of its own (added in 0.4.10).
  featureRunRules(b, ids, p);
  // Starting from an as-built record, and back_to_requirements (added in 0.4.7).
  if (isObj(b.source) && b.source.starting_point === "as-built-record" && !isObj(b.source.record)) p.push("body.build.source: the build started from an as-built record, and does not say where the record was read (record)");
  (Array.isArray(b.actions) ? b.actions : []).forEach((a, i) => {
    if (!isObj(a) || a.name !== "back_to_requirements") return;
    if (a.stage !== "code") p.push(`body.build.actions[${i}]: back_to_requirements acts at Code, not at ${a.stage}`);
    if (!(Array.isArray(a.needs) && a.needs.some((n) => isObj(n) && n.kind === "words" && n.optional !== true))) p.push(`body.build.actions[${i}]: back_to_requirements asks for the person's words (a need of kind words that is not optional)`);
  });
  // Each stage's cadence (added in 0.4.2).
  stages.forEach((s, i) => cadenceRules(s, `body.build.stages[${i}]`, cadences, p));
  // Each stage's features (added in 0.4.5).
  stages.forEach((s, i) => { if (isObj(s.features)) p.push(...countRules(s.features, `body.build.stages[${i}].features`)); });  // The build's artifacts (added in 0.4).
  if (Array.isArray(b.artifacts)) p.push(...checkArtifacts(b.artifacts, ids, "body.build.artifacts"));
  return p;
}

// The summary's shape for each kind of artifact (added in 0.4).
const SUMMARY_OF = { spec: "SpecSummary", statement: "StatementSummary", suite: "SuiteSummary", programs: "ProgramsSummary", findings: "FindingsSummary", security: "SecuritySummary", package: "PackageSummary", run_plan: "RunPlanSummary", as_built: "AsBuiltSummary", architecture: "ArchitectureSummary" };

/** The parts of the as-built record, in order (added in 0.4.6). */
export const AS_BUILT_PARTS = ["behaviors", "architecture", "interfaces", "dependencies", "tests_and_gaps"];

/** An as_built summary beyond its shape: its five parts once each, in order, and a drift record names the commit before (added in 0.4.6). */
export function asBuiltRules(s, at) {
  const p = [];
  if (!isObj(s)) return p;
  const parts = Array.isArray(s.parts) ? s.parts.filter(isObj).map((x) => x.part) : [];
  if (parts.length === AS_BUILT_PARTS.length && parts.join(",") !== AS_BUILT_PARTS.join(",")) p.push(`${at}.parts: are ${parts.join(", ")}, not ${AS_BUILT_PARTS.join(", ")} in that order`);
  if (s.trigger === "drift" && !(typeof s.since === "string" && s.since.trim())) p.push(`${at}: is a drift record, so it names the commit it is described against (since)`);
  if (s.trigger === "adoption" && s.since !== undefined) p.push(`${at}.since: an adoption record is described against nothing before it`);
  return p;
}

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
      // An architecture record gives its parts from 0.4.12; one in words alone, as before, is still read as words.
      const parts = a.kind !== "architecture" || Array.isArray(a.summary.systems);
      const def = a.state === "made" && parts ? SUMMARY_OF[a.kind] ?? "WordsSummary" : "WordsSummary";
      if (a.state === "made" || a.state === "not_made" || a.state === "not_run") p.push(...validate(def, a.summary, `${here}.summary`));
      if (a.state === "made" && a.kind === "as_built") p.push(...asBuiltRules(a.summary, `${here}.summary`));
      if (a.state === "made" && a.kind === "security") p.push(...securityRules(a.summary, `${here}.summary`));
      if (a.state === "made" && a.kind === "architecture" && parts) p.push(...architectureRules(a.summary, `${here}.summary`));
    } else if (a.state === "not_made" || a.state === "not_run") p.push(`${here}: is ${a.state}, so its summary says why in words`);
    if (a.state === "made" && Array.isArray(a.checks)) p.push(...checksRules(a.checks, `${here}.checks`));
  });
  return p;
}

const SECTION = /^[0-9]+(\.[0-9]+)*$/;

/**
 * A made artifact's Common Agent checks (added in 0.4.13): each names its
 * section by number, a check not done says why, and one artifact holds the
 * same rule, asked the same way, once.
 */
function checksRules(list, at) {
  const p = [];
  const seen = new Set();
  list.forEach((c, i) => {
    if (!isObj(c)) return;
    const here = `${at}[${i}]`;
    if (!(typeof c.section === "string" && SECTION.test(c.section))) p.push(`${here}.section: names a section by its number alone, such as 12.6`);
    if (c.result === "not_checked" && !(typeof c.detail === "string" && c.detail.trim())) p.push(`${here}.detail: the check was not done, so its detail says why`);
    const key = JSON.stringify([c.section, c.rule ?? null, c.asks]);
    if (seen.has(key)) p.push(`${here}: Section ${c.section}${c.rule === undefined ? "" : `, rule ${c.rule}`}, "${c.asks}", is on this artifact twice`);
    seen.add(key);
  });
  return p;
}

/**
 * The security statement's structured parts (added in 0.4.12): a reach with
 * no reason is one of no_reason_recorded, and a statement with any permission
 * lacking a reason has not passed (stages.json: done when every permission
 * asked for has a recorded reason).
 */
function securityRules(s, at) {
  const p = [];
  const missing = new Set(Array.isArray(s.no_reason_recorded) ? s.no_reason_recorded : []);
  (Array.isArray(s.reaches) ? s.reaches : []).forEach((r, i) => {
    if (isObj(r) && typeof r.reason === "string" && !r.reason.trim() && !missing.has(r.system)) p.push(`${at}.reaches[${i}]: ${r.system} has no reason, so it is one of no_reason_recorded`);
  });
  if (missing.size && /^passed/i.test(String(s.verdict ?? ""))) p.push(`${at}.verdict: passed, but ${missing.size} permission${missing.size === 1 ? " has" : "s have"} no recorded reason`);
  return p;
}

/** The architecture record's rules (added in 0.4.12): a binding is for a system the record names, and every decision carries its reason. */
function architectureRules(s, at) {
  const p = [];
  const systems = new Set(Array.isArray(s.systems) ? s.systems : []);
  for (const sys of Object.keys(isObj(s.bindings) ? s.bindings : {})) if (!systems.has(sys)) p.push(`${at}.bindings: "${sys}" is bound but is not one of the record's systems`);
  (Array.isArray(s.decisions) ? s.decisions : []).forEach((d, i) => { if (isObj(d) && typeof d.why === "string" && !d.why.trim()) p.push(`${at}.decisions[${i}]: a decision without a reason is not delivered`); });
  return p;
}

/** GET /products (added in 0.4). */
export function checkProducts(body) {
  const p = validate("ProductsAnswer", body);
  const names = (isObj(body) && Array.isArray(body.products) ? body.products : []).map((x) => x?.name);
  for (const n of new Set(names)) if (names.filter((x) => x === n).length > 1) p.push(`body.products: "${n}" appears more than once`);
  return p;
}

/** GET /products/{name} (added in 0.4): the product asked for, its activity newest first; from 0.4.2 its setup and when_needed lists. */
export function checkProduct(body, name, cadences = CADENCES(), roles = stageRoles()) {
  const p = validate("ProductAnswer", body);
  if (!isObj(body)) return p;
  if (name !== undefined && body.name !== name) p.push(`body.name: is ${JSON.stringify(body.name)}, not the product asked for (${name})`);
  (Array.isArray(body.activity) ? body.activity : []).forEach((e, i, all) => {
    if (i > 0 && isObj(e) && isObj(all[i - 1]) && Date.parse(all[i - 1].at) < Date.parse(e.at)) p.push(`body.activity[${i}]: the feed is newest first, and this line is newer than the one above it`);
  });
  // The codebase and the last commit any build knew (added in 0.4.6).
  const src = body.source;
  if (isObj(src) && typeof src.drift === "boolean") {
    const differs = typeof src.current === "string" && src.current !== src.commit;
    if (src.drift && !differs) p.push("body.source.drift: is true, but the commit read now is not a different one");
    if (!src.drift && differs) p.push(`body.source.drift: is false, but the repository is at ${src.current} and the last build knew ${src.commit}`);
  }
  if (isObj(src) && typeof src.build === "string" && Array.isArray(body.builds) && body.builds.length && !body.builds.some((b) => isObj(b) && b.id === src.build)) p.push(`body.source.build: ${src.build} is not one of the product's builds`);
  // The setup and when_needed lists (added in 0.4.2).
  const versions = new Set((Array.isArray(body.builds) ? body.builds : []).filter(isObj).map((b) => b.version));
  const inOrder = (key, cadence) => {
    if (!Array.isArray(body[key])) return [];
    const items = body[key].filter(isObj);
    const want = ofCadence(cadences, cadence);
    const got = items.map((x) => x.stage);
    if (want.length && JSON.stringify(got) !== JSON.stringify(want)) p.push(`body.${key}: lists ${got.join(", ") || "nothing"}, not stages.json's ${cadence} stages in order (${want.join(", ")})`);
    return items;
  };
  inOrder("setup", "setup").forEach((x, i) => {
    const at = `body.setup[${i}]`;
    const own = roles?.byStage?.[x.stage];
    if (own && typeof x.role === "string" && !own.includes(x.role)) p.push(`${at}.role: ${x.role} does not hold ${x.stage} in stages.json`);
    if (x.state === "chosen" && !isObj(x.holder)) p.push(`${at}: is chosen, so it names its holder`);
    if (x.state !== "chosen" && x.holder !== null && x.holder !== undefined) p.push(`${at}: is ${x.state}, so nobody holds it, but it names a holder`);
    if (x.state !== "chosen" && x.since !== null && x.since !== undefined) p.push(`${at}.since: is ${JSON.stringify(x.since)}, but a stage ${x.state} has held nothing since a version`);
    if (typeof x.since === "string" && versions.size && !versions.has(x.since)) p.push(`${at}.since: ${x.since} is not a version of the product's builds`);
    // Its form (added in 0.4.4).
    (isObj(x.form) && Array.isArray(x.form.fields) ? x.form.fields : []).forEach((f, j) => fieldRules(f, `${at}.form.fields[${j}]`, p));
    if (isObj(x.form) && Array.isArray(x.form.fields)) {
      const names = x.form.fields.filter(isObj).map((f) => f.name);
      for (const n of new Set(names)) if (names.filter((y) => y === n).length > 1) p.push(`${at}.form.fields: "${n}" appears more than once`);
    }
  });
  const builds = new Set((Array.isArray(body.builds) ? body.builds : []).filter(isObj).map((b) => b.id));
  inOrder("when_needed", "when_needed").forEach((x, i) => {
    const at = `body.when_needed[${i}]`;
    if (x.can_run === false && !(typeof x.why_not === "string" && x.why_not.trim())) p.push(`${at}: cannot run, so it says why_not`);
    if (x.can_run === false && x.action !== undefined) p.push(`${at}: cannot run, so it names no action`);
    if (x.can_run === true && !isObj(x.action)) p.push(`${at}: can run, so it names the action that runs it`);
    if (x.can_run === true && x.why_not !== undefined) p.push(`${at}: can run, so it gives no why_not`);
    // The confirm card, the needs and the last run (added in 0.4.4).
    if (x.can_run !== true && x.confirm !== undefined) p.push(`${at}: cannot run, so it has no confirm card`);
    if (isObj(x.action) && builds.size && typeof x.action.build === "string" && !builds.has(x.action.build)) p.push(`${at}.action.build: ${x.action.build} is not one of the product's builds`);
    (isObj(x.action) && Array.isArray(x.action.needs) ? x.action.needs : []).forEach((n, j) => fieldRules(n, `${at}.action.needs[${j}]`, p));
    const c = x.confirm;
    if (isObj(c) && x.stage === "rollback") {
      if (!(typeof c.to_version === "string" && c.to_version.trim())) p.push(`${at}.confirm: a rollback names the version it goes back to (to_version)`);
      if (Array.isArray(c.cannot_undo) && !c.cannot_undo.length) p.push(`${at}.confirm.cannot_undo: a rollback names what can't be undone, as the stage's own words ask`);
      if (typeof c.to_version === "string" && versions.size && !versions.has(c.to_version)) p.push(`${at}.confirm.to_version: ${c.to_version} is not a version of the product's builds`);
    }
    if (isObj(x.last) && typeof x.last.version === "string" && versions.size && !versions.has(x.last.version)) p.push(`${at}.last.version: ${x.last.version} is not a version of the product's builds`);
  });
  // Which version runs, and a retired product (added in 0.4.4).
  if (isObj(body.running) && builds.size && !builds.has(body.running.build)) p.push(`body.running.build: ${body.running.build} is not one of the product's builds`);
  if (isObj(body.retired)) {
    if (isObj(body.running)) p.push("body.running: the product is retired, so nothing of it runs");
    (Array.isArray(body.when_needed) ? body.when_needed : []).forEach((x, i) => { if (isObj(x) && x.can_run === true) p.push(`body.when_needed[${i}]: the product is retired, so ${x.stage} cannot run`); });
  }
  return p;
}

/** A setup form's field or an action's need (added in 0.4.4): a choice has options, and its default is one of them; a number's default is a number. */
function fieldRules(f, at, p) {
  if (!isObj(f)) return;
  if (f.kind === "choice" && !(Array.isArray(f.options) && f.options.length)) p.push(`${at}: is a choice, so it lists its options`);
  if (f.kind === "choice" && f.default !== undefined && Array.isArray(f.options) && !f.options.includes(f.default)) p.push(`${at}.default: ${JSON.stringify(f.default)} is not one of its options`);
  if (f.kind === "number" && f.default !== undefined && typeof f.default !== "number") p.push(`${at}.default: is a number field, so its default is a number`);
}

/**
 * GET /builds/{id}/stages/{stage} (added in 0.4). build: the build's answer
 * ({ build }), when the caller has it, to hold the workspace to it.
 */
export function checkStageWorkspace(body, ids, stage, build, cadences = CADENCES()) {
  const p = validate("StageWorkspace", body);
  if (!isObj(body)) return p;
  if (stage !== undefined && body.stage !== stage) p.push(`body.stage: is ${JSON.stringify(body.stage)}, not the stage asked for (${stage})`);
  cadenceRules(body, "body", cadences, p);
  skillRules(body.holder, "body.holder", p);
  const b0 = isObj(build) ? build.build : null;
  const same = isObj(b0) && Array.isArray(b0.stages) ? b0.stages.find((s) => isObj(s) && s.stage === body.stage) : null;
  if (same && same.cadence !== undefined && body.cadence !== undefined && same.cadence !== body.cadence) p.push(`body.cadence: is ${JSON.stringify(body.cadence)}, but the build's stage says ${JSON.stringify(same.cadence)}`);
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
  // A gate's features (added in 0.4.3): only at Requirements, each feature once.
  const gf = isObj(body.gate) && isObj(body.gate.features) ? body.gate.features : null;
  if (gf) {
    if (body.stage !== "requirements") p.push(`body.gate.features: a gate carries features only at Requirements, and this is ${body.stage}`);
    const all = ["approved", "to_approve", "backlog"].flatMap((k) => (Array.isArray(gf[k]) ? gf[k] : []).map((x) => x?.id));
    for (const id of new Set(all)) if (all.filter((x) => x === id).length > 1) p.push(`body.gate.features: ${id} is listed more than once`);
  }
  // The stage's features (added in 0.4.5): its own stage, and the same count as the build's stage.
  if (isObj(body.features)) {
    p.push(...sliceRules(body.features, "body.features"));
    if (body.features.stage !== body.stage) p.push(`body.features.stage: is ${JSON.stringify(body.features.stage)}, not ${body.stage}`);
    if (same && isObj(same.features) && same.features.words !== body.features.words) p.push(`body.features.words: is ${JSON.stringify(body.features.words)}, but the build's stage says ${JSON.stringify(same.features.words)}`);
  }
  return p;
}

// ---------- each stage's features (added in 0.4.5) ----------

/** A stage's count of features: it never covers more than it has. */
function countRules(c, at) {
  const p = [];
  if (Number.isInteger(c.covered) && Number.isInteger(c.total) && c.covered > c.total) p.push(`${at}: covers ${c.covered} of ${c.total} features, more than it has`);
  return p;
}

/**
 * A stage's features: its count, each feature once, a feature at Test with
 * tests is done or stale and one without is to do, and a feature at Code never
 * passes more tests than check it.
 */
export function sliceRules(s, at = "body.features") {
  const p = countRules(s, at);
  const items = Array.isArray(s.items) ? s.items.filter(isObj) : [];
  const ids = items.map((x) => x.id);
  for (const id of new Set(ids)) if (ids.filter((x) => x === id).length > 1) p.push(`${at}.items: ${id} is listed more than once`);
  items.forEach((x, i) => {
    const here = `${at}.items[${i}]`;
    if (s.stage === "test" && Array.isArray(x.tests)) {
      if (x.tests.length && x.state === "to_do") p.push(`${here}: ${x.id} has tests, so it is not to do`);
      if (!x.tests.length && ["done", "stale"].includes(x.state)) p.push(`${here}: ${x.id} has no test, so it is to do`);
    }
    if (Number.isInteger(x.passed) && Number.isInteger(x.of)) {
      if (x.passed > x.of) p.push(`${here}: ${x.id} passed ${x.passed} of ${x.of} tests, more than it has`);
      if (x.state === "failing" && x.passed >= x.of) p.push(`${here}: is failing, but every test checking ${x.id} passed`);
      if (x.state === "done" && x.passed < x.of) p.push(`${here}: is done, but ${x.of - x.passed} of its tests failed`);
    }
    if (x.state === "findings" && !(Array.isArray(x.findings) && x.findings.some((f) => isObj(f) && f.open))) p.push(`${here}: has findings open, and names none`);
  });
  return p;
}

/** Each stage's asset as stages.json names it, for the stages that name one, in stages.json's order: { id: name }. */
export function stageAssets(path = join(HERE, "stages.json")) {
  return Object.fromEntries(JSON.parse(readFileSync(path, "utf8")).stages.filter((s) => typeof s.asset === "string" && s.asset).map((s) => [s.id, s.asset]));
}
let assetsBeside = null;
const ASSETS = () => (assetsBeside ??= stageAssets());

/**
 * GET /products/{name}/documents (added in 0.4.11): one document per stage
 * that names an asset, in stages.json's order and no other; a made document
 * has a current copy, made, at its own stage, whose version heads the
 * history; any other has none; history is newest first.
 */
export function checkDocuments(body, name, assets = ASSETS(), cadences = CADENCES()) {
  const p = validate("DocumentsAnswer", body);
  if (!isObj(body)) return p;
  if (name !== undefined && body.product !== name) p.push(`body.product: is ${JSON.stringify(body.product)}, not the product asked for (${name})`);
  const docs = Array.isArray(body.documents) ? body.documents.filter(isObj) : [];
  const want = Object.keys(assets);
  const got = docs.map((d) => d.stage);
  for (const id of want) if (!got.includes(id)) p.push(`body.documents: the stage "${id}" (${assets[id]}) is missing`);
  for (const id of got) if (!want.includes(id)) p.push(`body.documents: "${id}" is not a stage that makes a document in stages.json`);
  for (const id of new Set(got)) if (got.filter((x) => x === id).length > 1) p.push(`body.documents: the stage "${id}" is listed more than once`);
  const order = got.filter((id) => want.includes(id));
  if (order.join() !== want.filter((id) => order.includes(id)).join()) p.push("body.documents: not in stages.json's order");
  docs.forEach((d, i) => {
    const at = `body.documents[${i}]`;
    if (assets[d.stage] && d.name !== assets[d.stage]) p.push(`${at}.name: is ${JSON.stringify(d.name)}, and stages.json names the asset "${assets[d.stage]}"`);
    if (cadences[d.stage] && d.cadence !== cadences[d.stage]) p.push(`${at}.cadence: is ${JSON.stringify(d.cadence)}, and stages.json says ${cadences[d.stage]}`);
    const cur = isObj(d.current) ? d.current : null;
    if (d.state === "made" && !cur) p.push(`${at}: is made, so current says which copy stands`);
    if (d.state !== "made" && cur) p.push(`${at}: is ${d.state}, so it has no current copy`);
    if (cur && isObj(cur.artifact)) {
      if (cur.artifact.stage !== d.stage) p.push(`${at}.current.artifact: is made at "${cur.artifact.stage}", not at this document's stage`);
      if (cur.artifact.state !== "made") p.push(`${at}.current.artifact: the copy that stands is ${cur.artifact.state}, not made`);
    }
    const hist = Array.isArray(d.history) ? d.history.filter(isObj) : [];
    if (cur && hist.length && (hist[0].build !== cur.build || hist[0].artifact !== cur.artifact?.id)) p.push(`${at}.history: the newest entry is not the copy that stands`);
    if (cur && !hist.length) p.push(`${at}.history: a made document names the version that made it`);
    hist.forEach((h, j) => { if (j > 0 && typeof h.at === "string" && typeof hist[j - 1].at === "string" && Date.parse(hist[j - 1].at) < Date.parse(h.at)) p.push(`${at}.history[${j}]: newest first, and this one is newer than the one above it`); });
  });
  return p;
}

/** GET /products/{name}/stages/{stage}/messages (added in 0.4): oldest first, each at the stage asked about. */
export function checkMessages(body, stage) {
  const p = validate("MessagesAnswer", body);
  (isObj(body) && Array.isArray(body.messages) ? body.messages : []).forEach((m, i, all) => {
    if (!isObj(m)) return;
    if (i > 0 && isObj(all[i - 1]) && Date.parse(all[i - 1].at) > Date.parse(m.at)) p.push(`body.messages[${i}]: the chat is oldest first, and this message is older than the one above it`);
    if (stage !== undefined && isObj(m.from) && m.from.stage !== stage) p.push(`body.messages[${i}].from.stage: is ${JSON.stringify(m.from.stage)}, not the stage asked about (${stage})`);
    p.push(...proposalRules(m.features, `body.messages[${i}].features`));
  });
  return p;
}

/** POST /products/{name}/stages/{stage}/messages (added in 0.4). build: the build's answer, to hold a proposal to its actions. */
export function checkMessageReply(body, build) {
  const p = validate("MessageReplyAnswer", body);
  if (isObj(body) && isObj(body.reply)) p.push(...proposalRules(body.reply.features, "body.reply.features"));
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
  p.push(...proposalRules(m.features, `${at}.features`));
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

// ---------- features (added in 0.4.3) ----------

/** The matrix's columns, in their order. */
export const FEATURE_COLUMNS = ["spec", "tests", "code", "review", "docs"];

/**
 * The features a test names: the ids in square brackets its name starts with,
 * such as "[F3] counts an empty passage as none" or "[F1, F2] ...". None when
 * it starts with no such brackets.
 */
export function featuresOfTest(name) {
  const m = /^\s*\[([^\]]+)\]/.exec(String(name ?? ""));
  if (!m) return [];
  const ids = m[1].split(",").map((s) => s.trim());
  return ids.every((id) => /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(id)) ? [...new Set(ids)] : [];
}

/** Feature proposals on a message: an answer says who gave it and how, an ask says who asked whom, a change says what the feature was. */
function proposalRules(list, at) {
  const p = [];
  (Array.isArray(list) ? list : []).forEach((f, i) => {
    if (!isObj(f)) return;
    const here = `${at}[${i}]`;
    if ((f.state === "approved" || f.state === "not_now") && !(isObj(f.answered) && f.answered.decision === f.state)) p.push(`${here}: is ${f.state}, so it says who answered it, when, and with ${f.state}`);
    if (f.state === "asked" && !isObj(f.asked)) p.push(`${here}: is asked, so it says who asked whom, and when`);
    // Added in 0.4.6: bug and dropped answer a behavior marked as built; bug keeps a fix item.
    if ((f.state === "bug" || f.state === "dropped") && !(isObj(f.answered) && f.answered.decision === f.state)) p.push(`${here}: is ${f.state}, so it says who answered it, when, and with ${f.state}`);
    if ((f.state === "bug" || f.state === "dropped") && !isObj(f.as_built)) p.push(`${here}: is ${f.state}, which only a behavior marked as built can be, and it is not marked`);
    if (f.state === "bug" && !isObj(f.fix)) p.push(`${here}: is bug, so it carries the fix item kept for it`);
    if (isObj(f.fix) && f.fix.feature !== f.feature) p.push(`${here}.fix: is a fix item of ${f.fix.feature}, not ${f.feature}`);
    if (f.change === "changed" && !isObj(f.was)) p.push(`${here}: changes ${f.feature}, so it says what the feature was`);
  });
  const ids = (Array.isArray(list) ? list : []).map((f) => f?.feature);
  for (const id of new Set(ids)) if (ids.filter((x) => x === id).length > 1) p.push(`${at}: proposes ${id} more than once in one reply`);
  return p;
}

/** GET /builds/{id}/features and GET /products/{name}/features (added in 0.4.3). build: the build asked for, when it was named. */
export function checkFeatures(body, build) {
  const p = validate("FeaturesAnswer", body);
  if (!isObj(body)) return p;
  if (build !== undefined && body.build !== build) p.push(`body.build: is ${JSON.stringify(body.build)}, not the build asked for (${build})`);
  if (Array.isArray(body.columns) && body.columns.join(",") !== FEATURE_COLUMNS.join(",")) p.push(`body.columns: are ${body.columns.join(", ")}, not ${FEATURE_COLUMNS.join(", ")} in that order`);
  const versions = Array.isArray(body.versions) ? body.versions.filter(isObj) : [];
  const vs = versions.map((v) => v.version);
  for (const v of new Set(vs)) if (vs.filter((x) => x === v).length > 1) p.push(`body.versions: ${v} appears more than once`);
  if (versions.length && !versions.some((v) => v.version === body.version && v.build === body.build)) p.push(`body.version: ${body.version} (build ${body.build}) is not one of the product's versions`);
  const rows = Array.isArray(body.features) ? body.features : [];
  const ids = rows.map((r) => r?.id);
  for (const id of new Set(ids)) if (ids.filter((x) => x === id).length > 1) p.push(`body.features: ${id} is a row more than once`);
  rows.forEach((r, i) => {
    if (!isObj(r) || !isObj(r.cells)) return;
    for (const col of FEATURE_COLUMNS) {
      const c = r.cells[col];
      if (!isObj(c)) continue;
      const here = `body.features[${i}].cells.${col}`;
      const t = isObj(c.tests) ? c.tests : null;
      if (t && Number.isInteger(t.passed) && Number.isInteger(t.total)) {
        if (t.passed > t.total) p.push(`${here}.tests: passed ${t.passed} of ${t.total}, more than it has`);
        if (c.state === "failing" && t.passed >= t.total) p.push(`${here}: is failing, but every test naming ${r.id} passed`);
        if (c.state === "done" && t.passed < t.total) p.push(`${here}: is done, but ${t.total - t.passed} test${t.total - t.passed === 1 ? "" : "s"} naming ${r.id} failed`);
      }
      if (isObj(c.link) && c.link.feature !== r.id) p.push(`${here}.link: opens ${c.link.feature}, not ${r.id}`);
    }
    if (r.state === "proposed" && isObj(r.cells.spec) && r.cells.spec.state !== "missing") p.push(`body.features[${i}].cells.spec: ${r.id} was never approved, so the spec does not carry it yet, and the cell is missing`);
  });
  // Added in 0.4.5: a row's pending proposal is its own, a test that checks a feature is not also unmapped, and backfill is offered only with no features.
  const unmapped = new Set(Array.isArray(body.unmapped) ? body.unmapped : []);
  rows.forEach((r, i) => {
    if (!isObj(r)) return;
    if (isObj(r.pending)) {
      if (r.pending.feature !== r.id) p.push(`body.features[${i}].pending: is a proposal of ${r.pending.feature}, not ${r.id}`);
      p.push(...proposalRules([r.pending], `body.features[${i}].pending`).map((x) => x.replace(`body.features[${i}].pending[0]`, `body.features[${i}].pending`)));
    }
    (Array.isArray(r.tests) ? r.tests : []).forEach((t) => { if (unmapped.has(t)) p.push(`body.unmapped: "${t}" checks ${r.id}, so it is not unmapped`); });
  });
  if (isObj(body.backfill) && body.backfill.offered === true && rows.length) p.push("body.backfill: is offered, but the product has features already");
  // Added in 0.4.6: a row with a fix item or dropped came from the as-built record, and was never approved by that answer.
  rows.forEach((r, i) => {
    if (!isObj(r)) return;
    if ((isObj(r.fix) || isObj(r.dropped)) && !isObj(r.as_built)) p.push(`body.features[${i}]: has ${isObj(r.fix) ? "a fix item" : "been dropped"}, which only a behavior marked as built can, and it is not marked`);
    if (isObj(r.fix) && r.fix.feature !== r.id) p.push(`body.features[${i}].fix: is a fix item of ${r.fix.feature}, not ${r.id}`);
  });
  const ids2 = new Set(rows.filter(isObj).map((r) => r.id));
  (Array.isArray(body.fixes) ? body.fixes : []).forEach((x, i) => { if (isObj(x) && rows.length && !ids2.has(x.feature)) p.push(`body.fixes[${i}]: is a fix item of ${x.feature}, which is not one of the matrix's features`); });
  return p;
}

/** POST /builds/{id}/features/approve_all (added in 0.4.5): every proposal named reads approved, and the statement has one new version. proposals: the ids sent. */
export function checkFeatureApproveAll(body, proposals) {
  const p = validate("FeatureApproveAllAnswer", body);
  if (!isObj(body)) return p;
  const approved = Array.isArray(body.approved) ? body.approved.filter(isObj) : [];
  p.push(...proposalRules(approved, "body.approved"));
  approved.forEach((x, i) => { if (x.state !== "approved") p.push(`body.approved[${i}].state: is ${x.state}, after approve_all`); });
  if (Array.isArray(proposals)) {
    const got = new Set(approved.map((x) => x.proposal));
    for (const id of proposals) if (!got.has(id)) p.push(`body.approved: does not list the proposal ${id} it was asked to approve`);
  }
  (Array.isArray(body.features) ? body.features.filter(isObj) : []).forEach((f, i) => { if (f.state !== "approved") p.push(`body.features[${i}].state: ${f.id} was approved, and is not`); });
  if (typeof body.statement !== "string") p.push("body.statement: approving gives the statement of the job a new version, and the answer does not name it");
  return p;
}

/** GET /products/{name}/features/{feature} (added in 0.4.3): the feature asked for, its history oldest first. */
export function checkFeature(body, id) {
  const p = validate("FeatureAnswer", body);
  if (!isObj(body)) return p;
  if (id !== undefined && isObj(body.feature) && body.feature.id !== id) p.push(`body.feature.id: is ${JSON.stringify(body.feature.id)}, not the feature asked for (${id})`);
  const h = Array.isArray(body.history) ? body.history : [];
  h.forEach((e, i) => {
    if (!isObj(e)) return;
    if (i > 0 && isObj(h[i - 1]) && Date.parse(h[i - 1].at) > Date.parse(e.at)) p.push(`body.history[${i}]: the history is oldest first, and this entry is older than the one above it`);
    if (isObj(e.link) && e.link.kind === "message" && typeof e.link.message !== "string") p.push(`body.history[${i}].link: is a message, so it names the message`);
    if (isObj(e.link) && e.link.kind === "artifact" && typeof e.link.artifact !== "string") p.push(`body.history[${i}].link: is an artifact, so it names the artifact`);
  });
  if (isObj(body.feature) && body.feature.state === "approved" && !h.some((e) => isObj(e) && e.kind === "approved")) p.push("body.history: the feature is approved, and its history has no approval");
  return p;
}

/** POST /builds/{id}/features/{feature}/{decision} (added in 0.4.3): the proposal reads as the decision taken. */
export function checkFeatureDecision(body, decision) {
  const p = validate("FeatureDecisionAnswer", body);
  if (!isObj(body) || !isObj(body.proposal)) return p;
  p.push(...proposalRules([body.proposal], "body.proposal").map((x) => x.replace("body.proposal[0]", "body.proposal")));
  const want = { approve: "approved", not_now: "not_now", ask: "asked", bug: "bug", drop: "dropped" }[decision];
  if (want && body.proposal.state !== want) p.push(`body.proposal.state: is ${body.proposal.state}, after ${decision}`);
  if (decision === "approve" && typeof body.statement !== "string") p.push("body.statement: an approval gives the statement of the job a new version, and the answer does not name it");
  if (decision === "approve" && isObj(body.feature) && body.feature.state !== "approved") p.push("body.feature.state: the feature was approved, and is not");
  if (decision === "not_now" && isObj(body.feature) && body.feature.backlog !== true) p.push("body.feature.backlog: the feature was left for later, so it is a backlog item");
  if (decision === "ask" && !Array.isArray(body.told)) p.push("body.told: an ask names who was asked");
  // Added in 0.4.6.
  if (decision === "bug" && !isObj(body.fix)) p.push("body.fix: a bug keeps a fix item, and the answer does not carry it");
  if ((decision === "bug" || decision === "drop") && isObj(body.feature) && body.feature.state === "approved" && !isObj(body.feature.pending)) p.push(`body.feature.state: a behavior answered ${decision} is not approved by it`);
  if (decision === "drop" && isObj(body.feature) && !isObj(body.feature.dropped)) p.push("body.feature.dropped: the behavior was dropped, and the feature does not say so");
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
