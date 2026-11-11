// An agent's own files, read the way the builder reads them.
//
// An agent here is kept in the layout Common Agent 13.2 says a package is
// authored in: agent-descriptor.json (every caller-facing fact),
// agent-runtime-requirements.json (every host-facing fact) and plugin.json,
// with each skill's SKILL.md under skills/<slug>/. plugin.json's
// extensions["net.agentdoc.package"].build is the builder's own entry: the
// files each skill carries (kept once, beside the agent, and copied into every
// skill that runs them) and anything else only a build reads.
//
// readAgentFolder(dir) returns those files as they are, and `jobs`: one entry
// per skill, in the build entry's order, with the members a test of a package
// reads about a job: slug, title, does, inputs, outputs, how, examples,
// offered, steps (the ids), revisions, trial, scopes, started_by, works_as,
// example,
// run, lockfile, scripts,
// references, assets, and skill (the SKILL.md text, which holds what a
// spec called a job's when, good, empty and instructions); and `systems`,
// each system's descriptor entry with its runtime binding laid over it,
// `refuses` (one line each), `escalates`, `records` and `description`. It is the same
// projection adlc's build.py makes of the folder (read_folder), so a test
// that checks a job checks what the package is built from. The names before
// Common Agent 0.30.0-draft (descriptor.json, install.json) are read where
// the current ones are absent.
//
// specOfFolder(dir) is the whole of read_folder's projection, every member a
// spec.json carried, with each job's when, good, empty and instructions read
// back out of its SKILL.md. It is what a writer downstream of the spec writer
// reads when the files came instead of a spec.json, so the writer's own steps
// run unchanged. It validates nothing: the builder does that, in its words.
//
// agentFilesAmong(files) finds those files among the ones a message carried,
// by content and never by name, because a file that came through the process
// runner arrives under its piece label with a prefix per hop. layOutAgentFiles
// puts what it found back into the layout, under a folder of the caller's.
//
// This file is kept once, here, and copied into each agent that reads an
// agent's files (test-writer/scripts, code-writer/scripts), because a package
// carries its own scripts. test_folder.py holds every copy to this one.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

const EXT = "net.agentdoc.package";
export const DESCRIPTOR_FILE = "agent-descriptor.json";
export const RUNTIME_FILE = "agent-runtime-requirements.json";
export const MANIFEST_FILE = "plugin.json";
const DESCRIPTOR_FORMAT = "agent-descriptor-v1";
const RUNTIME_FORMATS = ["agent-runtime-requirements-v1", "agent-install-v1"];
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const first = (dir, names) => names.map((n) => join(dir, n)).find((p) => existsSync(p)) ?? null;
const systemName = (s) => s?.name ?? s?.role;

/** Whether a folder holds an agent's own files. */
export function isAgentFolder(dir) {
  return existsSync(join(dir, "plugin.json")) && first(dir, ["agent-descriptor.json", "descriptor.json"]) !== null;
}

export function readAgentFolder(dir) {
  const manifest = readJson(join(dir, "plugin.json"));
  const dpath = first(dir, ["agent-descriptor.json", "descriptor.json"]);
  const rpath = first(dir, ["agent-runtime-requirements.json", "install.json"]);
  if (!dpath || !rpath) throw new Error(`${dir} has no agent-descriptor.json or agent-runtime-requirements.json`);
  const descriptor = readJson(dpath);
  const runtime = readJson(rpath);
  const build = manifest.extensions?.[EXT]?.build ?? {};
  const offerings = descriptor.offerings ?? [];
  const projected = new Map();
  for (const o of offerings) for (const p of [o, ...(o.steps ?? [])]) if (!projected.has(p.id)) projected.set(p.id, p);
  const order = build.skills ? Object.keys(build.skills) : [...projected.keys()];
  const byOffering = new Map(offerings.map((o) => [o.id, o]));
  const deps = new Map((runtime.dependencies ?? []).map((d) => [d.skill, d]));
  const jobs = order.map((slug) => {
    const p = byOffering.get(slug) ?? projected.get(slug) ?? { name: slug };
    const j = { slug, title: p.name };
    for (const k of ["does", "inputs", "outputs", "how", "examples"]) if (k in p) j[k] = p[k];
    j.offered = byOffering.has(slug);
    const o = byOffering.get(slug);
    if (o?.steps?.length) j.steps = o.steps.map((s) => s.id);
    for (const k of ["revisions", "trial", "scopes", "started_by", "works_as", "example"]) if (o && k in o) j[k] = o[k];
    if (runtime.run?.[slug]) j.run = runtime.run[slug];
    if (deps.has(slug)) j.lockfile = deps.get(slug).lockfile.slice(`skills/${slug}/`.length);
    for (const k of ["scripts", "references", "assets"]) if (build.skills?.[slug]?.[k]?.length) j[k] = [...build.skills[slug][k]];
    const md = join(dir, "skills", slug, "SKILL.md");
    j.skill = existsSync(md) ? readFileSync(md, "utf8") : "";
    return j;
  });
  // A system is one name in both files: what it is for in the descriptor,
  // how it is bound in the runtime requirements.
  const bound = new Map((runtime.systems ?? []).map((s) => [s.name ?? s.role, s]));
  const systems = (descriptor.systems ?? []).map((d) => ({ ...d, ...(bound.get(d.name ?? d.role) ?? {}) }));
  return {
    dir, manifest, descriptor, runtime, build, jobs, systems,
    name: manifest.name, version: manifest.version, description: manifest.description,
    refuses: (descriptor.refusals ?? "").split(/\n/).filter((l) => l.trim()),
    escalates: descriptor.escalates ?? [], records: descriptor.records ?? [],
  };
}

