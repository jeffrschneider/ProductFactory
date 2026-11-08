// A stand-in for the reference test writer's job.mjs: the same command line,
// no model. It writes one test file for scripts/count.mjs.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

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
// A revision ("Revise the suite" on the first line, the suite attached) rewrites the test the
// words name, as the reference test writer does: here it adds a case for an empty passage.
const asked = o.text && existsSync(o.text) ? readFileSync(o.text, "utf8") : "";
const revise = /^\s*Revise the suite\b/i.test(asked.split(/\r?\n/)[0] ?? "");
if (revise && !o.files.some((f) => f.endsWith(".test.mjs"))) { console.log(JSON.stringify({ ok: false, code: 3, reply: "Nothing was revised: no suite came with it." })); process.exit(0); }
writeFileSync(join(o.job, "out", "test", "count.test.mjs"), `import { test } from "node:test";
import assert from "node:assert/strict";
import { count } from "../scripts/count.mjs";

test("counts the words in a passage", () => {
  assert.equal(count("one two  three"), 3);
});
${revise ? `
test("an empty passage has no words", () => {
  assert.equal(count(""), 0);
});
` : ""}`);
writeFileSync(join(o.job, "pieces.json"), JSON.stringify([{ name: "count.test.mjs", step: "write-the-suite", path: "out/test/count.test.mjs", media_type: "text/javascript", about: "a test file" }], null, 2));
console.log(JSON.stringify({ ok: true, code: 0, reply: `Wrote 1 test file for ${JSON.parse(readFileSync(descriptor, "utf8")).name}. It fails against an empty stand-in.`, pieces: "pieces.json" }));
