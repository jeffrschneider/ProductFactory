// The stand-in check, in the plugin's two phases: the spec until the person
// approves it, then every gate of the build at once, and the build passed when
// none has anything missing.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PHASES, GATES, GATE_TITLES, lockOf, writeLock, specProblems, gateProblems } from "./stages.mjs";
const dir = dirname(dirname(fileURLToPath(import.meta.url)));
const lock = lockOf(dir);
let out;
if (lock.gates.build?.passed) out = { code: 0, phase: null, passed: true, problems: [], said: "The build has passed." };
else if (!lock.gates.spec?.passed) {
  const problems = specProblems(dir);
  out = problems.length ? { code: 1, phase: "spec", passed: false, problems } : { code: 4, phase: "spec", passed: false, problems: [], waiting: true, said: "The spec is ready for the person." };
} else {
  const gates = Object.fromEntries(GATES.map((g) => [g, gateProblems(dir, g)]));
  const problems = GATES.flatMap((g) => gates[g].map((p) => `${GATE_TITLES[g]}: ${p}`));
  if (problems.length) out = { code: 1, phase: "build", passed: false, gates, problems, tests_fixed: false };
  else { lock.gates.build = { passed: true, by: "check" }; writeLock(dir, lock); out = { code: 0, phase: "build", passed: true, gates, problems: [], said: "The build has passed every gate." }; }
}
console.log(JSON.stringify({ phases: PHASES, ...out }));
process.exitCode = out.code;
