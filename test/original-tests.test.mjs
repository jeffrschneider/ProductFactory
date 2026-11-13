// The original's own tests in the suite (reverse engineer 0.3.0, test-writer
// 0.10.0), with stand-in holders: no test reaches a model or the network.
//
//   - the write-up's tests/ and support/ folders are read with its JSON parts,
//     within the same limits, and go to the test writer alone: each carried
//     test, every support file (a closure three files deep here) and a carried
//     manifest naming them with their digests; the spec writer is not given
//     them;
//   - the suite comes back with the support files under test/support/ and
//     their record; the hand-off is given the suite as one archive, so the
//     build folder keeps their layout, pins them, and Code's check runs the
//     carried test, which passes only because the closure is laid out;
//   - the features view names the carried tests as the original named them
//     and counts them as original tests, apart from the tests not tied to a
//     feature;
//   - an existing-code build carries the code's own tests the same way;
//   - a revision that drops a carried test, as the person names it, takes it
//     out of the suite;
//   - what is a test, and what a suite carries beside its tests.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { factory, tempDir, stageOf } from "./helpers.mjs";
import { checkBuild, checkStageWorkspace } from "../standards/lifecycle-api-check.mjs";
import { STAGE_IDS } from "../lib/standards.mjs";
import { readRecordFolder, carriedOf, EXTRA_FILES_MAX } from "../lib/as-built-record.mjs";
import { carriedPlace, isCarriedSuitePath, isTestFile, suiteForHandOff } from "../lib/adapters.mjs";
import { digestOf } from "../lib/fence.mjs";

const COMMIT = "bfecc9cea70c5df651db5cf2530416832c6fc68d";
const sha = (text) => createHash("sha256").update(text).digest("hex");
const ok = (b) => assert.deepEqual(checkBuild({ build: b }, STAGE_IDS), []);

// The original's own test, as its repository has it: the agent sits two folders below the top, and the
// test says a count through a helper at the top, which reads a plan, which reads the unit (three deep).
const ORIGINAL = `import { test } from "node:test";
import assert from "node:assert/strict";
import { count } from "../scripts/count.mjs";
import { say } from "../../../lib/say.mjs";

test("a passage of two words is said as two words", () => {
  assert.equal(say(count("one two")), "2 words");
});
`;
const SUPPORT = {
  "support/lib/say.mjs": `import { plan } from "./plan.mjs";\nexport const say = (n) => \`\${n} \${plan(n)}\`;\n`,
  "support/lib/plan.mjs": `import { UNIT } from "./words/unit.mjs";\nexport const plan = (n) => (n === 1 ? UNIT.one : UNIT.many);\n`,
  "support/lib/words/unit.mjs": `export const UNIT = { one: "word", many: "words" };\n`,
};
const CARRIED = [{ file: "test/words.test.mjs", at: "tests/test/words.test.mjs", imports: [{ from: "../../../lib/say.mjs", support: "support/lib/say.mjs" }] }];

/** The reverse engineer's write-up in folder dir: record.json, its five parts, and the tests and support folders. */
function writeUp(dir, { carried = CARRIED } = {}) {
  const put = (p, v) => { mkdirSync(join(dir, ...p.split("/").slice(0, -1)), { recursive: true }); writeFileSync(join(dir, ...p.split("/")), typeof v === "string" ? v : JSON.stringify(v, null, 2)); };
  put("record.json", { format: "as-built-record-v1", as_built: true, repository: "file:///work/orig", commit: COMMIT, made_by: { agent: "reverse-engineer", version: "0.3.0" } });
  put("behaviors.json", { behaviors: [{ id: "B1", name: "Count words", does: "Answers how many words a passage has.", evidence: [{ file: "scripts/count.mjs", line: 2 }], as_built: true }] });
  put("architecture.json", { settings: [], systems: [] });
  put("interfaces.json", { interfaces: [{ id: "I1", kind: "constant", name: "UNIT", module: "lib/words/unit.mjs", value: { one: "word", many: "words" } }] });
  put("sbom.cdx.json", { bomFormat: "CycloneDX", specVersion: "1.5", components: [] });
  put("tests-and-gaps.json", { tests: [{ file: "test/words.test.mjs", covers: ["B1"] }], gaps: [], carried });
  put("tests/test/words.test.mjs", ORIGINAL);
  for (const [p, text] of Object.entries(SUPPORT)) put(p, text);
  return dir;
}

