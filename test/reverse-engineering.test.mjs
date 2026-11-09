// Starting from existing code (stages.json 1.4.0, lifecycle API 0.4.6), over
// HTTP, with stand-in holders: the stand-in reverse engineer under
// fixtures/fake-adlc reads the code and writes the as-built record, and no
// test reaches a model or the network. The codebases are git repositories
// made in a temporary folder.
//
//   - adoption end to end: Reverse engineering, the as-built record in five
//     parts, each behavior proposed as built, the three answers (approve, bug,
//     drop), characterization tests named by feature, and Code adopting the
//     code at its commit as the first version, through to the package;
//   - code that cannot be packaged as an agent stops at Code, in words;
//   - drift: the product's Reverse engineering turns on when the repository's
//     commit differs from the last one any build knew, and running it passes
//     the last record, so only what changed reaches Requirements.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { factory, tempDir, stageOf, actionNames } from "./helpers.mjs";
import { checkBuild as consoleCheckBuild } from "adlc-console/lib/contract.mjs";
import { checkBuild, checkArtifacts, checkFeatures, checkFeatureDecision, checkProduct, checkStageWorkspace, AS_BUILT_PARTS, run as apiCheck, stageIds, stageRoles, stageFacts } from "../standards/lifecycle-api-check.mjs";
import { STAGE_IDS } from "../lib/standards.mjs";
import { adoptable, sourceOf, treeDigest } from "../lib/adopt.mjs";

const COUNT = (extra = "") => `// count.mjs: counts the words in a passage.
// behavior: Count words: answers how many words a passage has, splitting on spaces
export function count(text) {
  // behavior: Empty passage: answers 0 for an empty passage
  // behavior: Trim spaces: ignores spaces at either end
  return String(text).trim().split(/\\s+/).filter(Boolean).length;
}
// gap: what a passage of only punctuation gives was not determined
${extra}`;

/** A git repository at dir with files { path: text }, committed. Returns its commit. */
function repo(dir, files, message = "the code") {
  mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" }).trim();
  if (!existsSync(join(dir, ".git"))) git("init", "--quiet");
  for (const [p, text] of Object.entries(files)) { mkdirSync(join(dir, ...p.split("/").slice(0, -1)), { recursive: true }); writeFileSync(join(dir, ...p.split("/")), text); }
  git("add", "-A");
  git("commit", "--quiet", "-m", message);
  return git("rev-parse", "HEAD");
}

const ok = (b) => { assert.deepEqual(checkBuild({ build: b }, STAGE_IDS), []); assert.deepEqual(consoleCheckBuild({ build: b }, STAGE_IDS), []); };
const asBuiltOf = (b) => b.artifacts.find((a) => a.kind === "as_built");

/** Answers every behavior as built: approve the first, bug the second (with words), drop the rest. */
async function triage(f, id, m) {
  const rows = m.features.filter((r) => r.pending?.as_built);
  const out = [];
  for (const [i, r] of rows.entries()) {
    const decision = i === 0 ? "approve" : i === 1 ? "bug" : "drop";
    const res = await f.post(`/builds/${id}/features/${r.id}/${decision}`, { proposal: r.pending.proposal, ...(decision === "bug" ? { words: "An empty passage should be refused, not counted." } : {}) });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.deepEqual(checkFeatureDecision(res.json, decision), [], decision);
    out.push({ id: r.id, decision, res: res.json });
  }
  return out;
}

