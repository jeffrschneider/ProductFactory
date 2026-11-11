// What the given names, and whether the draft keeps it.
//
// The given is what the person sent: their words, what they attached and
// their answers. It may be notes, or an as-built record the reverse engineer
// wrote from code, in its JSON parts or rendered as words ("Setting: count.",
// "Reaches: https://...: why"). Whatever it names exactly, the draft carries
// exactly; what it does not say, the draft asks rather than invents.
//
// On 2026-11-09 a rebuild of hn-reader from its as-built record went wrong
// here first. The draft put the count setting inside the job, where the files
// drop it; declared no runtime, though every job ran node; and invented an
// output shape, `{stories, read}`, that the record never stated, which the
// test writer and the code writer then built. Each of those is read here by
// rule, with no model:
//
//   - settings: each setting the given names is declared in the draft, as a
//     run-config setting (the spec's own run_config, never a job's) or as a
//     system setting's variable;
//   - runtimes: a runtime the given names (node, and its version when given)
//     is declared, and so is node when a job's command runs it;
//   - price: a price the given states is the draft's price;
//   - reaches: each address the given says the code reaches is the default
//     of an address setting, and a destination it names without an address
//     (any page a story links to) is covered by a service that fetches what
//     it is handed (scripts/reaches.mjs says why);
//   - shapes: a JSON Schema the given carries is carried into the draft, its
//     properties and its constant values word for word; and an output whose
//     shape the given does not state is asked about, never sketched;
//   - exact words: each string the given quotes, in backticks or quotation
//     marks, appears in the draft as it was written, and so does each
//     exported function it names, because tests import it by that name.
//
//   needs: node >= 22. Nothing here reads or writes a file.
//   import { givenOf, givenProblems, fitToGiven } from "./given.mjs"
import { addressSettingsOf, fetchesHanded, sameAddress } from "./reaches.mjs";