test("the write-up's tests and support folders are read with its JSON parts, within the same limits, and made into a carried manifest", async () => {
  const dir = writeUp(join(await tempDir("writeup"), "as-built"));
  const got = readRecordFolder(dir);
  assert.equal(got.ok, true, got.reason);
  const paths = got.files.map((f) => f.path);
  for (const p of ["tests/test/words.test.mjs", ...Object.keys(SUPPORT)]) assert.ok(paths.includes(p), p);
  // A file outside tests/ and support/ that is not JSON is still not read.
  writeFileSync(join(dir, "notes.txt"), "not part of the record\n");
  assert.ok(!readRecordFolder(dir).files.some((f) => f.path === "notes.txt"));
  // The count limit holds them too.
  for (let i = 0; i <= EXTRA_FILES_MAX; i += 1) { mkdirSync(join(dir, "support", "many"), { recursive: true }); writeFileSync(join(dir, "support", "many", `f${i}.mjs`), "export {};\n"); }
  assert.match(readRecordFolder(dir).reason, /carries \d+ files beside its six \(other JSON files, and the original's tests and the files they import\), more than 100/);

  const at = Object.fromEntries(["tests/test/words.test.mjs", ...Object.keys(SUPPORT)].map((p) => [p, join(dir, ...p.split("/"))]));
  const carried = carriedOf(at, { carried: [...CARRIED, { file: "test/gone.test.mjs", at: "tests/test/gone.test.mjs", imports: [] }] });
  assert.deepEqual(carried.manifest, {
    carried_tests: "v1",
    tests: [
      { file: "test/words.test.mjs", at: "tests/test/words.test.mjs", sha256: sha(ORIGINAL), imports: CARRIED[0].imports },
      { file: "test/gone.test.mjs", at: "tests/test/gone.test.mjs", imports: [] },
    ],
    support: Object.keys(SUPPORT).sort().map((p) => ({ path: p, sha256: sha(SUPPORT[p]) })),
  });
  assert.deepEqual(carried.files.map((f) => [f.path, f.media_type]), [["tests/test/words.test.mjs", "text/javascript"], ...Object.keys(SUPPORT).sort().map((p) => [p, "text/javascript"])]);
  assert.equal(carriedOf(at, { carried: [] }), null, "a record that carries no test gives none");
  assert.equal(carriedPlace("out/as-built/support/lib/say.mjs"), "support/lib/say.mjs");
  assert.equal(carriedPlace("out/tests/test/words.test.mjs"), "tests/test/words.test.mjs");
  assert.equal(carriedPlace("out/as-built/behaviors.json"), null);
});

/** A build from the write-up, walked to Code: its one behavior approved, and the spec. */
async function toCode(t, opts = {}) {
  const f = await factory(opts);
  t.after(f.close);
  const rec = writeUp(join(await tempDir("record"), "as-built"));
  const started = await f.post("/builds", { name: "word-counter", starting_point: "as-built-record", source: { folder: rec } });
  assert.equal(started.status, 201, JSON.stringify(started.json));
  const id = started.json.build.id;
  const before = await f.settled(id);
  ok(before);
  const m = (await f.get(`/builds/${id}/features`)).json;
  for (const r of m.features) assert.equal((await f.post(`/builds/${id}/features/${r.id}/approve`, { proposal: r.pending.proposal })).status, 200);
  assert.equal((await f.post(`/builds/${id}/actions/approve`)).status, 200);
  const b = await f.settled(id);
  ok(b);
  return { f, id, before, b };
}

test("a build from a write-up carries the original's tests into the suite and the gate, and the features view counts them as original", async (t) => {
  const { f, id, before, b } = await toCode(t);
  const re = stageOf(before, "reverse-engineering");
  for (const p of ["as-built/tests/test/words.test.mjs", "as-built/support/lib/words/unit.mjs"]) assert.ok(re.handed_back.files.some((x) => x.path === p), p);

  // The spec writer is given the JSON parts, never the tests or the files they import.
  const asked = JSON.parse(readFileSync(join(f.store.folder(id), "stages", "requirements", "records", "r1", "asked.json"), "utf8"));
  assert.deepEqual(asked.files.map((p) => p.replace(/\\/g, "/").split("/").pop()), ["behaviors.json", "interfaces.json", "architecture.json", "tests-and-gaps.json"]);

  // The test writer was given the carried test, every support file and the manifest.
  const job = join(f.store.folder(id), "stages", "test", "jobs", "r1");
  const attached = JSON.parse(readFileSync(join(job, "attached.json"), "utf8"));
  for (const n of ["words.test.mjs", "say.mjs", "plan.mjs", "unit.mjs", "carried-r1.json"]) assert.ok(attached.includes(n), n);
  const manifest = JSON.parse(readFileSync(join(f.store.folder(id), "stages", "test", "carried-r1.json"), "utf8"));
  assert.equal(manifest.tests[0].sha256, sha(ORIGINAL));
  // The suite came back with the support files under test/support/ and their record.
  const handed = stageOf(b, "test").handed_back.files.map((x) => x.path);
  for (const p of ["test/count.test.mjs", "test/words.test.mjs", "test/support/lib/say.mjs", "test/support/lib/plan.mjs", "test/support/lib/words/unit.mjs", "test/carried-tests.json"]) assert.ok(handed.includes(p), p);

  // The hand-off laid out the build folder with the support closure in place, pinned in the lock,
  // and Code's check ran the carried test, which passes only because the closure is there.
  const build = join(f.store.folder(id), "stages", "code", "handoff", "work", "build");
  assert.equal(readFileSync(join(build, "test", "words.test.mjs"), "utf8"), ORIGINAL.replace('"../../../lib/say.mjs"', '"./support/lib/say.mjs"'));
  const lock = JSON.parse(readFileSync(join(build, "build.lock.json"), "utf8"));
  for (const p of Object.keys(SUPPORT)) assert.equal(lock.digests[`test/${p}`], digestOf(Buffer.from(SUPPORT[p])), `test/${p} is pinned`);
  const code = stageOf(b, "code");
  assert.equal(code.state, "waiting_on_you", JSON.stringify(code.rounds));
  const run = readdirSync(join(build, "test")).filter((n) => n.endsWith(".test.mjs"));
  assert.ok(run.includes("words.test.mjs"));
  assert.match(code.rounds.at(-1).words, new RegExp(`All ${run.length} test files pass`));

  // The features view: the carried test by its own name, counted as original, not among the untied.
  const tst = (await f.get(`/builds/${id}/stages/test`)).json;
  assert.deepEqual(checkStageWorkspace(tst, STAGE_IDS, "test", (await f.get(`/builds/${id}`)).json), []);
  assert.deepEqual(tst.features.original, { words: "1 original test, carried from the code being rebuilt, not tied to a feature", items: ["a passage of two words is said as two words"] });
  assert.ok(!(tst.features.untied?.items ?? []).includes("a passage of two words is said as two words"));
  const suiteArt = (await f.get(`/builds/${id}`)).json.build.artifacts.find((a) => a.id === "suite");
  assert.deepEqual(suiteArt.summary.original, ["a passage of two words is said as two words"]);
  assert.ok(!suiteArt.summary.tests.some((n) => /^\.test|support/.test(n)), "no support file is read for test names");
  const matrix = (await f.get(`/builds/${id}/features`)).json;
  assert.deepEqual(matrix.original, ["a passage of two words is said as two words"]);
  assert.ok(!(matrix.unmapped ?? []).includes("a passage of two words is said as two words"));
});

test("a revision that drops a carried test, as the person names it, takes only it out of the suite", async (t) => {
  // Code is refused (the stand-in harness writes the wrong code), so the build can be sent back to Requirements.
  const { f, id, b: atCode } = await toCode(t, { failRounds: 5, rounds: 1 });
  assert.equal(stageOf(atCode, "code").state, "refused");
  const sent = await f.post(`/builds/${id}/actions/back_to_requirements`, { changes: "Drop the original test words.test.mjs: we no longer say counts." });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  await f.settled(id);
  assert.equal((await f.post(`/builds/${id}/actions/approve`)).status, 200);
  const b = await f.settled(id);
  ok(b);
  const after = stageOf(b, "test").handed_back.files.map((x) => x.path);
  assert.ok(!after.includes("test/words.test.mjs"), "the dropped test is out of the suite");
  for (const p of ["test/carried-tests.json", "test/count.test.mjs", ...Object.keys(SUPPORT).map((x) => `test/${x}`)]) assert.ok(after.includes(p), p);
  assert.ok(stageOf(b, "test").log.some((e) => /It dropped the original test test\/words\.test\.mjs, as you named it\./.test(e.said)));
});

test("an existing-code build carries the code's own tests the same way, and the adopted code passes them in the gate", async (t) => {
  const f = await factory({ extraEnv: { PF_STUB_RE_CARRY: "1" } });
  t.after(f.close);
  const code = join(await tempDir("code"), "word-counter");
  const files = {
    "scripts/count.mjs": "// count.mjs\nexport function count(text) {\n  // behavior: Count words: answers how many words a passage has\n  return String(text).trim().split(/\\s+/).filter(Boolean).length;\n}\n",
    "test/words.test.mjs": ORIGINAL.replace('"../../../lib/say.mjs"', '"../lib/say.mjs"'),
    "lib/say.mjs": SUPPORT["support/lib/say.mjs"], "lib/plan.mjs": SUPPORT["support/lib/plan.mjs"], "lib/words/unit.mjs": SUPPORT["support/lib/words/unit.mjs"],
  };
  mkdirSync(code, { recursive: true });
  const git = (...args) => execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "-c", "commit.gpgsign=false", ...args], { cwd: code, encoding: "utf8" }).trim();
  git("init", "--quiet");
  for (const [p, text] of Object.entries(files)) { mkdirSync(join(code, ...p.split("/").slice(0, -1)), { recursive: true }); writeFileSync(join(code, ...p.split("/")), text); }
  git("add", "-A"); git("commit", "--quiet", "-m", "the code");
  const id = (await f.post("/builds", { does: "Adopt word-counter", name: "word-counter", starting_point: "existing-code", source: { folder: code } })).json.build.id;
  let b = await f.settled(id);
  ok(b);
  assert.ok(stageOf(b, "reverse-engineering").handed_back.files.some((x) => x.path === "as-built/support/lib/words/unit.mjs"));
  const m = (await f.get(`/builds/${id}/features`)).json;
  for (const r of m.features) await f.post(`/builds/${id}/features/${r.id}/approve`, { proposal: r.pending.proposal });
  assert.equal((await f.post(`/builds/${id}/actions/approve`)).status, 200);
  b = await f.settled(id);
  ok(b);
  const attached = JSON.parse(readFileSync(join(f.store.folder(id), "stages", "test", "jobs", "r1", "attached.json"), "utf8"));
  for (const n of ["words.test.mjs", "say.mjs", "plan.mjs", "unit.mjs", "carried-r1.json"]) assert.ok(attached.includes(n), n);
  const c = stageOf(b, "code");
  assert.equal(c.state, "waiting_on_you", JSON.stringify(c.rounds));
  assert.equal(c.rounds[0].verdict, "The existing code passes the suite");
  assert.equal(readFileSync(join(f.store.folder(id), "stages", "code", "handoff", "work", "build", "test", "words.test.mjs"), "utf8"), ORIGINAL.replace('"../../../lib/say.mjs"', '"./support/lib/say.mjs"'));
});