test("adoption end to end: the as-built record, approve, bug and drop, characterization tests by feature, and the code adopted as the first version", async (t) => {
  const f = await factory();
  t.after(f.close);
  const code = join(await tempDir("code"), "word-counter");
  const commit = repo(code, { "scripts/count.mjs": COUNT(), "test/count.test.mjs": "import { test } from \"node:test\";\ntest(\"counts\", () => {});\n", "README.md": "# word counter\n" });

  // A start request that names existing code needs the product's name and the codebase.
  assert.equal((await f.post("/builds", { starting_point: "existing-code", source: { folder: code } })).status, 400);
  assert.match((await f.post("/builds", { name: "x", starting_point: "existing-code" })).json.error, /source names the codebase/);
  assert.match((await f.post("/builds", { does: "x", starting_point: "prototype" })).json.error, /does not start from prototype yet/);

  const started = await f.post("/builds", { does: "Adopt the existing code of word-counter", name: "word-counter", starting_point: "existing-code", source: { folder: code } });
  assert.equal(started.status, 201, JSON.stringify(started.json));
  ok(started.json.build);
  const id = started.json.build.id;
  let b = await f.settled(id);
  ok(b);

  // Reverse engineering ran first, at the commit, and Requirements waits on the person.
  const re = stageOf(b, "reverse-engineering");
  assert.equal(re.state, "done");
  assert.equal(re.holder.role, "reverse-engineer");
  assert.match(re.given, /at its newest commit/);
  assert.deepEqual(re.handed_back.files.map((x) => x.path).sort(), ["as-built/architecture.json", "as-built/behaviors.json", "as-built/interfaces.json", "as-built/record.json", "as-built/sbom.cdx.json", "as-built/tests-and-gaps.json"]);
  assert.equal(stageOf(b, "requirements").state, "waiting_on_you");
  assert.equal(b.source.commit, commit, "the build records the commit it knew");
  assert.equal(b.source.starting_point, "existing-code");
  assert.equal(b.source.trigger, "adoption");
  const run = f.store.read(id).run;
  assert.equal(run.process.name, "adopt existing code");
  assert.equal(run.phases["reverse-engineer"].status, "closed");
  const asked = readFileSync(join(f.store.folder(id), "stages", "reverse-engineering", "r1", "job", "message.txt"), "utf8");
  assert.match(asked, /^Reverse engineer this codebase\.\ntrigger: adoption\n/);
  assert.match(asked, new RegExp(`commit: ${commit}`));

  // The as-built record is one artifact, with a readable summary per part.
  const art = asBuiltOf(b);
  assert.equal(art.state, "made");
  assert.equal(art.stage, "reverse-engineering");
  assert.equal(art.version, commit.slice(0, 7));
  assert.deepEqual(checkArtifacts([art], STAGE_IDS), []);
  assert.deepEqual(art.summary.parts.map((p) => p.part), AS_BUILT_PARTS);
  assert.equal(art.summary.trigger, "adoption");
  assert.equal(art.summary.source.commit, commit);
  const [behaviors, arch, , deps, tests] = art.summary.parts;
  assert.equal(behaviors.count, 3);
  assert.deepEqual(behaviors.items, [
    "B1 Count words: answers how many words a passage has, splitting on spaces (scripts/count.mjs:2)",
    "B2 Empty passage: answers 0 for an empty passage (scripts/count.mjs:4)",
    "B3 Trim spaces: ignores spaces at either end (scripts/count.mjs:5)",
  ]);
  assert.ok(arch.items.includes("Entry point: scripts/count.mjs (scripts/count.mjs:1)"));
  assert.match(deps.words, /No components, in CycloneDX 1\.5/);
  assert.ok(tests.items.includes("Test: test/count.test.mjs"));
  assert.ok(tests.items.some((x) => /^Gap: what a passage of only punctuation gives was not determined \(scripts\/count\.mjs:8\)$/.test(x)));
  // Requirements is given it; a build started from an idea has no such artifact, and stage 00 says why it did not run.
  const ws = (await f.get(`/builds/${id}/stages/requirements`)).json;
  assert.ok(ws.given.includes("as_built"));
  // The gate never approves a behavior as built: it says they wait for an answer, one at a time.
  assert.deepEqual(ws.gate.features.to_approve, []);
  assert.ok(ws.gate.open.includes("F1, F2, F3 as built wait for your answer in Features: approve each one you want kept, call it a bug, or drop it. The spec is approved after that."));
  assert.deepEqual(checkStageWorkspace(ws, STAGE_IDS, "requirements"), []);
  const reWs = (await f.get(`/builds/${id}/stages/reverse-engineering`)).json;
  assert.deepEqual(reWs.outputs.map((a) => a.id), ["as_built"]);

  // Each behavior arrives as a proposed feature marked as built.
  let m = (await f.get(`/builds/${id}/features`)).json;
  assert.deepEqual(checkFeatures(m, id), []);
  assert.deepEqual(m.features.map((r) => [r.id, r.name, r.state, r.pending?.as_built?.behavior]), [["F1", "Count words", "proposed", "B1"], ["F2", "Empty passage", "proposed", "B2"], ["F3", "Trim spaces", "proposed", "B3"]]);
  assert.deepEqual(m.features[0].as_built.evidence, ["scripts/count.mjs:2"]);
  assert.equal(m.features[0].as_built.commit, commit);
  assert.equal(m.features[0].cells.spec.words, "As built, waiting for your answer");

  // The spec cannot be approved while a behavior as built waits for an answer.
  const early = await f.post(`/builds/${id}/actions/approve`);
  assert.equal(early.status, 409);
  assert.match(early.json.error, /^3 behaviors as built wait for your answer \(F1, F2, F3\)\. Approve each one you want kept, call it a bug, or drop it, then approve the spec\.$/);

  // The three answers.
  const answers = await triage(f, id, m);
  assert.deepEqual(answers.map((a) => [a.id, a.decision, a.res.proposal.state]), [["F1", "approve", "approved"], ["F2", "bug", "bug"], ["F3", "drop", "dropped"]]);
  const bug = answers[1].res;
  assert.equal(bug.fix.feature, "F2");
  assert.equal(bug.fix.behavior, "B2");
  assert.equal(bug.fix.state, "proposed");
  assert.equal(bug.fix.words, "An empty passage should be refused, not counted.");
  assert.equal(bug.feature.state, "proposed", "a bug is never approved");
  assert.ok(answers[2].res.feature.dropped);
  // A second answer to the same proposal is refused, and bug or drop needs a behavior marked as built.
  assert.equal((await f.post(`/builds/${id}/features/F2/approve`, { proposal: answers[1].res.proposal.proposal })).status, 400);
  m = (await f.get(`/builds/${id}/features`)).json;
  assert.deepEqual(checkFeatures(m, id), []);
  assert.deepEqual(m.fixes.map((x) => [x.feature, x.behavior]), [["F2", "B2"]]);
  assert.equal(m.features[1].cells.spec.words, "A bug as built: kept as a fix item, not approved");
  assert.equal(m.features[2].cells.spec.words, "Dropped: not kept");
  const history = (await f.get("/products/word-counter/features/F2")).json.history.map((h) => h.kind);
  assert.deepEqual(history, ["proposed", "bug"]);

  // Approving the spec approves nothing else: the bug stays a fix item, the dropped behavior stays dropped.
  const approved = await f.post(`/builds/${id}/actions/approve`);
  assert.equal(approved.status, 200, JSON.stringify(approved.json));
  b = await f.settled(id);
  ok(b);
  m = (await f.get(`/builds/${id}/features`)).json;
  assert.deepEqual(m.features.map((r) => r.state), ["approved", "proposed", "proposed"]);

  // Test was given parts 1 and 5 and wrote characterization tests, named by feature, for the approved behavior only.
  const job = join(f.store.folder(id), "stages", "test", "jobs", "r1");
  const said = readFileSync(join(job, "message.txt"), "utf8");
  assert.match(said, /^Write characterization tests for the agent's files attached/);
  assert.match(said, /characterization: this agent is existing code/);
  assert.match(said, /- F1 \(offering Count\): Count words\./);
  assert.doesNotMatch(said, /F2|F3/);
  const suite = readFileSync(join(job, "out", "test", "count.test.mjs"), "utf8");
  assert.match(suite, /test\("\[F1\] count words"/);
  assert.doesNotMatch(suite, /\[F2\]|\[F3\]/);
  assert.equal(stageOf(b, "test").given.includes("parts 1 and 5"), true);

  // Code adopted the code at its commit as the first version: no harness ran, and the gate passed it.
  const c = stageOf(b, "code");
  assert.equal(c.holder.kind, "outside_tool");
  assert.equal(c.state, "waiting_on_you");
  assert.equal(c.rounds[0].verdict, "The existing code passes the suite");
  assert.deepEqual(c.rounds[0].by_feature, [{ feature: "F1", passed: 1, total: 1 }]);
  assert.equal(existsSync(f.stubLog), false, "no coding harness ran");
  const script = await f.call("GET", `/builds/${id}/files?path=${encodeURIComponent("code/scripts/count.mjs")}`, undefined, { raw: true });
  assert.equal(script.text, COUNT());
  assert.deepEqual(actionNames(b), ["accept", "stop"]);

  // Your OK, and the result is an Agent Package as today.
  await f.post(`/builds/${id}/actions/accept`);
  b = await f.settled(id);
  ok(b);
  assert.equal(stageOf(b, "package").state, "done");
  assert.match(stageOf(b, "package").handed_back.words[0], /Packed word-counter 0\.1\.0 as an Agent Package/);
  // The whole service, with an adopted build in it, passes the lifecycle API check.
  const checked = await apiCheck({ base: `${f.base}/v1/lifecycle/`, key: f.key.value, ids: stageIds(), roles: stageRoles(), stages: stageFacts(), allFiles: true });
  assert.deepEqual(checked.problems, []);

  // A build started from an idea runs no Reverse engineering, and says why in words.
  const idea = await f.post("/builds", { does: "Count the words in a passage." });
  const other = await f.settled(idea.json.build.id);
  assert.equal(stageOf(other, "reverse-engineering").state, "not_offered");
  assert.match(stageOf(other, "reverse-engineering").given, /^Reverse engineering runs on existing code/);
  assert.equal(asBuiltOf(other), undefined);
  assert.equal(other.source, undefined);
});

test("a proposal that is not marked as built cannot be called a bug or dropped", async (t) => {
  const f = await factory();
  t.after(f.close);
  const code = join(await tempDir("code"), "counter");
  repo(code, { "scripts/count.mjs": COUNT() });
  const id = (await f.post("/builds", { name: "word-counter", starting_point: "existing-code", source: { folder: code } })).json.build.id;
  await f.settled(id);
  const r = f.store.read(id);
  // A feature proposed in a chat, not from the record.
  await f.store.update(id, (b) => { b.feature_log.push({ id: "fp_chat00000001", at: new Date().toISOString(), kind: "proposed", feature: "F9", name: "Count lines", does: "Counts lines too.", offering: "Count", change: "new", by: "The spec writer", from: { build: r.id, stage: "requirements", message: "t_1" } }); });
  const bug = await f.post(`/builds/${id}/features/F9/bug`, { proposal: "fp_chat00000001" });
  assert.equal(bug.status, 400);
  assert.match(bug.json.error, /^Only a behavior marked as built can be called a bug\. F9 was proposed as a new feature/);
  assert.equal((await f.post(`/builds/${id}/features/F9/drop`, { proposal: "fp_chat00000001" })).status, 400);
});

test("code that cannot be packaged as an agent stops at Code, in plain words", async (t) => {
  const f = await factory();
  t.after(f.close);
  const code = join(await tempDir("code"), "py-counter");
  repo(code, { "main.py": "# behavior: Count words: answers how many words a passage has\ndef count(text):\n    return len(text.split())\n", "util.py": "x = 1\n" });
  const id = (await f.post("/builds", { name: "py-counter", starting_point: "existing-code", source: { folder: code } })).json.build.id;
  let b = await f.settled(id);
  assert.equal(stageOf(b, "reverse-engineering").state, "done");
  const m = (await f.get(`/builds/${id}/features`)).json;
  await f.post(`/builds/${id}/features/F1/approve`, { proposal: m.features[0].pending.proposal });
  await f.post(`/builds/${id}/actions/approve`);
  b = await f.settled(id);
  ok(b);
  const c = stageOf(b, "code");
  assert.equal(b.summary, "Stopped at Code: the code cannot be packaged as an agent");
  assert.equal(c.state, "stopped");
  assert.equal(c.rounds[0].verdict, "Cannot be packaged as an agent");
  assert.match(c.handed_back.words[0], /^The codebase at [0-9a-f]{7} has no Node scripts: it is written in Python \(2 files\)\. An Agent Package runs Node 22 scripts, so this code cannot be packaged as an agent\. Product Factory adopts agents only; general software stays out of scope, so the build stops here\.$/);
  assert.equal(stageOf(b, "package").state, "not_started");
  assert.deepEqual(actionNames(b), ["archive"]);
});

test("drift: Reverse engineering turns on when the commit moves, and only what changed reaches Requirements", async (t) => {
  const f = await factory();
  t.after(f.close);
  const code = join(await tempDir("code"), "word-counter");
  const first = repo(code, { "scripts/count.mjs": COUNT() });
  const id = (await f.post("/builds", { name: "word-counter", starting_point: "existing-code", source: { folder: code } })).json.build.id;
  let b = await f.settled(id);
  let m = (await f.get(`/builds/${id}/features`)).json;
  for (const r of m.features) await f.post(`/builds/${id}/features/${r.id}/approve`, { proposal: r.pending.proposal });
  await f.post(`/builds/${id}/actions/approve`);
  await f.settled(id);
  await f.post(`/builds/${id}/actions/accept`);
  b = await f.settled(id);
  assert.equal(stageOf(b, "package").state, "done");

  // The code has not moved: the action is off, and says why.
  let p = (await f.get("/products/word-counter")).json;
  assert.deepEqual(checkProduct(p, "word-counter"), []);
  assert.deepEqual(p.source, { repository: code, commit: first, build: id, version: "0.1.0", current: first, drift: false, words: `${code} is at ${first.slice(0, 7)}, the commit 0.1.0 knew, so the code has not changed outside the lifecycle.` });
  let item = p.when_needed.find((x) => x.stage === "reverse-engineering");
  assert.equal(item.can_run, false);
  assert.match(item.why_not, /has not changed outside the lifecycle\. Reverse engineering runs when they differ\.$/);
  assert.equal((await f.post(`/builds/${id}/actions/reverse-engineering`, {})).status, 409);

  // A hand edit outside the lifecycle: one behavior changes, one is new.
  const second = repo(code, { "scripts/count.mjs": COUNT().replace("ignores spaces at either end", "ignores spaces and tabs at either end").replace("// gap:", "// behavior: Count lines: answers how many lines a passage has\n// gap:") }, "a hand edit");
  p = (await f.get("/products/word-counter")).json;
  assert.deepEqual(checkProduct(p, "word-counter"), []);
  assert.equal(p.source.drift, true);
  assert.equal(p.source.current, second);
  assert.equal(p.source.words, `The code changed outside the lifecycle: ${code} is at ${second.slice(0, 7)}, and the last build that knew it, 0.1.0, knew ${first.slice(0, 7)}.`);
  item = p.when_needed.find((x) => x.stage === "reverse-engineering");
  assert.equal(item.can_run, true);
  assert.deepEqual(item.action, { build: id, name: "reverse-engineering", label: "Reverse engineer the change", needs: [] });
  assert.equal(item.confirm.title, "Reverse engineer what changed in word-counter?");
  assert.equal(item.confirm.steps[0], p.source.words);
  assert.equal(item.confirm.to_version, "0.1.1");

  // Running it starts 0.1.1 from the code as it is now, with the last record.
  const ran = await f.post(`/builds/${id}/actions/reverse-engineering`, {});
  assert.equal(ran.status, 200, JSON.stringify(ran.json));
  assert.equal(ran.json.result.ok, true);
  assert.match(ran.json.result.words, /^Started word-counter 0\.1\.1 from the code as it is now/);
  const next = ran.json.result.build;
  const nb = await f.settled(next);
  ok(nb);
  assert.equal(nb.version, "0.1.1");
  assert.equal(nb.source.trigger, "drift");
  assert.equal(nb.source.commit, second);
  const said = readFileSync(join(f.store.folder(next), "stages", "reverse-engineering", "r1", "job", "message.txt"), "utf8");
  assert.match(said, /^Reverse engineer what changed in this codebase since the last as-built record, which is attached\.\ntrigger: drift\n/);
  assert.match(said, new RegExp(`since: ${first}`));
  const art = asBuiltOf(nb);
  assert.deepEqual(checkArtifacts([art], STAGE_IDS), []);
  assert.equal(art.summary.trigger, "drift");
  assert.equal(art.summary.since, first);
  assert.deepEqual(art.summary.parts[0].items, [
    "B3 Trim spaces: ignores spaces and tabs at either end (scripts/count.mjs:5) [changed]",
    "B4 Count lines: answers how many lines a passage has (scripts/count.mjs:8) [new]",
  ]);

  // Only the changed behaviors reach Requirements, each marked as built, the same way.
  m = (await f.get(`/builds/${next}/features`)).json;
  assert.deepEqual(checkFeatures(m, next), []);
  const pending = m.features.filter((r) => r.pending?.as_built).map((r) => [r.id, r.pending.change, r.pending.as_built.change]);
  assert.deepEqual(pending, [["F3", "changed", "changed"], ["F4", "new", "new"]]);
  assert.deepEqual(m.features.filter((r) => !r.pending).map((r) => r.id), ["F1", "F2"], "unchanged behaviors stay approved, with nothing to answer");
  // The build that knew the commit keeps the action's record, and the product reads no drift now that 0.1.1 knows the new commit.
  p = (await f.get("/products/word-counter")).json;
  assert.equal(p.source.build, next);
  assert.equal(p.source.drift, false);
  assert.match(p.when_needed.find((x) => x.stage === "reverse-engineering").last.words, /^Started word-counter 0\.1\.1/);
});

test("the codebase a start request names, the commit of a folder that is not a repository, and what can be adopted", async () => {
  const dir = await tempDir("plain");
  writeFileSync(join(dir, "a.mjs"), "export const a = 1;\n");
  assert.throws(() => sourceOf({}), /source names the codebase/);
  assert.throws(() => sourceOf({ repository: "acme/x", folder: dir }), /not both/);
  assert.throws(() => sourceOf({ folder: "relative/path" }), /not a full path/);
  assert.deepEqual(sourceOf({ repository: "acme/word-counter", commit: "3f2a9c1" }), { repository: "acme/word-counter", commit: "3f2a9c1", shown: "acme/word-counter" });
  assert.match(treeDigest(dir), /^sha256:[0-9a-f]{64}$/);
  mkdirSync(join(dir, "scripts"));
  writeFileSync(join(dir, "scripts", "count.mjs"), "export function count() {}\n");
  writeFileSync(join(dir, "scripts", "util.mjs"), "export const u = 1;\n");
  const plan = adoptable(dir, ["scripts/count.mjs"]);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.take.map((x) => x.to), ["scripts/count.mjs", "scripts/util.mjs"]);
  assert.deepEqual(plan.left, ["a.mjs"]);
  assert.match(adoptable(dir, ["scripts/tally.mjs"]).why, /^The spec names scripts\/tally\.mjs, and the codebase has no such script/);
});
