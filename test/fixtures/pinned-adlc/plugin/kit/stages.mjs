// The two phases of a build, and the gates the check runs over the result.
//
// One builder writes the whole agent. There are two phases:
//   1. The spec. The builder writes it from the person's words, and the person
//      approves it. Nothing is built on a spec the person has not approved.
//   2. The build. The builder writes everything else (the architecture record,
//      the agent's files, the tests and the code) in whatever order it works
//      best. The check runs every gate over the folder and names what is still
//      missing at each one.
//
// Only two things have a fixed order: the person's approval of the spec comes
// before the build, and the tests are fixed the first time the code is judged,
// so they cannot be changed to fit the code. To change either afterwards, the
// person sends the build back (`node .adlc/approve.mjs --send-back spec` or
// `build`).
//
// The lock file, build.lock.json, records what can no longer change (`digests`)
// and which phases have passed (`gates`).
//
//   needs: node >= 22
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, sep } from "node:path";
import { LOCK_FILE, digestOf, scriptsOf as codeScriptsOf } from "./code-writer/scripts/workspace.mjs";
import { specOfFolder } from "./code-writer/scripts/agent-folder.mjs";
import { corpusOf, coverageProblems, specProblems } from "./spec-writer/scripts/spec-check.mjs";
import { checkDraft } from "./spec-writer/scripts/check-spec.mjs";
import { addressProblems } from "./spec-writer/scripts/design.mjs";
import { declarationProblems } from "./spec-writer/scripts/declared.mjs";
import { givenOfSpec } from "./spec-writer/scripts/given.mjs";
import { loadSchemas } from "./spec-writer/scripts/can-use.mjs";
import { filesFrom, recordFrom, standardTestsOf } from "./generate.mjs";
import { parseRecord } from "./spec-writer/scripts/architecture-record.mjs";
import { structureOf } from "./spec-writer/scripts/structure.mjs";
import { RUN_SECONDS, declarationRun, declarationStandIn, importsOf, placeSuite, runSuite, standInPackage, suiteFiles, supportFiles } from "./test-writer/scripts/check-suite.mjs";
import { bracketIdsOf, scenariosOf, specFindings } from "./test-writer/scripts/spec-rules.mjs";
import { testNamesIn } from "./test-writer/scripts/suite-rules.mjs";
import { loadSpec } from "./test-writer/scripts/agent-folder.mjs";
import { PACKER, pack } from "./packer.mjs";
import { answersOf } from "./answers.mjs";

const trim = (s) => String(s ?? "").trim();
const list = (v) => (Array.isArray(v) ? v : []);

export const PHASES = ["spec", "build"];
export const TITLES = { spec: "The spec", build: "The build" };
export const BY_PERSON = new Set(["spec"]);

/** The gates of the build phase. They are checked together, in no order the
 *  builder must follow; a gate that needs another's output says so. */
export const GATES = ["architecture", "files", "test", "code"];
export const GATE_TITLES = { architecture: "Architecture", files: "The agent's files", test: "Test", code: "Code" };

/** The files each phase fixes when it passes, as paths in the folder; a
 *  pattern ending in / is every file under it. Only the files that are there
 *  are fixed. */
export const PINS = {
  spec: ["spec.json", "spec.md", "request.md"],
  build: ["architecture.json", "answers.json", "stack.json", "architecture-record.md", "prose.json", "agent-descriptor.json", "agent-runtime-requirements.json", "plugin.json", "skills/*/SKILL.md", "test/", "scripts/"],
};

/** The tests, fixed the first time the code is judged. */
export const TEST_FILES = "test/";

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const posix = (p) => p.split(sep).join("/");

function walk(dir, base = dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const at = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(at, base));
    else out.push(posix(relative(base, at)));
  }
  return out;
}

