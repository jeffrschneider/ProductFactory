// run.reply: how the host reads a job's reply from the command it runs, and
// the rule the package maker holds it to. A drafted value outside the rule is
// the model's to get wrong and not the person's to decide, so it is corrected
// and said; and where the builder is not on the host to refuse it, this says
// what it would (technical debt 652: a draft's "text:counts" stopped a build
// at Package, and nothing goes back from Package to the spec).
//
// And json:<member> names a member the job's command prints: the host reads
// that member of the one JSON object printed, and an empty reply is a job it
// records as stopped and tells the sender was cut short (technical debt 657:
// "json:consonant-count-report.md", the report's file name, while the script
// printed {"code":0,"reply":"..."}). Every house script prints `reply`.
//
//   needs: node >= 22
//   import { RUN_REPLY_STDOUT, RUN_REPLY_MEMBER, PRINTED_MEMBER, runReplyOk, runReplyProblems, runReplyUnprinted, printedMembers, fitRunReply } from "./run-reply.mjs"

/** The two forms the package maker takes for run.reply: the command's whole
 *  output, or json:<member>, one member of the JSON object it prints. Named
 *  once in build.py (RUN_REPLY_STDOUT, RUN_REPLY_MEMBER); test/run-reply.test.mjs
 *  reads them there and holds these to them (technical debt 652). */
export const RUN_REPLY_STDOUT = "stdout";
export const RUN_REPLY_MEMBER = "json:";

/** The rule, as build.py's run_reply_ok has it. */
export const runReplyOk = (v) => v === RUN_REPLY_STDOUT || (typeof v === "string" && v.startsWith(RUN_REPLY_MEMBER) && v.length > RUN_REPLY_MEMBER.length);

/** A value as Python's repr writes it, which is how the package maker quotes it. */
const pyRepr = (v) => {
  if (typeof v === "string") return v.includes("'") && !v.includes('"') ? `"${v}"` : `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  if (v === null) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  return typeof v === "number" ? String(v) : JSON.stringify(v);
};

/** The member every house script prints: the words the sender reads. */
export const PRINTED_MEMBER = "reply";

/** A member name as a JSON object a script prints carries it. */
const PLAIN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The members a job's command prints: `reply`, and any plain name its own
 *  instructions put in backticks. A file name is never one: a file the job
 *  writes is a piece it files, not a member of what it prints. */
export function printedMembers(job) {
  const named = [...String(job?.instructions ?? "").matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim()).filter((w) => PLAIN.test(w));
  return [...new Set([PRINTED_MEMBER, ...named])];
}

const jobsOf = (spec) => (Array.isArray(spec?.jobs) ? spec.jobs : []);
const hasReply = (j) => !!j && typeof j.run === "object" && j.run !== null && !Array.isArray(j.run) && "reply" in j.run;

/** Why each job's run.reply would be refused at Package, in the package
 *  maker's own words and saying where it is set. Empty when every job's is
 *  absent or one the package maker takes. */
export function runReplyProblems(spec) {
  const out = [];
  for (const j of jobsOf(spec)) {
    if (!hasReply(j) || runReplyOk(j.run.reply)) continue;
    out.push(`job ${String(j.slug ?? "?").trim() || "?"}: run.reply is '${RUN_REPLY_STDOUT}' or '${RUN_REPLY_MEMBER}<member>'; bad: ${pyRepr(j.run.reply)}. `
      + "It is set in agent-runtime-requirements.json; the package maker refuses the package until it is one of those");
  }
  return out;
}

/** Each job whose run.reply is json:<member> for a member its command does
 *  not print, as a finding naming the job (technical debt 657). Empty when
 *  every job's is stdout, absent, outside the package maker's rule (that is
 *  runReplyProblems's to say) or a member the job prints. */
export function runReplyUnprinted(spec) {
  const out = [];
  for (const j of jobsOf(spec)) {
    if (!hasReply(j) || !runReplyOk(j.run.reply) || j.run.reply === RUN_REPLY_STDOUT) continue;
    const member = j.run.reply.slice(RUN_REPLY_MEMBER.length);
    if (printedMembers(j).includes(member)) continue;
    out.push(`job ${String(j.slug ?? "?").trim() || "?"}: run.reply is ${JSON.stringify(j.run.reply)}, and the job's command prints no member ${member}: `
      + `every house script prints one JSON object whose ${PRINTED_MEMBER} member is what the sender reads, and the job's instructions name no other. `
      + `The host would read no reply and tell the sender the work was cut short; write ${JSON.stringify(RUN_REPLY_MEMBER + PRINTED_MEMBER)}`);
  }
  return out;
}

/** A member name a wrong form still carries, as in "text:counts". */
const MEMBER = /^[A-Za-z][A-Za-z0-9_-]*:([A-Za-z_][A-Za-z0-9_.-]*)$/;

/** The draft with every run.reply one the package maker takes, and what was
 *  changed in a sentence for the person ("" when nothing was). A reply that
 *  names a member after the wrong word replies with that member; anything
 *  else outside the rule replies with what the command prints. How the host
 *  reads a reply is a host fact, not one of the person's questions, so it is
 *  set here rather than asked for, and said. */
export function fitRunReply(spec) {
  if (!runReplyProblems(spec).length && !runReplyUnprinted(spec).length) return { spec, note: "" };
  const notes = [];
  const printed = `${RUN_REPLY_MEMBER}${PRINTED_MEMBER}`;
  const jobs = jobsOf(spec).map((j) => {
    if (!hasReply(j)) return j;
    const was = j.run.reply;
    const slug = String(j.slug ?? "?").trim() || "?";
    if (runReplyOk(was)) {
      // In the package maker's form, but a member the command never prints
      // (technical debt 657).
      if (was === RUN_REPLY_STDOUT || printedMembers(j).includes(was.slice(RUN_REPLY_MEMBER.length))) return j;
      notes.push(`Job ${slug}: the draft's run.reply ${JSON.stringify(was)} names ${was.slice(RUN_REPLY_MEMBER.length)}, which the job's command does not print (a file the job writes is a piece it files, not a member of what it prints), and the host would read no reply and tell the sender the work was cut short. So it is written as ${JSON.stringify(printed)}: the reply is the member ${PRINTED_MEMBER} of the JSON object the command prints.`);
      return { ...j, run: { ...j.run, reply: printed } };
    }
    const m = typeof was === "string" ? MEMBER.exec(was.trim()) : null;
    // A member after the wrong word is kept only when the command prints it.
    const member = m && printedMembers(j).includes(m[1]) ? m[1] : m ? PRINTED_MEMBER : null;
    const fitted = member ? `${RUN_REPLY_MEMBER}${member}` : RUN_REPLY_STDOUT;
    const means = member ? `the reply is the member ${member} of the JSON object the command prints` : "the reply is what the command prints";
    notes.push(`Job ${slug}: the draft's run.reply ${JSON.stringify(was)} is not one the package maker takes ('${RUN_REPLY_STDOUT}' or '${RUN_REPLY_MEMBER}<member>'), so it is written as ${JSON.stringify(fitted)}: ${means}.`);
    return { ...j, run: { ...j.run, reply: fitted } };
  });
  return { spec: { ...spec, jobs }, note: notes.join(" ") };
}
