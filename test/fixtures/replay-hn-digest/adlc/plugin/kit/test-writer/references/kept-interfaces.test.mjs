// The interfaces the spec says must be kept exactly are kept.
// Written by the test writer into every suite whose spec keeps an interface
// (keep: true), made from the spec by code and never by a model: KEPT below is
// the spec's kept interfaces, copied in, and the rest of the file is the same
// bytes in every suite. It is the test writer's file and not the package's, so
// it is never edited here. The next suite the test writer writes for this
// package brings its current copy.
//   node --test test/kept-interfaces.test.mjs
//
// What is worth pinning. A spec keeps an interface when a dependent relies on
// it or a rebuild must match the code it replaces: a function other code
// imports, a command a runner calls with its flags, a file another program
// reads. A rebuild that renames the function, makes it async when it was not,
// drops a flag or changes a file's shape breaks whoever relied on it, and no
// test written from the behaviors alone notices. So, for each one, named by
// the interface's id ("[I4] ..."):
//   - a function is exported under that exact name from that module, and is
//     async when its signature says async (or returns a Promise) and not
//     otherwise;
//   - a command, run with each of its flags, does not refuse one as unknown
//     and does not stop as a usage error (exit 2);
//   - a constant is exported from its module with exactly the value the spec
//     keeps (a regular expression is compared by its written form, /a+/i,
//     or its source), and anything else as JSON;
//   - a declaration, a name or value the agent declares to the platform
//     (an offering id, a step id, an output's name, a label, a setting), is
//     at exactly the place the spec says it is declared, with exactly its
//     value: "agent-descriptor.json offerings[0].outputs[1].name" is read
//     from the package's top, by members, [n], ["name"] and [id=x];
//   - a file or a message is held to the JSON Schema the spec keeps for it.
//     The suite's other tests call checkKept(jobDir, { expect: ["I5"] }) on
//     each job folder whose job writes the file, and keptProblems("I6", value)
//     on a message, and assert each returns []. This file's own test for a
//     file checks each job folder kept as an example under
//     test/fixtures/delivered/ or a folder DELIVERED names, as
//     delivered-formats.test.mjs does.
//
// How it is reached. A function's module is read from the package's top, and
// a module the packed layout puts under skills/<job>/scripts/ is read from
// scripts/ here. A command is the script its name or module names, else the
// job command in agent-runtime-requirements.json that carries every one of
// its flags; each flag is given an empty folder made for it (an empty file
// when its name says file), the model settings are left out, and it runs with
// a time limit. The JSON Schema reading covers type, enum, const, properties,
// required, additionalProperties, items, prefixItems, the length, size and
// range keywords, pattern, allOf, anyOf, oneOf, not and $ref within the
// schema; any other keyword is not read, and the test writer says which, per
// interface, beside the suite.
//
// Nothing here touches a network or a model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const trim = (s) => String(s ?? "").trim();

/** The spec these interfaces were copied from. */
export const FROM = null;

/** The interfaces the spec keeps, as the test writer copied them: id, kind,
 *  name, and module, signature, flags or schema as the spec gives them; test
 *  is the name of this file's test for it, or null when it has none, and
 *  held_by names the function the suite's other tests hold it with. */
export const KEPT = [];

/** The longest one command here may run, in seconds. */
export const RUN_SECONDS = 60;
/** The settings a job reaches a model through; never handed to a command here. */
export const MODEL_SETTINGS = ["MODEL_NAME", "MODEL_ENDPOINT", "MODEL_KEY", "MODEL_PROTOCOL", "AGENT_MODEL", "TEXT_MODEL"];

// ── a JSON Schema, read ─────────────────────────────────────────────────────

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v);
const fitsType = (v, t) => t === typeOf(v) || (t === "number" && typeOf(v) === "integer");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The keywords this reading holds a value to, and the ones that only
 *  describe it. Any other keyword is not read. */
export const READ = ["type", "enum", "const", "properties", "required", "additionalProperties", "items", "prefixItems", "additionalItems",
  "minItems", "maxItems", "uniqueItems", "minLength", "maxLength", "pattern", "minimum", "maximum", "exclusiveMinimum",
  "exclusiveMaximum", "multipleOf", "minProperties", "maxProperties", "allOf", "anyOf", "oneOf", "not", "$ref"];
