// The build's artifacts (lifecycle API 0.4, build.artifacts): what the build
// has made and will make, in stage order, for the stages its lifecycle uses,
// each with a summary a person can read. Every summary is read from the files
// the build already holds: the agent's files from Requirements, the suite and
// the test writer's record of it, the scripts, the reviewers' documents from
// the pull request's gate, the package, its validation and build record, and
// the run plan. Nothing here makes content up, and nothing here writes.
//
//   statement     agent-descriptor.json, agent-runtime-requirements.json, plugin.json,
//                 and still-open.md when the spec writer left a question
//   suite         the test files, with the names the test writer recorded (suite.json)
//   programs      the scripts Code handed back, the commit and the pull request
//   findings      the code critic's findings document, from the gate on the commit
//   security      the security reviewer's review, from the same gate
//   package       the archive, its digest (the build record), and validation.json
//   run_plan      run-plan.json, as the build keeps it
//
// A stage Product Factory does not run (Architecture, Release, Conformance,
// Docs) reads not_run or not_made, with why in words.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";
import { roleById } from "./standards.mjs";
import { piecesOf } from "./adapters.mjs";
import { openFindings, outsideFindings } from "./review.mjs";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const words = (s) => String(s ?? "").trim();
const short = (sha) => (sha ? String(sha).slice(0, 7) : null);
const roleWords = (id) => (roleById.get(id)?.name ?? id).toLowerCase();

/** The artifacts Product Factory knows, in stage order. runs: whether Product Factory makes it. */
export const ARTIFACTS = [
  { id: "statement", stage: "requirements", kind: "statement", name: "Statement of the job", role: "spec-writer", runs: true },
  { id: "architecture", stage: "architecture", kind: "architecture", name: "Architecture record", role: "solution-architect", runs: false },
  { id: "suite", stage: "test", kind: "suite", name: "The suite", role: "test-writer", runs: true },
  { id: "programs", stage: "code", kind: "programs", name: "The programs", role: "code-writer", runs: true },
  { id: "findings", stage: "review", kind: "findings", name: "Review findings", role: "code-critic", runs: "pull-request" },
  { id: "security", stage: "security", kind: "security", name: "Security record", role: "security-reviewer", runs: "pull-request" },
  { id: "package", stage: "package", kind: "package", name: "The package", role: "package-maker", runs: true },
  { id: "build_record", stage: "release", kind: "build_record", name: "Signed build record", role: "package-maker", runs: false },
  { id: "run_plan", stage: "deploy", kind: "run_plan", name: "Run plan", role: "deployment-manager", runs: true },
  { id: "attestation", stage: "conformance", kind: "attestation", name: "Conformance attestation", role: "conformance-checker", runs: false },
  { id: "agentdoc", stage: "docs", kind: "agentdoc", name: "AgentDoc", role: "documenter", runs: false },
];

/** The words for a holder: a reference agent by its role, anyone else by its own name. */
export function holderWords(h, role) {
  if (!h) return roleWords(role);
  if (h.kind === "reference_agent") return roleWords(h.role ?? role);
  return words(h.name) || roleWords(role);
}

const readText = (at) => { try { return readFileSync(at, "utf8"); } catch { return null; } };
const readJson = (at) => { try { return JSON.parse(readFileSync(at, "utf8")); } catch { return null; } };
const sizeOf = (at) => { try { return statSync(at).size; } catch { return 0; } };

/** A file inside the build folder by its path there, or null when it is outside or missing. */
function inside(dir, rel) {
  if (!rel) return null;
  const at = resolve(dir, rel);
  const back = relative(dir, at);
  if (!back || back.startsWith("..") || isAbsolute(back)) return null;
  return existsSync(at) ? at : null;
}

/** The round a file was made in, from its place in the build folder (…/r4/…). */
const roundOf = (at) => Number(/(?:^|\/)r(\d+)\//.exec(String(at ?? ""))?.[1] ?? 0) || null;

/** The first sentence of each line, for the refusals a descriptor gives in one string. */
function lines(text) {
  return String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = /^(.+?[.!?])(\s|$)/.exec(l);
    return (m ? m[1] : l).replace(/[.]$/, "");
  });
}

