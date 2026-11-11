// A stand-in for the reference solution architect's asked.mjs: the same
// variables, the same exit codes, no model. It records what it was given so
// the tests can see it: the statement (the message's words and the text of
// each attached Markdown file that is not a record), whether this is a
// revision (an earlier record attached, or answers), and each "key: answer"
// line under a key the architect asks with.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";

const { JOB_DIR, RECORDS, TEXT_FILE, FILES = "", MODEL_NAME, MODEL_ENDPOINT, MODEL_PROTOCOL } = process.env;
if (!JOB_DIR || !RECORDS || !TEXT_FILE) { console.error("JOB_DIR, RECORDS and TEXT_FILE are required"); process.exit(2); }
const text = readFileSync(TEXT_FILE, "utf8");
mkdirSync(RECORDS, { recursive: true });
if (/refuse at architecture/i.test(text)) {
  console.log(JSON.stringify({ ok: false, code: 3, reply: "There is nothing here to write an architecture from." }));
  process.exit(3);
}
const files = FILES ? FILES.split(",").map((f) => f.split("::")[0]) : [];
const isRecord = (t) => /^---\r?\nrecord: architecture-record-v1/.test(t);
const read = files.map((p) => ({ name: basename(p), text: existsSync(p) ? readFileSync(p, "utf8") : "" }));
const earlier = read.find((f) => isRecord(f.text)) ?? null;
const answers = Object.fromEntries([...text.matchAll(/^\s*(limit-cost|egress-\d+|binding-[a-z0-9-]+|system-[a-z0-9-]+):\s*(.+)$/gm)].map((m) => [m[1], m[2].trim()]));
const statement = earlier
  ? JSON.parse(/^statement: (.+)$/m.exec(earlier.text)?.[1] ?? '""')
  : [text, ...read.filter((f) => !isRecord(f.text) && /\.md$/.test(f.name)).map((f) => f.text)].join("\n\n");
writeFileSync(join(RECORDS, "asked.json"), JSON.stringify({ said: text, files, statement, revision: Boolean(earlier) || Object.keys(answers).length > 0, earlier: earlier?.text ?? null, answers, model: { MODEL_NAME, MODEL_ENDPOINT, MODEL_PROTOCOL } }, null, 2));
console.log(JSON.stringify({ ok: true, code: 0, said: "recorded" }));
