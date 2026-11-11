// The architecture record (architecture-record-v1), as the reference solution
// architect writes it (CommonAgent/adlc agents/solution-architect,
// scripts/architecture-record.mjs): a Markdown document for the person with a
// structured header for the bindings, then fixed headings. This file reads one
// back for Product Factory, without a YAML library and without the
// architect's own code, so a record written by any holder of the role that
// keeps the form reads the same.
//
//   readRecord(text)          the header: { statement, environments, kind, done, questions, systems, bindings }, or null
//   questionsOf(text)         the open questions under ## Questions: [{ key, question }]
//   architectureSummary(text) the record as lifecycle API 0.4.12 ArchitectureSummary, or null when it
//                             cannot be one (no header, or a kind outside the three the API names)
//
// Nothing here reads or writes a file.

const words = (s) => String(s ?? "").trim();

/** The record's format word, the first line of every header. */
export const RECORD_FORMAT = "architecture-record-v1";
/** The agent's kinds the lifecycle API names (ArchitectureSummary.kind). */
export const KINDS = ["plugin-on-harness", "mesh-coded", "third-party-framework"];

/** A scalar as YAML reads it: a double-quoted one as JSON, a single-quoted one without its quotes. */
function unquote(v) {
  const t = words(v);
  if (/^"(?:[^"\\]|\\.)*"$/.test(t)) { try { return JSON.parse(t); } catch { return t.slice(1, -1); } }
  if (/^'.*'$/.test(t)) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

/** A flow or block list as the header writes it: [a, b], none, or the items gathered under it. */
function listOf(v) {
  if (Array.isArray(v)) return v.filter(Boolean);
  const t = words(v).replace(/^\[/, "").replace(/\]$/, "");
  return !t || t === "none" ? [] : t.split(",").map(unquote).filter(Boolean);
}

/** The record's header, read back, or null when the text is not an architecture record. */
export function readRecord(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? ""));
  if (!m) return null;
  const out = { bindings: {} };
  let inBindings = false;
  let system = null;
  let listing = null;
  for (const raw of m[1].split(/\r?\n/)) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    const item = /^-\s+(.+)$/.exec(line);
    if (item && listing) { out[listing].push(unquote(item[1])); continue; }
    const at = line.indexOf(":");
    if (at < 0) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (indent === 0) {
      inBindings = key === "bindings" && !value;
      system = null;
      listing = null;
      if (key === "bindings") continue;
      if (!value && ["systems", "environments", "standing_assets"].includes(key)) { out[key] = []; listing = key; continue; }
      out[key] = value;
      continue;
    }
    if (!inBindings) continue;
    if (indent <= 2 && !value) { system = key; out.bindings[system] = {}; continue; }
    if (system) {
      const b = /^(.+?)\s*\((customer|platform|asked)\)$/.exec(value);
      out.bindings[system][key] = !b || b[2] === "asked" || /^unbound\b/.test(value) ? { unbound: true } : { product: b[1].trim(), provided_by: b[2] };
    }
  }
  if (unquote(out.record) !== RECORD_FORMAT) return null;
  return {
    statement: unquote(out.statement),
    environments: listOf(out.environments),
    kind: words(out.kind),
    done: words(out.done) === "yes",
    questions: Number(out.questions) || 0,
    systems: listOf(out.systems),
    bindings: out.bindings,
  };
}

/** The body's sections by their heading (## Name), each the lines under it. */
function sections(text) {
  const body = String(text ?? "").replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const out = new Map();
  let cur = null;
  for (const line of body.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) { cur = h[1].toLowerCase(); out.set(cur, []); continue; }
    if (cur) out.get(cur).push(line);
  }
  return out;
}

const bullets = (lines = []) => lines.map((l) => /^\s*-\s+(.+)$/.exec(l)?.[1]).filter(Boolean).map(words);
const noStop = (s) => words(s).replace(/[.\s]+$/, "");

