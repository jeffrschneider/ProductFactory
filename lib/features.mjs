// Features (lifecycle API 0.4.3). The statement of the job carries a feature
// list: each feature has a stable id (F1, F2, ...), a name, what it does, and
// the offering of the statement it belongs to. Features change through chat:
// when a stage's agent (mainly the spec writer) or the boss lands on a new or
// changed feature, its reply carries a proposal, and the person answers that
// one feature there:
//
//   approve    a gate decision of Requirements for that feature alone, recorded
//              with who, when and the message; the statement gets a new version
//   not_now    it stays proposed, a backlog item linked to the conversation
//   ask        a person who may not answer Requirements asks its approvers, who
//              are told (notices.mjs) and see the same proposal with its button
//
// Everything is kept as events in each build's record (build.json
// "feature_log"), never rewritten: a proposal, and each answer to it, is a
// record of its own. The product's features are those events folded in time
// order across its builds, so a feature keeps its id and its history from one
// version to the next. Tests name the feature they check by starting with its
// id in square brackets ("[F3] counts an empty passage as none"), so a round
// of the gate reports its results per feature (byFeature), and the matrix
// (matrixOf) holds each feature against the spec, the tests, the code, the
// review and the docs.
//
// The approved features reach the spec writer and the test writer as lines of
// the run's material aimed at their phases (materialLines): the reference
// agents read them as part of what they were asked, and need no change.
//
// Lifecycle API 0.4.5: each every-build stage carries its slice of the
// features (slicesOf), with a count for the spine (countsOf). A product built
// before features can have them listed by the spec writer from its statement
// (thread.mjs backfillRules): each listed proposal is kept with "listed" and
// the tests already in the build it maps ("tests", only the suite's own
// names), and a feature's tests are those naming it and those mapped to it
// (testsOf). approveAll approves several proposals as one batch.

import { randomBytes } from "node:crypto";
import { Refused } from "./lifecycle.mjs";
import { featuresOfTest, FEATURE_COLUMNS } from "../standards/lifecycle-api-check.mjs";

export { featuresOfTest, FEATURE_COLUMNS };

