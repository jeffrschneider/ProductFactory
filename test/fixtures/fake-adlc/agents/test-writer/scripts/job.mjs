// A stand-in for the reference test writer's job.mjs: the same command line,
// no model. It writes one test file for scripts/count.mjs. With the spec
// attached (spec.json, format spec-v1, stages.json 1.6.0) it adds one test per
// acceptance scenario, named by its id ("[F1.A1] <scenario>"), and a
// kept-interfaces.test.mjs with one test per kept interface ("[I1] ...").
// Without one, when the message lists approved features ("- F1 (offering
// Count): <name>. <does>"), it adds one test per feature, named "[F1] <name>".
// A feature whose name or words say "fails" gets a test no script can pass.
//
// One feature's tests (test-writer 0.11.0): when the message has a line
// "feature: F2", it writes that feature's tests alone, in a file named for it
// (test/f2.test.mjs), and nothing else but kept-interfaces.test.mjs, which is
// the same bytes in every feature's run. A revision rewrites the feature's
// own file when one came with it.
//
// The original's own tests (test-writer 0.10.0): with a carried manifest
// attached (carried_tests v1, tests and support), it places each test by its
// digest at out/test/<name> with the listed import specifiers pointed at
// ./support/<path>, each support file at out/test/support/<path>, and their
// record at out/test/carried-tests.json. In a revision whose words say "drop
// the original test <name>", it hands back the record with that test dropped.
import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";

