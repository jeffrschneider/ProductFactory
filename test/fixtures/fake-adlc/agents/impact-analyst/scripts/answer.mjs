// Answer each dependent: compatible, breaking, or a change of behavior, with
// where it was learned of and why.
//
// What a dependent uses decides which differences reach it:
//   - a solution whose canvas was given: the lines out of the changed agent's
//     box (which outputs it reads, and the input of the next box each one
//     goes into, with that input's kind) and the lines into it (which inputs
//     it sends);
//   - an agent given as one that may take what the changed agent hands back:
//     each of its inputs with the name of one of the agent's outputs, or
//     failing that with exactly the kind of one, before or after;
//   - anything else (another organization's solution, whose canvas its owner
//     does not show, a schedule, a caller seen only in the record of who
//     called it): the offerings the platform saw it use, or every offering
//     when it saw none, and what it reads is not known.
//
// An output whose kind changed is answered for each reader by the platform's
// own rule for whether a line fits (kinds.mjs, from ports.ts):
//   the new kind fits the reader's input and the old one did   change of behavior
//     (the line still fits, but what arrives is labelled differently, and only
//     a run of the new version shows whether the reader reads it the same);
//   the new kind fits and the old one did not                  compatible
//   the old kind fitted and the new one does not               breaking
//   the reader's input is not known, and the new kind is a
//     narrower spelling of the old one, so every input that
//     took the old kind takes the new one                      change of behavior
//   anything else                                              breaking, because
//     it could not be told.
//
// The worst answer a dependent gets is its answer: breaking, then change of
// behavior, then compatible. The same inputs always give the same answers, in
// the same order.
//
//   needs: node >= 22
//   import { answerAll, WORST } from "./answer.mjs"
import { bareKind, satisfies } from "./kinds.mjs";

const trim = (s) => String(s ?? "").trim();
const list = (x) => (Array.isArray(x) ? x : []);
const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

export const VERDICT_WORDS = { compatible: "compatible", breaking: "breaking", behaviour: "change of behavior" };
const RANK = { compatible: 0, behaviour: 1, breaking: 2 };
export const WORST = (a, b) => (RANK[b] > RANK[a] ? b : a);

/** "write-facts.in.site-read" as {offering, side, name}. */
export function parsePort(id) {
  const m = /^(.*?)\.(in|out)\.(.*)$/.exec(trim(id));
  return m ? { offering: m[1], side: m[2], name: m[3] } : null;
}

/** A name as a comparison reads it: "site read", "site-read" and "Site_Read" are one name. */
export const sameName = (a, b) => trim(a).toLowerCase().replace(/[-_\s]+/g, " ") === trim(b).toLowerCase().replace(/[-_\s]+/g, " ");

const portKind = (p) => bareKind(p?.media_type ?? p?.kind);

function findPort(ports, id) {
  for (const o of list(ports?.offerings)) for (const p of [...list(o.inputs), ...list(o.outputs)]) if (trim(p?.id) === id) return p;
  return null;
}

/** What a solution's canvas says the solution uses of the agent `key`. */
export function useFromCanvas(solution, key) {
  if (!trim(key)) return null;
  const nodes = list(solution?.nodes);
  const byId = new Map(nodes.map((n) => [trim(n?.id), n]));
  const mine = new Set(nodes.filter((n) => trim(n?.agent) === key).map((n) => trim(n.id)));
  if (!mine.size) return null;
  const reads = new Map();
  const sends = new Set();
  const offerings = new Set();
  for (const c of list(solution?.connections)) {
    if (mine.has(trim(c?.from_node))) {
      const from = parsePort(c.from_port);
      if (!from) continue;
      offerings.add(from.offering);
      const to = byId.get(trim(c.to_node));
      const port = to ? findPort(to.ports, trim(c.to_port)) : null;
      const toPort = parsePort(c.to_port);
      const receiver = {
        label: trim(to?.label) || (trim(to?.kind) === "end" ? "End" : "a box"),
        agent: trim(to?.agent) || null,
        end: trim(to?.kind) === "end",
        port: toPort?.name ?? trim(c.to_port),
        offering: toPort?.offering ?? null,
        kind: port ? portKind(port) : null,
        known: !!port,
      };
      const k = `${from.offering}.out.${from.name}`;
      if (!reads.has(k)) reads.set(k, []);
      reads.get(k).push(receiver);
    }
    if (mine.has(trim(c?.to_node))) {
      const to = parsePort(c.to_port);
      if (!to) continue;
      offerings.add(to.offering);
      sends.add(`${to.offering}.in.${to.name}`);
    }
  }
  return { offerings, reads, sends, canvas: true };
}

