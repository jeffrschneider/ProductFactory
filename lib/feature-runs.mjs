// Feature runs (processes/make-a-feature.txt). Once the spec of a version is
// approved, each approved feature is made in a run of its own: its tests, its
// scripts and the person's OK, at the same time as the others, each with its
// own pull request. The version's own run (make-a-new-agent.txt v2) keeps
// what is product-wide: the spec, its approval, and, once every feature's run
// has closed, the package and the rest. Its gather-the-features phase is the
// wait: Product Factory starts the feature runs there and closes the phase
// when every one of them has closed.
//
// A feature run lives inside its version's build.json, under feature_runs,
// each with the fields a run's steps read and write (RUN_FIELDS); every other
// field is the version's. The runner reaches one through the lens store
// (lensStore): a feature run's key is "<build id>~<run id>", and reading it
// gives the version's record with the run's fields in place of its own, so
// the steps that drive a build drive a feature run the same way. Its files
// are under the build's folder, in runs/<run id>/.
//
// The version's base is what the accepted features merged: their suite and
// the scripts of the last one accepted (build.json "base"). A feature's
// scripts are judged with every test of the features already accepted, so
// when another feature is accepted while a run is open, the run is brought up
// to date with the new base before its gate runs again (upToDate): the base's
// tests go in beside its own, and each script is taken from the side that
// changed it. A script both sides changed is a conflict: the base's version
// goes in, the feature's own is kept beside it under records/yours/, and the
// next round of the gate (the fix loop, when it runs) works it in.
//
// composed(b) is the version as a reader of one chain expects it: Test and
// Code across the feature runs, and the pull request of the run that leads.

import { join } from "node:path";
import { LOCK_FILE, CONFLICT_FILE, digestOf } from "./fence.mjs";

/** The run made when the spec as approved holds no feature: the whole spec in one run. */
export const FEATURE_ALL = "all";
/** The fields of a build's record a feature run keeps for itself; every other field is its version's. */
export const RUN_FIELDS = ["run", "status", "at", "stages", "work", "log", "process", "feature", "title", "given", "started", "by"];
/** The stages a feature run holds. */
export const RUN_STAGES = ["test", "code"];
/** Where the note of a conflict goes in a build folder, and the feature's own scripts beside it. */
export const UP_TO_DATE_FILE = "records/up-to-date.md";
export const YOURS_DIR = "records/yours";

/** A feature run's key, as the runner and its store name it. */
export const runKey = (build, run) => `${build}~${run}`;
/** A key's version build and run: { build, run }, run null for the version itself. */
export function keyParts(key) {
  const s = String(key ?? "");
  const i = s.indexOf("~");
  return i < 0 ? { build: s, run: null } : { build: s.slice(0, i), run: s.slice(i + 1) };
}

/** Whether a build makes its features in runs of their own. */
export const hasFeatureRuns = (b) => Array.isArray(b?.feature_runs);

/** The record a feature run's steps see: the version's, with the run's own fields in its place. */
export function runRecord(b, fr) {
  const out = { ...b };
  delete out.feature_runs;
  delete out.base;
  for (const k of RUN_FIELDS) out[k] = fr[k];
  out.id = runKey(b.id, fr.id);
  out.build = b.id;
  out.feature_run = fr.id;
  return out;
}

/** What a step changed on the record it saw goes back where it belongs: the run's fields to the run, the rest to the version. */
function putBack(b, fr, v) {
  for (const k of RUN_FIELDS) fr[k] = v[k];
  for (const [k, x] of Object.entries(v)) {
    if (RUN_FIELDS.includes(k) || ["id", "build", "feature_run", "feature_runs", "base", "updated"].includes(k)) continue;
    b[k] = x;
  }
}

/**
 * The store as the runner reads it: a version by its id, as before, and a
 * feature run by its key, as runRecord shows it. A change to a feature run is
 * a change to its version's build.json, made one at a time with the rest.
 */
export function lensStore(store) {
  const runOf = (b, run) => b?.feature_runs?.find((x) => x.id === run) ?? null;
  return {
    ...store,
    folder(id) {
      const { build, run } = keyParts(id);
      return run ? join(store.folder(build), "runs", run) : store.folder(build);
    },
    read(id) {
      const { build, run } = keyParts(id);
      const b = store.read(build);
      if (!run) return b;
      const fr = runOf(b, run);
      return fr ? runRecord(b, fr) : null;
    },
    update(id, fn) {
      const { build, run } = keyParts(id);
      if (!run) return store.update(build, fn);
      return store.update(build, (b) => {
        const fr = runOf(b, run);
        if (!fr) throw new Error(`no feature run ${id}`);
        const v = runRecord(b, fr);
        const out = fn(v);
        putBack(b, fr, v);
        return out === undefined ? v : out;
      });
    },
    fileIn(id, rel) {
      const { build, run } = keyParts(id);
      return run ? store.fileIn(build, `runs/${run}/${rel}`) : store.fileIn(build, rel);
    },
  };
}

