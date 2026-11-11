// Architecture and Design (make-a-new-agent.txt v3): the reference solution
// architect writes the architecture record once the spec is approved, the
// owner answers what it asks, and the spec writer makes the agent's own files
// again within it. With the stand-in holders under fixtures/fake-adlc: no test
// reaches a model or the network.
//
//   - the record read into the lifecycle API's ArchitectureSummary (0.4.12)
//   - a build walked through the new phases, with the stage, its workspace
//     and its artifacts held to the API's checks
//   - a record that asks: the build waits for the owner's answers, and the
//     architect revises the record with them
//   - a later version carries the record forward without asking again
//   - a lifecycle that leaves the stage out, and a build on v2 of the process

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBuild } from "adlc-console/lib/contract.mjs";
import { factory, stageOf, actionNames } from "./helpers.mjs";
import { validate, checkBuild as checkBuildApi, checkStageWorkspace } from "../standards/lifecycle-api-check.mjs";
import { STAGE_IDS } from "../lib/standards.mjs";
import { architectureSummary, questionsOf, readRecord } from "../lib/architecture.mjs";
import { parse, holderOf, stageOf as phaseStage } from "../lib/orchestrator.mjs";

const fixture = (p) => readFileSync(fileURLToPath(new URL(`./fixtures/${p}`, import.meta.url)), "utf8");
const ok = (b) => {
  assert.deepEqual(checkBuild({ build: b }, STAGE_IDS), []);
  assert.deepEqual(checkBuildApi({ build: b }, STAGE_IDS, b.id), []);
};
const artifact = (b, id) => b.artifacts.find((a) => a.id === id);
const recordsOf = (f, id, n = 1) => JSON.parse(readFileSync(join(f.store.folder(id), "stages", "architecture", "records", `r${n}`, "asked.json"), "utf8"));
async function ws(f, b, stage) {
  const got = (await f.get(`/builds/${b.id}/stages/${stage}`)).json;
  assert.deepEqual(checkStageWorkspace(got, STAGE_IDS, stage, { build: b }), [], stage);
  return got;
}

test("an architecture record reads into the lifecycle API's ArchitectureSummary, every part from the record", () => {
  const text = fixture("architecture/architecture-record.md");
  const s = architectureSummary(text);
  assert.deepEqual(validate("ArchitectureSummary", s), []);
  assert.deepEqual(s.systems, ["files", "text-reasoning"]);
  // A binding still asked is left out; the rest give the product and who provided it.
  assert.deepEqual(s.bindings.files, { dev: { product: "local folder", provided_by: "customer" }, test: { product: "local folder", provided_by: "customer" } });
  assert.deepEqual(s.bindings["text-reasoning"].production, { product: "platform", provided_by: "platform" });
  assert.deepEqual(s.dependencies, [{ name: "page-reader", why: "It fetches the page and hands back its text" }]);
  assert.equal(s.kind, "plugin-on-harness");
  assert.equal(s.limits.cost, "at most 2 USD a day. The statement's owner said so.");
  assert.deepEqual(Object.keys(s.limits), ["cost", "speed", "data", "trust"]);
  assert.deepEqual(s.decisions[1], { decided: "Bind text-reasoning to platform in dev, test and production", why: "The organization chose no product for text-reasoning, so the platform's default fills each.", options: ["A model provider of the organization's own."], follows: "The install places the model in the four model settings." });
  assert.equal(s.decisions[0].options, undefined);
  // Egress per environment: whether its target enforces an allowlist, and the destinations beyond the derived set.
  assert.deepEqual(s.egress.map((e) => [e.environment, e.enforced]), [["dev", false], ["test", false], ["production", true]]);
  assert.deepEqual(s.egress[2].destinations, [{ what: "the page's own host", why: "because the page's address arrives with each request" }]);
  assert.equal(s.questions, 1);
  assert.deepEqual(questionsOf(text), [{ key: "binding-files-production", question: "Which product holds the files in production?" }]);
  assert.equal(readRecord(text).done, false);
  // Not a record, or a kind the API does not name: no summary of parts.
  assert.equal(architectureSummary("# Notes\n"), null);
  assert.equal(architectureSummary(text.replace("kind: plugin-on-harness", "kind: not settled")), null);
});

