// The architecture standard, as checks: what the drafting answer is held to
// before anything is bound, and what is put right in code when a second go
// still has it wrong. standards/architecture-standard.md is the prose; this
// is the part a program can see.
//
// Two kinds of thing are told apart, and the difference is the whole point of
// the stage. A FINDING is something the model wrote wrong that it can write
// again: a system named by its product, a decision with no reason, a bare
// application/json. A COMMITMENT is something the model may not settle at
// all, because somebody would be held to it: a spending limit, a destination
// beyond the derived set, access the statement never called for. A commitment
// the answer filled in is taken back out in code and asked, whatever the
// model said, so the record never arrives looking settled when it is not.
//
//   needs: node >= 22. Pure: nothing here reads a file or the network.
import { inputIs, settingMissing } from "./options.mjs";
import { providersIn, withoutProviders } from "./no-provider.mjs";
import { PUBLIC_ACCESS, PUBLIC_ADDRESS, parseRecord } from "./architecture-record.mjs";
import { LIMIT_DRIVERS, decisionOf, driversOf, isRuling, slug, specOfferings, statesLimit } from "./views.mjs";

const trim = (s) => String(s ?? "").trim();

export const KINDS = ["plugin-on-harness", "mesh-coded", "third-party-framework", "bare-harness"];
export const ACCESS = ["read", "write", "trigger"];
export const GIVEN_BY = ["person", "agent", "either"];
/** The model systems, each reached with access trigger and stated by the
 *  capability the work needs. */
export const MODEL_SYSTEMS = ["text-reasoning", "image-reading", "speech-to-text", "text-to-speech"];
export const VALUE_KINDS = ["text", "identifier", "url", "document"];

/** A model named by its own name, the same families the package maker looks
 *  for (agents/package-maker/build.py, MODEL_NAME_RE), with a provider in
 *  front read with it, and the same families written in words.
 *
 *  Built from its parts, family and tail apart, so that this file itself names
 *  no model in the eyes of the package maker's own check, which reads every
 *  line of a script that is not a comment. */
const FAMILY = (family, tail) => `${family}${tail}`;
export const MODEL_NAME_RE = new RegExp(String.raw`(?<![\w-])(?:[a-z][a-z0-9-]*[/.])*(` + [
  FAMILY("gem" + "ini", String.raw`-(?:\d[\w.-]*|pro\b[\w.-]*|flash\b[\w.-]*|ultra\b[\w.-]*|embedding-[\w.-]+)`),
  FAMILY("gem" + "ma", String.raw`-?\d[\w.-]*`),
  FAMILY("(?:chat)?g" + "pt", String.raw`-(?:\d[\w.-]*|4o[\w.-]*|oss[\w.-]*)`),
  FAMILY("text-embed" + "ding", String.raw`-(?:\d|ada)[\w.-]*`),
  FAMILY("cla" + "ude", String.raw`-(?:opus|sonnet|haiku|instant|\d)[\w.:-]*`),
  String.raw`o[134]-(?:mini|preview|pro)[\w.-]*`,
  FAMILY("lla" + "ma", String.raw`-?\d[\w.-]*`),
  FAMILY("mis" + "tral", String.raw`-(?:large|medium|small|tiny)[\w.-]*`),
  FAMILY("comm" + "and", String.raw`-r(?:-plus)?(?:-\d[\w.-]*)?(?![\w-])`),
  FAMILY("deep" + "seek", String.raw`-(?:r\d|v\d|chat|coder|reasoner)[\w.-]*`),
  FAMILY("qw" + "en", String.raw`-?\d[\w.-]*`),
  FAMILY("gr" + "ok", String.raw`-\d[\w.-]*`),
  FAMILY("gem" + "ini", String.raw` \d(?:\.\d+)?(?: (?:pro|flash|ultra)\b(?:[ -]lite)?)?`),
  FAMILY("cla" + "ude", String.raw` (?:opus|sonnet|haiku) \d(?:\.\d+)?`),
  FAMILY("g" + "pt", String.raw` (?:4o|\d(?:\.\d+)?)\b`),
  FAMILY("cla" + "ude", String.raw` \d(?:\.\d+)?(?: (?:opus|sonnet|haiku)\b)?`),
  FAMILY("lla" + "ma", String.raw` \d(?:\.\d+)?`),
  FAMILY("gem" + "ini", String.raw` (?:pro|flash|ultra)\b`),
].join("|") + ")", "gi");

