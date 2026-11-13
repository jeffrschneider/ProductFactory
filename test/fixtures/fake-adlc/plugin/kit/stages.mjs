// The stand-in check's two phases and the build's gates: what each needs in the folder.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export const PHASES = ["spec", "build"];
export const GATES = ["architecture", "files", "test", "code"];
export const GATE_TITLES = { architecture: "Architecture", files: "The agent's files", test: "Test", code: "Code" };
const json = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
export const lockOf = (dir) => json(join(dir, "build.lock.json"));
export const writeLock = (dir, l) => writeFileSync(join(dir, "build.lock.json"), JSON.stringify(l, null, 2) + "\n");
export const specProblems = (dir) => (existsSync(join(dir, "spec.json")) && existsSync(join(dir, "request.md")) ? [] : ["spec.json is not in the folder"]);
/** An answer after the spec counts only with the person's words, found in said.md. */
const answered = (dir, key) => {
  const a = (json(join(dir, "answers.json")) ?? {})[key];
  const said = existsSync(join(dir, "said.md")) ? readFileSync(join(dir, "said.md"), "utf8") : "";
  return a && typeof a === "object" && a.answer === "yes" && a.said && said.includes(a.said);
};
export function gateProblems(dir, gate) {
  const has = (p) => existsSync(join(dir, p));
  if (gate === "architecture") {
    if (!has("architecture-record.md")) return ["architecture-record.md is not in the folder; run `node .adlc/generate.mjs record`"];
    if (!answered(dir, "egress-1")) return ["the person has not answered egress-1: May this agent reach the public Hacker News API? Ask them, and put their answer in answers.json under egress-1 with their words: {\"answer\": ..., \"said\": \"<their words, exactly>\"}"];
    return [];
  }
  if (gate === "files") return has("agent-descriptor.json") && has("plugin.json") ? [] : ["agent-descriptor.json is not in the folder"];
  if (gate === "test") return has("test/f1.test.mjs") ? [] : ["there are no tests of the agent's own under test/"];
  if (gate === "code") return has("scripts/count.mjs") ? [] : ["scripts/count.mjs is not written"];
  return [];
}
