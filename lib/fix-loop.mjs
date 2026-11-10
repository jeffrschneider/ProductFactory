// The fix loop: Code on a pull request, with code.harness set. Product
// Factory runs your coding harness itself, round by round, and the gate's
// findings go straight back to it, for at most code.fix_rounds rounds:
//
//   1. the round's folder is the build folder as the branch's newest commit
//      has it, read through the API, with every pinned file as approved
//   2. the harness runs there with the round's prompt (fixPrompt): AGENTS.md
//      and `node .adlc/check.mjs`, and from the second round on the last gate
//      run's findings, word for word
//   3. what it changed under scripts/ (and records/conflict.md) goes on the
//      branch as one commit Product Factory makes; anything else it changed is
//      left out and named in the round's record
//   4. the gate runs on that commit as on any push
//
// A pass waits for your OK. A conflict or a security refusal stops the loop
// and waits on you (stopOf). Any other refusal starts the next round while
// rounds remain; then Code is refused with the last gate run's words.
//
// This file holds the parts that only read and write folders and words; the
// runner (runner.mjs fixLoop) drives the rounds.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { digestOf } from "./fence.mjs";
import { fixRoundPath } from "./pull-request.mjs";

/** How many fix rounds a loop gets when product-factory.json sets none (code.fix_rounds). */
export const FIX_ROUNDS_DEFAULT = 3;

const short = (sha) => String(sha ?? "").slice(0, 7);
const rel = (base, at) => relative(base, at).split(sep).join("/");

/** Whether a build's Code runs the fix loop: on a pull request, with a harness named. */
export const fixLoopOn = (settings) => settings?.code?.holder === "pull-request" && Array.isArray(settings.code.harness) && settings.code.harness.length > 0;

/** The rounds one loop gets, from the build's settings. */
export const fixRoundsOf = (settings) => (Number.isInteger(settings?.code?.fix_rounds) && settings.code.fix_rounds > 0 ? settings.code.fix_rounds : FIX_ROUNDS_DEFAULT);

/** The instruction every round starts with. */
export const FIX_FIRST = "Read AGENTS.md in this folder and do what it says: write the scripts under scripts/ until `node .adlc/check.mjs` exits 0. Change nothing outside scripts/. If a test contradicts the spec, so that it cannot pass without breaking what the spec says, do not change the test: write why in records/conflict.md, naming the test and what in the spec it contradicts, and stop there.";

/** The last gate run's findings, word for word: its title, its summary and its items. */
export function findingsText(last) {
  const items = last.items?.length ? ["", "Items:", ...last.items.map((x) => `- ${x}`)] : [];
  return [last.title, "", last.summary, ...items].join("\n");
}

/**
 * The words a fix round sends the harness. round: the round's number in this
 * loop. last: the last gate run ({ sha, title, summary, items }) from the
 * second round on, else null.
 */
export function fixPrompt({ round, last = null, upToDate = null }) {
  // A feature's branch brought up to date with the version's base, with scripts both changed (feature-runs.mjs): its note goes with the round.
  const merged = upToDate ? ["", `The branch was brought up to date with the version's base, and records/up-to-date.md says what that left for you to do:`, "", upToDate.trim()] : [];
  if (!last) return [FIX_FIRST, ...merged].join("\n");
  return [
    FIX_FIRST,
    ...merged,
    "",
    `This is fix round ${round}. Product Factory's gate ran on commit ${short(last.sha)} and did not pass it. What it found, word for word:`,
    "",
    findingsText(last),
    "",
    "Fix what it found, then run the check again.",
  ].join("\n");
}

/** A path from a commit that may be written under a folder: relative, no climbing out, no drive. */
const safePath = (p) => typeof p === "string" && p && !p.startsWith("/") && !/(^|\/)\.\.?(\/|$)/.test(p) && !/[\\:]/.test(p);

/** The round's folder, written fresh from files (Map<path, bytes>). Paths that could leave it are not written. */
export function writeFolder(folder, files) {
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  for (const [p, bytes] of files) {
    if (!safePath(p)) continue;
    const at = join(folder, ...p.split("/"));
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, bytes);
  }
}

/** Every file in a folder, by its path inside it, with its digest. */
export function snapshotOf(folder) {
  const out = new Map();
  const walk = (d) => {
    let names = [];
    try { names = readdirSync(d); } catch { return; }
    for (const name of names.sort()) {
      const at = join(d, name);
      const st = statSync(at);
      if (st.isDirectory()) walk(at);
      else if (st.isFile()) out.set(rel(folder, at), digestOf(readFileSync(at)));
    }
  };
  walk(folder);
  return out;
}

/**
 * What the harness changed in the round's folder, against the snapshot taken
 * before it ran: { files: [{ path, bytes }], removed: [path], leftOut: [path] }.
 * files and removed are what a fix round commits (scripts/ and
 * records/conflict.md); leftOut is everything else it changed, added or removed.
 */
export function changesOf(before, folder) {
  const after = snapshotOf(folder);
  const files = [];
  const removed = [];
  const leftOut = [];
  for (const [p, d] of after) {
    if (before.get(p) === d) continue;
    if (fixRoundPath(p)) files.push({ path: p, bytes: readFileSync(join(folder, ...p.split("/"))) });
    else leftOut.push(p);
  }
  for (const p of before.keys()) {
    if (after.has(p)) continue;
    if (fixRoundPath(p)) removed.push(p);
    else leftOut.push(`${p} (removed)`);
  }
  return { files, removed, leftOut: leftOut.sort() };
}

/**
 * The build folder a round starts from: the branch's files, with every pinned
 * file as Product Factory approved it. A pinned file the branch changed or
 * removed is taken from the build's own folder when that one matches its
 * digest (the gate refuses the branch's copy either way).
 * Returns { files, restored: [path] }.
 */
export function roundFiles(branch, digests, localFolder) {
  const files = new Map(branch);
  const restored = [];
  for (const [p, d] of Object.entries(digests ?? {})) {
    const got = files.get(p);
    if (got && digestOf(got) === d) continue;
    const at = localFolder ? join(localFolder, ...p.split("/")) : null;
    if (!at || !existsSync(at)) continue;
    const bytes = readFileSync(at);
    if (digestOf(bytes) !== d) continue;
    files.set(p, bytes);
    restored.push(p);
  }
  return { files, restored };
}

/**
 * Why a gate run stops the loop, or null when the next round may fix it:
 * "conflict" when the harness wrote records/conflict.md, "security" when the
 * security reviewer refused it.
 */
export function stopOf(run) {
  if (run?.conflict) return "conflict";
  if (run?.reviews?.security && run.reviews.security.passed === false) return "security";
  return null;
}

/** A span of time in words: "4 s", "2 min 5 s". */
export function tookWords(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
}

/** A list of paths in words, at most n of them. */
export const pathWords = (list, n = 12) => `${list.slice(0, n).join(", ")}${list.length > n ? `, and ${list.length - n} more` : ""}`;
