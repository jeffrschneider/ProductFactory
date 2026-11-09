// Products and stage workspaces (lifecycle API 0.4). A product (such as
// word-counter) is every build of one name, one build per version; each
// build's stages are workspaces: what the stage was given, what it handed
// back, and its gate. All of it is read from the builds' own records.
//
//   GET /products                      every product, its newest build and its versions
//   GET /products/:name                its builds, its newest run plan, a short activity feed, and
//                                      (0.4.2) its setup stages and its when-needed actions
//   GET /builds/:id/stages/:stage      one stage: given, outputs, gate and done_when
//
// "Project" is the lifecycle's team scope, so a product is never called one.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stageById } from "./standards.mjs";
import { parse, stageOf } from "./orchestrator.mjs";
import { listItem } from "./view.mjs";
import { setupList, whenNeededList } from "./cadence.mjs";

const STATE_OF_STATUS = { working: "working", waiting: "waiting_on_you", refused: "refused", stopped: "stopped", done: "done" };
const ACTIVITY_KEPT = 60;

/** What each stage reads: the artifacts of earlier stages it is given. */
export const GIVEN = {
  // Where code already exists, the as-built record goes to the stages stages.json 1.4.0 says are given parts of it.
  requirements: ["as_built"],
  architecture: ["statement", "as_built"],
  impact: ["statement", "as_built"],
  test: ["statement", "as_built"],
  code: ["statement", "suite"],
  review: ["statement", "suite", "programs"],
  security: ["statement", "programs", "as_built"],
  package: ["statement", "programs"],
  release: ["package"],
  deploy: ["package"],
  conformance: ["package"],
  acceptance: ["package"],
  docs: ["statement", "package"],
};

/** A build's state in the API's words. */
export const stateOf = (r) => STATE_OF_STATUS[r.status] ?? r.status;

/** The builds of one product, newest first. */
export const buildsOf = (all, name) => all.filter((r) => r.name === name).sort((a, b) => String(b.created).localeCompare(String(a.created)));

/** GET /products: one entry per build name, newest build first. */
export function productList(all) {
  const names = [...new Set(all.map((r) => r.name))];
  return names.map((name) => {
    const builds = buildsOf(all, name);
    const r = builds[0];
    return {
      name,
      latest: { build: r.id, version: r.version, state: stateOf(r), at: listItem(r).at },
      versions: [...new Set(builds.map((b) => b.version))],
    };
  }).sort((a, b) => {
    const at = (p) => all.find((r) => r.id === p.latest.build)?.updated ?? "";
    return String(at(b)).localeCompare(String(at(a)));
  });
}

/**
 * GET /products/:name: its builds, the newest run plan, and one line per stage
 * event, newest first. current: the lifecycle in effect now for the project its
 * newest build was started under (lifecycle.snapshot), for its setup and
 * when-needed lists (0.4.2); without it the lists are left out.
 */
export function productView(all, name, { runPlanOf = () => null, current = null } = {}) {
  const builds = buildsOf(all, name);
  if (!builds.length) return null;
  const activity = [];
  for (const r of builds) {
    for (const [stage, s] of Object.entries(r.stages)) {
      for (const e of s.log ?? []) activity.push({ at: e.at, build: r.id, version: r.version, stage, words: e.said });
    }
  }
  activity.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const out = {
    name,
    builds: builds.map((r) => ({ id: r.id, version: r.version, state: stateOf(r), at: listItem(r).at, created: r.created })),
    activity: activity.slice(0, ACTIVITY_KEPT),
  };
  for (const r of builds) {
    const plan = runPlanOf(r);
    if (plan) { out.run_plan = { build: r.id, version: r.version, ...plan }; break; }
  }
  if (current) {
    out.setup = setupList(builds, current);
    out.when_needed = whenNeededList(current);
  }
  return out;
}

// ---------- a stage's gate ----------

/** The actions a gate offers at a stage, as Product Factory offers them (view.mjs actionsOf). */
function gateActions(stage, onPr) {
  if (stage === "requirements") return ["approve", "changes", "stop"];
  if (stage === "code") return onPr ? ["accept", "back_to_test", "stop"] : ["accept", "stop"];
  if (stage === "deploy") return ["approve", "stop"];
  return ["stop"];
}

