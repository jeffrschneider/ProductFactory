// A stand-in for the reference code writer's handoff.mjs: the same command
// line. It lays out <work>/build with the spec (spec.json and spec.md, when
// they come), the agent's files, the suite, a stub
// script, AGENTS.md, .adlc/check.mjs and build.lock.json, and files a
// stand-in "archive" that names the folder.
import { cpSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";

const o = { files: [] };
const a = process.argv.slice(2);
for (let i = 0; i < a.length; i++) {
  if (a[i] === "--job") o.job = a[++i];
  else if (a[i] === "--records") o.records = a[++i];
  else if (a[i] === "--work") o.work = a[++i];
  else if (a[i] === "--message") o.message = a[++i];
  else if (a[i] === "--file") o.files.push(a[++i].split("::")[0]);
}
if (!o.job || !o.records || !o.work) { console.error("--job, --records and --work are required"); process.exit(2); }
if (!/^hand off the code/i.test(readFileSync(o.message, "utf8"))) { console.log(JSON.stringify({ ok: true, code: 0, escalate: true, reply: "" })); process.exit(0); }
const dir = join(o.work, "build");
mkdirSync(join(dir, "scripts"), { recursive: true });
mkdirSync(join(dir, "test"), { recursive: true });
mkdirSync(join(dir, ".adlc"), { recursive: true });
let suite = 0;
for (const f of o.files) {
  const n = basename(f);
  // The spec (stages.json 1.6.0) goes at the top of the build folder, pinned with the agent's files.
  if (["spec.json", "spec.md", "agent-descriptor.json", "agent-runtime-requirements.json", "plugin.json"].includes(n)) cpSync(f, join(dir, n));
  else if (n === "SKILL.md") { mkdirSync(join(dir, "skills", basename(dirname(f))), { recursive: true }); cpSync(f, join(dir, "skills", basename(dirname(f)), n)); }
  else if (n.endsWith(".test.mjs")) { cpSync(f, join(dir, "test", n)); suite++; }
}
if (!existsSync(join(dir, "agent-descriptor.json")) || !suite) {
  console.log(JSON.stringify({ ok: false, code: 3, reply: "Nothing is laid out: the agent's files or the suite did not arrive." }));
  process.exit(3);
}
writeFileSync(join(dir, "scripts", "count.mjs"), "export function count() { throw new Error(\"not written yet\"); }\n");
writeFileSync(join(dir, "AGENTS.md"), `# Writing the scripts\n\n${existsSync(join(dir, "spec.md")) ? "Read the spec first: spec.md, and spec.json beside it.\n\n" : ""}Write scripts/count.mjs so that \`node .adlc/check.mjs\` exits 0.\n`);
writeFileSync(join(dir, ".adlc", "suite.mjs"), readFileSync(new URL("./suite.mjs", import.meta.url)));
writeFileSync(join(dir, ".adlc", "check.mjs"), "import { dirname } from \"node:path\";\nimport { fileURLToPath } from \"node:url\";\nimport { runSuite } from \"./suite.mjs\";\nif (process.env.WORKSPACE || process.env.RECORDS) { console.error(\"a build folder's check reads no WORKSPACE or RECORDS\"); process.exit(2); }\nrunSuite(dirname(dirname(fileURLToPath(import.meta.url))));\n");
// build.lock.json as the reference hand-off writes it: the digest of every file outside scripts/,
// records/ and the lock, and the scripts the folder starts with.
const digests = {};
const walk = (d, rel = "") => {
  for (const name of readdirSync(d).sort()) {
    const r = rel ? `${rel}/${name}` : name;
    if (r === "scripts" || r === "records" || r === "build.lock.json") continue;
    if (statSync(join(d, name)).isDirectory()) walk(join(d, name), r);
    else digests[r] = `sha256:${createHash("sha256").update(readFileSync(join(d, name))).digest("hex")}`;
  }
};
walk(dir);
writeFileSync(join(dir, "build.lock.json"), `${JSON.stringify({ build_lock: "v1", digests, scripts: [{ path: "scripts/count.mjs", from: "stub", names: ["count"] }] }, null, 2)}\n`);
mkdirSync(join(o.job, "out"), { recursive: true });
writeFileSync(join(o.job, "out", "build-folder.tar.gz"), dir);
writeFileSync(join(o.job, "pieces.json"), JSON.stringify([{ name: "the build folder", step: "pack-the-build-folder", path: "out/build-folder.tar.gz", media_type: "application/gzip", about: "the build folder" }], null, 2));
console.log(JSON.stringify({ ok: true, code: 0, reply: `Laid out the build folder: 1 script to write, ${suite} test file${suite === 1 ? "" : "s"}, AGENTS.md and .adlc/.` }));
