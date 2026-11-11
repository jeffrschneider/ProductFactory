// The stand-in approval: Requirements passes on the person's word, or a stage and every one after it reopen.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { STAGES, lockOf, writeLock, problemsAt } from "./stages.mjs";
const dir = dirname(dirname(fileURLToPath(import.meta.url)));
const lock = lockOf(dir);
const at = process.argv.indexOf("--send-back");
if (at > 0) {
  const from = STAGES.indexOf(process.argv[at + 1]);
  for (const s of STAGES.slice(from)) delete lock.gates[s];
  writeLock(dir, lock);
  console.log(`Sent back to ${process.argv[at + 1]}.`);
} else {
  const p = problemsAt(dir, "requirements");
  if (p.length) { console.log(`The spec is not ready to approve:\n  - ${p.join("\n  - ")}`); process.exit(1); }
  lock.gates.requirements = { passed: true, by: "the person" };
  writeLock(dir, lock);
  console.log("Approved. The spec is pinned, and the build moves to Architecture.");
}
