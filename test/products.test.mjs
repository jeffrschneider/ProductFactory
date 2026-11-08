// Products, stage workspaces and each stage's chat (lifecycle API 0.4), over
// HTTP, on builds walked with stand-in holders: the stand-in agents, a fake
// GitHub for Code's pull request, and a stand-in for the shared model caller
// (fixtures/fake-adlc/agents/spec-writer/scripts/model-caller.mjs). No test
// reaches a model or the network.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { factory, stageOf, actionNames } from "./helpers.mjs";
import { fakeGitHub } from "./fixtures/fake-github.mjs";
import { createKeys, KEYS_FILE } from "../lib/people.mjs";
import { checkBuild } from "adlc-console/lib/contract.mjs";
import { validate, checkProducts, checkProduct, checkStageWorkspace, checkMessages, checkMessageReply } from "../standards/lifecycle-api-check.mjs";
import { STAGE_IDS } from "../lib/standards.mjs";

const BRANCH = "adlc/counter-0.1.0";
const SCRIPT = "agents/counter/scripts/count.mjs";
const RIGHT = "export function count(text) { return String(text).split(/\\s+/).filter(Boolean).length; }\n";

/** A product "counter" on a pull request, its first build waiting for the spec's approval. */
async function counter(t, { factory: opts = {} } = {}) {
  const gh = await fakeGitHub();
  const f = await factory({ holder: "pull-request", github: gh, ...opts });
  t.after(async () => { await f.close(); await gh.close(); });
  const id = (await f.post("/builds", { does: "Count the words in a passage.", name: "counter" })).json.build.id;
  await f.settled(id);
  return { gh, f, id };
}

/** Walks the build from the spec's gate to Code's gate, with a passing push. */
async function toCodeGate(f, gh, id) {
  await f.post(`/builds/${id}/actions/approve`);
  await f.settled(id);
  gh.push(BRANCH, { [SCRIPT]: RIGHT });
  await f.runner.poll(id);
  return f.settled(id);
}

/** A stage workspace, held to the lifecycle API 0.4 check against the build as it stands. */
async function ws(f, id, stage) {
  const got = await f.get(`/builds/${id}/stages/${stage}`);
  if (got.status === 200) assert.deepEqual(checkStageWorkspace(got.json, STAGE_IDS, stage, (await f.get(`/builds/${id}`)).json), [], stage);
  return got;
}
const say = (f, stage, text, extra = {}, call = f.call) => call("POST", `/products/counter/stages/${stage}/messages`, { text, ...extra });

