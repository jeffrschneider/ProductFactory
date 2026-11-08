// Parse a document written in the Agent Processes language
// (agentcatalog.com/spec/agent-processes) into a plain structure, and say
// what stops a run from starting against it.
//
// A port of the platform's parser (services/src/api/catalog-process.ts,
// parseProcessDocument) with the same grammar: top-level sections at column 0,
// phase lines `id - kind: what` with owner:/after:/by:/automation:, after split
// on `+`, handoffs and deviations `a -> b / c [key]: text`, blanks `<...>`.
// Two differences, both forced by documents the platform never had to read:
//   1. owner/after/by/automation are scanned across the whole phase entry, not
//      only on continuation lines that start with one, because a phase may
//      write `after: x` mid-line after its sentence.
//   2. `runs <pattern>` with no colon and no sentence is read as the kind.
// Two rules keep it honest, as in the original: a blank stays the literal text
// the author wrote (never a guess at a value), and every line the parser could
// not place is reported under `unparsed` rather than dropped in silence.
//
//   needs: node >= 22
//   node parse-process.mjs <document.txt> [--roster <roster.txt>]
//     prints JSON: { ok, problems, document }. ok is false when a run must not
//     start from this document (section 15.5, 7.5, 6.5 of the specification).
import { readFileSync } from "node:fs";

export const SECTION_KEYS = ["PROCESS", "from", "owner", "confidential-under", "trigger", "concurrency", "goal", "phases", "run-scoped", "handoffs", "deviations", "bindings", "policy", "measures", "records", "amendments", "extensions"];
export const LEVELS = ["manual", "assisted", "supervised", "autonomous", "never"];

const squash = (s) => s.replace(/\s+/g, " ").trim();
/** An owner line, or a phase's owner, that names whoever instructs the run
 *  (0.30.0): a document any account may run, whose gates go to whoever
 *  started it, written once rather than rewritten per run. */
export const STARTS_THE_RUN = "whoever starts the run";
export const startsTheRun = (s) => squash(String(s ?? "")).toLowerCase().replace(/[.]$/, "") === STARTS_THE_RUN;

const isBlank = (s) => /^<[^<>]*>$/.test(squash(s ?? ""));

/** Group a section's lines into entries: an entry starts at the shallowest
 *  indent seen in the section, and deeper lines continue it. */
function entries(lines) {
  const indent = (l) => l.length - l.trimStart().length;
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (!nonEmpty.length) return [];
  const base = Math.min(...nonEmpty.map(indent));
  const out = [];
  for (const l of nonEmpty) {
    if (indent(l) === base || !out.length) out.push([l]);
    else out[out.length - 1].push(l);
  }
  return out;
}

/** Split on commas that sit outside parentheses and angle brackets. */
function splitTopLevel(s) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(" || ch === "<") depth++;
    else if (ch === ")" || ch === ">") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out.map(squash).filter(Boolean);
}

/** Scan "key: value  key: value" runs where keys are known and values run to
 *  the next key. Returns the values and where the first key sat. */
function scanKeys(text, keys) {
  const re = new RegExp(`\\b(${keys.join("|")}):\\s*`, "g");
  const found = [];
  for (let m = re.exec(text); m; m = re.exec(text)) found.push({ key: m[1], start: m.index, end: m.index + m[0].length });
  const out = {};
  found.forEach((f, i) => { out[f.key] = squash(text.slice(f.end, i + 1 < found.length ? found[i + 1].start : undefined)); });
  return { values: out, firstAt: found.length ? found[0].start : -1 };
}

function parseSystems(text) {
  return splitTopLevel(text).map((item) => {
    const m = /^(.*?)\s*\(([^)]*)\)$/.exec(item);
    if (!m) return { role: item, access: null };
    const inside = m[2].split(",").map(squash);
    const access = ["read", "write", "trigger"].find((a) => inside[0] === a) ?? null;
    const cap = inside.slice(1).find((x) => x.startsWith("cap:"))?.slice(4).trim();
    const sys = { role: squash(m[1]), access };
    if (cap) sys.cap = cap;
    return sys;
  });
}

/** The extensions this runtime reads (0.33.0): typed-handoffs v2, whose map
 *  lines are the saved mappings (fit.mjs mappingsOf). Every other extension a
 *  document carries is run as if its lines were absent, and the run says so
 *  (Agent Processes 20.3). */
export const KNOWN_EXTENSIONS = ["agentprocesses.ai/ext/typed-handoffs v2"];
/** An extension as its block names it: `<name> v<n>`. */
export const extensionName = (e) => `${e.name}${e.version ? ` ${e.version}` : ""}`;
/** The lines of one extension a document carries, by its full name; [] when it carries none. */
export function extensionLines(doc, full) {
  return (doc?.extensions ?? []).filter((e) => extensionName(e) === full).flatMap((e) => e.lines);
}

/** The work pattern a phase runs ("runs watch-a-video" gives watch-a-video),
 *  or null for a human:, system: or convenes phase. */
export function offeringOf(phase) {
  if (/^runs\s+process\b/.test(phase?.kind ?? "")) return null;
  const m = /^runs\s+([a-z0-9-]+)/.exec(phase?.kind ?? "");
  return m ? m[1] : null;
}

