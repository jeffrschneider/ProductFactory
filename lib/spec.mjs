// The spec (stages.json 1.6.0, CommonAgent/adlc standards/spec.schema.json,
// spec-v1): what Requirements hands back, the analysis of the product's
// functional requirements and capabilities. The spec writer's write-a-spec job
// writes it beside the agent's own files: out/spec.json (the spec, format
// spec-v1) and out/spec.md (the same spec for a person to read), and the
// agent's own files under out/agent/, which the Design part of Architecture
// and Design makes from the spec.
//
// Every place Product Factory reads the spec writer's spec is here, so a
// change in where the spec writer puts it is a change to this file alone:
//
//   specPieces(filed)    which of the job's filed pieces are spec.json and spec.md
//   SPEC_NAMES, isSpecName   the names the spec goes by in a hand-off ("spec.json", "spec.md")
//   specOfBuild(r, dir)  the spec a build's Requirements handed back, read
//   specFilesOf(files)   the spec's files among a phase's handed files, for Test and Code
//   specSummary(spec)    the spec artifact's summary (lifecycle API 0.4.8 SpecSummary)
//
// The spec is told apart from any other spec.json by its format, spec-v1.

import { readFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";

export const SPEC_FORMAT = "spec-v1";
/** The spec's two files, by the names they go by from Requirements on. */
export const SPEC_JSON = "spec.json";
export const SPEC_MD = "spec.md";
export const SPEC_NAMES = [SPEC_JSON, SPEC_MD];
export const isSpecName = (name) => SPEC_NAMES.includes(String(name ?? "").replace(/^requirements\//, ""));
export const SPEC_TYPES = { [SPEC_JSON]: "application/json", [SPEC_MD]: "text/markdown" };

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const words = (s) => String(s ?? "").trim();
const list = (v) => (Array.isArray(v) ? v : []);
const readJson = (at) => { try { return JSON.parse(readFileSync(at, "utf8")); } catch { return null; } };

/** Whether a value is a spec: an object of format spec-v1. */
export const isSpec = (v) => isObj(v) && v.format === SPEC_FORMAT;

/**
 * The spec among a spec writer's job pieces (adapters.mjs piecesOf): the
 * spec.json of format spec-v1 at the top of out/, and the spec.md beside it.
 * Each is { abs, path, media_type } with path its name ("spec.json"), or null.
 */
export function specPieces(filed) {
  const top = (p, name) => p.path === `out/${name}`;
  const json = list(filed).find((p) => top(p, SPEC_JSON) && isSpec(readJson(p.abs)));
  const md = json ? list(filed).find((p) => top(p, SPEC_MD)) : null;
  const one = (p, name) => (p ? { abs: p.abs, path: name, media_type: SPEC_TYPES[name] } : null);
  return { json: one(json, SPEC_JSON), md: one(md, SPEC_MD) };
}

/** A file inside the build folder by its path there, or null when it is outside it. */
function inside(dir, rel) {
  if (!rel) return null;
  const at = resolve(dir, rel);
  const back = relative(dir, at);
  return !back || back.startsWith("..") || isAbsolute(back) ? null : at;
}

/**
 * The spec build r's Requirements handed back, read: { spec, files, round }
 * with files its handed-back entries ({ path, at }) and round the spec
 * writer's round it is from, or null when it handed back none (a spec writer
 * from before stages.json 1.6.0) and none was written after the version
 * (lifecycle API 0.4.14). A spec written after comes back with after: { at, words }.
 */
export function specOfBuild(r, dir) {
  const handed = r?.stages?.requirements?.handed_back?.files ?? [];
  const later = handed.some((f) => f.path === `requirements/${SPEC_JSON}`) ? null : r?.spec_written_after ?? null;
  const files = later ? later.files ?? [] : handed;
  const json = files.find((f) => f.path === `requirements/${SPEC_JSON}`);
  const spec = json ? readJson(inside(dir, json.at)) : null;
  if (!isSpec(spec)) return null;
  const md = files.find((f) => f.path === `requirements/${SPEC_MD}`);
  if (later) return { spec, files: [json, ...(md ? [md] : [])], round: null, after: { at: later.at, words: later.words } };
  const round = Number(/(?:^|\/)r(\d+)\//.exec(String(json.at))?.[1] ?? 0) || null;
  return { spec, files: [json, ...(md ? [md] : [])], round };
}

/** The spec's files among a phase's handed files ([{ name, path, media_type }]): spec.json first, then spec.md. */
export function specFilesOf(files) {
  const byName = (n) => list(files).find((f) => basename(String(f.name ?? "")) === n && isSpecName(f.name));
  return SPEC_NAMES.map(byName).filter(Boolean);
}

// ---------- the summary the lifecycle API answers (0.4.8 SpecSummary) ----------

const requirementOf = (q) => ({
  id: words(q.id), shall: words(q.shall),
  ...(words(q.kind) ? { kind: words(q.kind) } : {}),
  ...(list(q.exact).length ? { exact: list(q.exact).map((x) => String(x)) } : {}),
});

/** A constraint in words: "C1 (limit): The agent shall ...". */
const constraintWords = (c) => `${words(c.id)}${words(c.kind) ? ` (${words(c.kind)})` : ""}: ${words(c.shall)}`;

/** A system in words: "Hacker News API (read): https://...: why". */
const systemWords = (s) => `${words(s.name)} (${words(s.reach) || "reach not said"})${words(s.address) ? `: ${words(s.address)}` : ""}${words(s.why) ? `, ${words(s.why).replace(/^[A-Z]/, (c) => c.toLowerCase())}` : ""}`;

/** A setting in words: "limit (integer, default 30, 1 to 100, set by either): what it changes". */
function settingWords(s) {
  const bits = [words(s.kind)];
  if (s.default !== undefined) bits.push(`default ${typeof s.default === "string" ? s.default : JSON.stringify(s.default)}`);
  if (typeof s.min === "number" || typeof s.max === "number") bits.push(`${s.min ?? "any"} to ${s.max ?? "any"}`);
  if (list(s.values).length) bits.push(`one of ${list(s.values).map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(", ")}`);
  if (words(s.set_by)) bits.push(`set by ${words(s.set_by)}`);
  return `${words(s.name)} (${bits.filter(Boolean).join(", ")}): ${words(s.about)}`;
}

/**
 * The spec artifact's summary (lifecycle API 0.4.8 SpecSummary): the product,
 * its purpose, each feature with its requirements and acceptance scenarios,
 * the interfaces and which must be kept, the constraints and the open
 * questions. It also carries the systems, the settings and the price in
 * words, which SpecSummary does not name; a client that does not know them
 * ignores them.
 */
export function specSummary(spec, { name = "", version = "" } = {}) {
  const p = isObj(spec.product) ? spec.product : {};
  const out = {
    product: `${words(p.name) || name} ${words(p.version) || version}`.trim(),
    ...(words(spec.purpose) ? { purpose: words(spec.purpose) } : {}),
    features: list(spec.features).filter(isObj).map((f) => ({
      id: words(f.id), name: words(f.name), does: words(f.does),
      ...(words(f.offering) ? { offering: words(f.offering) } : {}),
      ...(words(f.as_built) ? { as_built: words(f.as_built) } : {}),
      requirements: list(f.requirements).filter(isObj).map(requirementOf),
      acceptance: list(f.acceptance).filter(isObj).map((a) => ({ id: words(a.id), gherkin: String(a.gherkin ?? "") })),
    })),
    interfaces: list(spec.interfaces).filter(isObj).map((x) => ({ id: words(x.id), ...(words(x.kind) ? { kind: words(x.kind) } : {}), name: words(x.name), keep: x.keep === true, ...(words(x.about) ? { about: words(x.about) } : {}) })),
    constraints: list(spec.constraints).filter(isObj).map(constraintWords),
    open: list(spec.open).filter(isObj).map((q) => words(q.question)).filter(Boolean),
  };
  const systems = list(spec.systems).filter(isObj).map(systemWords);
  const settings = list(spec.settings).filter(isObj).map(settingWords);
  if (systems.length) out.systems = systems;
  if (settings.length) out.settings = settings;
  if (words(spec.price)) out.price = words(spec.price);
  return out;
}

/** The spec's features as features.mjs proposes them: { id, name, does, offering, as_built }. */
export function specFeatures(spec) {
  return list(spec?.features).filter((f) => isObj(f) && words(f.id) && words(f.name) && words(f.does)).map((f) => ({ id: words(f.id), name: words(f.name), does: words(f.does), offering: words(f.offering), as_built: words(f.as_built) }));
}

/** The ids of the spec's interfaces that must be kept exactly. */
export const keptInterfaces = (spec) => list(spec?.interfaces).filter((x) => isObj(x) && x.keep === true).map((x) => words(x.id)).filter(Boolean);