export const DESCRIBES = ["$schema", "$id", "$defs", "definitions", "$comment", "title", "description", "default", "examples",
  "format", "deprecated", "readOnly", "writeOnly", "contentMediaType", "contentEncoding"];

/** The keywords anywhere in a schema that this reading does not hold a value
 *  to, once each, in the order found. */
export function unreadKeywords(schema) {
  const out = [];
  const walk = (s) => {
    if (!s || typeof s !== "object") return;
    if (Array.isArray(s)) { s.forEach(walk); return; }
    for (const [k, v] of Object.entries(s)) {
      if (!READ.includes(k) && !DESCRIBES.includes(k) && !out.includes(k)) out.push(k);
      if (["properties", "$defs", "definitions"].includes(k) && v && typeof v === "object") Object.values(v).forEach(walk);
      else if (["items", "additionalProperties", "not"].includes(k)) walk(v);
      else if (["prefixItems", "allOf", "anyOf", "oneOf"].includes(k)) (Array.isArray(v) ? v : []).forEach(walk);
    }
  };
  walk(schema);
  return out;
}

/** The schema a $ref within the root names: "#", "#/$defs/x", "#/definitions/x". */
function refOf(root, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#")) return undefined;
  let at = root;
  for (const part of ref.slice(1).split("/").filter(Boolean)) {
    const key = decodeURIComponent(part.replace(/~1/g, "/").replace(/~0/g, "~"));
    if (!at || typeof at !== "object" || !(key in at)) return undefined;
    at = at[key];
  }
  return at;
}

/** Every way a value is not what a JSON Schema says, as sentences naming
 *  where in the value; [] when it is. */
export function valueProblems(value, schema, { root = schema, at = "the value", depth = 0 } = {}) {
  if (schema === true || schema === undefined || schema === null) return [];
  if (schema === false) return [`${at} is not allowed here`];
  if (typeof schema !== "object" || depth > 64) return [];
  const out = [];
  if (typeof schema.$ref === "string") {
    const target = refOf(root, schema.$ref);
    if (target !== undefined) out.push(...valueProblems(value, target, { root, at, depth: depth + 1 }));
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => fitsType(value, t))) return [...out, `${at} is ${typeOf(value)}, and the schema says ${types.join(" or ")}`];
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => same(e, value))) out.push(`${at} is ${JSON.stringify(value)}, not one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  if ("const" in schema && !same(schema.const, value)) out.push(`${at} is ${JSON.stringify(value)}, and the schema says ${JSON.stringify(schema.const)}`);
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && [...value].length < schema.minLength) out.push(`${at} is shorter than ${schema.minLength} characters`);
    if (typeof schema.maxLength === "number" && [...value].length > schema.maxLength) out.push(`${at} is longer than ${schema.maxLength} characters`);
    if (typeof schema.pattern === "string") {
      let re = null;
      try { re = new RegExp(schema.pattern, "u"); } catch { try { re = new RegExp(schema.pattern); } catch { re = null; } }
      if (re && !re.test(value)) out.push(`${at} is ${JSON.stringify(value)}, which does not match the pattern ${schema.pattern}`);
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) out.push(`${at} is ${value}, below the minimum ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) out.push(`${at} is ${value}, above the maximum ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) out.push(`${at} is ${value}, not above ${schema.exclusiveMinimum}`);
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) out.push(`${at} is ${value}, not below ${schema.exclusiveMaximum}`);
    if (typeof schema.multipleOf === "number" && schema.multipleOf > 0 && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-9) out.push(`${at} is ${value}, not a multiple of ${schema.multipleOf}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) out.push(`${at} has ${value.length} items, fewer than ${schema.minItems}`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) out.push(`${at} has ${value.length} items, more than ${schema.maxItems}`);
    if (schema.uniqueItems === true && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) out.push(`${at} holds the same item twice`);
    const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : Array.isArray(schema.items) ? schema.items : [];
    prefix.forEach((s, i) => { if (i < value.length) out.push(...valueProblems(value[i], s, { root, at: `${at}[${i}]`, depth: depth + 1 })); });
    const rest = Array.isArray(schema.items) ? schema.additionalItems : schema.items;
    if (rest !== undefined) for (let i = prefix.length; i < value.length; i += 1) out.push(...valueProblems(value[i], rest, { root, at: `${at}[${i}]`, depth: depth + 1 }));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    for (const k of Array.isArray(schema.required) ? schema.required : []) if (!(k in value)) out.push(`${at} has no ${k}, which the schema requires`);
    if (typeof schema.minProperties === "number" && keys.length < schema.minProperties) out.push(`${at} has fewer than ${schema.minProperties} members`);
    if (typeof schema.maxProperties === "number" && keys.length > schema.maxProperties) out.push(`${at} has more than ${schema.maxProperties} members`);
    const props = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    for (const k of keys) {
      if (k in props) out.push(...valueProblems(value[k], props[k], { root, at: `${at}.${k}`, depth: depth + 1 }));
      else if (schema.additionalProperties === false) out.push(`${at} has ${k}, which the schema does not allow`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") out.push(...valueProblems(value[k], schema.additionalProperties, { root, at: `${at}.${k}`, depth: depth + 1 }));
    }
  }
  for (const s of Array.isArray(schema.allOf) ? schema.allOf : []) out.push(...valueProblems(value, s, { root, at, depth: depth + 1 }));
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((s) => !valueProblems(value, s, { root, at, depth: depth + 1 }).length)) out.push(`${at} fits none of the shapes the schema allows (anyOf)`);
  if (Array.isArray(schema.oneOf)) {
    const n = schema.oneOf.filter((s) => !valueProblems(value, s, { root, at, depth: depth + 1 }).length).length;
    if (n !== 1) out.push(`${at} fits ${n} of the shapes the schema allows one of (oneOf)`);
  }
  if (schema.not !== undefined && !valueProblems(value, schema.not, { root, at, depth: depth + 1 }).length) out.push(`${at} is a shape the schema rules out (not)`);
  return out;
}

