// The agent's own files, their structure written from the spec by code.
//
// In the round trip on hn-reader (2026-11-09) the spec was carried across
// exactly and its revisions were exact edits, but the Design was a fresh
// model draft every time: asked to rename one output, it renamed the
// offering, its step and its skill folder too; asked to undo that, it also
// flipped the output's name back. The build could never pass, because the
// agent's files disagreed with the spec. So from 0.10.0 three rules hold:
//
//   1. code copies facts, and the model only describes. Every structural
//      field of the files is written here from the spec, never by the model:
//      the offering ids, step ids and skill folder names (from the spec's
//      declarations when it keeps them, else from its features' offerings),
//      each input's and output's name, kind and schema (declarations, else
//      the spec's pieces and file interfaces), the labels the spec keeps, the
//      run-config settings (the spec's settings), the systems and their
//      address settings (the spec's systems, and each model system the
//      architecture record names; an address only in a setting's
//      default), each run command in the packaged form {home}/{package}/
//      skills/<slug>/scripts/... with the flags its command interface keeps,
//      the scripts, the runtimes, the records and the price. The model writes
//      only the prose: what the agent and each job does, when each is the
//      right one, what a good result is, what happens when there is nothing
//      to give, each job's instructions, each piece's about, each system's
//      needs and the refusals;
//   2. code checks the files against the stage before: every declaration the
//      spec keeps is at its place in the files with its value
//      (declared.mjs), and the package maker's own check runs as before;
//   3. a change is an edit. A revision recomputes the structure from the
//      spec, so it changes only when the spec does; the prose changes only
//      where the person's words name it, and every other prose field stays
//      byte for byte, checked here (proseUnchangedProblems).
//
//   needs: node >= 22. Nothing here reads or writes a file.
//   import { structureOf, placeDeclarations, proseSlots, namedProse, mergeProse } from "./structure.mjs"
import { declarationsOf, isProductField } from "./declared.mjs";
import { priceNamed } from "./given.mjs";
import { STAND_IN_NAME } from "./seed.mjs";
import { hostOf, sameAddress } from "./reaches.mjs";
import { conventionHeadings } from "./check-spec.mjs";

const trim = (s) => String(s ?? "").trim();
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);
const clone = (v) => (v === undefined ? undefined : structuredClone(v));

/** The model systems a job reaches as bound capabilities (Common Agent
 *  12.4.1), by name, and the request formats the shared caller speaks. */
export const MODEL_SYSTEMS = ["text-reasoning", "image-reading", "speech-to-text", "text-to-speech"];
export const MODEL_PROTOCOLS = ["anthropic-messages", "openai-chat", "gemini"];

/** The flags a house command takes, and what the host puts after each. A
 *  file flag is repeated once per attached file (run.per_file), because the
 *  host fills {file_path} there and nowhere else. */
export const FLAG_VALUES = {
  "--job": "{job_dir}", "--records": "{records}", "--work": "{work}",
  "--text-file": "{job_dir}/message.txt", "--message-file": "{job_dir}/message.txt",
  "--sender": "{sender}", "--handle": "{handle}", "--message-id": "{message_id}", "--in-reply-to": "{in_reply_to}",
};
export const FILE_FLAGS = { "--file": "{file_path}::{file_media_type}" };

/** The command a job runs when the spec names no command: the house form. */
export const HOUSE_FLAGS = ["--job", "--records", "--work", "--text-file"];

/** The records every package declares, and the one a package that ships
 *  went-without.mjs declares with it (check-spec.mjs, recordProblems). */
export const MANIFEST_RECORD = { name: "the signed job manifest of each delivery", when: "per_task" };
export const WENT_WITHOUT_RECORD = { name: "what the job did not have and did anyway", when: "per_task", file: "*/went-without.json" };

/** Text as a slug: lower case letters, digits and hyphens, opening with a
 *  letter, at most 63 characters, cut at a hyphen. */
export function slugOf(text, fallback = "the-job") {
  let s = trim(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^[^a-z]+/, "");
  if (s.length > 63) s = s.slice(0, 63).replace(/-[^-]*$/, "");
  return s.length >= 3 ? s : fallback;
}

/** A slug as a title: "read-the-tides" is "Read the tides". */
export const titleOf = (slug) => { const t = trim(slug).replace(/[-_]+/g, " "); return t ? t[0].toUpperCase() + t.slice(1) : t; };

/** A setting's name as a label: "how_many" is "How many". */
const labelOf = (name) => titleOf(trim(name).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase());

/** A file's path as a piece's name: "out/stories.json" is "stories". */
export const pieceName = (path) => trim(path).replace(/\\/g, "/").split("/").pop().replace(/\.[a-z0-9]+$/i, "");

/** The kind of a file, from its extension, when the spec gives none. */
export function kindOfFile(path) {
  const p = trim(path).toLowerCase();
  if (p.endsWith(".json")) return `application/vnd.agentmesh.${slugOf(pieceName(p), "data")}+json`;
  if (p.endsWith(".md")) return "text/markdown";
  if (p.endsWith(".txt")) return "text/plain";
  if (p.endsWith(".html")) return "text/html";
  if (p.endsWith(".csv")) return "text/csv";
  return "document";
}

const isAddress = (v) => typeof v === "string" && /^[a-z][a-z0-9+.-]*:\/\//i.test(v.trim());

/** A JSON Schema with every constant and allowed value that is an address
 *  taken out: the package maker refuses a descriptor that carries one, and
 *  the spec keeps it. Returns { schema, taken }. */
