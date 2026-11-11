// A stand-in for one builder: each round it writes what the folder's check
// asks for next, and it logs the prompt it was given (PF_STUB_LOG).
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.cwd();
if (process.env.PF_STUB_LOG) appendFileSync(process.env.PF_STUB_LOG, JSON.stringify({ builder: true, cwd: dir, prompt: process.argv[2], plugin: process.argv[3] ?? null }) + "\n");
const put = (p, text) => { mkdirSync(join(dir, p, ".."), { recursive: true }); if (!existsSync(join(dir, p))) writeFileSync(join(dir, p), text); };
put("architecture-record.md", "---\nrecord: architecture-record-v1\n---\n# Architecture record\n");
put("agent-descriptor.json", JSON.stringify({ format: "agent-descriptor-v1" }) + "\n");
put("plugin.json", JSON.stringify({ name: "word-counter", version: "0.1.0", extensions: { "net.agentdoc.package": { build: { skills: { count: { scripts: ["scripts/count.mjs"] } } } } } }) + "\n");
put("agent-runtime-requirements.json", JSON.stringify({ format: "agent-runtime-requirements-v1", systems: [] }) + "\n");
put("skills/count/SKILL.md", "---\nname: count\n---\n");
if (!process.env.PF_STUB_SKIP_TEST) put("test/f1.test.mjs", "import { test } from \"node:test\";\ntest(\"[F1.A1] counts\", () => {});\n");
put("scripts/count.mjs", "export const count = (s) => s.split(/\s+/).filter(Boolean).length;\n");
