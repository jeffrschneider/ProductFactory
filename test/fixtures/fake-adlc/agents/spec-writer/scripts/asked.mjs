// A stand-in for the reference spec writer's asked.mjs: the same variables,
// the same exit codes, no model. It records what it was given so the tests
// can see it.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const { JOB_DIR, RECORDS, TEXT_FILE, FILES = "", MODEL_NAME, MODEL_ENDPOINT, MODEL_PROTOCOL } = process.env;
if (!JOB_DIR || !RECORDS || !TEXT_FILE) { console.error("JOB_DIR, RECORDS and TEXT_FILE are required"); process.exit(2); }
const text = readFileSync(TEXT_FILE, "utf8");
mkdirSync(RECORDS, { recursive: true });
if (/refuse at requirements/i.test(text)) {
  console.log(JSON.stringify({ ok: false, code: 3, reply: "Nothing arrived that a spec could be written from." }));
  process.exit(3);
}
const files = FILES ? FILES.split(",").map((f) => f.split("::")[0]) : [];
writeFileSync(join(RECORDS, "asked.json"), JSON.stringify({ said: text, files, model: { MODEL_NAME, MODEL_ENDPOINT, MODEL_PROTOCOL } }, null, 2));
console.log(JSON.stringify({ ok: true, code: 0, said: "recorded" }));
