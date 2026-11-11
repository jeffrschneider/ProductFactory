// Does this draft carry what a good spec carries?
//
// Not the same question as whether it builds. build.py answers that, and it
// answers it hard: a spec that does not build is not a spec. This asks the
// other question, the one nothing else asks, which is whether the thing that
// builds is any good. A spec can pass every validator and still say nothing
// useful about when to use the job, what a good result is, or what the agent
// will refuse to do.
//
// Every rule here was read off the eight specs that already produced working
// agents, and the reference beside this file says where each number came from.
// Nothing is invented: where the eight disagree, this does not have a rule.
//
//   needs: node >= 22
//   DRAFT=<draft.json> node check-spec.mjs
import { readFileSync } from "node:fs";
import { canUseProblems, loadSchemas } from "./can-use.mjs";
import { optionProblems } from "./options.mjs";
import { jobSecondsProblem } from "./job-seconds.mjs";
import { runReplyProblems, runReplyUnprinted } from "./run-reply.mjs";
import { reachProblems } from "./reaches.mjs";
import { givenProblems, scriptOfWord } from "./given.mjs";
export { PRINTED_MEMBER, RUN_REPLY_MEMBER, RUN_REPLY_STDOUT, fitRunReply, printedMembers, runReplyOk, runReplyProblems, runReplyUnprinted } from "./run-reply.mjs";
export { JOB_SECONDS_MAX, JOB_SECONDS_MIN, fitJobSeconds, jobSecondsProblem } from "./job-seconds.mjs";

const trim = (s) => String(s ?? "").trim();
const words = (s) => trim(s).split(/\s+/).filter(Boolean).length;

// Measured across the 43 jobs of the eight existing packages, with headroom.
// `when` ran 4 to 28 words, `good` 21 to 103, `empty` 13 to 106, `does` 11 to
// 44. These bound the shape without pretending the measured range is a law.
export const WHEN_MAX = 45;
export const GOOD_MIN = 15;
export const EMPTY_MIN = 10;
export const DOES_MAX = 60;
export const REFUSES_MIN = 4;

export const SENTENCES = ["when", "good", "empty", "does"];
export const HOW_MEMBERS = ["control", "intelligence", "cost", "contract"];

/** A refusal names an act, as a gerund, then says why and what happens
 *  instead. "Be careful with credentials" is not a refusal; "accepting a
 *  credential value pasted into a message" is. Checked by the first word,
 *  which is the only mechanical part of that; the rest is a reader's job. */
export function refusalProblems(refuses = []) {
  const out = [];
  if (!Array.isArray(refuses) || refuses.length < REFUSES_MIN) {
    out.push(`the spec names ${Array.isArray(refuses) ? refuses.length : 0} refusals; every package that works names at least ${REFUSES_MIN}, and a package with nothing to refuse has not been thought about`);
    if (!Array.isArray(refuses)) return out;
  }
  for (const [i, r] of refuses.entries()) {
    const text = trim(typeof r === "string" ? r : r?.what ?? r?.name ?? "");
    if (!text) { out.push(`refusal ${i + 1} is empty`); continue; }
    const first = text.split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, "");
    if (!first.endsWith("ing")) {
      out.push(`refusal ${i + 1} begins "${text.split(/\s+/)[0]}"; a refusal names an act as a gerund, as in "publishing anything it was not handed", so that a reader can tell whether a request falls under it`);
    }
    if (words(text) < 8) {
      out.push(`refusal ${i + 1} is ${words(text)} words; a refusal says the act, then why, then what happens instead`);
    }
  }
  return out;
}

/** The records a spec must declare, and the one it must not.
 *
 *  The manifest is unconditional: every package that works declares it.
 *
 *  went-without.json is conditional, and the condition is the point. A record
 *  declared and never written is worse than one absent, because the
 *  conformance checker audits a package against its own declarations and
 *  looks for it. So the rule is that the declaration and the ability to write
 *  it travel together: ship went-without.mjs and declare the record, or ship
 *  neither. This file used to demand the record from every spec, which is how
 *  five packages ended up declaring a record nothing in them could write. */
