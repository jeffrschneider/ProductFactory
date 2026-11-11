// The Design declares exactly the standing assets the architecture record
// decided, as `can_use` entries, each with what the agent reads (`reads`),
// what it does with it (`does`) and what it does when none is given
// (`without`). The architecture standard, section 10, is the rule, and
// standards/standing-asset-schemas.json is the list of known kinds and the
// house rule's fields, read at the version this agent pins
// (standards-pins.json, held by test/standards-pins.test.mjs).
//
// The model drafts the entries; code then holds them to the record: an entry
// for a schema the record did not decide is taken out, one the record decided
// and the draft left out is added from the house rule, and a member the draft
// left empty is filled from it. Nothing here calls a model.
//
//   needs: node >= 22
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const trim = (s) => String(s ?? "").trim();

export const SCHEMAS_FILE = "standing-asset-schemas.json";

/** Where a standard is read from: beside the scripts in a package (a skill's
 *  references/), or the repository's standards/ folder when run from source. */
export function standardAt(name, here = HERE) {
  return [join(here, "..", "references", name), join(here, "..", "..", "..", "standards", name)].find((p) => existsSync(p)) ?? null;
}

export function loadSchemas(here = HERE) {
  const p = standardAt(SCHEMAS_FILE, here);
  return p ? JSON.parse(readFileSync(p, "utf8")) : null;
}

export function kindMatches(kind, pattern) {
  const k = trim(kind).split(";")[0].trim().toLowerCase();
  const p = trim(pattern).toLowerCase();
  return p.endsWith("/*") ? k.startsWith(p.slice(0, -1)) : k === p;
}

/** The kinds of the outputs a caller is handed: the offered jobs' outputs. */
export function offeredOutputKinds(spec) {
  const jobs = Array.isArray(spec?.jobs) ? spec.jobs : [];
  const offered = jobs.filter((j) => j?.offered);
  return (offered.length ? offered : jobs).flatMap((j) => (Array.isArray(j?.outputs) ? j.outputs : [])).map((o) => trim(o?.kind)).filter(Boolean);
}

/** The house rule's entry for one schema, for these output kinds: the fields
 *  every applying class reads, and its does and without. Classes that match
 *  none of the kinds are used only when no class does. */
export function houseEntry(schema, kinds = [], table = null) {
  const all = (table?.outputs ?? []).flatMap((c) => (c.assets ?? []).filter((a) => a.schema === schema).map((a) => ({ c, a })));
  if (!all.length) return null;
  const matching = all.filter(({ c }) => kinds.some((k) => (c.kinds ?? []).some((p) => kindMatches(k, p))));
  const use = matching.length ? matching : all;
  const reads = [...new Set(use.flatMap(({ a }) => a.reads ?? []))];
  return {
    schema, reads, required: false,
    does: use.map(({ a }) => trim(a.does)).filter(Boolean).join("; and "),
    without: use.map(({ a }) => trim(a.without)).filter(Boolean).join("; and "),
  };
}

/** The draft's can_use held to the record's standing assets. Returns the
 *  spec and the notes saying what code changed. With no record, or one
 *  written before standing assets were decided, every entry is kept and only
 *  an empty member of a known kind is filled. */
