// The architecture record's form: a Markdown document for the person, with a
// structured header for the bindings, so the next stage and a test can read
// what is bound where without parsing prose.
//
// The header is front matter, written as YAML: `field: value` lines, the lists
// as flow sequences, the statement quoted, and one nested block for the
// bindings. This file reads it back without a YAML library, and reads the
// plain forms a person writes by hand too (a block list, a quoted scalar). It
// is written from the same facts as the body, by renderRecord, so the two
// cannot disagree.
//
// The spec writer carries a copy of this file (agents/spec-writer/scripts/
// architecture-record.mjs) to read a record its Design is given, and a test
// there holds the two copies equal. Change them together.
//
//   needs: node >= 22. Nothing here reads or writes a file.

/** The record's format word, the first line of every header. */
export const RECORD = "architecture-record-v1";

/** The header's fields, in order, and the body's fixed headings, in order.
 *  The architecture standard (standards/architecture-standard.md, section 9)
 *  names the same lists. From the standard's 2.0.0 the body carries the
 *  architecture's views (Components, Connectors, Runtime and deployment, Data
 *  flow), and Drivers takes the place of Limits; the header is unchanged. */
export const HEADER_FIELDS = ["record", "statement", "environments", "kind", "done", "questions", "systems", "standing_assets", "cost_limit", "bindings"];
export const HEADINGS = ["Statement", "Systems", "Bindings", "Dependencies", "Kind", "Components", "Connectors", "Runtime and deployment", "Data flow", "Drivers", "Egress", "Formats", "Standing assets", "Settings", "Decisions", "Questions"];

/** The access a public service may be reached with, and how its address may
 *  be written: http or https, a host, a path, and nothing that could carry a
 *  credential (no user before the host and no query). */
