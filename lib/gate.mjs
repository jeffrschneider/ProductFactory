// The gate on every push to the "Write the scripts" pull request: what one
// commit of the build folder comes to.
//
//   1. The fence and the static review (fence.mjs). Any problem ends the run
//      as a failure that names each file: nothing refused is ever run.
//   2. A records/conflict.md the coding agent pushed ends the run there, with
//      nothing run: it says a test cannot pass without breaking what the
//      agent's files say, and the owner decides whether to send the build
//      back to Test.
//   3. The suite, and the suite again with each script blanked
//      (gate-suite.mjs), in a folder of its own holding the files the fence
//      allowed.
//   4. When all of that passed, the code critic and the security reviewer
//      read it (review.mjs), where the lifecycle uses their stages and their
//      holders can run.
//
// A passing gate merges nothing. Your OK in the console does.
//
// Ported from AgentMesh's hand-off gate (services/src/handoffs/gate.ts and
// gate-run.ts) with the rules unchanged. There the suite ran in a sandbox
// job; here it runs on your computer, where your coding harness and the
// suite already run in local mode.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFLICT_FILE, CONFLICT_MAX_CHARS, LOCK_FILE, fenceOfTree, judgedFiles } from "./fence.mjs";
import { run } from "./exec.mjs";

const SUITE_SCRIPT = fileURLToPath(new URL("./gate-suite.mjs", import.meta.url));
export const RESULT_TAG = "GATE_RESULT ";

/** The check's title when the coding agent stopped on a conflict. */
export const CONFLICT_TITLE = "Stopped on a conflict: a test your coding agent cannot pass";

/** What the coding agent said, when this commit carries a records/conflict.md
 *  of its own (not one the repository already had at issue); null otherwise. */
export function conflictIn(issued, files) {
  const bytes = judgedFiles(issued, files).get(CONFLICT_FILE);
  if (!bytes) return null;
  const text = Buffer.from(bytes).toString("utf8").trim();
  return text ? text : null;
}

/** The check's words for a conflict: the coding agent's own, fenced so they
 *  cannot close the fence, and what the owner does next. */
