// The product's boss (lifecycle API 0.4.1; Agent Roles §39), over HTTP, on
// builds walked with stand-in holders and a stand-in for the shared model
// caller (fixtures/fake-adlc/agents/spec-writer/scripts/model-caller.mjs),
// which reads the person's words for what kind of message they are. No test
// reaches a model or the network.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { factory, stageOf, actionNames } from "./helpers.mjs";
import { createKeys, KEYS_FILE } from "../lib/people.mjs";
import { checkBossMessages, checkBossReply, checkBossCommitments, checkMessages } from "../standards/lifecycle-api-check.mjs";
import { STAGE_IDS } from "../lib/standards.mjs";
import { nextVersion } from "../lib/boss.mjs";

/** A product "counter", its first build waiting at the spec's gate. */
async function counter(t, opts = {}) {
  const f = await factory(opts);
  t.after(f.close);
  const id = (await f.post("/builds", { does: "Count the words in a passage.", name: "counter" })).json.build.id;
  await f.settled(id);
  return { f, id };
}

/** Says something to the boss, and holds the reply to the lifecycle API 0.4.1 checks. */
async function tell(f, text, extra = {}, call = f.call) {
  const got = await call("POST", "/products/counter/boss/messages", { text, ...extra });
  if (got.status === 200) {
    const p = got.json.reply.proposes;
    const build = p && p.action !== "start_version" ? (await call("GET", `/builds/${p.build}`)).json : undefined;
    assert.deepEqual(checkBossReply(got.json, STAGE_IDS, build), [], text);
  }
  return got;
}
const frozen = (r) => JSON.stringify([r.status, r.at, r.run.events.length, r.stages]);

test("a question is answered from the product's record, and answering changes nothing", async (t) => {
  const { f, id } = await counter(t);
  const before = frozen(f.store.read(id));

  const got = await tell(f, "Where is counter now?");
  assert.equal(got.status, 200);
  const { message, reply } = got.json;
  assert.deepEqual({ ...message, id: "x", at: "x" }, { id: "x", at: "x", build: id, version: "0.1.0", from: { kind: "person", name: "Test Person" }, text: "Where is counter now?" });
  assert.deepEqual(reply.from, { kind: "agent", name: "The boss", role: "boss" });
  assert.equal(reply.text, `From the record: 0.1.0 (build ${id}) is Waiting on you at Requirements.`);
  for (const k of ["routed", "plan", "proposes", "started"]) assert.equal(reply[k], undefined, k);

  // The boss was told the product's record: its versions, the newest build stage by stage, and where it may post.
  const prompt = readFileSync(join(f.store.folder(id), "thread", message.id, "prompt.txt"), "utf8");
  assert.match(prompt, /^You are the boss of the product counter/);
  assert.match(prompt, /- requirements \(Requirements\): waiting_on_you, held by the spec writer\. Its gate is open: Anyone may answer this gate/);
  assert.match(prompt, /Stages you may post a directive to on 0\.1\.0: requirements \(the spec writer\), architecture \(the solution architect\), test \(the test writer\)\./);
  assert.equal(frozen(f.store.read(id)), before);

  // Kept as the product's boss conversation, and in no stage's chat.
  const all = (await f.get("/products/counter/boss/messages")).json;
  assert.deepEqual(checkBossMessages(all, STAGE_IDS), []);
  assert.deepEqual(all.messages.map((m) => m.id), [message.id, reply.id]);
  assert.deepEqual((await f.get("/products/counter/stages/requirements/messages")).json.messages, []);
  assert.deepEqual((await f.get("/products/counter/boss/commitments")).json, { commitments: [] });
});

