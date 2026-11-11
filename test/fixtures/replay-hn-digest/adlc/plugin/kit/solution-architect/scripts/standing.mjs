// Standing assets: for each kind of output a person reads, which of the
// organization's standing assets apply, each with its reason, or "none,
// because". The architecture standard, section 10, is the rule; the house
// rule's data (which kinds of output read which assets, and why) is
// standards/standing-asset-schemas.json, which this agent reads at the
// version it pins (standards-pins.json, held by test/standards-pins.test.mjs).
//
// No model is called here: the rule is applied to the record's formats, and a
// person's own answer ("standing-assets: none, because ...") stands in its place.
//
//   needs: node >= 22
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const trim = (s) => String(s ?? "").trim();
const oneLine = (s) => trim(s).replace(/\s+/g, " ");

export const SCHEMAS_FILE = "standing-asset-schemas.json";

/** Where a standard is read from: beside the scripts in a package (a skill's
 *  references/), or the repository's standards/ folder when run from source. */
export function standardAt(name, here = HERE) {
  return [join(here, "..", "references", name), join(here, "..", "..", "..", "standards", name)].find((p) => existsSync(p)) ?? null;
}

/** The list of known standing-asset kinds and the house rule, or null when
 *  it is not where this agent reads it. */
export function loadSchemas(here = HERE) {
  const p = standardAt(SCHEMAS_FILE, here);
  return p ? JSON.parse(readFileSync(p, "utf8")) : null;
}

/** Whether a kind matches a pattern from the list: an exact media type, or
 *  `type/*` for every subtype. Parameters after `;` are not compared. */
export function kindMatches(kind, pattern) {
  const k = trim(kind).split(";")[0].trim().toLowerCase();
  const p = trim(pattern).toLowerCase();
  return p.endsWith("/*") ? k.startsWith(p.slice(0, -1)) : k === p;
}

export const isPersonFacing = (kind, table) => (table?.person_facing_kinds ?? []).some((p) => kindMatches(kind, p));

/** The short word for an asset's kind, from the list ("brand profile"). */
export function kindWord(schema, table) {
  return (table?.schemas ?? []).find((s) => s.schema === schema)?.kind ?? schema;
}

/** The record's standing assets from its formats.
 *
 *  Returns {outputs: [{piece, kind, classes, assets: [{schema, why}]}],
 *  schemas: [schema...], none: reason | null}. `none` is set when no output
 *  is read by a person, or when the person answered that none apply; then
 *  `schemas` is empty. `note` says when a person's answer was not a none,
 *  which is the only answer that changes this. Null when the list of kinds
 *  and the house rule (table) was not read: then nothing is decided, and the
 *  record says so rather than a false "none". architecture-record.mjs renders
 *  it. */
export function standingAssetsOf(formats = [], table = null, answer = "") {
  const said = oneLine(answer);
  if (!table && !/^none\b/i.test(said)) return null;
  const note = said && !/^none\b/i.test(said)
    ? `the person answered "${said}"; only "none, because ..." changes this section, so the house rule stands, and what applies follows the formats`
    : null;
  const outs = (formats ?? []).filter((f) => f?.direction !== "in" && isPersonFacing(f?.kind, table));
  if (/^none\b/i.test(said)) {
    const because = said.replace(/^none[,:;.\s]*(because\s*)?/i, "").replace(/[.\s]+$/, "");
    return { outputs: outs.map((f) => ({ piece: oneLine(f.piece), kind: trim(f.kind), classes: [], assets: [] })), schemas: [],
      none: `the person said none apply${because ? `, because ${because}` : ""}` };
  }
  if (!outs.length) {
    return { outputs: [], schemas: [], none: "no output is read by a person: the agent hands back only data that code reads, or nothing beyond the reply", ...(note ? { note } : {}) };
  }
  const outputs = outs.map((f) => {
    const classes = [];
    const assets = [];
    for (const c of table?.outputs ?? []) {
      if (!(c.kinds ?? []).some((p) => kindMatches(f.kind, p))) continue;
      classes.push(c.class);
      for (const a of c.assets ?? []) {
        const had = assets.find((x) => x.schema === a.schema);
        if (had) had.why = `${had.why}; and ${a.why}`;
        else assets.push({ schema: a.schema, word: kindWord(a.schema, table), why: a.why });
      }
    }
    return { piece: oneLine(f.piece), kind: trim(f.kind), classes, assets };
  });
  const schemas = [...new Set(outputs.flatMap((o) => o.assets.map((a) => a.schema)))].sort();
  return { outputs, schemas, none: schemas.length ? null : "no rule in the house list applies to these outputs' kinds", ...(note ? { note } : {}) };
}

/** What is wrong with a record's standing assets, by the standard (section
 *  10). Empty when every person-facing output has its assets or a reason. */
export function standingProblems(sa, table = null) {
  const out = [];
  if (!sa) return ["the standing assets are not decided"];
  const known = new Set((table?.schemas ?? []).map((s) => s.schema));
  for (const s of sa.schemas ?? []) if (table && !known.has(s)) out.push(`the standing asset ${s} is not a known kind`);
  if (!(sa.schemas ?? []).length && !trim(sa.none)) out.push("no standing asset applies and the record does not say why");
  for (const o of sa.outputs ?? []) for (const a of o.assets ?? []) if (!trim(a.why)) out.push(`the ${a.schema} for ${o.piece} has no reason`);
  return out;
}
