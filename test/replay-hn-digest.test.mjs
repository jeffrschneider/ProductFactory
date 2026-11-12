// A replay of a real build: hn-digest 0.1.0 on the cloud machine (build b_22251b9bbf4a,
// AgentMesh-Dev-Test/pf-e2e-proof pull request #6, 2026-11-11), with one builder on a pull
// request. Each push is the builder's own commit from that run
// (fixtures/replay-hn-digest/builder-pushes.json), in the order it came, between the
// person's console actions in the order they were taken. A fake GitHub stands in for
// GitHub; nothing reaches the network and no model runs.
//
// The ADLC plugin is the one this Product Factory pins, in two phases (fixtures/pinned-adlc),
// not the five-stage plugin that machine ran, so each push is replayed without the lock file
// the old check wrote into it: the folder's own check writes the lock.
//
// The spec check that plugin carries now holds the run's first spec at once: its news
// system kept its address in two settings, which the run only found at the agent's files.
// So here your words go in at Requirements and the builder's revised spec (879c31b) is the
// one approved. The two tests of approving while a new spec arrives start from run #7's
// first spec, which the check accepts (fixtures/replay-hn-digest-7: the same words, the same
// folder), and the builder's new push is this run's revised spec.
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
// The person's words on that run, which the builder added to request.md with its revised spec.
const SENT_BACK = "Take both of your recommendations. The news system carries the address I approved in egress-1 (https://hacker-news.firebaseio.com/v0) as its address, with no settings of its own. A story with no link of its own stays in the digest with the line: Link: none (a Hacker News post with no link of its own).";

async function replayFactory(t) {
  const adlc = await tempDir("adlc");
  cpSync(FAKE_ADLC, adlc, { recursive: true });
  cpSync(join(HERE, "fixtures", "pinned-adlc", "plugin"), join(adlc, "plugin"), { recursive: true });
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
  return gh.push(branch, Object.fromEntries(Object.entries(c.changes).filter(([p]) => p !== "build.lock.json").map(([p, text]) => [`${FOLDER}/${p}`, text])), c.message);
}

/** A push is seen: Product Factory's poll runs the folder's check on it. */
async function seen(f, id) { await f.runner.poll(id); return f.settled(id); }

/** The first push of run #7 (the same words, the same folder): a spec the folder's check accepts. */
const RUN7 = JSON.parse(readFileSync(join(HERE, "fixtures", "replay-hn-digest-7", "builder-pushes.json"), "utf8"));
const firstSpecOf7 = RUN7.commits.find((c) => c.sha === "e08df84");

/** Start the build, and see the builder's first push. */
async function started(f, gh, push) {
  const id = (await f.post("/builds", STARTED)).json.build.id;
  let b = await f.settled(id);
  ok(b);
  const branch = [...gh.pulls.values()][0].head;
  assert.equal(gh.filesAt(branch)[`${FOLDER}/request.md`], RUN.request, "the folder holds the person's words exactly as the run's did");
  assert.equal(stageOf(b, "requirements").state, "working");
  push(branch);
  b = await seen(f, id);
  ok(b);
  return { id, branch, b };
}

/** After run #7's first spec, the builder's new push: this run's revised spec, with this run's answers (its price is "free" where run #7's is "Free"). */
function revisedSpecPush(gh, branch) {
  const c = pushOf("879c31b");
  const changes = { ...c.changes, "answers.json": pushOf("b4a5c56").changes["answers.json"] };
  return gh.push(branch, Object.fromEntries(Object.entries(changes).map(([p, text]) => [`${FOLDER}/${p}`, text])), c.message);
}

/** Start the build and bring it to where the person first approves the builder's spec (run #7's). */
async function toFirstApproval(f, gh) {
  const r = await started(f, gh, (branch) => gh.push(branch, Object.fromEntries(Object.entries(firstSpecOf7.changes).map(([p, text]) => [`${FOLDER}/${p}`, text])), firstSpecOf7.message));
  assert.equal(stageOf(r.b, "requirements").state, "waiting_on_you");
  return r;
}