export function recordProblems(records = [], spec = null) {
  const out = [];
  const list = Array.isArray(records) ? records : [];
  const text = list.map((r) => (typeof r === "string" ? r : `${r?.name ?? ""} ${r?.file ?? ""}`)).join(" ").toLowerCase();
  const declared = text.includes("went-without");
  const ships = (spec?.jobs ?? []).some((j) => (j?.scripts ?? []).some((f) => String(f).endsWith("went-without.mjs")));
  if (declared && !ships) {
    out.push("a record named went-without.json is declared and no job ships went-without.mjs, so nothing can write it; a record declared and never written is what the conformance checker catches");
  }
  if (ships && !declared) {
    out.push("a job ships went-without.mjs and no record names went-without.json; what a job did not have and did anyway is left for somebody to find rather than declared");
  }
  if (!text.includes("manifest")) {
    out.push("no record for the signed job manifest of each delivery; all eight existing packages declare one");
  }
  return out;
}

export function jobProblems(job) {
  const out = [];
  const slug = trim(job?.slug) || "a job with no slug";
  for (const k of SENTENCES) {
    if (!trim(job?.[k])) out.push(`job ${slug}: no ${k}`);
  }
  if (trim(job?.when) && words(job.when) > WHEN_MAX) {
    out.push(`job ${slug}: when is ${words(job.when)} words; it is read by somebody choosing between jobs, so it stays under about ${WHEN_MAX}`);
  }
  if (trim(job?.good) && words(job.good) < GOOD_MIN) {
    out.push(`job ${slug}: good is ${words(job.good)} words; it describes the artifact a reader could check, not the effort`);
  }
  if (trim(job?.empty) && words(job.empty) < EMPTY_MIN) {
    out.push(`job ${slug}: empty is ${words(job.empty)} words; it says what the agent does when there is nothing to give, and is not an error message`);
  }
  if (trim(job?.does) && words(job.does) > DOES_MAX) {
    out.push(`job ${slug}: does is ${words(job.does)} words; it is one line for somebody skimming the package`);
  }
  // A job whose command runs a script names its scripts: they are the files
  // Code writes, and a job that names none leaves Code nothing to write.
  const command = Array.isArray(job?.run?.command) ? job.run.command : [];
  const runs = command.map(scriptOfWord).filter(Boolean);
  const named = Array.isArray(job?.scripts) ? job.scripts.map((f) => trim(f).replace(/^\.\//, "")) : [];
  for (const f of runs) if (!named.includes(f)) out.push(`job ${slug}: its command runs ${f}, and scripts does not name it; name every script the job runs in scripts, because those are the files Code writes`);
  // The host starts a command from its own home folder, so a script is named
  // in the packaged form, never as a bare path.
  for (const w of command) {
    if (/^(?:\.\/)?scripts\/[\w./-]+\.(?:mjs|js|cjs)$/.test(trim(w))) out.push(`job ${slug}: its command names ${trim(w)} as a bare path, and the host runs a command from its own home folder, where that finds nothing; write {home}/{package}/skills/${slug}/${trim(w).replace(/^\.\//, "")}`);
  }
  const how = job?.how;
  if (!how || typeof how !== "object") out.push(`job ${slug}: no how; every job says control, intelligence, cost and contract`);
  else {
    for (const m of HOW_MEMBERS) if (!trim(how[m])) out.push(`job ${slug}: how names no ${m}`);
    // Said here as well as in the builder, because the builder's refusal
    // arrives after a package has been assembled and this one arrives while
    // the model still has the draft in hand.
    if (how.control === "model" && how.contract === "full") {
      out.push(`job ${slug}: how says a model decides what happens next and the whole method is written down. That is the shape that fails. Write it as a program, or say the contract is the ends.`);
    }
    if (how.control === "script" && how.intelligence === "open") {
      out.push(`job ${slug}: how says a program decides what happens next and a model is given the work to find its own way. That is a model with a launcher.`);
    }
  }
  return out;
}

/** The two forms a kind takes: one of four words, or one media type. The same
 *  rule the builder applies, said here while the model still has the draft,
 *  because a container spec is never packed and nothing else would catch it
 *  (debt 48: "array of application/octet-stream"). */
export const VALUE_KINDS = ["text", "identifier", "url", "document"];
const MEDIA_RE = /^[a-z]+\/[a-z0-9][a-z0-9.+-]*$/;
export const isKind = (k) => typeof k === "string" && (VALUE_KINDS.includes(k) || MEDIA_RE.test(k));

export function kindProblems(job) {
  const out = [];
  const slug = trim(job?.slug) || "a job with no slug";
  for (const side of ["inputs", "outputs"]) {
    for (const e of Array.isArray(job?.[side]) ? job[side] : []) {
      if (isKind(e?.kind)) continue;
      out.push(`job ${slug}: ${side === "inputs" ? "input" : "output"} ${JSON.stringify(e?.name ?? null)} has kind ${JSON.stringify(e?.kind ?? null)}, which is not a kind; a kind is one of ${VALUE_KINDS.join(", ")} or one media type such as text/markdown or application/vnd.agentmesh.<name>+json, and several files of one kind are one input`);
    }
  }
  return out;
}

/** The words a person reads on the form (owner, 2026-11-03). An input a
 *  person gives, or may give, is drawn as a box with its `label` above and its
 *  `about` under it, so the about is written to that person: one or two short
 *  sentences saying what to put in the box, with an example or what a blank
 *  box means. The shape of the data belongs to the kind and the job's skill,
 *  never to the form. Found on 2026-11-03 across 62 agents: "The agent whose
 *  storefront to write, by its handle or its key." and "The ranked list
 *  (ranked-stories-v1) as the rank checker passed it." */
export const FORM_WORDS_MAX = 25;
const MEDIA_TYPE = /\b(?:application|text|image|audio|video)\/[a-z0-9.+-]+/i;
const FORMAT_ID = /\b[a-z]+(?:-[a-z]+)*-v\d+\b/;
const PLACEHOLDER = /\bYYYY\b|\bMM-DD\b|\blast N\b|\bN (?:days|weeks|posts)\b/;
export function formWordsProblems(job) {
  const out = [];
  const slug = trim(job?.slug) || "a job with no slug";
  for (const e of Array.isArray(job?.inputs) ? job.inputs : []) {
    if (e?.given_by === "agent" || !trim(e?.about)) continue;
    const said = trim(e.about);
    const name = JSON.stringify(e.name ?? null);
    if (words(said) > FORM_WORDS_MAX) out.push(`job ${slug}: input ${name}'s about is ${words(said)} words; a person reads it under the box, so say what to put there in ${FORM_WORDS_MAX} words or fewer and leave the rest to the skill`);
    if (MEDIA_TYPE.test(said) || FORMAT_ID.test(said) || /[{}]/.test(said)) out.push(`job ${slug}: input ${name}'s about names a data format; a person reads it on the form, so say what the thing is and who makes it, and leave the format to the kind`);
    if (PLACEHOLDER.test(said)) out.push(`job ${slug}: input ${name}'s about uses a placeholder such as YYYY-MM-DD or "last N days"; give a real example instead, such as 2026-10-01 or "last 30 days"`);
  }
  return out;
}

/** The format rules (owner, 2026-10-27). What one agent hands another, or a
 *  person reviews, is Markdown with a light convention; JSON is only for
 *  exact typed data code consumes and no person reads, and then under a kind
 *  that says what it is. The package maker refuses a new agent that declares
 *  bare application/json, so it is said here while the model still has the
 *  draft in hand. Each input also says who gives it (given_by, Common Agent
 *  6.13, proposed and optional), and a Markdown piece sketches its convention
 *  in its about: a short header for the structured fields, then the fixed
 *  headings, each written in backticks as `## Heading`. */
export const BARE_JSON = "application/json";
export const GIVEN_BY = ["person", "agent", "either"];
export const isBareJson = (k) => typeof k === "string" && k.split(";")[0].trim().toLowerCase() === BARE_JSON;
const isMarkdown = (k) => typeof k === "string" && k.split(";")[0].trim().toLowerCase() === "text/markdown";

/** The headings a piece's about sketches as its convention: each `# ...`
 *  written in backticks. */
export const conventionHeadings = (about) => [...String(about ?? "").matchAll(/`(#{1,6} [^`]+)`/g)].map((m) => m[1].trim());

/** The pieces an earlier spec already declared as bare application/json, as
 *  "inputs:<name>" and "outputs:<name>". A revision of a released agent keeps
 *  what that agent sends: converting an existing piece is its own decision,
 *  so those are left as they were and only new pieces are held to the rule.
 *  Read from what came with the request: a spec.json, or the agent's own
 *  agent-descriptor.json. */
export function earlierBareJson(asked = null) {
  const out = new Set();
  const add = (job) => {
    for (const side of ["inputs", "outputs"]) {
      for (const e of Array.isArray(job?.[side]) ? job[side] : []) if (isBareJson(e?.kind) && trim(e?.name)) out.add(`${side}:${trim(e.name)}`);
    }
  };
  for (const a of asked?.attached ?? []) {
    if (typeof a?.text !== "string") continue;
    let doc;
    try { doc = JSON.parse(a.text); } catch { continue; }
    for (const j of Array.isArray(doc?.jobs) ? doc.jobs : []) add(j);
    for (const o of Array.isArray(doc?.offerings) ? doc.offerings : []) {
      add(o);
      for (const st of Array.isArray(o?.steps) ? o.steps : []) add(st);
    }
  }
  return out;
}

export function formatProblems(spec, { earlier = new Set() } = {}) {
  const out = [];
  for (const job of Array.isArray(spec?.jobs) ? spec.jobs : []) {
    const slug = trim(job?.slug) || "a job with no slug";
    for (const side of ["inputs", "outputs"]) {
      const word = side === "inputs" ? "input" : "output";
      for (const e of Array.isArray(job?.[side]) ? job[side] : []) {
        const name = JSON.stringify(e?.name ?? null);
        if (isBareJson(e?.kind) && !earlier.has(`${side}:${trim(e?.name)}`)) {
          out.push(`job ${slug}: ${word} ${name} is bare application/json. Content one agent hands another, or a person reviews, is text/markdown with a convention sketched in its about; JSON is only for exact typed data code consumes and no person reads, and then a kind that says what it is, such as application/vnd.agentmesh.<name>+json`);
        }
        if (isMarkdown(e?.kind) && !conventionHeadings(e?.about).length && !/(?:header|front matter)[^`]{0,40}`[^`#]+`/i.test(String(e?.about ?? ""))) {
          out.push(`job ${slug}: ${word} ${name} is text/markdown and its about sketches no convention; say the short header's fields, then the fixed headings, each in backticks as \`## Heading\`, so the next reader and the test of it know what to find`);
        }
        if (side === "inputs" && !GIVEN_BY.includes(e?.given_by)) {
          out.push(`job ${slug}: input ${name} does not say who gives it; given_by is ${GIVEN_BY.join(", ")}`);
        }
      }
    }
  }
  return out;
}

