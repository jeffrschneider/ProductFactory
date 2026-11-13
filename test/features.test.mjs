// Features (lifecycle API 0.4.3), over HTTP, with stand-in holders and a
// stand-in for the shared model caller: a line "feature: <name> - <does>" in
// what the person says makes the stand-in propose that feature
// (fixtures/fake-adlc/agents/spec-writer/scripts/model-caller.mjs), and the
// stand-in test writer names one test per approved feature "[F1] ...". No test
// reaches a model or the network.
//
// The product is built on the reference writers (a rebuild from an as-built
// record with no behaviors in it), so its Requirements chat is the reference
// spec writer's: one builder makes new agents, and is talked to where it runs.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { factory, tempDir, startRebuild, asBuiltRecord } from "./helpers.mjs";
import { createKeys, KEYS_FILE } from "../lib/people.mjs";
import { checkBuild, checkFeatures, checkFeature, checkFeatureDecision, checkMessages, checkMessageReply, checkStageWorkspace, checkBossMessages } from "../standards/lifecycle-api-check.mjs";
import { STAGE_IDS } from "../lib/standards.mjs";
import { byFeature, materialLines, registerOf } from "../lib/features.mjs";
import { phaseMaterial, parse, RECORD_FILE } from "../lib/orchestrator.mjs";

const SINK = join(import.meta.dirname, "fixtures", "bin", "notice-sink.mjs");

/** A product "counter", its first build waiting for the spec's approval. */
async function counter(t, opts = {}) {
  const f = await factory({ rounds: 1, ...opts });
  t.after(f.close);
  const id = await startRebuild(f, { does: "Count the words in a passage.", name: "counter" });
  await f.settled(id);
  return { f, id };
}
const say = (f, stage, text, call = f.call, extra = {}) => call("POST", `/products/counter/stages/${stage}/messages`, { text, ...extra });
const decide = (f, id, feature, decision, body, call = f.call) => call("POST", `/builds/${id}/features/${feature}/${decision}`, body);
// What Requirements hands back: the spec (lifecycle API 0.4.8).
const statementOf = async (f, id) => (await f.get(`/builds/${id}`)).json.build.artifacts.find((a) => a.id === "spec");
const matrix = async (f, id) => { const got = await f.get(`/builds/${id}/features`); assert.equal(got.status, 200); assert.deepEqual(checkFeatures(got.json, id), []); return got.json; };
const rowOf = (m, id) => m.features.find((x) => x.id === id);

/** Says a feature in the Requirements chat and approves it there. */
async function approved(f, id, line) {
  const r = await say(f, "requirements", line);
  const p = r.json.reply.features[0];
  const got = await decide(f, id, p.feature, "approve", { proposal: p.proposal, message: r.json.reply.id });
  assert.equal(got.status, 200, JSON.stringify(got.json));
  return { p, reply: r.json.reply, got: got.json };
}