/** An address: a URL, or a host name with a dot and a known ending. A handle
 *  on the mesh (name.owner@example.com) is a name, not an address, and is not
 *  read as one. */
export const ADDRESS_RE = /\b(?:https?|wss?|nats|postgres(?:ql)?|mongodb(?:\+srv)?):\/\/[^\s)`'"]+|(?<![@\w.-])(?:[a-z0-9-]+\.)+(?:com|net|org|io|ai|dev|app|co|cloud)\b(?![@\w-])(?::\d+)?(?:\/[^\s)`'"]*)?/gi;

/** Something that looks like a credential value rather than a name. */
export const CREDENTIAL_RE = /\b(?:AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})/g;

/** Words that name a product rather than a system. A system named by one of
 *  these has been named by what stands behind it. */
export function productWords(vocabulary = []) {
  const out = new Set(["supabase", "firestore", "postgres", "postgresql", "mysql", "mongodb", "dynamodb", "redis", "s3", "gcs",
    "google-cloud-storage", "okta", "auth0", "resend", "ses", "sendgrid", "mailgun", "twilio", "slack", "gemini", "claude",
    "anthropic", "openai", "gpt", "vertex", "bedrock", "elevenlabs", "hindsight", "nats", "jetstream", "stripe"]);
  for (const s of vocabulary) {
    for (const p of s?.products ?? []) if (trim(p) && p !== "platform" && p !== "own-gateway") out.add(trim(p).toLowerCase());
    if (trim(s?.house?.product) && s.house.product !== "none") out.add(trim(s.house.product).toLowerCase());
  }
  return out;
}

/** The system a product word is bound to, where the vocabulary says. */
export function systemForProduct(word, vocabulary = []) {
  const w = trim(word).toLowerCase();
  const hit = vocabulary.find((s) => (s?.products ?? []).map((p) => String(p).toLowerCase()).includes(w)
    || trim(s?.house?.product).toLowerCase() === w);
  if (hit) return hit.name;
  if (["gemini", "claude", "anthropic", "openai", "gpt", "vertex", "bedrock"].includes(w)) return "text-reasoning";
  if (["postgres", "postgresql", "mysql", "mongodb", "dynamodb", "redis"].includes(w)) return "database";
  if (["gcs"].includes(w)) return "files";
  if (["sendgrid", "mailgun"].includes(w)) return "mail";
  return null;
}

/** Every string in a value, with where it sits, for the checks that read
 *  everything the record will carry. */
export function* stringsIn(value, at = "") {
  if (typeof value === "string") { yield [at, value]; return; }
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i += 1) yield* stringsIn(value[i], `${at}[${i}]`); return; }
  if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) yield* stringsIn(v, at ? `${at}.${k}` : k);
}

const modelNamesIn = (s) => [...String(s).matchAll(MODEL_NAME_RE)].map((m) => m[0]);
const addressesIn = (s) => [...String(s).matchAll(ADDRESS_RE)].map((m) => m[0]);
const credentialsIn = (s) => [...String(s).matchAll(CREDENTIAL_RE)].map((m) => m[0]);
const numbersIn = (s) => [...String(s).matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => m[0].replace(",", "."));

/** Where an answer may carry a keyless public service's address: a
 *  destination's service, and a public system made from one. */
export const PUBLIC_AT = /^(?:egress\[\d+\]\.service\.address|systems\[\d+\]\.public\.address)$/;

/** The findings the drafting answer carries, as sentences the second go is
 *  handed. `ctx` is {statement, answers, vocabulary, environments}. */
