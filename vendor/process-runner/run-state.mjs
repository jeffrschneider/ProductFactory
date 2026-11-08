// The state of one run and the events that move it. Every turn of the Runner
// loads a run from disk, applies what the message means as events, asks what
// to do next, and saves. The reducer (`apply`) and the planner (`nextActions`)
// are pure, so a whole run can be walked in a test without a mesh.
//
// On disk, under <runs dir>/<run id>/: state.json (this structure),
// events.jsonl (one event per line, in order, never edited), document.txt
// (the document as received), and files/ (what crossed each handoff).
//
// Events, each with `at`:
//   started    {by}                                 the run opened
//   holder     {phase, handle, how}                 who holds a phase, and how that was found
//   sent       {phase, to, handle, kind, message_id, inbox_id, outbox, text, files}
//              kind: work | draft | revision | answer | stop | question | delivery | report
//              outbox {dir, ref, line}: where a message the host sends was left,
//              when this work could not send it and so has no id yet
//   ids        {found: [{ref, message_id, inbox_id}]}   the ids the host got back
//              for messages left in an outbox, read on a later turn
//   send-failed {phase, to, kind, error}
//   replied    {phase, from, handle, in_reply_to, inbox_id, text, files, verdict, label}
//              verdict: delivered | block | refused | stopped; a delivery or a
//              refusal is kept as one of the phase's attempts (0.20.0), with
//              the holder's retry label for a refusal
//   retried    {phase, attempt, of, job, label, said, why, holder}   the retry
//              policy sends a refused phase's work to its holder again (0.20.0)
//   gated      {phase, question, files, message_id}  the owner was asked about a phase
//   approved   {phase, by, text, files}             the owner answered yes, or acted
//   deviated   {key, from, to, by, text, steps}     the owner named a deviation edge
//   stopped    {by, reason}                          the owner cancelled the run
//   timed-out  {phase, since, limit_ms, holder}      a phase had its work out past
//              the limit with nothing back; the run ends as failed, the
//              holders still working are told to stop, the owner is told
//   closed     {outcome, result, open}
//   send-again {phase, by, files}                  the owner asked for a phase to go out again, with files to add
//   noted      {text}
//   gap        {phase, why, missing, inputs}       the phase's handoff does not fit what its holder takes, and the run waits on the owner (fit.mjs)
//   converted  {phase, from_phases, inputs, via, fields, read_as}   what a handoff was converted into before it went out
//   gap-cleared {phase, by, word}                  the owner's answer to a gap: retry, send anyway, convert anyway, or pay for the conversion
//   conversion-started {phase, plan, queue, read_as}  a piece goes through other agents before the phase (0.15.0)
//   conversion-sent {phase, agent, offering, step}    one sub-step went out
//   conversion-got  {phase, got}                       a sub-step delivered; the piece is now what it gave
//   conversion-failed {phase, why}                     a sub-step refused, failed or ran out of time: a gap
//   resumed    {phase, reopen, revisions, by, for, price, acct}   a run that failed or was stopped,
//              taken up again at one phase (0.16.0, resume.mjs); the phases in reopen run again
//   skipped    {phase, holder, text}   a phase refused and every phase that waits for it
//              names it with ?, so the run goes on past it (0.17.0); status "skipped"
//   trigger-refused {phase, holder, text}   a phase that starts at the trigger refused
//              what the run was started with; the run ends as failed (0.17.0)
//
// Every text an event carries (a message's words, a question, a stop reason)
// passes through `scrub` as the event is applied, so nothing that looks like
// a credential value reaches state.json, events.jsonl or the account.
//
//   needs: node >= 22
import { timeline } from "./timeline.mjs";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { graph, holderFor, inbound, modeOf, optionalEverywhere, outbound, phase as phaseOf, readyPhases, startsAtTrigger, successors, carried } from "./plan.mjs";
import { termsRefusal } from "./agreements.mjs";
import { budgetOf } from "./retry.mjs";

export const FORMAT = "process-run-v1";
export const ACTIVE = new Set(["working", "blocked", "holding", "gated", "asking-holder", "refused", "unreachable", "stopping", "needs-input", "converting"]);

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

export const REMOVED = "[a credential value was removed]";

/** Replaces anything that looks like a credential value with a note that one
 *  was removed. Called before message text is written anywhere. The shapes:
 *  Google-style keys (AIza and 35 more characters), prefixed tokens of 20 or
 *  more characters (sk-, pk-, amt_, hf_, ghp_, xoxb-, glpat-, npm_, an AKIA
 *  access key id), bearer tokens, and whatever follows the words key, token,
 *  password, passphrase, secret or credential and a colon or equals sign on
 *  the same line. Applying it twice changes nothing. */
export function scrub(text) {
  return String(text ?? "")
    .replace(/\bAIza[\w-]{35}/g, REMOVED)
    .replace(/\b(?:sk|pk|amt|hf|glpat|xox[abopsr]|gh[opsur])[-_][A-Za-z0-9_-]{20,}|\bnpm_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b/g, REMOVED)
    .replace(/\bbearer[ \t]+[A-Za-z0-9._~+/=-]{8,}/gi, (m) => `${m.split(/[ \t]/)[0]} ${REMOVED}`)
    .replace(/(\b(?:[a-z]+[ _-])?(?:key|token|password|passphrase|secret|credential)s?[ \t]*[:=][ \t]*)[^\n]*\S/gi, `$1${REMOVED}`);
}

export function newRunId(now = new Date()) {
  const d = now.toISOString().slice(0, 10).replace(/-/g, "");
  return `r-${d}-${randomBytes(2).toString("hex")}`;
}

/** A by: value as milliseconds, when it is a plain duration; null otherwise. */
export function parseBound(by) {
  const m = /^(\d+)\s*(minute|hour|day|week)s?$/i.exec(String(by ?? "").trim());
  if (!m) return null;
  const unit = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 }[m[2].toLowerCase()];
  return Number(m[1]) * unit;
}

/** The words after "one run per" that name each arrival rather than a thing
 *  the material is about. Every trigger is a new run under such a line. */
const PER_ARRIVAL = new Set(["trigger", "triggers", "message", "messages", "request", "requests", "instruction", "instructions", "time", "schedule", "run", "start"]);

/** What the concurrency: line allows, read from its words.
 *
 *  "One run per trigger" means each trigger is its own run, so it never
 *  refuses a trigger. It was read as "one run per <subject>" with the subject
 *  taken from the material, and a scheduled solution sends the same file
 *  name every morning: run r-20260928-0424 stayed open for channel.json, and
 *  every later trigger was refused under a line that begins "runs may
 *  overlap" (2026-09-29). */
export function concurrencyRule(text) {
  const t = String(text ?? "").toLowerCase();
  const per = /one run per ([a-z-]+)/.exec(t);
  if (per && PER_ARRIVAL.has(per[1])) return { mode: "overlap", per: per[1], text: String(text ?? "") };
  if (per) return { mode: "per-subject", subject: per[1], text: String(text ?? "") };
  if (/one run at a time|never overlap|do not overlap|runs never/.test(t)) return { mode: "single", text: String(text ?? "") };
  return { mode: "overlap", text: String(text ?? "") };
}

/** How long a phase may sit with its work out and no word back before the
 *  run ends as failed. Six hours unless PROCESS_STUCK_HOURS says otherwise,
 *  and never shorter than the phase's own by: bound, which is recorded as
 *  passed and never enforced. A holder that fails without answering (the
 *  fleet's model credit ran out on 2026-09-28 and two runs sat open with a
 *  phase "working" for a day, refusing every trigger after them) leaves
 *  nothing that would ever move the run, so the limit is what ends it. */
