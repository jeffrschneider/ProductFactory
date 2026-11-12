// The answers a build has already settled.
//
// A request can come from somebody who already holds an answer the architect
// would otherwise ask: a build with defaults it settles for every agent it
// makes, the platform's own spending rules, the account's limits. Asking the
// person again is a question nobody needed, and an answer that contradicts
// the build is one the next stage cannot use (technical debt 641: Build an
// agent settles that a person's agent reaches a model only through
// AgentMesh's model door, and the record bound text-reasoning to the House
// Stack, which the Design would then have declared).
//
// So each settled answer is used, as a decision that says where it came
// from, and the question it answers is not asked. Where the architect, or the
// model inside it, would have chosen otherwise, that is said in the
// decision's "weighed", as a note and never as a binding or a question. It
// still asks what nobody else can answer.
//
// The answers travel as exact typed data the scripts read:
//
//   {"settled_answers": "v1", "by": "AgentMesh Build an agent",
//    "answers": [{"key": "...", "answer": "...", "from": "...", "why": "..."}]}
//
// The keys this record has a place for:
//
//   kind          one of the four kinds of agent
//   reaches       nothing-outside-agentmesh: no system outside AgentMesh and
//                 no destination beyond the derived set
//   model         model-door: a model only through AgentMesh's model door, so
//                 no model system is named or bound
//   limit-cost    the spending limit, in words, from whoever holds it
//   attended      no: nobody attends a job, so nobody reviews in between
//   environments  the environments it runs in, a list
//
// Any other key is kept in the records and changes nothing.
//
//   needs: node >= 22. Pure: nothing here reads a file or the network.
import { MODEL_SYSTEMS } from "./no-provider.mjs";

const trim = (s) => String(s ?? "").trim();
const noStop = (s) => trim(s).replace(/[.\s]+$/, "");

export const SETTLED_FORMAT = "v1";
export const SETTLED_KIND = "application/vnd.agentmesh.settled-answers+json";
export const KEYS = ["kind", "reaches", "model", "limit-cost", "attended", "environments"];
const KIND_WORDS = ["plugin-on-harness", "mesh-coded", "third-party-framework", "bare-harness"];
const ENVIRONMENTS = ["dev", "test", "staging", "production"];

/** Whether a parsed JSON document is a build's settled answers. */
export const isSettled = (doc) => Boolean(doc && typeof doc === "object" && !Array.isArray(doc) && doc.settled_answers && Array.isArray(doc.answers));

/** The settled answers, read: who settled them and each answer with where it
 *  came from, the keys this record has a place for first. Null when the
 *  document is not settled answers. */
export function settledOf(doc) {
  if (!isSettled(doc)) return null;
  const answers = [];
  const unread = [];
  for (const a of doc.answers) {
    const key = trim(a?.key).toLowerCase();
    if (!key || (a.answer === undefined || a.answer === null || (typeof a.answer === "string" && !trim(a.answer)))) continue;
    if (answers.some((x) => x.key === key) || unread.includes(key)) continue;
    if (!KEYS.includes(key)) { unread.push(key); continue; }
    answers.push({ key, answer: Array.isArray(a.answer) ? a.answer.map(trim).filter(Boolean) : trim(a.answer), from: trim(a.from) || "the build", why: trim(a.why) });
  }
  return { by: trim(doc.by) || "the build", answers, unread };
}

/** One settled answer by its key, or null. */
export const answerOf = (settled, key) => settled?.answers?.find((a) => a.key === key) ?? null;

/** The part of the model's request that says what the build settled. */
export function settledPart(settled) {
  if (!settled?.answers?.length) return "";
  const line = (a) => `- ${a.key}: ${Array.isArray(a.answer) ? a.answer.join(", ") : a.answer} (from ${a.from})${a.why ? `. ${noStop(a.why)}` : ""}`;
  const model = answerOf(settled, "model")?.answer === "model-door"
    ? "\nThe model is settled: the agent reaches a model only through AgentMesh's model door, so name no model system (no text-reasoning, image-reading, speech-to-text or text-to-speech)."
    : "";
  const reaches = answerOf(settled, "reaches")?.answer === "nothing-outside-agentmesh"
    ? "\nWhat it reaches is settled: nothing outside AgentMesh, so name no other system and no egress destination."
    : "";
  return `--- WHAT THE BUILD HAS ALREADY SETTLED ---\n${settled.by} settled these for every agent it builds:\n${settled.answers.map(line).join("\n")}\n`
    + "Take each as given: do not ask about any of them, and never contradict one. Where you would have chosen otherwise, keep their answer and say what you would have chosen in a decision's \"weighed\"."
    + model + reaches;
}

const andList = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** A question about a person looking at the result in between, which nobody
 *  attending answers. */
export const ABOUT_ATTENDING = /\b(?:review|reviews|reviewed|approve|approves|approval|confirm|confirms|sign[- ]?off|attend|attends|in the loop|before it (?:goes|is sent))\b/i;

/** Apply the settled answers to the architecture after the model's answer
 *  has been repaired and its systems checked against the statement. Returns
 *  the architecture, the questions still open, and what was used and where it
 *  differs from what the architect would have chosen. */