/** The other process a phase runs (0.34.0, Agent Processes 6.3.1): a phase
 *  written `runs process <id> v<n>: ...` starts an inner run of that
 *  document. Returns { id, version } ("v3"), { id, version: "" } when no
 *  version is written, or null for any other phase. */
export function innerProcessOf(phase) {
  const m = /^runs\s+process\s+(\S+)(?:\s+(v\d+))?\s*$/.exec(String(phase?.kind ?? "").trim());
  return m ? { id: m[1], version: m[2] ?? "" } : null;
}

/** A document's whole id, team and slug ("agentmesh/new-agent"), as a
 *  `runs process` line cites it. */
export function fullIdOf(doc) {
  return doc?.header?.team ? `${doc.header.team}/${doc.id}` : String(doc?.id ?? "");
}

/** Parse the document text. Throws only when it is not a process document at all. */
export function parseProcessDocument(text) {
  const raw = String(text).replace(/\r\n?/g, "\n").split("\n");
  const sections = [];
  const unplaced = [];
  const dropLine = (line, from) => unplaced.push({ at: Math.max(0, raw.indexOf(line, from)), line });
  raw.forEach((line, i) => {
    if (!line.trim()) return;
    if (!/^\s/.test(line)) {
      const m = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
      if (m && SECTION_KEYS.includes(m[1])) { sections.push({ key: m[1], head: m[2], lines: [], start: i }); return; }
      unplaced.push({ at: i, line });
      return;
    }
    if (!sections.length) { unplaced.push({ at: i, line }); return; }
    sections[sections.length - 1].lines.push(line);
  });
  const sec = (key) => sections.find((s) => s.key === key);
  const secStart = (key) => sec(key)?.start ?? 0;
  const sectionText = (key) => { const s = sec(key); return s ? squash([s.head, ...s.lines].join(" ")) : ""; };
  const processLine = sec("PROCESS");
  if (!processLine) throw new Error("not a process document: no PROCESS line");

  // Header. "PROCESS: name   id: <team>/slug   v1"
  const headKeys = scanKeys(processLine.head, ["id"]).values;
  const name = squash(processLine.head.split(/\s{2,}id:/)[0]);
  const idPart = headKeys.id ?? "";
  const idMatch = /<[^>]+>\/([a-z0-9-]+)\s*(v\d+)?/.exec(idPart) ?? /^([a-z0-9-]+)\/([a-z0-9-]+)\s*(v\d+)?/.exec(idPart) ?? /^([a-z0-9-]+)\s*(v\d+)?/.exec(idPart);
  const slug = idMatch ? (idMatch.length === 4 ? idMatch[2] : idMatch[1]) : "";
  const version = idMatch ? (idMatch.length === 4 ? idMatch[3] : idMatch[2]) ?? "" : "";
  const team = /^(<[^>]+>|[a-z0-9-]+)\//.exec(idPart)?.[1] ?? "";
  const ownerLine = scanKeys("owner: " + sectionText("owner"), ["owner", "effective"]).values;

  // Trigger, the items it carries (0.33.0, Agent Processes 5.4) and its watch.
  // A line under the trigger that opens `carries:` is an item, and lines
  // indented deeper than it go on with it; everything else is the sentence.
  const trigSec = sec("trigger");
  const carriesRaw = [];
  const sentence = trigSec ? [trigSec.head] : [];
  {
    let open = null;
    const ind = (l) => l.length - l.trimStart().length;
    for (const l of trigSec?.lines ?? []) {
      if (/^\s*carries:/.test(l)) { open = { indent: ind(l), parts: [l.trim().replace(/^carries:\s*/, "")] }; carriesRaw.push(open); continue; }
      if (open && ind(l) > open.indent) { open.parts.push(l.trim()); continue; }
      open = null;
      sentence.push(l);
    }
  }
  const carries = carriesRaw.map((c) => {
    const whole = squash(c.parts.join(" "));
    const m = /^([a-z0-9]+(?:-[a-z0-9]+)*)\s+-\s+(.*?),\s*(required|optional)\s*$/.exec(whole);
    return m ? { key: m[1], text: squash(m[2]), required: m[3] === "required" } : { key: /^(\S+)/.exec(whole)?.[1] ?? "", text: whole, required: false, malformed: true };
  });
  const trig = squash(sentence.join(" "));
  const watchCount = (trig.match(/\bwatch:/g) ?? []).length;
  const firstWatch = trig.indexOf("watch:");
  let triggerText = trig, watch = null;
  if (firstWatch >= 0) {
    triggerText = squash(trig.slice(0, firstWatch).replace(/\bor\s*$/, ""));
    const w = trig.slice(firstWatch + 6);
    const pick = (k) => { const m = new RegExp(`${k}=(<[^>]*>|\\S+)`).exec(w); return m ? squash(m[1]) : ""; };
    watch = { record: pick("record"), system: pick("system"), change: pick("change") };
  }

  // Phases.
  const phases = [];
  const phaseRanges = [];
  const phaseSec = sec("phases");
  if (phaseSec) {
    let lineCursor = phaseSec.start + 1;
    for (const entry of entries(phaseSec.lines)) {
      const first = entry[0];
      const m = /^\s*([a-z0-9-]+)\s+-\s+(.*)$/.exec(first);
      if (!m) { dropLine(first, lineCursor); lineCursor += entry.length; continue; }
      const id = m[1];
      const whole = squash([m[2], ...entry.slice(1)].join(" "));
      const scanned = scanKeys(whole, ["owner", "after", "by", "automation"]);
      const whatAll = scanned.firstAt < 0 ? whole : squash(whole.slice(0, scanned.firstAt));
      const attrs = scanned.values;
      const colon = whatAll.indexOf(":");
      let kind = colon >= 0 ? whatAll.slice(0, colon).trim() : "";
      let what = colon >= 0 ? squash(whatAll.slice(colon + 1)) : whatAll;
      if (colon < 0 && /^(runs|convenes)\s+[a-z0-9-]+$/.test(whatAll)) { kind = whatAll; what = ""; }
      phases.push({
        id, kind, what,
        owner: attrs.owner ?? "",
        after: attrs.after ? attrs.after.split(/\s*\+\s*/).map(squash).filter(Boolean) : [],
        hasAfter: attrs.after !== undefined,
        by: attrs.by ?? null,
        automation: attrs.automation ?? "",
      });
      const startIdx = raw.indexOf(first, lineCursor);
      phaseRanges.push({ id, start: startIdx, end: startIdx + entry.length });
      lineCursor = startIdx + entry.length;
    }
  }

  // Run-scoped lines.
  const runScoped = [];
  for (const entry of entries(sec("run-scoped")?.lines ?? [])) {
    const joined = squash(entry.join(" "));
    // `- runs <pattern> ...` is the earlier form and `- harness: <output> ...`
    // the one Agent Processes writes now (specification 6.3); both name what
    // the line hands one agent to work out, so both land in `runs`.
    const m = /^([a-z0-9-]+)\s+-\s+(?:runs\s+|harness:\s*)(.*)$/.exec(joined);
    if (!m) { dropLine(entry[0], secStart("run-scoped")); continue; }
    const attrs = scanKeys("runs: " + m[2], ["runs", "owner", "every", "from", "until", "on", "cap"]).values;
    const r = { id: m[1], runs: attrs.runs ?? "", owner: attrs.owner ?? "" };
    for (const k of ["every", "from", "until", "on", "cap"]) if (attrs[k]) r[k] = attrs[k];
    runScoped.push(r);
  }

  // Handoffs and deviations share a line shape: "a -> b / c [key]: text".
  const arrow = /^([a-z0-9-]+(?:\s*\+\s*[a-z0-9-]+)*|any)\s+->\s+(.+?)\s*\[([^\]]+)\]:\s*(.*)$/s;
  const handoffs = [];
  for (const entry of entries(sec("handoffs")?.lines ?? [])) {
    const m = arrow.exec(squash(entry.join(" ")));
    if (!m) { dropLine(entry[0], secStart("handoffs")); continue; }
    handoffs.push({
      from: m[1].split(/\s*\+\s*/).map(squash).filter(Boolean),
      to: m[2].split(/\s*\/\s*/).map(squash).filter(Boolean),
      key: m[3], text: squash(m[4]),
    });
  }
  const deviations = [];
  for (const entry of entries(sec("deviations")?.lines ?? [])) {
    const m = arrow.exec(squash(entry.join(" ")));
    if (!m) { dropLine(entry[0], secStart("deviations")); continue; }
    // A limit (0.30.0): `limit: <n>` at the end of the line, the most times
    // one run may take this deviation. Read off, and the words keep the rest.
    const lim = /\s*\blimit:\s*(\d+)\s*$/.exec(squash(m[4]));
    // cut-ok: only the trailing `limit: <n>` is taken off, and it is kept as the limit
    deviations.push({ from: squash(m[1]), to: squash(m[2]), key: m[3], text: lim ? squash(squash(m[4]).slice(0, lim.index)) : squash(m[4]), limit: lim ? Number(lim[1]) : null });
  }

  // Bindings.
  // `mapping:` lines are the conversions a solution saved between two steps
  // (fit.mjs readMappings), applied at the handoff with no model.
  const bindings = { roster: "", systems: [], data: [], mappings: [] };
  for (const entry of entries(sec("bindings")?.lines ?? [])) {
    const joined = squash(entry.join(" "));
    const m = /^(roster|systems|data|mapping):\s*(.*)$/s.exec(joined);
    if (!m) { dropLine(entry[0], secStart("bindings")); continue; }
    if (m[1] === "mapping") bindings.mappings.push(squash(m[2]));
    else if (m[1] === "roster") bindings.roster = squash(m[2]);
    else if (m[1] === "systems") bindings.systems = parseSystems(m[2]);
    else bindings.data = splitTopLevel(m[2]);
  }

  const policy = entries(sec("policy")?.lines ?? []).map((e) => squash(e.join(" ")));
  const measures = [];
  for (const entry of entries(sec("measures")?.lines ?? [])) {
    const joined = squash(entry.join(" "));
    const m = /^([^:]+):\s*(.*)$/.exec(joined);
    if (!m) { dropLine(entry[0], secStart("measures")); continue; }
    measures.push({ name: squash(m[1]), text: squash(m[2]) });
  }
  const records = [];
  for (const entry of entries(sec("records")?.lines ?? [])) {
    const joined = squash(entry.join(" "));
    const m = /^([a-z0-9-]+)\s+-\s+(.*)$/.exec(joined);
    if (!m) { dropLine(entry[0], secStart("records")); continue; }
    records.push({ key: m[1], text: squash(m[2]) });
  }
  const amendments = entries(sec("amendments")?.lines ?? []).map((e) => squash(e.join(" ")));
  // The extensions block (0.33.0, Agent Processes 20.2): each extension is a
  // line naming it and its version, and the lines under it, kept as written
  // but for the indent, are its own. Read here, used where the runner knows
  // the extension (fit.mjs mappingsOf), and otherwise named as ignored.
  const extensions = entries(sec("extensions")?.lines ?? []).map((e) => {
    const m = /^\s*(\S+)\s+v(\d+)\s*$/.exec(e[0]);
    const under = e.slice(1);
    const base = under.length ? Math.min(...under.map((l) => l.length - l.trimStart().length)) : 0;
    return { name: m ? m[1] : squash(e[0]), version: m ? `v${m[2]}` : "", lines: under.map((l) => l.slice(base).replace(/\s+$/, "")) };
  });

  // Blanks, in document order, with the section and phase they sit in.
  const blanks = [];
  const full = raw.join("\n");
  const lineStarts = []; let acc = 0;
  for (const l of raw) { lineStarts.push(acc); acc += l.length + 1; }
  const lineOf = (pos) => { let lo = 0, hi = lineStarts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1; } return lo; };
  const sectionOf = (line) => {
    let key = "header";
    for (const s of sections) if (s.start <= line) key = s.key;
    return ["PROCESS", "from", "owner", "confidential-under"].includes(key) ? "header" : key;
  };
  const blankRe = /<[^<>]+>/g;
  for (let m = blankRe.exec(full); m; m = blankRe.exec(full)) {
    const line = lineOf(m.index);
    const b = { text: squash(m[0]), section: sectionOf(line) };
    if (b.section === "extensions") continue;
    const ph = phaseRanges.find((r) => line >= r.start && line < r.end);
    if (ph) b.phase = ph.id;
    blanks.push(b);
  }

  return {
    id: slug,
    name,
    ref: sectionText("from"),
    header: {
      team, owner: ownerLine.owner ?? "", effective: ownerLine.effective ?? "", version,
      // The Agent NDA every outside participant must be bound by (section 4),
      // present only when the document names one.
      ...(sec("confidential-under") ? { confidentialUnder: sectionText("confidential-under") } : {}),
    },
    trigger: { text: triggerText, watch, carries },
    concurrency: sectionText("concurrency"),
    goal: sectionText("goal"),
    phases, runScoped, handoffs, deviations, bindings, policy, measures, records, amendments, extensions, blanks,
    unparsed: unplaced.sort((a, b) => a.at - b.at).map((u) => u.line),
    watchCount,
  };
}

