// A stand-in for the reference code critic's job.mjs: the same command line,
// no model. It reads the diff it was given and files a findings document:
// nothing open, unless a script it adds says TODO-CRITIC.
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
if (!o.job || !o.records || !o.work || !o.text) { console.log(JSON.stringify({ ok: false, reply: "The job command needs --job, --records, --work and --text-file." })); process.exit(2); }
if (!process.env.MODEL_NAME) { console.log(JSON.stringify({ ok: false, code: 1, reply: "MODEL_NAME is not set." })); process.exit(1); }
const pkg = o.files.find(([p, t]) => t === "application/gzip" && existsSync(p));
if (!pkg || readFileSync(pkg[0])[0] !== 0x1f) { console.log(JSON.stringify({ ok: false, code: 3, reply: "Nothing reviewable came." })); process.exit(3); }
const diff = o.files.find(([p, t]) => t === "text/x-diff" && existsSync(p));
const open = diff && readFileSync(diff[0], "utf8").includes("TODO-CRITIC") ? 1 : 0;
mkdirSync(join(o.job, "out"), { recursive: true });
writeFileSync(join(o.job, "out", "findings.md"), [
  "# Findings", "", "## Summary", "", `- open: ${open}`, "", "## Findings", "",
  ...(open ? ["### F1. A TODO-CRITIC marker is left in the script", "- Place: `scripts/count.mjs`", "- Claim: the script says TODO-CRITIC", "- Consequence: it is not finished.", "- Answer: open", ""] : []),
].join("\n"));
writeFileSync(join(o.job, "pieces.json"), JSON.stringify([{ name: "findings.md", path: "out/findings.md", media_type: "text/markdown" }]));
console.log(JSON.stringify({ ok: true, code: 0, reply: open ? "1 finding, 1 open." : "Reviewed the change: no findings." }));
