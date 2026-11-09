// Analyze a change to an agent: one command, five steps, no model.
//   needs: node >= 22
//   node analyze.mjs --job <job folder> --records <records folder>
//        --work <work folder> --text-file <message> [--file <path>[::<media type>]]...
//
// This is the command the runtime requirements start (run.agent-change). The
// steps, in order:
//   read-the-change          read-change.mjs: the attached files, sorted
//   compare-the-declarations compare.mjs: every difference, with its effect
//   answer-each-dependent    answer.mjs: each dependent, answered
//   file-what-is-owed        ledger.mjs: a dependency debt per breaking or
//                            change-of-behavior answer, filed once
//   write-the-report         report.mjs and pieces.mjs: the report, the
//                            pieces list and the reply
//
// It changes nothing it reports on and approves nothing. Asked to approve or
// to go ahead, it says no, and still reports when it was given what it needs.
// It reaches one thing outside its folder, the ledger, and only when the host
// binds it (LEDGER_TOKEN and MESH_API_BASE).
//
// It prints one JSON object with a `reply` field. Exit codes: 0 reported; 2
// usage; 3 the job stops and the reply says what is needed; 1 failed.
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { asksForApproval, fromText, pairDescriptors, pairRuntimes, readChange } from "./read-change.mjs";
import { compareDeclarations, compareRuntimes, contractChanged, unseenChange } from "./compare.mjs";
import { answerAll, VERDICT_WORDS } from "./answer.mjs";
import { fileOwed, owedItems } from "./ledger.mjs";
import { writeReport } from "./report.mjs";
import { fill, plan as piecesPlan } from "./pieces.mjs";
import { note, read as wentWithout, sentence } from "./went-without.mjs";

const trim = (s) => String(s ?? "").trim();

export function fromArgv(args = []) {
  const parsed = { files: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--job") parsed.job = args[++i];
    else if (a === "--records") parsed.records = args[++i];
    else if (a === "--work") parsed.work = args[++i];
    else if (a === "--text-file") parsed.textFile = args[++i];
    else if (a === "--file") {
      const v = String(args[++i] ?? "");
      const at = v.lastIndexOf("::");
      parsed.files.push(at === -1 ? { path: v, declared: "" } : { path: v.slice(0, at), declared: v.slice(at + 2) });
    }
  }
  return parsed;
}

export const DECLINE = "I do not approve changes or say whether to go ahead. The person who asked for the change decides, from the report.";

export const HOW_TO_ASK = "Attach the agent's declaration as it runs today and as it would be after the change (two agent-descriptor-v1 files, application/vnd.agentmesh.agent-descriptor+json), and the platform's list of what depends on it (the dependents_list answer, application/vnd.agentmesh.dependents+json). To have each dependent solution's lines read, attach each one as the platform answers GET /v1/solutions/:id (application/vnd.agentmesh.solution+json). To have an agent that may take what it hands back answered, attach its ports (application/vnd.agentmesh.agent-ports+json). For the price and the limits, attach the runtime requirements before and after (application/vnd.agentmesh.agent-runtime-requirements+json).";

/** What the job is missing, in words, or "". */
export function whatIsMissing(got) {
  const parts = [];
  if (got.descriptors.length < 2) parts.push(got.descriptors.length ? "only one agent declaration came, and I need the one that runs today and the one after the change" : "no agent declaration came, and I need the one that runs today and the one after the change");
  if (got.descriptors.length > 2) parts.push(`${got.descriptors.length} agent declarations came (${got.descriptors.map((f) => f.name).join(", ")}), and I compare exactly two: the one that runs today and the one after the change`);
  if (!got.dependents.length) parts.push("no list of what depends on the agent came, so I could not name a single dependent");
  if (got.dependents.length > 1) parts.push(`${got.dependents.length} dependents lists came, and I read one`);
  if (got.dependents.length && !String(got.dependents[0].doc?.subject?.id ?? "").trim()) parts.push("the list of what depends on the agent does not say which agent it is about (its subject has no id), so no canvas could be read against it");
  return parts.length ? `I cannot report on this change yet: ${parts.join("; ")}. ${HOW_TO_ASK}` : "";
}

/** The analysis, given what was read. Pure apart from the ledger call, which
 *  is handed in. */
export async function analyze({ got, said = "", ledger = {} }) {
  const pair = pairDescriptors(got.descriptors);
  const before = pair.running.doc;
  const after = pair.changed.doc;
  const dependents = got.dependents[0].doc;
  const key = trim(dependents?.subject?.id);
  const subject = trim(dependents?.subject?.name) || key || "the agent";
  const rt = pairRuntimes(got.runtimes, pair.running, pair.changed);
  const diffs = compareDeclarations(before, after);
  if (rt.running && rt.changed) diffs.push(...compareRuntimes(rt.running.doc, rt.changed.doc));
  diffs.push(...unseenChange({ before, after, said, contractChanged: contractChanged(diffs) }));
  const { answered, notes } = answerAll({ diffs, dependents, solutions: got.solutions, ports: got.ports, key, before, after });
  const owed = owedItems({ answered, subject, before, after });
  const report = writeReport({ subject, before, after, dependents, diffs, answered, notes: [...got.notes, ...notes], owed, runtime: { before: rt.running?.doc, after: rt.changed?.doc, how: rt.how }, said, pairing: pair.how });
  const filed = await fileOwed(owed, ledger);
  return { subject, key, before, after, pair, rt, diffs, answered, notes, owed, filed, report };
}

