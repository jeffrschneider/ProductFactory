// Name the systems: the one step here that wakes a model.
//
// The judgment is reading a statement of the job and saying what the agent
// stands on: which systems it reaches and why, the capability each model
// system needs, the agent's kind, what it depends on, its limits, what it
// must reach beyond the derived set, what passes in and out and in what
// format, and each of those as a decision with its reason. Binding is not
// part of it: products are bound in code, from the stacks, in the next step.
//
// The answer is checked against the architecture standard before anything
// else sees it (standard.mjs), and where the check finds something the same
// request goes once more with the findings appended. Never a third time. Then
// code puts right what must never reach a record whatever the model said (a
// model's name, an address, a credential) and takes back out every commitment
// the answer filled in (a spending limit, a destination beyond the derived
// set, a system the statement never called for), each as a question.
//
// The model is reached through the shared model caller (model-caller.mjs),
// from the four settings the install places, read on every call, and the
// request asks for JSON. MODEL_PROTOCOL must be one this package's
// text-reasoning system declares in agent-runtime-requirements.json.
//
//   needs: node >= 22; MODEL_NAME, MODEL_ENDPOINT, MODEL_PROTOCOL, and MODEL_KEY
//   where the endpoint asks for one, for the text-reasoning system
//   ASKED=<asked.json> RECORDS=<records folder> [ANSWERS_FROM=<answer files, for a replay>] node name.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { callerFor, cannotCall, replayCaller } from "./model-caller.mjs";
import { carriedFrom, findingsOf, repaired, yesOrNo, KINDS } from "./standard.mjs";
import { parseRecord } from "./architecture-record.mjs";
import { applySettled, settledPart } from "./settled.mjs";
import { specOfferings } from "./views.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const trim = (s) => String(s ?? "").trim();
const norm = (s) => trim(s).toLowerCase().replace(/[\s’']+/g, " ").replace(/[^\p{L}\p{N} ]/gu, "");

/** Two goes and no more. The second carries the findings from the first. */
export const TRIES = 2;

export const INSTRUCTION = `You are the solution architect for one agent. You settle what the agent stands on, before anybody designs what it does.

You are given the statement of the job, the systems the platform reserves with what each promises, and the architecture standard you apply. Answer with the architecture as one JSON object and nothing else.

What you decide, applying the standard:
- The systems the agent reaches, each named in plain system words from the reserved list (database, files, text-reasoning, mail, draft-host and the rest), never by a product, an address or an account. A model is a system named by capability: text-reasoning for text, image-reading for pictures, each with access "trigger", and you say the capability the work needs in plain words (text, vision, long context, speech). Never name a model or a version anywhere in your answer.
- For each system, quote in "called_for" the exact words of the statement that call for it. A system the statement does not call for is access nobody granted: leave it out and put it in "questions".
- The agent's kind: plugin-on-harness (skills a harness reads, with the work in scripts that call a model at named points) is the default; mesh-coded (code that answers on the network itself) or third-party-framework (somebody else's program in a container) only with a reason.
- The dependencies on other agents and services, each with why. None is a real answer.
- The limits on cost, speed, data and trust. A spending limit is a commitment: write one only when the statement states it, in its own numbers; otherwise leave cost null. Speed, data and trust you may draft from the statement, each with its reason.
- The egress: each destination the agent must reach on the network beyond its systems, the mesh, the registrar and its model, named by what it is (never by address) and why. Reading pages at addresses a caller gives is such a destination. Never grant one: list it, and it will be asked.
- Where a destination is one public service at one fixed address that takes no key (a public API such as the Hacker News API), say so in its "service": a system name in plain lowercase-hyphen words (hacker-news), the access ("read", "write" or "read-write"), and its address, as the statement gives it or as the service itself publishes it. It is still a destination, and still asked: the owner's yes makes it a system of the record, bound to the service itself. This address is the only one you may write.
- The formats of what the agent takes and hands back at its edge. Content a person reviews or an agent hands on is text/markdown with a light convention: a short header of named fields, then fixed headings, sketched in "convention". JSON only for exact typed data code consumes, with a vendor kind such as application/vnd.agentmesh.<name>+json, never a bare application/json. Every input says who gives it: "person", "agent" or "either".
- Inputs are only the material the job is about. Anything that only shapes how the job runs (a voice, a tone, a length, a style, a format choice, anything with a fixed set of values or a default) is a setting, never an input, and brand, palette or template material is a standing asset the agent reads, never an input.
- Settings the work needs, each a preference or a rule, with a "label" and an "about" for a person, a "default", its "allowed" choices with a label for each in "value_labels" (a number gets "min", "max" and "step" instead), all decided now and never left open. An address is never a setting, and the model is never a setting you declare: the text-reasoning binding places it.
- The environments it will run in: dev, test and production unless the statement says otherwise.

What the agent is made of, which is the software architecture itself:
- The skills a harness reads, each named in lowercase-hyphen words, with what it is responsible for. One skill per job a caller orders. Where a spec came with its offerings, those are the skills: give their responsibilities and add none. Each skill on a harness runs one script, scripts/<skill>.mjs; say in "script" what the script is responsible for.
- The parts of each script: each a piece of the program with one responsibility (a client for a system it reads, a filter, a writer that calls the model, the part that puts the reply together), with "within" naming its skill and "reaches" naming the one system it reaches, if any. The harness, the skills, the scripts and the outside systems are drawn for you from the kind and the systems; you give the parts and the words.
- The data flow: each step in order, from one component to the next, with what passes ("data") and one sentence saying how ("says"). Name the ends by the ids "caller" (whoever sent the job), "harness", a part's id, or a system's name.
- The limits are drivers: quality requirements the decisions answer, never decisions themselves. Give any further driver the statement or the spec states (how readable, how testable, how private) under "drivers", each with a lowercase-hyphen key and the words it comes from.
- The decisions about the agent's structure, in the manner of an architecture decision record: its "context" (the situation that called for it), the "drivers" it answers by key (cost, speed, data, trust, a spec constraint's id such as C1, or a key under "drivers"), "why", at least one of the "alternatives" weighed with why it was not chosen, and its "consequences". Decide how the work is controlled (a program that calls a model at named points, or a model in control), what carries it (a package on a harness, a long-running service, a container), how it reaches each system, how it reads and writes in bulk, and how it answers (synchronously, or by storing results). A decision never only states a limit ("spend at most 1 USD a day" is a driver, not a decision). Do not write the rulings: binding each system, granting or refusing a destination, and what the build settled are written for you.

Put in "questions" only a real choice the rules leave open, such as where a person reviews the result. Do not ask about spending, egress, bindings or access there: those are asked for you, each once.

You do not write the statement, design the steps of the job, or choose the agent that does a step. If that is what is asked, answer {"declined": "statement" | "design" | "agent", "reply": "<one sentence saying so>"} and nothing else.

Answer with this JSON object:
{"title": "a few words saying what the agent is for (a working title, never a name for the agent)",
 "environments": ["dev", "test", "production"],
 "systems": [{"name": "text-reasoning", "plain": "text reasoning", "capability": "text", "access": "trigger", "why": "...", "called_for": "exact words of the statement"}],
 "kind": {"kind": "plugin-on-harness", "why": "..."},
 "dependencies": [{"name": "...", "what": "agent | service", "why": "..."}],
 "limits": {"cost": null, "speed": {"limit": "...", "why": "..."}, "data": {"limit": "...", "why": "..."}, "trust": {"limit": "...", "why": "..."}},
 "drivers": [{"key": "lowercase-hyphen-key", "quality": "...", "says": "...", "from": "exact words of the statement or the spec"}],
 "egress": [{"destination": "...", "why": "...", "service": {"name": "...", "access": "read", "address": "<its address, with its scheme>"}}],
 "formats": [{"piece": "...", "direction": "in | out", "kind": "text/markdown", "convention": "...", "given_by": "person | agent | either", "why": "..."}],
 "settings": [{"name": "...", "kind": "preference | rule", "label": "...", "about": "...", "default": "...", "allowed": ["...", "..."], "value_labels": {"...": "..."}, "job_may_set": true, "why": "..."}],
 "skills": [{"name": "lowercase-hyphen-name", "responsibility": "...", "script": "what its script is responsible for"}],
 "parts": [{"id": "lowercase-hyphen-id", "name": "...", "within": "<skill name>", "responsibility": "...", "reaches": "<system name, or leave it out>"}],
 "flow": [{"from": "caller", "to": "harness", "data": "...", "says": "..."}],
 "decisions": [{"decided": "...", "context": "...", "drivers": ["cost", "speed"], "why": "...", "alternatives": [{"option": "...", "why_not": "..."}], "consequences": ["..."]}],
 "questions": [{"key": "lowercase-hyphen-key", "question": "..."}]}`;

/** The reserved systems, as the model reads them: name, purpose, promise. */
export function vocabularyText(vocabulary = []) {
  return vocabulary.map((s) => `- ${s.name}: ${trim(s.purpose)} ${trim(s.promises)}${s.state === "reserved" ? " (reserved, not yet defined)" : ""}`).join("\n");
}

/** The part of the request that says what the spec settles for the
 *  architecture: its offerings, which are the skills, and its constraints,
 *  which are drivers the decisions cite by id. */
export function specPart(spec) {
  if (!spec || typeof spec !== "object") return "";
  const offerings = specOfferings(spec);
  const constraints = (spec.constraints ?? []).filter((c) => trim(c?.id));
  if (!offerings.length && !constraints.length) return "";
  return [
    "--- WHAT THE SPEC SETTLES ---",
    ...(offerings.length ? [`The skills are the spec's offerings: ${offerings.join(", ")}. Give each its responsibility and its script's, and add no other skill.`] : []),
    ...(constraints.length ? ["The spec's constraints are drivers your decisions cite by id:", ...constraints.map((c) => `- ${trim(c.id)} (${trim(c.kind) || "constraint"}): ${trim(c.shall)}`)] : []),
  ].join("\n");
}

/** The parts of the request, in order. Pure, so a test reads the whole prompt. */
export function requestParts({ asked, standard = "", example = "", findings = [] } = {}) {
  const parts = [INSTRUCTION];
  parts.push(`--- THE STATEMENT OF THE JOB ---\n${trim(asked?.statement) || "(none)"}`);
  parts.push(`--- THE SYSTEMS THE PLATFORM RESERVES ---\n${vocabularyText(asked?.defaults?.systems ?? [])}`);
  const settled = settledPart(asked?.settled);
  if (settled) parts.push(settled);
  const spec = specPart(asked?.spec);
  if (spec) parts.push(spec);
  if (asked?.revision && asked?.earlier) {
    parts.push(`--- THE RECORD YOU ARE REVISING ---\n${trim(asked.earlier.text)}`);
    const answers = Object.entries(asked.answers ?? {});
    if (answers.length) parts.push(`--- THE PERSON HAS ANSWERED THESE QUESTIONS ---\n${answers.map(([k, v]) => `${k}: ${trim(v)}`).join("\n")}`);
    if (trim(asked.revision.change)) parts.push(`--- WHAT TO CHANGE ---\n${trim(asked.revision.change)}\nIf the change needs a system the statement does not call for (a design step that reaches something new, say), do not add it: put it in "questions" for the person.`);
    parts.push("This is a revision. Answer with the whole architecture again. Keep every line the answers and the change do not touch; change only what they touch.");
  }
  if (trim(standard)) parts.push(`--- THE ARCHITECTURE STANDARD ---\n${trim(standard)}`);
  if (trim(example)) parts.push(`--- A RECORD THAT WORKS, FOR ITS FORM AND NOT ITS CONTENT ---\n${trim(example)}`);
  if (findings.length) parts.push(`--- WHAT WAS WRONG WITH YOUR LAST ANSWER ---\n${findings.map((f) => `- ${f}`).join("\n")}\nAnswer again with these fixed. Change nothing else.`);
  return parts;
}

/** The answer, out of whatever wrapping it came in. */
export function answerFrom(text) {
  const raw = trim(text);
  if (!raw) throw new Error("the text-reasoning service answered with nothing");
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(raw);
  let doc;
  try { doc = JSON.parse(fenced ? fenced[1] : raw); } catch { throw new Error("the text-reasoning service did not answer with JSON"); }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("the text-reasoning service answered with JSON that is not an object");
  return doc;
}

/** Systems the statement (or a person's answer) does not call for are taken
 *  out and asked. In a revision, a system the earlier record already named
 *  stands. */
export function calledFor(arch, { statement = "", answers = {}, earlierSystems = [], refusedBefore = [] } = {}) {
  const words = norm(`${statement}\n${Object.values(answers).join("\n")}`);
  const questions = [];
  const decisions = [];
  const kept = [];
  for (const s of arch.systems ?? []) {
    const answer = trim(answers[`system-${s.name}`]);
    const verdict = answer ? yesOrNo(answer) : null;
    const granted = verdict === "yes";
    if (verdict === "no") {
      decisions.push({ kind: "ruling", decided: `The agent does not reach ${s.name}`, why: `The person said no in an answer (system-${s.name}: ${answer})`, follows: "Whatever needed it has to work without it, or the statement changes" });
      continue;
    }
    if (!answer && refusedBefore.includes(s.name)) continue;
    // A public service the owner approved as a destination is called for by
    // that approval, and needs no quote of its own.
    if (s.public) { kept.push(s); continue; }
    if (granted) decisions.push({ kind: "ruling", decided: `The agent reaches ${s.name}`, why: `The person granted it in an answer (system-${s.name}: ${answer})`, follows: `${s.name} is bound in each environment like any other system` });
    const quote = norm(s.called_for);
    if (earlierSystems.includes(s.name) || granted || (quote.length >= 3 && words.includes(quote))) { kept.push(s); continue; }
    questions.push({
      key: `system-${s.name}`,
      question: `Should this agent reach ${s.name}${trim(s.why) ? ` (${trim(s.why).replace(/\.$/, "")})` : ""}? The statement does not call for it, and access nobody asked for is not granted here. Answer "system-${s.name}: yes" or "system-${s.name}: no".`,
    });
  }
  return { arch: { ...arch, systems: kept, decisions: [...(arch.decisions ?? []), ...decisions] }, questions };
}

/** Ask, check, ask once more with the findings, then repair in code. */
export async function nameTheSystems({ ask, asked, standard = "", example = "", tries = TRIES } = {}) {
  if (typeof ask !== "function") throw new Error("nameTheSystems needs ask");
  const carried = asked?.revision && asked?.earlier ? carriedFrom(asked.earlier.text) : {};
  const ctx = { statement: asked?.statement, answers: asked?.answers ?? {}, vocabulary: asked?.defaults?.systems ?? [], carried, spec: asked?.spec ?? null };
  let findings = [];
  let doc = null;
  const used = [];
  for (let go = 0; go < tries; go += 1) {
    const got = await ask(requestParts({ asked, standard, example, findings }).join("\n\n"));
    used.push({ answered_by: got?.answered_by ?? null, tokens_in: got?.tokens_in ?? null, tokens_out: got?.tokens_out ?? null });
    doc = answerFrom(got?.text);
    if (doc.declined) return { declined: doc.declined, reply: trim(doc.reply) || "That is not this role's to do: I write the architecture record, and nothing a later stage owns.", used };
    findings = findingsOf(doc, ctx);
    if (!findings.length) break;
  }
  if (!KINDS.includes(trim(doc.kind?.kind))) doc.kind = { kind: "plugin-on-harness", why: trim(doc.kind?.why) || "The house default: skills a harness reads, with the work in scripts that call a model at named points." };
  const fixed = repaired(doc, ctx);
  const earlierSystems = asked?.revision && asked?.earlier ? parseRecord(asked.earlier.text)?.systems ?? [] : [];
  const refusedBefore = (carried.refused ?? []).filter((x) => /^[a-z][a-z0-9-]*$/.test(x));
  const called = calledFor(fixed.arch, { statement: asked?.statement, answers: asked?.answers ?? {}, earlierSystems, refusedBefore });
  // The model's own questions as repaired, so nothing a record never carries
  // comes back through them.
  const modelQuestions = (Array.isArray(fixed.arch.questions) ? fixed.arch.questions : [])
    .filter((q) => q && /^[a-z][a-z0-9-]*$/.test(trim(q.key)) && trim(q.question) && !(trim(q.key) in (asked?.answers ?? {})))
    // The commitments are code's to ask, each once, under its own key: a
    // model's own question about egress, spending, a binding or access to a
    // system says the same thing twice.
    .filter((q) => !/egress|network|reach|spend|cost|budget|limit|bind|access|grant/i.test(`${q.key} ${q.question}`));
  const byKey = new Map();
  for (const q of [...fixed.questions, ...called.questions, ...modelQuestions]) if (!byKey.has(q.key)) byKey.set(q.key, { key: q.key, question: trim(q.question) });
  // What the build already settled is used, with where it came from, and the
  // questions it answers go; where the answer would have been otherwise it
  // is a note in the decision, never a binding or a question (settled.mjs).
  const applied = applySettled(called.arch, [...byKey.values()], asked?.settled ?? null);
  const arch = applied.arch;
  delete arch.questions;
  // A limit the model filled in was taken out to be asked; where the build
  // settled one, it was used instead, and the note says so.
  const notes = applied.settled?.used?.includes("limit-cost")
    ? fixed.notes.map((n) => n.replace(/, and asked for it$/, `, and used the one ${applied.settled.by} settled`))
    : fixed.notes;
  return { architecture: arch, questions: applied.questions, notes, settled: applied.settled, findings: findingsOf(arch, ctx).filter((f) => !/address|credential|names the model/.test(f)), used, calls: used.length };
}

/** The request formats this package's text-reasoning system declares, read
 *  from agent-runtime-requirements.json beside the scripts (at the package's
 *  root from source, or above a skill's scripts/ in a built package). An
 *  empty list when none is found, and then the job is refused
 *  (modelCaller). `here` is the scripts folder the file is looked for
 *  above, so a test can point it at another file. */
export function declaredProtocols(here = HERE) {
  const at = [join(here, "..", "agent-runtime-requirements.json"), join(here, "..", "..", "agent-runtime-requirements.json"), join(here, "..", "..", "..", "agent-runtime-requirements.json")].find((p) => existsSync(p));
  if (!at) return [];
  try {
    const system = (JSON.parse(readFileSync(at, "utf8"))?.systems ?? []).find((s) => s?.name === "text-reasoning");
    return Array.isArray(system?.protocols) ? system.protocols.map(trim).filter(Boolean) : [];
  } catch { return []; }
}

/** Why the job is refused when the declared protocols could not be read:
 *  without them the caller would hold MODEL_PROTOCOL to nothing and send
 *  whatever it speaks (Common Agent 12.4.1), so nothing is sent. */
export const PROTOCOLS_UNREAD = "the model system's declared protocols could not be read from agent-runtime-requirements.json, so nothing was sent to the model";

/** The shared caller for this job, asking for JSON with the declared
 *  protocols. Throws in words before anything is sent when a setting is
 *  missing, MODEL_PROTOCOL is not declared, or the declared protocols could
 *  not be read. */
export function modelCaller(env = process.env, fetchImpl = fetch, { protocols = declaredProtocols() } = {}) {
  const why = cannotCall(env, { protocols }) || (Array.isArray(protocols) && protocols.length ? "" : PROTOCOLS_UNREAD);
  if (why) throw new Error(why);
  return callerFor(env, fetchImpl, { json: true, protocols });
}

export function referenceAt(name, here = HERE) {
  // In a package, a skill's references/; from source, the agent's own
  // references/, or the repository's standards/ for a standard it pins.
  return [join(here, "..", "references", name), join(here, "..", "..", "references", name), join(here, "..", "..", "..", "standards", name)].find((p) => existsSync(p)) ?? null;
}

const thisFile = process.argv[1] ? process.argv[1].replace(/\\/g, "/").split("/").pop() : "";
if (thisFile && import.meta.url.endsWith(thisFile)) {
  const env = process.env;
  const { ASKED, RECORDS } = env;
  if (!ASKED || !RECORDS) { console.error("ASKED and RECORDS are required"); process.exit(2); }
  const read = (p) => (p && existsSync(p) ? readFileSync(p, "utf8") : "");
  try {
    const asked = JSON.parse(readFileSync(ASKED, "utf8"));
    // The answer is one JSON object, so every ask says json: true.
    const caller = trim(env.ANSWERS_FROM) ? replayCaller(env.ANSWERS_FROM) : modelCaller(env, fetch);
    const out = await nameTheSystems({
      ask: (p) => caller.ask(p, { json: true }), asked,
      standard: read(referenceAt("architecture-standard.md")), example: read(referenceAt("a-record-that-works.md")),
    });
    mkdirSync(RECORDS, { recursive: true });
    writeFileSync(join(RECORDS, "calls.json"), JSON.stringify({
      calls: "v1", model: caller.model, protocol: caller.protocol, made: out.used.length,
      answered_by: [...out.used].reverse().find((u) => u.answered_by)?.answered_by ?? null, each: out.used,
    }, null, 2) + "\n");
    writeFileSync(join(RECORDS, "named.json"), JSON.stringify({ named: "v1", ...out }, null, 2) + "\n");
    if (out.declined) { console.log(JSON.stringify({ ok: false, code: 3, reply: out.reply })); process.exit(3); }
    console.log(JSON.stringify({ ok: true, code: 0, named: join(RECORDS, "named.json"), systems: out.architecture.systems.map((s) => s.name), questions: out.questions.map((q) => q.key), findings: out.findings, calls: out.calls }));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
