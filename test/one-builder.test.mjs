// A build that one builder holds (code.holder "builder", make-a-new-agent-one-builder.txt,
// the reference make-a-new-agent v3 with its blanks filled): the build folder is laid out
// with the ADLC plugin's kit, your approval of the spec is pressed there by Product Factory,
// each stage is decided by the folder's own check, what only you can answer waits for you,
// and the build can be sent back to any earlier stage. Stand-ins throughout: the fake spec
// writer, a stand-in kit (fixtures/fake-kit) and a stand-in builder (fixtures/stub-builder.mjs).

import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { checkBuild as readTheCheck } from "../lib/builder.mjs";
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
  // The reference make-a-new-agent v3 as published, its blanks filled: the build in any order, judged together.
  const doc = readFileSync(join(f.store.folder(id), "run", "document.txt"), "utf8");
  assert.match(doc, /^PROCESS: make a new agent +id: product-factory\/make-a-new-agent +v3$/m);
  assert.match(doc, /build-the-agent +- harness: from the approved spec, in any order,/);
  assert.match(doc, /^ +owner: builder$/m);
  assert.doesNotMatch(doc, /design-the-agent|gather-the-features|write-the-architecture/);
  assert.equal(stageOf(b, "requirements").state, "waiting_on_you");
  // One author: the builder holds Requirements too, and wrote the spec in the folder; no reference spec writer ran.
  for (const s of ["requirements", "architecture", "test", "code"]) assert.match(stageOf(b, s).holder.name, /^one builder: your coding harness \(node\) with the ADLC plugin$/, s);
  assert.match(stageOf(b, "requirements").handed_back.words[0], /^The builder's spec is ready for your approval/);
  assert.match(calls(f)[0].prompt, /from its first phase, the spec: write spec\.json from the person's words in request\.md/);

  // Your approval, pressed in the console: the build folder is laid out and the approval pinned there by Product Factory.
  assert.equal((await f.post(`/builds/${id}/actions/approve`)).status, 200);
  b = await f.settled(id);
  ok(b);
  const folder = join(f.store.folder(id), "build");
  assert.ok(existsSync(join(folder, ".adlc", "check.mjs")));
  assert.equal(lockOf(f, id).gates.spec.by, "the person");
  assert.ok(JSON.parse(readFileSync(join(folder, "spec.json"), "utf8")).format, "the spec you approved is in the folder");
  // The builder ran in the folder with the plugin of the pinned checkout, and the check asked what only you can answer.
  const c = calls(f);
  assert.equal(c.length, 1);
  assert.equal(c[0].plugin, join(adlc, "plugin"));
  assert.equal(c[0].not_the_person, "1", "the plugin is told the prompts are Product Factory's, not yours");
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
  // Your answer goes in with your words, and your reply into said.md, where the folder's check finds them.
  assert.deepEqual(JSON.parse(readFileSync(join(folder, "answers.json"), "utf8"))["egress-1"], { answer: "yes", said: "yes" });
  assert.match(readFileSync(join(folder, "said.md"), "utf8"), /^## \d{4}-\d{2}-\d{2}T[\d:.]+Z\n\negress-1: yes\n/m);
  assert.deepEqual(Object.keys(lockOf(f, id).gates), ["spec", "build"]);
  for (const s of ["architecture", "test", "code"]) assert.equal(stageOf(b, s).state, "done", s);
  const handed = stageOf(b, "code").handed_back.files.map((x) => x.path);
  assert.ok(handed.includes("code/scripts/count.mjs"));
  assert.ok(handed.includes("code/agent-descriptor.json"));
  // Each file is shown at the stage whose gates passed it, so the console's tabs find them as they find a separate holder's.
  assert.deepEqual(stageOf(b, "architecture").handed_back.files.map((x) => x.path).sort(), ["architecture/architecture-record.md", "design/agent-descriptor.json", "design/agent-runtime-requirements.json", "design/plugin.json", "design/skills/count/SKILL.md"]);
  assert.deepEqual(stageOf(b, "test").handed_back.files.map((x) => x.path), ["test/f1.test.mjs"]);
  const made = Object.fromEntries(b.artifacts.map((x) => [x.id, x.state]));
  for (const k of ["spec", "statement", "architecture", "suite", "programs", "package"]) assert.equal(made[k], "made", `the console's ${k} tab`);
  assert.equal(stageOf(b, "package").state, "done");
});

test("changes asked for at Requirements go into request.md under a dated heading, and the builder revises the spec before you approve it", async (t) => {
  const adlc = await adlcWithKit();
  const f = await factory({ doc: leftOut, holder: "builder", harness: ["node", STUB_BUILDER, "{prompt}", "{plugin}"], adlc });
  t.after(f.close);
  const id = (await f.post("/builds", { does: "Count the words in a passage.", name: "word-counter" })).json.build.id;
  let b = await f.settled(id);
  assert.equal(stageOf(b, "requirements").state, "waiting_on_you");
  const folder = join(f.store.folder(id), "build");
  assert.match(JSON.parse(readFileSync(join(folder, "spec.json"), "utf8")).purpose, /for anyone who sends one/);
  assert.equal((await f.post(`/builds/${id}/actions/changes`, { changes: "Say what happens when the passage is empty." })).status, 200);
  b = await f.settled(id);
  ok(b);
  const request = readFileSync(join(folder, "request.md"), "utf8");
  assert.match(request, /Count the words in a passage\./);
  assert.match(request, /^## The person asked for changes \(\d{4}-\d{2}-\d{2}\)\n\nSay what happens when the passage is empty\.$/m);
  assert.equal(stageOf(b, "requirements").state, "waiting_on_you");
  assert.match(JSON.parse(readFileSync(join(folder, "spec.json"), "utf8")).purpose, /revised as asked/);
  assert.equal(lockOf(f, id).gates.spec, undefined, "nothing is approved until you approve it");
  assert.equal(calls(f).length, 2);
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
  assert.deepEqual(Object.keys(lockOf(f, id).gates), ["spec"], "the build is open again, and the spec stays approved");
  assert.equal(stageOf(b, "architecture").state, "done");
  assert.ok(f.store.read(id).stages.test.log.some((l) => /^You sent the build back to Architecture and Design: “Name the counting rule in the record\.”$/.test(l.said)), "the send back is on the record with your words");
});

test("a build folder still on the kit from before the two phases is never read as passed", async () => {
  const folder = join(await tempDir("old-kit"), "build");
  mkdirSync(join(folder, ".adlc"), { recursive: true });
  // The old check's answer when one stage passed: code 0 and passed, with the stage it was at.
  writeFileSync(join(folder, ".adlc", "check.mjs"), "console.log(JSON.stringify({ stages: [\"requirements\", \"architecture\", \"files\", \"test\", \"code\"], code: 0, stage: \"architecture\", passed: true, problems: [], next: \"files\" }));\n");
  const c = await readTheCheck(folder);
  assert.equal(c.done, false);
  assert.equal(c.old_kit, true);
  assert.equal(c.stage, null);
  assert.match(c.problems[0], /^This build folder carries the ADLC plugin's kit from before its two phases/);
});

// Review and Security review used: the code critic and the security reviewer read the build folder once its check passes the build.
const withReviews = { version: "0.1", organization: { used: { docs: false } } };

test("with Review and Security review used, the reviewers read the build folder once its check passes, and a pass goes on to Package", async (t) => {
  const adlc = await adlcWithKit();
  const f = await factory({ doc: withReviews, holder: "builder", harness: ["node", STUB_BUILDER, "{prompt}", "{plugin}"], adlc });
  t.after(f.close);
  const id = (await f.post("/builds", { does: "Count the words in a passage.", name: "word-counter" })).json.build.id;
  await f.settled(id);
  await f.post(`/builds/${id}/actions/approve`);
  await f.settled(id);
  await f.post(`/builds/${id}/actions/changes`, { changes: "egress-1: yes" });
  const b = await f.settled(id);
  ok(b);
  const gate = f.store.read(id).work.builder.gate;
  assert.equal(gate.runs.length, 1);
  assert.equal(gate.runs[0].passed, true);
  assert.deepEqual(Object.keys(gate.runs[0].reviews).sort(), ["critic", "security"]);
  assert.equal(gate.passed, gate.runs[0].sha);
  assert.equal(stageOf(b, "review").state, "done");
  assert.equal(stageOf(b, "security").state, "done");
  assert.match(stageOf(b, "security").given, /^Read in the build folder, once its check passed the build, at [0-9a-f]{7}/);
  const made = Object.fromEntries(b.artifacts.map((x) => [x.id, x.state]));
  assert.equal(made.findings, "made", "the code critic's findings");
  assert.equal(made.security, "made", "the security reviewer's record");
  assert.equal(stageOf(b, "package").state, "done");
});

test("a security refusal holds the build for the person, with the reviewer's words, and a send back opens it for the builder", async (t) => {
  const adlc = await adlcWithKit();
  const f = await factory({ doc: withReviews, holder: "builder", harness: ["node", STUB_BUILDER, "{prompt}", "{plugin}"], adlc, extraEnv: { PF_STUB_MARK: "TODO-SECURITY" } });
  t.after(f.close);
  const id = (await f.post("/builds", { does: "Count the words in a passage.", name: "word-counter" })).json.build.id;
  await f.settled(id);
  await f.post(`/builds/${id}/actions/approve`);
  await f.settled(id);
  await f.post(`/builds/${id}/actions/changes`, { changes: "egress-1: yes" });
  let b = await f.settled(id);
  ok(b);
  assert.equal(stageOf(b, "security").state, "refused");
  assert.equal(stageOf(b, "review").state, "done", "the code critic left nothing open");
  assert.equal(stageOf(b, "package").state, "not_started", "nothing refused is packed");
  assert.equal(stageOf(b, "code").state, "refused");
  const words = stageOf(b, "code").handed_back.words.join(" ");
  assert.match(words, /The security reviewer refused it\./);
  assert.match(words, /send it back to the start of the build/);
  assert.deepEqual(actionNames(b), ["resume", "send_back", "stop"]);
  // You send it back to the start of the build: the build folder opens, and the builder goes on from your words.
  assert.equal((await f.post(`/builds/${id}/actions/send_back`, { to: "architecture", changes: "Take out the marked line the security reviewer refused." })).status, 200);
  b = await f.settled(id);
  ok(b);
  // The build opened again, its check passed it again (the stand-in kit holds nothing back), and the reviewers read it again: the marker is still there, so they refuse again.
  const runs = f.store.read(id).work.builder.gate.runs;
  assert.equal(runs.length, 2);
  assert.equal(runs[1].passed, false);
  assert.equal(stageOf(b, "security").state, "refused");
});

test("the builder's spec puts its features in the product's register as proposed, as the spec writer's does", async (t) => {
  const adlc = await adlcWithKit();
  const f = await factory({ doc: leftOut, holder: "builder", harness: ["node", STUB_BUILDER, "{prompt}", "{plugin}"], adlc });
  t.after(f.close);
  const id = (await f.post("/builds", { does: "Count the words in a passage.", name: "word-counter" })).json.build.id;
  await f.settled(id);
  const kept = f.store.read(id);
  assert.deepEqual((kept.feature_log ?? []).map((e) => e.feature), ["F1"], "the spec's one feature is proposed");
  const matrix = await f.get(`/builds/${id}/features`);
  assert.equal(matrix.status, 200);
  assert.ok(JSON.stringify(matrix.json).includes("F1"), "the features matrix shows it");
});