export function applySettled(arch, questions = [], settled = null) {
  if (!settled?.answers?.length) return { arch, questions, settled: settled ? { by: settled.by, used: [], differs: [], unread: settled.unread ?? [] } : null };
  const a = JSON.parse(JSON.stringify(arch ?? {}));
  a.systems = Array.isArray(a.systems) ? a.systems : [];
  a.egress = Array.isArray(a.egress) ? a.egress : [];
  a.decisions = Array.isArray(a.decisions) ? a.decisions : [];
  a.limits = a.limits && typeof a.limits === "object" ? a.limits : {};
  let open = [...questions];
  const used = [];
  const differs = [];
  const by = settled.by;
  const because = (s) => `${by} settled it (${s.from})${s.why ? `: ${noStop(s.why)}` : ""}`;
  const drop = (pred) => { open = open.filter((q) => !pred(q)); };

  const kind = answerOf(settled, "kind");
  if (kind && KIND_WORDS.includes(kind.answer)) {
    const was = trim(a.kind?.kind);
    if (was && was !== kind.answer) differs.push(`the kind ${was}, which I would have chosen, where ${by} settles ${kind.answer}`);
    a.kind = { kind: kind.answer, why: because(kind) };
    used.push("kind");
  }

  const envs = answerOf(settled, "environments");
  if (envs && Array.isArray(envs.answer) && envs.answer.length && envs.answer.every((e) => ENVIRONMENTS.includes(e))) {
    a.environments = envs.answer;
    used.push("environments");
  }

  const reaches = answerOf(settled, "reaches");
  const model = answerOf(settled, "model");
  const modelDoor = model?.answer === "model-door";
  const nothingOutside = reaches?.answer === "nothing-outside-agentmesh";

  if (nothingOutside) {
    // The model systems are the model answer's: without one, the House
    // Stack's model is AgentMesh's own and stays.
    const gone = a.systems.filter((s) => !MODEL_SYSTEMS.includes(s.name));
    const dests = a.egress.map((d) => trim(d?.destination)).filter(Boolean);
    a.systems = a.systems.filter((s) => !gone.includes(s));
    a.egress = [];
    drop((q) => /^(?:system-|egress-|binding-)/.test(q.key) && !MODEL_SYSTEMS.some((m) => q.key === `system-${m}` || q.key.startsWith(`binding-${m}-`)));
    const would = [...gone.map((s) => `reaching ${s.name}`), ...dests.map((d) => `reaching ${d}`)];
    for (const w of would) differs.push(`${w}, which I would have asked about`);
    a.decisions.push({ kind: "ruling",
      decided: "The agent reaches nothing outside AgentMesh",
      why: because(reaches),
      weighed: would.length ? `${andList(would).replace(/^reaching/, "Reaching")}, which I would have asked about: the build's settled answer stands, so this is a note and not a question` : "",
      follows: "No system outside AgentMesh is bound, and no destination beyond the derived set is asked for",
    });
    used.push("reaches");
  }

  if (modelDoor) {
    const gone = a.systems.filter((s) => MODEL_SYSTEMS.includes(s.name));
    a.systems = a.systems.filter((s) => !gone.includes(s));
    drop((q) => MODEL_SYSTEMS.some((m) => q.key === `system-${m}` || q.key.startsWith(`binding-${m}-`)));
    const would = gone.map((s) => `${s.name}${trim(s.capability) ? ` (for ${noStop(s.capability)})` : ""}`);
    for (const w of would) differs.push(`naming and binding ${w}, which I would have chosen for this job`);
    a.decisions.push({ kind: "ruling",
      decided: "Reach a model only through AgentMesh's model door, and name no model system",
      why: because(model),
      weighed: would.length ? `Naming and binding ${andList(would)}, which I would have chosen for this job: the build's settled answer stands, so this is a note and not a binding` : "",
      follows: "The record binds no model, so the Design declares no model system, and a job that needs a model asks the model door the build names",
    });
    used.push("model");
  }

  const cost = answerOf(settled, "limit-cost");
  if (cost && typeof cost.answer === "string") {
    // The settled limit is the cost driver and the header's cost_limit, with
    // where it came from. It is not a decision: a limit is what the
    // decisions answer (the architecture standard, section 16).
    a.limits.cost = { limit: cost.answer, why: `Settled by ${by}, from ${cost.from}` };
    a.decisions = a.decisions.filter((d) => !/^Limit what the agent spends to /.test(trim(d?.decided)));
    drop((q) => q.key === "limit-cost");
    used.push("limit-cost");
  }

  const attended = answerOf(settled, "attended");
  if (attended && /^no\b/i.test(String(attended.answer))) {
    const answered = open.filter((q) => !/^(?:limit-cost|egress-\d+|reason-\d+|binding-|system-|standing-assets)/.test(q.key) && ABOUT_ATTENDING.test(`${q.key} ${q.question}`));
    drop((q) => answered.includes(q));
    for (const q of answered) differs.push(`asking "${trim(q.question)}", which nobody attending answers`);
    a.decisions.push({ kind: "ruling",
      decided: "Nobody attends a job: the agent answers whoever asked, with no person reviewing in between",
      why: because(attended),
      weighed: answered.length ? `${andList(answered.map((q) => `Asking "${trim(q.question)}"`))}, which the build's settled answer answers` : "",
      follows: "The agent does not stop to ask during a job",
    });
    used.push("attended");
  }

  return { arch: a, questions: open, settled: { by, used, differs, unread: settled.unread ?? [] } };
}
