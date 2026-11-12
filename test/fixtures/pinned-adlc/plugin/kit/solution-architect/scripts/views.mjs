// The architecture's views: the agent's own components and what each is
// responsible for, the connectors between them and to the systems outside,
// how it runs and where each system is bound, the data flow, and the drivers
// its decisions cite (the architecture standard, sections 12 to 17).
//
// Code fills what code can know, and the model writes what is judgment. The
// carrier comes from the kind (a harness, the agent's own service, a
// container). The skills come from the spec's offerings, or from the skills
// the answer names, and each skill on a harness runs one script. The outside
// systems come from the record. The connectors come from the systems and
// their bindings: a model through the shared caller and its four settings, a
// keyless public service at the address its binding names, any other system
// through its bound product. The model writes each responsibility, the parts
// of each script, the flow's wording and the decisions' text.
//
// The checks here hold the views together before a record is called
// finished: every component has a responsibility, every connector names both
// ends, the flow has steps, every architectural decision has its drivers, an
// alternative and its consequences, and no limit stands as a decision. A
// limit is a driver: a quality requirement the decisions answer, carried by
// the record and decided by nobody here.
//
//   needs: node >= 22. Pure: nothing here reads a file or the network.
import { MODEL_SYSTEMS } from "./no-provider.mjs";
import { RULING_RE, isRuling } from "./architecture-record.mjs";

export { RULING_RE, isRuling };

