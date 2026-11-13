// The build's artifacts (lifecycle API 0.4, build.artifacts): what the build
// has made and will make, in stage order, for the stages its lifecycle uses,
// each with a summary a person can read. Every summary is read from the files
// the build already holds: the agent's files from Requirements, the suite and
// the test writer's record of it, the scripts, the reviewers' documents from
// the pull request's gate, the package, its validation and build record, and
// the run plan. Nothing here makes content up, and nothing here writes.
//
//   as_built      the as-built record of Reverse engineering (lifecycle API 0.4.6): record.json
//                 and its five parts, read into one line per item, for a build started
//                 from existing code, or brought with a build started from an as-built record
//                 (0.4.7, with brought); a build that was neither has no such artifact
//   spec          the spec of Requirements (lifecycle API 0.4.8, stages.json 1.6.0):
//                 spec.json and spec.md from the spec writer (spec.mjs), read into a
//                 SpecSummary: each feature with its requirements and acceptance
//                 scenarios, the interfaces, the constraints and the open questions;
//                 each approval of a feature in a chat gives the spec a new version
//   statement     the agent's own files, made from the spec at Design (0.4.8), so it
//                 sits at Architecture and Design: agent-descriptor.json,
//                 agent-runtime-requirements.json, plugin.json, and still-open.md when
//                 the spec writer left a question. The reference spec writer makes them
//                 in the same job as the spec, and again at the Design within the
//                 architecture record (make-a-new-agent.txt v3), whose files then stand
//                 for them. A build whose spec writer handed back no
//                 spec (from before 1.6.0) carries the feature list here, as before
//   architecture  the architecture record (architecture-record-v1) the solution architect
//                 wrote, read into an ArchitectureSummary (lifecycle API 0.4.12,
//                 architecture.mjs), with the record served beside it
//   suite         the test files, with the names the test writer recorded (suite.json)
//   programs      the scripts Code handed back, the commit and the pull request
//   findings      the code critic's findings document, from the gate on the commit
//   security      the security reviewer's review, from the same gate
//   package       the archive, its digest (the build record), and validation.json
//   run_plan      run-plan.json, as the build keeps it
//   attestation   the conformance attestation (conformance.mjs): which Common Agent
//                 checks ran on the deployed package and how each came out, and which
//                 need the running agent and were not checked, in words
//
// A made artifact of the agent's own files, the architecture record, the
// security record, the package or the attestation also carries checks
// (lifecycle API 0.4.13): the Common Agent rules its stage applied, read from
// the same files by rule-checks.mjs, and only where those files speak to them.
//
// A stage Product Factory does not run (Release, Docs, and Architecture or
// Conformance on a build whose process has no phase for it) reads not_run or
// not_made, with why in words.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";
import { roleById } from "./standards.mjs";
import { piecesOf } from "./adapters.mjs";
import { openFindings, outsideFindings } from "./review.mjs";
import { statementVersion } from "./features.mjs";
import { specOfBuild, specSummary } from "./spec.mjs";
import { architectureSummary, readRecord } from "./architecture.mjs";
import { securityChecks, packageChecks, attestationChecks, statementChecks, architectureChecks, productsOf } from "./rule-checks.mjs";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const words = (s) => String(s ?? "").trim();
const short = (sha) => (sha ? String(sha).slice(0, 7) : null);
const roleWords = (id) => (roleById.get(id)?.name ?? id).toLowerCase();

