// Notices: a person is told when a gate starts waiting and when a build
// ends. Two kinds are built in, named in product-factory.json "notify":
//
//   { "kind": "webhook", "url_env": "SLACK_WEBHOOK_URL" }   posts the message as JSON to the address in that
//                                                            environment variable (a Slack or Teams incoming
//                                                            webhook reads its "text")
//   { "kind": "command", "command": ["node", "mail.mjs"] }  runs the command with the message as JSON on stdin
//
// A build started from a GitHub issue (intake.mjs) also gets a comment on its
// issue at the same moments.
//
// watch() listens to every save of a build (store.onSave); nothing in the
// runner knows about notices. When a build's status changes to waiting,
// refused, done or stopped, the notice waits until the runner has stopped
// moving the build, and goes out only if the build is still there. Each
// notice is sent once: its key (a gate's wait at a stage and round, or the
// build's end) is kept in build.json under "notices" before it is sent, so a
// repeated save, or Product Factory starting again, never sends it twice.
// A notice that fails is said in the build's log and never stops the build.
//
// waiting_on names the gate's approvers when the lifecycle names any (people
// and teams, through people.mjs), and otherwise "anyone".
//
// A person who may not answer Requirements may ask its approvers to approve a
// feature proposed in a chat (features.mjs, lifecycle API 0.4.3). Each ask is
// told once the same way (event "feature_approval"), keyed "ask:<its id>" in
// "notices", and the approvers find the same proposal, with its approve button,
// on the message it came on.

import { spawn } from "node:child_process";
import { resolveCommand, tail } from "./exec.mjs";
import { actionsOf, summaryOf } from "./view.mjs";
import { stageById } from "./standards.mjs";
import { connect } from "./pull-request.mjs";

const nameOf = (id) => stageById.get(id)?.name ?? id;
const ENDED = new Set(["done", "stopped"]);
const WAITS = new Set(["waiting", "refused"]);
const WEBHOOK_SECONDS = 10;
const COMMAND_SECONDS = 30;
/** Someone in no team and named nowhere: the gate rule then answers with who may, and nothing of anyone's own standing. */
const NOBODY = { name: "", email: "", role: "member", teams: [] };
const either = (list) => (list.length <= 1 ? list.join("") : `${list.slice(0, -1).join(", ")} or ${list[list.length - 1]}`);

/** Who may answer the gate a build waits at: its approvers in words, or "anyone". A refused stage anyone may run again. */
export function waitingOnOf(r, people) {
  if (r.status !== "waiting" || !people) return "anyone";
  const who = people.gate(NOBODY, r.at, r.lifecycle?.project ?? null).who;
  return who.length ? either(who) : "anyone";
}

/** The message a notice carries, for a build whose status just changed; null when nobody needs telling. */
export function noticeOf(r, { link = null, waitingOn = "anyone" } = {}) {
  const base = { build: r.id, name: r.name, stage: r.at, link: link ?? null };
  if (WAITS.has(r.status)) {
    const first = actionsOf(r).find((a) => a.name !== "stop");
    const gate = r.status === "waiting" && first ? first.label : `${nameOf(r.at)} was refused`;
    return { ...base, event: "waiting", gate, waiting_on: waitingOn, state: r.status, text: `${r.name} (${r.id}) waits at ${nameOf(r.at)}: ${gate}. Who may answer: ${waitingOn}.${link ? ` ${link}` : ""}` };
  }
  if (ENDED.has(r.status)) {
    return { ...base, event: "ended", gate: null, waiting_on: null, state: r.status, text: `${r.name} (${r.id}) ended: ${summaryOf(r)}.${link ? ` ${link}` : ""}` };
  }
  return null;
}

