// The build's artifacts (lifecycle API 0.4, build.artifacts), read from a
// finished build's files: fixtures/word-counter is a real word-counter build
// with its local paths and repository taken out, laid out as Product Factory
// keeps it. Each kind's summary is held to what those files say.

import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactsOf, reviewFiles, frontMatter, testNames, scriptDoes, priceWords } from "../lib/artifacts.mjs";
import { openFindings, outsideFindings, readFindings } from "../lib/review.mjs";
import { securityChecks, packageChecks, statementChecks, architectureChecks, productsOf } from "../lib/rule-checks.mjs";
import { readRecord } from "../lib/architecture.mjs";
import { checkArtifacts, stageIds } from "../standards/lifecycle-api-check.mjs";
import { tempDir } from "./helpers.mjs";

const DIR = fileURLToPath(new URL("./fixtures/word-counter/", import.meta.url));
const record = () => JSON.parse(readFileSync(`${DIR}build.json`, "utf8"));
const link = (p) => `/files?path=${p}`;
const byId = (list) => Object.fromEntries(list.map((a) => [a.id, a]));

test("every artifact of a finished build, in stage order, for the stages its lifecycle uses", () => {
  const list = artifactsOf(record(), { dir: DIR, link });
  // This build is from before stages.json 1.6.0: its spec writer handed back the agent's own files and no spec.
  assert.deepEqual(list.map((a) => a.id), ["spec", "statement", "architecture", "suite", "programs", "findings", "security", "package", "build_record", "run_plan", "attestation", "agentdoc"]);
  assert.deepEqual(list.map((a) => a.state), ["not_made", "made", "not_run", "made", "made", "made", "made", "made", "not_made", "made", "not_run", "not_run"]);
  assert.match(list[0].summary.words, /^This version was built before the spec writer wrote specs, so it has none\./);
  // The agent's own files are made at Design (lifecycle API 0.4.8).
  assert.equal(list[1].stage, "architecture");
  assert.equal(list[1].name, "The agent's own files");
  // A build made before make-a-new-agent.txt v3 is not run again: its process had no architecture phase.
  assert.match(list[2].summary.words, /^This build's process has no architecture phase, so no architecture record was made/);
  for (const a of list) {
    assert.ok(a.summary && typeof a.summary === "object", a.id);
    assert.ok(a.by, a.id);
    for (const f of a.files ?? []) assert.ok(f.size > 0 && f.link === link(f.path), `${a.id} ${f.path}`);
  }
});

test("the statement: the agent, its offerings, refusals, records and price, from the agent's own files", () => {
  const a = byId(artifactsOf(record(), { dir: DIR, link })).statement;
  assert.equal(a.by, "spec writer");
  assert.equal(a.version, "v4");
  assert.deepEqual(a.summary, {
    agent: "word-counter 0.1.0",
    offerings: [{ name: "Count words", does: "Reads a single sentence of text handed over by the caller, counts the exact number of words it contains, and returns the total." }],
    refuses: [
      "Counting anything that is not a sentence of text",
      "Processing binary files, images, or any media types other than plain text",
      "Guessing the word count of an empty or missing input",
      "Accepting a credential value or a system address pasted into the text input",
    ],
    records: ["what the job did not have and did anyway", "the signed job manifest of each delivery"],
    open: [],
    price: "free",
  });
  assert.deepEqual(a.files.map((f) => f.path), ["requirements/agent-descriptor.json", "requirements/agent-runtime-requirements.json", "requirements/plugin.json", "requirements/skills/count-words/SKILL.md"]);
});

test("a statement with a question still open lists it", () => {
  const r = record();
  r.stages.requirements.handed_back.files.push({ path: "requirements/still-open.md", at: "stages/requirements/r3/job/out/still-open.md", size: 0 });
  const a = byId(artifactsOf(r, { dir: DIR, link })).statement;
  assert.deepEqual(a.summary.open, ["What is the price for this agent offering (e.g., flat amount or free)?"]);
});

test("the suite: the test writer's recorded names, and the names in a file it did not record", () => {
  const a = byId(artifactsOf(record(), { dir: DIR, link })).suite;
  assert.equal(a.summary.count, 15);
  assert.equal(a.summary.tests[0], "multiple sentences or non-text content are refused");
  assert.ok(a.summary.tests.includes("FILE is exported correctly"), "read from went-without.test.mjs itself");
  assert.equal(a.version, "v1");
});

test("the programs: each script with its lines and what it says it does, the commit and the pull request", () => {
  const a = byId(artifactsOf(record(), { dir: DIR, link })).programs;
  assert.deepEqual(a.summary, {
    scripts: [
      { path: "scripts/count.mjs", lines: 185, does: "count the words in one sentence of text." },
      { path: "scripts/went-without.mjs", lines: 76, does: "what a job did not have and went ahead without anyway." },
    ],
    commit: "21065e2",
    pr: { number: 1, url: "https://github.com/acme/agents/pull/1" },
  });
  assert.equal(a.by, "your coding harness, on a pull request (acme/agents)");
});

test("the findings and the security record, from the reviewers' documents on the commit the gate passed", () => {
  const list = byId(artifactsOf(record(), { dir: DIR, link }));
  assert.deepEqual(list.findings.summary.open, []);
  assert.equal(list.findings.summary.verdict, "Nothing open. 1 note outside the change, which holds nothing up.");
  assert.equal(list.findings.summary.outside[0].place, "agent-runtime-requirements.json:34");
  assert.equal(list.findings.version, "on 21065e2");
  assert.deepEqual(list.findings.files.map((f) => f.path), ["review/findings.md"]);
  const s = list.security.summary;
  assert.deepEqual(s.reach, ["folder records (write): every record the descriptor names", "folder work (write): inputs and drafts in progress"]);
  assert.equal(s.spend, "10 USD per day (the owner's spending limit)");
  assert.equal(s.never.length, 8);
  assert.equal(s.never[4], "Reaching an address no declared system covers");
  assert.equal(s.verdict, "Passed.");
  // 0.4.12: the same parts as the reviewer's record lists them, each with its reason.
  assert.deepEqual(s.reaches, [{ system: "folder records", access: "write", reason: "every record the descriptor names" }, { system: "folder work", access: "write", reason: "inputs and drafts in progress" }]);
  assert.deepEqual(s.spends, [{ limit: "10 USD per day", ceiling: "the owner's spending limit" }]);
  assert.equal(s.never_does.length, 8);
  assert.deepEqual(s.never_does[4], { act: "Reaching an address no declared system covers", reason: "what it may reach is what its systems name, and nothing else was agreed" });
  assert.deepEqual(s.no_reason_recorded, []);
  assert.equal(s.architecture_record, "absent");
  assert.equal(list.security.digest, "sha256:58775446ce7841129f101ce05abaae196b6fdb32d0525cb7ad006cf4a2d9d5f8");
  // The documents are served beside the files the stages handed back.
  assert.deepEqual(reviewFiles(record(), DIR).map((f) => f.path), ["review/findings.md", "security/security-review.md"]);
});

test("the package, the build record Release would sign, and the run plan", () => {
  const list = byId(artifactsOf(record(), { dir: DIR, link }));
  assert.deepEqual(list.package.summary, { file: "word-counter-0.1.0.tar.gz", validated: true, digest: "sha256:cb9523cf965e8a9d61caa1221df028331641173f32738e683d1368960e40bb17" });
  assert.equal(list.build_record.state, "not_made");
  assert.match(list.build_record.summary.words, /unsigned build record/);
  const plan = list.run_plan.summary.stages;
  assert.equal(plan.length, 11);
  assert.deepEqual(plan[0], { stage: "deploy", name: "Deploy", holder: "deployment manager", settings: "no settings", reads: "chosen" });
  assert.deepEqual(plan.find((e) => e.stage === "eval"), { stage: "eval", name: "Eval", holder: null, settings: "no settings", reads: "not chosen" });
  assert.equal(list.run_plan.by, "Product Factory");
  assert.equal(list.attestation.state, "not_run");
});

test("a stage the lifecycle leaves out has no artifact; a working build's next one is next, the rest later; a stopped build's are not made", () => {
  const r = record();
  r.lifecycle.used.docs = { used: false, from: "org" };
  assert.ok(!artifactsOf(r, { dir: DIR, link }).some((a) => a.id === "agentdoc"));

  const w = record();
  w.status = "working"; w.at = "test";
  w.stages.test.handed_back.files = [];
  w.stages.code.handed_back.files = [];
  delete w.work.pr; delete w.plan;
  w.stages.package.state = "not_started";
  const list = byId(artifactsOf(w, { dir: DIR, link }));
  assert.equal(list.statement.state, "made");
  assert.equal(list.suite.state, "next");
  assert.equal(list.programs.state, "later");
  assert.equal(list.findings.state, "later");
  assert.equal(list.package.state, "later");
  assert.equal(list.build_record.state, "not_run");

  w.status = "stopped";
  const stopped = byId(artifactsOf(w, { dir: DIR, link }));
  assert.equal(stopped.suite.state, "not_made");
  assert.match(stopped.suite.summary.words, /stopped/);

  // A build on the reference writers: nobody asks the reviewers, and the artifact says why.
  w.status = "working"; w.settings.code.holder = "code-writer";
  assert.equal(byId(artifactsOf(w, { dir: DIR, link })).findings.state, "not_run");
});

test("the readers each kind is built from", () => {
  assert.deepEqual(frontMatter("---\nverdict: \"passed\"\nreaches:\n  - system: \"folder work\"\n    access: \"write\"\nrefused_for: []\n---\n# x"), { verdict: "passed", reaches: [{ system: "folder work", access: "write" }], refused_for: [] });
  assert.deepEqual(testNames("test(\"a\", () => {});\n  it('b c', () => {});\ntest(`d`)"), ["a", "b c", "d"]);
  assert.equal(scriptDoes("// count.mjs: count the words.\n//\n"), "count the words.");
  assert.equal(priceWords({ price: { model: "free" } }), "free");
  assert.equal(priceWords({ price: { model: "flat", amount: "0.05", currency: "USD" } }), "flat amount 0.05 currency USD");
  const doc = "- open: 1\n\n## Findings\n\n### F1. A thing\n\n- Place: `scripts/a.mjs:3`\n- Claim: it breaks\n- Consequence: it fails.\n- Answer: open\n\n## Outside the change\n\n- `x.json:1` (rule): a note\n";
  assert.deepEqual(openFindings(doc), [{ place: "scripts/a.mjs:3", claim: "it breaks", consequence: "it fails." }]);
  assert.deepEqual(outsideFindings(doc), [{ place: "x.json:1", claim: "a note" }]);
  assert.deepEqual(readFindings(doc).open_findings, ["`scripts/a.mjs:3` it breaks it fails."]);
});

// ---------- 0.4.13: each artifact's Common Agent checks ----------

const IDS = stageIds(fileURLToPath(new URL("../standards/stages.json", import.meta.url)));
const RECORD_MD = fileURLToPath(new URL("./fixtures/architecture/architecture-record.md", import.meta.url));
const ca = (o) => ({ standard: "common-agent", version: "0.41.0", ...o });

test("each made artifact says which Common Agent rules its stage applied, from that stage's own records, and the lifecycle API check holds them", () => {
  const list = artifactsOf(record(), { dir: DIR, link });
  assert.deepEqual(checkArtifacts(list, IDS), []);
  const a = byId(list);
  // The agent's own files: no system to name, a Descriptor of shapes only, and an offering a person may start with no example.
  assert.deepEqual(a.statement.checks, [
    ca({ section: "12.4", asks: "Systems named in system words", result: "met", detail: "There is no system in the runtime requirements, so there is no name to hold to system words." }),
    ca({ section: "6.4", rule: "3", asks: "No credential, key, address or account in a declaration", result: "met", detail: "All 25 values of the draft Descriptor read; none carries a credential value, a key, an address or an account." }),
    ca({ section: "6.13.8", asks: "An example for each offering a person starts", result: "not_met", detail: "Count words does not say who starts it, so a person may (Section 6.13.2), and carries no example." }),
  ]);
  // The security record: every permission has its reason, no address in the scripts, and a review of another archive than the package.
  assert.deepEqual(a.security.checks, [
    ca({ section: "12.4", asks: "Every permission asked for has a reason", result: "met", detail: "The security reviewer found a recorded reason for every permission the package asks for (2 reaches, 1 spend)." }),
    ca({ section: "12.6", rule: "2", asks: "No address in its scripts", result: "met", detail: "The security reviewer's address check read the scripts and run commands; none carries an http, https, ws or wss address, or one in 169.254.0.0/16." }),
    ca({ section: "12.6", rule: "5", asks: "The review names the archive's digest", result: "not_met", detail: "The review names sha256:58775446ce78…, and the package the build holds is sha256:cb9523cf965e…, so the review does not apply to it." }),
  ]);
  assert.deepEqual(a.package.checks, [
    ca({ section: "12.10", asks: "The package validates", result: "met", detail: "The packer's validate found no problem. The packer (@common-agent/package 0.1.0) implements Section 12 as of Common Agent 0.30.0-draft, so this check is only as current as it." }),
  ]);
  // A stage whose records say nothing of a Common Agent rule gives no checks.
  for (const id of ["suite", "programs", "findings", "run_plan"]) assert.equal(a[id].checks, undefined, id);
});

test("the security record's checks follow what the review says, and a rule its record does not speak to is left out", () => {
  const head = frontMatter(readFileSync(`${DIR}stages/code/pr/21065e2bf19e/review/security/job/out/security-review.md`, "utf8"));
  assert.deepEqual(securityChecks(head, { packageDigest: head.digest }).map((c) => [c.section, c.rule ?? null, c.result]), [["12.4", null, "met"], ["12.6", "2", "met"], ["12.6", "5", "met"]]);
  const unreasoned = securityChecks({ ...head, no_reason_recorded: ["system mail at write access"] })[0];
  assert.deepEqual([unreasoned.result, unreasoned.detail], ["not_met", "The security reviewer found no recorded reason for 1 permission: system mail at write access."]);
  const warned = securityChecks({ ...head, warnings: [{ file: "skills/count-words/scripts/count.mjs", line: 12, address: "https://api.example.com" }] })[1];
  assert.deepEqual([warned.result, warned.detail], ["not_met", "The security reviewer's address check found 1 address written into the scripts or run commands: skills/count-words/scripts/count.mjs, line 12: https://api.example.com."]);
  // The code critic's warnings on the same commit count too.
  const critic = "# Review\n\n## Findings\n\nNone.\n\n## Warnings\n\nEvery network address written into a script is listed here.\n\n- `scripts/a.mjs:3`: `http://10.0.0.1/x`\n\n## Outside the change\n";
  assert.equal(securityChecks(head, { critic })[1].detail, "The security reviewer's and the code critic's address checks found 1 address written into the scripts or run commands: scripts/a.mjs:3: http://10.0.0.1/x.");
  // A review that records neither its address warnings nor the permissions without a reason, with no package yet: nothing to say, so nothing is said.
  const { warnings, no_reason_recorded, ...older } = head;
  assert.deepEqual(securityChecks(older), []);
});

test("the package's check is the packer's validate result, and a build that kept none gives no check", () => {
  const failed = packageChecks({ ok: false, issues: [{ message: "plugin.json: no name" }], warnings: [] }, ["npx", "--yes", "@common-agent/package@0.1.0"])[0];
  assert.deepEqual([failed.section, failed.result], ["12.10", "not_met"]);
  assert.match(failed.detail, /^The packer's validate found 1 problem: plugin\.json: no name\. The packer \(@common-agent\/package 0\.1\.0\) implements Section 12 as of Common Agent 0\.30\.0-draft/);
  assert.equal(packageChecks({ ok: true, issues: [], warnings: [] }, ["my-packer"])[0].detail, "The packer's validate found no problem. The packer (my-packer) is your own, and the build does not record which version of Section 12 it implements.");
  assert.deepEqual(packageChecks(null, ["my-packer"]), []);
});

test("the agent's own files and the architecture record: systems in system words held against the products the record binds, shapes only, and examples", async () => {
  const head = readRecord(readFileSync(RECORD_MD, "utf8"));
  assert.deepEqual(architectureChecks(head), [ca({ section: "12.4", asks: "Systems named in system words", result: "met", detail: "Each system in the architecture record (files, text-reasoning) is lowercase words with no address or account, and none is a product the architecture record binds." })]);
  const products = productsOf(head);
  const sys = (...names) => ({ systems: names.map((name) => ({ name })) });
  assert.equal(statementChecks({ requirements: sys("files", "text-reasoning"), products })[0].result, "met");
  // Without an architecture record nobody has said which names are products, so that part is not checked.
  const open = statementChecks({ requirements: sys("files") })[0];
  assert.deepEqual([open.result, open.detail], ["not_checked", "Each system in the runtime requirements (files) is lowercase words with no address or account; no architecture record binds products, so whether a name is a product was not checked."]);
  const bad = statementChecks({ requirements: sys("platform", "api.example.com", "Supabase"), products })[0];
  assert.deepEqual([bad.result, bad.detail], ["not_met", "In the runtime requirements, platform is a product the architecture record binds; api.example.com is an address; Supabase is not lowercase words joined by hyphens."]);
  // The Descriptor: an address, a credential value or an account fails Section 6.4, rule 3, except in a member that is an address by its definition.
  const descriptor = {
    does: "Reads https://news.example.com with sk-0123456789abcdef0123456789abcdef for owner@example.com.",
    can_use: [{ schema: "https://schemas.example.org/brand-profile" }],
    offerings: [
      { id: "summarize", name: "Summarize", started_by: ["person"], example: { inputs: { page: { url: "https://example.com/page.html", media_type: "text/html" } }, good_result: "Three key points about the page." } },
      { id: "feed", name: "Feed", started_by: ["agent"] },
    ],
  };
  const [shapes, examples] = statementChecks({ descriptor });
  assert.deepEqual([shapes.section, shapes.rule, shapes.result, shapes.detail], ["6.4", "3", "not_met", "In the draft Descriptor, does carries an API key; does carries an address; does carries an account."]);
  assert.deepEqual([examples.section, examples.result, examples.detail], ["6.13.8", "met", "Summarize: each offering a person starts carries an example."]);
  descriptor.offerings[0] = { id: "summarize", name: "Summarize", started_by: ["person"] };
  assert.equal(statementChecks({ descriptor })[1].detail, "Summarize says a person starts it, and carries no example.");
  // A build folder without the files leaves their checks out.
  assert.deepEqual(statementChecks({}), []);

  // A build with an architecture record: the record's check, and the agent's own files held against its products.
  const dir = join(await tempDir("artifacts"), "build");
  cpSync(DIR, dir, { recursive: true });
  mkdirSync(join(dir, "stages", "architecture", "r1", "out"), { recursive: true });
  cpSync(RECORD_MD, join(dir, "stages", "architecture", "r1", "out", "architecture-record.md"));
  const r = record();
  r.stages.architecture = { state: "done", holder: { kind: "reference_agent", role: "solution-architect" }, runs: 1, rounds: [{ n: 1, at: "2026-11-08T21:20:00.000Z", label: "Round 1", verdict: "Written", back: false, words: "Written." }], handed_back: { words: [], files: [{ path: "architecture/architecture-record.md", at: "stages/architecture/r1/out/architecture-record.md" }] } };
  const list = artifactsOf(r, { dir, link });
  assert.deepEqual(checkArtifacts(list, IDS), []);
  const got = byId(list);
  assert.deepEqual(got.architecture.checks.map((c) => [c.section, c.result]), [["12.4", "met"]]);
  assert.deepEqual(got.statement.checks[0], ca({ section: "12.4", asks: "Systems named in system words", result: "met", detail: "There is no system in the runtime requirements, so there is no name to hold to system words." }));
});
