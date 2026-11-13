// Features through the lifecycle (lifecycle API 0.4.5), over HTTP, with
// stand-in holders and a stand-in for the shared model caller: no test reaches
// a model or the network.
//
//   - a product made before features (fixtures/word-counter, a real build) has
//     its features listed by the spec writer from its statement, with the tests
//     already in the build mapped where the stand-in recognizes them and the
//     rest left unmapped, then approved together with Approve all;
//   - each every-build stage carries its features (Test, Code, Review) and a
//     count for the spine;
//   - a feature with no test is to do at Test, and at Code;
//   - a review finding is tied to a feature only through its tests;
//   - `product-factory features backfill <product>` runs the same listing.

import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { factory, tempDir, FAKE_ADLC, MODEL_VARS } from "./helpers.mjs";
import { createKeys, KEYS_FILE } from "../lib/people.mjs";
import { checkBuild, checkFeatures, checkMessageReply, checkStageWorkspace, checkFeatureApproveAll } from "../standards/lifecycle-api-check.mjs";
import { STAGE_IDS } from "../lib/standards.mjs";
import { findingFeatures, registerOf, testLines, lastRun, statementVersion } from "../lib/features.mjs";
import { BACKFILL_TEXT, promptFor } from "../lib/thread.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/word-counter/", import.meta.url));
const WC = JSON.parse(readFileSync(join(FIXTURE, "build.json"), "utf8"));
const BIN = fileURLToPath(new URL("../bin/product-factory.mjs", import.meta.url));

/** A Product Factory holding the real word-counter build, made before features. */
async function wordCounter(t, opts = {}) {
  const f = await factory({ holder: "harness", ...opts });
  t.after(f.close);
  cpSync(FIXTURE, f.store.folder(WC.id), { recursive: true });
  return { f, id: WC.id };
}
const stageIn = (build, id) => build.stages.find((s) => s.stage === id);
const suiteNames = async (f, id) => (await f.get(`/builds/${id}`)).json.build.artifacts.find((a) => a.id === "suite").summary.tests;

