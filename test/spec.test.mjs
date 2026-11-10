// The spec (stages.json 1.6.0, spec-v1, lifecycle API 0.4.8): Requirements
// hands back the spec, the analysis of the product's functional requirements
// and capabilities, and the agent's own files are made from it at Design. Over
// HTTP with the stand-in holders (fixtures/fake-adlc): the stand-in spec
// writer files out/spec.json and out/spec.md beside out/agent/, the stand-in
// test writer finds the spec by its format and names a test per acceptance
// scenario ("[F1.A1] ...") and per kept interface ("[I1] ..."), and the
// stand-in hand-off lays the spec out in the build folder, pinned. No test
// reaches a model or the network.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { factory, tempDir, stageOf, codeDir } from "./helpers.mjs";
import { checkArtifacts, checkBuild, checkFeatures, checkStageWorkspace, validate } from "../standards/lifecycle-api-check.mjs";
import { STAGE_IDS } from "../lib/standards.mjs";
import { specPieces, specSummary, specFeatures, specOfBuild, specFilesOf, isSpec } from "../lib/spec.mjs";
import { specProposals, featureIds, interfaceIds, unmappedTests, testsOf, byFeature, registerOf, eventsOf } from "../lib/features.mjs";
import { fenceProblems, declaredHosts, digestOf } from "../lib/fence.mjs";
import { revisedSpecComment } from "../lib/pull-request.mjs";

const AT = "2026-11-09T10:00:00.000Z";
const SPEC = {
  format: "spec-v1",
  product: { name: "hn-reader", version: "0.2.0", kind: "agent" },
  purpose: "Reads the top stories of Hacker News and hands back their titles.",
  features: [
    {
      id: "F1", name: "Read the top stories", does: "Hands back the titles of the top stories.", offering: "Read",
      requirements: [
        { id: "F1.R1", shall: "The agent shall hand back at most 30 titles.", kind: "limit", exact: ["30"], verify: "test" },
        { id: "F1.R2", shall: "The agent shall stop at a line matching the stop pattern.", kind: "pattern", exact: ["^-- end --$"], verify: "test" },
      ],
      acceptance: [{ id: "F1.A1", gherkin: "Scenario: forty stories\n  Given 40 top stories\n  When it reads them\n  Then it hands back 30 titles", checks: ["F1.R1"] }],
    },
    {
      id: "F2", name: "Refuse a login", does: "Declines to sign in anywhere.", as_built: "B2",
      requirements: [{ id: "F2.R1", shall: "The agent shall refuse to sign in, saying \"I read only what is public.\"", kind: "refusal", exact: ["I read only what is public."], verify: "test" }],
      acceptance: [{ id: "F2.A1", gherkin: "Scenario: asked to sign in\n  When it is asked to sign in\n  Then it says \"I read only what is public.\"", checks: ["F2.R1"] }],
    },
  ],
  interfaces: [
    { id: "I1", kind: "command", name: "read-news --limit <n>", keep: true, about: "The command line." },
    { id: "I2", kind: "file", name: "out/stories.json", keep: false, about: "What it writes." },
  ],
  constraints: [{ id: "C1", shall: "The agent shall finish within 60 seconds.", kind: "performance", verify: "test" }],
  systems: [{ name: "Hacker News API", reach: "read", address: "https://hacker-news.firebaseio.com/v0", why: "For the stories." }],
  settings: [{ name: "limit", kind: "integer", default: 30, min: 1, max: 100, set_by: "either", about: "how many titles it hands back" }],
  price: "free",
  open: [{ key: "links", question: "Should it follow a story's link?" }],
};

// ---------- reading the spec writer's spec (lib/spec.mjs) ----------

