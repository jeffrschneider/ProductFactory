// went-without.mjs: what a job did not have and went ahead without anyway.
//
// Each job keeps one record, went-without.json, in a folder of its own under
// the agent's records folder: join(RECORDS, basename(JOB_DIR)). It holds
// { entries: [{ wanted, did, why? }] }, one entry per thing wanted (a later
// note for the same thing replaces the earlier one), and no entries when the
// job lacked nothing.
//
//   needs: node >= 22; nothing else.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const FILE = "went-without.json";

/** Where the record sits in a job's own records folder. */
export function fileIn(dir) {
  return join(dir, FILE);
}

/** The entries kept so far; [] when there is no record yet. */
export function read(dir) {
  const at = fileIn(dir);
  if (!existsSync(at)) return [];
  try {
    const doc = JSON.parse(readFileSync(at, "utf8"));
    return Array.isArray(doc?.entries) ? doc.entries : [];
  } catch {
    return [];
  }
}

function write(dir, entries) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(fileIn(dir), JSON.stringify({ entries }, null, 2) + "\n");
}

/** Make sure the record exists, with whatever entries it already holds. */
export function keep(dir) {
  write(dir, read(dir));
}

/** Note one thing the job went without; a note for the same `wanted`
 *  replaces the earlier one, in its place. */
export function note(dir, { wanted, did, why } = {}) {
  const entry = { wanted: String(wanted ?? ""), did: String(did ?? "") };
  if (why) entry.why = String(why);
  const entries = read(dir);
  const at = entries.findIndex((e) => e?.wanted === entry.wanted);
  if (at >= 0) entries[at] = entry;
  else entries.push(entry);
  write(dir, entries);
  return entries;
}

const NUMBERS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const numberWord = (n) => NUMBERS[n] ?? String(n);
const listOf = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const stop = (s) => (/[.!?]$/.test(s) ? s : `${s}.`);

/** The entries as plain sentences for a reply; "" when there are none. */
export function sentence(entries = []) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && e.wanted);
  if (!list.length) return "";
  if (list.length === 1) {
    const [e] = list;
    return stop(`This job went ahead without ${e.wanted}${e.why ? ` (${e.why})` : ""}: ${e.did}`);
  }
  const head = `This job went ahead without ${numberWord(list.length)} of the things it takes: ${listOf(list.map((e) => e.wanted))}.`;
  const each = list.map((e) => stop(`Without ${e.wanted}${e.why ? ` (${e.why})` : ""}, it ${e.did}`));
  return [head, ...each].join(" ");
}

/** The record in a job's records folder, as a paragraph. */
export function paragraph(dir) {
  return sentence(read(dir));
}
