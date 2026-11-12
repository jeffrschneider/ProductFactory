// The spec, seeded from an as-built record with no model.
//
// The reverse engineer's record (agents/reverse-engineer 0.2.0,
// references/the-as-built-record.md) already says, byte for byte and with
// evidence, what the code does: each behavior, the words and patterns other
// code depends on, the rules it holds to, the interfaces it presents, the
// constants it writes down and the settings it reads. Until 0.9.0 none of
// that had a place to go: the spec was the agent's descriptor, which has no
// field for a stop pattern or a refusal's words, and on 2026-11-09 a round
// trip on hn-reader lost every one of them before Test. So code carries them
// into the spec here, each where spec-v1 says it goes, and the model then
// writes only what code cannot: clear shall statements, the purpose and the
// Gherkin scenarios.
//
//   - each behavior is a feature (as_built: B<n>), unless the person dropped
//     it or called it a bug;
//   - each verbatim quote is a requirement of kind wording, or pattern for a
//     regular expression, with the quote in exact and the behavior and its
//     evidence as source;
//   - each rule (order, limit, header, default) is a requirement of that kind
//     (a header is kind interface), with its values in exact: the rule's own
//     quote, and every number, quoted word, tag and file name its words name;
//   - each refusal is a refusal requirement with its words in exact, and each
//     error handling an error requirement in its words;
//   - each constant the behavior uses is a requirement with its value in
//     exact, and an exported one that no behavior lists is a constraint;
//   - each interface is an interface with keep: true (a rebuild keeps them;
//     the person can loosen one), a function with its module and signature,
//     a command with its flags, a file with its JSON Schema from schemas/;
//   - each address the code reaches (the record's egress) is a system, with
//     an address setting whose default is the address; each address it only
//     writes down (a constant or a schema's const that no egress names) is a
//     system with reach none;
//   - the settings are the record's settings and its run config's, each one
//     whose default the record withholds asked as an open question.
//
// Nothing here invents a value: every string in exact is in the record as it
// was written. The name, the version and the price are the person's (keyed
// lines in their words), and where they did not say, the name is a stand-in
// and the question is open.
//
//   needs: node >= 22. Reads an attachment from its path only when the
//   gathering step cut its text at the cap.
//   import { recordOf, seedSpec, ruleValues } from "./seed.mjs"
import { readFileSync } from "node:fs";
import { sameAddress } from "./reaches.mjs";
import { declaredSettingsIn } from "./declared.mjs";
import { SPEC_FORMAT } from "./spec-v1.mjs";

const trim = (s) => String(s ?? "").trim();
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);
const URL_AT = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;
const isAddress = (v) => typeof v === "string" && /^https?:\/\/[^\s]+$/i.test(v.trim());

/** The name a spec carries while the person has not named the product. It
 *  is never a name: the open question beside it says so, and the Design
 *  writes no name from it. */
export const STAND_IN_NAME = "agent-not-named-yet";
/** The version a first spec drafts when the person gave none. */
export const FIRST_VERSION = "0.1.0";

/** The kinds of interface spec-v1 1.1.0 gives a place to. */
export const INTERFACE_KINDS = ["command", "file", "function", "constant", "declaration", "message", "http", "setting"];

/** The format of the reverse engineer's inventory of every string a person
 *  reads and every pattern the code matches (0.3.0, strings.json). */
export const STRINGS_FORMAT = "as-built-strings-v1";

/** The parts of an as-built record among what came with the request, read by
 *  their format, never by their file names: behaviors, interfaces,
 *  architecture, tests and gaps, the record itself, and each JSON Schema by
 *  its file name (an interface names schemas/I2.schema.json). Null when no
 *  behaviors part came. An attachment cut at the gathering step's cap is
 *  read again whole from its path. */
