// A replay of a real build: hn-digest 0.1.0 on the cloud machine (build b_22251b9bbf4a,
// AgentMesh-Dev-Test/pf-e2e-proof pull request #6, 2026-11-11), with one builder on a pull
// request. The ADLC plugin is the one that machine ran (CommonAgent/adlc 0f7cc46, kept in
// fixtures/replay-hn-digest/adlc), and each push is the builder's own commit from that run
// (fixtures/replay-hn-digest/builder-pushes.json), in the order it came, between the
// person's console actions in the order they were taken. A fake GitHub stands in for
// GitHub; nothing reaches the network and no model runs.
//
// The run found three things this replay holds Product Factory to: what you approve is the
// spec on the branch as it stands; a send back carries your words; and after any refusal you
// have a next action that works.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { factory, stageOf, FAKE_ADLC, tempDir } from "./helpers.mjs";
import { fakeGitHub } from "./fixtures/fake-github.mjs";
import { checkBuild } from "adlc-console/lib/contract.mjs";
import { STAGE_IDS } from "../lib/standards.mjs";
import { checkBuild as checkBuildApi } from "../standards/lifecycle-api-check.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures", "replay-hn-digest");
const RUN = JSON.parse(readFileSync(join(FIX, "builder-pushes.json"), "utf8"));
const FOLDER = RUN.folder;
const pushOf = (sha) => RUN.commits.find((c) => c.sha === sha);
const ok = (b) => { assert.deepEqual(checkBuild({ build: b }, STAGE_IDS), []); assert.deepEqual(checkBuildApi({ build: b }, STAGE_IDS, b.id), []); };
const leftOut = { version: "0.1", organization: { used: { review: false, docs: false, security: false } } };
const sha256 = (t) => `sha256:${createHash("sha256").update(t).digest("hex")}`;
const actionsOf = (b) => b.actions.map((a) => `${a.stage}/${a.name}`);

// The build as it was started on the cloud machine (D:/scratch/hn-digest/drive.mjs).
const STARTED = {
  name: "hn-digest",
  does: "Reads the current top stories on Hacker News and writes a short digest of the ones about a topic the caller names: each story's title, link, points and one plain sentence on why it matters.",
  refuses: "Writing about stories it did not read from Hacker News; inventing points, links or comments; posting, voting or commenting on Hacker News.",
  more: "It reaches one system, the public Hacker News API (read only, no key). It uses a model to write the sentences, with a spending ceiling of 1 USD per day. Settings: how many top stories to read (default 30, 10 to 100) and how many to put in the digest (default 5, 1 to 10). It is free.",
};
// The words the person sent the build back with, after the agent's files were held.
const SENT_BACK = "Take both of your recommendations. The news system carries the address I approved in egress-1 (https://hacker-news.firebaseio.com/v0) as its address, with no settings of its own. A story with no link of its own stays in the digest with the line: Link: none (a Hacker News post with no link of its own).";

async function replayFactory(t) {
  const adlc = await tempDir("adlc");
  cpSync(FAKE_ADLC, adlc, { recursive: true });
  cpSync(join(FIX, "adlc", "plugin"), join(adlc, "plugin"), { recursive: true });
  const gh = await fakeGitHub();
  // The packer is never reached in this run (the agent's files are held before it), and a
  // stand-in answers if it were, so nothing reaches npm.
  const f = await factory({ doc: leftOut, holder: "builder", where: "pull-request", github: gh, adlc, extraEnv: { ADLC_PACK: `node ${JSON.stringify(join(HERE, "fixtures", "bin", "stub-packer.mjs"))}` } });
  t.after(async () => { await f.close(); await gh.close(); });
  return { f, gh };
}

/** The builder's commit from the run, pushed as it was. */
function builderPushes(gh, branch, sha) {
  const c = pushOf(sha);
  return gh.push(branch, Object.fromEntries(Object.entries(c.changes).map(([p, text]) => [`${FOLDER}/${p}`, text])), c.message);
}

