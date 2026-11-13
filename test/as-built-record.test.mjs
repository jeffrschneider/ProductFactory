// Starting from an as-built record, and Send back to Requirements (stages.json
// 1.5.0, lifecycle API 0.4.7), over HTTP, with stand-in holders: no test
// reaches a model or the network.
//
//   - a build started from an as-built record of code kept elsewhere enters at
//     Requirements; the record is its as_built artifact, marked brought; each
//     behavior is proposed as built; the spec writer and the test writer get
//     the record's parts whole; and the reference code writer writes the code
//     fresh, with nothing adopted;
//   - the record may come from a repository, at a path in it;
//   - a record that is not whole, or a source that is wrong, is refused in words;
//   - the as-built gaps are read as the reverse engineer writes them (about,
//     why), with what and words as fallbacks;
//   - Send back to Requirements from Code: when Code was refused, the spec
//     writer revises the spec, the test writer revises the suite against it,
//     and the scripts written so far carry over;
//   - the Features words of a build that has not reached features, and the
//     harness command init writes.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { factory, tempDir, stageOf, actionNames, startRebuild } from "./helpers.mjs";
import { checkBuild as consoleCheckBuild } from "adlc-console/lib/contract.mjs";
import { checkBuild, checkArtifacts, checkFeatures, checkStageWorkspace, AS_BUILT_PARTS, run as apiCheck, stageIds, stageRoles, stageFacts } from "../standards/lifecycle-api-check.mjs";
import { STAGE_IDS } from "../lib/standards.mjs";
import { recordSourceOf, readRecordFolder } from "../lib/as-built-record.mjs";
import { gapWords } from "../lib/artifacts.mjs";
import { STARTER, CLAUDE_HARNESS, BUILDER_HARNESS } from "../lib/config.mjs";

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
  // The spec keeps each behavior as the feature it was proposed as (stages.json 1.6.0), so it proposes nothing of its own:
  // the behavior's proposal, marked as built, is the one answered.
  const specArt = (await f.get(`/builds/${id}`)).json.build.artifacts.find((a) => a.id === "spec");
  assert.deepEqual(specArt.summary.features.map((x) => [x.id, x.as_built]), [["F1", "B1"], ["F2", "B2"]]);
  assert.ok(f.store.read(id).feature_log.every((e) => e.kind !== "proposed" || e.as_built));

  // The spec writer was given the record's parts whole, and words to keep its interfaces and settings.
  const asked = JSON.parse(readFileSync(join(f.store.folder(id), "stages", "requirements", "records", "r1", "asked.json"), "utf8"));
  const names = asked.files.map((p) => p.replace(/\\/g, "/").split("/").pop());
  assert.deepEqual(names, ["behaviors.json", "interfaces.json", "architecture.json", "tests-and-gaps.json", "count-v1.schema.json"]);
  assert.match(asked.said, /as built elsewhere: this agent is built again from the as-built record of code kept elsewhere \(file:\/\/\/work\/orig at bfecc9c\)/);
  assert.match(asked.said, /Keep the interfaces exactly as the record gives them/);
  // Each behavior names the feature it was proposed as, so the spec keeps that id (stages.json 1.6.0).
  assert.match(asked.said, /- B2 \(feature F2\) Write the counts: Writes counts\.json in the count-v1 format\. \(scripts\/count\.mjs:9\)/);

  // The spec waits for every behavior's answer, then the suite is written with the parts attached.
  assert.equal((await f.post(`/builds/${id}/actions/approve`)).status, 409);
  for (const r of m.features) assert.equal((await f.post(`/builds/${id}/features/${r.id}/approve`, { proposal: r.pending.proposal })).status, 200);
  assert.equal((await f.post(`/builds/${id}/actions/approve`)).status, 200);
  b = await f.settled(id);
  ok(b);
  const job = join(f.store.folder(id), "stages", "test", "jobs", "r1");
  const said = readFileSync(join(job, "message.txt"), "utf8");
  assert.match(said, /^Write the suite for the spec and the agent's files attached\. The code is written fresh from them/);
  assert.match(said, /Gaps the record marked: what the code does when it runs: no test command was run\./);
  const attached = JSON.parse(readFileSync(join(job, "attached.json"), "utf8"));
  for (const n of ["behaviors.json", "interfaces.json", "architecture.json", "tests-and-gaps.json", "count-v1.schema.json"]) assert.ok(attached.includes(n), n);
  assert.match(stageOf(b, "test").given, /the as-built record you brought: its behaviors, interfaces, architecture as built, and existing tests and gaps/);

  // The reference code writer wrote the code in a fresh build folder: nothing was adopted.
  const code = stageOf(b, "code");
  assert.deepEqual(code.holder, { kind: "reference_agent", name: "code-writer", role: "code-writer" });
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

test("with one builder set, a rebuild from an as-built record runs on the reference writers, and its settings say so", async (t) => {
  const f = await factory();
  t.after(f.close);
  const rec = writeRecord(join(await tempDir("record"), "as-built"));
  const started = await start(f, { folder: rec });
  assert.equal(started.status, 201, JSON.stringify(started.json));
  const id = started.json.build.id;
  const b = await f.settled(id);
  ok(b);
  const kept = f.store.read(id);
  assert.equal(kept.run.process.name, "rebuild from an as-built record");
  assert.equal(kept.settings.code.holder, "code-writer", "one builder makes new agents only");
  assert.equal(kept.settings.code.where, undefined);
  assert.equal(kept.work.builder, undefined, "no build folder for one builder is laid out");
  for (const [s, name] of [["requirements", "spec-writer"], ["test", "test-writer"], ["code", "code-writer"]]) {
    assert.deepEqual(stageOf(b, s).holder, { kind: "reference_agent", name, role: name }, s);
  }
  assert.equal(stageOf(b, "requirements").state, "waiting_on_you", "the reference spec writer wrote the spec");
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
  // A record with no behaviors, so nothing is proposed as built before the spec is written.
  const id = await startRebuild(f, { does: "Count the words in a passage.", name: "counter" });
  await f.settled(id);
  const m = (await f.get(`/builds/${id}/features`)).json;
  assert.deepEqual(m.features, []);
  assert.equal(m.backfill.offered, true);
  assert.doesNotMatch(m.words, /made before features/);
  assert.match(m.words, /^No features yet\. This build has not reached them: each feature of the spec comes to you at Requirements as proposed/);
});

test("the harness command init writes runs Claude Code as the one builder, with only the ADLC plugin, without your plugins, hooks and MCP servers, and with your normal sign-in", () => {
  assert.equal(STARTER.code.holder, "builder");
  assert.deepEqual(STARTER.code.harness, BUILDER_HARNESS);
  assert.deepEqual(BUILDER_HARNESS.filter((w) => !["--plugin-dir", "{plugin}"].includes(w)), CLAUDE_HARNESS);
  const h = STARTER.code.harness;
  assert.deepEqual(h.slice(h.indexOf("--plugin-dir"), h.indexOf("--plugin-dir") + 2), ["--plugin-dir", "{plugin}"]);
  assert.deepEqual(h.slice(h.indexOf("--setting-sources"), h.indexOf("--setting-sources") + 2), ["--setting-sources", "project"]);
  assert.ok(h.includes("--strict-mcp-config"));
  assert.ok(!h.includes("--bare"), "--bare ignores the normal sign-in");
  assert.ok(!h.includes("--mcp-config"));
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.ok(readme.includes(JSON.stringify(h).replace(/,/g, ", ")), "the README shows the same command");
});

// ---------- Send back to Requirements ----------

test("Send back to Requirements when Code was refused: the spec and suite are revised, and the scripts written so far carry over", async (t) => {
  const f = await factory({ failRounds: 2, rounds: 2 });
  t.after(f.close);
  const id = await startRebuild(f, { does: "Count the words.", name: "counter" });
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