const words = (s) => String(s ?? "").trim();
const byTime = (a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
const ID = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const DECISIONS = new Set(["approve", "not_now", "ask"]);
const NAME_LIMIT = 120;
const DOES_LIMIT = 600;
const same = (a, b) => words(a.name) === words(b.name) && words(a.does) === words(b.does) && words(a.offering) === words(b.offering);
const content = (x) => ({ name: x.name, does: x.does, offering: x.offering });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The builds of a product up to and including build b, oldest first (a later version never changes an earlier one's features). */
export function buildsUpTo(builds, b) {
  const created = (r) => String(r.created ?? "");
  return builds.filter((r) => r.id === b.id || created(r) <= created(b)).sort((x, y) => created(x).localeCompare(created(y)));
}

/** The version before build b's, among a product's builds: the newest build created before it. */
export function earlierBuild(builds, b) {
  return builds.filter((r) => r.id !== b.id && String(r.created ?? "") < String(b.created ?? "")).sort((x, y) => String(y.created).localeCompare(String(x.created)))[0] ?? null;
}

/** Every feature event of these builds, oldest first, each with the build and version it was kept on. */
export function eventsOf(builds) {
  return builds.flatMap((r) => (Array.isArray(r.feature_log) ? r.feature_log : []).map((e) => ({ ...e, build: r.id, version: r.version }))).sort(byTime);
}

/** Where a proposal's answer stands: approved, not_now, asked, replaced or open. */
function proposalState(p, events) {
  const answers = events.filter((e) => e.proposal === p.id);
  if (answers.some((e) => e.kind === "approved")) return "approved";
  const newer = events.some((e) => e.kind === "proposed" && e.feature === p.feature && e.at > p.at && e.id !== p.id);
  if (newer) return "replaced";
  const last = answers.filter((e) => e.kind === "not_now" || e.kind === "asked").at(-1);
  return last ? last.kind : "open";
}

/**
 * The product's features from its events: id -> { id, name, does, offering,
 * state, backlog, approved, approvedAt, pending, proposals, events }. A feature
 * is approved once any of its proposals was; its words are those of its newest
 * approval, and a newer proposal waiting for an answer is pending. A feature
 * never approved reads as its newest proposal.
 */
export function registerOf(events) {
  const out = new Map();
  for (const e of events) {
    if (!out.has(e.feature)) out.set(e.feature, { id: e.feature, events: [], proposals: [] });
    const f = out.get(e.feature);
    f.events.push(e);
    if (e.kind === "proposed") f.proposals.push(e);
  }
  for (const f of out.values()) {
    const states = new Map(f.proposals.map((p) => [p.id, proposalState(p, events)]));
    const approvals = f.events.filter((e) => e.kind === "approved");
    const lastApproval = approvals.at(-1) ?? null;
    const approvedProposal = lastApproval ? f.proposals.find((p) => p.id === lastApproval.proposal) : null;
    const newest = f.proposals.at(-1);
    const base = approvedProposal ?? newest;
    Object.assign(f, content(base));
    f.state = approvedProposal ? "approved" : "proposed";
    f.approved = lastApproval ? { by: lastApproval.by, at: lastApproval.at, build: lastApproval.build, version: lastApproval.version } : null;
    f.approvedAt = lastApproval?.at ?? null;
    // When its words last changed, for what was made before it: a feature listed after the build (0.4.5)
    // describes what was already made, so approving it changes nothing that was made.
    f.changedAt = approvedProposal?.listed ? null : f.approvedAt;
    const waiting = f.proposals.filter((p) => ["open", "asked", "not_now"].includes(states.get(p.id)) && (!lastApproval || p.at > lastApproval.at)).at(-1) ?? null;
    f.pending = waiting;
    f.states = states;
    f.backlog = waiting ? states.get(waiting.id) === "not_now" : false;
    // The tests mapped to it when the features were listed after the build: its newest proposal that mapped any.
    f.tests = [...f.proposals].reverse().find((p) => Array.isArray(p.tests))?.tests ?? [];
  }
  return out;
}

/** A feature's id for a new feature: one past the highest F<n> the product has given. */
export function nextId(events) {
  let top = 0;
  for (const e of events) {
    const m = /^F(\d+)$/.exec(e.feature ?? "");
    if (m) top = Math.max(top, Number(m[1]));
  }
  return `F${top + 1}`;
}

/** An offering's name as the statement gives it, matched by name or id; the only offering when there is one; else the words as said. */
export function offeringOf(said, offerings = []) {
  const t = words(said).toLowerCase();
  const hit = offerings.find((o) => words(o.name).toLowerCase() === t || words(o.id).toLowerCase() === t);
  if (hit) return words(hit.name) || words(hit.id);
  if (offerings.length === 1) return words(offerings[0].name) || words(offerings[0].id);
  return words(said);
}

/**
 * A feature from a model's reply ({ id?, name, does, offering, tests? }),
 * checked; null when it is not one. tests (0.4.5): the names of tests already
 * in the build that the agent says check it, kept only when given.
 */
export function readFeature(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const name = words(v.name).slice(0, NAME_LIMIT);
  const does = words(v.does).slice(0, DOES_LIMIT);
  if (!name || !does) return null;
  const id = typeof v.id === "string" && ID.test(v.id.trim()) ? v.id.trim() : null;
  const out = { id, name, does, offering: words(v.offering) };
  if (Array.isArray(v.tests)) out.tests = [...new Set(v.tests.filter((t) => typeof t === "string").map(words).filter(Boolean))].slice(0, 200);
  return out;
}

/** The features a reply proposes: "features" (a list) or "feature" (one), each checked. limit: how many are kept (a listing after the build may hold more). */
export function featuresInReply(v, { limit = 12 } = {}) {
  if (!v || typeof v !== "object") return [];
  const list = Array.isArray(v.features) ? v.features : v.feature ? [v.feature] : [];
  return list.map(readFeature).filter(Boolean).slice(0, limit);
}

/**
 * The tests a listing after the build maps to features, kept only where the
 * name is one of the suite's own (known): a name the suite does not have is
 * dropped, never matched loosely.
 */
export function keepKnownTests(said, known) {
  const names = new Set((known ?? []).map(words));
  return said.map((f) => (Array.isArray(f.tests) ? { ...f, tests: f.tests.filter((t) => names.has(words(t))) } : f));
}

/** The test names that name a feature. */
export const testsFor = (names, id) => (Array.isArray(names) ? names : []).filter((n) => featuresOfTest(n).includes(id));

/**
 * The tests that check feature f (0.4.5): those whose names start with its id,
 * and those mapped to it when the features were listed after the build (f.tests).
 */
export const testsOf = (names, f) => {
  const mapped = new Set((f?.tests ?? []).map(words));
  return (Array.isArray(names) ? names : []).filter((n) => featuresOfTest(n).includes(f.id) || mapped.has(words(n)));
};

/** The tests that check no feature of the register: neither named nor mapped. Left so, never guessed. */
export function unmappedTests(names, reg) {
  const list = [...reg.values()];
  return (Array.isArray(names) ? names : []).filter((n) => !list.some((f) => testsOf([n], f).length));
}

/** A round's results per feature: [{ feature, passed, total }] for each feature the suite's tests name, from the names that failed. */
export function byFeature(names, failing = []) {
  const failed = new Set((failing ?? []).map((n) => words(n)));
  const out = new Map();
  for (const n of Array.isArray(names) ? names : []) {
    for (const id of featuresOfTest(n)) {
      const x = out.get(id) ?? { feature: id, passed: 0, total: 0 };
      x.total += 1;
      if (!failed.has(words(n))) x.passed += 1;
      out.set(id, x);
    }
  }
  return [...out.values()].sort((a, b) => a.feature.localeCompare(b.feature, "en", { numeric: true }));
}

/** A round's results per feature, in words: "By feature: F1 2 of 2 pass; F2 0 of 1 pass." Empty when no test names a feature. */
export function byFeatureWords(list) {
  if (!list?.length) return "";
  return `By feature: ${list.map((x) => `${x.feature} ${x.passed} of ${x.total} pass`).join("; ")}.`;
}

/**
 * The lines of the run's material aimed at the spec writer's and the test
 * writer's phases, for the approved features: `[<phase>] ...`, which the
 * process runner hands to that phase alone (orchestrator.mjs phaseMaterial).
 */
export function materialLines(features, { spec = "write-the-spec", suite = "write-the-suite" } = {}) {
  const list = features.filter((f) => f.state === "approved");
  if (!list.length) return "";
  const line = (f) => `- ${f.id} (offering ${f.offering || "not named"}): ${f.name}. ${f.does}`;
  return [
    `[${spec}] features: the owner approved these; keep each one in the spec, by its id and in its offering:`,
    ...list.map((f) => `[${spec}] ${line(f)}`),
    `[${suite}] features: the owner approved these:`,
    ...list.map((f) => `[${suite}] ${line(f)}`),
    `[${suite}] Name each test that checks one of these features starting with the feature's id in square brackets, such as "[${list[0].id}] ${list[0].name.toLowerCase()}". A test that checks two names both: "[${list[0].id}, ${list[list.length > 1 ? 1 : 0].id}] ...".`,
  ].join("\n");
}

/** The lines a build's statement carries: every feature approved, and every one proposed and not yet approved. */
export function statementFeatures(reg) {
  return [...reg.values()].sort(order).map((f) => ({ id: f.id, name: f.name, does: f.does, offering: f.offering, state: f.state }));
}

/** F2 before F10. */
const order = (a, b) => a.id.localeCompare(b.id, "en", { numeric: true });

/**
 * The newest code round that ran the suite, local or on a pull request:
 * { at, failing, label } or null. A round that passed the gate ran the whole
 * suite with nothing failing, so a passing round kept before rounds recorded
 * their failing tests (a build from before features) reads as none failing.
 */
export function lastRun(r) {
  const rounds = r.stages?.code?.rounds ?? [];
  for (const x of [...rounds].reverse()) {
    if (Array.isArray(x.failing)) return { at: x.at, failing: x.failing, label: x.label };
    if (x.back === false && x.at) return { at: x.at, failing: [], label: x.label };
  }
  return null;
}

/**
 * When the chat approvals on build r make its statement's version: v<n> with n
 * the spec writer's round the statement is from (base), else its delivered
 * rounds, and one more per approval in a chat; the features approved together
 * with Approve all (one batch) make one version. Null without any.
 */
export function statementVersion(r, base = null) {
  const chat = new Set((Array.isArray(r.feature_log) ? r.feature_log : []).filter((e) => e.kind === "approved" && e.via === "chat").map((e) => e.batch ?? e.id)).size;
  if (!chat) return null;
  const rounds = Number.isInteger(base) && base > 0 ? base : (r.stages?.requirements?.rounds ?? []).filter((x) => !["Refused", "Not run"].includes(x.verdict)).length;
  return `v${rounds + chat}`;
}

// ---------- the matrix ----------

const cellOf = (state, said, extra = {}) => ({ state, words: said, ...extra });
const linkTo = (b, a, id) => (a?.state === "made" ? { link: { build: b.id, stage: a.stage, artifact: a.id, feature: id } } : {});

/** One feature's cells against build b's artifacts. arts: id -> artifact. */
export function cellsOf(f, b, arts) {
  const statement = arts.get("statement");
  const suite = arts.get("suite");
  const programs = arts.get("programs");
  const findings = arts.get("findings");
  const doc = arts.get("agentdoc");
  const changedAt = f.changedAt;
  const made = (a) => a?.state === "made";

  const spec = f.state !== "approved"
    ? cellOf("missing", f.backlog ? "In the backlog, not approved" : "Proposed, not approved", linkTo(b, statement, f.id))
    : !made(statement) ? cellOf("missing", "No statement yet")
      : cellOf("done", `Spec ${statement.version ?? ""}`.trim(), linkTo(b, statement, f.id));

  const names = made(suite) ? testsOf(suite.summary?.tests, f) : [];
  const run = lastRun(b);
  const ranOn = run && made(suite) && (!suite.at || run.at >= suite.at) ? run : null;
  const failed = ranOn ? names.filter((n) => ranOn.failing.map(words).includes(words(n))).length : null;
  const passed = failed === null ? null : names.length - failed;
  const t = { tests: { passed, total: names.length } };
  let tests;
  if (!made(suite)) tests = cellOf("missing", "No suite yet");
  else if (!names.length) tests = cellOf("missing", `No test names ${f.id}`, linkTo(b, suite, f.id));
  else if (changedAt && suite.at && suite.at < changedAt) tests = cellOf("stale", `${plural(names.length, "test")}, written before ${f.id} changed`, { tests: { passed: null, total: names.length }, ...linkTo(b, suite, f.id) });
  else if (passed === null) tests = cellOf("done", plural(names.length, "test"), { ...t, ...linkTo(b, suite, f.id) });
  else tests = cellOf(passed < names.length ? "failing" : "done", `Tests ${passed}/${names.length}`, { ...t, ...linkTo(b, suite, f.id) });

  let code;
  if (!made(programs)) code = cellOf("missing", "No code yet");
  else if (!names.length) code = cellOf("missing", `No test checks ${f.id}`, linkTo(b, programs, f.id));
  else if ((changedAt && programs.at && programs.at < changedAt) || (made(suite) && suite.at && programs.at && programs.at < suite.at)) code = cellOf("stale", `Written before ${changedAt && programs.at < changedAt ? `${f.id} changed` : "the suite changed"}`, linkTo(b, programs, f.id));
  else if (passed === null) code = cellOf("missing", "Not run against the suite yet", linkTo(b, programs, f.id));
  else code = cellOf(passed < names.length ? "failing" : "done", `Passes ${passed}/${names.length}`, { ...t, ...linkTo(b, programs, f.id) });

  let review;
  if (!made(findings)) review = cellOf("missing", findings?.state === "not_run" ? "Not reviewed here" : "Not reviewed yet");
  else if (made(programs) && findings.at && programs.at && findings.at < programs.at) review = cellOf("stale", `Reviewed ${findings.version ?? ""}, before the code changed`.replace("  ", " "), linkTo(b, findings, f.id));
  else review = cellOf("done", `Reviewed ${findings.version ?? ""}`.trim(), linkTo(b, findings, f.id));

  const docs = made(doc) ? cellOf(changedAt && doc.at && doc.at < changedAt ? "stale" : "done", `Docs ${doc.version ?? ""}`.trim(), linkTo(b, doc, f.id)) : cellOf("missing", doc?.state === "not_run" ? "Not run here" : "No docs yet");

  return { spec, tests, code, review, docs };
}

/** A feature's badge for this version, against the register of the version before: new, changed or unchanged. */
export function badgeOf(f, before) {
  const was = before?.get(f.id);
  if (!was || was.state !== "approved") return "new";
  if (f.state !== "approved") return "unchanged";
  return same(f, was) ? "unchanged" : "changed";
}

/**
 * The features matrix for build b of a product (GET /builds/:id/features and
 * GET /products/:name/features). builds: the product's builds. artifactsFor(r):
 * the build's artifacts.
 */
export function matrixOf(builds, b, { artifactsFor, pendingView = null, backfill = null }) {
  const reg = registerOf(eventsOf(buildsUpTo(builds, b)));
  const prev = earlierBuild(builds, b);
  const before = prev ? registerOf(eventsOf(buildsUpTo(builds, prev))) : null;
  const arts = new Map(artifactsFor(b).map((a) => [a.id, a]));
  const suite = arts.get("suite");
  const names = suite?.state === "made" ? (suite.summary?.tests ?? []) : null;
  const seen = new Set();
  const versions = [...builds].sort((x, y) => String(y.created).localeCompare(String(x.created))).filter((r) => (seen.has(r.version) ? false : seen.add(r.version))).map((r) => ({ version: r.version, build: r.id }));
  const row = (f) => {
    const out = { id: f.id, name: f.name, does: f.does, offering: f.offering, state: f.state, backlog: f.backlog, badge: badgeOf(f, before), cells: cellsOf(f, b, arts) };
    // 0.4.5: the proposal waiting for an answer, where the feature's newest proposal was said, and the tests that check it.
    if (f.pending && pendingView) out.pending = pendingView(f.pending, reg);
    const said = f.proposals.at(-1);
    if (said?.from?.message) out.from = { build: said.from.build ?? said.build, message: said.from.message, ...(said.from.stage ? { stage: said.from.stage } : {}) };
    if (names) out.tests = testsOf(names, f);
    return out;
  };
  const out = {
    product: b.name, build: b.id, version: b.version, versions,
    columns: [...FEATURE_COLUMNS],
    features: [...reg.values()].sort(order).map(row),
  };
  if (names && reg.size) out.unmapped = unmappedTests(names, reg);
  if (backfill) out.backfill = backfill;
  if (!out.features.length) out.words = backfill?.offered
    ? "No features yet. This build was made before features: the spec writer can list them from the statement of the job, and map the tests already in the build to them."
    : "No features yet. They are settled in a chat, mostly the Requirements chat: when the spec writer or the boss proposes one, its reply has an Approve feature button.";
  return out;
}

// ---------- each stage's slice (0.4.5) ----------

/** The tests in a test file with the line each starts at: [{ name, line }]. */
export function testLines(text) {
  const out = [];
  const lines = String(text ?? "").split(/\r?\n/);
  const re = /\b(?:test|it)\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
  lines.forEach((l, i) => {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(l))) out.push({ name: m[2].replace(/\\(.)/g, "$1"), line: i + 1 });
  });
  return out;
}

