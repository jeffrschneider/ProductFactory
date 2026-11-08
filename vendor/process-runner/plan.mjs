// The plan a parsed process document gives a runtime: the graph the after:
// lines draw, which phases are ready given the ones that closed, where the
// joins are, which phases are gates, what each phase needs in hand before it
// may begin, and who holds it. Pure: nothing here reads a file or a clock.
//
// The rules it keeps, from the Agent Processes specification:
//   6.2  order comes from after: lines and never from listing order
//   6.5  after: a + b waits for both; a phase does not begin before every
//        handoff into it exists (8.4)
//   6.5.2 a name marked ? that the run never entered does not hold a join,
//        and neither does one the run entered and went on past because it
//        refused (0.17.0, optionalEverywhere)
//   7    never is a gate; supervised holds the output; assisted and manual
//        leave the act to the person; autonomous runs unattended
//
//   needs: node >= 22
//   node plan.mjs <document.txt> [--closed a,b] [--roster <roster.txt>]
//     prints the graph, the ready set and the gates as JSON
import { readFileSync } from "node:fs";
import { afterName, offeringOf, parseProcessDocument, parseRoster, startsTheRun } from "./parse-process.mjs";

/** How a runtime must treat a phase, from its automation level. */
export function modeOf(phase) {
  switch (phase.automation) {
    case "never": return "gate";
    case "supervised": return "hold-output";
    case "assisted": return "person-acts";
    case "manual": return "person-acts";
    case "autonomous": return "agent";
    default: return "unknown";
  }
}

/** The phases an after: value names, with the ? marker read off. */
export function afterNames(phase) {
  return phase.after.map(afterName).filter((a) => a.name !== "trigger" && !a.prose && a.exception === undefined);
}

export function startsAtTrigger(phase) {
  return !phase.hasAfter || phase.after.some((a) => afterName(a).name === "trigger");
}

/** Whether the run may go on past a phase it entered and that refused
 *  (0.17.0): at least one phase waits for it, and every phase that waits for
 *  it names it with the trailing ? (specification 6.5.2, a phase the run may
 *  never enter). A phase nothing waits for is not one: it is where the run
 *  closes, and closing without it would be a different run. */
export function optionalEverywhere(doc, id) {
  const namings = doc.phases.flatMap((p) => afterNames(p).filter((a) => a.name === id));
  return namings.length > 0 && namings.every((a) => a.optional);
}

/** The graph: predecessors and successors by phase id. */
export function graph(doc) {
  const preds = {}, succs = {};
  for (const p of doc.phases) { preds[p.id] = []; succs[p.id] = []; }
  for (const p of doc.phases) {
    for (const a of afterNames(p)) {
      if (!(a.name in succs)) continue;
      preds[p.id].push(a.name);
      succs[a.name].push(p.id);
    }
  }
  return { ids: doc.phases.map((p) => p.id), preds, succs };
}

/** Every phase reachable from id through after: lines, in a stable order. */
export function successors(doc, id) {
  const { succs, ids } = graph(doc);
  const seen = new Set();
  const walk = (x) => { for (const n of succs[x] ?? []) { if (!seen.has(n)) { seen.add(n); walk(n); } } };
  walk(id);
  return ids.filter((x) => seen.has(x));
}

/** The phases nothing waits for: where a run reaches its close. */
export function closingPhases(doc) {
  const { succs } = graph(doc);
  return doc.phases.filter((p) => !succs[p.id].length).map((p) => p.id);
}

export function joins(doc) {
  return doc.phases.filter((p) => afterNames(p).length > 1).map((p) => p.id);
}

export function gates(doc) {
  return doc.phases.filter((p) => modeOf(p) === "gate").map((p) => p.id);
}

/** The phases the document leaves to a person: a gate, an output held for a
 *  person's approval, or an act a person performs. A run of a document that
 *  has any of these stops until a person answers, so a runtime that cannot
 *  reach the person the document names cannot finish the run at all. Each
 *  carries the level it is written at, because the refusal names it. */
export function personPhases(doc) {
  return doc.phases.filter((p) => ["gate", "hold-output", "person-acts"].includes(modeOf(p))).map((p) => ({ id: p.id, level: p.automation }));
}

export function phase(doc, id) {
  return doc.phases.find((p) => p.id === id) ?? null;
}

/** Handoffs into a phase and out of it. */
export function inbound(doc, id) { return doc.handoffs.filter((h) => h.to.includes(id)); }
export function outbound(doc, id) { return doc.handoffs.filter((h) => h.from.includes(id)); }

export function deviationsFrom(doc, id) {
  return doc.deviations.filter((d) => d.from === id || d.from === "any");
}
export function findDeviation(doc, key) {
  return doc.deviations.find((d) => d.key === key) ?? null;
}

/** The handoff keys a phase's own sentence names as words, so a gate can be
 *  handed the draft it "plays" as well as the review it "reads". */
export function carried(doc, id) {
  const p = phase(doc, id);
  if (!p) return [];
  const words = new Set(`${p.what} ${p.kind}`.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean));
  return doc.handoffs.filter((h) => words.has(h.key) || h.key.split("-").every((w) => words.has(w))).map((h) => h.key);
}