/** The name an after: value cites, and whether it carries the trailing ?
 *  that marks a phase the run may never enter (specification 6.5.2). */
export function afterName(value) {
  const m = /^([a-z0-9-]+)(\?)?$/.exec(squash(value));
  if (m) return { name: m[1], optional: Boolean(m[2]) };
  const ex = exceptionEdge(value);
  if (ex) return { name: ex.names[0], names: ex.names, optional: false, exception: ex.when };
  return { name: squash(value), optional: false, prose: true };
}

/** An exception edge (specification 6.5.1): the phases whose failure sends
 *  work here, then a comma and the condition, as in `do-the-work, when it
 *  slips` or `score or route, whichever could not finish`. Null for any other
 *  value. */
export function exceptionEdge(value) {
  const m = /^([a-z0-9-]+(?:\s+or\s+[a-z0-9-]+)*)\s*,\s*(\S.*)$/.exec(squash(value));
  return m ? { names: m[1].split(/\s+or\s+/), when: m[2] } : null;
}

/** Everything that stops a run from starting against this document, and
 *  everything worth telling the owner. Each problem carries a code:
 *    blocking:  no-owner, no-effective, no-version, blank, no-level, bad-level,
 *               unknown-after, prose-after, exception-edge, no-trigger-phase, cycle, no-phases,
 *               unknown-handoff-phase, unknown-deviation-phase, bad-carries,
 *               carries-not-unique
 *    open:      open-holder (a phase owner left as a blank, to be bound by
 *               the roster; not blocking on its own)
 *    note:      no-after (read as after: trigger), unparsed (a line the
 *               parser could not place), run-scoped (lines this runtime
 *               does not run), confidential-under (an agreement this
 *               runtime does not check, said as section 11.3 requires),
 *               extension-ignored (an extension this runtime does not know)
 *  `ok` is true when nothing blocking remains. */