export const PUBLIC_ACCESS = ["read", "write", "read-write"];
export const PUBLIC_ADDRESS = /^https?:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d+)?(?:\/[^\s?#@]*)?$/i;

/** The environments a record may bind, in the words the deploy into each uses
 *  (Common Agent 8.3), and the stack's word for each. */
export const ENVIRONMENTS = ["dev", "test", "staging", "production"];
export const STACK_WORD = { dev: "development", test: "staging", staging: "staging", production: "production" };

const trim = (s) => String(s ?? "").trim();
const oneLine = (s) => trim(s).replace(/\s+/g, " ");

/** A binding as the header spells it: the product and who provides it, or
 *  `unbound (asked)` where the record asks instead of binding. A keyless
 *  public service is bound to the service itself, and its binding names the
 *  address, says it takes no key, gives the access and records the owner's
 *  approval: `itself at <address>, no key, read, approved by the owner in
 *  egress-1` (the architecture standard, section 2). */
export function bindingWord(b) {
  if (!b || b.unbound) return "unbound (asked)";
  if (b.public) return `itself at ${trim(b.address)}, no key, ${trim(b.access) || "read"}, approved by the owner${trim(b.approved) ? ` in ${trim(b.approved)}` : ""}`;
  return `${trim(b.product)} (${b.provided_by === "customer" ? "customer" : "platform"})`;
}

/** A public binding read back from its header words, or null. */
export function publicBinding(value) {
  const m = /^itself at (\S+?),\s*no key,\s*(read-write|read|write),\s*approved by the owner(?: in ([a-z][a-z0-9-]*))?$/.exec(trim(value));
  if (!m || !PUBLIC_ADDRESS.test(m[1])) return null;
  return { public: true, product: "itself", address: m[1], key: "none", access: m[2], ...(m[3] ? { approved: m[3] } : {}) };
}

/** The spending limit a record carries, in the words it was set in, or "". */
const costOf = (rec) => oneLine(rec.limits?.cost?.limit || rec.limits?.cost?.said || "");

/** The header, as text between the two `---` lines. */
export function headerOf(rec) {
  const systems = (rec.systems ?? []).map((s) => s.name);
  const lines = [
    `record: ${RECORD}`,
    // Quoted, so a colon or a hash in the person's words stays their words.
    // cut-ok: the header shows the statement's first 240 characters; the body's Statement section quotes it whole.
    `statement: ${JSON.stringify(oneLine(rec.statement).slice(0, 240) || "(none given)")}`,
    `environments: [${(rec.environments ?? []).join(", ")}]`,
    `kind: ${trim(rec.kind?.kind) || "not settled"}`,
    `done: ${rec.done ? "yes" : "no"}`,
    `questions: ${(rec.questions ?? []).length}`,
    `systems: [${systems.join(", ")}]`,
    // The schemas the record decided (standard section 10), or none. A record
    // written before the section has no line, and reads as not decided.
    ...(rec.standing_assets ? [`standing_assets: ${rec.standing_assets.schemas?.length ? `[${rec.standing_assets.schemas.join(", ")}]` : "none"}`] : []),
    // The spending limit, in the words it was set in, so the Design can
    // declare it as the ceiling of the spending system without reading prose.
    `cost_limit: ${costOf(rec) ? JSON.stringify(costOf(rec)) : "not set"}`,
  ];
  if (systems.length) {
    lines.push("bindings:");
    for (const s of rec.systems) {
      lines.push(`  ${s.name}:`);
      for (const env of rec.environments ?? []) lines.push(`    ${env}: ${bindingWord(s.bindings?.[env])}`);
    }
  } else {
    lines.push("bindings: none");
  }
  return lines.join("\n");
}

const noStop = (s) => oneLine(s).replace(/[.\s]+$/, "");
const COUNT = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const bullet = (s) => `- ${oneLine(s)}`;
const sentence = (s) => { let t = oneLine(s); if (t) t = t[0].toUpperCase() + t.slice(1); return !t ? "" : /[.!?]$/.test(t) ? t : `${t}.`; };

/** The statement the record was written from, quoted whole, so a revision
 *  and the Design read the same words the architecture answered. */
function statementSection(rec) {
  const t = trim(rec.statement);
  return t ? t.split(/\r?\n/).map((l) => `> ${l}`.trimEnd()).join("\n") : "> (no statement was given)";
}

/** The statement a record quotes, read back from its body. */
export function statementIn(text) {
  const body = bodyOf(text);
  const at = body.search(/^## Statement\s*$/m);
  if (at < 0) return "";
  const out = [];
  for (const line of body.slice(at).split(/\r?\n/).slice(1)) {
    if (/^## /.test(line)) break;
    if (/^>/.test(line)) out.push(line.replace(/^> ?/, ""));
  }
  return out.join("\n").trim();
}

function systemsSection(rec) {
  if (!(rec.systems ?? []).length) return "This agent reaches no system outside its own folder.";
  return rec.systems.map((s) => {
    const bits = [`\`${s.name}\` (${oneLine(s.plain || s.name)}), ${s.access}`];
    if (trim(s.capability)) bits.push(`for ${oneLine(s.capability)}`);
    if (s.public) bits.push("a public service with no key, which the owner approved");
    return `${bits.join(", ")}: ${sentence(s.why)}`;
  }).map(bullet).join("\n");
}

function bindingsSection(rec) {
  if (!(rec.systems ?? []).length) return "Nothing to bind.";
  const envs = rec.environments ?? [];
  const head = `| System | ${envs.join(" | ")} |\n|---|${envs.map(() => "---").join("|")}|`;
  const rows = rec.systems.map((s) => `| ${s.name} | ${envs.map((e) => {
    const b = s.bindings?.[e];
    if (!b || b.unbound) return "unbound: asked";
    if (b.public) return `the service itself at ${trim(b.address)}, no key, approved by the owner`;
    const who = b.provided_by === "customer" ? "the organization's choice" : "platform default";
    return `${trim(b.label) && b.label !== b.product ? `${b.product} (${b.label})` : b.product}, ${who}`;
  }).join(" | ")} |`);
  return [head, ...rows].join("\n");
}

function listOr(items, empty, render) {
  return (items ?? []).length ? items.map(render).map(bullet).join("\n") : empty;
}

const KIND_WORD = { harness: "the harness", service: "the agent's own service", container: "a container", skill: "a skill", script: "a script", part: "a part", system: "an outside system" };

/** The components, each under the one it sits within, then the systems
 *  outside, each with what it is responsible for (the standard, section 12). */
function componentsSection(rec) {
  const all = rec.components ?? [];
  if (!all.length) return "Not described.";
  const lines = [];
  const one = (c, depth) => {
    const asked = c.asked ? `, asked in ${c.asked}` : "";
    const reach = trim(c.reaches) ? ` It reaches \`${c.reaches}\`.` : "";
    lines.push(`${"  ".repeat(depth)}- **${oneLine(c.name)}** (\`${c.id}\`), ${KIND_WORD[c.kind] ?? c.kind}${asked}: ${sentence(c.responsibility) || "no responsibility given."}${reach}`);
    for (const k of all.filter((x) => x.within === c.id && !x.outside)) one(k, depth + 1);
  };
  const inside = all.filter((c) => !c.outside);
  const ids = new Set(inside.map((c) => c.id));
  for (const c of inside.filter((x) => !x.within || !ids.has(x.within))) one(c, 0);
  for (const c of all.filter((x) => x.outside)) one(c, 0);
  return lines.join("\n");
}

/** The connectors, each naming both of its ends (the standard, section 13). */
function connectorsSection(rec) {
  return listOr(rec.connectors, "Not described.", (k) => `\`${k.from}\` to \`${k.to}\`${trim(k.access) ? `, ${k.access}` : ""}: ${oneLine(k.how)}${trim(k.carries) ? `; it carries ${noStop(k.carries)}` : ""}.`);
}

/** How the agent runs, and what each system is bound to where it runs (the
 *  standard, section 14). */
function runtimeSection(rec) {
  const r = rec.runtime;
  if (!r || !trim(r.runs)) return "Not described.";
  const lines = [sentence(r.runs), ""];
  for (const e of r.environments ?? []) {
    lines.push(bullet(`${e.environment}: ${(e.systems ?? []).length ? e.systems.map((s) => `\`${s.system}\` on ${noStop(s.binding)}`).join("; ") : "no system to bind"}.`));
  }
  if (trim(r.note)) lines.push("", sentence(r.note));
  return lines.join("\n").trim();
}

/** The data flow, in order, each step from one component to another (the
 *  standard, section 15). */
function flowSection(rec) {
  const steps = rec.flow ?? [];
  if (!steps.length) return "Not described.";
  return steps.map((s, i) => `${i + 1}. \`${s.from}\` to \`${s.to}\`, ${noStop(s.data)}: ${sentence(s.says)}`).join("\n");
}

/** The decisions that cite a driver, by their number in the record. */
const citing = (rec, key) => orderedDecisions(rec).map((d, i) => ((d.drivers ?? []).includes(key) ? i + 1 : 0)).filter(Boolean);

/** The drivers the decisions answer: the quality requirements and
 *  constraints, each with where it came from (the standard, section 16). The
 *  four limits keep their place at the top, so a reader of an earlier record
 *  finds them where they were. */
function driversSection(rec) {
  const drivers = rec.drivers?.length ? rec.drivers : ["cost", "speed", "data", "trust"].map((key) => ({ key, quality: key, says: oneLine(rec.limits?.[key]?.limit || rec.limits?.[key]?.said), why: rec.limits?.[key]?.why }));
  return drivers.map((d) => {
    const word = d.quality === d.key ? d.key[0].toUpperCase() + d.key.slice(1) : `${oneLine(d.quality)[0]?.toUpperCase() ?? ""}${oneLine(d.quality).slice(1)}`;
    const says = trim(d.says) ? `${noStop(d.says)}.${trim(d.why) ? ` ${sentence(d.why)}` : ""}` : d.key === "cost" ? "not set; asked, because a spending limit is a commitment." : "not set.";
    const from = trim(d.from) && !/^(?:the statement|the cost limit the record carries|asked \(limit-cost\))$/.test(trim(d.from)) ? ` From ${noStop(d.from)}.` : "";
    const cited = citing(rec, d.key);
    const by = cited.length ? ` Cited by decision${cited.length === 1 ? "" : "s"} ${list(cited.map(String))}.` : "";
    return bullet(`**${word}** (\`${d.key}\`): ${says}${from}${by}`);
  }).join("\n");
}

function egressSection(rec) {
  const out = [];
  for (const env of rec.environments ?? []) {
    const policy = rec.egress_policy?.[env] ?? "not known";
    out.push(`${env}: the target runs the agent ${policy === "allowlist" ? "behind an allowlist" : policy === "open" ? "open (it enforces no allowlist today)" : `${policy}`}.`);
  }
  const dests = rec.egress ?? [];
  out.push(dests.length
    ? `Beyond the derived set (its systems, the network, the registrar, the model it is given): ${dests.map((d) => `${oneLine(d.destination)}${d.granted ? " (granted by the person)" : " (asked)"}, ${noStop(d.why)}`).join("; ")}.`
    : "None beyond the derived set (its systems, the network, the registrar, the model it is given).");
  return out.map(bullet).join("\n");
}

function formatsSection(rec) {
  return listOr(rec.formats, "Nothing passes in or out beyond the reply.", (f) => {
    const dir = f.direction === "in" ? "takes" : "hands back";
    const who = f.direction === "in" && trim(f.given_by) ? `, given by ${f.given_by === "either" ? "a person or an agent" : `a ${f.given_by}`}` : "";
    const conv = trim(f.convention) ? `; ${noStop(f.convention)}` : "";
    return `It ${dir} ${oneLine(f.piece)} as \`${trim(f.kind)}\`${who}${conv}. ${sentence(f.why)}`;
  });
}

/** For each kind of output a person reads, the standing assets that apply and
 *  why, or none and why (the architecture standard, section 10). */
function standingSection(rec) {
  const sa = rec.standing_assets;
  if (!sa) return "Not decided: the list of standing-asset kinds was not read, so this record does not say which apply.";
  const lines = [];
  for (const o of sa.outputs ?? []) {
    const what = `**${oneLine(o.piece)}** (\`${trim(o.kind)}\`${o.classes?.length ? `, ${o.classes.join(" and ")}` : ""})`;
    if (!(o.assets ?? []).length) { lines.push(bullet(`${what}: none.`)); continue; }
    lines.push(bullet(`${what}: ${o.assets.map((a) => `the ${oneLine(a.word || a.schema)} (\`${a.schema}\`), because ${noStop(a.why)}`).join("; ")}.`));
  }
  if (trim(sa.note)) lines.push(bullet(`Note: ${noStop(sa.note)}.`));
  if (trim(sa.none)) lines.push(bullet(`None, because ${noStop(sa.none)}.`));
  else lines.push(bullet(`The Design declares exactly these as \`can_use\`, each with what it reads, what it does with it and what it does \`without\` it: ${(sa.schemas ?? []).map((x) => `\`${x}\``).join(", ")}.`));
  return lines.join("\n");
}

function settingsSection(rec) {
  const choices = (s) => {
    if (Array.isArray(s.allowed) && s.allowed.length) {
      const label = (v) => (s.value_labels && trim(s.value_labels[String(v)]) ? ` (${oneLine(s.value_labels[String(v)])})` : "");
      return `, one of ${s.allowed.map((v) => `${JSON.stringify(v)}${label(v)}`).join(", ")}`;
    }
    return ["min", "max", "step"].some((k) => k in s) ? `, from ${s.min ?? "?"} to ${s.max ?? "?"} in steps of ${s.step ?? "?"}` : "";
  };
  const lines = (rec.settings ?? []).map((s) => `\`${trim(s.name)}\`${trim(s.label) ? ` ("${oneLine(s.label)}")` : ""}, a ${s.kind === "rule" ? "rule" : "preference"} with the default ${JSON.stringify(s.default)}${choices(s)}${s.job_may_set ? ", which a sender may set for one job" : ""}: ${trim(s.about) ? `${sentence(s.about)} ` : ""}${sentence(s.why)}`);
  return lines.length ? lines.map(bullet).join("\n") : "No setting beyond the bindings' own.";
}

/** A ruling: a rule of the standard applied, or an answer a person or the
 *  build gave (a binding, a destination granted or refused, a settled
 *  answer). Everything else the record decides is a decision about the
 *  agent's structure. */
export const RULING_RE = /^(?:bind [a-z0-9-]+ to\b|the agent (?:may reach|does not reach|reaches)\b|reach a model only through\b|nobody attends a job\b)/i;
export const isRuling = (d) => d?.kind === "ruling" || Boolean(d?.from_binding) || RULING_RE.test(trim(d?.decided));

/** The decisions in the record's order: those about structure first, then
 *  the rulings, each group as it came. */
export function orderedDecisions(rec) {
  const all = rec.decisions ?? [];
  return [...all.filter((d) => !isRuling(d)), ...all.filter(isRuling)];
}

const list = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** One decision about structure, in the manner of an architecture decision
 *  record: its context, the drivers it answers, why, the alternatives weighed
 *  and its consequences (the standard, section 17). */
function structureDecision(d, i, rec) {
  const drivers = rec.drivers ?? [];
  const driver = (k) => { const x = drivers.find((y) => y.key === k); return `\`${k}\`${x && trim(x.says) ? ` (${noStop(x.says)})` : ""}`; };
  const alternatives = (d.alternatives ?? []).length ? d.alternatives : trim(d.weighed) ? [{ option: d.weighed }] : [];
  const consequences = (d.consequences ?? []).length ? d.consequences : trim(d.follows) ? [d.follows] : [];
  return [
    `### Decision ${i + 1}. ${oneLine(d.decided)}`,
    ...(trim(d.context) ? ["", `Context: ${sentence(d.context)}`] : []),
    "", `Drivers: ${(d.drivers ?? []).length ? `${d.drivers.map(driver).join("; ")}.` : "none cited."}`,
    "", `Why: ${sentence(d.why) || "no reason given."}`,
    "", "Alternatives:", "",
    ...(alternatives.length ? alternatives.map((a) => bullet(`${noStop(a.option)}${trim(a.why_not) ? `: not chosen, because ${noStop(a.why_not)}` : ""}.`)) : ["- None weighed."]),
    "", "Consequences:", "",
    ...(consequences.length ? consequences.map((c) => bullet(sentence(c))) : ["- None said."]),
  ].join("\n");
}

/** A ruling, as the record has always written its decisions. */
function rulingDecision(d, i) {
  return [
    `### Decision ${i + 1}. ${oneLine(d.decided)}`,
    "",
    `Why: ${sentence(d.why) || "no reason given."}`,
    ...(trim(d.weighed) ? ["", `Weighed: ${sentence(d.weighed)}`] : []),
    ...(trim(d.follows) ? ["", `What follows: ${sentence(d.follows)}`] : []),
  ].join("\n");
}

function decisionsSection(rec) {
  const all = orderedDecisions(rec);
  if (!all.length) return "No decision was made.";
  const n = all.filter((d) => !isRuling(d)).length;
  const span = (a, b) => (a === b ? `Decision ${a}` : b === a + 1 ? `Decisions ${a} and ${b}` : `Decisions ${a} to ${b}`);
  const lead = n && n < all.length
    ? `${span(1, n)} ${n === 1 ? "chooses" : "choose"} the agent's structure. ${span(n + 1, all.length)} ${all.length - n === 1 ? "is a ruling" : "are rulings"}: the standard's rules applied, and the answers a person or the build gave.`
    : n ? `${span(1, n)} ${n === 1 ? "chooses" : "choose"} the agent's structure.` : `${span(1, all.length)} ${all.length === 1 ? "is a ruling" : "are rulings"}: the standard's rules applied, and the answers a person or the build gave. No decision chooses the agent's structure.`;
  return [lead, ...all.map((d, i) => (isRuling(d) ? rulingDecision(d, i) : structureDecision(d, i, rec)))].join("\n\n");
}

function questionsSection(rec) {
  return (rec.questions ?? []).length
    ? rec.questions.map((q) => `- ${q.key}: ${oneLine(q.question)}`).join("\n")
    : "None. Every system is named and bound in each environment, and every decision has its reason.";
}

/** The whole record, header and body. */
export function renderRecord(rec) {
  const title = oneLine(rec.title) || "an agent";
  const body = [
    `# Architecture record: ${title}`,
    "",
    rec.done
      ? "This record is finished: every system is named and bound in each environment, and every decision has its reason."
      : `This record is not finished: ${(rec.questions ?? []).length === 1 ? "one question is" : `${COUNT[(rec.questions ?? []).length] ?? (rec.questions ?? []).length} questions are`} still open, under Questions.`,
    "",
    "## Statement", "", statementSection(rec), "",
    "## Systems", "", systemsSection(rec), "",
    "## Bindings", "", bindingsSection(rec), "",
    "## Dependencies", "", listOr(rec.dependencies, "None.", (d) => `**${oneLine(d.name)}** (${d.what === "agent" ? "an agent" : "a service"}): ${sentence(d.why)}`), "",
    "## Kind", "", `**${trim(rec.kind?.kind) || "not settled"}**: ${sentence(rec.kind?.why) || "no reason given."}`, "",
    "## Components", "", componentsSection(rec), "",
    "## Connectors", "", connectorsSection(rec), "",
    "## Runtime and deployment", "", runtimeSection(rec), "",
    "## Data flow", "", flowSection(rec), "",
    "## Drivers", "", driversSection(rec), "",
    "## Egress", "", egressSection(rec), "",
    "## Formats", "", formatsSection(rec), "",
    "## Standing assets", "", standingSection(rec), "",
    "## Settings", "", settingsSection(rec), "",
    "## Decisions", "", decisionsSection(rec), "",
    "## Questions", "", questionsSection(rec), "",
  ].join("\n");
  return `---\n${headerOf(rec)}\n---\n\n${body}`;
}

/** The body alone, without the header: what a reader compares between two
 *  versions of one record. */
export function bodyOf(text) {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(String(text ?? ""));
  return m ? String(text).slice(m[0].length) : String(text ?? "");
}

/** Read a record's header back, or null when the text is not an architecture
 *  record. Returns the fields, with `environments` and `systems` as lists,
 *  `done` as a boolean, `questions` as a number, `bindings` as
 *  {system: {environment: {product, provided_by} | {unbound: true} |
 *  {public: true, product: "itself", address, key: "none", access,
 *  approved}}}, `standing_assets` as a list of schemas ([] for none, null
 *  when the record does not say), and `cost_limit` as the words of the
 *  spending limit ("" when none is set). */
/** A scalar as YAML would read it: a double-quoted one as JSON, a single-quoted
 *  one with its quotes taken off, anything else trimmed. */
function unquote(v) {
  const t = trim(v);
  if (/^"(?:[^"\\]|\\.)*"$/.test(t)) { try { return JSON.parse(t); } catch { return t.slice(1, -1); } }
  if (/^'.*'$/.test(t)) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

const BOM = new RegExp("^" + String.fromCharCode(0xfeff));
export function parseRecord(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? "").replace(BOM, ""));
  if (!m) return null;
  const out = { bindings: {} };
  let inBindings = false;
  let system = null;
  let listing = null;
  for (const raw of m[1].split(/\r?\n/)) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    // A block list under a top-level key, as a person writes YAML by hand.
    const item = /^-\s+(.+)$/.exec(line);
    if (item && listing) { out[listing].push(unquote(item[1])); continue; }
    const at = line.indexOf(":");
    if (at < 0) continue;
    const key = line.slice(0, at).trim(); // cut-ok: the key is the text before the colon; the value is read after it
    const value = line.slice(at + 1).trim();
    if (indent === 0) {
      inBindings = key === "bindings" && !value;
      system = null;
      listing = null;
      if (key === "bindings") continue;
      if (!value && (key === "systems" || key === "environments" || key === "standing_assets")) { out[key] = []; listing = key; continue; }
      out[key] = value;
      continue;
    }
    if (!inBindings) continue;
    if (indent <= 2 && !value) { system = key; out.bindings[system] = {}; continue; }
    if (system) {
      const pub = publicBinding(value);
      if (pub) { out.bindings[system][key] = pub; continue; }
      const b = /^(.+?)\s*\((customer|platform|asked)\)$/.exec(value);
      out.bindings[system][key] = !b || b[2] === "asked" || /^unbound\b/.test(value)
        ? { unbound: true }
        : { product: b[1].trim(), provided_by: b[2] };
    }
  }
  if (unquote(out.record) !== RECORD) return null;
  const list = (v) => {
    if (Array.isArray(v)) return v.filter(Boolean);
    const t = trim(v).replace(/^\[/, "").replace(/\]$/, "");
    return !t || t === "none" ? [] : t.split(",").map(unquote).filter(Boolean);
  };
  return {
    record: unquote(out.record),
    statement: unquote(out.statement),
    environments: list(out.environments),
    kind: trim(out.kind),
    done: trim(out.done) === "yes",
    questions: Number(out.questions) || 0,
    systems: list(out.systems),
    bindings: typeof out.bindings === "object" ? out.bindings : {},
    // null when the record has no line (written before the standard's
    // section 10), [] when it says none.
    standing_assets: out.standing_assets === undefined ? null : list(out.standing_assets),
    // "" when the record sets none, or was written before the field.
    cost_limit: out.cost_limit === undefined || trim(out.cost_limit) === "not set" ? "" : unquote(out.cost_limit),
  };
}

/** The open questions a record carries under its Questions heading, as
 *  {key, question}, so a later message can be matched to the one it answers. */
export function questionsIn(text) {
  const body = bodyOf(text);
  const at = body.search(/^## Questions\s*$/m);
  if (at < 0) return [];
  const rest = body.slice(at).split(/\r?\n/).slice(1);
  const out = [];
  for (const line of rest) {
    if (/^## /.test(line)) break;
    const q = /^- ([a-z][a-z0-9-]*): (.+)$/.exec(line.trim());
    if (q) out.push({ key: q[1], question: q[2] });
  }
  return out;
}