/** The files a phase fixes that are in the folder now. */
export function pinsOf(phase, dir) {
  const out = [];
  for (const p of PINS[phase] ?? []) {
    if (p.endsWith("/")) out.push(...walk(join(dir, p)).map((r) => `${p}${r}`));
    else if (p.includes("*")) {
      const [head, , tail] = p.split("/");
      for (const d of existsSync(join(dir, head)) ? readdirSync(join(dir, head)) : []) {
        const rel = `${head}/${d}/${tail}`;
        if (existsSync(join(dir, rel)) && statSync(join(dir, rel)).isFile()) out.push(rel);
      }
    } else if (existsSync(join(dir, p))) out.push(p);
  }
  return out.sort();
}

/** The lock as it stands, or a new one. */
export function lockOf(dir) {
  const lock = readJson(join(dir, LOCK_FILE));
  return lock && lock.build_lock === "v1" ? { digests: {}, gates: {}, ...lock } : { build_lock: "v1", digests: {}, gates: {} };
}

export const writeLock = (dir, lock) => writeFileSync(join(dir, LOCK_FILE), JSON.stringify(lock, null, 2) + "\n");

/** The five stage gates a lock carried before the two phases. */
export const OLD_STAGES = ["requirements", "architecture", "files", "test", "code"];

/** A lock written in the five stages, brought to the two phases: an approved
 *  spec stays approved and fixed; every later stage's pass is dropped, so the
 *  build is checked again by its gates, and its files and the tests are free
 *  to change until the code is judged. A lock already in the two phases comes
 *  back as it was. Returns { lock, moved }. */
export function migrateLock(lock) {
  const gates = lock.gates ?? {};
  if (!OLD_STAGES.some((s) => s in gates)) return { lock, moved: false };
  const next = { ...lock, gates: {} };
  delete next.scripts;
  delete next.tests_fixed;
  if (gates.requirements) next.gates.spec = { ...gates.requirements };
  next.digests = Object.fromEntries(Object.entries(lock.digests ?? {}).filter(([p]) => ownerOf(p) !== "build" && (ownerOf(p) !== "spec" || gates.requirements)));
  return { lock: next, moved: true };
}

/** The phase the folder is in: the first not passed, or null when both have. */
export const phaseOf = (lock) => PHASES.find((p) => !lock.gates?.[p]) ?? null;

/** Whether a file is the one fixed in the lock: its bytes, or its bytes with
 *  git's CRLF line ends on checkout turned back into LF. */
export function sameAsFixed(bytes, want) {
  if (digestOf(bytes) === want) return true;
  const text = bytes.toString("utf8");
  return text.includes("\r\n") && digestOf(Buffer.from(text.replace(/\r\n/g, "\n"), "utf8")) === want;
}

/** Every file that can no longer change and changed or went, against the lock. */
export function pinProblems(dir, lock) {
  const out = [];
  for (const [p, want] of Object.entries(lock.digests ?? {})) {
    const back = ownerOf(p) === "spec" ? "spec" : "build";
    if (!existsSync(join(dir, p))) out.push(`${p} can no longer change, and it is gone; put it back, or ask the person to send the build back (--send-back ${back})`);
    else if (!sameAsFixed(readFileSync(join(dir, p)), want)) out.push(`${p} can no longer change, and it changed; put it back, or ask the person to send the build back (--send-back ${back})`);
  }
  return out;
}