test("make-a-new-agent v3: the architecture is written after the spec's approval, then the Design within it", () => {
  const doc = parse(readFileSync(fileURLToPath(new URL("../processes/make-a-new-agent.txt", import.meta.url)), "utf8"));
  assert.equal(doc.header.version, "v3");
  const at = (id) => [phaseStage(doc, id), holderOf(doc, id), doc.phases.find((p) => p.id === id).after.join(" ")];
  assert.deepEqual(at("write-the-architecture"), ["architecture", "architect", "approve-the-spec"]);
  assert.deepEqual(at("design-the-agent"), ["architecture", "spec-writer", "write-the-architecture"]);
  assert.deepEqual(at("gather-the-features"), ["code", "features", "design-the-agent"]);
  // v2, which builds already made keep, has neither phase.
  const v2 = parse(fixture("make-a-new-agent-v2.txt"));
  assert.ok(!v2.phases.some((p) => holderOf(v2, p.id) === "architect"));
});

test("a build runs the solution architect after the spec is approved, then the spec writer's Design within its record", async (t) => {
  const f = await factory();
  t.after(f.close);
  const id = (await f.post("/builds", { does: "Count the words in a passage.", name: "counter" })).json.build.id;
  let b = await f.settled(id);
  ok(b);
  // Before the spec is approved the stage waits, held by the solution architect, and its record is next.
  assert.equal(stageOf(b, "architecture").state, "not_started");
  assert.deepEqual(stageOf(b, "architecture").holder, { kind: "reference_agent", name: "solution-architect", role: "solution-architect" });
  assert.equal(artifact(b, "architecture").state, "next");

  await f.post(`/builds/${id}/actions/approve`);
  b = await f.settled(id);
  ok(b);
  const arch = stageOf(b, "architecture");
  assert.equal(arch.state, "done");
  assert.equal(arch.done_when_met, true);
  assert.deepEqual(arch.rounds.map((r) => [r.n, r.label, r.verdict]), [[2, "Design 1", "The agent's own files made"], [1, "Round 1", "Record finished"]]);
  assert.deepEqual(arch.handed_back.files.map((x) => x.path), ["architecture/architecture-record.md", "design/agent-descriptor.json", "design/agent-runtime-requirements.json", "design/plugin.json", "design/skills/count/SKILL.md"]);

  // The architect was given the person's words and the spec as approved, as the statement, with the model settings.
  const asked = recordsOf(f, id);
  assert.match(asked.said, /^Write the architecture, with the statement attached\./);
  assert.deepEqual(asked.files.map((p) => p.replace(/\\/g, "/").split("/").pop()), ["statement.md", "spec.md"]);
  assert.match(asked.statement, /what it should do: Count the words in a passage\./);
  assert.equal(asked.model.MODEL_NAME, "stand-in-model");

  // The record, as an ArchitectureSummary, with the file served beside it.
  const a = artifact(b, "architecture");
  assert.deepEqual([a.state, a.stage, a.by, a.version], ["made", "architecture", "solution architect", "v1"]);
  assert.deepEqual(a.summary.systems, ["text-reasoning"]);
  assert.equal(a.summary.kind, "plugin-on-harness");
  assert.equal(a.summary.questions, 0);
  assert.deepEqual(a.summary.bindings["text-reasoning"].dev, { product: "platform", provided_by: "platform" });
  assert.equal(a.summary.decisions[0].why, "The organization chose no product for text-reasoning, so the platform's default fills each.");
  const got = await f.call("GET", `/builds/${id}/files?path=${encodeURIComponent("architecture/architecture-record.md")}`, undefined, { raw: true });
  assert.equal(got.status, 200);
  assert.match(got.text, /^---\nrecord: architecture-record-v1\n/);

  // The Design was given the approved spec and the record; its files stand for the agent's own files.
  const design = JSON.parse(readFileSync(join(f.store.folder(id), "stages", "architecture", "design", "records", "r1", "asked.json"), "utf8"));
  assert.match(design.said, /^answer: Make the agent's own files from the approved spec attached, within the architecture record attached\./);
  assert.deepEqual(design.files.map((p) => p.replace(/\\/g, "/").split("/").pop()), ["spec.json", "spec.md", "architecture-record.md"]);
  const own = artifact(b, "statement");
  assert.deepEqual([own.state, own.by], ["made", "spec writer"]);
  assert.ok(own.files.some((x) => x.path === "design/agent-descriptor.json"));
  const run = f.store.read(id).run;
  for (const p of ["write-the-architecture", "design-the-agent"]) assert.equal(run.phases[p].status, "closed", p);
  assert.equal(run.phases["write-the-architecture"].holder.handle, "adlc/solution-architect");
  // Each feature's run carries the Design's files, and the suite was written from them.
  const [one] = f.store.read(id).feature_runs;
  assert.match(readFileSync(join(f.store.folder(id), "runs", one.id, "given", "skills", "count", "SKILL.md"), "utf8"), /Designed within the architecture record/);

  // The stage workspace: held by the solution architect with its skills, given the spec, its outputs both made.
  const w = await ws(f, b, "architecture");
  assert.deepEqual(w.holder.skills.map((s) => s.name), ["write-the-architecture"]);
  assert.deepEqual(w.given, ["spec"]);
  assert.deepEqual(w.outputs.map((x) => [x.id, x.state]), [["statement", "made"], ["architecture", "made"]]);
  assert.equal(w.cadence, "setup");
  assert.equal(w.gate, undefined, "a record that asks nothing has no gate");

  // On to the package: it is made from the Design's files.
  await f.post(`/builds/${id}/actions/accept`);
  b = await f.settled(id);
  ok(b);
  assert.equal(stageOf(b, "package").state, "done");
  const packed = readFileSync(join(f.store.folder(id), "stages", "package", "r1", "source", "skills", "count", "SKILL.md"), "utf8");
  assert.match(packed, /Designed within the architecture record/);
});

test("a record that asks what only a person can answer waits for the owner's answers, and the architect revises it with them", async (t) => {
  const f = await factory();
  t.after(f.close);
  const id = (await f.post("/builds", { does: "Count the words in a passage. ASK-LIMIT", name: "counter" })).json.build.id;
  await f.settled(id);
  await f.post(`/builds/${id}/actions/approve`);
  let b = await f.settled(id);
  ok(b);
  assert.equal(b.summary, "Waiting on you at Architecture and Design");
  assert.equal(stageOf(b, "architecture").state, "waiting_on_you");
  assert.equal(stageOf(b, "test").state, "not_started", "nothing is designed or tested before the answers");
  assert.deepEqual(actionNames(b), ["changes", "stop"]);
  const answer = b.actions.find((x) => x.name === "changes");
  assert.deepEqual([answer.stage, answer.label, answer.needs.map((n) => [n.name, n.kind])], ["architecture", "Answer the questions", [["changes", "words"]]]);
  assert.deepEqual(stageOf(b, "architecture").handed_back.files.map((x) => x.path), ["architecture/architecture-record.md", "architecture/still-open.md"]);
  // The record is there to read, with its question open, and nothing filled in.
  const a = artifact(b, "architecture");
  assert.deepEqual([a.state, a.summary.questions], ["made", 1]);
  assert.match(a.summary.limits.cost, /^not set; asked/);
  // In the run, the solution architect asked (the runner's block) and the owner was asked it.
  const blocked = f.store.read(id).run.phases["write-the-architecture"];
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.block.text, /limit-cost: How much may this agent spend/);
  let w = await ws(f, b, "architecture");
  assert.deepEqual([w.gate.state, w.gate.actions], ["open", ["changes", "stop"]]);

  // Your answers: the architect revises the record with them, attached, and the build goes on.
  assert.equal((await f.post(`/builds/${id}/actions/changes`, {})).status, 400);
  assert.equal((await f.post(`/builds/${id}/actions/changes`, { changes: "limit-cost: 5 USD a day" })).status, 200);
  b = await f.settled(id);
  ok(b);
  const revised = recordsOf(f, id, 2);
  assert.match(revised.said, /^Revise the architecture record:\nlimit-cost: 5 USD a day/);
  assert.deepEqual(revised.answers, { "limit-cost": "5 USD a day" });
  assert.match(revised.earlier, /^---\nrecord: architecture-record-v1/);
  const arch = stageOf(b, "architecture");
  assert.equal(arch.state, "done");
  assert.deepEqual(arch.rounds.map((r) => [r.n, r.verdict]), [[3, "The agent's own files made"], [2, "Record finished"], [1, "You answered"]]);
  const done = artifact(b, "architecture");
  assert.deepEqual([done.version, done.summary.questions, done.summary.limits.cost], ["v2", 0, "5 USD a day"]);
  assert.equal(stageOf(b, "code").state, "waiting_on_you");
  w = await ws(f, b, "architecture");
  assert.deepEqual([w.gate.state, w.gate.answered.action, w.gate.answered.by], ["answered", "changes", "Test Person"]);
  const run = f.store.read(id).run;
  assert.equal(run.phases["write-the-architecture"].status, "closed");
  assert.ok(run.messages.some((m) => m.kind === "answer" && m.phase === "write-the-architecture" && /limit-cost: 5 USD a day/.test(m.text)));
});

