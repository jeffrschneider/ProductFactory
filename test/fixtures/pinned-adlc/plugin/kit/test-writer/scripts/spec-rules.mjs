// The spec (spec-v1), and the checks a suite written from it is held to
// (test-writer 0.9.0). No model.
//
// WHY THIS EXISTS. Until stages.json 1.6.0 the "spec" this agent was handed
// was the agent's own declaration files, so a suite was written from a
// descriptor. On a round trip (a public news reader rebuilt from its as-built
// record) the record caught the runner's stop pattern, the page-metadata
// sources, the refusal's words and the output's schema exactly, and none of
// it reached this agent: the files that carried it were attached, matched no
// kind it picked out, and were dropped without a word. The gate then passed
// code the original's own tests fail. Requirements now hands back the spec
// (standards/spec.schema.json): features with requirements, each fixing its
// exact words, patterns and numbers, acceptance scenarios in Gherkin, and the
// interfaces that must be kept. This file finds it by content, and holds a
// suite to it:
//
// - every acceptance scenario has a test named with its id in square
//   brackets, "[F1.A1] ...";
// - every entry of `exact` of a requirement verified by test is carried by a
//   test named for its feature (a constraint's, by a test named for it, or
//   anywhere in the suite when none is): words and patterns byte for byte, a
//   number as the number;
// - every kept file or message with a schema is held, by some test, with
//   checkKept or keptProblems from ./kept-interfaces.test.mjs.
//
// A test is named for a feature when its name opens with ids in square
// brackets that include the feature's id, one of its scenarios' ids or one
// of its requirements' ids ("[F1]", "[F1.A2]", "[F1.R3, F2.A1]"). Product
// Factory maps tests to features by that F number.
//
//   needs: node >= 22
//   import { specV1Among, acceptanceFindings, exactFindings, keptCallFindings } from "./spec-rules.mjs"
import { readFileSync } from "node:fs";
import { chunksOf, numbersWritten, statedIn, testNamesIn } from "./suite-rules.mjs";

const trim = (s) => String(s ?? "").trim();
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

/** Whether a document is a spec, spec-v1: its format says so and it has
 *  features. The full schema is the spec writer's and the standard's to
 *  hold; this is the floor a suite can be written from. */
export const isSpecV1 = (doc) => Boolean(doc && typeof doc === "object" && !Array.isArray(doc)
  && doc.format === "spec-v1" && Array.isArray(doc.features) && doc.features.length);

/** The spec in a text, or null. */
export function specV1Of(text) {
  try { const doc = JSON.parse(String(text ?? "")); return isSpecV1(doc) ? doc : null; } catch { return null; }
}

/** The spec among the files a message carried, by content and never by
 *  name (a file through the process runner arrives under its piece label
 *  with a prefix per hop). With more than one, the one whose product version
 *  is `version` (the agent's own plugin.json), else the last. Its path, or
 *  null. */
export function specV1Among(files = [], read = (p) => readFileSync(p, "utf8"), { version = null } = {}) {
  const found = [];
  for (const f of files ?? []) {
    const path = typeof f === "string" ? f : f?.path;
    if (!path || /job-manifest\.json$/.test(path)) continue;
    let text;
    try { text = read(path); } catch { continue; }
    const doc = specV1Of(text);
    if (doc) found.push({ path, doc });
  }
  if (!found.length) return null;
  const match = version ? [...found].reverse().find((s) => String(s.doc.product?.version) === String(version)) : null;
  return (match ?? found[found.length - 1]).path;
}

/** Every acceptance scenario: { id, feature, title, checks }. title is the
 *  text of its Scenario: line. */
export function scenariosOf(spec) {
  const out = [];
  for (const f of spec?.features ?? []) {
    for (const a of f?.acceptance ?? []) {
      if (!trim(a?.id)) continue;
      const title = trim(/^\s*Scenario:\s*(.*)$/m.exec(String(a.gherkin ?? ""))?.[1]);
      out.push({ id: trim(a.id), feature: trim(f.id), title, checks: Array.isArray(a.checks) ? a.checks.map(trim) : [] });
    }
  }
  return out;
}

/** Every requirement a test verifies (verify: test), features' and
 *  constraints': { id, feature, kind, exact, by }, where feature is the F id
 *  (null for a constraint) and by the scenarios that check it. */
