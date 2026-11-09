// A stand-in for builds.mjs: writes the spec (stages.json 1.6.0, spec-v1) and
// the agent's own files made from it, the layout a package is authored in,
// for an agent with one skill, count. The spec's features are the ones the
// request carries, as the reference spec writer keeps them:
//
//   "- F1 (offering Count): <name>. <does>"   an approved feature, kept by its id
//   "- B1 (feature F2) <name>: <does>"        a behavior of the as-built record, kept as built
//   "spec feature: <name> - <does>"           a new feature, given the next id
//
// Each feature gets one acceptance scenario, named after it. The spec has
// one interface, the count function, kept exactly.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const { DRAFT, RECORDS } = process.env;
if (!DRAFT || !RECORDS) { console.error("DRAFT and RECORDS are required"); process.exit(2); }
const draft = JSON.parse(readFileSync(DRAFT, "utf8"));
const said = (() => { try { return JSON.parse(readFileSync(join(RECORDS, "asked.json"), "utf8")).said; } catch { return ""; } })();
const out = join(RECORDS, "agent");
mkdirSync(join(out, "skills", "count"), { recursive: true });
const name = draft.name ?? "word-counter";
const version = draft.version ?? "0.1.0";
writeFileSync(join(out, "agent-descriptor.json"), JSON.stringify({ format: "agent-descriptor-v1", agent_version: version, name, does: "Counts the words in a passage.", will_not: ["It will not change the passage."], offerings: [{ id: "count", name: "Count" }] }, null, 2));
writeFileSync(join(out, "agent-runtime-requirements.json"), JSON.stringify({ format: "agent-runtime-requirements-v1", runtimes: [{ name: "node", version: ">=22" }] }, null, 2));
writeFileSync(join(out, "plugin.json"), JSON.stringify({ name, version, description: "Counts the words in a passage.", extensions: { "net.agentdoc.package": { build: { skills: { count: { scripts: ["scripts/count.mjs"] } } } } } }, null, 2));
writeFileSync(join(out, "skills", "count", "SKILL.md"), `---\nname: count\ndescription: when somebody wants the words in a passage counted\n---\n\n# Count\n${draft.revision ? "\nRevised as asked.\n" : ""}`);

// The spec's features, from the request.
const features = [];
for (const m of said.matchAll(/^- (F\d+) \(offering ([^)]*)\): ([^.]+)\.\s*(.*)$/gm)) features.push({ id: m[1], name: m[3].trim(), does: m[4].trim(), offering: m[2] === "not named" ? "" : m[2] });
for (const m of said.matchAll(/^- (B\d+) \(feature (F\d+)\) ([^:]+): (.+?)(?: \([^()]*\))?$/gm)) if (!features.some((f) => f.id === m[2])) features.push({ id: m[2], name: m[3].trim(), does: m[4].trim(), offering: "Count", as_built: m[1] });
let top = Math.max(0, ...features.map((f) => Number(f.id.slice(1))));
for (const m of said.matchAll(/^.*\bspec feature:\s*(.+?)\s+-\s+(.+)$/gim)) features.push({ id: `F${++top}`, name: m[1].trim(), does: m[2].trim(), offering: "Count" });
const spec = {
  format: "spec-v1",
  product: { name, version, kind: "agent" },
  purpose: "Counts the words in a passage, for anyone who sends one.",
  source: { kind: features.some((f) => f.as_built) ? "as-built-record" : "account" },
  features: features.map((f) => ({
    ...f,
    requirements: [{ id: `${f.id}.R1`, shall: `The agent shall ${f.does.replace(/^[A-Z]/, (c) => c.toLowerCase()).replace(/\.$/, "")}.`, kind: "behavior", verify: "test", exact: ["\\s+"] }],
    acceptance: [{ id: `${f.id}.A1`, gherkin: `Scenario: ${f.name.toLowerCase()}\n  Given the passage "one two"\n  When it is counted\n  Then the count is 2`, checks: [`${f.id}.R1`] }],
  })),
  interfaces: [{ id: "I1", kind: "function", name: "count", module: "scripts/count.mjs", signature: "count(text)", keep: true, about: "Counts the words in text." }],
  constraints: [{ id: "C1", shall: "The agent shall run on Node 22 or later.", kind: "runtime", verify: "inspection" }],
  systems: [],
  settings: [],
  open: draft.name ? [] : [{ key: "name", question: "What should this agent be called?" }],
};
writeFileSync(join(RECORDS, "spec.json"), `${JSON.stringify(spec, null, 2)}\n`);
writeFileSync(join(RECORDS, "spec.md"), `# ${name} ${version}\n\n${spec.purpose}\n\n${spec.features.map((f) => `## ${f.id} ${f.name}\n\n${f.does}\n\n- ${f.requirements[0].id}: ${f.requirements[0].shall}\n\n\`\`\`gherkin\n${f.acceptance[0].gherkin}\n\`\`\`\n`).join("\n")}`);
writeFileSync(join(RECORDS, "builds.json"), JSON.stringify({ checked: false, files: ["agent-descriptor.json", "agent-runtime-requirements.json", "plugin.json", "skills/count/SKILL.md"] }));
console.log(JSON.stringify({ ok: true, code: 0, checked: false }));