/** The process document a build runs, parsed; null when it cannot be read. */
function docIn(dir, r) {
  try { return parse(readFileSync(join(dir, r.process), "utf8")); } catch { return null; }
}

/**
 * The last time the stage waited on the person, from the run's events, and how
 * it was answered: { kind: "gate" | "refused", at, answered: { by, at, action } | null }
 * or null when it never waited. A gate the person was never asked (a gated event
 * answered in the same moment, as an OK settles the phases behind it) is not one.
 */
export function lastWait(r, stage, dir) {
  const doc = docIn(dir, r);
  if (!doc) return null;
  const events = Array.isArray(r.run?.events) ? r.run.events : [];
  const st = (p) => (p ? stageOf(doc, p) : null);
  const byPerson = (e) => typeof e.by === "string" && !/^Product Factory\b/.test(e.by);
  const instant = (g) => events.some((e) => e.type === "approved" && e.phase === g.phase && e.at === g.at);
  let w = null;
  events.forEach((e, i) => {
    if (e.type === "gated" && !instant(e) && st(e.phase) === stage) w = { i, at: e.at, kind: "gate" };
    if (e.type === "replied" && e.verdict === "refused" && st(e.phase) === stage) w = { i, at: e.at, kind: "refused" };
  });
  if (!w) return null;
  let answered = null;
  for (let i = w.i + 1; i < events.length && !answered; i++) {
    const e = events[i];
    if (!byPerson(e)) continue;
    if (e.type === "stopped") answered = { by: e.by, at: e.at, action: "stop" };
    else if (w.kind === "gate" && e.type === "approved" && st(e.phase) === stage && !/^Sent back to Test/.test(e.text ?? "")) answered = { by: e.by, at: e.at, action: stage === "code" ? "accept" : "approve" };
    else if (e.type === "deviated" && st(e.from) === stage) answered = { by: e.by, at: e.at, action: stage === "code" ? "back_to_test" : "changes" };
    else if (w.kind === "refused" && e.type === "resumed" && st(e.phase) === stage) answered = { by: e.by, at: e.at, action: "resume" };
  }
  return { ...w, answered };
}

/**
 * A stage's gate, or null when it has none to show. actions: the build's
 * actions as this person sees them. offered: every action the build offers.
 * whoMay(stage): words for who may answer it. personName(email): a name.
 */
export function gateOf(r, stage, { dir, actions, offered, whoMay, personName = (e) => e }) {
  const onPr = r.settings?.code?.holder === "pull-request";
  const here = (list) => list.filter((a) => a.stage === stage && !["archive", "unarchive"].includes(a.name));
  if (["waiting", "refused"].includes(r.status) && r.at === stage && here(offered).length) {
    const refused = r.status === "refused";
    return { actions: here(actions).map((a) => a.name), state: "open", who_may: refused ? "Anyone may run it again or stop it." : whoMay(stage) };
  }
  const w = lastWait(r, stage, dir);
  if (!w) return null;
  const gate = { actions: w.kind === "refused" ? ["resume", ...(stage === "requirements" ? ["changes"] : []), "stop"] : gateActions(stage, onPr), state: "answered", who_may: w.kind === "refused" ? "Anyone may run it again or stop it." : whoMay(stage) };
  if (w.answered) gate.answered = { by: personName(w.answered.by), at: w.answered.at, action: w.answered.action };
  else gate.closed = stage === "code" ? "A newer push came before an answer, so this gate closed." : "This gate closed without an answer.";
  return gate;
}

/**
 * GET /builds/:id/stages/:stage. stageView: the stage as the build answer shows
 * it. artifacts: the build's artifacts.
 */
export function stageWorkspace(r, stage, { stageView, artifacts, gate }) {
  const def = stageById.get(stage);
  const made = new Set(artifacts.filter((a) => a.state === "made").map((a) => a.id));
  const out = {
    stage,
    name: def.name,
    state: stageView.state,
    holder: stageView.holder,
    given: (GIVEN[stage] ?? []).filter((id) => made.has(id)),
    outputs: artifacts.filter((a) => a.stage === stage),
    done_when: def.done_when,
    cadence: stageView.cadence,
  };
  if (stageView.carried) out.carried = stageView.carried;
  if (gate) out.gate = gate;
  return out;
}
