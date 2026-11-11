// Lay out the workspace the harness writes in, and record what was laid out.
//
// The harness does the writing; this step makes the folder it writes in and
// the record the check holds it to. The agent's own files (agent-descriptor.json,
// agent-runtime-requirements.json, plugin.json and each skills/<slug>/SKILL.md,
// what the spec writer delivers since 0.3.0) and the suite go in as they
// arrived and their digests are recorded, so a changed test or a changed
// declaration is caught by comparison and not by trust. A spec.json is still
// taken where the agent's files did not come, for one transition, and goes in
// the same way. Every script the spec names gets
// a starting file: the prototype's own, when the prototype is already in the
// house stack and has a file at that path; otherwise a stub exporting every
// function the suite imports from it, each throwing "not written yet", so the
// first round fails for the right reasons and the harness starts from the
// interface rather than from nothing. The rest of the prototype goes under
// prototype/ to be read and never changed.
//
// Given FILES, the attached files as the message listed them, it sorts them
// itself by what is in them (spec, tests and their helpers, prototype) and
// reads each by its bytes, so the harness never copies anything off the job
// folder's mount, where tar and cp -p fail on timestamps. A named script that
// is not a module (package.json) is laid out from the prototype or left
// empty, never given a JavaScript stub.
//
// When the prototype is itself a package (it carries the agent's files or a
// file under scripts/), every file it carries outside scripts/ is also laid
// out at its own path, read-only and pinned, so a sample or a data file is
// where the suite reads it. When one of the attached files is a build folder
// (a gzip tar archive carrying build.lock.json), the script unpacks it with
// archive.mjs, checks every pinned file against the lock before anything
// else, refuses naming the file that differs, and uses the folder as the
// workspace.
//
//   needs: node >= 22
//   WORKSPACE=<folder> FILES=<each attached path, with ::media_type, comma separated>
//   RECORDS=<records folder> [ROUNDS_MAX=30] node workspace.mjs
//   or, with the files already sorted into folders:
//   WORKSPACE=<folder> SPEC=<the agent's folder, or a spec.json> SUITE=<folder holding test/> RECORDS=<records folder>
//   [CODE=<folder holding a prototype>] [ROUNDS_MAX=30] node workspace.mjs
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative } from "node:path";
import { DESCRIPTOR_FILE, MANIFEST_FILE, RUNTIME_FILE, agentFilesAmongTexts, specOfFolder } from "./agent-folder.mjs";
// archive.mjs is not carried by every step that runs check.mjs, which imports
// this file, so it is loaded where it is and its absence only means a build
// folder archive cannot be read here.
const archive = await import("./archive.mjs").catch(() => null);

const trim = (s) => String(s ?? "").trim();
export const LOCK_FILE = "build.lock.json";
export const digestOf = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** How many rounds the harness may take before the check says stop. */
export const ROUNDS_MAX_DEFAULT = 30;
export const roundsMaxOf = (env = {}) => { const n = Number(env.ROUNDS_MAX); return Number.isInteger(n) && n > 0 ? n : ROUNDS_MAX_DEFAULT; };

/** Every script the spec names, once, in the order named. */
export function scriptsOf(spec) {
  return [...new Set((spec?.jobs ?? []).flatMap((j) => j?.scripts ?? []).map((s) => trim(s).replace(/\\/g, "/")).filter(Boolean))];
}

/** Everything else the spec names and the builder copies: references and
 *  assets, once each. These are not the writer's to write; they are laid out
 *  when they arrived and stood in as empty when they did not, so the builder
 *  can check the declaration, and the verdict says which were stood in. */
export function extrasOf(spec) {
  const out = [];
  for (const j of spec?.jobs ?? []) for (const kind of ["references", "assets"]) for (const p of j?.[kind] ?? []) {
    const rel = trim(p).replace(/\\/g, "/");
    if (rel && !out.includes(rel)) out.push(rel);
  }
  return out;
}