export function recordOf(asked = null, { read = (p) => readFileSync(p, "utf8") } = {}) {
  const out = { behaviors: null, interfaces: null, architecture: null, tests: null, record: null, strings: null, schemas: {} };
  for (const a of list(asked?.attached)) {
    if (a?.missing) continue;
    let text = typeof a?.text === "string" ? a.text : null;
    if (a?.cut && a?.path) { try { text = read(a.path); } catch { /* the cut text stays, and will not parse */ } }
    if (text == null || !/^\s*[[{]/.test(text)) continue;
    let doc;
    try { doc = JSON.parse(text); } catch { continue; }
    if (!isObj(doc)) continue;
    const f = trim(doc.format);
    if (f === "as-built-behaviors-v1") out.behaviors = doc;
    else if (f === "as-built-interfaces-v1") out.interfaces = doc;
    else if (f === "as-built-architecture-v1" || (doc.as_built === true && trim(doc.record) === "architecture-record-v1")) out.architecture = doc;
    else if (f === "as-built-tests-and-gaps-v1") out.tests = doc;
    else if (f === "as-built-record-v1") out.record = doc;
    else if (f === STRINGS_FORMAT) out.strings = doc;
    else if (/json-schema/i.test(String(doc.$schema ?? "")) || (doc.type && isObj(doc.properties))) out.schemas[baseName(a.name ?? a.path)] = doc;
  }
  return out.behaviors && list(out.behaviors.behaviors).length ? out : null;
}

const baseName = (p) => String(p ?? "").replace(/\\/g, "/").split("/").pop();

/** What the person said that settles the product's name, version and price,
 *  from keyed lines in their words or their answers ("name: x", "version:
 *  1.2.0", "price: free"). Each is null when they did not say it. */
export function personSettled(texts = []) {
  const out = { name: null, version: null, price: null };
  for (const t of texts) {
    const text = String(t ?? "");
    const name = /^\s*(?:[-*]\s*)?(?:changes\s*:\s*)?name\s*:\s*`?([a-z][a-z0-9-]*[a-z0-9])`?\s*\.?\s*$/im.exec(text);
    if (name && !out.name) out.name = name[1];
    const version = /^\s*(?:[-*]\s*)?(?:changes\s*:\s*)?version\s*:\s*v?(\d+\.\d+\.\d+)\b/im.exec(text);
    if (version && !out.version) out.version = version[1];
    const price = /(?:^|[\s.;:])price\s*(?:is|:|=)\s*([^\n.;]+)/im.exec(text);
    if (price && !out.price) out.price = priceWords(price[1]);
  }
  return out;
}

/** A price as the person said it, tidied only at its edges. */
const priceWords = (s) => { const t = trim(s).replace(/[.,;]+$/, ""); return t ? t[0].toUpperCase() + t.slice(1) : null; };

/** The behaviors the person dropped or called a bug, from their words:
 *  "dropped: B7", "bug: B3 and B4", "B7 is dropped", "drop B7". Returns a
 *  Map of B<n> to "dropped" or "bug". */
export function leftOutIn(text = "") {
  const out = new Map();
  const ids = (s) => [...String(s).matchAll(/\bB([1-9]\d*)\b/g)].map((m) => `B${m[1]}`);
  const t = String(text);
  for (const m of t.matchAll(/^\s*(?:\[[^\]]+\]\s*)?(?:[-*]\s*)?(dropped|drop|bugs?|not kept)\s*:\s*(.+)$/gim)) {
    for (const id of ids(m[2])) out.set(id, /bug/i.test(m[1]) ? "bug" : "dropped");
  }
  for (const m of t.matchAll(/\b(B[1-9]\d*(?:\s*(?:,|and)\s*B[1-9]\d*)*)\s+(?:is|was|are|were)\s+(dropped|not kept|a bug|bugs)\b/gi)) {
    for (const id of ids(m[1])) out.set(id, /bug/i.test(m[2]) ? "bug" : "dropped");
  }
  for (const m of t.matchAll(/\bdrop(?:ping)?\s+(B[1-9]\d*(?:\s*(?:,|and)\s*B[1-9]\d*)*)/gi)) for (const id of ids(m[1])) out.set(id, "dropped");
  return out;
}

/** The features the person already approved, as the lines the runner adds
 *  ("- F1 (offering read-the-stories): find requested revision. Reads ..."),
 *  by name, so a feature keeps the id it was approved under. */
export function approvedIn(text = "") {
  const out = new Map();
  for (const m of String(text).matchAll(/^\s*(?:\[[^\]]+\]\s*)?-\s*(F[1-9]\d*)\s*\(offering ([^)]*)\):\s*([^\n]+?)\.\s/gm)) {
    const offering = trim(m[2]) === "not named" ? "" : trim(m[2]);
    out.set(trim(m[3]).toLowerCase(), { id: m[1], offering });
  }
  return out;
}

/** A sentence in the third person ("Caps the count at 30.") as what the
 *  agent shall do ("The agent shall cap the count at 30."). A sentence that
 *  does not open with a verb is kept whole after "shall do this:". */
export function shallOf(words, subject = "The agent") {
  const t = trim(words).replace(/\s+/g, " ");
  if (!t) return `${subject} shall do what the record says.`;
  const [first, ...rest] = t.split(" ");
  const w = first.replace(/[^A-Za-z]/g, "");
  const lower = w.toLowerCase();
  const special = { is: "be", has: "have", does: "do", goes: "go" };
  let base = null;
  if (special[lower]) base = special[lower];
  else if (/[^aeiou]ies$/.test(lower)) base = lower.replace(/ies$/, "y");
  else if (/(?:ches|shes|sses|xes|zes)$/.test(lower)) base = lower.replace(/es$/, "");
  else if (/[^s]s$/.test(lower) && lower.length > 3) base = lower.replace(/s$/, "");
  const end = /[.!?]$/.test(t) ? "" : ".";
  if (!base || first !== w) return `${subject} shall do this: ${t}${end}`;
  return `${subject} shall ${[base, ...rest].join(" ")}${end}`;
}

