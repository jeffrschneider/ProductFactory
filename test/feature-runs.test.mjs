// Each feature in a run of its own (processes/make-a-feature.txt, lib/feature-runs.mjs),
// with the stand-in holders and a fake GitHub (fixtures/fake-github.mjs): no test
// reaches a model or the network.
//
//   - two features run at the same time, each with its own pull request, and the
//     version waits for both before it is packed;
//   - a feature accepted first moves the version's base, and the other is brought
//     up to date with it (one merge commit) before its gate runs again and its OK
//     is offered;
//   - one feature's Send back to Test leaves the other as it was;
//   - a build started before feature runs (an old build.json) finishes the old way;
//   - upToDate takes each script from the side that changed it.

import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { factory, stageOf, actionNames, codeRun } from "./helpers.mjs";
import { fakeGitHub } from "./fixtures/fake-github.mjs";
import { checkBuild } from "adlc-console/lib/contract.mjs";
import { validate, checkBuild as checkBuildApi, checkBuildList } from "../standards/lifecycle-api-check.mjs";
import { STAGE_IDS } from "../lib/standards.mjs";
import { openRun, event, parse } from "../lib/orchestrator.mjs";
import { upToDate, UP_TO_DATE_FILE } from "../lib/feature-runs.mjs";

const V1 = readFileSync(fileURLToPath(new URL("./fixtures/make-a-new-agent-v1.txt", import.meta.url)), "utf8");
const SCRIPT = "agents/counter/scripts/count.mjs";
const RIGHT = "export function count(text) { return String(text).split(/\\s+/).filter(Boolean).length; }\n";
const RIGHT_TOO = "export function count(text) { return String(text).trim().split(/\\s+/).filter(Boolean).length; }\n";
const branchOf = (feature) => `adlc/counter-0.1.0-${feature.toLowerCase()}`;
const ok = (b) => {
  assert.deepEqual(checkBuild({ build: b }, STAGE_IDS), []);
  assert.deepEqual(validate("BuildAnswer", { build: b }), []);
  // Lifecycle API 0.4.10: each feature run named once, its actions naming it, and the build's actions and bars naming runs it has.
  assert.deepEqual(checkBuildApi({ build: b }, STAGE_IDS, b.id), []);
};
const runOf = (b, id) => b.feature_runs.find((x) => x.id === id);

/** A build named counter with two features approved in the chat, its spec approved, on pull requests. */
async function twoFeatures(t) {
  const gh = await fakeGitHub();
  const f = await factory({ holder: "pull-request", github: gh, doc: { version: "0.1", organization: { used: { review: false, security: false } } } });
  t.after(async () => { await f.close(); await gh.close(); });
  const id = (await f.post("/builds", { does: "Count the words in a passage.", name: "counter" })).json.build.id;
  await f.settled(id);
  const say = async (text) => (await f.post("/products/counter/stages/requirements/messages", { text })).json.reply.features[0];
  for (const [n, words] of [["F1", "Count words - Counts the words in a passage."], ["F2", "Count lines - Counts the lines of a passage."]]) {
    const p = await say(`Add a feature: ${words}`);
    assert.equal((await f.post(`/builds/${id}/features/${n}/approve`, { proposal: p.proposal })).status, 200);
  }
  assert.deepEqual(f.store.read(id).feature_runs, [], "no feature run starts before the spec is approved");
  await f.post(`/builds/${id}/actions/approve`);
  const b = await f.settled(id);
  return { gh, f, id, b };
}

