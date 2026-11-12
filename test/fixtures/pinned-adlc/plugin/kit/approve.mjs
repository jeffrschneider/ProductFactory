// The person's word: approve the spec, or send the build back.
//
// This is the person's command and never the builder's. In Claude Code a hook
// stops the assistant from running it; with no lifecycle service behind the
// folder that is a convention on this machine, and it becomes binding when a
// lifecycle or a pull request check holds the same folder.
//
// Approving runs the spec's check first: a spec the check holds is not
// approved, and the problems are said.
//
//   needs: node >= 22
//   node .adlc/approve.mjs                   approve the spec: it can no longer change, and the build starts
//   node .adlc/approve.mjs --send-back spec  reopen the spec, and the build after it
//   node .adlc/approve.mjs --send-back build reopen the build: the tests can change again
import { CHECKS, PHASES, TITLES, lockOf, pass, phaseOf, pinProblems, sendBack, writeLock } from "./stages.mjs";
import { folderOf } from "./check.mjs";

export async function approve(dir, { by = "the person" } = {}) {
  const lock = lockOf(dir);
  if (lock.gates?.spec) return { code: 0, said: "The spec is already approved. To change it, send the build back to the spec (--send-back spec)." };
  const moved = pinProblems(dir, lock);
  if (moved.length) return { code: 3, said: `A file that can no longer change was changed, so nothing was approved:\n${moved.map((p) => `  - ${p}`).join("\n")}` };
  const problems = await CHECKS.spec(dir, lock);
  if (problems.length) return { code: 1, said: `The spec is not ready to approve:\n${problems.map((p) => `  - ${p}`).join("\n")}` };
  writeLock(dir, pass(dir, lock, "spec", { by }));
  return { code: 0, said: "Approved. The spec can no longer change, and the build starts." };
}

export function sendBackTo(dir, phase) {
  if (!PHASES.includes(phase)) return { code: 2, said: `${phase} is not a phase; send the build back to the spec or to the build (--send-back spec, --send-back build)` };
  writeLock(dir, sendBack(dir, lockOf(dir), phase));
  const now = phaseOf(lockOf(dir));
  return { code: 0, said: phase === "spec"
    ? `Sent back to the spec: the spec can change again, and so can everything built on it. ${TITLES[now]} is open.`
    : "Sent back to the build: the tests can change again, and the build is checked from the start." };
}

const thisFile = process.argv[1] ? process.argv[1].replace(/\\/g, "/").split("/").pop() : "";
if (thisFile === "approve.mjs" && import.meta.url.endsWith("/approve.mjs")) {
  const dir = folderOf();
  const back = process.argv.indexOf("--send-back");
  const run = back > 0 ? Promise.resolve(sendBackTo(dir, process.argv[back + 1])) : approve(dir);
  run.then((r) => { console.log(r.said); process.exitCode = r.code; }, (e) => { console.error(e.message); process.exitCode = 1; });
}
