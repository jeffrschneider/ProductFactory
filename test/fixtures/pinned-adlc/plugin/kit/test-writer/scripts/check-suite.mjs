// Check the suite by running it: against nothing, and against something.
//
// Against nothing: every script the spec names is stood in by an empty file
// and the suite is run over them. It must fail. A suite that passes with every
// function absent has asserted nothing, and this is the check that catches a
// suite of comments.
//
// Against a package: the suite is run over the real scripts and must pass.
// Then each script is blanked in turn and the suite run again, and a script
// whose absence the suite never notices is named. That is the whole check on
// a suite, and it is mechanical: nothing here judges whether a test is good,
// only whether the suite notices when the thing it is for is gone.
//
// Against the agent's own files: a test that touches no script reads only
// what the spec writer delivered (the descriptor, the manifest, the runtime
// requirements, a SKILL.md), so no script can change whether it passes. It
// must pass before any script exists. The suite is run once more beside the
// agent's own files, with every script stood in by a module that exports the
// names the suite imports and does nothing, so every file loads; each test
// that fails there and whose body touches no script is named (technical debt
// 618: a test asserting the descriptor's `name` and an offering's `offered`,
// which the Common Agent descriptor does not carry, stopped every build at
// the code step). Whether a body touches a script is read leniently: naming
// a script, a function imported from one, or a helper that does is touching,
// and a failure that cannot be placed in a test is not named.
//
// The same run checks every worked value. Each expected value a rule in the
// spec decides is written as worked(value, () => computation), a constant at
// the top of its file, and the worked-values check every suite carries
// (references/worked-values.test.mjs) fails one test naming each value its
// own computation does not give. Every file loads in this run, so each such
// value is read out of that failure and named (technical debt 646: a suite
// pinned 16 vowels where the sentence holds 14, and "HTTP" where the spec's
// rule gives "HTP", and the build stopped at the code step).
//
// Nothing here edits a test. A failure against the real scripts belongs to
// whoever owns the scripts, and the verdict says so.
//
//   needs: node >= 22
//   SUITE=<folder holding test/*.test.mjs> SPEC=<the agent's folder, or a spec.json> RECORDS=<records folder>
//   [AGAINST=<package folder with scripts/>] node check-suite.mjs
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, posix, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { DESCRIPTOR_FILE, MANIFEST_FILE, RUNTIME_FILE, loadSpec } from "./agent-folder.mjs";

const trim = (s) => String(s ?? "").trim();

/** How long one run of a suite may take. A written suite that hangs is a
 *  finding, not a wait. */
export const RUN_SECONDS = 120;

/** Every script the spec names, once, in the order named. */
export function scriptsOf(spec) {
  return [...new Set((spec?.jobs ?? []).flatMap((j) => j?.scripts ?? []).map(trim).filter(Boolean))];
}

/** A path that stays inside the folder it is placed in. A spec that names
 *  "../x.mjs" or "/etc/x" is refused before anything is written, because a
 *  stand-in is an empty file put wherever the spec says. */
export function staysInside(rel) {
  const p = trim(rel).replace(/\\/g, "/");
  if (!p || isAbsolute(p) || /^[a-zA-Z]:/.test(p)) return false;
  const n = normalize(p).replace(/\\/g, "/");
  return !(n === ".." || n.startsWith("../"));
}

/** The agent's own files a suite may read, copied from its folder beside
 *  the stand-ins: the two authored files, the manifest and each SKILL.md,
 *  where a built package has them. */
export function agentFilesInto(folder, dir) {
  for (const rel of [DESCRIPTOR_FILE, RUNTIME_FILE, MANIFEST_FILE]) {
    if (existsSync(join(folder, rel))) cpSync(join(folder, rel), join(dir, rel));
  }
  if (existsSync(join(folder, "skills"))) {
    for (const slug of readdirSync(join(folder, "skills"))) {
      const md = join(folder, "skills", slug, "SKILL.md");
      if (existsSync(md)) { mkdirSync(join(dir, "skills", slug), { recursive: true }); cpSync(md, join(dir, "skills", slug, "SKILL.md")); }
    }
  }
}

