// Existing code (stages.json 1.4.0, the starting point existing-code): where
// a codebase comes from, the commit a build knows it at, whether the code has
// moved since, and how Code adopts it as the first version of the scripts.
//
//   sourceOf(req)               the codebase a start request names, checked: a repository
//                               (a git URL or owner/name) with an optional commit, or a
//                               local folder
//   checkout(source, into)      the codebase at its commit, copied into a folder of the
//                               build's: cloned with git (a repository, or a folder that
//                               is a git repository), or copied (a folder that is not),
//                               whose commit is then sha256 over its files
//   currentCommit(source)       the codebase's commit now, to see drift
//   adoptable(code, named)      whether the code can be the scripts of an Agent Package:
//                               Node scripts, at the paths the spec names, or why not
//   adoptInto(folder, code, plan)   the code's scripts placed in the build folder
//
// Product Factory adopts agents only. Code that is not Node scripts (Python, Go,
// a web service) cannot be packaged as an agent, and Code says so in words.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { run, tail } from "./exec.mjs";

const words = (v) => (typeof v === "string" ? v.trim() : "");
const rel = (base, at) => relative(base, at).split(sep).join("/");
export const short = (c) => (String(c ?? "").startsWith("sha256:") ? String(c).slice(0, 19) : String(c ?? "").slice(0, 7));
const SKIP = new Set([".git", "node_modules", ".adlc"]);
const JS = new Set([".js", ".mjs", ".cjs"]);
const LANGUAGE = { ".py": "Python", ".go": "Go", ".java": "Java", ".kt": "Kotlin", ".rb": "Ruby", ".rs": "Rust", ".cs": "C#", ".php": "PHP", ".ts": "TypeScript", ".tsx": "TypeScript", ".swift": "Swift", ".c": "C", ".cpp": "C++", ".scala": "Scala", ".ex": "Elixir", ".sh": "shell" };

/** A git URL for a repository the person named: owner/name means GitHub. */
export function urlOf(repository) {
  const r = words(repository);
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r) ? `https://github.com/${r}.git` : r;
}

/**
 * The codebase a start request names: { repository?, folder?, commit?, shown }
 * where shown is how a person reads where it is. Throws Error with words when
 * it names none, or both.
 */
export function sourceOf(s) {
  if (!s || typeof s !== "object" || Array.isArray(s)) throw new Error("source names the codebase: a repository (and a commit when you want one other than the newest), or a local folder.");
  for (const k of ["repository", "folder", "commit"]) if (k in s && typeof s[k] !== "string") throw new Error(`source.${k} is words.`);
  const repository = words(s.repository);
  const folder = words(s.folder);
  const commit = words(s.commit);
  if (!repository && !folder) throw new Error("source names the codebase: a repository (and a commit when you want one other than the newest), or a local folder.");
  if (repository && folder) throw new Error("source names a repository or a local folder, not both.");
  if (folder) {
    if (!isAbsolute(folder)) throw new Error(`The folder ${folder} is not a full path. Give the folder's full path on this computer.`);
    if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new Error(`There is no folder at ${folder} on this computer.`);
  }
  if (commit && !/^[0-9a-fA-F]{4,64}$|^[\w./-]{1,200}$/.test(commit)) throw new Error("source.commit is a commit, a tag or a branch.");
  return { ...(repository ? { repository } : {}), ...(folder ? { folder: resolve(folder) } : {}), ...(commit ? { commit } : {}), shown: repository || resolve(folder) };
}

