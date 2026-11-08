// A stand-in coding harness. It runs in the build folder, as a harness does,
// and writes scripts/count.mjs: wrong for its first PF_STUB_FAIL_ROUNDS calls,
// right after that. Each call is appended to PF_STUB_LOG, so the tests can see
// what it was given.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const log = process.env.PF_STUB_LOG;
const calls = log && existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;
const fail = calls < Number(process.env.PF_STUB_FAIL_ROUNDS ?? 0);
if (log) appendFileSync(log, `${JSON.stringify({ prompt: process.argv[2], cwd: process.cwd(), round: process.env.PF_ROUND, feedback: process.env.PF_FEEDBACK_FILE, agents_md: existsSync("AGENTS.md") })}\n`);
writeFileSync(join("scripts", "count.mjs"), fail
  ? "export function count() { return 0; }\n"
  : "export function count(text) { return String(text).split(/\\s+/).filter(Boolean).length; }\n");
if (process.env.RECORDS) writeFileSync(join(process.env.RECORDS, "account.md"), "Wrote scripts/count.mjs.\n");