export function validate(doc, { roster = null } = {}) {
  const problems = [];
  const add = (code, text, extra = {}) => problems.push({ code, text, ...extra });
  const ids = new Set(doc.phases.map((p) => p.id));
  const owner = doc.header.owner;
  const effective = doc.header.effective;
  if (!owner || isBlank(owner)) add("no-owner", "the document names no owner (owner: is empty or a blank), so it is a reference process and runs nowhere");
  if (!effective || isBlank(effective)) add("no-effective", "the document names no effective date (effective: is empty or a blank), so it is not in force");
  if (!doc.header.version) add("no-version", "the document carries no version beside its id (write `id: team/slug v1`)");
  if (!doc.phases.length) add("no-phases", "the document has no phases");

  const rosterHas = (phase) => {
    if (!roster) return false;
    const bare = phase.owner.replace(/^<|>$/g, "").trim();
    return roster.has(phase.id) || roster.has(bare);
  };
  for (const b of doc.blanks) {
    const phase = b.phase ? doc.phases.find((p) => p.id === b.phase) : null;
    if (phase && isBlank(phase.owner) && b.text === squash(phase.owner)) {
      if (!rosterHas(phase)) add("open-holder", `phase ${phase.id} names its holder as ${b.text}; the roster must name a handle for it`, { phase: phase.id, blank: b.text });
      continue;
    }
    if (b.section === "bindings" && doc.bindings.roster && doc.bindings.roster.includes(b.text.slice(1, -1))) {
      add("note", `the roster binding is a blank (${b.text}); the roster sent with the run replaces it`, { section: b.section });
      continue;
    }
    add("blank", `a blank is still open in ${b.phase ? `phase ${b.phase}` : `the ${b.section} section`}: ${b.text}`, { section: b.section, ...(b.phase ? { phase: b.phase } : {}) });
  }

  let anyTrigger = false;
  for (const p of doc.phases) {
    if (!p.automation) add("no-level", `phase ${p.id} carries no automation: level; a runtime must not choose one`, { phase: p.id });
    else if (!isBlank(p.automation) && !LEVELS.includes(p.automation)) add("bad-level", `phase ${p.id} has automation: ${p.automation}, which is not one of ${LEVELS.join(", ")}`, { phase: p.id });
    if (!p.hasAfter) { add("no-after", `phase ${p.id} has no after: line; it is read as after: trigger`, { phase: p.id }); anyTrigger = true; }
    for (const a of p.after) {
      const { name, names, optional, prose, exception } = afterName(a);
      if (name === "trigger") { anyTrigger = true; continue; }
      if (prose) { add("prose-after", `phase ${p.id} has a qualified after: value (${a}) this runtime cannot read; it refuses rather than discard the qualification`, { phase: p.id }); continue; }
      if (exception !== undefined) {
        for (const n of names) if (!ids.has(n)) add("unknown-after", `phase ${p.id} is entered when ${n} cannot complete, but ${n} is not a phase of this document`, { phase: p.id, names: n });
        // Read, and still refused: this runtime asks the owner when a phase
        // cannot complete, and routing the work to the exception phase instead
        // is what the document says happens. Running it without that route
        // would discard the edge (specification 6.5, 6.5.1).
        add("exception-edge", `phase ${p.id} is entered when ${names.join(" or ")} cannot complete (${exception}); this runtime does not route a phase that cannot complete to an exception phase`, { phase: p.id, names: names.join(" ") });
        continue;
      }
      if (!ids.has(name)) add("unknown-after", `phase ${p.id} waits for ${name}${optional ? "?" : ""}, which is not a phase of this document`, { phase: p.id, names: name });
    }
  }
  // A phase that runs another process (0.34.0, Agent Processes 6.3.1).
  for (const p of doc.phases) {
    const inner = innerProcessOf(p);
    if (!inner) continue;
    if (p.automation === "never") add("process-never", `phase ${p.id} runs the process ${inner.id} at never; a phase that runs a process is never written at never, and a gate on what the inner run produced is a phase of its own after it`, { phase: p.id });
    if (!inner.version && !isBlank(inner.id)) add("process-no-version", `phase ${p.id} runs the process ${inner.id} without a version; it names the document by its id and the version it was written against (runs process <id> v<n>)`, { phase: p.id });
    if (inner.id === fullIdOf(doc)) add("process-runs-itself", `phase ${p.id} runs ${inner.id}, which is this document; a process never runs itself`, { phase: p.id });
  }
  if (doc.phases.length && !anyTrigger) add("no-trigger-phase", "no phase starts at the trigger (after: trigger), so nothing in the graph ever begins");

  // A cycle in after: lines deadlocks every run (specification 6.7.2).
  // An exception edge is a failure path, not a wait, so it is no predecessor.
  const preds = new Map(doc.phases.map((p) => [p.id, p.after.map(afterName).filter((a) => a.exception === undefined).map((a) => a.name).filter((n) => ids.has(n))]));
  const state = new Map();
  const visit = (id, path) => {
    if (state.get(id) === "done") return null;
    if (state.get(id) === "open") return [...path, id];
    state.set(id, "open");
    for (const n of preds.get(id) ?? []) { const c = visit(n, [...path, id]); if (c) return c; }
    state.set(id, "done");
    return null;
  };
  for (const id of ids) { const c = visit(id, []); if (c) { add("cycle", `the after: lines form a cycle: ${c.join(" -> ")}`); break; } }

  for (const h of doc.handoffs) {
    for (const f of h.from) if (!ids.has(f) && /^[a-z0-9-]+$/.test(f)) add("unknown-handoff-phase", `handoff [${h.key}] leaves ${f}, which is not a phase of this document`, { key: h.key });
    for (const t of h.to) if (!ids.has(t) && /^[a-z0-9-]+$/.test(t)) add("unknown-handoff-phase", `handoff [${h.key}] goes to ${t}, which is not a phase of this document`, { key: h.key });
  }
  for (const d of doc.deviations) {
    if (d.from !== "any" && !ids.has(d.from)) add("unknown-deviation-phase", `deviation [${d.key}] leaves ${d.from}, which is not a phase of this document`, { key: d.key });
    if (!ids.has(d.to)) add("unknown-deviation-phase", `deviation [${d.key}] returns to ${d.to}, which is not a phase of this document`, { key: d.key });
  }
  // What the trigger carries (0.33.0, Agent Processes 5.4): every item a key,
  // its words and required or optional, and no two items with one key. A run
  // cannot hold to a required item it cannot read.
  const itemKeys = new Map();
  for (const c of doc.trigger?.carries ?? []) {
    if (c.malformed) { add("bad-carries", `the trigger's line "carries: ${c.text}" is not an item: a key, a dash, what it is, and required or optional`); continue; }
    if (itemKeys.has(c.key)) add("carries-not-unique", `the trigger carries two items with the key ${c.key}, so a run cannot say which one it was handed`, { key: c.key });
    itemKeys.set(c.key, true);
  }
  // The extensions (Agent Processes 20.3): one this runtime does not know is
  // ignored, never refused, and said.
  for (const e of doc.extensions ?? []) {
    const full = extensionName(e);
    if (!KNOWN_EXTENSIONS.includes(full)) add("extension-ignored", `the document carries the extension ${full}, which this runtime does not know; it runs the document as if its lines were absent`, { extension: full });
  }
  for (const line of doc.unparsed) add("unparsed", `a line the parser could not place: ${squash(line)}`);
  // Section 11.3: a runtime that does not check the agreement says so.
  if (doc.header.confidentialUnder && !isBlank(doc.header.confidentialUnder)) add("confidential-under", `the document names ${doc.header.confidentialUnder} in confidential-under:; this runtime does not check that each outside participant is bound by it`);
  for (const r of doc.runScoped) add("run-scoped", `run-scoped line ${r.id} (runs ${r.runs}${r.every ? `, every ${r.every}` : ""}) is noted in the account; this runtime does not run it`, { line: r.id });

  const BLOCKING = new Set(["no-owner", "no-effective", "no-version", "blank", "no-level", "bad-level", "unknown-after", "prose-after", "exception-edge", "no-trigger-phase", "cycle", "no-phases", "unknown-handoff-phase", "unknown-deviation-phase", "bad-carries", "carries-not-unique", "process-never", "process-no-version", "process-runs-itself"]);
  const blocking = problems.filter((p) => BLOCKING.has(p.code));
  return { ok: blocking.length === 0, problems, blocking, open: problems.filter((p) => p.code === "open-holder") };
}