const trim = (s) => String(s ?? "").trim();
const noStop = (s) => trim(s).replace(/[.\s]+$/, "");
const list = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** A name as an id: lowercase words joined by hyphens. */
export const slug = (s) => trim(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** The end of a connector or a flow step outside the agent: whoever sent the
 *  job, a person or an agent. */
export const CALLER = "caller";

/** What carries the agent, by its kind. */
export const CARRIERS = {
  "plugin-on-harness": { id: "harness", name: "the harness", kind: "harness" },
  "bare-harness": { id: "harness", name: "the harness", kind: "harness" },
  "mesh-coded": { id: "service", name: "the agent's service", kind: "service" },
  "third-party-framework": { id: "container", name: "the container", kind: "container" },
};

/** The kinds of component a record names. */
export const COMPONENT_KINDS = ["harness", "service", "container", "skill", "script", "part", "system"];

/** The four limits the record has always carried, now its first drivers. */
export const LIMIT_DRIVERS = ["cost", "speed", "data", "trust"];

/** The model system's four settings (Common Agent Section 12.4.1). */
export const MODEL_SETTINGS = ["MODEL_NAME", "MODEL_ENDPOINT", "MODEL_KEY", "MODEL_PROTOCOL"];

/** A decision that only states a limit: what the agent may spend, how fast
 *  it must answer, how much it may hold. A limit is a driver, not a decision. */
export const LIMIT_DECISION_RE = /^(?:limit\b|cap\b|keep (?:the )?(?:spend|spending|cost)\b|(?:spend|cost)s? (?:at most|no more than|up to|under|below)\b|(?:answer|respond|reply|finish)(?:s|es)? (?:with)?in\b|hold (?:at most|no more than)\b)/i;

/** Whether a decision only states a limit. */
export function statesLimit(d, drivers = []) {
  const said = trim(d?.decided);
  if (!said) return false;
  if (LIMIT_DECISION_RE.test(said)) return true;
  const n = (s) => trim(s).toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();
  return drivers.some((x) => n(x.says).length >= 6 && n(said) === n(x.says));
}

/** An architectural decision in the record's form, from what the answer gave:
 *  its context, the drivers it answers (by key), why, the alternatives weighed
 *  (each an option and why it was not chosen) and its consequences. An answer
 *  in the earlier form (`weighed`, `follows`) is read as one alternative and
 *  one consequence. A ruling is kept as it came. */
export function decisionOf(d) {
  if (!d || typeof d !== "object") return d;
  if (isRuling(d)) return { ...d, kind: "ruling" };
  const alternatives = (Array.isArray(d.alternatives) ? d.alternatives : typeof d.alternatives === "string" ? [d.alternatives] : [])
    .map((a) => (typeof a === "string" ? { option: trim(a) } : { option: trim(a?.option), ...(trim(a?.why_not) ? { why_not: trim(a.why_not) } : {}) }))
    .filter((a) => a.option);
  if (!alternatives.length && trim(d.weighed)) alternatives.push({ option: trim(d.weighed) });
  const consequences = (Array.isArray(d.consequences) ? d.consequences : typeof d.consequences === "string" ? [d.consequences] : []).map(trim).filter(Boolean);
  if (!consequences.length && trim(d.follows)) consequences.push(trim(d.follows));
  const drivers = (Array.isArray(d.drivers) ? d.drivers : typeof d.drivers === "string" ? d.drivers.split(",") : []).map((x) => trim(x)).filter(Boolean);
  const out = { decided: trim(d.decided), kind: "structure", context: trim(d.context), drivers: [...new Set(drivers)], why: trim(d.why), alternatives, consequences };
  return out;
}

/** The spec's offerings, the skills a harness reads (one skill per offering,
 *  Common Agent Section 12.6, rule 2), or [] when no spec came. A spec whose
 *  features name no offering has one, named after the product. */
export function specOfferings(spec) {
  if (!spec || typeof spec !== "object") return [];
  const named = [...new Set((spec.offerings ?? []).map(slug).filter(Boolean))];
  if (named.length) return named;
  const product = slug(spec.product);
  return product ? [product] : [];
}

/** The skills: the spec's offerings where a spec came, else the skills the
 *  answer names. Each with what it is responsible for and its script's. */
export function skillsOf(arch = {}, spec = null) {
  const named = (Array.isArray(arch.skills) ? arch.skills : []).filter((s) => s && slug(s.name));
  const byName = (n) => named.find((s) => slug(s.name) === n);
  const offerings = specOfferings(spec);
  const names = offerings.length ? offerings : [...new Set(named.map((s) => slug(s.name)))];
  return names.map((n) => ({ name: n, responsibility: trim(byName(n)?.responsibility), script: trim(byName(n)?.script), from: offerings.length ? "the spec" : "the answer" }));
}

/** What the code-known components are responsible for, where the answer
 *  says nothing of its own. Each follows from the kind alone. */
function carrierDuty(kind, skills) {
  if (kind === "mesh-coded") return "Answers each job on the network itself and runs the parts below for it.";
  if (kind === "third-party-framework") return "Runs the program inside it for each job and hands its answer back.";
  if (kind === "bare-harness") return "Reads the skills and does each job itself, with no script of its own.";
  return skills.length > 1
    ? "Starts the script of the skill a job asks for, once per job, hands it the job's input and settings, and sends back what it writes as the reply."
    : "Starts the skill's script once per job, hands it the job's input and settings, and sends back what it writes as the reply.";
}
/** What an outside system is there for, from the record's own words: a model
 *  by the capability the work needs, any other system by why it is reached. */
function systemDuty(s) {
  if (MODEL_SYSTEMS.includes(s.name)) return `The model behind the shared caller, for ${noStop(s.capability) || "the text the work needs"}`;
  return noStop(s.why);
}
const scriptDuty = (skill) => `The program the ${skill} skill runs: it reads the job's input and settings from its flags, calls the parts below, and writes the reply.`;

/** The components: the carrier, each skill and its script, the parts of
 *  each script, and the systems outside. `asked` are keyless public services
 *  still asked as destinations, each {name, key, plain, why}: they are drawn,
 *  marked as asked, so the flow can be read before the owner answers. */
export function componentsOf({ kind = "plugin-on-harness", skills = [], parts = [], systems = [], asked = [], responsibilities = {} } = {}) {
  const carrier = CARRIERS[kind] ?? CARRIERS["plugin-on-harness"];
  const duty = (id) => trim(responsibilities?.[id]);
  const out = [{ ...carrier, responsibility: duty(carrier.id) || carrierDuty(kind, skills), from: duty(carrier.id) ? "the answer" : "the kind" }];
  const ids = new Set([carrier.id, CALLER]);
  const take = (id) => { let x = id || "part"; while (ids.has(x)) x = `${x}-part`; ids.add(x); return x; };
  const onHarness = kind === "plugin-on-harness" || kind === "bare-harness" || !CARRIERS[kind];
  const homes = {};
  if (onHarness) {
    for (const s of skills) {
      const skill = take(`skill-${s.name}`);
      out.push({ id: skill, name: s.name, kind: "skill", within: carrier.id, responsibility: s.responsibility, from: s.from });
      homes[s.name] = skill;
      if (kind !== "bare-harness") {
        const script = take(`script-${s.name}`);
        out.push({ id: script, name: `scripts/${s.name}.mjs`, kind: "script", within: skill, responsibility: trim(s.script) || scriptDuty(s.name), from: trim(s.script) ? "the answer" : "the skill" });
        homes[s.name] = script;
      }
    }
  }
  const systemIds = new Set([...systems.map((s) => trim(s?.name)), ...asked.map((a) => trim(a?.name))].filter(Boolean));
  const only = Object.values(homes);
  for (const p of Array.isArray(parts) ? parts : []) {
    if (!p || !trim(p.name)) continue;
    const want = slug(p.id || p.name);
    const id = take(systemIds.has(want) ? `${want}-part` : want);
    const home = homes[slug(p.within)] ?? (only.length === 1 ? only[0] : only[0] ?? carrier.id);
    out.push({ id, name: trim(p.name), kind: "part", within: home, responsibility: trim(p.responsibility), ...(slug(p.reaches) ? { reaches: slug(p.reaches) } : {}), from: "the answer" });
  }
  for (const s of systems) {
    if (!trim(s?.name)) continue;
    out.push({ id: s.name, name: trim(s.plain) || s.name, kind: "system", outside: true, responsibility: duty(s.name) || systemDuty(s), from: duty(s.name) ? "the answer" : "the record's systems" });
    ids.add(s.name);
  }
  for (const a of asked) {
    if (!trim(a?.name) || ids.has(a.name)) continue;
    out.push({ id: a.name, name: trim(a.plain) || a.name, kind: "system", outside: true, asked: trim(a.key), responsibility: duty(a.name) || systemDuty({ name: a.name, why: a.why }), from: "the egress asked" });
    ids.add(a.name);
  }
  return out.map((c) => (c.responsibility ? { ...c, responsibility: noStop(c.responsibility) } : c));
}

/** How a part or a script reaches one system: the shared model caller for a
 *  model, the address its binding names for a keyless public service, the
 *  bound product for anything else. */
function reachOf(system, asked) {
  if (MODEL_SYSTEMS.includes(system.name)) {
    return `through the shared model caller (scripts/model-caller.mjs) and its four settings, ${list(MODEL_SETTINGS)}, read on every call (Common Agent Section 12.4.1)`;
  }
  const pub = system.public ?? (asked ? { address: asked.address } : null);
  if (pub) {
    const scheme = /^https:/i.test(trim(pub.address)) ? "HTTPS" : "HTTP";
    return `over ${scheme}, with no key, at the address its binding names, read from a setting and never written into a script (Common Agent Section 12.6, rule 2)${asked ? `, once the owner says yes in ${asked.key}` : ""}`;
  }
  return "through the product bound to it in each environment, with the credential and address the install places (Common Agent Section 12.4)";
}

/** The connectors: the job in, the harness to each script, each part (or
 *  script) to each system it reaches, and the reply out. Each names both of
 *  its ends, how the two are joined, and what it carries where the flow says. */
export function connectorsOf({ kind = "plugin-on-harness", components = [], systems = [], asked = [], formats = [], settings = [], flow = [] } = {}) {
  const carrier = components.find((c) => ["harness", "service", "container"].includes(c.kind)) ?? { id: "harness" };
  const scripts = components.filter((c) => c.kind === "script");
  const skills = components.filter((c) => c.kind === "skill");
  // Without a script (a bare harness, a service, a container) the carrier
  // itself reaches the systems and writes the reply.
  const runners = scripts.length ? scripts : [carrier];
  const inputs = formats.filter((f) => f?.direction === "in").map((f) => trim(f.piece)).filter(Boolean);
  const outputs = formats.filter((f) => f?.direction === "out");
  const names = settings.map((s) => trim(s?.name)).filter(Boolean);
  // What a connector carries is what the flow says passes between its ends,
  // either way, where it says so: a read carries data back to whoever reads.
  const carried = (from, to) => [...new Set(flow.filter((s) => (s.from === from && s.to === to) || (s.from === to && s.to === from)).map((s) => noStop(s.data)).filter(Boolean))];
  const out = [];
  const add = (c) => { const said = carried(c.from, c.to); out.push(said.length ? { ...c, carries: list(said) } : c); };
  add({ from: CALLER, to: carrier.id, how: kind === "mesh-coded" ? "a job sent on the network, which the service answers itself" : "a job message, which the host hands to the harness", carries: inputs.length ? list(inputs) : "the job's message" });
  if (kind === "bare-harness") for (const s of skills) add({ from: carrier.id, to: s.id, how: "the harness reads the skill's instructions and does the job itself" });
  for (const s of scripts) {
    add({
      from: carrier.id, to: s.id,
      how: `by command: node ${s.name}, started once per job, with the job's input${names.length ? ` and the setting${names.length === 1 ? "" : "s"} ${list(names)}` : ""} as flags (the job's run, Common Agent Section 12.3)`,
      carries: list([...(inputs.length ? inputs : ["the job's input"]), ...(names.length ? ["the settings"] : [])]),
    });
  }
  const sysComponents = components.filter((c) => c.kind === "system");
  for (const sc of sysComponents) {
    const system = systems.find((s) => s.name === sc.id) ?? { name: sc.id };
    const ask = asked.find((a) => a.name === sc.id && sc.asked);
    const parts = components.filter((c) => c.kind === "part" && c.reaches === sc.id);
    const from = parts.length ? parts : runners;
    for (const f of from) add({ from: f.id, to: sc.id, access: trim(system.access) || (ask ? trim(ask.access) || "read" : ""), how: reachOf(system, ask) });
  }
  for (const r of runners) {
    const pieces = outputs.length ? outputs.map((f) => `${trim(f.piece)} (\`${trim(f.kind)}\`)`) : ["the reply"];
    add({
      from: r.id, to: CALLER,
      how: r.kind === "script" ? "written to the script's standard output, which the harness hands back as the job's reply" : kind === "mesh-coded" ? "answered on the network as the job's reply" : "handed back as the job's reply",
      carries: list(pieces),
    });
  }
  return out;
}

/** The runtime and deployment view: how the agent runs, from its kind, and
 *  what each system is bound to in each environment, from the bindings. */
export function runtimeOf({ kind = "plugin-on-harness", systems = [], environments = [], note = "" } = {}) {
  const runs = {
    "plugin-on-harness": "Runs once per job: the harness starts the skill's script as a command, and the process ends when the reply is written. It has no service of its own, opens no port and keeps no process between jobs.",
    "bare-harness": "Runs once per job inside the harness, which reads the skills; it has no script and no service of its own.",
    "mesh-coded": "Runs as its own long-lived service that answers on the network itself, one per environment.",
    "third-party-framework": "Runs as somebody else's program in its own container, one per environment, started by the deploy.",
  }[kind] ?? "Runs once per job under a harness.";
  const word = (b) => {
    if (!b || b.unbound) return "unbound: asked";
    if (b.public) return `the service itself at ${trim(b.address)}, no key, ${trim(b.access) || "read"}`;
    return `${trim(b.label) && b.label !== b.product ? `${b.product} (${b.label})` : trim(b.product)}, ${b.provided_by === "customer" ? "the organization's choice" : "a platform default"}`;
  };
  return {
    runs,
    per_job: kind !== "mesh-coded" && kind !== "third-party-framework",
    own_service: kind === "mesh-coded" || kind === "third-party-framework",
    environments: environments.map((e) => ({ environment: e, systems: systems.map((s) => ({ system: s.name, binding: word(s.bindings?.[e]) })) })),
    ...(trim(note) ? { note: noStop(note) } : {}),
  };
}

/** The data flow, as the answer wrote it, with each end read as a component:
 *  by its id, by its name, or the caller. A step whose end is not a component
 *  of the record (a service the owner said no to, say) is left out, and said. */
export function flowOf(steps = [], components = []) {
  const ids = new Map();
  for (const c of components) { ids.set(c.id, c.id); ids.set(slug(c.name), c.id); }
  // A skill on a harness runs its script, so a step to the skill is a step
  // to the script that does its work.
  for (const s of components.filter((c) => c.kind === "script")) {
    const skill = components.find((c) => c.id === s.within);
    if (skill) { ids.set(skill.id, s.id); ids.set(slug(skill.name), s.id); }
  }
  for (const w of ["caller", "the-caller", "person", "the-person", "sender", "the-sender", "requester"]) ids.set(w, CALLER);
  const end = (x) => ids.get(trim(x)) ?? ids.get(slug(x)) ?? null;
  const flow = [];
  const left = [];
  for (const s of Array.isArray(steps) ? steps : []) {
    if (!s || typeof s !== "object") continue;
    const from = end(s.from);
    const to = end(s.to);
    const step = { from: from ?? trim(s.from), to: to ?? trim(s.to), data: noStop(s.data), says: noStop(s.says) };
    if (!from || !to) { left.push(step); continue; }
    flow.push(step);
  }
  return { flow, left };
}

/** The drivers: the quality requirements and constraints the decisions
 *  answer. The four limits come first, each with where it came from; then the
 *  spec's constraints, by their ids; then any further quality requirement
 *  the answer drew from the statement. */
export function driversOf({ limits = {}, spec = null, extra = [] } = {}) {
  const out = [];
  for (const key of LIMIT_DRIVERS) {
    const l = limits?.[key];
    out.push({ key, quality: key, says: noStop(l?.limit || l?.said), why: noStop(l?.why), from: key === "cost" ? (trim(l?.limit || l?.said) ? "the cost limit the record carries" : "asked (limit-cost)") : "the statement" });
  }
  for (const c of Array.isArray(spec?.constraints) ? spec.constraints : []) {
    if (!trim(c?.id) || out.some((d) => d.key === trim(c.id))) continue;
    out.push({ key: trim(c.id), quality: trim(c.kind) || "constraint", says: noStop(c.shall), why: "", from: `the spec, ${trim(c.id)}` });
  }
  for (const x of Array.isArray(extra) ? extra : []) {
    const key = slug(x?.key || x?.quality);
    if (!key || out.some((d) => d.key === key) || !trim(x?.says)) continue;
    out.push({ key, quality: trim(x.quality) || key, says: noStop(x.says), why: noStop(x.why), from: trim(x.from) ? `the statement: "${noStop(x.from)}"` : "the statement" });
  }
  return out;
}

/** Why the views are not finished, one sentence each. Empty when they are. */
export function viewProblems(rec = {}) {
  const p = [];
  const components = Array.isArray(rec.components) ? rec.components : [];
  const ids = new Set([CALLER, ...components.map((c) => c.id)]);
  if (!components.length) p.push("the record names no component");
  for (const c of components) {
    if (!trim(c.responsibility)) p.push(`the component ${c.name} has no responsibility`);
    if (c.within && !ids.has(c.within)) p.push(`the component ${c.name} sits within ${c.within}, which is not a component`);
  }
  const connectors = Array.isArray(rec.connectors) ? rec.connectors : [];
  for (const k of connectors) {
    if (!ids.has(k?.from) || !ids.has(k?.to)) p.push(`the connector from ${trim(k?.from) || "nothing"} to ${trim(k?.to) || "nothing"} does not name both of its ends`);
    else if (!trim(k?.how)) p.push(`the connector from ${k.from} to ${k.to} does not say how the two are joined`);
  }
  for (const c of components.filter((x) => x.kind === "system")) if (!connectors.some((k) => k.to === c.id || k.from === c.id)) p.push(`nothing connects to ${c.id}`);
  if (!trim(rec.runtime?.runs)) p.push("the record has no runtime and deployment view");
  const flow = Array.isArray(rec.flow) ? rec.flow : [];
  if (!flow.length) p.push("the data flow has no step");
  flow.forEach((s, i) => { if (!trim(s.data) || !trim(s.says)) p.push(`step ${i + 1} of the data flow does not say what passes and how`); });
  const drivers = Array.isArray(rec.drivers) ? rec.drivers : [];
  const keys = new Set(drivers.map((d) => d.key));
  const decisions = Array.isArray(rec.decisions) ? rec.decisions : [];
  const structural = decisions.filter((d) => !isRuling(d));
  if (!structural.length) p.push("the record makes no decision about the agent's structure");
  for (const d of decisions) if (statesLimit(d, drivers)) p.push(`the decision "${trim(d.decided)}" states a limit; a limit is a driver the decisions cite, not a decision`);
  for (const d of structural) {
    const said = trim(d.decided);
    if (!(d.drivers ?? []).length) p.push(`the decision "${said}" cites no driver`);
    for (const k of d.drivers ?? []) if (!keys.has(k)) p.push(`the decision "${said}" cites ${k}, which is not one of the record's drivers`);
    if (!(d.alternatives ?? []).length) p.push(`the decision "${said}" weighs no alternative`);
    if (!(d.consequences ?? []).length) p.push(`the decision "${said}" says no consequence`);
  }
  return p;
}