const sortedDigests = (d) => Object.fromEntries(Object.entries(d).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** The lock with a phase passed: its gate, and its files fixed. */
export function pass(dir, lock, phase, { by = "check", at = new Date().toISOString() } = {}) {
  const digests = { ...lock.digests };
  for (const p of pinsOf(phase, dir)) digests[p] = digestOf(readFileSync(join(dir, p)));
  return { ...lock, digests: sortedDigests(digests), gates: { ...lock.gates, [phase]: { passed: true, by, at } } };
}

/** The lock with the tests fixed: done the first time the code is judged,
 *  so the tests cannot then be changed to fit the code. */
export function fixTests(dir, lock, { at = new Date().toISOString() } = {}) {
  const digests = { ...lock.digests };
  for (const r of walk(join(dir, TEST_FILES))) digests[`${TEST_FILES}${r}`] = digestOf(readFileSync(join(dir, TEST_FILES, r)));
  return { ...lock, digests: sortedDigests(digests), tests_fixed: { at } };
}

/** The lock sent back to a phase: that phase, and the build after it, open
 *  again, the tests no longer fixed, and their files free to change. A build
 *  sent back keeps a fingerprint of its files as they were (`sent_back`), so
 *  the check neither passes it nor fixes the tests again until something in
 *  it has changed: a send back is never undone by the next run of the check. */
export function sendBack(dir, lock, phase, { at = new Date().toISOString() } = {}) {
  const i = PHASES.indexOf(phase);
  if (i < 0) throw new Error(`${phase} is not a phase; the phases are ${PHASES.join(" and ")}`);
  const reopened = new Set(PHASES.slice(i));
  const digests = Object.fromEntries(Object.entries(lock.digests ?? {}).filter(([p]) => !reopened.has(ownerOf(p))));
  const gates = Object.fromEntries(Object.entries(lock.gates ?? {}).filter(([s]) => !reopened.has(s)));
  const { tests_fixed: _dropped, sent_back: _was, ...rest } = lock;
  return { ...rest, digests, gates, ...(phase === "build" ? { sent_back: { at, files: buildFingerprint(dir) } } : {}) };
}

/** Every file of the build, by path, and its digest. */
export function buildFingerprint(dir) {
  return Object.fromEntries(walk(dir).filter((p) => ownerOf(p) === "build").sort().map((p) => [p, digestOf(readFileSync(join(dir, p)))]));
}

/** Whether a build sent back is just as it was when it was sent back. */
export function unchangedSinceSentBack(dir, lock) {
  const was = lock.sent_back?.files;
  if (!was) return false;
  const now = buildFingerprint(dir);
  const keys = new Set([...Object.keys(was), ...Object.keys(now)]);
  return [...keys].every((p) => was[p] === now[p]);
}

const matches = (pattern, p) => (pattern.endsWith("/") ? p.startsWith(pattern)
  : pattern.includes("*") ? new RegExp(`^${pattern.replace(/[.]/g, "\\.").replace(/\*/g, "[^/]+")}$`).test(p)
  : p === pattern);

/** The phase that fixes a path, or null for a file no phase fixes (the kit
 *  under .adlc/, fixed from the start). */
export const ownerOf = (p) => PHASES.find((s) => (PINS[s] ?? []).some((x) => matches(x, p))) ?? null;

// ---------- Requirements ----------

const kinds = (spec) => list(spec?.features).flatMap((f) => list(f?.requirements));

/** Every requirement checked by a scenario, and the refusals, the empty case
 *  and the failure case each stated: the spec writer's own rule, run by its
 *  specProblems too, so the spec it calls ready is never held here. */
export { coverageProblems };

/** The Requirements check: the spec writer's own rules (coverage among them)
 *  over what the person gave (request.md, and their answers in answers.json:
 *  name, price and version are theirs). */
export function requirementsProblems(dir) {
  const spec = readJson(join(dir, "spec.json"));
  if (!spec) return ["spec.json is not in the folder, or is not JSON; write the spec first"];
  const request = existsSync(join(dir, "request.md")) ? readFileSync(join(dir, "request.md"), "utf8") : "";
  if (!trim(request)) return ["request.md is not in the folder; keep the person's own words there first, because every requirement comes from them"];
  const answers = answersOf(dir).values;
  const person = Object.fromEntries(["name", "version", "price"].filter((k) => trim(answers[k])).map((k) => [k, trim(answers[k])]));
  const corpus = corpusOf({ said: request }, answers);
  return specProblems(spec, { corpus, person });
}

// ---------- Architecture ----------

const NOT_BY_HAND = "never edit it by hand: change what it is written from and write it again";

/** The Architecture check: the record is finished, and it is the record the
 *  generator writes from architecture.json and the person's answers, so every
 *  fact in it came through the architect's own naming, binding and checks. */
export async function architectureProblems(dir) {
  const spec = readJson(join(dir, "spec.json"));
  const named = readJson(join(dir, "architecture.json"));
  if (!named) return ["architecture.json is not in the folder; run `node .adlc/generate.mjs brief` for what it holds, write it, then `node .adlc/generate.mjs record`"];
  const text = existsSync(join(dir, "architecture-record.md")) ? readFileSync(join(dir, "architecture-record.md"), "utf8") : "";
  if (!trim(text)) return ["architecture-record.md is not in the folder; run `node .adlc/generate.mjs record`"];
  const given = answersOf(dir);
  const r = await recordFrom({
    spec, named,
    answers: given.values,
    request: existsSync(join(dir, "request.md")) ? readFileSync(join(dir, "request.md"), "utf8") : "",
    stack: readJson(join(dir, "stack.json")),
  });
  // An answer the person's words do not hold up is one they have not given.
  const out = [...given.problems];
  if (r.text !== text) out.push(`architecture-record.md is not what the generator writes from architecture.json and answers.json; run \`node .adlc/generate.mjs record\`, and ${NOT_BY_HAND}`);
  for (const f of r.forbidden) out.push(`the record would carry ${f}; a record names no model, model provider, address or credential`);
  for (const f of r.findings) out.push(`architecture.json: ${f}`);
  for (const q of r.questions) out.push(`the person has not answered ${q.key}: ${q.question} Ask them, and put their answer in answers.json under ${q.key} with their words: {"answer": ..., "said": "<their words, exactly>"}`);
  if (!r.questions.length) for (const p of r.problems) out.push(`the record is not finished: ${p}`);
  // The spec and the record name the same systems: the files are made from
  // both, and a spec system the record knows under another name would
  // otherwise be found only at the agent's files. The mapping is
  // the files generator's own (a public service by its host, else by name).
  const record = parseRecord(text);
  if (Array.isArray(record?.systems)) {
    const named = new Set(record.systems);
    for (const s of list(structureOf(spec, { architecture: record }).draft?.systems)) {
      if (!named.has(s.name)) out.push(`the spec's system ${JSON.stringify(s.from ?? s.name)} is ${s.name} in the files, and the record names no ${s.name}${record.systems.length ? ` (it names ${record.systems.join(", ")})` : ""}; name it the same in both, in plain system words: in architecture.json, or, since the approved spec can no longer change, by asking the person to send the build back to the spec (--send-back spec)`);
    }
  }
  return out;
}

// ---------- The agent's files ----------

/** The check on the agent's files: every one is what the generators write
 *  from the spec, the record and prose.json; every prose key is written; the
 *  files hold what good files hold and every declaration the spec keeps; they
 *  carry no address; and the packer accepts them. */
export async function filesProblems(dir, _lock, { env = process.env, packer = pack } = {}) {
  const spec = readJson(join(dir, "spec.json"));
  const recordText = existsSync(join(dir, "architecture-record.md")) ? readFileSync(join(dir, "architecture-record.md"), "utf8") : "";
  const prose = readJson(join(dir, "prose.json"));
  if (!prose) return ["prose.json is not in the folder; run `node .adlc/generate.mjs files`, which lays out every key, then write the words"];
  const r = filesFrom({ spec, recordText, prose });
  const out = [];
  for (const k of r.empty) out.push(`prose.json: ${k} is empty`);
  for (const k of r.unknown) out.push(`prose.json: ${k} is not a key of the agent's files; move its words to the key that is, or delete it`);
  for (const k of r.refused) out.push(`prose.json: ${k} is fixed by the spec; take it out of prose.json`);
  for (const k of r.misshapen) out.push(`prose.json: ${k === "refuses" ? "refuses is a list of sentences" : `${k} is one string`}`);
  out.push(...r.problems);
  for (const [rel, text] of Object.entries(r.files)) {
    const at = join(dir, rel);
    if (!existsSync(at)) out.push(`${rel} is not in the folder; run \`node .adlc/generate.mjs files\``);
    else if (readFileSync(at, "utf8") !== text) out.push(`${rel} is not what the generators write from the spec, the record and prose.json; run \`node .adlc/generate.mjs files\`, and ${NOT_BY_HAND}`);
  }
  if (out.length) return out;
  out.push(...checkDraft(r.draft, { architecture: r.architecture, given: givenOfSpec(spec), table: loadSchemas() }));
  out.push(...addressProblems(r.worded));
  out.push(...declarationProblems(spec, r.files));
  if (out.length) return [...new Set(out)];
  const packed = packer(dir, { env });
  if (!packed.ok) out.push(`the packer (${PACKER.package} ${PACKER.version}, Common Agent ${PACKER.common_agent}) refuses the folder: ${packed.refused}`);
  return out;
}

// ---------- Test ----------

/** The Test check: the standard checks are the test writer's own bytes;
 *  every approved scenario has a test named for it and no test is named for
 *  no scenario; the test writer's rules for exact values and kept interfaces
 *  hold; and against empty stand-ins for every script the suite fails, while
 *  every test that touches no script passes beside the agent's own files. */
export function testProblems(dir, _lock, { spawn } = {}) {
  const spec = readJson(join(dir, "spec.json"));
  const out = [];
  const standard = standardTestsOf(spec);
  for (const [rel, text] of Object.entries(standard)) {
    if (!existsSync(join(dir, rel))) out.push(`${rel} is not in the folder; run \`node .adlc/generate.mjs tests\``);
    else if (readFileSync(join(dir, rel), "utf8") !== text) out.push(`${rel} is the test writer's standard check and is not its bytes; run \`node .adlc/generate.mjs tests\`, and ${NOT_BY_HAND}`);
  }
  const files = suiteFiles(dir);
  const own = files.filter((f) => !(f.path in standard));
  if (!own.length) return [...out, "there are no tests of the agent's own under test/; write one file per feature, each test named with the scenario it checks in square brackets (\"[F1.A1] ...\")"];
  // A test is tied to the approved spec through a scenario, a requirement
  // (Requirements holds every requirement to a scenario) or a constraint (a
  // constraint has no scenario, and the test writer names its test for it).
  const approved = new Set([
    ...scenariosOf(spec).map((s) => s.id),
    ...kinds(spec).map((r) => trim(r?.id)),
    ...list(spec?.constraints).map((c) => trim(c?.id)),
  ].filter(Boolean));
  for (const f of own) {
    for (const name of testNamesIn(f.text)) {
      if (!bracketIdsOf(name).some((id) => approved.has(id))) out.push(`${f.path}: the test "${name}" is named for nothing approved; open its name with the scenario, requirement or constraint it checks in square brackets ("[F1.A1] ...", "[F1.R2] ...", "[C1] ..."), or take it out: a behaviour the spec does not state goes back to the spec`);
    }
  }
  // A control character in a test is an escape lost on the way in (a "\b"
  // that became a backspace when the file was written through a shell), and
  // a pattern carrying one matches nothing it was meant to.
  for (const f of own) {
    f.text.split("\n").forEach((line, i) => {
      const c = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.exec(line);
      if (c) out.push(`${f.path}, line ${i + 1}, carries the control character U+${c[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}: an escape such as \\b was lost when the file was written; write it again with the editor, not through a shell`);
    });
  }
  out.push(...specFindings([...files, ...supportFiles(dir)], spec, { skip: Object.keys(standard) }));
  if (out.length) return out;
  // Against empty stand-ins it is the builder's own tests that must fail: the
  // standard checks fail there by themselves, and would hide a suite that
  // asserts nothing. Every file is placed, so an own test that imports a
  // standard check still loads it; only the own tests are run.
  const all = [...files, ...supportFiles(dir)];
  const agent = loadSpec(dir);
  const ownPaths = own.map((f) => f.path);
  const scratch = mkdtempSync(join(tmpdir(), "adlc-standins-"));
  let run;
  try {
    const scripts = standInPackage(agent, scratch, dir);
    placeSuite(all, scratch);
    run = { scripts: scripts.length, ...runSuite(scratch, ownPaths, spawn ? { spawn } : {}) };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  if (run.timed_out) out.push("against empty stand-ins for the scripts the suite did not finish in time; a test waits on something that never comes");
  else if (!run.fails) out.push(`against empty stand-ins for the ${run.scripts} script${run.scripts === 1 ? "" : "s"} the suite passes (${run.pass} of ${run.tests} of its own tests), so it asserts nothing about them; each scenario's test must fail until the code does what it says`);
  const d = declarationRun({ spec: agent, files: all, folder: dir, ...(spawn ? { spawn } : {}) });
  for (const u of d.unpassable ?? []) out.push(`${u.path}: the test "${u.name}" touches no script and fails against the agent's own files, so no script can make it pass; it is wrong about the files, not the code`);
  for (const w of d.wrong_values ?? []) out.push(`a worked value disagrees with its own computation: ${w}`);
  for (const b of brokenTests(dir, all, ownPaths, spawn ? { spawn } : {})) out.push(`the test "${b.name}" uses ${b.undefined}, which it never defines, so it fails before it checks anything and no script can make it pass; fix the test`);
  return out;
}

// ---------- Code ----------

/** The Code gate: nothing fixed changed (checked before any gate),
 *  the whole suite passes over the real scripts, each script the agent's
 *  files name, blanked in turn, is noticed by the suite, and the packer
 *  accepts the folder with its scripts. The code writer's own check is not
 *  imported here: it runs as a command when the command run is named
 *  check.mjs, as this one is. */
export function codeProblems(dir, _lock, { env = process.env, packer = pack, spawn } = {}) {
  const out = [];
  const scripts = codeScriptsOf(specOfFolder(dir));
  for (const s of scripts) if (!existsSync(join(dir, s)) || !trim(readFileSync(join(dir, s), "utf8"))) out.push(`${s} is not written; the agent's files name it, and the code is yours to write`);
  if (out.length) return out;
  out.push(...undeclaredReads(dir));
  if (out.length) return out;
  const paths = suiteFiles(dir).map((f) => f.path);
  const run = runTests(dir, paths, spawn ? { spawn } : {});
  if (run.timed_out) return ["the suite did not finish in time over the scripts; a script waits on something that never comes"];
  if (run.fails) {
    const failing = run.failing.filter((n) => !/^test[\\/]/.test(n) || run.failing.length === 1).slice(0, 20);
    return [`the suite fails over the scripts: ${run.fail} of ${run.tests}. The tests are fixed, so the scripts change, never the tests${failing.length ? `:\n${failing.map((n) => `      not ok: ${n}`).join("\n")}` : ""}`];
  }
  for (const b of blankEach(dir, scripts, paths, spawn)) {
    if (!b.noticed) out.push(`${b.script}, blanked, is not noticed by the suite: nothing tests it. The tests are fixed, so ask the person to send the build back (\`node .adlc/approve.mjs --send-back build\`) to add one`);
  }
  if (out.length) return out;
  const packed = packer(dir, { env });
  if (!packed.ok) out.push(`the packer (${PACKER.package} ${PACKER.version}, Common Agent ${PACKER.common_agent}) refuses the folder with its scripts: ${packed.refused}`);
  return out;
}

/** The model's settings (Common Agent 12.4.1) and the house's own variables
 *  for where a job's folders are: read by any agent without a declaration. */
export const MODEL_SETTINGS = ["MODEL_NAME", "MODEL_ENDPOINT", "MODEL_KEY", "MODEL_PROTOCOL", "MODEL_MAX_OUTPUT_TOKENS"];
export const HOUSE_VARIABLES = ["JOB_DIR", "RECORDS", "WORK", "TEXT_FILE", "FILES"];

/** Every variable a script reads from the environment that the agent's files
 *  do not declare. A script reaches a system only through the variables its
 *  runtime requirements name (Common Agent 12.4, item 3; 12.6, rule 2); a run
 *  setting arrives in the job's run-context.json (Section 5.8), never as a
 *  variable. Read by text, as the packer's address check reads addresses. */
export function undeclaredReads(dir) {
  const runtime = readJson(join(dir, "agent-runtime-requirements.json")) ?? {};
  const declared = new Set(HOUSE_VARIABLES);
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (k === "env" && typeof x === "string") declared.add(x); else walk(x); }
  };
  walk(runtime);
  if (list(runtime.systems).some((s) => s?.kind === "model")) MODEL_SETTINGS.forEach((n) => declared.add(n));
  const runNames = new Set(list(readJson(join(dir, "agent-descriptor.json"))?.run_config?.settings).map((s) => String(s?.name ?? "").toUpperCase()));
  const out = [];
  const READ = /\benv(?:\.([A-Z][A-Z0-9_]*)\b|\[\s*["'`]([A-Z][A-Z0-9_]*)["'`]\s*\])/g;
  for (const rel of walk2(join(dir, "scripts"))) {
    if (!/\.(?:mjs|js|cjs)$/.test(rel)) continue;
    const seen = new Set();
    for (const m of readFileSync(join(dir, "scripts", rel), "utf8").matchAll(READ)) {
      const name = m[1] ?? m[2];
      if (declared.has(name) || seen.has(name)) continue;
      seen.add(name);
      const why = runNames.has(name)
        ? "it is a declared run setting, and a run setting arrives in the job's run-context.json (Common Agent 5.8), never as a variable"
        : "the agent's files do not declare it, so no install sets it; if a system needs it (an address, a key), it goes into the spec, and the person sends the build back to the spec (--send-back spec)";
      out.push(`scripts/${rel} reads ${name} from the environment: ${why}`);
    }
  }
  return out;
}

function walk2(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk2(join(dir, e.name), base) : [relative(base, join(dir, e.name)).split(sep).join("/")]));
}

/** The suite run as the test writer runs it (node --test, TAP, no trace of a
 *  parent runner), with every failing test's name kept, not only the tail. */
export function runTests(dir, paths, { spawn = spawnSync } = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("NODE_TEST_")) delete env[k];
  const r = spawn("node", ["--test", "--test-reporter=tap", ...paths], { cwd: dir, env, encoding: "utf8", timeout: RUN_SECONDS * 1000 });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const count = (k) => Number(new RegExp(`^# ${k} (\\d+)$`, "m").exec(out)?.[1] ?? 0);
  const tests = count("tests"); const fail = count("fail");
  const status = typeof r.status === "number" ? r.status : 1;
  return {
    tests, pass: count("pass"), fail, timed_out: !!r.error && /ETIMEDOUT|timed out/i.test(String(r.error?.code ?? r.error?.message ?? "")),
    fails: status !== 0 || fail > 0 || tests === 0,
    // A file that did not load is a "not ok" at the top level, named by its path.
    failing: [...out.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => trim(m[1])).filter((n, i, a) => a.indexOf(n) === i),
    output: out,
  };
}

