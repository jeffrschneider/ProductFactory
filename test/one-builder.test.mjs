// A build that one builder holds (code.holder "builder", make-a-new-agent-one-builder.txt,
// the reference make-a-new-agent v2 with its blanks filled): the build folder is laid out
// with the ADLC plugin's kit, your approval of the spec is pressed there by Product Factory,
// each stage is decided by the folder's own check, what only you can answer waits for you,
// and the build can be sent back to any earlier stage. Stand-ins throughout: the fake spec
// writer, a stand-in kit (fixtures/fake-kit) and a stand-in builder (fixtures/stub-builder.mjs).

import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { factory, stageOf, actionNames, FAKE_ADLC, tempDir } from "./helpers.mjs";
import { checkBuild } from "adlc-console/lib/contract.mjs";
import { STAGE_IDS } from "../lib/standards.mjs";
import { checkBuild as checkBuildApi } from "../standards/lifecycle-api-check.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB_BUILDER = join(HERE, "fixtures", "stub-builder.mjs");
const ok = (b) => { assert.deepEqual(checkBuild({ build: b }, STAGE_IDS), []); assert.deepEqual(checkBuildApi({ build: b }, STAGE_IDS, b.id), [], "the lifecycle API 0.5.0 check, send_back among it"); };
const leftOut = { version: "0.1", organization: { used: { review: false, docs: false, security: false } } };

/** An adlc checkout for the test: the fake reference agents, and the stand-in plugin kit. */
async function adlcWithKit() {
  const at = await tempDir("adlc");
  cpSync(FAKE_ADLC, at, { recursive: true });
  cpSync(join(HERE, "fixtures", "fake-kit"), join(at, "plugin", "kit"), { recursive: true });
  return at;
}

const lockOf = (f, id) => JSON.parse(readFileSync(join(f.store.folder(id), "build", "build.lock.json"), "utf8"));
const calls = (f) => (existsSync(f.stubLog) ? readFileSync(f.stubLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.builder) : []);

test("one builder takes the approved spec through the code, each stage passed by the build folder's own check, and asks you what only you can answer", async (t) => {
  const adlc = await adlcWithKit();
  const f = await factory({ doc: leftOut, holder: "builder", harness: ["node", STUB_BUILDER, "{prompt}", "{plugin}"], adlc });
  t.after(f.close);

  const started = await f.post("/builds", { does: "Count the words in a passage.", refuses: "Changing the passage.", name: "word-counter" });
  assert.equal(started.status, 201);
  const id = started.json.build.id;
  let b = await f.settled(id);
  ok(b);
  // The reference make-a-new-agent v2 as published, its blanks filled.
  const doc = readFileSync(join(f.store.folder(id), "run", "document.txt"), "utf8");
  assert.match(doc, /^PROCESS: make a new agent +id: product-factory\/make-a-new-agent +v2$/m);
  assert.match(doc, /^ +owner: builder$/m);
  assert.doesNotMatch(doc, /design-the-agent|gather-the-features|write-the-architecture/);
  assert.equal(stageOf(b, "requirements").state, "waiting_on_you");
  for (const s of ["architecture", "test", "code"]) assert.match(stageOf(b, s).holder.name, /^one builder: your coding harness \(node\) with the ADLC plugin$/);

  // Your approval, pressed in the console: the build folder is laid out and the approval pinned there by Product Factory.
  assert.equal((await f.post(`/builds/${id}/actions/approve`)).status, 200);
  b = await f.settled(id);
  ok(b);
  const folder = join(f.store.folder(id), "build");
  assert.ok(existsSync(join(folder, ".adlc", "check.mjs")));
  assert.equal(lockOf(f, id).gates.requirements.by, "the person");
  assert.ok(JSON.parse(readFileSync(join(folder, "spec.json"), "utf8")).format, "the spec you approved is in the folder");
  // The builder ran in the folder with the plugin of the pinned checkout, and the check asked what only you can answer.
  const c = calls(f);
  assert.equal(c.length, 1);
  assert.equal(c[0].plugin, join(adlc, "plugin"));
  assert.match(c[0].prompt, /Follow AGENTS\.md in this folder/);
  assert.equal(b.summary, "Waiting on you at Architecture and Design");
  assert.equal(stageOf(b, "architecture").state, "waiting_on_you");
  assert.match(stageOf(b, "architecture").handed_back.words[0], /^Only you can answer: egress-1: May this agent reach the public Hacker News API\?/);
  assert.deepEqual(actionNames(b), ["changes", "send_back", "stop"]);
  const back = b.actions.find((a) => a.name === "send_back");
  assert.deepEqual(back.needs.find((n) => n.name === "to").options, ["requirements"]);

  // Your answer goes into the folder, and the builder goes on: every stage passes, and the package is made from what it handed on.
  assert.equal((await f.post(`/builds/${id}/actions/changes`, { changes: "egress-1: yes" })).status, 200);
  b = await f.settled(id);
  ok(b);
  assert.equal(JSON.parse(readFileSync(join(folder, "answers.json"), "utf8"))["egress-1"], "yes");
  assert.deepEqual(Object.keys(lockOf(f, id).gates), ["requirements", "architecture", "files", "test", "code"]);
  for (const s of ["architecture", "test", "code"]) assert.equal(stageOf(b, s).state, "done", s);
  const handed = stageOf(b, "code").handed_back.files.map((x) => x.path);
  assert.ok(handed.includes("scripts/count.mjs"));
  assert.ok(handed.includes("agent-descriptor.json"));
  assert.equal(stageOf(b, "package").state, "done");
});