// ── files and messages ──────────────────────────────────────────────────────

/** The kept interface by its id, or null. */
export const keptById = (id) => KEPT.find((i) => i.id === id) ?? null;

/** Whether a file or message is to be read as JSON: its name ends .json, or
 *  its schema is for an object or a list. */
const isJson = (i) => /\.json$/i.test(trim(i.name)) || ["object", "array"].includes(i.schema?.type) || Boolean(i.schema?.properties);

/** A kept file's name as a path inside a job folder: placeholders and a
 *  leading ./ taken off. */
export const relativeName = (name) => trim(name).replace(/\\/g, "/").replace(/^(?:\{[a-z_]+\}|<[^>]+>|\*)\//, "").replace(/^\.\//, "");

/** Every file under a folder whose path ends with the kept file's name, the
 *  shallower first. */
export function filesNamed(folder, name, { depth = 6 } = {}) {
  const rel = relativeName(name);
  if (!rel || !folder || !existsSync(folder)) return [];
  const out = [];
  const walk = (dir, d, prefix) => {
    if (d > depth) return;
    let names = [];
    try { names = readdirSync(dir).sort(); } catch { return; }
    for (const n of names) {
      const at = join(dir, n);
      const p = prefix ? `${prefix}/${n}` : n;
      let st;
      try { st = statSync(at); } catch { continue; }
      if (st.isDirectory()) { if (n !== "node_modules" && n !== ".git") walk(at, d + 1, p); }
      else if (p === rel || p.endsWith(`/${rel}`) || (!rel.includes("/") && n === rel)) out.push({ path: at, rel: p });
    }
  };
  walk(folder, 0, "");
  return out.sort((a, b) => a.rel.split("/").length - b.rel.split("/").length);
}

/** What is wrong with one value of a kept file or message, as sentences. A
 *  string is read as JSON when the interface is JSON. */
export function keptProblems(id, value) {
  const i = keptById(id);
  if (!i) return [`${id} is not an interface the spec keeps`];
  if (i.schema === undefined) return [];
  let v = value;
  if (Buffer.isBuffer(v)) v = v.toString("utf8");
  if (typeof v === "string" && isJson(i)) {
    try { v = JSON.parse(v); } catch (e) { return [`[${i.id}] ${i.name} does not parse as JSON: ${e.message}`]; }
  }
  return valueProblems(v, i.schema, { at: `[${i.id}] ${i.name}` });
}

/** Every kept file under a folder that is not what its schema says, as
 *  sentences: each file interface with a schema, wherever under the folder a
 *  file of its name is. An id in expect is one the folder must hold. */
export function checkKept(folder, { expect = [] } = {}) {
  const out = [];
  for (const id of expect) {
    const i = keptById(id);
    if (!i) out.push(`${id} is not an interface the spec keeps`);
    else if (i.kind !== "file") out.push(`[${id}] ${i.name} is a ${i.kind}, not a file: hold it with keptProblems("${id}", value)`);
  }
  for (const i of KEPT) {
    if (i.kind !== "file" || i.schema === undefined) continue;
    const found = filesNamed(folder, i.name);
    if (!found.length) {
      if (expect.includes(i.id)) out.push(`[${i.id}] the job wrote no ${relativeName(i.name)} under ${folder}`);
      continue;
    }
    for (const f of found) out.push(...keptProblems(i.id, readFileSync(f.path)).map((p) => `${p} (${f.rel})`));
  }
  return out;
}

/** The job folders kept as examples, as delivered-formats.test.mjs finds them. */
export function exampleFolders(env = process.env, here = HERE) {
  const roots = [join(here, "fixtures", "delivered"), ...trim(env.DELIVERED).split(delimiter).filter(Boolean)];
  const out = [];
  for (const r of roots) {
    if (!existsSync(r) || !statSync(r).isDirectory()) continue;
    if (existsSync(join(r, "pieces.json"))) out.push(r);
    for (const n of readdirSync(r)) if (existsSync(join(r, n, "pieces.json"))) out.push(join(r, n));
  }
  return out;
}

// ── functions ───────────────────────────────────────────────────────────────

/** Where a module the spec names is in this package: from its top, or, for a
 *  path the packed layout puts under skills/<job>/, from scripts/. Null when
 *  it is not here. */
export function moduleAt(module, root = ROOT) {
  const m = trim(module).replace(/\\/g, "/").replace(/^(?:\{[a-z_]+\}\/)+/, "").replace(/^\.\//, "");
  if (!m) return null;
  const tries = [join(root, m)];
  const packed = /^skills\/[^/]+\/(.+)$/.exec(m);
  if (packed) tries.push(join(root, packed[1]));
  tries.push(join(root, "scripts", basename(m)));
  return tries.find((p) => existsSync(p) && statSync(p).isFile()) ?? null;
}

/** Whether a signature says the function is async: the word async, or a
 *  Promise it returns. */
export const saysAsync = (signature) => /\basync\b|\bPromise\b/.test(String(signature ?? ""));
/** Whether a function is async as JavaScript makes it. */
export const isAsync = (fn) => ["AsyncFunction", "AsyncGeneratorFunction"].includes(fn?.constructor?.name);

// ── constants and declarations ──────────────────────────────────────────────

/** A value as the spec keeps it, as JSON; a regular expression as its
 *  written form. */
export const asKept = (v) => {
  if (v instanceof RegExp) return String(v);
  if (v === undefined || typeof v === "function") return v;
  try { return JSON.parse(JSON.stringify(v)); } catch { return v; }
};

/** Whether what a module exports is exactly the value the spec keeps: a
 *  regular expression whose written form or source is the kept words, or the
 *  same JSON. */
export function sameKept(got, want) {
  if (got instanceof RegExp && typeof want === "string") return String(got) === want || got.source === want;
  return isDeepStrictEqual(asKept(got), want);
}

/** Where a declaration is: the file, then the place in it. The same reading
 *  as the test writer's (scripts/kept-interfaces.mjs placeOf). */
export function placeOf(declaredIn) {
  const t = trim(declaredIn);
  const m = /^(\S+)(?:\s+(.*))?$/.exec(t);
  if (!m) return { file: "", parts: [], why: null };
  const file = m[1].replace(/\\/g, "/").replace(/^\.\//, "");
  if (!/\.json$/i.test(file)) return { file, parts: [], why: `${file} is not a JSON file` };
  const parts = [];
  let rest = trim(m[2]);
  while (rest) {
    let p;
    if ((p = /^\.?([A-Za-z_$][\w$-]*)/.exec(rest))) parts.push({ key: p[1] });
    else if ((p = /^\[(\d+)\]/.exec(rest))) parts.push({ index: Number(p[1]) });
    else if ((p = /^\[\s*(["'])((?:(?!\1).)*)\1\s*\]/.exec(rest))) parts.push({ key: p[2] });
    else if ((p = /^\[\s*([A-Za-z_$][\w$-]*)\s*=\s*(["']?)([^\]"']*)\2\s*\]/.exec(rest))) parts.push({ where: p[1], is: p[3] });
    else return { file, parts, why: `the place ${JSON.stringify(trim(m[2]))} is not one this check reads` };
    rest = rest.slice(p[0].length);
  }
  return { file, parts, why: null };
}

/** What the agent's files carry at a declaration's place: { found, value,
 *  why }; why says where the reading stopped. */
export function declaredAt(declaredIn, root = ROOT) {
  const place = placeOf(declaredIn);
  if (!place.file) return { found: false, why: "no file is named" };
  if (place.why) return { found: false, why: place.why };
  const at = join(root, place.file);
  if (!existsSync(at)) return { found: false, why: `${place.file} is not in the package` };
  let v;
  try { v = JSON.parse(readFileSync(at, "utf8")); } catch (e) { return { found: false, why: `${place.file} does not parse as JSON: ${e.message}` }; }
  let said = place.file;
  for (const p of place.parts) {
    if (p.index !== undefined) {
      if (!Array.isArray(v) || p.index >= v.length) return { found: false, why: `${said} has no item [${p.index}]` };
      v = v[p.index]; said += `[${p.index}]`;
    } else if (p.where !== undefined) {
      const hit = Array.isArray(v) ? v.find((x) => x && typeof x === "object" && String(x[p.where]) === p.is) : undefined;
      if (hit === undefined) return { found: false, why: `${said} has no item whose ${p.where} is ${p.is}` };
      v = hit; said += `[${p.where}=${p.is}]`;
    } else {
      if (!v || typeof v !== "object" || Array.isArray(v) || !(p.key in v)) return { found: false, why: `${said} has no ${p.key}` };
      v = v[p.key]; said += `.${p.key}`;
    }
  }
  return { found: true, value: v };
}

// ── commands ────────────────────────────────────────────────────────────────

/** A flag as given on a command line: "--job <folder>" is --job. */
export const flagOf = (f) => {
  const t = trim(f).split(/[\s=]/)[0];
  return t.startsWith("-") ? t : `--${t}`;
};

/** The script a kept command runs, in this package: one its name or module
 *  names, else the one a job command in agent-runtime-requirements.json runs
 *  when that command carries every one of its flags. Null when none is. */
export function commandScript(i, root = ROOT) {
  for (const s of [i.module, i.name]) {
    const m = /(?:^|\s)((?:\{[a-z_]+\}\/|[\w.-]+\/)*[\w.-]+\.(?:m|c)?js)\b/.exec(trim(s));
    const at = m ? moduleAt(m[1], root) : null;
    if (at) return at;
  }
  let decl = null;
  for (const f of ["agent-runtime-requirements.json", "install.json"]) {
    const at = join(root, f);
    if (existsSync(at)) { try { decl = JSON.parse(readFileSync(at, "utf8")); } catch { decl = null; } break; }
  }
  const flags = (i.flags ?? []).map(flagOf);
  const runs = decl?.run && typeof decl.run === "object" ? Object.values(decl.run) : [];
  for (const r of runs) {
    const argv = Array.isArray(r?.command) ? r.command.map(String) : [];
    if (!flags.every((f) => argv.includes(f))) continue;
    const script = argv.find((a) => /\.(?:m|c)?js$/.test(a));
    const at = script ? moduleAt(script.replace(/^(?:\{[a-z_]+\}\/)+/, ""), root) : null;
    if (at) return at;
  }
  return null;
}

/** The command run once with each of its flags given an empty folder (or an
 *  empty file, when the flag's name says file), with no model settings, in
 *  folders made for it. What it said and how it ended. */
export function runWithFlags(i, script) {
  const scratch = mkdtempSync(join(tmpdir(), "kept-interfaces-"));
  try {
    const argv = [script];
    for (const f of (i.flags ?? []).map(flagOf)) {
      const at = join(scratch, f.replace(/^-+/, "") || "value");
      if (/file/i.test(f)) writeFileSync(at, "");
      else mkdirSync(at, { recursive: true });
      argv.push(f, at);
    }
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith("NODE_TEST_") || MODEL_SETTINGS.includes(k)) delete env[k];
    const home = join(scratch, "home");
    mkdirSync(home, { recursive: true });
    const r = spawnSync(process.execPath, argv, { cwd: home, env: { ...env, HOME: home }, encoding: "utf8", timeout: RUN_SECONDS * 1000, maxBuffer: 32 * 1024 * 1024 });
    const timedOut = r.error?.code === "ETIMEDOUT" || (r.status === null && !!r.signal);
    return { status: r.status, timedOut, said: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Why a run refused a command's flags, as sentences; [] when it took them. */
export function flagProblems(i, run) {
  const out = [];
  if (run.timedOut) return [`[${i.id}] ${i.name} did not finish in ${RUN_SECONDS} seconds when run with its flags`];
  if (run.status === 2) out.push(`[${i.id}] ${i.name} stopped with exit 2, a usage error, when given every flag the spec keeps: ${trim(run.said).slice(0, 300)}`);
  for (const f of (i.flags ?? []).map(flagOf)) {
    const e = escapeRe(f);
    const refused = new RegExp(`(?:unknown|unrecogni[sz]ed|unexpected|invalid|unsupported)[^\\n]{0,40}${e}(?![\\w-])|${e}(?![\\w-])[^\\n]{0,40}(?:is not (?:a |an )?(?:known |valid )?(?:flag|option|argument)|unknown|unrecogni[sz]ed|not accepted)`, "i");
    if (refused.test(run.said)) out.push(`[${i.id}] ${i.name} refused ${f}, which the spec keeps`);
  }
  return out;
}

// ── the tests ───────────────────────────────────────────────────────────────

// The tests run when this file is run, as node --test runs each suite file;
// importing a function from it adds none.
const ranDirectly = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
for (const i of ranDirectly ? KEPT : []) {
  if (!i.test) continue;
  if (i.kind === "function") {
    test(i.test, async () => {
      const at = moduleAt(i.module);
      assert.ok(at, `[${i.id}] ${i.module} is not in the package, and the spec keeps ${i.name} exported from it`);
      const mod = await import(pathToFileURL(at).href);
      assert.equal(typeof mod[i.name], "function", `[${i.id}] ${i.module} does not export a function named ${i.name}, and the spec keeps it`);
      if (i.signature !== undefined) {
        assert.equal(isAsync(mod[i.name]), saysAsync(i.signature),
          `[${i.id}] ${i.name} is ${isAsync(mod[i.name]) ? "async" : "not async"}, and its signature as the spec keeps it, ${JSON.stringify(i.signature)}, says it is ${saysAsync(i.signature) ? "async" : "not"}`);
      }
    });
  } else if (i.kind === "constant") {
    test(i.test, async () => {
      const at = moduleAt(i.module);
      assert.ok(at, `[${i.id}] ${i.module} is not in the package, and the spec keeps ${i.name} exported from it`);
      const mod = await import(pathToFileURL(at).href);
      assert.ok(i.name in mod, `[${i.id}] ${i.module} does not export ${i.name}, and the spec keeps it`);
      assert.ok(sameKept(mod[i.name], i.value),
        `[${i.id}] ${i.name} is ${JSON.stringify(asKept(mod[i.name]))}, and the spec keeps it as exactly ${JSON.stringify(i.value)}`);
    });
  } else if (i.kind === "declaration") {
    test(i.test, () => {
      const got = declaredAt(i.declared_in);
      assert.ok(got.found, `[${i.id}] ${i.name} is not at ${i.declared_in}: ${got.why}`);
      assert.deepEqual(got.value, i.value, `[${i.id}] ${i.name} at ${i.declared_in} is ${JSON.stringify(got.value)}, and the spec keeps it as exactly ${JSON.stringify(i.value)}`);
    });
  } else if (i.kind === "command") {
    test(i.test, () => {
      const script = commandScript(i);
      assert.ok(script, `[${i.id}] the script ${i.name} runs is not in the package, by its name, its module, or a job command in agent-runtime-requirements.json carrying ${(i.flags ?? []).map(flagOf).join(", ")}`);
      assert.deepEqual(flagProblems(i, runWithFlags(i, script)), []);
    });
  } else if (i.kind === "file") {
    test(i.test, (t) => {
      const folders = exampleFolders();
      if (!folders.length) { t.skip("no job folder kept as an example under test/fixtures/delivered and none named by DELIVERED; the suite's tests hold what each job writes with checkKept"); return; }
      for (const d of folders) assert.deepEqual(checkKept(d), [], d);
    });
  }
}