/** The tests that fail on a mistake of their own: run against stand-ins that
 *  export every name the suite imports and only throw when called, a test
 *  that stops on a name it never defined (ReferenceError) has failed before
 *  checking anything, and no script can make it pass. */
export function brokenTests(dir, files, ownPaths, { spawn } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "adlc-broken-"));
  try {
    cpSync(dir, scratch, { recursive: true, filter: (src) => !/(?:^|[\\/])(?:\.git|records|node_modules|scripts)(?:[\\/]|$)/.test(relative(dir, src)) });
    const wanted = new Map();
    for (const f of files) for (const i of importsOf(f.text)) {
      if (!i.script) continue;
      if (!wanted.has(i.from)) wanted.set(i.from, new Set());
      for (const n of i.names) wanted.get(i.from).add(n.imported);
    }
    for (const [s, names] of wanted) {
      mkdirSync(dirname(join(scratch, s)), { recursive: true });
      writeFileSync(join(scratch, s), declarationStandIn([...names]));
    }
    const out = runTests(scratch, ownPaths, spawn ? { spawn } : {}).output;
    const found = [];
    const blocks = out.split(/^(?=\s*(?:not ok|ok) \d+ - )/m);
    for (const b of blocks) {
      const m = /^\s*not ok \d+ - (.+)$/m.exec(b);
      // TAP gives the error's name and its message on lines of their own.
      const ref = /ReferenceError/.test(b) ? /['"|\s]([A-Za-z_$][\w$]*) is not defined/.exec(b) : null;
      if (m && ref) found.push({ name: trim(m[1]), undefined: ref[1] });
    }
    return found;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

/** Each script blanked in turn, in a copy of the folder: does the suite fail? */
function blankEach(dir, scripts, paths, spawn) {
  const scratch = mkdtempSync(join(tmpdir(), "adlc-blank-"));
  try {
    return scripts.map((s, i) => {
      const at = join(scratch, `without-${i}`);
      cpSync(dir, at, { recursive: true, filter: (src) => !/(?:^|[\\/])(?:\.git|records|node_modules)(?:[\\/]|$)/.test(relative(dir, src)) });
      writeFileSync(join(at, s), "");
      return { script: s, noticed: runTests(at, paths, spawn ? { spawn } : {}).fails };
    });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

// ---------- The build: every gate over the folder ----------

/** Every gate of the build over the folder as it stands. The builder may write
 *  in any order; each gate says what is missing, and a gate that needs another
 *  gate's output says it waits for it. The code is judged only once the tests
 *  pass their gate, and the first time it is, the tests are fixed in the lock.
 *  Returns { gates: {gate: problems}, problems, lock }, where `problems` is
 *  every gate's, each named with its gate, and `lock` is the lock as it now
 *  stands. */
export async function buildGates(dir, lock, opts = {}) {
  // Sent back by the person and nothing changed yet: nothing is judged, and the tests stay free.
  if (unchangedSinceSentBack(dir, lock)) {
    const why = "the person sent the build back, and nothing in it has changed since; make the change they asked for (their words are in said.md or at the end of request.md), then run the check again";
    const gates = Object.fromEntries(GATES.map((g) => [g, g === "architecture" ? [why] : ["waits until the build sent back has changed"]]));
    return { gates, problems: [`${GATE_TITLES.architecture}: ${why}`], lock };
  }
  if (lock.sent_back) { const { sent_back: _changed, ...rest } = lock; lock = rest; }
  const gates = {};
  gates.architecture = await architectureProblems(dir);
  gates.files = existsSync(join(dir, "architecture-record.md"))
    ? await filesProblems(dir, lock, opts)
    : ["waits for the architecture record, which the agent's files are generated from"];
  gates.test = existsSync(join(dir, "agent-descriptor.json"))
    ? testProblems(dir, lock, opts)
    : ["waits for the agent's files, which the tests run beside"];
  let next = lock;
  if (gates.test.length) gates.code = ["waits for the tests to pass their gate; the code is judged against tests that are fixed"];
  else {
    if (!lock.tests_fixed) next = fixTests(dir, lock);
    gates.code = codeProblems(dir, next, opts);
  }
  const problems = GATES.flatMap((g) => gates[g].map((p) => `${GATE_TITLES[g]}: ${p}`));
  return { gates, problems, lock: next };
}

/** Each phase's check: the spec's problems, or the build's from every gate. */
export const CHECKS = {
  spec: requirementsProblems,
  build: buildGates,
};