export function testedRequirements(spec) {
  const scenarios = scenariosOf(spec);
  const by = (id) => scenarios.filter((s) => s.checks.includes(id)).map((s) => s.id);
  const one = (r, feature) => ({ id: trim(r.id), feature, kind: r.kind ?? null, shall: trim(r.shall), exact: (Array.isArray(r.exact) ? r.exact : []).map(String).filter((e) => trim(e)), by: by(trim(r.id)) });
  const out = [];
  for (const f of spec?.features ?? []) for (const r of f?.requirements ?? []) if (r?.verify === "test" && trim(r.id)) out.push(one(r, trim(f.id)));
  for (const r of spec?.constraints ?? []) if (r?.verify === "test" && trim(r?.id)) out.push(one(r, null));
  return out;
}

/** The interfaces the spec keeps exactly (keep: true), in its order. */
export const keptOf = (spec) => (Array.isArray(spec?.interfaces) ? spec.interfaces : []).filter((i) => i && i.keep === true && trim(i.id));

/** The ids a test's name opens with, in one or more bracket groups:
 *  "[F1.A1, F1.A2] ..." and "[F1.A1] [C2] ..." give each id. */
export function bracketIdsOf(name) {
  const m = /^\s*((?:\[[^\]]+\]\s*)+)/.exec(String(name ?? ""));
  if (!m) return [];
  return [...m[1].matchAll(/\[([^\]]+)\]/g)].flatMap((x) => x[1].split(/[,\s]+/)).map(trim).filter(Boolean);
}

/** The feature an id belongs to: F1 for F1, F1.A2 and F1.R3; null for any
 *  other id. */
export const featureOfId = (id) => /^(F\d+)(?:\.[AR]\d+)?$/.exec(trim(id))?.[1] ?? null;

/** Whether a test name is named for one of these ids, or for the feature
 *  they belong to. */
const namedFor = (name, ids) => bracketIdsOf(name).some((x) => ids.includes(x) || ids.includes(featureOfId(x)));

/** Each acceptance scenario no test is named for, as a finding: the
 *  standard's done-when, "every acceptance scenario has a test". */
export function acceptanceFindings(files = [], spec = null, { skip = [] } = {}) {
  const names = files.filter((f) => !skip.includes(f.path)).flatMap((f) => testNamesIn(f.text));
  const have = new Set(names.flatMap(bracketIdsOf));
  const out = [];
  for (const s of scenariosOf(spec)) {
    if (have.has(s.id)) continue;
    out.push(`no test is named for the acceptance scenario ${s.id}${s.title ? ` ("${s.title}")` : ""}: write at least one test for it, named "[${s.id}] ..." with the scenario's id in square brackets, that checks ${s.checks.length ? s.checks.join(", ") : "what it says"}`);
  }
  return out;
}

/** The text a test pins with, for these ids: the tests named for them and
 *  each constant of their file they use that is a worked value or fits on
 *  one line (sample data and stand-ins pin nothing). Null when no test is
 *  named for them. As pinFindings reads a feature's tests. */
