// Starting from an as-built record, and Send back to Requirements (stages.json
// 1.5.0, lifecycle API 0.4.7), over HTTP, with stand-in holders: no test
// reaches a model or the network.
//
//   - a build started from an as-built record of code kept elsewhere enters at
//     Requirements; the record is its as_built artifact, marked brought; each
//     behavior is proposed as built; the spec writer and the test writer get
//     the record's parts whole; and Code runs as for a new build, with nothing
//     adopted;
//   - the record may come from a repository, at a path in it;
//   - a record that is not whole, or a source that is wrong, is refused in words;
//   - the as-built gaps are read as the reverse engineer writes them (about,
//     why), with what and words as fallbacks;
//   - Send back to Requirements from Code: on a pull request the spec writer
//     revises the spec, the test writer revises the suite against it, and both
//     go on the same branch as one forward commit; when Code was refused on
//     this computer, the scripts written so far carry over;
//   - the Features words of a build that has not reached features, and the
//     harness command init writes.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { factory, tempDir, stageOf, actionNames } from "./helpers.mjs";
import { fakeGitHub } from "./fixtures/fake-github.mjs";
import { checkBuild as consoleCheckBuild } from "adlc-console/lib/contract.mjs";
import { checkBuild, checkArtifacts, checkFeatures, checkStageWorkspace, AS_BUILT_PARTS, run as apiCheck, stageIds, stageRoles, stageFacts } from "../standards/lifecycle-api-check.mjs";
import { STAGE_IDS } from "../lib/standards.mjs";
import { recordSourceOf, readRecordFolder } from "../lib/as-built-record.mjs";
import { gapWords } from "../lib/artifacts.mjs";
import { STARTER, CLAUDE_HARNESS } from "../lib/config.mjs";

const ok = (b) => { assert.deepEqual(checkBuild({ build: b }, STAGE_IDS), []); assert.deepEqual(consoleCheckBuild({ build: b }, STAGE_IDS), []); };
const asBuiltOf = (b) => b.artifacts.find((a) => a.kind === "as_built");
const CODE = "file:///work/orig";
const COMMIT = "bfecc9cea70c5df651db5cf2530416832c6fc68d";