export function fitCanUse(spec, architecture = null, table = null) {
  if (!spec || typeof spec !== "object") return { spec, notes: [] };
  const decided = Array.isArray(architecture?.standing_assets) ? architecture.standing_assets : null;
  const kinds = offeredOutputKinds(spec);
  const drafted = Array.isArray(spec.can_use) ? spec.can_use.filter((e) => e && typeof e === "object") : [];
  const notes = [];
  const fill = (e) => {
    const house = houseEntry(trim(e.schema), kinds, table);
    const out = { ...e, schema: trim(e.schema) };
    for (const k of ["reads", "does", "without"]) {
      const empty = k === "reads" ? !(Array.isArray(out.reads) && out.reads.some((f) => trim(f))) : !trim(out[k]);
      if (empty && house) { out[k] = house[k]; notes.push(`can_use ${out.schema}: ${k} was empty and is the house rule's`); }
    }
    if (!("required" in out)) out.required = false;
    return out;
  };
  let entries;
  if (!decided) {
    entries = drafted.map(fill);
  } else {
    entries = [];
    for (const e of drafted) {
      if (!decided.includes(trim(e.schema))) notes.push(`can_use ${trim(e.schema)} was taken out: the architecture record does not decide it, and the Design declares exactly the record's standing assets`);
    }
    for (const schema of decided) {
      const had = drafted.find((e) => trim(e.schema) === schema);
      if (had) { entries.push(fill(had)); continue; }
      const house = houseEntry(schema, kinds, table);
      if (house) { entries.push(house); notes.push(`can_use ${schema} was added from the house rule: the architecture record decides it and the draft left it out`); }
      else notes.push(`can_use ${schema}: the architecture record decides it, and no house rule says what to read from it`);
    }
  }
  const next = { ...spec };
  if (entries.length) next.can_use = entries;
  else delete next.can_use;
  return { spec: next, notes };
}

/** What is wrong with a draft's can_use, as sentences a model can act on.
 *  Given the spec or its can_use entries alone; with no table named, the
 *  list of known kinds is the one this agent pins. */
export function canUseProblems(spec, architecture = null, table = loadSchemas()) {
  const out = [];
  const entries = Array.isArray(spec) ? spec : Array.isArray(spec?.can_use) ? spec.can_use : [];
  const known = new Set((table?.schemas ?? []).map((s) => s.schema));
  const decided = Array.isArray(architecture?.standing_assets) ? architecture.standing_assets : null;
  for (const e of entries) {
    const schema = trim(e?.schema);
    if (table && !known.has(schema)) out.push(`can_use names ${schema || "no schema"}, which is not a known kind of standing asset; use one from the list`);
    if (decided && !decided.includes(schema)) out.push(`can_use names ${schema}, which the architecture record does not decide; declare exactly the record's standing assets`);
    if (!(Array.isArray(e?.reads) && e.reads.some((f) => trim(f)))) out.push(`can_use ${schema}: reads lists the fields the agent reads from it`);
    if (!trim(e?.does)) out.push(`can_use ${schema}: does says in one sentence what the agent does with it`);
    if (!trim(e?.without)) out.push(`can_use ${schema}: without says what the agent does when none is given`);
  }
  for (const schema of decided ?? []) {
    if (!entries.some((e) => trim(e?.schema) === schema)) out.push(`the architecture record decides the standing asset ${schema} and the draft does not declare it in can_use`);
  }
  return out;
}

/** The schemas of the known kinds of standing asset, from the list this
 *  agent pins. */
export function knownSchemas(table = loadSchemas()) {
  return (table?.schemas ?? []).map((s) => trim(s?.schema)).filter(Boolean);
}

/** The house rule's entry for one schema, whatever the outputs: what it
 *  reads, required false, and its does and without; null for a schema the
 *  house rule does not name. */
export function houseRuleFor(schema, kinds = [], table = loadSchemas()) {
  return houseEntry(trim(schema), kinds, table);
}

/** What the agent does when none of this standing asset is given, as the
 *  house rule says it; "" for a schema the house rule does not name. */
export function withoutFor(schema, kinds = [], table = loadSchemas()) {
  return houseRuleFor(schema, kinds, table)?.without ?? "";
}

/** can_use entries held to the record, as fitCanUse holds a draft's: the
 *  entries left, or undefined when none are. */
export function cleanCanUse(entries = [], architecture = null, table = loadSchemas()) {
  return fitCanUse({ can_use: Array.isArray(entries) ? entries : [] }, architecture, table).spec.can_use;
}

/** The sentence the model is given with the record. */
export const CAN_USE_RULE = "Declare exactly the standing assets the record's \"Standing assets\" section decides, and no other, "
  + "each as one entry in \"can_use\": {\"schema\": the schema URL as the record writes it, \"reads\": the fields of it this agent reads, "
  + "\"required\": false, \"does\": one sentence on what the agent does with them, \"without\": one sentence on what it does when none is given}. "
  + "Where the record says none, leave can_use out.";
