// Builds walked through the stages milestone 1 runs, with fake holders: one
// builder (the stand-in builder and the stand-in kit) for a new agent, and the
// stand-in reference writers under fixtures/fake-adlc for a rebuild from an
// as-built record, with a stand-in packer. Every answer along the way goes
// through the console's contract checks.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { factory, stageOf, actionNames, walk, startRebuild } from "./helpers.mjs";
import { checkBuild } from "adlc-console/lib/contract.mjs";
import { STAGE_IDS } from "../lib/standards.mjs";

const FOLDER = join(dirname(fileURLToPath(import.meta.url)), "..", "runtimes", "folder.mjs");
const leftOut = { version: "0.1", organization: { used: { review: false, docs: false } } };
const ok = (b) => assert.deepEqual(checkBuild({ build: b }, STAGE_IDS), []);
const calls = (f) => (existsSync(f.stubLog) ? readFileSync(f.stubLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

test("a walked build's timeline has one bar per phase per round, each with its stage", async (t) => {
  const f = await factory({ runtime: { command: ["node", FOLDER, "--into", "./installed"] } });
  t.after(f.close);
  const id = (await f.post("/builds", { does: "Count the words in a passage." })).json.build.id;
  let b = await f.settled(id);
  // While the spec waits on the person, its gate is an open bar at Requirements.
  const open = b.timeline.filter((x) => x.end === null);
  assert.ok(open.some((x) => x.stage === "requirements" && x.kind === "person"), JSON.stringify(open));
  b = await walk(f, id);
  ok(b);
  const bars = b.timeline;
  assert.ok(bars.length > 0);
  for (const x of bars) {
    for (const k of ["phase", "stage", "round", "holder", "kind", "start", "end", "duration_ms", "status"]) assert.ok(k in x, `${x.phase}: ${k}`);
    assert.ok(STAGE_IDS.includes(x.stage), `${x.phase} is at a stage of stages.json`);
    assert.ok(["agent", "person", "external"].includes(x.kind));
  }
  const at = (phase) => bars.filter((x) => x.phase === phase);
  assert.deepEqual([...new Set(at("write-the-spec").map((x) => x.stage))], ["requirements"]);
  assert.deepEqual([...new Set(at("approve-the-spec").map((x) => x.stage))], ["requirements"]);
  // One builder's phase starts at the first stage it holds.
  assert.deepEqual([...new Set(at("build-the-agent").map((x) => x.stage))], ["architecture"]);
  assert.deepEqual([...new Set(at("make-the-package").map((x) => x.stage))], ["package"]);
  assert.deepEqual([...new Set(at("approve-the-deploy").map((x) => x.stage))], ["deploy"]);
  assert.deepEqual([...new Set(at("deploy-the-agent").map((x) => x.stage))], ["deploy"]);
  assert.deepEqual([...new Set(at("check-conformance").map((x) => x.stage))], ["conformance"]);
  // Done: every bar closed, ordered by start, each with its duration.
  for (const x of bars) assert.equal(x.duration_ms, Date.parse(x.end) - Date.parse(x.start), x.phase);
  const starts = bars.map((x) => Date.parse(x.start));
  assert.deepEqual(starts, [...starts].sort((p, q) => p - q));
});

test("a build keeps the lifecycle it started under; a later change does not touch it", async (t) => {
  const f = await factory({ doc: leftOut });
  t.after(f.close);
  const id = (await f.post("/builds", { does: "Count the words." })).json.build.id;
  await f.settled(id);
  assert.equal((await f.put("/stages/review", { used: true })).status, 200);
  assert.equal((await f.put("/stages/package", { used: false })).status, 200);
  const b = (await f.get(`/builds/${id}`)).json.build;
  assert.equal(stageOf(b, "review").state, "not_used");
  assert.equal(stageOf(b, "package").state, "not_started");
  assert.deepEqual(b.lifecycle.project, null);
  // A build started now follows the new choice: Package is left out, so it ends once the build has passed.
  const id2 = (await f.post("/builds", { does: "Count the words.", name: "counter" })).json.build.id;
  const done = await walk(f, id2);
  ok(done);
  assert.equal(stageOf(done, "package").state, "not_used");
  assert.equal(done.summary, "Code OK'd · counter 0.1.0 · Package is not part of this lifecycle");
  assert.equal(stageOf(done, "code").state, "done");
});

test("a project's lifecycle is the one a build under that project follows", async (t) => {
  const f = await factory({ doc: { version: "0.1", organization: {}, projects: { web: { used: { package: false } } } } });
  t.after(f.close);
  const b = (await f.post("/builds", { does: "Count the words.", project: "web" })).json.build;
  ok(b);
  assert.deepEqual(b.lifecycle.project, "web");
  assert.equal(b.project, "web");
  assert.equal(stageOf(b, "package").state, "not_used");
  assert.match(stageOf(b, "package").given, /the project web leaves it out/);
  await f.settled(b.id);
});

test("on a rebuild, the reference code writer holds Code with its own workspace, check and delivery check", async (t) => {
  const f = await factory({ failRounds: 1 });
  t.after(f.close);
  const id = await startRebuild(f, { does: "Count the words.", name: "counter" });
  await f.settled(id);
  await f.post(`/builds/${id}/actions/approve`);
  const b = await f.settled(id);
  ok(b);
  const code = stageOf(b, "code");
  assert.deepEqual(code.holder, { kind: "reference_agent", name: "code-writer", role: "code-writer" });
  assert.equal(code.state, "waiting_on_you");
  assert.equal(code.rounds.length, 2);
  assert.equal(code.rounds[1].verdict, "The suite fails");
  assert.match(code.rounds[0].words, /delivery check accepted it/);
  assert.deepEqual(actionNames(b), ["accept", "stop"]);
  const h = calls(f);
  assert.ok(h[0].cwd.endsWith(join("code-writer", "workspace")));
  assert.match(h[0].prompt, /reference code writer/);
});

test("on a rebuild, when the rounds run out Code stops and waits; more rounds finish it", async (t) => {
  const f = await factory({ failRounds: 3, rounds: 2 });
  t.after(f.close);
  const id = await startRebuild(f, { does: "Count the words.", name: "counter" });
  await f.settled(id);
  await f.post(`/builds/${id}/actions/approve`);
  let b = await f.settled(id);
  ok(b);
  assert.equal(stageOf(b, "code").state, "refused");
  assert.equal(stageOf(b, "code").rounds.length, 2);
  assert.match(stageOf(b, "code").handed_back.words[0], /still does not pass after 2 rounds/);
  // Code was refused: more rounds, or the spec may be what has to change (0.4.7).
  assert.deepEqual(actionNames(b), ["resume", "back_to_requirements", "stop"]);
  assert.equal(b.actions[0].label, "Give it more rounds");
  await f.post(`/builds/${id}/actions/resume`);
  b = await f.settled(id);
  ok(b);
  assert.equal(stageOf(b, "code").state, "waiting_on_you");
  assert.equal(stageOf(b, "code").rounds.length, 4);
  assert.equal(stageOf(b, "code").runs, 2);
  assert.equal(calls(f).length, 4);
});

test("a stage that cannot run says why in words, asking for changes needs words, and stopping a build ends it", async (t) => {
  const f = await factory({ harness: false });
  t.after(f.close);
  const refusedAtSpec = await f.settled((await f.post("/builds", { does: "Count the words." })).json.build.id);
  ok(refusedAtSpec);
  assert.equal(stageOf(refusedAtSpec, "requirements").state, "refused");
  assert.match(stageOf(refusedAtSpec, "requirements").handed_back.words[0], /No coding harness is set/);
  assert.deepEqual(actionNames(refusedAtSpec), ["resume", "changes", "stop"]);
  assert.equal((await f.post(`/builds/${refusedAtSpec.id}/actions/changes`, {})).status, 400);
  const stopped = await f.post(`/builds/${refusedAtSpec.id}/actions/stop`);
  ok(stopped.json.build);
  assert.equal(stageOf(stopped.json.build, "requirements").state, "stopped");
  assert.equal(stopped.json.build.summary, "Stopped at Requirements");
  assert.deepEqual(actionNames(stopped.json.build), ["archive"]);
  const notNow = await f.post(`/builds/${refusedAtSpec.id}/actions/approve`);
  assert.equal(notNow.status, 409);
  assert.equal(typeof notNow.json.error, "string");
  ok(notNow.json.build);

  // Archived builds leave the list, and come back with ?archived=1.
  await f.post(`/builds/${refusedAtSpec.id}/actions/archive`);
  assert.ok(!(await f.get("/builds")).json.builds.some((x) => x.id === refusedAtSpec.id));
  assert.ok((await f.get("/builds?archived=1")).json.builds.some((x) => x.id === refusedAtSpec.id && x.archived));
});

test("a build that was running when Product Factory stopped runs its stage again", async (t) => {
  const f = await factory();
  t.after(f.close);
  const id = (await f.post("/builds", { does: "Count the words.", name: "counter" })).json.build.id;
  await f.settled(id);
  // Stop Product Factory while the builder is working: the build stays working in its record.
  await f.post(`/builds/${id}/actions/approve`);
  await f.runner.stopAll();
  assert.equal(f.store.read(id).status, "working");
  await f.runner.resumeAll();
  const b = await f.settled(id);
  assert.equal(stageOf(b, "test").state, "done");
  assert.equal(stageOf(b, "code").state, "done");
  assert.ok(b.log.some((e) => /^Product Factory started again while .+ was running, so it runs again\.$/.test(e.said)));
});