export function conflictSummary(words) {
  const longest = Math.max(2, ...[...words.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(longest + 1);
  return [
    `Your coding agent stopped: it says a test cannot pass without breaking what the agent's files say. In its words (${CONFLICT_FILE}):`,
    `${f}text\n${words}\n${f}`,
    "Nothing was run. Which of the two is wrong is the owner's call. If the test is wrong, Send back to Test in the console has the test writer revise the suite, and the revised tests come back as a new commit on this branch. If the agent's files are wrong, the spec is changed first.",
  ].join("\n\n");
}

/** The words for a list of problems, one line each. */
export const problemLines = (problems) => problems.map((p) => `- \`${p.path}\` ${p.what}`).join("\n");

/** The GATE_RESULT line in what gate-suite.mjs printed: the result, { error }, or null. */
export function readGateResult(stdout) {
  const line = String(stdout ?? "").split(/\r?\n/).reverse().find((l) => l.startsWith(RESULT_TAG));
  if (!line) return null;
  let got;
  try { got = JSON.parse(line.slice(RESULT_TAG.length)); } catch { return null; }
  if (typeof got.error === "string" && got.error) return { error: got.error };
  if (!got.suite) return null;
  return { suite: got.suite, blanks: Array.isArray(got.blanks) ? got.blanks : [] };
}

/** Whether the run passed, in words a check can carry: { passed, words, items }. */
export function judgeGateRun(result, scripts) {
  const s = result.suite;
  const said = [];
  const items = [];
  let passed = true;
  if (s.timed_out) {
    passed = false;
    said.push("The suite did not finish in time.");
  } else if (!s.tests) {
    passed = false;
    said.push(s.said ? `The suite did not run: ${s.said}.` : "The suite ran no tests.");
  } else if (s.exit !== 0 || s.fail > 0) {
    passed = false;
    const count = s.failing_count ?? s.failing.length;
    const more = count > s.failing.length ? `, and ${count - s.failing.length} more` : "";
    said.push(`${s.fail} of ${s.tests} tests failed: ${s.failing.join("; ")}${more}.`);
    items.push(...s.failing);
  } else {
    said.push(`All ${s.tests} tests passed.`);
  }
  const seen = new Map(result.blanks.map((b) => [b.script, b]));
  const missed = scripts.filter((p) => seen.get(p)?.noticed !== true);
  if (scripts.length && s.exit === 0 && s.fail === 0 && s.tests) {
    if (missed.length) {
      passed = false;
      said.push(`With ${missed.join(", ")} blanked the suite still passed, so nothing tests ${missed.length === 1 ? "it" : "them"}.`);
      items.push(...missed.map((p) => `nothing tests ${p}`));
    } else {
      said.push(`Blanking each of the ${scripts.length} script${scripts.length === 1 ? "" : "s"} made the suite fail, as it should.`);
    }
  }
  return { passed, words: said.join(" "), items };
}

/** A path from a commit that may be written under a folder: relative, no climbing out, no drive. */
const safePath = (p) => typeof p === "string" && p && !p.startsWith("/") && !/(^|\/)\.\.?(\/|$)/.test(p) && !/[\\:]/.test(p);

/**
 * The suite run: the judged files written into folder (less the lock, the
 * coding step's records and anything under .gate/), then gate-suite.mjs run
 * there. Resolves to { ok, passed, words, items } or { ok: false, reason }.
 */
export async function runGateSuite({ folder, files, scripts, seconds, env, signal }) {
  mkdirSync(folder, { recursive: true });
  for (const [path, bytes] of files) {
    if (path === LOCK_FILE || path.startsWith("records/") || path.startsWith(".gate/") || !safePath(path)) continue;
    const at = join(folder, ...path.split("/"));
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, bytes);
  }
  mkdirSync(join(folder, ".gate"), { recursive: true });
  writeFileSync(join(folder, ".gate", "scripts.json"), JSON.stringify(scripts));
  const e = { ...env, GATE_SUITE_SECONDS: String(seconds), GATE_BLANKS_DIR: join(dirname(folder), "blanks") };
  delete e.WORKSPACE; delete e.RECORDS;
  const r = await run([process.execPath, SUITE_SCRIPT], { cwd: folder, env: e, signal, timeoutMs: (seconds * (scripts.length + 1) + 60) * 1000, log: join(dirname(folder), "suite.log") });
  if (r.stopped) return { ok: false, reason: "It was stopped." };
  if (r.timedOut) return { ok: false, reason: "The gate's test run did not finish in time." };
  const read = readGateResult(r.stdout);
  if (!read) return { ok: false, reason: `The gate's test run did not report the suite's result${r.error ? `: ${r.error}` : ""}.` };
  if ("error" in read) return { ok: false, reason: `The gate's test run could not run the suite: ${read.error}` };
  return { ok: true, ...judgeGateRun(read, scripts) };
}

/**
 * Judge one commit of the build folder. tree: every file of the commit, by
 * its path from the top of the repository. runSuite(judged) and
 * review(judged, words) are the suite run and the reviews.
 * Resolves to { passed, title, summary, items, conflict?, judged? }.
 */
export async function judgeFolder(issued, tree, { runSuite, review }) {
  const { files, scoped, fence, stat } = fenceOfTree(issued, tree);
  if (fence.length || stat.length) {
    const parts = [];
    if (fence.length) parts.push(`These files are outside what the coding step may change:\n${problemLines(fence)}`);
    if (stat.length) parts.push(`The review refused:\n${problemLines(stat)}`);
    parts.push("Nothing was run. Fix these and push again.");
    const n = fence.length + stat.length;
    return { passed: false, title: `Refused: ${n} problem${n === 1 ? "" : "s"}`, summary: parts.join("\n\n"), items: [...fence, ...stat].map((p) => `${p.path} ${p.what}`) };
  }
  const conflict = conflictIn(scoped, files);
  if (conflict !== null) {
    if (conflict.length > CONFLICT_MAX_CHARS) {
      return { passed: false, title: "Refused: the conflict is too long", summary: `${CONFLICT_FILE} is ${conflict.length.toLocaleString("en-US")} characters; the gate reads at most ${CONFLICT_MAX_CHARS.toLocaleString("en-US")}. Say it more briefly, naming each test and the line it contradicts, and push again. Nothing was run.`, items: [] };
    }
    return { passed: false, title: CONFLICT_TITLE, summary: conflictSummary(conflict), items: [], conflict };
  }
  const judged = judgedFiles(scoped, files);
  const got = await runSuite(judged);
  if (!got.ok) return { passed: false, title: "The test run did not finish", summary: got.reason, items: [], judged };
  if (!got.passed) return { passed: false, title: "The tests did not pass", summary: got.words, items: got.items ?? [], judged };
  const v = await review(judged, got.words);
  return { ...v, judged };
}