/** A quote that is a pattern: a regular expression as written, or one the
 *  record calls a pattern or attached by rule. */
export const isPatternQuote = (q) => q?.by_rule === true || /\bpattern\b/i.test(String(q?.what ?? "")) || /^\/.+\/[dgimsuyv]*$/s.test(String(q?.text ?? ""));

/** The values a rule fixes, each as the record wrote it: its quote, then
 *  every word it quotes ('x', "x" or in backticks), every tag (<article>),
 *  every file name (message.json) and every number its words name. */
export function ruleValues(rule) {
  const out = [];
  const add = (v) => { const s = String(v); if (s && !out.includes(s)) out.push(s); };
  if (trim(rule?.quote)) add(rule.quote);
  const words = String(rule?.rule ?? "");
  for (const m of words.matchAll(/(?:^|[\s(])'([^'\n]{1,80})'(?=$|[\s.,;:)])/g)) add(m[1]);
  for (const m of words.matchAll(/"([^"\n]{1,80})"/g)) add(m[1]);
  for (const m of words.matchAll(/`([^`\n]{1,80})`/g)) add(m[1]);
  for (const m of words.matchAll(/<[a-z][a-z0-9-]*>/gi)) add(m[0]);
  for (const m of words.matchAll(/\b[\w-]+\.(?:json|txt|md|mjs|js|cjs|html|csv)\b/g)) add(m[0]);
  for (const m of words.matchAll(/(?<![\w.])\d+(?:\.\d+)?(?![\w.])/g)) add(m[0]);
  return out;
}

/** The kind of requirement a rule of the record is: its own kind, except a
 *  header (a fixed field the agent sends), which is an interface. */
const RULE_KIND = { order: "order", limit: "limit", default: "default", header: "interface" };

const evidenceOf = (ev) => list(ev).filter((e) => isObj(e) && trim(e.file) && Number.isInteger(e.line)).map((e) => ({ file: trim(e.file), line: e.line }));
const sourceOf = (b, ev) => ({ behavior: b.id, ...(evidenceOf(ev ?? b.evidence).length ? { evidence: evidenceOf(ev ?? b.evidence) } : {}) });

/** The module and export an anchor names: "scripts/a.mjs#run" is the export
 *  run of scripts/a.mjs; "scripts/a.mjs" is the command's main block. */
const anchorOf = (b) => { const [module, name] = trim(b?.anchor).split("#"); return { module, name: name ?? null }; };

/** Each interface of the record as an interface of the spec, kept. */
export function interfacesOf(record) {
  const out = [];
  const used = new Set();
  let next = 1;
  const idFor = (id) => {
    const want = /^I[1-9]\d*$/.test(trim(id)) && !used.has(trim(id)) ? trim(id) : null;
    if (want) { used.add(want); return want; }
    while (used.has(`I${next}`)) next += 1;
    used.add(`I${next}`); return `I${next}`;
  };
  for (const i of list(record?.interfaces?.interfaces)) {
    const kind = INTERFACE_KINDS.includes(trim(i?.kind)) ? trim(i.kind) : null;
    if (!kind || !trim(i?.name)) continue;
    // A constant or a declaration with no value is nothing to keep.
    if ((kind === "constant" || kind === "declaration") && (i.value === undefined || i.withheld)) continue;
    if (kind === "declaration" && !trim(i.declared_in)) continue;
    const e = { id: idFor(i.id), kind };
    if (kind === "function") {
      const name = trim(i.export) || trim(i.name).replace(/\(.*$/s, "");
      Object.assign(e, { name, keep: true, ...(trim(i.module) ? { module: trim(i.module) } : {}), signature: `${i.async ? "async " : ""}${trim(i.name).includes("(") ? trim(i.name) : `${name}(${trim(i.params)})`}` });
    } else if (kind === "command") {
      Object.assign(e, { name: trim(i.command) || trim(i.name), keep: true, ...(list(i.flags).length ? { flags: i.flags.map(String) } : {}) });
      if (list(i.required_flags).length) e.required_flags = i.required_flags.map(String);
    } else if (kind === "constant") {
      Object.assign(e, { name: trim(i.name), keep: true, ...(trim(i.module) ? { module: trim(i.module) } : {}), value: structuredClone(i.value) });
    } else if (kind === "declaration") {
      Object.assign(e, { name: trim(i.name), keep: true, declared_in: trim(i.declared_in), value: structuredClone(i.value) });
    } else {
      Object.assign(e, { name: trim(i.name), keep: true });
    }
    e.about = trim(i.does) || (kind === "constant" ? `The constant ${trim(i.name)}${trim(i.module) ? `, exported by ${trim(i.module)}` : ""}, kept with its value.`
      : kind === "declaration" ? `What the agent declares to the platform at ${trim(i.declared_in)}, kept with its value.`
        : `The ${kind} ${trim(i.name)}, as the as-built record gives it.`);
    const schema = trim(i.schema) ? record?.schemas?.[baseName(i.schema)] : undefined;
    if (schema !== undefined) e.schema = schema;
    if (isObj(i.values) && Object.keys(i.values).length) e.values = structuredClone(i.values);
    e.as_built = trim(i.id);
    out.push(e);
  }
  return out;
}

/** The outside systems: each address the code reaches (the record's egress),
 *  named by the architecture system its evidence shares when there is one;
 *  every other system the architecture names; and each address the code
 *  only writes down, with reach none. */
export function systemsOf(record) {
  const arch = record?.architecture ?? {};
  const systems = list(arch.systems);
  const egress = list(arch.egress).map((e) => (typeof e === "string" ? { destination: e } : e)).filter((e) => trim(e?.destination));
  const overlap = (a, b) => evidenceOf(a).some((x) => list(b).some((y) => isObj(y) && y.file === x.file && Number.isInteger(y.line) && x.line >= y.line && x.line <= (y.end_line ?? y.line)))
    || list(b).some((y) => isObj(y) && evidenceOf(a).some((x) => y.file === x.file && y.line === x.line));
  const taken = new Set();
  const reachOf = (s) => ({ read: "read", write: "write", "read-write": "read-write", readwrite: "read-write" }[trim(s?.access).toLowerCase()] ?? "read");
  const out = [];
  const pending = [];
  for (const e of egress) {
    const k = systems.findIndex((s, i) => !taken.has(i) && overlap(e.evidence, s.evidence));
    if (k >= 0) taken.add(k);
    pending.push({ e, k });
  }
  // An egress with no evidence in common takes the next system not yet
  // matched, in the order the record lists them.
  for (const p of pending) {
    if (p.k >= 0) continue;
    const k = systems.findIndex((s, i) => !taken.has(i));
    if (k >= 0) { taken.add(k); p.k = k; }
  }
  for (const { e, k } of pending) {
    const s = k >= 0 ? systems[k] : null;
    const address = String(e.destination).match(/https?:\/\/[^\s"'<>)]+/i)?.[0] ?? null;
    out.push({
      name: trim(s?.product) || (address ? hostOf(address) : trim(e.destination)),
      reach: s ? reachOf(s) : "read",
      ...(address ? { address } : {}),
      why: [trim(e.why), trim(s?.why)].filter(Boolean).join(" ") || `The code reaches ${trim(e.destination)}.`,
    });
  }
  systems.forEach((s, i) => {
    if (taken.has(i) || !trim(s?.name)) return;
    out.push({ name: trim(s.product) || trim(s.name), reach: reachOf(s), why: trim(s.why) || `The code reaches ${trim(s.name)}.` });
  });
  // An address written down and never reached: a constant, or a schema's
  // const, that no egress names.
  const reached = out.filter((s) => s.address).map((s) => sameAddress(s.address));
  const isReached = (a) => reached.some((r) => sameAddress(a) === r || sameAddress(a).startsWith(`${r}/`));
  const seen = new Set();
  for (const c of constantsOf(record)) {
    if (!isAddress(c.value) || isReached(c.value) || seen.has(sameAddress(c.value))) continue;
    seen.add(sameAddress(c.value));
    out.push({ name: hostOf(c.value) || c.value, reach: "none", address: c.value, why: `The code writes this address down (${c.name}${c.module ? ` in ${c.module}` : ""}) and the record names no call to it.` });
  }
  for (const [file, schema] of Object.entries(record?.schemas ?? {})) {
    for (const v of constsIn(schema)) {
      if (!isAddress(v) || isReached(v) || seen.has(sameAddress(v))) continue;
      seen.add(sameAddress(v));
      out.push({ name: hostOf(v) || v, reach: "none", address: v, why: `The code writes this address down (a constant value in ${file}) and the record names no call to it.` });
    }
  }
  return out;
}

const hostOf = (a) => /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i.exec(trim(a))?.[1]?.toLowerCase() ?? "";

function constsIn(schema) {
  const out = [];
  const walk = (s) => {
    if (Array.isArray(s)) { s.forEach(walk); return; }
    if (!isObj(s)) return;
    if (typeof s.const === "string") out.push(s.const);
    for (const e of list(s.enum)) if (typeof e === "string") out.push(e);
    for (const v of Object.values(s)) if (typeof v === "object") walk(v);
  };
  walk(schema);
  return out;
}

/** Every constant the record gives a value: the interfaces' exported ones
 *  and each behavior's, by name, with the module and whether another file
 *  imports it. */
export function constantsOf(record) {
  const out = new Map();
  // An interface of kind constant (reverse engineer 0.3.0) first, then the
  // record's own list of constants; one name is one constant.
  const listed = [...list(record?.interfaces?.interfaces).filter((i) => trim(i?.kind) === "constant"), ...list(record?.interfaces?.constants)];
  for (const c of listed) {
    if (out.has(trim(c?.name))) continue;
    if (!trim(c?.name) || c.value === undefined || c.withheld) continue;
    out.set(trim(c.name), { name: trim(c.name), value: c.value, module: trim(c.module), exported: true, imported: list(c.imported_by).length > 0 });
  }
  for (const b of list(record?.behaviors?.behaviors)) {
    for (const c of list(b?.constants)) {
      if (!trim(c?.name) || c.value === undefined || c.withheld || out.has(trim(c.name))) continue;
      out.set(trim(c.name), { name: trim(c.name), value: c.value, module: trim(evidenceOf(c.evidence)[0]?.file), exported: false, imported: false });
    }
  }
  return [...out.values()];
}

/** The name an address setting is given: the system's name in capitals,
 *  then _ADDRESS. */
export const addressEnvOf = (name) => `${String(name).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "SERVICE"}_ADDRESS`;

/** The settings: the run config's and the environment's the record names,
 *  and an address setting for each system the code reaches at an address.
 *  Returns the settings and an open question for each setting whose default
 *  the record withholds. */
/** The run-config settings the record's declarations give, by name. */
const declaredSettings = (record) => declaredSettingsIn(list(record?.interfaces?.interfaces).filter((i) => trim(i?.kind) === "declaration" && i.value !== undefined));

/** Every string the record's inventory lists (strings.json): a words, a
 *  template or a pattern, with its file and line, as written. */
export function stringsOf(record) {
  return list(record?.strings?.strings)
    .filter((s) => isObj(s) && typeof s.text === "string" && s.text && trim(s.file))
    .map((s) => ({ file: trim(s.file), line: Number.isInteger(s.line) ? s.line : null, kind: ["words", "template", "pattern"].includes(trim(s.kind)) ? trim(s.kind) : "words", text: s.text }));
}

/** Which behavior a string belongs to: the one whose evidence covers its
 *  line, the narrowest when several do; else the first anchored to its file.
 *  Returns { behavior, by } with by "evidence" or "anchor", or null. */
export function behaviorOfString(s, behaviors = []) {
  let best = null;
  for (const b of behaviors) {
    for (const e of list(b?.evidence)) {
      if (!isObj(e) || trim(e.file) !== s.file || !Number.isInteger(e.line) || s.line == null) continue;
      const end = Number.isInteger(e.end_line) ? e.end_line : e.line;
      if (s.line < e.line || s.line > end) continue;
      const width = end - e.line;
      if (!best || width < best.width) best = { behavior: b, width };
    }
  }
  if (best) return { behavior: best.behavior, by: "evidence" };
  const anchored = behaviors.find((b) => anchorOf(b).module === s.file);
  return anchored ? { behavior: anchored, by: "anchor" } : null;
}

/** Where each string of the inventory lands in the spec, by code: in some
 *  requirement's exact, byte for byte. Under the feature of the behavior it
 *  belongs to (behaviorOfString): where a requirement there already carries
 *  it in exact nothing is added, and otherwise a wording requirement (a
 *  pattern requirement for a pattern) is. A string of no behavior is a
 *  constraint; a string of a behavior the person dropped is not kept. Pure:
 *  changes the features and constraints it is handed. */
export function landStrings(record, { behaviors = [], features = [], constraints = [], left = new Map() } = {}) {
  const byBehavior = new Map(features.map((f) => [trim(f.as_built), f]));
  for (const s of stringsOf(record)) {
    const found = behaviorOfString(s, behaviors);
    if (found && left.has(trim(found.behavior.id))) continue;
    const pattern = s.kind === "pattern";
    const evidence = s.line != null ? [{ file: s.file, line: s.line }] : [];
    const shall = pattern ? "The agent shall recognize this pattern exactly as given." : s.kind === "template" ? "The agent shall say these words exactly as given, with each placeholder filled." : "The agent shall say these words exactly as given.";
    const f = found ? byBehavior.get(trim(found.behavior.id)) : null;
    if (f) {
      if (list(f.requirements).some((r) => list(r.exact).includes(s.text))) continue;
      f.requirements.push({ id: `${f.id}.R${f.requirements.length + 1}`, shall, kind: pattern ? "pattern" : "wording", exact: [s.text], priority: "must", source: { behavior: trim(found.behavior.id), ...(evidence.length ? { evidence } : {}) }, verify: "test" });
      continue;
    }
    if (constraints.some((c) => list(c.exact).includes(s.text))) continue;
    constraints.push({ shall, kind: pattern ? "pattern" : "wording", exact: [s.text], priority: "must", source: { said: `the as-built record's strings list it at ${s.file}${s.line != null ? `:${s.line}` : ""}, in no behavior`, ...(evidence.length ? { evidence } : {}) }, verify: "test" });
  }
}

