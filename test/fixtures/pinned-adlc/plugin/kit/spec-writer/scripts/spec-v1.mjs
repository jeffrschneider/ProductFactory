// The spec (spec-v1, standards/spec.schema.json): checked against its
// schema, and written out for a person to read.
//
// What Requirements hands back is the spec: the analysis of the product's
// functional requirements and capabilities, each feature with requirements
// in the attributes of ISO/IEC/IEEE 29148 and acceptance criteria as Gherkin
// scenarios (stages.json 1.6.0). This file holds two things about it that
// need no model:
//
//   - validateSpec: the problems with a value as spec-v1, from the schema
//     itself, read at the version standards-pins.json pins. The part of JSON
//     Schema 2020-12 the schema uses and no more, in the pattern of
//     standards/lifecycle-api-check.mjs (type, enum, const, required,
//     properties, items, minItems, minLength, pattern, $ref). A pattern that
//     opens with the inline flag (?m) is read with JavaScript's m flag.
//   - specMarkdown: the same spec as Markdown a person reads (out/spec.md):
//     the product, each feature with each requirement's shall line and the
//     exact words it fixes, each acceptance scenario in Gherkin, then the
//     interfaces, constraints, systems, settings, price and open questions.
//
//   needs: node >= 22. Reads spec.schema.json beside the package or in the
//   repository's standards/.
//   import { validateSpec, specMarkdown, loadSpecSchema } from "./spec-v1.mjs"
//   SPEC=<spec.json> node spec-v1.mjs   (prints the problems, exits 1 when any)
import { readFileSync } from "node:fs";
import { standardAt } from "./can-use.mjs";

export const SPEC_FORMAT = "spec-v1";
export const SPEC_SCHEMA_FILE = "spec.schema.json";

const trim = (s) => String(s ?? "").trim();
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const isType = (v, t) => t === typeOf(v) || (t === "number" && typeof v === "number");

let cached = null;
/** The spec schema, read once: from a skill's references/ in a package, or
 *  the repository's standards/ from source. Throws when it is in neither. */
export function loadSpecSchema() {
  if (cached) return cached;
  const at = standardAt(SPEC_SCHEMA_FILE);
  if (!at) throw new Error(`${SPEC_SCHEMA_FILE} is not beside the scripts or in standards/, so no spec can be checked`);
  cached = JSON.parse(readFileSync(at, "utf8"));
  return cached;
}

/** A schema pattern as a JavaScript RegExp: an inline (?m) becomes the m
 *  flag, which JavaScript does not read inline. */
export function patternOf(p) {
  const m = /^\(\?([a-z]+)\)/.exec(String(p));
  return m ? new RegExp(String(p).slice(m[0].length), m[1].replace(/[^gimsuy]/g, "")) : new RegExp(String(p));
}

function walk(root, schema, v, at, out) {
  if (schema === true || !isObj(schema)) return;
  if (schema.$ref) {
    const name = String(schema.$ref).replace(/^#\/\$defs\//, "");
    const def = root.$defs?.[name];
    if (!def) throw new Error(`the spec schema has no definition ${schema.$ref}`);
    walk(root, def, v, at, out);
  }
  if (schema.type !== undefined) {
    const types = [].concat(schema.type);
    if (!types.some((t) => isType(v, t))) { out.push(`${at}: is ${typeOf(v)}, not ${types.join(" or ")}`); return; }
  }
  if (schema.enum && !schema.enum.includes(v)) out.push(`${at}: is ${JSON.stringify(v)}, not one of ${schema.enum.join(", ")}`);
  if ("const" in schema && v !== schema.const) out.push(`${at}: is ${JSON.stringify(v)}, not ${JSON.stringify(schema.const)}`);
  if (typeof v === "string") {
    if (schema.minLength !== undefined && v.length < schema.minLength) out.push(`${at}: is empty`);
    if (schema.pattern !== undefined && !patternOf(schema.pattern).test(v)) out.push(`${at}: is ${JSON.stringify(v.length > 80 ? `${v.slice(0, 80)}...` : v)}, which is not in the form ${schema.pattern}`);
  }
  if (isObj(v)) {
    for (const k of schema.required ?? []) if (!(k in v)) out.push(`${at}: has no ${k}`);
    for (const [k, s] of Object.entries(schema.properties ?? {})) if (k in v) walk(root, s, v[k], `${at}.${k}`, out);
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(v)) if (!(k in (schema.properties ?? {}))) out.push(`${at}: has ${k}, which the schema does not allow`);
    }
  }
  if (Array.isArray(v) && schema.minItems !== undefined && v.length < schema.minItems) out.push(`${at}: has ${v.length} items, fewer than ${schema.minItems}`);
  if (Array.isArray(v) && schema.items) v.forEach((x, i) => walk(root, schema.items, x, `${at}[${i}]`, out));
}