/** An as-built record in the reverse engineer's shape, in folder dir: record.json, its five parts, and a schema it derived. */
function writeRecord(dir, { drop = [] } = {}) {
  const put = (p, v) => { mkdirSync(join(dir, ...p.split("/").slice(0, -1)), { recursive: true }); writeFileSync(join(dir, ...p.split("/")), JSON.stringify(v, null, 2)); };
  const files = {
    "record.json": { format: "as-built-record-v1", as_built: true, repository: CODE, commit: COMMIT, read_mode: "read", trigger: "adoption", made_by: { agent: "reverse-engineer", version: "0.1.0" } },
    "behaviors.json": { format: "as-built-behaviors-v1", behaviors: [
      { id: "B1", name: "Count words", does: "Answers how many words a passage has, splitting on spaces.", evidence: [{ file: "scripts/count.mjs", line: 2 }], as_built: true },
      { id: "B2", name: "Write the counts", does: "Writes counts.json in the count-v1 format.", evidence: [{ file: "scripts/count.mjs", line: 9 }], as_built: true },
    ] },
    "architecture.json": { format: "as-built-architecture-v1", settings: [{ name: "COUNT_LIMIT", why: "how many passages it reads" }], systems: [] },
    "interfaces.json": { format: "as-built-interfaces-v1", interfaces: [{ id: "I1", kind: "file", name: "counts.json", format: "count-v1" }], exported_functions: [{ file: "scripts/count.mjs", names: ["count"] }] },
    "sbom.cdx.json": { bomFormat: "CycloneDX", specVersion: "1.5", components: [] },
    "tests-and-gaps.json": { format: "as-built-tests-and-gaps-v1", tests: [{ file: "test/count.test.mjs", covers: ["B1"] }], gaps: [{ id: "G1", kind: "run-time-only", about: "what the code does when it runs", why: "no test command was run" }] },
    "schemas/count-v1.schema.json": { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", required: ["counts"] },
  };
  for (const [p, v] of Object.entries(files)) if (!drop.includes(p)) put(p, v);
  return dir;
}

/** A git repository at dir with the files under it committed. Returns its commit. */
function commitAll(dir) {
  const git = (...args) => execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("add", "-A");
  git("commit", "--quiet", "-m", "the record");
  return git("rev-parse", "HEAD");
}

const start = (f, source, extra = {}) => f.post("/builds", { name: "word-counter", starting_point: "as-built-record", source, ...extra });

test("start from an as-built record: Requirements first, the record brought, behaviors proposed as built, the parts given whole, and Code writing fresh code", async (t) => {
  const f = await factory();
  t.after(f.close);
  const rec = writeRecord(join(await tempDir("record"), "as-built"));

  const started = await start(f, { folder: rec });
  assert.equal(started.status, 201, JSON.stringify(started.json));
  ok(started.json.build);
  const id = started.json.build.id;
  let b = await f.settled(id);
  ok(b);

  // It entered at Requirements, under its own process; Reverse engineering did not run here, and says so.
  const run = f.store.read(id).run;
  assert.equal(run.process.name, "rebuild from an as-built record");
  assert.ok(!("reverse-engineer" in run.phases));
  assert.equal(stageOf(b, "requirements").state, "waiting_on_you");
  const re = stageOf(b, "reverse-engineering");
  assert.equal(re.state, "done");
  assert.equal(re.runs, 0);
  assert.deepEqual(re.holder, { kind: "outside_tool", name: "the as-built record you brought (made by reverse-engineer 0.1.0)", role: "reverse-engineer" });
  assert.match(re.given, /^Not run here: you brought the as-built record of code kept elsewhere \(file:\/\/\/work\/orig at bfecc9c\), from .*as-built\. The code it describes is not taken on; Code writes the code fresh\.$/);
  assert.deepEqual(re.handed_back.files.map((x) => x.path), ["as-built/record.json", "as-built/behaviors.json", "as-built/architecture.json", "as-built/interfaces.json", "as-built/sbom.cdx.json", "as-built/tests-and-gaps.json", "as-built/schemas/count-v1.schema.json"]);

  // The build says where it started, and the as_built artifact says it was brought.
  assert.equal(b.source.starting_point, "as-built-record");
  assert.equal(b.source.repository, CODE);
  assert.equal(b.source.commit, COMMIT);
  assert.deepEqual(b.source.record, { folder: rec });
  assert.match(b.source.words, /^Rebuilt from the as-built record of file:\/\/\/work\/orig at bfecc9c, read from .*\. The code it describes is not taken on; Code writes the code fresh\.$/);
  const art = asBuiltOf(b);
  assert.equal(art.state, "made");
  assert.deepEqual(checkArtifacts([art], STAGE_IDS), []);
  assert.deepEqual(art.summary.parts.map((p) => p.part), AS_BUILT_PARTS);
  assert.equal(art.summary.brought.from, rec);
  assert.match(art.summary.brought.words, /^Brought from .*\. The code it describes is not taken on; Code writes the code fresh\.$/);
  // The gap is read as the reverse engineer writes it: about, then why.
  assert.ok(art.summary.parts[4].items.includes("Gap: what the code does when it runs: no test command was run"));
  assert.ok((await f.get(`/builds/${id}/stages/requirements`)).json.given.includes("as_built"));
  assert.deepEqual(checkStageWorkspace((await f.get(`/builds/${id}/stages/reverse-engineering`)).json, STAGE_IDS, "reverse-engineering"), []);

  // Each behavior is a proposed feature marked as built, from the brought record.
  let m = (await f.get(`/builds/${id}/features`)).json;
  assert.deepEqual(checkFeatures(m, id), []);
  assert.deepEqual(m.features.map((r) => [r.id, r.name, r.pending?.as_built?.behavior]), [["F1", "Count words", "B1"], ["F2", "Write the counts", "B2"]]);
  assert.equal(m.features[0].as_built.commit, COMMIT);

  // The spec writer was given the record's parts whole, and words to keep its interfaces and settings.
  const asked = JSON.parse(readFileSync(join(f.store.folder(id), "stages", "requirements", "records", "r1", "asked.json"), "utf8"));
  const names = asked.files.map((p) => p.replace(/\\/g, "/").split("/").pop());
  assert.deepEqual(names, ["behaviors.json", "interfaces.json", "architecture.json", "tests-and-gaps.json", "count-v1.schema.json"]);
  assert.match(asked.said, /as built elsewhere: this agent is built again from the as-built record of code kept elsewhere \(file:\/\/\/work\/orig at bfecc9c\)/);
  assert.match(asked.said, /Keep the interfaces exactly as the record gives them/);
  assert.match(asked.said, /- B2 Write the counts: Writes counts\.json in the count-v1 format\. \(scripts\/count\.mjs:9\)/);

  // The spec waits for every behavior's answer, then the suite is written with the parts attached.
  assert.equal((await f.post(`/builds/${id}/actions/approve`)).status, 409);
  for (const r of m.features) assert.equal((await f.post(`/builds/${id}/features/${r.id}/approve`, { proposal: r.pending.proposal })).status, 200);
  assert.equal((await f.post(`/builds/${id}/actions/approve`)).status, 200);
  b = await f.settled(id);
  ok(b);
  const job = join(f.store.folder(id), "stages", "test", "jobs", "r1");
  const said = readFileSync(join(job, "message.txt"), "utf8");
  assert.match(said, /^Write the suite for the agent's files attached\. The code is written fresh from them/);
  assert.match(said, /Gaps the record marked: what the code does when it runs: no test command was run\./);
  const attached = JSON.parse(readFileSync(join(job, "attached.json"), "utf8"));
  for (const n of ["behaviors.json", "interfaces.json", "architecture.json", "tests-and-gaps.json", "count-v1.schema.json"]) assert.ok(attached.includes(n), n);
  assert.match(stageOf(b, "test").given, /the as-built record you brought: its behaviors, interfaces, architecture as built, and existing tests and gaps/);

  // Code ran your coding harness on a fresh build folder: nothing was adopted.
  const code = stageOf(b, "code");
  assert.equal(code.holder.kind, "your_agent");
  assert.equal(code.state, "waiting_on_you");
  assert.ok(existsSync(f.stubLog), "the coding harness ran");
  assert.ok(!existsSync(join(f.store.folder(id), "source", "code")), "no codebase was copied in");
  await f.post(`/builds/${id}/actions/accept`);
  b = await f.settled(id);
  assert.equal(stageOf(b, "package").state, "done");
  const checked = await apiCheck({ base: `${f.base}/v1/lifecycle/`, key: f.key.value, ids: stageIds(), roles: stageRoles(), stages: stageFacts(), allFiles: true });
  assert.deepEqual(checked.problems, []);
  // The product's drift is not about a record's code: it knew no codebase it took on.
  assert.equal((await f.get("/products/word-counter")).json.source, undefined);
});

test("an as-built record may come from a repository, at a path in it", async (t) => {
  const f = await factory();
  t.after(f.close);
  const repo = join(await tempDir("records"), "records");
  writeRecord(join(repo, "word-counter", "as-built"));
  const commit = commitAll(repo);
  const started = await start(f, { repository: repo, path: "word-counter/as-built" });
  assert.equal(started.status, 201, JSON.stringify(started.json));
  const b = await f.settled(started.json.build.id);
  ok(b);
  assert.deepEqual(b.source.record, { repository: repo, commit, path: "word-counter/as-built" });
  assert.match(stageOf(b, "reverse-engineering").handed_back.words[0], new RegExp(`^Read the as-built record from .* at ${commit.slice(0, 7)}, in word-counter/as-built\\.$`));
  assert.equal(stageOf(b, "requirements").state, "waiting_on_you");
  // The clone it was read from is gone.
  assert.ok(!existsSync(join(f.store.folder(b.id), "..", `.record-${b.id}`)));
});

test("a record that is not whole, and a source that is wrong, are refused in words", async (t) => {
  const f = await factory();
  t.after(f.close);
  const base = await tempDir("record");
  const whole = writeRecord(join(base, "whole"));
  assert.match((await f.post("/builds", { starting_point: "as-built-record", source: { folder: whole } })).json.error, /name is required when it starts from an as-built record/);
  assert.match((await start(f, undefined)).json.error, /^source names the as-built record/);
  assert.match((await start(f, { folder: whole, path: "x" })).json.error, /A commit and a path go with a repository/);
  assert.match((await start(f, { repository: "acme/records", path: "../up" })).json.error, /source\.path is a folder inside the repository/);
  const part = writeRecord(join(base, "part"), { drop: ["sbom.cdx.json", "interfaces.json"] });
  const r = await start(f, { folder: part });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /has no interfaces\.json, sbom\.cdx\.json, so it is not whole/);
  const loose = writeRecord(join(base, "loose"));
  writeFileSync(join(loose, "record.json"), JSON.stringify({ format: "as-built-record-v1" }));
  assert.match((await start(f, { folder: loose })).json.error, /does not name the repository and the commit it describes/);
  assert.match((await f.post("/builds", { does: "x", source: { folder: whole } })).json.error, /goes with the starting point existing-code or as-built-record/);
  assert.equal(f.store.list().length, 0, "nothing started");
  // The pieces, alone.
  assert.deepEqual(recordSourceOf({ repository: "acme/records", commit: "9b1c2d4", path: "/as-built/" }), { repository: "acme/records", commit: "9b1c2d4", path: "as-built", shown: "acme/records (as-built)" });
  assert.equal(readRecordFolder(whole).files.length, 7);
});

test("as-built gaps are read as the reverse engineer writes them, with what and words as fallbacks", () => {
  assert.equal(gapWords({ about: "what the code does when it runs", why: "no test command was run" }), "what the code does when it runs: no test command was run");
  assert.equal(gapWords({ about: "the page fetch" }), "the page fetch");
  assert.equal(gapWords({ what: "what a passage of only punctuation gives" }), "what a passage of only punctuation gives");
  assert.equal(gapWords({ words: "unclear" }), "unclear");
  assert.equal(gapWords(" plain words "), "plain words");
  assert.equal(gapWords(null), "");
});

test("the Features words of a new build at Requirements say it has not reached features, not that it was made before them", async (t) => {
  const f = await factory();
  t.after(f.close);
  const id = (await f.post("/builds", { does: "Count the words in a passage.", name: "counter" })).json.build.id;
  await f.settled(id);
  const m = (await f.get(`/builds/${id}/features`)).json;
  assert.deepEqual(m.features, []);
  assert.equal(m.backfill.offered, true);
  assert.doesNotMatch(m.words, /made before features/);
  assert.match(m.words, /^No features yet\. This build has not reached them: the spec writer proposes features at Requirements/);
});

test("the harness command init writes runs Claude Code without your plugins, hooks and MCP servers, and with your normal sign-in", () => {
  assert.deepEqual(STARTER.code.harness, CLAUDE_HARNESS);
  const h = STARTER.code.harness;
  assert.deepEqual(h.slice(h.indexOf("--setting-sources"), h.indexOf("--setting-sources") + 2), ["--setting-sources", "project"]);
  assert.ok(h.includes("--strict-mcp-config"));
  assert.ok(!h.includes("--bare"), "--bare ignores the normal sign-in");
  assert.ok(!h.includes("--mcp-config"));
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.ok(readme.includes(JSON.stringify(h).replace(/,/g, ", ")), "the README shows the same command");
});

// ---------- Send back to Requirements ----------

const BRANCH = "adlc/counter-0.1.0";
const SCRIPT = "agents/counter/scripts/count.mjs";
const RIGHT = "export function count(text) { return String(text).split(/\\s+/).filter(Boolean).length; }\n";

test("Send back to Requirements on a pull request: the spec is revised, then the suite against it, and both go on the same branch as one forward commit", async (t) => {
  const gh = await fakeGitHub();
  const f = await factory({ holder: "pull-request", github: gh, doc: { version: "0.1", organization: { used: { review: false, security: false } } } });
  t.after(async () => { await f.close(); await gh.close(); });
  const id = (await f.post("/builds", { does: "Count the words in a passage.", name: "counter" })).json.build.id;
  await f.settled(id);
  await f.post(`/builds/${id}/actions/approve`);
  let b = await f.settled(id);
  // A push passes the gate, and the build waits for your OK; you judge the spec wrong instead.
  gh.push(BRANCH, { [SCRIPT]: RIGHT });
  await f.runner.poll(id);
  b = await f.settled(id);
  assert.deepEqual(actionNames(b), ["accept", "back_to_test", "back_to_requirements", "stop"]);
  const offered = b.actions.find((a) => a.name === "back_to_requirements");
  assert.deepEqual([offered.stage, offered.label, offered.needs], ["code", "Send back to Requirements", [{ name: "changes", label: "What should change in the spec, for the spec writer", kind: "words" }]]);
  const before = { ...f.store.read(id).work.pr.digests };

  // It needs words; with them, Requirements opens again as an ask for changes.
  assert.equal((await f.post(`/builds/${id}/actions/back_to_requirements`, {})).status, 400);
  const sent = await f.post(`/builds/${id}/actions/back_to_requirements`, { changes: "Declare the address of the counting service as a setting." });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  ok(sent.json.build);
  b = await f.settled(id);
  ok(b);
  assert.equal(stageOf(b, "requirements").state, "waiting_on_you");
  assert.equal(stageOf(b, "code").state, "not_started");
  assert.deepEqual(actionNames(b), ["approve", "changes", "stop"]);
  const asked = JSON.parse(readFileSync(join(f.store.folder(id), "stages", "requirements", "records", "r2", "asked.json"), "utf8"));
  assert.match(asked.said, /^changes: Declare the address of the counting service as a setting\./);
  // The Code gate reads as answered by it, and the spec's gate as a wait of its own only once the revised spec is ready.
  const codeWs = (await f.get(`/builds/${id}/stages/code`)).json;
  assert.equal(codeWs.gate.answered.action, "back_to_requirements");
  assert.deepEqual(checkStageWorkspace(codeWs, STAGE_IDS, "code"), []);

  // You approve the revised spec: the test writer revises the suite against it.
  assert.equal((await f.post(`/builds/${id}/actions/approve`)).status, 200);
  b = await f.settled(id);
  ok(b);
  const said = readFileSync(join(f.store.folder(id), "stages", "test", "jobs", "r2", "message.txt"), "utf8");
  assert.match(said, /^Revise the suite\.\n\nThe spec was revised at Requirements: the build was sent back from Code/);
  assert.match(said, /Declare the address of the counting service as a setting\./);
  assert.equal(stageOf(b, "test").rounds[0].verdict, "Suite revised");

  // One forward commit on the same branch: the revised spec, the revised test, and the new lock; the scripts as they were.
  assert.equal(gh.pulls.size, 1);
  const files = gh.filesAt(BRANCH);
  assert.match(files["agents/counter/skills/count/SKILL.md"], /Revised as asked\./);
  assert.match(files["agents/counter/test/count.test.mjs"], /an empty passage has no words/);
  assert.equal(files[SCRIPT], RIGHT, "the coding agent's script is as it was");
  const lock = JSON.parse(files["agents/counter/build.lock.json"]);
  const pr = f.store.read(id).work.pr;
  assert.deepEqual(lock.digests, pr.digests, "the lock and the fence agree");
  assert.notEqual(pr.digests["skills/count/SKILL.md"], before["skills/count/SKILL.md"]);
  const comment = gh.comments.at(-1).body;
  assert.match(comment, /^\*\*The spec and the tests were revised\*\*/);
  // The stand-in spec writer names the agent again on a revision, so more of its files change than the skill.
  assert.match(comment, /The revised spec changed (`[^`]+`, )*`skills\/count\/SKILL\.md`\. The test writer revised `test\/count\.test\.mjs` against it\./);
  assert.match(comment, /> Declare the address of the counting service as a setting\./);
  assert.equal(stageOf(b, "code").state, "working");
  assert.deepEqual(actionNames(b), ["back_to_test", "back_to_requirements", "stop"]);
  assert.ok(stageOf(b, "code").log.some((e) => /^The revised spec and suite went to pull request #1 as [0-9a-f]{7}: /.test(e.said)));

  // The gate hears the revised commit first, and it passes the fence; the build goes on to your OK and Package.
  const { judged } = await f.runner.poll(id);
  assert.equal(judged, true);
  b = await f.settled(id);
  assert.equal(stageOf(b, "code").where.check.title, "Ready for your OK");
  await f.post(`/builds/${id}/actions/accept`);
  b = await f.settled(id);
  assert.equal(stageOf(b, "package").state, "done");

  // The run records both ways back, in the person's words, as deviations.
  const run = f.store.read(id).run;
  assert.deepEqual(run.deviations.map((d) => [d.key, d.from, d.to, d.text]), [
    ["conflict", "write-the-scripts", "approve-the-spec", "Declare the address of the counting service as a setting."],
    ["changes", "approve-the-spec", "write-the-spec", "Declare the address of the counting service as a setting."],
  ]);
  assert.deepEqual(run.events.filter((e) => e.type === "deviated").map((e) => e.action), ["back_to_requirements", "back_to_requirements"]);
});

test("Send back to Requirements when Code was refused before any pull request: the pull request then opened is watched, and its gate runs", async (t) => {
  const gh = await fakeGitHub();
  const f = await factory({ holder: "pull-request", github: gh, doc: { version: "0.1", organization: { used: { review: false, security: false } } } });
  t.after(async () => { await f.close(); await gh.close(); });
  gh.branch(BRANCH); // left over from an earlier build, so the pull request cannot be opened
  const id = (await f.post("/builds", { does: "Count the words in a passage.", name: "counter" })).json.build.id;
  await f.settled(id);
  await f.post(`/builds/${id}/actions/approve`);
  let b = await f.settled(id);
  assert.equal(stageOf(b, "code").state, "refused");
  assert.equal(gh.pulls.size, 0);
  assert.equal((await f.post(`/builds/${id}/actions/back_to_requirements`, { changes: "Say what an empty passage counts as." })).status, 200);
  b = await f.settled(id);
  await f.post(`/builds/${id}/actions/approve`);
  b = await f.settled(id);
  assert.equal(stageOf(b, "code").state, "refused", "the branch is still there");
  gh.dropBranch(BRANCH);
  await f.post(`/builds/${id}/actions/resume`);
  b = await f.settled(id);
  assert.equal(gh.pulls.size, 1);
  assert.equal(f.store.read(id).work.back_to_requirements, undefined, "the pull request was opened from the revised spec, so nothing is left to send");
  gh.push(BRANCH, { [SCRIPT]: RIGHT });
  const { judged } = await f.runner.poll(id);
  assert.equal(judged, true, "the gate runs on the push");
  b = await f.settled(id);
  assert.equal(stageOf(b, "code").where.check.title, "Ready for your OK");
});

test("Send back to Requirements when Code was refused on this computer: the spec and suite are revised, and the scripts written so far carry over", async (t) => {
  const f = await factory({ failRounds: 2, rounds: 2 });
  t.after(f.close);
  const id = (await f.post("/builds", { does: "Count the words.", name: "counter" })).json.build.id;
  await f.settled(id);
  await f.post(`/builds/${id}/actions/approve`);
  let b = await f.settled(id);
  assert.equal(stageOf(b, "code").state, "refused");
  assert.deepEqual(actionNames(b), ["resume", "back_to_requirements", "stop"]);
  assert.equal((await f.post(`/builds/${id}/actions/back_to_requirements`, { changes: "Say what an empty passage counts as." })).status, 200);
  b = await f.settled(id);
  assert.equal(stageOf(b, "requirements").state, "waiting_on_you");
  await f.post(`/builds/${id}/actions/approve`);
  b = await f.settled(id);
  ok(b);
  assert.equal(stageOf(b, "test").rounds[0].verdict, "Suite revised");
  const code = stageOf(b, "code");
  assert.equal(code.state, "waiting_on_you", "the harness passes the revised suite");
  assert.ok(code.log.some((e) => e.said === "The scripts written before the build went back to Requirements are in it, over the stubs: scripts/count.mjs."));
  assert.equal(f.store.read(id).work.back_to_requirements, undefined);
  const run = f.store.read(id).run;
  assert.deepEqual(run.deviations.map((d) => d.key), ["conflict", "changes"]);
});
