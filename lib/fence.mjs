// The gate's own checks on a build folder that came back on the pull request:
// what changed that may not have, and what a script carries that no script
// may. Both only read the files; nothing the pull request carries is run here.
//
// Ported from AgentMesh's hand-off gate (services/src/handoffs/gate-fence.ts),
// as plain JavaScript, with the rules unchanged.
//
// THE FENCE IS OURS. The build folder carries build.lock.json, but a pull
// request can change that file too, so the gate never reads it. It checks
// against the digests Product Factory kept when it opened the pull request,
// the same rule the code writer's own check applies: every pinned file is
// there and unchanged; a file under scripts/ is free; a new file under test/
// is allowed (adding a test is fine; changing one, or the spec, goes back
// through the spec and test steps); records/ and the lock itself are not
// held. Anything else that was added is refused by name.
//
// Pure: takes bytes, returns problems.

import { createHash } from "node:crypto";

/** The lock the hand-off writes in the build folder; never trusted here. */
export const LOCK_FILE = "build.lock.json";

/** Where the coding agent says a test cannot pass without breaking what the
 *  agent's files say (the code writer's AGENTS.md). records/ is not held, so
 *  the fence lets it be written; the gate reads it. */
export const CONFLICT_FILE = "records/conflict.md";
/** The most of it the gate reads; a longer one is refused by name, never read in part. */
export const CONFLICT_MAX_CHARS = 20_000;

/** The digest form build.lock.json uses. */
export const digestOf = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** A file's git blob id, which is how GitHub names the repository's own files. */
export const gitBlobSha = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

const free = (p) => p.startsWith("scripts/");
const unheld = (p) => p === LOCK_FILE || p.startsWith("records/");
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const sortProblems = (ps) => ps.sort(byPath);

/** Where a hand-off goes in the repository: a folder of its own, agents/<name>/,
 *  so two builds handed to the same repository never write the same paths. */
export const HANDOFF_ROOT = "agents";
export const folderFor = (agent) => `${HANDOFF_ROOT}/${agent}`;

/**
 * The files the gate judges: the repository's own files, as they were when
 * the pull request opened, are the repository's and not the coding step's, so
 * they are left out.
 */
export function judgedFiles(issued, files) {
  const own = issued.repoFiles ?? {};
  return new Map([...files].filter(([p, b]) => !(p in own && gitBlobSha(b) === own[p])));
}

/** Every file the fence refuses, against the digests kept at issue. */
export function fenceProblems(issued, files) {
  const out = [];
  const pinned = issued.digests;
  // The repository's own files may stay as they were, and nothing else.
  for (const [p, sha] of Object.entries(issued.repoFiles ?? {})) {
    if (p in pinned) continue;
    const got = files.get(p);
    if (!got) out.push({ path: p, what: "is the repository's own file and was removed" });
    else if (gitBlobSha(got) !== sha) out.push({ path: p, what: "is the repository's own file and was changed; the coding step changes only scripts/" });
  }
  const own = issued.repoFiles ?? {};
  for (const [p, d] of Object.entries(pinned)) {
    const got = files.get(p);
    const specOrTest = p.startsWith("test/") || p === "spec.json" || p === "spec.md";
    if (!got) out.push({ path: p, what: specOrTest ? "was removed; a change to a test or the spec goes back through the spec and test steps" : "was removed" });
    else if (digestOf(got) !== d) out.push({ path: p, what: specOrTest ? "was changed; a change to a test or the spec goes back through the spec and test steps" : "was changed, and it is pinned" });
  }
  for (const p of files.keys()) {
    if (p in pinned || p in own || free(p) || unheld(p)) continue;
    if (p.startsWith("test/")) continue;
    out.push({ path: p, what: "was added outside scripts/ and test/" });
  }
  return sortProblems(out);
}