test("a chat proposes a feature, and Approve feature records the decision and gives the spec a new version", async (t) => {
  const { f, id } = await counter(t);
  assert.equal((await statementOf(f, id)).version, "v1");
  assert.deepEqual((await statementOf(f, id)).summary.features, [], "the spec this stand-in wrote has no features until one is settled");

  const r = await say(f, "requirements", "Add a feature: Count words - Counts the words in a passage.");
  assert.equal(r.status, 200);
  assert.deepEqual(checkMessageReply(r.json, (await f.get(`/builds/${id}`)).json), []);
  const p = r.json.reply.features[0];
  assert.deepEqual({ ...p, proposal: "x" }, { proposal: "x", feature: "F1", name: "Count words", does: "Counts the words in a passage.", offering: "Count", change: "new", state: "open", you_may_approve: true, approvers: [] });

  const got = await decide(f, id, "F1", "approve", { proposal: p.proposal, message: r.json.reply.id });
  assert.equal(got.status, 200);
  assert.deepEqual(checkFeatureDecision(got.json, "approve"), []);
  assert.equal(got.json.statement, "v2", "the spec gets a new version with the feature");
  assert.equal(got.json.feature.state, "approved");
  assert.equal(got.json.proposal.answered.by, "Test Person");

  // The decision is recorded: who, when, linked to the message.
  const e = f.store.read(id).feature_log.find((x) => x.kind === "approved");
  assert.deepEqual({ ...e, id: "x", at: "x", proposal: "x" }, { id: "x", at: "x", kind: "approved", via: "chat", feature: "F1", proposal: "x", by: "Test Person", email: "person@example.com", message: r.json.reply.id, stage: "requirements", statement: "v2" });
  const s = await statementOf(f, id);
  assert.equal(s.version, "v2");
  // The feature list is the product's register; the agent's own files carry none once there is a spec.
  assert.equal((await f.get(`/builds/${id}`)).json.build.artifacts.find((a) => a.id === "statement").summary.features, undefined);

  // The chat now shows it approved, and it cannot be approved twice.
  const chat = (await f.get("/products/counter/stages/requirements/messages")).json;
  assert.deepEqual(checkMessages(chat, "requirements"), []);
  assert.equal(chat.messages.at(-1).features[0].state, "approved");
  assert.equal((await decide(f, id, "F1", "approve", { proposal: p.proposal })).status, 400);
  assert.equal((await decide(f, id, "F1", "approve", {})).status, 400, "a decision names its proposal");
  assert.equal((await decide(f, id, "F1", "maybe", { proposal: p.proposal })).status, 404);

  // A change to F1 is proposed as changed, with what it was.
  const c = await say(f, "requirements", "Change feature F1: Count words - Counts the words in a passage, and says how many lines.");
  assert.deepEqual({ change: c.json.reply.features[0].change, was: c.json.reply.features[0].was.does, feature: c.json.reply.features[0].feature }, { change: "changed", was: "Counts the words in a passage.", feature: "F1" });
  // Saying the feature as it is approved proposes nothing.
  const again = await say(f, "requirements", "Add a feature: Count words - Counts the words in a passage.");
  assert.equal(again.json.reply.features, undefined, "nothing new to approve");
});

test("Not now keeps a feature proposed, as a backlog item linked to the conversation", async (t) => {
  const { f, id } = await counter(t);
  const r = await say(f, "requirements", "Add a feature: Lines - Says how many lines the passage has.");
  const p = r.json.reply.features[0];
  const got = await decide(f, id, p.feature, "not_now", { proposal: p.proposal, message: r.json.reply.id });
  assert.equal(got.status, 200);
  assert.deepEqual(checkFeatureDecision(got.json, "not_now"), []);
  assert.deepEqual({ state: got.json.feature.state, backlog: got.json.feature.backlog, pending: got.json.feature.pending.state }, { state: "proposed", backlog: true, pending: "not_now" });
  const m = await matrix(f, id);
  assert.deepEqual({ backlog: rowOf(m, "F1").backlog, spec: rowOf(m, "F1").cells.spec }, { backlog: true, spec: { state: "missing", words: "In the backlog, not approved", link: { build: id, stage: "requirements", artifact: "spec", feature: "F1" } } });
  const h = (await f.get("/products/counter/features/F1")).json;
  assert.deepEqual(h.history.map((x) => x.kind), ["proposed", "not_now"]);
  assert.deepEqual(h.history[1].link, { kind: "message", stage: "requirements", message: r.json.reply.id });
  assert.equal((await decide(f, id, p.feature, "not_now", { proposal: p.proposal })).status, 400, "already left for later");
  // It can still be approved later.
  assert.equal((await decide(f, id, p.feature, "approve", { proposal: p.proposal })).status, 200);
});

