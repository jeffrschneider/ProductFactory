// The check: whether the harness is done, and what it may not have touched.
//
// The harness runs this as often as it likes. Each run is one round, and
// each round is appended to the record so a reader afterwards sees how many
// it took and what failed on each. Done is four things, all mechanical: the
// suite passes; each script blanked in turn is noticed; the builder takes the
// package, when the builder is on this host; and the fence held, meaning no
// test, no spec line and no prototype file changed, and nothing was written
// outside scripts/ and the two record files. A blanked script the suite does
// not notice is recorded and said, not held against the harness, because
// fixing it means writing a test and that is not the harness's to do.
//
// A new test file under test/ is allowed and runs with the rest. A pinned
// test or agent file that is changed or removed is not, and the round says
// the work goes back to the spec and test steps, because those files are
// theirs and never the writer's.
//
// Run from a build folder's .adlc/, with no variables, it checks the folder
// it sits in against build.lock.json and keeps its records under records/.
//
// In a clone of the branch a hand-off pushed, three things are not the
// coding agent's doing and do not break the fence. Git's own folder, .git, is
// never walked. A pinned text file whose bytes differ only by CRLF line ends,
// which git's core.autocrlf writes on checkout, is the same file: when the
// byte-exact digest fails and the file holds no NUL byte, CRLF is read as LF
// and compared again; a binary file stays byte for byte. And the
// repository's own files: a file git held in the parent of the commit that
// added build.lock.json was on the branch before the hand-off, so it is not
// judged while it is unchanged against that parent's blob (CRLF read as LF
// again); changed or removed, it breaks the fence, as at the service's gate.
// This needs git and the history back to that parent; without either (no
// git, not a clone, a clone of depth 1, a hand-off in the root commit) no
// file is the repository's own and every file outside the lock and scripts/
// is judged as before.
//
// A hand-off goes to a folder of its own in the repository, agents/<name>/
// (technical debt 653), and the services gate refuses any change outside that
// folder. So when the build folder is not the top of its clone, a file
// outside it that differs from the hand-off commit (changed, removed or
// added, committed or not, ignored files aside) breaks the fence by name too.
// An earlier hand-off elsewhere in the repository is outside the folder: it is
// neither walked nor run (debt 632).
//
// Exit codes are the harness's instructions: 0 done, 1 not yet with each
// failing test named, 3 the fence was broken with what was touched named,
// 4 the rounds are used up.
//
//   needs: node >= 22; python3 and the builder, or it says the package-maker will build it
//   WORKSPACE=<folder> RECORDS=<records folder> [BUILDER=<path to the builder>] node check.mjs
//   or, in a build folder: node .adlc/check.mjs
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LOCK_FILE, digestOf, listing, lockedDigests, roundsMaxOf, scriptsOf } from "./workspace.mjs";
import { specOfFolder } from "./agent-folder.mjs";

const trim = (s) => String(s ?? "").trim();

/** How long one run of the suite may take. */
export const RUN_SECONDS = 120;

/** The builder, where the fleet keeps it. Not a declared setting: it belongs
 *  to no system, and the check says plainly when it is not there. */
export const BUILDER_DEFAULT = "/opt/fleet/agentbuilder-build.py";
export const builderAt = (env = {}) => trim(env.BUILDER) || BUILDER_DEFAULT;

/** The suite's files under a workspace, as paths the runner takes. */
export function suitePaths(dir) {
  const at = join(dir, "test");
  if (!existsSync(at)) return [];
  return readdirSync(at).filter((n) => n.endsWith(".test.mjs")).sort().map((n) => `test/${n}`);
}

/** What node's TAP reporter says at the end. */
export function tapSummary(output) {
  const n = (k) => { const m = new RegExp(`^# ${k} (\\d+)`, "m").exec(output); return m ? Number(m[1]) : 0; };
  return { tests: n("tests"), pass: n("pass"), fail: n("fail") + n("cancelled") };
}

/** Each failing test by name, as the harness needs it to know what to fix.
 *  Nested subtests are indented and their parent is listed too; the parent
 *  is dropped when a child already names the failure. */