export function settingsOf(record, systems = []) {
  const out = [];
  const open = [];
  const has = (n) => out.some((s) => s.name === n);
  const declared = declaredSettings(record);
  for (const s of list(record?.interfaces?.settings)) {
    const name = trim(typeof s === "string" ? s : s?.name);
    if (!name || has(name)) continue;
    // What the agent declares of the setting (reverse engineer 0.3.0) is
    // copied: its default, its range and its allowed values. Only a default
    // nobody declared is asked.
    const d = declared.get(name) ?? {};
    out.push({
      name, kind: "run-config", set_by: "either",
      about: `A run-config setting the agent declares${trim(s?.declared_in) ? ` (${trim(s.declared_in)})` : ""}; ${"default" in d ? "its declared values are kept" : "the as-built record names it and never its value"}.`,
      ...("default" in d ? { default: d.default } : {}),
      ...(typeof d.min === "number" ? { min: d.min } : {}), ...(typeof d.max === "number" ? { max: d.max } : {}),
      ...(Array.isArray(d.allowed) ? { values: d.allowed } : {}),
    });
    if (!("default" in d)) open.push({ key: `setting ${name}`, question: `The as-built record names the setting ${name} and not its default, its range or what it changes. What are they?` });
  }
  const env = [...list(record?.interfaces?.environment), ...list(record?.architecture?.settings)];
  for (const s of env) {
    const name = trim(typeof s === "string" ? s : s?.name);
    if (!name || has(name)) continue;
    out.push({ name, kind: s?.credential ? "credential" : "environment", set_by: "install", about: s?.credential ? `A credential the code reads from ${name}; the install places it and it is never written down.` : `A setting the code reads from ${name}.` });
  }
  for (const sys of systems) {
    if (!sys.address || sys.reach === "none") continue;
    const name = addressEnvOf(sys.name);
    if (has(name)) continue;
    out.push({ name, kind: "address", default: sys.address, set_by: "install", about: `Where ${sys.name} answers, its base address. The scripts read the address from this setting and carry none of their own.` });
  }
  return { settings: out, open };
}