/** The notice for an ask to approve one feature: who asked, the feature, and who may approve it. */
export function askNoticeOf(r, e, { link = null } = {}) {
  const to = e.to?.length ? either(e.to) : "an approver";
  const p = (r.feature_log ?? []).find((x) => x.id === e.proposal);
  const what = p ? `: ${p.name}. ${p.does}` : ".";
  return {
    build: r.id, name: r.name, stage: "requirements", link: link ?? null, event: "feature_approval",
    gate: `Approve feature ${e.feature}`, feature: e.feature, proposal: e.proposal, waiting_on: to, state: r.status,
    text: `${e.by} asks ${to} to approve feature ${e.feature} of ${r.name} (${r.id})${what} It is on the message in the ${e.stage === "requirements" || !e.stage ? "Requirements" : nameOf(e.stage)} chat, with its Approve feature button.${link ? ` ${link}` : ""}`,
  };
}

/** The key a notice is sent once under: a gate's wait at a stage and round, or the build's end. */
export function noticeKey(r, message) {
  if (message.event === "ended") return `end:${r.status}`;
  const s = r.stages?.[r.at];
  return `wait:${r.at}:${s?.runs ?? 0}.${s?.rounds?.length ?? 0}:${message.gate}`;
}

/** Posts the message to the address in the environment variable. Resolves to { ok, why? }. */
export async function postWebhook(urlEnv, message, { env = process.env, fetchImpl = fetch } = {}) {
  const url = String(env[urlEnv] ?? "").trim();
  if (!url) return { ok: false, why: `${urlEnv} is not set` };
  if (!/^https?:\/\/\S+$/.test(url)) return { ok: false, why: `${urlEnv} is not a web address` };
  try {
    const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(message), signal: AbortSignal.timeout(WEBHOOK_SECONDS * 1000) });
    await res.text().catch(() => "");
    return res.ok ? { ok: true } : { ok: false, why: `the webhook in ${urlEnv} answered ${res.status}` };
  } catch {
    return { ok: false, why: `the webhook in ${urlEnv} did not answer` };
  }
}