export function tapFailures(output, max = 40) {
  const lines = String(output ?? "").split(/\r?\n/);
  const out = [];
  for (const raw of lines) {
    const m = /^(\s*)not ok \d+ - (.+?)\s*(?:#.*)?$/.exec(raw);
    if (!m) continue;
    const name = trim(m[2]);
    if (!name || out.includes(name)) continue;
    out.push(name);
  }
  return out.slice(0, max);
}

/** Run the suite in a folder. `spawn` is handed in by tests. */
export function runSuite(dir, paths, { spawn = spawnSync } = {}) {
  // A child started from inside a node:test process inherits NODE_TEST_CONTEXT
  // and then refuses to run any file, so the suite runs in a clean environment.
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("NODE_TEST_")) delete env[k];
  const started = Date.now();
  const r = spawn("node", ["--test", "--test-reporter=tap", ...paths], { cwd: dir, env, encoding: "utf8", timeout: RUN_SECONDS * 1000 });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const sum = tapSummary(out);
  const status = typeof r.status === "number" ? r.status : 1;
  const timedOut = !!r.error && /ETIMEDOUT|timed out/i.test(String(r.error?.code ?? r.error?.message ?? ""));
  return {
    ...sum, status,
    fails: status !== 0 || sum.fail > 0 || sum.tests === 0,
    timed_out: timedOut,
    failing: tapFailures(out),
    seconds: Math.round((Date.now() - started) / 100) / 10,
    tail: out.trim().slice(-2400),
  };
}

/** What the fence never walks: the records, and git's own folder. */
export const UNWALKED = ["records", ".git"];

/** A file's git blob id, which is how git names the repository's own files. */
export const gitBlobSha = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

/** The bytes with CRLF read as LF, or null for a binary file (one holding a
 *  NUL byte, which git leaves alone on checkout too). */
export function asLf(bytes) {
  const b = Buffer.from(bytes);
  if (b.includes(0)) return null;
  return b.includes(0x0d) ? Buffer.from(b.toString("latin1").replace(/\r\n/g, "\n"), "latin1") : null;
}

/** Whether a file's bytes match a digest, byte for byte or, for a text file,
 *  with CRLF read as LF. `hash` is the digest function. */
const matches = (bytes, want, hash) => {
  if (hash(bytes) === want) return true;
  const lf = asLf(bytes);
  return !!lf && hash(lf) === want;
};

/** git run in `dir`: its output, or null when git is missing or refuses. */
const gitIn = (dir, run) => (...args) => {
  try {
    const r = run("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return r && r.status === 0 ? String(r.stdout ?? "") : null;
  } catch { return null; }
};

/** The commit that added this folder's build.lock.json: the hand-off. */
const handoffCommit = (git) => {
  const added = trim(git("log", "--diff-filter=A", "--format=%H", "-n", "1", "--", LOCK_FILE));
  return /^[0-9a-f]{7,64}$/.test(added) ? added : "";
};

/** What the fence calls a file outside the build folder that moved. */
const OUTSIDE = { A: "added outside the build folder", D: "removed outside the build folder", M: "changed outside the build folder" };

/** Files outside the build folder that differ from the hand-off commit, as
 *  fence entries with paths from the top of the repository. A hand-off goes
 *  to a folder of its own (agents/<name>/, technical debt 653), and the
 *  services gate refuses any change outside it, so this says the same here:
 *  changed, removed or added, in the working tree or committed since, and a
 *  file git does not track yet (one it ignores is left alone). Empty when the
 *  folder is the top of its repository (everything is inside it), when there
 *  is no git, and when no commit added this folder's lock. `run` is handed in
 *  by tests. */
export function outsideChanges(dir, { run = spawnSync } = {}) {
  const git = gitIn(dir, run);
  const prefix = trim(git("rev-parse", "--show-prefix"));
  if (!prefix) return [];
  const added = handoffCommit(git);
  if (!added) return [];
  const out = new Map();
  const diff = git("diff", "--name-status", "--no-renames", "-z", added, "--", ":/");
  if (diff == null) return [];
  const parts = diff.split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i].charAt(0);
    const path = parts[i + 1];
    if (!path || path.startsWith(prefix)) continue;
    out.set(path, OUTSIDE[status] ?? OUTSIDE.M);
  }
  for (const path of (git("ls-files", "--others", "--exclude-standard", "--full-name", "-z", "--", ":/") ?? "").split("\0")) {
    if (path && !path.startsWith(prefix)) out.set(path, OUTSIDE.A);
  }
  return [...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, what]) => ({ path, what }));
}

/** The repository's own files: what git held in the parent of the commit
 *  that added build.lock.json in `dir`, as {path relative to dir: blob id}.
 *  Empty when there is no git, no such commit, or no parent. `run` is handed
 *  in by tests. */