test("the spec among a job's pieces is out/spec.json of format spec-v1, with out/spec.md beside it; any other spec.json is not it", async () => {
  const dir = await tempDir("spec-pieces");
  const at = (p, body) => { const abs = join(dir, ...p.split("/")); mkdirSync(join(abs, ".."), { recursive: true }); writeFileSync(abs, body); return { path: p, abs, media_type: "" }; };
  const json = at("out/spec.json", JSON.stringify(SPEC));
  const md = at("out/spec.md", "# hn-reader\n");
  const agent = at("out/agent/agent-descriptor.json", "{}");
  assert.deepEqual(specPieces([agent, json, md]), { json: { abs: json.abs, path: "spec.json", media_type: "application/json" }, md: { abs: md.abs, path: "spec.md", media_type: "text/markdown" } });
  // A container's spec.json (no format spec-v1) is not the spec, and then nothing is.
  const container = at("out/spec.json", JSON.stringify({ name: "a container" }));
  assert.deepEqual(specPieces([container, md]), { json: null, md: null });
  assert.deepEqual(specFilesOf([{ name: "plugin.json" }, { name: "spec.md" }, { name: "spec.json" }]).map((f) => f.name), ["spec.json", "spec.md"]);
  assert.ok(isSpec(SPEC));
});

test("the spec's summary (SpecSummary): features with requirements and scenarios, interfaces with keep, constraints, and systems, settings and price in words", () => {
  const s = specSummary(SPEC);
  assert.equal(s.product, "hn-reader 0.2.0");
  assert.deepEqual(s.features[0].requirements[1], { id: "F1.R2", shall: "The agent shall stop at a line matching the stop pattern.", kind: "pattern", exact: ["^-- end --$"] });
  assert.equal(s.features[1].as_built, "B2");
  assert.match(s.features[0].acceptance[0].gherkin, /^Scenario: forty stories\n {2}Given 40 top stories/);
  assert.deepEqual(s.interfaces, [{ id: "I1", kind: "command", name: "read-news --limit <n>", keep: true, about: "The command line." }, { id: "I2", kind: "file", name: "out/stories.json", keep: false, about: "What it writes." }]);
  assert.deepEqual(s.constraints, ["C1 (performance): The agent shall finish within 60 seconds."]);
  assert.deepEqual(s.systems, ["Hacker News API (read): https://hacker-news.firebaseio.com/v0, for the stories."]);
  assert.deepEqual(s.settings, ["limit (integer, default 30, 1 to 100, set by either): how many titles it hands back"]);
  assert.equal(s.price, "free");
  assert.deepEqual(s.open, ["Should it follow a story's link?"]);
  // A spec artifact carrying it is one the lifecycle API's check accepts.
  assert.deepEqual(checkArtifacts([{ id: "spec", stage: "requirements", name: "Spec", by: "spec writer", state: "made", kind: "spec", version: "v1", at: AT, summary: s, files: [] }], STAGE_IDS), []);
  assert.deepEqual(specFeatures(SPEC).map((f) => [f.id, f.as_built]), [["F1", ""], ["F2", "B2"]]);
});

// ---------- the spec's features, and the tests named by its scenarios (lib/features.mjs) ----------

test("each feature of the spec is proposed by its own id; one held in the same words, or kept from the as-built record, proposes nothing", () => {
  const build = { id: "b1", version: "0.2.0", created: AT, feature_log: [] };
  let n = 0;
  const newId = (p) => `${p}_${++n}`;
  const first = specProposals([build], specFeatures(SPEC), { build: "b1", at: AT, newId });
  assert.deepEqual(first.map((e) => [e.feature, e.name, e.change, e.by, e.from.stage]), [["F1", "Read the top stories", "new", "The spec writer", "requirements"], ["F2", "Refuse a login", "new", "The spec writer", "requirements"]]);
  // Approved, the same spec proposes nothing again; a changed feature is proposed as a change.
  build.feature_log = [...first, ...first.map((e) => ({ id: newId("fd"), at: AT, kind: "approved", via: "gate", feature: e.feature, proposal: e.id, by: "Test Person" }))];
  assert.deepEqual(specProposals([build], specFeatures(SPEC), { build: "b1", at: AT, newId }), []);
  const changed = specProposals([build], [{ ...specFeatures(SPEC)[0], does: "Hands back the titles of the top 30 stories." }], { build: "b1", at: AT, newId });
  assert.deepEqual(changed.map((e) => [e.feature, e.change, e.was.does]), [["F1", "changed", "Hands back the titles of the top stories."]]);
  // A behavior proposed as built is answered through its own proposal: the spec neither proposes it again nor replaces it.
  const rebuilt = { id: "b2", version: "0.1.0", created: AT, feature_log: [{ id: "fp_b", at: AT, kind: "proposed", feature: "F2", name: "Refuse a login", does: "Says no to a login.", offering: "", change: "new", as_built: { behavior: "B2", evidence: [] }, by: "The as-built record you brought", from: { build: "b2", stage: "reverse-engineering" } }] };
  assert.deepEqual(specProposals([rebuilt], specFeatures(SPEC), { build: "b2", at: AT, newId }).map((e) => e.feature), ["F1"]);
  assert.deepEqual(specProposals([rebuilt], [{ id: "F2", name: "Refuse a login", does: "Declines.", offering: "" }], { build: "b2", at: AT, newId }), [], "a pending behavior as built is not replaced");
});