/** A push is seen: Product Factory's poll runs the folder's check on it. */
async function seen(f, id) { await f.runner.poll(id); return f.settled(id); }

/** Start the build and bring it to where the person first approves the builder's spec. */
async function toFirstApproval(f, gh) {
  const id = (await f.post("/builds", STARTED)).json.build.id;
  let b = await f.settled(id);
  ok(b);
  const branch = [...gh.pulls.values()][0].head;
  assert.equal(gh.filesAt(branch)[`${FOLDER}/request.md`], RUN.request, "the folder holds the person's words exactly as the run's did");
  assert.equal(stageOf(b, "requirements").state, "working");
  builderPushes(gh, branch, "b4a5c56");
  b = await seen(f, id);
  ok(b);
  assert.equal(stageOf(b, "requirements").state, "waiting_on_you");
  return { id, branch, b };
}

test("the real hn-digest build, replayed: approve, answer, held, sent back with your words, the revised spec approved as it stands on the branch", async (t) => {
  const { f, gh } = await replayFactory(t);
  let { id, branch, b } = await toFirstApproval(f, gh);

  // You approve the builder's spec: pinned by you in the folder and pushed.
  assert.equal((await f.post(`/builds/${id}/actions/approve`)).status, 200);
  b = await f.settled(id);
  ok(b);
  assert.equal(JSON.parse(gh.filesAt(branch)[`${FOLDER}/build.lock.json`]).gates.requirements.by, "the person");
  assert.equal(stageOf(b, "architecture").state, "working");

  // The builder pushes the architecture with one question only you can answer.
  builderPushes(gh, branch, "da90433");
  b = await seen(f, id);
  ok(b);
  assert.equal(stageOf(b, "architecture").state, "waiting_on_you");
  assert.match(stageOf(b, "architecture").handed_back.words[0], /^Only you can answer: egress-1: /);

  // Your answer goes on the branch; the builder pushes the architecture passing, then the agent's files.
  assert.equal((await f.post(`/builds/${id}/actions/changes`, { changes: "egress-1: yes" })).status, 200);
  b = await f.settled(id);
  assert.equal(JSON.parse(gh.filesAt(branch)[`${FOLDER}/answers.json`])["egress-1"], "yes");
  builderPushes(gh, branch, "98ced22");
  b = await seen(f, id);
  ok(b);
  assert.equal(stageOf(b, "architecture").state, "working", "the architecture passed, and the agent's files are next");
  builderPushes(gh, branch, "caed733");
  b = await seen(f, id);
  ok(b);
  assert.ok(actionsOf(b).includes("architecture/send_back"), `a next action that works while the files are held: ${actionsOf(b).join(" ")}`);

  // You send the build back to Requirements with your words: they go on the branch with it.
  assert.equal((await f.post(`/builds/${id}/actions/send_back`, { to: "requirements", changes: SENT_BACK })).status, 200);
  b = await f.settled(id);
  ok(b);
  const request = gh.filesAt(branch)[`${FOLDER}/request.md`];
  assert.ok(request.includes(SENT_BACK), "your words are in request.md on the branch");
  assert.equal(request.split(SENT_BACK).length, 2, "and only once");
  assert.deepEqual(JSON.parse(gh.filesAt(branch)[`${FOLDER}/build.lock.json`]).gates, {}, "Requirements and every stage after it are open again");
  // The spec on the branch is still the one you sent back: nothing is offered for approval until the builder revises it.
  assert.equal(stageOf(b, "requirements").state, "working");
  assert.ok(!actionsOf(b).includes("requirements/approve"), `the old spec is not offered again: ${actionsOf(b).join(" ")}`);

  // The builder pushes the revised spec; the console hands you that spec, and your approval pins it.
  builderPushes(gh, branch, "879c31b");
  b = await seen(f, id);
  ok(b);
  assert.equal(stageOf(b, "requirements").state, "waiting_on_you");
  const revised = pushOf("879c31b").changes["spec.json"];
  assert.equal(JSON.parse(revised).systems[0].address, "https://hacker-news.firebaseio.com/v0");
  assert.equal((await f.post(`/builds/${id}/actions/approve`)).status, 200);
  b = await f.settled(id);
  ok(b);
  const lock = JSON.parse(gh.filesAt(branch)[`${FOLDER}/build.lock.json`]);
  assert.equal(lock.gates.requirements.by, "the person");
  assert.equal(lock.digests["spec.json"], sha256(revised), "the spec you approved is the revised one on the branch");
  // Where the run ended: the build waits for the builder's next push at Architecture.
  assert.equal(stageOf(b, "requirements").state, "done");
  assert.equal(stageOf(b, "architecture").state, "working");
});

