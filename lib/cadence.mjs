// Each stage's cadence (stages.json 1.3.0, lifecycle API 0.4.2): what runs on
// every build, what is set up once per product, and what is run when needed.
//
//   every_build   the routine: Requirements to Docs. A build's steps.
//   setup         set up once per product: who holds the stage, and with what
//                 settings, is chosen once and carried forward to each later
//                 version until someone changes it. A setup stage whose holder
//                 and settings are the same as an earlier version's reads
//                 "Unchanged since <version>" (carried), so nothing is asked again.
//   when_needed   actions on the product, run when something happens: actions.mjs
//                 runs them (0.4.4); whenNeededList below is what a service
//                 without them says.
//
// The holder and settings of a setup stage come from a lifecycle: the one a
// build kept when it started (build.lifecycle), or the one in effect now for
// the product's project (GET /products/:name). A choice is the stage's role,
// whether the lifecycle uses the stage, the holder and the holder's settings.
//
// A role can hold more than one stage (the watcher holds Monitor and Cost), so
// a holder may keep each stage's settings under that stage's id (lifecycle API
// 0.4.4): { "monitor": { "every_minutes": 5 }, "cost": { "monthly_ceiling": 50 } }.
// A stage's settings are its own entry when there is one; otherwise every
// setting that is not another stage's entry, as before 0.4.4.

import { STAGES_DOC, stageById, roleById } from "./standards.mjs";

export const CADENCES = ["every_build", "setup", "when_needed"];
export const cadenceOf = (id) => stageById.get(id)?.cadence ?? "every_build";
export const SETUP_STAGES = STAGES_DOC.stages.filter((s) => s.cadence === "setup").map((s) => s.id);
export const WHEN_NEEDED_STAGES = STAGES_DOC.stages.filter((s) => s.cadence === "when_needed").map((s) => s.id);

/** The role whose holder holds a setup stage. Architecture is the solution architect's
 *  (its record is the architecture record); every other stage is its first role. */
const ROLE_OF = { architecture: "solution-architect" };
export const setupRole = (id) => ROLE_OF[id] ?? stageById.get(id)?.role_ids?.[0] ?? null;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const roleName = (id) => roleById.get(id)?.name ?? id;
const STAGE_SET = new Set(STAGES_DOC.stages.map((s) => s.id));

/** A holder's settings for one stage: its own entry under the stage's id, else the settings that are no stage's entry. */
export function settingsFor(holder, stage) {
  const s = isObj(holder?.settings) ? holder.settings : {};
  if (isObj(s[stage])) return structuredClone(s[stage]);
  return structuredClone(Object.fromEntries(Object.entries(s).filter(([k]) => !STAGE_SET.has(k))));
}

/** A value with its keys sorted, so two choices compare by content. */
function sorted(v) {
  if (Array.isArray(v)) return v.map(sorted);
  if (!isObj(v)) return v;
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])]));
}

/** A setup stage's choice in a lifecycle: { role, used, holder, settings }. holder carries no settings. */
export function choiceOf(lifecycle, id) {
  const role = setupRole(id);
  const used = lifecycle?.used?.[id]?.used !== false;
  const h = used ? lifecycle?.holders?.[role] ?? null : null;
  if (!isObj(h)) return { role, used, holder: null, settings: {} };
  const holder = { kind: h.kind, name: h.name };
  if (h.handle) holder.handle = h.handle;
  return { role, used, holder, settings: settingsFor(h, id) };
}

/** Whether two choices are the same holder with the same settings, for a stage the lifecycle uses. */
export function sameChoice(a, b) {
  if (!a?.holder || !b?.holder || !a.used || !b.used) return false;
  return JSON.stringify(sorted([a.role, a.holder, a.settings])) === JSON.stringify(sorted([b.role, b.holder, b.settings]));
}

/**
 * The earliest build, in an unbroken run going back from the newest of
 * `builds` (newest first), whose choice for the stage is `choice`; null when
 * the newest does not have it.
 */
function earliestWith(builds, id, choice) {
  let since = null;
  for (const b of builds) {
    if (!sameChoice(choiceOf(b.lifecycle, id), choice)) break;
    since = b;
  }
  return since;
}

const unchanged = (version) => `Unchanged since ${version}`;

/**
 * A setup stage of build r whose holder and settings are the same as an
 * earlier version's: { since, build, words }, or null. earlier: the product's
 * builds started before r, newest first.
 */
export function carriedFor(r, id, earlier = []) {
  if (cadenceOf(id) !== "setup") return null;
  const mine = choiceOf(r.lifecycle, id);
  if (!mine.holder) return null;
  const since = earliestWith(earlier.filter((b) => b.version !== r.version), id, mine);
  return since ? { since: since.version, build: since.id, words: unchanged(since.version) } : null;
}

/**
 * The product's setup list (GET /products/:name, 0.4.2). builds: the product's
 * builds, newest first. current: the lifecycle in effect now for the project
 * its newest build was started under ({ project, used, holders }).
 */
export function setupList(builds, current) {
  return SETUP_STAGES.map((id) => {
    const c = choiceOf(current, id);
    const base = { stage: id, name: stageById.get(id).name, role: c.role, project: current?.project ?? null };
    if (!c.used) return { ...base, state: "not_used", holder: null, settings: {}, since: null, words: "Not part of this product's lifecycle" };
    if (!c.holder) return { ...base, state: "not_chosen", holder: null, settings: {}, since: null, words: `Nobody chosen: nobody holds the ${roleName(c.role)} role` };
    const since = earliestWith(builds, id, c);
    const words = !since ? "Chosen: it holds from the next version" : since.id === builds[0]?.id ? `Chosen at ${since.version}` : unchanged(since.version);
    return { ...base, state: "chosen", holder: c.holder, settings: c.settings, since: since?.version ?? null, words };
  });
}

/** Why Product Factory cannot run each when-needed stage, given who the run plan hands it to. */
function whyNot(id, current) {
  const d = stageById.get(id);
  if (current?.used?.[id]?.used === false) return `This product's lifecycle leaves ${d.name} out.`;
  if (id === "impact") return "Product Factory does not run Impact yet, so nothing checks what depends on the running version before a new version is built. A new version starts at Requirements.";
  const role = d.role_ids[0];
  const h = current?.holders?.[role] ?? null;
  const who = isObj(h) ? `${h.kind === "reference_agent" ? `the reference ${roleName(role).toLowerCase()}` : h.name} holds it as ${roleName(role)}` : `nobody holds the ${roleName(role)} role`;
  return `Product Factory does not run the product, so it cannot run ${d.name}. The run plan hands it to the runtime you bring, where ${who}.`;
}

/** The product's when-needed list (GET /products/:name, 0.4.2): none can run here, each with why. */
export function whenNeededList(current) {
  return WHEN_NEEDED_STAGES.map((id) => ({ stage: id, name: stageById.get(id).name, can_run: false, why_not: whyNot(id, current) }));
}
