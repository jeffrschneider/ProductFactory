// What the agent declares to the platform, as the spec keeps it, and whether
// the agent's own files say the same.
//
// spec-v1 1.1.0 keeps every name and value an agent declares (an offering's
// id, a step's id, an output's name and kind, a label, a run-config setting,
// a run command) as an interface of kind declaration: its value, and where
// it is declared, such as "agent-descriptor.json offerings[0].outputs[1].name".
// The reverse engineer 0.3.0 writes one for each, from the agent's own files.
// The Design writes those files from the spec, by code (structure.mjs), and
// this file holds the two things that need no model:
//
//   - parseDeclaredIn and valueAt: where a declaration points, as a file and
//     a path into it, and what is there;
//   - declarationProblems: every kept declaration whose value is not at its
//     place in the files, as sentences. Empty when the files agree with the
//     spec. A declaration of the product's own name or version is left to the
//     spec's product, which a revision changes on purpose.
//
//   needs: node >= 22. Nothing here reads or writes a file.
//   import { parseDeclaredIn, valueAt, declarationsOf, declarationProblems } from "./declared.mjs"

const trim = (s) => String(s ?? "").trim();
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The files a declaration may point into. */
export const DECLARED_FILES = ["agent-descriptor.json", "agent-runtime-requirements.json", "plugin.json"];

/** Where a declaration points: { file, path, text }, the path a list of keys
 *  and indexes. "agent-descriptor.json offerings[0].outputs[1].name" is the
 *  file agent-descriptor.json and the path offerings, 0, outputs, 1, name. A
 *  key with a dot in it is written in brackets and quotes: extensions
 *  ["net.agentdoc.package"].build. Null when it is not in that form. */
export function parseDeclaredIn(text) {
  const t = trim(text);
  const m = /^(\S+)\s+(.+)$/.exec(t);
  if (!m) return null;
  const file = m[1];
  const path = [];
  const rest = m[2].trim();
  const re = /\["([^"]+)"\]|\[(\d+)\]|\.?([^.[\]\s]+)/gy;
  let at = 0;
  for (let g; at < rest.length && (g = re.exec(rest));) {
    if (g[1] !== undefined) path.push(g[1]);
    else if (g[2] !== undefined) path.push(Number(g[2]));
    else path.push(g[3]);
    at = re.lastIndex;
  }
  if (at !== rest.length || !path.length) return null;
  return { file, path, text: t };
}

/** The value at a path in a document, or undefined. */
export function valueAt(doc, path) {
  let v = doc;
  for (const k of path) {
    if (v === null || typeof v !== "object") return undefined;
    v = v[k];
  }
  return v;
}

/** A path written back as text: offerings[0].outputs[1].name. */
export const pathText = (path) => path.map((k, i) => (typeof k === "number" ? `[${k}]` : /[.[\]\s]/.test(k) ? `["${k}"]` : `${i ? "." : ""}${k}`)).join("");

/** The product's own name and version, wherever a declaration of them sits:
 *  the spec's product carries them, and a revision changes them on purpose. */
export function isProductField(where) {
  if (!where) return false;
  const p = pathText(where.path);
  return (where.file === "agent-descriptor.json" && (p === "agent_version" || p === "agent")) || (where.file === "plugin.json" && (p === "name" || p === "version"));
}

/** The spec's kept declarations, each with where it points. A declaration
 *  whose declared_in is not in the form is returned with where null, so the
 *  check can say so. */
export function declarationsOf(spec) {
  return list(spec?.interfaces)
    .filter((i) => isObj(i) && trim(i.kind) === "declaration" && i.keep !== false && "value" in i)
    .map((i) => ({ id: trim(i.id), name: trim(i.name), value: i.value, declared_in: trim(i.declared_in), where: parseDeclaredIn(i.declared_in) }));
}

/** Each kept declaration of the spec whose value is not at its place in the
 *  agent's own files ({rel: text}), as sentences. A file that is not JSON,
 *  or not there, is said once per declaration that points into it. */
export function declarationProblems(spec, files = {}) {
  const out = [];
  const docs = new Map();
  const docOf = (file) => {
    if (docs.has(file)) return docs.get(file);
    let d;
    try { d = typeof files[file] === "string" ? JSON.parse(files[file]) : undefined; } catch { d = undefined; }
    docs.set(file, d);
    return d;
  };
  for (const d of declarationsOf(spec)) {
    if (!d.where) { out.push(`interface ${d.id} declares ${JSON.stringify(d.value)} at ${JSON.stringify(d.declared_in)}, which is not a file and a place in it (such as agent-descriptor.json offerings[0].id)`); continue; }
    if (isProductField(d.where)) continue;
    const doc = docOf(d.where.file);
    if (doc === undefined) { out.push(`interface ${d.id} declares ${JSON.stringify(d.value)} at ${d.declared_in}, and the agent's files have no ${d.where.file}`); continue; }
    const got = valueAt(doc, d.where.path);
    if (!same(got, d.value)) out.push(`interface ${d.id} keeps ${d.declared_in} as ${JSON.stringify(d.value)}, and the agent's files say ${got === undefined ? "nothing there" : JSON.stringify(got)}; the files say what the spec keeps`);
  }
  return out;
}

/** The run-config settings an as-built record's declarations give, by name:
 *  each agent-descriptor.json run_config.settings[n] declaration grouped by
 *  n, keyed by the name declared at n. */
export function declaredSettingsIn(declarations = []) {
  const byIndex = new Map();
  for (const d of declarations) {
    const w = d?.where ?? parseDeclaredIn(d?.declared_in);
    if (!w || w.file !== "agent-descriptor.json" || w.path[0] !== "run_config" || w.path[1] !== "settings" || typeof w.path[2] !== "number" || w.path.length !== 4) continue;
    const at = byIndex.get(w.path[2]) ?? {};
    at[w.path[3]] = d.value;
    byIndex.set(w.path[2], at);
  }
  const out = new Map();
  for (const s of byIndex.values()) if (typeof s.name === "string" && trim(s.name)) out.set(trim(s.name), s);
  return out;
}
