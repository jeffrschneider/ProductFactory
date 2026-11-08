// Code on a pull request, against a fake GitHub (fixtures/fake-github.mjs, a
// local HTTP stub with a small git in memory): opening the pull request, a
// failing push, a passing push, the fence refusing a change outside what the
// coding step may change, your OK taking the passing commit, and Send back to
// Test. No test reaches the network.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { factory, stageOf, actionNames } from "./helpers.mjs";
import { fakeGitHub } from "./fixtures/fake-github.mjs";
import { checkBuild } from "adlc-console/lib/contract.mjs";
import { validate } from "../standards/lifecycle-api-check.mjs";
import { STAGE_IDS } from "../lib/standards.mjs";
import { readConfig } from "../lib/config.mjs";

const BRANCH = "adlc/counter-0.1.0";
const SCRIPT = "agents/counter/scripts/count.mjs";
const WRONG = "export function count() { return 0; }\n";
const RIGHT = "export function count(text) { return String(text).split(/\\s+/).filter(Boolean).length; }\n";
const ok = (b) => {
  assert.deepEqual(checkBuild({ build: b }, STAGE_IDS), []);
  assert.deepEqual(validate("BuildAnswer", { build: b }), []);
};

/** A build started and walked to Code, where the pull request is opened. */
async function atCode(t, opts = {}) {
  const gh = await fakeGitHub(opts.github);
  const f = await factory({ holder: "pull-request", github: gh, ...opts.factory });
  t.after(async () => { await f.close(); await gh.close(); });
  const id = (await f.post("/builds", { does: "Count the words in a passage.", name: "counter" })).json.build.id;
  await f.settled(id);
  await f.post(`/builds/${id}/actions/approve`);
  const b = await f.settled(id);
  return { gh, f, id, b };
}

/** Polls the pull request, then waits for the build to settle. */
async function polled(f, id) {
  const r = await f.runner.poll(id);
  return { r, b: await f.settled(id) };
}