test("products, a product's builds and activity, and each stage's workspace, from a walked build", async (t) => {
  const { gh, f, id } = await counter(t);

  // The product list: one product per build name, with its newest build.
  let list = await f.get("/products");
  assert.equal(list.status, 200);
  assert.deepEqual(checkProducts(list.json), []);
  assert.deepEqual(list.json.products, [{ name: "counter", latest: { build: id, version: "0.1.0", state: "waiting_on_you", at: { stage: "requirements", state: "waiting_on_you", summary: "Waiting on you at Requirements" } }, versions: ["0.1.0"] }]);

  // Requirements: the gate is open, with the build's live actions and who may answer.
  let req = (await ws(f, id, "requirements")).json;
  assert.equal(req.state, "waiting_on_you");
  assert.deepEqual(req.gate, { actions: ["approve", "changes", "stop"], state: "open", who_may: "Anyone may answer this gate: the lifecycle names no approvers for it." });
  assert.deepEqual(req.given, []);
  assert.deepEqual(req.outputs.map((a) => [a.id, a.state]), [["statement", "made"]]);
  assert.equal(req.done_when, "a package could be built from it, and nothing unsettled was invented");
  // Test has not run: nothing given yet but the statement, its suite is next, and it has no gate.
  const tst = (await ws(f, id, "test")).json;
  assert.deepEqual(tst.given, ["statement"]);
  assert.deepEqual(tst.outputs.map((a) => [a.id, a.state]), [["suite", "next"]]);
  assert.equal(tst.gate, undefined);

  // On to Code's gate: Requirements now reads answered, by the person, with the action they took.
  let b = await toCodeGate(f, gh, id);
  req = (await ws(f, id, "requirements")).json;
  assert.equal(req.gate.state, "answered");
  assert.deepEqual({ ...req.gate.answered, at: "x" }, { by: "Test Person", at: "x", action: "approve" });
  const code = (await ws(f, id, "code")).json;
  assert.deepEqual(code.gate.actions, ["accept", "back_to_test", "stop"]);
  assert.equal(code.gate.state, "open");
  assert.deepEqual(code.given, ["statement", "suite"]);
  assert.deepEqual(code.outputs.map((a) => [a.id, a.state]), [["programs", "made"]]);
  assert.equal(code.outputs[0].summary.pr.number, 1);
  const review = (await ws(f, id, "review")).json;
  assert.deepEqual(review.outputs.map((a) => [a.id, a.state]), [["findings", "made"]]);
  assert.equal(review.outputs[0].summary.verdict, "Nothing open.");
  assert.deepEqual(review.given, ["statement", "suite", "programs"]);

  // The build answer carries the artifacts, and still meets the console's checks and the lifecycle API's.
  const one = await f.get(`/builds/${id}`);
  assert.deepEqual(checkBuild(one.json, STAGE_IDS), []);
  assert.deepEqual(validate("BuildAnswer", one.json), []);
  assert.deepEqual(one.json.build.artifacts.map((a) => a.id), ["statement", "architecture", "suite", "programs", "findings", "security", "package", "build_record", "run_plan", "attestation", "agentdoc"]);
  assert.equal(one.json.build.artifacts.find((a) => a.id === "package").state, "next");
  // A reviewer's document is read at its artifact's link.
  const findings = one.json.build.artifacts.find((a) => a.id === "findings").files[0];
  const doc = await f.call("GET", findings.link.replace("/v1/lifecycle", ""), undefined, { raw: true });
  assert.equal(doc.status, 200);
  assert.match(doc.text, /open: 0/);

  // Your OK, then the package: the deploy gate opens with the package and the run plan.
  await f.post(`/builds/${id}/actions/accept`);
  b = await f.settled(id);
  assert.deepEqual(actionNames(b), ["approve", "stop"]);
  const deploy = (await ws(f, id, "deploy")).json;
  assert.deepEqual(deploy.gate.actions, ["approve", "stop"]);
  assert.deepEqual(deploy.given, ["package"]);
  assert.deepEqual(deploy.outputs.map((a) => [a.id, a.state]), [["run_plan", "made"]]);
  assert.equal((await ws(f, id, "code")).json.gate.answered.action, "accept");

  // The product: its builds, the newest run plan, and one line per stage event, newest first.
  const p = (await f.get("/products/counter")).json;
  assert.deepEqual(checkProduct(p, "counter"), []);
  assert.deepEqual(p.builds.map((x) => [x.id, x.version, x.state]), [[id, "0.1.0", "waiting_on_you"]]);
  assert.equal(p.run_plan.build, id);
  assert.ok(p.run_plan.summary.stages.some((e) => e.stage === "monitor"));
  assert.ok(p.activity.some((e) => e.stage === "code" && /^Opened pull request #1/.test(e.words)));
  assert.ok(p.activity.some((e) => e.stage === "requirements" && e.words === "You approved the spec."));
  assert.ok(p.activity.every((e, i, all) => i === 0 || all[i - 1].at >= e.at), "newest first");
  assert.ok(p.activity.every((e) => e.build === id && e.version === "0.1.0"));

  // A second build of the same product is a new version of it.
  const second = (await f.post("/builds", { does: "Count the words in a passage, again.", name: "counter" })).json.build.id;
  await f.settled(second);
  list = (await f.get("/products")).json.products;
  assert.equal(list.length, 1);
  assert.equal(list[0].latest.build, second);
  assert.equal((await f.get("/products/counter")).json.builds.length, 2);

  // What is not there is said in words.
  assert.equal((await f.get("/products/nothing")).status, 404);
  assert.match((await ws(f, id, "nowhere")).json.error, /There is no stage "nowhere"/);
});

test("the agent holding a stage answers a question from its outputs, and the chat is kept per product per stage", async (t) => {
  const { gh, f, id } = await counter(t);
  await toCodeGate(f, gh, id);
  const before = f.store.read(id);

  const got = await say(f, "test", "What happens with an empty message?");
  assert.equal(got.status, 200);
  assert.deepEqual(checkMessageReply(got.json, (await f.get(`/builds/${id}`)).json), []);
  const { message, reply } = got.json;
  assert.deepEqual({ ...message, id: "x", at: "x" }, { id: "x", at: "x", build: id, version: "0.1.0", from: { kind: "person", name: "Test Person", stage: "test" }, to: { role: "test-writer" }, text: "What happens with an empty message?" });
  assert.equal(reply.from.kind, "agent");
  assert.equal(reply.from.name, "Test writer");
  assert.equal(reply.from.role, "test-writer");
  assert.equal(reply.build, id);
  assert.match(reply.text, /^You asked: What happens with an empty message\? I read test\/count\.test\.mjs, requirements\/agent-descriptor\.json/);
  assert.equal(reply.proposes, undefined);

  // The agent was told its suite, what it was given, and the build's record, and nothing changed by answering.
  const prompt = readFileSync(join(f.store.folder(id), "thread", message.id, "prompt.txt"), "utf8");
  assert.match(prompt, /^You are the Test writer on a build/);
  assert.match(prompt, /What you made, The suite \(made, v1\):/);
  assert.match(prompt, /What you were given, Statement of the job/);
  assert.match(prompt, /Where it is now: Waiting on you at Code\./);
  const after = f.store.read(id);
  assert.equal(after.status, before.status);
  assert.equal(after.run.events.length, before.run.events.length);
  assert.deepEqual(after.stages, before.stages);

  // The chat at Test holds both; the chat at Requirements holds neither.
  const chatAnswer = (await f.get("/products/counter/stages/test/messages")).json;
  assert.deepEqual(checkMessages(chatAnswer, "test"), []);
  const chat = chatAnswer.messages;
  assert.deepEqual(chat.map((m) => [m.from.kind, m.build, m.version]), [["person", id, "0.1.0"], ["agent", id, "0.1.0"]]);
  assert.deepEqual((await f.get("/products/counter/stages/requirements/messages")).json.messages, []);

  // A second build of the product: the chat at Test goes on across builds, each message marked with its build.
  const second = (await f.post("/builds", { does: "Count the words in a passage.", name: "counter" })).json.build.id;
  await f.settled(second);
  await f.post(`/builds/${second}/actions/approve`);
  await f.settled(second);
  const again = await say(f, "test", "And now?");
  assert.equal(again.json.message.build, second);
  const prompt2 = readFileSync(join(f.store.folder(second), "thread", again.json.message.id, "prompt.txt"), "utf8");
  assert.match(prompt2, /What the person and you said before, on this build and earlier ones:\n- \(0\.1\.0\) The person: What happens with an empty message\?/);
  const all = (await f.get("/products/counter/stages/test/messages")).json.messages;
  assert.deepEqual(all.map((m) => m.build), [id, id, second, second]);
  // An earlier build is still asked by naming it.
  assert.equal((await say(f, "test", "About the first one?", { build: id })).json.message.build, id);
});

test("a change request proposes the stage's existing action with its needs filled, and confirming it goes through the gate", async (t) => {
  const { gh, f, id } = await counter(t);

  // At Requirements: the spec writer proposes changes.
  let got = await say(f, "requirements", "Please change the price to free.");
  assert.equal(got.status, 200);
  assert.deepEqual(got.json.reply.proposes, { action: "changes", needs: { changes: "change the price to free." } });
  assert.equal(f.store.read(id).status, "waiting", "answering changed nothing");

  // At Code's gate: the test writer proposes sending the build back to Test.
  await toCodeGate(f, gh, id);
  got = await say(f, "test", "Change the suite so an empty passage has no words.");
  assert.deepEqual(checkMessageReply(got.json, (await f.get(`/builds/${id}`)).json), []);
  assert.deepEqual(got.json.reply.proposes, { action: "back_to_test", needs: { changes: "Change the suite so an empty passage has no words." } });
  // The spec is approved and Requirements offers nothing now: the spec writer says so and proposes nothing.
  got = await say(f, "requirements", "Change the name to tally.");
  assert.equal(got.json.reply.proposes, undefined);
  assert.match(got.json.reply.text, /The build offers no way to make that change now, so I have not proposed one\.$/);

  // The person confirms the test writer's proposal with the actions route.
  const p = (await f.get("/products/counter/stages/test/messages")).json.messages.find((m) => m.proposes?.action === "back_to_test").proposes;
  const sent = await f.post(`/builds/${id}/actions/${p.action}`, p.needs);
  assert.equal(sent.status, 200);
  const b = await f.settled(id);
  assert.equal(stageOf(b, "test").rounds[0].verdict, "Suite revised");
});

test("a stage nobody Product Factory can reach holds is refused in words, as is a stage the lifecycle leaves out", async (t) => {
  const { f, id } = await counter(t, { factory: { doc: { version: "0.1", organization: { used: { docs: false } } } } });
  const refused = async (stage, re, status = 400) => {
    const got = await say(f, stage, "Hello?");
    assert.equal(got.status, status, stage);
    assert.match(got.json.error, re, stage);
  };
  await refused("docs", /^This build's lifecycle leaves out Docs, so no agent holds it to answer\.$/);
  await refused("code", /^Code is held by your coding harness, on a pull request \(acme\/agents\), which Product Factory cannot send messages to\. Talk to it where it runs\./);
  await refused("architecture", /^Product Factory does not run Architecture and Design on this build/);
  await refused("nowhere", /^There is no stage "nowhere"/, 404);
  assert.equal((await f.call("POST", "/products/counter/stages/test/messages", { text: "" })).status, 400);
  assert.equal((await f.call("POST", "/products/counter/stages/test/messages", { text: "x", build: "b_000000000000" })).status, 400);
  assert.equal((await f.call("POST", "/products/nothing/stages/test/messages", { text: "x" })).status, 404);
  // Nothing refused was kept.
  assert.equal(f.store.read(id).thread, undefined);
});

test("a stage held by an outside tool, and a model that is not set or fails, are said in words", async (t) => {
  const { f, id } = await counter(t, { factory: { model: false } });
  const got = await say(f, "requirements", "Hello?");
  assert.equal(got.status, 409);
  assert.match(got.json.error, /^The spec writer answers through the model, and PF_T_MODEL_NAME, PF_T_MODEL_ENDPOINT, PF_T_MODEL_PROTOCOL are not set\./);
  assert.equal(f.store.read(id).thread, undefined);

  const g = await counter(t);
  await toCodeGate(g.f, g.gh, g.id);
  await g.f.post(`/builds/${g.id}/actions/accept`);
  await g.f.settled(g.id);
  const pkg = await say(g.f, "package", "Hello?");
  assert.equal(pkg.status, 400);
  assert.match(pkg.json.error, /^Package is held by the packer \(node\), an outside tool, which does not answer messages\.$/);
  const failed = await say(g.f, "requirements", "MODEL-FAILS please");
  assert.equal(failed.status, 200);
  assert.deepEqual(failed.json.reply.from, { kind: "system", name: "Product Factory", stage: "requirements" });
  assert.equal(failed.json.reply.text, "The spec writer could not answer: the model service at model.example answered 503: busy. Nothing changed.");
  assert.ok(existsSync(join(g.f.store.folder(g.id), "thread", failed.json.message.id, "prompt.txt")));
});

const PEOPLE = {
  organization: "Example Org",
  people: [
    { name: "Ana Lee", email: "ana@example.com", role: "approver" },
    { name: "Max Member", email: "max@example.com", role: "member" },
  ],
};

test("teams rules: anyone who may see the build may talk to its agents, and a proposal is made only to whoever may answer the gate", async (t) => {
  const doc = { version: "0.1", organization: { approvers: { requirements: [{ person: "ana@example.com" }] } } };
  const { f, id } = await counter(t, { factory: { people: PEOPLE, doc } });
  const keys = createKeys(join(f.config.data, KEYS_FILE));
  const ana = keys.make("ana@example.com");
  const max = keys.make("max@example.com");
  const as = (key) => (method, path, body) => f.call(method, path, body, { auth: key });

  // A member sees the gate, not its answers, and who may answer it.
  const seen = (await as(max)("GET", `/builds/${id}/stages/requirements`)).json;
  assert.deepEqual(seen.gate.actions, ["stop"]);
  assert.equal(seen.gate.who_may, "Only Ana Lee (ana@example.com) may answer the Requirements gate.");
  assert.deepEqual((await as(ana)("GET", `/builds/${id}/stages/requirements`)).json.gate.actions, ["approve", "changes", "stop"]);

  // A member may talk to the spec writer; a change they ask for is not proposed to them, and the reply says why.
  const asked = await say(f, "requirements", "Change the price to free.", {}, as(max));
  assert.equal(asked.status, 200);
  assert.equal(asked.json.message.from.name, "Max Member");
  assert.equal(asked.json.reply.proposes, undefined);
  assert.match(asked.json.reply.text, /Only Ana Lee \(ana@example\.com\) may answer the Requirements gate\. So I have not proposed it\.$/);
  // The approver named for the gate gets the proposal.
  const yes = await say(f, "requirements", "Change the price to free.", {}, as(ana));
  assert.deepEqual(yes.json.reply.proposes, { action: "changes", needs: { changes: "Change the price to free." } });
  // Without a key, nobody is answered.
  assert.equal((await f.call("POST", "/products/counter/stages/requirements/messages", { text: "x" }, { auth: null })).status, 401);
});
