// A build walked through every stage milestone 1 runs, with fake holders:
// the stand-in spec writer, test writer and hand-off under fixtures/fake-adlc,
// a stand-in coding harness and a stand-in packer. Every answer along the way
// goes through the console's contract checks.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { factory, stageOf, actionNames, MODEL_VARS } from "./helpers.mjs";
import { checkBuild, checkBuildList } from "adlc-console/lib/contract.mjs";
import { STAGE_IDS } from "../lib/standards.mjs";

const FOLDER = join(dirname(fileURLToPath(import.meta.url)), "..", "runtimes", "folder.mjs");
const leftOut = { version: "0.1", organization: { used: { review: false, docs: false } } };
const ok = (b) => assert.deepEqual(checkBuild({ build: b }, STAGE_IDS), []);
const calls = (f) => (existsSync(f.stubLog) ? readFileSync(f.stubLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

test("a build runs every stage: spec, your approval, suite, a failed round, your OK, package", async (t) => {
  const f = await factory({ holder: "harness", doc: leftOut, failRounds: 1 });
  t.after(f.close);

  // Start it. Requirements runs, and the build waits for the person to approve the spec.
  const started = await f.post("/builds", { does: "Count the words in a passage.", refuses: "Changing the passage." });
  assert.equal(started.status, 201);
  ok(started.json.build);
  const id = started.json.build.id;
  let b = await f.settled(id);
  ok(b);
  assert.equal(stageOf(b, "requirements").state, "waiting_on_you");
  assert.equal(stageOf(b, "requirements").holder.kind, "reference_agent");
  assert.deepEqual(actionNames(b), ["approve", "changes", "stop"]);
  assert.equal(b.summary, "Waiting on you at Requirements");
  assert.match(stageOf(b, "requirements").handed_back.words[0], /Drafted the spec/);
  const files = stageOf(b, "requirements").handed_back.files.map((x) => x.path);
  assert.ok(files.includes("requirements/agent-descriptor.json"));
  assert.ok(files.includes("requirements/still-open.md"));
  const asked = JSON.parse(readFileSync(join(f.store.folder(id), "stages", "requirements", "records", "r1", "asked.json"), "utf8"));
  assert.match(asked.said, /^Write a spec\.\nwhat it should do: Count the words in a passage\./);
  assert.equal(asked.model.MODEL_NAME, "stand-in-model", "the model settings reach the spec writer under the names it reads");

  // The left-out stages read not_used; the stages milestone 1 does not run read not_offered.
  assert.equal(stageOf(b, "review").state, "not_used");
  assert.match(stageOf(b, "review").given, /^Not part of this build's lifecycle: the organization leaves it out\.$/);
  assert.equal(stageOf(b, "docs").state, "not_used");
  assert.equal(stageOf(b, "security").state, "not_offered");
  assert.match(stageOf(b, "deploy").given, /hands the package to the runtime you bring/);

  // Ask for changes: the spec writer gets them as a revision, with its earlier files attached.
  const changed = await f.post(`/builds/${id}/actions/changes`, { changes: "name: word-counter" });
  assert.equal(changed.status, 200);
  ok(changed.json.build);
  b = await f.settled(id);
  ok(b);
  const req = stageOf(b, "requirements");
  assert.equal(req.state, "waiting_on_you");
  assert.equal(req.runs, 2);
  assert.equal(req.rounds[0].n, 2);
  assert.equal(req.rounds[1].verdict, "You asked for changes");
  assert.equal(req.rounds[1].back, true);
  const revised = JSON.parse(readFileSync(join(f.store.folder(id), "stages", "requirements", "records", "r2", "asked.json"), "utf8"));
  assert.match(revised.said, /^changes: name: word-counter/);
  assert.equal(revised.files.length, 6, "the earlier draft's spec (spec.json and spec.md) and the agent's own files go back with the changes");
  assert.equal(b.name, "word-counter", "the build takes the name the spec settles");

  // Approve the spec: Test runs, then Code. The first harness round fails the suite; the second passes.
  const approved = await f.post(`/builds/${id}/actions/approve`);
  assert.equal(approved.status, 200);
  ok(approved.json.build);
  b = await f.settled(id);
  ok(b);
  assert.equal(stageOf(b, "requirements").state, "done");
  assert.equal(stageOf(b, "requirements").rounds[0].verdict, "Approved");
  assert.equal(stageOf(b, "test").state, "done");
  // The count test, and the test of the interface the spec keeps (stages.json 1.6.0).
  assert.deepEqual(stageOf(b, "test").handed_back.files.map((x) => x.path), ["test/count.test.mjs", "test/kept-interfaces.test.mjs"]);
  const code = stageOf(b, "code");
  assert.equal(code.state, "waiting_on_you");
  assert.equal(code.holder.kind, "your_agent");
  assert.match(code.holder.name, /your coding harness/);
  assert.equal(code.rounds.length, 2);
  assert.equal(code.rounds[1].verdict, "The suite fails");
  assert.equal(code.rounds[1].back, true);
  assert.match(code.rounds[1].words, /counts the words in a passage/);
  assert.equal(code.rounds[0].verdict, "The suite passes");
  assert.equal(code.done_when_met, true);
  assert.deepEqual(actionNames(b), ["accept", "stop"]);
  assert.equal(b.summary, "Waiting on you at Code");

  // The harness ran in the build folder, read AGENTS.md, and got the failed check's words on its second round.
  const h = calls(f);
  assert.equal(h.length, 2);
  assert.ok(h.every((c) => c.agents_md && c.cwd.endsWith(join("handoff", "work", "build"))));
  assert.match(h[0].prompt, /Read AGENTS\.md/);
  assert.equal(h[0].feedback, "");
  assert.match(h[1].prompt, /First read .*check\.txt/);
  assert.match(readFileSync(h[1].feedback, "utf8"), /not ok: counts the words in a passage/);

  // The scripts the harness wrote are handed back and can be read.
  const script = stageOf(b, "code").handed_back.files.find((x) => x.path === "code/scripts/count.mjs");
  assert.ok(script);
  const bytes = await f.call("GET", `/builds/${id}/files?path=${encodeURIComponent(script.path)}`, undefined, { raw: true });
  assert.equal(bytes.status, 200);
  assert.match(bytes.text, /split/);

  // Your OK: Package packs the build folder and validates it, and the build is done.
  const accepted = await f.post(`/builds/${id}/actions/accept`);
  ok(accepted.json.build);
  b = await f.settled(id);
  ok(b);
  assert.equal(stageOf(b, "code").state, "done");
  assert.equal(stageOf(b, "code").rounds[0].verdict, "OK'd by you");
  const pkg = stageOf(b, "package");
  assert.equal(pkg.state, "done");
  assert.equal(pkg.holder.kind, "outside_tool");
  assert.match(pkg.handed_back.words[0], /Packed word-counter 0\.1\.0 as an Agent Package/);
  assert.deepEqual(pkg.handed_back.files.map((x) => x.path), ["package/word-counter-0.1.0.tar.gz", "package/word-counter-build.json", "package/validation.json"]);
  // The process document's "approve the deploy" gate waits on the person, with the run plan to read.
  assert.equal(stageOf(b, "deploy").state, "waiting_on_you");
  assert.equal(b.summary, "Packed and validated · word-counter 0.1.0 · Approve the deploy");
  assert.deepEqual(actionNames(b), ["approve", "stop"]);
  // Approved: with no runtime set, Deploy waits on the person to hand the package over (runtime.test.mjs has the rest).
  ok((await f.post(`/builds/${id}/actions/approve`)).json.build);
  b = await f.settled(id);
  ok(b);
  assert.equal(b.summary, "Packed and validated · word-counter 0.1.0 · Hand this package to your runtime");
  assert.deepEqual(actionNames(b), ["resume", "archive"]);
  assert.ok(existsSync(join(f.store.folder(id), "stages", "package", "r1", "source", "skills", "count", "scripts", "count.mjs")), "the skill carries its script, as plugin.json's build entry names it");

  // The process runner ran the build: every phase milestone 1 runs closed, the deploy was approved, and with no runtime
  // set the run waits at deploy-the-agent, held by the runtime you bring, for the package to be handed over.
  const run = f.store.read(id).run;
  assert.equal(run.process.name, "make a new agent");
  assert.equal(run.status, "open");
  for (const p of ["write-the-spec", "approve-the-spec", "write-the-architecture", "design-the-agent", "gather-the-features", "make-the-package", "approve-the-deploy"]) assert.equal(run.phases[p].status, "closed", p);
  assert.deepEqual(["deploy-the-agent", "check-conformance", "publish-the-agent"].map((p) => run.phases[p].status), ["working", "waiting", "waiting"]);
  assert.deepEqual(run.approvals.map((a) => [a.phase, a.by]), [["write-the-spec", "person@example.com"], ["approve-the-spec", "person@example.com"], ["approve-the-deploy", "person@example.com"]]);
  assert.deepEqual(run.deviations.map((d) => d.key), ["changes"]);
  assert.ok(existsSync(join(f.store.folder(id), "run", run.run_id, "events.jsonl")), "the run is kept on disk the process runner's way too");
  // A spec with no features is made in one run of make-a-feature: its suite, its scripts and your OK.
  const [one] = f.store.read(id).feature_runs;
  assert.equal(one.feature, "all");
  assert.equal(one.run.process.name, "make a feature");
  assert.equal(one.run.outcome, "completed");
  for (const p of ["write-the-suite", "write-the-scripts", "ok-the-feature"]) assert.equal(one.run.phases[p].status, "closed", p);
  assert.deepEqual(one.run.approvals.map((a) => a.phase), ["write-the-scripts", "ok-the-feature"]);
  assert.deepEqual(one.run.trigger.carried.map((c) => [c.key, c.given]), [["spec", true], ["feature", true], ["suite", false]]);
  assert.ok(existsSync(join(f.store.folder(id), "runs", "all", "run", one.run.run_id, "events.jsonl")), "the feature's run is kept in its own folder");

  const list = (await f.get("/builds")).json;
  assert.deepEqual(checkBuildList(list), []);
  assert.equal(list.builds[0].at.summary, "Packed and validated · word-counter 0.1.0 · Hand this package to your runtime");
  assert.equal(list.builds[0].at.stage, "deploy");
  assert.equal(list.builds[0].at.state, "waiting_on_you");
});

test("a walked build's timeline has one bar per phase per round, each with its stage", async (t) => {
  const f = await factory({ holder: "harness", failRounds: 1, runtime: { command: ["node", FOLDER, "--into", "./installed"] } });
  t.after(f.close);
  const id = (await f.post("/builds", { does: "Count the words in a passage." })).json.build.id;
  let b = await f.settled(id);
  // While the spec waits on the person, its gate is an open bar at Requirements.
  const open = b.timeline.filter((x) => x.end === null);
  assert.ok(open.some((x) => x.stage === "requirements" && x.kind === "person"), JSON.stringify(open));
  await f.post(`/builds/${id}/actions/approve`);
  await f.settled(id);
  await f.post(`/builds/${id}/actions/accept`);
  await f.settled(id);
  await f.post(`/builds/${id}/actions/approve`);
  b = await f.settled(id);
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
  assert.deepEqual([...new Set(at("write-the-suite").map((x) => x.stage))], ["test"]);
  assert.deepEqual([...new Set(at("write-the-scripts").map((x) => x.stage))], ["code"]);
  assert.deepEqual([...new Set(at("make-the-package").map((x) => x.stage))], ["package"]);
  assert.deepEqual([...new Set(at("approve-the-deploy").map((x) => x.stage))], ["deploy"]);
  assert.deepEqual([...new Set(at("write-the-architecture").map((x) => x.stage))], ["architecture"]);
  assert.deepEqual([...new Set(at("design-the-agent").map((x) => x.stage))], ["architecture"]);
  assert.deepEqual([...new Set(at("deploy-the-agent").map((x) => x.stage))], ["deploy"]);
  assert.deepEqual([...new Set(at("check-conformance").map((x) => x.stage))], ["conformance"]);
  // Done: every bar closed, ordered by start, each with its duration.
  for (const x of bars) assert.equal(x.duration_ms, Date.parse(x.end) - Date.parse(x.start), x.phase);
  const starts = bars.map((x) => Date.parse(x.start));
  assert.deepEqual(starts, [...starts].sort((p, q) => p - q));
});

test("a build keeps the lifecycle it started under; a later change does not touch it", async (t) => {
  const f = await factory({ holder: "harness", doc: leftOut });
  t.after(f.close);
  const id = (await f.post("/builds", { does: "Count the words." })).json.build.id;
  await f.settled(id);
  assert.equal((await f.put("/stages/review", { used: true })).status, 200);
  assert.equal((await f.put("/stages/package", { used: false })).status, 200);
  const b = (await f.get(`/builds/${id}`)).json.build;
  assert.equal(stageOf(b, "review").state, "not_used");
  assert.equal(stageOf(b, "package").state, "not_started");
  assert.deepEqual(b.lifecycle.project, null);
  // A build started now follows the new choice: Package is left out, so it ends at Code.
  const id2 = (await f.post("/builds", { does: "Count the words.", name: "counter" })).json.build.id;
  await f.settled(id2);
  await f.post(`/builds/${id2}/actions/approve`);
  await f.settled(id2);
  await f.post(`/builds/${id2}/actions/accept`);
  const done = await f.settled(id2);
  ok(done);
  assert.equal(stageOf(done, "package").state, "not_used");
  assert.equal(stageOf(done, "review").state, "not_offered");
  assert.equal(done.summary, "Code OK'd · counter 0.1.0 · Package is not part of this lifecycle");
  assert.equal(stageOf(done, "code").state, "done");
});

test("a project's lifecycle is the one a build under that project follows", async (t) => {
  const f = await factory({ holder: "harness", doc: { version: "0.1", organization: {}, projects: { web: { used: { package: false } } } } });
  t.after(f.close);
  const b = (await f.post("/builds", { does: "Count the words.", project: "web" })).json.build;
  ok(b);
  assert.deepEqual(b.lifecycle.project, "web");
  assert.equal(b.project, "web");
  assert.equal(stageOf(b, "package").state, "not_used");
  assert.match(stageOf(b, "package").given, /the project web leaves it out/);
  await f.settled(b.id);
});

test("when the rounds run out the build stops and waits; more rounds finish it", async (t) => {
  const f = await factory({ holder: "harness", failRounds: 3, rounds: 2 });
  t.after(f.close);
  const id = (await f.post("/builds", { does: "Count the words.", name: "counter" })).json.build.id;
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

test("asking for changes needs words, and a refused spec runs again with them", async (t) => {
  const f = await factory({ holder: "harness", model: false });
  t.after(f.close);
  const id = (await f.post("/builds", { does: "Count the words." })).json.build.id;
  const b = await f.settled(id);
  assert.equal(stageOf(b, "requirements").state, "refused");
  assert.equal((await f.post(`/builds/${id}/actions/changes`, {})).status, 400);
  // The spec writer refused what the run started with, so the runner ended the run as failed; the person can start it again.
  assert.equal(f.store.read(id).run.outcome, "failed");
  // With the model set, asking for changes runs the spec again with the words, and the build goes on to the end.
  Object.assign(f.env, MODEL_VARS);
  await f.post(`/builds/${id}/actions/changes`, { changes: "Count hyphenated words as one." });
  const again = await f.settled(id);
  assert.equal(stageOf(again, "requirements").state, "waiting_on_you");
  assert.equal(stageOf(again, "requirements").runs, 2);
  assert.equal(f.store.read(id).run.resumes.length, 1);
  assert.match(readFileSync(join(f.store.folder(id), "stages", "requirements", "records", "r2", "asked.json"), "utf8"), /Count hyphenated words as one/);
  await f.post(`/builds/${id}/actions/approve`);
  const atCode = await f.settled(id);
  ok(atCode);
  assert.equal(stageOf(atCode, "code").state, "waiting_on_you");
  await f.post(`/builds/${id}/actions/accept`);
  const done = await f.settled(id);
  assert.equal(stageOf(done, "package").state, "done");
  await f.post(`/builds/${id}/actions/approve`);
  await f.settled(id);
  assert.equal(f.store.read(id).run.phases["deploy-the-agent"].status, "working", "with no runtime set, the package waits to be handed over");
});

test("the reference code writer holds Code with its own workspace, check and delivery check", async (t) => {
  const f = await factory({ holder: "code-writer", failRounds: 1 });
  t.after(f.close);
  const id = (await f.post("/builds", { does: "Count the words.", name: "counter" })).json.build.id;
  await f.settled(id);
  await f.post(`/builds/${id}/actions/approve`);
  const b = await f.settled(id);
  ok(b);
  const code = stageOf(b, "code");
  assert.deepEqual(code.holder, { kind: "reference_agent", name: "code-writer", role: "code-writer" });
  assert.equal(code.state, "waiting_on_you");
  assert.equal(code.rounds.length, 2);
  assert.match(code.rounds[0].words, /delivery check accepted it/);
  const h = calls(f);
  assert.ok(h[0].cwd.endsWith(join("code-writer", "workspace")));
  assert.match(h[0].prompt, /reference code writer/);
});

test("a stage that cannot run says why in words, and stopping a build ends it", async (t) => {
  const noModel = await factory({ holder: "harness", model: false });
  t.after(noModel.close);
  const b1 = await noModel.settled((await noModel.post("/builds", { does: "Count the words." })).json.build.id);
  ok(b1);
  assert.equal(stageOf(b1, "requirements").state, "refused");
  assert.match(stageOf(b1, "requirements").handed_back.words[0], /PF_T_MODEL_NAME, PF_T_MODEL_ENDPOINT, PF_T_MODEL_PROTOCOL are not set/);
  assert.deepEqual(actionNames(b1), ["resume", "changes", "stop"]);

  const f = await factory({ holder: "harness", harness: false });
  t.after(f.close);
  const refusedAtSpec = await f.settled((await f.post("/builds", { does: "Please refuse at requirements." })).json.build.id);
  assert.equal(stageOf(refusedAtSpec, "requirements").state, "refused");
  assert.match(stageOf(refusedAtSpec, "requirements").handed_back.words[0], /Nothing arrived/);
  const stopped = await f.post(`/builds/${refusedAtSpec.id}/actions/stop`);
  ok(stopped.json.build);
  assert.equal(stageOf(stopped.json.build, "requirements").state, "stopped");
  assert.equal(stopped.json.build.summary, "Stopped at Requirements");
  assert.deepEqual(actionNames(stopped.json.build), ["archive"]);
  const notNow = await f.post(`/builds/${refusedAtSpec.id}/actions/approve`);
  assert.equal(notNow.status, 409);
  assert.equal(typeof notNow.json.error, "string");
  ok(notNow.json.build);

  const id = (await f.post("/builds", { does: "Count the words.", name: "counter" })).json.build.id;
  await f.settled(id);
  await f.post(`/builds/${id}/actions/approve`);
  const noHarness = await f.settled(id);
  assert.equal(stageOf(noHarness, "code").state, "refused");
  assert.match(stageOf(noHarness, "code").handed_back.words[0], /No coding harness is set/);

  // Archived builds leave the list, and come back with ?archived=1.
  await f.post(`/builds/${refusedAtSpec.id}/actions/archive`);
  assert.ok(!(await f.get("/builds")).json.builds.some((x) => x.id === refusedAtSpec.id));
  assert.ok((await f.get("/builds?archived=1")).json.builds.some((x) => x.id === refusedAtSpec.id && x.archived));
});

test("a build that was running when Product Factory stopped runs its stage again", async (t) => {
  const f = await factory({ holder: "harness" });
  t.after(f.close);
  const id = (await f.post("/builds", { does: "Count the words.", name: "counter" })).json.build.id;
  await f.settled(id);
  // Stop Product Factory while the solution architect is working: the build stays working in its record.
  await f.post(`/builds/${id}/actions/approve`);
  await f.runner.stopAll();
  assert.equal(f.store.read(id).status, "working");
  await f.runner.resumeAll();
  const b = await f.settled(id);
  assert.equal(stageOf(b, "architecture").state, "done");
  assert.equal(stageOf(b, "test").state, "done");
  assert.ok(b.log.some((e) => /started again while Architecture and Design was running/.test(e.said)));
});