/** A kind that says what a piece is, so that two inputs and outputs sharing it
 *  are the same thing: not plain JSON, not a wildcard, and not one of the
 *  value kinds that only say a piece is text, an address, a document or an id. */
export const specific = (k) => !!k && !["application/json", "text", "url", "document", "identifier", "text/plain"].includes(k) && !k.endsWith("/*");

/** What a given agent (its ports) may take of what the agent hands back: each
 *  input with the name of one of its outputs, or failing that with exactly the
 *  kind of one, before or after, when that kind is specific. */
export function useFromPorts(ports, outputs) {
  const reads = new Map();
  for (const o of list(ports?.offerings)) {
    for (const p of list(o?.inputs)) {
      const kind = portKind(p);
      const byName = outputs.filter((x) => sameName(x.name, p?.name));
      const matched = byName.length ? byName : (specific(kind) ? outputs.filter((x) => x.before === kind || x.after === kind) : []);
      for (const x of matched) {
        const k = `${x.offering}.out.${x.name}`;
        if (!reads.has(k)) reads.set(k, []);
        reads.get(k).push({ label: trim(ports.label) || trim(ports.agent), agent: trim(ports.agent), end: false, port: trim(p.name), offering: trim(o.id), kind, known: true, required: p.required === true, how: byName.length ? "name" : "kind" });
      }
    }
  }
  return { offerings: new Set([...reads.keys()].map((k) => parsePort(k).offering)), reads, sends: new Set(), canvas: false, reader: true };
}

/** Every output of the agent, before and after: {offering, name, before, after}. */
export function outputsOf(before, after) {
  const out = new Map();
  for (const [side, doc] of [["before", before], ["after", after]]) {
    for (const o of list(doc?.offerings)) {
      for (const p of list(o?.outputs)) {
        const k = `${trim(o.id ?? o.name)}.out.${trim(p?.name)}`;
        if (!out.has(k)) out.set(k, { offering: trim(o.id ?? o.name), name: trim(p?.name), before: null, after: null });
        out.get(k)[side] = bareKind(p?.kind ?? p?.media_type);
      }
    }
  }
  return [...out.values()];
}

const who = (r) => (r.end ? "End, what the person gets" : `${r.label}'s input ${r.port}`);
const nameOf = (r) => (r.end ? "End" : r.label);

/** "a", "a and b", "a, b and c". */
export const joined = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** One reader of an output whose kind changed: its answer, the category the
 *  reason is grouped under, and a sentence for that one line. */
