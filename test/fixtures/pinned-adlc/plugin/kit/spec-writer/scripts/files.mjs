// The agent's own files, written from a draft: agent-descriptor.json,
// agent-runtime-requirements.json, plugin.json and a SKILL.md per skill, the
// layout Common Agent 13.2 says a package is authored in.
//
// WHY THIS IS HERE AND NOT THE BUILDER'S. The builder (the package maker's
// build.py) writes these same files when it builds a spec, and on a host that
// has it this agent runs it too, over the files this writes, as the check.
// But this agent is installed where the builder is not: its container is
// node and nothing else, so a Python program cannot be what makes the files
// it delivers. So the builder's projection of a spec into the two authored
// files, the manifest and each SKILL.md is written again here, member for
// member and in the builder's order, and it is held to the builder byte for
// byte: test/files.test.mjs builds every fixture both ways and compares, and
// the agent folders in the repository round-trip through it.
//
// It projects and does not judge. A draft the builder would refuse still
// gets files written, and the builder refuses them in its own words wherever
// they are built: here when the builder is on the host, at the package maker
// otherwise. What is never written is a name, a price or a system the draft
// does not state: a draft with no name gets files with no name, and each
// SKILL.md says it is part of an agent not named yet.
//
// A job whose instructions are a file (`instructions: {file}`) has no "How
// to do it" here, as the builder writes none from a file that is not there
// yet; and a lockfile's digest is the digest of the stand-in, the empty file,
// which the package maker refuses until the lockfile itself is delivered.
//
// The $schema plugin.json carries is read from references/
// plugin-manifest-schema.json beside the scripts and not written here: it is
// an address, and a script carries none (Common Agent 12.6 rule 2, the address
// check of 12.10). It names a format and is never fetched.
//
//   needs: node >= 22
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXT = "net.agentdoc.package";
const HERE = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_FILE = "plugin-manifest-schema.json";

/** Where the reference holding the $schema value is: references/ beside this
 *  script's folder, in the source and in a built skill alike. */
export const schemaFileAt = (here = HERE) => { const p = join(here, "..", "references", SCHEMA_FILE); return existsSync(p) ? p : null; };

/** The $schema value every plugin.json written here carries, from the
 *  reference, read each time files are written. With the reference missing
 *  nothing is made up: the files are not written, and the error says which
 *  file is missing. */
export function schemaUrlOf(here = HERE) {
  const at = schemaFileAt(here);
  if (!at) throw new Error(`references/${SCHEMA_FILE} is not beside the scripts, so plugin.json has no $schema to carry`);
  const value = JSON.parse(readFileSync(at, "utf8"))?.$schema;
  if (typeof value !== "string" || !value.trim()) throw new Error(`references/${SCHEMA_FILE} carries no $schema value`);
  return value.trim();
}
export const RUNTIME_FORMAT = "agent-runtime-requirements-v1";
export const NOT_NAMED = "an agent not named yet";
const NAME_RE = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/;
const HOW_KEYS = ["control", "intelligence", "cost", "contract"];
const TRIAL_CEILING_MEMBERS = ["amount_micro", "currency", "per", "per_1k_tokens_micro"];
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v : "");
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const basename = (p) => String(p).replace(/[\\/]+$/, "").split(/[\\/]/).pop();

/** The builder's one spelling of a JSON file: two-space indent, a newline at
 *  the end. Python's json.dumps(indent=2, ensure_ascii=False) and this agree
 *  for every value a declaration carries. */
export const dumps = (obj) => JSON.stringify(obj, null, 2) + "\n";

/** A line as a sentence: trimmed, with a full stop when it has none. */
const sentence = (s) => { const t = String(s).trim(); return t.endsWith(".") ? t : `${t}.`; };

/** Python's str() of a version the draft gave as a number or a string. */
const pyStr = (v) => (typeof v === "number" && Number.isInteger(v) ? String(v) : String(v));

/** The slugs a caller can order: until one job says `offered`, every job is. */
export function offeredSlugs(jobs) {
  const anyone = jobs.some((j) => "offered" in j);
  return jobs.filter((j) => !anyone || j.offered === true).map((j) => j.slug);
}

/** A system's name, under `role` as Common Agent 0.16.0-draft still reads it. */
const systemName = (s) => s?.name ?? s?.role;

