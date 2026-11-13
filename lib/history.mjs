// The history: every build over time, in an SQLite file beside the build
// files (<data>/history.sqlite), kept through Node's built-in node:sqlite. No
// server and no dependency. It is what analytics reads.
//
// The build files stay the source of truth. The history is worked out from
// them alone: each time a build is saved (store.onSave) its rows are written
// again from its build.json, and when the file is missing, or made by another
// version of this file, it is built again from every build folder. A build
// changed while Product Factory was stopped is caught up when it starts.
//
//   builds   one row per build: project, status, when it started and ended
//   stages   one row per stage a build ran: holder, start, end, its time, the
//            time spent waiting on a person and with an agent working, rounds
//            and how many were sent back
//   rounds   one row per round of a stage, as the build's record keeps it:
//            holder, start, end, sent back or not, the verdict
//   steps    one row per timeline bar (one per phase per round): holder, kind,
//            start, end, and its split between a person and an agent
//
// analytics() answers GET /v1/lifecycle/analytics. That route is Product
// Factory's own, not part of the lifecycle API standard. Weeks start on
// Monday, 00:00 UTC.
//
// node:sqlite needs Node 22.13 or later, or Node 22.5 to 22.12 started with
// --experimental-sqlite. On an older Node there is no history: createHistory
// returns null, HISTORY_UNAVAILABLE says why, and the route is not offered.

import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { parse, timelineOf } from "./orchestrator.mjs";
import { STAGES_DOC } from "./standards.mjs";
import { Refused } from "./lifecycle.mjs";

// node:sqlite says it is experimental each time a process loads it; that
// one warning is kept out of Product Factory's output. Nothing else is.
let sqlite = null;
let unavailable = null;
{
  const emit = process.emitWarning;
  process.emitWarning = function (w, ...rest) {
    if (/sqlite/i.test(String(w?.message ?? w))) return;
    return emit.call(process, w, ...rest);
  };
  try { sqlite = await import("node:sqlite"); } catch {
    unavailable = `Analytics needs Node's built-in SQLite (node:sqlite): Node 22.13 or later, or Node 22.5 to 22.12 started with --experimental-sqlite. This is Node ${process.versions.node}, so there is no history and no analytics.`;
  } finally { process.emitWarning = emit; }
}

/** Why there is no history on this Node, in words; null when there is one. */
export const HISTORY_UNAVAILABLE = unavailable;
export const HISTORY_FILE = "history.sqlite";
/** The windows analytics answers, in days; all has no start. */
export const WINDOWS = { "7d": 7, "30d": 30, all: null };

const VERSION = 1;
const DAY = 86_400_000;
const ENDED = new Set(["done", "stopped"]);
const STAGE_NUMBER = new Map(STAGES_DOC.stages.map((s, i) => [s.id, s.number ?? i + 1]));
const STAGE_NAME = new Map(STAGES_DOC.stages.map((s) => [s.id, s.name]));

const SCHEMA = `
CREATE TABLE builds (id TEXT PRIMARY KEY, project TEXT, name TEXT, status TEXT, started TEXT, ended TEXT, updated TEXT);
CREATE TABLE stages (build_id TEXT NOT NULL, project TEXT, stage TEXT NOT NULL, holder TEXT, started TEXT, ended TEXT,
  time_ms INTEGER, person_ms INTEGER, agent_ms INTEGER, rounds INTEGER, sent_back INTEGER, PRIMARY KEY (build_id, stage));
CREATE TABLE rounds (build_id TEXT NOT NULL, project TEXT, stage TEXT NOT NULL, n INTEGER, holder TEXT, started TEXT, ended TEXT,
  sent_back INTEGER, verdict TEXT);
CREATE TABLE steps (build_id TEXT NOT NULL, project TEXT, stage TEXT NOT NULL, phase TEXT, round INTEGER, holder TEXT, kind TEXT,
  started TEXT, ended TEXT, duration_ms INTEGER, person_ms INTEGER, agent_ms INTEGER, status TEXT);
CREATE INDEX rounds_build ON rounds (build_id);
CREATE INDEX steps_build ON steps (build_id);
`;

/** The Monday (UTC) of the week a time falls in, as YYYY-MM-DD. */
export function weekOf(at) {
  const d = new Date(typeof at === "number" ? at : Date.parse(at));
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back)).toISOString().slice(0, 10);
}