export const STUCK_AFTER_MS = 6 * 3_600_000;

export function stuckLimitMs(doc, phaseId, env = process.env) {
  const hours = Number(env?.PROCESS_STUCK_HOURS);
  const base = Number.isFinite(hours) && hours > 0 ? hours * 3_600_000 : STUCK_AFTER_MS;
  const bound = doc ? parseBound(phaseOf(doc, phaseId)?.by) : null;
  return bound && bound > base ? bound : base;
}

/** The phase that has been working past its limit with nothing back, or
 *  null. The clock starts at the last thing this runner sent the phase (its
 *  work, a revision, an answer), so a phase answered an hour ago is an hour
 *  old. Only an open run's working phase counts: a gate, a held output or a
 *  relayed question waits on the owner, and that wait is never timed out. */
export function stuckPhase(state, doc, now, env = process.env) {
  if (state?.status !== "open") return null;
  const t = Date.parse(now);
  if (!Number.isFinite(t)) return null;
  const owner = String(state.owner ?? "").trim().toLowerCase();
  for (const [id, p] of Object.entries(state.phases ?? {})) {
    if (p.status !== "working") continue;
    // A phase the run's own owner holds (0.30.0) waits on them, like a gate:
    // the owner is waiting on themselves, and what they wait for (a pull
    // request, an install approval, a verdict filed later) can take days.
    if (owner && String(p.holder?.handle ?? "").trim().toLowerCase() === owner) continue;
    // A phase whose inner run has started (0.34.0) waits on that run, which
    // runs under its own deadlines (Agent Processes 6.3.1).
    if (p.inner?.run) continue;
    const sends = (p.sent ?? []).filter((x) => ["work", "draft", "revision", "answer", "deploy-request"].includes(x.kind)).map((x) => Date.parse(x.at)).filter(Number.isFinite);
    const since = Math.max(Date.parse(p.opened_at ?? "") || 0, ...sends);
    if (!since) continue;
    const limit = stuckLimitMs(doc, id, env);
    if (t - since > limit) return { phase: id, since: new Date(since).toISOString(), limit_ms: limit, holder: p.holder?.handle ?? null };
  }
  return null;
}

/** "6 hours", "90 minutes", "2 days": a limit as a person says it. */
export function spanWords(ms) {
  const m = Math.round(ms / 60_000);
  if (m < 120) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"}`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}

/** The subject of a run for the concurrency rule: the first web address in
 *  the material, else the first attached file's name, else the material's digest. */
export function subjectOf(material, files = []) {
  const url = /https?:\/\/\S+/.exec(String(material ?? ""));
  if (url) return url[0].replace(/[),.]+$/, "");
  if (files.length) return files[0].name ?? files[0].path ?? "";
  return material ? sha256(String(material)).slice(0, 16) : "";
}

export function newRun({ runId, doc, text, owner, rosterText = "", material = "", files = [], budget = null, startedAt, startedBy, platformRun = null, platformRunDriven = true, runConfig = null, acct = null, testCase = null, carried = null, extensions = null, innerOf = null }) {
  const phases = {};
  for (const p of doc.phases) {
    phases[p.id] = { status: "waiting", level: p.automation, mode: modeOf(p), round: 0, holder: null, sent: [], history: [] };
  }
  return {
    format: FORMAT,
    run_id: runId,
    status: "open",
    process: { id: doc.id, key: doc.header.team ? `${doc.header.team}/${doc.id}` : doc.id, name: doc.name, version: doc.header.version, ref: doc.ref || null, owner: doc.header.owner, effective: doc.header.effective, digest: `sha256:${sha256(text)}` },
    // 0.34.0: an inner run (Agent Processes 6.3.1) names the outer run and the
    // phase that started it, the chain of documents above it, and the highest
    // level its phases run at. Fixed at start.
    ...(innerOf ? { inner_of: innerOf } : {}),
    owner: owner ?? doc.header.owner,
    started_at: startedAt,
    started_by: startedBy ?? owner ?? doc.header.owner,
    // 0.33.0: what the run was handed, item by item, when the trigger carries items (Agent Processes 13.2).
    trigger: { text: doc.trigger.text, material: scrub(material), files, subject: subjectOf(scrub(material), files), ...(carried ? { carried } : {}), ...(innerOf ? { inner_of: { run: innerOf.run, phase: innerOf.phase } } : {}) },
    // 0.33.0: the extensions the document carries, read and ignored (Agent Processes 20.3).
    ...(extensions ? { extensions } : {}),
    concurrency: concurrencyRule(doc.concurrency),
    budget,
    // The platform's own record of this run, when the platform asked for it.
    // Null means nobody but this agent is keeping a record, which is every run
    // somebody starts by sending a document on the mesh. A run is one or the
    // other for its whole life: a phase sent by both would be paid for twice.
    platform_run: platformRun ?? null,
    // 0.13.0: a hand-off names its platform run without asking to be driven
    // (`platform run:`); then the run walks on the mesh as before and the id
    // only says which of the platform's runs this is (technical debt 215).
    ...(platformRun && !platformRunDriven ? { platform_run_driven: false } : {}),
    // 0.19.0: the run config the platform resolved for this run, as
    // { name, digest (the resolved digest), parts: { <phase id>: <part> } };
    // each phase is handed its part verbatim in its run context.
    ...(runConfig ? { run_config: runConfig } : {}),
    // 0.30.0: the run accounting record the run was started under (who asked
    // and for whom, kept by the platform as meta.acct). Every message the run
    // sends carries it, whichever message woke the turn that sent it.
    ...(acct ? { acct } : {}),
    // 0.32.0: a test run follows a test case (Agent Processes 0.9.0), fixed
    // at start: its approvals may be answered by the test case and are
    // recorded as the test case's, a phase with a stand-in is not sent, and a
    // phase the test case keeps from running ends the run. Every other run is
    // "real", and nothing a test case says acts on it.
    mode: testCase ? "test" : "real",
    ...(testCase ? { test_case: testCase.id, stand_ins: testCase.stand_ins ?? {}, not_run: testCase.not_run ?? [] } : {}),
    roster_text: rosterText,
    roster: {},
    round: 1,
    phases,
    handoffs: {},
    handoff_history: [],
    messages: [],
    approvals: [],
    deviations: [],
    bounds: [],
    notes: [],
    // Every conversion of a handoff before it went out (fit.mjs): which phase,
    // what changed, how sure the converter was, and where each value came from.
    conversions: [],
    events: [],
    closed_at: null,
    outcome: null,
    result: null,
    open: [],
  };
}

const clone = (s) => structuredClone(s);

/** Apply one event. Returns a new state; the event is appended to state.events. */
/** The handoff as the owner left it: a changed file attached with the yes
 *  replaces the piece of the same name and every other piece stays. Taking
 *  the owner's files alone dropped the pieces they did not touch; taking the
 *  holder's kept a superseded draft in play (2026-09-15). */
export function ownersVersion(inFiles = [], ownerFiles = []) {
  const theirs = (ownerFiles ?? []).filter((f) => f && !f.error);
  if (!theirs.length) return inFiles;
  // One piece in, one file back: it is that piece, changed, whatever the
  // person called the copy (brief.txt comes back as brief-edited.txt).
  if (inFiles.length === 1 && theirs.length === 1) return theirs;
  const nameOf = (f) => String(f.name ?? f.path ?? "").split(/[\\/]/).pop();
  const replaced = new Set(theirs.map(nameOf));
  return [...inFiles.filter((f) => !replaced.has(nameOf(f))), ...theirs];
}

