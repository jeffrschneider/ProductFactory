// Conformance (make-a-new-agent.txt v3): after the deploy, the package that was
// deployed is held to the Common Agent checks programs run with node and no
// network (lib/conformance.mjs): the package's mechanical checks of Section
// 12.10 by the packer's validate command (the stand-in packer here), and a
// package AgentDoc's static checks of Section 9.10 by @common-agent/agentdoc,
// against cases copied from the Common Agent 0.41.0 conformance folder. The
// checks that need the running agent are named as not checked, never passed.

import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBuild } from "adlc-console/lib/contract.mjs";
import { factory, stageOf, actionNames, tempDir, STUB_PACKER } from "./helpers.mjs";
import { checkBuild as checkBuildApi, checkStageWorkspace, checkArtifacts } from "../standards/lifecycle-api-check.mjs";
import { STAGE_IDS } from "../lib/standards.mjs";
import { checkConformance } from "../lib/conformance.mjs";
import { attestationChecks } from "../lib/rule-checks.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FOLDER = join(HERE, "..", "runtimes", "folder.mjs");
const PASS_DOC = join(HERE, "fixtures", "conformance", "pass-package.agentdoc.json");
const FAIL_DOC = join(HERE, "fixtures", "conformance", "fail-not-stated-complete-package.agentdoc.json");
const ok = (b) => {
  assert.deepEqual(checkBuild({ build: b }, STAGE_IDS), []);
  assert.deepEqual(checkBuildApi({ build: b }, STAGE_IDS, b.id), []);
};
const results = (checks) => checks.map((c) => [c.id, c.section, c.result]);
const NOT_RUN_HERE = [["descriptor-floor", "4.9", "not_checked"], ["five-questions", "4.3", "not_checked"], ["trials", "7.7", "not_checked"]];

/** A stand-in package as the stand-in packer writes one, in a folder of its own. */
async function aPackage(text = "stand-in package of source\n") {
  const dir = await tempDir("conformance");
  const archive = join(dir, "counter-0.1.0.tar.gz");
  writeFileSync(archive, text);
  return { dir, archive };
}
const run = (o) => checkConformance({ packer: ["node", STUB_PACKER], env: process.env, signal: new AbortController().signal, name: "counter", version: "0.1.0", at: "2026-11-10T12:00:00.000Z", ...o });