test("a test named by an acceptance scenario counts for its feature; a kept interface's or a constraint's test checks no feature and is not unmapped; [F1] still works", () => {
  assert.deepEqual(featureIds("[F1.A1] forty stories"), ["F1"]);
  assert.deepEqual(featureIds("[F1.A1, F2.A1] both"), ["F1", "F2"]);
  assert.deepEqual(featureIds("[F2.R1] a requirement"), ["F2"]);
  assert.deepEqual(featureIds("[F3] the old way"), ["F3"]);
  assert.deepEqual(featureIds("[I1] read-news keeps its flags"), []);
  assert.deepEqual(interfaceIds("[I1] read-news keeps its flags"), ["I1"]);
  // A constraint's test (the test writer's "[C1] ...") is tied to no feature either.
  assert.deepEqual(featureIds("[C1] finishes within 60 seconds"), []);
  assert.deepEqual(interfaceIds("[C1] finishes within 60 seconds"), ["C1"]);
  const names = ["[F1.A1] forty stories", "[F1.A2] none", "[F3] the old way", "[I1] read-news keeps its flags", "[C1] finishes within 60 seconds", "a plain test"];
  const reg = registerOf(eventsOf([{ id: "b1", version: "0.1.0", feature_log: [
    { id: "p1", at: AT, kind: "proposed", feature: "F1", name: "a", does: "b", offering: "" },
    { id: "p3", at: AT, kind: "proposed", feature: "F3", name: "c", does: "d", offering: "" },
  ] }]));
  assert.deepEqual(testsOf(names, reg.get("F1")), ["[F1.A1] forty stories", "[F1.A2] none"]);
  assert.deepEqual(unmappedTests(names, reg), ["a plain test"]);
  assert.deepEqual(byFeature(names, ["[F1.A2] none"]), [{ feature: "F1", passed: 1, total: 2 }, { feature: "F3", passed: 1, total: 1 }]);
});

// ---------- end to end ----------