export function findingsOf(arch, ctx = {}) {
  // Options are settings and inputs are material (options.mjs, the audit
  // checklist's options-are-settings and settings-declared-fully).
  const out = [];
  if (!arch || typeof arch !== "object") return ["the answer is not an architecture"];
  const vocab = ctx.vocabulary ?? [];
  const products = productWords(vocab);
  const reserved = new Set(vocab.map((s) => s.name));
  const systems = Array.isArray(arch.systems) ? arch.systems : null;
  if (!systems) out.push("systems is missing; an empty list is the answer when the agent reaches nothing outside its folder");
  for (const s of systems ?? []) {
    const name = trim(s?.name);
    if (!/^[a-z][a-z0-9-]*$/.test(name)) { out.push(`the system ${JSON.stringify(s?.name)} is not named in plain lowercase-hyphen system words`); continue; }
    if (products.has(name) || name.split("-").some((w) => products.has(w) && !reserved.has(name))) {
      out.push(`the system ${name} is named by its product; name the system (${systemForProduct(name, vocab) ?? "the reserved word for what it is"}) and keep the product in the binding`);
    }
    if (!ACCESS.includes(s?.access) && !(s?.public && PUBLIC_ACCESS.includes(s?.access))) out.push(`the system ${name} has no access (read, write or trigger)`);
    if (MODEL_SYSTEMS.includes(name)) {
      if (s.access !== "trigger") out.push(`the system ${name} is a model, reached with access trigger`);
      if (!trim(s.capability)) out.push(`the system ${name} does not say the capability the work needs (text, vision, long context, speech)`);
    }
    if (!trim(s?.why)) out.push(`the system ${name} has no reason`);
  }
  const names = (systems ?? []).map((s) => trim(s?.name));
  for (const dup of names.filter((n, i) => n && names.indexOf(n) !== i)) out.push(`the system ${dup} is named twice`);
  if (!KINDS.includes(trim(arch.kind?.kind))) out.push(`the kind ${JSON.stringify(arch.kind?.kind ?? null)} is not one of ${KINDS.join(", ")}`);
  else if (!trim(arch.kind?.why)) out.push("the kind has no reason");
  for (const f of Array.isArray(arch.formats) ? arch.formats : []) {
    const k = trim(f?.kind).split(";")[0].trim().toLowerCase();
    const piece = trim(f?.piece) || "a piece";
    if (!k) out.push(`${piece} has no kind`);
    else if (k === "application/json") out.push(`${piece} is bare application/json; say what it is: text/markdown with a convention when a person reads it or an agent hands it on, or a vendor kind such as application/vnd.agentmesh.<name>+json for exact typed data only code reads`);
    else if (k.includes("json") && !k.endsWith("+json")) out.push(`${piece} is ${k}; a JSON kind ends +json and names what the data is`);
    else if (!k.includes("/") && !VALUE_KINDS.includes(k)) out.push(`${piece} has the kind ${k}, which is neither a media type nor one of ${VALUE_KINDS.join(", ")}`);
    if (k === "text/markdown" && !trim(f?.convention)) out.push(`${piece} is Markdown with no convention; sketch its header and its fixed headings`);
    if (f?.direction === "in" && !GIVEN_BY.includes(f?.given_by)) out.push(`${piece} does not say who gives it (person, agent or either)`);
    if (f?.direction === "in" && inputIs(f?.piece, k) === "option") out.push(`${piece} only shapes how the job runs, so it is a setting with a label, an about, a default and its allowed values, not an input; inputs are only the material the job is about`);
    if (f?.direction === "in" && inputIs(f?.piece, k) === "library") out.push(`${piece} is brand or library material, so it is a standing asset the agent reads (section 10), not an input`);
    if (!trim(f?.why)) out.push(`the format of ${piece} has no reason`);
  }
  for (const s of Array.isArray(arch.settings) ? arch.settings : []) {
    const n = trim(s?.name);
    if (!n) { out.push("a setting has no name"); continue; }
    if (!("default" in (s ?? {}))) out.push(`the setting ${n} has no default`);
    const missing = settingMissing(s).filter((m) => m !== "default");
    if (missing.length) out.push(`the setting ${n} does not declare ${missing.join(", ")}; every option gets a label, an about, a default and its choices, decided now and never left open`);
    if (/url|address|host|endpoint|base/i.test(n) || addressesIn(String(s?.default ?? "")).length) out.push(`the setting ${n} is an address, and addresses are never settings`);
    if (/model/i.test(n)) out.push(`the setting ${n} chooses a model; the model is the text-reasoning binding's, placed at install, and the package declares no default for it`);
  }
  if (!Array.isArray(arch.decisions) || !arch.decisions.length) out.push("no decision is recorded; every choice the record makes is a decision with its reason");
  for (const d of Array.isArray(arch.decisions) ? arch.decisions : []) {
    if (!trim(d?.decided)) out.push("a decision says nothing was decided");
    else if (!trim(d?.why)) out.push(`the decision "${trim(d.decided)}" has no reason`);
  }
  out.push(...viewFindings(arch, ctx));
  for (const [at, s] of stringsIn(arch)) {
    for (const m of modelNamesIn(s)) out.push(`${at} names the model ${m}; state the capability and leave the model to the binding`);
    // The one address a record carries: a keyless public service's, which
    // its binding names (the architecture standard, section 2).
    if (PUBLIC_AT.test(at) && PUBLIC_ADDRESS.test(trim(s))) continue;
    for (const a of addressesIn(s)) out.push(`${at} carries the address ${a}; the record carries no address, and the owner's instruction supplies it at Deploy`);
    if (credentialsIn(s).length) out.push(`${at} carries something that looks like a credential; the record carries none`);
  }
  for (const e of arch.environments ?? []) if (!["dev", "test", "staging", "production"].includes(e)) out.push(`the environment ${e} is not one the deploy spells (dev, test, staging, production)`);
  return [...new Set(out)];
}