/** A model named by its own name (the families the platform's agents have
 *  called, with a version or size after the family, or in words), the same
 *  pattern the package maker refuses in a new agent's scripts and skills.
 *  [-] keeps this line from naming a model itself. */
export const MODEL_NAME_RE = /(?<![\w-])(?:[a-z][a-z0-9-]*[\/.])*(gemini-(?:\d[\w.-]*|pro\b[\w.-]*|flash\b[\w.-]*|ultra\b[\w.-]*|embedding-[\w.-]+)|gemma-?\d[\w.-]*|(?:chat)?gpt-(?:\d(?![\w.]*-(?:encoder|tokens?|tokenizer)\b)[\w.-]*|4o[\w.-]*|oss[\w.-]*)|text-embedding-(?:\d|ada)[\w.-]*|claude-(?:opus|sonnet|haiku|instant|\d)[\w.:-]*|o[134]-(?:mini|preview|pro)[\w.-]*|llama-?\d[\w.-]*|mistral-(?:large|medium|small|tiny)[\w.-]*|command[-]r(?:-plus)?(?:-\d[\w.-]*)?(?![\w-])|deepseek-(?:r\d|v\d|chat|coder|reasoner)[\w.-]*|qwen-?\d[\w.-]*|grok-\d[\w.-]*|gemini \d(?:\.\d+)?(?: (?:pro|flash|ultra)\b(?:[ -]lite)?)?|claude (?:opus|sonnet|haiku) \d(?:\.\d+)?|gpt (?:4o|\d(?:\.\d+)?)\b)/gi;