/** A price as the runtime requirements give it ({ model, ...}), in words. */
export function priceWords(p) {
  const v = isObj(p?.price) ? p.price : isObj(p) ? p : null;
  if (!v) return null;
  if (v.model === "free") return "free";
  const rest = Object.entries(v).filter(([k]) => k !== "model").map(([k, x]) => (isObj(x) ? `${k} ${JSON.stringify(x)}` : `${k} ${x}`));
  return [v.model, ...rest].filter(Boolean).join(" ") || null;
}

/** A Markdown document's YAML header, read as far as the reviewers write it: scalars, and lists of scalars or of flat maps. */
export function frontMatter(doc) {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(doc ?? ""))?.[1];
  if (head === undefined) return {};
  const val = (v) => { const t = v.trim(); if (!t) return ""; try { return JSON.parse(t); } catch { return t.replace(/^['"]|['"]$/g, ""); } };
  const out = {};
  let key = null;
  let item = null;
  for (const line of head.split(/\r?\n/)) {
    let m;
    if ((m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line))) {
      key = m[1]; item = null;
      out[key] = m[2].trim() === "" ? [] : val(m[2]);
      if (m[2].trim() === "[]") out[key] = [];
    } else if (key && Array.isArray(out[key]) && (m = /^\s+-\s+([A-Za-z_][\w-]*):\s*(.*)$/.exec(line))) {
      item = { [m[1]]: val(m[2]) };
      out[key].push(item);
    } else if (key && Array.isArray(out[key]) && (m = /^\s+-\s+(.*)$/.exec(line))) {
      item = null;
      out[key].push(val(m[1]));
    } else if (item && (m = /^\s+([A-Za-z_][\w-]*):\s*(.*)$/.exec(line))) {
      item[m[1]] = val(m[2]);
    }
  }
  return out;
}

/** The test names in a test file, as written: test("…") and it("…"). */
export function testNames(text) {
  const out = [];
  const re = /\b(?:test|it)\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
  let m;
  while ((m = re.exec(String(text ?? "")))) out.push(m[2].replace(/\\(.)/g, "$1"));
  return out;
}

/** What a script says it does: its first comment line, without its own name. */
export function scriptDoes(text) {
  const first = String(text ?? "").split(/\r?\n/).find((l) => l.trim() && !l.startsWith("#!"));
  const m = /^\s*\/\/\s*(.+)$/.exec(first ?? "");
  if (!m) return null;
  return m[1].replace(/^[\w./-]+\.m?js:\s*/, "").trim() || null;
}

const lineCount = (text) => { const t = String(text ?? ""); if (!t) return 0; const n = t.split("\n").length; return t.endsWith("\n") ? n - 1 : n; };

/** The commit Code's artifacts are from on a pull request: the one taken, else the one passed, else the newest judged. */
export function prCommit(r) {
  const pr = r.work?.pr;
  if (!pr) return null;
  return pr.taken?.sha ?? pr.passed ?? [...(pr.runs ?? [])].reverse().find((x) => x.sha)?.sha ?? null;
}

/** A reviewer's document from the gate on a commit: { at, path } inside the build folder, or null. */
function reviewDoc(dir, sha, id) {
  if (!sha) return null;
  const job = join(dir, "stages", "code", "pr", sha.slice(0, 12), "review", id, "job");
  if (!existsSync(job)) return null;
  const md = piecesOf(job).find((p) => /markdown/i.test(p.media_type ?? "") || /\.md$/i.test(p.path));
  return md ? { abs: md.abs, rel: relative(dir, md.abs).split("\\").join("/") } : null;
}

/** Why a reviewer was not asked, from the gate's own words on that commit, or null. */
function skippedWhy(r, sha, who) {
  const run = [...(r.work?.pr?.runs ?? [])].reverse().find((x) => x.sha === sha);
  const m = new RegExp(`${who} was not asked: ([^\\n]+)`, "i").exec(run?.summary ?? "");
  return m ? m[1].trim() : null;
}

/** The files the reviewers' documents are served at, beside the files the stages handed back: [{ path, at }]. */
export function reviewFiles(r, dir) {
  const sha = prCommit(r);
  const out = [];
  for (const [id, path] of [["critic", "review/findings.md"], ["security", "security/security-review.md"]]) {
    const d = reviewDoc(dir, sha, id);
    if (d) out.push({ path, at: d.rel });
  }
  return out;
}

// ---------- each kind, read from its files ----------

function statement(r, dir) {
  const s = r.stages.requirements;
  const files = s?.handed_back?.files ?? [];
  const byName = (name) => files.find((f) => f.path === `requirements/${name}`);
  const desc = byName("agent-descriptor.json");
  if (!desc) return null;
  const d = readJson(inside(dir, desc.at)) ?? {};
  const req = readJson(inside(dir, byName("agent-runtime-requirements.json")?.at)) ?? {};
  const plugin = readJson(inside(dir, byName("plugin.json")?.at)) ?? {};
  const openFile = byName("still-open.md");
  const open = openFile ? (readText(inside(dir, openFile.at)) ?? "").split(/\r?\n/).filter((l) => /^-\s/.test(l)).map((l) => l.replace(/^-\s*(`[^`]*`:\s*)?/, "").trim()).filter(Boolean) : [];
  const n = roundOf(desc.at) ?? s.runs;
  const round = [...s.rounds].reverse().find((x) => x.n === n) ?? s.rounds.at(-1);
  const summary = {
    agent: `${words(plugin.name) || r.name} ${words(d.agent_version) || words(plugin.version) || r.version}`,
    offerings: (Array.isArray(d.offerings) ? d.offerings : []).map((o) => ({ name: words(o.name) || words(o.id), does: words(o.does) })),
    refuses: lines(d.refusals),
    records: (Array.isArray(d.records) ? d.records : []).map((x) => words(x?.name)).filter(Boolean),
    open,
  };
  const price = priceWords(req.price);
  if (price) summary.price = price;
  return { version: `v${n}`, at: round?.at, files, summary };
}

function suite(r, dir) {
  const s = r.stages.test;
  const files = (s?.handed_back?.files ?? []).filter((f) => /^test\//.test(f.path));
  if (!files.length) return null;
  const n = Math.max(...files.map((f) => roundOf(f.at) ?? 0)) || s.runs;
  const recorded = readJson(join(dir, "stages", "test", "records", `r${n}`, "suite.json"));
  const named = new Map((Array.isArray(recorded?.files) ? recorded.files : []).map((f) => [f.path, Array.isArray(f.names) ? f.names : []]));
  const tests = [];
  for (const f of files) tests.push(...(named.get(f.path) ?? testNames(readText(inside(dir, f.at)))));
  const round = [...s.rounds].reverse().find((x) => x.n === n) ?? s.rounds.at(-1);
  return { version: `v${n}`, at: round?.at, files, summary: { count: tests.length, tests } };
}

function programs(r, dir) {
  const s = r.stages.code;
  const files = (s?.handed_back?.files ?? []).filter((f) => /^code\/scripts\//.test(f.path));
  if (!files.length) return null;
  const scripts = files.map((f) => {
    const text = readText(inside(dir, f.at)) ?? "";
    const one = { path: f.path.replace(/^code\//, ""), lines: lineCount(text) };
    const does = scriptDoes(text);
    if (does) one.does = does;
    return one;
  });
  const summary = { scripts };
  const pr = r.work?.pr;
  const sha = prCommit(r);
  if (sha) summary.commit = short(sha);
  if (pr?.number) summary.pr = { number: pr.number, url: pr.url };
  const round = s.rounds.at(-1);
  return { version: sha ? short(sha) : `v${s.rounds.length || 1}`, at: pr?.taken?.at ?? round?.at, files, summary };
}

function findings(r, dir) {
  const sha = prCommit(r);
  const d = reviewDoc(dir, sha, "critic");
  if (!d) return null;
  const doc = readText(d.abs) ?? "";
  const open = openFindings(doc);
  const outside = outsideFindings(doc);
  const count = /^-\s*open:\s*(\d+)\s*$/m.exec(doc);
  const n = count ? Number(count[1]) : open.length;
  const verdict = [n === 0 ? "Nothing open." : `${n} finding${n === 1 ? "" : "s"} open, to answer by a change or a reason.`];
  if (outside.length) verdict.push(`${outside.length} note${outside.length === 1 ? "" : "s"} outside the change, which ${outside.length === 1 ? "holds" : "hold"} nothing up.`);
  const summary = { open, verdict: verdict.join(" ") };
  if (outside.length) summary.outside = outside;
  const at = /^-\s*reviewed_at:\s*(\S+)/m.exec(doc)?.[1];
  return { version: `on ${short(sha)}`, at, files: [{ path: "review/findings.md", at: d.rel, size: sizeOf(d.abs) }], summary };
}

function security(r, dir) {
  const sha = prCommit(r);
  const d = reviewDoc(dir, sha, "security");
  if (!d) return null;
  const head = frontMatter(readText(d.abs));
  const list = (k) => (Array.isArray(head[k]) ? head[k] : []);
  const reach = list("reaches").map((x) => (isObj(x) ? `${words(x.system)}${x.access ? ` (${words(x.access)})` : ""}${x.reason ? `: ${words(x.reason)}` : ""}` : words(x))).filter(Boolean);
  const spends = list("spends").map((x) => (isObj(x) ? `${words(x.limit)}${x.ceiling ? ` (${words(x.ceiling)})` : ""}` : words(x))).filter(Boolean);
  const never = list("never_does").map((x) => (isObj(x) ? words(x.act) : words(x))).filter(Boolean);
  const refused = list("refused_for").map((x) => words(isObj(x) ? JSON.stringify(x) : x)).filter(Boolean);
  const v = words(head.verdict);
  const verdict = v === "passed" ? "Passed." : v === "refused" ? `Refused${refused.length ? `: ${refused.join("; ")}` : "."}` : v ? `${v[0].toUpperCase()}${v.slice(1)}.` : "No verdict in the review.";
  const out = {
    version: `on ${short(sha)}`, at: words(head.reviewed_at) || undefined,
    files: [{ path: "security/security-review.md", at: d.rel, size: sizeOf(d.abs) }],
    summary: { reach: reach.length ? reach : ["nothing it declares"], spend: spends.length ? spends.join("; ") : "nothing", never, verdict },
  };
  if (words(head.digest)) out.digest = words(head.digest);
  return out;
}

function pkg(r, dir) {
  const s = r.stages.package;
  const files = s?.handed_back?.files ?? [];
  const archive = files.find((f) => f.path.endsWith(".tar.gz"));
  if (!archive || s.state !== "done") return null;
  const record = readJson(inside(dir, files.find((f) => f.path.endsWith("-build.json"))?.at));
  const validation = readJson(inside(dir, files.find((f) => f.path.endsWith("validation.json"))?.at));
  const sha = words(record?.package?.sha256) || /sha256 ([0-9a-f]{64})/.exec(s.handed_back.words?.join(" ") ?? "")?.[1] || null;
  const summary = { file: archive.path.replace(/^package\//, ""), validated: validation?.ok === true };
  const out = { version: words(record?.package?.version) || r.version, at: s.rounds.at(-1)?.at, files, summary };
  if (sha) { summary.digest = `sha256:${sha}`; out.digest = summary.digest; }
  return out;
}

function runPlan(r, dir) {
  if (!r.plan?.at) return null;
  const at = inside(dir, r.plan.at);
  if (!at) return null;
  const doc = readJson(at) ?? {};
  const stages = (Array.isArray(r.plan.stages) ? r.plan.stages : Array.isArray(doc.stages) ? doc.stages : []).filter((e) => e.used !== false).map((e) => ({
    stage: e.stage, name: e.name ?? e.stage,
    holder: e.holder ? holderWords(e.holder, e.role) : null,
    settings: Object.keys(isObj(e.settings) ? e.settings : {}).length ? Object.entries(e.settings).map(([k, v]) => `${k}: ${isObj(v) || Array.isArray(v) ? JSON.stringify(v) : v}`).join("; ") : "no settings",
    reads: e.reads ?? (e.chosen ? "chosen" : "not chosen"),
  }));
  return { version: r.version, at: doc.made, files: [{ path: "package/run-plan.json", at: r.plan.at, size: sizeOf(at) }], summary: { stages } };
}

const READERS = { statement, suite, programs, findings, security, package: pkg, run_plan: runPlan };

// ---------- the list ----------

/** Why an artifact Product Factory does not make is not made, in words. */
function notRunWords(a, r) {
  if (a.kind === "build_record") {
    return r.stages.package?.state === "done"
      ? "Release did not run: Product Factory holds no signing key, so the package carries an unsigned build record. A platform that installs agents may ask for a signed one."
      : "Release does not run: Product Factory holds no signing key, so the package will carry an unsigned build record.";
  }
  if (a.kind === "architecture") return "Architecture and Design is in your lifecycle, but Product Factory does not run it yet, so no architecture record is made. The security reviewer says so in its record.";
  return `${a.stage === "docs" ? "Docs" : a.stage === "conformance" ? "Conformance" : a.stage} is in your lifecycle, but Product Factory does not run it yet. A platform that installs agents may ask for this.`;
}

/** Who makes an artifact, in words: the build's holder for a stage it runs, else the lifecycle's binding, else the role. */
function byOf(a, r) {
  if (a.kind === "run_plan") return "Product Factory";
  const own = r.stages[a.stage]?.holder;
  if (own && a.stage !== "deploy") return holderWords(own, a.role);
  return holderWords(r.lifecycle?.holders?.[a.role] ?? null, a.role);
}

/**
 * The build's artifacts, as the lifecycle API 0.4 answers them. dir: the
 * build's folder. link(path): the address a file is read at.
 */
export function artifactsOf(r, { dir, link }) {
  const used = (stage) => r.lifecycle?.used?.[stage]?.used !== false;
  const onPr = r.settings?.code?.holder === "pull-request";
  const ended = ["done", "stopped"].includes(r.status);
  let nextGiven = false;
  const out = [];
  for (const a of ARTIFACTS) {
    if (!used(a.stage)) continue;
    const base = { id: a.id, stage: a.stage, name: a.name, by: byOf(a, r), kind: a.kind };
    const made = READERS[a.kind]?.(r, dir) ?? null;
    if (made) {
      const one = { ...base, state: "made" };
      if (made.version) one.version = made.version;
      if (made.digest) one.digest = made.digest;
      if (made.at) one.at = made.at;
      one.summary = made.summary;
      one.files = made.files.map((f) => ({ path: f.path, size: f.size ?? sizeOf(inside(dir, f.at)), link: link(f.path) }));
      out.push(one);
      continue;
    }
    const runs = a.runs === "pull-request" ? onPr : a.runs;
    if (!runs) {
      const why = a.runs === "pull-request"
        ? `Product Factory asks the ${roleWords(a.role)} at the gate on a pull request. This build's Code is held on this computer, so the suite is the gate and the ${roleWords(a.role)} is not asked.`
        : notRunWords(a, r);
      out.push({ ...base, state: a.kind === "build_record" && r.stages.package?.state === "done" ? "not_made" : "not_run", summary: { words: why } });
      continue;
    }
    // A reviewer the gate did not ask on the commit it judged says why.
    if (a.runs === "pull-request" && prCommit(r)) {
      const why = skippedWhy(r, prCommit(r), a.role === "code-critic" ? "the code critic" : "the security reviewer");
      if (why) { out.push({ ...base, state: "not_run", summary: { words: `The gate on ${short(prCommit(r))} did not ask the ${roleWords(a.role)}: ${why}` } }); continue; }
    }
    if (ended) {
      out.push({ ...base, state: "not_made", summary: { words: r.status === "stopped" ? "The build was stopped before this was made." : "The build ended before this was made." } });
      continue;
    }
    out.push({ ...base, state: nextGiven ? "later" : "next" });
    nextGiven = true;
  }
  return out;
}