test("Code opens a Write the scripts pull request; a failing push, then a passing one; your OK takes that commit", async (t) => {
  const { gh, f, id, b: opened } = await atCode(t);
  ok(opened);

  // The pull request holds the build folder in a folder of its own, beside the repository's own files.
  const code = stageOf(opened, "code");
  assert.equal(code.state, "working");
  assert.deepEqual(code.holder, { kind: "your_agent", name: "your coding harness, on a pull request (acme/agents)", role: "code-writer" });
  assert.match(code.given, /on a "Write the scripts" pull request/);
  assert.equal(code.where.kind, "pull_request");
  assert.equal(code.where.url, "https://github.example/acme/agents/pull/1");
  assert.equal(code.where.check, null);
  assert.equal(code.where.head, gh.head(BRANCH).slice(0, 7));
  assert.deepEqual(actionNames(opened), ["back_to_test", "stop"]);
  assert.equal(opened.summary, "Working at Code: waiting for a push to pull request #1");
  const pr = gh.pulls.get(1);
  assert.equal(pr.title, "Write the scripts: counter 0.1.0");
  assert.equal(pr.head, BRANCH);
  assert.equal(pr.base, "main");
  assert.match(pr.body, /agents\/counter\/AGENTS\.md/);
  assert.match(pr.body, /Nothing here merges by itself/);
  const issued = gh.filesAt(BRANCH);
  for (const p of ["README.md", "agents/counter/AGENTS.md", "agents/counter/build.lock.json", "agents/counter/.adlc/check.mjs", "agents/counter/test/count.test.mjs", SCRIPT, "agents/counter/agent-descriptor.json"]) assert.ok(p in issued, p);
  assert.equal(calls(f).length, 0, "no harness runs here: the person's own harness works on the pull request");

  // Nothing pushed yet: the gate does not run on Product Factory's own commit.
  assert.deepEqual(await f.runner.poll(id), { judged: false });
  assert.equal(gh.comments.length, 0);

  // A failing push: the suite fails, and the gate says so on the pull request and as a commit status.
  const bad = gh.push(BRANCH, { [SCRIPT]: WRONG }, "First try");
  let { r, b } = await polled(f, id);
  assert.equal(r.judged, true);
  assert.equal(r.passed, false);
  ok(b);
  let c = stageOf(b, "code");
  assert.equal(c.state, "working");
  assert.equal(c.rounds.length, 1);
  assert.equal(c.rounds[0].label, `Push ${bad.slice(0, 7)}`);
  assert.equal(c.rounds[0].verdict, "The tests did not pass");
  assert.equal(c.rounds[0].back, true);
  assert.equal(c.where.head, bad.slice(0, 7));
  assert.equal(c.where.check.title, "The tests did not pass");
  assert.equal(c.where.check.passed, false);
  assert.deepEqual(c.where.check.items, ["counts the words in a passage"]);
  assert.deepEqual(actionNames(b), ["back_to_test", "stop"]);
  assert.equal(gh.comments.length, 1);
  assert.match(gh.comments[0].body, new RegExp(`^\\*\\*Product Factory gate: The tests did not pass\\*\\* \\(${bad.slice(0, 7)}\\)`));
  assert.deepEqual(gh.statuses.filter((s) => s.sha === bad).map((s) => s.state), ["pending", "failure"]);
  assert.ok(gh.statuses.every((s) => s.context === "Product Factory gate"));

  // A passing push: the suite passes, every blanked script is noticed, both reviewers pass it, and the build waits for your OK.
  const good = gh.push(BRANCH, { [SCRIPT]: RIGHT }, "Second try");
  ({ r, b } = await polled(f, id));
  assert.equal(r.passed, true);
  ok(b);
  c = stageOf(b, "code");
  assert.equal(c.state, "waiting_on_you");
  assert.equal(c.done_when_met, true);
  assert.equal(c.where.check.title, "Ready for your OK");
  assert.equal(c.where.check.passed, true);
  assert.match(c.where.check.words, /All 1 tests passed\. Blanking each of the 1 script made the suite fail, as it should\./);
  assert.match(c.where.check.words, /The code critic reviewed the scripts and left nothing open\./);
  assert.match(c.where.check.words, /The security reviewer passed it\./);
  assert.deepEqual(actionNames(b), ["accept", "back_to_test", "stop"]);
  assert.equal(b.summary, "Waiting on you at Code");
  assert.deepEqual(gh.statuses.filter((s) => s.sha === good).map((s) => s.state), ["pending", "success"]);
  const handed = c.handed_back.files.find((x) => x.path === "code/scripts/count.mjs");
  const bytes = await f.call("GET", `/builds/${id}/files?path=${encodeURIComponent(handed.path)}`, undefined, { raw: true });
  assert.match(bytes.text, /split/);
  // The security reviewer was told the owner's spending limit.
  const asked = readFileSync(join(f.store.folder(id), "stages", "code", "pr", good.slice(0, 12), "review", "security", "job", "message.txt"), "utf8");
  assert.match(asked, /^spending limit: 10 USD per day$/m);

  // Your OK: the scripts from that exact commit, the pull request merged there, and Package packs them.
  const accepted = await f.post(`/builds/${id}/actions/accept`);
  assert.equal(accepted.status, 200);
  b = await f.settled(id);
  ok(b);
  assert.equal(stageOf(b, "code").state, "done");
  assert.match(stageOf(b, "code").log.map((e) => e.said).join("\n"), new RegExp(`taken from ${good.slice(0, 7)}, the commit the gate passed, and pull request #1 was merged there`));
  assert.equal(stageOf(b, "package").state, "done");
  assert.equal(gh.pulls.get(1).merged, true);
  assert.equal(gh.filesAt("main")[SCRIPT], RIGHT);
  const packed = readFileSync(join(f.store.folder(id), "stages", "package", "r1", "source", "skills", "count", "scripts", "count.mjs"), "utf8");
  assert.equal(packed, RIGHT);
  const run = f.store.read(id).run;
  assert.ok(run.approvals.some((a) => a.phase === "write-the-scripts" && a.text === `OK'd in the console at ${good.slice(0, 7)}`));
  assert.equal(run.outcome, "ended");

  // The token is read from its variable each time and never kept.
  assert.ok(!readFileSync(join(f.store.folder(id), "build.json"), "utf8").includes(gh.token));
  assert.ok(gh.calls.every((x) => x.auth === `Bearer ${gh.token}`));
});