/** Runs the command with the message as JSON on stdin. Resolves to { ok, why? }. */
export function runCommand(argv, message, { env = process.env, seconds = COMMAND_SECONDS } = {}) {
  return new Promise((done) => {
    if ("NODE_TEST_CONTEXT" in env) { env = { ...env }; delete env.NODE_TEST_CONTEXT; }
    const { file, args, shell } = resolveCommand(argv, env);
    let child;
    try {
      child = spawn(file, args, { env, shell, windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
    } catch (e) {
      return done({ ok: false, why: `${argv[0]} could not start: ${e.message}` });
    }
    let err = "";
    let gone = null;
    child.stderr.on("data", (c) => { if (err.length < 4096) err += c.toString("utf8"); });
    child.stdin.on("error", () => { /* it did not read its input; its exit says the rest */ });
    child.on("error", (e) => { gone = e.code === "ENOENT" ? `${argv[0]} was not found` : e.message; });
    const timer = setTimeout(() => { gone = `${argv[0]} took longer than ${seconds} seconds`; child.kill(); }, seconds * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (gone) return done({ ok: false, why: gone });
      done(code === 0 ? { ok: true } : { ok: false, why: `${argv[0]} exited ${code}${err.trim() ? `: ${tail(err, 200)}` : ""}` });
    });
    child.stdin.end(`${JSON.stringify(message)}\n`);
  });
}

/** The comment a build leaves on its issue. */
export function issueComment(r, message) {
  if (message.event === "waiting") return `Product Factory build \`${r.id}\` waits at **${nameOf(r.at)}**: ${message.gate}. Who may answer: ${message.waiting_on}.`;
  return `Product Factory build \`${r.id}\` ended (${r.status}): ${summaryOf(r)}.`;
}

/**
 * The notices for one Product Factory. linkOf(r): the address a notice points to (the issue when the
 * build came from one). people: people.mjs, for a gate's approvers. settled(id): resolves when the
 * runner has stopped moving the build (runner.idle).
 */
export function createNotices({ config, env = process.env, store, people = null, settled = async () => {}, linkOf = () => null, fetchImpl = fetch, now = () => new Date().toISOString() }) {
  const pending = new Set();
  const targets = config.notify ?? [];

  const logged = (id, said) => store.update(id, (b) => { b.log.push({ at: now(), said }); }).catch(() => {});

  async function tell(was) {
    // A run that ends and goes straight on to the runtime saves "done" on the way: only where the build stops is told.
    await settled(was.id);
    const r = store.read(was.id);
    if (!r || r.status !== was.status || r.at !== was.at) return;
    const link = r.issue?.url ?? linkOf(r);
    const message = noticeOf(r, { link, waitingOn: waitingOnOf(r, people) });
    if (!message) return;
    const key = noticeKey(r, message);
    const first = await store.update(r.id, (b) => {
      b.notices ??= [];
      if (b.notices.includes(key)) return false;
      b.notices.push(key);
      return true;
    });
    if (!first) return;
    const failed = [];
    for (const t of targets) {
      const got = t.kind === "webhook" ? await postWebhook(t.url_env, message, { env, fetchImpl }) : await runCommand(t.command, message, { env });
      if (!got.ok) failed.push(`The ${t.kind} notice was not sent: ${got.why}.`);
    }
    if (r.issue) {
      const c = connect({ ...config.repository, repo: r.issue.repo }, env, { fetchImpl });
      let why = c.problem ?? null;
      if (!why) {
        try {
          const res = await c.gh.call("POST", `/repos/${r.issue.repo}/issues/${r.issue.number}/comments`, { body: issueComment(r, message) });
          if (res.status !== 201) why = `GitHub answered ${res.status}`;
        } catch { why = "GitHub did not answer"; }
      }
      if (why) failed.push(`The comment on issue #${r.issue.number} was not posted: ${why}.`);
    }
    for (const f of failed) await logged(r.id, f);
  }

  /** Tells an ask to approve a feature, once: its key is kept before it is sent. */
  async function tellAsk(id, eventId) {
    const key = `ask:${eventId}`;
    const first = await store.update(id, (b) => {
      b.notices ??= [];
      if (b.notices.includes(key)) return false;
      b.notices.push(key);
      return true;
    });
    if (!first) return;
    const r = store.read(id);
    const e = (r?.feature_log ?? []).find((x) => x.id === eventId);
    if (!e) return;
    const message = askNoticeOf(r, e, { link: r.issue?.url ?? linkOf(r) });
    for (const t of targets) {
      const got = t.kind === "webhook" ? await postWebhook(t.url_env, message, { env, fetchImpl }) : await runCommand(t.command, message, { env });
      if (!got.ok) await logged(id, `The ${t.kind} notice asking for feature ${e.feature} to be approved was not sent: ${got.why}.`);
    }
  }
  const asking = new Set();
  function fireAsks(r) {
    for (const e of r.feature_log ?? []) {
      if (e.kind !== "asked" || (r.notices ?? []).includes(`ask:${e.id}`) || asking.has(e.id)) continue;
      asking.add(e.id);
      const job = tellAsk(r.id, e.id).catch((x) => logged(r.id, `A notice went wrong in Product Factory: ${x.message}`)).finally(() => { pending.delete(job); asking.delete(e.id); });
      pending.add(job);
    }
  }

  function fire(r) {
    const job = tell(r).catch((e) => logged(r.id, `A notice went wrong in Product Factory: ${e.message}`)).finally(() => pending.delete(job));
    pending.add(job);
  }

  return {
    /** Watches every save of a build (store.onSave), and sends the notices when its status changes. Returns how to stop. */
    watch() {
      const seen = new Map(store.list().map((r) => [r.id, r.status]));
      return store.onSave((r) => {
        const was = seen.get(r.id);
        seen.set(r.id, r.status);
        if (was !== undefined && was !== r.status && (WAITS.has(r.status) || ENDED.has(r.status))) fire({ id: r.id, status: r.status, at: r.at });
        fireAsks(r);
      });
    },
    /** Resolves when every notice sent so far has been sent or has failed. */
    idle: async () => { while (pending.size) await Promise.all([...pending]); },
  };
}