test("approving right after the builder pushed a new spec: never the old one, and you can approve the new one next", async (t) => {
  const { f, gh } = await replayFactory(t);
  let { id, branch, b } = await toFirstApproval(f, gh);
  const first = gh.filesAt(branch)[`${FOLDER}/spec.json`];

  // The builder pushes a revised spec (the run's own revision, with the words it came from in
  // request.md), and you approve before Product Factory has looked at the push.
  const revised = pushOf("879c31b").changes["spec.json"];
  builderPushes(gh, branch, "879c31b");
  const r = await f.post(`/builds/${id}/actions/approve`);
  b = await f.settled(id);
  ok(b);
  const lock = JSON.parse(gh.filesAt(branch)[`${FOLDER}/build.lock.json`]);
  if (r.status === 200 && lock.gates.requirements) {
    assert.equal(lock.digests["spec.json"], sha256(revised), "an approval pins the spec on the branch, never the one shown before the push");
  } else {
    assert.equal(r.status, 409);
    assert.match(r.json.error, /new spec/i, "the refusal says the builder pushed a new spec");
    assert.equal(lock.gates.requirements, undefined, "nothing was approved");
    assert.notEqual(revised, first);
    // The new spec is handed to you, and approving it works.
    assert.equal(stageOf(b, "requirements").state, "waiting_on_you");
    assert.ok(actionsOf(b).includes("requirements/approve"), `approve is the next action: ${actionsOf(b).join(" ")}`);
    assert.equal((await f.post(`/builds/${id}/actions/approve`)).status, 200);
    b = await f.settled(id);
    const pinned = JSON.parse(gh.filesAt(branch)[`${FOLDER}/build.lock.json`]);
    assert.equal(pinned.gates.requirements.by, "the person");
    assert.equal(pinned.digests["spec.json"], sha256(revised));
  }
  assert.notEqual(stageOf(b, "architecture").state, "refused", "the build never sits refused with nothing that works");
});

test("a build from before the branch was read at Approve: a spec changed under your approval sends it back to Requirements, with the spec as it stands to approve", async (t) => {
  const { f, gh } = await replayFactory(t);
  let { id, branch, b } = await toFirstApproval(f, gh);
  // A build whose record says nothing of which spec was handed to you, as one started before this change.
  await f.store.update(id, (x) => { delete x.work.builder.handed_spec; });
  builderPushes(gh, branch, "879c31b");
  const revised = pushOf("879c31b").changes["spec.json"];
  assert.equal((await f.post(`/builds/${id}/actions/approve`)).status, 200);
  b = await f.settled(id);
  ok(b);
  assert.equal(JSON.parse(gh.filesAt(branch)[`${FOLDER}/build.lock.json`]).gates.requirements, undefined, "nothing was approved for you");
  assert.equal(stageOf(b, "requirements").state, "waiting_on_you", "back at Requirements, with the spec as it stands");
  assert.notEqual(stageOf(b, "architecture").state, "refused");
  assert.ok(actionsOf(b).includes("requirements/approve"), `approve is the next action: ${actionsOf(b).join(" ")}`);
  assert.equal((await f.post(`/builds/${id}/actions/approve`)).status, 200);
  b = await f.settled(id);
  const lock = JSON.parse(gh.filesAt(branch)[`${FOLDER}/build.lock.json`]);
  assert.equal(lock.gates.requirements.by, "the person");
  assert.equal(lock.digests["spec.json"], sha256(revised));
});
