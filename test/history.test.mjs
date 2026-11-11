// The history (lib/history.mjs) and GET /v1/lifecycle/analytics: rows worked
// out from build records alone, the four questions over hand-made builds
// where every number is known, the history built again from the build files
// when its file is missing, and the route as the service answers it.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore, RECORD_FORMAT } from "../lib/store.mjs";
import { createHistory, rowsOf, weekOf, median, HISTORY_FILE } from "../lib/history.mjs";
import { factory, tempDir } from "./helpers.mjs";
import { checkAnalytics } from "adlc-console/lib/contract.mjs";

const MIN = 60_000;
const NOW = "2026-11-08T12:00:00.000Z"; // a Sunday: its week began Monday 2026-11-02
const at = (day, h, m = 0) => new Date(Date.UTC(2026, 10, day, h, m)).toISOString();
const oct = (day, h, m = 0) => new Date(Date.UTC(2026, 9, day, h, m)).toISOString();

function record(id, { created, status = "working", project = null, closed = null, stages = {} }) {
  return {
    format: RECORD_FORMAT, id, name: id, does: "Count the words.", version: "0.1.0",
    ...(project ? { project } : {}), created, updated: closed ?? created, archived: false, status, at: "requirements",
    lifecycle: { project, at: created, used: {} }, run: closed ? { closed_at: closed } : null, stages, work: {}, log: [],
  };
}
const stage = (holder, rounds = []) => ({ state: "done", holder: { kind: "reference_agent", name: holder }, runs: rounds.length, rounds, given: "", handed_back: { words: [], files: [] }, done_when_met: null, log: [] });
const round = (n, when, back) => ({ n, at: when, label: `Round ${n}`, verdict: back ? "Sent back" : "Passed", back, words: "" });
// A timeline bar with its stage and the runner's split; end null while it is open.
function bar(stageId, kind, start, end, personMs = null) {
  const d = end ? Date.parse(end) - Date.parse(start) : null;
  const person = end ? (personMs ?? (kind === "person" ? d : 0)) : null;
  return { phase: `${stageId}-${kind}`, stage: stageId, round: 1, holder: kind === "person" ? null : `${stageId}.example`, kind, start, end, duration_ms: d, status: end ? "closed" : "working", split: end ? { person_ms: person, agent_ms: kind === "agent" ? d - person : 0, external_ms: 0 } : null };
}

// A: project web, done this week; B: stopped in October; C: working now; D: done long ago.
const A = record("b_aaaaaaaaaaaa", { created: at(3, 10), status: "done", project: "web", closed: at(4, 10), stages: {
  requirements: stage("spec-writer", [round(1, at(3, 10, 20), true), round(2, at(3, 10, 30), false)]),
  code: stage("code-writer", [round(1, at(3, 12, 20), false)]),
} });
const B = record("b_bbbbbbbbbbbb", { created: oct(20, 9), status: "stopped", closed: oct(21, 9), stages: { requirements: stage("spec-writer", [round(1, oct(20, 9, 10), false)]) } });
const C = record("b_cccccccccccc", { created: at(5, 9), stages: { requirements: stage("spec-writer") } });
const D = { ...record("b_dddddddddddd", { created: "2025-01-01T09:00:00.000Z", status: "done", closed: "2025-01-01T10:00:00.000Z" }) };
const BARS = {
  [A.id]: [bar("requirements", "agent", at(3, 10), at(3, 10, 30)), bar("requirements", "person", at(3, 10, 30), at(3, 11, 30)), bar("code", "agent", at(3, 12), at(3, 12, 20))],
  [B.id]: [bar("requirements", "agent", oct(20, 9), oct(20, 9, 10))],
  [C.id]: [bar("requirements", "agent", at(5, 9), null)],
};

async function handMade() {
  const dir = await tempDir("history");
  const store = createStore({ dir });
  for (const r of [A, B, C, D]) store.create(structuredClone(r));
  return { dir, store, open: () => createHistory({ store, now: () => NOW, bars: (r) => BARS[r.id] ?? [] }) };
}

test("weeks start on Monday (UTC), and the median is the middle value", () => {
  assert.equal(weekOf("2026-11-08T23:59:00Z"), "2026-11-02");
  assert.equal(weekOf("2026-11-02T00:00:00Z"), "2026-11-02");
  assert.equal(weekOf("2026-11-01T23:59:00Z"), "2026-10-26");
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 10]), 3.5);
  assert.equal(median([]), null);
});

