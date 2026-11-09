// A stand-in for the reference test writer's job.mjs: the same command line,
// no model. It writes one test file for scripts/count.mjs. With the spec
// attached (spec.json, format spec-v1, stages.json 1.6.0) it adds one test per
// acceptance scenario, named by its id ("[F1.A1] <scenario>"), and a
// kept-interfaces.test.mjs with one test per kept interface ("[I1] ...").
// Without one, when the message lists approved features ("- F1 (offering
// Count): <name>. <does>"), it adds one test per feature, named "[F1] <name>".
// A feature whose name or words say "fails" gets a test no script can pass.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { basename, join } from "node:path";

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
const approvedIds = [...asked.matchAll(/^- (F\d+) \(offering /gm)].map((m) => m[1]);
const scenarios = (spec?.features ?? []).filter((f) => !approvedIds.length || approvedIds.includes(f.id)).flatMap((f) => (f.acceptance ?? []).map((a) => ({ feature: f.id, name: `[${a.id}] ${/Scenario:\s*(.+)/.exec(a.gherkin)?.[1]?.trim() ?? f.name.toLowerCase()}`, fails: /fails/i.test(f.name + f.does) })));
const cases = [
  ...scenarios,
  ...[...asked.matchAll(/^- (F\d+) \(offering [^)]*\): ([^.]+)\.(.*)$/gm)].filter((m) => !scenarios.some((c) => c.feature === m[1])).map((m) => ({ name: `[${m[1]}] ${m[2].toLowerCase()}`, fails: /fails/i.test(m[2] + m[3]) })),
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
writeFileSync(join(o.job, "out", "test", "count.test.mjs"), `import { test } from "node:test";
import assert from "node:assert/strict";
import { count } from "../scripts/count.mjs";

test("counts the words in a passage", () => {
  assert.equal(count("one two  three"), 3);
});
${cases.map((c) => `
test(${JSON.stringify(c.name)}, () => {
  assert.equal(count("one two"), ${c.fails ? 99 : 2});
});
`).join("")}${revise ? `
test("an empty passage has no words", () => {
  assert.equal(count(""), 0);
});
` : ""}`);
writeFileSync(join(o.job, "pieces.json"), JSON.stringify([
  { name: "count.test.mjs", step: "write-the-suite", path: "out/test/count.test.mjs", media_type: "text/javascript", about: "a test file" },
  ...(kept.length ? [{ name: "kept-interfaces.test.mjs", step: "write-the-suite", path: "out/test/kept-interfaces.test.mjs", media_type: "text/javascript", about: "the kept interfaces' tests" }] : []),
], null, 2));
console.log(JSON.stringify({ ok: true, code: 0, reply: `Wrote ${kept.length ? 2 : 1} test file${kept.length ? "s" : ""} for ${JSON.parse(readFileSync(descriptor, "utf8")).name}. It fails against an empty stand-in.`, pieces: "pieces.json" }));
