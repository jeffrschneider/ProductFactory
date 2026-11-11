// The stand-in check's stages: what each needs in the folder.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export const STAGES = ["requirements", "architecture", "files", "test", "code"];
const json = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
export const lockOf = (dir) => json(join(dir, "build.lock.json"));
export const writeLock = (dir, l) => writeFileSync(join(dir, "build.lock.json"), JSON.stringify(l, null, 2) + "\n");
export function problemsAt(dir, stage) {
  const has = (p) => existsSync(join(dir, p));
  if (stage === "requirements") return has("spec.json") && has("request.md") ? [] : ["spec.json is not in the folder"];
  if (stage === "architecture") {
    if (!has("architecture-record.md")) return ["architecture-record.md is not in the folder; run `node .adlc/generate.mjs record`"];
    if ((json(join(dir, "answers.json")) ?? {})["egress-1"] !== "yes") return ["the person has not answered egress-1: May this agent reach the public Hacker News API? Ask them, and put their answer in answers.json under egress-1"];
    return [];
  }
  if (stage === "files") return has("agent-descriptor.json") && has("plugin.json") ? [] : ["agent-descriptor.json is not in the folder"];
  if (stage === "test") return has("test/f1.test.mjs") ? [] : ["there are no tests of the agent's own under test/"];
  if (stage === "code") return has("scripts/count.mjs") ? [] : ["scripts/count.mjs is not written"];
  return [];
}
