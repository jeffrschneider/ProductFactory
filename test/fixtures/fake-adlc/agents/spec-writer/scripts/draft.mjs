// A stand-in for draft.mjs: a fixed draft, named from a "name:" line when there is one.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { ASKED, RECORDS } = process.env;
if (!ASKED || !RECORDS) { console.error("ASKED and RECORDS are required"); process.exit(2); }
const asked = JSON.parse(readFileSync(ASKED, "utf8"));
if (!asked.model.MODEL_NAME || !asked.model.MODEL_ENDPOINT || !asked.model.MODEL_PROTOCOL) {
  console.log(JSON.stringify({ ok: false, code: 4, reply: "A model setting is missing." }));
  process.exit(4);
}
const name = /^(?:changes:\s*)?name:\s*(.+)$/m.exec(asked.said)?.[1]?.trim() ?? null;
const revision = /^changes:/m.test(asked.said);
writeFileSync(join(RECORDS, "draft.json"), JSON.stringify({ name, revision, files: asked.files }, null, 2));
writeFileSync(join(RECORDS, "blanks.json"), JSON.stringify(name ? [] : [{ key: "name", question: "What should this agent be called?" }]));
console.log(JSON.stringify({ ok: true, code: 0 }));
