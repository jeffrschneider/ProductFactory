// A stand-in for pieces.mjs: the agent's files under out/agent/, and pieces.json.
import { cpSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const { JOB_DIR, RECORDS } = process.env;
if (!JOB_DIR || !RECORDS) { console.error("JOB_DIR and RECORDS are required"); process.exit(2); }
const { files } = JSON.parse(readFileSync(join(RECORDS, "builds.json"), "utf8"));
mkdirSync(join(JOB_DIR, "out"), { recursive: true });
cpSync(join(RECORDS, "agent"), join(JOB_DIR, "out", "agent"), { recursive: true });
const entries = files.map((f) => ({ name: f, step: "draft-the-spec", path: `out/agent/${f}`, media_type: f.endsWith(".md") ? "text/markdown" : `application/vnd.agentmesh.${f.replace(".json", "")}+json`, about: "one of the agent's own files" }));
const blanks = JSON.parse(readFileSync(join(RECORDS, "blanks.json"), "utf8"));
if (blanks.length) {
  writeFileSync(join(JOB_DIR, "out", "still-open.md"), `# What is still open\n\n${blanks.map((b) => `- \`${b.key}\`: ${b.question}`).join("\n")}\n`);
  entries.push({ name: "what is still open", step: "ask-what-is-missing", path: "out/still-open.md", media_type: "text/markdown", about: "the open questions" });
}
writeFileSync(join(JOB_DIR, "pieces.json"), JSON.stringify(entries, null, 2));
console.log(`${entries.length} pieces listed`);
