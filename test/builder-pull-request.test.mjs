// One builder on a pull request (code.holder "builder", code.where "pull-request"): this
// machine runs no coding agent. Your approval of the spec is pressed in the console and
// pinned in the build folder here, the folder goes to a branch and a "Build the agent" pull
// request, your own coding assistant works it there (a stand-in builder, run on a copy of the
// branch, pushes what it wrote), and every push is checked by the folder's own check. Your
// answers go on the branch as Product Factory's commit. Stand-ins throughout: the fake spec
// writer, the stand-in kit (fixtures/fake-kit), a fake GitHub (fixtures/fake-github.mjs).

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { factory, stageOf, FAKE_ADLC, tempDir } from "./helpers.mjs";
import { fakeGitHub } from "./fixtures/fake-github.mjs";
import { checkBuild } from "adlc-console/lib/contract.mjs";
import { STAGE_IDS } from "../lib/standards.mjs";
import { checkBuild as checkBuildApi } from "../standards/lifecycle-api-check.mjs";
import { readConfig } from "../lib/config.mjs";
import { builderPullRequestBody, changedFrom, mirror, folderFiles } from "../lib/builder-pr.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB_BUILDER = join(HERE, "fixtures", "stub-builder.mjs");
const ok = (b) => { assert.deepEqual(checkBuild({ build: b }, STAGE_IDS), []); assert.deepEqual(checkBuildApi({ build: b }, STAGE_IDS, b.id), []); };
const leftOut = { version: "0.1", organization: { used: { review: false, docs: false, security: false } } };

async function adlcWithKit() {
  const at = await tempDir("adlc");
  cpSync(FAKE_ADLC, at, { recursive: true });
  cpSync(join(HERE, "fixtures", "fake-kit"), join(at, "plugin", "kit"), { recursive: true });
  return at;
}

const harnessCalls = (f) => (existsSync(f.stubLog) ? readFileSync(f.stubLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.builder) : []);

/** Your own coding assistant runs the folder's check, as AGENTS.md says, and pushes the lock it pinned. */
async function personChecks(gh, branch, folder) {
  const work = await tempDir("checkout");
  const files = gh.filesAt(branch);
  for (const [p, text] of Object.entries(files)) {
    if (!p.startsWith(`${folder}/`)) continue;
    const at = join(work, ...p.slice(folder.length + 1).split("/"));
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, text);
  }
  spawnSync(process.execPath, [join(work, ".adlc", "check.mjs"), "--json"], { cwd: work, encoding: "utf8" });
  const lock = readFileSync(join(work, "build.lock.json"), "utf8");
  if (lock !== files[`${folder}/build.lock.json`]) gh.push(branch, { [`${folder}/build.lock.json`]: lock });
  return JSON.parse(lock).gates;
}

/** Your own coding assistant: the branch's build folder checked out, the stand-in builder run in it, and what it wrote pushed. */
async function personPushes(gh, branch, folder) {
  const work = await tempDir("checkout");
  const files = gh.filesAt(branch);
  for (const [p, text] of Object.entries(files)) {
    if (!p.startsWith(`${folder}/`)) continue;
    const at = join(work, ...p.slice(folder.length + 1).split("/"));
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, text);
  }
  const r = spawnSync(process.execPath, [STUB_BUILDER, "build it", "plugin"], { cwd: work, encoding: "utf8", env: { ...process.env, PF_STUB_LOG: "" } });
  assert.equal(r.status, 0, r.stderr);
  const changes = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const at = join(d, name);
      if (statSync(at).isDirectory()) walk(at);
      else {
        const p = `${folder}/${relative(work, at).split(sep).join("/")}`;
        const text = readFileSync(at, "utf8");
        if (files[p] !== text) changes[p] = text;
      }
    }
  };
  walk(work);
  gh.push(branch, changes);
  return Object.keys(changes);
}