/** The sections of a SKILL.md the builder writes from a job, by heading.
 *
 *  Read in the builder's order and nowhere else: "When to use this", then
 *  "What a good result looks like", then "When it comes back empty", each
 *  the first after the one before; "What this needs" and "What it produces"
 *  only between those; "How to do it" the first after the empty case. So a
 *  heading inside a job's own words is never taken for one of the builder's.
 *  A job's instructions may carry "## " headings of their own, so "How to do
 *  it" runs to the lists of files the builder writes after it (Scripts,
 *  References, Assets), found from the end, and not to the next heading. */
export function skillSections(text) {
  const lines = String(text ?? "").replace(/\r/g, "").split("\n");
  const at = (h, from, before = lines.length) => {
    const i = lines.indexOf(`## ${h}`, from);
    return i >= 0 && i < before ? i : -1;
  };
  const when = at("When to use this", 0);
  const good = at("What a good result looks like", when + 1);
  const empty = good >= 0 ? at("When it comes back empty", good + 1) : -1;
  const needs = when >= 0 && good >= 0 ? at("What this needs", when + 1, good) : -1;
  const produces = good >= 0 && empty >= 0 ? at("What it produces", good + 1, empty) : -1;
  const how = empty >= 0 ? at("How to do it", empty + 1) : -1;
  const TRAILER = /^(## (Scripts|References|Assets)|- (scripts|references|assets)\/.*|Run these from this skill's folder; each one says what it needs at the top\.|Templates and resources the scripts fill in; never edited by hand\.|)$/;
  const last = Math.max(when, good, empty, how);
  let end = lines.length;
  for (let i = lines.length - 1; i > last; i--) {
    if (!TRAILER.test(lines[i])) break;
    if (/^## (Scripts|References|Assets)$/.test(lines[i])) end = i;
  }
  const starts = [["When to use this", when], ["What this needs", needs], ["What a good result looks like", good],
    ["What it produces", produces], ["When it comes back empty", empty], ["How to do it", how]].filter(([, i]) => i >= 0);
  const out = {};
  starts.forEach(([h, i], n) => {
    const stop = n + 1 < starts.length ? starts[n + 1][1] : end;
    out[h] = lines.slice(i + 1, stop).join("\n").trim();
  });
  return out;
}

/** The spec an agent's folder states: read_folder's projection in build.py,
 *  member for member, with when, good, empty and instructions read back out
 *  of each SKILL.md (the sections the builder writes them into). A member
 *  the folder does not state is absent here, as it would be in a spec. */
export function specOfFolder(dir) {
  const a = readAgentFolder(dir);
  const { manifest, descriptor: desc, runtime: inst, build: b } = a;
  const own = manifest.extensions?.[EXT] ?? {};
  const version = manifest.version ?? desc.agent_version ?? "1.0.0";
  const spec = {};
  if (typeof manifest.name === "string" && manifest.name) spec.name = manifest.name;
  spec.version = version;
  if (manifest.description !== undefined) spec.description = manifest.description;
  for (const k of ["license", "homepage", "repository", "author"]) if (k in manifest) spec[k] = manifest[k];
  if ("from" in own) spec.from = own.from;
  for (const k of ["kind", "container", "claims"]) if (k in b) spec[k] = b[k];
  spec.jobs = a.jobs.map(({ skill, ...j }) => {
    const s = skillSections(skill);
    const job = { ...j };
    if (s["When to use this"]) job.when = s["When to use this"];
    if (s["What a good result looks like"]) job.good = s["What a good result looks like"];
    if (s["When it comes back empty"]) job.empty = s["When it comes back empty"];
    if (s["How to do it"]) job.instructions = s["How to do it"];
    return job;
  });
  if ("name" in desc) spec.display_name = desc.name;
  for (const k of ["summary", "will_not"]) if (k in desc) spec[k] = desc[k];
  spec.refuses = a.refuses;
  if (desc.escalates?.length) spec.escalates = desc.escalates;
  spec.records = desc.records ?? [];
  const bound = new Map((inst.systems ?? []).map((e) => [systemName(e), e]));
  spec.systems = (desc.systems ?? []).map((d) => {
    const e = bound.get(systemName(d)) ?? {};
    const s = { name: systemName(d), access: d.access };
    for (const k of ["needs", "leaves"]) if (k in d) s[k] = d[k];
    for (const k of ["kind", "credential", "env", "spends", "settings", "protocols"]) if (k in e) s[k] = e[k];
    return s;
  });
  for (const k of ["can_use", "run_config"]) if (k in desc) spec[k] = desc[k];
  for (const k of ["runtimes", "binaries", "directories"]) if (k in inst) spec[k] = inst[k];
  if (Array.isArray(inst.ceilings)) {
    spec.ceilings = inst.ceilings.map((c) => {
      if (!c || typeof c !== "object") return c;
      const { enforced_by, ...rest } = c;
      return rest;
    });
  }
  for (const k of ["job_seconds", "wants_replies", "one_at_a_time", "samples_ref", "trial_ceiling"]) if (k in inst) spec[k] = inst[k];
  if (inst.answer && typeof inst.answer === "object") spec.answer = inst.answer.piece;
  if (inst.price?.price) {
    const price = { ...inst.price.price };
    if ("sku" in inst.price) price.sku = inst.price.sku;
    if (inst.price.covers?.offerings) price.covers = inst.price.covers.offerings;
    spec.price = price;
  }
  const v = /^skills\/([^/]+)\/(.+)$/.exec(String(inst.verify ?? ""));
  if (v) spec.verify = { job: v[1], script: v[2] };
  return spec;
}

/** A spec from wherever it is kept: an agent's folder, or a spec.json, which
 *  is still read for one transition. */
export function loadSpec(path) {
  if (existsSync(path) && statSync(path).isDirectory()) return specOfFolder(path);
  return readJson(path);
}

/** The frontmatter of a SKILL.md, between its opening `---` and the next,
 *  and the skill it names: exactly one unindented `name:` line. One rule,
 *  kept the same in pack.py, so a file is a skill to every reader or to none. */
export function skillSlugOf(text) {
  const t = String(text ?? "").replace(/\r/g, "");
  if (!t.startsWith("---\n")) return null;
  const end = t.indexOf("\n---", 3);
  if (end < 0) return null;
  const names = t.slice(4, end).split("\n").filter((l) => l.startsWith("name:")).map((l) => l.slice(5).trim());
  return names.length === 1 && /^[a-z][a-z0-9-]{1,62}$/.test(names[0]) ? names[0] : null;
}

/** What one file is, by its content: "descriptor", "runtime", "manifest",
 *  "skill" (with its slug), or null. */
export function agentFileKind(text) {
  const t = String(text ?? "");
  if (/^---\r?\n/.test(t)) {
    const slug = skillSlugOf(t);
    return slug ? { kind: "skill", slug } : null;
  }
  let doc;
  try { doc = JSON.parse(t); } catch { return null; }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  if (doc.format === DESCRIPTOR_FORMAT) return { kind: "descriptor", doc };
  if (RUNTIME_FORMATS.includes(doc.format)) return { kind: "runtime", doc };
  const ext = doc.extensions;
  if (ext && typeof ext === "object" && (EXT in ext || /agent-plugins\.org/.test(String(doc.$schema ?? "")))) return { kind: "manifest", doc };
  return null;
}

/** One agent's own files among entries ({key, text}, in the order they
 *  came), or null unless a manifest, a descriptor and runtime requirements
 *  are all there. Returns {manifest, descriptor, runtime, skills: {slug:
 *  key}, used: [keys]}.
 *
 *  Several files can look like an agent's: two rounds of the spec writer's
 *  pieces in one message, or a prototype that is itself a package. So the
 *  manifest is chosen first (the last one carrying the builder's entry, else
 *  the last), then the descriptor whose agent_version is the manifest's
 *  version (else the last), then the last runtime requirements, and only the
 *  skills the chosen manifest's build entry names (or, with no build entry,
 *  the descriptor's offerings and steps), the later of two for one skill.
 *  Everything else is left where it was, an ordinary attachment. */
export function agentFilesAmongTexts(entries) {
  const of = { manifest: [], descriptor: [], runtime: [] };
  const skills = [];
  for (const { key, text } of entries ?? []) {
    const k = agentFileKind(text);
    if (!k) continue;
    if (k.kind === "skill") skills.push({ key, slug: k.slug });
    else of[k.kind].push({ key, doc: k.doc, sha256: createHash("sha256").update(String(text), "utf8").digest("hex") });
  }
  // A built package's manifest names its two files by digest: those files
  // are that package's (a prototype that is a package), never the agent's.
  const built = new Set();
  for (const m of of.manifest) {
    const own = m.doc.extensions?.[EXT] ?? {};
    for (const p of ["descriptor", "runtime_requirements", "install"]) if (typeof own[p]?.sha256 === "string") built.add(own[p].sha256);
  }
  of.descriptor = of.descriptor.filter((d) => !built.has(d.sha256));
  of.runtime = of.runtime.filter((r) => !built.has(r.sha256));
  const lastOf = (xs, ok = () => true) => [...xs].reverse().find(ok) ?? null;
  const manifest = lastOf(of.manifest, (m) => isObj(m.doc.extensions?.[EXT]?.build)) ?? lastOf(of.manifest);
  if (!manifest) return null;
  const version = manifest.doc.version;
  const descriptor = (version !== undefined && lastOf(of.descriptor, (d) => String(d.doc.agent_version) === String(version)))
    || lastOf(of.descriptor);
  const runtime = lastOf(of.runtime);
  if (!descriptor || !runtime) return null;
  const build = manifest.doc.extensions?.[EXT]?.build;
  const wanted = new Set(isObj(build?.skills)
    ? Object.keys(build.skills)
    : (descriptor.doc.offerings ?? []).flatMap((o) => [o?.id, ...(o?.steps ?? []).map((s) => s?.id)]).filter(Boolean));
  const chosen = {};
  for (const s of skills) if (wanted.has(s.slug)) chosen[s.slug] = s.key;
  return {
    manifest: manifest.key, descriptor: descriptor.key, runtime: runtime.key, skills: chosen,
    used: [descriptor.key, runtime.key, manifest.key, ...Object.values(chosen)],
  };
}

/** The same, among files by path: a job manifest is JSON too and is skipped
 *  by name. */
export function agentFilesAmong(files, read = (p) => readFileSync(p, "utf8")) {
  const entries = [];
  for (const f of files ?? []) {
    const path = typeof f === "string" ? f : f?.path;
    if (!path || /job-manifest\.json$/.test(path)) continue;
    try { entries.push({ key: path, text: read(path) }); } catch { /* unreadable is not one of them */ }
  }
  return agentFilesAmongTexts(entries);
}

/** Put the files agentFilesAmong found back into the layout under dir, by
 *  their bytes, into a folder emptied first so a skill from an earlier job
 *  cannot ride along. Returns dir. */
export function layOutAgentFiles(found, dir, readBytes = (p) => readFileSync(p)) {
  rmSync(dir, { recursive: true, force: true });
  const put = (rel, from) => {
    const at = join(dir, rel);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, readBytes(from));
  };
  put(DESCRIPTOR_FILE, found.descriptor);
  put(RUNTIME_FILE, found.runtime);
  put(MANIFEST_FILE, found.manifest);
  for (const [slug, p] of Object.entries(found.skills ?? {})) put(join("skills", slug, "SKILL.md"), p);
  return dir;
}
