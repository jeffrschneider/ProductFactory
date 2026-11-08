// The holder adapters: how each holder milestone 1 sends work to is reached,
// the way it says it is run, and nothing else. They know nothing of builds,
// records or the order of steps; each takes folders and files and hands back
// what the holder said and made. They are the part a shared process runner
// reuses: the orchestrator (orchestrator.mjs) decides the next step, and an
// adapter here does it.
//
//   Requirements  the reference spec writer (CommonAgent/adlc agents/spec-writer),
//                 its four commands and pieces.mjs, as its write-a-spec skill says
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
import { run, lastJson, tail } from "./exec.mjs";

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
export function requestText({ does, refuses, more, name, prototype }) {
  const lines = ["Write a spec.", `what it should do: ${words(does)}`];
  if (words(refuses)) lines.push(`what it must refuse: ${words(refuses)}`);
  if (words(more)) lines.push(`more: ${words(more)}`);
  if (words(prototype)) lines.push(`prototype: ${words(prototype)}`);
  if (words(name)) lines.push(`name: ${words(name)}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Runs the spec writer's write-a-spec job in <dir>/stages/requirements/r<n>.
 * text: the message. attach: earlier agent files to revise ([{abs, media_type}]).
 * Resolves to { ok, reply, agentFiles: [{abs, media_type, path}], handed: [{path, at}] }.
 */
export async function specWriter({ dir, adlc, n, text, attach = [], env, signal }) {
  const scripts = ["asked.mjs", "draft.mjs", "builds.mjs", "ask.mjs", "pieces.mjs"];
  const gone = missingAgent(adlc, "spec-writer", scripts);
  if (gone) return { ok: false, reply: gone };
  const base = join(dir, "stages", "requirements");
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
  const agentFiles = filed.filter((p) => p.path.startsWith("out/agent/")).map((p) => ({ abs: p.abs, media_type: p.media_type, path: p.path.slice("out/agent/".length) }));
  const handed = filed.map((p) => ({ path: `requirements/${p.path.replace(/^out\/(agent\/)?/, "")}`, at: rel(dir, p.abs) }));
  if (!agentFiles.length) return { ok: false, reply, handed };
  return { ok: true, reply, agentFiles, handed };
}

// ---------- Test: the reference test writer ----------

/**
 * Runs the test writer's write-a-suite job, as its run declaration says, in
 * <dir>/stages/test. Resolves to { ok, reply, suite: [{abs, path}], handed }.
 */
export async function testWriter({ dir, adlc, n, agentFiles, text = "Write the suite for the agent's files attached.\n", attach = [], env, signal }) {
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
  const suite = filed.filter((p) => /^out\/test\/[^/]+\.test\.mjs$/.test(p.path)).map((p) => ({ abs: p.abs, media_type: p.media_type || "text/javascript", path: p.path.slice("out/".length) }));
  const handed = filed.map((p) => ({ path: p.path.replace(/^out\//, "").replace(/^(?!test\/)/, "test/"), at: rel(dir, p.abs) }));
  if (r.code !== 0 || !suite.length) return { ok: false, reply: suite.length ? failed(r, "The test writer") : r.reply || failed(r, "The test writer"), handed };
  return { ok: true, reply: r.reply || `The test writer wrote ${plural(suite.length, "test file")}.`, suite, handed };
}

// ---------- Code: the hand-off, then your coding harness or the reference code writer ----------

/**
 * Lays out the build folder with the code writer's hand-off: the agent's files,
 * the suite, the stubs, AGENTS.md, .adlc/check.mjs and build.lock.json.
 * Resolves to { ok, reply, folder, archive }.
 */
export async function handOff({ dir, adlc, agentFiles, suite, env, signal }) {
  const gone = missingAgent(adlc, "code-writer", ["handoff.mjs"]);
  if (gone) return { ok: false, reply: gone };
  const base = join(dir, "stages", "code", "handoff");
  const job = join(base, "job");
  mkdirSync(job, { recursive: true });
  writeFileSync(join(job, "message.txt"), "Hand off the code\n");
  const files = [...agentFiles, ...suite].flatMap((f) => ["--file", `${f.abs}::${f.media_type ?? ""}`]);
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
  return argv.map((w) => w.replace(/\{(prompt|workspace|feedback_file|round)\}/g, (_, k) => String(vars[k] ?? "")));
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
 * Resolves to { pass, code, words, items, harness }.
 */
export async function codeRound({ dir, adlc, mode, folder, records, harness, round, feedbackFile, minutes, env, signal }) {
  const base = join(dir, "stages", "code", "rounds", String(round));
  mkdirSync(base, { recursive: true });
  const prompt = mode === "code-writer" ? codeWriterPrompt({ adlc, feedbackFile }) : harnessPrompt({ feedbackFile });
  const extra = mode === "code-writer" ? { WORKSPACE: folder, RECORDS: records } : {};
  const hEnv = { ...env, ...extra, PF_PROMPT: prompt, PF_WORKSPACE: folder, PF_FEEDBACK_FILE: feedbackFile ?? "", PF_ROUND: String(round) };
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

/** The scripts the folder holds now, as handed-back files. */
export function scriptsHanded(dir, folder) {
  return filesUnder(join(folder, "scripts")).map((r) => ({ path: `code/scripts/${r}`, at: rel(dir, join(folder, "scripts", r)) }));
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