/** The feature id each behavior takes: the id it was approved under (by its
 *  name), else F<n> for B<n> when that is free, else the next free one. */
function featureIds(behaviors, approved) {
  const ids = new Map();
  const used = new Set();
  for (const b of behaviors) { const a = approved.get(trim(b.name).toLowerCase()); if (a && !used.has(a.id)) { ids.set(b.id, a.id); used.add(a.id); } }
  for (const b of behaviors) {
    if (ids.has(b.id)) continue;
    const n = /^B([1-9]\d*)$/.exec(trim(b.id))?.[1];
    if (n && !used.has(`F${n}`)) { ids.set(b.id, `F${n}`); used.add(`F${n}`); }
  }
  let next = 1;
  for (const b of behaviors) {
    if (ids.has(b.id)) continue;
    while (used.has(`F${next}`)) next += 1;
    ids.set(b.id, `F${next}`); used.add(`F${next}`);
  }
  return ids;
}

const kindOfData = (record, name) => {
  const piece = baseName(name).replace(/\.[a-z0-9]+$/i, "");
  return list(record?.architecture?.formats).find((f) => trim(f?.piece) === piece && trim(f?.kind))?.kind ?? null;
};

/** One behavior as a feature, with its requirements. Acceptance is left
 *  empty: the model writes it, and code writes one only where it did not. */