test("a build's rows come from its record and its timeline alone", () => {
  const { build, stages, rounds, steps } = rowsOf(A, BARS[A.id]);
  assert.deepEqual(build, { id: A.id, project: "web", name: A.id, status: "done", started: at(3, 10), ended: at(4, 10), updated: at(4, 10) });
  const req = stages.find((s) => s.stage === "requirements");
  assert.deepEqual(req, { build_id: A.id, project: "web", stage: "requirements", holder: "spec-writer", started: at(3, 10), ended: at(3, 11, 30), time_ms: 90 * MIN, person_ms: 60 * MIN, agent_ms: 30 * MIN, rounds: 2, sent_back: 1 });
  assert.deepEqual(rounds.filter((x) => x.stage === "requirements").map((x) => [x.n, x.started, x.ended, x.sent_back]), [[1, at(3, 10), at(3, 10, 20), 1], [2, at(3, 10, 20), at(3, 10, 30), 0]]);
  assert.equal(steps.length, 3);
  // A stage with a bar still open has no end and no time yet.
  const open = rowsOf(C, BARS[C.id]).stages[0];
  assert.equal(open.ended, null);
  assert.equal(open.time_ms, null);
});

test("the four questions over a window, and by project", async (t) => {
  const h = await handMade();
  const history = h.open();
  t.after(() => history.close());

  const week = history.analytics({ window: "7d" });
  for (const w of ["7d", "30d", "all"]) assert.deepEqual(checkAnalytics(history.analytics({ window: w })), [], w);
  assert.deepEqual(checkAnalytics(history.analytics({ window: "30d", project: "web" })), []);
  assert.deepEqual(week.weeks, ["2026-10-26", "2026-11-02"]);
  assert.deepEqual(week.projects, ["web"]);
  assert.deepEqual(week.builds, [{ week: "2026-10-26", started: 0, finished: 0, stopped: 0 }, { week: "2026-11-02", started: 2, finished: 1, stopped: 0 }]);
  assert.deepEqual(week.stage_times, [
    { stage: "requirements", name: "Requirements", weeks: [{ week: "2026-11-02", median_ms: 90 * MIN, builds: 1 }] },
    { stage: "code", name: "Code", weeks: [{ week: "2026-11-02", median_ms: 20 * MIN, builds: 1 }] },
  ]);
  assert.deepEqual(week.send_backs, [
    { stage: "requirements", name: "Requirements", rounds: 2, back: 1, rate: 0.5, builds: 1 },
    { stage: "code", name: "Code", rounds: 1, back: 0, rate: 0, builds: 1 },
  ]);
  assert.deepEqual(week.waiting, [{ week: "2026-10-26", person_ms: 0, agent_ms: 0 }, { week: "2026-11-02", person_ms: 60 * MIN, agent_ms: 50 * MIN }]);

  const month = history.analytics({ window: "30d" });
  assert.deepEqual(month.weeks, ["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02"]);
  assert.deepEqual(month.builds.find((x) => x.week === "2026-10-19"), { week: "2026-10-19", started: 1, finished: 0, stopped: 1 });
  // Requirements: 10 min in B's week, 90 min in A's.
  assert.deepEqual(month.stage_times[0].weeks.map((x) => [x.week, x.median_ms]), [["2026-10-19", 10 * MIN], ["2026-11-02", 90 * MIN]]);
  assert.deepEqual(month.send_backs[0], { stage: "requirements", name: "Requirements", rounds: 3, back: 1, rate: 1 / 3, builds: 2 });

  const all = history.analytics({ window: "all" });
  assert.equal(all.weeks[0], "2024-12-30");
  assert.equal(all.weeks.at(-1), "2026-11-02");
  assert.equal(all.builds.reduce((n, x) => n + x.finished, 0), 2);

  const web = history.analytics({ window: "30d", project: "web" });
  assert.equal(web.project, "web");
  assert.equal(web.builds.reduce((n, x) => n + x.started, 0), 1);
  assert.deepEqual(web.send_backs.map((x) => x.stage), ["requirements", "code"]);
  const none = history.analytics({ window: "30d", project: "nobody" });
  assert.equal(none.builds.reduce((n, x) => n + x.started, 0), 0);
  assert.deepEqual(none.stage_times, []);

  assert.equal(history.analytics({}).window, "30d", "30 days when no window is given");
  assert.throws(() => history.analytics({ window: "1y" }), /window is 7d, 30d or all/);
});

