// Every expected value a rule decides is worked twice, and the two agree.
// Written by the test writer into every suite it writes, the same bytes each
// time; it is the test writer's file and not the package's, so it is never
// edited here. The next suite the test writer writes for this package brings
// its current copy.
//   node --test test/worked-values.test.mjs
//
// What is worth pinning. A suite is written before the scripts exist, so its
// expected values are worked out by whoever writes it, and a value worked out
// in the head is often wrong: a vowel-counter suite pinned 16 vowels in
// "Education provides curious insights." (it holds 14), and an acronym-maker
// suite pinned "HTTP" for "hypertext transfer protocol" when the spec takes
// one letter per word. A suite that pins a wrong value cannot be passed by a
// script that keeps the spec, and the build stops at the code step (technical
// debt 646).
//
// How it is reached. Each value the spec's rule decides from the input (a
// count, a total, letters taken from words, an order) is written once as the
// literal the writer expects and once as a computation, plain code over the
// same input in the test file itself, never a script's function:
//
//   import { worked } from "./worked-values.test.mjs";
//   const TOTAL = worked(14, () => vowelsIn(SENTENCE), "the vowels in SENTENCE");
//
// as a constant at the top of the file, before any test (called inside a
// test, the test it adds would start inside that one and be cancelled, and a
// script reached first would keep it from running at all). worked() gives the
// literal back and checks it against its computation; the first worked()
// in a file adds one test, "every worked value agrees with its own
// computation", which fails naming each value that does not, so the
// disagreement is said once, plainly, and never mistaken for a script's
// fault. The test writer runs every file before it delivers the suite, and a
// disagreement goes back to the writer to settle. This file's own tests run
// only when this file is run itself, so importing worked from it adds none
// beyond that one.
//
// Nothing here touches a network, a model or a host.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect, isDeepStrictEqual } from "node:util";

const ME = fileURLToPath(import.meta.url);
const trim = (s) => String(s ?? "").trim();

/** How a disagreement opens; the test writer reads failures by these words. */
export const WRONG = "worked values disagree with their own computations:";

const show = (v) => (typeof v === "string" ? JSON.stringify(v) : inspect(v, { depth: 4, breakLength: Infinity, compact: true }));

/** Where worked() was called from, as test/<file>:<line>, read off the
 *  stack: the first frame that is not this file. */
function calledFrom(stack) {
  for (const line of String(stack ?? "").split("\n").slice(1)) {
    const m = /\(?((?:file:\/\/)?[^()\s]+?):(\d+):\d+\)?\s*$/.exec(line.trim());
    if (!m) continue;
    let file = m[1];
    try { if (file.startsWith("file:")) file = fileURLToPath(file); } catch { continue; }
    if (resolve(file) === resolve(ME) || file.startsWith("node:")) continue;
    const parts = file.replace(/\\/g, "/").split("/");
    return `${parts.slice(-2).join("/")}:${m[2]}`;
  }
  return "";
}

/** Why this literal and its computation disagree, as one sentence, or "" when
 *  they agree. Pure apart from running the computation. */
export function disagreement(expected, compute, what = "", at = "") {
  const label = `${trim(what) || show(expected)}${at ? ` (${at})` : ""}`;
  if (typeof compute !== "function") return `${label}: no computation was given beside the value ${show(expected)}, so nothing checks it`;
  let got;
  try { got = compute(); } catch (e) {
    return `${label}: its computation threw "${trim(e?.message ?? e)}"; a computation is the test's own plain code over the test's own input, never a script's function`;
  }
  if (got && typeof got.then === "function") return `${label}: its computation answered a promise; it must work the value out directly`;
  if (isDeepStrictEqual(got, expected)) return "";
  return `${label}: the test pins ${show(expected)} and its own computation gives ${show(got)}`;
}

const wrong = [];
let added = false;

/** The literal, given back, after it is checked against its computation.
 *  A disagreement fails the one test this adds to the file. */
export function worked(expected, compute, what = "") {
  const said = disagreement(expected, compute, what, calledFrom(new Error().stack));
  if (said) wrong.push(said);
  if (!added) {
    added = true;
    test("every worked value agrees with its own computation", () => {
      if (wrong.length) throw new Error(`${WRONG}\n${wrong.join("\n")}`);
    });
  }
  return expected;
}

const ranDirectly = Boolean(process.argv[1]) && resolve(process.argv[1]) === ME;
if (ranDirectly) {
  test("a value its computation gives agrees, and one it does not is named with both values", () => {
    assert.equal(disagreement(14, () => 14, "n"), "");
    assert.match(disagreement(16, () => 14, "n"), /pins 16 and its own computation gives 14/);
  });

  test("a computation that throws or is missing is said, not passed", () => {
    assert.match(disagreement(1, () => { throw new Error("no"); }, "n"), /threw "no"/);
    assert.match(disagreement(1, null, "n"), /no computation/);
  });
}
