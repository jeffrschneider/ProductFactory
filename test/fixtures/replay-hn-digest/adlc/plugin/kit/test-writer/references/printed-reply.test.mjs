// Each job's command, run as the host runs it, prints the reply its run.reply names.
// Written by the test writer into every suite it writes, the same bytes each
// time; it is the test writer's file and not the package's, so it is never
// edited here. The next suite the test writer writes for this package brings
// its current copy.
//   node --test test/printed-reply.test.mjs
//
// What is worth pinning. The host runs a job's command (run.command in
// agent-runtime-requirements.json) and reads the sender's reply from what it
// prints, the way run.reply says:
//
//   stdout          the whole of what it printed, trimmed;
//   json:<member>   that member of the one JSON object the whole output is: a
//                   string as it is, missing or null as nothing, anything else
//                   as text; output that is not one JSON object gives nothing.
//
// An answer piece the package names, then the answer file (MESH_JOB_ANSWER),
// come before that reading, as on the host. A reply that is empty after
// trimming is no answer: the host records the job as stopped and tells the
// sender the work was cut short when pieces were filed, and that it produced no
// answer when none were, whatever the exit code. consonant-ledger was drafted
// with run.reply "json:consonant-count-report.md" while its script printed
// {"code":0,"reply":"..."}; every job made its report and still ended "cut
// short", and Conformance was inconclusive, because nothing before the host
// ran the command line (technical debt 657).
//
// How it is reached. This file runs each job's command itself, with an empty
// message and no files, which is the job's `empty` case: every job says
// something to that. The placeholders are filled as the host fills them, a
// script the packed layout puts under skills/<job>/scripts/ is run from
// scripts/ here, the model settings are left out so no model is reached, and
// the reply is read as above. One test per job, run when this file is run
// (as node --test runs every suite file); it needs nothing from the other
// tests, and importing a function from it adds no test. When the printed object lacks the member
// run.reply names, either the script prints it or, if the job should not, the
// spec's run.reply is wrong, which is the spec's to change and not a script's
// to bend around.
//
// Nothing here touches a network or a model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const trim = (s) => String(s ?? "").trim();

/** The longest one job here may run, in seconds, whatever it declares. */
export const RUN_SECONDS_MAX = 60;
/** The settings a job reaches a model through; never handed to the job here. */
export const MODEL_SETTINGS = ["MODEL_NAME", "MODEL_ENDPOINT", "MODEL_KEY", "MODEL_PROTOCOL", "AGENT_MODEL", "TEXT_MODEL"];

/** What the command printed, as the host reads it (one-message.mjs replyOf). */
export function replyOf(reply, stdout) {
  const mode = reply ?? "stdout";
  if (!mode.startsWith("json:")) return stdout;
  try {
    const v = JSON.parse(stdout)[mode.slice(5)];
    return typeof v === "string" ? v : v == null ? "" : String(v);
  } catch { return ""; }
}

/** The answer the sender gets, as the host decides it (one-message.mjs
 *  answerOf): the named answer piece when it was filed as text and is not
 *  empty, else the answer file when it is not empty, else the reply. Trimmed.
 *  `stdout` is the reply already read by replyOf. */
export function hostReply({ answerPiece = null, jobDir = "", answerFile = null, stdout = "" } = {}) {
  if (answerPiece) {
    try {
      const listed = JSON.parse(readFileSync(join(jobDir, "pieces.json"), "utf8"));
      const piece = Array.isArray(listed) ? listed.find((p) => p?.name === answerPiece) : null;
      if (piece && typeof piece.path === "string" && /^text\//.test(typeof piece.media_type === "string" ? piece.media_type : "")) {
        const text = trim(readFileSync(join(jobDir, piece.path), "utf8"));
        if (text) return text;
      }
    } catch { /* not filed: fall through, as the host does */ }
  }
  if (answerFile && existsSync(answerFile)) {
    try {
      const text = trim(readFileSync(answerFile, "utf8"));
      if (text) return text;
    } catch { /* unreadable: fall through */ }
  }
  return trim(stdout);
}

/** The package's declaration beside test/: its agent-runtime-requirements.json
 *  (or the older install.json), else a spec.json; null when there is neither. */
export function readDeclaration(dir = join(HERE, "..")) {
  for (const f of ["agent-runtime-requirements.json", "install.json", "spec.json"]) {
    const at = join(dir, f);
    if (!existsSync(at)) continue;
    try { return JSON.parse(readFileSync(at, "utf8")); } catch { return null; }
  }
  return null;
}

/** Each job that names a command: its slug, command, run.reply (stdout when
 *  absent), message file, and the seconds it may take here. */
export function commandsOf(decl) {
  const seconds = Math.min(Number(decl?.job_seconds) || RUN_SECONDS_MAX, RUN_SECONDS_MAX);
  const runs = decl?.run && typeof decl.run === "object" && !Array.isArray(decl.run)
    ? Object.entries(decl.run)
    : (Array.isArray(decl?.jobs) ? decl.jobs : []).map((j) => [j?.slug, j?.run]);
  return runs
    .filter(([slug, r]) => trim(slug) && r && Array.isArray(r.command) && r.command.length)
    .map(([slug, r]) => ({ slug: trim(slug), command: r.command.map(String), reply: r.reply ?? "stdout", message_file: r.message_file ?? null, seconds }));
}

