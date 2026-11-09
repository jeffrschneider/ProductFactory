// A stand-in for the reference reverse engineer: the command line its run
// declaration gives, no model. It reads the folder the message names and
// writes the as-built record's six files. Each behavior is a comment in a
// script, "// behavior: <name>: <what it does>", evidenced by that file and
// line; "// gap: <what>" is a gap. On drift (the last record attached) it
// hands back only the behaviors that are new, changed or no longer there.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep, basename } from "node:path";

const o = { files: [] };
const a = process.argv.slice(2);
for (let i = 0; i < a.length; i++) {
  if (a[i] === "--job") o.job = a[++i];
  else if (a[i] === "--records") o.records = a[++i];
  else if (a[i] === "--work") o.work = a[++i];
  else if (a[i] === "--text-file") o.text = a[++i];
  else if (a[i] === "--file") o.files.push(a[++i].split("::")[0]);
}
if (!o.job || !o.records || !o.work || !o.text) { console.log(JSON.stringify({ ok: false, reply: "The job command needs --job, --records, --work and --text-file." })); process.exit(1); }
const said = readFileSync(o.text, "utf8");
const key = (k) => new RegExp(`^${k}: (.+)$`, "m").exec(said)?.[1]?.trim() ?? null;
const folder = key("folder");
if (!folder || !existsSync(folder)) { console.log(JSON.stringify({ ok: false, code: 3, reply: "The message names no folder I can read." })); process.exit(3); }
if (process.env.PF_STUB_RE_FAIL) { console.log(JSON.stringify({ ok: false, code: 1, reply: "The stand-in reverse engineer was told to fail." })); process.exit(1); }
const trigger = key("trigger") ?? "adoption";
const files = [];
const walk = (d) => { for (const n of readdirSync(d).sort()) { if (n === ".git" || n === "node_modules") continue; const at = join(d, n); if (statSync(at).isDirectory()) walk(at); else files.push(relative(folder, at).split(sep).join("/")); } };
walk(folder);
const behaviors = [];
const gaps = [];
let n = 0;
for (const f of files.filter((p) => /\.(m?js|py)$/.test(p) && !/\.test\./.test(p))) {
  readFileSync(join(folder, f), "utf8").split(/\r?\n/).forEach((line, i) => {
    let m = /\/\/\s*behavior:\s*([^:]+):\s*(.+)$/.exec(line) ?? /#\s*behavior:\s*([^:]+):\s*(.+)$/.exec(line);
    if (m) behaviors.push({ id: `B${++n}`, name: m[1].trim(), does: m[2].trim(), offering: "Count", evidence: [`${f}:${i + 1}`], as_built: true });
    m = /\/\/\s*gap:\s*(.+)$/.exec(line);
    if (m) gaps.push({ what: m[1].trim(), where: `${f}:${i + 1}`, marked: "could not be determined by reading" });
  });
}
// Drift: only what changed since the last record, by name.
const prevFile = o.files.find((f) => basename(f) === "behaviors.json");
let out = behaviors;
if (trigger === "drift" && prevFile) {
  const prev = JSON.parse(readFileSync(prevFile, "utf8")).behaviors ?? [];
  out = [];
  for (const b of behaviors) {
    const was = prev.find((p) => p.name === b.name);
    if (!was) out.push({ ...b, change: "new" });
    else if (was.does !== b.does) out.push({ ...b, id: was.id, change: "changed" });
  }
  for (const p of prev) if (!behaviors.some((b) => b.name === p.name)) out.push({ ...p, change: "removed" });
}
const tests = files.filter((p) => /\.test\.m?js$/.test(p)).map((p) => ({ name: p, file: p }));
let deps = {};
try { deps = JSON.parse(readFileSync(join(folder, "package.json"), "utf8")).dependencies ?? {}; } catch { /* none */ }
const dir = join(o.job, "out");
mkdirSync(dir, { recursive: true });
const write = (name, v) => writeFileSync(join(dir, name), `${JSON.stringify(v, null, 2)}\n`);
write("record.json", { as_built: "v1", repository: key("repository"), commit: key("commit"), ran: false, trigger, ...(key("since") ? { since: key("since") } : {}) });
write("behaviors.json", { behaviors: out });
write("architecture.json", { as_built: true, parts: [...new Set(files.filter((p) => p.includes("/")).map((p) => p.split("/")[0]))].map((p) => ({ name: p })), entry_points: files.filter((p) => /^scripts\/.*\.m?js$/.test(p)).map((p) => ({ name: p, evidence: `${p}:1` })), data_stores: [], reaches: [], settings: [], starts: "node runs a script once per job" });
write("interfaces.json", { interfaces: files.filter((p) => /^scripts\/.*\.m?js$/.test(p)).map((p) => ({ kind: "command", name: `node ${p}`, format: "words in, words out" })) });
write("sbom.cdx.json", { bomFormat: "CycloneDX", specVersion: "1.5", components: Object.entries(deps).map(([name, version]) => ({ type: "library", name, version: String(version).replace(/^[\^~]/, "") })) });
write("tests-and-gaps.json", { tests, baseline: { ran: false, words: "Not run: the stand-in reads only." }, gaps });
const pieces = ["record.json", "behaviors.json", "architecture.json", "interfaces.json", "sbom.cdx.json", "tests-and-gaps.json"].map((name) => ({ name, step: "describe", path: `out/${name}`, media_type: name.startsWith("sbom") ? "application/vnd.cyclonedx+json" : "application/json" }));
writeFileSync(join(o.job, "pieces.json"), JSON.stringify(pieces, null, 2));
console.log(JSON.stringify({ ok: true, code: 0, reply: trigger === "drift" ? `Described what changed since ${key("since")}: ${out.length} behavior${out.length === 1 ? "" : "s"}.` : `Described ${out.length} behavior${out.length === 1 ? "" : "s"} at ${String(key("commit")).slice(0, 7)}, each with its file and line; ${gaps.length} gap${gaps.length === 1 ? "" : "s"} marked.` }));
