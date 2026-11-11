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
  for (const s of ["architecture", "test", "code"]) assert.match(stageOf(b, s).holder.name, /^one builder: your own coding assistant with the ADLC plugin, on a pull request \(acme\/agents\)$/);

  // Your approval in the console: the folder is laid out and your approval pinned there, then it goes to a branch and a pull request.
  assert.equal((await f.post(`/builds/${id}/actions/approve`)).status, 200);
  b = await f.settled(id);
  ok(b);
  assert.equal(gh.pulls.size, 1);
  const pr = [...gh.pulls.values()][0];
  assert.match(pr.title, /^Build the agent: word-counter /);
  assert.match(pr.body, /\/plugin install adlc --marketplace CommonAgent\/adlc/);
  const branch = pr.head;
  const onBranch = gh.filesAt(branch);
  assert.ok(onBranch["agents/word-counter/.adlc/check.mjs"], "the ADLC kit is on the branch");
  assert.ok(onBranch["agents/word-counter/spec.json"], "the spec you approved is on the branch");
  assert.equal(JSON.parse(onBranch["agents/word-counter/build.lock.json"]).gates.requirements.by, "the person");
  // This machine ran no coding agent: the harness was never called.
  assert.deepEqual(harnessCalls(f), []);
  assert.equal(stageOf(b, "architecture").state, "working");
  assert.equal(b.work?.builder, undefined, "the build's work is not in the API");

  // A push with nothing new is not checked again.
  assert.equal((await f.runner.poll(id)).judged, false);

  // Your own assistant pushes the architecture, the files, a test and a script: the check asks what only you can answer.
  const pushed = await personPushes(gh, branch, "agents/word-counter");
  assert.ok(pushed.includes("agents/word-counter/scripts/count.mjs"));
  const judged = await f.runner.poll(id);
  assert.equal(judged.judged, true);
  b = await f.settled(id);
  ok(b);
  assert.equal(stageOf(b, "architecture").state, "waiting_on_you");
  assert.match(stageOf(b, "architecture").handed_back.words[0], /^Only you can answer: egress-1: /);
  assert.ok(gh.comments.some((c) => /is not passed yet/.test(c.body ?? c)), "the check's word is said on the pull request");

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