test("the fence refuses a change outside what the coding step may change, and nothing is run", async (t) => {
  const { gh, f, id } = await atCode(t, { github: { statuses: false } });
  const sha = gh.push(BRANCH, {
    [SCRIPT]: `${RIGHT}// reports to https://collector.badhost.io\n`,
    "agents/counter/test/count.test.mjs": "// the test, emptied\n",
    "agents/counter/notes.txt": "a note\n",
    "README.md": "# changed\n",
  });
  const { r, b } = await polled(f, id);
  assert.equal(r.passed, false);
  ok(b);
  const c = stageOf(b, "code");
  assert.equal(c.where.check.title, "Refused: 4 problems");
  assert.deepEqual(c.where.check.items, [
    "README.md is the repository's own file, outside the build folder agents/counter/, and was changed; the coding step changes only agents/counter/scripts/",
    "agents/counter/notes.txt was added outside scripts/ and test/",
    "agents/counter/test/count.test.mjs was changed; a change to a test or the spec goes back through the spec and test steps",
    `${SCRIPT} names collector.badhost.io, which the spec does not declare`,
  ]);
  assert.match(c.where.check.words, /Nothing was run\. Fix these and push again\./);
  assert.ok(!existsSync(join(f.store.folder(id), "stages", "code", "pr", sha.slice(0, 12), "build")), "nothing refused is ever run");
  assert.equal(f.store.read(id).status, "working");
  // A token that may not post commit statuses: the gate's word goes on the pull request as a comment only.
  assert.equal(gh.statuses.length, 0);
  assert.equal(gh.comments.length, 1);
  assert.match(gh.comments[0].body, /Refused: 4 problems/);
  assert.ok(c.log.some((e) => /may not post commit statuses/.test(e.said)));
});

test("a push after the gate passed: your OK waits for the gate on the newest commit", async (t) => {
  const { gh, f, id } = await atCode(t, { factory: { doc: { version: "0.1", organization: { used: { review: false, security: false } } } } });
  gh.push(BRANCH, { [SCRIPT]: RIGHT });
  let { b } = await polled(f, id);
  assert.equal(stageOf(b, "code").state, "waiting_on_you");
  // The lifecycle leaves out Review and Security review, so no reviewer is asked.
  assert.doesNotMatch(stageOf(b, "code").where.check.words, /critic|security reviewer/i);
  // Another push comes before the OK: the OK is refused, by name, until the gate runs on it.
  const later = gh.push(BRANCH, { [SCRIPT]: `${RIGHT}// TODO: more\n` });
  const refused = await f.post(`/builds/${id}/actions/accept`);
  assert.equal(refused.status, 409);
  assert.match(refused.json.error, new RegExp(`The gate has not run on it yet: the newest commit on pull request #1 is ${later.slice(0, 7)}`));
  ok(refused.json.build);
  assert.equal(gh.pulls.get(1).merged, false);
  // A newer commit that fails takes the OK away until one passes.
  const failing = gh.push(BRANCH, { [SCRIPT]: WRONG });
  ({ b } = await polled(f, id));
  assert.equal(f.store.read(id).status, "working");
  assert.equal(stageOf(b, "code").state, "working");
  assert.deepEqual(actionNames(b), ["back_to_test", "stop"]);
  assert.equal(stageOf(b, "code").where.head, failing.slice(0, 7));
  assert.ok(b.log.some((e) => /did not pass the gate, so your OK waits for one that does/.test(e.said)));
  gh.push(BRANCH, { [SCRIPT]: RIGHT });
  ({ b } = await polled(f, id));
  assert.equal(f.store.read(id).status, "waiting");
  assert.equal((await f.post(`/builds/${id}/actions/accept`)).status, 200);
  b = await f.settled(id);
  assert.equal(stageOf(b, "package").state, "done");
});