/** Put an empty file where every script the spec names would be, and the
 *  agent's own files beside them when it came as a folder (a spec.json,
 *  still read for one transition, goes beside them as it came). Returns
 *  what was stood in. */
export function standInPackage(spec, dir, folder = null) {
  const scripts = scriptsOf(spec);
  for (const s of scripts) {
    if (!staysInside(s)) throw new Error(`the spec names a script outside the package: ${s}`);
  }
  mkdirSync(dir, { recursive: true });
  for (const s of scripts) {
    const at = join(dir, s);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, "");
  }
  if (folder) agentFilesInto(folder, dir);
  else writeFileSync(join(dir, "spec.json"), JSON.stringify(spec, null, 2) + "\n");
  return scripts;
}

/** A test file of a suite: test/<name>.test.mjs, the only files run. */
export const isTestPath = (p) => /^test\/[^/]+\.test\.mjs$/.test(String(p ?? "").replace(/\\/g, "/"));
/** A file a suite carries beside its tests and never runs (test-writer
 *  0.10.0): a file an original test imports, under test/support/, and the
 *  record of the original tests, test/carried-tests.json. */
export const isSupportPath = (p) => { const n = String(p ?? "").replace(/\\/g, "/"); return /^test\/support\/.+/.test(n) || n === "test/carried-tests.json"; };

/** Write the suite's files under a package folder: each test at
 *  test/<name>, and each file it carries beside them at its own path, by its
 *  bytes. Returns the tests' paths, which are what is run. */
export function placeSuite(files, dir) {
  const placed = [];
  for (const f of files) {
    const test = isTestPath(f.path);
    if (!staysInside(f.path) || (!test && !isSupportPath(f.path))) {
      throw new Error(`a suite file must be test/<name>.test.mjs, or a file it carries under test/support/, not ${f.path}`);
    }
    const at = join(dir, f.path);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, f.bytes ?? f.text);
    if (test) placed.push(f.path);
  }
  return placed;
}

/** The files a suite carries beside its tests under a folder (test/support/
 *  and test/carried-tests.json), as {path, bytes}. */
export function supportFiles(dir) {
  const out = [];
  const walk = (at, rel) => {
    if (!existsSync(at)) return;
    for (const n of readdirSync(at).sort()) {
      const p = join(at, n);
      if (statSync(p).isDirectory()) walk(p, `${rel}/${n}`);
      else out.push({ path: `${rel}/${n}`, bytes: readFileSync(p) });
    }
  };
  walk(join(dir, "test", "support"), "test/support");
  if (existsSync(join(dir, "test", "carried-tests.json"))) out.push({ path: "test/carried-tests.json", bytes: readFileSync(join(dir, "test", "carried-tests.json")) });
  return out;
}

/** The suite files under a folder: test/*.test.mjs, as {path, text}. */
export function suiteFiles(dir) {
  const at = join(dir, "test");
  if (!existsSync(at)) return [];
  return readdirSync(at).filter((n) => n.endsWith(".test.mjs")).sort()
    .map((n) => ({ path: `test/${n}`, text: readFileSync(join(at, n), "utf8") }));
}

/** What node's TAP reporter says at the end: tests, pass, fail. Read from
 *  the summary lines so a suite that crashed before printing any test still
 *  counts as a run that failed. */
export function tapSummary(output) {
  const n = (k) => { const m = new RegExp(`^# ${k} (\\d+)`, "m").exec(output); return m ? Number(m[1]) : 0; };
  return { tests: n("tests"), pass: n("pass"), fail: n("fail") + n("cancelled") };
}

