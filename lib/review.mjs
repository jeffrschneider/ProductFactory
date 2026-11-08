// The gate's reviews: the code critic and the security reviewer read a build
// folder that came back on the pull request, once the fence, the static
// review and the suite have passed it.
//
// Ported from AgentMesh's hand-off gate (services/src/handoffs/gate-review.ts):
// what each reviewer is given, how its answer is read, and what passes. What
// did not come over is the waiting: there the reviewers were other agents on
// the mesh, asked by message and answered minutes later. Here each is the
// reference agent from your adlc checkout (agents/code-critic,
// agents/security-reviewer), run on this computer the way its runtime
// requirements say, as the spec writer and the test writer are, so its answer
// is there when its command ends.
//
// WHO IS ASKED. A reviewer is asked only when its stage is used in the
// build's lifecycle (Review for the code critic, Security review for the
// security reviewer) and its holder can run here: the lifecycle leaves its
// role with the reference agent, the agent is in the adlc checkout, and the
// model is set. One that cannot run is named in the check with why, and does
// not fail it.
//
// WHAT PASSES. The security reviewer says its verdict in its review's header
// (verdict: passed or refused, refused_for). The code critic gives no verdict
// by design: it hands back findings to answer, and its stage is done when
// none is open. So the gate passes it when its findings document says
// `open: 0` and its model's review was had, and quotes every open finding
// when it is not.

import { LOCK_FILE } from "./fence.mjs";

export const REVIEWERS = [
  { id: "critic", stage: "review", role: "code-critic", agent: "code-critic", script: "job.mjs", who: "the code critic" },
  { id: "security", stage: "security", role: "security-reviewer", agent: "security-reviewer", script: "review-package.mjs", who: "the security reviewer" },
];

/** The limit the security reviewer is told when product-factory.json sets none
 *  (review.spending_limit); the one AgentMesh's own reviews were sent under. */
export const SPENDING_LIMIT_DEFAULT = "10 USD per day";

// "the code critic" starts a sentence as "The code critic".
const cap = (s) => (s.startsWith("the ") ? `The ${s.slice(4)}` : s);
const whoOf = (id) => REVIEWERS.find((r) => r.id === id).who;
const clip = (s, n = 400) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// The hand-off's own scaffolding, which is the hand-off's and not the agent's:
// the house rules, the check it ships, the lock and the coding step's records.
const SCAFFOLD = (p) => p === "AGENTS.md" || p === "CLAUDE.md" || p === LOCK_FILE || p.startsWith(".adlc/") || p.startsWith("records/") || p.startsWith(".gate/");