/** The driver keys an answer's decisions may cite: the four limits, the
 *  spec's constraints by their ids, and the further drivers it names. */
export function driverKeys(arch = {}, spec = null) {
  return new Set(driversOf({ limits: { cost: { limit: "x" } }, spec, extra: arch?.drivers }).map((d) => d.key));
}

/** The findings on the answer's views (the architecture standard, sections
 *  12 to 17): the skills it names (unless a spec named them), the parts and
 *  what each is responsible for, the data flow, the further drivers, and each
 *  decision about structure with its context, drivers, alternatives and
 *  consequences. A decision that only states a limit is a finding too: a
 *  limit is a driver the decisions cite. */
export function viewFindings(arch, ctx = {}) {
  const out = [];
  const kind = trim(arch?.kind?.kind) || "plugin-on-harness";
  const onHarness = kind === "plugin-on-harness" || kind === "bare-harness";
  const offerings = specOfferings(ctx.spec);
  const skills = Array.isArray(arch.skills) ? arch.skills : [];
  if (onHarness && !offerings.length && !skills.some((s) => trim(s?.name))) out.push("no skill is named; name each skill the harness reads, in lowercase-hyphen words, with what it is responsible for");
  for (const s of skills) {
    if (!trim(s?.name)) { out.push("a skill has no name"); continue; }
    if (!/^[a-z][a-z0-9-]*$/.test(trim(s.name))) out.push(`the skill ${JSON.stringify(s.name)} is not named in lowercase-hyphen words`);
    if (!trim(s.responsibility)) out.push(`the skill ${trim(s.name)} has no responsibility`);
  }
  for (const p of Array.isArray(arch.parts) ? arch.parts : []) {
    if (!trim(p?.name)) { out.push("a part has no name"); continue; }
    if (!trim(p.responsibility)) out.push(`the part ${trim(p.name)} has no responsibility; say what it is responsible for in one sentence`);
  }
  const flow = Array.isArray(arch.flow) ? arch.flow : [];
  if (!flow.length) out.push("the data flow is missing; give each step from one component to the next, with what passes and a sentence saying how");
  flow.forEach((s, i) => {
    if (!trim(s?.from) || !trim(s?.to)) out.push(`step ${i + 1} of the data flow does not name both of its ends`);
    if (!trim(s?.data) || !trim(s?.says)) out.push(`step ${i + 1} of the data flow does not say what passes and how`);
  });
  for (const x of Array.isArray(arch.drivers) ? arch.drivers : []) {
    if (!trim(x?.key) || !trim(x?.says)) out.push("a driver has no key or does not say what it requires");
    else if (LIMIT_DRIVERS.includes(slug(x.key))) out.push(`the driver ${trim(x.key)} is one of the four limits; give it under limits, not again under drivers`);
  }
  const keys = driverKeys(arch, ctx.spec);
  const drivers = driversOf({ limits: arch.limits ?? {}, spec: ctx.spec, extra: arch.drivers });
  const structural = (Array.isArray(arch.decisions) ? arch.decisions : []).filter((d) => d && trim(d.decided) && !isRuling(d));
  if (Array.isArray(arch.decisions) && arch.decisions.length && !structural.length) out.push("no decision chooses the agent's structure; the rulings (bindings, grants, the build's settled answers) are written for you");
  for (const raw of Array.isArray(arch.decisions) ? arch.decisions : []) {
    if (!raw || !trim(raw.decided)) continue;
    const said = trim(raw.decided);
    if (statesLimit(raw, drivers)) { out.push(`the decision "${said}" only states a limit; a limit is a driver the decisions cite, so give it under limits or drivers and decide the structure that answers it`); continue; }
    if (isRuling(raw)) continue;
    const d = decisionOf(raw);
    if (!d.context) out.push(`the decision "${said}" has no context; say the situation that called for it`);
    if (!d.drivers.length) out.push(`the decision "${said}" cites no driver; name the drivers it answers (${[...keys].join(", ")})`);
    for (const k of d.drivers) if (!keys.has(k)) out.push(`the decision "${said}" cites ${k}, which is not a driver; cite one of ${[...keys].join(", ")}, or add it under drivers`);
    if (!d.alternatives.length) out.push(`the decision "${said}" weighs no alternative; give at least one, with why it was not chosen`);
    if (!d.consequences.length) out.push(`the decision "${said}" says no consequence; say what follows from it`);
  }
  return out;
}