export function answerKind(diff, r) {
  const { before, after } = diff;
  if (r && r.known && r.kind) {
    const oldFit = !!before && satisfies(before, r.kind);
    const newFit = !!after && satisfies(after, r.kind);
    if (oldFit && newFit) return { effect: "behaviour", cat: "fits-both", words: `${who(r)} takes ${r.kind}; ${after} fits it as ${before} did, so the line still fits, but what arrives is labelled differently and only a run of the new version shows ${nameOf(r)} reads it the same.` };
    if (newFit) return { effect: "compatible", cat: "now-fits", words: `${who(r)} takes ${r.kind}, which ${before ?? "the old kind"} did not fit and ${after} does, so the line now fits.` };
    if (oldFit) return { effect: "breaking", cat: "no-longer", words: `${who(r)} takes ${r.kind}, which ${before} fitted and ${after ?? "the new kind"} does not, so the line no longer fits.` };
    return { effect: "breaking", cat: "neither", words: `${who(r)} takes ${r.kind}, which neither ${before ?? "the old kind"} nor ${after ?? "the new kind"} fits, so it could not be told what the line does now.` };
  }
  if (diff.refines) return { effect: "behaviour", cat: "unknown-refines", words: `${r ? `${who(r)} does not say what kind it takes` : "What it reads is not known"}; ${after} is a narrower spelling of ${before} (RFC 6839: a +json kind is JSON), so any input that took ${before} still takes it, but only a run of the new version shows it is read the same.` };
  return { effect: "breaking", cat: "unknown", words: `${r ? `${who(r)} does not say what kind it takes` : "What it reads is not known"}, and ${after ?? "the new kind"} is not a narrower spelling of ${before ?? "the old kind"}, so it could not be told whether it still fits.` };
}

/** The reasons for one answer, with the readers of one changed output said
 *  once: "site-read still fits Scene writer, Fact writer and Fact checker". */
export function reasonsOf(effects, verdict) {
  const out = [];
  const groups = new Map();
  for (const e of effects.filter((x) => x.effect === verdict)) {
    if (!e.cat) { if (!out.includes(e.words)) out.push(e.words); continue; }
    const k = `${e.diff.offering}.${e.diff.port}|${e.cat}`;
    if (!groups.has(k)) { groups.set(k, { e, lines: [] }); out.push(k); }
    if (e.line) groups.get(k).lines.push(e.line);
  }
  return out.map((x) => {
    const g = groups.get(x);
    if (!g) return x;
    const { diff, cat } = g.e;
    const names = [...new Set(g.lines.map(nameOf))];
    const kinds = [...new Set(g.lines.map((r) => r.kind).filter(Boolean))];
    const port = diff.port;
    const takes = kinds.length ? ` (${kinds.length === 1 && names.length > 1 ? `each takes ${kinds[0]}` : `takes ${joined(kinds)}`})` : "";
    if (cat === "fits-both") return `${port} now arrives as ${diff.after}, which still fits ${joined(names)}${takes} as ${diff.before} did; only a run of the new version shows ${names.length === 1 ? "it reads" : "each reads"} it the same.`;
    if (cat === "now-fits") return `${port} now fits ${joined(names)}${takes}, which ${diff.before ?? "the old kind"} did not.`;
    if (cat === "no-longer") return `${port} no longer fits ${joined(names)}${takes}: it was ${diff.before} and is now ${diff.after ?? "a kind it does not state"}.`;
    if (cat === "neither") return `${port} fits ${joined(names)}${takes} neither before nor after, so it could not be told what the line does now.`;
    const at = names.length ? `${joined(names)} ${names.length === 1 ? "does" : "do"} not say what ${names.length === 1 ? "it takes" : "they take"}` : "What it reads of the agent is not known";
    if (cat === "unknown-refines") return `${at}; ${port} now arrives as ${diff.after}, a narrower spelling of ${diff.before} (RFC 6839), so any input that took ${diff.before} still takes it, but only a run of the new version shows it is read the same.`;
    return `${at}, and ${port} changed from ${diff.before ?? "an unstated kind"} to ${diff.after ?? "an unstated kind"}, which is not a narrower spelling of it, so it could not be told whether it still fits.`;
  });
}