const same = (a, b) => Boolean(a && b) && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

/**
 * A feature's build folder brought up to date with the version's base.
 * ancestor: the folder as it was when it last met the base (when its pull
 * request opened, or when it was last brought up to date); ours: as it is
 * now; base: the base's. Each is a Map of path in the folder to bytes.
 *
 *   test/      every test of both: the base's, and this feature's own
 *   scripts/   from the side that changed each one since the ancestor; one
 *              both changed is the base's, with the feature's own kept
 *              under records/yours/ and named in records/up-to-date.md
 *   the rest   this feature's own (the same approved spec on both sides)
 *
 * The lock is not written here (the caller pins the new suite), and
 * records/conflict.md is taken out, as after any revision.
 * Returns { files, conflicts: [path], added: [test path] }. Pure.
 */
export function upToDate({ ancestor = new Map(), ours, base }) {
  const files = new Map();
  const conflicts = [];
  const added = [];
  const paths = [...new Set([...ours.keys(), ...base.keys()])].sort();
  for (const p of paths) {
    if (p === LOCK_FILE || p === CONFLICT_FILE || p === UP_TO_DATE_FILE || p.startsWith(`${YOURS_DIR}/`)) continue;
    const o = ours.get(p);
    const b = base.get(p);
    const a = ancestor.get(p);
    if (p.startsWith("scripts/")) {
      if (o && b) {
        if (same(o, b) || same(b, a)) files.set(p, o);
        else if (same(o, a)) files.set(p, b);
        else { files.set(p, b); conflicts.push(p); }
      } else {
        // On one side only: kept, unless the other side took out what the ancestor had and this side left it as it was.
        const one = o ?? b;
        if (!same(one, a)) files.set(p, one);
      }
      continue;
    }
    if (p.startsWith("test/")) {
      // A test this feature changed is its own; every other is the base's.
      files.set(p, o && (!b || !same(o, a)) ? o : b);
      if (!o) added.push(p);
      continue;
    }
    if (p.startsWith("records/")) { if (o) files.set(p, o); continue; }
    files.set(p, o ?? b);
  }
  for (const p of conflicts) files.set(`${YOURS_DIR}/${p}`, ours.get(p));
  if (conflicts.length) files.set(UP_TO_DATE_FILE, Buffer.from(upToDateNote(conflicts), "utf8"));
  return { files, conflicts, added };
}

/** The note a conflicted update leaves in the build folder, for the harness that works it in. */
export function upToDateNote(conflicts) {
  return [
    "# Brought up to date with the version's base",
    "",
    "Another feature of this version was accepted and merged while this one was open, so this folder was brought up to date with it: its tests are in test/ beside this feature's own, and every script it changed is in scripts/.",
    "",
    "Both changed these scripts. The base's version, which passes every accepted feature's tests, is in scripts/; this feature's own version is beside it under records/yours/. Carry this feature's change into the base's version, so the whole suite passes:",
    "",
    ...conflicts.map((p) => `- ${p} (yours: ${YOURS_DIR}/${p})`),
    "",
  ].join("\n");
}

/** The digests a brought-up-to-date folder pins: every file the old ones pinned, and every test, at its new bytes. Pure. */
export function pinnedDigests(digests, files) {
  const keys = new Set([...Object.keys(digests ?? {}), ...[...files.keys()].filter((p) => p.startsWith("test/"))]);
  return Object.fromEntries([...keys].filter((p) => files.has(p)).sort().map((p) => [p, digestOf(files.get(p))]));
}

/** The suite with another's files added, by name: a name it already has keeps its own file. */
export function suiteWith(suite = [], more = []) {
  const names = new Set(suite.map((f) => f.name));
  return [...suite, ...more.filter((f) => !names.has(f.name))].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
}

// ---------- the version as one chain reads it ----------

const STATE_OF_STATUS = { working: "working", waiting: "waiting_on_you", refused: "refused", stopped: "stopped", done: "done" };
const byAt = (a, b) => (String(a.at) < String(b.at) ? -1 : String(a.at) > String(b.at) ? 1 : 0);
/** A feature run in words: its feature's id and name. */
export const runWords = (fr) => (fr.feature === FEATURE_ALL ? "The whole spec" : `${fr.feature}${fr.title ? ` ${fr.title}` : ""}`);
/** Whether a feature run has ended: closed by the OK, or stopped. */
export const runEnded = (fr) => ["done", "stopped"].includes(fr?.status);