export function featureOf(b, id, record, { offering = "", interfaces = [], outputsHere = [] } = {}) {
  const reqs = [];
  const add = (r) => reqs.push({ id: `${id}.R${reqs.length + 1}`, ...r });
  add({ shall: shallOf(b.does), kind: "behavior", priority: "must", source: sourceOf(b), verify: "test" });
  for (const q of list(b.quotes)) {
    if (typeof q?.text !== "string" || !q.text) continue;
    const pattern = isPatternQuote(q);
    add({
      shall: pattern ? `The agent shall recognize ${trim(q.what) || "this"} with exactly the pattern given.` : `The agent shall say ${trim(q.what) || "these words"} in exactly the words given.`,
      kind: pattern ? "pattern" : "wording", exact: [q.text], priority: "must", source: sourceOf(b, q.evidence), verify: "test",
    });
  }
  for (const r of list(b.rules)) {
    if (!trim(r?.rule)) continue;
    const values = ruleValues(r);
    add({ shall: shallOf(r.rule), kind: RULE_KIND[trim(r.kind)] ?? "behavior", ...(values.length ? { exact: values } : {}), priority: "must", source: sourceOf(b, r.evidence), verify: "test" });
  }
  for (const text of list(b.refusals)) {
    if (typeof text !== "string" || !trim(text)) continue;
    add({ shall: "The agent shall refuse in exactly the words given, and do nothing more.", kind: "refusal", exact: [text], priority: "must", source: sourceOf(b), verify: "test" });
  }
  for (const text of list(b.error_handling)) {
    if (typeof text !== "string" || !trim(text)) continue;
    add({ shall: shallOf(text), kind: "error", priority: "must", source: sourceOf(b), verify: "test" });
  }
  const fixed = () => reqs.flatMap((r) => list(r.exact));
  for (const c of list(b.constants)) {
    if (!trim(c?.name) || c.value === undefined || c.withheld || isAddress(c.value)) continue;
    const exported = constantsOf(record).find((x) => x.name === trim(c.name));
    const value = String(c.value);
    const named = exported?.imported;
    if (!named && fixed().includes(value)) continue;
    const kind = typeof c.value === "number" ? (/default/i.test(c.name) ? "default" : "limit") : "wording";
    add({ shall: `The agent shall hold ${trim(c.name)} at ${value}${named ? `, exported as ${trim(c.name)}` : ""}.`, kind, exact: named ? [trim(c.name), value] : [value], priority: "must", source: sourceOf(b, c.evidence), verify: "test" });
  }
  const { module, name } = anchorOf(b);
  for (const i of interfaces) {
    if (i.kind === "function" && name && i.module === module && i.name === name) {
      add({ shall: `The agent shall export ${i.signature} from ${module}.`, kind: "interface", exact: [i.name], priority: "must", source: sourceOf(b), verify: "test" });
    }
    if (i.kind === "command" && !name && i.name === module) {
      add({ shall: `The agent shall run ${module} as a command${list(i.flags).length ? `, reading the flags ${i.flags.join(", ")}` : ""}.`, kind: "interface", exact: [module, ...list(i.flags)], priority: "must", source: sourceOf(b), verify: "test" });
    }
  }
  const data = (w) => ({ name: trim(w), about: `As the as-built record names it (${b.id}).` });
  const inputs = list(b.inputs).filter((w) => typeof w === "string" && trim(w)).map(data);
  const outputs = [...list(b.outputs).filter((w) => typeof w === "string" && trim(w)).map(data), ...outputsHere];
  return {
    id, name: trim(b.name) || `behavior ${b.id}`, does: trim(b.does) || `What ${b.id} does, as the as-built record says.`,
    ...(trim(offering || b.offering) ? { offering: trim(offering || b.offering) } : {}),
    ...(inputs.length ? { inputs } : {}), ...(outputs.length ? { outputs } : {}),
    requirements: reqs, acceptance: [], as_built: b.id,
  };
}

