// A stand-in for pieces.mjs: the record as out/architecture-record.md, what is
// still open as out/still-open.md when a question is, and pieces.json.
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { JOB_DIR, RECORDS } = process.env;
if (!JOB_DIR || !RECORDS) { console.error("JOB_DIR and RECORDS are required"); process.exit(2); }
mkdirSync(join(JOB_DIR, "out"), { recursive: true });
const entries = [];
for (const [file, to, name] of [["record.md", "out/architecture-record.md", "the architecture record"], ["still-open.md", "out/still-open.md", "what is still open"]]) {
  if (!existsSync(join(RECORDS, file))) continue;
  cpSync(join(RECORDS, file), join(JOB_DIR, to));
  entries.push({ name, step: "check-the-record", path: to, media_type: "text/markdown" });
}
writeFileSync(join(JOB_DIR, "pieces.json"), JSON.stringify(entries, null, 2));
console.log(`${entries.length} pieces listed`);