/** One `name: value` line as a roster writes one: a phase or a role, then one word. */
const ROSTER_LINE = /^<?([a-z0-9][a-z0-9 ._-]*?)>?\s*:\s*(\S+)$/i;
/** An agent id as the mesh spells one (SPEC 18.1): one NATS subject token. */
const AGENT_ID = /^U[A-Z2-7]{55}$/;
/** A handle: one word with one @ in it, and nothing a JSON value is made of. */
const HANDLE = /^[^\s@{}"'<>(),;]+@[^\s@{}"'<>(),;]+$/;
/** The runner's own lines, which are neither roster nor material: the owner's
 *  `budget: ...` and the platform's `run: <id>` (drive.mjs, platformRun). */
// `platform run:` (0.13.0) names the platform's record of a hand-off without
// asking the runner to drive it (technical debt 215).
// `test run:` (0.32.0) marks a run the platform starts as a test, naming its test case.
// `carried:` (0.33.0) says what the run was handed, item by item (Agent
// Processes 13.2): `carried: <key> = <what>` or `carried: <key> - not given`.
export const CARRIED_LINE = /^carried\s*:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*(?:=\s*(\S.*?)|-\s*not given)\s*$/i;
const RUNNERS_OWN = [CARRIED_LINE, /^budget\s*:/i, /^run\s*:\s*[A-Za-z0-9_-]{3,120}$/i, /^platform run\s*:\s*[A-Za-z0-9_-]{3,120}$/i, /^test run\s*:\s*[A-Za-z0-9_-]{3,120}$/i, /^inner run of\s*:/i];

/** A line of material meant for one phase: `[<phase id>] ` (square brackets
 *  round the id, then one space), then the line itself. */
const PHASE_PREFIX = /^\[([A-Za-z0-9][A-Za-z0-9._-]*)\] (.*)$/s;

/** A line as a per-phase line, or null. Leading blanks (a line written inside
 *  a `roster:` block is indented) do not stop it being one. */
export function phasePrefixed(line) {
  const m = PHASE_PREFIX.exec(String(line ?? "").trimStart());
  return m ? { id: m[1], text: m[2] } : null;
}

const phaseIdIn = (doc, id) => (doc?.phases ?? []).find((p) => p.id === id || String(p.id).toLowerCase() === String(id).toLowerCase())?.id ?? null;

/** The material one phase is handed. A line that begins `[<phase id>] ` where
 *  the id is that phase's goes to it with the prefix removed; one whose id is
 *  another phase's is not handed to it; a line without a prefix, and one whose
 *  bracketed id names no phase of the document (left exactly as written), go
 *  to every phase. With no document nothing is filtered. */
export function materialFor(material, doc, phaseId) {
  const out = [];
  for (const raw of String(material ?? "").split(/\r?\n/)) {
    const pre = phasePrefixed(raw);
    const target = pre && doc ? phaseIdIn(doc, pre.id) : null;
    if (!target) { out.push(raw); continue; }
    if (target === phaseId) out.push(pre.text);
  }
  return out.join("\n").trim();
}

/** A file's own name: the adapter puts <n>-<8 chars>- on every inbound file
 *  it stages, and a file that came through another runner carries one per
 *  hop. A phase's files went on under those prefixes on 2026-09-15 and the
 *  next holder could not tell the spec from the suite by name. */
export function bareName(name) {
  let n = String(name ?? "");
  for (;;) { const m = /^\d+-[A-Za-z0-9_-]{8}-(.+)$/.exec(n); if (!m) return n; n = m[1]; }
}

/** A material line that aims one of the run's files at one phase (0.17.0):
 *  `[<phase id>] file: <file name>`. */
const AIMED_FILE = /^file\s*:\s*(.+?)\s*$/i;

/**
 * The run's files that the material aims at phases (0.17.0), as a map from a
 * file's bare name to the phases that name it. A file is aimed by a line
 * `[<phase id>] file: <file name>` whose id is a phase of the document; one
 * file may be aimed at several phases by several lines. A line whose
 * bracketed id names no phase aims nothing, the way materialFor leaves such a
 * line to every phase. With no document nothing is aimed.
 */
export function aimedFiles(material, doc) {
  const out = new Map();
  if (!doc) return out;
  for (const raw of String(material ?? "").split(/\r?\n/)) {
    const pre = phasePrefixed(raw);
    const target = pre ? phaseIdIn(doc, pre.id) : null;
    const m = target ? AIMED_FILE.exec(pre.text) : null;
    if (!m) continue;
    const name = bareName(m[1]);
    if (!out.has(name)) out.set(name, new Set());
    out.get(name).add(target);
  }
  return out;
}

/** The bracketed ids of the material that name no phase of the document, once each. */
export function unknownPhaseIds(material, doc) {
  const ids = [];
  for (const raw of String(material ?? "").split(/\r?\n/)) {
    const pre = phasePrefixed(raw);
    if (pre && !phaseIdIn(doc, pre.id) && !ids.includes(pre.id)) ids.push(pre.id);
  }
  return ids;
}

/** Whether a value names a holder by itself: a handle, or an agent id. */
const namesHolder = (value) => HANDLE.test(String(value ?? "")) || AGENT_ID.test(String(value ?? ""));

/**
 * The text a run is started with, before its document, read apart into the
 * roster's lines and the material.
 *
 * A roster line is one inside the `roster:` block (the platform writes
 * `roster:` and then one indented `name: handle` line per holder; the first
 * blank or unindented line ends it), one on the `roster:` line itself
 * (`roster: site-reader: reader.example`, several separated by commas, as a
 * page sends its Roster field), or a bare `name: value` line whose value
 * is a handle or an agent id, or whose name is a phase or a role of `doc`
 * (the older bare form, `video-watcher: watcher.acme`, whose handles carry no
 * @). A line with an address in it is material whatever its shape, and so is
 * a line that begins `[<phase id>] `, even inside the roster block. The
 * `budget:` and `run:` lines are the runner's own and are neither; it reads
 * them from the text itself. Every other line is material, word for word.
 *
 * Until 0.10.4 every `name: word` line was taken for a roster line, so a Start
 * form's one-word answers (`voice: Charon`, `pace: brisk`) were taken out of
 * the material and never reached a phase.
 */
export function splitStart(text, doc = null) {
  const names = new Set();
  for (const p of doc?.phases ?? []) {
    names.add(String(p.id).toLowerCase());
    const role = String(p.owner ?? "").replace(/^<|>$/g, "").trim().toLowerCase();
    if (role) names.add(role);
  }
  const roster = [];
  const material = [];
  let inBlock = false;
  // Inside the `material:` block the platform writes (0.14.0), a line is a
  // Start answer unless it names a phase or a role of the document: an answer
  // whose value looks like a handle (`contact: bob@example.com`) or that is
  // called budget or run is the person's, and was lost before.
  let inMaterial = false;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (/^roster\s*:$/i.test(line)) { inBlock = true; inMaterial = false; continue; }
    // The roster on its own line (0.29.1): `roster: <name>: <handle>`, one or
    // several separated by commas or semicolons, as a page sends a Roster
    // field. It also opens the block, so indented lines after it are holders.
    const inline = /^roster\s*:\s*(\S.*)$/i.exec(line);
    if (inline && !/:\/\//.test(line)) {
      const parts = inline[1].split(/[,;]/).map((x) => x.trim()).filter(Boolean);
      if (parts.length && parts.every((x) => ROSTER_LINE.test(x))) { roster.push(...parts); inBlock = true; inMaterial = false; continue; }
    }
    if (/^material\s*:$/i.test(line)) { inBlock = false; inMaterial = true; material.push(raw); continue; }
    if (inMaterial && !phasePrefixed(line)) {
      const m = ROSTER_LINE.exec(line);
      if (m && !/:\/\//.test(line) && names.has(m[1].trim().toLowerCase())) roster.push(line);
      else material.push(raw);
      continue;
    }
    // A line meant for one phase is material, never a roster line, wherever
    // it stands; inside a roster block it does not end the block.
    if (phasePrefixed(line)) {
      if (inBlock && /^\s/.test(raw)) material.push(line);
      else { inBlock = false; material.push(raw); }
      continue;
    }
    if (inBlock && line && /^\s/.test(raw)) { roster.push(line); continue; }
    inBlock = false;
    if (RUNNERS_OWN.some((re) => re.test(line))) continue;
    const m = ROSTER_LINE.exec(line);
    if (m && !/:\/\//.test(line) && (namesHolder(m[2]) || names.has(m[1].trim().toLowerCase()))) { roster.push(line); continue; }
    material.push(raw);
  }
  return { rosterText: roster.join("\n"), material: material.join("\n").trim() };
}

/** The roster: one line per phase or role, `name: handle`. Every line of the
 *  text is read as a roster line, which is right for a roster file and wrong
 *  for a message: the lines of a message are read apart by splitStart first,
 *  and only its roster lines come here. A line that is not that shape is kept
 *  under `ignored`. */
export function parseRoster(text) {
  const map = new Map();
  const ignored = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = ROSTER_LINE.exec(line);
    if (!m) { ignored.push(line); continue; }
    map.set(m[1].trim().toLowerCase(), m[2]);
  }
  return { map, ignored };
}

/** The most of an item's words the run record carries as they are; longer
 *  words are named by where they are, the run's material, which keeps them
 *  whole (Agent Processes 13.2: "the words, or a reference"). */
export const CARRIED_SHOWN = 200;
const itemSlug = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * What a run was handed, item by item (0.33.0, Agent Processes 5.4 and
 * 13.2), or null when the document's trigger carries no items.
 *
 * The hand-off may say it outright, one runner's line per item, `carried:
 * <key> = <what>` or `carried: <key> - not given`, and what it says stands
 * (the platform writes these, because only it knows which file a person gave
 * for which item). An item it does not mention is found in what came: a
 * material line under the item's name (`topic: ...`, `[<phase>] topic: ...`,
 * or `topic:` with the words indented under it), else a file whose name,
 * without its extension, is the item's key. Names are compared as keys, so
 * `target_audience` is the item `target-audience`. Each item comes back as
 * { key, required, given, value } with value only when given.
 */
export function carriedOf(doc, { before = "", material = "", files = [] } = {}) {
  const items = (doc?.trigger?.carries ?? []).filter((c) => !c.malformed);
  if (!items.length) return null;
  const said = new Map();
  for (const raw of String(before ?? "").split(/\r?\n/)) {
    const m = CARRIED_LINE.exec(raw.trim());
    if (m && !said.has(m[1].toLowerCase())) said.set(m[1].toLowerCase(), m[2] === undefined ? null : m[2].trim());
  }
  const lines = String(material ?? "").split(/\r?\n/);
  const found = new Map();
  for (let i = 0; i < lines.length; i++) {
    const pre = phasePrefixed(lines[i]);
    const m = /^\s*([^:[\]]{1,120}?)\s*:(?:\s+(.*))?\s*$/.exec(pre ? pre.text : lines[i]);
    if (!m || /\/\//.test(m[1])) continue;
    const k = itemSlug(m[1]);
    if (!k || found.has(k)) continue;
    let words = (m[2] ?? "").trim();
    if (!words) {
      const block = [];
      for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) block.push(lines[j].trim());
      words = block.join("\n");
    }
    if (words) found.set(k, words);
  }
  const named = new Map();
  for (const f of files ?? []) {
    if (f?.error) continue;
    const name = bareName(String(f?.name ?? f?.path ?? "").split(/[\\/]/).pop());
    const k = itemSlug(name.replace(/\.[A-Za-z0-9]+$/, ""));
    if (k && !named.has(k)) named.set(k, name);
  }
  return items.map((c) => {
    const base = { key: c.key, required: c.required };
    if (said.has(c.key)) return said.get(c.key) === null ? { ...base, given: false } : { ...base, given: true, value: said.get(c.key) };
    const words = found.get(c.key);
    if (words) return { ...base, given: true, value: !words.includes("\n") && words.length <= CARRIED_SHOWN ? words : `the words in the run's material, ${words.length} characters` };
    if (named.has(c.key)) return { ...base, given: true, value: `file ${named.get(c.key)}` };
    return { ...base, given: false };
  });
}

/** The run record's line for one item (Agent Processes 13.2). */
export const carriedLine = (c) => (c.given ? `carried: ${c.key} = ${c.value}` : `carried: ${c.key} - not given`);

const thisFile = process.argv[1] ? process.argv[1].replace(/\\/g, "/").split("/").pop() : "";
if (thisFile && import.meta.url.endsWith(thisFile)) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const ri = args.indexOf("--roster");
  if (!file) { console.error("usage: node parse-process.mjs <document.txt> [--roster <roster.txt>]"); process.exit(2); }
  try {
    const doc = parseProcessDocument(readFileSync(file, "utf8"));
    const roster = ri >= 0 && args[ri + 1] ? parseRoster(readFileSync(args[ri + 1], "utf8")).map : null;
    const v = validate(doc, { roster });
    console.log(JSON.stringify({ ok: v.ok, problems: v.problems, document: doc }, null, 2));
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, problems: [{ code: "not-a-process", text: e.message }] }));
    process.exit(1);
  }
}