export function schemaWithoutAddresses(schema) {
  let taken = 0;
  const walk = (s) => {
    if (Array.isArray(s)) return s.map(walk);
    if (!isObj(s)) return s;
    const out = {};
    for (const [k, v] of Object.entries(s)) {
      // The dialect's own address names a format and holds no value of the
      // piece's, so it goes without a word.
      if ((k === "$schema" || k === "$id") && isAddress(v)) continue;
      if (k === "const" && isAddress(v)) { taken += 1; continue; }
      if (k === "enum" && Array.isArray(v) && v.some(isAddress)) { const kept = v.filter((x) => !isAddress(x)); taken += v.length - kept.length; if (kept.length) out.enum = kept; continue; }
      if (k === "default" && isAddress(v)) { taken += 1; continue; }
      out[k] = typeof v === "object" ? walk(v) : v;
    }
    return out;
  };
  return { schema: walk(schema), taken };
}

/** The declarations the structure is made from, by file and path. */
function declarationIndex(spec) {
  const decls = declarationsOf(spec).filter((d) => d.where && !isProductField(d.where));
  const at = (file, test) => decls.filter((d) => d.where.file === file && test(d.where.path));
  return { decls, at };
}

/** The offerings and their steps, from the declarations when the spec keeps
 *  them: offerings[i].id, and offerings[i].steps[j].id. */
function declaredJobs(index) {
  const offers = new Map();
  for (const d of index.at("agent-descriptor.json", (p) => p[0] === "offerings" && typeof p[1] === "number" && p[2] === "id" && p.length === 3)) {
    if (typeof d.value === "string" && trim(d.value)) offers.set(d.where.path[1], { slug: trim(d.value), steps: new Map() });
  }
  for (const d of index.at("agent-descriptor.json", (p) => p[0] === "offerings" && typeof p[1] === "number" && p[2] === "steps" && typeof p[3] === "number" && p[4] === "id" && p.length === 5)) {
    const o = offers.get(d.where.path[1]);
    if (o && typeof d.value === "string" && trim(d.value)) o.steps.set(d.where.path[3], trim(d.value));
  }
  return [...offers.entries()].sort((a, b) => a[0] - b[0]).map(([, o]) => ({ slug: o.slug, steps: [...o.steps.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s) }));
}

/** The pieces the declarations give offering i on one side, by index: each
 *  offerings[i].<side>[k].<field>, grouped by k. */
function declaredPieces(index, i, side) {
  const out = new Map();
  if (i < 0) return out;
  for (const d of index.at("agent-descriptor.json", (p) => p[0] === "offerings" && p[1] === i && p[2] === side && typeof p[3] === "number" && p.length === 5)) {
    const at = out.get(d.where.path[3]) ?? {};
    at[d.where.path[4]] = d.value;
    out.set(d.where.path[3], at);
  }
  return out;
}

/** The offerings derived from the features when no declaration names them:
 *  each offering a feature names, in the order the features name them, as a
 *  slug; with none named, one, named after the first feature. Stable: it
 *  changes only when the features do. */
function derivedJobs(spec) {
  const seen = [];
  for (const f of list(spec?.features)) { const o = trim(f?.offering); if (o && !seen.includes(slugOf(o))) seen.push(slugOf(o)); }
  if (!seen.length) seen.push(slugOf(list(spec?.features)[0]?.name));
  return seen.map((slug) => ({ slug, steps: [] }));
}

/** The pieces a feature hands back or takes, as the files carry them. From
 *  an as-built record only the pieces that are files (a file interface by
 *  name, or with a kind or schema) are pieces; the behavior's other words
 *  (`{ reply }`, a function's parameters) are not. */
function piecesOf(spec, features, side) {
  const files = new Map(list(spec?.interfaces).filter((i) => trim(i?.kind) === "file").map((i) => [trim(i.name), i]));
  const asBuilt = trim(spec?.source?.kind) === "as-built-record";
  const out = [];
  for (const f of features) {
    for (const d of list(f?.[side])) {
      const name = trim(d?.name);
      if (!name) continue;
      const file = files.get(name);
      if (asBuilt && !file && !trim(d.kind) && d.schema === undefined) continue;
      const piece = file ? pieceName(name) : name;
      if (out.some((x) => x.name === piece)) continue;
      const kind = trim(d.kind) || (file ? kindOfFile(name) : side === "inputs" ? "text" : "text/markdown");
      const schema = d.schema !== undefined ? d.schema : file?.schema;
      // What the spec says of the piece beside its name and kind (spec-v1
      // 1.2.0): its shape in words, and for an input whether it is required
      // and who gives it.
      const said = {
        ...(trim(d.about) ? { about: trim(d.about) } : {}),
        ...(typeof d.required === "boolean" ? { required: d.required } : {}),
        ...(["person", "agent", "either"].includes(trim(d.given_by)) ? { given_by: trim(d.given_by) } : {}),
      };
      out.push({ name: piece, kind, ...(schema !== undefined ? { schema } : {}), ...said });
    }
  }
  return out;
}

/** The spec's command interfaces it keeps, in order. */
const commandsOf = (spec) => list(spec?.interfaces).filter((i) => trim(i?.kind) === "command" && i.keep !== false && trim(i.name));