/** The artifacts Product Factory knows, in stage order. runs: whether Product Factory makes it. */
export const ARTIFACTS = [
  { id: "as_built", stage: "reverse-engineering", kind: "as_built", name: "As-built record", role: "reverse-engineer", runs: true },
  { id: "spec", stage: "requirements", kind: "spec", name: "Spec", role: "spec-writer", runs: true },
  // The agent's own files are made at Design, from the spec (0.4.8); the spec writer makes them in its Requirements job.
  { id: "statement", stage: "architecture", kind: "statement", name: "The agent's own files", role: "spec-writer", runs: true },
  // Made where the build's process has an architecture phase, which the build keeps as its Architecture stage (runner.mjs).
  { id: "architecture", stage: "architecture", kind: "architecture", name: "Architecture record", role: "solution-architect", runs: "architecture" },
  { id: "suite", stage: "test", kind: "suite", name: "The suite", role: "test-writer", runs: true },
  { id: "programs", stage: "code", kind: "programs", name: "The programs", role: "code-writer", runs: true },
  { id: "findings", stage: "review", kind: "findings", name: "Review findings", role: "code-critic", runs: "pull-request" },
  { id: "security", stage: "security", kind: "security", name: "Security record", role: "security-reviewer", runs: "pull-request" },
  { id: "package", stage: "package", kind: "package", name: "The package", role: "package-maker", runs: true },
  { id: "build_record", stage: "release", kind: "build_record", name: "Signed build record", role: "package-maker", runs: false },
  { id: "run_plan", stage: "deploy", kind: "run_plan", name: "Run plan", role: "deployment-manager", runs: true },
  // Made where the build's run goes on past the deploy, which the build keeps as its Conformance stage (runner.mjs).
  { id: "attestation", stage: "conformance", kind: "attestation", name: "Conformance attestation", role: "conformance-checker", runs: "conformance" },
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
/** Where a build keeps its gate's runs and reviews: Code's pull request, or, for one builder, the reviews of its build folder. */
export const gateOf = (r) => r.work?.pr ?? r.work?.builder?.gate ?? null;

export function prCommit(r) {
  const pr = gateOf(r);
  if (!pr) return null;
  return pr.taken?.sha ?? pr.passed ?? [...(pr.runs ?? [])].reverse().find((x) => x.sha)?.sha ?? null;
}

/**
 * A reviewer's document from the gate on a commit: { at, path } inside the build folder, or null.
 * A version whose features are made in runs of their own keeps each run's gate in that run's folder (runs/<id>/).
 */
function reviewDoc(dir, sha, id, r = null) {
  if (!sha) return null;
  for (const base of [dir, ...(r?.feature_runs ?? []).map((fr) => join(dir, "runs", fr.id))]) {
    const job = join(base, "stages", "code", "pr", sha.slice(0, 12), "review", id, "job");
    if (!existsSync(job)) continue;
    const md = piecesOf(job).find((p) => /markdown/i.test(p.media_type ?? "") || /\.md$/i.test(p.path));
    return md ? { abs: md.abs, rel: relative(dir, md.abs).split("\\").join("/") } : null;
  }
  return null;
}

/** Why a reviewer was not asked, from the gate's own words on that commit, or null. */
function skippedWhy(r, sha, who) {
  const run = [...(gateOf(r)?.runs ?? [])].reverse().find((x) => x.sha === sha);
  const m = new RegExp(`${who} was not asked: ([^\\n]+)`, "i").exec(run?.summary ?? "");
  return m ? m[1].trim() : null;
}

/** The files the reviewers' documents are served at, beside the files the stages handed back: [{ path, at }]. */
export function reviewFiles(r, dir) {
  const sha = prCommit(r);
  const out = [];
  for (const [id, path] of [["critic", "review/findings.md"], ["security", "security/security-review.md"]]) {
    const d = reviewDoc(dir, sha, id, r);
    if (d) out.push({ path, at: d.rel });
  }
  return out;
}

// ---------- each kind, read from its files ----------

/** The spec of Requirements (0.4.8): spec.json read into a SpecSummary, with spec.md beside it. Its version moves with each approval of a feature in a chat. */
function spec(r, dir) {
  const got = specOfBuild(r, dir);
  if (!got) return null;
  const s = r.stages.requirements;
  const n = got.round ?? s.runs;
  const round = [...s.rounds].reverse().find((x) => x.n === n) ?? s.rounds.at(-1);
  const summary = specSummary(got.spec, { name: r.name, version: r.version });
  // A question the spec writer left in still-open.md and not in the spec is still open too.
  const openFile = (s.handed_back?.files ?? []).find((f) => f.path === "requirements/still-open.md");
  const more = openFile ? stillOpen(readText(inside(dir, openFile.at))) : [];
  for (const q of more) if (!summary.open.includes(q)) summary.open.push(q);
  // Written after the version was built (lifecycle API 0.4.14): no round of Requirements made it.
  if (got.after) return { version: "written after", at: got.after.at, files: got.files, summary, written_after: got.after };
  return { version: statementVersion(r, n) ?? `v${n}`, at: round?.at, files: got.files, summary };
}

/** The questions in still-open.md: one per list line, without its key. */
const stillOpen = (text) => String(text ?? "").split(/\r?\n/).filter((l) => /^-\s/.test(l)).map((l) => l.replace(/^-\s*(`[^`]*`:\s*)?/, "").trim()).filter(Boolean);

function statement(r, dir, { features = null } = {}) {
  // The Design's files, made again within the architecture record (make-a-new-agent.txt v3), stand for the ones drafted at Requirements.
  const designed = (r.stages.architecture?.handed_back?.files ?? []).filter((f) => /^design\//.test(f.path));
  const at = designed.some((f) => f.path === "design/agent-descriptor.json") ? "design" : "requirements";
  const s = at === "design" ? r.stages.architecture : r.stages.requirements;
  const files = at === "design" ? designed : (s?.handed_back?.files ?? []).filter((f) => !/^requirements\/spec\.(json|md)$/.test(f.path));
  const byName = (name) => files.find((f) => f.path === `${at}/${name}`);
  const desc = byName("agent-descriptor.json");
  if (!desc) return null;
  // With a spec (0.4.8) the feature list and its versions are the spec's; these are the files made from it.
  const fromSpec = Boolean(specOfBuild(r, dir));
  const descriptor = readJson(inside(dir, desc.at));
  const requirements = readJson(inside(dir, byName("agent-runtime-requirements.json")?.at));
  const d = descriptor ?? {};
  const req = requirements ?? {};
  const plugin = readJson(inside(dir, byName("plugin.json")?.at)) ?? {};
  const openFile = byName("still-open.md");
  const open = openFile ? stillOpen(readText(inside(dir, openFile.at))) : [];
  const n = roundOf(desc.at) ?? s.runs;
  const round = at === "design" ? [...s.rounds].reverse().find((x) => x.label === `Design ${n}`) ?? s.rounds.at(-1) : [...s.rounds].reverse().find((x) => x.n === n) ?? s.rounds.at(-1);
  const summary = {
    agent: `${words(plugin.name) || r.name} ${words(d.agent_version) || words(plugin.version) || r.version}`,
    offerings: (Array.isArray(d.offerings) ? d.offerings : []).map((o) => ({ name: words(o.name) || words(o.id), does: words(o.does) })),
    refuses: lines(d.refusals),
    records: (Array.isArray(d.records) ? d.records : []).map((x) => words(x?.name)).filter(Boolean),
    open,
  };
  const price = priceWords(req.price);
  if (price) summary.price = price;
  if (features?.length && !fromSpec) summary.features = features;
  // 0.4.13: the rules the agent's own files are held to, read from those files; the products are the architecture record's, where the build has one.
  const record = architectureFile(r, dir).text;
  const checks = statementChecks({ descriptor, requirements, products: record ? productsOf(readRecord(record)) : null });
  if (at === "design") return { version: `v${n}`, at: round?.at, files, summary, checks };
  return { version: fromSpec ? `v${n}` : statementVersion(r, n) ?? `v${n}`, at: round?.at, files, summary, checks };
}

/** The architecture record (0.4.12): read into an ArchitectureSummary, or, where it cannot be one, said in words. */
/** The architecture record's files, its own file among them, and its text, or null text where the build has none. */
function architectureFile(r, dir) {
  const files = (r.stages.architecture?.handed_back?.files ?? []).filter((f) => /^architecture\//.test(f.path));
  const rec = files.find((f) => f.path === "architecture/architecture-record.md");
  return { files, rec, text: rec ? readText(inside(dir, rec.at)) : null };
}

function architecture(r, dir) {
  const s = r.stages.architecture;
  const { files, rec, text } = architectureFile(r, dir);
  if (!text) return null;
  const n = r.work?.architecture?.n ?? roundOf(rec.at) ?? s.runs;
  const round = [...s.rounds].reverse().find((x) => x.n === n) ?? s.rounds.at(-1);
  const carried = r.work?.architecture?.carried;
  const summary = architectureSummary(text) ?? { words: "The record's header does not settle the agent's kind as one of the three the lifecycle API names, so its parts are not shown: read the record." };
  return { version: carried ? `carried from ${carried.version}` : `v${n}`, at: round?.at, files, summary, checks: architectureChecks(readRecord(text)) };
}

function suite(r, dir) {
  const s = r.stages.test;
  const files = (s?.handed_back?.files ?? []).filter((f) => /^test\//.test(f.path));
  if (!files.length) return null;
  const n = Math.max(...files.map((f) => roundOf(f.at) ?? 0)) || s.runs;
  const recorded = readJson(join(dir, "stages", "test", "records", `r${n}`, "suite.json"));
  const named = new Map((Array.isArray(recorded?.files) ? recorded.files : []).map((f) => [f.path, Array.isArray(f.names) ? f.names : []]));
  const tests = [];
  // Only test files name tests: a file an original test imports, under test/support/, or their record, is not one (test-writer 0.10.0).
  for (const f of files.filter((x) => /^test\/[^/]+\.test\.mjs$/.test(x.path))) tests.push(...(named.get(f.path) ?? testNames(readText(inside(dir, f.at)))));
  // A version whose features are made in runs of their own: its suite is as new as the newest run's round (feature-runs.mjs).
  const round = r.feature_runs?.length ? s.rounds.at(-1) : [...s.rounds].reverse().find((x) => x.n === n) ?? s.rounds.at(-1);
  const original = originalTests(files, dir);
  return { version: `v${n}`, at: round?.at, files, summary: { count: tests.length, tests, ...(original.length ? { original } : {}) } };
}

/**
 * The tests the suite carries from the original (test-writer 0.10.0), named
 * as the original named them: those of each test file the suite's record,
 * test/carried-tests.json, lists as placed. Empty when it carries none.
 */
function originalTests(files, dir) {
  const rec = files.find((f) => f.path === "test/carried-tests.json");
  const doc = rec ? readJson(inside(dir, rec.at)) : null;
  const placed = new Set((Array.isArray(doc?.placed) ? doc.placed : []).map((p) => String(p?.test ?? "")));
  const out = [];
  for (const f of files.filter((x) => placed.has(x.path))) out.push(...testNames(readText(inside(dir, f.at))));
  return out;
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
  const d = reviewDoc(dir, sha, "critic", r);
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
  const d = reviewDoc(dir, sha, "security", r);
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
    summary: {
      reach: reach.length ? reach : ["nothing it declares"], spend: spends.length ? spends.join("; ") : "nothing", never, verdict,
      // 0.4.12: the same parts as the reviewer's record lists them, so a client can show each with its reason.
      reaches: list("reaches").filter(isObj).map((x) => ({ system: words(x.system), access: words(x.access), reason: words(x.reason) })),
      spends: list("spends").filter(isObj).map((x) => ({ limit: words(x.limit), ...(words(x.ceiling) ? { ceiling: words(x.ceiling) } : {}) })),
      never_does: list("never_does").filter(isObj).map((x) => ({ act: words(x.act), ...(words(x.reason) ? { reason: words(x.reason) } : {}) })),
      no_reason_recorded: list("no_reason_recorded").map((x) => words(isObj(x) ? x.system ?? x.permission ?? JSON.stringify(x) : x)).filter(Boolean),
      ...(["present", "absent"].includes(words(head.architecture_record)) ? { architecture_record: words(head.architecture_record) } : {}),
    },
  };
  if (words(head.digest)) out.digest = words(head.digest);
  // 0.4.13: the rules the review applied, from its own record and the code critic's on the same commit.
  const critic = reviewDoc(dir, sha, "critic", r);
  out.checks = securityChecks(head, { critic: critic ? readText(critic.abs) : null, packageDigest: pkg(r, dir)?.digest ?? null });
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
  // 0.4.13: Section 12.10, from the packer's validate result the build recorded.
  out.checks = packageChecks(validation, r.settings?.packer);
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

// ---------- the as-built record (0.4.6) ----------

const list = (v, ...keys) => { for (const k of keys) if (Array.isArray(v?.[k])) return v[k]; return Array.isArray(v) ? v : []; };
const itemWords = (x) => (typeof x === "string" ? x : isObj(x) ? words(x.name ?? x.what ?? x.id ?? x.path ?? x.file ?? x.title ?? JSON.stringify(x)) : String(x ?? ""));
const evidenceWords = (e) => {
  const all = (Array.isArray(e) ? e : e ? [e] : []).map((x) => (typeof x === "string" ? x : isObj(x) ? [x.file, x.line].filter(Boolean).join(":") || words(x.run) : "")).filter(Boolean);
  return all.length ? ` (${all.join("; ")})` : "";
};
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * A gap of the as-built record in words: what it is about and why it could
 * not be determined, as the reverse engineer writes it ({ about, why }), else
 * what or words, as other records may. A gap given as words is itself.
 */
export function gapWords(g) {
  if (typeof g === "string") return g.trim();
  if (!isObj(g)) return "";
  const about = words(g.about);
  const why = words(g.why);
  if (about || why) return [about, why].filter(Boolean).join(": ");
  return words(g.what ?? g.words);
}

/** The architecture as built, one line per thing it names: parts, entry points, data stores, what it reaches, settings and credentials, how it starts. */
function architectureLines(a) {
  if (!isObj(a)) return [];
  const out = [];
  const labels = [["parts", "Part"], ["entry_points", "Entry point"], ["data_stores", "Data store"], ["reaches", "Reaches"], ["systems", "Reaches"], ["networks", "Network"], ["settings", "Setting"], ["credentials", "Credential"]];
  for (const [k, label] of labels) for (const x of Array.isArray(a[k]) ? a[k] : []) out.push(`${label}: ${itemWords(x)}${isObj(x) ? evidenceWords(x.evidence) : ""}`);
  for (const k of ["starts", "runs", "how_it_runs"]) if (typeof a[k] === "string" && a[k].trim()) out.push(`Starts and runs: ${a[k].trim()}`);
  return out;
}

function asBuilt(r, dir) {
  const s = r.stages["reverse-engineering"];
  const files = (s?.handed_back?.files ?? []).filter((f) => /^as-built\//.test(f.path));
  const at = (name) => inside(dir, files.find((f) => f.path === `as-built/${name}`)?.at);
  const record = readJson(at("record.json"));
  if (!record || s.state !== "done") return null;
  const behaviors = list(readJson(at("behaviors.json")), "behaviors");
  const arch = readJson(at("architecture.json")) ?? {};
  const interfaces = list(readJson(at("interfaces.json")), "interfaces");
  const sbom = readJson(at("sbom.cdx.json")) ?? {};
  const tg = readJson(at("tests-and-gaps.json")) ?? {};
  const commit = words(record.commit) || words(r.source?.commit);
  const repository = words(record.repository) || words(r.source?.shown);
  const ran = record.ran === true || /run/.test(words(record.mode ?? record.read_or_run));
  const trigger = words(record.trigger) === "drift" || r.source?.trigger === "drift" ? "drift" : "adoption";
  const since = words(record.since) || words(r.drift?.commit);
  const drift = trigger === "drift";

  const bItems = behaviors.map((b) => `${[words(b.id), words(b.name)].filter(Boolean).join(" ")}: ${words(b.does)}${evidenceWords(b.evidence)}${["new", "changed", "removed"].includes(b.change) ? ` [${b.change === "removed" ? "no longer there" : b.change}]` : ""}`);
  const aItems = architectureLines(arch);
  const iItems = interfaces.map((x) => (isObj(x) ? `${x.kind ? `${words(x.kind)[0].toUpperCase()}${words(x.kind).slice(1)}: ` : ""}${itemWords(x)}${x.format ? ` (${words(x.format)})` : ""}` : itemWords(x)));
  const comps = list(sbom, "components", "packages");
  const format = sbom.bomFormat ? `${sbom.bomFormat}${sbom.specVersion ? ` ${sbom.specVersion}` : ""}` : sbom.spdxVersion ? words(sbom.spdxVersion) : "a bill of materials";
  const dItems = comps.map((c) => `${words(c.name)}${c.version || c.versionInfo ? ` ${words(c.version ?? c.versionInfo)}` : ""}`);
  const tests = list(tg, "tests");
  const gaps = list(tg, "gaps");
  const base = isObj(tg.baseline) ? tg.baseline : null;
  const baseWords = base ? (words(base.words) || (Number.isInteger(base.passed) ? `Baseline run: ${base.passed} passed, ${base.failed ?? 0} failed${base.skipped ? `, ${base.skipped} skipped` : ""}.` : base.ran === false ? "No baseline run." : "")) : "";
  const tItems = [...tests.map((x) => `Test: ${itemWords(x)}${isObj(x) && x.covers ? `, covers ${itemWords(x.covers)}` : ""}`), ...gaps.map((g) => `Gap: ${gapWords(g) || itemWords(g)}${isObj(g) && (g.where || g.evidence) ? ` (${words(g.where) || evidenceWords(g.evidence).slice(2, -1)})` : ""}`)];
  const changed = drift ? " changed since the last record" : "";
  const shortC = commit.startsWith("sha256:") ? commit.slice(0, 19) : commit.slice(0, 7);
  const parts = [
    { part: "behaviors", name: "Behaviors", count: behaviors.length, words: behaviors.length ? `${count(behaviors.length, "behavior")}${changed}, each with its evidence, marked as built.` : drift ? "No behavior changed since the last record." : "No behavior was found.", items: bItems, file: "as-built/behaviors.json" },
    { part: "architecture", name: "Architecture as built", count: aItems.length, words: aItems.length ? `${count(aItems.length, "thing")} the code is made of, reaches or reads, marked as built.` : "Nothing named.", items: aItems, file: "as-built/architecture.json" },
    { part: "interfaces", name: "Interfaces", count: interfaces.length, words: interfaces.length ? `${count(interfaces.length, "interface")}: APIs, commands, messages and file formats.` : "No interface named.", items: iItems, file: "as-built/interfaces.json" },
    { part: "dependencies", name: "Dependencies", count: comps.length, words: `${comps.length ? count(comps.length, "component") : "No components"}, in ${format}.`, items: dItems, file: "as-built/sbom.cdx.json" },
    { part: "tests_and_gaps", name: "Existing tests and gaps", count: tests.length + gaps.length, words: `${count(tests.length, "existing test")} and ${count(gaps.length, "gap")} marked.${baseWords ? ` ${baseWords}` : ""}`, items: tItems, file: "as-built/tests-and-gaps.json" },
  ];
  const summary = {
    source: { repository, commit, ran, words: `${ran ? "Read and run" : "Read, not run,"} at ${shortC}, from ${repository}.` },
    trigger, ...(drift && since ? { since } : {}), parts,
  };
  // Brought with the build (the starting point as-built-record, 0.4.7): made elsewhere, not by this build's Reverse engineering.
  if (r.starting_point === "as-built-record" && r.record?.shown) summary.brought = { from: r.record.shown, words: `Brought from ${r.record.shown}. The code it describes is not taken on; Code writes the code fresh.` };
  const round = s.rounds.at(-1);
  return { version: shortC, at: round?.at, files, summary };
}

/** The conformance attestation: its words, and each check with its section and result, from the attestation's header. */
function attestation(r, dir) {
  const s = r.stages.conformance;
  const file = (s?.handed_back?.files ?? []).find((f) => f.path === "conformance/attestation.md");
  const text = file ? readText(inside(dir, file.at)) : null;
  if (!text) return null;
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const said = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ?? "";
  const checks = [...text.matchAll(/^\s+-\s+\{\s*id:\s*([a-z0-9-]+),\s*section:\s*"([^"]+)",\s*result:\s*([a-z_]+)\s*\}\s*$/gm)].map((m) => ({ id: m[1], section: m[2], result: m[3] }));
  const round = s.rounds.at(-1);
  return { version: r.version, at: round?.at, files: [file], summary: { words: said, checks }, checks: attestationChecks(text, r.settings?.packer) };
}

const READERS = { as_built: asBuilt, spec, statement, architecture, attestation, suite, programs, findings, security, package: pkg, run_plan: runPlan };

// ---------- the list ----------

/** A version built before the spec writer wrote specs, in words (lifecycle API 0.4.14). */
export const SPEC_BEFORE_WORDS = "This version was built before the spec writer wrote specs, so it has none. What it was asked to do is in the agent's own files.";

/** Whether build r's spec writer handed back the agent's own files and no spec, as one from before stages.json 1.6.0 does. */
export const builtBeforeSpecs = (r) => {
  const files = r.stages?.requirements?.handed_back?.files ?? [];
  return files.some((f) => f.path === "requirements/agent-descriptor.json") && !files.some((f) => f.path === "requirements/spec.json");
};

/** Why an artifact Product Factory does not make is not made, in words. */
function notRunWords(a, r) {
  if (a.kind === "build_record") {
    return r.stages.package?.state === "done"
      ? "Release did not run: Product Factory holds no signing key, so the package carries an unsigned build record. A platform that installs agents may ask for a signed one."
      : "Release does not run: Product Factory holds no signing key, so the package will carry an unsigned build record.";
  }
  if (a.kind === "architecture") return "This build's process has no architecture phase, so no architecture record was made; the spec writer made the agent's own files, its Design part, from the spec. The security reviewer says so in its record.";
  return `${a.stage === "docs" ? "Docs" : a.stage === "conformance" ? "Conformance" : a.stage} is in your lifecycle, but Product Factory does not run it yet. A platform that installs agents may ask for this.`;
}

/** Who makes an artifact, in words: the build's holder for a stage it runs, else the lifecycle's binding, else the role. */
function byOf(a, r) {
  if (a.kind === "run_plan") return "Product Factory";
  // The agent's own files sit at Architecture and Design, and the spec writer makes them.
  if (a.kind === "statement") return holderWords(r.stages.requirements?.holder ?? null, a.role);
  const own = r.stages[a.stage]?.holder;
  if (own && a.stage !== "deploy") return holderWords(own, a.role);
  return holderWords(r.lifecycle?.holders?.[a.role] ?? null, a.role);
}

/**
 * The build's artifacts, as the lifecycle API 0.4 answers them. dir: the
 * build's folder. link(path): the address a file is read at. features: the
 * statement's feature list (lifecycle API 0.4.3), when the product has one.
 * specBackfill: { offered, words }, whether the spec of a version built before
 * specs can be written now (lifecycle API 0.4.14).
 */
export function artifactsOf(r, { dir, link, features = null, specBackfill = null }) {
  const used = (stage) => r.lifecycle?.used?.[stage]?.used !== false;
  // The reviewers are asked at Code's gate on a pull request, or on a one-builder build once its folder's check passes.
  const onPr = r.settings?.code?.holder === "pull-request" || Boolean(r.one_builder);
  const ended = ["done", "stopped"].includes(r.status);
  let nextGiven = false;
  const out = [];
  for (const a of ARTIFACTS) {
    // The agent's own files are made by the spec writer even where the lifecycle leaves Architecture and Design out.
    if (!used(a.stage) && a.kind !== "statement") continue;
    if (a.kind === "statement" && !used("requirements")) continue;
    // Reverse engineering runs when needed: only a build started from existing code has its record.
    if (a.kind === "as_built" && !r.stages?.["reverse-engineering"]) continue;
    const base = { id: a.id, stage: a.stage, name: a.name, by: byOf(a, r), kind: a.kind };
    const made = READERS[a.kind]?.(r, dir, { features }) ?? null;
    if (made) {
      const one = { ...base, state: "made" };
      if (made.version) one.version = made.version;
      if (made.digest) one.digest = made.digest;
      if (made.at) one.at = made.at;
      one.summary = made.summary;
      if (made.checks?.length) one.checks = made.checks;
      if (made.written_after) one.written_after = made.written_after;
      one.files = made.files.map((f) => ({ path: f.path, size: f.size ?? sizeOf(inside(dir, f.at)), link: link(f.path) }));
      out.push(one);
      continue;
    }
    // A spec writer from before stages.json 1.6.0 hands back the agent's own files and no spec; it can be written now (0.4.14).
    if (a.kind === "spec" && builtBeforeSpecs(r)) {
      out.push({ ...base, state: "not_made", summary: { words: SPEC_BEFORE_WORDS }, ...(specBackfill ? { backfill: specBackfill } : {}) });
      continue;
    }
    const runs = a.runs === "pull-request" ? onPr : ["architecture", "conformance"].includes(a.runs) ? Boolean(r.stages?.[a.runs]) : a.runs;
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