/** The name of the piece the package says is its reply, or null. */
export function answerPieceOf(decl) {
  const a = decl?.answer;
  if (typeof a === "string" && a) return a;
  return typeof a?.piece === "string" && a.piece ? a.piece : null;
}

const fillOne = (s, values) => String(s).replace(/\{([a-z_]+)\}/g, (whole, key) => (key in values ? values[key] : whole));

/** The command with its placeholders filled as the host fills them, {home}
 *  and {package} naming this package's folder. A path the packed layout puts
 *  under skills/<job>/ that is not here is taken from the folder's top, where
 *  the package's scripts sit before they are packed. */
export function fillCommand(command, { root, job_dir, records, work, message_id = "printed-reply-1", sender = "a-sender.test@agentmesh.ai" } = {}) {
  const values = { home: dirname(root), package: basename(root), records, work, job_dir, message_id, sender, handle: sender, in_reply_to: "none" };
  const top = resolve(root);
  return command.map((x) => {
    const filled = fillOne(x, values);
    const at = resolve(filled);
    if (!at.startsWith(top) || existsSync(at)) return filled;
    const m = /^skills[\\/][^\\/]+[\\/](.+)$/.exec(at.slice(top.length + 1));
    return m && existsSync(join(top, m[1])) ? join(top, m[1]) : filled;
  });
}

/** One job's command, run once as the host runs it, with an empty message and
 *  no files, in folders made for it. What it printed, and the reply the host
 *  would read from that. */
export function runJob(job, { root = join(HERE, ".."), answerPiece = null } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "printed-reply-"));
  try {
    const home = join(scratch, "home");
    const job_dir = join(scratch, "job-1");
    const records = join(scratch, "records");
    const work = join(scratch, "work");
    for (const d of [home, join(job_dir, "out"), records, work]) mkdirSync(d, { recursive: true });
    const answerFile = join(scratch, "answer.txt");
    const filled = { root, job_dir, records, work };
    if (job.message_file) {
      const mf = fillCommand([job.message_file], filled)[0];
      mkdirSync(dirname(mf), { recursive: true });
      writeFileSync(mf, "");
    }
    const argv = fillCommand(job.command, filled);
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith("NODE_TEST_") || MODEL_SETTINGS.includes(k)) delete env[k];
    Object.assign(env, { HOME: home, MESH_JOB_DIR: job_dir, MESH_JOB_OUT: join(job_dir, "out"), MESH_JOB_ANSWER: answerFile });
    const r = spawnSync(argv[0], argv.slice(1), { cwd: home, env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: job.seconds * 1000 });
    const stdout = trim(r.stdout);
    const timedOut = r.error?.code === "ETIMEDOUT" || (r.status === null && !!r.signal);
    return {
      code: timedOut ? 124 : r.status ?? 2, timedOut, stdout, stderr: trim(r.stderr),
      started: !(r.error && !timedOut),
      reply: hostReply({ answerPiece, jobDir: job_dir, answerFile, stdout: replyOf(job.reply, stdout) }),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** A short quote of what was printed, for the sentence that names it. */
const quote = (s) => (s.length > 200 ? `${JSON.stringify(s.slice(0, 200))}...` : JSON.stringify(s)); // cut-ok: a quote in a test failure; the whole is the script's own output

/** Why the host would read no reply from this run, as sentences; [] when it
 *  reads one. */
export function printedReplyProblems(job, run) {
  if (trim(run?.reply)) return [];
  const mode = job.reply ?? "stdout";
  const out = trim(run?.stdout);
  const end = "so the host reads no reply: it records the job as stopped and tells the sender the work was cut short "
    + "(or, with no piece filed, that it produced no answer), whatever the exit code";
  let why;
  if (run?.timedOut) why = `the command did not finish in ${job.seconds} seconds`;
  else if (run && run.started === false) why = `the command could not be started (${trim(run.stderr) || "no reason given"})`;
  else if (!mode.startsWith("json:")) why = "the command printed nothing";
  else {
    const member = mode.slice(5);
    let doc;
    try { doc = JSON.parse(out); } catch { doc = undefined; }
    if (!out) why = "the command printed nothing";
    else if (doc === undefined || doc === null || typeof doc !== "object" || Array.isArray(doc)) why = `what it printed is not one JSON object: ${quote(out)}`;
    else if (!(member in doc) || doc[member] == null) why = `the object it printed has no member ${member} (it has ${Object.keys(doc).join(", ") || "no members"})`;
    else why = `the object's ${member} member is empty`;
  }
  const fix = mode.startsWith("json:")
    ? ` Print one JSON object whose ${mode.slice(5)} member is the words the sender reads, and nothing else on stdout. If the job should not print that member, the spec's run.reply is wrong, and that is the spec's to change, not a script's.`
    : " Print the words the sender reads.";
  return [`job ${job.slug}: run.reply is ${JSON.stringify(mode)}, and run with an empty message ${why}, ${end}.${fix}`];
}

// The tests run when this file is run, as node --test runs each suite file;
// importing a function from it adds none.
const ranDirectly = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const declaration = ranDirectly ? readDeclaration() : null;
for (const job of commandsOf(declaration)) {
  test(`job ${job.slug}: its command, run as the host runs it with an empty message, prints the reply run.reply names`, () => {
    const run = runJob(job, { answerPiece: answerPieceOf(declaration) });
    assert.deepEqual(printedReplyProblems(job, run), []);
  });
}