/** The script a command interface names, as scripts/<file>. */
const scriptPathOf = (name) => { const v = trim(name).replace(/\\/g, "/").replace(/^\.\//, ""); return /^scripts\//.test(v) ? v : `scripts/${v.split("/").pop()}`; };

/** The modules the spec's interfaces name under scripts/, in order. */
function modulesOf(spec) {
  const out = [];
  const add = (m) => { const v = trim(m).replace(/\\/g, "/").replace(/^\.\//, ""); if (/^scripts\/[\w./-]+\.(?:mjs|js|cjs)$/.test(v) && !v.split("/").includes("..") && !out.includes(v)) out.push(v); };
  for (const i of list(spec?.interfaces)) {
    const k = trim(i?.kind);
    if (k === "command") add(scriptPathOf(i.name));
    else if (k === "function" || k === "constant") add(i.module);
  }
  return out;
}

/** The run of a job whose command interface the spec keeps: node (for a
 *  JavaScript module) and the script in the packaged form, then each flag
 *  with what the host puts after it, a file flag once per attached file. A
 *  flag the command requires and the host has nothing for is a problem.
 *  Returns { run, problems }. */
export function runOf(slug, command) {
  const script = scriptPathOf(command.name);
  const packaged = `{home}/{package}/skills/${slug}/${script}`;
  const words = /\.(?:mjs|js|cjs)$/.test(script) ? ["node", packaged] : [packaged];
  const flags = list(command.flags).map(String);
  const required = list(command.required_flags).map(String);
  const problems = [];
  const perFile = [];
  for (const flag of [...flags, ...required.filter((r) => !flags.includes(r))]) {
    if (FLAG_VALUES[flag]) words.push(flag, FLAG_VALUES[flag]);
    else if (FILE_FLAGS[flag]) perFile.push(flag, FILE_FLAGS[flag]);
    else if (required.includes(flag)) problems.push(`the command ${trim(command.name)} (interface ${trim(command.id)}) requires ${flag}, and the host has nothing to put after it; say in the spec what it is given, or declare the run command`);
  }
  return { run: { command: words, ...(perFile.length ? { per_file: perFile } : {}), reply: "json:reply" }, problems };
}

/** The house run for a job the spec names no command for. */
export function houseRun(slug) {
  return runOf(slug, { name: `scripts/${slug}.mjs`, flags: HOUSE_FLAGS, id: "" }).run;
}

/** The kinds of a spec setting that a run config sets, and the kinds the
 *  install places: where a system answers, a variable the code reads, and a
 *  secret. */
export const RUN_CONFIG_KINDS = ["run-config", "preference", "rule"];
export const INSTALL_KINDS = ["address", "environment", "credential"];

/** Is a spec setting one a run config sets? One of the run-config kinds, or
 *  a value a person or a job may set (set_by person or either) whose kind is
 *  a value type: integer, number, string, boolean, or any kind the install
 *  does not place. The spec of hn-digest (2026-11-11) wrote its two counts as
 *  kind integer, set by either, and both were dropped from the files. */
const isRunConfig = (s) => RUN_CONFIG_KINDS.includes(trim(s?.kind))
  || (!INSTALL_KINDS.includes(trim(s?.kind)) && ["person", "either"].includes(trim(s?.set_by)));

/** A spec setting as a run-config setting, with what code can say of it. */
function runSettingOf(s) {
  const e = { name: trim(s.name), kind: trim(s.kind) === "rule" ? "rule" : "preference" };
  e.label = trim(s.label) || labelOf(s.name);
  e.about = trim(s.about);
  if ("default" in s) e.default = clone(s.default);
  const allowed = Array.isArray(s.values) ? s.values : Array.isArray(s.allowed) ? s.allowed : null;
  if (allowed) {
    e.allowed = clone(allowed);
    e.value_labels = Object.fromEntries(allowed.map((v) => [String(v), trim(s.value_labels?.[String(v)]) || String(v)]));
  }
  const min = typeof s.min === "number" ? s.min : typeof s.range?.min === "number" ? s.range.min : undefined;
  const max = typeof s.max === "number" ? s.max : typeof s.range?.max === "number" ? s.range.max : undefined;
  if (min !== undefined) e.min = min;
  if (max !== undefined) e.max = max;
  const step = typeof s.step === "number" ? s.step : typeof s.range?.step === "number" ? s.range.step : undefined;
  // A whole-number range steps by one: that is arithmetic, not a choice.
  if (step !== undefined) e.step = step;
  else if (typeof e.default === "number" && Number.isInteger(e.default) && (min === undefined || Number.isInteger(min)) && (max === undefined || Number.isInteger(max)) && !allowed) e.step = 1;
  e.job_may_set = trim(s.set_by) !== "install";
  return e;
}

/** A system's name as the variable that holds its address:
 *  "public-hacker-news-api" is PUBLIC_HACKER_NEWS_API_ADDRESS. */
export const addressEnvOf = (name) => `${slugOf(name, "service").toUpperCase().replace(/-/g, "_").slice(0, 55).replace(/_+$/, "")}_ADDRESS`;

/** A record's public binding of a system, the service bound to itself
 *  (the architecture standard, section 2), or null. */
const publicBindingOf = (architecture, name) => Object.values(architecture?.bindings?.[name] ?? {}).find((b) => b?.public && trim(b.address)) ?? null;

/** The systems the files declare: each system the spec reaches, as a
 *  service (or a model system, by its reserved name), with the address
 *  setting the spec lists for its address, under the name the architecture
 *  record gives it when one came. A system of reach none is no system. A
 *  service whose fixed address no setting of the spec holds gets one, named
 *  for the service, with the address as its default: the one place a file
 *  may carry an address (Common Agent Section 12.6, rule 2). Every system
 *  the record names is declared too: a model system as kind model with its
 *  protocols, and a keyless public service the record binds to itself as a
 *  service with the address its binding names, even where the spec lists
 *  neither. */
function systemsOf(spec, architecture = null) {
  const settings = list(spec?.settings);
  const named = Array.isArray(architecture?.systems) ? architecture.systems.map(trim) : [];
  const publics = named.map((n) => ({ name: n, b: publicBindingOf(architecture, n) })).filter((p) => p.b);
  const addressSetting = (system, said, address) => {
    const st = settings.find((x) => trim(x?.kind) === "address" && typeof x.default === "string" && sameAddress(x.default) === sameAddress(address));
    return st
      ? { env: trim(st.name), purpose: trim(st.about) || `where ${said} answers, its base address`, default: st.default }
      : { env: addressEnvOf(system), purpose: `where ${said} answers, its base address`, default: address };
  };
  const out = [];
  for (const s of list(spec?.systems)) {
    if (!isObj(s) || trim(s.reach) === "none" || !trim(s.name)) continue;
    const slug = slugOf(s.name, "service");
    const model = MODEL_SYSTEMS.find((m) => slugOf(s.name) === m || trim(s.name).toLowerCase() === m);
    // A service the record binds to itself is that system of the record: the
    // one at the host of the spec's address, or else the one its name holds
    // ("public Hacker News API" is hacker-news). Its address and its access
    // are the binding's, which the owner approved.
    const pub = model ? null : publics.find((p) => trim(s.address) && hostOf(s.address) === hostOf(p.b.address)) ?? publics.find((p) => slug === p.name || slug.includes(p.name));
    const fromRecord = pub?.name ?? named.find((n) => n === slug) ?? named.find((n) => n === model);
    const name = fromRecord ?? model ?? slug;
    if (out.some((x) => x.name === name)) continue;
    if (model) { out.push({ name, kind: "model", access: "trigger", protocols: [...MODEL_PROTOCOLS], needs: "", from: s.name }); continue; }
    const e = { name, kind: "service", access: pub ? pub.b.access : { read: "read", write: "write", "read-write": "read-write" }[trim(s.reach)] ?? "read", needs: "", from: s.name };
    const address = pub ? trim(pub.b.address) : trim(s.address);
    if (address) e.settings = [addressSetting(name, trim(s.name), address)];
    // What the scripts need to reach it, as the spec says it (spec-v1 1.3.0,
    // Common Agent Section 12.4, item 3): the credential by name and the
    // variable it is read from, and each value the host supplies by its
    // variable and purpose, never a value. A keyless public service says
    // "none", and carries no credential.
    if (isObj(s.credential) && trim(s.credential.name) && trim(s.credential.env)) { e.credential = trim(s.credential.name); e.env = trim(s.credential.env); }
    for (const st of list(s.settings)) {
      if (!isObj(st) || !trim(st.env)) continue;
      e.settings = e.settings ?? [];
      if (!e.settings.some((x) => x.env === trim(st.env))) e.settings.push({ env: trim(st.env), purpose: trim(st.purpose) });
    }
    out.push(e);
  }
  // A system the record names and the spec does not list is declared all the
  // same, because the Design declares exactly the record's systems. The
  // install places MODEL_NAME, MODEL_ENDPOINT, MODEL_KEY and MODEL_PROTOCOL
  // only for a declared system of kind model (Common Agent Section 12.4.1);
  // in hn-digest (2026-11-11) the record named text-reasoning, the spec listed
  // only the Hacker News API, and the scripts read four settings nothing
  // declared.
  for (const m of named.filter((n) => MODEL_SYSTEMS.includes(n))) {
    if (!out.some((x) => x.name === m)) out.push({ name: m, kind: "model", access: "trigger", protocols: [...MODEL_PROTOCOLS], needs: "", from: m });
  }
  for (const p of publics) {
    if (!out.some((x) => x.name === p.name)) out.push({ name: p.name, kind: "service", access: p.b.access, needs: "", settings: [addressSetting(p.name, p.name, trim(p.b.address))], from: p.name });
  }
  // A setting the code reads from its environment is declared on the first
  // service, the one place a descriptor carries a variable, when its name is
  // a variable's (upper case, as the package maker reads one).
  const env = settings.filter((x) => trim(x?.kind) === "environment" && /^[A-Z][A-Z0-9_]{0,63}$/.test(trim(x.name)));
  const first = out.find((x) => x.kind === "service");
  if (first) for (const st of env) (first.settings ??= []).push({ env: trim(st.name), purpose: trim(st.about) || `the setting ${trim(st.name)}` });
  return out;
}

/** A spending limit in words as a ceiling Common Agent Section 12.4, item 4
 *  reads: the currency it spends in, what it is per (a task or a day), and
 *  the number, as `suggested`. "1 USD per day, across every job" is
 *  { unit: "USD", per: "day", suggested: 1 }. Null when the words say no
 *  amount, currency and period code can read. */
export function ceilingOf(words = "") {
  const m = /(?:([$€£])\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(usd|eur|gbp|dollars?|euros?|pounds?)\b)\s*(?:a|an|per|each|every)\s+(day|job|task|run)\b/i.exec(trim(words));
  if (!m) return null;
  const unit = m[1] ? { "$": "USD", "€": "EUR", "£": "GBP" }[m[1]] : { usd: "USD", dollar: "USD", dollars: "USD", eur: "EUR", euro: "EUR", euros: "EUR", gbp: "GBP", pound: "GBP", pounds: "GBP" }[m[4].toLowerCase()];
  const suggested = Number(m[2] ?? m[3]);
  if (!(suggested > 0) || !unit) return null;
  return { unit, per: m[5].toLowerCase() === "day" ? "day" : "task", suggested };
}

/** The runtimes the spec's constraints name, and node wherever a command
 *  runs it. */
function runtimesOf(spec, jobs) {
  const out = [];
  for (const c of list(spec?.constraints)) {
    if (trim(c?.kind) !== "runtime") continue;
    const words = [trim(c.shall), ...list(c.exact).map(String)].join(" ");
    if (/\bnode\b/i.test(words) && !out.some((r) => r.name === "node")) {
      const v = /(>=?\s*\d+(?:\.\d+)*)/.exec(list(c.exact).join(" "))?.[1]?.replace(/\s+/g, "");
      out.push({ name: "node", ...(v ? { version: v } : {}) });
    }
  }
  if (!out.some((r) => r.name === "node") && jobs.some((j) => list(j.run?.command)[0] === "node")) out.push({ name: "node" });
  return out;
}

/** Where a declaration's path lands in the draft: the object to set into
 *  and the path under it, or null when this layout has no place for it. */
function placeOf(draft, where) {
  const { file, path } = where;
  const jobs = list(draft.jobs);
  const offered = jobs.filter((j) => j.offered === true);
  const job = (slug) => jobs.find((j) => j.slug === slug);
  const jobPath = (j, rest) => {
    if (!j || !rest.length) return null;
    if (rest[0] === "id" && rest.length === 1) return { obj: j, path: ["slug"] };
    if (rest[0] === "name" && rest.length === 1) return { obj: j, path: ["title"] };
    return { obj: j, path: rest };
  };
  if (file === "agent-descriptor.json") {
    if (path[0] === "offerings" && typeof path[1] === "number") {
      const o = offered[path[1]];
      if (path[2] === "steps" && typeof path[3] === "number") return jobPath(job(list(o?.steps)[path[3]]), path.slice(4));
      return jobPath(o, path.slice(2));
    }
    if (path[0] === "run_config") return { obj: draft, path };
    if (path[0] === "systems" && typeof path[1] === "number") return draft.systems?.[path[1]] ? { obj: draft.systems[path[1]], path: path.slice(2) } : null;
    if (path[0] === "records" && typeof path[1] === "number") return { obj: draft, path };
    if (path.length === 1 && path[0] === "does") return { obj: draft, path: ["description"] };
    if (path.length === 1 && ["summary", "will_not"].includes(path[0])) return { obj: draft, path };
    if (path.length === 1 && path[0] === "name") return { obj: draft, path: ["display_name"] };
    return null;
  }
  if (file === "agent-runtime-requirements.json") {
    if (path[0] === "run" && typeof path[1] === "string" && job(path[1])) return { obj: job(path[1]), path: ["run", ...path.slice(2)] };
    if (path[0] === "systems" && typeof path[1] === "number") return draft.systems?.[path[1]] ? { obj: draft.systems[path[1]], path: path.slice(2) } : null;
    if (["runtimes", "binaries", "job_seconds", "wants_replies", "directories"].includes(path[0])) return { obj: draft, path };
    return null;
  }
  if (file === "plugin.json") {
    const ext = path[0] === "extensions" && path[1] === "net.agentdoc.package" && path[2] === "build";
    if (ext && path[3] === "skills" && typeof path[4] === "string" && job(path[4]) && ["scripts", "references", "assets"].includes(path[5])) return { obj: job(path[4]), path: path.slice(5) };
    if (path.length === 1 && path[0] === "description") return { obj: draft, path: ["description"] };
    if (path.length === 1 && path[0] === "license") return { obj: draft, path };
    return null;
  }
  return null;
}

function setAt(obj, path, value) {
  let o = obj;
  for (let i = 0; i < path.length - 1; i += 1) {
    const k = path[i];
    if (o[k] === undefined || o[k] === null || typeof o[k] !== "object") o[k] = typeof path[i + 1] === "number" ? [] : {};
    o = o[k];
  }
  o[path[path.length - 1]] = clone(value);
}

/** The draft with each kept declaration put where its file reads it from.
 *  The descriptor's refusals are one string; the draft's are a list. Returns
 *  { draft, placed, unplaced }, placed as prose keys a declaration fixes. */
export function placeDeclarations(draft, spec) {
  const d = draft;
  const placed = [];
  const unplaced = [];
  for (const decl of declarationIndex(spec).decls) {
    if (decl.where.file === "agent-descriptor.json" && decl.where.path.length === 1 && decl.where.path[0] === "refusals" && typeof decl.value === "string") {
      d.refuses = decl.value.split("\n").filter(Boolean); placed.push("refuses"); continue;
    }
    const at = placeOf(d, decl.where);
    if (!at || !at.path.length) { unplaced.push(decl); continue; }
    setAt(at.obj, at.path, decl.value);
    placed.push(proseKeyOf(d, at));
  }
  return { draft: d, placed: placed.filter(Boolean), unplaced };
}

/** The prose key a placed declaration fixes, when it fixes prose. */
function proseKeyOf(d, at) {
  const p = at.path;
  if (at.obj === d) return p.length === 1 && p[0] === "description" ? "description" : "";
  if (list(d.jobs).includes(at.obj)) {
    if (p.length === 1 && JOB_PROSE.includes(p[0])) return `job:${at.obj.slug}.${p[0]}`;
    if (p.length === 3 && ["inputs", "outputs"].includes(p[0]) && typeof p[1] === "number" && p[2] === "about") return `job:${at.obj.slug}.${p[0]}:${trim(at.obj[p[0]]?.[p[1]]?.name)}.about`;
    return "";
  }
  if (list(d.systems).includes(at.obj) && p.length === 1 && p[0] === "needs") return `system:${at.obj.name}.needs`;
  return "";
}

/** The structure of the agent's own files, written from the spec by code,
 *  with every prose field empty: a draft in the shape files.mjs projects.
 *  Returns { draft, notes, problems, fixed, asks }: what code derived that a
 *  reader should check, what it could not place, the prose keys the spec or
 *  a declaration fixes, and the questions for an offering the spec gives no
 *  input or no output. Pure. */
export function structureOf(spec, { architecture = null } = {}) {
  const notes = [];
  const problems = [];
  const index = declarationIndex(spec);
  const declared = declaredJobs(index);
  const shape = declared.length ? declared : derivedJobs(spec);
  if (!declared.length) notes.push(`The spec keeps no declaration of the offerings, so code named ${shape.length === 1 ? "the offering" : "them"} after the features' offering${shape.length === 1 ? "" : "s"}: ${shape.map((o) => o.slug).join(", ")}.`);
  const features = list(spec?.features);
  const offerSlugs = shape.map((o) => o.slug);
  const featuresOf = (slug) => (offerSlugs.length === 1 ? features : features.filter((f) => slugOf(f.offering) === slug));
  const commands = commandsOf(spec);
  const modules = modulesOf(spec);
  const systems = systemsOf(spec, architecture);
  const reachesModel = systems.some((s) => s.kind === "model");
  const how = { control: "script", intelligence: reachesModel ? "called" : "none", cost: reachesModel ? "metered" : "none", contract: "full" };
  const jobs = [];
  const fromSpec = [];
  const asks = [];
  shape.forEach((o, i) => {
    const mine = featuresOf(o.slug);
    const job = { slug: o.slug, title: titleOf(o.slug), offered: true };
    const steps = o.steps.filter((s) => s !== o.slug);
    if (steps.length) job.steps = steps;
    Object.assign(job, { does: "", when: "", good: "", empty: "" });
    // The pieces the spec declares for this offering are its pieces, in the
    // declared order, each with the schema of the piece of that name; with
    // none declared, the features' pieces.
    const sideOf = (side) => {
      const derived = piecesOf(spec, mine, side);
      const byIndex = declaredPieces(index, declared.length ? i : -1, side);
      if (!byIndex.size) return derived;
      return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => {
        // The piece of that name, or else the one piece of that kind: a piece
        // the spec renamed keeps its schema.
        const ofKind = derived.filter((x) => trim(p.kind) && x.kind === trim(p.kind));
        const same = derived.find((x) => x.name === trim(p.name)) ?? (ofKind.length === 1 ? ofKind[0] : undefined);
        const said = Object.fromEntries(Object.entries(same ?? {}).filter(([k]) => ["about", "required", "given_by"].includes(k)));
        return { name: trim(p.name), kind: trim(p.kind) || same?.kind || (side === "inputs" ? "text" : "text/markdown"), ...(same?.schema !== undefined ? { schema: same.schema } : {}), ...said };
      });
    };
    const inputs = sideOf("inputs");
    const outputs = sideOf("outputs");
    job.inputs = inputs.map((p) => ({ name: p.name, kind: p.kind, required: p.required ?? true, given_by: p.given_by ?? "either", about: p.about ?? "" }));
    job.outputs = outputs.map((p) => {
      const out = { name: p.name, kind: p.kind, when: "per_task", about: p.about ?? "" };
      if (p.schema !== undefined) { const s = schemaWithoutAddresses(p.schema); out.schema = s.schema; if (s.taken) notes.push(`The schema of ${p.name} carries an address the spec keeps; the files carry the schema without it, because the package maker refuses a descriptor that carries one.`); }
      return out;
    });
    // The about the spec gives a piece is the piece's about, and the model
    // does not write it again, unless it is Markdown whose about sketches no
    // convention, which the model then writes from the spec's words.
    for (const side of ["inputs", "outputs"]) {
      for (const p of job[side]) if (trim(p.about) && (!/^text\/markdown\b/i.test(p.kind) || conventionHeadings(p.about).length)) fromSpec.push(`job:${o.slug}.${side}:${p.name}.about`);
    }
    // An offering with nothing it hands back, or one whose spec never says
    // what it takes, is asked, never delivered empty (hn-digest,
    // 2026-11-11: the spec named neither, and the files declared neither).
    // An inputs list the spec states empty says the job takes nothing.
    if (!outputs.length) asks.push({ key: `outputs-${o.slug}`, question: `The spec names nothing ${o.slug} hands back, so its files declare no output. What does it hand back? For each piece say its name, its kind (Markdown, plain text, a JSON shape, a file type), and its shape in words, such as a Markdown header and its headings.` });
    if (!inputs.length && !mine.some((f) => Array.isArray(f?.inputs))) asks.push({ key: `inputs-${o.slug}`, question: `The spec does not say what ${o.slug} takes, so its files declare no input. What does a caller give it? For each piece say its name, its kind (plain text, a URL, Markdown, a file type), whether it is required, who gives it (a person, an agent or either) and its shape in words. If it takes nothing, say so.` });
    job.how = { ...how };
    const command = commands[i];
    if (command) {
      const r = runOf(o.slug, command);
      job.run = r.run;
      problems.push(...r.problems);
      job.scripts = [...new Set([scriptPathOf(command.name), ...modules])];
    } else if (i === 0 || !commands.length) {
      job.run = houseRun(o.slug);
      job.scripts = [...new Set([`scripts/${o.slug}.mjs`, ...modules])];
      notes.push(`The spec keeps no command for ${o.slug}, so it runs the house command, scripts/${o.slug}.mjs with the flags ${HOUSE_FLAGS.join(", ")}.`);
    }
    job.instructions = "";
    jobs.push(job);
    for (const s of steps) {
      if (jobs.some((j) => j.slug === s) || offerSlugs.includes(s)) continue;
      jobs.push({ slug: s, title: titleOf(s), offered: false, does: "", when: "", good: "", empty: "", how: { ...how }, instructions: "" });
    }
  });
  const draft = {};
  const name = trim(spec?.product?.name);
  const open = new Set(list(spec?.open).map((o) => trim(o?.key)));
  if (name && name !== STAND_IN_NAME && !open.has("name")) draft.name = name;
  if (/^\d+\.\d+\.\d+$/.test(trim(spec?.product?.version))) draft.version = trim(spec.product.version);
  draft.description = "";
  draft.jobs = jobs;
  draft.refuses = [];
  const ships = jobs.some((j) => list(j.scripts).some((f) => f.endsWith("went-without.mjs")));
  draft.records = [...(ships ? [{ ...WENT_WITHOUT_RECORD }] : []), { ...MANIFEST_RECORD }];
  draft.systems = systems;
  // The record's spending limit is the ceiling of the model system it bounds
  // (the architecture standard, section 9; Common Agent Section 12.4, item
  // 4): the system says it spends, in the limit's currency, and ceilings[]
  // names it, per task or day, with the number as suggested, which binds
  // nothing until the owner's instruction adopts it.
  const limit = trim(architecture?.cost_limit);
  if (limit) {
    const c = ceilingOf(limit);
    const spender = systems.find((s) => s.kind === "model");
    if (c && spender) {
      spender.spends = { unit: c.unit };
      draft.ceilings = [{ system: spender.name, per: c.per, suggested: c.suggested }];
    } else {
      notes.push(`The architecture record's cost limit, ${JSON.stringify(limit)}, ${c ? "bounds no model system the files declare" : "does not say an amount, a currency and per day or per job in words code reads"}, so the files declare no ceiling for it.`);
    }
  }
  const run = list(spec?.settings).filter(isRunConfig);
  if (run.length) {
    // The declared order first, by the name each index declares, then the rest.
    const order = new Map(index.at("agent-descriptor.json", (p) => p[0] === "run_config" && p[1] === "settings" && typeof p[2] === "number" && p[3] === "name" && p.length === 4).map((d) => [trim(d.value), d.where.path[2]]));
    const sorted = [...run].sort((a, b) => (order.get(trim(a.name)) ?? 1e9) - (order.get(trim(b.name)) ?? 1e9));
    draft.run_config = { settings: sorted.map(runSettingOf) };
  }
  draft.runtimes = runtimesOf(spec, jobs);
  const price = trim(spec?.price) ? priceNamed([{ from: "the spec", text: `price: ${trim(spec.price)}` }]) : null;
  if (price) { const { from, ...p } = price; draft.price = p; }
  else if (trim(spec?.price)) problems.push(`the spec's price, ${JSON.stringify(trim(spec.price))}, is not free or a flat amount, so the files carry none; say it as "free" or as an amount such as $0.50`);
  const placed = placeDeclarations(draft, spec);
  for (const u of placed.unplaced) problems.push(`interface ${u.id} declares ${JSON.stringify(u.value)} at ${u.declared_in}, which the agent's files have no place for`);
  // A piece a declaration made has what every piece has.
  for (const j of jobs) {
    if (Array.isArray(j.inputs)) j.inputs = j.inputs.map((p) => ({ ...p, ...("required" in p ? {} : { required: true }), ...("given_by" in p ? {} : { given_by: "either" }), ...("about" in p ? {} : { about: "" }) }));
    if (Array.isArray(j.outputs)) j.outputs = j.outputs.map((p) => ({ ...p, ...("when" in p ? {} : { when: "per_task" }), ...("about" in p ? {} : { about: "" }) }));
  }
  for (const s of list(draft.systems)) delete s.from;
  return { draft: placed.draft, notes, problems, fixed: [...placed.placed, ...fromSpec], asks };
}

// ---------- the prose: what the model writes ----------

/** The prose fields of a job, and of a piece and a system. */
export const JOB_PROSE = ["does", "when", "good", "empty", "instructions"];

/** Every prose field of a draft, by key: description, refuses,
 *  job:<slug>.<field>, job:<slug>.inputs:<name>.about,
 *  job:<slug>.outputs:<name>.about and system:<name>.needs. */
export function proseSlots(draft) {
  const out = ["description", "refuses"];
  for (const j of list(draft?.jobs)) {
    for (const k of JOB_PROSE) out.push(`job:${j.slug}.${k}`);
    for (const side of ["inputs", "outputs"]) for (const p of list(j[side])) out.push(`job:${j.slug}.${side}:${trim(p.name)}.about`);
  }
  for (const s of list(draft?.systems)) out.push(`system:${trim(s.name)}.needs`);
  return out;
}

const SLOT = /^job:([^.]+)\.(?:(inputs|outputs):(.+)\.about|([a-z]+))$/;

/** The value at a prose key, or undefined when the draft has no such field. */
export function proseAt(draft, key) {
  if (key === "description") return draft?.description;
  if (key === "refuses") return draft?.refuses;
  const s = /^system:(.+)\.needs$/.exec(key);
  if (s) return list(draft?.systems).find((x) => trim(x.name) === s[1])?.needs;
  const m = SLOT.exec(key);
  if (!m) return undefined;
  const j = list(draft?.jobs).find((x) => x.slug === m[1]);
  if (!j) return undefined;
  if (m[2]) return list(j[m[2]]).find((p) => trim(p.name) === m[3])?.about;
  return j[m[4]];
}

/** The draft with one prose field set. False when it has no such field. */
export function setProse(draft, key, value) {
  if (key === "description") { draft.description = value; return true; }
  if (key === "refuses") { draft.refuses = value; return true; }
  const s = /^system:(.+)\.needs$/.exec(key);
  if (s) { const x = list(draft?.systems).find((y) => trim(y.name) === s[1]); if (!x) return false; x.needs = value; return true; }
  const m = SLOT.exec(key);
  if (!m) return false;
  const j = list(draft?.jobs).find((x) => x.slug === m[1]);
  if (!j) return false;
  if (m[2]) { const p = list(j[m[2]]).find((x) => trim(x.name) === m[3]); if (!p) return false; p.about = value; return true; }
  if (!JOB_PROSE.includes(m[4])) return false;
  j[m[4]] = value;
  return true;
}

const isProse = (key, v) => (key === "refuses" ? Array.isArray(v) && v.every((x) => typeof x === "string") : typeof v === "string");

/** The prose an earlier draft carries for each slot of this one: the same
 *  key, or, for a piece renamed in the spec, the piece at the same place in
 *  the same job, or, for a job renamed in the spec, the job at the same
 *  place. Returns a Map of key to value. */
export function carriedProse(draft, earlier) {
  const out = new Map();
  if (!isObj(earlier)) return out;
  const eJobs = list(earlier.jobs);
  for (const key of proseSlots(draft)) {
    let v = proseAt(earlier, key);
    if (v === undefined) {
      const m = SLOT.exec(key);
      if (m) {
        const jobs = list(draft.jobs);
        const ji = jobs.findIndex((x) => x.slug === m[1]);
        const ej = eJobs.find((x) => x.slug === m[1]) ?? (eJobs.length === jobs.length ? eJobs[ji] : undefined);
        if (ej && m[2]) {
          // The piece of that name in the job, or a piece the spec renamed:
          // the one at the same place whose name the new job no longer has.
          const byName = list(ej[m[2]]).find((p) => trim(p.name) === m[3]);
          const pi = list(jobs[ji][m[2]]).findIndex((p) => trim(p.name) === m[3]);
          const ep = list(ej[m[2]])[pi];
          if (byName) v = byName.about;
          else if (ep && !list(jobs[ji][m[2]]).some((p) => trim(p.name) === trim(ep.name))) v = ep.about;
        } else if (ej) v = ej[m[4]];
      }
      const s = /^system:(.+)\.needs$/.exec(key);
      if (s) { const i = list(draft.systems).findIndex((x) => trim(x.name) === s[1]); const es = list(earlier.systems)[i]; if (es && !list(draft.systems).some((x) => trim(x.name) === trim(es.name))) v = es.needs; }
    }
    if (isProse(key, v) && (key !== "refuses" ? trim(v) : v.length)) out.set(key, clone(v));
  }
  return out;
}

const FIELD_WORDS = {
  when: /\bwhen\b[^.\n]{0,20}\b(?:line|sentence|to use)\b|\bwhen to use\b|\bthe when\b/i,
  good: /\bgood result\b|\bthe good\b|\bwhat a good\b/i,
  empty: /\bempty\b|\bnothing to give\b/i,
  does: /\bthe does\b|\bwhat (?:it|the job) does\b|\bone[- ]line\b/i,
  instructions: /\binstructions?\b|\bhow to do it\b/i,
};

/** The prose fields a person's words name, by key. A job named by its slug
 *  or title opens its prose (the fields the words name, or all of them); a
 *  piece or a system named by its name opens its about or needs; "refusals"
 *  opens the refusals, and "description" the agent's own line; a field named
 *  with no job opens that field of every job. Each name is a whole word: a
 *  piece called stories is not named by read-the-stories. */
export function namedProse(words = "", draft = null) {
  const t = String(words);
  const out = new Set();
  const word = (v) => new RegExp(`(?<![\\w$-])${trim(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$-])`, "i").test(t);
  const fields = Object.entries(FIELD_WORDS).filter(([, re]) => re.test(t)).map(([k]) => k);
  let jobNamed = false;
  for (const j of list(draft?.jobs)) {
    if (!(word(j.slug) || (trim(j.title).length > 3 && word(j.title)))) continue;
    jobNamed = true;
    for (const k of fields.length ? fields : JOB_PROSE) out.add(`job:${j.slug}.${k}`);
  }
  if (!jobNamed) for (const j of list(draft?.jobs)) for (const k of fields) out.add(`job:${j.slug}.${k}`);
  for (const j of list(draft?.jobs)) for (const side of ["inputs", "outputs"]) for (const p of list(j[side])) if (trim(p.name).length > 1 && word(p.name)) out.add(`job:${j.slug}.${side}:${trim(p.name)}.about`);
  for (const s of list(draft?.systems)) if (trim(s.name).length > 2 && word(s.name)) out.add(`system:${trim(s.name)}.needs`);
  if (/\brefus(?:al|als|es|e)\b|\bwill not\b|\bwon't\b/i.test(t)) out.add("refuses");
  if (/\bdescription\b|\bwhat the agent does\b/i.test(t)) out.add("description");
  return out;
}

/** The draft with the model's prose put in, for the keys it may write and
 *  no other. The answer is {description, refuses, jobs: {slug: {does, when,
 *  good, empty, instructions, inputs: {name: about}, outputs: {name:
 *  about}}}, systems: {name: needs}}. Returns { draft, set }. */
export function mergeProse(draft, answer, may = new Set()) {
  const d = structuredClone(draft);
  const set = [];
  const put = (key, v) => { if (!may.has(key) || !isProse(key, v)) return; const val = key === "refuses" ? v.map(trim).filter(Boolean) : trim(v); if (setProse(d, key, val)) set.push(key); };
  if (!isObj(answer)) return { draft: d, set };
  put("description", answer.description);
  put("refuses", answer.refuses);
  for (const [slug, j] of Object.entries(isObj(answer.jobs) ? answer.jobs : {})) {
    if (!isObj(j)) continue;
    for (const k of JOB_PROSE) put(`job:${slug}.${k}`, j[k]);
    for (const side of ["inputs", "outputs"]) for (const [name, about] of Object.entries(isObj(j[side]) ? j[side] : {})) put(`job:${slug}.${side}:${name}.about`, isObj(about) ? about.about : about);
  }
  for (const [name, needs] of Object.entries(isObj(answer.systems) ? answer.systems : {})) put(`system:${name}.needs`, isObj(needs) ? needs.needs : needs);
  return { draft: d, set };
}

/** Every prose field that is not one the revision may change and is not
 *  what it was, byte for byte. Empty when only what was named changed. */
export function proseUnchangedProblems(before, after, may = new Set()) {
  const out = [];
  for (const [key, v] of before) {
    if (may.has(key)) continue;
    if (JSON.stringify(proseAt(after, key)) !== JSON.stringify(v)) out.push(`${key} changed, and your words do not name it; it stays as it was`);
  }
  return out;
}

/** What a structural field of two drafts says differently, by path, for the
 *  reply: the offerings and steps, each piece's name and kind, the run
 *  commands, the settings and the systems. */
export function structureChanges(before, after) {
  const out = [];
  const pick = (d) => ({
    jobs: list(d?.jobs).map((j) => ({ slug: j.slug, title: j.title, offered: j.offered, steps: j.steps, inputs: list(j.inputs).map((p) => [p.name, p.kind, p.label]), outputs: list(j.outputs).map((p) => [p.name, p.kind]), run: j.run, scripts: j.scripts })),
    run_config: d?.run_config, systems: list(d?.systems).map((s) => ({ ...s, needs: undefined })), runtimes: d?.runtimes, price: d?.price, name: d?.name, version: d?.version,
  });
  const a = pick(before);
  const b = pick(after);
  for (const k of Object.keys(b)) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(k);
  return out;
}

export { hostOf };