/** Every model the draft names, anywhere in it, with where. A model is a
 *  bound system (text-reasoning, access trigger) and the spec says the
 *  capability, never the model (rules.md, "A model is a bound system"). */
export function modelProblems(spec) {
  const out = [];
  const told = new Set();
  for (const [where, text] of stringsIn(spec, "")) {
    for (const found of String(text).matchAll(MODEL_NAME_RE)) {
      const m = [found[0], found[1].replace(/[.:-]+$/, "")];
      const key = `${where}:${m[1].toLowerCase()}`;
      if (told.has(key)) continue;
      told.add(key);
      out.push(`${where || "the spec"} names the model ${JSON.stringify(m[1])}; a model is a bound system (text-reasoning, image-reading and the like, access trigger, of kind model) that the install chooses through the four model settings it places, so say the capability the job needs in the system's purpose and never a model or a version`);
    }
  }
  return out;
}

/** What the drafting step holds a draft to: what a good spec carries, and
 *  the format rules. checkSpec alone is the first, which is what the specs
 *  that shipped before the format rules are measured by. A new draft also
 *  declares what it reaches over the network the way the security reviewer
 *  reads it (reaches.mjs), and, given what the person sent (opts.given, from
 *  given.mjs's givenOf), keeps every setting, runtime, price, address, shape
 *  and quoted word it names. */
