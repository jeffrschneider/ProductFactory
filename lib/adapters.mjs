// The holder adapters: how each holder milestone 1 sends work to is reached,
// the way it says it is run, and nothing else. They know nothing of builds,
// records or the order of steps; each takes folders and files and hands back
// what the holder said and made. They are the part a shared process runner
// reuses: the orchestrator (orchestrator.mjs) decides the next step, and an
// adapter here does it.
//
//   Requirements  the reference spec writer (CommonAgent/adlc agents/spec-writer),
//                 its four commands and pieces.mjs, as its write-a-spec skill says:
//                 the spec (spec.json and spec.md, read in spec.mjs) and the agent's
//                 own files made from it
//   Architecture  the reference solution architect (agents/solution-architect), its five
//                 commands and pieces.mjs, as its write-the-architecture skill says: the
//                 architecture record (architecture-record-v1, read in architecture.mjs);
//                 then the spec writer's same job again for the Design, given the approved
//                 spec and the record, which makes the agent's own files within it
//   Test          the reference test writer (agents/test-writer), its job command
//                 as its runtime requirements' run declaration says
//   Code          the hand-off (agents/code-writer scripts/handoff.mjs) lays out the
//                 build folder with AGENTS.md; then your coding harness, or the
//                 reference code writer's own scripts around the same harness
//   Package       the build folder made into an Agent Package and validated, by the
//                 Common Agent packer (@common-agent/package, or the command you name)
//
// A job here follows the reference agents' job folder: message.txt in, the
// pieces under out/ listed in pieces.json, and one JSON object printed with
// the reply in it.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { run, lastJson, tail, withoutEnv } from "./exec.mjs";
import { specPieces } from "./spec.mjs";
import { writeTarGz } from "./tar.mjs";

const NODE = (script, args = []) => [process.execPath, script, ...args];
const rel = (base, at) => relative(base, at).split(sep).join("/");
const words = (s) => String(s ?? "").trim();
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The pieces a job filed: pieces.json's entries, each with its file's absolute path. */
export function piecesOf(jobDir) {
  const list = join(jobDir, "pieces.json");
  if (!existsSync(list)) return [];
  let entries;
  try { entries = JSON.parse(readFileSync(list, "utf8")); } catch { return []; }
  if (!Array.isArray(entries)) entries = Array.isArray(entries?.pieces) ? entries.pieces : [];
  return entries
    .filter((e) => e && typeof e.path === "string")
    .map((e) => ({ ...e, abs: resolve(jobDir, e.path) }))
    .filter((e) => rel(jobDir, e.abs) && !rel(jobDir, e.abs).startsWith("..") && existsSync(e.abs));
}

/** Every file under a folder, as paths relative to it. */
export function filesUnder(dir, skip = []) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const at = join(d, name);
      const r = rel(dir, at);
      if (skip.some((s) => r === s || r.startsWith(`${s}/`))) continue;
      if (statSync(at).isDirectory()) walk(at); else out.push(r);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

function agentScript(adlc, agent, script) {
  return join(adlc, "agents", agent, "scripts", script);
}

function missingAgent(adlc, agent, scripts) {
  const gone = scripts.filter((s) => !existsSync(agentScript(adlc, agent, s)));
  if (!gone.length) return null;
  return `The reference ${agent.replace("-", " ")} is not in the adlc checkout at ${adlc} (${gone.map((s) => `agents/${agent}/scripts/${s}`).join(", ")} missing). Set "adlc" in product-factory.json to a checkout of CommonAgent/adlc.`;
}

/** One step of a reference agent: a script run with its variables, its JSON read back. */
async function step(argv, { env, cwd, signal, log, timeoutMs = 20 * 60 * 1000 }) {
  const r = await run(argv, { env, cwd, signal, log, timeoutMs });
  const doc = lastJson(r.stdout);
  return { ...r, doc, reply: words(doc?.reply) };
}

const failed = (r, what) => {
  if (r.stopped) return "It was stopped.";
  if (r.timedOut) return `${what} did not finish in time and was stopped.`;
  if (r.error) return `${what} could not run: ${r.error}.`;
  return r.reply || `${what} ended with code ${r.code}${tail(r.stderr || r.stdout, 400) ? `: ${tail(r.stderr || r.stdout, 400)}` : "."}`;
};

// ---------- Requirements: the reference spec writer ----------