test("backfill: the spec writer lists a product's features from its statement, maps the tests it can and leaves the rest unmapped; Approve all approves them as one new version", async (t) => {
  const { f, id } = await wordCounter(t);
  const names = await suiteNames(f, id);

  // Before: no features, and listing them is offered, in words.
  const before = (await f.get(`/builds/${id}/features`)).json;
  assert.deepEqual(checkFeatures(before, id), []);
  assert.deepEqual(before.features, []);
  assert.equal(before.backfill.offered, true);
  assert.match(before.backfill.words, /^The spec writer lists the features of the spec v4, and maps the \d+ tests already in the build to them where their names or content make it clear\. A test it cannot tie to a feature is left unmapped\. They arrive as proposed, for you to approve\.$/);
  assert.match(before.words, /made before features: the spec writer can list them/);
  assert.equal((await f.get(`/builds/${id}/stages/requirements`)).json.features, undefined, "no features, no slice");
  assert.equal(stageIn((await f.get(`/builds/${id}`)).json.build, "test").features, undefined);

  // The listing goes through the Requirements chat: the person's message, and the spec writer's reply with the proposals.
  const got = await f.post(`/builds/${id}/features/backfill`);
  assert.equal(got.status, 200, JSON.stringify(got.json));
  assert.deepEqual(checkMessageReply(got.json, (await f.get(`/builds/${id}`)).json), []);
  assert.equal(got.json.message.text, BACKFILL_TEXT);
  assert.equal(got.json.message.from.kind, "person");
  const props = got.json.reply.features;
  assert.deepEqual(props.map((p) => [p.feature, p.name, p.state, p.offering]), [["F1", "Count words", "open", "Count words"], ["F2", "Refuse non-text", "open", "Count words"], ["F3", "Stop on empty input", "open", "Count words"], ["F4", "Refuse credentials", "open", "Count words"]]);
  // Mapped only to the suite's own names: the name the suite does not have is dropped.
  for (const p of props) for (const n of p.tests) assert.ok(names.includes(n), `${n} is one of the suite's tests`);
  assert.ok(!props[0].tests.includes("a test the suite does not have"));
  assert.deepEqual(props[1].tests, ["multiple sentences or non-text content are refused", "binary files and images are refused immediately"]);
  assert.deepEqual(props[3].tests, ["a credential value or system address is refused"]);
  // The prompt told the spec writer the suite's names and not to guess.
  const prompt = readFileSync(join(f.store.folder(id), "thread", got.json.message.id, "prompt.txt"), "utf8");
  assert.match(prompt, /When it is not clear, leave it out: never guess\./);
  assert.match(prompt, /The suite's test names:\n- multiple sentences or non-text content are refused\n/);
  const chat = (await f.get("/products/word-counter/stages/requirements/messages")).json.messages;
  assert.deepEqual(chat.map((m) => m.from.kind), ["person", "agent"]);

  // The matrix: each row proposed, with its pending proposal to answer inline, the message it came from and its tests; the unclear tests unmapped.
  const m = (await f.get(`/builds/${id}/features`)).json;
  assert.deepEqual(checkFeatures(m, id), []);
  assert.deepEqual(m.features.map((r) => [r.id, r.state, r.pending.state, r.pending.you_may_approve]), [["F1", "proposed", "open", true], ["F2", "proposed", "open", true], ["F3", "proposed", "open", true], ["F4", "proposed", "open", true]]);
  assert.deepEqual(m.features[0].from, { build: id, message: got.json.reply.id, stage: "requirements" });
  assert.deepEqual(m.features[1].tests, props[1].tests);
  assert.ok(m.unmapped.includes("markdown is parsed to find the sentence"), "a test the spec writer could not tie is unmapped");
  assert.ok(m.unmapped.includes("the process contract requires --job"));
  assert.equal(m.unmapped.length + new Set(m.features.flatMap((r) => r.tests)).size, names.length, "every test is mapped or unmapped, once");
  assert.equal(m.backfill.offered, false);
  assert.equal((await f.post(`/builds/${id}/features/backfill`)).status, 409, "listed once: they change in a chat after that");

  // Approve all: every proposal, one batch, recorded as chat approvals, one new statement version.
  const all = await f.post(`/builds/${id}/features/approve_all`, { proposals: props.map((p) => p.proposal), message: got.json.reply.id });
  assert.equal(all.status, 200, JSON.stringify(all.json));
  assert.deepEqual(checkFeatureApproveAll(all.json, props.map((p) => p.proposal)), []);
  assert.equal(all.json.statement, "v5", "v4 and one version for the batch");
  const log = f.store.read(id).feature_log.filter((e) => e.kind === "approved");
  assert.equal(log.length, 4);
  assert.ok(log.every((e) => e.via === "chat" && e.by === "Test Person" && e.message === got.json.reply.id && e.stage === "requirements" && e.statement === "v5"));
  assert.equal(new Set(log.map((e) => e.batch)).size, 1);
  const after = (await f.get(`/builds/${id}/features`)).json;
  assert.deepEqual(checkFeatures(after, id), []);
  assert.deepEqual(after.features.map((r) => [r.id, r.state, r.cells.spec.state]), [["F1", "approved", "done"], ["F2", "approved", "done"], ["F3", "approved", "done"], ["F4", "approved", "done"]]);
  assert.equal(after.features[0].pending, undefined);
  // The code's round passed the gate, so every mapped test passes.
  assert.deepEqual({ ...after.features[1].cells.code, link: undefined }, { state: "done", words: "Passes 2/2", tests: { passed: 2, total: 2 }, link: undefined });
  const chatAfter = (await f.get("/products/word-counter/stages/requirements/messages")).json.messages;
  assert.deepEqual(chatAfter.at(-1).features.map((p) => p.state), ["approved", "approved", "approved", "approved"]);
  assert.equal((await f.post(`/builds/${id}/features/approve_all`, { proposals: [props[0].proposal] })).status, 400, "nothing open to approve");
});

test("each stage carries its features: Requirements, Test with untied tests, Code passing per feature, Review with findings not tied to a feature; the spine counts", async (t) => {
  const { f, id } = await wordCounter(t);
  const got = await f.post(`/builds/${id}/features/backfill`);
  const props = got.json.reply.features;
  // Before approving: Requirements counts what is approved; the other stages count approved features only.
  let b = (await f.get(`/builds/${id}`)).json;
  assert.deepEqual(stageIn(b.build, "requirements").features, { covered: 0, total: 4, words: "0 of 4 approved" });
  assert.deepEqual(stageIn(b.build, "test").features, { covered: 0, total: 0, words: "0 of 0 features" });
  await f.post(`/builds/${id}/features/approve_all`, { proposals: props.slice(0, 3).map((p) => p.proposal) });

  b = (await f.get(`/builds/${id}`)).json;
  assert.deepEqual(checkBuild(b, STAGE_IDS, id), []);
  const count = (s) => stageIn(b.build, s).features;
  assert.deepEqual(count("requirements"), { covered: 3, total: 4, words: "3 of 4 approved" });
  assert.deepEqual(count("test"), { covered: 3, total: 3, words: "3 of 3 features" });
  assert.deepEqual(count("code"), { covered: 3, total: 3, words: "3 of 3 features pass" });
  assert.deepEqual(count("review"), { covered: 3, total: 3, words: "3 of 3 features clear" });
  assert.equal(count("docs"), undefined, "Docs does not run here, so it has none");
  assert.equal(count("package"), undefined, "Package is not a feature stage");

  const ws = async (stage) => { const w = (await f.get(`/builds/${id}/stages/${stage}`)).json; assert.deepEqual(checkStageWorkspace(w, STAGE_IDS, stage, b), []); return w.features; };
  const req = await ws("requirements");
  assert.deepEqual(req.items.map((x) => [x.id, x.state, x.words]), [["F1", "done", "Approved"], ["F2", "done", "Approved"], ["F3", "done", "Approved"], ["F4", "to_do", "Proposed, not approved yet"]]);
  const tst = await ws("test");
  assert.deepEqual(tst.items.map((x) => [x.id, x.state]), [["F1", "done"], ["F2", "done"], ["F3", "done"]]);
  assert.equal(tst.items[1].words, "2 tests");
  assert.deepEqual(tst.items[1].tests, props[1].tests);
  assert.match(tst.untied.words, /^\d+ tests not tied to a feature$/);
  assert.ok(tst.untied.items.includes("markdown is parsed to find the sentence"));
  assert.ok(tst.untied.items.includes("a credential value or system address is refused"), "F4 is not approved, so its test is not tied yet");
  const code = await ws("code");
  assert.deepEqual(code.items.map((x) => [x.id, x.words, x.state]), [["F1", `${props[0].tests.length} of ${props[0].tests.length} passing`, "done"], ["F2", "2 of 2 passing", "done"], ["F3", `${props[2].tests.length} of ${props[2].tests.length} passing`, "done"]]);
  const review = await ws("review");
  assert.deepEqual(review.items.map((x) => [x.id, x.state, x.words]), [["F1", "done", "No findings"], ["F2", "done", "No findings"], ["F3", "done", "No findings"]]);
  assert.deepEqual(review.untied, { words: "1 finding not tied to a feature", items: ["agent-runtime-requirements.json:34: The `run.command` array for `count-words` does not include the `--records {records}` argument to pass the records directory to the script, and the host does not set a `RECORDS` environment variable. (outside the change)"] });
  assert.equal((await f.get(`/builds/${id}/stages/package`)).json.features, undefined);
});

test("a feature approved after the spec starts its own run then: its tests and its code, beside the first feature's", async (t) => {
  const f = await factory({ holder: "harness", rounds: 1 });
  t.after(f.close);
  const id = (await f.post("/builds", { does: "Count the words in a passage.", name: "counter" })).json.build.id;
  await f.settled(id);
  const say = async (text) => (await f.post("/products/counter/stages/requirements/messages", { text })).json.reply.features[0];
  const p1 = await say("Add a feature: Count words - Counts the words in a passage.");
  await f.post(`/builds/${id}/features/F1/approve`, { proposal: p1.proposal });
  await f.post(`/builds/${id}/actions/approve`);
  await f.settled(id);
  assert.deepEqual(f.store.read(id).feature_runs.map((x) => [x.feature, x.status]), [["F1", "waiting"]]);
  const p2 = await say("Add a feature: Lines - Says how many lines there are.");
  await f.post(`/builds/${id}/features/F2/approve`, { proposal: p2.proposal });
  // Its run starts at its approval, while the first feature waits for your OK.
  assert.deepEqual(f.store.read(id).feature_runs.map((x) => x.feature), ["F1", "F2"]);
  await f.settled(id);

  const b = (await f.get(`/builds/${id}`)).json;
  assert.deepEqual(checkBuild(b, STAGE_IDS, id), []);
  assert.deepEqual(stageIn(b.build, "test").features, { covered: 2, total: 2, words: "2 of 2 features" });
  const tst = (await f.get(`/builds/${id}/stages/test`)).json.features;
  assert.deepEqual(tst.items.map((x) => [x.id, x.state, x.words, x.tests]), [["F1", "done", "1 test", ["[F1] count words"]], ["F2", "done", "1 test", ["[F2] lines"]]]);
  assert.equal(tst.untied, undefined, "each feature's test writer wrote that feature's tests alone");
  const code = (await f.get(`/builds/${id}/stages/code`)).json.features;
  assert.deepEqual(code.items.map((x) => [x.id, x.state, x.words]), [["F1", "done", "1 of 1 passing"], ["F2", "done", "1 of 1 passing"]]);
  assert.equal(stageIn(b.build, "review").features, undefined, "the code critic is not asked on this computer, so Review has none");
  const m = (await f.get(`/builds/${id}/features`)).json;
  assert.deepEqual(checkFeatures(m, id), []);
  assert.deepEqual(m.unmapped, []);
  assert.equal(m.backfill.offered, false, "the product has features already");
});

test("a review finding is tied to a feature only through its tests: a line inside one, or a test's name quoted", () => {
  const events = [
    { id: "p1", kind: "proposed", feature: "F1", name: "Count", does: "Counts.", offering: "Count", at: "2026-01-01T00:00:00Z", tests: ["counts the words"] },
    { id: "p2", kind: "proposed", feature: "F2", name: "Empty", does: "Says none.", offering: "Count", at: "2026-01-01T00:00:01Z" },
  ];
  const reg = registerOf(events);
  const text = 'import { test } from "node:test";\n\ntest("counts the words", () => {\n  assert.equal(1, 1);\n});\n\ntest("[F2] an empty passage has none", () => {\n  assert.equal(0, 0);\n});\n';
  assert.deepEqual(testLines(text), [{ name: "counts the words", line: 3 }, { name: "[F2] an empty passage has none", line: 7 }]);
  const files = [{ path: "test/count.test.mjs", text }];
  assert.deepEqual(findingFeatures({ place: "test/count.test.mjs:4", claim: "x" }, files, reg), ["F1"], "inside a mapped test");
  assert.deepEqual(findingFeatures({ place: "count.test.mjs:8", claim: "x" }, files, reg), ["F2"], "inside a test that names its feature");
  assert.deepEqual(findingFeatures({ place: "test/count.test.mjs:1", claim: "x" }, files, reg), [], "above every test");
  assert.deepEqual(findingFeatures({ place: "scripts/count.mjs:12", claim: "x" }, files, reg), [], "a place in a script is not tied");
  assert.deepEqual(findingFeatures({ place: "", claim: 'The test "counts the words" asserts nothing.' }, files, reg), ["F1"], "a test's name quoted");
  assert.deepEqual(findingFeatures({ place: "agent-runtime-requirements.json:34", claim: "x" }, files, reg), []);
});

test("a passing round from before features reads as nothing failing, and Approve all makes one statement version", () => {
  assert.deepEqual(lastRun(WC), { at: WC.stages.code.rounds[0].at, failing: [], label: "Push 21065e2" });
  assert.equal(lastRun({ stages: { code: { rounds: [{ at: "x", back: true }] } } }), null, "a round sent back ran nothing we can read");
  const r = { stages: { requirements: { rounds: [] } }, feature_log: [{ id: "a", kind: "approved", via: "chat", batch: "b1" }, { id: "b", kind: "approved", via: "chat", batch: "b1" }, { id: "c", kind: "approved", via: "chat" }] };
  assert.equal(statementVersion(r, 4), "v6");
  assert.equal(statementVersion({ feature_log: [] }, 4), null);
});

test("Approve all: only an approver may, every proposal is checked first, and a proposal is named once", async (t) => {
  const doc = { version: "0.1", organization: { approvers: { requirements: [{ person: "ana@example.com" }] } } };
  const people = { organization: "Example Org", people: [{ name: "Ana Lee", email: "ana@example.com", role: "approver" }, { name: "Max Member", email: "max@example.com", role: "member" }] };
  const { f, id } = await wordCounter(t, { doc, people });
  const keys = createKeys(join(f.config.data, KEYS_FILE));
  const max = keys.make("max@example.com");
  // Anyone may ask for the listing: it only proposes.
  const got = await f.call("POST", `/builds/${id}/features/backfill`, {}, { auth: max });
  assert.equal(got.status, 200, JSON.stringify(got.json));
  const props = got.json.reply.features;
  assert.ok(props.every((p) => p.you_may_approve === false && p.approvers[0] === "Ana Lee (ana@example.com)"));
  const ids = props.map((p) => p.proposal);
  const no = await f.call("POST", `/builds/${id}/features/approve_all`, { proposals: ids }, { auth: max });
  assert.equal(no.status, 403);
  assert.match(no.json.error, /So only they may approve features\. Ask them instead/);
  assert.equal((await f.post(`/builds/${id}/features/approve_all`, { proposals: [] })).status, 400);
  assert.equal((await f.post(`/builds/${id}/features/approve_all`, { proposals: [ids[0], ids[0]] })).status, 400);
  // One proposal left for later is still open to approve; one that does not exist refuses the whole answer.
  await f.post(`/builds/${id}/features/F2/not_now`, { proposal: ids[1] });
  const ana = keys.make("ana@example.com");
  const bad = await f.call("POST", `/builds/${id}/features/approve_all`, { proposals: [ids[0], "fp_nope"] }, { auth: ana });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /has no proposal fp_nope/);
  assert.equal(f.store.read(id).feature_log.filter((e) => e.kind === "approved").length, 0, "nothing was approved");
  const ok = await f.call("POST", `/builds/${id}/features/approve_all`, { proposals: [ids[0], ids[1]] }, { auth: ana });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual(ok.json.approved.map((p) => [p.feature, p.state, p.answered.by]), [["F1", "approved", "Ana Lee"], ["F2", "approved", "Ana Lee"]]);
});

