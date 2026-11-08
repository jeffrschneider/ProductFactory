// A stand-in for builds.mjs: writes the agent's own files from the draft, the
// layout a package is authored in, for an agent with one skill, count.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const { DRAFT, RECORDS } = process.env;
if (!DRAFT || !RECORDS) { console.error("DRAFT and RECORDS are required"); process.exit(2); }
const draft = JSON.parse(readFileSync(DRAFT, "utf8"));
const out = join(RECORDS, "agent");
mkdirSync(join(out, "skills", "count"), { recursive: true });
const name = draft.name ?? "word-counter";
writeFileSync(join(out, "agent-descriptor.json"), JSON.stringify({ format: "agent-descriptor-v1", agent_version: "0.1.0", name, does: "Counts the words in a passage.", will_not: ["It will not change the passage."], offerings: [{ id: "count", name: "Count" }] }, null, 2));
writeFileSync(join(out, "agent-runtime-requirements.json"), JSON.stringify({ format: "agent-runtime-requirements-v1", runtimes: [{ name: "node", version: ">=22" }] }, null, 2));
writeFileSync(join(out, "plugin.json"), JSON.stringify({ name, version: "0.1.0", description: "Counts the words in a passage.", extensions: { "net.agentdoc.package": { build: { skills: { count: { scripts: ["scripts/count.mjs"] } } } } } }, null, 2));
writeFileSync(join(out, "skills", "count", "SKILL.md"), `---\nname: count\ndescription: when somebody wants the words in a passage counted\n---\n\n# Count\n${draft.revision ? "\nRevised as asked.\n" : ""}`);
writeFileSync(join(RECORDS, "builds.json"), JSON.stringify({ checked: false, files: ["agent-descriptor.json", "agent-runtime-requirements.json", "plugin.json", "skills/count/SKILL.md"] }));
console.log(JSON.stringify({ ok: true, code: 0, checked: false }));
