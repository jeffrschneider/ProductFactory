// A stand-in for the reference security reviewer's review-package.mjs: the
// same command line, no model. It passes a package when the message names
// the owner's spending limit, and refuses it otherwise, as the real one does.
// It also refuses a package whose scripts are marked TODO-SECURITY, as the
// real one refuses a script that sends data where the spec does not say.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const o = { files: [] };
const a = process.argv.slice(2);
for (let i = 0; i < a.length; i++) {
  if (a[i] === "--job") o.job = a[++i];
  else if (a[i] === "--records") o.records = a[++i];
  else if (a[i] === "--work") o.work = a[++i];
  else if (a[i] === "--text-file") o.text = a[++i];
  else if (a[i] === "--file") o.files.push(a[++i].split("::"));
}
if (!o.job || !o.text) { console.log(JSON.stringify({ ok: false, reply: "usage" })); process.exit(2); }
if (!o.files.some(([p, t]) => t === "application/gzip" && existsSync(p))) { console.log(JSON.stringify({ ok: false, code: 3, reply: "No package came." })); process.exit(3); }
const limit = /^spending limit:\s*(.+)$/m.exec(readFileSync(o.text, "utf8"));
// A script marked TODO-SECURITY is refused, as the real one refuses a script that sends data where the spec does not say.
const marked = o.files.some(([p, t]) => t === "application/gzip" && gunzipSync(readFileSync(p)).includes("TODO-SECURITY"));
const passed = limit && !marked;
mkdirSync(join(o.job, "out"), { recursive: true });
writeFileSync(join(o.job, "out", "review.md"), passed
  ? "---\nverdict: passed\nwarnings:\n---\n\n# Review\n"
  : `---\nverdict: refused\nrefused_for:\n  - "${marked ? "scripts/count.mjs sends the passage to a system the spec does not declare" : "its owner has set no spending limit"}"\n---\n\n# Review\n`);
writeFileSync(join(o.job, "pieces.json"), JSON.stringify([{ name: "review.md", path: "out/review.md", media_type: "text/markdown" }]));
console.log(JSON.stringify({ ok: true, code: 0, reply: passed ? "Passed." : "Refused." }));