/** Which differences reach one dependent, and its answer. */
export function answerOne(diffs, use) {
  const effects = [];
  const usesOffering = (off) => !use?.offerings || !use.offerings.size || use.offerings.has(off);
  const readsKnown = !!use?.reads && (use.canvas || use.reader);
  const sendsKnown = !!use?.canvas;
  for (const x of diffs) {
    if (x.effect === "words") continue;
    if (use?.reader) {
      // An agent that reads what this one hands back is reached by what it
      // reads, and by a change that may make the agent act differently. It
      // orders nothing, so a change to what is sent, or to the price, is not
      // its to answer.
      if (x.scope === "input") continue;
      if (x.scope === "output") {
        if (!use.reads.has(`${x.offering}.out.${x.port}`)) continue;
      } else {
        if (x.effect === "behaviour" && (!x.offering || usesOffering(x.offering))) effects.push({ effect: x.effect, words: x.words });
        continue;
      }
    }
    if (x.offering && !usesOffering(x.offering)) continue;
    if (x.scope === "input") {
      const sends = sendsKnown ? use.sends.has(`${x.offering}.in.${x.port}`) : null;
      if (x.change === "input-added-required") { effects.push({ effect: "breaking", words: x.words }); continue; }
      if (x.change === "input-now-required" && sends === true) { effects.push({ effect: "compatible", words: `${x.words.replace(/, so .*$/, "")}; this dependent already sends it.` }); continue; }
      // A box on a canvas is sent only what its lines carry, so an input that
      // is now required, or a group that now asks for something else, reaches
      // a dependent that does not send it.
      if (x.change === "input-group-changed" && sends === false && x.group && [...(use.sends ?? [])].some((s) => x.group.has(s))) continue;
      if ((x.change === "input-now-required" || x.change === "input-group-changed") && sends === false) { effects.push({ effect: "breaking", words: `${x.words} This dependent's canvas does not send it.` }); continue; }
      if (sends === false && x.effect !== "compatible") continue;
      effects.push({ effect: x.effect, words: sends === null && x.effect === "breaking" ? `${x.words} What this dependent sends is not known, so it is answered as if it sends it.` : x.words });
      continue;
    }
    if (x.scope === "output") {
      const k = `${x.offering}.out.${x.port}`;
      if (x.change === "output-added") { effects.push({ effect: "compatible", words: x.words }); continue; }
      const receivers = readsKnown ? (use.reads.get(k) ?? []) : [null];
      if (!receivers.length) continue;
      for (const r of receivers) {
        if (x.effect === "kind") effects.push({ ...answerKind(x, r), line: r, diff: x });
        else effects.push({ effect: x.effect, words: r ? `${x.words} It goes to ${who(r)}.` : (x.effect === "breaking" ? `${x.words} What this dependent reads of the agent is not known, so it is answered as if it reads it.` : x.words), line: r });
      }
      continue;
    }
    effects.push({ effect: x.effect, words: x.words });
  }
  let verdict = "compatible";
  for (const e of effects) verdict = WORST(verdict, e.effect);
  const reasons = reasonsOf(effects, verdict);
  return { verdict, reasons: reasons.length ? reasons : ["Nothing it uses changed."], effects };
}

const ownerWords = (o) => {
  if (!isObject(o)) return "its owner, who is not named";
  const name = trim(o.name);
  const org = trim(o.org);
  return name && org ? `${name} (${org})` : name || org || "its owner, who is not named";
};

/** Every dependent, answered, in a fixed order: the platform's list first, in
 *  its own order, then the given agents in the order given. */
