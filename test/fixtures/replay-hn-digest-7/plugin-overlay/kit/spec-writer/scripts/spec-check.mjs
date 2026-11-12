// Does the spec hold to what Requirements owes the stages after it?
//
// stages.json 1.6.0 says Requirements is done when every feature has
// requirements and at least one acceptance scenario a test can check, every
// requirement comes from what the person said or from a behavior of the
// as-built record, and nothing unsettled was invented. Each of those is read
// here by rule, with no model, and so is the shape (spec-v1):
//
//   - the spec is valid against standards/spec.schema.json, and its ids are
//     unique;
//   - every feature has requirements and at least one acceptance scenario,
//     each scenario checks requirement ids the spec has, and each is Gherkin
//     with a Scenario line and Given, When and Then steps;
//   - every quote, refusal and rule value of the as-built record, for each
//     behavior the spec keeps, is in some requirement's exact byte for byte,
//     and every interface of the record is in the spec's interfaces under
//     its name;
//   - no exact value is one the given does not state (an invented one goes
//     to open, never into a test);
//   - the name, the price and access to any system are the person's: a name
//     they did not give is the stand-in with the question open, a price they
//     did not set is absent with the question open, and a system the given
//     does not name is not reached.
//
// What these find goes back to the model once (spec.mjs); after that,
// fitSpec does what code can without guessing, and what still stands is said.
//
//   needs: node >= 22. Nothing here reads or writes a file.
//   import { specProblems, fitSpec, corpusOf } from "./spec-check.mjs"
import { validateSpec } from "./spec-v1.mjs";
import { STAND_IN_NAME, recordFixes } from "./seed.mjs";
import { ADDRESS_SETTING, FETCHING } from "./reaches.mjs";

const trim = (s) => String(s ?? "").trim();
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);

/** A Gherkin scenario's parts, by its step keywords at the start of a line. */
export function gherkinProblems(text) {
  const t = String(text ?? "");
  const out = [];
  if (!/^\s*Scenario(?: Outline)?:/m.test(t)) out.push("has no Scenario: line");
  for (const k of ["Given", "When", "Then"]) if (!new RegExp(`^\\s*${k}\\b`, "m").test(t)) out.push(`has no ${k} step`);
  return out;
}

/** Every requirement of the spec, the features' and the constraints', with
 *  the feature it is under (null for a constraint). */
export function requirementsOf(spec) {
  return [
    ...list(spec?.features).flatMap((f) => list(f?.requirements).map((r) => ({ r, feature: f }))),
    ...list(spec?.constraints).map((r) => ({ r, feature: null })),
  ];
}

/** Every exact value the spec fixes. */
export const exactsOf = (spec) => requirementsOf(spec).flatMap(({ r }) => list(r?.exact).map(String));

/** What the given states, as one body of text to look values up in: the
 *  person's words and answers, every attachment as it came and every string
 *  and number inside one that is JSON, and an earlier spec they approved.
 *  `stated(v)` says whether a value is in it byte for byte. */
