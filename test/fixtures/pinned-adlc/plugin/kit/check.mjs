// The check: one command, for the phase the build folder is in.
//
// A build has two phases. In the spec, the check runs the spec's rules, and
// when they pass it says the spec waits for the person's approval
// (approve.mjs). In the build, it runs every gate over the folder (the
// architecture record, the agent's files, the tests and the code) and names
// what each still needs; the builder writes in any order. Anything that can no
// longer change (the approved spec, the tests once the code has been judged,
// the kit) is checked first. When every gate passes, the build passes and the
// folder's files are fixed.
//
//   needs: node >= 22
//   node .adlc/check.mjs          check the folder
//   node .adlc/check.mjs --json   the same, as JSON
//
// Exit 0: the build passed. 1: something is missing, named. 3: a file that
// can no longer change was changed. 4: the spec waits for the person.
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CHECKS, GATES, GATE_TITLES, PHASES, lockOf, pass, phaseOf, pinProblems, writeLock } from "./stages.mjs";

/** The folder the check is for: the one its .adlc/ sits in, or --dir. */
export function folderOf(argv = process.argv, here = dirname(fileURLToPath(import.meta.url))) {
  const at = argv.indexOf("--dir");
  if (at > 0) return argv[at + 1];
  return basename(here) === ".adlc" ? dirname(here) : process.cwd();
}

/** One run of the check over a folder. Writes the lock when the tests become
 *  fixed and when the build passes. */
export async function checkFolder(dir) {
  let lock = lockOf(dir);
  const moved = pinProblems(dir, lock);
  const phase = phaseOf(lock);
  if (moved.length) return { code: 3, phase, passed: false, problems: moved };
  if (!phase) return { code: 0, phase: null, passed: true, problems: [], said: "The build has passed." };
  if (phase === "spec") {
    const problems = await CHECKS.spec(dir, lock);
    if (problems.length) return { code: 1, phase, passed: false, problems };
    return { code: 4, phase, passed: false, problems: [], waiting: true,
      said: "The spec is ready for the person. Show it to them in plain words and ask them to approve it by running `node .adlc/approve.mjs` themselves; you may not run it." };
  }
  const built = await CHECKS.build(dir, lock);
  if (built.lock !== lock) { lock = built.lock; writeLock(dir, lock); }
  if (built.problems.length) return { code: 1, phase, passed: false, gates: built.gates, problems: built.problems, tests_fixed: Boolean(lock.tests_fixed) };
  writeLock(dir, pass(dir, lock, "build"));
  return { code: 0, phase, passed: true, gates: built.gates, problems: [], said: "The build has passed every gate, and its files are fixed. Commit the folder and open the pull request." };
}

function say(r) {
  if (r.code === 3) return `A file that can no longer change was changed.\n${r.problems.map((p) => `  - ${p}`).join("\n")}`;
  if (!r.phase) return r.said;
  if (r.phase === "spec") return r.problems.length ? `The spec: ${r.problems.length} thing${r.problems.length === 1 ? "" : "s"} missing.\n${r.problems.map((p) => `  - ${p}`).join("\n")}` : `The spec: ${r.said}`;
  if (r.passed) return `The build: ${r.said}`;
  const lines = [`The build: ${r.problems.length} thing${r.problems.length === 1 ? "" : "s"} missing.`];
  for (const g of GATES) {
    const ps = r.gates?.[g] ?? [];
    lines.push(`  ${GATE_TITLES[g]}: ${ps.length ? "" : "passes"}`);
    for (const p of ps) lines.push(`    - ${p}`);
  }
  return lines.join("\n");
}

const thisFile = process.argv[1] ? process.argv[1].replace(/\\/g, "/").split("/").pop() : "";
if (thisFile === "check.mjs" && import.meta.url.endsWith("/check.mjs")) {
  checkFolder(folderOf()).then((r) => {
    console.log(process.argv.includes("--json") ? JSON.stringify({ phases: PHASES, ...r }, null, 2) : say(r));
    process.exitCode = r.code;
  }, (e) => { console.error(e.message); process.exitCode = 1; });
}