// What a credential value looks like when somebody has committed one. A
// narrow list on purpose: a checker that cries wolf gets turned off, and the
// rule is about values, never names.
export const SECRETS = [
  [/-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, "a private key"],
  [/\bghp_[A-Za-z0-9]{30,}\b/, "a GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}\b/, "a GitHub token"],
  [/\bsk-[A-Za-z0-9]{32,}\b/, "an API key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key id"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, "a Slack token"],
  [/"private_key"\s*:\s*"-----BEGIN/, "a service account key"],
];

// Characters that make code read differently from how it runs: the
// bidirectional controls (Trojan Source) and the invisible joiners. A byte
// order mark is allowed only as a file's first character.
const HIDDEN = /[‪-‮⁦-⁩​-‍⁠᠎]|(?<!^)﻿/u;

const ADDRESS = /\b(?:https?|wss?):\/\/([A-Za-z0-9.-]+)/g;

/** Hosts a script may name without the spec declaring them: this machine, and the names kept for examples. */
const LOCAL = new Set(["localhost", "127.0.0.1", "0.0.0.0", "example.com", "example.org", "example.net"]);

function hostAllowed(host, declared) {
  const h = host.toLowerCase();
  if (LOCAL.has(h) || h.endsWith(".example.com") || h.endsWith(".test") || h.endsWith(".invalid")) return true;
  return declared.some((d) => {
    const x = d.toLowerCase().replace(/^\*\./, "");
    return h === x || h.endsWith(`.${x}`);
  });
}

/** The spec as approved (spec.json, stages.json 1.6.0, whose systems name their addresses) and the agent's own files made from it: the descriptor, the runtime requirements, plugin.json and each skill's SKILL.md. */
const SPEC_FILE = /^(?:spec\.json|agent-descriptor\.json|agent-runtime-requirements\.json|plugin\.json|skills\/[^/]+\/SKILL\.md)$/;
/** A host written without its scheme, as a system's needs say it: three labels or more, ending in letters. */
const BARE_HOST = /\b((?:[a-z0-9-]+\.){2,}[a-z]{2,24})\b/gi;
const FILE_END = /\.(?:json|mjs|cjs|js|md|txt|html|ya?ml)$/i;

/**
 * The hosts the spec declares: every host its pinned files name, with a
 * scheme anywhere in them, or written bare (hacker-news.firebaseio.com) in
 * the descriptor and the runtime requirements. A pinned file is checked
 * against its digest by the fence, so what it names is what was approved.
 */
export function declaredHosts(issued, files) {
  const out = new Set((issued.hosts ?? []).map((h) => String(h).toLowerCase()));
  for (const [p, bytes] of files) {
    if (!(p in issued.digests) || !SPEC_FILE.test(p)) continue;
    const text = Buffer.from(bytes).toString("utf8");
    for (const m of text.matchAll(ADDRESS)) out.add(m[1].toLowerCase());
    if (!p.endsWith(".json")) continue;
    let doc;
    try { doc = JSON.parse(text); } catch { continue; }
    // Bare hosts are read from the values only, never the keys, with media types (application/vnd.x.y+json) taken out first.
    const walk = (v) => {
      if (typeof v === "string") { for (const m of v.replace(MEDIA_TYPE, " ").matchAll(BARE_HOST)) if (!FILE_END.test(m[1])) out.add(m[1].toLowerCase()); }
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(doc);
  }
  return [...out].sort();
}
const MEDIA_TYPE = /\b[a-z]+\/[a-z0-9][\w.+-]*/gi;

/**
 * What the static review refuses in the files a pull request may change
 * (scripts/ and new tests): a credential value, a hidden character, and, in a
 * script, an address the spec does not declare. Pinned files were checked
 * when they were issued and the fence already holds them.
 */
export function staticProblems(issued, files) {
  const out = [];
  const hosts = declaredHosts(issued, files);
  for (const [p, bytes] of files) {
    if (p in issued.digests || p in (issued.repoFiles ?? {}) || unheld(p)) continue;
    const text = Buffer.from(bytes).toString("utf8");
    for (const [re, what] of SECRETS) if (re.test(text)) out.push({ path: p, what: `carries ${what}` });
    const hidden = HIDDEN.exec(text);
    if (hidden) {
      const line = text.slice(0, hidden.index).split("\n").length;
      out.push({ path: p, what: `carries a hidden character (U+${hidden[0].codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}) on line ${line}` });
    }
    if (!free(p)) continue;
    const named = new Set();
    for (const m of text.matchAll(ADDRESS)) if (!hostAllowed(m[1], hosts)) named.add(m[1].toLowerCase());
    for (const h of [...named].sort()) out.push({ path: p, what: `names ${h}, which the spec does not declare` });
  }
  return sortProblems(out);
}

/** The files of a repository tree that belong to the build folder, by their path inside it. */
export function inFolder(folder, files) {
  const at = folder.replace(/^\/+|\/+$/g, "");
  if (!at) return new Map(files);
  const out = new Map();
  for (const [p, b] of files) if (p.startsWith(`${at}/`)) out.set(p.slice(at.length + 1), b);
  return out;
}

/**
 * Split one commit's files at the hand-off's folder. repoFiles are kept by
 * their path from the top of the repository; those inside the folder become
 * the folder's own, by their path inside it, and those outside must be
 * exactly as they were: changed, removed, or a file added outside the folder,
 * is refused by name, because taking the pull request takes the whole branch.
 * Returns { files, scoped, outside, full }.
 */
export function viewOf(issued, tree) {
  const at = issued.folder.replace(/^\/+|\/+$/g, "");
  if (!at) return { files: new Map(tree), scoped: issued, outside: [], full: (p) => p };
  const lead = `${at}/`;
  const own = {};
  const beyond = {};
  for (const [p, sha] of Object.entries(issued.repoFiles ?? {})) {
    if (p.startsWith(lead)) own[p.slice(lead.length)] = sha;
    else beyond[p] = sha;
  }
  const outside = [];
  for (const [p, sha] of Object.entries(beyond)) {
    const got = tree.get(p);
    if (!got) outside.push({ path: p, what: `is the repository's own file, outside the build folder ${lead}, and was removed` });
    else if (gitBlobSha(got) !== sha) outside.push({ path: p, what: `is the repository's own file, outside the build folder ${lead}, and was changed; the coding step changes only ${lead}scripts/` });
  }
  for (const p of tree.keys()) {
    if (!p.startsWith(lead) && !(p in beyond)) outside.push({ path: p, what: `was added outside the build folder ${lead}` });
  }
  return { files: inFolder(at, tree), scoped: { ...issued, repoFiles: own }, outside: sortProblems(outside), full: (p) => `${lead}${p}` };
}

/** The fence and the static review over one commit's tree, every problem by
 *  its path from the top of the repository, with the view they were read through. */
export function fenceOfTree(issued, tree) {
  const v = viewOf(issued, tree);
  const at = (ps) => ps.map((p) => ({ path: v.full(p.path), what: p.what }));
  return { ...v, fence: sortProblems([...v.outside, ...at(fenceProblems(v.scoped, v.files))]), stat: at(staticProblems(v.scoped, v.files)) };
}

/** The files the coding step wrote: every file under scripts/ of the folder,
 *  less the repository's own files left as they were at issue. */
export function scriptsOf(files, repoFiles = {}) {
  return [...judgedFiles({ repoFiles }, files).entries()]
    .filter(([p]) => p.startsWith("scripts/"))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, bytes]) => ({ path, bytes: Buffer.from(bytes) }));
}

/** The scripts one commit gives a hand-off, read through its folder, by their path inside it. */
export function scriptsOfHandoff(issued, tree) {
  const v = viewOf(issued, tree);
  return scriptsOf(v.files, v.scoped.repoFiles);
}
