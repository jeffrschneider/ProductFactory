// A stand-in for the reference security reviewer's review-package.mjs: the
// same command line, no model. It passes a package when the message names
// the owner's spending limit, and refuses it otherwise, as the real one does.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

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
mkdirSync(join(o.job, "out"), { recursive: true });
writeFileSync(join(o.job, "out", "review.md"), limit
  ? "---\nverdict: passed\nwarnings:\n---\n\n# Review\n"
  : "---\nverdict: refused\nrefused_for:\n  - \"its owner has set no spending limit\"\n---\n\n# Review\n");
writeFileSync(join(o.job, "pieces.json"), JSON.stringify([{ name: "review.md", path: "out/review.md", media_type: "text/markdown" }]));
console.log(JSON.stringify({ ok: true, code: 0, reply: limit ? "Passed." : "Refused." }));