test("the checks that run here: the package's (12.10) and a package AgentDoc's (9.10), and the three that need the running agent named as not checked", async () => {
  const { dir, archive } = await aPackage();
  // No package AgentDoc: its checks say so, and nothing reads as passed that did not run.
  let got = await run({ base: join(dir, "a"), archive });
  assert.equal(got.passed, true);
  assert.deepEqual(results(got.checks), [["package", "12.10", "passed"], ["package-agentdoc", "9.10", "not_checked"], ...NOT_RUN_HERE]);
  assert.equal(got.words, "The package passes every Common Agent 0.41.0 check that ran here: the package (Section 12.10), run with node and no network as Section 14 allows. Not checked: the package AgentDoc's static checks (Section 9.10), because the build carries no package AgentDoc (Section 13.4); the bound, signed Descriptor the running agent serves, asked of the agent itself (Section 4.9): Product Factory does not run the agent, so it cannot ask it; the five questions, answered from the agent's signed bytes and diffed against what it says (Section 4.3): they are asked of the running agent; trial requests, admitted and refused as the offerings declare (Section 7.7): they are sent to the running agent. The runtime you bring holds the agent, so the checks that need the running agent are its to run. Product Factory holds no key, so this attestation is not signed.");
  const text = readFileSync(got.file, "utf8");
  assert.match(text, /^---\nattestation: product-factory-conformance-v1\nstandard: "Common Agent 0\.41\.0"\nagent: "counter 0\.1\.0"\npackage: "counter-0\.1\.0\.tar\.gz"\nverdict: passed\nchecked_at: 2026-11-10T12:00:00\.000Z\nsigned: no\nchecks:\n/);
  assert.match(text, /^## Checks that ran\n\n- \*\*The package\*\* \(Section 12\.10\): passed\. counter-0\.1\.0\.tar\.gz passes the mechanical checks of Section 12\.10/m);
  assert.match(text, /^- \*\*Trials\*\* \(Section 7\.7\): not checked\./m);
  // Read back as the attestation artifact's Common Agent checks (lifecycle API 0.4.13): a check that did not run says why.
  const checks = attestationChecks(text, ["npx", "--yes", "@common-agent/package@0.1.0"]);
  assert.deepEqual(checks.map((c) => [c.section, c.result]), [["12.10", "met"], ["9.10", "not_checked"], ["4.9", "not_checked"], ["4.3", "not_checked"], ["7.7", "not_checked"]]);
  assert.match(checks[0].detail, /^counter-0\.1\.0\.tar\.gz passes the mechanical checks of Section 12\.10 .*\. The packer \(@common-agent\/package 0\.1\.0\) implements Section 12 as of Common Agent 0\.30\.0-draft, so this check is only as current as it\.$/);
  assert.equal(checks[1].detail, "The build carries no package AgentDoc (Section 13.4), so the static AgentDoc checks of Section 9.10 had nothing to read.");
  assert.deepEqual(checkArtifacts([{ id: "attestation", stage: "conformance", name: "Conformance attestation", by: "the Common Agent checkers", state: "made", kind: "attestation", summary: { words: got.words }, checks }], STAGE_IDS), []);

  // A package AgentDoc that the conformance cases accept passes; one they refuse fails, with the rule it breaks.
  got = await run({ base: join(dir, "b"), archive, agentdoc: PASS_DOC });
  assert.equal(got.passed, true);
  assert.deepEqual(results(got.checks).slice(0, 2), [["package", "12.10", "passed"], ["package-agentdoc", "9.10", "passed"]]);
  assert.match(got.checks[1].words, /passes the static checks of Section 9\.10 \(@common-agent\/agentdoc, its static checks, without fetching the sources\)/);
  got = await run({ base: join(dir, "c"), archive, agentdoc: FAIL_DOC });
  assert.equal(got.passed, false);
  assert.equal(got.checks[1].result, "failed");
  assert.match(got.checks[1].words, /fails the checks of Section 9\.10 .*: not-stated-complete: standing is absent and not named in not_stated\./);
  assert.match(got.words, /^The package fails one of the Common Agent 0\.41\.0 checks that ran here: the package AgentDoc \(Section 9\.10\)\./);
  assert.match(readFileSync(got.file, "utf8"), /^verdict: failed$/m);

  // A package the packer's checks refuse fails 12.10, in the packer's words.
  const bad = await aPackage("not a package\n");
  got = await run({ base: join(bad.dir, "a"), archive: bad.archive });
  assert.equal(got.passed, false);
  assert.deepEqual(results(got.checks).slice(0, 1), [["package", "12.10", "failed"]]);
  assert.match(got.checks[0].words, /^counter-0\.1\.0\.tar\.gz fails the mechanical checks of Section 12\.10 \(node .*stub-packer\.mjs validate\): not a package\.$/);
});

/** A build walked through your approvals to the deploy gate, with the reference runtime. */
async function atDeployGate(t) {
  const f = await factory({ runtime: { command: ["node", FOLDER, "--into", "./installed"] } });
  t.after(f.close);
  const id = (await f.post("/builds", { does: "Count the words in a passage.", name: "counter" })).json.build.id;
  await f.settled(id);
  await f.post(`/builds/${id}/actions/approve`);
  await f.settled(id);
  await f.post(`/builds/${id}/actions/accept`);
  const b = await f.settled(id);
  assert.deepEqual(actionNames(b), ["approve", "stop"]);
  return { f, id };
}

test("after the deploy, check-conformance holds the deployed package to the checks and records the attestation; the run ends before the publish gate", async (t) => {
  const { f, id } = await atDeployGate(t);
  // The adopted code's own package AgentDoc, where an agent repository keeps it (Common Agent 13.2), is checked too.
  mkdirSync(join(f.store.folder(id), "source", "code"), { recursive: true });
  cpSync(PASS_DOC, join(f.store.folder(id), "source", "code", "agentdoc.json"));
  await f.post(`/builds/${id}/actions/approve`);
  const b = await f.settled(id);
  ok(b);
  assert.equal(stageOf(b, "deploy").state, "done");
  const c = stageOf(b, "conformance");
  assert.equal(c.state, "done");
  assert.equal(c.holder.name, "the Common Agent checkers (@common-agent/package and @common-agent/agentdoc)");
  assert.deepEqual(c.handed_back.files.map((x) => x.path), ["conformance/attestation.md"]);
  assert.equal(c.rounds[0].verdict, "Passed the checks that ran");
  assert.deepEqual(actionNames(b), ["archive"]);

  // The attestation artifact says in words which checks ran and passed, and which need the running agent.
  const a = b.artifacts.find((x) => x.id === "attestation");
  assert.deepEqual([a.state, a.stage, a.kind], ["made", "conformance", "attestation"]);
  assert.match(a.summary.words, /^The package passes every Common Agent 0\.41\.0 check that ran here: the package \(Section 12\.10\) and the package AgentDoc \(Section 9\.10\), run with node and no network as Section 14 allows\. Not checked: the bound, signed Descriptor the running agent serves.*\(Section 4\.9\).*the five questions.*\(Section 4\.3\).*trial requests.*\(Section 7\.7\)/);
  assert.deepEqual(a.summary.checks.map((x) => [x.id, x.result]), [["package", "passed"], ["package-agentdoc", "passed"], ["descriptor-floor", "not_checked"], ["five-questions", "not_checked"], ["trials", "not_checked"]]);
  // Lifecycle API 0.4.13: one Common Agent check per section the attestation reports, the ones the running agent answers not checked.
  assert.deepEqual(a.checks.map((x) => [x.section, x.asks, x.result]), [
    ["12.10", "The deployed package passes the mechanical checks", "met"],
    ["9.10", "The package AgentDoc passes the static checks", "met"],
    ["4.9", "It serves a bound, signed Descriptor", "not_checked"],
    ["4.3", "It answers the five questions from its signed bytes", "not_checked"],
    ["7.7", "It admits and refuses trial requests as its offerings declare", "not_checked"],
  ]);
  assert.match(a.checks[1].detail, /^The package AgentDoc agentdoc\.json passes the static checks of Section 9\.10/);
  for (const c of a.checks.slice(2)) assert.equal(c.detail, "Your runtime holds the agent, so this check is its to run.");
  const w = (await f.get(`/builds/${id}/stages/conformance`)).json;
  assert.deepEqual(checkStageWorkspace(w, STAGE_IDS, "conformance", { build: b }), []);
  assert.deepEqual(w.given, ["package"]);

  // In the run: the runtime's answer was deploy-the-agent's delivery, the checks were check-conformance's, and the run ended before publish-the-agent.
  const r = f.store.read(id).run;
  assert.deepEqual([r.status, r.outcome, r.open], ["closed", "ended", ["publish-the-agent"]]);
  assert.equal(r.phases["check-conformance"].holder.handle, "product-factory/common-agent-checks");
  assert.deepEqual(r.handoffs.attestation.files.map((x) => x.name), ["attestation.md"]);
  assert.ok(b.log.some((e) => /^Done at Conformance\. Product Factory does not publish/.test(e.said)));
});

test("a check that fails refuses Conformance with the attestation, and nothing reads as passed", async (t) => {
  const { f, id } = await atDeployGate(t);
  mkdirSync(join(f.store.folder(id), "source", "code"), { recursive: true });
  cpSync(FAIL_DOC, join(f.store.folder(id), "source", "code", "agentdoc.json"));
  await f.post(`/builds/${id}/actions/approve`);
  const b = await f.settled(id);
  ok(b);
  assert.equal(b.summary, "Refused at Conformance: waiting on you");
  const c = stageOf(b, "conformance");
  assert.deepEqual([c.state, c.done_when_met, c.rounds[0].verdict], ["refused", false, "A check failed"]);
  assert.deepEqual(actionNames(b), ["resume", "stop"]);
  const a = b.artifacts.find((x) => x.id === "attestation");
  assert.equal(a.state, "made");
  assert.match(a.summary.words, /^The package fails one of the Common Agent 0\.41\.0 checks that ran here: the package AgentDoc \(Section 9\.10\)\./);
  const doc = a.checks.find((c) => c.section === "9.10");
  assert.equal(doc.result, "not_met");
  assert.match(doc.detail, /not-stated-complete: standing is absent and not named in not_stated\./);
  assert.equal(f.store.read(id).run.phases["check-conformance"].status, "refused");
});