/** A revision over the handoff it revises (0.31.0): each delivered file
 *  replaces the piece of the same name, the process runner's copy prefixes
 *  taken off, and every other piece stays. Unlike ownersVersion, one file
 *  back is never taken as the one piece changed: a revision names its files. */
export function revisedVersion(before = [], delivered = []) {
  const theirs = (delivered ?? []).filter((f) => f && !f.error);
  if (!theirs.length) return before;
  const nameOf = (f) => String(f.name ?? f.path ?? "").split(/[\\/]/).pop().replace(/^(\d+-[A-Za-z0-9_-]{8}-)+/, "");
  const replaced = new Set(theirs.map(nameOf));
  return [...(before ?? []).filter((f) => f && !f.error && !replaced.has(nameOf(f))), ...theirs];
}

/** The latest handoff of `key` that `phase` made, in place or withdrawn into
 *  the run's handoff history by the deviation that reopened it. */
function lastHandoffOf(s, key, phase) {
  const here = s.handoffs[key];
  if (here && (here.from ?? []).includes(phase)) return here;
  return [...(s.handoff_history ?? [])].reverse().find((h) => h.key === key && (h.from ?? []).includes(phase)) ?? null;
}

// ── handoffs that share a key (0.23.0) ─────────────────────────────────────
//
// A handoff's key may be used by more than one phase of a document: in the
// Ponder document prod ran, ponder-planner hands fact-checker [facts] and
// fact-checker hands lens-writer [facts]. The run keeps handoffs by key, so a
// delivery of the later phase replaces the earlier one, which is what the
// phase after it is to be handed. Until 0.23.0 the earlier one was simply
// lost, and reopening a phase withdrew every handoff named by one of its
// outgoing keys, whoever made it: in run r-20261009-9f57 "resume at
// fact-checker" withdrew the facts ponder-planner had handed fact-checker, so
// fact-checker was never ready and the run closed as completed with only the
// plan.

/** Put a handoff in place. One that another phase made under the same key is
 *  kept in the run's handoff history first, so it can be put back. */
function setHandoff(s, value) {
  const held = s.handoffs[value.key];
  if (held && !(held.from ?? []).some((f) => (value.from ?? []).includes(f))) s.handoff_history.push(held);
  s.handoffs[value.key] = value;
}

/** Withdraw the handoffs the reopened phases made themselves, and put back,
 *  for each key one of them had replaced, the latest handoff of that key a
 *  kept phase (closed or skipped, not reopened) made. A handoff of the same
 *  key that a kept phase made, and that is still in place, stays. */
function withdrawHandoffs(s, doc, reopened) {
  if (!doc) return;
  const re = new Set(reopened);
  const keys = [];
  for (const id of reopened) for (const h of outbound(doc, id)) if (!keys.includes(h.key)) keys.push(h.key);
  for (const key of keys) {
    const held = s.handoffs[key];
    if (held && (held.from ?? []).some((f) => re.has(f))) { s.handoff_history.push(held); delete s.handoffs[key]; }
    if (s.handoffs[key]) continue;
    const back = [...s.handoff_history].reverse().find((h) => h.key === key && (h.from ?? []).length
      && !h.from.some((f) => re.has(f)) && h.from.every((f) => ["closed", "skipped"].includes(s.phases[f]?.status)));
    if (back) s.handoffs[key] = back;
  }
}