test("two features run at once, each with its own pull request; the version waits for both, and the second is brought up to date with the first before its OK", async (t) => {
  const { gh, f, id, b: opened } = await twoFeatures(t);
  ok(opened);

  // Each approved feature is a run of its own, both at Code now, each on its own branch and pull request.
  assert.deepEqual(opened.feature_runs.map((x) => [x.id, x.feature, x.name, x.at.stage, x.at.state]), [["F1", "F1", "F1 Count words", "code", "working"], ["F2", "F2", "F2 Count lines", "code", "working"]]);
  // The two runs open their pull requests at the same time, so either may be numbered first.
  assert.equal(gh.pulls.size, 2);
  const prOf = (feature) => codeRun(f, id, feature).work.pr.number;
  assert.deepEqual([...gh.pulls.values()].map((p) => [p.head, p.title]).sort(), [[branchOf("F1"), "Write the scripts: counter 0.1.0, F1 Count words"], [branchOf("F2"), "Write the scripts: counter 0.1.0, F2 Count lines"]]);
  assert.equal(gh.pulls.get(prOf("F1")).head, branchOf("F1"));
  assert.match(gh.pulls.get(prOf("F1")).body, /makes one feature of the version, \*\*F1 Count words\*\*/);
  // Each feature's tests were written for it alone, in a file named for it.
  assert.ok("agents/counter/test/f1.test.mjs" in gh.filesAt(branchOf("F1")) && !("agents/counter/test/f2.test.mjs" in gh.filesAt(branchOf("F1"))));
  assert.ok("agents/counter/test/f2.test.mjs" in gh.filesAt(branchOf("F2")) && !("agents/counter/test/f1.test.mjs" in gh.filesAt(branchOf("F2"))));
  // They ran at the same time: each test writer started before the other's finished.
  const bar = (run) => runOf(opened, run).timeline.find((x) => x.phase === "write-the-suite");
  assert.ok(bar("F2").start < bar("F1").end && bar("F1").start < bar("F2").end, "the two features' suites were written at the same time");
  // The version waits at Code, at gather-the-features, and its spec was approved once.
  const v = f.store.read(id);
  assert.equal(v.run.phases["gather-the-features"].status, "working");
  assert.equal(v.at, "code");
  assert.equal(opened.summary, "Making 2 features, each in a run of its own");
  assert.deepEqual(opened.feature_runs.map((x) => x.pull_request?.url), [`https://github.example/acme/agents/pull/${prOf("F1")}`, `https://github.example/acme/agents/pull/${prOf("F2")}`]);
  // The board shows a card for each run.
  const listed = (await f.get("/builds")).json;
  assert.deepEqual(checkBuildList(listed, STAGE_IDS), []);
  const card = listed.builds.find((x) => x.id === id);
  assert.deepEqual(card.feature_runs.map((x) => [x.id, x.at.stage, x.at.state]), [["F1", "code", "working"], ["F2", "code", "working"]]);

  // Both pass the gate: each waits for your OK, and each action names its run.
  gh.push(branchOf("F1"), { [SCRIPT]: RIGHT });
  gh.push(branchOf("F2"), { [SCRIPT]: RIGHT_TOO });
  await f.runner.poll(id);
  let b = await f.settled(id);
  ok(b);
  assert.deepEqual(b.feature_runs.map((x) => x.at.state), ["waiting_on_you", "waiting_on_you"]);
  assert.deepEqual(b.actions.filter((a) => a.name === "accept").map((a) => [a.run, a.label]), [["F1", "OK the code: F1"], ["F2", "OK the code: F2"]]);
  assert.equal(b.summary, "Making 2 features, each in a run of its own: 2 wait on you");
  assert.equal(stageOf(b, "code").state, "waiting_on_you");

  // Your OK on F1 merges its pull request. The version does not go on: F2 is still open.
  assert.equal((await f.post(`/builds/${id}/actions/accept`, { run: "F1" })).status, 200);
  b = await f.settled(id);
  ok(b);
  assert.equal(gh.pulls.get(prOf("F1")).merged, true);
  assert.equal(gh.pulls.get(prOf("F2")).merged, false);
  assert.equal(runOf(b, "F1").ended, true);
  assert.equal(runOf(b, "F1").at.summary, `You OK'd the code on pull request #${prOf("F1")}`, "an accepted run says so, and nothing about Package");
  assert.equal(stageOf(b, "package").state, "not_started", "the version waits for every feature's run");
  assert.equal(f.store.read(id).base.feature, "F1");

  // F2 was brought up to date with the base F1 moved: one merge commit, with F1's test beside its own, and both changed the script.
  const head = gh.head(branchOf("F2"));
  assert.equal(gh.parents(head).length, 2, "a merge commit, so the pull request merges cleanly later");
  assert.equal(gh.parents(head)[1], gh.head("main"));
  const files = gh.filesAt(branchOf("F2"));
  assert.ok("agents/counter/test/f1.test.mjs" in files && "agents/counter/test/f2.test.mjs" in files);
  assert.equal(files[SCRIPT], RIGHT, "a script both changed is the base's");
  assert.equal(files["agents/counter/records/yours/scripts/count.mjs"], RIGHT_TOO, "and this feature's own is kept beside it");
  assert.match(files[`agents/counter/${UP_TO_DATE_FILE}`], /Carry this feature's change into the base's version/);
  assert.deepEqual(JSON.parse(files["agents/counter/build.lock.json"]).digests, codeRun(f, id, "F2").work.pr.digests, "the lock and the fence agree");
  assert.match(gh.comments.find((c) => c.number === prOf("F2") && /Brought up to date/.test(c.body)).body, /`test\/f1\.test\.mjs`/);
  // Its gate ran again on the merge commit, with every test of F1 too, and its OK is offered again.
  const pr2 = codeRun(f, id, "F2").work.pr;
  assert.equal(pr2.runs.at(-1).sha, head);
  assert.equal(pr2.runs.at(-1).passed, true);
  assert.equal(runOf(b, "F2").at.state, "waiting_on_you");
  assert.deepEqual(b.actions.filter((a) => a.name === "accept").map((a) => a.run), ["F2"]);

  // Your OK on F2: every feature's run has closed, and the version goes on to Package with the scripts as merged.
  await f.post(`/builds/${id}/actions/accept`, { run: "F2" });
  b = await f.settled(id);
  ok(b);
  assert.equal(gh.pulls.get(prOf("F2")).merged, true);
  assert.equal(stageOf(b, "package").state, "done");
  assert.equal(b.summary, "Packed and validated · counter 0.1.0 · Approve the deploy");
  const run = f.store.read(id).run;
  assert.equal(run.phases["gather-the-features"].status, "closed");
  assert.match(run.phases["gather-the-features"].record.what, /^Every feature's run closed: F1 Count words; F2 Count lines\.$/);
  assert.equal(readFileSync(join(f.store.folder(id), "stages", "package", "r1", "handed", "scripts", "count.mjs"), "utf8"), RIGHT);
  assert.deepEqual(f.store.read(id).feature_runs.map((x) => [x.id, x.run.outcome]), [["F1", "completed"], ["F2", "completed"]]);
  assert.equal(f.store.read(id).base.n, 2);
});

test("one feature's Send back to Test revises its own suite on its own pull request, and leaves the other feature as it was", async (t) => {
  const { gh, f, id } = await twoFeatures(t);
  gh.push(branchOf("F1"), { [SCRIPT]: RIGHT });
  gh.push(branchOf("F2"), { [SCRIPT]: RIGHT });
  await f.runner.poll(id);
  let b = await f.settled(id);
  const before = JSON.stringify(f.store.read(id).feature_runs.find((x) => x.id === "F2"));

  const sent = await f.post(`/builds/${id}/actions/back_to_test`, { run: "F1", changes: "Say that an empty passage has no words." });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  b = await f.settled(id);
  ok(b);
  // F1's run went back to its own suite: the test writer revised its file, and it went to F1's pull request.
  const one = codeRun(f, id, "F1");
  assert.deepEqual(one.run.deviations.map((d) => [d.key, d.from, d.to]), [["conflict", "write-the-scripts", "write-the-suite"]]);
  assert.match(readFileSync(join(f.store.folder(id), "runs", "F1", "stages", "test", "jobs", "r2", "message.txt"), "utf8"), /^Revise the suite\.\n\nSay that an empty passage has no words\./);
  assert.match(gh.filesAt(branchOf("F1"))["agents/counter/test/f1.test.mjs"], /an empty passage has no words/);
  assert.ok(!/an empty passage/.test(gh.filesAt(branchOf("F2"))["agents/counter/test/f2.test.mjs"]));
  // F2 is exactly as it was: still waiting for your OK on the same commit, its run untouched.
  assert.equal(JSON.stringify(f.store.read(id).feature_runs.find((x) => x.id === "F2")), before);
  assert.equal(runOf(b, "F2").at.state, "waiting_on_you");
  assert.deepEqual(b.actions.filter((a) => a.run === "F2").map((a) => a.name), ["accept", "back_to_test", "back_to_requirements", "stop"]);
  // The version's spec was not touched.
  assert.equal(f.store.read(id).run.approvals.filter((a) => a.phase === "approve-the-spec").length, 1);
});

test("a build started before feature runs, on make-a-new-agent v1, finishes the old way: Test and Code in its own run", async (t) => {
  // The old build: made by one Product Factory and left at the spec's gate, then turned into what an older
  // Product Factory kept (its own copy of make-a-new-agent v1, one run, no feature runs) for another to pick up.
  const a = await factory({ holder: "harness" });
  t.after(a.close);
  const id = (await a.post("/builds", { does: "Count the words in a passage.", name: "counter" })).json.build.id;
  await a.settled(id);
  const r = a.store.read(id);
  const v1 = openRun({ person: r.run.owner, day: r.created.slice(0, 10), settings: r.settings, material: r.run.trigger.material, startedAt: r.run.started_at, template: V1 });
  let state = v1.state;
  for (const e of r.run.events.slice(1)) state = event(state, e, v1.doc);
  delete r.feature_runs;
  r.run = state;

  const f = await factory({ holder: "harness" });
  t.after(f.close);
  const dir = f.store.folder(id);
  cpSync(a.store.folder(id), dir, { recursive: true });
  writeFileSync(join(dir, "run", "document.txt"), v1.text);
  writeFileSync(join(dir, "build.json"), `${JSON.stringify(r, null, 2)}\n`);
  assert.equal(parse(readFileSync(join(dir, "run", "document.txt"), "utf8")).header.version, "v1");

  await f.post(`/builds/${id}/actions/approve`);
  let b = await f.settled(id);
  ok(b);
  assert.equal(stageOf(b, "code").state, "waiting_on_you");
  assert.equal(b.feature_runs, undefined, "no feature run: the build keeps the one chain it started with");
  assert.deepEqual(actionNames(b), ["accept", "stop"]);
  await f.post(`/builds/${id}/actions/accept`);
  b = await f.settled(id);
  ok(b);
  assert.equal(stageOf(b, "package").state, "done");
  const run = f.store.read(id).run;
  for (const p of ["write-the-suite", "write-the-scripts", "make-the-package"]) assert.equal(run.phases[p].status, "closed", p);
  assert.equal(run.process.version, "v1");
  assert.equal(f.store.read(id).feature_runs, undefined);
});

test("bringing a feature up to date takes each script from the side that changed it, every test of both, and keeps a conflict's own side beside it", () => {
  const B = (s) => Buffer.from(s);
  const ancestor = new Map([["scripts/a.mjs", B("a0")], ["scripts/b.mjs", B("b0")], ["scripts/c.mjs", B("c0")], ["scripts/gone.mjs", B("g0")], ["test/f2.test.mjs", B("t2")], ["spec.json", B("s")]]);
  const ours = new Map([["scripts/a.mjs", B("a0")], ["scripts/b.mjs", B("b2")], ["scripts/c.mjs", B("c2")], ["scripts/gone.mjs", B("g0")], ["test/f2.test.mjs", B("t2")], ["spec.json", B("s")], ["build.lock.json", B("{}")], ["records/conflict.md", B("old")]]);
  const base = new Map([["scripts/a.mjs", B("a1")], ["scripts/b.mjs", B("b0")], ["scripts/c.mjs", B("c1")], ["test/f1.test.mjs", B("t1")], ["spec.json", B("s")]]);
  const got = upToDate({ ancestor, ours, base });
  const text = (p) => got.files.get(p)?.toString();
  assert.equal(text("scripts/a.mjs"), "a1", "only the base changed it");
  assert.equal(text("scripts/b.mjs"), "b2", "only this feature changed it");
  assert.equal(text("scripts/c.mjs"), "c1", "both changed it: the base's");
  assert.equal(text("records/yours/scripts/c.mjs"), "c2", "and this feature's own beside it");
  assert.equal(text("scripts/gone.mjs"), undefined, "the base took it out, and this feature left it as it was");
  assert.deepEqual([text("test/f1.test.mjs"), text("test/f2.test.mjs")], ["t1", "t2"]);
  assert.equal(got.files.has("build.lock.json"), false, "the caller pins the new suite");
  assert.equal(got.files.has("records/conflict.md"), false);
  assert.deepEqual(got.conflicts, ["scripts/c.mjs"]);
  assert.deepEqual(got.added, ["test/f1.test.mjs"]);
  assert.match(text(UP_TO_DATE_FILE), /- scripts\/c\.mjs \(yours: records\/yours\/scripts\/c\.mjs\)/);
});

test("on this computer too: two features each in a run of their own, and the one still open is laid out again with the first's tests once it is accepted", async (t) => {
  const f = await factory({ holder: "harness" });
  t.after(f.close);
  const id = (await f.post("/builds", { does: "Count the words in a passage.", name: "counter" })).json.build.id;
  await f.settled(id);
  const say = async (text) => (await f.post("/products/counter/stages/requirements/messages", { text })).json.reply.features[0];
  for (const [n, words] of [["F1", "Count words - Counts the words in a passage."], ["F2", "Count lines - Counts the lines of a passage."]]) {
    const p = await say(`Add a feature: ${words}`);
    await f.post(`/builds/${id}/features/${n}/approve`, { proposal: p.proposal });
  }
  await f.post(`/builds/${id}/actions/approve`);
  let b = await f.settled(id);
  assert.deepEqual(b.feature_runs.map((x) => x.at.state), ["waiting_on_you", "waiting_on_you"]);
  await f.post(`/builds/${id}/actions/accept`, { run: "F1" });
  b = await f.settled(id);
  ok(b);
  // F2's build folder holds F1's test beside its own now, and its suite passed again before its OK came back.
  const two = codeRun(f, id, "F2");
  const folder = join(f.store.folder(id), "runs", "F2", two.work.folder);
  assert.ok(readFileSync(join(folder, "test", "f1.test.mjs"), "utf8").includes("[F1] count words"));
  assert.equal(two.work.base_n, 1);
  assert.equal(two.work.behind, undefined);
  assert.ok(two.stages.code.log.some((e) => /^Another feature was accepted, so the build folder is laid out again/.test(e.said)));
  assert.equal(runOf(b, "F2").at.state, "waiting_on_you");
  assert.equal(stageOf(b, "package").state, "not_started");
  await f.post(`/builds/${id}/actions/accept`, { run: "F2" });
  b = await f.settled(id);
  assert.equal(stageOf(b, "package").state, "done");
});