/** Run the suite in a folder. `spawn` is handed in by tests. */
export function runSuite(dir, paths, { spawn = spawnSync } = {}) {
  // A child started from inside a node:test process inherits NODE_TEST_CONTEXT
  // and then refuses to run any file, so the suite is run in an environment
  // that carries no trace of the parent's runner.
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("NODE_TEST_")) delete env[k];
  const r = spawn("node", ["--test", "--test-reporter=tap", ...paths], {
    cwd: dir, env, encoding: "utf8", timeout: RUN_SECONDS * 1000,
  });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const sum = tapSummary(out);
  const status = typeof r.status === "number" ? r.status : 1;
  return {
    ...sum, status,
    // A run with nothing counted and a bad status is a suite that did not
    // load, which is a failure of the suite and is said as one.
    fails: status !== 0 || sum.fail > 0 || sum.tests === 0,
    timed_out: !!r.error && /ETIMEDOUT|timed out/i.test(String(r.error?.code ?? r.error?.message ?? "")),
    tail: out.trim().slice(-2000),
  };
}

/** The suite against empty stand-ins. Pure apart from the scratch folder,
 *  which is made and removed here. */
export function standInRun({ spec, files, spawn, folder = null } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "test-writer-standins-"));
  try {
    const scripts = standInPackage(spec, scratch, folder);
    const paths = placeSuite(files, scratch);
    const run = runSuite(scratch, paths, { spawn });
    return { against: "stand-ins", scripts: scripts.length, files: paths.length, ...run };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** Every relative import in a suite file, with the package path it resolves
 *  to from test/ ("../scripts/a.mjs" is "scripts/a.mjs"), whether that is a
 *  script, the names it takes ({imported, local}; a default import is
 *  "default") and the namespace it is bound to, if any. node's own modules
 *  and bare packages are not the package's and are left out. */
export function importsOf(text) {
  const out = [];
  const re = /\bimport\s+([\w$*{}\s,]+?)\s+from\s+["']([^"']+)["']/g;
  for (const m of String(text ?? "").matchAll(re)) {
    const spec = m[2];
    if (!/^\.\.?\//.test(spec)) continue;
    const from = posix.normalize(posix.join("test", spec));
    const entry = { from, script: from.startsWith("scripts/"), names: [], namespace: null };
    let clause = m[1].trim();
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) {
      for (const part of braces[1].split(",").map((s) => s.trim()).filter(Boolean)) {
        const [imported, local] = part.split(/\s+as\s+/).map((s) => s.trim());
        if (IDENT.test(imported)) entry.names.push({ imported, local: IDENT.test(local ?? "") ? local : imported });
      }
      clause = clause.replace(braces[0], "");
    }
    const ns = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(clause);
    if (ns) { entry.namespace = ns[1]; clause = clause.replace(ns[0], ""); }
    const def = clause.split(",").map((s) => s.trim()).find((s) => IDENT.test(s));
    if (def) entry.names.unshift({ imported: "default", local: def });
    out.push(entry);
  }
  return out;
}

/** A stand-in that lets a file importing these names load: each is a
 *  function that throws, saying it is a stand-in. Run as a program it does
 *  nothing. A name that is not an identifier is left out. */
export function declarationStandIn(names = []) {
  const lines = [
    "// A stand-in the test writer put here: it exports the names the suite imports and does nothing.",
    "const standIn = (name) => function standIn() { throw new Error(`stand-in: ${name} is not written yet`); };",
  ];
  for (const n of [...new Set(names)]) {
    if (n === "default") lines.push('export default standIn("default");');
    else if (IDENT.test(n)) lines.push(`export const ${n} = standIn(${JSON.stringify(n)});`);
  }
  return lines.join("\n") + "\n";
}

/** The lines where a test, suite or case is declared in a file. */
const testStarts = (text) => String(text ?? "").split("\n")
  .map((l, i) => (/^\s*(?:test|it|describe|suite)(?:\.\w+)?\s*\(/.test(l) ? i + 1 : 0)).filter(Boolean);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Code with its quoted strings and line comments blanked, so a test named
 *  "counts count-words" does not read as calling `words`. Template literals
 *  are kept, since what is inside `${}` is code. */
const codeOnly = (text) => String(text).replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""').replace(/(^|[^:])\/\/.*$/gm, "$1");
const mentions = (text, word) => new RegExp(`(?<![\\w$.])${escapeRe(word)}(?![\\w$])`).test(codeOnly(text));
/** Starting a program: a test that does reaches a script, whether or not it
 *  names it (a command read from agent-runtime-requirements.json does not). */
const STARTS = /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(|process\.execPath/;

/** The tests in a suite file whose body touches no script, by the line each
 *  is declared on. A body is from its declaration to the next one. It
 *  touches a script when it names a script (its file name, or a path under
 *  scripts/), loads a module by import(), or names anything imported from a
 *  script, a top-level helper in the file that touches one, or a name
 *  imported from a file beside the tests that mentions the scripts or starts
 *  a program, or that cannot be read (`read` is handed the package path of a
 *  file that is not in the suite). Lenient on purpose: a test wrongly read as
 *  touching is only not named. */
export function scriptFreeTests(file, { files = [], scripts = [], read = () => null } = {}) {
  const text = String(file?.text ?? "");
  const lines = text.split("\n");
  const scriptNames = [...new Set([...scripts, ...importsOf(text).filter((i) => i.script).map((i) => i.from)])]
    .map((s) => String(s).split("/").pop()).filter(Boolean);
  const namesScript = (t) => /scripts\/|["'`]scripts["'`]|\bimport\s*\(/.test(t) || STARTS.test(codeOnly(t)) || scriptNames.some((n) => t.includes(n));
  const touching = new Set();
  for (const i of importsOf(text)) {
    const beside = i.script ? null : (files.find((f) => f.path === i.from)?.text ?? read(i.from));
    if (i.script || typeof beside !== "string" || namesScript(beside)) {
      for (const n of i.names) touching.add(n.local);
      if (i.namespace) touching.add(i.namespace);
    }
  }
  // Top-level helpers, each from its line to the next top-level line.
  const starts = new Set(testStarts(text));
  const tops = [];
  lines.forEach((l, i) => {
    const m = /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(l) || /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(l);
    if (m) tops.push({ name: m[1], line: i + 1 });
    else if (/^\S/.test(l) && !/^[}\])]/.test(l)) tops.push({ name: null, line: i + 1 });
  });
  const spans = tops.filter((t) => t.name && !starts.has(t.line)).map((t) => {
    const next = tops.find((u) => u.line > t.line);
    return { name: t.name, text: lines.slice(t.line - 1, next ? next.line - 1 : lines.length).join("\n") };
  });
  for (let grew = true; grew;) {
    grew = false;
    for (const s of spans) {
      if (touching.has(s.name)) continue;
      if (namesScript(s.text) || [...touching].some((w) => mentions(s.text, w))) { touching.add(s.name); grew = true; }
    }
  }
  const all = testStarts(text);
  return all.filter((at, k) => {
    const body = lines.slice(at - 1, k + 1 < all.length ? all[k + 1] - 1 : lines.length).join("\n");
    return !namesScript(body) && ![...touching].some((w) => mentions(body, w));
  });
}

/** The failures that no script can mend: a test's own code failing (not a
 *  parent failing for its children, a hook, or a file that did not load),
 *  in a test placed in the suite and touching no script. A file missing
 *  outside the package is not the declaration's to answer for, and is not
 *  named either. Pure, apart from `read`. */
export function unpassableFrom(failures = [], { dir = "", files = [], scripts = [], read = () => null } = {}) {
  const free = new Map(files.map((f) => [f.path, new Set(scriptFreeTests(f, { files, scripts, read }))]));
  const out = []; const seen = new Set();
  for (const f of failures) {
    if (f?.failureType && f.failureType !== "testCodeFailure") continue;
    if (!f?.file || !f.line) continue;
    // A stand-in that was called says so: the test reached a script.
    if (/stand-in: /.test(String(f.error ?? ""))) continue;
    // A worked value that disagrees is said as that, not as a test no
    // script can mend (worked-values.test.mjs adds the test that fails).
    if (String(f.error ?? "").startsWith(WORKED_WRONG)) continue;
    const missing = /ENOENT[^']*'([^']+)'/.exec(String(f.error ?? ""));
    if (missing && dir && !resolve(missing[1]).startsWith(resolve(dir))) continue;
    const file = String(f.file).startsWith("file:") ? new URL(f.file).pathname : String(f.file);
    const path = relative(dir || ".", file).replace(/\\/g, "/");
    const at = free.get(path) ?? free.get(files.find((x) => path.endsWith(x.path))?.path);
    if (!at || !at.has(f.line)) continue;
    const key = `${path}:${f.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path: files.find((x) => path.endsWith(x.path))?.path ?? path, line: f.line, name: trim(f.name), error: trim(f.error).slice(0, 300) });
  }
  return out;
}

/** How the worked-values check (references/worked-values.test.mjs, copied
 *  into every suite) opens the failure it reports when a worked value is not
 *  what its own computation gives (technical debt 646). The same words as
 *  that file's WRONG. */
export const WORKED_WRONG = "worked values disagree with their own computations:";

/** Each worked value that disagrees, one sentence each, out of the
 *  failures the declaration run read. Said once each, in the order found. */
export function wrongValuesFrom(failures = []) {
  const out = [];
  for (const f of failures) {
    const e = String(f?.error ?? "");
    if (!e.startsWith(WORKED_WRONG)) continue;
    for (const line of e.slice(WORKED_WRONG.length).split("\n").map(trim).filter(Boolean)) if (!out.includes(line)) out.push(line);
  }
  return out;
}

/** The reporter the declaration run uses: one JSON line per failure. */
const REPORTER = `export default async function* report(source) {
  for await (const e of source) {
    if (e.type === "test:pass" && !e.data?.skip && !e.data?.todo) yield "DECLARATION-PASS\\n";
    if (e.type !== "test:fail") continue;
    const d = e.data ?? {};
    const err = d.details?.error;
    yield "DECLARATION-FAIL " + JSON.stringify({ name: d.name, file: d.file ?? null, line: d.line ?? null,
      failureType: err?.failureType ?? null, error: String(err?.cause?.message ?? err?.message ?? "") }) + "\\n";
  }
}
`;

/** The suite beside the agent's own files, every script stood in by a
 *  module exporting the names the suite imports. Returns the counts and the
 *  tests that touch no script and still fail. Pure apart from the scratch
 *  folder, which is made and removed here. */
export function declarationRun({ spec, files, folder = null, spawn = spawnSync } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "test-writer-declaration-"));
  try {
    const dir = join(scratch, "package");
    if (folder) {
      const skip = new Set(["scripts", "node_modules", ".git"].map((n) => resolve(folder, n)));
      cpSync(folder, dir, { recursive: true, filter: (src) => ![...skip].some((s) => resolve(src) === s) });
    } else {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "spec.json"), JSON.stringify(spec, null, 2) + "\n");
    }
    const wanted = new Map(scriptsOf(spec).map((s) => [posix.normalize(s.replace(/\\/g, "/")), new Set()]));
    for (const f of files.filter((x) => isTestPath(x.path))) {
      for (const i of importsOf(f.text)) {
        if (!i.script) continue;
        if (!wanted.has(i.from)) wanted.set(i.from, new Set());
        for (const n of i.names) wanted.get(i.from).add(n.imported);
      }
    }
    for (const [s, names] of wanted) {
      if (!staysInside(s)) throw new Error(`the spec names a script outside the package: ${s}`);
      const at = join(dir, s);
      mkdirSync(dirname(at), { recursive: true });
      writeFileSync(at, declarationStandIn([...names]));
    }
    const paths = placeSuite(files, dir);
    const reporter = join(scratch, "reporter.mjs");
    writeFileSync(reporter, REPORTER);
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith("NODE_TEST_")) delete env[k];
    const r = spawn("node", ["--test", `--test-reporter=${pathToFileURL(reporter).href}`, ...paths], {
      cwd: dir, env, encoding: "utf8", timeout: RUN_SECONDS * 1000,
    });
    const out = String(r.stdout ?? "").split("\n");
    const failures = out.filter((l) => l.startsWith("DECLARATION-FAIL "))
      .map((l) => { try { return JSON.parse(l.slice("DECLARATION-FAIL ".length)); } catch { return null; } }).filter(Boolean);
    return {
      against: "the agent's own files",
      pass: out.filter((l) => l.trim() === "DECLARATION-PASS").length,
      failed: failures.length,
      timed_out: !!r.error && /ETIMEDOUT|timed out/i.test(String(r.error?.code ?? r.error?.message ?? "")),
      // Every file loads here, so every worked value at the top of a file is
      // checked against its computation (technical debt 646).
      wrong_values: wrongValuesFrom(failures),
      unpassable: unpassableFrom(failures, {
        dir, files: files.filter((x) => isTestPath(x.path)), scripts: [...wanted.keys()],
        read: (p) => (staysInside(p) && existsSync(join(dir, p)) ? readFileSync(join(dir, p), "utf8") : null),
      }),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Both runs against nothing: empty stand-ins, where the suite must fail,
 *  and the agent's own files, where a test that touches no script must
 *  pass. The stand-in run's numbers, with the tests no script can mend. */
export function standInChecks({ spec, files, folder = null, spawn } = {}) {
  const standIns = standInRun({ spec, files, folder, spawn });
  const declarations = declarationRun({ spec, files, folder, ...(spawn ? { spawn } : {}) });
  return { ...standIns, unpassable: declarations.unpassable, wrong_values: declarations.wrong_values ?? [] };
}

/** A copy of a package for the suite to run in: everything but its own
 *  test folder, which is the suite being replaced. */
export function copyPackage(from, to) {
  const skip = resolve(from, "test");
  cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      const r = resolve(src);
      return r !== skip && !r.startsWith(skip + "\\") && !r.startsWith(skip + "/") && !/node_modules|\.git$/.test(basename(r));
    },
  });
}

/** The suite against a package's own scripts, then against that package with
 *  each script blanked in turn. */
export function provingRuns({ spec, files, realDir, spawn } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "test-writer-prove-"));
  try {
    const whole = join(scratch, "whole");
    copyPackage(realDir, whole);
    const paths = placeSuite(files, whole);
    const real = { against: basename(realDir), ...runSuite(whole, paths, { spawn }) };
    const mutations = [];
    for (const s of scriptsOf(spec)) {
      const dir = join(scratch, `without-${mutations.length}`);
      copyPackage(realDir, dir);
      placeSuite(files, dir);
      if (!staysInside(s)) throw new Error(`the spec names a script outside the package: ${s}`);
      const at = join(dir, s);
      mkdirSync(dirname(at), { recursive: true });
      writeFileSync(at, "");
      const run = runSuite(dir, paths, { spawn });
      mutations.push({ script: s, noticed: run.fails, tests: run.tests, pass: run.pass, fail: run.fail });
    }
    return { real, mutations };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The verdict in words. The reply carries it as written. */
export function verdict({ standIns = null, real = null, mutations = [] } = {}) {
  const lines = [];
  if (standIns) {
    const k = standIns.scripts;
    if (standIns.timed_out) {
      lines.push(`Against empty stand-ins for the ${k} script${k === 1 ? "" : "s"} it names, the suite did not finish in ${RUN_SECONDS} seconds, which is a fault in the suite.`);
    } else if (standIns.fails) {
      lines.push(`Against empty stand-ins for the ${k} script${k === 1 ? "" : "s"} it names, the suite fails (${standIns.pass} of ${standIns.tests} pass), which is what a suite written before the scripts must do.`);
    } else {
      lines.push(`Against empty stand-ins for the ${k} script${k === 1 ? "" : "s"} it names, the suite passes (${standIns.pass} of ${standIns.tests}), so it asserts nothing about them. It is not a suite yet.`);
    }
    const u = standIns.unpassable ?? [];
    if (u.length) {
      lines.push(`${u.length === 1 ? "One test touches" : `${u.length} tests touch`} no script and still ${u.length === 1 ? "fails" : "fail"} against the agent's own files, so no script can ever make ${u.length === 1 ? "it" : "them"} pass: ${u.map((x) => `"${x.name}" (${x.path})`).join(", ")}.`);
    }
    const w = standIns.wrong_values ?? [];
    if (w.length) {
      lines.push(`${w.length === 1 ? "One worked value disagrees with its own computation" : `${w.length} worked values disagree with their own computations`}, so the suite pins ${w.length === 1 ? "a value" : "values"} the spec's rule may not give, and a script that keeps the spec cannot pass ${w.length === 1 ? "it" : "them"}: ${w.join("; ")}.`);
    }
  }
  if (real) {
    if (real.timed_out) lines.push(`Against ${real.against}'s own scripts the suite did not finish in ${RUN_SECONDS} seconds.`);
    else if (!real.fails) lines.push(`Against ${real.against}'s own scripts, all ${real.tests} pass.`);
    else lines.push(`Against ${real.against}'s own scripts, ${real.fail} of ${real.tests} fail. The failures are the script owner's to read; nothing here changed a test to make them pass.`);
  }
  if (mutations.length) {
    const missed = mutations.filter((m) => !m.noticed).map((m) => m.script);
    if (!missed.length) lines.push(`Broken one script at a time, the suite noticed every one of the ${mutations.length}.`);
    else lines.push(`Broken one script at a time, the suite did not notice ${missed.join(", ")} going missing: nothing tests ${missed.length === 1 ? "it" : "them"}.`);
  }
  return lines.join(" ");
}

const thisFile = process.argv[1] ? process.argv[1].replace(/\\/g, "/").split("/").pop() : "";
if (thisFile && import.meta.url.endsWith(thisFile)) {
  const { SUITE, SPEC, RECORDS, AGAINST } = process.env;
  if (!SUITE || !SPEC || !RECORDS) { console.error("SUITE, SPEC and RECORDS are required"); process.exit(2); }
  try {
    const spec = loadSpec(SPEC);
    const folder = statSync(SPEC).isDirectory() ? SPEC : null;
    const files = suiteFiles(SUITE);
    // The files the suite carries beside its tests go with it, never run.
    const carried = supportFiles(SUITE);
    if (!files.length) {
      console.log(JSON.stringify({ ok: false, code: 3, reply: `There is no suite under ${join(SUITE, "test")} to check: nothing named test/<name>.test.mjs.` }));
      process.exitCode = 3;
    } else {
      const standIns = standInChecks({ spec, files: [...files, ...carried], folder });
      let real = null; let mutations = [];
      if (AGAINST) {
        if (!existsSync(join(AGAINST, "scripts"))) throw new Error(`${AGAINST} has no scripts folder to prove the suite against`);
        ({ real, mutations } = provingRuns({ spec, files: [...files, ...carried], realDir: AGAINST }));
      }
      const said = verdict({ standIns, real, mutations });
      const record = { checked: "v1", at: new Date().toISOString(), files: files.map((f) => f.path), stand_ins: standIns, real, mutations, verdict: said };
      mkdirSync(RECORDS, { recursive: true });
      writeFileSync(join(RECORDS, "checked.json"), JSON.stringify(record, null, 2) + "\n");
      console.log(said);
    }
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
