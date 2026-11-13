// Products, stage workspaces and each stage's chat (lifecycle API 0.4), over
// HTTP, on builds walked with stand-in holders: the stand-in agents, and a
// stand-in for the shared model caller
// (fixtures/fake-adlc/agents/spec-writer/scripts/model-caller.mjs). The
// product is built on the reference writers (a rebuild from an as-built record
// with no behaviors), whose stage chats answer; one builder, which makes new
// agents, is talked to where it runs. No test reaches a model or the network.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { factory, stageOf, actionNames, FAKE_ADLC, startRebuild } from "./helpers.mjs";
import { createKeys, KEYS_FILE } from "../lib/people.mjs";
import { checkBuild } from "adlc-console/lib/contract.mjs";
import { validate, checkProducts, checkProduct, checkStageWorkspace, checkMessages, checkMessageReply } from "../standards/lifecycle-api-check.mjs";
import { STAGE_IDS, STAGES_DOC } from "../lib/standards.mjs";
import { holderWithSkills } from "../lib/view.mjs";

/** A product "counter" on the reference writers, its first build waiting for the spec's approval. */
async function counter(t, { factory: opts = {} } = {}) {
  const f = await factory(opts);
  t.after(f.close);
  const id = await startRebuild(f, { does: "Count the words in a passage.", name: "counter" });
  await f.settled(id);
  return { f, id };
}

/** Walks the build from the spec's gate to Code's gate. */
async function toCodeGate(f, id) {
  await f.post(`/builds/${id}/actions/approve`);
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
  const { f, id } = await counter(t);

  // The product list: one product per build name, with its newest build.
  let list = await f.get("/products");
  assert.equal(list.status, 200);
  assert.deepEqual(checkProducts(list.json), []);
  assert.deepEqual(list.json.products, [{ name: "counter", latest: { build: id, version: "0.1.0", state: "waiting_on_you", at: { stage: "requirements", state: "waiting_on_you", summary: "Waiting on you at Requirements" } }, versions: ["0.1.0"] }]);

  // Requirements: the gate is open, with the build's live actions and who may answer.
  let req = (await ws(f, id, "requirements")).json;
  assert.equal(req.state, "waiting_on_you");
  assert.deepEqual(req.gate, { actions: ["approve", "changes", "stop"], state: "open", who_may: "Anyone may answer this gate: the lifecycle names no approvers for it." });
  // A rebuild is given the as-built record it was started from.
  assert.deepEqual(req.given, ["as_built"]);
  assert.deepEqual(req.outputs.map((a) => [a.id, a.state]), [["spec", "made"]]);
  // The words are stages.json's, as pinned (standards/ADLC.json), never a copy here.
  assert.equal(req.done_when, STAGES_DOC.stages.find((s) => s.id === "requirements").done_when);
  // Test has not run: what it is given is made, its suite is next, and it has no gate.
  const tst = (await ws(f, id, "test")).json;
  assert.deepEqual(tst.given, ["spec", "statement", "as_built"]);
  assert.deepEqual(tst.outputs.map((a) => [a.id, a.state]), [["suite", "next"]]);
  assert.equal(tst.gate, undefined);

  // On to Code's gate: Requirements now reads answered, by the person, with the action they took.
  let b = await toCodeGate(f, id);
  req = (await ws(f, id, "requirements")).json;
  assert.equal(req.gate.state, "answered");
  assert.deepEqual({ ...req.gate.answered, at: "x" }, { by: "Test Person", at: "x", action: "approve" });
  const code = (await ws(f, id, "code")).json;
  assert.deepEqual(code.gate.actions, ["accept", "stop"]);
  assert.equal(code.gate.state, "open");
  assert.deepEqual(code.given, ["spec", "statement", "suite"]);
  assert.deepEqual(code.outputs.map((a) => [a.id, a.state]), [["programs", "made"]]);

  // The build answer carries the artifacts, and still meets the console's checks and the lifecycle API's.
  const one = await f.get(`/builds/${id}`);
  assert.deepEqual(checkBuild(one.json, STAGE_IDS), []);
  assert.deepEqual(validate("BuildAnswer", one.json), []);
  assert.equal(one.json.build.artifacts.find((a) => a.id === "package").state, "next");

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
  assert.ok(p.activity.some((e) => e.stage === "code" && /^The build folder is laid out at /.test(e.words)));
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
  const { f, id } = await counter(t);
  await toCodeGate(f, id);
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
  // The test writer read its suite, then what it was given: the as-built record, the spec and the agent's own files (stages.json 1.6.0).
  assert.match(reply.text, /^You asked: What happens with an empty message\? I read test\/count\.test\.mjs, test\/kept-interfaces\.test\.mjs, as-built\/record\.json, .*requirements\/spec\.json, requirements\/spec\.md, requirements\/agent-descriptor\.json/);
  assert.equal(reply.proposes, undefined);

  // The agent was told its suite, what it was given, and the build's record, and nothing changed by answering.
  const prompt = readFileSync(join(f.store.folder(id), "thread", message.id, "prompt.txt"), "utf8");
  assert.match(prompt, /^You are the Test writer on a build/);
  assert.match(prompt, /What you made, The suite \(made, v1\):/);
  assert.match(prompt, /What you were given, Spec \(Requirements, made, v1\):/);
  assert.match(prompt, /What you were given, The agent's own files \(Architecture and Design, made, v1\):/);
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
  const second = await startRebuild(f, { does: "Count the words in a passage.", name: "counter" });
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
  // The stand-in harness writes the wrong code every round, so Code is refused after its one round.
  const { f, id } = await counter(t, { factory: { failRounds: 9, rounds: 1 } });

  // At Requirements: the spec writer proposes changes.
  let got = await say(f, "requirements", "Please change the price to free.");
  assert.equal(got.status, 200);
  assert.deepEqual(got.json.reply.proposes, { action: "changes", needs: { changes: "change the price to free." } });
  assert.equal(f.store.read(id).status, "waiting", "answering changed nothing");

  // The spec is approved and Code was refused: the spec writer proposes sending the build back to Requirements (0.4.7).
  const atCode = await toCodeGate(f, id);
  assert.equal(stageOf(atCode, "code").state, "refused");
  got = await say(f, "requirements", "Change the name to tally.");
  assert.deepEqual(checkMessageReply(got.json, (await f.get(`/builds/${id}`)).json), []);
  assert.deepEqual(got.json.reply.proposes, { action: "back_to_requirements", needs: { changes: "Change the name to tally." } });

  // The person confirms the spec writer's proposal with the actions route: Requirements opens again with the words.
  const p = got.json.reply.proposes;
  const sent = await f.post(`/builds/${id}/actions/${p.action}`, p.needs);
  assert.equal(sent.status, 200);
  const b = await f.settled(id);
  assert.equal(stageOf(b, "requirements").state, "waiting_on_you");
  assert.match(readFileSync(join(f.store.folder(id), "stages", "requirements", "records", "r2", "asked.json"), "utf8"), /Change the name to tally\./);
});