test("what is a test, and what a suite carries beside its tests", async () => {
  const dir = await tempDir("suite");
  const put = (p, text) => { mkdirSync(join(dir, ...p.split("/").slice(0, -1)), { recursive: true }); writeFileSync(join(dir, ...p.split("/")), text); };
  put("test/count.test.mjs", `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { count } from "../scripts/count.mjs";\nimport { TWO } from "./support/lib/two.mjs";\ntest("two words", () => assert.equal(count("a b"), TWO));\n`);
  put("test/support/lib/two.mjs", "export const TWO = 2;\n");

  // What is a test, and what a suite carries beside its tests.
  assert.equal(isTestFile("test/count.test.mjs"), true);
  assert.equal(isTestFile("test/support/lib/never.test.mjs"), false);
  assert.equal(isCarriedSuitePath("test/support/lib/two.mjs"), true);
  assert.equal(isCarriedSuitePath("test/carried-tests.json"), true);
  assert.equal(isCarriedSuitePath("test/support/../../x.mjs"), false);
  // Test files alone go to the hand-off loose; a suite carrying support files goes as one archive.
  const loose = [{ abs: join(dir, "test", "count.test.mjs"), path: "test/count.test.mjs", media_type: "text/javascript" }];
  assert.equal(suiteForHandOff(loose, join(dir, "suite.tar.gz")), loose);
  const packed = suiteForHandOff([...loose, { abs: join(dir, "test", "support", "lib", "two.mjs"), path: "test/support/lib/two.mjs", media_type: "text/javascript" }], join(dir, "suite.tar.gz"));
  assert.deepEqual(packed, [{ abs: join(dir, "suite.tar.gz"), media_type: "application/gzip" }]);
  assert.ok(existsSync(join(dir, "suite.tar.gz")));
});