export function repoFilesAt(dir, { run = spawnSync } = {}) {
  const git = gitIn(dir, run);
  const added = handoffCommit(git);
  if (!added) return {};
  const parent = trim(git("rev-parse", "--verify", "--quiet", `${added}^`));
  if (!/^[0-9a-f]{7,64}$/.test(parent)) return {};
  const prefix = trim(git("rev-parse", "--show-prefix"));
  const tree = git("ls-tree", "-r", "-z", "--full-tree", parent);
  if (tree == null) return {};
  const out = {};
  for (const entry of tree.split("\0")) {
    const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/s.exec(entry);
    if (!m || !m[2].startsWith(prefix)) continue;
    out[m[2].slice(prefix.length)] = m[1];
  }
  return out;
}

/** The fence: what changed that may not have. Compared against the record
 *  the workspace step wrote, by digest. `repoFiles` is the repository's own
 *  files, {path: git blob id}, which may stay as they were. `outside` is
 *  what moved outside the build folder (outsideChanges), each of which
 *  breaks the fence as it stands. */
export function fenceOf(record, dir, { repoFiles = {}, outside = [] } = {}) {
  const now = listing(dir, { skip: UNWALKED });
  const was = record?.listing ?? {};
  const pinned = record?.digests ?? {};
  const broken = [];
  const free = (p) => p.startsWith("scripts/");
  const newTest = (p) => p.startsWith("test/") && !(p in was);
  // A digest that differs is read again from the file, so a text file whose
  // line ends git changed on checkout is still the same file.
  const same = (p, want) => now[p] === want || matches(readFileSync(join(dir, p)), want, digestOf);
  const ownUnchanged = (p) => matches(readFileSync(join(dir, p)), repoFiles[p], gitBlobSha);
  for (const [p, d] of Object.entries(pinned)) {
    if (!(p in now)) broken.push({ path: p, what: "removed" });
    else if (!same(p, d)) broken.push({ path: p, what: "changed" });
  }
  for (const p of Object.keys(now)) {
    if (p in pinned || free(p) || newTest(p)) continue;
    if (p in repoFiles && !(p in was)) { if (!ownUnchanged(p)) broken.push({ path: p, what: "changed" }); continue; }
    if (!(p in was)) broken.push({ path: p, what: "added" });
    else if (!same(p, was[p])) broken.push({ path: p, what: "changed" });
  }
  for (const p of Object.keys(was)) {
    if (p in pinned || free(p) || p in now) continue;
    broken.push({ path: p, what: "removed" });
  }
  for (const p of Object.keys(repoFiles)) {
    if (p in pinned || p in was || free(p) || p in now || UNWALKED.some((s) => p === s || p.startsWith(s + "/"))) continue;
    broken.push({ path: p, what: "removed" });
  }
  broken.push(...outside);
  return { ok: !broken.length, broken };
}

/** A copy of the workspace to run in, without its records or git's folder. */
function copyWorkspace(from, to) {
  const skips = UNWALKED.map((s) => resolve(from, s));
  cpSync(from, to, { recursive: true, filter: (src) => { const r = resolve(src); return !skips.some((skip) => r === skip || r.startsWith(skip + "\\") || r.startsWith(skip + "/")); } });
}

/** Each script blanked in turn: does the suite notice? */
export function blankRuns({ dir, scripts, paths, spawn } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "code-writer-blank-"));
  try {
    const out = [];
    for (const s of scripts) {
      const at = join(scratch, `without-${out.length}`);
      copyWorkspace(dir, at);
      const target = join(at, s);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "");
      const run = runSuite(at, paths, { spawn });
      out.push({ script: s, noticed: run.fails, tests: run.tests, pass: run.pass, fail: run.fail });
    }
    return out;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The builder over the workspace, into a scratch folder. `run` is handed in
 *  by tests. */
