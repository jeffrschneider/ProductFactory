// A stand-in for pieces.mjs: the spec (out/spec.json and out/spec.md,
// stages.json 1.6.0), the agent's files under out/agent/, and pieces.json.
// With FAKE_NO_SPEC set it files no spec, as a spec writer from before 1.6.0.
import { cpSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const { JOB_DIR, RECORDS } = process.env;
if (!JOB_DIR || !RECORDS) { console.error("JOB_DIR and RECORDS are required"); process.exit(2); }
const { files } = JSON.parse(readFileSync(join(RECORDS, "builds.json"), "utf8"));
mkdirSync(join(JOB_DIR, "out"), { recursive: true });
cpSync(join(RECORDS, "agent"), join(JOB_DIR, "out", "agent"), { recursive: true });
const entries = [];
if (!process.env.FAKE_NO_SPEC && existsSync(join(RECORDS, "spec.json"))) {
  cpSync(join(RECORDS, "spec.json"), join(JOB_DIR, "out", "spec.json"));
  cpSync(join(RECORDS, "spec.md"), join(JOB_DIR, "out", "spec.md"));
  entries.push({ name: "the spec", step: "write-the-spec", path: "out/spec.json", media_type: "application/json", about: "the spec, spec-v1" });
  entries.push({ name: "the spec, to read", step: "write-the-spec", path: "out/spec.md", media_type: "text/markdown", about: "the spec, for a person" });
}
entries.push(...files.map((f) => ({ name: f, step: "draft-the-spec", path: `out/agent/${f}`, media_type: f.endsWith(".md") ? "text/markdown" : `application/vnd.agentmesh.${f.replace(".json", "")}+json`, about: "one of the agent's own files" })));
const blanks = JSON.parse(readFileSync(join(RECORDS, "blanks.json"), "utf8"));
if (blanks.length) {
  writeFileSync(join(JOB_DIR, "out", "still-open.md"), `# What is still open\n\n${blanks.map((b) => `- \`${b.key}\`: ${b.question}`).join("\n")}\n`);
  entries.push({ name: "what is still open", step: "ask-what-is-missing", path: "out/still-open.md", media_type: "text/markdown", about: "the open questions" });
}
writeFileSync(join(JOB_DIR, "pieces.json"), JSON.stringify(entries, null, 2));
console.log(`${entries.length} pieces listed`);