/** The request as the spec writer reads it: "Write a spec." and its keyed lines. */
export function requestText({ does, refuses, more, name, prototype, version }) {
  const lines = ["Write a spec.", `what it should do: ${words(does)}`];
  if (words(refuses)) lines.push(`what it must refuse: ${words(refuses)}`);
  if (words(more)) lines.push(`more: ${words(more)}`);
  if (words(prototype)) lines.push(`prototype: ${words(prototype)}`);
  if (words(name)) lines.push(`name: ${words(name)}`);
  if (words(version)) lines.push(`version: ${words(version)}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Runs the spec writer's write-a-spec job in <dir>/stages/requirements/r<n>.
 * text: the message. attach: an earlier spec and agent files to revise ([{abs, media_type}]).
 * Resolves to { ok, reply, agentFiles: [{abs, media_type, path}], spec: [{abs, media_type, path}],
 * handed: [{path, at}] }: spec is spec.json and spec.md (stages.json 1.6.0) when the
 * spec writer wrote them (spec.mjs specPieces), else empty.
 * part "design": the same job for the Design part of Architecture and Design, given the
 * approved spec and the architecture record, in <dir>/stages/architecture/design/r<n>; what
 * it hands back is under design/, and the spec it writes beside the files is not handed on.
 * part "written-after" (lifecycle API 0.4.14): the spec of a version built before the spec
 * writer wrote specs, in <dir>/stages/requirements/written-after/r<n>; only the spec is kept.
 */
export async function specWriter({ dir, adlc, n, text, attach = [], env, signal, part = "requirements" }) {
  const scripts = ["asked.mjs", "draft.mjs", "builds.mjs", "ask.mjs", "pieces.mjs"];
  const gone = missingAgent(adlc, "spec-writer", scripts);
  if (gone) return { ok: false, reply: gone };
  const design = part === "design";
  const after = part === "written-after";
  const base = design ? join(dir, "stages", "architecture", "design") : after ? join(dir, "stages", "requirements", "written-after") : join(dir, "stages", "requirements");
  const job = join(base, `r${n}`, "job");
  const RECORDS = join(base, "records", `r${n}`);
  mkdirSync(job, { recursive: true });
  mkdirSync(RECORDS, { recursive: true });
  const TEXT_FILE = join(job, "message.txt");
  writeFileSync(TEXT_FILE, text);
  const log = join(base, `r${n}`, "run.log");
  const FILES = attach.map((f) => `${f.abs}::${f.media_type ?? ""}`).join(",");
  const at = (s) => agentScript(adlc, "spec-writer", s);
  const o = { env, signal, log, cwd: job };

  const asked = await step(NODE(at("asked.mjs")), { ...o, env: { ...env, JOB_DIR: job, RECORDS, TEXT_FILE, FILES } });
  if (asked.code !== 0) return { ok: false, reply: failed(asked, "Reading the request") };
  const draft = await step(NODE(at("draft.mjs")), { ...o, env: { ...env, ASKED: join(RECORDS, "asked.json"), RECORDS, ANSWERS: join(RECORDS, "answers.json") } });
  if (draft.code !== 0) return { ok: false, reply: failed(draft, "Drafting the spec") };
  const builds = await step(NODE(at("builds.mjs")), { ...o, env: { ...env, DRAFT: join(RECORDS, "draft.json"), RECORDS } });
  if (builds.code !== 0 && !builds.doc) return { ok: false, reply: failed(builds, "Writing the agent's files") };
  const ask = await step(NODE(at("ask.mjs")), { ...o, env: { ...env, DRAFT: join(RECORDS, "draft.json"), BLANKS: join(RECORDS, "blanks.json"), BUILDS: join(RECORDS, "builds.json"), RECORDS } });
  if (ask.code !== 0 && !ask.reply) return { ok: false, reply: failed(ask, "Writing the reply") };
  const pieces = await step(NODE(at("pieces.mjs")), { ...o, env: { ...env, JOB_DIR: job, RECORDS } });
  const reply = ask.reply || "The spec writer gave no reply.";
  if (pieces.code !== 0) return { ok: false, reply: pieces.reply || `${reply} ${failed(pieces, "Filing the pieces")}` };

  const filed = piecesOf(job);
  // A container agent's checked draft is out/agent/spec.json (spec writer 0.9.0): it is not the spec, nor one of the
  // files a package is built from, so it keeps its agent/ folder in what is handed back and is not passed on.
  const draftOfContainer = (p) => /^out\/agent\/spec\.(json|md)$/.test(p.path);
  const agentFiles = filed.filter((p) => p.path.startsWith("out/agent/") && !draftOfContainer(p)).map((p) => ({ abs: p.abs, media_type: p.media_type, path: p.path.slice("out/agent/".length) }));
  const { json, md } = specPieces(filed);
  // Written after the version was built: the spec alone, never new agent files for a version that has its own.
  if (after) return json ? { ok: true, reply, spec: [json, md].filter(Boolean) } : { ok: false, reply: `${reply} The spec writer handed back no spec.`.trim() };
  // The Design is made from the spec as the owner approved it: a spec its job writes again stays in its records.
  const spec = design ? [] : [json, md].filter(Boolean);
  const kept = design ? filed.filter((p) => !/^out\/spec\.(json|md)$/.test(p.path)) : filed;
  const handed = kept.map((p) => ({ path: `${design ? "design" : "requirements"}/${draftOfContainer(p) ? p.path.slice("out/".length) : p.path.replace(/^out\/(agent\/)?/, "")}`, at: rel(dir, p.abs) }));
  if (!agentFiles.length) return { ok: false, reply, handed };
  return { ok: true, reply, agentFiles, spec, handed };
}

// ---------- Architecture: the reference solution architect ----------

/** The record the solution architect hands back, and what it leaves open, by their names in its job folder. */
export const RECORD_PIECE = "architecture-record.md";
export const OPEN_PIECE = "still-open.md";

/**
 * Runs the solution architect's write-the-architecture job, its five commands
 * and pieces.mjs, as its write-the-architecture skill says, in
 * <dir>/stages/architecture/r<n>. text: the message (the statement, or a
 * revision's answers). attach: [{abs, media_type}], the spec as more of the
 * statement, and on a revision the record to revise. A revision runs the same
 * commands from the revise-the-architecture skill's place: the scripts are the
 * same files, and asked.mjs tells a revision from a new request by what came.
 * Resolves to { ok, reply, record: {abs, path} | null, open: {abs, path} | null,
 * questions, handed: [{path, at}] }; questions is the count the record's header says.
 */
export async function solutionArchitect({ dir, adlc, n, text, attach = [], env, signal }) {
  const scripts = ["asked.mjs", "name.mjs", "bind.mjs", "check-record.mjs", "reply.mjs", "pieces.mjs"];
  const gone = missingAgent(adlc, "solution-architect", scripts);
  if (gone) return { ok: false, reply: gone };
  const base = join(dir, "stages", "architecture");
  const job = join(base, `r${n}`, "job");
  const RECORDS = join(base, "records", `r${n}`);
  mkdirSync(job, { recursive: true });
  mkdirSync(RECORDS, { recursive: true });
  const TEXT_FILE = join(job, "message.txt");
  writeFileSync(TEXT_FILE, text);
  const log = join(base, `r${n}`, "run.log");
  const FILES = attach.map((f) => `${f.abs}::${f.media_type ?? ""}`).join(",");
  const at = (s) => agentScript(adlc, "solution-architect", s);
  const o = { env, signal, log, cwd: job };
  const ASKED = join(RECORDS, "asked.json");
  const NAMED = join(RECORDS, "named.json");
  const BOUND = join(RECORDS, "bound.json");

  const asked = await step(NODE(at("asked.mjs")), { ...o, env: { ...env, JOB_DIR: job, RECORDS, TEXT_FILE, FILES } });
  if (asked.code !== 0) return { ok: false, reply: failed(asked, "Reading the request") };
  const named = await step(NODE(at("name.mjs")), { ...o, env: { ...env, ASKED, RECORDS } });
  if (named.code !== 0) return { ok: false, reply: failed(named, "Naming the systems") };
  const bound = await step(NODE(at("bind.mjs")), { ...o, env: { ...env, NAMED, ASKED, RECORDS } });
  if (bound.code !== 0) return { ok: false, reply: failed(bound, "Binding each environment") };
  const checked = await step(NODE(at("check-record.mjs")), { ...o, env: { ...env, ASKED, NAMED, BOUND, RECORDS } });
  if (checked.code !== 0) return { ok: false, reply: failed(checked, "Checking the record") };
  const replied = await step(NODE(at("reply.mjs")), { ...o, env: { ...env, RECORDS } });
  if (replied.code !== 0 && !replied.reply) return { ok: false, reply: failed(replied, "Writing the reply") };
  const pieces = await step(NODE(at("pieces.mjs")), { ...o, env: { ...env, JOB_DIR: job, RECORDS } });
  const reply = replied.reply || "The solution architect gave no reply.";
  if (pieces.code !== 0) return { ok: false, reply: pieces.reply || `${reply} ${failed(pieces, "Filing the pieces")}` };

  const filed = piecesOf(job);
  const one = (name) => { const p = filed.find((x) => basename(x.path) === name); return p ? { abs: p.abs, path: `architecture/${name}` } : null; };
  const record = one(RECORD_PIECE);
  const open = one(OPEN_PIECE);
  const handed = [record, open].filter(Boolean).map((f) => ({ path: f.path, at: rel(dir, f.abs) }));
  if (!record) return { ok: false, reply: `${reply} The solution architect filed no architecture record.`, handed };
  const head = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(record.abs, "utf8"))?.[1] ?? "";
  const questions = Number(/^questions:\s*(\d+)\s*$/m.exec(head)?.[1] ?? 0);
  return { ok: true, reply, record, open, questions, handed };
}

// ---------- Test: the reference test writer ----------

/** A test file of a suite, which the suite's runner runs: test/<name>.test.mjs, never one under test/support/. */
export const isTestFile = (p) => /^test\/[^/]+\.test\.mjs$/.test(String(p ?? ""));
/** The record of the original's own tests a suite carries (test-writer 0.10.0). */
export const CARRIED_RECORD = "test/carried-tests.json";
/** A file a suite carries beside its tests and never runs: a file an original test imports, under test/support/, or their record. */
export const isCarriedSuitePath = (p) => /^test\/support\/.+/.test(String(p ?? "")) && !String(p).split("/").includes("..") || p === CARRIED_RECORD;

/**
 * Runs the test writer's write-a-suite job, as its run declaration says, in
 * <dir>/stages/test. Resolves to { ok, reply, suite: [{abs, path}], handed }.
 */
export async function testWriter({ dir, adlc, n, agentFiles, text = "Write the suite for the spec and the agent's files attached.\n", attach = [], env, signal }) {
  const gone = missingAgent(adlc, "test-writer", ["job.mjs"]);
  if (gone) return { ok: false, reply: gone };
  const base = join(dir, "stages", "test");
  const job = join(base, "jobs", `r${n}`);
  mkdirSync(job, { recursive: true });
  writeFileSync(join(job, "message.txt"), text);
  const files = [...agentFiles, ...attach].flatMap((f) => ["--file", `${f.abs}::${f.media_type ?? ""}`]);
  const argv = NODE(agentScript(adlc, "test-writer", "job.mjs"), ["--job", job, "--records", join(base, "records"), "--work", join(base, "work"), "--text-file", join(job, "message.txt"), ...files]);
  const r = await step(argv, { env, signal, cwd: job, log: join(base, `r${n}.log`), timeoutMs: 30 * 60 * 1000 });
  const filed = piecesOf(job);
  // The suite: its test files, and what it carries beside them (test-writer 0.10.0): the files the
  // original's own tests import, under test/support/ with their layout, and their record,
  // test/carried-tests.json. A revision that only drops an original test hands back the record alone.
  const suite = filed.filter((p) => /^out\/test\/[^/]+\.test\.mjs$/.test(p.path) || isCarriedSuitePath(p.path.slice("out/".length))).map((p) => ({ abs: p.abs, media_type: p.media_type || "text/javascript", path: p.path.slice("out/".length) }));
  const handed = filed.map((p) => ({ path: p.path.replace(/^out\//, "").replace(/^(?!test\/)/, "test/"), at: rel(dir, p.abs) }));
  const tests = suite.filter((f) => isTestFile(f.path)).length;
  if (r.code !== 0 || !suite.length) return { ok: false, reply: suite.length ? failed(r, "The test writer") : r.reply || failed(r, "The test writer"), handed };
  return { ok: true, reply: r.reply || `The test writer wrote ${plural(tests, "test file")}.`, suite, handed };
}

// ---------- Code: the hand-off, then your coding harness or the reference code writer ----------

/**
 * The suite as the hand-off is given it. Test files go loose, as they always
 * have. A suite that carries files beside its tests (the files the original's
 * own tests import, under test/support/, and their record; test-writer
 * 0.10.0) goes as one gzip tar archive holding every file at its path under
 * test/, which the reference hand-off lays out as the suite with its folders,
 * so the support files keep their layout and are pinned like the tests.
 * suite: [{ abs, media_type, path }], path being test/...; archive: where the
 * archive is written.
 */
export function suiteForHandOff(suite, archive) {
  if (!suite.some((f) => f.path && !isTestFile(f.path))) return suite;
  mkdirSync(dirname(archive), { recursive: true });
  writeFileSync(archive, writeTarGz(suite.filter((f) => f.path).map((f) => ({ path: f.path, bytes: readFileSync(f.abs) }))));
  return [{ abs: archive, media_type: "application/gzip" }];
}

/**
 * Lays out the build folder with the code writer's hand-off: the spec
 * (spec.json and spec.md, stages.json 1.6.0), the agent's files, the suite,
 * the stubs, AGENTS.md, .adlc/check.mjs and build.lock.json, which pins the
 * spec with the agent's files. spec: [{abs, media_type}], empty for a build
 * whose spec writer handed back none.
 * Resolves to { ok, reply, folder, archive }.
 */
export async function handOff({ dir, adlc, agentFiles, spec = [], suite, env, signal }) {
  const gone = missingAgent(adlc, "code-writer", ["handoff.mjs"]);
  if (gone) return { ok: false, reply: gone };
  const base = join(dir, "stages", "code", "handoff");
  const job = join(base, "job");
  mkdirSync(job, { recursive: true });
  writeFileSync(join(job, "message.txt"), "Hand off the code\n");
  let given;
  try { given = suiteForHandOff(suite, join(base, "suite.tar.gz")); } catch (e) { return { ok: false, reply: `The suite could not be packed for the hand-off: ${e.message}.` }; }
  const files = [...spec, ...agentFiles, ...given].flatMap((f) => ["--file", `${f.abs}::${f.media_type ?? ""}`]);
  const work = join(base, "work");
  const argv = NODE(agentScript(adlc, "code-writer", "handoff.mjs"), ["--job", job, "--records", join(base, "records"), "--work", work, "--message", join(job, "message.txt"), ...files]);
  const r = await step(argv, { env, signal, cwd: job, log: join(base, "run.log") });
  const folder = join(work, "build");
  if (r.code !== 0 || !existsSync(join(folder, "AGENTS.md"))) return { ok: false, reply: failed(r, "The hand-off") };
  const archive = piecesOf(job).find((p) => p.media_type === "application/gzip")?.abs ?? null;
  return { ok: true, reply: r.reply || "Laid out the build folder.", folder, archive };
}

/** The words your coding harness is given, one line: AGENTS.md is the contract. */
export function harnessPrompt({ feedbackFile }) {
  const first = "Read AGENTS.md in this folder and do what it says: write the scripts under scripts/ until `node .adlc/check.mjs` exits 0. Change nothing outside scripts/.";
  return feedbackFile ? `${first} First read ${feedbackFile}: it says what is still wrong.` : first;
}

/** The words the harness is given when it works for the reference code writer. */
export function codeWriterPrompt({ adlc, feedbackFile }) {
  const cw = join(adlc, "agents", "code-writer");
  const first = `You are working for the reference code writer. Read ${join(cw, "rules.md")} and the suite under test/, then write the scripts under scripts/ in this folder so the suite passes. Check with \`node ${join(cw, "scripts", "check.mjs")}\` (WORKSPACE and RECORDS are set): exit 0 done, 1 not yet, 3 you changed something you may not, 4 the rounds are used up. Write only under scripts/, and your account in $RECORDS/account.md.`;
  return feedbackFile ? `${first} First read ${feedbackFile}: it says what is still wrong.` : first;
}

/** argv with {prompt}, {workspace}, {feedback_file} and {round} filled in. */
export function fill(argv, vars) {
  return argv.map((w) => w.replace(/\{(prompt|workspace|feedback_file|round|plugin)\}/g, (_, k) => String(vars[k] ?? "")));
}

/**
 * For the reference code writer: its workspace step, which unpacks the build
 * folder archive and checks every pinned file against build.lock.json.
 * Resolves to { ok, reply, folder, records }.
 */
export async function codeWriterWorkspace({ dir, adlc, archive, env, signal }) {
  const gone = missingAgent(adlc, "code-writer", ["workspace.mjs", "check.mjs", "report.mjs", "pieces.mjs", "verify.mjs"]);
  if (gone) return { ok: false, reply: gone };
  const base = join(dir, "stages", "code", "code-writer");
  const folder = join(base, "workspace");
  const records = join(base, "records");
  mkdirSync(records, { recursive: true });
  const r = await step(NODE(agentScript(adlc, "code-writer", "workspace.mjs")), { env: { ...env, WORKSPACE: folder, RECORDS: records, FILES: `${archive}::application/gzip` }, signal, cwd: base, log: join(base, "workspace.log") });
  if (r.code !== 0) return { ok: false, reply: failed(r, "The code writer's workspace step") };
  return { ok: true, reply: r.reply, folder, records };
}

/**
 * One round at Code: the harness works in the folder, then the suite runs.
 * mode "harness": the gate is the folder's own `node .adlc/check.mjs`.
 * mode "code-writer": the gate is the code writer's check.mjs, and on a pass
 * its report, pieces and delivery check (verify.mjs) run too.
 * envRemove: the variables taken out of the harness's environment (code.env_remove),
 * so it uses its own sign-in; the check after it keeps the whole environment.
 * Resolves to { pass, code, words, items, harness }.
 */
export async function codeRound({ dir, adlc, mode, folder, records, harness, round, feedbackFile, minutes, env, envRemove = [], signal }) {
  const base = join(dir, "stages", "code", "rounds", String(round));
  mkdirSync(base, { recursive: true });
  const prompt = mode === "code-writer" ? codeWriterPrompt({ adlc, feedbackFile }) : harnessPrompt({ feedbackFile });
  const extra = mode === "code-writer" ? { WORKSPACE: folder, RECORDS: records } : {};
  const hEnv = { ...withoutEnv(env, envRemove), ...extra, PF_PROMPT: prompt, PF_WORKSPACE: folder, PF_FEEDBACK_FILE: feedbackFile ?? "", PF_ROUND: String(round) };
  if (mode !== "code-writer") { delete hEnv.WORKSPACE; delete hEnv.RECORDS; }
  const h = await run(fill(harness, { prompt, workspace: folder, feedback_file: feedbackFile ?? "", round }), { cwd: folder, env: hEnv, signal, timeoutMs: minutes * 60 * 1000, log: join(base, "harness.log") });
  if (h.stopped) return { pass: false, stopped: true, code: null, words: "It was stopped.", items: [] };
  const said = [];
  if (h.error) said.push(`Your coding harness could not run: ${h.error}.`);
  else if (h.timedOut) said.push(`Your coding harness ran past ${plural(minutes, "minute")} and was stopped.`);
  else if (h.code !== 0) said.push(`Your coding harness ended with code ${h.code}.`);

  const gateEnv = { ...env };
  delete gateEnv.WORKSPACE; delete gateEnv.RECORDS;
  const gateArgv = mode === "code-writer" ? NODE(agentScript(adlc, "code-writer", "check.mjs")) : NODE(join(folder, ".adlc", "check.mjs"));
  if (mode === "code-writer") Object.assign(gateEnv, { WORKSPACE: folder, RECORDS: records });
  const g = await run(gateArgv, { cwd: folder, env: gateEnv, signal, timeoutMs: 30 * 60 * 1000, log: join(base, "check.log") });
  if (g.stopped) return { pass: false, stopped: true, code: null, words: "It was stopped.", items: [] };
  const out = words(g.stdout) || words(g.stderr);
  writeFileSync(join(base, "check.txt"), `${out}\n`);
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const items = lines.filter((l) => l.startsWith("not ok:")).map((l) => l.slice("not ok:".length).trim()).slice(0, 20);
  const first = lines.find((l) => !l.startsWith("not ok:")) ?? "";
  if (g.code !== 0) {
    said.push(first || tail(out, 400) || `The check ended with code ${g.code}.`);
    return { pass: false, code: g.code, words: said.join(" "), items, checkFile: join(base, "check.txt") };
  }
  said.push(first || "The suite passes.");
  if (mode === "code-writer") {
    const cw = (s) => agentScript(adlc, "code-writer", s);
    const job = join(dir, "stages", "code", "code-writer", "job");
    mkdirSync(job, { recursive: true });
    await step(NODE(cw("report.mjs")), { env: { ...gateEnv, RECORDS: records }, signal, cwd: base, log: join(base, "report.log") });
    const p = await step(NODE(cw("pieces.mjs")), { env: { ...gateEnv, JOB_DIR: job, RECORDS: records }, signal, cwd: base, log: join(base, "pieces.log") });
    const v = await step(NODE(cw("verify.mjs")), { env: { ...gateEnv, JOB_DIR: job }, signal, cwd: base, log: join(base, "verify.log") });
    if (p.code !== 0 || v.code !== 0) {
      const why = p.code !== 0 ? failed(p, "Filing the code writer's pieces") : failed(v, "The code writer's delivery check");
      return { pass: false, code: v.code ?? p.code, words: `${said.join(" ")} ${why}`, items, checkFile: join(base, "check.txt") };
    }
    said.push("The code writer's delivery check accepted it.");
  }
  return { pass: true, code: 0, words: said.join(" "), items, checkFile: join(base, "check.txt") };
}

/**
 * One fix round's harness run, for Code on a pull request: your coding harness
 * in the round's build folder with the round's prompt, and nothing after it
 * (the pull request's gate judges what it wrote). envRemove: the variables
 * taken out of its environment (code.env_remove, and the repository token's
 * variable, so the harness never holds repository credentials).
 * findingsFile: the last gate run's findings, for {feedback_file} and PF_FEEDBACK_FILE.
 * Resolves to { stopped, code, error, timedOut, said, ms }.
 */
export async function fixHarness({ base, folder, harness, prompt, round, findingsFile = null, minutes, env, envRemove = [], signal }) {
  mkdirSync(base, { recursive: true });
  const hEnv = { ...withoutEnv(env, envRemove), PF_PROMPT: prompt, PF_WORKSPACE: folder, PF_FEEDBACK_FILE: findingsFile ?? "", PF_ROUND: String(round) };
  delete hEnv.WORKSPACE; delete hEnv.RECORDS;
  const started = Date.now();
  const h = await run(fill(harness, { prompt, workspace: folder, feedback_file: findingsFile ?? "", round }), { cwd: folder, env: hEnv, signal, timeoutMs: minutes * 60 * 1000, log: join(base, "harness.log") });
  return { stopped: Boolean(h.stopped), code: h.code, error: h.error ?? null, timedOut: Boolean(h.timedOut), said: tail(h.stdout || h.stderr, 1500), ms: Date.now() - started };
}

/**
 * The gate alone on a build folder, with nothing written first: the folder's own
 * `node .adlc/check.mjs`, as a round of Code runs it after the harness. For code
 * adopted as it is. Resolves to { pass, code, words, items, checkFile }.
 */
export async function checkFolder({ dir, folder, round, env, signal }) {
  const base = join(dir, "stages", "code", "rounds", String(round));
  mkdirSync(base, { recursive: true });
  const gateEnv = { ...env };
  delete gateEnv.WORKSPACE; delete gateEnv.RECORDS;
  const g = await run(NODE(join(folder, ".adlc", "check.mjs")), { cwd: folder, env: gateEnv, signal, timeoutMs: 30 * 60 * 1000, log: join(base, "check.log") });
  if (g.stopped) return { pass: false, stopped: true, code: null, words: "It was stopped.", items: [] };
  const out = words(g.stdout) || words(g.stderr);
  writeFileSync(join(base, "check.txt"), `${out}\n`);
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const items = lines.filter((l) => l.startsWith("not ok:")).map((l) => l.slice("not ok:".length).trim()).slice(0, 20);
  const first = lines.find((l) => !l.startsWith("not ok:")) ?? "";
  if (g.code !== 0) return { pass: false, code: g.code, words: first || tail(out, 400) || `The check ended with code ${g.code}.`, items, checkFile: join(base, "check.txt") };
  return { pass: true, code: 0, words: first || "The suite passes.", items, checkFile: join(base, "check.txt") };
}

// ---------- Reverse engineering: the reference reverse engineer ----------

/** The six files the reverse engineer hands back: the record and its five parts, in order. */
export const AS_BUILT_FILES = ["record.json", "behaviors.json", "architecture.json", "interfaces.json", "sbom.cdx.json", "tests-and-gaps.json"];
export const AS_BUILT_TYPES = { "sbom.cdx.json": "application/vnd.cyclonedx+json" };
/**
 * A piece of the reverse engineer's write-up that is one of the original's
 * own tests or a file they import: its place in the write-up, tests/<path in
 * the codebase> or support/<path from the repository's top>, from the piece's
 * path (out/as-built/tests/..., or out/tests/...); null for any other piece.
 */
export function carriedPlace(path) {
  const p = String(path ?? "").replace(/\\/g, "/").replace(/^out\//, "").replace(/^as-built\//, "");
  return /^(tests|support)\/.+/.test(p) && !p.split("/").includes("..") ? p : null;
}
const RE_AGENT = "reverse-engineer";
const RE_OFFERING = "reverse-engineer";

/**
 * The reverse engineer's job script: the one its runtime requirements' run
 * declaration names for the offering reverse-engineer, by its file name
 * under agents/reverse-engineer/scripts/; job.mjs when it declares none.
 */
export function reverseEngineerScript(adlc) {
  try {
    const req = JSON.parse(readFileSync(join(adlc, "agents", RE_AGENT, "agent-runtime-requirements.json"), "utf8"));
    const cmd = req?.run?.[RE_OFFERING]?.command;
    const script = Array.isArray(cmd) ? cmd.find((w) => /\.m?js$/.test(String(w))) : null;
    if (script) return basename(String(script));
  } catch { /* no declaration: the usual name */ }
  return "job.mjs";
}

/** Why the reference reverse engineer cannot run from the adlc checkout, or null. */
export function reverseEngineerMissing(adlc) {
  const script = reverseEngineerScript(adlc);
  return existsSync(agentScript(adlc, RE_AGENT, script)) ? null : `The reference reverse engineer is not in the adlc checkout at ${adlc} (agents/${RE_AGENT}/scripts/${script} is missing). Set "adlc" in product-factory.json to a checkout of CommonAgent/adlc that has it.`;
}

/**
 * Runs the reverse engineer's job, as its run declaration says (--job,
 * --records, --work, --text-file, --file per file), in
 * <dir>/stages/reverse-engineering/r<n>. The message names the trigger, the
 * repository, the commit and the folder the code is in; the code goes as an
 * archive too, and on drift the last as-built record's six files go with it.
 * Resolves to { ok, reply, files: [{ name, abs }], handed: [{ path, at }] }:
 * the six files by name, each handed back as as-built/<name>.
 */
export async function reverseEngineer({ dir, adlc, n, code, repository, commit, trigger, since = null, previous = [], archive = null, env, signal, minutes = 30 }) {
  const gone = reverseEngineerMissing(adlc);
  if (gone) return { ok: false, reply: gone };
  const base = join(dir, "stages", "reverse-engineering", `r${n}`);
  const job = join(base, "job");
  mkdirSync(job, { recursive: true });
  const text = [
    trigger === "drift" ? "Reverse engineer what changed in this codebase since the last as-built record, which is attached." : "Reverse engineer this codebase.",
    `trigger: ${trigger}`,
    `repository: ${repository}`,
    `commit: ${commit}`,
    `folder: ${code}`,
    ...(since ? [`since: ${since}`] : []),
  ].join("\n");
  writeFileSync(join(job, "message.txt"), `${text}\n`);
  const files = [...(archive ? [{ abs: archive, media_type: "application/gzip" }] : []), ...previous];
  const script = reverseEngineerScript(adlc);
  const argv = NODE(agentScript(adlc, RE_AGENT, script), ["--job", job, "--records", join(base, "records"), "--work", join(base, "work"), "--text-file", join(job, "message.txt"), ...files.flatMap((f) => ["--file", `${f.abs}::${f.media_type ?? ""}`])]);
  const r = await step(argv, { env: { ...env, SOURCE_DIR: code }, signal, cwd: job, log: join(base, "run.log"), timeoutMs: minutes * 60 * 1000 });
  if (r.stopped) return { ok: false, reply: "It was stopped." };
  const filed = piecesOf(job);
  const got = AS_BUILT_FILES.map((name) => ({ name, piece: filed.find((p) => basename(p.path) === name) })).filter((x) => x.piece);
  // The original's own tests and the files they import (reverse engineer 0.3.0), each by its place in the write-up.
  const carried = filed.map((p) => ({ p, at: carriedPlace(p.path) })).filter((x) => x.at);
  const handed = [...got.map((x) => ({ path: `as-built/${x.name}`, at: rel(dir, x.piece.abs) })), ...carried.map((x) => ({ path: `as-built/${x.at}`, at: rel(dir, x.p.abs) }))];
  if (r.code !== 0) return { ok: false, reply: failed(r, "The reverse engineer"), handed };
  const missing = AS_BUILT_FILES.filter((name) => !got.some((x) => x.name === name));
  if (missing.length) return { ok: false, reply: `${r.reply ? `${r.reply} ` : ""}The reverse engineer handed back no ${missing.join(", ")}, so the as-built record is not whole.`, handed };
  return { ok: true, reply: r.reply || "The reverse engineer handed back the as-built record.", files: got.map((x) => ({ name: x.name, abs: x.piece.abs })), handed };
}

/** The scripts the folder holds now, as handed-back files. */
export function scriptsHanded(dir, folder) {
  return filesUnder(join(folder, "scripts")).map((r) => ({ path: `code/scripts/${r}`, at: rel(dir, join(folder, "scripts", r)) }));
}

// ---------- The gate's reviewers: the reference code critic and security reviewer ----------

/** Why a reference reviewer cannot run from the adlc checkout, or null when it can. */
export function reviewerMissing(adlc, agent, script) {
  return existsSync(agentScript(adlc, agent, script)) ? null : `the reference ${agent.replace("-", " ")} is not in the adlc checkout at ${adlc} (agents/${agent}/scripts/${script} is missing).`;
}

/**
 * Runs one reference reviewer's job, as its runtime requirements' run
 * declaration says (--job, --records, --work, --text-file, --file per file),
 * in base. files: [{ abs, media_type }].
 * Resolves to { ok, reply, doc, why }: doc is the Markdown piece it filed
 * (the code critic's findings, the security reviewer's review), or "".
 */
export async function reviewer({ adlc, agent, script, base, text, files, env, signal, minutes }) {
  const job = join(base, "job");
  mkdirSync(job, { recursive: true });
  writeFileSync(join(job, "message.txt"), text);
  const argv = NODE(agentScript(adlc, agent, script), ["--job", job, "--records", join(base, "records"), "--work", join(base, "work"), "--text-file", join(job, "message.txt"), ...files.flatMap((f) => ["--file", `${f.abs}::${f.media_type ?? ""}`])]);
  const r = await step(argv, { env, signal, cwd: job, log: join(base, "run.log"), timeoutMs: minutes * 60 * 1000 });
  if (r.stopped) return { ok: false, reply: "", doc: "", why: "It was stopped." };
  const md = piecesOf(job).find((p) => /markdown/i.test(p.media_type ?? "") || /\.md$/i.test(p.path));
  let doc = "";
  if (md) { try { doc = readFileSync(md.abs, "utf8"); } catch { doc = ""; } }
  const ok = r.code === 0;
  return { ok, reply: r.reply, doc, why: ok ? "" : failed(r, `The reference ${agent.replace("-", " ")}`) };
}

// ---------- Package: the build folder as an Agent Package ----------

/**
 * The package source: the agent's own files and skills from the build folder,
 * with each skill's scripts and references placed under skills/<slug>/ as the
 * build entry in plugin.json names them (extensions["net.agentdoc.package"].build.skills),
 * the layout Common Agent 12.2 gives a skill. Returns the files it could not place.
 */
export function packageSource(folder, out) {
  mkdirSync(out, { recursive: true });
  for (const f of ["agent-descriptor.json", "agent-runtime-requirements.json", "plugin.json", "mcp.json", "README.md"]) {
    if (existsSync(join(folder, f))) cpSync(join(folder, f), join(out, f));
  }
  if (existsSync(join(folder, "skills"))) cpSync(join(folder, "skills"), join(out, "skills"), { recursive: true });
  const missing = [];
  let plugin = {};
  try { plugin = JSON.parse(readFileSync(join(folder, "plugin.json"), "utf8")); } catch { /* the packer says so */ }
  const skills = plugin?.extensions?.["net.agentdoc.package"]?.build?.skills ?? {};
  for (const [slug, entry] of Object.entries(skills)) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) continue;
    for (const [kind, list] of [["scripts", entry?.scripts], ["references", entry?.references]]) {
      for (const p of Array.isArray(list) ? list : []) {
        const from = resolve(folder, String(p));
        const back = relative(folder, from);
        if (back.startsWith("..") || !existsSync(from) || !statSync(from).isFile()) { missing.push(String(p)); continue; }
        const to = join(out, "skills", slug, kind, basename(from));
        mkdirSync(dirname(to), { recursive: true });
        cpSync(from, to);
      }
    }
  }
  return { missing: [...new Set(missing)] };
}

