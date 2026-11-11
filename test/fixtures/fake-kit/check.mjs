// The stand-in check: the first stage not passed, what it misses, and the stage passed when nothing is.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { STAGES, lockOf, writeLock, problemsAt } from "./stages.mjs";
const dir = dirname(dirname(fileURLToPath(import.meta.url)));
const lock = lockOf(dir);
let out = null;
for (const stage of STAGES) {
  if (lock.gates[stage]) continue;
  const problems = problemsAt(dir, stage);
  if (problems.length) { out = { code: 1, stage, passed: false, problems }; break; }
  if (stage === "requirements") { out = { code: 4, stage, passed: false, problems: [], waiting: true, said: "Requirements is ready for the person." }; break; }
  lock.gates[stage] = { passed: true, by: "check" };
}
writeLock(dir, lock);
out ??= { code: 0, stage: null, passed: true, problems: [], said: "Every stage has passed." };
console.log(JSON.stringify({ stages: STAGES, ...out }));
process.exitCode = out.code;
