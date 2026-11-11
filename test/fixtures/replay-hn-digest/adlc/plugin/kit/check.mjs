// The check: one command, for whichever stage the build folder is at.
//
// It says the stage, what is missing there, and nothing else to do. Every
// pinned file is held first: a stage cannot pass over a pin that moved. When a
// stage's check passes, a stage the check gates is passed and its files are
// pinned; Requirements passes only on the person's word (approve.mjs), so the
// check says so and stops.
//
//   needs: node >= 22
//   node .adlc/check.mjs          check the stage the folder is at
//   node .adlc/check.mjs --json   the same, as JSON
//
// Exit 0: the stage passed (or every stage has). 1: something is missing,
// named. 3: a pinned file moved. 4: the stage waits on the person.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { basename } from "node:path";
import { BY_PERSON, CHECKS, STAGES, TITLES, lockOf, pass, pinProblems, stageOf, writeLock } from "./stages.mjs";

/** The folder the check is for: the one its .adlc/ sits in, or --dir. */
export function folderOf(argv = process.argv, here = dirname(fileURLToPath(import.meta.url))) {
  const at = argv.indexOf("--dir");
  if (at > 0) return argv[at + 1];
  return basename(here) === ".adlc" ? dirname(here) : process.cwd();
}

/** One run of the check over a folder. Writes the lock when a stage passes. */
export async function checkFolder(dir) {
  let lock = lockOf(dir);
  const moved = pinProblems(dir, lock);
  const stage = stageOf(lock);
  if (moved.length) return { code: 3, stage, passed: false, problems: moved };
  if (!stage) return { code: 0, stage: null, passed: true, problems: [], said: "Every stage has passed." };
  const check = CHECKS[stage];
  if (!check) return { code: 1, stage, passed: false, problems: [`the check for ${TITLES[stage]} is not built yet`] };
  const problems = await check(dir, lock);
  if (problems.length) return { code: 1, stage, passed: false, problems };
  if (BY_PERSON.has(stage)) {
    return { code: 4, stage, passed: false, problems: [], waiting: true,
      said: `${TITLES[stage]} is ready for the person. Show them the spec and ask them to approve it by running \`node .adlc/approve.mjs\` themselves; you may not run it.` };
  }
  lock = pass(dir, lock, stage);
  writeLock(dir, lock);
  const next = stageOf(lock);
  return { code: 0, stage, passed: true, problems: [], next, said: `${TITLES[stage]} passed and its files are pinned.${next ? ` Next: ${TITLES[next]}.` : " Every stage has passed."}` };
}

function say(r) {
  const at = r.stage ? TITLES[r.stage] : "Done";
  if (r.code === 3) return `${at}: a pinned file moved.\n${r.problems.map((p) => `  - ${p}`).join("\n")}`;
  if (r.problems.length) return `${at}: ${r.problems.length} thing${r.problems.length === 1 ? "" : "s"} missing.\n${r.problems.map((p) => `  - ${p}`).join("\n")}`;
  return `${at}: ${r.said}`;
}

const thisFile = process.argv[1] ? process.argv[1].replace(/\\/g, "/").split("/").pop() : "";
if (thisFile === "check.mjs" && import.meta.url.endsWith("/check.mjs")) {
  checkFolder(folderOf()).then((r) => {
    console.log(process.argv.includes("--json") ? JSON.stringify({ stages: STAGES, ...r }, null, 2) : say(r));
    process.exitCode = r.code;
  }, (e) => { console.error(e.message); process.exitCode = 1; });
}