/**
 * Packs the build folder with the packer and validates the archive.
 * Resolves to { ok, reply, handed, name, version }.
 */
export async function pack({ dir, n, folder, packer, env, signal }) {
  const base = join(dir, "stages", "package", `r${n}`);
  const src = join(base, "source");
  const out = join(base, "out");
  const { missing } = packageSource(folder, src);
  const log = join(base, "run.log");
  const built = await run([...packer, src, "--out", out, "--json"], { env, signal, cwd: base, log, timeoutMs: 10 * 60 * 1000 });
  if (built.stopped) return { ok: false, reply: "It was stopped." };
  const doc = lastJson(built.stdout);
  if (built.code !== 0 || !doc?.ok) {
    const why = built.error ? `The packer could not run: ${built.error}.` : `The packer refused the build folder: ${tail(built.stderr || built.stdout, 600) || `it ended with code ${built.code}`}`;
    return { ok: false, reply: why };
  }
  const archive = existsSync(out) ? readdirSync(out).find((f) => f.endsWith(".tar.gz")) : null;
  const record = existsSync(out) ? readdirSync(out).find((f) => f.endsWith("-build.json")) : null;
  if (!archive) return { ok: false, reply: "The packer said it packed the build folder, but wrote no archive." };
  const checked = await run([...packer, "validate", join(out, archive), "--json"], { env, signal, cwd: base, log, timeoutMs: 10 * 60 * 1000 });
  if (checked.stopped) return { ok: false, reply: "It was stopped." };
  const v = lastJson(checked.stdout);
  writeFileSync(join(base, "validation.json"), `${JSON.stringify(v ?? { ok: false, said: tail(checked.stdout || checked.stderr, 2000) }, null, 2)}\n`);
  const handed = [
    { path: `package/${archive}`, at: rel(dir, join(out, archive)) },
    ...(record ? [{ path: `package/${record}`, at: rel(dir, join(out, record)) }] : []),
    { path: "package/validation.json", at: rel(dir, join(base, "validation.json")) },
  ];
  const notes = [];
  if (missing.length) notes.push(`The build entry in plugin.json names ${plural(missing.length, "file")} that ${missing.length === 1 ? "is" : "are"} not in the build folder, so they are not packed: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ", …" : ""}.`);
  const issues = Array.isArray(v?.issues) ? v.issues : [];
  if (checked.code !== 0 || !v?.ok) {
    const list = issues.map((i) => (typeof i === "string" ? i : words(i?.message ?? i?.said ?? JSON.stringify(i)))).slice(0, 10);
    return { ok: false, reply: [`Packed ${doc.name} ${doc.version}, but the package does not validate${list.length ? `: ${list.join("; ")}` : "."}`, ...notes].join(" "), handed, items: list };
  }
  return {
    ok: true,
    reply: [`Packed ${doc.name} ${doc.version} as an Agent Package (sha256 ${doc.sha256}) and validated it against the mechanical checks of Common Agent Section 12.10: no problems.`, ...notes, "The build record is unsigned: milestone 1 holds no signing key."].join(" "),
    handed, name: doc.name, version: doc.version,
  };
}

// ---------- The holders' skills (lifecycle API 0.4.9) ----------

/** The name and description in a SKILL.md's frontmatter, as far as the Agent Skills format puts them: one scalar each. */
function skillHead(text) {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  const of = (key) => words(new RegExp(`^${key}:\s*(.*)$`, "m").exec(head)?.[1]).replace(/^(['"])(.*)\1$/, "$2");
  return { name: of("name"), description: of("description") };
}

/**
 * A reference agent's skills, from agents/<agent>/skills/<slug>/SKILL.md in the
 * adlc checkout, in the folder's order: [{ name, description, text }], text the
 * SKILL.md as written. [] when the agent has no skills folder, and null when the
 * agent is not in the checkout, so nothing is said about skills it may have.
 */
export function agentSkills(adlc, agent) {
  if (!adlc || !agent || !existsSync(join(adlc, "agents", agent))) return null;
  const dir = join(adlc, "agents", agent, "skills");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort()
    .filter((slug) => existsSync(join(dir, slug, "SKILL.md")))
    .map((slug) => {
      const text = readFileSync(join(dir, slug, "SKILL.md"), "utf8");
      const { name, description } = skillHead(text);
      return { name: name || slug, ...(description ? { description } : {}), text };
    });
}
