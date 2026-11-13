// The stand-in approval: the spec passes on the person's word, or the build is
// sent back to the spec or to the build.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lockOf, writeLock, specProblems } from "./stages.mjs";
const dir = dirname(dirname(fileURLToPath(import.meta.url)));
const lock = lockOf(dir);
const at = process.argv.indexOf("--send-back");
if (at > 0) {
  const to = process.argv[at + 1];
  if (!["spec", "build"].includes(to)) { console.log("Send back to the spec or the build."); process.exit(2); }
  delete lock.gates.build;
  if (to === "spec") delete lock.gates.spec;
  writeLock(dir, lock);
  console.log(`Sent back to the ${to}.`);
} else {
  const p = specProblems(dir);
  if (p.length) { console.log(`The spec is not ready to approve:\n  - ${p.join("\n  - ")}`); process.exit(1); }
  lock.gates.spec = { passed: true, by: "the person" };
  writeLock(dir, lock);
  console.log("Approved. The spec can no longer change, and the build starts.");
}
