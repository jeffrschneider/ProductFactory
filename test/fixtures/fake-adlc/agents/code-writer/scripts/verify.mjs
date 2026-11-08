// A stand-in for verify.mjs: accepts a job folder whose pieces were filed.
import { existsSync } from "node:fs";
import { join } from "node:path";

const { JOB_DIR } = process.env;
if (!JOB_DIR) { console.error("JOB_DIR is required"); process.exit(2); }
const ok = existsSync(join(JOB_DIR, "pieces.json"));
console.log(JSON.stringify({ ok, reply: ok ? "Accepted." : "No pieces were filed." }));
process.exit(ok ? 0 : 1);