/** The problems with value as spec-v1, as sentences; empty when it fits. */
export function validateSpec(value, schema = loadSpecSchema()) {
  const out = [];
  walk(schema, schema, value, "spec", out);
  return out;
}

// ---------- the spec as Markdown ----------

/** A fence that no line of the text can close: tildes, one more than the
 *  longest run of tildes in it, and never fewer than three. */
const fenceFor = (text) => "~".repeat(Math.max(3, ...[...String(text).matchAll(/~+/g)].map((m) => m[0].length + 1)));
const fenced = (text, lang = "", pad = "") => { const f = fenceFor(text); return [`${pad}${f}${lang}`, ...String(text).split("\n").map((l) => `${pad}${l}`), `${pad}${f}`]; };
const list = (v) => (Array.isArray(v) ? v : []);
const short = (v) => (typeof v === "string" ? v : JSON.stringify(v));

/** The headings spec.md always carries, in order, so the next reader (and
 *  the descriptor's convention for it) knows what to find. */
export const MD_HEADINGS = ["## Purpose", "## Features", "## Interfaces", "## Constraints", "## Systems", "## Settings", "## Price", "## Open questions"];

function requirementLines(r) {
  const tags = [trim(r.kind), trim(r.priority), r.verify ? `verified by ${trim(r.verify)}` : ""].filter(Boolean).join(", ");
  const out = [`- **${trim(r.id)}** (${tags}): ${trim(r.shall)}`];
  if (list(r.exact).length) {
    out.push("  Exactly:");
    for (const e of r.exact) out.push(...fenced(String(e), "", "  "));
  }
  const src = r.source ?? {};
  const from = [trim(src.said) ? `said: ${trim(src.said)}` : "", trim(src.behavior) ? `as built: ${trim(src.behavior)}` : "",
    list(src.evidence).length ? list(src.evidence).map((e) => `${e.file}:${e.line}`).join(", ") : ""].filter(Boolean).join("; ");
  if (from) out.push(`  From ${from}.`);
  if (trim(r.rationale)) out.push(`  Why: ${trim(r.rationale)}`);
  return out;
}

function dataLines(label, items) {
  if (!list(items).length) return [];
  const out = [`${label}:`];
  for (const d of items) {
    out.push(`- ${trim(d.name)}${trim(d.kind) ? ` (${trim(d.kind)})` : ""}: ${trim(d.about)}`);
    if (d.schema !== undefined) out.push(...fenced(JSON.stringify(d.schema, null, 2), "json", "  "));
  }
  return out;
}

