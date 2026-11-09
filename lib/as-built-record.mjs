// An as-built record brought from elsewhere (stages.json 1.5.0, the starting
// point as-built-record; lifecycle API 0.4.7): the record of code kept
// somewhere else, brought to build that code again without taking it on, as
// in a rewrite, a port or a clean-room rebuild. The build enters at
// Requirements; nothing is adopted, so Code writes the code fresh.
//
//   recordSourceOf(s)            where the record is, checked: a local folder holding its
//                                files, or a repository with an optional commit and the
//                                path of the record's folder in it
//   readRecordFolder(dir)        the record's files, read and checked: record.json and its
//                                five parts, and any other JSON file the record carries
//                                (such as the output schemas it derived), each passed on whole
//   fetchRecord(source, scratch) the record from a folder, or from a repository cloned into
//                                scratch (removed after), with words for where it was read
//
// The record is the reverse engineer's own shape (agents/reverse-engineer in
// CommonAgent/adlc). Product Factory reads only what the as_built artifact
// summarizes, and hands every file on whole to the spec writer and the test
// writer, so fields the reverse engineer adds later reach them without a
// change here.

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { checkout, short } from "./adopt.mjs";
import { AS_BUILT_FILES } from "./adapters.mjs";

const words = (v) => (typeof v === "string" ? v.trim() : "");
const rel = (base, at) => relative(base, at).split(sep).join("/");
const SKIP = new Set([".git", "node_modules"]);
/** The most other JSON files, and bytes in all, a record may carry beside its six. */
export const EXTRA_FILES_MAX = 100;
export const RECORD_BYTES_MAX = 20 * 1024 * 1024;

/**
 * Where an as-built record is: { folder? | repository?, commit?, path?, shown }.
 * shown is how a person reads where it is. Throws Error with words when it
 * names neither, or both, or a path outside the repository.
 */
export function recordSourceOf(s) {
  const what = "source names the as-built record: a folder on this computer that holds its files, or a repository (with a commit when you want one other than the newest, and the path of the record's folder in it).";
  if (!s || typeof s !== "object" || Array.isArray(s)) throw new Error(what);
  for (const k of ["repository", "folder", "commit", "path"]) if (k in s && typeof s[k] !== "string") throw new Error(`source.${k} is words.`);
  const repository = words(s.repository);
  const folder = words(s.folder);
  const commit = words(s.commit);
  const path = words(s.path).replace(/^\.?\/+|\/+$/g, "");
  if (!repository && !folder) throw new Error(what);
  if (repository && folder) throw new Error("source names a repository or a local folder, not both.");
  if (folder && (commit || path)) throw new Error("A commit and a path go with a repository. For a folder, name the folder that holds the record's files.");
  if (folder) {
    if (!isAbsolute(folder)) throw new Error(`The folder ${folder} is not a full path. Give the folder's full path on this computer.`);
    if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new Error(`There is no folder at ${folder} on this computer.`);
  }
  if (commit && !/^[0-9a-fA-F]{4,64}$|^[\w./-]{1,200}$/.test(commit)) throw new Error("source.commit is a commit, a tag or a branch.");
  if (path && (!/^[\w.-]+(\/[\w.-]+)*$/.test(path) || path.split("/").includes(".."))) throw new Error("source.path is a folder inside the repository, such as as-built.");
  if (folder) return { folder: resolve(folder), shown: resolve(folder) };
  return { repository, ...(commit ? { commit } : {}), ...(path ? { path } : {}), shown: `${repository}${path ? ` (${path})` : ""}` };
}

/** Every JSON file under dir, outside .git and node_modules: paths relative to it, sorted. */
function jsonFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      if (SKIP.has(name)) continue;
      const at = join(d, name);
      const st = statSync(at);
      if (st.isDirectory()) walk(at);
      else if (st.isFile() && name.endsWith(".json")) out.push(rel(dir, at));
    }
  };
  walk(dir);
  return out;
}

/**
 * The record in folder dir: { ok, files: [{ path, bytes }], record, behaviors }
 * or { ok: false, reason } in words. It must hold record.json and its five
 * parts as valid JSON, and record.json must name the repository and commit it
 * describes. Any other JSON file it carries is passed on whole, up to
 * EXTRA_FILES_MAX files and RECORD_BYTES_MAX bytes in all.
 */
export function readRecordFolder(dir, shown = dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return { ok: false, reason: `There is no folder at ${shown} to read an as-built record from.` };
  const missing = AS_BUILT_FILES.filter((n) => !existsSync(join(dir, n)));
  if (missing.length) return { ok: false, reason: `The as-built record at ${shown} has no ${missing.join(", ")}, so it is not whole. An as-built record is record.json and its five parts: behaviors.json, architecture.json, interfaces.json, sbom.cdx.json and tests-and-gaps.json.` };
  const files = [];
  const parsed = {};
  let total = 0;
  for (const name of AS_BUILT_FILES) {
    const bytes = readFileSync(join(dir, name));
    try { parsed[name] = JSON.parse(bytes.toString("utf8")); } catch { return { ok: false, reason: `${name} in the as-built record at ${shown} is not valid JSON.` }; }
    files.push({ path: name, bytes });
    total += bytes.length;
  }
  const record = parsed["record.json"];
  if (!record || typeof record !== "object" || !words(record.repository) || !words(record.commit)) {
    return { ok: false, reason: `record.json in the as-built record at ${shown} does not name the repository and the commit it describes, so it is not tied to its source.` };
  }
  const extra = jsonFiles(dir).filter((p) => !AS_BUILT_FILES.includes(p));
  if (extra.length > EXTRA_FILES_MAX) return { ok: false, reason: `The as-built record at ${shown} carries ${extra.length} JSON files beside its six, more than ${EXTRA_FILES_MAX}. Bring the record's own folder.` };
  for (const p of extra) {
    const bytes = readFileSync(join(dir, ...p.split("/")));
    total += bytes.length;
    files.push({ path: p, bytes });
  }
  if (total > RECORD_BYTES_MAX) return { ok: false, reason: `The as-built record at ${shown} is ${Math.ceil(total / 1024 / 1024)} MB, more than ${RECORD_BYTES_MAX / 1024 / 1024} MB.` };
  const b = parsed["behaviors.json"];
  const behaviors = Array.isArray(b) ? b : Array.isArray(b?.behaviors) ? b.behaviors : [];
  return { ok: true, files, record, behaviors };
}

/**
 * The record a start request names, read: from its folder, or from its
 * repository cloned into scratch (a folder that must not exist yet; removed
 * after). Resolves to readRecordFolder's answer with words saying where it
 * was read, and commit, the record repository's commit, for a repository.
 */
export async function fetchRecord(source, scratch, { env = process.env, signal } = {}) {
  if (source.folder) {
    const got = readRecordFolder(source.folder, source.shown);
    return got.ok ? { ...got, words: `Read the as-built record in ${source.folder}.` } : got;
  }
  try {
    const c = await checkout({ repository: source.repository, ...(source.commit ? { commit: source.commit } : {}), shown: source.repository }, scratch, { env, signal });
    if (!c.ok) return { ok: false, reason: c.reason };
    const at = source.path ? join(scratch, ...source.path.split("/")) : scratch;
    const got = readRecordFolder(at, source.shown);
    return got.ok ? { ...got, commit: c.commit, words: `Read the as-built record from ${source.repository} at ${short(c.commit)}${source.path ? `, in ${source.path}` : ""}.` } : got;
  } finally {
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* left for the next start to overwrite */ }
  }
}