/** The package the reviewers read: every judged file but the scaffolding, sorted by path. */
export function packageFiles(files) {
  return new Map([...files].filter(([p]) => !SCAFFOLD(p)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** A unified diff adding what the coding step may write (scripts/, and tests
 *  the issued lock does not pin), so the code critic reviews that and not the
 *  approved spec. */
export function changeDiff(issued, files) {
  const out = [];
  for (const [p, bytes] of packageFiles(files)) {
    if (p in issued.digests || !(p.startsWith("scripts/") || p.startsWith("test/"))) continue;
    const lines = Buffer.from(bytes).toString("utf8").split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    out.push(`diff --git a/${p} b/${p}`, "new file mode 100644", "--- /dev/null", `+++ b/${p}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`));
  }
  return out.length ? `${out.join("\n")}\n` : "";
}

/** The words each reviewer is sent. */
export function requestText(id, issued, sha, limit) {
  const what = `${issued.agent} ${issued.version}`;
  if (id === "critic") {
    return `Review the change: the scripts a coding agent wrote for ${what} on its hand-off pull request, at commit ${sha.slice(0, 12)}. The diff is the change; the agent's own files and the suite were approved before the code step and are attached as the package.\n`;
  }
  return `Review this package: ${what}, the scripts a coding agent wrote on its hand-off pull request at commit ${sha.slice(0, 12)}, with the agent's own files and its suite.\n\nspending limit: ${limit}\n`;
}

/** The open findings in the code critic's findings document, each { place, claim, consequence }. */
export function openFindings(doc) {
  const out = [];
  const findings = String(doc ?? "").replace(/\r/g, "").split(/^## /m).find((s) => s.startsWith("Findings")) ?? "";
  for (const b of findings.split(/^### /m).slice(1)) {
    const field = (k) => (new RegExp(`^-\\s*${k}:\\s*(.*)$`, "mi").exec(b)?.[1] ?? "").trim();
    if (!/^open\b/i.test(field("Answer") || "open")) continue;
    out.push({
      place: field("Place").replace(/`/g, ""),
      claim: field("Claim") || (/^F\d+\.\s*(.*)$/m.exec(b)?.[1] ?? "").trim(),
      consequence: field("Consequence"),
    });
  }
  return out;
}

/** What the code critic noted outside the change, which holds nothing up: [{ place, claim }]. */
export function outsideFindings(doc) {
  const part = String(doc ?? "").replace(/\r/g, "").split(/^## /m).find((s) => s.startsWith("Outside the change")) ?? "";
  return part.split("\n").filter((l) => /^-\s/.test(l)).map((l) => {
    const m = /^-\s*`([^`]+)`(?:\s*\(([^)]*)\))?:?\s*(.*)$/.exec(l.trim());
    return m ? { place: m[1], claim: m[3].trim() } : { place: "", claim: l.replace(/^-\s*/, "").trim() };
  }).filter((f) => f.claim);
}

/** The code critic's findings document, read: how many are open, and each open one. */
export function readFindings(doc) {
  const open = /^-\s*open:\s*(\d+)\s*$/m.exec(doc);
  const out = openFindings(doc).map(({ place, claim, consequence: why }) => clip(`${place ? `\`${place}\` ` : ""}${claim}${why ? ` ${why}` : ""}`));
  return { open: open ? Number(open[1]) : null, noModel: /the model's review could not be had/i.test(doc), open_findings: out };
}

/** The security reviewer's review header, read: its verdict and what refused it. */
export function readSecurityReview(doc) {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(doc)?.[1] ?? "";
  const str = (v) => { try { return String(JSON.parse(v)); } catch { return v.replace(/^["']|["']$/g, ""); } };
  const verdict = /^verdict:\s*(.+)$/m.exec(head);
  const refused = [];
  const at = head.split(/\r?\n/);
  const i = at.findIndex((l) => /^refused_for:\s*$/.test(l));
  if (i >= 0) for (let j = i + 1; j < at.length && /^\s+-\s/.test(at[j]); j++) refused.push(clip(str(at[j].replace(/^\s+-\s+/, "").trim())));
  const w = at.findIndex((l) => /^warnings:\s*$/.test(l));
  let warnings = 0;
  if (w >= 0) for (let j = w + 1; j < at.length && /^\s/.test(at[j]); j++) if (/^\s+-\s/.test(at[j])) warnings++;
  return { verdict: verdict ? str(verdict[1].trim()) : null, refused_for: refused, warnings };
}

const MAX_REASONS = 10;
const some = (reasons, who) => (reasons.length > MAX_REASONS ? [...reasons.slice(0, MAX_REASONS), `and ${reasons.length - MAX_REASONS} more in ${who}'s answer`] : reasons);

/** What a reviewer's document and words say: { passed, words, reasons }. */
export function judgeDoc(id, doc, said) {
  const who = whoOf(id);
  if (id === "security") {
    const r = readSecurityReview(doc);
    if (r.verdict === "passed") return { passed: true, words: `The security reviewer passed it${r.warnings ? `, with ${r.warnings} address warning${r.warnings === 1 ? "" : "s"}, which do not refuse it` : ""}.`, reasons: [] };
    if (r.verdict === "refused") return { passed: false, words: "The security reviewer refused it.", reasons: some(r.refused_for.length ? r.refused_for : [clip(said || "it gave no reason")], who) };
    return { passed: false, words: "The security reviewer answered without its review.", reasons: said ? [clip(said)] : [] };
  }
  const f = readFindings(doc);
  let open = f.open;
  if (open === null) {
    // No document: the reply's first line says the count.
    const m = /(\d+) findings?, (\d+) open/.exec(said);
    open = m ? Number(m[2]) : /: no findings/.test(said) ? 0 : null;
  }
  if (open === null) return { passed: false, words: "The code critic answered without its findings.", reasons: said ? [clip(said)] : [] };
  if (f.noModel) return { passed: false, words: "The code critic's review went without its model, so the code was not reviewed.", reasons: said ? [clip(said)] : [] };
  if (open === 0) return { passed: true, words: "The code critic reviewed the scripts and left nothing open.", reasons: [] };
  return { passed: false, words: `The code critic left ${open} finding${open === 1 ? "" : "s"} open.`, reasons: some(f.open_findings.length ? f.open_findings : [clip(said)], who) };
}

/** What one reviewer's run came to: its command's result read as a verdict. */
export function judgeRun(id, run) {
  if (!run.ok && !run.reply && !run.doc) return { passed: false, words: `${cap(whoOf(id))} could not review it.`, reasons: [clip(run.why || "it did not say why")] };
  return judgeDoc(id, run.doc ?? "", run.reply ?? "");
}

/**
 * The check's words once the reviews are in. tested: the suite's words.
 * asks: { critic?: verdict, security?: verdict }; skipped: [{ id, why }].
 * Returns { passed, title, summary, items }.
 */
export function finalVerdict({ tested, asks, skipped = [] }) {
  const ids = REVIEWERS.map((r) => r.id).filter((id) => asks[id]);
  const refused = ids.filter((id) => !asks[id].passed);
  const parts = [tested, "The build folder is within its fence and passed the static review."];
  const items = [];
  for (const id of ids) {
    const v = asks[id];
    if (v.passed) parts.push(v.words);
    else { parts.push([v.words, ...v.reasons.map((r) => `- ${r}`)].join("\n")); items.push(...v.reasons.map((r) => `${cap(whoOf(id))}: ${r}`)); }
  }
  for (const s of skipped) parts.push(`${cap(whoOf(s.id))} was not asked: ${s.why}`);
  if (!refused.length) {
    parts.push("It goes on to Package when you give your OK in the console.");
    return { passed: true, title: "Ready for your OK", summary: parts.join("\n\n"), items };
  }
  const title = refused.length === 2 ? "Both reviewers refused" : `${cap(whoOf(refused[0]))} refused`;
  parts.push("Fix what is quoted and push again; the gate runs again on the new commit.");
  return { passed: false, title, summary: parts.join("\n\n"), items };
}