/** Several states as one: waiting on you, then working, then refused; done once every one is; not started while none has. */
export function stateAcross(states) {
  const has = (s) => states.includes(s);
  if (has("waiting_on_you")) return "waiting_on_you";
  if (has("working")) return "working";
  if (has("refused")) return "refused";
  if (states.length && states.every((s) => s === "done" || s === "stopped")) return states.some((s) => s === "done") ? "done" : "stopped";
  if (has("done")) return "working";
  return "not_started";
}

/** The run that leads what a reader of one chain sees: one waiting on you, then one working, then the newest. */
export function leadRun(b) {
  const runs = b.feature_runs ?? [];
  return runs.find((r) => r.status === "waiting") ?? runs.find((r) => r.status === "working") ?? runs.find((r) => r.status === "refused") ?? runs.at(-1) ?? null;
}

/** One stage across the feature runs: its state, its rounds and log with the feature each is of, and what was handed back. */
function stageAcross(b, stage) {
  const own = b.stages[stage];
  const runs = (b.feature_runs ?? []).filter((r) => r.stages?.[stage]);
  if (!runs.length) return own;
  const at = (fr, p) => `runs/${fr.id}/${p}`;
  const label = (fr) => (fr.feature === FEATURE_ALL ? "" : `${fr.feature} · `);
  const rounds = runs.flatMap((fr) => fr.stages[stage].rounds.map((x) => ({ ...x, label: `${label(fr)}${x.label}` }))).sort(byAt);
  const log = runs.flatMap((fr) => fr.stages[stage].log.map((x) => ({ ...x, said: `${label(fr)}${x.said}` }))).sort(byAt);
  let files = [];
  if (stage === "code" && b.base?.scripts?.length) files = b.base.scripts.map((f) => ({ path: `code/${f.name}`, at: f.path, size: f.size ?? 0 }));
  else {
    const seen = new Set();
    for (const fr of runs) for (const f of fr.stages[stage].handed_back.files) if (!seen.has(f.path)) { seen.add(f.path); files.push({ ...f, at: at(fr, f.at) }); }
  }
  const states = runs.map((fr) => fr.stages[stage].state);
  return {
    ...own,
    state: stateAcross(states),
    runs: runs.reduce((n, fr) => n + fr.stages[stage].runs, 0),
    rounds,
    given: runs.length === 1 && runs[0].feature === FEATURE_ALL ? runs[0].stages[stage].given : `${runs.length === 1 ? "One feature is" : `${runs.length} features are`} made in runs of their own: ${runs.map(runWords).join("; ")}. ${runs[0].stages[stage].given}`,
    handed_back: { words: runs.flatMap((fr) => fr.stages[stage].handed_back.words.map((w) => `${label(fr)}${w}`)), files },
    done_when_met: runs.every((fr) => fr.stages[stage].done_when_met === true) ? true : runs.some((fr) => fr.stages[stage].done_when_met === false) ? false : null,
    log,
  };
}

/** Whether the version waits at gather-the-features: its features are being made. */
export const gathering = (b) => hasFeatureRuns(b) && b.at === "code" && b.status === "working";

/**
 * The version as a reader of one chain expects it (the build answer, the
 * product, the boss): Test and Code across its feature runs, the pull
 * request of the run that leads, and, while its features are made, the state
 * of the runs as its own: waiting on you when one waits. own_status keeps
 * the version's own. A build without feature runs is returned as it is.
 */
export function composed(b) {
  if (!hasFeatureRuns(b) || !b.feature_runs.length) return b;
  const out = { ...b, stages: { ...b.stages }, own_status: b.status };
  for (const s of RUN_STAGES) if (b.stages[s]) out.stages[s] = stageAcross(b, s);
  const lead = leadRun(b);
  if (lead?.work?.pr) out.work = { ...b.work, pr: lead.work.pr };
  // The version's log, with what each feature run said, in time order.
  out.log = [...b.log, ...b.feature_runs.flatMap((fr) => fr.log.map((x) => ({ ...x, said: fr.feature === FEATURE_ALL ? x.said : `${fr.feature}: ${x.said}` })))].sort(byAt);
  if (gathering(b)) {
    const open = b.feature_runs.filter((r) => !runEnded(r)).map((r) => r.status);
    out.status = open.includes("waiting") ? "waiting" : open.includes("working") || !open.length ? "working" : open.includes("refused") ? "refused" : "working";
  }
  return out;
}

/** A feature run's place as the board shows it: the stage it is at, its state there, in words. */
export function runAt(fr, summary) {
  const s = fr.stages?.[fr.at];
  return { stage: fr.at, state: s?.state ?? STATE_OF_STATUS[fr.status] ?? fr.status, summary };
}