const isGitFolder = (folder) => existsSync(join(folder, ".git"));
const gitEnv = (env) => ({ ...env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", GCM_INTERACTIVE: "never" });
const git = (args, { cwd, env = process.env, signal, timeoutMs = 5 * 60 * 1000 } = {}) => run(["git", ...args], { cwd, env: gitEnv(env), signal, timeoutMs });
const gitWords = (r, what) => (r.error ? `git could not run: ${r.error}. Product Factory reads codebases with git, so it needs git on this computer.` : r.timedOut ? `${what} did not finish in time.` : `${what} failed: ${tail(r.stderr || r.stdout, 400) || `git ended with code ${r.code}`}`);

/** Every file under dir that is code, not tooling: paths relative to it, sorted. */
export function codeFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      if (SKIP.has(name)) continue;
      const at = join(d, name);
      const st = statSync(at);
      if (st.isDirectory()) walk(at); else if (st.isFile()) out.push(rel(dir, at));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/** sha256 over a folder's files, paths and bytes, as the commit of a folder that is not a git repository. */
export function treeDigest(dir) {
  const h = createHash("sha256");
  for (const p of codeFiles(dir)) { h.update(`${p}\0`); h.update(readFileSync(join(dir, p))); h.update("\0"); }
  return `sha256:${h.digest("hex")}`;
}

/**
 * The codebase at its commit, in the folder into (which must not exist yet, or
 * be empty). Resolves to { ok, commit, words } or { ok: false, reason }.
 */
export async function checkout(source, into, { env = process.env, signal } = {}) {
  mkdirSync(dirname(into), { recursive: true });
  if (source.folder && !isGitFolder(source.folder)) {
    if (source.commit) return { ok: false, reason: `The folder ${source.folder} is not a git repository, so it has no commit ${source.commit} to read. Leave the commit out to take the folder as it is.` };
    cpSync(source.folder, into, { recursive: true, filter: (from) => !SKIP.has(basename(from)) || resolve(from) === resolve(source.folder) });
    const commit = treeDigest(into);
    return { ok: true, commit, words: `Copied the folder ${source.folder} as it is now (${short(commit)}); it is not a git repository, so its commit is a digest of its files.` };
  }
  const from = source.folder ?? urlOf(source.repository);
  const c = await git(["clone", "--quiet", "--no-checkout", from, into], { env, signal });
  if (c.code !== 0) return { ok: false, reason: gitWords(c, `Cloning ${source.shown}`) };
  const want = source.commit || "HEAD";
  const r = await git(["-C", into, "rev-parse", "--verify", "--quiet", `${want}^{commit}`], { env, signal, timeoutMs: 60_000 });
  const alt = r.code === 0 ? r : await git(["-C", into, "rev-parse", "--verify", "--quiet", `origin/${want}^{commit}`], { env, signal, timeoutMs: 60_000 });
  if (alt.code !== 0) return { ok: false, reason: `${source.shown} has no commit ${want}.` };
  const commit = alt.stdout.trim();
  const co = await git(["-C", into, "checkout", "--quiet", "--detach", commit], { env, signal });
  if (co.code !== 0) return { ok: false, reason: gitWords(co, `Checking out ${short(commit)}`) };
  return { ok: true, commit, words: `Read ${source.shown} at ${short(commit)}.` };
}

/**
 * The codebase's commit now: { ok, commit } or { ok: false, reason }. A
 * folder that is a git repository reads its HEAD; one that is not, the digest
 * of its files; a repository, its newest commit on its default branch.
 */
export async function currentCommit(source, { env = process.env, timeoutMs = 15_000 } = {}) {
  if (source.folder) {
    if (!existsSync(source.folder)) return { ok: false, reason: `There is no folder at ${source.folder} any more.` };
    if (!isGitFolder(source.folder)) return { ok: true, commit: treeDigest(source.folder) };
    const r = await git(["-C", source.folder, "rev-parse", "HEAD"], { env, timeoutMs });
    return r.code === 0 ? { ok: true, commit: r.stdout.trim() } : { ok: false, reason: gitWords(r, `Reading ${source.folder}`) };
  }
  const r = await git(["ls-remote", urlOf(source.repository), "HEAD"], { env, timeoutMs });
  const commit = /^([0-9a-f]{40,64})\s+HEAD$/m.exec(r.stdout ?? "")?.[1];
  return r.code === 0 && commit ? { ok: true, commit } : { ok: false, reason: gitWords(r, `Reading ${source.repository}`) };
}

/** The scripts plugin.json's build entry names, across its skills: ["scripts/count.mjs", ...]. */
export function namedScripts(folder) {
  let plugin = {};
  try { plugin = JSON.parse(readFileSync(join(folder, "plugin.json"), "utf8")); } catch { return []; }
  const skills = plugin?.extensions?.["net.agentdoc.package"]?.build?.skills ?? {};
  const out = new Set();
  for (const entry of Object.values(skills)) for (const p of Array.isArray(entry?.scripts) ? entry.scripts : []) out.add(String(p).replace(/^\.\//, ""));
  return [...out];
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const OUT_OF_SCOPE = "An Agent Package runs Node 22 scripts, so this code cannot be packaged as an agent. Product Factory adopts agents only; general software stays out of scope, so the build stops here.";

/**
 * Whether the code in folder code can be the scripts of an Agent Package whose
 * spec names `named` (paths such as scripts/count.mjs). Each named script is
 * taken from the same path in the codebase, else from the one file of that
 * name in it. Resolves to { ok: true, take: [{ from, to }], left: [paths] } or
 * { ok: false, why } in words.
 */
export function adoptable(code, named, { commit = "" } = {}) {
  const files = codeFiles(code);
  const at = commit ? ` at ${short(commit)}` : "";
  const js = files.filter((p) => JS.has(extname(p).toLowerCase()) && !/(^|\/)(test|tests|__tests__)\//.test(p) && !/\.test\.[cm]?js$/.test(p));
  if (!js.length) {
    const counts = new Map();
    for (const p of files) { const l = LANGUAGE[extname(p).toLowerCase()]; if (l) counts.set(l, (counts.get(l) ?? 0) + 1); }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const said = top.length
      ? `The codebase${at} has no Node scripts: it is written in ${top.map(([l, n]) => `${l} (${plural(n, "file")})`).join(", ")}.`
      : `The codebase${at} has no Node scripts${files.length ? `: none of its ${plural(files.length, "file")} is JavaScript` : ": it is empty"}.`;
    return { ok: false, why: `${said} ${OUT_OF_SCOPE}` };
  }
  const want = named.length ? named : [];
  if (!want.length) return { ok: false, why: `The spec names no scripts for the codebase${at} to fill, so nothing in it can be the agent's scripts. Ask for changes at Requirements so the spec names the codebase's scripts.` };
  const take = [];
  const missing = [];
  for (const to of want) {
    if (files.includes(to)) { take.push({ from: to, to }); continue; }
    const same = js.filter((p) => basename(p) === basename(to));
    if (same.length === 1) take.push({ from: same[0], to });
    else missing.push(to);
  }
  if (missing.length) {
    return { ok: false, why: `The spec names ${missing.join(", ")}, and the codebase${at} has no such script, so the code cannot be packaged as this agent. It has ${js.slice(0, 8).join(", ")}${js.length > 8 ? ", …" : ""}. Ask for changes at Requirements so the spec names the codebase's own scripts.` };
  }
  // The rest of the code's scripts folder goes too, as the helpers the named scripts may import.
  for (const p of files.filter((x) => x.startsWith("scripts/") && JS.has(extname(x).toLowerCase()))) {
    if (!take.some((t) => t.from === p)) take.push({ from: p, to: p });
  }
  const left = files.filter((p) => !take.some((t) => t.from === p));
  return { ok: true, take, left };
}

/** Places the code's scripts in the build folder, each over the hand-off's stub. Returns the paths written. */
export function adoptInto(folder, code, plan) {
  const out = [];
  for (const t of plan.take) {
    const to = join(folder, ...t.to.split("/"));
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(code, ...t.from.split("/")), to);
    out.push(t.to);
  }
  return out;
}