/** A path that stays inside the folder it is placed in. */
export function staysInside(rel) {
  const p = trim(rel).replace(/\\/g, "/");
  if (!p || p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return false;
  return !p.split("/").includes("..");
}

/** What a test file imports from the scripts: per script path, the names.
 *  Reads `import { a, b as c } from "../scripts/x.mjs"` and default imports;
 *  a dynamic `import("../scripts/x.mjs")` counts the script with no names. */
export function importsOf(text) {
  const out = new Map();
  const add = (path, names) => {
    const key = path.replace(/^\.\.\//, "");
    if (!out.has(key)) out.set(key, new Set());
    for (const n of names) out.get(key).add(n);
  };
  const src = String(text ?? "");
  for (const m of src.matchAll(/import\s+(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*["'](\.\.\/scripts\/[^"']+)["']/g)) {
    const names = [];
    if (m[1]) names.push("default");
    if (m[2]) for (const part of m[2].split(",")) { const n = trim(part).split(/\s+as\s+/)[0].trim(); if (n) names.push(n); }
    add(m[3], names);
  }
  for (const m of src.matchAll(/import\(\s*["'](\.\.\/scripts\/[^"']+)["']\s*\)/g)) add(m[1], []);
  return [...out.entries()].map(([script, names]) => ({ script, names: [...names] }));
}

/** The stub for a script: every named export the suite imports, throwing. */
export function stubFor(script, names = []) {
  const lines = [
    `// ${basename(script)}: not written yet.`,
    "//",
    "// The suite names what this exports; each one throws until it is written.",
    "// Replace this file. Keep the names.",
    "",
  ];
  for (const n of names) {
    if (n === "default") lines.push(`export default function () { throw new Error("${basename(script)} is not written yet"); }`);
    else if (/^[A-Z][A-Z0-9_]*$/.test(n)) lines.push(`export const ${n} = undefined; // not written yet`);
    else lines.push(`export function ${n}() { throw new Error("${n} is not written yet"); }`);
  }
  if (!names.length) lines.push("export {};");
  return lines.join("\n") + "\n";
}

/** Every file under a folder, as posix-relative paths with digests. */
export function listing(dir, { skip = [] } = {}) {
  const out = {};
  if (!existsSync(dir)) return out;
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const at = join(d, n);
      const rel = relative(dir, at).replace(/\\/g, "/");
      if (skip.some((s) => rel === s || rel.startsWith(s + "/"))) continue;
      if (statSync(at).isDirectory()) walk(at);
      else out[rel] = digestOf(readFileSync(at));
    }
  };
  walk(dir);
  return out;
}

const readOnly = (p) => { try { chmodSync(p, 0o444); } catch { /* a hint, not the fence; the digest is the fence */ } };

/** Lay it out. `spec` is the parsed document, `suite` the test files as
 *  {path, text} with path under test/, `code` the prototype's files as
 *  {path, bytes} relative to its own root, or null. Pure apart from writing
 *  into `workspace`. */
export function layOut({ workspace, spec, specText, agent = null, suite = [], code = null } = {}) {
  if (!workspace) throw new Error("no workspace folder to lay out");
  const scripts = scriptsOf(spec);
  for (const s of scripts) if (!staysInside(s) || !s.startsWith("scripts/")) throw new Error(`the spec names a script outside scripts/: ${s}`);
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(workspace, "scripts"), { recursive: true });
  mkdirSync(join(workspace, "test"), { recursive: true });
  mkdirSync(join(workspace, "records"), { recursive: true });

  // The declaration: the agent's own files when they came, written as they
  // arrived and pinned each by its path; a spec.json otherwise.
  const declared = {};
  if (agent) {
    for (const [rel, text] of Object.entries(agentFilesByPath(agent))) {
      const at = join(workspace, rel);
      mkdirSync(dirname(at), { recursive: true });
      writeFileSync(at, text);
      readOnly(at);
      declared[rel] = digestOf(Buffer.from(text));
    }
  } else {
    const specPath = join(workspace, "spec.json");
    writeFileSync(specPath, specText ?? JSON.stringify(spec, null, 2) + "\n");
    readOnly(specPath);
    declared["spec.json"] = digestOf(readFileSync(specPath));
  }

  // Every file the suite carries goes under test/ as it came and is pinned:
  // the test files, and the helpers, fakes and sample files beside them. A
  // suite that carried helpers.mjs could not go through before 2026-09-15,
  // when only test/<name>.test.mjs was allowed.
  const tests = {};
  for (const f of suite) {
    const rel = trim(f.path).replace(/\\/g, "/");
    if (!rel.startsWith("test/") || !staysInside(rel)) throw new Error(`a suite file must live under test/, not ${rel}`);
    const at = join(workspace, rel);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, f.text);
    readOnly(at);
    tests[rel] = digestOf(Buffer.from(f.text));
  }
  const testFiles = suite.filter((f) => /^test\/[^/]+\.test\.mjs$/.test(trim(f.path).replace(/\\/g, "/")));
  if (!testFiles.length) throw new Error("the suite has no test/<name>.test.mjs; nothing would run");

  // What the suite imports from each script, so a stub has the right names.
  const wanted = new Map();
  for (const f of testFiles) for (const { script, names } of importsOf(f.text)) {
    if (!wanted.has(script)) wanted.set(script, new Set());
    for (const n of names) wanted.get(script).add(n);
  }

  // The prototype: a file at a named script's own path seeds that script when
  // it is already an .mjs; everything else is placed under prototype/ to be
  // read. A prototype in another language is all under prototype/.
  const codeByPath = new Map((code ?? []).map((f) => [trim(f.path).replace(/\\/g, "/"), f.bytes]));
  const placed = [];
  const prototype = [];
  for (const s of scripts) {
    const at = join(workspace, s);
    mkdirSync(dirname(at), { recursive: true });
    if (codeByPath.has(s) && s.endsWith(".mjs")) {
      writeFileSync(at, codeByPath.get(s));
      placed.push({ path: s, from: "prototype" });
    } else if (!s.endsWith(".mjs")) {
      // A named script that is not a module (a package.json, a data file) is
      // never given a JavaScript stub: a stub is code, and code in a .json
      // file is a file nothing can read (debt 43). It is the prototype's own
      // bytes when the prototype carried it, and empty otherwise, for the
      // writer to fill.
      if (codeByPath.has(s)) {
        writeFileSync(at, codeByPath.get(s));
        placed.push({ path: s, from: "prototype" });
      } else {
        writeFileSync(at, "");
        placed.push({ path: s, from: "empty", names: [] });
      }
    } else {
      const names = [...(wanted.get(s) ?? [])];
      writeFileSync(at, stubFor(s, names));
      placed.push({ path: s, from: names.length ? "stub" : "empty", names });
    }
  }
  for (const [p, bytes] of codeByPath) {
    if (!staysInside(p)) continue;
    const at = join(workspace, "prototype", p);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, bytes);
    readOnly(at);
    prototype.push(p);
  }
  // References and assets the spec names: laid out from the prototype when it
  // carried them at those paths, stood in as empty otherwise, and pinned
  // either way, because they are not the writer's to write. A path with no
  // extension is taken as a folder.
  const extras = [];
  const stoodIn = [];
  const flatCarried = (rel) => [...codeByPath.keys()].find((p) => !p.includes("/") && p === basename(rel)) ?? null;
  for (const rel of extrasOf(spec)) {
    if (!staysInside(rel) || rel.startsWith("scripts/")) throw new Error(`the spec names a reference or asset it may not: ${rel}`);
    const at = join(workspace, rel);
    const carried = [...codeByPath.keys()].filter((p) => p === rel || p.startsWith(rel + "/"));
    if (carried.length) {
      for (const p of carried) {
        const to = join(workspace, p);
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, codeByPath.get(p));
        readOnly(to);
        tests[p] = digestOf(codeByPath.get(p));
      }
      extras.push({ path: rel, from: "prototype" });
    } else if (/\.[a-z0-9]+$/i.test(basename(rel)) && flatCarried(rel)) {
      // A prototype that came as loose files has no folders, so a reference
      // it carries is found by its file name, the way the delivery check
      // finds one.
      const bytes = codeByPath.get(flatCarried(rel));
      mkdirSync(dirname(at), { recursive: true });
      writeFileSync(at, bytes);
      readOnly(at);
      tests[rel] = digestOf(bytes);
      extras.push({ path: rel, from: "prototype" });
    } else if (/\.[a-z0-9]+$/i.test(basename(rel))) {
      mkdirSync(dirname(at), { recursive: true });
      writeFileSync(at, "");
      readOnly(at);
      tests[rel] = digestOf(Buffer.alloc(0));
      extras.push({ path: rel, from: "stand-in" });
      stoodIn.push(rel);
    } else {
      mkdirSync(at, { recursive: true });
      extras.push({ path: rel, from: "stand-in" });
      stoodIn.push(rel);
    }
  }
  // A prototype that is itself a package keeps its own layout: every file it
  // carries outside scripts/ goes at its own path too, read-only and pinned,
  // unless the declaration, the suite or an earlier step already holds that
  // path. The old copies of those stay under prototype/ to be read.
  const isPackage = [...codeByPath.keys()].some((p) => p.startsWith("scripts/") || p === DESCRIPTOR_FILE);
  if (isPackage) {
    for (const [p, bytes] of codeByPath) {
      if (!staysInside(p) || p.startsWith("scripts/") || p.startsWith("test/") || p.startsWith("records/") || p.startsWith("prototype/") || p.startsWith("skills/") || [DESCRIPTOR_FILE, RUNTIME_FILE, MANIFEST_FILE, "spec.json"].includes(p)) continue;
      if (p in tests || p in declared) continue;
      const to = join(workspace, p);
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, bytes);
      readOnly(to);
      tests[p] = digestOf(bytes);
    }
  }
  // Scripts the suite imports that the spec never named are said, not made:
  // the spec is what the package ships, and a file it does not name is not in
  // the package however many tests want it.
  const unnamed = [...wanted.keys()].filter((s) => !scripts.includes(s));

  return {
    scripts: placed,
    prototype,
    extras,
    stood_in: stoodIn,
    unnamed,
    digests: { ...declared, ...tests },
    listing: listing(workspace, { skip: ["records"] }),
  };
}