test("a build one builder holds is sent back to an earlier stage of its folder with your words, and the builder goes on from there", async (t) => {
  const adlc = await adlcWithKit();
  const f = await factory({ doc: leftOut, holder: "builder", rounds: 1, harness: ["node", STUB_BUILDER, "{prompt}", "{plugin}"], adlc, extraEnv: { PF_STUB_SKIP_TEST: "1" } });
  t.after(f.close);
  const id = (await f.post("/builds", { does: "Count the words in a passage.", name: "word-counter" })).json.build.id;
  await f.settled(id);
  await f.post(`/builds/${id}/actions/approve`);
  await f.settled(id);
  await f.post(`/builds/${id}/actions/changes`, { changes: "egress-1: yes" });
  let b = await f.settled(id);
  ok(b);
  // The suite never comes, so Test is refused in the check's own words once the rounds are used up.
  assert.match(b.summary, /Test/);
  assert.equal(stageOf(b, "test").state, "refused");
  assert.match(stageOf(b, "test").handed_back.words[0], /^The build folder's check still holds test after/);
  assert.deepEqual(actionNames(b), ["resume", "send_back", "stop"]);
  assert.deepEqual(b.actions.find((a) => a.name === "send_back").needs.find((n) => n.name === "to").options, ["requirements", "architecture"]);

  // Words are needed, and only an earlier stage may be chosen.
  assert.equal((await f.post(`/builds/${id}/actions/send_back`, { to: "architecture" })).status, 400);
  assert.equal((await f.post(`/builds/${id}/actions/send_back`, { to: "code", changes: "x" })).status, 400);
  const sent = await f.post(`/builds/${id}/actions/send_back`, { to: "architecture", changes: "Name the counting rule in the record." });
  assert.equal(sent.status, 200);
  b = await f.settled(id);
  ok(b);
  // The folder reopened Architecture and every stage after it, and the builder passed them again up to Test.
  assert.equal(calls(f).length, 3, "one more round after the send back");
  assert.deepEqual(Object.keys(lockOf(f, id).gates), ["requirements", "architecture", "files"]);
  assert.equal(stageOf(b, "architecture").state, "done");
  assert.ok(f.store.read(id).stages.test.log.some((l) => /^You sent the build back to Architecture and Design: “Name the counting rule in the record\.”$/.test(l.said)), "the send back is on the record with your words");
});