export function answerAll({ diffs, dependents, solutions = [], ports = [], key, before, after }) {
  const byId = new Map(solutions.map((s) => [trim(s.doc?.id), s.doc]));
  const used = new Set();
  const answered = [];
  const notes = [];
  for (const dep of list(dependents?.dependents)) {
    const id = trim(dep?.id) || null;
    const kind = trim(dep?.kind) || "dependent";
    const viaId = trim(dep?.via?.id);
    const canvasOf = kind === "solution" ? id : (dep?.via?.kind === "solution" ? viaId : "");
    let use = null;
    let how = "";
    if (canvasOf && byId.has(canvasOf)) {
      use = useFromCanvas(byId.get(canvasOf), key);
      used.add(canvasOf);
      how = use ? "its canvas was read" : "its canvas was given but does not place the agent";
    } else {
      if (kind === "solution" || canvasOf) notes.push(id || canvasOf
        ? `The canvas of ${trim(dep?.name) || canvasOf} was not given, so what it reads of the agent was not known.`
        : `${trim(dep?.name) || "A solution"} belongs to ${ownerWords(dep?.owner)}, whose canvas its owner does not show, so what it reads of the agent was not known.`);
      const offs = list(dep?.use?.offerings).map(trim).filter(Boolean);
      use = { offerings: offs.length ? new Set(offs) : null, reads: null, sends: null, canvas: false };
      how = offs.length ? `it was seen using ${offs.join(", ")}` : "what it uses was not known";
    }
    const a = answerOne(diffs, use);
    answered.push({
      kind, id, name: trim(dep?.name) || null, display: trim(dep?.name) || id || `an unnamed ${kind} of ${trim(dep?.owner?.name) || trim(dep?.owner?.org) || "another organization"}`, owner: dep?.owner ?? null, owner_words: ownerWords(dep?.owner),
      found_by: list(dep?.found_by).map((f) => ({ source: trim(f?.source), observed: f?.observed === true, words: trim(f?.words) })),
      declared: dep?.declared === true, observed: dep?.observed === true, how, use: describeUse(use), ...a,
    });
  }
  for (const s of solutions) {
    const id = trim(s.doc?.id);
    if (!id || used.has(id)) continue;
    const use = useFromCanvas(s.doc, key);
    if (!use) { notes.push(`${trim(s.doc?.name) ? `${trim(s.doc.name)} (${id})` : id} was given, but its canvas does not place the agent, so it is not a dependent.`); continue; }
    const a = answerOne(diffs, use);
    answered.push({ kind: "solution", id, name: trim(s.doc?.name) || id, display: trim(s.doc?.name) || id, owner: { org: trim(s.doc?.org) }, owner_words: ownerWords({ org: s.doc?.org }), found_by: [{ source: "canvas", observed: false, words: `Its canvas, given with the job, places the agent; the platform's list did not name it.` }], declared: true, observed: false, how: "its canvas was read", use: describeUse(use), ...a });
  }
  const outputs = outputsOf(before, after);
  for (const p of ports) {
    const use = useFromPorts(p.doc, outputs);
    const label = trim(p.doc?.label) || trim(p.doc?.agent);
    const matched = [...use.reads.values()].flat();
    const owner = isObject(p.doc?.owner) ? p.doc.owner : null;
    const base = { kind: "agent", id: trim(p.doc?.agent) || null, name: label, display: label, owner, owner_words: owner ? ownerWords(owner) : `the owner of ${label}`, declared: true, observed: false };
    if (!matched.length) {
      answered.push({ ...base, found_by: [{ source: "kind", observed: false, words: `Given as an agent that may take what it hands back; none of its inputs has the name or the kind of anything it hands back.` }], how: "its inputs were read", use: describeUse(use), verdict: "compatible", reasons: ["None of its inputs takes anything this agent hands back, by name or by kind, so the change does not reach it."], effects: [], reader: true });
      continue;
    }
    const words = [...new Set(matched.map((r) => `its input ${r.port} (${r.kind ?? "kind not stated"}) has the ${r.how} of something it hands back`))].join("; ");
    const a = answerOne(diffs, use);
    answered.push({ ...base, found_by: [{ source: "kind", observed: false, words: `Given as an agent that may take what it hands back: ${words}.` }], how: "its inputs were read", use: describeUse(use), ...a, reader: true });
  }
  return { answered, notes };
}

/** The lines a dependent uses, for the report. */
function describeUse(use) {
  if (!use) return null;
  const reads = use.reads ? [...use.reads.entries()].map(([k, rs]) => ({ output: k, to: rs.map((r) => ({ label: r.label, agent: r.agent, port: r.port, kind: r.kind, end: r.end })) })) : null;
  return { offerings: use.offerings ? [...use.offerings] : null, reads, sends: use.sends ? [...use.sends] : null };
}