export function buildRun({ dir, builder, run = null, stoodIn = [] } = {}) {
  if (!builder || !existsSync(builder)) {
    return { checked: false, ok: null, said: "The builder is not on this host, so whether the package builds was not checked here; the package-maker builds it and refuses what does not." };
  }
  const scratch = mkdtempSync(join(tmpdir(), "code-writer-build-"));
  try {
    const go = run ?? ((args, opts) => spawnSync("python3", args, { encoding: "utf8", ...opts }));
    // The agent's folder is the workspace itself when its files came; a
    // spec.json, still read for one transition, otherwise.
    const input = existsSync(join(dir, "agent-descriptor.json")) ? dir : join(dir, "spec.json");
    const r = go([builder, input, scratch], { timeout: RUN_SECONDS * 1000 });
    let doc = null;
    try { doc = JSON.parse(String(r.stdout ?? "")); } catch { doc = null; }
    if (doc && doc.ok === true) {
      // Never "builds" when something was stood in: what was checked is the
      // declaration and the scripts, and the reply says which files were empty.
      const said = stoodIn.length
        ? `The builder takes the declaration and the scripts, with ${stoodIn.length} file${stoodIn.length === 1 ? "" : "s"} the spec names stood in as empty (${stoodIn.join(", ")}); those are not this job's to write.`
        : "The builder takes the package.";
      return { checked: true, ok: true, said };
    }
    const why = trim(doc?.error ?? doc?.reason ?? r.stderr ?? r.stdout ?? "").split("\n").slice(-3).join(" ").slice(0, 400);
    return { checked: true, ok: false, said: `The builder refuses the package: ${why || "it gave no reason"}.` };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The words the record and the reply carry. */
export function verdict({ run = null, blanks = [], build = null, round = 0, roundsMax = 0, fence = null, stop = null } = {}) {
  if (stop === "ceiling") return `The rounds are used up: ${roundsMax} of ${roundsMax}, and the suite still fails${run ? ` (${run.fail} of ${run.tests})` : ""}. Nothing is delivered.`;
  if (stop === "fence") {
    const broken = fence?.broken ?? [];
    const said = `The fence was broken: ${broken.map((b) => `${b.path} ${b.what}`).join(", ")}. Put it back; nothing is delivered until the check passes with the fence whole.`;
    const pinned = broken.filter((b) => (b.what === "changed" || b.what === "removed") && (/^test\//.test(b.path) || /^(agent-descriptor|agent-runtime-requirements|plugin)\.json$|^skills\//.test(b.path)));
    return pinned.length ? `${said} A pinned test or agent file is the spec and test steps' to change, never this job's: if it is wrong, the work goes back to the spec and test steps.` : said;
  }
  const lines = [];
  if (run && run.fails) {
    lines.push(`Round ${round}${roundsMax ? ` of ${roundsMax}` : ""}: ${run.timed_out ? `the suite did not finish in ${RUN_SECONDS} seconds` : `${run.fail} of ${run.tests} fail`}.`);
    return lines.join(" ");
  }
  lines.push(`Round ${round}: the suite passes, ${run?.pass ?? 0} of ${run?.tests ?? 0}.`);
  const missed = blanks.filter((b) => !b.noticed).map((b) => b.script);
  if (blanks.length) {
    lines.push(missed.length
      ? `Blanked one at a time, the suite did not notice ${missed.join(", ")} going missing: nothing tests ${missed.length === 1 ? "it" : "them"}, which is the test-writer's to fix, not this job's.`
      : `Blanked one at a time, the suite noticed every one of the ${blanks.length}.`);
  }
  if (build) lines.push(build.said);
  return lines.join(" ");
}

/** A build folder worked in place: its lock is the record, and the baseline
 *  is what the lock pins, never the folder as it stands, so a file added
 *  outside scripts/ before the first run is still reported as added. Only the
 *  lock itself, which pins nothing of itself, is taken as it is. */
export function recordFromLock(lock, lockBytes, { folder, roundsMax }) {
  const baseline = { ...lockedDigests(lock) };
  baseline[LOCK_FILE] = digestOf(lockBytes);
  return { workspace: "v1", at: new Date().toISOString(), folder, rounds_max: roundsMax, from_build_folder: true,
    scripts: Array.isArray(lock.scripts) ? lock.scripts : [], digests: lockedDigests(lock), listing: baseline };
}

/** Whether a record taken from a build folder's lock is of a lock other than
 *  the one on disk: the branch moved on (revised tests, debt 636). The fence
 *  that counts is the gate's, on our side; this keeps the local check in step. */
export function recordIsStale(record, lockBytes) {
  return record?.from_build_folder === true && record?.listing?.[LOCK_FILE] !== digestOf(lockBytes);
}

const thisFile = process.argv[1] ? process.argv[1].replace(/\\/g, "/").split("/").pop() : "";
if (thisFile && import.meta.url.endsWith(thisFile)) {
  const env = process.env;
  let { WORKSPACE, RECORDS } = env;
  // Run from a build folder's .adlc/ with nothing set, it checks the folder
  // it sits in and keeps its records under records/, which the fence skips.
  const here = dirname(fileURLToPath(import.meta.url));
  if (!WORKSPACE && !RECORDS && basename(here) === ".adlc") { WORKSPACE = dirname(here); RECORDS = join(WORKSPACE, "records"); }
  if (!WORKSPACE || !RECORDS) { console.error("WORKSPACE and RECORDS are required"); process.exit(2); }
  const recordPath = join(RECORDS, "workspace.json");
  const lockAt = join(WORKSPACE, LOCK_FILE);
  // A record taken from a lock the branch has since moved past (the tests
  // were revised, debt 636) is taken again from the new lock.
  const kept = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, "utf8")) : null;
  if (existsSync(lockAt) && (!kept || recordIsStale(kept, readFileSync(lockAt)))) {
    const lockBytes = readFileSync(lockAt);
    mkdirSync(RECORDS, { recursive: true });
    writeFileSync(recordPath, JSON.stringify(recordFromLock(JSON.parse(lockBytes.toString("utf8")), lockBytes, { folder: WORKSPACE, roundsMax: roundsMaxOf(env) }), null, 2) + "\n");
  }
  if (!existsSync(recordPath)) { console.error(`no workspace record at ${recordPath}: run workspace.mjs first`); process.exit(2); }
  try {
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    const runsPath = join(RECORDS, "runs.json");
    const runs = existsSync(runsPath) ? (JSON.parse(readFileSync(runsPath, "utf8")).runs ?? []) : [];
    const roundsMax = Number(record.rounds_max) || 30;
    const round = runs.length + 1;
    const writeVerdict = (v) => writeFileSync(join(RECORDS, "verdict.json"), JSON.stringify({ verdict: "v1", at: new Date().toISOString(), ...v }, null, 2) + "\n");
    if (round > roundsMax) {
      const said = verdict({ stop: "ceiling", roundsMax, run: runs[runs.length - 1] ?? null });
      writeVerdict({ done: false, stop: "ceiling", round: runs.length, said });
      console.log(said);
      process.exit(4);
    }
    // A build folder may sit in a clone of the branch it was pushed to, beside
    // the repository's own files; git says which those are.
    const fence = fenceOf(record, WORKSPACE, record.from_build_folder ? { repoFiles: repoFilesAt(WORKSPACE), outside: outsideChanges(WORKSPACE) } : {});
    if (!fence.ok) {
      const said = verdict({ stop: "fence", fence });
      writeVerdict({ done: false, stop: "fence", round: runs.length, broken: fence.broken, said });
      console.log(said);
      process.exit(3);
    }
    const declared = existsSync(join(WORKSPACE, "agent-descriptor.json")) || existsSync(join(WORKSPACE, "spec.json"));
    // Where no declaration came (a folder with only scripts and a suite), the
    // scripts are the ones the workspace record names, or all under scripts/.
    const scriptsToBlank = declared
      ? scriptsOf(existsSync(join(WORKSPACE, "agent-descriptor.json")) ? specOfFolder(WORKSPACE) : JSON.parse(readFileSync(join(WORKSPACE, "spec.json"), "utf8")))
      : (record.scripts?.length ? record.scripts.map((x) => x.path) : Object.keys(listing(join(WORKSPACE, "scripts"))).map((r) => `scripts/${r}`));
    const paths = suitePaths(WORKSPACE);
    const run = runSuite(WORKSPACE, paths);
    runs.push({ round, at: new Date().toISOString(), tests: run.tests, pass: run.pass, fail: run.fail, failing: run.failing, seconds: run.seconds, timed_out: run.timed_out });
    writeFileSync(runsPath, JSON.stringify({ runs: "v1", rounds_max: roundsMax, runs }, null, 2) + "\n");
    if (run.fails) {
      const said = verdict({ run, round, roundsMax });
      writeVerdict({ done: false, stop: null, round, said, failing: run.failing });
      console.log(said);
      if (run.failing.length) console.log(run.failing.map((n) => `  not ok: ${n}`).join("\n"));
      // The runner's own output only when no test could be named: that is a
      // suite that did not load, and the error is the thing to read.
      else console.log(run.tail);
      process.exit(1);
    }
    const blanks = blankRuns({ dir: WORKSPACE, scripts: scriptsToBlank.filter((p) => existsSync(join(WORKSPACE, p))), paths });
    const build = declared
      ? buildRun({ dir: WORKSPACE, builder: builderAt(env), stoodIn: record.stood_in ?? [] })
      : { checked: false, ok: null, said: "No declaration came with the folder, so whether the package builds was not checked here; the package-maker builds it and refuses what does not." };
    if (build.checked && !build.ok) {
      const said = `${verdict({ run, round, blanks })} ${build.said}`;
      writeVerdict({ done: false, stop: null, round, said, blanks, build });
      console.log(said);
      process.exit(1);
    }
    const said = verdict({ run, round, blanks, build });
    writeVerdict({ done: true, round, tests: run.tests, blanks, unnoticed: blanks.filter((b) => !b.noticed).map((b) => b.script), build, said });
    console.log(`Done. ${said}`);
    process.exit(0);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