/**
 * The ready set. `closed` are the phases that closed in this round;
 * `entered` the phases the run has opened at any point; `have(key)` says
 * whether a handoff exists now; `active` the phases already in flight;
 * `skipped` the phases the run entered and went on past (0.17.0), which count
 * as done for a join and owe no handoff.
 * Returns the phases that may begin, and, for each phase that may not, why.
 */
export function readyPhases(doc, { closed = new Set(), entered = new Set(), have = () => false, active = new Set(), skipped = new Set() } = {}) {
  // A name marked ? holds a join while the run may still enter it (0.17.0):
  // it is ready now, or a phase in flight or ready now leads to it. Before,
  // it held only once entered, so a phase whose after: names only phases
  // marked ? that start at the trigger was sent in the same pass as they
  // were, with nothing. First the ready set with every such name holding,
  // then the names nothing can still reach are let go.
  const strict = readyOnce(doc, { closed, entered, have, active, skipped, live: null });
  const { succs } = graph(doc);
  const live = new Set();
  const walk = (x) => { for (const n of succs[x] ?? []) if (!live.has(n)) { live.add(n); walk(n); } };
  for (const id of [...active, ...strict.ready]) { live.add(id); walk(id); }
  return readyOnce(doc, { closed, entered, have, active, skipped, live });
}

/** One pass of the ready set. `live` null: every name marked ? the run has
 *  not entered holds; otherwise only those in `live` do. */
function readyOnce(doc, { closed, entered, have, active, skipped, live }) {
  const ready = [], blocked = [];
  const ids = new Set(doc.phases.map((p) => p.id));
  for (const p of doc.phases) {
    if (closed.has(p.id) || skipped.has(p.id) || active.has(p.id)) continue;
    const waiting = [];
    for (const a of afterNames(p)) {
      if (!ids.has(a.name)) continue;
      if (closed.has(a.name) || skipped.has(a.name)) continue;
      if (a.optional && !entered.has(a.name) && live && !live.has(a.name)) continue;
      waiting.push(a.name);
    }
    if (!startsAtTrigger(p) && !afterNames(p).length) continue;
    if (waiting.length) { blocked.push({ id: p.id, waiting }); continue; }
    const missing = [];
    for (const h of inbound(doc, p.id)) {
      // A handoff from a phase the run never entered is not owed (8.4), and
      // neither is one from a phase the run went on past (0.17.0).
      const owed = h.from.every((f) => !ids.has(f) || ((entered.has(f) || closed.has(f)) && !skipped.has(f)));
      if (!owed) continue;
      if (!have(h.key)) missing.push(h.key);
    }
    if (missing.length) { blocked.push({ id: p.id, handoffs: missing }); continue; }
    ready.push(p.id);
  }
  return { ready, blocked };
}

/** Who holds a phase: the roster by phase id, then by the owner's name with
 *  or without its brackets, then, for a phase whose owner line says whoever
 *  starts the run (0.30.0), the run's owner when it is given. Null when
 *  nobody is named. */
export function holderFor(doc, roster, id, runOwner = null) {
  const p = phase(doc, id);
  if (!p) return null;
  const bare = p.owner.replace(/^<|>$/g, "").trim().toLowerCase();
  if (roster?.has(p.id)) return { handle: roster.get(p.id), how: `named in the roster for phase ${p.id}` };
  if (bare && roster?.has(bare)) return { handle: roster.get(bare), how: `named in the roster for ${bare}` };
  if (runOwner && startsTheRun(p.owner)) return { handle: runOwner, how: "the run's owner: the document gives this phase to whoever starts the run" };
  return null;
}

/** Everything a runtime needs per phase, in one place. */
export function planFor(doc, roster = null) {
  const g = graph(doc);
  return {
    closing: closingPhases(doc),
    joins: joins(doc),
    gates: gates(doc),
    phases: doc.phases.map((p) => ({
      id: p.id,
      kind: p.kind,
      offering: offeringOf(p),
      mode: modeOf(p),
      level: p.automation,
      after: afterNames(p),
      startsAtTrigger: startsAtTrigger(p),
      preds: g.preds[p.id],
      succs: g.succs[p.id],
      needs: inbound(doc, p.id).map((h) => h.key),
      leaves: outbound(doc, p.id).map((h) => h.key),
      carries: carried(doc, p.id),
      deviations: deviationsFrom(doc, p.id).map((d) => d.key),
      by: p.by,
      holder: holderFor(doc, roster, p.id),
    })),
  };
}

const thisFile = process.argv[1] ? process.argv[1].replace(/\\/g, "/").split("/").pop() : "";
if (thisFile && import.meta.url.endsWith(thisFile)) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) { console.error("usage: node plan.mjs <document.txt> [--closed a,b] [--roster <roster.txt>]"); process.exit(2); }
  const doc = parseProcessDocument(readFileSync(file, "utf8"));
  const ci = args.indexOf("--closed");
  const closed = new Set(ci >= 0 && args[ci + 1] ? args[ci + 1].split(",").map((s) => s.trim()).filter(Boolean) : []);
  const ri = args.indexOf("--roster");
  const roster = ri >= 0 && args[ri + 1] ? parseRoster(readFileSync(args[ri + 1], "utf8")).map : null;
  const plan = planFor(doc, roster);
  const { ready, blocked } = readyPhases(doc, { closed, entered: closed, have: () => true });
  console.log(JSON.stringify({ ...plan, ready, blocked }, null, 2));
}