/** The middle value; the mean of the two middle values for an even count; null for none. */
export function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const num = (x) => (Number.isFinite(x) ? x : null);

/**
 * A build's rows, from its record and its run's timeline (bars, each with its
 * stage and the runner's split). Pure: the same record gives the same rows.
 */
export function rowsOf(r, bars = []) {
  const project = r.project ?? r.lifecycle?.project ?? null;
  const ended = ENDED.has(r.status) ? (r.run?.closed_at ?? r.updated ?? null) : null;
  const build = { id: r.id, project, name: r.name ?? null, status: r.status ?? null, started: r.created ?? null, ended, updated: r.updated ?? null };

  const staged = bars.filter((b) => typeof b?.stage === "string" && b.stage);
  const steps = staged.map((b) => {
    const closed = typeof b.end === "string" && Number.isFinite(b.duration_ms);
    const split = closed ? b.split : null;
    return {
      build_id: r.id, project, stage: b.stage, phase: b.phase ?? null, round: num(b.round), holder: b.holder ?? null, kind: b.kind ?? null,
      started: b.start ?? null, ended: closed ? b.end : null, duration_ms: closed ? b.duration_ms : null,
      // A bar of a person's kind is all a person's time; any other is an agent's, less any wait on a person inside it.
      person_ms: !closed ? null : split ? split.person_ms : b.kind === "person" ? b.duration_ms : 0,
      agent_ms: !closed ? null : split ? (split.agent_ms ?? 0) + (split.external_ms ?? 0) : b.kind === "person" ? 0 : b.duration_ms,
      status: b.status ?? null,
    };
  });

  const ids = [...new Set([...Object.keys(r.stages ?? {}), ...steps.map((s) => s.stage)])];
  const stages = [];
  const rounds = [];
  for (const stage of ids) {
    const s = r.stages?.[stage];
    const mine = steps.filter((x) => x.stage === stage);
    const list = Array.isArray(s?.rounds) ? s.rounds : [];
    if (!mine.length && !list.length) continue;
    const holder = s?.holder?.name ?? mine.find((x) => x.holder)?.holder ?? null;
    const open = mine.some((x) => x.ended === null);
    const starts = mine.map((x) => x.started).filter(Boolean).sort();
    const ends = mine.map((x) => x.ended).filter(Boolean).sort();
    const started = starts[0] ?? null;
    const sum = (k) => mine.reduce((t, x) => t + (x[k] ?? 0), 0);
    stages.push({
      build_id: r.id, project, stage, holder, started,
      ended: mine.length && !open ? ends[ends.length - 1] ?? null : null,
      time_ms: mine.length && !open ? sum("duration_ms") : null,
      person_ms: sum("person_ms"), agent_ms: sum("agent_ms"),
      rounds: list.length, sent_back: list.filter((x) => x?.back === true).length,
    });
    // A round runs from the round before it (or the stage's start) to its own time.
    let before = started;
    for (const x of list) {
      const at = typeof x?.at === "string" ? x.at : null;
      rounds.push({ build_id: r.id, project, stage, n: num(x?.n), holder, started: before, ended: at, sent_back: x?.back === true ? 1 : 0, verdict: x?.verdict ?? null });
      if (at) before = at;
    }
  }
  return { build, stages, rounds, steps };
}

/**
 * The history for a store, in <store.root>/history.sqlite. It watches the
 * store, so every save of a build writes that build's rows again. null when
 * this Node has no node:sqlite (HISTORY_UNAVAILABLE says why).
 * now: the clock analytics reads its window from. bars: a build's timeline
 * bars, each with its stage and split; by default read from its run.
 */
