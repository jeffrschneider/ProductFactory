// What the job did not have, and what it did anyway.
//
// Handed four of the five things it takes, a model will usually carry on and
// make something plausible, and most of the time that is what we want: a
// mismatch it can bridge is not worth stopping a run over. What it must never
// do is bridge a gap in silence, because then the run looks finished, the
// buyer reads a confident answer, and nobody ever learns which piece was
// absent. A run that quietly went without something is worse than one that
// stopped, because the stop is visible and this is not.
//
// So the moment a step finds something missing and goes on regardless, it
// says so here. At reply time the notes become a paragraph, and the rules say
// that paragraph goes in the reply. Nothing in this file refuses anything,
// stops anything, or checks anything against a declaration: it is a place to
// be honest in, not a gate.
//
// This is the shared file, copied whole from the solution planner. One
// difference from the copy in the reference
// package: note() returns the entry it recorded, because this package's suite
// reads the note back from the return value.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const FILE = "went-without.json";

const trim = (s) => String(s ?? "").trim();

/** The record's path inside a job's records folder. */
export function fileIn(records) { return join(records, FILE); }

/** Say that the job went without something and carried on.
 *
 *  `wanted` is the thing that was not there, named the way the offering names
 *  it. `did` is what the step did instead, as a verb phrase that reads after
 *  "it": "took the colours off the source page". It is the half that matters,
 *  because a note saying only that something was missing tells a reader
 *  nothing about what they are holding. `why` is optional and only worth
 *  writing when the reason is known, because a guess at a reason reads
 *  exactly like a fact.
 *
 *  Repeats are kept as one: a step run twice over the same absence has not
 *  gone without it twice. */
export function note(records, { wanted, did, why = "" } = {}) {
  if (!trim(wanted)) throw new Error("a note needs `wanted`: the thing that was not there");
  if (!trim(did)) throw new Error(`a note for "${trim(wanted)}" needs \`did\`: what this job did instead, which is the part a reader needs`);
  const path = fileIn(records);
  const kept = read(records);
  const entry = { wanted: trim(wanted), did: trim(did), ...(trim(why) ? { why: trim(why) } : {}) };
  const already = kept.findIndex((e) => e.wanted === entry.wanted);
  if (already >= 0) kept[already] = entry;
  else kept.push(entry);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ went_without: "v1", entries: kept }, null, 2) + "\n");
  return entry;
}

/** What this job went without, in the order it was found out. An unreadable
 *  or absent record is an empty list and never an error: this is the file
 *  that exists to make a job honest, and failing to read it must not be the
 *  thing that stops the job from replying at all. */
export function read(records) {
  const path = fileIn(records);
  if (!existsSync(path)) return [];
  try {
    const doc = JSON.parse(readFileSync(path, "utf8"));
    const entries = Array.isArray(doc?.entries) ? doc.entries : [];
    return entries.filter((e) => e && trim(e.wanted) && trim(e.did));
  } catch { return []; }
}

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const count = (n) => WORDS[n] ?? String(n);

/** The paragraph for the reply, or "" when the job went without nothing.
 *
 *  Written so the buyer can stop after the first sentence and still know that
 *  something is missing, and read on to learn what was done about it. */
export function sentence(entries = []) {
  const list = entries.filter((e) => e && trim(e.wanted) && trim(e.did));
  if (!list.length) return "";
  const named = (e) => `${trim(e.wanted)}${trim(e.why) ? ` (${trim(e.why)})` : ""}`;
  // `did` is a verb phrase, so it reads after "it": "took the colours off the
  // source page". A note written with the subject already on it is taken as
  // meant rather than doubled.
  const didOf = (e) => trim(e.did).replace(/^it\s+/i, "");
  const lines = list.map((e) => `Without ${trim(e.wanted)}, it ${didOf(e)}`)
    .map((l) => (l.endsWith(".") ? l : `${l}.`));
  // One absence names the thing once and goes straight on to what was done
  // about it. Naming it up front and again in the next sentence is how the
  // first draft of this read, and it reads like a form rather than a person.
  if (list.length === 1) {
    const only = list[0];
    return `This job went ahead without ${named(only)}: it ${didOf(only)}${trim(only.did).endsWith(".") ? "" : "."}`;
  }
  const all = list.map(named);
  const joined = `${all.slice(0, -1).join(", ")} and ${all[all.length - 1]}`;
  return `This job went ahead without ${count(list.length)} of the things it takes: ${joined}. ${lines.join(" ")}`;
}

/** Everything at once, for a step that just wants the paragraph. */
export function paragraph(records) { return sentence(read(records)); }