function scopeFor(perFile, ids) {
  const scope = [];
  for (const { chunks } of perFile) {
    const tests = chunks.filter((c) => c.test && c.names.some((n) => namedFor(n, ids)));
    if (!tests.length) continue;
    const body = tests.map((c) => c.text).join("\n");
    const used = new Set([...body.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]));
    const constant = (c) => /^\s*(?:export\s+)?const\b/m.test(c.text)
      && (/=\s*worked\s*\(/.test(c.text) || c.text.split("\n").filter((l) => trim(l) && !COMMENT_LINE.test(l)).length === 1);
    scope.push(body, ...chunks.filter((c) => !c.test && constant(c) && c.declares.some((n) => used.has(n))).map((c) => c.text));
  }
  return scope.length ? scope.join("\n") : null;
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether code carries an exact phrase as written: as it is (words, or a
 *  pattern in a regular expression literal), escaped as a pattern, written
 *  inside a string literal, or with its slashes escaped in a regular
 *  expression literal. */
export function carriesExact(code, phrase) {
  const p = String(phrase);
  const c = String(code ?? "");
  const inString = JSON.stringify(p).slice(1, -1);
  return [p, escapeRe(p), inString, JSON.stringify(escapeRe(p)).slice(1, -1), p.replace(/\//g, "\\/"), inString.replace(/'/g, "\\'")]
    .some((v) => v && c.includes(v));
}

/** An exact entry that is a number, with or without its unit ("30", "10
 *  seconds", "2,000,000", "500 ms"): the values a test may write it as, or
 *  null when the entry is words or a pattern. */
export function numberOfExact(entry) {
  const t = trim(entry);
  const m = /^(-?\d{1,3}(?:,\d{3})+|-?\d+)(?:\.(\d+))?(?:[\s-]*([A-Za-z]+))?$/.exec(t);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, "") + (m[2] ? `.${m[2]}` : ""));
  const unit = m[3] ?? "";
  // A count of things is a number; any other word after it ("1 point") is
  // words, held byte for byte.
  if (unit && !/^(?:ms|milliseconds?|s|secs?|seconds?|mins?|minutes?|hours?|characters?|chars?|bytes?|items?|lines?|words?|entries|entry|results?|KB|MB|GB|tokens?|times?|tries|attempts?)$/i.test(unit)) return null;
  const values = new Set([String(n)]);
  if (unit) for (const x of statedIn(t).numbers) for (const v of x.values) values.add(v);
  if (/^(?:ms|milliseconds?)$/i.test(unit) && n % 1000 === 0) values.add(String(n / 1000));
  return values;
}

/** Whether code carries an exact entry: a number as any value it may be
 *  written as, anything else byte for byte. */
export function pinsExact(code, entry) {
  const values = numberOfExact(entry);
  if (values) {
    const written = numbersWritten(code);
    return [...values].some((v) => written.has(v)) || carriesExact(code, entry);
  }
  return carriesExact(code, entry);
}

/** Each exact word, pattern and number a requirement verified by test fixes
 *  that no test named for its feature carries, as findings. A constraint's
 *  is looked for in the tests named for it, or anywhere in the suite when
 *  none is. */
export function exactFindings(files = [], spec = null, { skip = [] } = {}) {
  const own = files.filter((f) => !skip.includes(f.path));
  const perFile = own.map((f) => ({ f, chunks: chunksOf(f.text) }));
  const all = own.map((f) => String(f.text ?? "")).join("\n");
  const out = [];
  for (const r of testedRequirements(spec)) {
    if (!r.exact.length) continue;
    const ids = r.feature ? [r.feature] : [r.id];
    const scope = scopeFor(perFile, ids) ?? (r.feature ? null : all);
    const missing = r.exact.filter((e) => scope === null || !pinsExact(scope, e));
    if (!missing.length) continue;
    const said = missing.map((e) => JSON.stringify(e)).join(", ");
    const where = r.feature
      ? (scope === null
        ? `no test is named for ${r.feature}`
        : `no test named for ${r.feature} carries ${missing.length === 1 ? "it" : "them"}`)
      : `no test carries ${missing.length === 1 ? "it" : "them"}`;
    const which = r.by.length ? ` (the test for ${r.by.join(" or ")}, which checks ${r.id})` : "";
    out.push(`${r.id} fixes ${said} exactly, and ${where}: assert ${missing.length === 1 ? "it" : "each"} in a test named for ${r.feature ?? r.id}${which}, words and patterns byte for byte as the spec gives them and a number as the number (a time limit in seconds may be written in milliseconds)`);
  }
  return out;
}

/** Each kept file or message with a schema that no test holds, as findings:
 *  some test file other than the standard checks calls checkKept or
 *  keptProblems with the interface's id quoted. */
export function keptCallFindings(files = [], spec = null, { skip = [] } = {}) {
  const own = files.filter((f) => !skip.includes(f.path));
  const calls = own.filter((f) => /from\s+["']\.\/kept-interfaces\.test\.mjs["']/.test(f.text)).map((f) => String(f.text));
  const out = [];
  for (const i of keptOf(spec)) {
    if (!["file", "message"].includes(i.kind) || i.schema === undefined) continue;
    const id = trim(i.id);
    const quoted = new RegExp(`(?:checkKept|keptProblems)\\s*\\([^;]*?["'\`]${escapeRe(id)}["'\`]`, "s");
    if (calls.some((t) => quoted.test(t))) continue;
    out.push(i.kind === "file"
      ? `the spec keeps ${id} (${i.name}) with a JSON Schema, and no test holds what the job writes to it: in each test that runs a job that writes it, import { checkKept } from "./kept-interfaces.test.mjs" and assert checkKept(jobDir, { expect: ["${id}"] }) deep-equals []`
      : `the spec keeps the message ${id} (${i.name}) with a JSON Schema, and no test holds one to it: import { keptProblems } from "./kept-interfaces.test.mjs" and assert keptProblems("${id}", value) deep-equals [] for the message a test gets`);
  }
  return out;
}

/** Every finding a suite written from the spec can have, in order. */
export function specFindings(files = [], spec = null, opts = {}) {
  if (!isSpecV1(spec)) return [];
  return [...acceptanceFindings(files, spec, opts), ...exactFindings(files, spec, opts), ...keptCallFindings(files, spec, opts)];
}