/** The spec as Markdown: the same spec, readable by a person. Pure. */
export function specMarkdown(spec) {
  const p = spec?.product ?? {};
  const L = [`# ${trim(p.name) || "Not named yet"} ${trim(p.version)}`.trim(), ""];
  L.push(`The spec (${SPEC_FORMAT}) of ${trim(p.kind) === "process" ? "a process" : "an agent"}${spec?.source?.kind === "as-built-record" ? `, drawn from the as-built record of ${trim(spec.source.repository) || "code kept elsewhere"}${trim(spec.source.commit) ? ` at ${trim(spec.source.commit).slice(0, 12)}` : ""}` : ", drawn from the person's account"}.`, "");
  L.push("## Purpose", "", trim(spec?.purpose) || "Not said.", "");
  if (list(spec?.users).length) { for (const u of spec.users) L.push(`- ${trim(u.who)}: ${trim(u.wants)}`); L.push(""); }
  L.push("## Features", "");
  for (const f of list(spec?.features)) {
    L.push(`### ${trim(f.id)} ${trim(f.name)}`, "", `${trim(f.does)}${trim(f.as_built) ? ` (as built: ${trim(f.as_built)})` : ""}${trim(f.offering) ? ` Offering: ${trim(f.offering)}.` : ""}`, "");
    const io = [...dataLines("Inputs", f.inputs), ...dataLines("Outputs", f.outputs)];
    if (io.length) L.push(...io, "");
    L.push("Requirements:", "");
    for (const r of list(f.requirements)) L.push(...requirementLines(r));
    L.push("", "Acceptance:", "");
    for (const a of list(f.acceptance)) {
      L.push(`${trim(a.id)}, which checks ${list(a.checks).join(", ")}:`, "", ...fenced(String(a.gherkin ?? ""), "gherkin"), "");
    }
  }
  L.push("## Interfaces", "");
  if (!list(spec?.interfaces).length) L.push("None.", "");
  for (const i of list(spec?.interfaces)) {
    const extra = [trim(i.module) ? `from ${trim(i.module)}` : "", trim(i.signature) ? `signature ${trim(i.signature)}` : "", list(i.flags).length ? `flags ${i.flags.join(" ")}` : "",
      list(i.required_flags).length ? `requires ${i.required_flags.join(" ")}` : "", trim(i.declared_in) ? `declared at ${trim(i.declared_in)}` : ""].filter(Boolean).join(", ");
    L.push(`- **${trim(i.id)}** ${trim(i.kind)} \`${trim(i.name)}\`${i.keep ? ", kept exactly" : ", may change with your approval"}${extra ? `, ${extra}` : ""}: ${trim(i.about)}`);
    if ("value" in i) L.push("  Value:", ...fenced(JSON.stringify(i.value), "json", "  "));
    if (isObj(i.values)) L.push("  Allowed values:", ...Object.entries(i.values).map(([k, v]) => `  - \`${k}\`: ${list(v).map((x) => `\`${short(x)}\``).join(", ")}`));
    if (i.schema !== undefined) L.push(...fenced(JSON.stringify(i.schema, null, 2), "json", "  "));
  }
  if (list(spec?.interfaces).length) L.push("");
  L.push("## Constraints", "");
  if (!list(spec?.constraints).length) L.push("None.");
  for (const c of list(spec?.constraints)) L.push(...requirementLines(c));
  L.push("", "## Systems", "");
  if (!list(spec?.systems).length) L.push("None: it reaches nothing outside its own folder.");
  for (const s of list(spec?.systems)) L.push(`- ${trim(s.name)}: ${s.reach === "none" ? "named, never reached" : `reach ${trim(s.reach)}`}${trim(s.address) ? `, at ${trim(s.address)}` : ""}. ${trim(s.why)}`);
  L.push("", "## Settings", "");
  if (!list(spec?.settings).length) L.push("None.");
  for (const s of list(spec?.settings)) {
    const range = [s.default !== undefined ? `default ${short(s.default)}` : "no default given", s.min !== undefined ? `min ${s.min}` : "", s.max !== undefined ? `max ${s.max}` : "", list(s.values).length ? `one of ${s.values.map(short).join(", ")}` : "", trim(s.set_by) ? `set by ${trim(s.set_by)}` : ""].filter(Boolean).join(", ");
    L.push(`- \`${trim(s.name)}\` (${trim(s.kind)}; ${range}): ${trim(s.about)}`);
  }
  L.push("", "## Price", "", trim(spec?.price) || "Not set: it is an open question.", "");
  L.push("## Open questions", "");
  if (!list(spec?.open).length) L.push("None.");
  for (const o of list(spec?.open)) L.push(`- \`${trim(o.key)}\`: ${trim(o.question)}`);
  return L.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

const thisFile = process.argv[1] ? process.argv[1].replace(/\\/g, "/").split("/").pop() : "";
if (thisFile && import.meta.url.endsWith(thisFile)) {
  const { SPEC } = process.env;
  if (!SPEC) { console.error("SPEC is required"); process.exit(2); }
  try {
    const problems = validateSpec(JSON.parse(readFileSync(SPEC, "utf8")));
    console.log(JSON.stringify({ ok: !problems.length, problems }, null, 2));
    process.exitCode = problems.length ? 1 : 0;
  } catch (e) {
    console.error(e.message);
    process.exitCode = 2;
  }
}