/**
 * The feature ids a review finding is tied to, through the tests: its place
 * names a line in a test file of the suite (the test it falls in checks those
 * features), or its words quote a test's name. Empty when neither: a place in
 * a script is not tied to a feature, since nothing says which feature it serves.
 * files: [{ path, text }] of the suite. reg: the register.
 */
export function findingFeatures(finding, files, reg) {
  const ids = new Set();
  const tie = (name) => { for (const f of reg.values()) if (testsOf([name], f).length) ids.add(f.id); };
  const m = /^(.+?):(\d+)(?:[-:]\d+)?$/.exec(words(finding?.place));
  if (m) {
    const file = m[1].replace(/\\/g, "/").replace(/^\.\//, "");
    const hit = files.find((x) => x.path === file || x.path.endsWith(`/${file}`) || file.endsWith(`/${x.path}`) || x.path.replace(/^test\//, "") === file.replace(/^test\//, ""));
    if (hit) {
      const at = testLines(hit.text).filter((t) => t.line <= Number(m[2])).at(-1);
      if (at) tie(at.name);
    }
  }
  const said = `${words(finding?.claim)} ${words(finding?.consequence)}`;
  for (const f of files) for (const t of testLines(f.text)) if (t.name.length > 8 && said.includes(t.name)) tie(t.name);
  return [...ids].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

const sliceItem = (f, state, said, extra = {}) => ({ id: f.id, name: f.name, state, words: said, ...extra });
const countOf = (s) => ({ covered: s.covered, total: s.total, words: s.words });

/**
 * Each every-build stage's features at build b (0.4.5): stage -> { stage,
 * covered, total, words, items, untied? }. Requirements: each feature and
 * whether it is approved. Test: the tests per approved feature, a feature with
 * none to do. Code: how many of its tests pass. Review: the findings tied to it
 * through its tests, the rest not tied to a feature. Docs: whether the docs
 * name it, once they are made. A stage whose artifact is not made yet has none,
 * and a build with no features has none at all.
 * textOf(path): a file the build handed back, as text, or null.
 */
export function slicesOf(builds, b, { artifactsFor, textOf = () => null }) {
  const reg = registerOf(eventsOf(buildsUpTo(builds, b)));
  if (!reg.size) return {};
  const arts = new Map(artifactsFor(b).map((a) => [a.id, a]));
  const made = (id) => arts.get(id)?.state === "made";
  const all = [...reg.values()].sort(order);
  const approved = all.filter((f) => f.state === "approved");
  const total = approved.length;
  const out = {};

  const req = all.filter((f) => !(f.backlog && f.state !== "approved"));
  out.requirements = {
    stage: "requirements", covered: approved.length, total: req.length,
    words: `${approved.length} of ${req.length} approved`,
    items: all.map((f) => {
      const changing = f.pending && f.states.get(f.pending.id) !== "not_now" && f.state === "approved";
      if (f.state === "approved") return sliceItem(f, changing ? "stale" : "done", changing ? "Approved; a change waits for an answer" : "Approved");
      return sliceItem(f, "to_do", f.backlog ? "Not now: in the backlog" : "Proposed, not approved yet");
    }),
  };

  const cells = new Map(approved.map((f) => [f.id, cellsOf(f, b, arts)]));
  const suite = arts.get("suite");
  const names = made("suite") ? (suite.summary?.tests ?? []) : [];
  const plural2 = (n, one) => plural(n, one);

  if (made("suite")) {
    const items = approved.map((f) => {
      const t = testsOf(names, f);
      const c = cells.get(f.id).tests;
      if (!t.length) return sliceItem(f, "to_do", "No test yet: to do", { tests: [] });
      return sliceItem(f, c.state === "stale" ? "stale" : "done", c.state === "stale" ? `${plural2(t.length, "test")}, written before ${f.id} changed` : plural2(t.length, "test"), { tests: t });
    });
    const covered = items.filter((x) => x.tests.length).length;
    // Tied to an approved feature, as the slice lists: a test mapped to a feature still proposed is not tied yet.
    const loose = unmappedTests(names, new Map(approved.map((f) => [f.id, f])));
    out.test = { stage: "test", covered, total, words: `${covered} of ${total} ${total === 1 ? "feature" : "features"}`, items };
    if (loose.length) out.test.untied = { words: `${plural2(loose.length, "test")} not tied to a feature`, items: loose };
  }

  if (made("programs")) {
    const items = approved.map((f) => {
      const c = cells.get(f.id).code;
      const n = c.tests ? c.tests : null;
      if (n && Number.isInteger(n.passed)) return sliceItem(f, n.passed < n.total ? "failing" : c.state === "stale" ? "stale" : "done", `${n.passed} of ${n.total} passing`, { passed: n.passed, of: n.total });
      if (c.state === "stale") return sliceItem(f, "stale", c.words);
      return sliceItem(f, "to_do", testsOf(names, f).length ? "Not run against the suite yet" : "No test checks it yet");
    });
    const covered = items.filter((x) => x.state === "done").length;
    out.code = { stage: "code", covered, total, words: `${covered} of ${total} ${total === 1 ? "feature passes" : "features pass"}`, items };
  }

  if (made("findings")) {
    const s = arts.get("findings").summary ?? {};
    const files = (suite?.files ?? []).map((f) => ({ path: f.path, text: textOf(f.path) ?? "" })).filter((x) => x.text);
    const list = [...(s.open ?? []).map((x) => ({ ...x, open: true })), ...(s.outside ?? []).map((x) => ({ ...x, open: false }))];
    const tied = list.map((x) => ({ finding: { place: words(x.place), claim: words(x.claim), open: x.open }, ids: findingFeatures(x, files, reg) }));
    const items = approved.map((f) => {
      const mine = tied.filter((x) => x.ids.includes(f.id)).map((x) => x.finding);
      const open = mine.filter((x) => x.open).length;
      return sliceItem(f, open ? "findings" : "done", open ? `${plural2(open, "finding")} open` : mine.length ? `No findings open; ${plural2(mine.length, "note")} outside the change` : "No findings", { findings: mine });
    });
    const loose = tied.filter((x) => !x.ids.length).map((x) => x.finding);
    const covered = items.filter((x) => x.state === "done").length;
    out.review = { stage: "review", covered, total, words: `${covered} of ${total} ${total === 1 ? "feature" : "features"} clear`, items };
    if (loose.length) out.review.untied = { words: `${plural2(loose.length, "finding")} not tied to a feature`, items: loose.map((x) => `${x.place ? `${x.place}: ` : ""}${x.claim}${x.open ? "" : " (outside the change)"}`) };
  }

  if (made("agentdoc")) {
    const doc = arts.get("agentdoc");
    const text = (doc.files ?? []).map((f) => textOf(f.path) ?? "").join("\n").toLowerCase();
    const items = approved.map((f) => {
      const named = text.includes(f.name.toLowerCase()) || new RegExp(`\\b${f.id.toLowerCase()}\\b`).test(text);
      return sliceItem(f, named ? "done" : "to_do", named ? "Documented" : "Not in the docs yet");
    });
    const covered = items.filter((x) => x.state === "done").length;
    out.docs = { stage: "docs", covered, total, words: `${covered} of ${total} documented`, items };
  }
  return out;
}

/** Each stage's count for the build's stages (Stage.features, 0.4.5): stage -> { covered, total, words }. */
export function countsOf(slices) {
  return Object.fromEntries(Object.entries(slices).map(([k, s]) => [k, countOf(s)]));
}

// ---------- history ----------

/** Where an event was said, as a history link. */
function messageLink(e) {
  if (!e.from?.message) return undefined;
  return { kind: "message", ...(e.from.stage ? { stage: e.from.stage } : {}), message: e.from.message };
}

/**
 * One feature's history across the product's builds, oldest first: its
 * proposals and their answers, then each artifact that came to cover it.
 */
export function historyOf(builds, id, { artifactsFor }) {
  const events = eventsOf(builds);
  const reg = registerOf(events);
  const f = reg.get(id);
  if (!f) return null;
  const out = [];
  const stamp = (e) => ({ build: e.build, version: e.version });
  for (const e of f.events) {
    const at = e.at;
    if (e.kind === "proposed") out.push({ at, kind: "proposed", words: `${e.by} proposed ${e.change === "changed" ? "a change to " : ""}${id}: ${e.name}. ${e.does}${e.offering ? ` (offering ${e.offering})` : ""}`, by: e.by, ...stamp(e), ...(messageLink(e) ? { link: messageLink(e) } : {}) });
    else if (e.kind === "approved") out.push({ at, kind: "approved", words: e.via === "gate" ? `Approved with the spec at the Requirements gate.` : `Approved in the chat.${e.statement ? ` The statement of the job is ${e.statement} with it.` : ""}`, by: e.by, ...stamp(e), ...(e.message ? { link: { kind: "message", ...(e.stage ? { stage: e.stage } : {}), message: e.message } } : {}) });
    else if (e.kind === "not_now") out.push({ at, kind: "not_now", words: "Not now: kept as a proposed feature, in the backlog.", by: e.by, ...stamp(e), ...(e.message ? { link: { kind: "message", ...(e.stage ? { stage: e.stage } : {}), message: e.message } } : {}) });
    else if (e.kind === "asked") out.push({ at, kind: "asked", words: `Asked ${e.to.join(", ") || "the approvers"} to approve it.`, by: e.by, ...stamp(e), ...(e.message ? { link: { kind: "message", ...(e.stage ? { stage: e.stage } : {}), message: e.message } } : {}) });
  }
  for (const b of [...builds].sort((x, y) => String(x.created).localeCompare(String(y.created)))) {
    const holds = registerOf(eventsOf(buildsUpTo(builds, b))).get(id);
    if (!holds) continue;
    const arts = new Map(artifactsFor(b).map((a) => [a.id, a]));
    const stamp2 = { build: b.id, version: b.version };
    const art = (a) => ({ kind: "artifact", artifact: a.id, feature: id });
    // The spec writer revised the statement after the feature was approved: its brief carried it.
    const approvedHere = holds.approvedAt;
    for (const round of b.stages?.requirements?.rounds ?? []) {
      if (!approvedHere || !round.at || round.at <= approvedHere || ["Refused", "Not run"].includes(round.verdict)) continue;
      out.push({ at: round.at, kind: "spec", words: `The spec writer revised the statement (${round.label}) with ${id} in its brief.`, ...stamp2, link: art({ id: "statement" }) });
    }
    const suite = arts.get("suite");
    const names = suite?.state === "made" ? testsOf(suite.summary?.tests, holds) : [];
    if (names.length && suite.at) out.push({ at: suite.at, kind: "tests", words: `${plural(names.length, "test")} in the suite ${suite.version ?? ""} name ${id}.`.replace("  ", " "), ...stamp2, link: art(suite) });
    let last = null;
    for (const round of b.stages?.code?.rounds ?? []) {
      const x = (round.by_feature ?? []).find((y) => y.feature === id);
      if (!x || !round.at) continue;
      const said = `${x.passed} of ${x.total}`;
      if (said === last) continue;
      last = said;
      out.push({ at: round.at, kind: "code", words: `The code passes ${said} tests for ${id} (${round.label}).`, ...stamp2, link: art({ id: "programs" }) });
    }
    const findings = arts.get("findings");
    if (findings?.state === "made" && findings.at && names.length) out.push({ at: findings.at, kind: "review", words: `The code critic reviewed the code ${findings.version ?? ""}: ${findings.summary?.verdict ?? ""}`.trim(), ...stamp2, link: art(findings) });
    const doc = arts.get("agentdoc");
    if (doc?.state === "made" && doc.at) out.push({ at: doc.at, kind: "docs", words: `The docs ${doc.version ?? ""} were made.`.replace("  ", " "), ...stamp2, link: art(doc) });
  }
  out.sort(byTime);
  return { feature: entryOf(f), history: out };
}

/** A feature as the API answers it (FeatureEntry). The pending proposal is shaped by the caller. */
export function entryOf(f, pending = null) {
  return { id: f.id, name: f.name, does: f.does, offering: f.offering, state: f.state, backlog: f.backlog, ...(f.approved ? { approved: f.approved } : {}), ...(pending ? { pending } : {}) };
}

// ---------- proposals and answers ----------

/**
 * Features for a product: proposing them from a reply, and the person's answers.
 * store: Product Factory's store. now: the clock.
 */
export function createFeatures({ store, now = () => new Date().toISOString() }) {
  const newId = (p) => `${p}_${randomBytes(6).toString("hex")}`;

  /**
   * Keeps the features a reply proposes on build r, each as a proposal with its
   * id given now. builds: the product's builds. said: [{ id?, name, does,
   * offering }]. by: who proposed, in words. from: { stage?, message }.
   * offerings: the statement's offerings. Resolves to the proposal events kept;
   * one that changes nothing is left out.
   */
  async function propose(r, builds, said, { by, from, offerings = [], listed = false }) {
    if (!said.length) return [];
    const events = eventsOf(builds);
    const reg = registerOf(events);
    const kept = [];
    const taken = new Set(events.map((e) => e.feature));
    let fresh = nextId(events);
    const bump = () => { const n = Number(fresh.slice(1)) + 1; fresh = `F${n}`; };
    for (const s of said) {
      const offering = offeringOf(s.offering, offerings);
      let id = s.id && reg.has(s.id) ? s.id : null;
      if (!id) id = [...reg.values()].find((f) => f.name.toLowerCase() === s.name.toLowerCase())?.id ?? null;
      const was = id ? reg.get(id) : null;
      const next = { name: s.name, does: s.does, offering };
      if (was && (was.state === "approved" ? same(was, next) : was.pending && same(was.pending, next))) continue;
      if (kept.some((k) => k.feature === id && id)) continue;
      if (!id) {
        while (taken.has(fresh)) bump();
        id = fresh;
        taken.add(id);
        bump();
      }
      const changed = was?.state === "approved";
      kept.push({ id: newId("fp"), at: now(), kind: "proposed", feature: id, ...next, change: changed ? "changed" : "new", ...(changed ? { was: content(was) } : {}), ...(Array.isArray(s.tests) ? { tests: [...s.tests] } : {}), ...(listed ? { listed: true } : {}), by, from });
    }
    if (kept.length) await store.update(r.id, (b) => { (b.feature_log ??= []).push(...kept); });
    return kept;
  }

  /** The proposal a decision names, on its build, checked: { proposal, state, feature } or Refused 400. */
  function find(builds, r, featureId, proposalId) {
    if (typeof proposalId !== "string" || !proposalId) throw new Refused(400, "proposal is the id of the proposal you are answering.");
    const events = eventsOf(builds);
    const p = events.find((e) => e.kind === "proposed" && e.id === proposalId);
    if (!p || p.feature !== featureId) throw new Refused(400, `${r.name} has no proposal ${proposalId} of feature ${featureId}.`);
    const reg = registerOf(events);
    return { proposal: p, state: reg.get(featureId).states.get(p.id), feature: reg.get(featureId) };
  }

  /**
   * The person's answer to one proposal on build r: approve, not_now or ask.
   * gate: people.mjs's word on whether they may answer Requirements ({ yes, who, words }).
   * via: "chat" or "gate". Resolves to { event }. Throws Refused in words.
   */
  async function decide(r, builds, featureId, decision, body, who, gate, { via = "chat" } = {}) {
    if (!DECISIONS.has(decision)) throw new Refused(404, "Nothing here. A feature is answered with approve, not_now or ask.");
    const message = body?.message === undefined ? null : body.message;
    if (message !== null && (typeof message !== "string" || !message)) throw new Refused(400, "message is the id of the message the proposal is on.");
    const { proposal, state } = find(builds, r, featureId, body?.proposal);
    const open = ["open", "asked", "not_now"].includes(state);
    if (!open) throw new Refused(400, `That proposal is ${state === "replaced" ? "replaced by a newer one of the same feature" : state}, so there is nothing to answer.`);
    if (decision === "approve" && !gate.yes) throw new Refused(403, `${gate.words} So only they may approve a feature. Ask them instead: they are told, and see the same proposal.`);
    if (decision === "ask" && gate.yes) throw new Refused(400, gate.who.length ? "You may answer the Requirements gate, so approve it yourself." : "Anyone may answer the Requirements gate, so approve it yourself.");
    if (decision === "not_now" && state === "not_now") throw new Refused(400, "That proposal is already left for later.");
    const stage = proposal.from?.stage ?? null;
    const base = { id: newId("fd"), at: now(), feature: featureId, proposal: proposal.id, by: who.name, email: who.email, ...(message ? { message } : {}), ...(stage ? { stage } : {}) };
    const event = decision === "approve" ? { ...base, kind: "approved", via }
      : decision === "not_now" ? { ...base, kind: "not_now" }
        : { ...base, kind: "asked", to: [...gate.who] };
    await store.update(proposal.build, (b) => { (b.feature_log ??= []).push(event); });
    return { event, proposalBuild: proposal.build };
  }

  /**
   * Approve all (0.4.5): the person approves several proposals at once, such
   * as the features listed after the build. Each is recorded as a chat
   * approval, as Approve feature records one, and together they are one batch,
   * so the statement gets one new version. Every proposal is checked before
   * any is kept: one that is not open refuses the whole answer in words.
   * Resolves to { events, builds } with the builds the events were kept on.
   */
  async function approveAll(r, builds, proposalIds, body, who, gate) {
    if (!Array.isArray(proposalIds) || !proposalIds.length || proposalIds.some((x) => typeof x !== "string" || !x)) throw new Refused(400, "proposals is the list of the proposal ids you approve.");
    if (new Set(proposalIds).size !== proposalIds.length) throw new Refused(400, "proposals names a proposal more than once.");
    if (!gate.yes) throw new Refused(403, `${gate.words} So only they may approve features. Ask them instead: they are told, and see the same proposals.`);
    const message = body?.message === undefined ? null : body.message;
    if (message !== null && (typeof message !== "string" || !message)) throw new Refused(400, "message is the id of the message the proposals are on.");
    const events = eventsOf(builds);
    const reg = registerOf(events);
    const found = proposalIds.map((pid) => {
      const p = events.find((e) => e.kind === "proposed" && e.id === pid);
      if (!p) throw new Refused(400, `${r.name} has no proposal ${pid}.`);
      const state = reg.get(p.feature).states.get(p.id);
      if (!["open", "asked", "not_now"].includes(state)) throw new Refused(400, `The proposal of ${p.feature} is ${state === "replaced" ? "replaced by a newer one of the same feature" : state}, so there is nothing to answer. Nothing was approved.`);
      return p;
    });
    if (new Set(found.map((p) => p.feature)).size !== found.length) throw new Refused(400, "Two of those proposals are of the same feature; approve one of them. Nothing was approved.");
    const batch = newId("fb");
    const at = now();
    const kept = found.map((p) => ({ id: newId("fd"), at, kind: "approved", via: "chat", batch, feature: p.feature, proposal: p.id, by: who.name, email: who.email, ...(message ? { message } : p.from?.message ? { message: p.from.message } : {}), ...(p.from?.stage ? { stage: p.from.stage } : {}) }));
    const byBuild = new Map();
    found.forEach((p, i) => { byBuild.set(p.build, [...(byBuild.get(p.build) ?? []), kept[i]]); });
    for (const [id, list] of byBuild) await store.update(id, (b) => { (b.feature_log ??= []).push(...list); });
    return { events: kept, builds: [...byBuild.keys()] };
  }

  /**
   * The Requirements gate was approved on build r: every feature it started
   * building with (to_approve) is approved with it, recorded as the gate's.
   */
  async function gateApproved(r, builds, who) {
    const reg = registerOf(eventsOf(buildsUpTo(builds, r)));
    const list = [];
    for (const f of reg.values()) {
      const p = f.pending;
      if (!p || f.states.get(p.id) === "not_now") continue;
      list.push({ id: newId("fd"), at: now(), kind: "approved", via: "gate", feature: f.id, proposal: p.id, by: who.name, email: who.email, stage: "requirements" });
    }
    if (list.length) await store.update(r.id, (b) => { (b.feature_log ??= []).push(...list); });
    return list;
  }

  /** Records the statement version an approval made, once the statement is read again. */
  const noteStatement = (buildId, eventId, version) => store.update(buildId, (b) => {
    const e = (b.feature_log ?? []).find((x) => x.id === eventId);
    if (e && version) e.statement = version;
  });

  return { propose, decide, approveAll, gateApproved, noteStatement, find };
}

/**
 * A proposal as the person reading it sees it (FeatureProposal): its state,
 * whether they may approve it, and who may. reg: the product's register.
 * gate: people.mjs's word for this person at Requirements.
 */
export function proposalView(p, reg, gate) {
  const f = reg.get(p.feature);
  const state = f?.states.get(p.id) ?? "open";
  const answers = (f?.events ?? []).filter((e) => e.proposal === p.id);
  const answer = state === "approved" ? answers.find((e) => e.kind === "approved") : state === "not_now" ? answers.filter((e) => e.kind === "not_now").at(-1) : null;
  const asked = answers.filter((e) => e.kind === "asked").at(-1);
  return {
    proposal: p.id, feature: p.feature, name: p.name, does: p.does, offering: p.offering, change: p.change,
    ...(p.was ? { was: p.was } : {}),
    ...(Array.isArray(p.tests) ? { tests: [...p.tests] } : {}),
    state, you_may_approve: Boolean(gate.yes), approvers: [...(gate.who ?? [])],
    ...(answer ? { answered: { decision: state, by: answer.by, at: answer.at } } : {}),
    ...(asked ? { asked: { by: asked.by, at: asked.at, to: asked.to ?? [] } } : {}),
  };
}

/** The Requirements gate's features at build r (StageGate.features), or null when the build carries none. */
export function gateFeatures(builds, r) {
  const reg = registerOf(eventsOf(buildsUpTo(builds, r)));
  if (!reg.size) return null;
  const one = (f) => ({ id: f.id, ...content(f.pending && f.states.get(f.pending.id) !== "not_now" ? f.pending : f) });
  const list = [...reg.values()].sort(order);
  return {
    approved: list.filter((f) => f.state === "approved" && !(f.pending && f.states.get(f.pending.id) !== "not_now")).map(one),
    to_approve: list.filter((f) => f.pending && f.states.get(f.pending.id) !== "not_now").map(one),
    // A change left for later to an approved feature keeps it approved, so only a feature never approved is listed here.
    backlog: list.filter((f) => f.backlog && f.state !== "approved").map(one),
  };
}