test("a later version carries the architecture record forward unchanged, and the solution architect is not asked again", async (t) => {
  const f = await factory();
  t.after(f.close);
  const start = async (version) => {
    const r = await f.runner.start({ does: "Count the words in a passage.", name: "counter" }, undefined, version ? { version } : {});
    await f.settled(r.id);
    await f.post(`/builds/${r.id}/actions/approve`);
    return f.settled(r.id);
  };
  const first = await start(null);
  const second = await start("0.2.0");
  ok(second);
  const arch = stageOf(second, "architecture");
  assert.equal(arch.state, "done");
  assert.equal(arch.rounds.at(-1).verdict, "Unchanged since 0.1.0");
  assert.match(arch.handed_back.words[0], /^Unchanged since 0\.1\.0: the architecture record counter 0\.1\.0 finished is carried forward/);
  assert.ok(!existsSync(join(f.store.folder(second.id), "stages", "architecture", "records")), "the solution architect did not run");
  const a = artifact(second, "architecture");
  assert.deepEqual([a.state, a.version], ["made", "carried from 0.1.0"]);
  assert.deepEqual(a.summary, artifact(first, "architecture").summary);
  // The Design still runs for the new version's spec, within the carried record.
  assert.equal(arch.rounds[0].label, "Design 1");
});

