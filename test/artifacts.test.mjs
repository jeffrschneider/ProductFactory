// The build's artifacts (lifecycle API 0.4, build.artifacts), read from a
// finished build's files: fixtures/word-counter is a real word-counter build
// with its local paths and repository taken out, laid out as Product Factory
// keeps it. Each kind's summary is held to what those files say.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { artifactsOf, reviewFiles, frontMatter, testNames, scriptDoes, priceWords } from "../lib/artifacts.mjs";
import { openFindings, outsideFindings, readFindings } from "../lib/review.mjs";

const DIR = fileURLToPath(new URL("./fixtures/word-counter/", import.meta.url));
const record = () => JSON.parse(readFileSync(`${DIR}build.json`, "utf8"));
const link = (p) => `/files?path=${p}`;
const byId = (list) => Object.fromEntries(list.map((a) => [a.id, a]));

test("every artifact of a finished build, in stage order, for the stages its lifecycle uses", () => {
  const list = artifactsOf(record(), { dir: DIR, link });
  assert.deepEqual(list.map((a) => a.id), ["statement", "architecture", "suite", "programs", "findings", "security", "package", "build_record", "run_plan", "attestation", "agentdoc"]);
  assert.deepEqual(list.map((a) => a.state), ["made", "not_run", "made", "made", "made", "made", "made", "not_made", "made", "not_run", "not_run"]);
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

  // Code held on this computer: nobody asks the reviewers, and the artifact says why.
  w.status = "working"; w.settings.code.holder = "harness";
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