/** The spec seeded from an as-built record: every feature, requirement,
 *  interface, system and setting code can carry, with the acceptance left for
 *  the model and an open question for each thing only the person can settle.
 *  `said` is the person's words (for the name, version, price, what they
 *  dropped and what they approved). Pure. */
export function seedSpec(record, { said = "", answers = null } = {}) {
  const words = [String(said ?? ""), ...Object.values(isObj(answers) ? answers : {}).filter((v) => typeof v === "string")];
  const person = personSettled(words);
  const left = leftOutIn(words.join("\n"));
  const approved = approvedIn(words.join("\n"));
  const behaviors = list(record.behaviors.behaviors).filter((b) => /^B[1-9]\d*$/.test(trim(b?.id)));
  const kept = behaviors.filter((b) => !left.has(b.id));
  const ids = featureIds(kept, approved);
  const interfaces = interfacesOf(record);
  // A file the code writes is an output of the first entry behavior of the
  // file that writes it ("Written by scripts/x.mjs").
  const writerOf = (i) => /Written by (\S+?\.(?:mjs|js|cjs))/.exec(i.about)?.[1] ?? null;
  const outputsOf = new Map();
  for (const i of interfaces.filter((x) => x.kind === "file")) {
    const file = writerOf(i);
    const b = kept.find((x) => anchorOf(x).module === file && trim(x.kind) === "entry") ?? kept.find((x) => anchorOf(x).module === file);
    if (!b) continue;
    const kind = kindOfData(record, i.name);
    outputsOf.set(b.id, [...(outputsOf.get(b.id) ?? []), { name: i.name, ...(kind ? { kind } : {}), ...(i.schema !== undefined ? { schema: i.schema } : {}), about: i.about }]);
  }
  const features = kept.map((b) => featureOf(b, ids.get(b.id), record, {
    offering: approved.get(trim(b.name).toLowerCase())?.offering ?? "", interfaces, outputsHere: outputsOf.get(b.id) ?? [],
  })).sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  const systems = systemsOf(record);
  const { settings, open: settingsOpen } = settingsOf(record, systems);

  // Constraints on the whole product: the runtime the code is written for,
  // and each exported constant that no behavior lists.
  const constraints = [];
  const modules = [...interfaces.map((i) => i.module ?? (i.kind === "command" ? i.name : "")), ...behaviors.map((b) => anchorOf(b).module)].filter(Boolean);
  if (modules.some((m) => /\.(?:mjs|cjs|js)$/.test(m))) {
    constraints.push({ shall: "The agent shall run on node, as the code the record describes does.", kind: "runtime", exact: ["node"], priority: "must", source: { said: "the as-built record's modules are JavaScript modules run by node" }, verify: "inspection" });
  }
  const listed = new Set(behaviors.flatMap((b) => list(b.constants).map((c) => trim(c?.name))));
  for (const c of constantsOf(record)) {
    if (!c.exported || listed.has(c.name) || isAddress(c.value) || (typeof c.value !== "string" && typeof c.value !== "number")) continue;
    constraints.push({ shall: `The agent shall hold ${c.name} at ${String(c.value)}${c.module ? `, as ${c.module} exports it` : ""}.`, kind: typeof c.value === "number" ? "limit" : "wording", exact: [c.name, String(c.value)], priority: "must", source: { said: `the as-built record's interfaces list the constant ${c.name}` }, verify: "test" });
  }
  // Every string a person reads and every pattern the code matches, by
  // code, byte for byte, in some requirement's exact.
  landStrings(record, { behaviors, features, constraints, left });
  constraints.forEach((c, i) => { c.id = `C${i + 1}`; });

  const open = [];
  if (!person.name) open.push({ key: "name", question: "What should this agent be called? It becomes its handle on the mesh and cannot be changed later without a redeploy." });
  if (!person.price) open.push({ key: "price", question: "What should this cost per job, or should it be free? Flat is the usual answer." });
  open.push(...settingsOpen);

  const repo = trim(record.behaviors.repository) || trim(record.record?.repository);
  const commit = trim(record.behaviors.commit) || trim(record.record?.commit);
  const gaps = list(record.tests?.gaps).filter((g) => isObj(g) && trim(g.about)).map((g) => ({ id: trim(g.id), kind: trim(g.kind), about: trim(g.about) }));
  return {
    format: SPEC_FORMAT,
    product: { name: person.name ?? STAND_IN_NAME, version: person.version ?? FIRST_VERSION, kind: "agent" },
    purpose: `The agent the as-built record of ${repo || "code kept elsewhere"}${commit ? ` at ${commit.slice(0, 12)}` : ""} describes, built again so that it does what that code does: ${features.map((f) => f.name).join("; ")}.`,
    source: { kind: "as-built-record", ...(repo ? { repository: repo } : {}), ...(commit ? { commit } : {}) },
    features,
    interfaces: interfaces.map(({ as_built, ...i }) => i),
    constraints,
    systems,
    settings,
    ...(person.price ? { price: person.price } : {}),
    open,
    ...(left.size ? { left_out: [...left].map(([behavior, why]) => ({ behavior, why, name: trim(behaviors.find((b) => b.id === behavior)?.name) })) } : {}),
    ...(gaps.length ? { record_gaps: gaps } : {}),
  };
}