export function corpusOf(asked = null, answers = null, { record = null, earlier = null, extra = [] } = {}) {
  const parts = [];
  const walk = (v) => {
    if (typeof v === "string") parts.push(v);
    else if (typeof v === "number") parts.push(String(v));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (isObj(v)) { for (const [k, x] of Object.entries(v)) { parts.push(k); walk(x); } }
  };
  if (trim(asked?.said)) parts.push(String(asked.said));
  for (const a of list(asked?.attached)) {
    if (typeof a?.text !== "string") continue;
    parts.push(a.text);
    if (/^\s*[[{]/.test(a.text)) { try { walk(JSON.parse(a.text)); } catch { /* text only */ } }
  }
  if (record) for (const k of ["behaviors", "interfaces", "architecture", "tests", "record", "strings", "schemas"]) walk(record[k]);
  if (isObj(answers)) walk(answers);
  if (earlier) walk(earlier);
  walk(extra);
  const text = parts.join("\n");
  return { text, stated: (v) => text.includes(String(v)) };
}

/** The ids the spec carries, and each one said twice. */
function idProblems(spec) {
  const seen = new Map();
  const out = [];
  const see = (id, where) => { if (!trim(id)) return; if (seen.has(id)) out.push(`the id ${id} is used twice (${seen.get(id)} and ${where}); every id is stable and says one thing`); else seen.set(id, where); };
  for (const f of list(spec?.features)) {
    see(f?.id, "a feature");
    for (const r of list(f?.requirements)) {
      see(r?.id, `a requirement of ${f?.id}`);
      if (trim(r?.id) && trim(f?.id) && !trim(r.id).startsWith(`${trim(f.id)}.R`)) out.push(`requirement ${r.id} is under ${f.id}; a feature's requirements are ${f.id}.R1, ${f.id}.R2 and on`);
    }
    for (const a of list(f?.acceptance)) {
      see(a?.id, `a scenario of ${f?.id}`);
      if (trim(a?.id) && trim(f?.id) && !trim(a.id).startsWith(`${trim(f.id)}.A`)) out.push(`scenario ${a.id} is under ${f.id}; a feature's scenarios are ${f.id}.A1, ${f.id}.A2 and on`);
    }
  }
  for (const c of list(spec?.constraints)) see(c?.id, "a constraint");
  for (const i of list(spec?.interfaces)) see(i?.id, "an interface");
  const keys = new Set();
  for (const o of list(spec?.open)) { if (keys.has(trim(o?.key))) out.push(`the open question ${trim(o.key)} is asked twice`); keys.add(trim(o?.key)); }
  return out;
}

/** Each feature checkable: requirements, and scenarios in Gherkin that check
 *  requirements the spec has. */
export function featureProblems(spec) {
  const ids = new Set(requirementsOf(spec).map(({ r }) => trim(r?.id)));
  const out = [];
  for (const f of list(spec?.features)) {
    const id = trim(f?.id) || "a feature with no id";
    if (!list(f?.requirements).length) out.push(`feature ${id} has no requirements; every feature says what it shall do`);
    if (!list(f?.acceptance).length) out.push(`feature ${id} has no acceptance scenario; write at least one Gherkin scenario (Scenario, Given, When, Then) that checks its requirements, so a test can be written from it`);
    for (const a of list(f?.acceptance)) {
      const at = trim(a?.id) || `a scenario of ${id}`;
      for (const p of gherkinProblems(a?.gherkin)) out.push(`scenario ${at} ${p}; a scenario is Gherkin: a Scenario: line, then Given, When and Then steps`);
      const checks = list(a?.checks).map(trim);
      if (!checks.length) out.push(`scenario ${at} checks no requirement; name the ids it checks in checks`);
      for (const c of checks) if (!ids.has(c)) out.push(`scenario ${at} checks ${c}, which is no requirement of the spec`);
    }
    for (const r of list(f?.requirements)) if (!/\bshall\b/.test(String(r?.shall ?? ""))) out.push(`requirement ${trim(r?.id)} is not a statement with shall`);
  }
  return out;
}

/** What the as-built record fixes that the spec does not carry byte for byte. */
export function recordProblems(spec, record = null, { targets = new Set() } = {}) {
  if (!record) return [];
  const exacts = exactsOf(spec);
  const names = list(spec?.interfaces).flatMap((i) => [trim(i?.name), trim(i?.signature), ...list(i?.flags)]);
  const out = [];
  const missing = [];
  for (const fix of recordFixes(record, spec)) {
    if (fix.where === "exact") {
      if (!exacts.some((e) => e === fix.value || e.includes(fix.value))) missing.push(fix);
    } else {
      const i = fix.interface;
      // A declaration is found by where it is declared, since two may share
      // a name; every other interface by its name and kind.
      const there = i.kind === "declaration"
        ? list(spec?.interfaces).find((x) => trim(x?.kind) === "declaration" && trim(x?.declared_in) === i.declared_in)
        : list(spec?.interfaces).find((x) => trim(x?.name) === i.name && trim(x?.kind) === i.kind);
      if (!there) { out.push(`the as-built record's ${i.kind} interface ${i.as_built}, ${i.kind === "declaration" ? `declared at ${i.declared_in}` : i.name}, is not in the spec's interfaces${i.kind === "declaration" ? " at that place" : " under that name"}; a rebuild keeps it exactly, unless you loosen or drop it`); continue; }
      // An interface the person's words name in a revision is theirs to change.
      if (targets.has(trim(there.id))) continue;
      for (const flag of list(i.flags)) if (!list(there.flags).includes(flag)) out.push(`interface ${there.id} (${i.name}) does not carry the flag ${flag} the record gives it`);
      for (const flag of list(i.required_flags)) if (!list(there.required_flags).includes(flag)) out.push(`interface ${there.id} (${i.name}) does not carry ${flag} among the flags it requires, as the record gives it`);
      if ("value" in i && there.keep !== false && JSON.stringify(there.value) !== JSON.stringify(i.value)) out.push(`interface ${there.id} (${i.kind} ${i.kind === "declaration" ? i.declared_in : i.name}) is kept as ${JSON.stringify(there.value)}, and the record gives ${JSON.stringify(i.value)}; a kept value is the record's, byte for byte`);
      if (isObj(i.values) && JSON.stringify(there.values) !== JSON.stringify(i.values)) out.push(`interface ${there.id} (${i.name}) does not carry the allowed values the record gives it: ${JSON.stringify(i.values)}`);
    }
  }
  if (missing.length) {
    const by = new Map();
    for (const m of missing) by.set(m.behavior, [...(by.get(m.behavior) ?? []), m]);
    for (const [b, ms] of by) out.push(`the as-built record fixes these for ${b}, and no requirement's exact carries them byte for byte: ${ms.map((m) => JSON.stringify(m.value)).join(", ")}`);
  }
  return out;
}

/** Exact values the given does not state. */
export function inventedValues(spec, corpus) {
  if (!corpus) return [];
  const out = [];
  for (const { r } of requirementsOf(spec)) for (const v of list(r?.exact)) if (!corpus.stated(v)) out.push({ id: trim(r.id), value: String(v) });
  return out;
}

/** The three that are the person's, and access to any system. `person` is
 *  what they settled ({name, version, price}); `stated(v)` reads the given. */
export function personProblems(spec, person = {}, corpus = null) {
  const out = [];
  const keys = new Set(list(spec?.open).map((o) => trim(o?.key)));
  const name = trim(spec?.product?.name);
  if (person.name ? name !== person.name : name !== STAND_IN_NAME) out.push(person.name ? `the product's name is ${JSON.stringify(name)}, and the person named it ${person.name}; the name is theirs` : `the product's name ${JSON.stringify(name)} was not given; a name is the person's to choose, so it stays ${STAND_IN_NAME} and "name" is asked in open`);
  if (!person.name && !keys.has("name")) out.push(`the name is not settled and "name" is not asked in open`);
  if (person.price ? trim(spec?.price) !== person.price : trim(spec?.price)) out.push(person.price ? `the price is ${JSON.stringify(trim(spec?.price))}, and the person set it as ${JSON.stringify(person.price)}` : `the price ${JSON.stringify(trim(spec?.price))} was not given; a price is the person's money, so it is left out and "price" is asked in open`);
  if (!person.price && !trim(spec?.price) && !keys.has("price")) out.push(`no price is set and "price" is not asked in open`);
  if (corpus) {
    for (const s of list(spec?.systems)) {
      if (trim(s?.reach) === "none") continue;
      const named = (trim(s?.address) && corpus.stated(trim(s.address))) || (trim(s?.name) && corpus.text.toLowerCase().includes(trim(s.name).toLowerCase()));
      if (!named) out.push(`the system ${JSON.stringify(trim(s?.name))} is not named in what was given; access to a system is the person's to grant, so it is left out and "systems" is asked in open`);
    }
  }
  return out;
}

const EMPTY_WORDS = /\b(no|none|nothing|empty|zero)\b/i;

/** What Requirements is done with (stages.json 1.7.0): every requirement is
 *  checked by a scenario, and what the agent refuses, what it does when it
 *  finds nothing to work on, and what it does when a system it reaches fails
 *  are each stated. The ADLC plugin's Requirements check runs this same rule,
 *  so a spec this agent calls ready is never held in the build folder. */
export function coverageProblems(spec) {
  const out = [];
  // The features' requirements: a constraint has no scenario of its own.
  const reqs = list(spec?.features).flatMap((f) => list(f?.requirements));
  const checked = new Set(list(spec?.features).flatMap((f) => list(f?.acceptance).flatMap((a) => list(a?.checks).map(trim))));
  for (const r of reqs) if (trim(r?.id) && !checked.has(trim(r.id))) out.push(`requirement ${trim(r.id)} is checked by no scenario; every requirement has a scenario a test can be written from`);
  if (!reqs.some((r) => trim(r?.kind) === "refusal")) out.push("no requirement is a refusal; say what the agent refuses (kind refusal), each from the person's words");
  if (!reqs.some((r) => trim(r?.kind) !== "refusal" && EMPTY_WORDS.test(String(r?.shall ?? ""))))
    out.push("the empty case is not stated; say what the agent does when it is given nothing to work on or finds nothing (a requirement whose shall says so), and ask the person where their words do not say");
  if (!reqs.some((r) => trim(r?.kind) === "error"))
    out.push("the failure case is not stated; say what the agent does when a system it reaches fails or answers wrongly (kind error), and ask the person where their words do not say");
  return out;
}

/** What the agent's own files are later held to for a system the agent reaches (reaches.mjs,
 *  reachProblems), said here, at Requirements, where the spec can still change: a public
 *  service names its own `address`, unless its why says it fetches whatever address the
 *  caller hands it; and its address is never a setting of the spec (a setting carries no
 *  value, so the files would declare an address with no default). A service that takes a
 *  credential may have its address installed as a setting, as before. */
export function systemAddressProblems(spec) {
  const out = [];
  for (const s of list(spec?.systems)) {
    if (!isObj(s) || trim(s.reach) === "none" || !trim(s.name)) continue;
    const name = trim(s.name);
    const publicRead = s.credential === undefined || s.credential === null || s.credential === "none";
    if (!publicRead) continue;
    const addressSettings = list(s.settings).filter((st) => isObj(st) && ADDRESS_SETTING.test(trim(st.env)));
    for (const st of addressSettings) out.push(`system ${name} lists its address as the setting ${trim(st.env)}, and a service that takes no key carries its address in \`address\`, with no setting for it; put the address in \`address\` and take the setting out`);
    if (!trim(s.address) && !addressSettings.length && !FETCHING.test(String(s.why ?? ""))) out.push(`system ${name} is reached over the network and the spec gives no \`address\` for it; give the address it is reached at, or, where it reaches whatever address the caller hands it, say so in its why with the word fetches`);
  }
  return out;
}

/** Every problem with a spec, as sentences a model can act on. */
export function specProblems(spec, { record = null, corpus = null, person = {}, targets = new Set() } = {}) {
  if (!isObj(spec)) return ["the spec is not an object"];
  return [
    ...validateSpec(spec),
    ...idProblems(spec),
    ...featureProblems(spec),
    ...coverageProblems(spec),
    ...systemAddressProblems(spec),
    ...recordProblems(spec, record, { targets }),
    ...inventedValues(spec, corpus).map((x) => `requirement ${x.id} fixes ${JSON.stringify(x.value)}, which nothing given states; a value nobody gave is asked in open, never fixed`),
    ...personProblems(spec, person, corpus),
  ];
}

// ---------- what code does after the last go ----------

/** A scenario code writes for a feature the model left without one: from its
 *  requirements, each named by its id, so a test can still be named for it.
 *  It is said in the notes, so a reader knows to read it. */
export function scenarioOf(f) {
  const reqs = list(f?.requirements);
  const ins = list(f?.inputs).map((d) => trim(d?.name)).filter(Boolean);
  const lines = [
    `Scenario: ${trim(f?.name) || trim(f?.id)}`,
    `  Given ${trim(f?.as_built) ? `what ${trim(f.as_built)} is given` : "what the feature is given"}${ins.length ? `: ${ins.join(", ")}` : ""}`,
    `  When the agent does what ${trim(f?.id)} does`,
    ...reqs.map((r, i) => `  ${i ? "And" : "Then"} ${trim(r.id)} holds: ${trim(r.shall).replace(/\s+/g, " ")}`),
  ];
  return { gherkin: lines.join("\n"), checks: reqs.map((r) => trim(r.id)) };
}

/** The spec with what code can settle without guessing, after the last go:
 *  a scenario's checks that name no requirement are taken out, a scenario
 *  that is not Gherkin is taken out, a feature left without a scenario gets
 *  one code writes from its requirements, the ids of scenarios are numbered
 *  in order, an exact value nothing given states goes to open, a name or a
 *  price the person did not give is taken back and asked, and a system the
 *  given does not name is taken out and asked. Returns { spec, notes }. */
export function fitSpec(spec, { person = {}, corpus = null } = {}) {
  const s = structuredClone(spec);
  const notes = [];
  const open = list(s.open).filter((o) => isObj(o) && trim(o.key));
  const ask = (key, question) => { if (!open.some((o) => o.key === key)) open.push({ key, question }); };
  const ids = () => new Set(requirementsOf(s).map(({ r }) => trim(r?.id)));
  const wrote = [];
  for (const f of list(s.features)) {
    for (const r of list(f.requirements)) {
      if (!/\bshall\b/.test(String(r.shall ?? ""))) { r.shall = `The agent shall ${trim(r.shall).replace(/^the agent\s+/i, "").replace(/^./, (c) => c.toLowerCase()) || "do what this requirement says"}`; notes.push(`${r.id} was not written with shall, and now is.`); }
    }
    const known = ids();
    const kept = [];
    for (const a of list(f.acceptance)) {
      if (!isObj(a) || gherkinProblems(a.gherkin).length) continue;
      const checks = list(a.checks).map(trim).filter((c) => known.has(c));
      kept.push({ ...a, checks: checks.length ? checks : list(f.requirements).map((r) => r.id) });
    }
    if (!kept.length && list(f.requirements).length) { kept.push(scenarioOf(f)); wrote.push(f.id); }
    f.acceptance = kept.map((a, i) => ({ id: `${f.id}.A${i + 1}`, gherkin: a.gherkin, checks: a.checks }));
  }
  if (wrote.length) notes.push(`Code wrote the acceptance scenario of ${wrote.join(", ")} from ${wrote.length === 1 ? "its" : "their"} requirements, because none came that was Gherkin; read ${wrote.length === 1 ? "it" : "them"} hardest.`);
  if (corpus) {
    const invented = inventedValues(s, corpus);
    for (const { id, value } of invented) {
      const at = requirementsOf(s).find(({ r }) => trim(r.id) === id)?.r;
      if (at) at.exact = list(at.exact).filter((v) => String(v) !== value);
      if (at && !at.exact.length) delete at.exact;
      ask(`value in ${id}`, `${id} would fix ${JSON.stringify(value)}, which nothing you gave states. What should it be?`);
    }
    if (invented.length) notes.push(`${invented.length === 1 ? "One value" : `${invented.length} values`} nobody gave ${invented.length === 1 ? "was" : "were"} taken out of exact and asked: ${invented.map((x) => x.id).join(", ")}.`);
    const unnamed = list(s.systems).filter((x) => trim(x?.reach) !== "none" && !((trim(x?.address) && corpus.stated(trim(x.address))) || (trim(x?.name) && corpus.text.toLowerCase().includes(trim(x.name).toLowerCase()))));
    if (unnamed.length) {
      s.systems = list(s.systems).filter((x) => !unnamed.includes(x));
      ask("systems", `The draft would reach ${unnamed.map((x) => trim(x.name)).join(" and ")}, which nothing you gave names. Should it, and with what access?`);
      notes.push(`${unnamed.map((x) => trim(x.name)).join(" and ")} ${unnamed.length === 1 ? "was" : "were"} taken out of systems and asked.`);
    }
  }
  s.product = isObj(s.product) ? s.product : {};
  if (person.name) s.product.name = person.name;
  else if (trim(s.product.name) !== STAND_IN_NAME) { if (trim(s.product.name)) notes.push(`The name ${JSON.stringify(trim(s.product.name))} was not yours, so it was taken back and asked.`); s.product.name = STAND_IN_NAME; }
  if (!person.name) ask("name", "What should this agent be called? It becomes its handle on the mesh and cannot be changed later without a redeploy.");
  if (person.version) s.product.version = person.version;
  if (!/^\d+\.\d+\.\d+$/.test(trim(s.product.version))) s.product.version = "0.1.0";
  if (!trim(s.product.kind)) s.product.kind = "agent";
  if (person.price) s.price = person.price;
  else if (trim(s.price)) { notes.push(`The price ${JSON.stringify(trim(s.price))} was not yours, so it was taken back and asked.`); delete s.price; }
  if (!person.price) ask("price", "What should this cost per job, or should it be free? Flat is the usual answer.");
  // A question the person settled is not asked again.
  s.open = open.filter((o) => !(o.key === "name" && person.name) && !(o.key === "price" && person.price));
  return { spec: s, notes };
}