test("the real hn-digest build, replayed: the first spec held by the folder's check, your words, and the revised spec approved as it stands on the branch", async (t) => {
  const { f, gh } = await replayFactory(t);
  let { id, branch, b } = await started(f, gh, (branch) => builderPushes(gh, branch, "b4a5c56"));

  // The folder's check holds the builder's first spec and says why on the pull request, in its own words; there is nothing to approve yet.
  assert.equal(stageOf(b, "requirements").state, "working");
  assert.ok(gh.comments.some((c) => /NEWS_API_ADDRESS/.test(c.body ?? c)), "the check names the address kept in a setting");
  assert.ok(!actionsOf(b).includes("requirements/approve"), `a held spec is not offered for approval: ${actionsOf(b).join(" ")}`);
  assert.deepEqual(actionsOf(b), ["requirements/stop"], "while your assistant writes the spec, you talk to it, not the console");

  // You give your words to your assistant, which adds them to the end of request.md and revises the
  // spec (the run's own revision); the console hands you that spec, and your approval pins it.
  builderPushes(gh, branch, "879c31b");
  b = await seen(f, id);
  ok(b);
  const request = gh.filesAt(branch)[`${FOLDER}/request.md`];
  assert.ok(request.includes(SENT_BACK), "your words are in request.md on the branch");
  assert.equal(request.split(SENT_BACK).length, 2, "and only once");
  assert.equal(stageOf(b, "requirements").state, "waiting_on_you");
  const revised = pushOf("879c31b").changes["spec.json"];
  assert.equal(JSON.parse(revised).systems[0].address, "https://hacker-news.firebaseio.com/v0");
  assert.equal((await f.post(`/builds/${id}/actions/approve`)).status, 200);
  b = await f.settled(id);
  ok(b);
  const lock = JSON.parse(gh.filesAt(branch)[`${FOLDER}/build.lock.json`]);
  assert.equal(lock.gates.spec.by, "the person");
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
  revisedSpecPush(gh, branch);
  const r = await f.post(`/builds/${id}/actions/approve`);
  b = await f.settled(id);
  ok(b);
  const lock = JSON.parse(gh.filesAt(branch)[`${FOLDER}/build.lock.json`]);
  if (r.status === 200 && lock.gates.spec) {
    assert.equal(lock.digests["spec.json"], sha256(revised), "an approval pins the spec on the branch, never the one shown before the push");
  } else {
    assert.equal(r.status, 409);
    assert.match(r.json.error, /new spec/i, "the refusal says the builder pushed a new spec");
    assert.equal(lock.gates.spec, undefined, "nothing was approved");
    assert.notEqual(revised, first);
    // The new spec is handed to you, and approving it works.
    assert.equal(stageOf(b, "requirements").state, "waiting_on_you");
    assert.ok(actionsOf(b).includes("requirements/approve"), `approve is the next action: ${actionsOf(b).join(" ")}`);
    assert.equal((await f.post(`/builds/${id}/actions/approve`)).status, 200);
    b = await f.settled(id);
    const pinned = JSON.parse(gh.filesAt(branch)[`${FOLDER}/build.lock.json`]);
    assert.equal(pinned.gates.spec.by, "the person");
    assert.equal(pinned.digests["spec.json"], sha256(revised));
  }
  assert.notEqual(stageOf(b, "architecture").state, "refused", "the build never sits refused with nothing that works");
});

test("a build from before the branch was read at Approve: a spec changed under your approval sends it back to Requirements, with the spec as it stands to approve", async (t) => {
  const { f, gh } = await replayFactory(t);
  let { id, branch, b } = await toFirstApproval(f, gh);
  // A build whose record says nothing of which spec was handed to you, as one started before this change.
  await f.store.update(id, (x) => { delete x.work.builder.handed_spec; });
  revisedSpecPush(gh, branch);
  const revised = pushOf("879c31b").changes["spec.json"];
  assert.equal((await f.post(`/builds/${id}/actions/approve`)).status, 200);
  b = await f.settled(id);
  ok(b);
  assert.equal(JSON.parse(gh.filesAt(branch)[`${FOLDER}/build.lock.json`]).gates.spec, undefined, "nothing was approved for you");
  assert.equal(stageOf(b, "requirements").state, "waiting_on_you", "back at Requirements, with the spec as it stands");
  assert.notEqual(stageOf(b, "architecture").state, "refused");
  assert.ok(actionsOf(b).includes("requirements/approve"), `approve is the next action: ${actionsOf(b).join(" ")}`);
  assert.equal((await f.post(`/builds/${id}/actions/approve`)).status, 200);
  b = await f.settled(id);
  const lock = JSON.parse(gh.filesAt(branch)[`${FOLDER}/build.lock.json`]);
  assert.equal(lock.gates.spec.by, "the person");
  assert.equal(lock.digests["spec.json"], sha256(revised));
});