/** The open questions a record carries under its Questions heading: [{ key, question }]. */
export function questionsOf(text) {
  return bullets(sections(text).get("questions")).map((b) => /^([a-z][a-z0-9-]*): (.+)$/.exec(b)).filter(Boolean).map((m) => ({ key: m[1], question: m[2] }));
}

/** ## Dependencies: "**name** (an agent|a service): why." per line, or None. */
function dependenciesOf(lines) {
  return bullets(lines).map((b) => /^\*\*(.+?)\*\*(?:\s*\([^)]*\))?:\s*(.+)$/.exec(b)).filter(Boolean).map((m) => ({ name: words(m[1]), why: noStop(m[2]) }));
}

/** ## Limits: "**Cost**: ..." and the rest. Only the four the API names, each in its own words. */
function limitsOf(lines) {
  const out = {};
  for (const b of bullets(lines)) {
    const m = /^\*\*(Cost|Speed|Data|Trust)\*\*:\s*(.+)$/i.exec(b);
    if (m) out[m[1].toLowerCase()] = words(m[2]);
  }
  return out;
}

/** ## Decisions: "### Decision N. <decided>", then "Why:", "Weighed:" and "What follows:" paragraphs. */
function decisionsOf(lines = []) {
  const out = [];
  let d = null;
  for (const line of lines) {
    const h = /^###\s+Decision\s+\d+\.\s*(.+?)\s*$/.exec(line);
    if (h) { d = { decided: words(h[1]), why: "" }; out.push(d); continue; }
    if (!d) continue;
    const m = /^(Why|Weighed|What follows):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    if (m[1] === "Why") d.why = words(m[2]);
    else if (m[1] === "Weighed" && words(m[2])) d.options = [words(m[2])];
    else if (m[1] === "What follows" && words(m[2])) d.follows = words(m[2]);
  }
  return out;
}

/**
 * ## Egress: one line per environment ("dev: the target runs the agent open
 * ..." or "... behind an allowlist"), then the destinations beyond the derived
 * set, which hold in every environment: "Beyond the derived set (...): <what>
 * (asked), <why>; ..." or "None beyond the derived set ...".
 */
function egressOf(lines, environments) {
  const lineOf = new Map();
  let beyond = [];
  for (const b of bullets(lines)) {
    const env = /^([a-z]+):\s*(.+)$/.exec(b);
    if (env && environments.includes(env[1])) { lineOf.set(env[1], env[2]); continue; }
    const more = /^Beyond the derived set[^:]*:\s*(.+)$/.exec(b);
    if (more) {
      beyond = noStop(more[1]).split(/;\s+/).map((x) => /^(.+?)(?:\s*\((?:asked|granted by the person)\))?,\s*(.+)$/.exec(x.trim())).filter(Boolean).map((m) => ({ what: words(m[1]), why: words(m[2]) }));
    }
  }
  return environments.map((environment) => ({
    environment,
    ...(beyond.length ? { destinations: beyond.map((d) => ({ ...d })) } : {}),
    enforced: /behind an allowlist/.test(lineOf.get(environment) ?? ""),
  }));
}

/**
 * The record as the lifecycle API's ArchitectureSummary (0.4.12): its systems
 * and the product bound to each per environment (a binding still asked is left
 * out), its dependencies, kind, limits, every decision with its reason, its
 * egress per environment and how many questions are still open. Null when the
 * text is not a record, or its kind is not settled as one of the three.
 */
export function architectureSummary(text) {
  const head = readRecord(text);
  if (!head || !KINDS.includes(head.kind)) return null;
  const secs = sections(text);
  const bindings = {};
  for (const sys of head.systems) {
    const per = {};
    for (const [env, b] of Object.entries(head.bindings[sys] ?? {})) if (!b.unbound) per[env] = { product: b.product, provided_by: b.provided_by };
    bindings[sys] = per;
  }
  return {
    systems: head.systems,
    bindings,
    dependencies: dependenciesOf(secs.get("dependencies")),
    kind: head.kind,
    limits: limitsOf(secs.get("limits")),
    decisions: decisionsOf(secs.get("decisions")),
    egress: egressOf(secs.get("egress"), head.environments),
    questions: head.questions,
  };
}
