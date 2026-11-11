// A stand-in for name.mjs: no model. It names one system, text-reasoning, and
// asks the spending limit when the statement says ASK-LIMIT and no answer to
// limit-cost came back, as the reference architect asks a limit nobody gave.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { ASKED, RECORDS } = process.env;
if (!ASKED || !RECORDS) { console.error("ASKED and RECORDS are required"); process.exit(2); }
const asked = JSON.parse(readFileSync(ASKED, "utf8"));
if (!asked.model.MODEL_NAME || !asked.model.MODEL_ENDPOINT || !asked.model.MODEL_PROTOCOL) {
  console.log(JSON.stringify({ ok: false, code: 4, reply: "A model setting is missing." }));
  process.exit(4);
}
const earlierLimit = /^- \*\*Cost\*\*: (?!not set)(.+)$/m.exec(asked.earlier ?? "")?.[1] ?? null;
const limit = asked.answers["limit-cost"] ?? earlierLimit;
const questions = /ASK-LIMIT/.test(asked.statement) && !limit ? [{ key: "limit-cost", question: "How much may this agent spend, and per what (a day, a month, a job)?" }] : [];
writeFileSync(join(RECORDS, "named.json"), JSON.stringify({ systems: ["text-reasoning"], kind: "plugin-on-harness", limit, questions }, null, 2));
console.log(JSON.stringify({ ok: true, code: 0 }));
