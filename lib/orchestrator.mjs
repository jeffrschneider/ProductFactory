// The orchestrator: the boundary between Product Factory and the process
// runner (AgentMesh-Community/process-runner, Apache-2.0), whose parser,
// planner and run state are vendored, unchanged, under vendor/process-runner/
// (SOURCE.json says which version). Everything that decides what happens
// next in a build is the runner's: it reads the build's process document,
// keeps the run state, and says the next action. Product Factory supplies only
// the delivery: the holder adapters (adapters.mjs) and the person's gate in
// the console, in place of the runner's mesh messages.
//
// This file is the only one that imports the runner, so a newer runner is a
// drop-in: copy its files with scripts/vendor.mjs and run the tests.
//
//   openRun({ ... })            the build's process document, filled, parsed and checked, and a new run
//   nextAction(state, doc, roster)   the runner's next action for the run, or null
//   event(state, e, doc)        one event applied to the run (the runner's reducer)
//   stageOf(doc, phase)         the stage of stages.json a phase belongs to
//   holderOf(doc, phase)        which adapter does a phase: reverse-engineer, spec-writer,
//                               test-writer, code, packer or person; null when milestone 1 has none
//   phaseMaterial(m, doc, id)   the lines of material m aimed at one phase ("[<phase id>] ..."),
//                               and the lines aimed at none, as the runner hands them to that phase
//   timelineOf(state, doc)      the run's timeline, one bar per phase per round, each
//                               with the stage it belongs to

import { readFileSync } from "node:fs";
import { parseProcessDocument, validate, parseRoster, materialFor } from "../vendor/process-runner/parse-process.mjs";
import { newRun, newRunId, apply, nextActions, save } from "../vendor/process-runner/run-state.mjs";
import { phase as phaseOf, graph, findDeviation, modeOf } from "../vendor/process-runner/plan.mjs";
import { timeline } from "../vendor/process-runner/timeline.mjs";
import { STAGES_DOC, stageById, roleById } from "./standards.mjs";

export const PROCESS_FILE = new URL("../processes/make-a-new-agent.txt", import.meta.url);
/** The process a build started from existing code runs: Reverse engineering first, and the existing code adopted at Code. */
export const ADOPT_FILE = new URL("../processes/adopt-existing-code.txt", import.meta.url);

/** The adapter for each role a phase may name as its owner. */
const ADAPTER_OF_ROLE = { "reverse-engineer": "reverse-engineer", "spec-writer": "spec-writer", "test-writer": "test-writer", "code-writer": "code", "package-maker": "packer" };

/** The stages milestone 1 has an adapter for. A phase at any other stage is not run. */
export const RUNS = STAGES_DOC.stages.filter((s) => s.role_ids.some((r) => ADAPTER_OF_ROLE[r] && roleById.get(r)?.stages?.[0] === s.id)).map((s) => s.id);

const isPerson = (p) => /^(human|system)\b/.test(p.kind);

/** The stage of stages.json a phase belongs to: its owner role's first stage; for a
 *  person's phase, the stage of the phase next to it whose stage has a person's gate. */
export function stageOf(doc, id) {
  const p = phaseOf(doc, id);
  if (!p) return null;
  if (!isPerson(p)) return roleById.get(p.owner)?.stages?.[0] ?? null;
  const { preds, succs } = graph(doc);
  const own = (x) => { const q = phaseOf(doc, x); return q && !isPerson(q) ? roleById.get(q.owner)?.stages?.[0] ?? null : null; };
  const before = (preds[id] ?? []).map(own).find(Boolean) ?? null;
  const after = (succs[id] ?? []).map(own).find(Boolean) ?? null;
  if (before && stageById.get(before)?.person_gate) return before;
  if (after && stageById.get(after)?.person_gate) return after;
  return before ?? after;
}

export function holderOf(doc, id) {
  const p = phaseOf(doc, id);
  if (!p) return null;
  if (isPerson(p)) return "person";
  return ADAPTER_OF_ROLE[p.owner] ?? null;
}

