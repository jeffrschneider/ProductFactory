// A stand-in for ask.mjs: the reply, with the open questions.
import { readFileSync } from "node:fs";

const { DRAFT, BLANKS, RECORDS } = process.env;
if (!DRAFT || !BLANKS || !RECORDS) { console.error("DRAFT, BLANKS and RECORDS are required"); process.exit(2); }
const draft = JSON.parse(readFileSync(DRAFT, "utf8"));
const blanks = JSON.parse(readFileSync(BLANKS, "utf8"));
const open = blanks.length ? ` Still open: ${blanks.map((b) => b.question).join(" ")}` : "";
console.log(JSON.stringify({ ok: true, code: 0, reply: `${draft.revision ? "Revised" : "Drafted"} the spec for ${draft.name ?? "an agent not named yet"}.${open}` }));
