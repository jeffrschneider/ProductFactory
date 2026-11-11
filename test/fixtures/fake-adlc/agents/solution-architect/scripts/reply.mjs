// A stand-in for reply.mjs: the reply, with the questions still open.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { RECORDS } = process.env;
if (!RECORDS) { console.error("RECORDS is required"); process.exit(2); }
const named = JSON.parse(readFileSync(join(RECORDS, "named.json"), "utf8"));
const asked = JSON.parse(readFileSync(join(RECORDS, "asked.json"), "utf8"));
const open = named.questions.map((q) => `${q.key}: ${q.question}`);
console.log(JSON.stringify({ ok: true, code: 0, reply: `${asked.revision ? "Revised" : "Wrote"} the architecture record: one system, text-reasoning, bound to the platform's default in dev, test and production.${open.length ? ` Still open: ${open.join(" ")}` : " The record is finished."}`, done: !open.length, still_open: named.questions.map((q) => q.key) }));
