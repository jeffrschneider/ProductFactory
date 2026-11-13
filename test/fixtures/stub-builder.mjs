// A stand-in for one builder: each round it writes what the folder's check
// asks for next, and it logs the prompt it was given (PF_STUB_LOG).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.cwd();
if (process.env.PF_STUB_LOG) appendFileSync(process.env.PF_STUB_LOG, JSON.stringify({ builder: true, cwd: dir, prompt: process.argv[2], plugin: process.argv[3] ?? null, not_the_person: process.env.ADLC_NOT_THE_PERSON ?? null }) + "\n");
const put = (p, text) => { mkdirSync(join(dir, p, ".."), { recursive: true }); if (!existsSync(join(dir, p))) writeFileSync(join(dir, p), text); };
// The builder writes the spec too: from request.md, revised when the person's changes are added at its end.
const request = existsSync(join(dir, "request.md")) ? readFileSync(join(dir, "request.md"), "utf8") : "";
const revised = request.includes("## The person asked for changes");
// The name and version the person gave, as a real builder takes them from request.md.
const NAME = /^name:\s*(\S+)/mi.exec(request)?.[1] ?? "word-counter";
const VERSION = /^version:\s*(\d+\.\d+\.\d+)/mi.exec(request)?.[1] ?? "0.1.0";
const spec = {
  format: "spec-v1",
  product: { name: NAME, version: VERSION, kind: "agent" },
  purpose: revised ? "Counts the words in a passage, revised as asked." : "Counts the words in a passage, for anyone who sends one.",
  source: { kind: "account" },
  features: [{ id: "F1", name: "Count", does: "Counts the words in a passage.", offering: "Count",
    requirements: [{ id: "F1.R1", shall: "The agent shall count the words in a passage.", kind: "behavior", verify: "test" }],
    acceptance: [{ id: "F1.A1", gherkin: "Scenario: count\n  Given the passage \"one two\"\n  When it is counted\n  Then the count is 2", checks: ["F1.R1"] }] }],
  interfaces: [], constraints: [], systems: [], settings: [], open: [],
};
const was = (() => { try { return JSON.parse(readFileSync(join(dir, "spec.json"), "utf8")); } catch { return null; } })();
const approved = (() => { try { return Boolean(JSON.parse(readFileSync(join(dir, "build.lock.json"), "utf8")).gates?.spec?.passed); } catch { return false; } })();
if (!was || (revised && !approved && was.purpose !== spec.purpose)) writeFileSync(join(dir, "spec.json"), `${JSON.stringify(spec, null, 2)}\n`);
put("architecture-record.md", "---\nrecord: architecture-record-v1\n---\n# Architecture record\n");
put("agent-descriptor.json", JSON.stringify({ format: "agent-descriptor-v1", name: NAME, agent_version: VERSION }) + "\n");
put("plugin.json", JSON.stringify({ name: NAME, version: VERSION, extensions: { "net.agentdoc.package": { build: { skills: { count: { scripts: ["scripts/count.mjs"] } } } } } }) + "\n");
put("agent-runtime-requirements.json", JSON.stringify({ format: "agent-runtime-requirements-v1", systems: [] }) + "\n");
put("skills/count/SKILL.md", "---\nname: count\n---\n");
if (!process.env.PF_STUB_SKIP_TEST) put("test/f1.test.mjs", "import { test } from \"node:test\";\ntest(\"[F1.A1] counts\", () => {});\n");
// PF_STUB_MARK puts a marker in the script, such as TODO-SECURITY, which the stand-in reviewers refuse.
put("scripts/count.mjs", `export const count = (s) => s.split(/\\s+/).filter(Boolean).length;\n${process.env.PF_STUB_MARK ? `// ${process.env.PF_STUB_MARK}\n` : ""}`);