/**
 * The run's timeline as the lifecycle API's build.timeline (TimelineBar, 0.1):
 * the runner's bars, ordered by start, each with the stage of stages.json its
 * phase belongs to. Empty when the run cannot draw one. With { split: true }
 * each closed bar also carries the runner's split of its time (person_ms,
 * agent_ms, external_ms), which the history keeps (history.mjs).
 */
export function timelineOf(state, doc, { split = false } = {}) {
  let bars = [];
  try { bars = timeline(state).bars; } catch { return []; }
  return bars.map((b) => ({
    phase: b.phase, stage: stageOf(doc, b.phase), round: b.round, holder: b.holder, kind: b.kind,
    start: b.start, end: b.end, duration_ms: b.duration_ms, status: b.status,
    ...(split ? { split: b.split ?? null } : {}),
  }));
}

/** The roster sent with a run: who holds each role, by a name the run keeps. */
export function rosterText(settings, { adopt = false } = {}) {
  if (adopt) {
    return ["reverse-engineer: adlc/reverse-engineer", "spec-writer: adlc/spec-writer", "test-writer: adlc/test-writer", "code-writer: adopted/existing-code", `package-maker: packer/${String(settings.packer[0] ?? "not-set").replace(/\s+/g, "-")}`].join("\n");
  }
  return [
    "spec-writer: adlc/spec-writer",
    "test-writer: adlc/test-writer",
    settings.code.holder === "code-writer" ? "code-writer: adlc/code-writer" : settings.code.holder === "pull-request" ? "code-writer: harness/pull-request" : `code-writer: harness/${String(settings.code.harness?.[0] ?? "not-set").replace(/\s+/g, "-")}`,
    `package-maker: packer/${String(settings.packer[0] ?? "not-set").replace(/\s+/g, "-")}`,
  ].join("\n");
}

/** The process document with the blanks a build fills: who owns the run, and since when. */
export function fillDocument(template, { person, day }) {
  return template.replace("owner: <who>", `owner: ${person}`).replace("effective: <date>", `effective: ${day}`).split("<the agent's owner>").join(person);
}

/**
 * The build's run: the document filled, parsed and checked against the
 * roster, and a new run of it. Throws with the runner's own words when the
 * document cannot start a run.
 */
export function openRun({ person, day, settings, material, startedAt, adopt = false, template = readFileSync(adopt ? ADOPT_FILE : PROCESS_FILE, "utf8") }) {
  const text = fillDocument(template, { person, day });
  const doc = parseProcessDocument(text);
  const roster = rosterText(settings, { adopt });
  const v = validate(doc, { roster: parseRoster(roster).map });
  if (!v.ok) {
    const e = new Error(`The process document cannot start a run: ${v.problems.filter((p) => p.code !== "note").map((p) => p.text).join("; ")}`);
    e.problems = v.problems;
    throw e;
  }
  const state = newRun({ runId: newRunId(new Date(startedAt)), doc, text, owner: person, rosterText: roster, material, startedAt, startedBy: person, platformRun: null, platformRunDriven: false });
  return { text, doc, state: apply(state, { type: "started", by: person, at: startedAt }, doc) };
}

export const parse = (text) => parseProcessDocument(text);
export const rosterOf = (state) => parseRoster(state.roster_text ?? "").map;
export const event = (state, e, doc) => apply(state, e, doc);
export const deviation = (doc, key) => findDeviation(doc, key);
export const modeOfPhase = (doc, id) => modeOf(phaseOf(doc, id));
export const phaseNamed = (doc, id) => phaseOf(doc, id);
export const saveRun = (dir, state) => save(dir, state);
export const phaseMaterial = (material, doc, id) => materialFor(material, doc, id);

/** The runner's next action for the run, or null when there is nothing to do now. */
export function nextAction(state, doc) {
  return nextActions(state, doc, rosterOf(state))[0] ?? null;
}

/** Every action the runner has for the run now. */
export function actionsFor(state, doc) {
  return nextActions(state, doc, rosterOf(state));
}
