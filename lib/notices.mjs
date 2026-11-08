// Notices: a person is told when a gate starts waiting on them and when a
// build ends. Two kinds are built in, named in product-factory.json "notify":
//
//   { "kind": "webhook", "url_env": "SLACK_WEBHOOK_URL" }   posts the message as JSON to the address in that
//                                                            environment variable (a Slack or Teams incoming
//                                                            webhook reads its "text")
//   { "kind": "command", "command": ["node", "mail.mjs"] }  runs the command with the message as JSON on stdin
//
// A build started from a GitHub issue (intake.mjs) also gets a comment on its
// issue at the same moments.
//
// watch() listens to every save of a build (store.onSave) and sends the
// notices when its status changes; nothing in the runner knows about notices.
// A notice that fails is said in the build's log and never stops the build.

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

/** The message a notice carries, for a build whose status just changed; null when nobody needs telling. */
export function noticeOf(r, { link = null, waitingOn = null } = {}) {
  const base = { build: r.id, name: r.name, stage: r.at, link: link ?? null };
  if (WAITS.has(r.status)) {
    const first = actionsOf(r).find((a) => a.name !== "stop");
    const gate = r.status === "waiting" && first ? first.label : `${nameOf(r.at)} was refused`;
    const who = waitingOn ?? "you";
    return { ...base, event: "waiting", gate, waiting_on: who, state: r.status, text: `${r.name} (${r.id}) waits on ${who} at ${nameOf(r.at)}: ${gate}.${link ? ` ${link}` : ""}` };
  }
  if (ENDED.has(r.status)) {
    return { ...base, event: "ended", gate: null, waiting_on: null, state: r.status, text: `${r.name} (${r.id}) ended: ${summaryOf(r)}.${link ? ` ${link}` : ""}` };
  }
  return null;
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
  if (message.event === "waiting") return `Product Factory build \`${r.id}\` waits on ${message.waiting_on} at **${nameOf(r.at)}**: ${message.gate}.`;
  return `Product Factory build \`${r.id}\` ended (${r.status}): ${summaryOf(r)}.`;
}

/**
 * The notices for one Product Factory. linkOf(r): the address a notice points to (the issue when the
 * build came from one). person: who a gate waits on, the person running Product Factory (no accounts yet).
 */
export function createNotices({ config, env = process.env, store, person = null, linkOf = () => null, fetchImpl = fetch, now = () => new Date().toISOString() }) {
  const pending = new Set();
  const targets = config.notify ?? [];

  const logged = (id, said) => store.update(id, (b) => { b.log.push({ at: now(), said }); }).catch(() => {});

  async function tell(r) {
    const link = r.issue?.url ?? linkOf(r);
    const message = noticeOf(r, { link, waitingOn: person?.name ?? null });
    if (!message) return;
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
        if (was !== undefined && was !== r.status && (WAITS.has(r.status) || ENDED.has(r.status))) fire(structuredClone(r));
      });
    },
    /** Resolves when every notice sent so far has been sent or has failed. */
    idle: async () => { while (pending.size) await Promise.all([...pending]); },
  };
}