/** Words that make a sentence about money. */
export const MONEY_RE = /\b(?:spend|spends|spending|cost|costs|budget|usd|eur|gbp|dollars?|euros?|pounds?|cents?|credits?)\b|[$€£]/i;

/** A person's answer to a yes-or-no question: "yes", "no", or null when it
 *  says neither plainly, which is asked again rather than guessed. */
export function yesOrNo(answer) {
  const a = trim(answer).toLowerCase();
  if (/^(?:yes|y|yep|yeah|sure|granted|grant|allow|allowed|ok|okay|agreed|approved|go ahead)\b/.test(a)) return "yes";
  if (/^(?:no|n|nope|deny|denied|refuse|refused|do not|don't|never)\b/.test(a)) return "no";
  return null;
}

/** Whether two names of a destination name the same thing. */
export function sameThing(x, y) {
  const n = (s) => trim(s).toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();
  const a = n(x), b = n(y);
  return Boolean(a && b) && (a === b || a.includes(b) || b.includes(a));
}

/** What an earlier round of a record settled that the next round keeps: the
 *  spending limit, the destinations granted and refused (from its decisions),
 *  which destination each open egress question asked about, and each public
 *  service it bound to itself, by system name. */
export function carriedFrom(text = "") {
  const t = String(text ?? "");
  const decided = [...t.matchAll(/^### Decision \d+\. (.+)$/gm)].map((m) => m[1].trim());
  // The header's cost_limit (from 1.1.0); then, for a record written before
  // it, the decision that stated the limit or the Limits section's line.
  const cost = parseRecord(t)?.cost_limit
    || decided.map((d) => /^Limit what the agent spends to (.+)$/.exec(d)?.[1]).find(Boolean)
    || /^- \*\*Cost\*\*(?: \(`cost`\))?: (?!not set)(.+?)\. [A-Z]/m.exec(t)?.[1] || "";
  const publicServices = {};
  for (const [name, envs] of Object.entries(parseRecord(t)?.bindings ?? {})) {
    const b = Object.values(envs ?? {}).find((x) => x?.public);
    if (b) publicServices[name] = { address: b.address, access: b.access, approved: b.approved ?? "" };
  }
  return {
    public: publicServices,
    cost: trim(cost),
    granted: decided.map((d) => /^The agent may reach (.+)$/.exec(d)?.[1]).filter(Boolean),
    refused: decided.map((d) => /^The agent does not reach (.+)$/.exec(d)?.[1]).filter(Boolean),
    asked_egress: [...t.matchAll(/^- (egress-\d+): May this agent reach (.+?) on the network in /gm)].map((m) => ({ key: m[1], destination: m[2] })),
  };
}

/** A destination's keyless public service, when it names one whole: a
 *  system name in plain words, its access, and an address that carries no
 *  credential. Null otherwise, and the destination stays egress. */
export function publicServiceOf(d) {
  const s = d?.service;
  if (!s || typeof s !== "object") return null;
  const name = trim(s.name).toLowerCase();
  const address = trim(s.address);
  if (!/^[a-z][a-z0-9-]*$/.test(name) || MODEL_SYSTEMS.includes(name) || !PUBLIC_ADDRESS.test(address)) return null;
  return { name, access: PUBLIC_ACCESS.includes(trim(s.access)) ? trim(s.access) : "read", address };
}

const andList = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

const MODEL_PLAIN = { "text-reasoning": "a text model", "image-reading": "a vision model", "speech-to-text": "a speech model", "text-to-speech": "a voice model" };

/** Put right in code what must never reach the record, whatever the answer
 *  said, and turn each commitment it filled into a question. Returns the
 *  repaired architecture, the questions added, and a note per repair. */
export function repaired(arch, ctx = {}) {
  const a = JSON.parse(JSON.stringify(arch ?? {}));
  const notes = [];
  const questions = [];
  const vocab = ctx.vocabulary ?? [];
  const said = `${trim(ctx.statement)}\n${Object.values(ctx.answers ?? {}).join("\n")}`;

  // Model names, addresses and credential values are taken out of every
  // string. A model becomes the capability's plain words.
  const scrub = (v) => {
    if (typeof v === "string") {
      let s = v.replace(MODEL_NAME_RE, () => "the configured model");
      s = s.replace(CREDENTIAL_RE, "(a credential, left out)");
      s = s.replace(ADDRESS_RE, "(an address, supplied at Deploy)");
      return s;
    }
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]));
    return v;
  };
  // A keyless public service's address is the one address an answer may
  // carry, in its destination's service (the architecture standard, section
  // 2). It is kept out of the scrub and put back after it, and one that could
  // carry a credential (a user before the host, a query) is not kept.
  const publicAddresses = (Array.isArray(a.egress) ? a.egress : []).map((d) => {
    const v = trim(d?.service?.address);
    return d?.service && typeof d.service === "object" && PUBLIC_ADDRESS.test(v) && !credentialsIn(v).length ? v : "";
  });
  const before = JSON.stringify(a);
  const clean = scrub(a);
  if (JSON.stringify(clean) !== before) notes.push("took a model's name, an address or a credential out of the answer");
  Object.assign(a, clean);

  // A provider's name is taken out of the answer's words too: AgentMesh never
  // says which provider stands behind the House Stack, and the record goes
  // back to the person (no-provider.mjs). A system's own name is left for
  // the rename below, which names the system instead.
  const names = Array.isArray(a.systems) ? a.systems.map((s) => s?.name) : [];
  const unnamed = (v) => {
    if (typeof v === "string") return withoutProviders(v, { vocabulary: vocab });
    if (Array.isArray(v)) return v.map(unnamed);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unnamed(x)]));
    return v;
  };
  const named = JSON.stringify(a);
  Object.assign(a, unnamed(a));
  if (Array.isArray(a.systems)) a.systems.forEach((s, i) => { if (s && typeof s === "object") s.name = names[i]; });
  if (JSON.stringify(a) !== named) notes.push("took a model provider's name out of the answer");
  (Array.isArray(a.egress) ? a.egress : []).forEach((d, i) => {
    if (!d?.service || typeof d.service !== "object") return;
    if (publicAddresses[i]) d.service.address = publicAddresses[i];
    else delete d.service.address;
  });

  // A system named by its product is renamed to the system, where the
  // vocabulary says which.
  a.systems = Array.isArray(a.systems) ? a.systems : [];
  const products = productWords(vocab);
  for (const s of a.systems) {
    const name = trim(s.name).toLowerCase();
    if (products.has(name)) {
      const to = systemForProduct(name, vocab);
      if (to) { notes.push(`named the system ${to}, where the answer named it by ${providersIn(name, { vocabulary: vocab }).length ? "a model provider's name" : `its product ${name}`}`); s.product_named = name; s.name = to; }
    }
    if (MODEL_SYSTEMS.includes(s.name)) {
      if (s.access !== "trigger") s.access = "trigger";
      if (!trim(s.capability)) s.capability = MODEL_PLAIN[s.name];
    }
  }
  const seen = new Set();
  a.systems = a.systems.filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true)));

  // A spending limit nobody stated is a commitment: out, and asked. Stated
  // means its numbers stand in a sentence of the statement, an answer, or a
  // limit an earlier round of this record already settled, that speaks of
  // money: a "3" in "the 3 reports each morning" is not a budget.
  const carried = ctx.carried ?? {};
  a.limits = a.limits && typeof a.limits === "object" ? a.limits : {};
  const cost = a.limits.cost;
  const costText = trim(cost?.limit || cost?.said);
  const moneySentences = `${said}\n${trim(carried.cost)}`.split(/(?<=[.!?])\s+|\n+/).filter((x) => MONEY_RE.test(x));
  const stated = Boolean(costText) && numbersIn(costText).length > 0
    && numbersIn(costText).every((n) => moneySentences.some((x) => numbersIn(x).includes(n)));
  const answeredCost = trim(ctx.answers?.["limit-cost"]);
  a.decisions = Array.isArray(a.decisions) ? a.decisions : [];
  if (!stated && !answeredCost && trim(carried.cost)) {
    a.limits.cost = { limit: trim(carried.cost), why: "Settled in an earlier round of this record" };
  } else if (!stated && answeredCost) {
    // The limit is the cost driver, and the header's cost_limit, which the
    // Design declares as the spending system's ceiling. It is not a
    // decision: a limit is what the decisions answer.
    a.limits.cost = { limit: answeredCost, why: `The person set it in an answer (limit-cost: ${answeredCost})` };
  } else if (!stated) {
    if (costText) notes.push("took out a spending limit the statement did not state, and asked for it");
    a.limits.cost = null;
    questions.push({ key: "limit-cost", question: "What may this agent spend, and over what period (for example per job or per day)? A spending limit is a commitment somebody is held to, so it is asked and never filled in." });
  }

  // Every destination beyond the derived set is asked, unless a person's
  // answer granted it. A destination that is one keyless public service at
  // one address (its `service`: a system name, the access and the address)
  // is asked the same way, with the address in the question, and once the
  // owner says yes it is a system of the record, bound to the service itself
  // (the architecture standard, sections 2 and 7). A no leaves it out.
  // An answer is matched to its destination by what the destination is, not
  // by where it stood in a list: the earlier record's question under each
  // key names the destination it asked about. A destination granted or
  // refused in an earlier round stays so.
  a.egress = Array.isArray(a.egress) ? a.egress.filter((d) => trim(d?.destination)) : [];
  const refused = [];
  const askedBefore = carried.asked_egress ?? [];
  const used = new Set(askedBefore.map((x) => x.key));
  let next = 1;
  const freshKey = () => { while (used.has(`egress-${next}`)) next += 1; used.add(`egress-${next}`); return `egress-${next}`; };
  const envs = andList(a.environments?.length ? a.environments : ["dev", "test", "production"]);
  const carriedPublic = carried.public ?? {};
  const madeSystems = [];
  for (const d of a.egress) {
    const dest = trim(d.destination);
    const earlier = askedBefore.find((x) => sameThing(x.destination, dest));
    const key = earlier?.key;
    const answer = key ? trim(ctx.answers?.[key]) : "";
    const verdict = answer ? yesOrNo(answer) : null;
    const svc = publicServiceOf(d);
    const boundBefore = svc && !answer ? carriedPublic[svc.name] : null;
    if (verdict === "yes" || boundBefore || (!answer && (carried.granted ?? []).some((g) => sameThing(g, dest)))) {
      d.granted = true;
      if (svc) {
        madeSystems.push({ d, system: { name: svc.name, plain: dest, access: svc.access, why: trim(d.why) || `To reach ${dest}`, public: { address: svc.address, approved: key ?? boundBefore?.approved ?? "" } } });
        if (verdict === "yes") a.decisions.push({ kind: "ruling", decided: `The agent may reach ${dest}`, why: `The person granted it in an answer (${key}: ${answer})`, follows: `${dest} is the system ${svc.name}, bound to the service itself at the address the owner approved, with no key; the Design declares that address as a setting whose default it is, and the scripts hold no address of their own` });
        continue;
      }
      if (verdict === "yes") a.decisions.push({ kind: "ruling", decided: `The agent may reach ${dest}`, why: `The person granted it in an answer (${key}: ${answer})`, follows: "The offering declares reaches-network, and the destination is named in the egress of each environment" });
      continue;
    }
    if (verdict === "no" || (!answer && (carried.refused ?? []).some((g) => sameThing(g, dest)))) {
      refused.push(d);
      if (verdict === "no") a.decisions.push({ kind: "ruling", decided: `The agent does not reach ${dest}`, why: `The person said no in an answer (${key}: ${answer})`, follows: "Whatever needed it has to work without it, or the statement changes" });
      continue;
    }
    d.granted = false;
    const k = key ?? freshKey();
    // The key it is asked under, so the views can draw an asked service as
    // asked (views.mjs).
    d.asked = k;
    const named = dest.includes("(an address, supplied at Deploy)")
      ? `a destination the drafting named only by its address (${trim(d.why) || "no reason given"})`
      : dest;
    const what = svc
      ? ` (a public service with no key at ${svc.address}, reached to ${svc.access === "read-write" ? "read and write" : svc.access})`
      : "";
    const then = svc
      ? `With a yes it becomes the system ${svc.name}, bound to the service itself at that address.`
      : "It is beyond the derived set (its systems, the network, the registrar and its model), so it is a commitment: the offering must declare reaches-network, and the owner says yes or no.";
    questions.push({ key: k, question: `May this agent reach ${named}${what} on the network in ${envs}? ${then}${answer ? ` "${answer}" did not say which.` : ""} Answer "${k}: yes" or "${k}: no".` });
  }
  a.egress = a.egress.filter((d) => !refused.includes(d) && !madeSystems.some((m) => m.d === d));
  // Each approved public service is a system of the record. A system the
  // answer already names (a revision that kept it) takes the approval.
  for (const { system } of madeSystems) {
    const same = a.systems.find((s) => trim(s?.name) === system.name);
    if (same) Object.assign(same, { public: system.public, access: PUBLIC_ACCESS.includes(same.access) ? same.access : system.access });
    else a.systems.push(system);
  }
  // A system the earlier round bound to itself keeps its binding when the
  // answer names it as a system and no longer as a destination.
  for (const s of a.systems) {
    const b = carriedPublic[trim(s?.name)];
    if (b && !s.public) Object.assign(s, { public: { address: b.address, approved: b.approved }, access: PUBLIC_ACCESS.includes(s.access) ? s.access : b.access });
  }

  // A decision that only states a limit is taken out: the limit is a driver
  // the decisions cite (the architecture standard, section 16), and the
  // limits already carry it. Each decision about structure is put in the
  // record's form (views.mjs, decisionOf), and each ruling made above is
  // marked as one.
  a.decisions = a.decisions.filter((d) => trim(d?.decided));
  const drivers = driversOf({ limits: a.limits, spec: ctx.spec, extra: a.drivers });
  const limitsDecided = a.decisions.filter((d) => statesLimit(d, drivers));
  if (limitsDecided.length) notes.push(`took out ${limitsDecided.length === 1 ? "a decision that only stated a limit" : `${limitsDecided.length} decisions that only stated limits`}; a limit is a driver the decisions cite`);
  a.decisions = a.decisions.filter((d) => !limitsDecided.includes(d)).map(decisionOf);

  // Decisions without a reason are not delivered: each is asked.
  a.decisions.forEach((d, i) => {
    if (!trim(d.why)) questions.push({ key: `reason-${i + 1}`, question: `Why "${trim(d.decided)}"? A decision without a reason is not delivered, and I could not find one in the statement.` });
  });
  return { arch: a, questions, notes };
}