export const checkDraft = (spec, opts = {}) => [...checkSpec(spec), ...formatProblems(spec, opts), ...modelProblems(spec), ...architectureProblems(spec, opts.architecture),
  ...canUseProblems(spec, opts.architecture, opts.table === undefined ? loadSchemas() : opts.table), ...optionProblems(spec),
  ...reachProblems(spec), ...givenProblems(spec, opts.given)];

/** The Design is held to the architecture record it was given (the
 *  Architecture and Design stage's done-when: every step uses only systems
 *  the record named, and the package's systems are the record's). A system
 *  the draft declares that the record does not name goes back to the
 *  architect; a system the record names that the draft leaves out is a
 *  finding, because the package's systems and the record's must be one set.
 *  Nothing when no record came. */
export function architectureProblems(spec, architecture = null) {
  if (!architecture || !Array.isArray(architecture.systems)) return [];
  const named = new Set(architecture.systems);
  const declared = (Array.isArray(spec?.systems) ? spec.systems : []).map((s) => trim(s?.name ?? s?.role)).filter(Boolean);
  const out = [];
  for (const n of declared) if (!named.has(n)) out.push(`the draft declares the system ${n}, which the architecture record does not name; do not declare it, and put "architecture" in blanks with the question for the architect`);
  for (const n of named) if (!declared.includes(n)) out.push(`the architecture record names the system ${n} and the draft does not declare it; the package's systems are the record's`);
  return out;
}

/** The systems the platform brokers: the agent asks the mesh for a short-lived
 *  grant each time, so the spec names no credential, variable or setting. */
export const BROKERED = ["draft-host"];