/** JCS (RFC 8785) for a run config's digest, as the builder writes it. */
export function jcs(v) {
  if (v === null || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : JSON.stringify(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(jcs).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${jcs(v[k])}`).join(",")}}`;
}

function runConfig(rc) {
  const declared = new Map();
  const settings = (rc.settings ?? []).map((s) => {
    const e = { name: str(s.name).trim(), kind: s.kind, default: s.default };
    if ("allowed" in s) e.allowed = s.allowed;
    for (const k of ["label", "about"]) if (k in s) e[k] = str(s[k]).trim();
    if ("value_labels" in s) e.value_labels = Object.fromEntries(Object.entries(s.value_labels).map(([k, v]) => [k, str(v).trim()]));
    // A number's range (Common Agent 6.13.4), as build.py carries it: its
    // members in the order written; or the older spelling on the setting itself.
    if (isObj(s.range)) e.range = Object.fromEntries(Object.entries(s.range));
    for (const k of ["min", "max", "step"]) if (k in s) e[k] = s[k];
    e.job_may_set = s.job_may_set;
    if ("does" in s) e.does = str(s.does).trim();
    declared.set(e.name, e);
    return e;
  });
  const out = { settings };
  if ("tested_models" in rc) out.tested_models = rc.tested_models.map((m) => str(m).trim());
  if ("named" in rc) {
    out.named = rc.named.map((n) => {
      const e = { name: str(n.name).trim(), settings: n.settings };
      if ("does" in n) e.does = str(n.does).trim();
      e.digest = `sha256:${createHash("sha256").update(jcs(e), "utf8").digest("hex")}`;
      return e;
    });
  }
  if (rc.replay === true) out.replay = true;
  return out;
}

function canUse(entries) {
  return entries.map((e) => {
    const o = { schema: str(e.schema).trim(), reads: (e.reads ?? []).map((f) => str(f).trim()) };
    if ("required" in e) o.required = e.required;
    if ("does" in e) o.does = str(e.does).trim();
    if ("without" in e) o.without = str(e.without).trim();
    return o;
  });
}

/** The draft Agent Descriptor, as build.py's draft_descriptor writes it. */
export function descriptorOf(spec, jobs, systems, records) {
  const project = (j) => {
    const o = { id: j.slug, name: j.title };
    if (typeof j.does === "string" && j.does.trim()) o.does = j.does.trim();
    for (const side of ["inputs", "outputs"]) if (j[side] !== undefined && j[side] !== null) o[side] = j[side];
    if ("how" in j) o.how = Object.fromEntries(HOW_KEYS.map((k) => [k, j.how?.[k]]));
    // cut-ok: the builder's own rule (build.py keeps the first five examples), repeated so the files are its bytes
    if (j.examples !== undefined && j.examples !== null) o.examples = j.examples.map((e) => str(e).trim()).slice(0, 5);
    return o;
  };
  const projected = new Map(jobs.map((j) => [j.slug, project(j)]));
  const canOrder = new Set(offeredSlugs(jobs));
  const offerings = [];
  for (const j of jobs) {
    if (!canOrder.has(j.slug)) continue;
    const o = { ...projected.get(j.slug) };
    if (j.steps?.length) o.steps = j.steps.map((s) => ({ ...(projected.get(s) ?? { id: s }) }));
    if ("revisions" in j) o.revisions = j.revisions;
    if ("started_by" in j) o.started_by = [...j.started_by];
    if ("works_as" in j) o.works_as = j.works_as;
    // The offering's example (Common Agent 6.13.8, proposed), as build.py's example_declaration writes it.
    if ("example" in j) o.example = { inputs: j.example.inputs, good_result: str(j.example.good_result).trim() };
    if ("trial" in j) o.trial = j.trial;
    if ("scopes" in j) o.scopes = (j.scopes ?? []).map((s) => ({ id: s.id, description: str(s.description).trim() }));
    offerings.push(o);
  }
  const doc = {
    format: "agent-descriptor-v1",
    agent_version: pyStr(spec.version ?? "1.0.0"),
    // The members a person reads, as build.py's person_members writes them.
    ...("display_name" in spec ? { name: str(spec.display_name).trim() } : {}),
    ...("summary" in spec ? { summary: str(spec.summary).trim() } : {}),
    ...("will_not" in spec ? { will_not: (spec.will_not ?? []).map((w) => str(w).trim()) } : {}),
    does: str(spec.description).trim(),
    offerings,
    refusals: (spec.refuses ?? []).map(sentence).join("\n"),
  };
  if (spec.escalates?.length) doc.escalates = spec.escalates.map(sentence);
  doc.records = records;
  if (systems.length) {
    doc.systems = systems.map((s) => ({
      name: s.name, access: s.access,
      ...(s.needs ? { needs: str(s.needs).trim() } : {}),
      ...(s.leaves === true ? { leaves: true } : {}),
    }));
  }
  // An empty can_use is carried: it says the agent reads no standing asset.
  if (Array.isArray(spec.can_use)) doc.can_use = canUse(spec.can_use);
  if (isObj(spec.run_config)) doc.run_config = runConfig(spec.run_config);
  return doc;
}

function runOf(r) {
  const out = { command: [...r.command], reply: r.reply ?? "stdout" };
  if (r.escalate_when) out.escalate_when = r.escalate_when;
  if (r.calls_model) out.calls_model = true;
  if (r.per_file) out.per_file = [...r.per_file];
  if (r.message_file) out.message_file = r.message_file;
  return out;
}

function priceOf(spec) {
  const p = spec.price;
  if (!isObj(p)) return null;
  const covers = p.covers == null ? { agent: true } : { offerings: [...p.covers] };
  const price = Object.fromEntries(Object.entries(p).filter(([k]) => k !== "sku" && k !== "covers"));
  return { sku: p.sku ?? "default", covers, price };
}

/** The runtime requirements, as build.py's install_file writes them. */
export function runtimeOf(spec, jobs, systems, lockfiles) {
  const sysEntries = systems.map((s) => {
    const kind = s.kind ?? "directory";
    const e = { name: s.name, kind };
    // A model system names the request formats its scripts speak (12.4.1),
    // right after its kind, as build.py writes it.
    if (s.protocols != null) e.protocols = Array.isArray(s.protocols) ? [...s.protocols] : s.protocols;
    if (s.credential != null) e.credential = s.credential;
    if (s.env != null) e.env = s.env;
    if (s.spends != null) e.spends = { unit: s.spends.unit };
    if (s.settings != null) e.settings = s.settings.map((st) => ({ env: st.env, ...(st.purpose ? { purpose: st.purpose } : {}) }));
    return e;
  });
  const spending = sysEntries.filter((e) => "spends" in e).map((e) => e.name);
  const byName = new Map(sysEntries.map((e) => [e.name, e]));
  const ceilings = (spec.ceilings ?? spending.map((r) => ({ system: r, per: "task" }))).map((c) => {
    const s = byName.get(c.system) ?? {};
    // A model system is called by the scripts themselves, through the shared
    // caller, so the runtime that makes the call applies its ceiling, as
    // build.py's ceiling_side derives it (Common Agent Section 12.4, item 4).
    const side = s.credential || s.kind === "model" ? "runtime" : s.kind === "mcp" ? "platform" : undefined;
    return { system: c.system, per: c.per, enforced_by: side, ...("suggested" in c ? { suggested: c.suggested } : {}) };
  });
  const directories = spec.directories?.length ? spec.directories : [
    { name: "records", purpose: "every record the descriptor names" },
    { name: "work", purpose: "inputs and drafts in progress" },
  ];
  const price = priceOf(spec);
  const runs = Object.fromEntries(jobs.filter((j) => "run" in j).map((j) => [j.slug, runOf(j.run)]));
  const verify = isObj(spec.verify) ? `skills/${spec.verify.job}/${spec.verify.script}` : null;
  const tc = isObj(spec.trial_ceiling) ? Object.fromEntries(TRIAL_CEILING_MEMBERS.filter((k) => k in spec.trial_ceiling).map((k) => [k, spec.trial_ceiling[k]])) : null;
  const one = isObj(spec.one_at_a_time) ? Object.fromEntries(Object.entries(spec.one_at_a_time).filter(([, v]) => v !== null && v !== undefined)) : null;
  return {
    format: RUNTIME_FORMAT,
    runtimes: (spec.runtimes ?? []).map((r) => ({ name: r.name, ...(r.version ? { version: r.version } : {}) })),
    binaries: (spec.binaries ?? []).map((b) => ({ name: b.name, ...(b.purpose ? { purpose: b.purpose } : {}) })),
    dependencies: lockfiles,
    systems: sysEntries,
    ceilings,
    directories,
    ...(spec.job_seconds != null ? { job_seconds: spec.job_seconds } : {}),
    ...(spec.wants_replies === true ? { wants_replies: true } : {}),
    ...(spec.one_at_a_time != null ? { one_at_a_time: one } : {}),
    ...(price ? { price } : {}),
    ...(spec.answer ? { answer: { piece: spec.answer } } : {}),
    ...(Object.keys(runs).length ? { run: runs } : {}),
    ...(verify ? { verify } : {}),
    ...(spec.samples_ref === true ? { samples_ref: true } : {}),
    ...(tc && Object.keys(tc).length ? { trial_ceiling: tc } : {}),
  };
}

/** One skill's SKILL.md, as build.py's skill_md writes it. `copied` holds
 *  the names each kind of file is placed under in the skill. */
export function skillMd(job, agentName, copied) {
  const when = str(job.when || "When the request matches this job.").trim();
  // cut-ok: the builder's own rule (the frontmatter description is the first 1024 characters); the whole sentence is under "When to use this"
  const lines = ["---", `name: ${job.slug}`, `description: ${when.slice(0, 1024)}`, "---", "",
    `# ${job.title}`, "", `Part of ${agentName}. ${when}`, "",
    "## When to use this", "", when, ""];
  if (job.inputs?.length) {
    lines.push("## What this needs", "");
    for (const i of job.inputs) {
      const group = typeof i.one_of === "string" && i.one_of.trim() ? i.one_of : null;
      const req = i.required ? "required" : group ? `any one of the ${group} group` : "optional";
      lines.push(`- ${i.name} (${i.kind}, ${req})`);
    }
    lines.push("");
  }
  lines.push("## What a good result looks like", "", str(job.good || "The job is done and its records are left.").trim(), "");
  if (job.outputs?.length) {
    lines.push("## What it produces", "");
    for (const o of job.outputs) {
      const tail = (o.when ? `, ${o.when.replace(/_/g, " ")}` : "") + (o.working === true ? ", working out" : "");
      lines.push(`- ${o.name} (${o.kind}${tail})`);
    }
    lines.push("");
  }
  lines.push("## When it comes back empty", "", str(job.empty || "Say so plainly and name what is missing, rather than inventing a result.").trim(), "");
  if (typeof job.instructions === "string" && job.instructions) lines.push("## How to do it", "", job.instructions.trim(), "");
  if (copied.scripts.length) {
    lines.push("## Scripts", "", "Run these from this skill's folder; each one says what it needs at the top.", "");
    lines.push(...copied.scripts.map((p) => `- scripts/${p}`), "");
  }
  if (copied.references.length) {
    lines.push("## References", "");
    lines.push(...copied.references.map((p) => `- references/${p}`), "");
  }
  if (copied.assets.length) {
    lines.push("## Assets", "", "Templates and resources the scripts fill in; never edited by hand.", "");
    lines.push(...copied.assets.map((p) => `- assets/${p}`), "");
  }
  return lines.join("\n");
}

/** The agent's own files for a draft, {rel: text} in the order they are
 *  listed: the two authored files, the manifest, and each SKILL.md. The same
 *  bytes the builder writes for the spec, with plugin.json as convert.py
 *  writes it (the build entry in, the build's own pointers out). */
export function agentFilesOf(spec) {
  const jobs = (spec.jobs ?? []).filter(isObj).map((j) => ({ ...j }));
  const named = NAME_RE.test(str(spec.name));
  const systems = (spec.systems ?? []).map((s) => { const { role, ...rest } = s; return { ...rest, name: systemName(s) }; });
  const records = (spec.records ?? []).map((r) => (typeof r === "string"
    ? { name: r.trim(), when: "per_task" }
    : { name: str(r.name).trim(), when: r.when ?? "per_task", ...(r.file ? { file: r.file } : {}) }));
  const lockfiles = [];
  const skills = {};
  for (const j of jobs) {
    const copied = { scripts: [], references: [], assets: [] };
    for (const k of ["scripts", "references", "assets"]) for (const rel of j[k] ?? []) copied[k].push(basename(rel));
    // A stand-in lockfile is empty, so its digest is the empty file's until
    // the lockfile itself is delivered.
    if (j.lockfile) lockfiles.push({ skill: j.slug, lockfile: `skills/${j.slug}/${j.lockfile}`, sha256: sha256("") });
    skills[j.slug] = skillMd(j, named ? spec.name : NOT_NAMED, copied);
  }
  const desc = descriptorOf(spec, jobs, systems, records);
  const inst = runtimeOf(spec, jobs, systems, lockfiles);
  const lineage = Array.isArray(spec.from) && spec.from.length
    ? spec.from.map((e) => Object.fromEntries(["name", "version", "repository", "commit", "license"].filter((k) => k in e).map((k) => [k, e[k]])))
    : null;
  const build = {};
  for (const k of ["kind", "container", "claims"]) if (k in spec) build[k] = spec[k];
  build.skills = Object.fromEntries(jobs.map((j) => [j.slug, Object.fromEntries(
    ["scripts", "references", "assets"].filter((k) => Array.isArray(j[k]) && j[k].length).map((k) => [k, [...j[k]]]))]));
  const manifest = {
    $schema: schemaUrlOf(),
    ...(named ? { name: spec.name } : {}),
    version: pyStr(spec.version ?? "1.0.0"),
    description: str(spec.description).trim(),
    ...(spec.license ? { license: str(spec.license).trim() } : {}),
    ...(spec.homepage ? { homepage: spec.homepage } : {}),
    ...(spec.repository ? { repository: spec.repository } : {}),
    author: spec.author || { name: "Agent Builder" },
    keywords: ["built-agent", "draft", ...jobs.map((j) => j.slug)],
    extensions: { [EXT]: { ...(lineage ? { from: lineage } : {}), build } },
  };
  const files = {
    "agent-descriptor.json": dumps(desc),
    "agent-runtime-requirements.json": dumps(inst),
    "plugin.json": dumps(manifest),
  };
  for (const j of jobs) files[`skills/${j.slug}/SKILL.md`] = skills[j.slug];
  return files;
}