const trim = (s) => String(s ?? "").trim();
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);
const URL_RE = /\bhttps?:\/\/[A-Za-z0-9[][^\s"'`<>)\]]*/gi;
const IDENT = /^[A-Za-z_][\w-]*$/;
/** The four settings the install places for a model system (Common Agent
 *  12.4.1): a model system declares none of them, so naming one is no
 *  setting for the draft to keep. */
const MODEL_SETTINGS = new Set(["MODEL_NAME", "MODEL_ENDPOINT", "MODEL_KEY", "MODEL_PROTOCOL"]);
const STOP = new Set(["that", "which", "is", "it", "the", "a", "an", "to", "for", "of", "they", "its", "and", "or", "in", "on", "from", "with", "by", "as", "be", "was", "this", "these", "those"]);

/** The given, as pieces of text with where each came from: the request, each
 *  attachment read as text (and parsed, when it is JSON), and the answers. */
export function givenTexts(asked = null, answers = null) {
  const out = [];
  if (trim(asked?.said)) out.push({ from: "the request", text: String(asked.said), kind: "words" });
  for (const a of list(asked?.attached)) {
    if (a?.missing || typeof a?.text !== "string" || !trim(a.text)) continue;
    let json;
    if (/\.json$/i.test(String(a.name ?? "")) || /json/i.test(String(a.media_type ?? "")) || /^\s*[[{]/.test(a.text)) {
      try { json = JSON.parse(a.text); } catch { json = undefined; }
    }
    out.push({ from: String(a.name ?? "an attachment"), text: a.text, kind: a.kind ?? "", ...(json !== undefined ? { json } : {}) });
  }
  if (isObj(answers)) {
    for (const [k, v] of Object.entries(answers)) if (typeof v === "string" && trim(v)) out.push({ from: `your answer (${k})`, text: v, kind: "words" });
  }
  return out;
}

/** The lines under a Markdown heading, up to the next heading of any level. */
function section(text, heading) {
  const lines = String(text).split(/\r?\n/);
  const at = lines.findIndex((l) => new RegExp(`^#{1,6}\\s+${heading}\\s*$`, "i").test(l.trim()));
  if (at < 0) return [];
  const out = [];
  for (const l of lines.slice(at + 1)) { if (/^#{1,6}\s/.test(l.trim())) break; out.push(l); }
  return out;
}

const asBuilt = (doc) => isObj(doc) && /^as-built-/.test(trim(doc.format));
const isAsBuiltArchitecture = (doc) => isObj(doc) && doc.as_built === true && trim(doc.record) === "architecture-record-v1";
const isSchema = (doc) => isObj(doc) && (/json-schema/i.test(String(doc.$schema ?? "")) || (doc.type === "object" && isObj(doc.properties)));

/** Every setting the given names, by name. */
export function settingsNamed(texts) {
  const out = new Map();
  const add = (name, from) => { const n = trim(name).replace(/^`|`$/g, "").replace(/[.,;:]+$/, ""); if (IDENT.test(n) && !STOP.has(n.toLowerCase()) && !MODEL_SETTINGS.has(n) && !out.has(n)) out.set(n, from); };
  for (const t of texts) {
    const d = t.json;
    if (isObj(d)) {
      for (const s of list(d.run_config?.settings)) add(s?.name, t.from);
      for (const sys of list(d.systems)) for (const st of list(sys?.settings)) add(st?.env, t.from);
      if (isAsBuiltArchitecture(d)) for (const s of list(d.settings)) if (s?.credential !== true) add(typeof s === "string" ? s : s?.name, t.from);
      continue;
    }
    if (d !== undefined) continue;
    const text = t.text;
    for (const m of text.matchAll(/^\s*(?:[-*]\s*)?Settings?\s*:\s*(.+)$/gim)) {
      for (const part of m[1].split(/,|;|\band\b/)) {
        const lead = /^\s*`?([A-Za-z_][\w-]*)`?/.exec(part);
        if (lead) add(lead[1], t.from);
      }
    }
    for (const l of section(text, "Settings")) { const m = /^\s*[-*]\s*`([A-Za-z_][\w-]*)`/.exec(l); if (m) add(m[1], t.from); }
    for (const m of text.matchAll(/\bsettings?\s+`([A-Za-z_][\w-]*)`/gi)) add(m[1], t.from);
    for (const m of text.matchAll(/\brun[- ]config\s+settings?\s+([A-Za-z_][\w-]*)/gi)) add(m[1], t.from);
    for (const m of text.matchAll(/\bsettings?\s+([A-Z][A-Z0-9]*_[A-Z0-9_]+)\b/g)) add(m[1], t.from);
  }
  return [...out].map(([name, from]) => ({ name, from }));
}

/** The runtimes the given names: node, with the version when it says one. */
export function runtimesNamed(texts) {
  const out = new Map();
  const add = (name, version, from) => {
    const n = trim(name).toLowerCase();
    if (!n) return;
    const was = out.get(n);
    if (!was) out.set(n, { name: n, version: version || null, from });
    else if (!was.version && version) out.set(n, { ...was, version });
  };
  for (const t of texts) {
    const d = t.json;
    if (isObj(d)) { for (const r of list(d.runtimes)) if (trim(r?.name)) add(r.name, trim(r.version), t.from); continue; }
    if (d !== undefined) continue;
    for (const m of t.text.matchAll(/\bnode(?:\.?js)?\s*(?:version\s*)?(?:>=?\s*|v)?(\d{2,})\b/gi)) add("node", `>=${m[1]}`, t.from);
    if (/\bnode\.?js\b|`node`|\b(?:by|on|with|under|needs|requires|using)\s+node\b(?![-_])/i.test(t.text)) add("node", null, t.from);
  }
  return [...out.values()];
}

/** The price the given states, or null: free, or a flat amount. */
export function priceNamed(texts) {
  for (const t of texts) {
    const d = t.json;
    if (isObj(d)) {
      const p = isObj(d.price?.price) ? d.price.price : d.price;
      if (isObj(p) && trim(p.model)) return { ...p, from: t.from };
      continue;
    }
    if (d !== undefined) continue;
    const text = t.text;
    const lead = String.raw`\bprice[ds]?\b\s*(?:is|:|=|-|of)?\s*(?:a\s+)?(?:flat\s+)?(?:of\s+)?`;
    if (new RegExp(`${lead}free\\b`, "i").test(text)) return { model: "free", from: t.from };
    const micro = new RegExp(`${lead}([\\d][\\d,]*)\\s*micro[- ]?(?:usd|dollars)`, "i").exec(text);
    if (micro) return { model: "flat", amount_micro: Number(micro[1].replace(/,/g, "")), currency: "USD", from: t.from };
    const usd = new RegExp(`${lead}(?:US)?\\$\\s*(\\d+(?:\\.\\d+)?)`, "i").exec(text);
    if (usd) return { model: "flat", amount_micro: Math.round(Number(usd[1]) * 1e6), currency: "USD", from: t.from };
  }
  return null;
}

/** What the given says the code reaches: each address, and each destination
 *  named without one (handed to it at run time). */
export function reachesNamed(texts) {
  const addresses = new Map();
  const handed = [];
  const destination = (dest, from) => {
    const urls = String(dest).match(URL_RE) ?? [];
    if (urls.length) for (const u of urls) { const a = sameAddress(u.replace(/[.,;:]+$/, "")); if (!addresses.has(a)) addresses.set(a, from); }
    else if (trim(dest)) handed.push({ what: trim(dest), from });
  };
  for (const t of texts) {
    const d = t.json;
    if (isObj(d)) { if (isAsBuiltArchitecture(d)) for (const e of list(d.egress)) destination(typeof e === "string" ? e : e?.destination ?? "", t.from); continue; }
    if (d !== undefined) continue;
    for (const m of t.text.matchAll(/^\s*(?:[-*]\s*)?Reaches\s*:\s*(.+)$/gim)) {
      // "Reaches: <destination>: <why>". An address carries its own colon, so
      // the destination is the address when there is one, else the words
      // before the first colon.
      const urls = m[1].match(URL_RE);
      destination(urls ? urls.join(" ") : m[1].split(":")[0], t.from);
    }
    for (const l of section(t.text, "Egress")) for (const u of l.match(URL_RE) ?? []) destination(u, t.from);
  }
  return { addresses: [...addresses].map(([address, from]) => ({ address, from })), handed };
}

/** Member names in a sketch such as `{stories, read}` or `{a: x, b}`. */
export const sketchMembers = (inner) => String(inner).split(",").map((p) => /^\s*["']?([A-Za-z_$][\w$-]*)/.exec(p)?.[1]).filter(Boolean);

function keysOf(v, into) {
  if (Array.isArray(v)) for (const x of v) keysOf(x, into);
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) { into.add(k); keysOf(x, into); }
  return into;
}

function schemaEntry(doc, from) {
  const members = new Set();
  const consts = new Set();
  const walk = (s) => {
    if (Array.isArray(s)) { s.forEach(walk); return; }
    if (!isObj(s)) return;
    if (isObj(s.properties)) for (const k of Object.keys(s.properties)) members.add(k);
    if (typeof s.const === "string") consts.add(s.const);
    for (const e of list(s.enum)) if (typeof e === "string") consts.add(e);
    for (const v of Object.values(s)) if (typeof v === "object") walk(v);
  };
  walk(doc);
  const top = isObj(doc.properties) ? Object.keys(doc.properties) : [];
  const required = list(doc.required).filter((r) => typeof r === "string");
  return { name: trim(doc.title) || trim(doc.$id) || from, from, members, consts, top: required.length ? required : top };
}

/** The shapes the given states: every member name it gives an output (from a
 *  JSON Schema, a sketch in backticks, a JSON block, or an example file), and
 *  each JSON Schema whole. */
export function shapesNamed(texts) {
  const members = new Set();
  const schemas = [];
  const take = (doc, from) => {
    if (isSchema(doc)) { const s = schemaEntry(doc, from); schemas.push(s); for (const m of s.members) members.add(m); return; }
    const comps = doc?.components?.schemas;
    if (isObj(doc) && trim(doc.openapi) && isObj(comps)) { for (const [k, s] of Object.entries(comps)) if (isObj(s)) { const e = schemaEntry(s, `${from} ${k}`); schemas.push(e); for (const m of e.members) members.add(m); } return; }
    keysOf(doc, members);
  };
  for (const t of texts) {
    const d = t.json;
    if (d !== undefined) {
      // An example or a schema says a shape; a spec, an agent's own file, an
      // architecture record or an as-built part says other things, and its
      // own member names are not the shape of anything the agent writes.
      if (isSchema(d) || isObj(d?.components) || (t.kind === "data" && !asBuilt(d) && !isAsBuiltArchitecture(d) && !trim(d?.format))) take(d, t.from);
      continue;
    }
    for (const m of t.text.matchAll(/`\{([^`]*)\}`/g)) for (const k of sketchMembers(m[1])) members.add(k);
    for (const m of t.text.matchAll(/```json[ \t]*\r?\n([\s\S]*?)```/g)) { try { take(JSON.parse(m[1]), t.from); } catch { /* not JSON, not a shape */ } }
  }
  return { members, schemas };
}

/** Strings the given quotes exactly, from words (never from JSON's own
 *  quoting): in backticks, in double or curly quotes, or in single quotes
 *  that open after a space and close before one. A sketch is a shape, an
 *  address is a reach, and each is read by its own rule. */
export function exactNamed(texts) {
  const out = new Map();
  const add = (s, from) => {
    const v = String(s).replace(/\s+/g, " ").trim();
    if (v.length < 2 || v.length > 200 || /^\{.*\}$/.test(v) || /^https?:\/\/\S+$/i.test(v)) return;
    if (!out.has(v)) out.set(v, from);
  };
  const scan = (text, from) => {
    for (const m of text.matchAll(/`([^`\n]{2,200})`/g)) add(m[1], from);
    // Quoted words: a quoted single identifier is how JSON looks, so a quote
    // counts when it holds more than one word or a pattern's characters.
    const quoted = (q) => (/[\s\\^$*+?()[\]|]/.test(q) ? add(q, from) : null);
    for (const m of text.matchAll(/"([^"\n]{3,200})"/g)) quoted(m[1]);
    for (const m of text.matchAll(/“([^”\n]{3,200})”/g)) quoted(m[1]);
    for (const m of text.matchAll(/(?:^|[\s(\[])'([^'\n]{3,200})'(?=$|[\s.,;:)\]])/gm)) quoted(m[1]);
  };
  for (const t of texts) {
    const d = t.json;
    // An architecture record's words are held to it by their own rules (its
    // systems, its settings, its standing assets), and a spec or the agent's
    // own files sent back are the draft itself.
    if (d === undefined) { if (!["a spec", "an agent's own file", "an architecture record"].includes(t.kind)) scan(t.text, t.from); continue; }
    // The as-built record's words about behaviors and interfaces, string by
    // string: what the code says, quoted, is said there.
    if (asBuilt(d)) {
      const strings = [];
      const walk = (v) => { if (typeof v === "string") strings.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (isObj(v)) Object.values(v).forEach(walk); };
      walk(d.behaviors ?? d.interfaces ?? []);
      for (const s of strings) scan(s, t.from);
    }
  }
  return [...out].map(([text, from]) => ({ text, from }));
}

/** The exported functions the given names: an interface of kind function,
 *  or the words "export(ed) function x". */
export function functionsNamed(texts) {
  const out = new Map();
  const add = (n, from) => { const v = trim(n).replace(/\(\)$/, ""); if (/^[A-Za-z_$][\w$]*$/.test(v) && !out.has(v)) out.set(v, from); };
  for (const t of texts) {
    const d = t.json;
    if (isObj(d)) { if (asBuilt(d)) for (const i of list(d.interfaces)) if (trim(i?.kind) === "function") add(i.name, t.from); continue; }
    if (d !== undefined) continue;
    for (const m of t.text.matchAll(/\bI\d+\s+function\s+`?([A-Za-z_$][\w$]*)/g)) add(m[1], t.from);
    for (const m of t.text.matchAll(/\bexport(?:s|ed)?\s+(?:async\s+)?function\s+`?([A-Za-z_$][\w$]*)/gi)) add(m[1], t.from);
  }
  return [...out].map(([name, from]) => ({ name, from }));
}

/** The script modules the given names: in an as-built record's interfaces,
 *  each function's module and each command under scripts/. A rebuild writes
 *  these files, so a job that runs scripts names them. */
export function modulesNamed(texts) {
  const out = new Map();
  const add = (f, from) => { const v = trim(f).replace(/^\.\//, ""); if (/^scripts\/[\w./-]+\.(?:mjs|js|cjs)$/.test(v) && !v.split("/").includes("..") && !out.has(v)) out.set(v, from); };
  for (const t of texts) {
    const d = t.json;
    if (!isObj(d) || !asBuilt(d)) continue;
    for (const i of list(d.interfaces)) {
      const k = trim(i?.kind);
      if (k === "function") add(i.module ?? list(i.evidence)[0]?.file, t.from);
      else if (k === "command") add(i.command ?? i.name, t.from);
    }
  }
  return [...out].map(([file, from]) => ({ file, from }));
}

const BARE_SCRIPT = /^(?:\.\/)?scripts\/[\w./-]+\.(?:mjs|js|cjs)$/;

/** A word of a command as the script it names, scripts/<file>: a bare
 *  scripts/... path, or the packaged {home}/{package}/skills/<job>/scripts/...
 *  form; null for any other word. */
export function scriptOfWord(w) {
  const v = trim(w).replace(/^\.\//, "").replace(/^\{home\}\/\{package\}\/skills\/[^/]+\//, "");
  return /^scripts\/[\w./-]+\.(?:mjs|js|cjs)$/.test(v) && !v.split("/").includes("..") ? v : null;
}

/** The scripts a job's command runs, each as scripts/<file>. */
export function commandScripts(job) {
  return list(job?.run?.command).map(scriptOfWord).filter(Boolean);
}

/** The draft with every bare scripts/... path in a job's command written in
 *  the packaged form the host runs, {home}/{package}/skills/<job>/scripts/...:
 *  the host starts a command from its own home folder, so a bare path finds
 *  nothing. Returns { spec, note }. */
export function fitCommands(spec) {
  if (!isObj(spec)) return { spec, note: "" };
  const said = [];
  const jobs = jobsOf(spec).map((j) => {
    const cmd = list(j?.run?.command);
    const slug = trim(j?.slug);
    if (!cmd.length || !slug) return j;
    const fixed = cmd.map((w) => (BARE_SCRIPT.test(trim(w)) ? `{home}/{package}/skills/${slug}/${trim(w).replace(/^\.\//, "")}` : w));
    const changed = fixed.filter((w, i) => w !== cmd[i]);
    if (!changed.length) return j;
    said.push(`The job ${slug}'s command named its script as a bare path; it now names ${changed.join(", ")}, the form the host runs.`);
    return { ...j, run: { ...j.run, command: fixed } };
  });
  return said.length ? { spec: { ...spec, jobs }, note: said.join(" ") } : { spec, note: "" };
}

const runsScripts = (j) => trim(j?.how?.control) === "script" || commandScripts(j).length > 0;

/** The pieces an earlier spec or the agent's own descriptor already declared,
 *  as "outputs:<name>": a revision keeps their shape as it was given. */
function earlierOutputs(texts) {
  const out = new Set();
  const add = (job) => { for (const e of list(job?.outputs)) if (trim(e?.name)) out.add(trim(e.name)); };
  for (const t of texts) {
    const d = t.json;
    if (!isObj(d)) continue;
    for (const j of list(d.jobs)) add(j);
    for (const o of list(d.offerings)) { add(o); for (const s of list(o?.steps)) add(s); }
  }
  return out;
}

/** Everything the given names, read once. */
export function givenOf(asked = null, answers = null) {
  const texts = givenTexts(asked, answers);
  return {
    settings: settingsNamed(texts),
    runtimes: runtimesNamed(texts),
    price: priceNamed(texts),
    reaches: reachesNamed(texts),
    shapes: shapesNamed(texts),
    exact: exactNamed(texts),
    functions: functionsNamed(texts),
    modules: modulesNamed(texts),
    earlier_outputs: earlierOutputs(texts),
  };
}

/** What the spec (spec-v1) names, read the way givenOf reads what a person
 *  sent, for the Design: from 0.9.0 the agent's own files are made from the
 *  approved spec, so the spec is their given and the raw request is not.
 *
 *  - settings: each setting the spec lists;
 *  - runtimes: each constraint of kind runtime (node, and a version such as
 *    >=22 when its exact gives one);
 *  - price: the spec's price, in its words;
 *  - reaches: each system the spec reaches at an address (its address is the
 *    default of an address setting), and each it reaches with no address (a
 *    service that fetches what it is handed). A system of reach none is
 *    written down and never reached, so it is no reach;
 *  - shapes: the JSON Schema of each output and each file interface, with
 *    every constant that is an address left out of what the files must
 *    carry: an address in a descriptor is refused at Package, and the spec
 *    is where it is kept (the round trip of 2026-11-09 stopped there);
 *  - modules: each function interface's module and each command under
 *    scripts/, so a job names its scripts. The functions themselves are the
 *    spec's interfaces, which Test and Code read, so the files are not held
 *    to naming each one;
 *  - exact: none. The words and patterns the spec fixes are the spec's, and
 *    Test and Code read them there.
 *  `asked` is what the Design was handed (the spec and any earlier files), for
 *  the outputs an earlier draft already declared. */
export function givenOfSpec(spec, asked = null, answers = null) {
  const from = "the spec";
  const settings = list(spec?.settings).filter((s) => trim(s?.name)).map((s) => ({ name: trim(s.name), from }));
  const runtimes = [];
  for (const c of list(spec?.constraints)) {
    if (trim(c?.kind) !== "runtime") continue;
    const words = [trim(c.shall), ...list(c.exact).map(String)].join(" ");
    if (/\bnode\b/i.test(words)) {
      const v = /(>=?\s*\d+(?:\.\d+)*)/.exec(list(c.exact).join(" "))?.[1]?.replace(/\s+/g, "") ?? null;
      if (!runtimes.some((r) => r.name === "node")) runtimes.push({ name: "node", version: v, from });
    }
  }
  const price = trim(spec?.price) ? priceNamed([{ from, text: `price: ${trim(spec.price)}` }]) : null;
  const addresses = [];
  const handed = [];
  for (const s of list(spec?.systems)) {
    const reach = trim(s?.reach);
    if (!reach || reach === "none") continue;
    if (trim(s.address)) addresses.push({ address: sameAddress(trim(s.address)), from });
    else handed.push({ what: trim(s.name), from });
  }
  const members = new Set();
  const schemas = [];
  const takeSchema = (doc, name) => {
    if (!isObj(doc)) return;
    const e = schemaEntry(doc, name);
    e.name = name;
    for (const c of [...e.consts]) if (/^[a-z][a-z0-9+.-]*:\/\//i.test(c)) e.consts.delete(c);
    schemas.push(e);
    for (const m of e.members) members.add(m);
  };
  for (const f of list(spec?.features)) for (const o of list(f?.outputs)) if (o?.schema !== undefined) takeSchema(o.schema, trim(o.name));
  for (const i of list(spec?.interfaces)) if (trim(i?.kind) === "file" && i?.schema !== undefined && !schemas.some((s) => s.name === trim(i.name))) takeSchema(i.schema, trim(i.name));
  // The functions the spec keeps are its interfaces, by name and module, and
  // Test and Code read them there; the files are not asked to repeat them.
  const functions = [];
  const modules = [];
  const addModule = (f) => { const v = trim(f).replace(/^\.\//, ""); if (/^scripts\/[\w./-]+\.(?:mjs|js|cjs)$/.test(v) && !v.split("/").includes("..") && !modules.some((m) => m.file === v)) modules.push({ file: v, from }); };
  for (const i of list(spec?.interfaces)) { if (trim(i?.kind) === "function") addModule(i.module); else if (trim(i?.kind) === "command") addModule(i.name); }
  return {
    settings, runtimes, price,
    reaches: { addresses, handed },
    shapes: { members, schemas },
    exact: [],
    functions, modules,
    earlier_outputs: earlierOutputs(givenTexts(asked, answers)),
  };
}

/** Every string in a value, joined, whitespace collapsed: what the draft says. */
function saidIn(v) {
  const out = [];
  const walk = (x) => { if (typeof x === "string") out.push(x); else if (Array.isArray(x)) x.forEach(walk); else if (isObj(x)) Object.values(x).forEach(walk); };
  walk(v);
  return out.join("\n").replace(/[ \t]+/g, " ");
}

const jobsOf = (spec) => list(spec?.jobs);
const isJsonKind = (k) => typeof k === "string" && (/\+json\b/i.test(k) || k.split(";")[0].trim().toLowerCase() === "application/json");
const kindStem = (k) => /\/(?:vnd\.[a-z0-9-]+\.)?([a-z0-9.-]+)\+json/i.exec(String(k ?? ""))?.[1]?.toLowerCase() ?? "";

/** The sketch in an output's about, as member names: the first `{...}`. */
export function sketchOf(about) {
  const m = /`\{([^`]*)\}`/.exec(String(about ?? "")) ?? /\{([^{}]*)\}/.exec(String(about ?? ""));
  return m ? sketchMembers(m[1]) : [];
}

/** The JSON outputs whose shape the given does not state, each with the
 *  members its about sketches anyway (a guess) and the blank to ask. */
export function unstatedShapes(spec, given) {
  const out = [];
  if (!given) return out;
  for (const j of jobsOf(spec)) {
    for (const o of list(j?.outputs)) {
      const name = trim(o?.name);
      if (!name || !isJsonKind(o?.kind) || given.earlier_outputs?.has(name)) continue;
      const stem = kindStem(o.kind);
      const bySchema = given.shapes.schemas.some((s) => { const n = `${s.name} ${s.from}`.toLowerCase(); return n.includes(name.toLowerCase()) || (stem && n.includes(stem)); });
      const sketch = sketchOf(o.about);
      const invented = sketch.filter((m) => !given.shapes.members.has(m));
      if (bySchema && !invented.length) continue;
      if (sketch.length && !invented.length) continue;
      out.push({ job: trim(j.slug), output: name, sketch, invented, key: `shape of ${name}` });
    }
  }
  return out;
}

const blankFor = (u) => ({
  key: u.key,
  question: `What does ${u.output} hold? What was given does not say its shape${u.sketch.length ? `, so the draft's sketch \`{${u.sketch.join(", ")}}\` is a guess` : ""}: name its members, or attach a JSON Schema or an example of it.`,
});

/** What the draft does not keep of what the given names, as sentences a
 *  model can act on. Empty when it keeps all of it. */
export function givenProblems(spec, given = null) {
  if (!given || !isObj(spec)) return [];
  const out = [];
  const said = saidIn(spec);

  // Settings: the spec's own run_config, or a system setting's variable.
  const declared = new Set([
    ...list(spec.run_config?.settings).map((s) => trim(s?.name)),
    ...list(spec.systems).flatMap((s) => list(s?.settings).map((st) => trim(st?.env))),
  ].filter(Boolean));
  for (const s of given.settings) {
    if (declared.has(s.name)) continue;
    const inJob = jobsOf(spec).find((j) => list(j?.run_config?.settings).some((x) => trim(x?.name) === s.name));
    out.push(inJob
      ? `the setting ${s.name} (named in ${s.from}) sits in job ${trim(inJob.slug)}'s run_config, and run_config is the spec's own member: the files drop one inside a job, so move it to the spec's run_config`
      : `${s.from} names the setting ${s.name}, and the draft does not declare it; keep it, in the spec's run_config with its default and range, or as a system setting's variable`);
  }

  // Runtimes: what the given names, and node wherever a job's command runs it.
  const runtimes = list(spec.runtimes);
  const has = (n) => runtimes.find((r) => trim(r?.name).toLowerCase() === n);
  const wanted = [...given.runtimes];
  if (!wanted.some((r) => r.name === "node") && jobsOf(spec).some((j) => trim(list(j?.run?.command)[0]).toLowerCase() === "node")) wanted.push({ name: "node", version: null, from: "a job's command" });
  for (const r of wanted) {
    const got = has(r.name);
    if (!got) out.push(`${r.from} names the runtime ${r.name}${r.version ? ` ${r.version}` : ""}, and the draft declares no runtimes for it; without one the install file says the agent needs nothing`);
    else if (r.version && !String(got.version ?? "").includes(r.version.replace(/^>=/, ""))) out.push(`${r.from} names ${r.name} ${r.version}, and the draft declares ${r.name} ${trim(got.version) || "with no version"}`);
  }

  // Price: the given's price is the draft's.
  const p = given.price;
  if (p) {
    const got = spec.price;
    if (!isObj(got)) out.push(`${p.from} states the price (${p.model}${p.amount_micro != null ? `, ${p.amount_micro} micro USD` : ""}), and the draft has none; a price the person stated is theirs, so keep it`);
    else if (trim(got.model) !== trim(p.model) || (p.amount_micro != null && got.amount_micro !== p.amount_micro)) out.push(`${p.from} states the price as ${p.model}${p.amount_micro != null ? ` ${p.amount_micro} micro USD` : ""}, and the draft says ${trim(got.model)}${got.amount_micro != null ? ` ${got.amount_micro} micro USD` : ""}`);
  }

  // Reaches: each address is an address setting's default; each destination
  // handed at run time is covered by a service that fetches what it is handed.
  const defaults = new Set(addressSettingsOf(spec).filter((a) => typeof a.default === "string").map((a) => sameAddress(a.default)));
  for (const r of given.reaches.addresses) {
    if (!defaults.has(r.address)) out.push(`${r.from} says the code reaches ${r.address}, and no address setting in the draft has it as its default; declare the system that reaches it with a setting named for the address and this as its default`);
  }
  if (given.reaches.handed.length && !list(spec.systems).some((s) => trim(s?.kind) === "service" && fetchesHanded(s))) {
    out.push(`${given.reaches.handed[0].from} says the code reaches ${given.reaches.handed.map((h) => `"${h.what}"`).join(" and ")}, and no service in the draft says it fetches what it is handed; say so in that service's needs, with the word fetches, so the security reviewer can match the call`);
  }

  // Shapes: a schema's properties and constants are carried word for word;
  // a sketch the given does not state is a guess, asked instead.
  for (const s of given.shapes.schemas) {
    const missing = [...s.top, ...s.consts].filter((w) => !said.includes(w));
    if (missing.length) out.push(`${s.from} gives the JSON Schema ${s.name}, and the draft does not carry ${missing.map((w) => `"${w}"`).join(", ")}; carry the shape exactly, in the output's about and the job's instructions`);
  }
  for (const u of unstatedShapes(spec, given)) {
    if (u.invented.length) out.push(`job ${u.job}: output ${u.output} sketches \`{${u.sketch.join(", ")}}\`, and nothing given states ${u.invented.join(", ")}; a shape that was not given is asked, not invented: take the sketch out and put "${u.key}" in blanks with the question`);
  }

  // Exact words and functions.
  const flat = said.replace(/\s+/g, " ");
  const missingWords = given.exact.filter((e) => !flat.includes(e.text));
  if (missingWords.length) out.push(`what was given quotes these exactly, and the draft does not carry them as written: ${missingWords.map((e) => JSON.stringify(e.text)).join(", ")}; put each in the job's instructions word for word`);
  const missingFns = given.functions.filter((f) => !said.includes(f.name));
  if (missingFns.length) out.push(`what was given names the exported function${missingFns.length === 1 ? "" : "s"} ${missingFns.map((f) => f.name).join(", ")}, which the draft does not; tests import ${missingFns.length === 1 ? "it" : "them"} by that name, so name ${missingFns.length === 1 ? "it" : "each"} in the job's instructions`);
  return out;
}

/** The draft fitted to the given after the last go, where code can do it
 *  without guessing: a job's run_config moved to the spec when the spec has
 *  none, a runtime the given names added, the price the given states put in,
 *  and a blank added for every output whose shape was not given. Returns the
 *  spec, the blanks to add and a note saying what changed. */
export function fitToGiven(spec, given = null) {
  if (!given || !isObj(spec)) return { spec, blanks: [], note: "" };
  let s = spec;
  const said = [];
  const nested = jobsOf(s).filter((j) => isObj(j?.run_config));
  if (nested.length && !isObj(s.run_config)) {
    const settings = nested.flatMap((j) => list(j.run_config.settings));
    s = { ...s, run_config: { ...nested[0].run_config, settings }, jobs: jobsOf(s).map((j) => { if (!isObj(j?.run_config)) return j; const { run_config, ...rest } = j; return rest; }) };
    said.push(`The run-config settings drafted inside ${nested.map((j) => trim(j.slug)).join(" and ")} were moved to the spec's own run_config, where the files read them.`);
  }
  const wanted = [...given.runtimes];
  if (!wanted.some((r) => r.name === "node") && jobsOf(s).some((j) => trim(list(j?.run?.command)[0]).toLowerCase() === "node")) wanted.push({ name: "node", version: null });
  const runtimes = [...list(s.runtimes)];
  for (const r of wanted) {
    if (runtimes.some((x) => trim(x?.name).toLowerCase() === r.name)) continue;
    runtimes.push({ name: r.name, ...(r.version ? { version: r.version } : {}) });
    said.push(`The runtime ${r.name}${r.version ? ` ${r.version}` : ""} was added, as ${r.from ?? "a job's command"} names it.`);
  }
  if (runtimes.length !== list(s.runtimes).length) s = { ...s, runtimes };
  // A job that runs scripts names them: its command's scripts, and when it is
  // the only such job, every module the given's as-built record lists.
  const scriptJobs = jobsOf(s).filter((j) => runsScripts(j) && !list(j?.scripts).length);
  if (scriptJobs.length) {
    const lone = jobsOf(s).filter(runsScripts).length === 1;
    s = { ...s, jobs: jobsOf(s).map((j) => {
      if (!scriptJobs.includes(j)) return j;
      const files = [...new Set([...commandScripts(j), ...(lone ? list(given.modules).map((m) => m.file) : [])])];
      if (!files.length) return j;
      said.push(`The job ${trim(j.slug)} runs scripts and named none, so it now names ${files.join(", ")}${lone && list(given.modules).length ? ", from its command and the modules the as-built record lists" : ", from its command"}.`);
      return { ...j, scripts: files };
    }) };
  }
  if (given.price && !isObj(s.price)) {
    const { from, ...price } = given.price;
    s = { ...s, price };
    said.push(`The price was set to ${price.model}${price.amount_micro != null ? ` ${price.amount_micro} micro USD` : ""}, as ${from} states it.`);
  }
  const blanks = unstatedShapes(s, given).map(blankFor);
  if (blanks.length) said.push(`The shape of ${blanks.map((b) => b.key.replace(/^shape of /, "")).join(" and ")} was not given, so it is asked rather than drafted.`);
  return { spec: s, blanks, note: said.join(" ") };
}