/** Each file once, by its path (messages.mjs uniqueFiles, which this file does not import). */
const onceEach = (files) => {
  const seen = new Set();
  return (files ?? []).filter((f) => {
    const k = typeof f?.path === "string" ? f.path.replace(/\\/g, "/") : null;
    if (!k) return true;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

export function apply(state, event, doc) {
  const s = clone(state);
  const at = event.at ?? new Date().toISOString();
  const e = { ...event, at, n: s.events.length + 1 };
  for (const k of ["text", "question", "reason"]) if (typeof e[k] === "string") e[k] = scrub(e[k]);
  if (e.type === "timed-out" && s.status !== "open") throw new Error(`run ${s.run_id} is ${s.status}; only an open run times out`);
  s.events.push(e);
  const ph = (id) => {
    if (!s.phases[id]) throw new Error(`no phase ${id} in run ${s.run_id}`);
    return s.phases[id];
  };
  switch (e.type) {
    case "started": {
      s.status = "open";
      s.started_at = s.started_at ?? at;
      break;
    }
    case "noted": {
      s.notes.push({ at, text: e.text });
      break;
    }
    // A phase that was sent and then stalled could only be got out of by
    // stopping the run and starting another, which paid for every phase before
    // it a second time. This puts one phase back in line so the planner sends
    // its work again, and says in the record that it went out more than once.
    // A phase that already delivered is not sent again: asking for that work
    // over is a revision, which has its own price and its own exchange.
    case "send-again": {
      const p = ph(e.phase);
      p.status = "waiting";
      p.sends = (p.sends ?? 1) + 1;
      // Files the owner attached with the ask ride the resend, the owner's
      // winning by name over what the handoffs carry.
      if (e.files?.length) p.again_files = [...(p.again_files ?? []), ...e.files];
      delete p.block; delete p.asked; delete p.error; delete p.skipped;
      s.notes.push({ at, text: `phase ${e.phase}: ${e.by} asked for it to be sent again; this is send ${p.sends}` });
      break;
    }
    // The retry policy (0.20.0, retry.mjs): a refusal whose holder said
    // another try could help, with attempts left, puts the phase back in line
    // and the same work goes to the same holder, naming the earlier job and
    // what went wrong. The refusal stays on the phase's attempts.
    case "retried": {
      const p = ph(e.phase);
      const last = p.attempts?.[p.attempts.length - 1];
      if (last) last.retried = true;
      p.status = "waiting";
      p.retry = { used: (p.retry?.used ?? 0) + 1, attempt: e.attempt, of: e.of, job: e.job ?? null, label: e.label ?? null, said: e.said ?? "" };
      p.retry_pending = true;
      delete p.block; delete p.asked; delete p.error;
      s.notes.push({ at, text: `phase ${e.phase}: ${e.why}; sending it to ${e.holder ?? "its holder"} again, attempt ${e.attempt} of at most ${e.of}` });
      break;
    }
    case "holder": {
      const p = ph(e.phase);
      p.holder = { handle: e.handle, how: e.how };
      s.roster[e.phase] = { handle: e.handle, how: e.how, at };
      // A holder named after the phase stalled (nobody held it, the holder
      // refused, or the send failed) puts the phase back in line to be sent.
      if (["asking-holder", "refused", "unreachable"].includes(p.status)) { p.status = "waiting"; delete p.asked; delete p.block; delete p.error; }
      break;
    }
    case "sent": {
      const ref = e.outbox?.ref ?? null;
      const msg = { n: s.messages.length + 1, dir: "out", kind: e.kind, phase: e.phase ?? null, id: e.message_id ?? null, inbox_id: e.inbox_id ?? null, to: e.to, handle: e.handle ?? null, at, text: e.text, files: e.files ?? [], ...(e.outbox ? { outbox: e.outbox, ref } : {}) };
      s.messages.push(msg);
      if (e.phase) {
        const p = ph(e.phase);
        p.sent.push({ message_id: e.message_id ?? null, inbox_id: e.inbox_id ?? null, kind: e.kind, to: e.to, at, ...(ref ? { ref } : {}) });
        if (["work", "draft", "revision", "deploy-request"].includes(e.kind)) {
          p.status = "working"; p.opened_at = p.opened_at ?? at; p.round = s.round; delete p.block;
          // A send the retry policy asked for keeps the count of retries;
          // any other send opens the phase afresh (0.20.0).
          if (p.retry_pending) delete p.retry_pending;
          else delete p.retry;
        } else if (e.kind === "answer") {
          p.status = "working"; if (p.block) p.block.answered_at = at;
          // The runner's own answer, counted per round: it answers a holder
          // once a round, and asks the owner the next time.
          if (e.by_runner) { p.runner_answers = { ...(p.runner_answers ?? {}) }; p.runner_answers[s.round] = (p.runner_answers[s.round] ?? 0) + 1; }
        } else if (e.kind === "stop") {
          p.status = "cancelled"; p.closed_at = at;
        } else if (e.kind === "question") {
          p.asked = { at, message_id: e.message_id ?? null, ...(ref ? { ref } : {}) };
        }
      }
      break;
    }
    // The ids the host got back for messages this work left in an outbox. Each
    // is written where the send was recorded, so a reply that names the
    // message is matched by in_reply_to like any other; the sent event itself
    // is never edited, and this event is the record of when the id was learned.
    case "ids": {
      const byRef = new Map((e.found ?? []).filter((f) => f?.ref && f.message_id).map((f) => [f.ref, f]));
      for (const m of s.messages) {
        const f = m.dir === "out" && !m.id && m.ref ? byRef.get(m.ref) : null;
        if (f) { m.id = f.message_id; m.inbox_id = m.inbox_id ?? f.inbox_id ?? null; }
      }
      const learn = (x) => {
        const f = x && !x.message_id && x.ref ? byRef.get(x.ref) : null;
        if (f) x.message_id = f.message_id;
        if (f && "inbox_id" in x) x.inbox_id = x.inbox_id ?? f.inbox_id ?? null;
      };
      for (const p of Object.values(s.phases)) {
        for (const x of p.sent ?? []) learn(x);
        for (const h of p.history ?? []) for (const x of h.sent ?? []) learn(x);
        learn(p.asked);
      }
      break;
    }
    case "send-failed": {
      const p = ph(e.phase);
      // A stop that could not be sent leaves the phase cancelled, not waiting
      // for somebody to name another holder: the run has ended either way.
      if (e.kind === "stop" || s.status !== "open") { p.status = "cancelled"; p.closed_at = p.closed_at ?? at; p.error = e.error; }
      else { p.status = "unreachable"; p.error = e.error; p.opened_at = p.opened_at ?? at; p.round = s.round; }
      s.notes.push({ at, text: `phase ${e.phase}: sending ${e.kind} to ${e.to} failed: ${e.error}` });
      break;
    }
    case "replied": {
      const msg = { n: s.messages.length + 1, dir: "in", phase: e.phase ?? null, id: e.inbox_id ?? null, in_reply_to: e.in_reply_to ?? null, from: e.from, handle: e.handle ?? null, at, text: e.text, files: e.files ?? [], verdict: e.verdict };
      s.messages.push(msg);
      if (!e.phase) break;
      const p = ph(e.phase);
      const agent = e.handle ?? e.from;
      // Every answer to the phase's work is an attempt (0.20.0, the retry
      // policy): when it went, when it came back, from whom, what it came to,
      // and the holder's label for a refusal. The run page shows them with
      // what each cost.
      if (["delivered", "refused"].includes(e.verdict)) {
        const work = [...(p.sent ?? [])].reverse().find((x) => ["work", "revision", "draft"].includes(x.kind)) ?? null;
        p.attempts = [...(p.attempts ?? []), {
          n: (p.attempts?.length ?? 0) + 1, round: p.round ?? s.round, sent_at: work?.at ?? p.opened_at ?? null, answered_at: at,
          job: e.in_reply_to ?? work?.message_id ?? null, from: e.from ?? null, handle: e.handle ?? null, outcome: e.verdict,
          ...(e.label ? { label: e.label } : {}),
          // Which budget a refusal counted against (0.21.0): the model's answer, or the infrastructure.
          ...(e.verdict === "refused" && budgetOf(e.label) ? { budget: budgetOf(e.label) } : {}),
        }];
      }
      if (e.verdict === "delivered") {
        // The reply's words whole (0.14.0): the run page shows what the holder said.
        p.record = { agent, what: String(e.text ?? ""), at, files: e.files ?? [], reply_id: e.inbox_id ?? null, in_reply_to: e.in_reply_to ?? null };
        // A test run's stand-in (0.32.0): the phase was not sent, and the
        // test case's output is its delivery. The record says so, so no reader
        // takes it for the holder's work.
        if (e.stood_in) {
          p.record.stood_in = true;
          p.stood_in = true;
          p.opened_at = p.opened_at ?? at;
          p.round = s.round;
          msg.stood_in = true;
        }
        const bound = doc ? parseBound(phaseOf(doc, e.phase)?.by) : null;
        if (bound && p.opened_at && Date.parse(at) - Date.parse(p.opened_at) > bound) {
          s.bounds.push({ phase: e.phase, by: phaseOf(doc, e.phase).by, opened_at: p.opened_at, delivered_at: at });
          p.past_bound = true;
        }
        const outs = doc ? outbound(doc, e.phase) : [];
        const held = p.mode === "hold-output" || p.mode === "person-acts";
        for (const h of outs) {
          // The phase a deviation sent back revises its last handoff (0.31.0,
          // debt 666): what it delivers now replaces the pieces of the same
          // name and the rest stay. new-agent v3's wrong-test revises only
          // the tests named, and the whole suite goes on (r-20261101-991b
          // handed on the one revised file). A phase that runs again only
          // because it comes after the target hands on what it delivers.
          const before = p.redo && p.redo.key !== "after-publish" ? lastHandoffOf(s, h.key, e.phase) : null;
          const files = before ? revisedVersion(before.files ?? [], e.files ?? []) : e.files ?? [];
          if (before) p.record.handed = files;
          setHandoff(s, { key: h.key, from: [e.phase], round: s.round, files, text: String(e.text ?? ""), at, agent, held, ...(before ? { revised: true } : {}) });
        }
        // A delivery closes the phase whatever state it was in: a holder that
        // refused once and then delivered (2026-09-15) leaves no block and no
        // open question behind it.
        delete p.block;
        if (held) { p.status = "holding"; delete p.asked; }
        else { p.status = "closed"; p.closed_at = at; delete p.asked; }
      } else if (e.verdict === "block") {
        // A block with files is a conflict record (0.30.0): its files ride
        // to the owner with the question, and are never handed on.
        const withFiles = (e.files ?? []).filter((f) => f && !f.error);
        p.status = "blocked"; p.block = { text: String(e.text ?? ""), at, from: agent, reply_id: e.inbox_id ?? null, ...(withFiles.length ? { files: withFiles, conflict: true } : {}) };
        delete p.asked;
      } else if (e.verdict === "refused") {
        p.status = "refused"; p.block = { text: String(e.text ?? ""), at, from: agent, refused: true, reply_id: e.inbox_id ?? null };
        delete p.asked;
      } else if (e.verdict === "stopped") {
        s.notes.push({ at, text: `phase ${e.phase}: ${agent} confirmed the stop` });
      }
      break;
    }
    case "gated": {
      const p = ph(e.phase);
      if (p.mode === "gate" && p.status === "waiting") { p.status = "gated"; p.opened_at = p.opened_at ?? at; p.round = s.round; }
      else if (p.status === "waiting") { p.status = "asking-holder"; p.round = s.round; }
      p.asked = { at, question: e.question, files: e.files ?? [], message_id: e.message_id ?? null, ...(e.ref ? { ref: e.ref } : {}) };
      if (p.block) p.block.relayed_at = at;
      break;
    }
    case "approved": {
      const p = ph(e.phase);
      // Who answered (0.32.0): a person, or the test case a test run follows.
      s.approvals.push({ phase: e.phase, by: e.by, answered_by: e.answered_by ?? "person", at, text: e.text ?? "", files: e.files ?? [] });
      // The agent's own delivery, kept when a person approves it (0.25.0): an
      // approved-output phase that closes the run sends it as the deliverable.
      if (p.mode === "hold-output" && p.record && !p.record.person) p.drafted = p.record;
      p.record = { agent: e.by, person: true, answered_by: e.answered_by ?? "person", what: e.text ? String(e.text) : "approved", at, files: e.files ?? [] };
      const outs = doc ? outbound(doc, e.phase) : [];
      if (p.mode === "gate") {
        // The gate's outbound handoff is its inbound one as the person left it,
        // with who approved it and when (a changed file replaces the piece).
        const ins = doc ? inbound(doc, e.phase) : [];
        const inFiles = onceEach(ins.flatMap((h) => s.handoffs[h.key]?.files ?? []));
        const files = ownersVersion(inFiles, e.files);
        for (const h of outs) setHandoff(s, { key: h.key, from: [e.phase], round: s.round, files, text: e.text ?? "", at, agent: e.by, approved_by: e.by, approved_at: at });
      } else if (p.mode === "person-acts" && p.status === "asking-holder") {
        // The person did the phase: what they attached with the yes is the
        // phase's whole delivery, and the outbound handoffs are made of it.
        for (const h of outs) setHandoff(s, { key: h.key, from: [e.phase], round: s.round, files: e.files ?? [], text: e.text ?? "", at, agent: e.by, approved_by: e.by, approved_at: at, held: false });
      } else {
        for (const h of outs) if (s.handoffs[h.key]) Object.assign(s.handoffs[h.key], { held: false, approved_by: e.by, approved_at: at, ...(e.files?.length ? { files: ownersVersion(s.handoffs[h.key].files ?? [], e.files) } : {}) });
      }
      p.status = "closed"; p.closed_at = at; delete p.asked;
      break;
    }
    case "deviated": {
      const target = e.to;
      const reopen = [target, ...(doc ? successors(doc, target) : [])].filter((id) => s.phases[id]);
      s.round += 1;
      const reopened = [];
      for (const id of reopen) {
        const p = s.phases[id];
        if (p.status === "waiting" && p.round === 0) continue;
        p.history.push({ round: p.round, status: p.status, record: p.record ?? null, sent: p.sent, opened_at: p.opened_at ?? null, closed_at: p.closed_at ?? null, block: p.block ?? null, asked: p.asked ?? null, ...(p.inner ? { inner: p.inner } : {}), superseded_by: e.key, superseded_at: at });
        Object.assign(p, { status: "waiting", sent: [], round: 0 });
        // A deviation that returns to a phase that runs a process starts a new
        // inner run and never reopens the one before (0.34.0).
        delete p.inner;
        delete p.record; delete p.drafted; delete p.block; delete p.asked; delete p.opened_at; delete p.closed_at; delete p.past_bound; delete p.skipped;
        // The reopened target always carries the deviation (0.30.0), steps or
        // none: its work goes out saying why it runs again, in the owner's
        // words, with its own last delivery and the owner's files beside it.
        if (id === target) p.redo = { steps: e.steps ?? [], key: e.key, deviation_at: at, text: e.text ?? "", files: (e.files ?? []).filter((f) => f && !f.error) };
        else delete p.redo;
        reopened.push(id);
      }
      // Only the handoffs the reopened phases made, and a kept phase's put back (0.23.0).
      withdrawHandoffs(s, doc, reopened);
      s.deviations.push({ key: e.key, from: e.from, to: target, by: e.by, answered_by: e.answered_by ?? "person", at, text: e.text ?? "", steps: e.steps ?? [], reopened, round: s.round });
      break;
    }
    case "stopped": {
      s.status = "stopped";
      s.outcome = "abandoned";
      s.closed_at = at;
      s.stopped_by = e.by;
      s.stop_answered_by = e.answered_by ?? "person";
      s.stop_reason = e.reason ?? "";
      for (const [id, p] of Object.entries(s.phases)) {
        if (["working", "blocked"].includes(p.status) && p.holder) p.status = "stopping";
        else if (p.status !== "closed") { p.status = "cancelled"; p.closed_at = at; }
      }
      s.open = Object.entries(s.phases).filter(([, p]) => p.status !== "closed").map(([id]) => id);
      break;
    }
    // The same ending as a stop, so every holder still working is told the
    // work is no longer wanted, but the outcome is failed rather than
    // abandoned: nobody chose to end it. Published as stopped, a platform
    // reads it as failed.
    case "timed-out": {
      s.status = "stopped";
      s.outcome = "failed";
      s.closed_at = at;
      s.stopped_by = "the runner";
      s.failed = { phase: e.phase, since: e.since, limit_ms: e.limit_ms, holder: e.holder ?? null };
      s.stop_reason = `${e.phase} had its work out with ${e.holder ?? "its holder"} from ${e.since} and nothing came back within ${spanWords(e.limit_ms)}, so the run ended as failed`;
      for (const [, p] of Object.entries(s.phases)) {
        if (["working", "blocked"].includes(p.status) && p.holder) p.status = "stopping";
        else if (p.status !== "closed") { p.status = "cancelled"; p.closed_at = at; }
      }
      s.open = Object.entries(s.phases).filter(([, p]) => p.status !== "closed").map(([id]) => id);
      s.notes.push({ at, text: s.stop_reason });
      break;
    }
    // A phase a test run's test case keeps from running (0.32.0): it reaches
    // outside and the test case gives no stand-in for it. The same ending as
    // over-limit, failed with the reason; the holder is never sent anything.
    case "not-run-in-test": {
      s.status = "stopped";
      s.outcome = "failed";
      s.closed_at = at;
      s.stopped_by = "the runner";
      s.failed = { phase: e.phase, holder: e.holder ?? null, not_run_in_test: true, test_case: s.test_case ?? null };
      s.stop_reason = e.reason;
      for (const [, p] of Object.entries(s.phases)) {
        if (["working", "blocked"].includes(p.status) && p.holder) p.status = "stopping";
        else if (p.status !== "closed") { p.status = "cancelled"; p.closed_at = at; }
      }
      s.open = Object.entries(s.phases).filter(([, p]) => p.status !== "closed").map(([id]) => id);
      s.notes.push({ at, text: s.stop_reason });
      break;
    }
    // More than the holder declares it takes (0.14.0): the same ending as a
    // time-out, failed and with the reason, because nothing smaller would be
    // the same work. The holder is never sent a part of it.
    case "over-limit": {
      s.status = "stopped";
      s.outcome = "failed";
      s.closed_at = at;
      s.stopped_by = "the runner";
      s.failed = { phase: e.phase, holder: e.holder ?? null, over_limit: { input: e.input, size: e.size, limit: e.limit, files: e.files ?? [] } };
      s.stop_reason = `${e.phase} was not sent to ${e.holder ?? "its holder"}: ${e.why}. Nothing was cut; the run ended as failed`;
      for (const [, p] of Object.entries(s.phases)) {
        if (["working", "blocked"].includes(p.status) && p.holder) p.status = "stopping";
        else if (p.status !== "closed") { p.status = "cancelled"; p.closed_at = at; }
      }
      s.open = Object.entries(s.phases).filter(([, p]) => p.status !== "closed").map(([id]) => id);
      s.notes.push({ at, text: s.stop_reason });
      break;
    }
    // A phase that refused, which every phase waiting for it may go on
    // without (0.17.0, plan.mjs optionalEverywhere): closed as skipped. It
    // counts as done for a join, the handoffs it would have made are not
    // owed, and the phases after it go on with what the others delivered. The
    // refusal stays on the phase (block) so the account says what it wrote.
    case "skipped": {
      const p = ph(e.phase);
      p.status = "skipped";
      p.closed_at = at;
      p.skipped = { at, holder: e.holder ?? p.block?.from ?? null, text: String(e.text ?? p.block?.text ?? "") };
      delete p.asked;
      s.notes.push({ at, text: `phase ${e.phase} was skipped: ${p.skipped.holder ?? "its holder"} refused the work, and every phase after it may go on without it, so the run went on. It wrote: ${p.skipped.text}` });
      break;
    }
    // A phase that starts at the trigger refused what the run was started
    // with (0.17.0). The same ending as over-limit: failed, with the reason
    // and the holder's words whole. The refused phase keeps its status and
    // its block, so the page shows which step refused; every holder still
    // working is told to stop.
    case "trigger-refused": {
      s.status = "stopped";
      s.outcome = "failed";
      s.closed_at = at;
      s.stopped_by = "the runner";
      const words = String(e.text ?? "");
      s.failed = { phase: e.phase, holder: e.holder ?? null, refused: words };
      s.stop_reason = `${e.phase} could not use what the run was started with, so the run ended as failed. ${e.holder ?? "Its holder"} wrote: ${words}`;
      for (const [id, p] of Object.entries(s.phases)) {
        if (id === e.phase) { p.closed_at = p.closed_at ?? at; delete p.asked; continue; }
        if (["working", "blocked"].includes(p.status) && p.holder) p.status = "stopping";
        else if (!["closed", "skipped"].includes(p.status)) { p.status = "cancelled"; p.closed_at = at; }
      }
      s.open = Object.entries(s.phases).filter(([, p]) => !["closed", "skipped"].includes(p.status)).map(([id]) => id);
      s.notes.push({ at, text: s.stop_reason });
      break;
    }
    // A handoff that does not fit what its holder takes, with no saved mapping
    // and no answer from the converter the run could be sure of. The phase
    // waits on the owner, with the reason, rather than going out on a guess.
    case "gap": {
      const p = ph(e.phase);
      p.status = "needs-input";
      p.opened_at = p.opened_at ?? at;
      p.round = s.round;
      p.gap = { at, why: e.why, missing: e.missing ?? [], inputs: e.inputs ?? [], ...(e.confidential ? { confidential: true } : {}) };
      delete p.asked;
      s.notes.push({ at, text: `phase ${e.phase}: not sent; ${e.why}` });
      break;
    }
    case "converted": {
      const c = { n: (s.conversions ?? []).length + 1, at, phase: e.phase, from_phases: e.from_phases ?? [], inputs: e.inputs ?? [], via: e.via, fields: e.fields ?? {}, read_as: e.read_as ?? null, ...(e.stood_in_for ? { stood_in_for: e.stood_in_for } : {}), ...(e.through?.length ? { through: e.through } : {}) };
      s.conversions = [...(s.conversions ?? []), c];
      break;
    }
    // A piece that is not words goes through other agents first (0.15.0): the
    // converter planned it from the conversions the platform listed, and the
    // runner runs each step over the mesh as a sub-step of this phase. The
    // phase waits, shown as converting, until the last step delivers; the
    // phase's own work then goes with the input built from what it gave.
    case "conversion-started": {
      const p = ph(e.phase);
      p.status = "converting";
      p.opened_at = p.opened_at ?? at;
      p.round = s.round;
      p.converting = { started_at: at, round: s.round, plan: e.plan ?? {}, queue: e.queue ?? [], read_as: e.read_as ?? null, index: 0, step: 0, replaced: {}, steps: [], done: false, agent: null };
      delete p.gap; delete p.asked;
      break;
    }
    case "conversion-sent": {
      const c = ph(e.phase).converting;
      if (c) { c.agent = e.agent; c.offering = e.offering ?? null; c.sent_at = at; }
      break;
    }
    case "conversion-got": {
      const p = ph(e.phase);
      const c = p.converting;
      if (!c) break;
      const entry = c.queue[c.index];
      const via = entry?.via ?? [];
      c.steps.push({ at, input: entry?.input ?? null, agent: c.agent, offering: c.offering ?? null, got: e.got });
      // What it gave stands in for the piece from here on.
      if (entry) c.replaced[entry.source] = e.got;
      c.step += 1;
      if (c.step >= via.length) { c.index += 1; c.step = 0; }
      c.agent = null; delete c.sent_at;
      if (c.index >= c.queue.length) { c.done = true; p.status = "waiting"; }
      break;
    }
    case "conversion-failed": {
      const p = ph(e.phase);
      p.status = "needs-input";
      p.gap = { at, why: e.why, missing: e.missing ?? [], inputs: e.inputs ?? [], conversion: true };
      p.conversion_history = [...(p.conversion_history ?? []), { ...(p.converting ?? {}), failed_at: at, why: e.why }];
      delete p.converting; delete p.asked;
      s.notes.push({ at, text: `phase ${e.phase}: not sent; ${e.why}` });
      break;
    }
    case "gap-cleared": {
      const p = ph(e.phase);
      if (p.status === "needs-input") p.status = "waiting";
      if (e.word === "send anyway") p.gap_override = true;
      if (e.word === "convert anyway") p.convert_allowed = true;
      if (e.word === "pay for the conversion") p.conversion_paid_ok = true;
      p.gap_history = [...(p.gap_history ?? []), { ...(p.gap ?? {}), cleared_at: at, by: e.by, word: e.word }];
      delete p.gap; delete p.asked;
      s.notes.push({ at, text: `phase ${e.phase}: ${e.by} said "${e.word}"` });
      break;
    }
    // A run that failed or was stopped, taken up again at one phase (0.16.0,
    // resume.mjs says which phases run again and why). The run is open again,
    // in a new round; each phase that runs again keeps what it did before in
    // its history, as a deviation does, and loses its delivery, so it is sent
    // again with what the phases before it handed on, as they were kept. Every
    // phase not named here keeps its delivery and is not sent or paid again.
    case "resumed": {
      const reopen = (e.reopen ?? []).filter((id) => s.phases[id]);
      s.status = "open";
      s.round += 1;
      s.closed_at = null;
      s.outcome = null;
      s.result = null;
      s.open = [];
      delete s.stopped_by; delete s.stop_reason; delete s.failed; delete s.owner_untold;
      for (const id of reopen) {
        const p = s.phases[id];
        if (!(p.status === "waiting" && p.round === 0 && !(p.sent ?? []).length)) {
          p.history.push({ round: p.round, status: p.status, record: p.record ?? null, sent: p.sent, opened_at: p.opened_at ?? null, closed_at: p.closed_at ?? null, block: p.block ?? null, asked: p.asked ?? null, superseded_by: "resume", superseded_at: at });
        }
        Object.assign(p, { status: "waiting", sent: [], round: 0 });
        for (const k of ["record", "drafted", "block", "asked", "opened_at", "closed_at", "past_bound", "redo", "error", "gap", "converting", "again_files", "sends", "skipped"]) delete p[k];
        p.resumed = { at, by: e.by ?? null, phase: e.phase ?? null };
      }
      // Only the handoffs the reopened phases made, and a kept phase's put back (0.23.0).
      withdrawHandoffs(s, doc, reopen);
      s.resumes = [...(s.resumes ?? []), { at, by: e.by ?? null, for: e.for ?? s.owner, phase: e.phase ?? null, reopened: reopen, revisions: e.revisions ?? [], price: e.price ?? null, acct: e.acct ?? null, round: s.round }];
      s.notes.push({ at, text: `${e.by ?? "the owner"} resumed the run at ${e.phase}${e.for && e.for !== e.by ? ` for ${e.for}` : ""}; ${reopen.join(", ")} run${reopen.length === 1 ? "s" : ""} again${e.revisions?.length ? `, ${e.revisions.join(", ")} as a revision with its own price, which they said yes to` : ""}` });
      break;
    }
    case "revised-after-publish": {
      // 0.18.0: one phase of a closed run revises the lines the platform's
      // acceptance check named. Only that phase reopens; its delivery is kept
      // in its history and its outbound handoffs stand until the revision
      // replaces them, so nothing after it is asked again.
      const p = s.phases[e.phase];
      if (!p) break;
      s.status = "open";
      s.round += 1;
      s.closed_at = null;
      s.outcome = null;
      s.result = null;
      s.open = [];
      p.history.push({ round: p.round, status: p.status, record: p.record ?? null, sent: p.sent, opened_at: p.opened_at ?? null, closed_at: p.closed_at ?? null, block: p.block ?? null, asked: p.asked ?? null, superseded_by: "revise after publish", superseded_at: at });
      Object.assign(p, { status: "waiting", sent: [], round: 0 });
      for (const k of ["record", "drafted", "block", "asked", "opened_at", "closed_at", "past_bound", "error", "gap", "converting", "again_files", "sends", "skipped"]) delete p[k];
      p.redo = { steps: ["revise-lines"], key: "after-publish", deviation_at: at, findings: scrub(e.findings ?? "") };
      s.publish_revisions = [...(s.publish_revisions ?? []), { at, by: e.by ?? null, phase: e.phase, round: s.round }];
      const later = doc ? successors(doc, e.phase).filter((id) => s.phases[id]) : [];
      s.notes.push({ at, text: `The run closed and its publish was stopped by the platform's acceptance check on named lines. ${e.by ?? "The run's account"} asked ${e.phase} to revise only those lines, once.${later.length ? ` ${later.join(", ")} ${later.length === 1 ? "is" : "are"} not asked again: a person approved the delivery, and the platform's check asked for the named lines to change.` : ""}` });
      break;
    }
    // A phase that runs another process (0.34.0, inner.mjs). Its holder was
    // asked to start the inner run (the work message, a `sent` event before
    // this one); the phase records which document it asked for.
    case "inner-requested": {
      const p = ph(e.phase);
      p.inner = { process: e.process, cited: e.version, requested_at: at, round: s.round };
      break;
    }
    // The inner run started: the outer record names it and the version it
    // runs under, and says so when that is not the version the phase cites.
    case "inner-started": {
      const p = ph(e.phase);
      p.inner = { ...(p.inner ?? {}), run: e.run, version: e.version, cited: e.cited ?? p.inner?.cited ?? null, started_at: at };
      s.notes.push({ at, text: `phase ${e.phase}: inner run ${e.run} of ${e.process} ${e.version} started` });
      if (e.cited && e.version && e.cited !== e.version) s.notes.push({ at, text: `phase ${e.phase} cites ${e.process} ${e.cited}, and the inner run runs under ${e.version}, the version in force; what it produces may differ from what this document was written against` });
      break;
    }
    // How the inner run ended. The delivery (or the refusal) that follows is
    // what moves the phase; this records the outcome on the outer phase.
    case "inner-closed": {
      const p = ph(e.phase);
      p.inner = { ...(p.inner ?? {}), outcome: e.outcome ?? null, reached: Boolean(e.reached), closed_at: at };
      break;
    }
    // The runner refused the inner run (a document already in the chain, a
    // role nobody in the outer roster holds, a start it could not take): the
    // phase cannot complete, as a refused phase cannot.
    case "inner-refused": {
      const p = ph(e.phase);
      p.status = "refused";
      p.block = { text: String(e.text ?? ""), at, from: "the runner", refused: true, reply_id: null };
      p.opened_at = p.opened_at ?? at;
      p.round = p.round || s.round;
      p.inner = { ...(p.inner ?? {}), refused: String(e.text ?? ""), refused_at: at };
      delete p.asked;
      s.notes.push({ at, text: `phase ${e.phase}: ${e.text}` });
      break;
    }
    case "closed": {
      s.status = "closed";
      s.closed_at = at;
      s.outcome = e.outcome ?? "completed";
      s.result = e.result ?? null;
      s.open = e.open ?? [];
      break;
    }
    default:
      throw new Error(`unknown event type ${e.type}`);
  }
  return s;
}

/** The files a phase is handed: its inbound handoffs, and for a gate every
 *  handoff of this round its own sentence names. */
export function filesFor(state, doc, id) {
  const p = phaseOf(doc, id);
  const keys = new Set(inbound(doc, id).map((h) => h.key));
  if (modeOf(p) === "gate") for (const k of carried(doc, id)) keys.add(k);
  const out = [];
  for (const k of keys) {
    const h = state.handoffs[k];
    if (!h) continue;
    const described = doc.handoffs.find((x) => x.key === k)?.text ?? k;
    out.push({ key: k, text: described, said: h.text, files: h.files, approved_by: h.approved_by ?? null, approved_at: h.approved_at ?? null, agent: h.agent ?? null, round: h.round });
  }
  return out;
}

/**
 * What a phase's refusal comes to (0.17.0), or null when the phase has not
 * refused, the owner was already asked about it, or it refused for want of
 * accepted terms (that one is offered a retry, as before):
 *   "skip"  every phase that waits for it names it with ? (optionalEverywhere),
 *           so the run goes on past it
 *   "fail"  it starts at the trigger, so it refused what the run was started
 *           with and the run ends as failed
 *   "ask"   anything else: the owner is asked who holds it instead, as before
 */
export function refusalRule(state, doc, id, sp = state.phases[id]) {
  if (sp?.status !== "refused" || sp.asked) return null;
  if (termsRefusal(sp.block?.text)) return null;
  const p = phaseOf(doc, id);
  if (!p) return null;
  if (optionalEverywhere(doc, id)) return "skip";
  if (startsAtTrigger(p)) return "fail";
  return "ask";
}

/** What the Runner should do now. Each action names its kind and phase. */
export function nextActions(state, doc, rosterMap = null) {
  const actions = [];
  if (state.status === "stopped") {
    for (const [id, p] of Object.entries(state.phases)) if (p.status === "stopping") actions.push({ kind: "send-stop", phase: id, to: p.holder?.handle ?? null });
    return actions;
  }
  if (state.status !== "open") return actions;
  const closed = new Set(Object.entries(state.phases).filter(([, p]) => p.status === "closed").map(([id]) => id));
  const skipped = new Set(Object.entries(state.phases).filter(([, p]) => p.status === "skipped").map(([id]) => id));
  const entered = new Set(Object.entries(state.phases).filter(([, p]) => p.status !== "waiting" || p.round > 0).map(([id]) => id));
  const active = new Set(Object.entries(state.phases).filter(([, p]) => ACTIVE.has(p.status)).map(([id]) => id));
  const have = (key) => Boolean(state.handoffs[key]) && !state.handoffs[key].held;
  // A refusal is settled before anything else is planned (0.17.0): a phase
  // the run may go on without is skipped, and a phase that starts at the
  // trigger ends the run, so nothing is sent this round on a run that is
  // about to end. A refusal for want of accepted terms is neither: the holder
  // is right, and the owner is offered a retry (agreements.mjs).
  for (const [id, sp] of Object.entries(state.phases)) {
    const r = refusalRule(state, doc, id, sp);
    if (r === "fail") return [{ kind: "fail-refused", phase: id, text: sp.block?.text ?? "", from: sp.block?.from ?? sp.holder?.handle ?? null }];
  }
  const { ready } = readyPhases(doc, { closed, entered, have, active, skipped });
  for (const id of ready) {
    const p = phaseOf(doc, id);
    const sp = state.phases[id];
    const mode = modeOf(p);
    const handoffs = filesFor(state, doc, id);
    if (mode === "gate") { actions.push({ kind: "ask-gate", phase: id, handoffs }); continue; }
    const holder = sp.holder ?? holderFor(doc, rosterMap, id, state.owner);
    const isPersonPhase = /^(human|system)\b/.test(p.kind);
    if (isPersonPhase && (mode === "person-acts" || !holder)) { actions.push({ kind: "ask-act", phase: id, handoffs, mode }); continue; }
    if (!holder) { actions.push({ kind: "ask-holder", phase: id, offering: p.kind }); continue; }
    const prior = sp.history.findLast?.((h) => h.record && !h.record.person) ?? [...sp.history].reverse().find((h) => h.record && !h.record.person);
    if (sp.redo?.steps?.length && prior) actions.push({ kind: "send-revision", phase: id, to: holder.handle, holder, handoffs, steps: sp.redo.steps, prior, draft: mode === "person-acts" });
    else actions.push({ kind: "send-work", phase: id, to: holder.handle, holder, handoffs, draft: mode === "person-acts", mode });
  }
  for (const [id, sp] of Object.entries(state.phases)) {
    if (sp.asked) continue;
    const handoffs = filesFor(state, doc, id);
    if (sp.status === "holding") actions.push({ kind: sp.mode === "person-acts" ? "ask-act-on-draft" : "ask-approve", phase: id, handoffs: Object.values(state.handoffs).filter((h) => h.from.includes(id)).map((h) => ({ key: h.key, text: h.text, files: h.files })) });
    else if (sp.status === "blocked" && !sp.block?.relayed_at && !sp.block?.answered_at) actions.push({ kind: "answer-block", phase: id, question: sp.block.text, from: sp.block.from });
    else if (sp.status === "refused" && refusalRule(state, doc, id, sp) === "skip") actions.push({ kind: "skip-refused", phase: id, text: sp.block?.text ?? "", from: sp.block?.from ?? sp.holder?.handle ?? null });
    else if (sp.status === "refused") actions.push({ kind: "ask-refused", phase: id, text: sp.block?.text ?? "", from: sp.block?.from ?? null });
    else if (sp.status === "unreachable") actions.push({ kind: "ask-unreachable", phase: id, error: sp.error ?? "", to: sp.holder?.handle ?? null });
    else if (sp.status === "asking-holder") actions.push({ kind: "ask-holder", phase: id, offering: phaseOf(doc, id)?.kind ?? "" });
    else if (sp.status === "needs-input") actions.push({ kind: "ask-gap", phase: id, gap: sp.gap ?? null, to: sp.holder?.handle ?? null });
    // A conversion step that has not gone out yet (0.15.0).
    else if (sp.status === "converting" && sp.converting && !sp.converting.agent && !sp.converting.done) actions.push({ kind: "send-substep", phase: id });
  }
  // The run closes when every phase is done. A phase is done when it closed,
  // or when the run never entered it and no ready or running phase can still
  // lead to it: a phase marked ? in an after: value that this run had no
  // reason to enter counts as closed for a join (specification 6.5.2), and
  // must not hold the run open forever.
  const { succs } = graph(doc);
  const reachable = new Set();
  const walk = (x) => { for (const n of succs[x] ?? []) if (!reachable.has(n)) { reachable.add(n); walk(n); } };
  for (const id of [...ready, ...active]) walk(id);
  const neverEntered = Object.entries(state.phases).filter(([id, p]) => p.status !== "closed" && !entered.has(id) && !reachable.has(id)).map(([id]) => id);
  // A skipped phase is done (0.17.0).
  const allDone = Object.entries(state.phases).every(([id, p]) => p.status === "closed" || p.status === "skipped" || neverEntered.includes(id));
  if (allDone && !actions.length) actions.push(neverEntered.length ? { kind: "close", never_entered: neverEntered } : { kind: "close" });
  return actions;
}

// ── where a run is kept ─────────────────────────────────────────────────────
//
// On disk, under the runs folder, unless a turn opened a session on a store
// (store.mjs): then load, save and listRuns read and write the session, which
// holds the runs the platform handed this turn and writes them back, at the
// revision each was read at, when the turn ends. A run the session was not
// handed is still read from disk, which is where every run an earlier version
// kept is. The files a run carries (what crossed each handoff, the words of
// each message, the account) stay in the run's folder either way.

let session = null;

/** The session this process's turn keeps its runs in, or null for disk. */
export function useSession(s) { session = s ?? null; }

export function runDir(runsDir, runId) { return join(runsDir, runId); }

export function loadFromDisk(runsDir, runId) {
  const p = join(runDir(runsDir, runId), "state.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

export function load(runsDir, runId) {
  if (session) return session.get(runId);
  return loadFromDisk(runsDir, runId);
}

/** A run by its id wherever it is kept, including one that ended before the
 *  session's window (0.16.0: a resume may name an older run). */
export async function loadAnywhere(runsDir, runId) {
  if (session?.fetch) return session.fetch(runId);
  return loadFromDisk(runsDir, runId);
}

export function save(runsDir, state) {
  const dir = runDir(runsDir, state.run_id);
  // Durations for every run and step (0.30.0), kept on the state so the
  // published run carries them. A timeline that cannot be drawn never stops a save.
  try { state.timeline = timeline(state); } catch { /* the run is saved without it */ }
  if (session) { session.put(state); return dir; }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2) + "\n");
  writeFileSync(join(dir, "events.jsonl"), state.events.map((e) => JSON.stringify(e)).join("\n") + (state.events.length ? "\n" : ""));
  return dir;
}

/** The process document a run is running, as text; "" when there is none. */
export function documentOf(runsDir, runId) {
  if (session) { const d = session.documentOf(runId); if (d) return d; }
  try { return readFileSync(join(runDir(runsDir, runId), "document.txt"), "utf8"); } catch { return ""; }
}

export function listRunsOnDisk(runsDir) {
  if (!existsSync(runsDir)) return [];
  const out = [];
  for (const name of readdirSync(runsDir)) {
    let st = null;
    try { st = loadFromDisk(runsDir, name); } catch { st = null; }
    if (st) out.push(st);
  }
  return out.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
}

export function listRuns(runsDir) {
  if (session) return session.states();
  return listRunsOnDisk(runsDir);
}