test("teams: a person who may not answer Requirements asks the approver, who is told and sees the same button", async (t) => {
  const out = join(await tempDir("asks"), "notices.jsonl");
  const doc = { version: "0.1", organization: { approvers: { requirements: [{ person: "ana@example.com" }] } } };
  const people = { organization: "Example Org", people: [{ name: "Ana Lee", email: "ana@example.com", role: "approver" }, { name: "Max Member", email: "max@example.com", role: "member" }] };
  const { f, id } = await counter(t, { doc, people, notify: [{ kind: "command", command: ["node", SINK, out] }] });
  const keys = createKeys(join(f.config.data, KEYS_FILE));
  const as = (key) => (method, path, body) => f.call(method, path, body, { auth: key });
  const ana = as(keys.make("ana@example.com"));
  const max = as(keys.make("max@example.com"));

  const r = await say(f, "requirements", "Add a feature: Lines - Says how many lines the passage has.", max);
  const p = r.json.reply.features[0];
  assert.deepEqual({ may: p.you_may_approve, approvers: p.approvers }, { may: false, approvers: ["Ana Lee (ana@example.com)"] });
  const no = await decide(f, id, "F1", "approve", { proposal: p.proposal }, max);
  assert.equal(no.status, 403);
  assert.match(no.json.error, /Only Ana Lee \(ana@example\.com\) may answer the Requirements gate\. So only they may approve a feature\. Ask them instead/);

  const asked = await decide(f, id, "F1", "ask", { proposal: p.proposal, message: r.json.reply.id }, max);
  assert.equal(asked.status, 200);
  assert.deepEqual(checkFeatureDecision(asked.json, "ask"), []);
  assert.deepEqual(asked.json.told, ["Ana Lee (ana@example.com)"]);
  await f.notices.idle();
  const told = readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((x) => x.event === "feature_approval");
  assert.equal(told.length, 1);
  assert.deepEqual({ feature: told[0].feature, gate: told[0].gate, waiting_on: told[0].waiting_on }, { feature: "F1", gate: "Approve feature F1", waiting_on: "Ana Lee (ana@example.com)" });
  assert.match(told[0].text, /^Max Member asks Ana Lee \(ana@example\.com\) to approve feature F1 of counter \(b_[0-9a-f]+\): Lines\. Says how many lines the passage has\. It is on the message in the Requirements chat, with its Approve feature button\./);
  assert.ok(f.store.read(id).notices.some((k) => k.startsWith("ask:")), "told once, keyed in notices");

  // The approver sees the same proposal, asked, with the button that is theirs.
  const seen = (await ana("GET", "/products/counter/stages/requirements/messages")).json.messages.at(-1).features[0];
  assert.deepEqual({ state: seen.state, may: seen.you_may_approve, asked: seen.asked.by }, { state: "asked", may: true, asked: "Max Member" });
  assert.equal((await decide(f, id, "F1", "ask", { proposal: p.proposal }, ana)).status, 400, "an approver approves it herself");
  const yes = await decide(f, id, "F1", "approve", { proposal: p.proposal, message: r.json.reply.id }, ana);
  assert.equal(yes.status, 200);
  assert.equal(yes.json.proposal.answered.by, "Ana Lee");
});