test("the listing's prompt carries the rules only when asked, and a reply outside a listing maps no tests", async (t) => {
  const base = { r: WC, role: "spec-writer", stage: "requirements", given: [], outputs: [], files: [], history: [], text: "hi" };
  assert.doesNotMatch(promptFor(base), /built before it had a feature list/);
  assert.match(promptFor({ ...base, backfill: { tests: null } }), /The build has no suite, so give each feature "tests": \[\]\./);
  // A chat reply that names tests keeps none of them: only a listing maps tests.
  const { f, id } = await wordCounter(t);
  const r = await f.post("/products/word-counter/stages/requirements/messages", { text: "Add a feature: Count words - Counts the words." });
  assert.equal(r.json.reply.features[0].tests, undefined);
  assert.equal(f.store.read(id).feature_log[0].tests, undefined);
});

test("product-factory features backfill <product> lists the features through the same code, with no service running", async () => {
  const dir = await tempDir("backfill-cli");
  const config = join(dir, "product-factory.json");
  writeFileSync(config, JSON.stringify({ adlc: FAKE_ADLC, lifecycle: "./lifecycle.json", data: "./data", port: 0, model: { name: "PF_T_MODEL_NAME", endpoint: "PF_T_MODEL_ENDPOINT", key: "PF_T_MODEL_KEY", protocol: "PF_T_MODEL_PROTOCOL" }, code: { holder: "harness", harness: null, rounds: 1, minutes: 2 } }, null, 2));
  mkdirSync(join(dir, "data", "builds"), { recursive: true });
  cpSync(FIXTURE, join(dir, "data", "builds", WC.id), { recursive: true });
  const run = (args) => new Promise((ok) => {
    const child = spawn(process.execPath, [BIN, ...args, "--config", config], { cwd: dir, env: { ...process.env, ...MODEL_VARS }, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => ok({ code, out, err }));
  });
  const got = await run(["features", "backfill", "word-counter"]);
  assert.equal(got.code, 0, got.err);
  assert.match(got.out, /^Asking the spec writer to list the features of word-counter\./);
  assert.match(got.out, /\n {2}F2 Refuse non-text: Refuses more than one sentence, binary files, images and anything that is not text\. \(offering Count words\)\. 2 tests mapped\.\n/);
  assert.match(got.out, /They are proposed, not approved\. Open word-counter's Requirements stage in the console: its Features tab has Approve all/);
  const kept = JSON.parse(readFileSync(join(dir, "data", "builds", WC.id, "build.json"), "utf8"));
  assert.equal(kept.feature_log.filter((e) => e.kind === "proposed").length, 4);
  assert.equal(kept.feature_log.filter((e) => e.kind === "approved").length, 0);
  // Once listed, the command says why not again; and a product that is not there says so.
  const again = await run(["features", "backfill", "word-counter"]);
  assert.equal(again.code, 1);
  assert.match(again.err, /The product has features already/);
  const none = await run(["features", "backfill", "nothing-here"]);
  assert.equal(none.code, 1);
  assert.match(none.err, /There is no product nothing-here/);
  assert.equal((await run(["features", "list"])).code, 2);
});