const o = { files: [] };
const a = process.argv.slice(2);
for (let i = 0; i < a.length; i++) {
  if (a[i] === "--job") o.job = a[++i];
  else if (a[i] === "--records") o.records = a[++i];
  else if (a[i] === "--work") o.work = a[++i];
  else if (a[i] === "--text-file") o.text = a[++i];
  else if (a[i] === "--file") o.files.push(a[++i].split("::")[0]);
}
if (!o.job || !o.records || !o.work) { console.log(JSON.stringify({ ok: false, reply: "The job command needs --job, --records and --work." })); process.exit(1); }
if (!process.env.MODEL_NAME) { console.log(JSON.stringify({ ok: false, code: 1, reply: "MODEL_NAME is not set." })); process.exit(1); }
const descriptor = o.files.find((f) => f.endsWith("agent-descriptor.json") && existsSync(f));
if (!descriptor) { console.log(JSON.stringify({ ok: false, code: 3, reply: "Nothing attached is the agent's files." })); process.exit(0); }
mkdirSync(join(o.job, "out", "test"), { recursive: true });
// What it was given, by file name, so the tests can see the attachments.
writeFileSync(join(o.job, "attached.json"), JSON.stringify(o.files.map((f) => basename(f)), null, 2));
// A revision ("Revise the suite" on the first line, the suite attached) rewrites the test the
// words name, as the reference test writer does: here it adds a case for an empty passage.
const asked = o.text && existsSync(o.text) ? readFileSync(o.text, "utf8") : "";
const revise = /^\s*Revise the suite\b/i.test(asked.split(/\r?\n/)[0] ?? "");
if (revise && !o.files.some((f) => f.endsWith(".test.mjs"))) { console.log(JSON.stringify({ ok: false, code: 3, reply: "Nothing was revised: no suite came with it." })); process.exit(0); }
// The spec (stages.json 1.6.0), found among the attachments by its format, as the reference test writer
// finds it: one test per acceptance scenario, named by its id ("[F1.A1] ..."), and one per kept interface
// ("[I1] ...") in kept-interfaces.test.mjs. Without a spec, one test per approved feature line ("[F1] ...").
const spec = o.files.map((f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } }).find((v) => v?.format === "spec-v1") ?? null;
// A feature approved after the spec was written has no scenario in it: its test is named by the feature.
// When the message lists the approved features, only theirs are pinned: a behavior called a bug or dropped is left out.
const only = /^feature:\s*(F\d+)\s*$/m.exec(asked)?.[1] ?? null;
const approvedIds = only ? [only] : [...asked.matchAll(/^- (F\d+) \(offering /gm)].map((m) => m[1]);
const scenarios = (spec?.features ?? []).filter((f) => !approvedIds.length || approvedIds.includes(f.id)).flatMap((f) => (f.acceptance ?? []).map((a) => ({ feature: f.id, name: `[${a.id}] ${/Scenario:\s*(.+)/.exec(a.gherkin)?.[1]?.trim() ?? f.name.toLowerCase()}`, fails: /fails/i.test(f.name + f.does) })));
const cases = [
  ...scenarios,
  ...[...asked.matchAll(/^- (F\d+) \(offering [^)]*\): ([^.]+)\.(.*)$/gm)].filter((m) => !scenarios.some((c) => c.feature === m[1]) && (!only || m[1] === only)).map((m) => ({ name: `[${m[1]}] ${m[2].toLowerCase()}`, fails: /fails/i.test(m[2] + m[3]) })),
];
const kept = (spec?.interfaces ?? []).filter((x) => x.keep === true);
if (kept.length) {
  writeFileSync(join(o.job, "out", "test", "kept-interfaces.test.mjs"), `import { test } from "node:test";
import assert from "node:assert/strict";
import * as script from "../scripts/count.mjs";
${kept.map((x) => `
test(${JSON.stringify(`[${x.id}] ${x.name} is exported, as the spec keeps it`)}, () => {
  assert.equal(typeof script[${JSON.stringify(x.name)}], "function");
});
`).join("")}`);
}
// The file it writes: the feature's own in a feature's run, the one it was sent back for in a revision of one, else count.test.mjs.
const own = only ? `${only.toLowerCase()}.test.mjs` : revise ? o.files.map((x) => basename(x)).find((x) => /^f\d+\.test\.mjs$/.test(x)) ?? "count.test.mjs" : "count.test.mjs";
const forFeature = /^f\d+\.test\.mjs$/.test(own);
writeFileSync(join(o.job, "out", "test", own), `import { test } from "node:test";
import assert from "node:assert/strict";
import { count } from "../scripts/count.mjs";
${forFeature ? "" : `
test("counts the words in a passage", () => {
  assert.equal(count("one two  three"), 3);
});
`}${cases.map((c) => `
test(${JSON.stringify(c.name)}, () => {
  assert.equal(count("one two"), ${c.fails ? 99 : 2});
});
`).join("")}${revise ? `
test("an empty passage has no words", () => {
  assert.equal(count(""), 0);
});
` : ""}`);
// The original's own tests, carried.
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const docs = o.files.map((f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } }).filter(Boolean);
const manifest = docs.find((v) => v?.carried_tests === "v1" && Array.isArray(v.tests));
const held = docs.find((v) => v?.carried_tests === "v1" && Array.isArray(v.placed));
const carried = [];
const put = (to, from, text) => { mkdirSync(dirname(join(o.job, to)), { recursive: true }); if (from) cpSync(from, join(o.job, to)); else writeFileSync(join(o.job, to), text); carried.push(to); };
if (manifest && !revise) {
  const record = { carried_tests: "v1", placed: [], support: [], dropped: [] };
  for (const s of manifest.support ?? []) {
    const from = o.files.find((f) => sha(f) === s.sha256);
    if (!from) continue;
    put(`out/test/support/${s.path.slice("support/".length)}`, from);
    record.support.push({ path: `test/support/${s.path.slice("support/".length)}`, sha256: s.sha256 });
  }
  for (const t of manifest.tests ?? []) {
    const from = o.files.find((f) => sha(f) === t.sha256);
    if (!from) continue;
    let text = readFileSync(from, "utf8");
    for (const i of t.imports ?? []) text = text.split(JSON.stringify(i.from)).join(JSON.stringify(`./support/${i.support.slice("support/".length)}`));
    put(`out/test/${basename(t.file)}`, null, text);
    record.placed.push({ test: `test/${basename(t.file)}`, file: t.file, at: t.at, sha256: createHash("sha256").update(text).digest("hex") });
  }
  put("out/test/carried-tests.json", null, `${JSON.stringify(record, null, 2)}\n`);
}
const drop = revise && held ? /drop the original test ([\w.-]+)/i.exec(asked)?.[1] : null;
if (drop) {
  const gone = held.placed.filter((p) => basename(p.test) === drop);
  put("out/test/carried-tests.json", null, `${JSON.stringify({ ...held, placed: held.placed.filter((p) => !gone.includes(p)), dropped: [...(held.dropped ?? []), ...gone.map((p) => ({ file: p.file, test: p.test, at: "2026-11-09T12:00:00.000Z", by: "the person, by naming it" }))] }, null, 2)}\n`);
}
writeFileSync(join(o.job, "pieces.json"), JSON.stringify([
  { name: own, step: "write-the-suite", path: `out/test/${own}`, media_type: "text/javascript", about: "a test file" },
  ...(kept.length ? [{ name: "kept-interfaces.test.mjs", step: "write-the-suite", path: "out/test/kept-interfaces.test.mjs", media_type: "text/javascript", about: "the kept interfaces' tests" }] : []),
  ...carried.map((p) => ({ name: p.slice("out/test/".length), step: "write-the-suite", path: p, media_type: p.endsWith(".json") ? "application/vnd.agentmesh.carried-tests+json" : "text/javascript", about: "carried" })),
], null, 2));
console.log(JSON.stringify({ ok: true, code: 0, reply: `Wrote ${kept.length ? 2 : 1} test file${kept.length ? "s" : ""} for ${JSON.parse(readFileSync(descriptor, "utf8")).name}. It fails against an empty stand-in.`, pieces: "pieces.json" }));