/** The name a file that came through the process runner goes under: its
 *  piece-label prefixes ("0-abcdefgh-") taken off. */
export function plainName(path) {
  let n = basename(String(path ?? "").replace(/\\/g, "/"));
  while (/^\d+-[A-Za-z0-9_-]{8}-/.test(n)) n = n.replace(/^\d+-[A-Za-z0-9_-]{8}-/, "");
  return n;
}

const looksLikeSpec = (text) => {
  try {
    const d = JSON.parse(text);
    return !!(d && typeof d === "object" && !Array.isArray(d) && typeof d.name === "string" && d.name
      && Array.isArray(d.jobs) && d.jobs.length && d.jobs.every((j) => j && typeof j.slug === "string" && j.slug));
  } catch { return false; }
};
const importsNodeTest = (text) => /from\s+["']node:test["']/.test(text);

/** The agent's own files, as {rel: text} at the paths they take in a
 *  folder. `agent` is {descriptor, runtime, manifest, skills: {slug}}, each
 *  a text. */
export function agentFilesByPath(agent) {
  const out = { [DESCRIPTOR_FILE]: agent.descriptor, [RUNTIME_FILE]: agent.runtime, [MANIFEST_FILE]: agent.manifest };
  for (const [slug, text] of Object.entries(agent.skills ?? {})) out[`skills/${slug}/SKILL.md`] = text;
  return out;
}

/** The spec the agent's files state, read the way the builder reads them,
 *  from a scratch copy laid out as the folder. */
export function specOfAgent(agent, scratch) {
  for (const [rel, text] of Object.entries(agentFilesByPath(agent))) {
    mkdirSync(dirname(join(scratch, rel)), { recursive: true });
    writeFileSync(join(scratch, rel), text);
  }
  return specOfFolder(scratch);
}

/** The agent's own files among texts, by content: {descriptor, runtime,
 *  manifest, skills, used} with each a text, or null unless the three
 *  authored files are all there. Chosen the way agent-folder.mjs chooses
 *  them (the manifest first, then the descriptor and runtime requirements
 *  that go with it, and only the skills it names), so a prototype that is
 *  itself a package stays the prototype. */
export function agentAmong(got) {
  const found = agentFilesAmongTexts(got.map((f, i) => ({ key: i, text: f.text })));
  if (!found) return null;
  const t = (i) => got[i].text;
  return {
    descriptor: t(found.descriptor), runtime: t(found.runtime), manifest: t(found.manifest),
    skills: Object.fromEntries(Object.entries(found.skills).map(([slug, i]) => [slug, t(i)])),
    used: found.used.map((i) => got[i]),
  };
}

/** Sort the attached files by what is in them, never by their names: the
 *  spec is the JSON with a name, a version and jobs with slugs; a test file
 *  imports node:test and goes under test/ as <name>.test.mjs; a file a test
 *  imports by a relative name (./helpers.mjs) goes under test/ beside it;
 *  everything else is the prototype, under its plain name. Read as bytes and
 *  written by this script, so nothing is copied with tar or cp on the job
 *  folder's mount, where preserving a timestamp fails (debt 43). `read` is
 *  handed in by tests. */
export function sortAttachments(paths = [], read = (p) => readFileSync(p)) {
  const got = [];
  for (const p of paths) {
    if (!p || /job-manifest\.json$/.test(p)) continue;
    let bytes;
    try { bytes = read(p); } catch { continue; }
    got.push({ from: p, name: plainName(p), bytes: Buffer.from(bytes), text: Buffer.from(bytes).toString("utf8") });
  }
  // A build folder is a gzip tar archive that carries build.lock.json. It is
  // the whole workspace, so when one came nothing else is sorted.
  for (const f of got) {
    if (f.bytes[0] !== 0x1f || f.bytes[1] !== 0x8b) continue;
    let entries;
    try { entries = archive?.entriesIn(f.bytes); } catch { continue; }
    if (!entries) continue;
    if (entries.some((e) => e.type === "file" && e.path.replace(/^(\.\/)+/, "") === LOCK_FILE)) {
      return { spec: null, agent: null, suite: [], code: [], build: { from: f.from, entries } };
    }
  }
  // The agent's own files are preferred; a spec.json is read where they did
  // not come. Neither is a test, a helper or the prototype.
  const agent = agentAmong(got);
  const taken = new Set(agent?.used ?? []);
  const spec = agent ? null : got.find((f) => looksLikeSpec(f.text)) ?? null;
  if (spec) taken.add(spec);
  // A spec that came with the agent's files is the older form of the same
  // declaration: set aside, never laid out as the prototype.
  if (agent) for (const f of got) if (looksLikeSpec(f.text)) taken.add(f);
  const tests = got.filter((f) => !taken.has(f) && importsNodeTest(f.text));
  const testName = (n) => (n.endsWith(".test.mjs") ? n : n.endsWith(".mjs") ? `${n.slice(0, -4)}.test.mjs` : `${n}.test.mjs`);
  const helpersWanted = new Set();
  for (const t of tests) for (const m of t.text.matchAll(/from\s+["']\.\/([^"'/]+)["']/g)) helpersWanted.add(m[1]);
  const helpers = got.filter((f) => !taken.has(f) && !tests.includes(f) && helpersWanted.has(f.name));
  const suite = [
    ...tests.map((f) => ({ path: `test/${testName(f.name)}`, text: f.text })),
    ...helpers.map((f) => ({ path: `test/${f.name}`, text: f.text })),
  ];
  const code = got.filter((f) => !taken.has(f) && !tests.includes(f) && !helpers.includes(f)).map((f) => ({ path: f.name, bytes: f.bytes }));
  const { used, ...files } = agent ?? {};
  return { spec: spec ? { from: spec.from, text: spec.text } : null, agent: agent ? files : null, suite, code };
}

/** The pinned digests a build folder's lock holds: {path: digest}. The lock
 *  keeps them under "digests", or is itself the map. */
export function lockedDigests(lock) {
  const d = lock && typeof lock === "object" && lock.digests && typeof lock.digests === "object" ? lock.digests : lock;
  return Object.fromEntries(Object.entries(d ?? {}).filter(([, v]) => typeof v === "string"));
}

/** Every problem a build folder's entries have against build.lock.json, as
 *  {path, what}: a pinned file that is missing or differs, and any file outside
 *  scripts/ that the lock does not pin (the lock itself and records/, which
 *  neither the lock nor the fence holds, are not counted). Pure: reads nothing
 *  from disk. */
export function lockProblems(entries) {
  const byPath = new Map(entries.filter((e) => e.type === "file").map((e) => [e.path.replace(/^(\.\/)+/, ""), e.bytes]));
  let lock;
  try { lock = JSON.parse(byPath.get(LOCK_FILE)?.toString("utf8") ?? ""); } catch { return [{ path: LOCK_FILE, what: "is not valid JSON" }]; }
  const out = [];
  const pinned = lockedDigests(lock);
  for (const [p, d] of Object.entries(pinned)) {
    if (!byPath.has(p)) out.push({ path: p, what: "is missing" });
    else if (digestOf(byPath.get(p)) !== d) out.push({ path: p, what: "differs from its digest" });
  }
  // A file outside scripts/ that the lock does not pin would be unpacked and
  // then taken into the fence's baseline, so it is refused here, by name.
  for (const p of byPath.keys()) {
    if (p in pinned || p === LOCK_FILE || p.startsWith("scripts/") || p.startsWith("records/")) continue;
    out.push({ path: p, what: "is outside scripts/ and not pinned by the lock" });
  }
  return out;
}

const thisFile = process.argv[1] ? process.argv[1].replace(/\\/g, "/").split("/").pop() : "";
if (thisFile && import.meta.url.endsWith(thisFile)) {
  const env = process.env;
  const { WORKSPACE, SPEC, SUITE, RECORDS, CODE, FILES } = env;
  if (!WORKSPACE || !RECORDS || !(FILES || (SPEC && SUITE))) { console.error("WORKSPACE and RECORDS are required, with FILES (the attached files) or SPEC and SUITE"); process.exit(2); }
  try {
    let specText; let suite; let code = null; let testDir; let agent = null;
    if (FILES) {
      // The attached files, sorted here by what is in them.
      const sorted = sortAttachments(FILES.split(",").map((e) => e.trim()).filter(Boolean).map((e) => e.split("::")[0]));
      if (!sorted.spec && !sorted.agent && !sorted.build) {
        console.log(JSON.stringify({ ok: false, code: 3, reply: "Nothing attached is the agent's files or a spec: the scripts are written from the files the package is built from (agent-descriptor.json, agent-runtime-requirements.json, plugin.json and the SKILL.md files), and from the suite written from them. Attach both and ask again." }));
        process.exit(3);
      }
      if (sorted.build) {
        const problems = lockProblems(sorted.build.entries);
        if (problems.length) {
          console.log(JSON.stringify({ ok: false, code: 3, reply: `The build folder does not match its build.lock.json, so nothing is laid out: ${problems.map((p) => `${p.path} ${p.what}`).join("; ")}. Whoever made the folder has to hand it over again.` }));
          process.exit(3);
        }
        const unpacked = archive.unpack(sorted.build.from, WORKSPACE);
        for (const d of ["scripts", "test", "records"]) mkdirSync(join(WORKSPACE, d), { recursive: true });
        const lock = JSON.parse(readFileSync(join(WORKSPACE, LOCK_FILE), "utf8"));
        const hasAgent = existsSync(join(WORKSPACE, DESCRIPTOR_FILE));
        const spec = hasAgent ? specOfFolder(WORKSPACE) : null;
        const suiteFiles = Object.keys(listing(join(WORKSPACE, "test"))).filter((rel) => /^[^/]+\.test\.mjs$/.test(rel));
        if (!suiteFiles.length) {
          console.log(JSON.stringify({ ok: false, code: 3, reply: "The build folder carries no suite: nothing named test/<name>.test.mjs. The test-writer writes it from the spec, and the scripts are written to it, so nothing can be written yet." }));
          process.exit(3);
        }
        const named = spec ? scriptsOf(spec) : Object.keys(listing(join(WORKSPACE, "scripts"))).map((r) => `scripts/${r}`);
        const lockScripts = new Map((Array.isArray(lock.scripts) ? lock.scripts : []).map((s) => [s.path, s]));
        const scripts = named.map((p) => lockScripts.get(p) ?? { path: p, from: "build folder" });
        mkdirSync(RECORDS, { recursive: true });
        const record = {
          workspace: "v1", at: new Date().toISOString(), folder: WORKSPACE, rounds_max: roundsMaxOf(env),
          from_attachments: true, from_build_folder: true, prototype_given: false, prototype_found: false,
          scripts, prototype: [], extras: [], stood_in: [], unnamed: [],
          digests: lockedDigests(lock), listing: listing(WORKSPACE, { skip: ["records"] }),
        };
        writeFileSync(join(RECORDS, "workspace.json"), JSON.stringify(record, null, 2) + "\n");
        console.log(JSON.stringify({ ok: true, code: 0, workspace: WORKSPACE, said: `the build folder unpacked, ${unpacked.files.length} files checked against build.lock.json (${Object.keys(record.digests).length} pinned); ${scripts.length} script${scripts.length === 1 ? "" : "s"} to write; ${suiteFiles.length} test file${suiteFiles.length === 1 ? "" : "s"}` }));
        process.exit(0);
      }
      agent = sorted.agent;
      specText = sorted.spec?.text;
      suite = sorted.suite;
      code = sorted.code.length ? sorted.code : null;
      testDir = "the attached files";
    } else {
      if (statSync(SPEC).isDirectory()) {
        // The agent's own folder: its authored files and each SKILL.md.
        const read = (rel) => readFileSync(join(SPEC, rel), "utf8");
        const skills = {};
        if (existsSync(join(SPEC, "skills"))) for (const slug of readdirSync(join(SPEC, "skills")).sort()) {
          if (existsSync(join(SPEC, "skills", slug, "SKILL.md"))) skills[slug] = read(join("skills", slug, "SKILL.md"));
        }
        // The names before Common Agent 0.30.0-draft are read where the
        // current ones are absent.
        const either = (now, old) => (existsSync(join(SPEC, now)) ? now : old);
        agent = { descriptor: read(either(DESCRIPTOR_FILE, "descriptor.json")), runtime: read(either(RUNTIME_FILE, "install.json")), manifest: read(MANIFEST_FILE), skills };
      } else specText = readFileSync(SPEC, "utf8");
      testDir = join(SUITE, "test");
      // Everything under test/, helpers and fixtures included; the runner's
      // paths are the *.test.mjs among them.
      suite = existsSync(testDir)
        ? Object.keys(listing(testDir)).sort().map((rel) => ({ path: `test/${rel}`, text: readFileSync(join(testDir, rel), "utf8") }))
        : [];
      if (CODE && existsSync(CODE)) {
        const files = listing(CODE, { skip: ["node_modules", ".git"] });
        code = Object.keys(files).map((p) => ({ path: p, bytes: readFileSync(join(CODE, p)) }));
      }
    }
    const spec = agent ? specOfAgent(agent, join(RECORDS, "agent")) : JSON.parse(specText);
    if (!suite.some((f) => /^test\/[^/]+\.test\.mjs$/.test(f.path))) {
      console.log(JSON.stringify({ ok: false, code: 3, reply: `There is no suite in ${testDir}: nothing named test/<name>.test.mjs. The test-writer writes it from the spec, and the scripts are written to it, so nothing can be written yet.` }));
      process.exitCode = 3;
    } else {
      const out = layOut({ workspace: WORKSPACE, spec, specText, agent, suite, code });
      mkdirSync(RECORDS, { recursive: true });
      const record = {
        workspace: "v1", at: new Date().toISOString(), folder: WORKSPACE, rounds_max: roundsMaxOf(env),
        ...(FILES
          ? { from_attachments: true, prototype_given: !!code, prototype_found: !!code }
          : { prototype_given: !!CODE, prototype_found: !!(CODE && existsSync(CODE)) }),
        ...out,
      };
      writeFileSync(join(RECORDS, "workspace.json"), JSON.stringify(record, null, 2) + "\n");
      const empty = out.scripts.filter((s) => s.from === "empty").length;
      const bits = [`${out.scripts.length} script${out.scripts.length === 1 ? "" : "s"} laid out (${out.scripts.filter((s) => s.from === "prototype").length} from the prototype, ${out.scripts.filter((s) => s.from === "stub").length} stubbed${empty ? `, ${empty} empty` : ""})`,
        `${suite.filter((f) => f.path.endsWith(".test.mjs")).length} test file${suite.filter((f) => f.path.endsWith(".test.mjs")).length === 1 ? "" : "s"}${suite.some((f) => !f.path.endsWith(".test.mjs")) ? ` and ${suite.filter((f) => !f.path.endsWith(".test.mjs")).length} other file${suite.filter((f) => !f.path.endsWith(".test.mjs")).length === 1 ? "" : "s"} beside them` : ""}`];
      if (out.prototype.length) bits.push(`${out.prototype.length} prototype file${out.prototype.length === 1 ? "" : "s"} under prototype/`);
      if (out.stood_in.length) bits.push(`${out.stood_in.length} reference${out.stood_in.length === 1 ? "" : "s"} the spec names stood in as empty: ${out.stood_in.join(", ")}`);
      if (out.unnamed.length) bits.push(`the suite imports ${out.unnamed.join(", ")}, which the spec never names`);
      console.log(JSON.stringify({ ok: true, code: 0, workspace: WORKSPACE, said: bits.join("; ") }));
    }
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