test("a reviewer that leaves a finding open fails the gate, quoting it", async (t) => {
  const { gh, f, id } = await atCode(t);
  gh.push(BRANCH, { [SCRIPT]: `${RIGHT}// TODO-CRITIC: tidy this\n` });
  const { b } = await polled(f, id);
  ok(b);
  const check = stageOf(b, "code").where.check;
  assert.equal(check.title, "The code critic refused");
  assert.equal(check.passed, false);
  assert.deepEqual(check.items, ["The code critic: `scripts/count.mjs` the script says TODO-CRITIC it is not finished."]);
  assert.match(check.words, /The security reviewer passed it\./);
  assert.equal(f.store.read(id).status, "working");
});

test("Send back to Test: the test writer revises the suite, and the revised tests go on the same pull request", async (t) => {
  const { gh, f, id } = await atCode(t, { factory: { doc: { version: "0.1", organization: { used: { review: false, security: false } } } } });
  // The coding agent stops on a conflict: nothing is run, and the owner decides.
  gh.push(BRANCH, { "agents/counter/records/conflict.md": "The suite never says what an empty passage counts as.\n" });
  let { b } = await polled(f, id);
  ok(b);
  assert.equal(stageOf(b, "code").where.check.title, "Stopped on a conflict: a test your coding agent cannot pass");
  assert.match(gh.comments.at(-1).body, /The suite never says what an empty passage counts as\./);

  // Send back to Test needs words.
  assert.equal((await f.post(`/builds/${id}/actions/back_to_test`, {})).status, 400);
  const sent = await f.post(`/builds/${id}/actions/back_to_test`, { changes: "Say that an empty passage has no words." });
  assert.equal(sent.status, 200);
  ok(sent.json.build);
  b = await f.settled(id);
  ok(b);

  // The test writer revised the suite from the person's words and the coding agent's.
  const testStage = stageOf(b, "test");
  assert.equal(testStage.state, "done");
  assert.equal(testStage.rounds[0].verdict, "Suite revised");
  const records = join(f.store.folder(id), "stages", "test", "jobs", "r2", "message.txt");
  const said = readFileSync(records, "utf8");
  assert.match(said, /^Revise the suite\.\n\nSay that an empty passage has no words\.\n\nThe coding agent said, in records\/conflict\.md:\nThe suite never says/);
  assert.equal(stageOf(b, "requirements").state, "done", "the spec stands as approved");

  // One forward commit on the same branch: the revised test, the lock with its digest, and no conflict.
  assert.equal(gh.pulls.size, 1);
  const files = gh.filesAt(BRANCH);
  assert.match(files["agents/counter/test/count.test.mjs"], /an empty passage has no words/);
  assert.ok(!("agents/counter/records/conflict.md" in files));
  const lock = JSON.parse(files["agents/counter/build.lock.json"]);
  const pr = f.store.read(id).work.pr;
  assert.equal(lock.digests["test/count.test.mjs"], pr.digests["test/count.test.mjs"], "the lock and the fence agree");
  const revised = gh.comments.at(-1).body;
  assert.match(revised, /^\*\*The tests were revised\*\*/);
  assert.match(revised, /The test writer revised `test\/count\.test\.mjs`/);
  assert.match(revised, /> Say that an empty passage has no words\./);
  assert.equal(stageOf(b, "code").state, "working");
  assert.deepEqual(actionNames(b), ["back_to_test", "stop"]);

  // The revised commit is the first the gate hears, and it passes the fence: the stub still fails the suite.
  let r;
  ({ r, b } = await polled(f, id));
  assert.equal(r.judged, true);
  assert.equal(stageOf(b, "code").where.check.title, "The tests did not pass");
  // The harness writes to the revised suite, and the build goes on to your OK and Package.
  gh.push(BRANCH, { [SCRIPT]: RIGHT });
  ({ b } = await polled(f, id));
  assert.equal(stageOf(b, "code").where.check.title, "Ready for your OK");
  assert.match(stageOf(b, "code").where.check.words, /All 2 tests passed/);
  await f.post(`/builds/${id}/actions/accept`);
  b = await f.settled(id);
  assert.equal(stageOf(b, "package").state, "done");

  // The run records the document's way back from Code, in the person's words, and the spec's gate answered again.
  const run = f.store.read(id).run;
  assert.deepEqual(run.deviations.map((d) => [d.key, d.from, d.to, d.text]), [["conflict", "write-the-scripts", "approve-the-spec", "Say that an empty passage has no words."]]);
  assert.equal(run.approvals.filter((a) => a.phase === "approve-the-spec").length, 2);
  assert.equal(run.outcome, "ended");
});

