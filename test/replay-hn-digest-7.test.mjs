// A replay of a real build, the whole flow: hn-digest 0.1.0 on the cloud machine (build
// b_85f8645c822b, AgentMesh-Dev-Test/pf-e2e-proof pull request #7, 2026-11-12), one builder
// on a pull request, from the person's words to a closed build. The ADLC plugin is the one
// that machine ran (CommonAgent/adlc 3071e62: the kit of replay-hn-digest, 0f7cc46, with the
// one file that changed between them, kept in replay-hn-digest-7/plugin-overlay), and each
// push is the builder's own commit from that run (replay-hn-digest-7/builder-pushes.json), in
// the order it came, between the person's console actions in the order they were taken. The
// watch loop (pollAll, what the timer runs) sees each push. A fake GitHub stands in for
// GitHub and a stand-in packer for npm; nothing reaches the network and no model runs.
//
// On the cloud machine the run stopped after the builder's last push: the folder's check
// passed every stage, and the build never went on to Package.

import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { factory, stageOf, FAKE_ADLC, tempDir } from "./helpers.mjs";
import { fakeGitHub } from "./fixtures/fake-github.mjs";
import { checkBuild } from "adlc-console/lib/contract.mjs";
import { STAGE_IDS } from "../lib/standards.mjs";
import { checkBuild as checkBuildApi } from "../standards/lifecycle-api-check.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures", "replay-hn-digest-7");
const RUN = JSON.parse(readFileSync(join(FIX, "builder-pushes.json"), "utf8"));
const FOLDER = RUN.folder;
const pushOf = (sha) => RUN.commits.find((c) => c.sha === sha);
const ok = (b) => { assert.deepEqual(checkBuild({ build: b }, STAGE_IDS), []); assert.deepEqual(checkBuildApi({ build: b }, STAGE_IDS, b.id), []); };
const leftOut = { version: "0.1", organization: { used: { review: false, docs: false, security: false } } };
const actionsOf = (b) => b.actions.map((a) => `${a.stage}/${a.name}`);
const states = (b) => Object.fromEntries(b.stages.filter((s) => !["not_offered", "not_used"].includes(s.state)).map((s) => [s.stage, s.state]));

const STARTED = {
  name: "hn-digest",
  does: "Reads the current top stories on Hacker News and writes a short digest of the ones about a topic the caller names: each story's title, link, points and one plain sentence on why it matters.",
  refuses: "Writing about stories it did not read from Hacker News; inventing points, links or comments; posting, voting or commenting on Hacker News.",
  more: "It reaches one system, the public Hacker News API (read only, no key). It uses a model to write the sentences, with a spending ceiling of 1 USD per day. Settings: how many top stories to read (default 30, 10 to 100) and how many to put in the digest (default 5, 1 to 10). It is free.",
};

async function replayFactory(t) {
  const adlc = await tempDir("adlc");
  cpSync(FAKE_ADLC, adlc, { recursive: true });
  cpSync(join(HERE, "fixtures", "replay-hn-digest", "adlc", "plugin"), join(adlc, "plugin"), { recursive: true });
  cpSync(join(FIX, "plugin-overlay"), join(adlc, "plugin"), { recursive: true });
  const gh = await fakeGitHub();
  const f = await factory({ doc: leftOut, holder: "builder", where: "pull-request", github: gh, adlc, extraEnv: { ADLC_PACK: `node ${JSON.stringify(join(HERE, "fixtures", "bin", "stub-packer.mjs"))}` } });
  t.after(async () => { await f.close(); await gh.close(); });
  return { f, gh };
}

function builderPushes(gh, branch, sha) {
  const c = pushOf(sha);
  return gh.push(branch, Object.fromEntries(Object.entries(c.changes).map(([p, text]) => [`${FOLDER}/${p}`, text])), c.message);
}

/** A push is seen as on the machine: by the watch loop the timer runs. */
async function watched(f, id) { await f.runner.pollAll(); return f.settled(id); }