test("a directive is routed into the chat of the stage that owns it, with its context and the person's words", async (t) => {
  const { f, id } = await counter(t);
  await f.post(`/builds/${id}/actions/approve`);
  const b = await f.settled(id);
  assert.deepEqual(actionNames(b), ["accept", "stop"], "the build waits at Code");

  const said = "The tests should cover an empty passage. Keep each test under a second.";
  const got = await tell(f, said);
  assert.equal(got.status, 200);
  const { reply } = got.json;
  assert.equal(reply.routed.stage, "test");
  assert.equal(reply.routed.build, id);
  assert.equal(reply.text, "That is the test writer's. I posted it in the Test chat, to the test writer, on 0.1.0. Its answer is there.");

  // In the Test chat: the boss's message, carrying the constraint in the person's own words, then the test writer's answer.
  const chat = (await f.get("/products/counter/stages/test/messages")).json;
  assert.deepEqual(checkMessages(chat, "test"), []);
  const [posted, answer] = chat.messages;
  assert.equal(posted.id, reply.routed.message_id);
  assert.deepEqual(posted.from, { kind: "agent", name: "The boss", role: "boss", stage: "test" });
  assert.deepEqual(posted.to, { role: "test-writer" });
  assert.match(posted.text, /^Add a test: The tests should cover an empty passage\./);
  assert.match(posted.text, /The person's own words: “The tests should cover an empty passage\. Keep each test under a second\.”/);
  assert.match(posted.text, new RegExp(`From the boss, for Test Person, on counter 0\\.1\\.0 \\(build ${id}\\)\\.$`));
  assert.equal(answer.from.role, "test-writer");
  const prompt = readFileSync(join(f.store.folder(id), "thread", posted.id, "prompt.txt"), "utf8");
  assert.match(prompt, /The product's boss passes on a directive from the person, with its context\. The person says:\nAdd a test:/);
  // Nothing else went anywhere: no other stage's chat holds it.
  assert.deepEqual((await f.get("/products/counter/stages/requirements/messages")).json.messages, []);

  // A directive no single stage owns: the boss asks which.
  const asked = await tell(f, "Put this somewhere sensible.");
  assert.equal(asked.json.reply.text, "Which stage owns that: Requirements or Test?");
  assert.equal(asked.json.reply.routed, undefined);
});

test("a request that changes the statement is planned, proposes the next version, then the spec writer's changes action", async (t) => {
  const { f, id } = await counter(t);
  const said = "It should also count the characters.";
  const got = await tell(f, said);
  assert.equal(got.status, 200);
  const { reply } = got.json;

  // The plan: every stage the next version runs, in order, with the gates the person meets.
  assert.deepEqual(reply.plan.map((s) => s.stage), ["requirements", "architecture", "test", "code", "package"]);
  assert.equal(reply.plan[0].words, "The spec writer revises the statement to say it.");
  assert.equal(reply.plan[3].words, "Your coding harness (node) writes the scripts until the suite passes.");
  assert.equal(reply.plan[0].gate, "You approve the spec, or ask for changes. Anyone may answer this gate: the lifecycle names no approvers for it.");
  assert.match(reply.plan[3].gate, /^You OK the code\./);
  assert.equal(reply.plan[1].gate, undefined);
  assert.equal(reply.plan[2].gate, undefined);
  assert.match(reply.text, /^That changes what the agent does\. This changes the agent's statement, so it needs version 0\.2\.0: a new build, with 0\.1\.0 as its prototype\..* You will meet these gates: Requirements \(you approve the spec, or ask for changes\), Code \(you OK the code\)\. Nothing changes until you confirm\.$/);
  assert.deepEqual({ ...reply.proposes, id: "x" }, { id: "x", build: id, action: "start_version", needs: { version: "0.2.0" }, words: "Start version 0.2.0 of counter, with 0.1.0 as its prototype?" });
  assert.equal((await f.get("/products/counter")).json.builds.length, 1, "nothing started before the person confirmed");
  assert.equal((await f.get("/products/counter/boss/messages")).json.messages.at(-1).proposes.state, "open");

  // The person confirms: the boss starts 0.2.0 through the start path, with 0.1.0 as its prototype.
  const yes = await tell(f, "Yes, start 0.2.0.", { confirms: reply.proposes.id });
  assert.equal(yes.status, 200);
  const started = yes.json.reply.started;
  assert.equal(started.version, "0.2.0");
  assert.equal(yes.json.message.confirms, reply.proposes.id);
  assert.match(yes.json.reply.text, /^I started 0\.2\.0 \(build b_[0-9a-f]+\) on your confirmation, with 0\.1\.0 as its prototype\./);
  // Then it proposes the spec writer's own action, with the person's words.
  assert.deepEqual({ ...yes.json.reply.proposes, id: "x" }, { id: "x", build: started.build, action: "changes", needs: { changes: said }, words: "Ask for changes on Requirements, 0.2.0?", when: "When Requirements of 0.2.0 waits on you, after the spec writer's first draft." });

  // The new build is the product's newest, version 0.2.0, and its first draft revised 0.1.0's statement.
  const b = await f.settled(started.build);
  assert.equal(b.version, "0.2.0");
  assert.deepEqual(actionNames(b), ["approve", "changes", "stop"]);
  const asked = JSON.parse(readFileSync(join(f.store.folder(started.build), "stages", "requirements", "records", "r1", "asked.json"), "utf8"));
  assert.match(asked.said, new RegExp(`\\nprototype: counter 0\\.1\\.0 \\(build ${id}\\): its approved spec and the agent's own files are attached, to revise\\.\\n`));
  assert.match(asked.said, /\nversion: 0\.2\.0\n/);
  assert.ok(asked.files.some((p) => p.replace(/\\/g, "/").endsWith("/out/agent/agent-descriptor.json") && p.includes(id)), asked.files.join("\n"));
  assert.deepEqual((await f.get("/products/counter")).json.builds.map((x) => x.version), ["0.2.0", "0.1.0"]);
  // A proposal is confirmed once.
  assert.equal((await tell(f, "Yes again.", { confirms: reply.proposes.id })).status, 400);

  // The person confirms Ask for changes with the build's own actions route: it goes back through the Requirements gate.
  const p = yes.json.reply.proposes;
  assert.deepEqual(checkBossReply(yes.json, STAGE_IDS, (await f.get(`/builds/${p.build}`)).json), []);
  assert.equal((await f.post(`/builds/${p.build}/actions/${p.action}`, p.needs)).status, 200);
  const after = await f.settled(p.build);
  assert.equal(stageOf(after, "requirements").rounds[1].verdict, "You asked for changes");
  const commitments = (await f.get("/products/counter/boss/commitments")).json.commitments;
  assert.equal(commitments.find((c) => c.proposal?.id === p.id).answer.state, "taken");
  assert.equal((await f.get("/products/counter/boss/messages")).json.messages.find((m) => m.proposes?.id === p.id).proposes.state, "taken");
});

test("asked to approve a gate, edit an artifact, accept a price or start without asking, the boss refuses in words", async (t) => {
  const { f, id } = await counter(t);
  const before = frozen(f.store.read(id));

  const gate = await tell(f, "Please approve the spec for me.");
  assert.equal(gate.status, 200);
  assert.equal(gate.json.reply.text, `I do not answer gates, so I have not approved anything: a gate answered by whoever proposed the work is not a gate. Requirements on 0.1.0 (build ${id}) waits at its gate. Anyone may answer this gate: the lifecycle names no approvers for it. Answer it on that stage, where its buttons are.`);
  assert.equal(gate.json.reply.proposes, undefined);
  assert.equal(frozen(f.store.read(id)), before);

  // Asked to edit the statement itself: it refuses, and proposes the stage's own action instead.
  const edit = await tell(f, "Edit the statement yourself so the price is free.");
  assert.match(edit.json.reply.text, /^I do not change what a stage made: .* The spec writer can make it: confirm Ask for changes below and it goes back through the Requirements gate of 0\.1\.0\.$/);
  assert.deepEqual({ ...edit.json.reply.proposes, id: "x" }, { id: "x", build: id, action: "changes", needs: { changes: "Edit the statement yourself so the price is free." }, words: "Ask for changes on Requirements, 0.1.0?" });

  const limit = "I will not do that: it is past my authority. I may post into this product's stage chats, propose, and start the next version when you confirm it. I commit no money, accept no price, start no build you have not confirmed, and message nobody outside this product's stages. Nothing changed.";
  assert.equal((await tell(f, "Agree to pay the supplier's price.")).json.reply.text, limit);
  assert.equal((await tell(f, "Start version 0.2.0 without asking me.")).json.reply.text, limit);
  assert.equal(frozen(f.store.read(id)), before);
  assert.equal((await f.get("/products/counter")).json.builds.length, 1);

  // A stage's action cannot be confirmed through the boss: it goes through the build's actions.
  const tried = await tell(f, "Yes.", { confirms: edit.json.reply.proposes.id });
  assert.equal(tried.status, 400);
  assert.match(tried.json.error, /^That proposal is the build's own action\. Confirm it with its button/);
  assert.equal((await tell(f, "Yes.", { confirms: "bp_nothing" })).status, 400);
  assert.equal((await tell(f, "")).status, 400);
});

test("asked what it committed, the boss answers in full, as the commitments route lists it", async (t) => {
  const { f, id } = await counter(t);
  await f.post(`/builds/${id}/actions/approve`);
  await f.settled(id);
  const routed = (await tell(f, "The tests should cover an empty passage.")).json.reply;
  const plan = (await tell(f, "It should also count the characters.")).json.reply;
  const declined = (await tell(f, "No, not now.", { declines: plan.proposes.id })).json;
  assert.match(declined.reply.text, /^All right: I have not done it\./);
  const plan2 = (await tell(f, "It should also count the lines.")).json.reply;
  const yes = (await tell(f, "Yes.", { confirms: plan2.proposes.id })).json.reply;
  await f.settled(yes.started.build);
  const dropped = (await tell(f, "Drop the empty passage test.")).json.reply;
  assert.deepEqual(dropped.dropped.map((d) => d.stage), ["test"]);
  assert.equal(dropped.text, "I told Test that the work is no longer wanted.");
  const told = (await f.get("/products/counter/stages/test/messages")).json.messages.find((m) => m.id === dropped.dropped[0].message_id);
  assert.match(told.text, /^The person withdrew this, so it is no longer wanted: “Add a test: The tests should cover an empty passage\.” Stop any work on it\./);

  const list = (await f.get("/products/counter/boss/commitments")).json;
  assert.deepEqual(checkBossCommitments(list, STAGE_IDS), []);
  const c = list.commitments;
  assert.deepEqual(c.map((x) => [x.kind, x.answer?.state ?? null]), [
    ["routed", null], ["proposed", "declined"], ["proposed", "taken"], ["started", null], ["proposed", "open"], ["dropped", null],
  ]);
  assert.equal(c[0].message_id, routed.routed.message_id);
  assert.equal(c[0].to, "the test writer, at Test");
  assert.equal(c[3].confirmation.by, "Test Person");
  assert.equal(c[3].build, yes.started.build);
  assert.equal(c[5].withdraws, c[0].id);
  assert.ok(c.every((x) => x.reply), "each names the reply it was made in");

  // The answer in words lists every one of them, the declined one too.
  const said = (await tell(f, "What did you commit on my behalf?")).json.reply.text;
  assert.match(said, /^Everything I committed on your behalf, 6 in all:\n/);
  assert.equal(said.split("\n").length, 7);
  assert.match(said, /proposed to you on 0\.1\.0: Start 0\.2\.0 of counter .* \(declined by Test Person at /);
  assert.match(said, new RegExp(`started 0\\.2\\.0 \\(build ${yes.started.build}\\) on your confirmation at `));
  assert.match(said, /told the test writer, at Test on 0\.1\.0 that work is no longer wanted/);
});

test("a model that is not set keeps nothing, and one that fails is said in words", async (t) => {
  const { f, id } = await counter(t, { model: false });
  const got = await tell(f, "Where is it?");
  assert.equal(got.status, 409);
  assert.match(got.json.error, /^The boss answers through the model, and PF_T_MODEL_NAME, PF_T_MODEL_ENDPOINT, PF_T_MODEL_PROTOCOL are not set\./);
  assert.deepEqual((await f.get("/products/counter/boss/messages")).json.messages, []);
  assert.equal(f.store.read(id).thread, undefined);

  const g = await counter(t);
  const failed = await tell(g.f, "MODEL-FAILS please");
  assert.equal(failed.status, 200);
  assert.deepEqual(failed.json.reply.from, { kind: "system", name: "Product Factory" });
  assert.equal(failed.json.reply.text, "The boss could not answer: the model service at model.example answered 503: busy. Nothing changed.");
  assert.ok(existsSync(join(g.f.store.folder(g.id), "thread", failed.json.message.id, "prompt.txt")));
  assert.equal((await g.f.call("GET", "/products/nothing/boss/messages")).status, 404);
  assert.equal((await g.f.call("PUT", "/products/counter/boss/messages", {})).status, 405);
});

const PEOPLE = {
  organization: "Example Org",
  people: [
    { name: "Ana Lee", email: "ana@example.com", role: "approver" },
    { name: "Max Member", email: "max@example.com", role: "member" },
  ],
};

test("teams rules: anyone who may see the product talks to the boss, and a gate's action is proposed only to whoever may answer it", async (t) => {
  const doc = { version: "0.1", organization: { approvers: { requirements: [{ person: "ana@example.com" }] } } };
  const { f, id } = await counter(t, { people: PEOPLE, doc });
  const keys = createKeys(join(f.config.data, KEYS_FILE));
  const as = (key) => (method, path, body) => f.call(method, path, body, { auth: key });
  const ana = as(keys.make("ana@example.com"));
  const max = as(keys.make("max@example.com"));

  // A member asks the boss to approve: refused, naming who may.
  const gate = await tell(f, "Approve the spec.", {}, max);
  assert.match(gate.json.reply.text, /Only Ana Lee \(ana@example\.com\) may answer the Requirements gate\. Answer it on that stage/);
  // A member asks to edit the statement: no proposal for them, since they may not answer that gate; the plan says who may.
  const edit = await tell(f, "Edit the statement yourself so the price is free.", {}, max);
  assert.equal(edit.json.reply.proposes.action, "start_version", "a member may start builds, so the next version is proposed");
  assert.equal(edit.json.reply.plan[0].gate, "You approve the spec, or ask for changes. Only Ana Lee (ana@example.com) may answer the Requirements gate.");
  // The approver named for the gate gets the stage's own action.
  const yes = await tell(f, "Edit the statement yourself so the price is free.", {}, ana);
  assert.equal(yes.json.reply.proposes.action, "changes");
  assert.equal(yes.json.message.from.name, "Ana Lee");

  // The member confirms the start: the build starts, and the changes action is not proposed to them.
  const started = await tell(f, "Yes, start it.", { confirms: edit.json.reply.proposes.id }, max);
  assert.equal(started.status, 200);
  assert.equal(started.json.reply.proposes, undefined);
  assert.match(started.json.reply.text, /Only Ana Lee \(ana@example\.com\) may answer the Requirements gate\. So I have not proposed it\.$/);
  await f.settled(started.json.reply.started.build);
  const c = (await max("GET", "/products/counter/boss/commitments")).json.commitments;
  assert.equal(c.find((x) => x.kind === "started").confirmation.by, "Max Member");
  // Everyone may read the conversation; without a key, nobody is answered.
  assert.equal((await ana("GET", "/products/counter/boss/messages")).status, 200);
  assert.equal((await f.call("POST", "/products/counter/boss/messages", { text: "x" }, { auth: null })).status, 401);
  assert.equal(f.store.read(id).status, "waiting");
});

test("the next version is the next minor after the newest", () => {
  assert.equal(nextVersion(["0.1.0"]), "0.2.0");
  assert.equal(nextVersion(["0.9.3", "0.10.0", "0.2.0"]), "0.11.0");
  assert.equal(nextVersion(["1.4.2"]), "1.5.0");
  assert.equal(nextVersion([]), "0.1.0");
});