/** What the record fixes that the spec must carry byte for byte, for every
 *  behavior the spec keeps as a feature: each quote, refusal and rule value
 *  (in some requirement's exact), and each interface (its name in the spec's
 *  interfaces). Each as { what, value, where }. */
export function recordFixes(record, spec) {
  const out = [];
  const keptBehaviors = new Set(list(spec?.features).map((f) => trim(f.as_built)).filter(Boolean));
  for (const b of list(record?.behaviors?.behaviors)) {
    if (!keptBehaviors.has(trim(b?.id))) continue;
    for (const q of list(b.quotes)) if (typeof q?.text === "string" && q.text) out.push({ what: `the quote ${trim(q.what) || ""}`.trim(), value: q.text, where: "exact", behavior: b.id });
    for (const t of list(b.refusals)) if (typeof t === "string" && trim(t)) out.push({ what: "the refusal", value: t, where: "exact", behavior: b.id });
    for (const r of list(b.rules)) for (const v of ruleValues(r)) out.push({ what: `the ${trim(r.kind)} rule "${trim(r.rule)}"`, value: v, where: "exact", behavior: b.id });
  }
  const leftOut = new Set(list(spec?.left_out).map((x) => trim(x?.interface)).filter(Boolean));
  for (const i of interfacesOf(record)) {
    if (leftOut.has(i.as_built)) continue;
    out.push({ what: `the ${i.kind} interface ${i.as_built}`, value: i.name, where: "interfaces", interface: i });
  }
  // Every string of the inventory, unless it belongs to a behavior the spec
  // does not keep.
  const behaviors = list(record?.behaviors?.behaviors);
  for (const s of stringsOf(record)) {
    const found = behaviorOfString(s, behaviors);
    if (found && !keptBehaviors.has(trim(found.behavior.id))) continue;
    out.push({ what: `the ${s.kind} at ${s.file}${s.line != null ? `:${s.line}` : ""}`, value: s.text, where: "exact", behavior: found ? trim(found.behavior.id) : "no behavior", string: s });
  }
  return out;
}