test("Code on a pull request stops and says so when the token is not set, and the settings refuse a token value", async (t) => {
  const gh = await fakeGitHub();
  const f = await factory({ holder: "pull-request", github: gh });
  t.after(async () => { await f.close(); await gh.close(); });
  delete f.env.PF_T_GITHUB_TOKEN;
  const id = (await f.post("/builds", { does: "Count the words.", name: "counter" })).json.build.id;
  await f.settled(id);
  await f.post(`/builds/${id}/actions/approve`);
  const b = await f.settled(id);
  assert.equal(stageOf(b, "code").state, "refused");
  assert.match(stageOf(b, "code").handed_back.words[0], /read from PF_T_GITHUB_TOKEN, which is not set/);
  assert.equal(gh.pulls.size, 0);

  assert.throws(() => readConfig({ code: { holder: "pull-request" } }, "/"), /"repository" names where the pull request goes/);
  assert.throws(() => readConfig({ repository: { host: "github", repo: "a/b", token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" } }, "/"), /never a token/);
  assert.throws(() => readConfig({ repository: { host: "gitlab", repo: "a/b", token: "T" } }, "/"), /"github"/);
  assert.throws(() => readConfig({ repository: { host: "github", repo: "nope", token: "T" } }, "/"), /owner\/name/);
  const c = readConfig({ code: { holder: "pull-request" }, repository: { host: "github", repo: "acme/agents", token: "GITHUB_TOKEN" } }, "/");
  assert.deepEqual(c.repository, { host: "github", repo: "acme/agents", token: "GITHUB_TOKEN", api: "https://api.github.com", poll_seconds: 30 });
});

const calls = (f) => (existsSync(f.stubLog) ? readFileSync(f.stubLog, "utf8").split("\n").filter(Boolean) : []);

test("a build waiting on pushes when Product Factory stopped goes on checking its pull request after it starts again", async (t) => {
  const { gh, f, id } = await atCode(t, { factory: { doc: { version: "0.1", organization: { used: { review: false, security: false } } } } });
  await f.runner.stopAll();
  await f.runner.resumeAll();
  let b = await f.settled(id);
  assert.equal(stageOf(b, "code").runs, 1, "nothing is sent again: the pull request is still there");
  assert.equal(gh.pulls.size, 1);
  assert.ok(b.log.some((e) => /goes on checking pull request #1 for pushes/.test(e.said)));
  gh.push(BRANCH, { [SCRIPT]: RIGHT });
  ({ b } = await polled(f, id));
  assert.equal(stageOf(b, "code").where.check.title, "Ready for your OK");
});
