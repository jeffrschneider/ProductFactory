// The impact report: Markdown for the person who decides, with a structured
// header a program can read.
//
// The convention (the piece's `about` says the same, so the next reader and
// the delivered-formats test both know what to find):
//   front matter  report, subject, running, changed, read_at, verdict, counts,
//                 dependents (each with name, kind, owner, found_by, verdict,
//                 reason), approved
//   ## What changed
//   ## Each dependent
//   ## The agents that read what it hands back
//   ## What is owed
//   ## What to redo and what to reuse
//   ## Cost
//   ## Not read
//   ## Your decision
//
// Nothing in it depends on when it was written or on what the ledger said:
// the same two declarations and the same dependents always give the same
// bytes. What was filed, and its numbers, are in the reply and in the job's
// filed.json, never here.
//
//   needs: node >= 22
//   import { writeReport, HEADINGS, ABOUT } from "./report.mjs"
import { VERDICT_WORDS } from "./answer.mjs";
import { priceWords } from "./compare.mjs";

const trim = (s) => String(s ?? "").trim();
const q = (s) => JSON.stringify(String(s ?? ""));
const joinedWords = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const many = (n, w, ws = `${w}s`) => `${n} ${n === 1 ? w : ws}`;

export const HEADINGS = [
  "## What changed",
  "## Each dependent",
  "## The agents that read what it hands back",
  "## What is owed",
  "## What to redo and what to reuse",
  "## Cost",
  "## Not read",
  "## Your decision",
];

export const ABOUT = "The impact report, Markdown for the person who approves or refuses the change. A front matter header `report, subject, running, changed, read_at, verdict, counts, dependents, approved` lists each dependent with its answer (compatible, breaking or change of behavior) and the reason, then `## What changed`, `## Each dependent`, `## The agents that read what it hands back`, `## What is owed`, `## What to redo and what to reuse`, `## Cost`, `## Not read` and `## Your decision`. It approves nothing.";

const EFFECT_WORDS = { compatible: "compatible", breaking: "breaking", behaviour: "change of behavior", words: "words only", kind: "answered for each reader" };

function counts(answered) {
  const c = { compatible: 0, breaking: 0, behaviour: 0 };
  for (const a of answered) c[a.verdict] += 1;
  return c;
}

const countWords = (c) => `${c.breaking} breaking, ${c.behaviour} change of behavior, ${c.compatible} compatible`;

const foundWords = (a) => a.found_by.map((f) => `${f.source}${f.observed ? " (observed)" : ""}`).join(", ") || "given";