test("one builder on a pull request: the folder goes to a branch, your own assistant works it, each push is checked, and your answer goes on the branch", async (t) => {
  const adlc = await adlcWithKit();
  const gh = await fakeGitHub();
  const f = await factory({ doc: leftOut, holder: "builder", where: "pull-request", github: gh, harness: ["node", STUB_BUILDER, "{prompt}", "{plugin}"], adlc });
  t.after(async () => { await f.close(); await gh.close(); });

  const id = (await f.post("/builds", { does: "Count the words in a passage.", refuses: "Changing the passage.", name: "word-counter" })).json.build.id;
  let b = await f.settled(id);
  ok(b);
  // One author: the builder holds Requirements too, and no reference spec writer runs.
  for (const s of ["requirements", "architecture", "test", "code"]) assert.match(stageOf(b, s).holder.name, /^one builder: your own coding assistant with the ADLC plugin, on a pull request \(acme\/agents\)$/, s);
  assert.equal(stageOf(b, "requirements").state, "working");
  // The pull request opens at once, with the folder and your words in request.md and no spec yet.
  assert.equal(gh.pulls.size, 1);
  const pr = [...gh.pulls.values()][0];
  assert.match(pr.title, /^Build the agent: word-counter /);
  assert.match(pr.body, /\/plugin install adlc --marketplace CommonAgent\/adlc/);
  const branch = pr.head;
  let onBranch = gh.filesAt(branch);
  assert.ok(onBranch["agents/word-counter/.adlc/check.mjs"], "the ADLC kit is on the branch");
  assert.match(onBranch["agents/word-counter/request.md"], /Count the words in a passage\./);
  assert.equal(onBranch["agents/word-counter/spec.json"], undefined, "the builder writes the spec, not this machine");
  assert.deepEqual(harnessCalls(f), [], "this machine runs no coding agent");
  assert.equal(b.work?.builder, undefined, "the build's work is not in the API");
  // A push with nothing new is not checked again.
  assert.equal((await f.runner.poll(id)).judged, false);

  // Your own assistant writes the spec (and, being a stand-in, everything after it) and pushes: the check says the spec is ready for you.
  const pushed = await personPushes(gh, branch, "agents/word-counter");
  assert.ok(pushed.includes("agents/word-counter/spec.json"));
  assert.equal((await f.runner.poll(id)).judged, true);
  b = await f.settled(id);
  ok(b);
  assert.equal(stageOf(b, "requirements").state, "waiting_on_you");
  assert.match(stageOf(b, "requirements").handed_back.words[0], /^The builder's spec is ready for your approval/);

  // Your approval in the console: pinned in the folder here and pushed to the branch; then the check asks what only you can answer.
  assert.equal((await f.post(`/builds/${id}/actions/approve`)).status, 200);
  b = await f.settled(id);
  ok(b);
  onBranch = gh.filesAt(branch);
  assert.equal(JSON.parse(onBranch["agents/word-counter/build.lock.json"]).gates.requirements.by, "the person");
  assert.equal(stageOf(b, "requirements").state, "done");
  assert.equal(stageOf(b, "architecture").state, "waiting_on_you");
  assert.match(stageOf(b, "architecture").handed_back.words[0], /^Only you can answer: egress-1: /);
  assert.deepEqual(harnessCalls(f), [], "still no coding agent on this machine");

  // While the build waits on you, your assistant still pushes, and the watch loop (pollAll, what the timer
  // runs) still judges each push: on the cloud machine it stopped following the branch here.
  const judgedBefore = gh.comments.length;
  gh.push(branch, { "agents/word-counter/notes.md": "the assistant pushed while the question was open\n" });
  await f.runner.pollAll();
  await f.settled(id);
  assert.ok(gh.comments.length > judgedBefore, "the push made while waiting on you was checked");

  // Your answer goes on the branch as Product Factory's commit, and the check passes every stage on it.
  assert.equal((await f.post(`/builds/${id}/actions/changes`, { changes: "egress-1: yes" })).status, 200);
  b = await f.settled(id);
  ok(b);
  assert.equal(JSON.parse(gh.filesAt(branch)["agents/word-counter/answers.json"])["egress-1"], "yes");
  assert.match(gh.log(branch)[0].message, /^Product Factory: your answers to what the build folder asked$/);
  for (const s of ["architecture", "test", "code"]) assert.equal(stageOf(b, s).state, "done", s);
  assert.equal(stageOf(b, "package").state, "done");
  assert.deepEqual(harnessCalls(f), [], "still no coding agent on this machine");
});

test("while the build waits on your answer, the assistant's pushes still move it on, through every stage", async (t) => {
  const adlc = await adlcWithKit();
  const gh = await fakeGitHub();
  const f = await factory({ doc: leftOut, holder: "builder", where: "pull-request", github: gh, adlc });
  t.after(async () => { await f.close(); await gh.close(); });
  const folder = "agents/word-counter";
  const id = (await f.post("/builds", { does: "Count the words in a passage.", refuses: "Changing the passage.", name: "word-counter" })).json.build.id;
  await f.settled(id);
  const branch = [...gh.pulls.values()][0].head;
  await personPushes(gh, branch, folder);
  await f.runner.poll(id);
  await f.settled(id);
  assert.equal((await f.post(`/builds/${id}/actions/approve`)).status, 200);
  let b = await f.settled(id);
  assert.equal(stageOf(b, "architecture").state, "waiting_on_you", "the folder asks egress-1");

  // As on the cloud machine (pf-e2e-proof #7): the assistant goes on while the console still shows the
  // question, and pushes stage after stage. Each push is judged by the watch loop and applied.
  gh.push(branch, { [`${folder}/answers.json`]: JSON.stringify({ ...JSON.parse(gh.filesAt(branch)[`${folder}/answers.json`] ?? "{}"), "egress-1": "yes" }, null, 2) + "\n" });
  await personChecks(gh, branch, folder);
  await f.runner.pollAll();
  b = await f.settled(id);
  ok(b);
  for (const s of ["architecture", "test", "code"]) assert.equal(stageOf(b, s).state, "done", s);
  assert.notEqual(stageOf(b, "architecture").state, "waiting_on_you");
});

test("a send back from the console goes on the pull request: approve.mjs --send-back run in a mirror of the branch, pushed, and the next push's check finds the stage open", async (t) => {
  const adlc = await adlcWithKit();
  const gh = await fakeGitHub();
  const f = await factory({ doc: leftOut, holder: "builder", where: "pull-request", github: gh, adlc });
  t.after(async () => { await f.close(); await gh.close(); });
  const folder = "agents/word-counter";
  const id = (await f.post("/builds", { does: "Count the words in a passage.", name: "word-counter" })).json.build.id;
  await f.settled(id);
  const branch = [...gh.pulls.values()][0].head;

  // Your assistant writes the spec and everything but the script; you approve the spec and answer, and the build waits at Code.
  await personPushes(gh, branch, folder);
  gh.push(branch, { [`${folder}/scripts/count.mjs`]: null });
  await f.runner.poll(id);
  await f.settled(id);
  assert.equal((await f.post(`/builds/${id}/actions/approve`)).status, 200);
  await f.settled(id);
  await f.post(`/builds/${id}/actions/changes`, { changes: "egress-1: yes" });
  await f.settled(id);
  // Your assistant pulls your answer, runs the check, and pushes the lock it pinned: up to Test, with Code still to write.
  assert.deepEqual(Object.keys(await personChecks(gh, branch, folder)), ["requirements", "architecture", "files", "test"]);
  await f.runner.poll(id);
  let b = await f.settled(id);
  ok(b);
  assert.equal(stageOf(b, "test").state, "done");
  assert.equal(stageOf(b, "code").state, "working");
  assert.ok(b.actions.find((a) => a.name === "send_back").needs.find((n) => n.name === "to").options.includes("test"));

  // You send it back to Test in the console: the send back is run in a mirror of the branch and pushed as Product Factory's commit.
  assert.equal((await f.post(`/builds/${id}/actions/send_back`, { to: "test", changes: "Test the empty passage too." })).status, 200);
  b = await f.settled(id);
  ok(b);
  assert.match(gh.log(branch)[0].message, /^Product Factory: you sent the build back to test$/);
  assert.deepEqual(Object.keys(JSON.parse(gh.filesAt(branch)[`${folder}/build.lock.json`]).gates), ["requirements", "architecture", "files"], "Test and Code are open again on the branch");
  assert.match(gh.filesAt(branch)[`${folder}/request.md`], /Test the empty passage too\.\n$/, "your words go with the send back, at the end of request.md");

  // Your assistant takes the test out to rewrite it: the next push's check finds Test open, and the build is back at it.
  gh.push(branch, { [`${folder}/test/f1.test.mjs`]: null });
  assert.equal((await f.runner.poll(id)).judged, true);
  b = await f.settled(id);
  ok(b);
  assert.equal(stageOf(b, "test").state, "working");
  assert.equal(stageOf(b, "code").state, "not_started");
  assert.ok(gh.comments.some((c) => /test is not passed yet/.test(c.body ?? c)), "the check's word is said on the pull request");
});

test("the folder mirrors its branch, keeps records/, and names only what changed since", async () => {
  const dir = await tempDir("mirror");
  mkdirSync(join(dir, "records"), { recursive: true });
  writeFileSync(join(dir, "records", "local.log"), "mine\n");
  writeFileSync(join(dir, "stale.md"), "gone soon\n");
  const branch = new Map([["spec.json", Buffer.from("{}\n")], ["test/a.test.mjs", Buffer.from("x\n")]]);
  mirror(dir, branch);
  assert.deepEqual([...folderFiles(dir).keys()], ["spec.json", "test/a.test.mjs"]);
  assert.equal(readFileSync(join(dir, "records", "local.log"), "utf8"), "mine\n");
  writeFileSync(join(dir, "answers.json"), "{\"egress-1\":\"yes\"}\n");
  assert.deepEqual(changedFrom(dir, branch).map((c) => c.path), ["answers.json"]);
  assert.match(builderPullRequestBody("word-counter", "0.1.0", "agents/word-counter"), /`agents\/word-counter\/`/);
});

test("code.where is for one builder only, and a pull request needs its repository", () => {
  assert.throws(() => readConfig({ code: { holder: "harness", where: "pull-request" } }, "/"), /"code.where" is for "code.holder": "builder" only/);
  assert.throws(() => readConfig({ code: { holder: "builder", where: "pull-request" } }, "/"), /"code.where" is "pull-request", so "repository" names where the pull request goes/);
  assert.throws(() => readConfig({ code: { holder: "builder", where: "elsewhere" } }, "/"), /"code.where" is "here" .* or "pull-request"/);
  const c = readConfig({ code: { holder: "builder", where: "pull-request" }, repository: { host: "github", repo: "acme/agents", token: "GITHUB_TOKEN" } }, "/");
  assert.equal(c.code.where, "pull-request");
});