test("the real hn-digest build #7, replayed whole: your words, the builder's pushes, your approval and answer, through Package to your OK", async (t) => {
  const { f, gh } = await replayFactory(t);
  const id = (await f.post("/builds", STARTED)).json.build.id;
  let b = await f.settled(id);
  ok(b);
  const branch = [...gh.pulls.values()][0].head;
  assert.equal(gh.filesAt(branch)[`${FOLDER}/request.md`], RUN.request, "the folder holds the person's words exactly as the run's did");

  // The builder writes the spec; you approve it in the console, and the approval is pinned in the folder.
  builderPushes(gh, branch, "e08df84");
  b = await watched(f, id);
  ok(b);
  assert.equal(stageOf(b, "requirements").state, "waiting_on_you");
  assert.equal((await f.post(`/builds/${id}/actions/approve`)).status, 200);
  b = await f.settled(id);
  ok(b);
  assert.equal(JSON.parse(gh.filesAt(branch)[`${FOLDER}/build.lock.json`]).gates.requirements.by, "the person");

  // The builder writes the architecture, with egress-1 for you; you answer it in the console.
  builderPushes(gh, branch, "c0db1fb");
  b = await watched(f, id);
  ok(b);
  assert.equal(stageOf(b, "architecture").state, "waiting_on_you");
  assert.match(stageOf(b, "architecture").handed_back.words[0], /^Only you can answer: egress-1: /);
  assert.equal((await f.post(`/builds/${id}/actions/changes`, { changes: "egress-1: yes" })).status, 200);
  b = await f.settled(id);
  ok(b);
  assert.equal(JSON.parse(gh.filesAt(branch)[`${FOLDER}/answers.json`])["egress-1"], "yes");

  // The builder pushes stage after stage, each seen by the watch loop, as on the machine.
  for (const sha of ["038fba0", "a2e38c4", "7597fa6", "36e7045"]) {
    builderPushes(gh, branch, sha);
    b = await watched(f, id);
    ok(b);
  }
  for (const s of ["requirements", "architecture", "test", "code"]) assert.equal(stageOf(b, s).state, "done", `${s}: ${JSON.stringify(states(b))}`);
  assert.ok(b.log.some((l) => /Every stage of the build folder passed its own check/.test(l.said)), "the log says every stage passed");

  // Where the machine stopped: the build goes on past the builder, through Package, to your OK.
  assert.notEqual(stageOf(b, "package").state, "not_started", `the build went on to Package: ${JSON.stringify(states(b))} | ${actionsOf(b).join(" ")}`);
  ok(b);
  const pkg = stageOf(b, "package");
  assert.equal(pkg.state, "done", `Package: ${JSON.stringify(pkg.handed_back?.words)}`);
  assert.match(pkg.handed_back.words[0], /^Packed hn-digest 0\.1\.0 as an Agent Package/);
  // Your OK: the process document's "approve the deploy" gate, with no runtime set as on the machine.
  assert.equal(stageOf(b, "deploy").state, "waiting_on_you");
  assert.deepEqual(actionsOf(b), ["deploy/approve", "deploy/stop"]);
  assert.equal((await f.post(`/builds/${id}/actions/approve`)).status, 200);
  b = await f.settled(id);
  ok(b);
  assert.equal(b.summary, "Packed and validated · hn-digest 0.1.0 · Hand this package to your runtime");
  assert.ok(actionsOf(b).includes("deploy/archive"), actionsOf(b).join(" "));
  // You hand the package over yourself and close the build.
  assert.equal((await f.post(`/builds/${id}/actions/archive`)).status, 200);
  b = await f.settled(id);
  ok(b);
  assert.ok(actionsOf(b).includes("deploy/unarchive") && !actionsOf(b).includes("deploy/archive"), `the build is archived: ${actionsOf(b).join(" ")}`);
});