test("approved features reach the spec writer and the test writer as lines aimed at their phases; tests name them, and the gate reports per feature", async (t) => {
  const { f, id } = await counter(t);
  await approved(f, id, "Add a feature: Count words - Counts the words in a passage.");
  await approved(f, id, "Add a feature: Fails on purpose - A case no script passes.");

  // Lines aimed at a phase go to that phase alone: the spec writer's, and the test writer's.
  const doc = parse(readFileSync(RECORD_FILE, "utf8"));
  const lines = materialLines([...registerOf(f.store.read(id).feature_log.map((e) => ({ ...e, build: id, version: "0.1.0" }))).values()]);
  assert.match(phaseMaterial(lines, doc, "write-the-spec"), /^features: the owner approved these; keep each one in the spec/);
  assert.doesNotMatch(phaseMaterial(lines, doc, "write-the-spec"), /square brackets/);
  assert.match(phaseMaterial(lines, doc, "write-the-suite"), /starting with the feature's id in square brackets/);
  assert.doesNotMatch(phaseMaterial(lines, doc, "write-the-suite"), /keep each one in the spec/);

  // Ask for changes: the spec writer's revision carries the features.
  await f.post(`/builds/${id}/actions/changes`, { changes: "Say what it refuses." });
  await f.settled(id);
  const specText = readFileSync(join(f.store.folder(id), "stages", "requirements", "r2", "job", "message.txt"), "utf8");
  assert.match(specText, /^changes: Say what it refuses\.\n\nfeatures: the owner approved these; keep each one in the spec, by its id and in its offering:\n- F1 \(offering Count\): Count words\. Counts the words in a passage\.\n- F2 /);
  assert.doesNotMatch(specText, /\[write-the-/);

  // The gate: the test writer is asked for the approved features' tests, Code runs them, and the round says each feature's results.
  await f.post(`/builds/${id}/actions/approve`);
  const b = await f.settled(id);
  const testText = readFileSync(join(f.store.folder(id), "stages", "test", "jobs", "r1", "message.txt"), "utf8");
  assert.match(testText, /features: the owner approved these:\n- F1 [^\n]*\n- F2 /);
  // With a spec (stages.json 1.6.0) a test is named by its acceptance scenario, and a feature the spec has no scenario for by its own id.
  assert.match(testText, /Name each test that checks one of the spec's acceptance scenarios starting with the scenario's id in square brackets, such as "\[F1\.A1\] \.\.\.", and each test of a kept interface with the interface's id, such as "\[I1\] \.\.\."\. A test of one of these features that has no scenario in the spec starts with the feature's id, such as "\[F1\] count words"\./);
  // The revised spec kept both features with a scenario each, so each test is named by its scenario and counts for its feature;
  // the kept interface's test checks no feature.
  assert.deepEqual(b.artifacts.find((a) => a.id === "suite").summary.tests, ["counts the words in a passage", "[F1.A1] count words", "[F2.A1] fails on purpose", "[I1] count is exported, as the spec keeps it"]);
  const [round] = b.stages.find((s) => s.stage === "code").rounds;
  assert.deepEqual(round.by_feature, [{ feature: "F1", passed: 1, total: 1 }, { feature: "F2", passed: 0, total: 1 }]);
  assert.match(round.words, /By feature: F1 1 of 1 pass/);
  assert.deepEqual(checkBuild((await f.get(`/builds/${id}`)).json, STAGE_IDS, id), []);

  const m = await matrix(f, id);
  assert.deepEqual(rowOf(m, "F1").cells.tests, { state: "done", words: "Tests 1/1", tests: { passed: 1, total: 1 }, link: { build: id, stage: "test", artifact: "suite", feature: "F1" } });
  assert.deepEqual({ state: rowOf(m, "F1").cells.code.state, words: rowOf(m, "F1").cells.code.words }, { state: "done", words: "Passes 1/1" });
  assert.deepEqual({ state: rowOf(m, "F2").cells.tests.state, words: rowOf(m, "F2").cells.tests.words }, { state: "failing", words: "Tests 0/1" });
  assert.deepEqual({ state: rowOf(m, "F2").cells.code.state, words: rowOf(m, "F2").cells.code.words }, { state: "failing", words: "Passes 0/1" });
  assert.equal(rowOf(m, "F1").cells.review.state, "missing", "the code critic is not asked on this computer");
  assert.equal(rowOf(m, "F1").cells.docs.state, "missing");

  assert.deepEqual(byFeature(["[F1] a", "[F1, F2] b", "c"], ["[F1, F2] b"]), [{ feature: "F1", passed: 1, total: 2 }, { feature: "F2", passed: 0, total: 1 }]);
});

test("the matrix: done, stale and missing cells, and new, changed or unchanged badges against the version before", async (t) => {
  const { f, id } = await counter(t, { rounds: 2 });
  const one = await approved(f, id, "Add a feature: Count words - Counts the words in a passage.");
  await approved(f, id, "Add a feature: Lines - Says how many lines there are.");
  await f.post(`/builds/${id}/actions/approve`);
  await f.settled(id);
  let m = await matrix(f, id);
  assert.deepEqual(Object.fromEntries(Object.entries(rowOf(m, "F1").cells).map(([k, v]) => [k, v.state])), { spec: "done", tests: "done", code: "done", review: "missing", docs: "missing" });
  assert.deepEqual(m.features.map((x) => x.badge), ["new", "new"], "the first version: every feature is new");
  assert.deepEqual(m.versions, [{ version: "0.1.0", build: id }]);

  // F1 changes after its tests and code were made: both are stale. F3 is approved after the suite: no test names it.
  const c = await say(f, "requirements", "Change feature F1: Count words - Counts the words, ignoring punctuation.");
  await decide(f, id, "F1", "approve", { proposal: c.json.reply.features[0].proposal });
  await approved(f, id, "Add a feature: Bytes - Says how many bytes.");
  m = await matrix(f, id);
  assert.deepEqual({ tests: rowOf(m, "F1").cells.tests.state, code: rowOf(m, "F1").cells.code.state }, { tests: "stale", code: "stale" });
  assert.match(rowOf(m, "F1").cells.tests.words, /written before F1 changed$/);
  assert.deepEqual({ tests: rowOf(m, "F3").cells.tests, code: rowOf(m, "F3").cells.code.state }, { tests: { state: "missing", words: "No test names F3", link: { build: id, stage: "test", artifact: "suite", feature: "F3" } }, code: "missing" });
  assert.ok(one.p.proposal);

  // The next version: F2 changes, F4 is new, F1 and F3 are unchanged.
  await f.post(`/builds/${id}/actions/accept`);
  await f.settled(id);
  const next = (await f.runner.start({ does: "Count the words in a passage.", name: "counter", starting_point: "as-built-record", source: { folder: await asBuiltRecord() } }, undefined, { version: "0.2.0" })).id;
  await f.settled(next);
  const c2 = await say(f, "requirements", "Change feature F2: Lines - Says how many lines and paragraphs there are.", f.call, { build: next });
  await decide(f, next, "F2", "approve", { proposal: c2.json.reply.features[0].proposal });
  const r4 = await say(f, "requirements", "Add a feature: Words per line - Says the words on each line.", f.call, { build: next });
  await decide(f, next, "F4", "approve", { proposal: r4.json.reply.features[0].proposal });
  const m2 = await matrix(f, next);
  assert.deepEqual(m2.features.map((x) => [x.id, x.badge]), [["F1", "unchanged"], ["F2", "changed"], ["F3", "unchanged"], ["F4", "new"]]);
  assert.deepEqual(m2.versions.map((v) => v.version), ["0.2.0", "0.1.0"]);
  // The product's matrix answers the newest version, or the version asked for.
  const p = (await f.get("/products/counter/features")).json;
  assert.deepEqual(checkFeatures(p), []);
  assert.equal(p.version, "0.2.0");
  const old = (await f.get("/products/counter/features?version=0.1.0")).json;
  assert.deepEqual(old.features.map((x) => x.id), ["F1", "F2", "F3"], "a later version never changes an earlier one's features");
  assert.equal((await f.get("/products/counter/features?version=9.9.9")).status, 404);
});

test("a feature's history: proposed in chat, approved, tests added, code changed, each linked to its message or artifact", async (t) => {
  const { f, id } = await counter(t);
  const { reply } = await approved(f, id, "Add a feature: Count words - Counts the words in a passage.");
  await f.post(`/builds/${id}/actions/approve`);
  await f.settled(id);
  const got = await f.get("/products/counter/features/F1");
  assert.equal(got.status, 200);
  assert.deepEqual(checkFeature(got.json, "F1"), []);
  assert.deepEqual(got.json.history.map((x) => x.kind), ["proposed", "approved", "tests", "code"]);
  assert.deepEqual(got.json.history[0].link, { kind: "message", stage: "requirements", message: reply.id });
  assert.match(got.json.history[0].words, /^Spec writer proposed F1: Count words\. Counts the words in a passage\. \(offering Count\)$/);
  assert.match(got.json.history[1].words, /^Approved in the chat\. The spec is v2 with it\.$/);
  assert.deepEqual(got.json.history[2].link, { kind: "artifact", artifact: "suite", feature: "F1" });
  assert.match(got.json.history[3].words, /^The code passes 1 of 1 tests for F1 \(Round 1\)\.$/);
  assert.equal((await f.get("/products/counter/features/F99")).status, 404);
});

test("the Requirements gate shrinks to what is still open and the features it starts building with; features approved in chat are not asked again", async (t) => {
  const { f, id } = await counter(t);
  // Without features the gate is as it was.
  assert.equal((await f.get(`/builds/${id}/stages/requirements`)).json.gate.features, undefined);
  await approved(f, id, "Add a feature: Count words - Counts the words in a passage.");
  await say(f, "requirements", "Add a feature: Lines - Says how many lines there are.");
  const later = await say(f, "requirements", "Add a feature: Bytes - Says how many bytes.");
  await decide(f, id, "F3", "not_now", { proposal: later.json.reply.features[0].proposal });

  const ws = (await f.get(`/builds/${id}/stages/requirements`)).json;
  assert.deepEqual(checkStageWorkspace(ws, STAGE_IDS, "requirements", (await f.get(`/builds/${id}`)).json), []);
  const ids = (k) => ws.gate.features[k].map((x) => x.id);
  assert.deepEqual({ approved: ids("approved"), to_approve: ids("to_approve"), backlog: ids("backlog") }, { approved: ["F1"], to_approve: ["F2"], backlog: ["F3"] });
  assert.ok(Array.isArray(ws.gate.open), "what the statement still leaves open");
  assert.deepEqual(ws.gate.actions, ["approve", "changes", "stop"]);

  // Starting to build approves what was waiting, as the gate's decision; the backlog stays proposed.
  await f.post(`/builds/${id}/actions/approve`);
  await f.settled(id);
  const m = await matrix(f, id);
  assert.deepEqual(m.features.map((x) => [x.id, x.state, x.backlog]), [["F1", "approved", false], ["F2", "approved", false], ["F3", "proposed", true]]);
  const gateApproval = f.store.read(id).feature_log.filter((e) => e.kind === "approved" && e.via === "gate");
  assert.deepEqual(gateApproval.map((e) => e.feature), ["F2"], "F1 was approved in chat and is not approved again");
  assert.match((await f.get("/products/counter/features/F2")).json.history.find((x) => x.kind === "approved").words, /^Approved with the spec at the Requirements gate\.$/);
});

test("the boss proposes a feature on its reply too, and never approves it", async (t) => {
  const { f, id } = await counter(t);
  const r = await f.post("/products/counter/boss/messages", { text: "We need a feature: Lines - Says how many lines there are." });
  assert.equal(r.status, 200);
  assert.deepEqual({ feature: r.json.reply.features[0].feature, state: r.json.reply.features[0].state }, { feature: "F1", state: "open" });
  const msgs = (await f.get("/products/counter/boss/messages")).json;
  assert.deepEqual(checkBossMessages(msgs, STAGE_IDS), []);
  assert.equal(f.store.read(id).feature_log.filter((e) => e.kind === "approved").length, 0);
  const h = (await f.get("/products/counter/features/F1")).json.history[0];
  assert.deepEqual({ by: h.by, link: h.link }, { by: "The boss", link: { kind: "message", message: r.json.reply.id } });
  await decide(f, id, "F1", "approve", { proposal: r.json.reply.features[0].proposal, message: r.json.reply.id });
  assert.equal((await f.get("/products/counter/boss/messages")).json.messages.at(-1).features[0].state, "approved");
});