test("the history follows each save, and is built again from the build files when its file is missing", async (t) => {
  const h = await handMade();
  let history = h.open();
  const before = history.analytics({ window: "all" });

  // A save reaches the history at once: C finishes.
  await h.store.update(C.id, (r) => { r.status = "done"; r.run = { closed_at: at(6, 9) }; });
  const after = history.analytics({ window: "all" });
  assert.equal(after.builds.reduce((n, x) => n + x.finished, 0), before.builds.reduce((n, x) => n + x.finished, 0) + 1);
  history.close();

  // The file is removed: the history is built again from the build folders, with the same answers.
  const file = join(h.dir, HISTORY_FILE);
  assert.ok(existsSync(file));
  rmSync(file);
  history = h.open();
  assert.ok(existsSync(file));
  assert.deepEqual(history.analytics({ window: "all" }), after);
  history.close();

  // A build changed while nothing watched (here, by hand) is caught up when the history opens.
  const bFile = join(h.store.folder(B.id), "build.json");
  const b = JSON.parse(readFileSync(bFile, "utf8"));
  writeFileSync(bFile, JSON.stringify({ ...b, project: "web", updated: at(7, 9) }));
  history = h.open();
  t.after(() => history.close());
  assert.equal(history.analytics({ window: "all", project: "web" }).builds.reduce((n, x) => n + x.started, 0), 2);

  // A file that is not a database is put aside and the history built again.
  history.close();
  writeFileSync(file, "not a database");
  history = h.open();
  assert.equal(history.analytics({ window: "all" }).builds.reduce((n, x) => n + x.started, 0), 4);
});

test("GET /v1/lifecycle/analytics: Product Factory's own route, from real walked builds", async (t) => {
  // The walked build goes through the deploy gate to the reference runtime, so it finishes.
  const f = await factory({ failRounds: 1, runtime: { command: ["node", fileURLToPath(new URL("../runtimes/folder.mjs", import.meta.url)), "--into", "./installed"] } });
  t.after(f.close);
  const id = (await f.post("/builds", { does: "Count the words in a passage.", project: "web" })).json.build.id;
  await f.settled(id);
  await f.post(`/builds/${id}/actions/changes`, { changes: "Say what it refuses." });
  await f.settled(id);
  await f.post(`/builds/${id}/actions/approve`);
  await f.settled(id);
  await f.post(`/builds/${id}/actions/accept`);
  await f.settled(id);
  await f.post(`/builds/${id}/actions/approve`);
  await f.settled(id);
  const other = (await f.post("/builds", { does: "Count the words." })).json.build.id;
  await f.settled(other);
  await f.post(`/builds/${other}/actions/stop`);

  const r = await f.get("/analytics?window=7d");
  assert.equal(r.status, 200);
  const a = r.json;
  // The console's own check for the analytics answer (adlc-console lib/contract.mjs).
  assert.deepEqual(checkAnalytics(a), []);
  for (const k of ["window", "project", "from", "to", "weeks", "projects", "builds", "stage_times", "send_backs", "waiting"]) assert.ok(k in a, k);
  assert.equal(a.window, "7d");
  assert.deepEqual(a.projects, ["web"]);
  const sum = (rows, k) => rows.reduce((n, x) => n + x[k], 0);
  assert.equal(sum(a.builds, "started"), 2);
  assert.equal(sum(a.builds, "finished"), 1);
  assert.equal(sum(a.builds, "stopped"), 1);
  // The walked build ran Requirements, Test, Code and Package, and the deploy gate, each now finished with a time.
  assert.deepEqual(a.stage_times.map((x) => x.stage), ["requirements", "architecture", "test", "code", "package", "deploy"]);
  // Code's first round failed the suite and Requirements was sent back with changes.
  const backs = Object.fromEntries(a.send_backs.map((x) => [x.stage, x]));
  assert.equal(backs.code.back, 1);
  assert.ok(backs.requirements.back >= 1);
  // The spec's gate waited on a person; the reference agents worked.
  assert.ok(sum(a.waiting, "person_ms") > 0);
  assert.ok(sum(a.waiting, "agent_ms") > 0);

  const web = await f.get("/analytics?window=all&project=web");
  assert.deepEqual(checkAnalytics(web.json), []);
  assert.equal(sum(web.json.builds, "started"), 1);
  assert.equal((await f.get("/analytics?window=1y")).status, 400);
  assert.equal((await f.call("POST", "/analytics", {})).status, 405);
  assert.equal((await f.call("GET", "/analytics", undefined, { auth: null })).status, 401);
});

test("a service with no history does not offer the route", async (t) => {
  const f = await factory({ history: false });
  t.after(f.close);
  const r = await f.get("/analytics?window=7d");
  assert.equal(r.status, 404);
});