test("a stage nobody Product Factory can reach holds is refused in words, as is a stage the lifecycle leaves out", async (t) => {
  const { f, id } = await counter(t, { factory: { doc: { version: "0.1", organization: { used: { docs: false } } } } });
  const refused = async (stage, re, status = 400, product = "counter") => {
    const got = await f.call("POST", `/products/${product}/stages/${stage}/messages`, { text: "Hello?" });
    assert.equal(got.status, status, stage);
    assert.match(got.json.error, re, stage);
  };
  await refused("docs", /^This build's lifecycle leaves out Docs, so no agent holds it to answer\.$/);
  await refused("nowhere", /^There is no stage "nowhere"/, 404);
  // One builder holds a new agent's stages, and is talked to where it runs.
  const other = (await f.post("/builds", { does: "Say hello.", name: "greeter" })).json.build.id;
  await f.settled(other);
  await refused("code", /^Code is held by one builder: your coding harness \(node\) with the ADLC plugin, which Product Factory cannot send messages to\. Talk to it where it runs\.$/, 400, "greeter");
  assert.equal((await f.call("POST", "/products/counter/stages/test/messages", { text: "" })).status, 400);
  assert.equal((await f.call("POST", "/products/counter/stages/test/messages", { text: "x", build: "b_000000000000" })).status, 400);
  assert.equal((await f.call("POST", "/products/nothing/stages/test/messages", { text: "x" })).status, 404);
  // Nothing refused was kept.
  assert.equal(f.store.read(id).thread, undefined);
  assert.equal(f.store.read(other).thread, undefined);
});

test("a stage held by an outside tool, and a model that is not set or fails, are said in words", async (t) => {
  const { f, id } = await counter(t, { factory: { model: false } });
  const got = await say(f, "requirements", "Hello?");
  assert.equal(got.status, 409);
  assert.match(got.json.error, /^The spec writer answers through the model, and PF_T_MODEL_NAME, PF_T_MODEL_ENDPOINT, PF_T_MODEL_PROTOCOL are not set\./);
  assert.equal(f.store.read(id).thread, undefined);

  const g = await counter(t);
  await toCodeGate(g.f, g.id);
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

test("0.4.9: a stage's holder lists its skills: a reference agent's from the adlc checkout, none without a skills folder, one sentence for your coding harness", async (t) => {
  const { f, id } = await counter(t);
  // The reference spec writer: each skill by its frontmatter name and description, and its SKILL.md as written.
  const req = (await ws(f, id, "requirements")).json;
  const at = (slug) => readFileSync(join(FAKE_ADLC, "agents", "spec-writer", "skills", slug, "SKILL.md"), "utf8");
  assert.deepEqual(req.holder.skills, [
    { name: "ask-what-is-missing", description: "last, to put the open questions to the person", text: at("ask-what-is-missing") },
    { name: "write-a-spec", description: "the whole job, when someone asks for a spec of an agent", text: at("write-a-spec") },
  ]);
  assert.equal(req.holder.skills_note, undefined);
  // One builder is your coding harness, which keeps its own skills, so one sentence says so and none are listed.
  const other = (await f.post("/builds", { does: "Say hello.", name: "greeter" })).json.build.id;
  await f.settled(other);
  const code = (await ws(f, other, "code")).json;
  assert.equal(code.holder.kind, "your_agent");
  assert.equal(code.holder.skills, undefined);
  assert.equal(code.holder.skills_note, "Its skills are whatever your coding harness has installed; Product Factory cannot see them.");
  // The stand-in code critic has no skills folder, so it lists none.
  const review = (await ws(f, other, "review")).json;
  assert.equal(review.holder.kind, "reference_agent");
  assert.deepEqual(review.holder.skills, []);
  // The build's stages leave the skills out, where every stage would repeat them.
  for (const one of [id, other]) {
    const b = (await f.get(`/builds/${one}`)).json.build;
    assert.ok(b.stages.every((s) => !s.holder || (s.holder.skills === undefined && s.holder.skills_note === undefined)));
  }
});

test("0.4.9: a holder Product Factory cannot read skills for is left as it is", () => {
  const ref = { kind: "reference_agent", name: "spec-writer", role: "spec-writer" };
  assert.deepEqual(holderWithSkills(ref, null), ref);
  assert.deepEqual(holderWithSkills({ ...ref, name: "nobody", role: "requester" }, FAKE_ADLC), { ...ref, name: "nobody", role: "requester" });
  assert.deepEqual(holderWithSkills({ kind: "person", name: "Ana" }, FAKE_ADLC), { kind: "person", name: "Ana" });
  assert.deepEqual(holderWithSkills({ kind: "outside_tool", name: "the packer" }, FAKE_ADLC), { kind: "outside_tool", name: "the packer" });
  assert.equal(holderWithSkills({ kind: "contracted", name: "A review supplier", handle: "r.s@example.com" }, FAKE_ADLC).skills_note, "Its skills are whatever that agent has installed; Product Factory cannot see them.");
  assert.equal(holderWithSkills(null, FAKE_ADLC), null);
});

test("a product's documents (0.4.11): one per stage that makes one, in stages.json's order, each with the copy that stands and the versions that made it", async (t) => {
  const { f, id } = await counter(t);
  let r = await f.get("/products/counter/documents");
  assert.equal(r.status, 200);
  assert.equal(r.json.product, "counter");
  const assets = STAGES_DOC.stages.filter((s) => typeof s.asset === "string" && s.asset);
  assert.deepEqual(r.json.documents.map((d) => [d.stage, d.name, d.cadence]), assets.map((s) => [s.id, s.asset, s.cadence ?? "every_build"]));
  const doc = (stage) => r.json.documents.find((d) => d.stage === stage);
  // The spec stands as soon as Requirements made it; the suite is not made yet, and says so.
  assert.equal(doc("requirements").state, "made");
  assert.deepEqual([doc("requirements").current.build, doc("requirements").current.version, doc("requirements").current.artifact.id, doc("requirements").current.carried], [id, "0.1.0", "spec", false]);
  assert.deepEqual(doc("requirements").history.map((h) => [h.build, h.version, h.artifact]), [[id, "0.1.0", "spec"]]);
  assert.equal(doc("test").state, "not_made");
  assert.equal(doc("test").current, null);
  assert.deepEqual(doc("test").history, []);
  assert.equal(doc("test").words, "Test has not made it yet.");
  assert.ok(r.json.documents.every((d) => (d.state === "made") === (d.current !== null)));
  // Once the build reached Code's gate, the suite and the code stand too.
  await toCodeGate(f, id);
  r = await f.get("/products/counter/documents");
  assert.equal(doc("test").state, "made");
  assert.equal(doc("test").current.artifact.id, "suite");
  assert.equal(doc("code").state, "made");
  assert.equal((await f.get("/products/nobody/documents")).status, 404);
  assert.equal((await f.post("/products/counter/documents", {})).status, 405);
});