const many = (n, w, ws = `${w}s`) => `${n} ${n === 1 ? w : ws}`;

/** The reply, in words. */
export function replyText({ result, asked, went }) {
  const { subject, before, after, answered, owed, filed, report } = result;
  const L = [];
  if (asked) L.push(DECLINE);
  const c = report.counts;
  L.push(`I compared ${subject} ${trim(before.agent_version)} with ${trim(after.agent_version)} against ${many(answered.length, "dependent")}: ${c.breaking} breaking, ${c.behaviour} change of behavior, ${c.compatible} compatible. The impact report is filed with the job.`);
  if (went) L.push(went);
  const top = answered.slice(0, 12).map((a) => `${a.display} (${a.kind}): ${VERDICT_WORDS[a.verdict]}`);
  if (top.length) L.push(`${top.join("; ")}${answered.length > 12 ? `; and ${answered.length - 12} more in the report` : ""}.`);
  if (owed.length) {
    const byState = { filed: [], "already filed": [], "not filed": [] };
    filed.forEach((f, i) => byState[f.state].push({ ...f, owed: owed[i] }));
    if (byState.filed.length) L.push(`I filed ${many(byState.filed.length, "dependency debt item")} in the ledger: ${byState.filed.map((f) => `#${f.number} owed to ${f.owed.owed_to}`).join(", ")}.`);
    if (byState["already filed"].length) L.push(`${many(byState["already filed"].length, "item was", "items were")} already in the ledger for this same change, so nothing was filed twice: ${byState["already filed"].map((f) => `#${f.number}`).join(", ")}.`);
    if (byState["not filed"].length) L.push(`${many(byState["not filed"].length, "item")} owed ${byState["not filed"].length === 1 ? "is" : "are"} not filed, because ${[...new Set(byState["not filed"].map((f) => f.why))].join("; ")}. The report lists ${byState["not filed"].length === 1 ? "it" : "them"} under What is owed.`);
  }
  if (!asked) L.push("The report approves nothing; the person who asked for the change decides from it.");
  return L.join(" ");
}

/** The job, as the runtime requirements start it. */
export async function runJob(argv = [], env = process.env, { fetchImpl } = {}) {
  const args = fromArgv(argv);
  if (!args.job || !args.records) return { ok: false, code: 2, reply: "This job needs --job <job folder> and --records <records folder>." };
  const text = args.textFile && existsSync(args.textFile) ? readFileSync(args.textFile, "utf8") : "";
  const asked = asksForApproval(text);
  const id = basename(args.job);
  const RECORDS = join(args.records, id);
  mkdirSync(RECORDS, { recursive: true });
  rmSync(join(RECORDS, "went-without.json"), { force: true });
  const got = readChange(args.files);
  const missing = whatIsMissing(got);
  if (missing) return { ok: false, code: 3, reply: asked ? `${DECLINE} ${missing}` : missing, declined: asked };

  for (const u of got.unread) note(RECORDS, { wanted: u.name, did: "reported from the files it could read", why: u.why });
  const { said } = fromText(text);
  const result = await analyze({
    got, said,
    ledger: { base: env.MESH_API_BASE, token: env.LEDGER_TOKEN, ...(fetchImpl ? { fetchImpl } : {}) },
  });
  if (!(result.rt.running && result.rt.changed)) note(RECORDS, { wanted: "the runtime requirements before and after", did: "compared the declarations alone and said nothing about the price or the job limit", why: result.rt.how || "" });
  if (!got.solutions.length && result.answered.some((a) => a.kind === "solution")) note(RECORDS, { wanted: "the canvases of the dependent solutions", did: "answered each solution from what the platform's list says it uses, which does not say what it reads" });
  const notFiled = result.filed.filter((f) => f.state === "not filed");
  if (notFiled.length) note(RECORDS, { wanted: "a ledger that would take the items owed", did: "listed what is owed in the report without filing it", why: notFiled[0].why });

  const listed = fill(args.job, piecesPlan({ report: result.report.text })).map((e) => e.name);
  writeFileSync(join(RECORDS, "filed.json"), `${JSON.stringify({ filed: "v1", items: result.owed.map((o, i) => ({ owed_to: o.owed_to, against: o.against, caused_by: o.caused_by, blocks: o.blocks, dependent: o.dependent, ...result.filed[i] })) }, null, 2)}\n`);
  const went = sentence(wentWithout(RECORDS));
  return {
    ok: true, code: 0,
    reply: replyText({ result, asked, went }),
    declined: asked,
    subject: result.subject,
    running: trim(result.before.agent_version),
    changed: trim(result.after.agent_version),
    verdict: result.report.verdict,
    counts: result.report.counts,
    dependents: result.answered.map((a) => ({ kind: a.kind, id: a.id, name: a.name, verdict: a.verdict })),
    filed: result.filed,
    went_without: wentWithout(RECORDS),
    listed,
  };
}

const startedAsCommand = () => {
  try { return Boolean(process.argv[1]) && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
};

if (startedAsCommand()) {
  const out = await runJob(process.argv.slice(2)).catch((e) => ({
    ok: false, code: 1, reply: `No impact report was written, and this is what stopped it: ${trim(e?.message ?? e)}`,
  }));
  console.log(JSON.stringify(out, null, 2));
  process.exitCode = out.code ?? 0;
}