/** Every string under a value, with where it sits. */
function stringsIn(v, at, out = []) {
  if (typeof v === "string") out.push([at, v]);
  else if (Array.isArray(v)) v.forEach((x, i) => stringsIn(x, `${at}[${i}]`, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) stringsIn(x, at ? `${at}.${k}` : k, out);
  return out;
}

/** What a package's systems may not carry. An address anywhere in them ends
 *  in the install file, which the builder refuses whole (debt 67), except an
 *  address setting's `default`: the builder writes a setting's variable and
 *  purpose and leaves its default out, and the install supplies the value
 *  (reaches.mjs says why the default is there at all); a brokered
 *  system given a key asks for one no host holds; and a model system (kind
 *  model, Common Agent 12.4.1) names the request formats its scripts speak
 *  and no credential, variable or setting, because the installer places the
 *  four model settings, the same names in every agent, without being told. */
export function systemProblems(systems = []) {
  const out = [];
  for (const s of Array.isArray(systems) ? systems : []) {
    const name = trim(s?.name) || "a system with no name";
    for (const [where, text] of stringsIn(s, "")) {
      if (/^settings\[\d+\]\.default$/.test(where)) continue;
      if (/[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
        out.push(`system ${name}: ${where} carries an address, and the builder refuses a package whose install file carries one. A product somebody binds is named by its system and credential; a public read that needs no key is a system with access read, no credential, and a setting named for its address (such as API_ADDRESS) whose default is the address, never its purpose or needs; an address the caller gives is an input of kind url`);
        break;
      }
    }
    if (BROKERED.includes(name) && (s.credential || s.env || (Array.isArray(s.settings) && s.settings.length))) {
      out.push(`system ${name} is brokered: the agent asks the mesh for a short-lived grant each time it writes, so the entry names its access and what it needs, and no credential, env or settings`);
    }
    if (trim(s?.kind) === "model") {
      const named = ["credential", "env", "settings"].filter((k) => s[k] !== undefined && s[k] !== null);
      if (named.length) {
        out.push(`system ${name} is a model system and names ${named.join(", ")}: a model system takes no credential, env or settings, because the installer places MODEL_NAME, MODEL_ENDPOINT, MODEL_KEY and MODEL_PROTOCOL for it; it names the request formats its scripts speak under protocols`);
      }
    }
  }
  return out;
}

export const CONTAINER_KINDS = ["mesh-coded", "third-party-framework"];

/** A container agent's spec: somebody else's program in its own repository.
 *  The builder checks all of this too; it is said here so the second go can
 *  fix it rather than the person. */
export function containerProblems(spec) {
  if (!CONTAINER_KINDS.includes(trim(spec?.kind))) return [];
  const out = [];
  for (const j of Array.isArray(spec.jobs) ? spec.jobs : []) {
    for (const k of ["scripts", "references", "assets", "run", "instructions"]) {
      if (j?.[k] && (!Array.isArray(j[k]) || j[k].length)) out.push(`job ${trim(j?.slug) || "?"}: a ${spec.kind} agent's code lives in its own repository, so a job names no ${k}`);
    }
  }
  const c = spec.container;
  if (!c || typeof c !== "object" || Array.isArray(c)) {
    out.push("a container agent's spec carries a container block: the repository, the folder, the commit from the scan and the Dockerfile; without the scan, put container in the blanks rather than guessing");
    return out;
  }
  if (!/^[0-9a-f]{40}$/.test(trim(c.commit).toLowerCase())) out.push("container.commit is the full 40-character commit the scan read; a branch moves and a spec must not");
  if (c.holds_own_key !== true) out.push("container.holds_own_key is true: the lifecycle installs only a container that speaks the mesh with its own key");
  for (const e of Array.isArray(c.secrets) ? c.secrets : []) {
    if (e && "value" in e) out.push(`container.secrets: ${e.env ?? "an entry"} carries a value; a secret is named, and its credential is the owner's answer at the deploy`);
  }
  return out;
}

/** Every problem with a draft, as sentences a model can act on. Empty means
 *  it carries what a good spec carries; it says nothing about whether it
 *  builds, which is the next step's question. */
export function checkSpec(spec) {
  const out = [];
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return ["the draft is not an object"];
  if (!/^[a-z][a-z0-9-]*$/.test(trim(spec.name))) {
    out.push(`the name ${JSON.stringify(spec.name ?? null)} is not a handle; it is lower case letters, digits and hyphens, and it becomes the agent's name on the mesh`);
  }
  // The builder does not check this, and release pointers are bare semver, so
  // a version it accepts can still be one that nothing downstream can order.
  // All eight existing packages are three numbers; "one point oh" builds.
  if (!/^\d+\.\d+\.\d+$/.test(trim(spec.version))) {
    out.push(`the version ${JSON.stringify(spec.version ?? null)} is not three numbers; a release is pointed at by bare semver, and the builder will take this without noticing`);
  }
  const jobs = Array.isArray(spec.jobs) ? spec.jobs : [];
  if (!jobs.length) out.push("the spec has no jobs");
  for (const j of jobs) out.push(...jobProblems(j), ...kindProblems(j), ...formWordsProblems(j));
  const offered = jobs.filter((j) => j.offered);
  if (jobs.length && !offered.length) {
    out.push("no job is marked offered; one of them is what a caller orders and the rest are the steps that deliver it");
  }
  out.push(...refusalProblems(spec.refuses));
  out.push(...recordProblems(spec.records, spec));
  out.push(...systemProblems(spec.systems));
  out.push(...containerProblems(spec));
  // The builder refuses any other value (build.py), so a draft carrying one
  // would pass here and stop at packing, as the ping-pong smoke test's did
  // on 2026-10-03 with 30, and vowel-gauge's on 2026-10-31 (debt 648).
  const timed = jobSecondsProblem(spec);
  if (timed) out.push(timed);
  // The same for a job's run.reply: the package maker takes 'stdout' or
  // 'json:<member>' and nothing else (vowel-scale's "text:counts", debt 652).
  out.push(...runReplyProblems(spec));
  // And a json:<member> the command never prints, which the host reads as no
  // reply and tells the sender the work was cut short (debt 657).
  out.push(...runReplyUnprinted(spec));
  if (!spec.price || typeof spec.price !== "object") out.push("no price; seven of the eight existing packages are flat and one is free, and a spec with neither has not decided");
  return out;
}

const thisFile = process.argv[1] ? process.argv[1].replace(/\\/g, "/").split("/").pop() : "";
if (thisFile && import.meta.url.endsWith(thisFile)) {
  const { DRAFT } = process.env;
  if (!DRAFT) { console.error("DRAFT is required"); process.exit(2); }
  try {
    const problems = checkDraft(JSON.parse(readFileSync(DRAFT, "utf8")));
    console.log(JSON.stringify({ ok: !problems.length, problems }, null, 2));
    process.exitCode = problems.length ? 1 : 0;
  } catch (e) {
    console.error(e.message);
    process.exitCode = 2;
  }
}