test("a lifecycle that leaves out Architecture and Design: neither phase runs, and the build goes on with the agent's files as approved", async (t) => {
  const f = await factory({ doc: { version: "0.1", organization: { used: { architecture: false } } } });
  t.after(f.close);
  const id = (await f.post("/builds", { does: "Count the words in a passage.", name: "counter" })).json.build.id;
  await f.settled(id);
  await f.post(`/builds/${id}/actions/approve`);
  const b = await f.settled(id);
  // The lifecycle API's own check; the console's contract also refuses the agent's own files at a stage left out, which
  // Product Factory has always shown there (artifacts.mjs), so it is not held here.
  assert.deepEqual(checkBuildApi({ build: b }, STAGE_IDS, b.id), []);
  assert.equal(stageOf(b, "architecture").state, "not_used");
  assert.equal(stageOf(b, "code").state, "waiting_on_you");
  assert.ok(!b.artifacts.some((x) => x.id === "architecture"));
  const run = f.store.read(id).run;
  assert.match(run.phases["write-the-architecture"].record.what, /^Not run: this build's lifecycle leaves out Architecture and Design, so no architecture record is made\./);
  assert.ok(run.phases["design-the-agent"].record.files.some((x) => x.name === "agent-descriptor.json"));
  assert.ok(!existsSync(join(f.store.folder(id), "stages", "architecture")));
});