export function createHistory({ store, file = join(store.root, HISTORY_FILE), now = () => new Date().toISOString(), bars = null }) {
  if (!sqlite) return null;
  const docs = new Map();

  function open() {
    let d = null;
    try {
      d = new sqlite.DatabaseSync(file);
      d.prepare("SELECT count(*) FROM sqlite_master").get();
      return d;
    } catch {
      // Not a database Product Factory can read: it is put aside, and the history is built again.
      try { d?.close(); } catch { /* not open */ }
      try { renameSync(file, `${file}.unreadable-${Date.now()}`); } catch { /* nothing to put aside */ }
      return new sqlite.DatabaseSync(file);
    }
  }

  const fresh = !existsSync(file);
  const db = open();
  const current = db.prepare("PRAGMA user_version").get().user_version === VERSION && !fresh;

  function make() {
    db.exec("DROP TABLE IF EXISTS builds; DROP TABLE IF EXISTS stages; DROP TABLE IF EXISTS rounds; DROP TABLE IF EXISTS steps;");
    db.exec(SCHEMA);
    db.exec(`PRAGMA user_version = ${VERSION}`);
  }

  let st = null;
  const prep = () => {
    st = {
      drop: ["builds", "stages", "rounds", "steps"].map((t) => db.prepare(`DELETE FROM ${t} WHERE ${t === "builds" ? "id" : "build_id"} = ?`)),
      build: db.prepare("INSERT INTO builds (id, project, name, status, started, ended, updated) VALUES (?, ?, ?, ?, ?, ?, ?)"),
      stage: db.prepare("INSERT INTO stages (build_id, project, stage, holder, started, ended, time_ms, person_ms, agent_ms, rounds, sent_back) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
      round: db.prepare("INSERT INTO rounds (build_id, project, stage, n, holder, started, ended, sent_back, verdict) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"),
      step: db.prepare("INSERT INTO steps (build_id, project, stage, phase, round, holder, kind, started, ended, duration_ms, person_ms, agent_ms, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
      updated: db.prepare("SELECT id, updated FROM builds"),
    };
  };

  /** The run's timeline with its split, read from the build's own process document. */
  function barsOf(r) {
    if (!r?.run || !r.process) return [];
    const one = (key, run, at) => {
      let doc = docs.get(key);
      if (!doc) {
        try { doc = parse(readFileSync(at, "utf8")); } catch { return []; }
        docs.set(key, doc);
      }
      try { return timelineOf(run, doc, { split: true }); } catch { return []; }
    };
    return one(r.id, r.run, join(store.folder(r.id), r.process));
  }

  function write(r) {
    const { build, stages, rounds, steps } = rowsOf(r, (bars ?? barsOf)(r));
    for (const d of st.drop) d.run(r.id);
    st.build.run(build.id, build.project, build.name, build.status, build.started, build.ended, build.updated);
    for (const s of stages) st.stage.run(s.build_id, s.project, s.stage, s.holder, s.started, s.ended, s.time_ms, s.person_ms, s.agent_ms, s.rounds, s.sent_back);
    for (const x of rounds) st.round.run(x.build_id, x.project, x.stage, x.n, x.holder, x.started, x.ended, x.sent_back, x.verdict);
    for (const x of steps) st.step.run(x.build_id, x.project, x.stage, x.phase, x.round, x.holder, x.kind, x.started, x.ended, x.duration_ms, x.person_ms, x.agent_ms, x.status);
  }

  function inOne(fn) {
    db.exec("BEGIN");
    try { fn(); db.exec("COMMIT"); } catch (e) { try { db.exec("ROLLBACK"); } catch { /* none open */ } throw e; }
  }

  /** One build's rows, written again from its record. Never throws: the build file is what counts. */
  function record(r) {
    if (!r?.id) return false;
    try { inOne(() => write(r)); return true; } catch { return false; }
  }

  /** Every build's rows, from the build folders alone. */
  function rebuild() {
    inOne(() => {
      make();
      prep();
      for (const r of store.list()) write(r);
    });
  }

  /** Builds changed or removed while the history was not watching are caught up. */
  function sync() {
    const have = new Map(st.updated.all().map((x) => [x.id, x.updated]));
    inOne(() => {
      for (const r of store.list()) {
        if (have.get(r.id) !== r.updated) write(r);
        have.delete(r.id);
      }
      for (const id of have.keys()) for (const d of st.drop) d.run(id);
    });
  }

  if (current) { prep(); sync(); } else rebuild();
  const stopWatching = store.onSave(record);

  /**
   * GET /v1/lifecycle/analytics?window=7d|30d|all&project=. Four questions over
   * the window, from the history alone, never estimated:
   *   builds        builds started, finished (done) and stopped, per week
   *   stage_times   the median time per stage per week, over the stages that
   *                 finished that week (the sum of the stage's bars, as the
   *                 Dashboard counts it)
   *   send_backs    per stage over the window: rounds, rounds sent back, the rate
   *   waiting       per week, the time waiting on a person and the time an agent
   *                 was working, from the steps that ended that week
   */
  function analytics({ window = null, project = null } = {}) {
    const w = window ?? "30d";
    if (!Object.hasOwn(WINDOWS, w)) throw new Refused(400, "window is 7d, 30d or all.");
    const to = now();
    const days = WINDOWS[w];
    const from = days ? new Date(Date.parse(to) - days * DAY).toISOString() : null;
    const inWindow = (t) => typeof t === "string" && (!from || t >= from) && t <= to;
    const where = "WHERE (? IS NULL OR project = ?)";
    const p = [project, project];

    const builds = db.prepare(`SELECT started, ended, status FROM builds ${where}`).all(...p);
    const stages = db.prepare(`SELECT stage, ended, time_ms FROM stages ${where} AND ended IS NOT NULL AND time_ms IS NOT NULL`).all(...p);
    const rounds = db.prepare(`SELECT build_id, stage, ended, sent_back FROM rounds ${where}`).all(...p);
    const steps = db.prepare(`SELECT ended, person_ms, agent_ms FROM steps ${where} AND ended IS NOT NULL`).all(...p);
    const projects = db.prepare("SELECT DISTINCT project FROM builds WHERE project IS NOT NULL ORDER BY project").all().map((x) => x.project);

    // The weeks the window covers, oldest first; for all, from the first build's week.
    const first = from ?? builds.map((b) => b.started).filter(Boolean).sort()[0] ?? to;
    const weeks = [];
    for (let t = Date.parse(`${weekOf(first)}T00:00:00Z`), end = Date.parse(`${weekOf(to)}T00:00:00Z`); t <= end; t += 7 * DAY) weeks.push(weekOf(t));

    const perWeek = new Map(weeks.map((k) => [k, { week: k, started: 0, finished: 0, stopped: 0 }]));
    for (const b of builds) {
      const a = inWindow(b.started) && perWeek.get(weekOf(b.started));
      if (a) a.started++;
      const e = inWindow(b.ended) && perWeek.get(weekOf(b.ended));
      if (e) e[b.status === "stopped" ? "stopped" : "finished"]++;
    }

    const times = new Map();
    for (const s of stages) {
      if (!inWindow(s.ended)) continue;
      const byWeek = times.get(s.stage) ?? times.set(s.stage, new Map()).get(s.stage);
      const k = weekOf(s.ended);
      (byWeek.get(k) ?? byWeek.set(k, []).get(k)).push(s.time_ms);
    }
    const order = (a, b) => (STAGE_NUMBER.get(a.stage) ?? Infinity) - (STAGE_NUMBER.get(b.stage) ?? Infinity) || a.stage.localeCompare(b.stage);
    const stageTimes = [...times].map(([stage, byWeek]) => ({
      stage, name: STAGE_NAME.get(stage) ?? stage,
      weeks: weeks.filter((k) => byWeek.has(k)).map((k) => ({ week: k, median_ms: median(byWeek.get(k)), builds: byWeek.get(k).length })),
    })).sort(order);

    const backs = new Map();
    for (const x of rounds) {
      if (!inWindow(x.ended)) continue;
      const row = backs.get(x.stage) ?? backs.set(x.stage, { stage: x.stage, name: STAGE_NAME.get(x.stage) ?? x.stage, rounds: 0, back: 0, rate: 0, ids: new Set() }).get(x.stage);
      row.rounds++;
      row.back += x.sent_back ? 1 : 0;
      row.ids.add(x.build_id);
    }
    const sendBacks = [...backs.values()].map(({ ids, ...row }) => ({ ...row, rate: row.rounds ? row.back / row.rounds : 0, builds: ids.size })).sort(order);

    const waiting = new Map(weeks.map((k) => [k, { week: k, person_ms: 0, agent_ms: 0 }]));
    for (const x of steps) {
      if (!inWindow(x.ended)) continue;
      const row = waiting.get(weekOf(x.ended));
      if (!row) continue;
      row.person_ms += x.person_ms ?? 0;
      row.agent_ms += x.agent_ms ?? 0;
    }

    return {
      window: w, project, from, to, weeks, projects,
      builds: [...perWeek.values()],
      stage_times: stageTimes,
      send_backs: sendBacks,
      waiting: [...waiting.values()],
    };
  }

  return {
    file,
    record, rebuild, sync, analytics,
    close() { stopWatching(); try { db.close(); } catch { /* closed */ } },
  };
}