/** The report, as text. */
export function writeReport({ subject, before, after, dependents, diffs, answered, notes = [], owed = [], runtime = {}, said = "", pairing = "" }) {
  const c = counts(answered);
  const verdict = c.breaking ? "breaking" : c.behaviour ? "behaviour" : "compatible";
  const va = trim(before?.agent_version) || "unstated";
  const vb = trim(after?.agent_version) || "unstated";
  const readAt = trim(dependents?.read_at) || "not stated";
  const L = [];
  L.push("---");
  L.push("report: impact-report-v1");
  L.push(`subject: ${q(subject)}`);
  L.push(`running: ${q(va)}`);
  L.push(`changed: ${q(vb)}`);
  L.push(`read_at: ${q(readAt)}`);
  L.push(`verdict: ${q(VERDICT_WORDS[verdict])}`);
  L.push(`counts: ${q(countWords(c))}`);
  L.push(answered.length ? "dependents:" : "dependents: []");
  for (const a of answered) {
    L.push(`  - name: ${q(a.display)}`);
    L.push(`    kind: ${q(a.kind)}`);
    L.push(`    owner: ${q(a.owner_words)}`);
    L.push(`    found_by: ${q(foundWords(a))}`);
    L.push(`    verdict: ${q(VERDICT_WORDS[a.verdict])}`);
    L.push(`    reason: ${q(a.reasons.join(" "))}`);
  }
  L.push(`approved: ${q("no: this report approves nothing; the person who asked for the change decides")}`);
  L.push("---");
  L.push("");
  L.push(`# What changing ${subject} from ${va} to ${vb} touches`);
  L.push("");
  const lead = answered.length
    ? `${many(answered.length, "dependent")} ${answered.length === 1 ? "is" : "are"} named below, each with where it was found and its answer: ${countWords(c)}. ${c.breaking ? "A breaking answer means something it sends or gets back changes, or that it could not be told; each one says which." : c.behaviour ? "A change of behavior means nothing it sends or gets back stops fitting, but the agent may act differently, and only running the new version against each of them settles it." : "Nothing any of them uses changes in a way it would notice."}`
    : "Nothing is named as depending on this agent, so the change touches no dependent the platform knows of. The sources that could not be read are under Not read.";
  L.push(lead);
  if (said) { L.push(""); L.push(`The change, as given: ${said}`); }
  L.push("");

  L.push(HEADINGS[0]);
  L.push("");
  if (pairing) { L.push(`${pairing}.`); L.push(""); }
  const shown = diffs.filter((x) => x.effect !== "words");
  const wordsOnly = diffs.filter((x) => x.effect === "words");
  if (!shown.length) L.push("Nothing in the declaration that a dependent sends, gets back or pays changed.");
  for (const x of shown) L.push(`- ${x.words} (${EFFECT_WORDS[x.effect]})`);
  if (wordsOnly.length) {
    L.push("");
    L.push(`Words only, which change nothing a dependent sends or gets: ${wordsOnly.map((x) => x.words.replace(/\.$/, "").replace(/^The /, "the ")).join("; ")}.`);
  }
  L.push("");

  L.push(HEADINGS[1]);
  L.push("");
  if (!answered.length) L.push("None.");
  answered.forEach((a, i) => {
    L.push(`### ${i + 1}. ${a.display} (${a.kind})`);
    L.push("");
    L.push(`- Answer: **${VERDICT_WORDS[a.verdict]}**`);
    L.push(`- Owner: ${a.owner_words}`);
    L.push(`- Found by: ${a.found_by.map((f) => `${f.source}${f.observed ? ", observed" : ""}: ${f.words}`).join(" ") || "given with the job"}`);
    if (a.id) L.push(`- Id: ${a.id}`);
    const lines = (a.use?.reads ?? []).map((r) => `${r.output.replace(/^.*?\.out\./, "")} into ${joinedWords([...new Set(r.to.map((t) => (t.end ? "End" : `${t.label}'s ${t.port}`)))])}`);
    if (lines.length) L.push(`- What it reads: ${lines.join("; ")}`);
    else if (a.use && a.use.reads === null) L.push(`- What it reads: not known${a.how.startsWith("it was seen") ? `; ${a.how}` : ""}`);
    if (a.use?.sends?.length) L.push(`- What it sends: ${a.use.sends.join(", ")}`);
    L.push(`- Why: ${a.reasons.join(" ")}`);
    L.push("");
  });

  L.push(HEADINGS[2]);
  L.push("");
  const readers = new Map();
  for (const a of answered) {
    for (const e of a.effects ?? []) {
      if (!e.line || e.line.end) continue;
      const k = e.line.agent || e.line.label;
      if (!readers.has(k)) readers.set(k, { label: e.line.label, agent: e.line.agent, verdict: "compatible", seen: [] });
      const r = readers.get(k);
      if ({ compatible: 0, behaviour: 1, breaking: 2 }[e.effect] > { compatible: 0, behaviour: 1, breaking: 2 }[r.verdict]) r.verdict = e.effect;
      r.seen.push({ where: a.kind === "agent" ? "its own inputs" : (a.name ?? a.id ?? "a solution"), port: e.line.port, kind: e.line.kind, effect: e.effect, words: e.words });
    }
  }
  if (!readers.size) L.push("No agent was seen reading what it hands back: no canvas that was read draws a line out of it to another agent, and no agent was given as one that may take it.");
  else {
    L.push("Each agent that reads one of its outputs, on a canvas that was read or by its own inputs, with the worst answer for it.");
    L.push("");
    L.push("| Agent | Reads into | Takes | Answer | Where |");
    L.push("|---|---|---|---|---|");
    for (const r of [...readers.values()].sort((x, y) => (x.label < y.label ? -1 : x.label > y.label ? 1 : 0))) {
      const ports = [...new Set(r.seen.map((s) => s.port))].join(", ");
      const kinds = [...new Set(r.seen.map((s) => s.kind ?? "not stated"))].join(", ");
      const where = [...new Set(r.seen.map((s) => s.where))];
      L.push(`| ${r.label} | ${ports} | ${kinds} | ${VERDICT_WORDS[r.verdict]} | ${where.length > 3 ? `${where.slice(0, 3).join("; ")} and ${where.length - 3} more` : where.join("; ")} |`);
    }
    L.push("");
    for (const r of [...readers.values()].sort((x, y) => (x.label < y.label ? -1 : x.label > y.label ? 1 : 0))) {
      const w = [...new Set(r.seen.filter((s) => s.effect === r.verdict).map((s) => s.words))];
      L.push(`- ${r.label}: ${w.join(" ")}`);
    }
  }
  L.push("");

  L.push(HEADINGS[3]);
  L.push("");
  if (!owed.length) L.push("Nothing: no dependent is answered breaking or change of behavior, so no dependency debt is owed.");
  else {
    L.push(`${many(owed.length, "dependency debt item")} against ${subject}, one for each dependent answered breaking or change of behavior. Each holds back ${owed[0].blocks.join(" and ")} on ${subject} until it is closed, and is caused by: ${owed[0].caused_by}.`);
    L.push("");
    for (const o of owed) L.push(`- Owed to ${o.owed_to}: ${o.dependent.display} (${o.dependent.kind}).`);
    L.push("");
    L.push("The reply says whether each one was filed in the ledger and under what number.");
  }
  L.push("");

  L.push(HEADINGS[4]);
  L.push("");
  const redo = answered.filter((a) => a.verdict !== "compatible");
  const reuse = answered.filter((a) => a.verdict === "compatible");
  L.push(redo.length
    ? `To redo: run ${redo.length === 1 ? "this dependent" : `these ${redo.length} dependents`} against ${vb}, each against what it counts as done, before ${vb} is promoted: ${redo.map((a) => a.display).join("; ")}. That run is the evidence half, the conformance checker's once ${vb} exists; a breaking one also needs its own change, or its owner's written acceptance.`
    : "To redo: nothing.");
  L.push("");
  L.push(reuse.length ? `To reuse as it is: ${reuse.map((a) => a.display).join("; ")}.` : "To reuse as it is: no dependent is untouched.");
  L.push("");
  L.push(`What ${subject} made before the change was made by ${va}; nothing here remakes it.`);
  L.push("");

  L.push(HEADINGS[5]);
  L.push("");
  if (runtime.before && runtime.after) {
    const pa = priceWords(runtime.before);
    const pb = priceWords(runtime.after);
    L.push(pa === pb ? `Its declared price is ${pa} before and after, so the change costs a dependent nothing more to order.` : `Its declared price moves from ${pa} to ${pb}.`);
  } else {
    L.push(`The runtime requirements before and after were not both given, so what the change costs as far as the declared prices show could not be said.${runtime.how ? ` (${runtime.how}.)` : ""}`);
  }
  L.push("Running each dependent against the new version is the evidence half, and it is metered to whoever makes the change.");
  L.push("");

  L.push(HEADINGS[6]);
  L.push("");
  const seenNotes = new Map();
  for (const u of [...(dependents?.unread ?? []).map((u) => `The platform could not read ${trim(u?.source)} this time: ${trim(u?.why)}.`), ...notes]) seenNotes.set(u, (seenNotes.get(u) ?? 0) + 1);
  const unread = [...seenNotes].map(([u, n]) => (n > 1 ? `${u} (${n} of them)` : u));
  const notRead = (dependents?.not_read ?? []).map(trim).filter(Boolean);
  if (!unread.length && !notRead.length) L.push("Every source of dependents the platform has was read.");
  for (const u of unread) L.push(`- ${u}`);
  if (notRead.length) L.push(`- What the platform's list does not cover yet: ${notRead.join("; ")}.`);
  L.push("");

  L.push(HEADINGS[7]);
  L.push("");
  L.push(`This report approves nothing and changes nothing. Whether ${subject} ${vb} goes ahead is the decision of the person who asked for the change, made from this report. The impact analyst does not judge whether the change is worth making, and has not run the new version.`);
  L.push("");
  return { text: L.join("\n"), verdict, counts: c };
}