test("Requirements hands back the spec: its features come to you as proposed, Test is given spec.json, and the build folder carries the spec, pinned", async (t) => {
  const f = await factory({ rounds: 1 });
  t.after(f.close);
  const id = (await f.post("/builds", { does: "Count the words in a passage.", name: "counter", more: "spec feature: Count words - Counts the words in a passage." })).json.build.id;
  let b = await f.settled(id);
  assert.deepEqual(checkBuild({ build: b }, STAGE_IDS, id), []);

  // The spec is Requirements' artifact; the agent's own files sit at Architecture and Design, made from it.
  const spec = b.artifacts.find((a) => a.id === "spec");
  assert.deepEqual([spec.stage, spec.kind, spec.name, spec.state, spec.version], ["requirements", "spec", "Spec", "made", "v1"]);
  assert.deepEqual(spec.summary.features.map((x) => [x.id, x.name, x.requirements.length, x.acceptance.map((a) => a.id)]), [["F1", "Count words", 1, ["F1.A1"]]]);
  assert.deepEqual(spec.summary.interfaces, [{ id: "I1", kind: "function", name: "count", keep: true, about: "Counts the words in text." }]);
  assert.deepEqual(spec.files.map((x) => x.path), ["requirements/spec.json", "requirements/spec.md"]);
  const own = b.artifacts.find((a) => a.id === "statement");
  assert.deepEqual([own.stage, own.kind, own.name, own.state], ["architecture", "statement", "The agent's own files", "made"]);
  assert.equal(own.summary.features, undefined, "the feature list is the spec's");
  assert.ok(!own.files.some((x) => /spec\.(json|md)$/.test(x.path)));
  const req = (await f.get(`/builds/${id}/stages/requirements`)).json;
  assert.deepEqual(checkStageWorkspace(req, STAGE_IDS, "requirements", { build: b }), []);
  assert.deepEqual(req.outputs.map((a) => a.id), ["spec"]);

  // Its feature is proposed by the spec writer, by the spec's id, and the gate starts building with it.
  const log = f.store.read(id).feature_log;
  assert.deepEqual(log.map((e) => [e.kind, e.feature, e.name, e.by, e.spec]), [["proposed", "F1", "Count words", "The spec writer", true]]);
  assert.deepEqual(req.gate.features.to_approve.map((x) => x.id), ["F1"]);
  assert.match(stageOf(b, "requirements").log.map((e) => e.said).join(" "), /1 feature of the spec goes to you as proposed: F1\./);

  // Approving the spec approves the feature; Test is given the spec (spec.json) with the agent's own files.
  await f.post(`/builds/${id}/actions/approve`);
  b = await f.settled(id);
  const attached = JSON.parse(readFileSync(join(codeDir(f, id), "stages", "test", "jobs", "r1", "attached.json"), "utf8"));
  assert.deepEqual(attached, ["spec.json", "agent-descriptor.json", "agent-runtime-requirements.json", "plugin.json", "SKILL.md"]);
  assert.match(stageOf(b, "test").given, /^The spec from Requirements, as you approved it \(spec\.json\), and the agent's own files made from it at Design/);
  const suite = b.artifacts.find((a) => a.id === "suite");
  assert.deepEqual(suite.summary.tests, ["[F1.A1] count words", "[I1] count is exported, as the spec keeps it"]);

  // The hand-off laid the spec out in the build folder and pinned it; AGENTS.md says to read it first.
  const folder = join(codeDir(f, id), "stages", "code", "handoff", "work", "build");
  const lock = JSON.parse(readFileSync(join(folder, "build.lock.json"), "utf8"));
  for (const p of ["spec.json", "spec.md", "agent-descriptor.json"]) assert.equal(lock.digests[p], digestOf(readFileSync(join(folder, p))), `${p} is pinned`);
  assert.deepEqual(JSON.parse(readFileSync(join(folder, "spec.json"), "utf8")).features.map((x) => x.id), ["F1"]);
  assert.match(readFileSync(join(folder, "AGENTS.md"), "utf8"), /Read the spec first: spec\.md, and spec\.json beside it\./);
  assert.match(stageOf(b, "code").given, /^The spec, the agent's files and the suite, laid out as a build folder/);

  // The round reports F1 by its scenario's test, and the matrix maps it; the kept interface's test is not unmapped.
  const round = stageOf(b, "code").rounds.at(-1);
  assert.deepEqual(round.by_feature, [{ feature: "F1", passed: 1, total: 1 }]);
  const m = (await f.get(`/builds/${id}/features`)).json;
  assert.deepEqual(checkFeatures(m, id), []);
  const row = m.features.find((x) => x.id === "F1");
  assert.deepEqual(row.tests, ["[F1.A1] count words"]);
  assert.deepEqual([row.cells.spec.state, row.cells.spec.link.artifact, row.cells.tests.words, row.cells.code.words], ["done", "spec", "Tests 1/1", "Passes 1/1"]);
  assert.deepEqual(m.unmapped, [], "the feature's test writer wrote that feature's tests alone");
});

test("a spec writer from before stages.json 1.6.0 hands back no spec: the spec reads not made, the build goes on from the agent's own files, and the hand-off is given none", async (t) => {
  const f = await factory({ rounds: 1, extraEnv: { FAKE_NO_SPEC: "1" } });
  t.after(f.close);
  const id = (await f.post("/builds", { does: "Count the words in a passage.", name: "counter" })).json.build.id;
  let b = await f.settled(id);
  assert.deepEqual(checkBuild({ build: b }, STAGE_IDS, id), []);
  const spec = b.artifacts.find((a) => a.id === "spec");
  assert.equal(spec.state, "not_made");
  assert.match(spec.summary.words, /no spec \(spec\.json, format spec-v1\)/);
  assert.equal(specOfBuild(f.store.read(id), f.store.folder(id)), null);
  assert.equal(b.artifacts.find((a) => a.id === "statement").state, "made");
  await f.post(`/builds/${id}/actions/approve`);
  b = await f.settled(id);
  const attached = JSON.parse(readFileSync(join(codeDir(f, id), "stages", "test", "jobs", "r1", "attached.json"), "utf8"));
  assert.ok(!attached.includes("spec.json"));
  const folder = join(codeDir(f, id), "stages", "code", "handoff", "work", "build");
  const lock = JSON.parse(readFileSync(join(folder, "build.lock.json"), "utf8"));
  assert.equal(lock.digests["spec.json"], undefined);
  assert.equal(stageOf(b, "code").rounds.at(-1).verdict, "The suite passes");
});

test("a container agent's draft at out/agent/spec.json is not the spec: it keeps its agent/ folder, and only the spec goes on", async (t) => {
  const f = await factory({ rounds: 1, extraEnv: { FAKE_CONTAINER_DRAFT: "1" } });
  t.after(f.close);
  const id = (await f.post("/builds", { does: "Count the words in a passage.", name: "counter" })).json.build.id;
  const b = await f.settled(id);
  const paths = stageOf(b, "requirements").handed_back.files.map((x) => x.path);
  assert.ok(paths.includes("requirements/spec.json") && paths.includes("requirements/agent/spec.json"), paths.join(", "));
  const spec = b.artifacts.find((a) => a.id === "spec");
  assert.equal(spec.state, "made");
  assert.deepEqual(spec.files.map((x) => x.path), ["requirements/spec.json", "requirements/spec.md"]);
  const delivered = f.store.read(id).run.events.filter((e) => e.type === "replied" && e.verdict === "delivered").at(-1).files.map((x) => x.name);
  assert.deepEqual(delivered.filter((n) => /spec/.test(n)), ["spec.json", "spec.md"], "the draft is not delivered as the spec");
});

// ---------- on a pull request (lib/fence.mjs, lib/pull-request.mjs) ----------

test("on a pull request the spec is pinned like the agent's files: a change to it goes back through the spec and test steps, and its systems' addresses are declared hosts", () => {
  const json = Buffer.from(JSON.stringify(SPEC));
  const md = Buffer.from("# hn-reader\n");
  const issued = { digests: { "spec.json": digestOf(json), "spec.md": digestOf(md), "test/a.test.mjs": "sha256:t" }, repoFiles: {}, hosts: [] };
  const files = new Map([["spec.json", json], ["spec.md", Buffer.from("# hn-reader, changed\n")], ["test/a.test.mjs", Buffer.from("x")]]);
  const problems = fenceProblems(issued, files);
  assert.deepEqual(problems.find((p) => p.path === "spec.md"), { path: "spec.md", what: "was changed; a change to a test or the spec goes back through the spec and test steps" });
  assert.ok(!problems.some((p) => p.path === "spec.json"));
  assert.ok(declaredHosts(issued, files).includes("hacker-news.firebaseio.com"));
  // After Send back to Requirements, the comment names the spec's own files apart from what was made from it.
  const said = revisedSpecComment([{ path: "spec.json" }, { path: "spec.md" }, { path: "plugin.json" }, { path: "test/a.test.mjs" }], [], "Keep the stop pattern.", "abcdef1234567");
  assert.match(said, /The revised spec changed `spec\.json`, `spec\.md`\. The files made from it changed: `plugin\.json`\. The test writer revised `test\/a\.test\.mjs` against it\./);
  assert.deepEqual(validate("SpecSummary", specSummary(SPEC)), []);
});
