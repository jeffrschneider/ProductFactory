// The person's word: approve the spec, or send the build back to a stage.
//
// This is the person's command and never the builder's. In Claude Code a hook
// stops the assistant from running it; with no lifecycle service behind the
// folder that is a convention on this machine, and it becomes binding when a
// lifecycle or a pull request check holds the same folder.
//
// Approving runs the Requirements check first: a spec the check holds is not
// approved, and the problems are said.
//
//   needs: node >= 22
//   node .adlc/approve.mjs                       approve the spec: Requirements passes, and the spec is pinned
//   node .adlc/approve.mjs --send-back <stage>   reopen that stage and every one after it
import { CHECKS, STAGES, TITLES, lockOf, pass, pinProblems, sendBack, stageOf, writeLock } from "./stages.mjs";
import { folderOf } from "./check.mjs";

export async function approve(dir, { by = "the person" } = {}) {
  const lock = lockOf(dir);
  if (lock.gates?.requirements) return { code: 0, said: "The spec is already approved. To change it, send the build back to requirements." };
  const moved = pinProblems(dir, lock);
  if (moved.length) return { code: 3, said: `A pinned file moved, so nothing was approved:\n${moved.map((p) => `  - ${p}`).join("\n")}` };
  const problems = await CHECKS.requirements(dir, lock);
  if (problems.length) return { code: 1, said: `The spec is not ready to approve:\n${problems.map((p) => `  - ${p}`).join("\n")}` };
  writeLock(dir, pass(dir, lock, "requirements", { by }));
  return { code: 0, said: "Approved. The spec is pinned, and the build moves to Architecture." };
}

export function sendBackTo(dir, stage) {
  if (!STAGES.includes(stage)) return { code: 2, said: `${stage} is not a stage; the stages are ${STAGES.join(", ")}` };
  const lock = lockOf(dir);
  writeLock(dir, sendBack(dir, lock, stage));
  const at = stageOf(lockOf(dir));
  return { code: 0, said: `Sent back to ${TITLES[stage]}: it and every stage after it are open again, and their files are no longer pinned. The build is at ${TITLES[at]}.` };
}

const thisFile = process.argv[1] ? process.argv[1].replace(/\\/g, "/").split("/").pop() : "";
if (thisFile === "approve.mjs" && import.meta.url.endsWith("/approve.mjs")) {
  const dir = folderOf();
  const back = process.argv.indexOf("--send-back");
  const run = back > 0 ? Promise.resolve(sendBackTo(dir, process.argv[back + 1])) : approve(dir);
  run.then((r) => { console.log(r.said); process.exitCode = r.code; }, (e) => { console.error(e.message); process.exitCode = 1; });
}
