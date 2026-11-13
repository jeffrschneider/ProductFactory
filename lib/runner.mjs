// The driver: runs each build's process document through the process runner
// (orchestrator.mjs) and does what the runner says with the holder adapters.
// It holds no order of steps of its own. For each build it asks the runner
// for every action it has now, and acts on them: phases no after: path
// connects never wait for each other (Agent Processes 6.2), so when more than
// one phase is ready to send, each goes to its holder at once. By kind:
//
//   send-work, send-revision   hands the phase to its adapter (adapters.mjs), then tells
//                              the runner what came back (replied: delivered or refused)
//   ask-gate, ask-approve,     the person's gate: the build waits, and the console shows
//   ask-act-on-draft           the gate's actions; the person's answer is an event
//                              (approved, deviated, resumed, stopped)
//   ask-refused, fail-refused  the build waits on the person, in the holder's words
//   close                      the build is done
//
// A phase at a stage milestone 1 does not run, or at a stage the build's
// lifecycle leaves out, ends the run there, and the run's record names the
// phases left open. At a packed build, the process document's "approve the
// deploy" gate is asked with the run plan to read; once the person says yes,
// the package and the plan go to the runtime you bring (runtime.mjs). A run
// whose roster names the runtime for deploy-the-agent goes on: the runtime's answer is that phase's delivery, check-conformance
// holds the package to the Common Agent checks that run here (conformance.mjs),
// and the run ends before the publish gate, which Product Factory does not hold.
// Any other run ends at the deploy, as before.
//
// Code on a pull request (code.holder "pull-request"): the code phase opens a
// "Write the scripts" pull request with the build folder (pull-request.mjs)
// and the build waits on pushes. poll() reads the pull request's newest
// commit; on each new one the gate runs (gate.mjs), its result goes on the
// pull request, and a pass is the holder's delivery. Your OK takes the
// scripts from that exact commit; Send back to Test has the test writer
// revise the suite, and the revised tests go on the same pull request.
// With code.harness set, Product Factory runs the harness itself in the fix
// loop (fixLoop, fix-loop.mjs): each round's changes are committed to the
// branch and gated, and the gate's findings go back to the harness.
//
// The spec (stages.json 1.6.0): the spec writer's job hands back the spec
// (spec.json and spec.md, found by spec.mjs) and the agent's own files made
// from it. Its features go to the person as proposed (features.mjs
// specProposals). Test is given spec.json with the agent's files
// (suiteGiven); Code's hand-off is given spec.json and spec.md with the
// agent's files and the suite (handOffGiven), and pins them all.
//
// A new agent is built by one builder (make-a-new-agent-one-builder.txt,
// builder.mjs): your coding harness with the ADLC plugin, or your own coding
// assistant on a pull request, writes the spec and then the build in one
// folder whose own check decides each stage. Adopting existing code and
// rebuilding from an as-built record run their own documents on the
// reference spec writer and test writer, and a rebuild's Code on the
// reference code writer.
//
// Every step writes the run's state and what the console shows into
// build.json before the next starts, so a build that was running when Product
// Factory stopped sends its phase again when it starts.

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Refused } from "./lifecycle.mjs";
import { openRun, parse, actionsFor, event, stageOf, holderOf, RUNS, phaseNamed, saveRun, timelineOf, phaseMaterial, rosterOf, builtByOne, BUILDER_STAGES } from "./orchestrator.mjs";
import { layOut, startFolder, addChanges, specPrompt, approveSpec, checkBuild, sendBack as sendFolderBack, builderRound, passedStages, questionsOf, writeAnswers, STAGE_OF_CHECK } from "./builder.mjs";
import { stageById, roleById, STAGES_DOC } from "./standards.mjs";
import { modelEnv, localPerson, credentialNames } from "./config.mjs";
import { withoutEnv } from "./exec.mjs";
import { RECORD_FORMAT } from "./store.mjs";
import { actionsOf } from "./view.mjs";
import { specWriter, RECORD_PIECE, testWriter, handOff, codeWriterWorkspace, codeRound, scriptsHanded, pack, requestText, reviewer, reviewerMissing, reverseEngineer, checkFolder, fixHarness, AS_BUILT_FILES, AS_BUILT_TYPES, CARRIED_RECORD, isTestFile } from "./adapters.mjs";
import { fixLoopOn, fixRoundsOf, fixPrompt, findingsText, writeFolder, snapshotOf, changesOf, roundFiles, stopOf, tookWords, pathWords } from "./fix-loop.mjs";
import { sourceOf, checkout, adoptable, adoptInto, namedScripts, codeFiles, short } from "./adopt.mjs";
import { recordSourceOf, fetchRecord, carriedOf, supportType, CARRIED_FOLDERS } from "./as-built-record.mjs";
import { connect, openPullRequest, pullRequestHead, readCommitFiles, postResult, revisePullRequest, takePullRequest, readBuildFolder, slugOf, readBranchFolder, commitFixRound, commitOnBranch } from "./pull-request.mjs";
import { builderPullRequestBody, builtOf, mirror, changedFrom } from "./builder-pr.mjs";
import { judgeFolder, runGateSuite } from "./gate.mjs";
import { digestOf, LOCK_FILE } from "./fence.mjs";
import { REVIEWERS, SPENDING_LIMIT_DEFAULT, packageFiles, changeDiff, requestText as reviewText, judgeRun, finalVerdict } from "./review.mjs";
import { writeTarGz } from "./tar.mjs";
import { createRuntime } from "./runtime.mjs";
import { registerOf, eventsOf, buildsUpTo, materialLines, byFeature, byFeatureWords, asBuiltProposals, openAsBuilt, specProposals } from "./features.mjs";
import { testNames, gapWords } from "./artifacts.mjs";
import { specFilesOf, specOfBuild, specFeatures, isSpecName, isSpec, SPEC_JSON, SPEC_MD } from "./spec.mjs";
import { checkConformance, ATTESTATION_FILE } from "./conformance.mjs";

const words = (s) => String(s ?? "").trim();
const nameOf = (id) => stageById.get(id)?.name ?? id;
const rel = (base, at) => relative(base, at).split(sep).join("/");
const firstWords = (s, n = 500) => { const t = words(s).replace(/\s+/g, " "); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const AGENT_FILE = /^(agent-descriptor\.json|agent-runtime-requirements\.json|plugin\.json|mcp\.json|skills\/[^/]+\/SKILL\.md)$/;

/** The request as the spec writer reads it. A name is passed only when the person gave one. */
const asked = (r) => requestText({ ...r, name: r.named ? r.name : "", version: r.versioned ? r.version : "" });

const ROLE_OF = { "reverse-engineering": "reverse-engineer", requirements: "spec-writer", architecture: "solution-architect", test: "test-writer", code: "code-writer", package: "package-maker" };

// From stages.json 1.6.0 Requirements hands back the spec, and the agent's own files are made from it at Design.
const GIVEN = {
  conformance: "The package that was deployed, held to the Common Agent checks that run with node and no network: its mechanical checks, and its package AgentDoc's when the build carries one. The checks that need the running agent are left to the runtime you bring.",
  code: "The spec, the agent's files and the suite, laid out as a build folder with AGENTS.md (the hand-off contract), .adlc/check.mjs and build.lock.json.",
  "code-pr": "The spec, the agent's files and the suite, laid out as a build folder with AGENTS.md (the hand-off contract), .adlc/check.mjs and build.lock.json, on a \"Write the scripts\" pull request your coding harness pushes to.",
  "code-pr-loop": "The spec, the agent's files and the suite, laid out as a build folder with AGENTS.md (the hand-off contract), .adlc/check.mjs and build.lock.json, on a \"Write the scripts\" pull request. Product Factory runs your coding harness on it in the fix loop: each round's scripts go on the branch as one commit, and the gate's findings go back to the harness in the next round.",
  package: "The agent's files as you approved them, and the scripts Code wrote, placed under each skill as plugin.json's build entry names them.",
  // One builder holds Architecture, Test and Code in one build folder (make-a-new-agent-one-builder.txt).
  "architecture-builder": "The spec you approved, in the build folder with the ADLC plugin's kit. One builder writes the rest of the build from it in whatever order works best, the architecture record and the agent's own files among it; the folder's own check judges every gate together, and asks you what only you can answer.",
  "test-builder": "The spec you approved, in the same build folder. The builder writes the suite as part of the build; the check holds every test to an approved scenario, shows it fails against empty scripts, and fixes the tests the first time the code is judged against them.",
  "code-builder": "The spec you approved, in the same build folder. The builder writes the scripts as part of the build, until the folder's check passes: the suite passes, each script is noticed blanked, and the Common Agent packer accepts the folder.",
  // Started from existing code (stages.json 1.4.0).
  "test-adopt": "The spec from Requirements, as you approved it, the agent's own files made from it, and the behaviors and the existing tests and gaps of the as-built record (parts 1 and 5), to write characterization tests that pin each behavior you approved as built.",
  "code-adopt": "The spec, the agent's files and the characterization suite, laid out as a build folder, and the existing code at the commit it was taken on at, as the first version of the scripts.",
  // Started from an as-built record of code kept elsewhere (stages.json 1.5.0).
  "test-record": "The spec from Requirements, as you approved it, the agent's own files made from it, and the as-built record you brought: its behaviors, interfaces, architecture as built, and existing tests and gaps, to write tests that pin each behavior you approved, for code written fresh.",
};

/** The words "Reverse engineering" is given on a build started from an as-built record: it did not run here. */
const broughtGiven = (r) => `Not run here: you brought the as-built record of code kept elsewhere (${r.record.code.repository} at ${short(r.record.code.commit)}), from ${r.record.shown}. The code it describes is not taken on; Code writes the code fresh.`;

/** The words Reverse engineering is given, for a build started from existing code. */
const reverseGiven = (r) => r.source?.trigger === "drift"
  ? `The codebase ${r.source.shown} at its newest commit, and the last as-built record (${r.drift?.version ?? "the version before"}, at ${short(r.drift?.commit)}), so only what changed is described.`
  : `The codebase ${r.source.shown}${r.source.commit_asked ? ` at ${r.source.commit_asked}` : ", at its newest commit"}, as it is: the code is read, and the record says whether it was run.`;

/** Who holds each stage milestone 1 runs, from the settings in effect when the build started. */
export function holdersFor(settings, { adopt = false, record = null } = {}) {
  const packer = settings.packer.join(" ");
  if (record) {
    // The record was made elsewhere: Reverse engineering is held by whoever made it, and every stage after it as for a new build.
    const made = [words(record.made_by?.agent), words(record.made_by?.version)].filter(Boolean).join(" ");
    return { "reverse-engineering": { kind: "outside_tool", name: `the as-built record you brought${made ? ` (made by ${made})` : ""}`, role: "reverse-engineer" }, ...holdersFor(settings) };
  }
  if (adopt) {
    return {
      "reverse-engineering": { kind: "reference_agent", name: "reverse-engineer", role: "reverse-engineer" },
      requirements: { kind: "reference_agent", name: "spec-writer", role: "spec-writer" },
      test: { kind: "reference_agent", name: "test-writer", role: "test-writer" },
      code: { kind: "outside_tool", name: "the existing code, adopted as it is", role: "code-writer" },
      package: { kind: "outside_tool", name: packer.includes("@common-agent/package") ? "the Common Agent packer (@common-agent/package)" : `the packer (${settings.packer[0]})`, role: "package-maker" },
    };
  }
  if (settings.code.holder === "builder") {
    // One builder holds every writing stage, from the spec through the code (make-a-new-agent-one-builder.txt): your coding harness with the ADLC plugin. No reference spec writer runs.
    const builder = settings.code.where === "pull-request" ? `one builder: your own coding assistant with the ADLC plugin, on a pull request (${settings.repository?.repo ?? "no repository set"})` : `one builder: your coding harness (${settings.code.harness?.[0] ?? "not set"}) with the ADLC plugin`;
    const one = (role) => ({ kind: "your_agent", name: builder, role });
    return {
      requirements: one("spec-writer"),
      architecture: one("solution-architect"),
      test: one("test-writer"),
      code: one("code-writer"),
      package: { kind: "outside_tool", name: packer.includes("@common-agent/package") ? "the Common Agent packer (@common-agent/package)" : `the packer (${settings.packer[0]})`, role: "package-maker" },
      conformance: { kind: "outside_tool", name: "the Common Agent checkers (@common-agent/package and @common-agent/agentdoc)", role: "conformance-checker" },
    };
  }
  return {
    requirements: { kind: "reference_agent", name: "spec-writer", role: "spec-writer" },
    // Only a build whose run's roster names the checkers keeps this stage (start).
    conformance: { kind: "outside_tool", name: "the Common Agent checkers (@common-agent/package and @common-agent/agentdoc)", role: "conformance-checker" },
    test: { kind: "reference_agent", name: "test-writer", role: "test-writer" },
    code: settings.code.holder === "code-writer"
      ? { kind: "reference_agent", name: "code-writer", role: "code-writer" }
      : settings.code.holder === "pull-request"
        ? { kind: "your_agent", name: fixLoopOn(settings) ? `your coding harness (${settings.code.harness[0]}), run by Product Factory on a pull request (${settings.repository?.repo ?? "no repository set"})` : `your coding harness, on a pull request (${settings.repository?.repo ?? "no repository set"})`, role: "code-writer" }
        : { kind: "your_agent", name: `your coding harness (${settings.code.harness?.[0] ?? "not set"})`, role: "code-writer" },
    package: { kind: "outside_tool", name: packer.includes("@common-agent/package") ? "the Common Agent packer (@common-agent/package)" : `the packer (${settings.packer[0]})`, role: "package-maker" },
  };
}

export function createRunner({ store, lifecycle, config, env = process.env, person = localPerson(), now = () => new Date().toISOString() }) {
  const running = new Map();
  const by = person.email;
  const runtime = createRuntime({ store, config, env, now });

  const say = (list, said) => list.push({ at: now(), said });
  const dirOf = (id) => store.folder(id);
  const abs = (id, p) => resolve(dirOf(id), p);
  const docs = new Map();
  const docOf = (r) => {
    if (!docs.has(r.id)) docs.set(r.id, parse(readFileSync(abs(r.id, r.process), "utf8")));
    return docs.get(r.id);
  };

  /** One change to a build: fn(record, ev) may apply events to its run with ev(e). The run is kept on disk the runner's way too. */
  function change(id, fn) {
    return store.update(id, (b) => {
      const doc = docOf(b);
      const ev = (e) => { b.run = event(b.run, { at: now(), ...e }, doc); };
      const out = fn(b, ev);
      try { saveRun(join(dirOf(id), "run"), b.run); } catch { /* the run in build.json is the record */ }
      return out;
    });
  }

  /**
   * The environment code a model wrote runs in: the gate running the scripts on a pull request and
   * their suite, and the harness in the fix loop. Every credential Product Factory reads or is told
   * to keep from a harness is taken out by its exact name (config.mjs credentialNames); the rest
   * (PATH, HOME or USERPROFILE, TEMP, and the settings the agent's own files declare) stays.
   */
  const sealedEnv = (r) => withoutEnv(env, credentialNames(config, r.settings));

  function agentEnv() {
    const e = { ...env, ...modelEnv(config, env).env };
    // The spec writer would check its drafts with the package maker's Python builder if one were
    // on this machine; Product Factory runs no Python, so it never points the spec writer at one.
    delete e.BUILD_PY;
    return e;
  }

  function filesHanded(id, list) {
    return list.map((f) => {
      let size = 0;
      try { size = statSync(abs(id, f.at)).size; } catch { /* gone */ }
      return { path: f.path, at: f.at, size };
    });
  }

  /** The files a phase was handed, from the runner's handoffs: [{ name, path, media_type }] with path inside the build folder. */
  const handed = (action) => (action.handoffs ?? []).flatMap((h) => h.files ?? []);
  const absOf = (id, list) => list.map((f) => ({ abs: abs(id, f.path), media_type: f.media_type }));

  /**
   * What the test writer is given as files (stages.json 1.6.0): the spec
   * (spec.json, format spec-v1) and the agent's own files made from it, from
   * the phase's handed files. The as-built record's parts go beside them
   * (recordParts). The spec's files are found in spec.mjs.
   */
  const suiteGiven = (id, action) => {
    const files = handed(action);
    return absOf(id, [...specFilesOf(files).filter((f) => f.name === SPEC_JSON), ...files.filter((f) => AGENT_FILE.test(f.name))]);
  };

  /**
   * What the code writer's hand-off is given (stages.json 1.6.0): the spec
   * (spec.json and spec.md), the agent's own files and the suite, from the
   * phase's handed files. The hand-off lays them out as the build folder and
   * pins the spec with the agent's files, so on a pull request they are
   * pinned alike, and a revised spec goes to the branch with the revised suite.
   */
  const handOffGiven = (id, action) => {
    const files = handed(action);
    // Each suite file keeps its path, so files carried beside the tests (under test/support/) keep their layout.
    const suite = files.filter((f) => /^test\//.test(f.name));
    const own = absOf(id, suite).map((f, i) => ({ ...f, path: suite[i].name }));
    return { spec: absOf(id, specFilesOf(files)), agentFiles: absOf(id, files.filter((f) => AGENT_FILE.test(f.name))), suite: own };
  };

  function missingModel() {
    const { missing } = modelEnv(config, env);
    if (!missing.length) return null;
    return `The reference agents need a model, and ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set. product-factory.json names the environment variables the four model settings are read from (model.name, model.endpoint, model.key, model.protocol); set them, then run it again.`;
  }

  // ---------- sending a phase to its adapter, and telling the runner what came back ----------

  /** The phase goes out: the runner records who holds it and that the work was sent. */
  function sent(id, action, stage, said) {
    return change(id, (b, ev) => {
      if (b.status !== "working") return;
      ev({ type: "holder", phase: action.phase, handle: action.to, how: action.holder?.how ?? "named in the roster" });
      ev({ type: "sent", phase: action.phase, to: action.to, handle: action.to, kind: action.kind === "send-revision" ? "revision" : "work", text: said });
      const s = b.stages[stage];
      s.state = "working";
      s.runs += 1;
      say(s.log, said);
    });
  }

  /** The holder refused: the runner records it, and the build waits on the person in the holder's words. */
  function refused(id, action, stage, reply, extra = {}) {
    return change(id, (b, ev) => {
      if (b.status !== "working") return;
      ev({ type: "replied", phase: action.phase, from: action.to, handle: action.to, text: reply, files: extra.files ?? [], verdict: "refused" });
      const s = b.stages[stage];
      s.state = "refused";
      s.done_when_met = false;
      if (extra.round) s.rounds.push(extra.round);
      if (extra.handed) s.handed_back = { words: [reply], files: filesHanded(id, extra.handed) };
      else s.handed_back.words = [reply];
      say(s.log, firstWords(reply));
      // The runner decides what a refusal means (it may end the run); the next step asks it.
      say(b.log, `${nameOf(stage)} was refused. It waits on you.`);
    });
  }

  /** The holder delivered: the runner records the delivery and its files. */
  function delivered(b, ev, action, reply, files) {
    ev({ type: "replied", phase: action.phase, from: action.to, handle: action.to, text: reply, files, verdict: "delivered" });
  }

  const asFiles = (id, list) => list.map((f) => ({ name: f.path, path: rel(dirOf(id), f.abs), media_type: f.media_type ?? "" }));

  /** A build started from an earlier version: that version's approved agent files, with the first draft only, to revise. */
  const earlierFiles = (r, revise, n) => (!revise && n === 1 && r.earlier ? r.earlier.files.map((f) => ({ abs: abs(r.earlier.build, f.at), media_type: f.media_type })) : []);

  /**
   * The approved features of the build's product (features.mjs), as the lines of
   * the run's material aimed at one phase: the process runner hands a phase the
   * lines aimed at it ("[write-the-spec] ..."), so the spec writer and the test
   * writer read them as part of what they were asked. Empty without any.
   */
  function featuresFor(r, phase) {
    const builds = store.list().filter((b) => b.name === r.name);
    const reg = registerOf(eventsOf(buildsUpTo(builds.some((b) => b.id === r.id) ? builds : [...builds, r], r)));
    // A build started from existing code also carries the code as built (asBuiltLines). With a spec (stages.json 1.6.0), tests are named by its scenarios.
    const scenarios = Boolean(specOfBuild(r, dirOf(r.id)));
    const list = [...reg.values()].sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
    const lines = [materialLines(list, { scenarios }), asBuiltLines(r, reg)].filter(Boolean).join("\n");
    if (!lines) return "";
    // Only the lines aimed at a phase are features; a line aimed at none is not one of them.
    return phaseMaterial(lines, docOf(r), phase);
  }
  const withFeatures = (text, r, phase) => { const f = featuresFor(r, phase); return f ? `${text.replace(/\s+$/, "")}\n\n${f}\n` : text; };

  /** The test names in a build folder's suite, for its results per feature. */
  function suiteNames(folder) {
    const out = [];
    try {
      for (const name of readdirSync(join(folder, "test")).filter((n) => n.endsWith(".test.mjs")).sort()) out.push(...testNames(readFileSync(join(folder, "test", name), "utf8")));
    } catch { /* no suite to read */ }
    return out;
  }

  // ---------- existing code: Reverse engineering, the as-built record, and Code adopting the code ----------

  const adopting = (r) => r.starting_point === "existing-code";
  /** Started from an as-built record of code kept elsewhere (stages.json 1.5.0): the record is given, nothing is adopted. */
  const fromRecord = (r) => r.starting_point === "as-built-record" && Boolean(r.record);
  const readJsonAt = (at) => { try { return JSON.parse(readFileSync(at, "utf8")); } catch { return null; } };

  /** The as-built record a build's Reverse engineering handed back: each file by name, its place, and the parts read. */
  function asBuiltOf(r) {
    const files = r.stages?.["reverse-engineering"]?.handed_back?.files ?? [];
    const at = Object.fromEntries(files.filter((f) => /^as-built\//.test(f.path)).map((f) => [f.path.slice("as-built/".length), abs(r.id, f.at)]));
    const behaviors = (() => { const v = readJsonAt(at["behaviors.json"]); return Array.isArray(v) ? v : Array.isArray(v?.behaviors) ? v.behaviors : []; })();
    return { at, behaviors, record: readJsonAt(at["record.json"]) ?? {}, tests: readJsonAt(at["tests-and-gaps.json"]) ?? {} };
  }

  /** Where the build's copy of the codebase is, at the commit it knew. */
  const codeDir = (id) => join(dirOf(id), "source", "code");

  /**
   * The lines of the run's material about the code as built, aimed at the spec
   * writer and the test writer (orchestrator.mjs phaseMaterial): what the code
   * is, the behaviors it was found to have, the scripts it has, and for the
   * test writer that its tests pin only the behaviors approved as built.
   */
  function asBuiltLines(r, reg = new Map()) {
    if (fromRecord(r)) return recordLines(r, reg);
    if (!adopting(r) || !r.source?.commit) return "";
    const { behaviors, tests } = asBuiltOf(r);
    const where = `${r.source.shown} at ${short(r.source.commit)}`;
    let scripts = [];
    try { scripts = codeFiles(codeDir(r.id)).filter((p) => /^scripts\/.+\.[cm]?js$/.test(p)); } catch { /* not read yet */ }
    const { gaps, had } = testsAndGaps(tests);
    return [
      `[write-the-spec] as built: this agent is existing code, taken on from ${where}. Write the spec of what the code does, from the as-built record; the owner decides at the spec what is kept. ${scripts.length ? `Name the scripts the code already has, at their paths: ${scripts.join(", ")}.` : "The code has no scripts/ folder; name the scripts it has."}`,
      ...behaviors.map((b) => `[write-the-spec] - ${behaviorWords(b, reg)}`),
      `[write-the-suite] characterization: this agent is existing code, taken on from ${where}. Write characterization tests: each pins what the code does today for one approved feature, as the as-built record says. Pin nothing that is not approved; a behavior called a bug or dropped is left out.${had.length ? ` Tests the code already has: ${had.join(", ")}.` : ""}${gaps.length ? ` Gaps the record marked: ${gaps.join("; ")}.` : ""}`,
    ].join("\n");
  }

  /**
   * A behavior of the as-built record as a line of the spec writer's material:
   * its id, the feature it was proposed as (so the spec keeps that feature's id,
   * and the tests named by its scenarios tie to it), its name, what it does and
   * its evidence. reg: the product's features (features.mjs registerOf).
   */
  const behaviorWords = (b, reg) => {
    const f = [...reg.values()].find((x) => x.as_built?.behavior === words(b.id));
    return `${words(b.id)}${f ? ` (feature ${f.id})` : ""} ${words(b.name)}: ${words(b.does)}${evidenceOf(b)}`;
  };

  /** A behavior's evidence, as " (file:line; ...)". */
  const evidenceOf = (b) => { const e = Array.isArray(b.evidence) ? b.evidence : b.evidence ? [b.evidence] : []; return e.length ? ` (${e.map((x) => (typeof x === "string" ? x : [x?.file, x?.line].filter(Boolean).join(":") || x?.run || "")).join("; ")})` : ""; };
  /** The existing tests and the gaps of part 5, in words. A gap is read as the reverse engineer writes it (about, why), or as what or words. */
  const testsAndGaps = (tests) => ({
    gaps: (Array.isArray(tests.gaps) ? tests.gaps : []).map(gapWords).filter(Boolean),
    had: (Array.isArray(tests.tests) ? tests.tests : []).map((x) => (typeof x === "string" ? x : words(x?.name ?? x?.file))).filter(Boolean),
  });

  /**
   * The material lines for a build started from an as-built record of code
   * kept elsewhere: the spec is written from what the record says the code
   * does, keeping its interfaces and settings as the record gives them, and
   * the suite pins each approved behavior, for code written fresh. The record's
   * files go with both too (recordParts), whole.
   */
  function recordLines(r, reg = new Map()) {
    const { behaviors, tests } = asBuiltOf(r);
    const where = `${r.record.code.repository} at ${short(r.record.code.commit)}`;
    const { gaps, had } = testsAndGaps(tests);
    return [
      `[write-the-spec] as built elsewhere: this agent is built again from the as-built record of code kept elsewhere (${where}), brought from ${r.record.shown}. The code is not taken on: write the spec of what the record says the code does, so the code can be written fresh; the owner decides at the spec what is kept. The record's files are attached whole. Keep the interfaces exactly as the record gives them (output formats and their schemas, exported functions and their names, command line flags, and quoted patterns and words), and declare every setting, system and network the architecture part names. Where the record does not say, ask; do not invent.`,
      ...behaviors.map((b) => `[write-the-spec] - ${behaviorWords(b, reg)}`),
      `[write-the-suite] as built elsewhere: this agent is built again from the as-built record of code kept elsewhere (${where}), and the code is written fresh. Write tests that pin each approved feature as the record says the code does it, holding the interfaces, settings and words the record gives exactly. Pin nothing that is not approved; a behavior called a bug or dropped is left out. The record's files are attached whole.${had.length ? ` Tests the code kept elsewhere has: ${had.join(", ")}.` : ""}${gaps.length ? ` Gaps the record marked: ${gaps.join("; ")}.` : ""}`,
    ].join("\n");
  }

  /** The record's own JSON files beside its six, such as the output schemas it derived, passed on whole. The original's own tests and the files they import (tests/, support/) go to the test writer alone, carried (carriedParts). */
  const extraParts = (at) => Object.keys(at).filter((n) => !AS_BUILT_FILES.includes(n) && !CARRIED_FOLDERS.some((d) => n.startsWith(`${d}/`))).sort();

  /**
   * The original's own tests to carry into the suite (reverse engineer 0.3.0,
   * test-writer 0.10.0), for a build with an as-built record: each test of
   * tests-and-gaps.json's carried list, every file under the write-up's
   * support/, and the carried manifest naming them with their digests, written
   * beside the test stage's jobs as carried-r<n>.json. None when the record
   * carries none.
   */
  const carriedParts = (r, n) => {
    if (!adopting(r) && !fromRecord(r)) return [];
    const { at, tests } = asBuiltOf(r);
    const got = carriedOf(at, tests);
    if (!got) return [];
    const file = join(dirOf(r.id), "stages", "test", `carried-r${n}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(got.manifest, null, 2)}\n`);
    return [...got.files.map((f) => ({ abs: f.abs, media_type: f.media_type })), { abs: file, media_type: "application/json" }];
  };

  /**
   * The as-built record's parts the spec writer and the test writer are given,
   * as files: the behaviors, the interfaces, the architecture as built, and the
   * existing tests and gaps (parts 1, 3, 2 and 5), and any other file the record
   * carries, each whole. A build that has no record is given none.
   */
  const recordParts = (r) => {
    if (!adopting(r) && !fromRecord(r)) return [];
    const { at } = asBuiltOf(r);
    return [...["behaviors.json", "interfaces.json", "architecture.json", "tests-and-gaps.json"].filter((n) => at[n]), ...extraParts(at)].map((n) => ({ abs: at[n], media_type: "application/json" }));
  };

  /** Reverse engineering: the codebase read at its commit, the reverse engineer's as-built record, and each behavior proposed as a feature marked as built. */
  async function reverseStep(r, action, stage, signal) {
    const id = r.id;
    await sent(id, action, stage, r.source?.trigger === "drift" ? "Sent to the reverse engineer with the code and the last as-built record." : "Sent to the reverse engineer with the code.");
    const n = store.read(id).stages[stage].runs;
    const fail = (why) => refused(id, action, stage, why, { round: { n, at: now(), label: `Round ${n}`, verdict: "Refused", back: false, words: firstWords(why) } });
    // The codebase at its commit, in the build's folder: read once, and kept as the commit the build knew.
    const code = codeDir(id);
    let src = store.read(id).source;
    if (!src.commit || !existsSync(code)) {
      const into = join(dirOf(id), "source", `r${n}`);
      const got = await checkout({ ...src, commit: src.commit ?? src.commit_asked }, into, { env, signal });
      if (signal.aborted) return;
      if (!got.ok) return fail(got.reason);
      await store.update(id, (b) => {
        // The copy the build keeps is the one this round read.
        b.source = { ...b.source, commit: got.commit, at: now(), words: got.words, copy: rel(dirOf(id), into) };
        say(b.stages[stage].log, got.words);
        say(b.log, got.words);
      });
      src = store.read(id).source;
      cpSync(into, code, { recursive: true });
    }
    // The code also goes as an archive, the way the hand-off hands a build folder over.
    let archive = null;
    try {
      const files = codeFiles(code).map((p) => ({ path: p, bytes: readFileSync(join(code, ...p.split("/"))) }));
      archive = join(dirOf(id), "stages", stage, `r${n}`, "codebase.tar.gz");
      mkdirSync(dirname(archive), { recursive: true });
      writeFileSync(archive, writeTarGz(files));
    } catch { archive = null; /* a path too long for an archive: the folder is named in the message */ }
    const fresh = store.read(id);
    const previous = (fresh.drift?.files ?? []).map((f) => ({ abs: resolve(dirOf(f.build), f.at), media_type: AS_BUILT_TYPES[f.name] ?? "application/json" }));
    const res = await reverseEngineer({
      dir: dirOf(id), adlc: config.adlc, n, code, repository: src.shown, commit: src.commit, trigger: src.trigger,
      since: fresh.drift?.commit ?? null, previous, archive, env: agentEnv(), signal,
    });
    if (signal.aborted) return;
    const round = { n, at: now(), label: `Round ${n}`, verdict: res.ok ? "As-built record made" : "Refused", back: false, words: firstWords(res.reply) };
    if (!res.ok) return refused(id, action, stage, res.reply, { round, handed: res.handed ?? [] });
    await change(id, (b, ev) => {
      if (b.status !== "working") return;
      const s = b.stages[stage];
      s.rounds.push(round);
      s.handed_back = { words: [res.reply], files: filesHanded(id, res.handed) };
      s.state = "done";
      s.done_when_met = true;
      say(s.log, `The reverse engineer handed back the as-built record of ${short(src.commit)}, in five parts.`);
      // Each behavior goes to Requirements as a proposed feature marked as built.
      const builds = store.list().filter((x) => x.name === b.name && x.id !== b.id);
      const v = readJsonAt(resolve(dirOf(id), res.handed.find((f) => f.path === "as-built/behaviors.json").at));
      const behaviors = Array.isArray(v) ? v : Array.isArray(v?.behaviors) ? v.behaviors : [];
      const kept = asBuiltProposals([...builds, b], behaviors, { build: b.id, commit: src.commit, at: now() });
      if (kept.length) (b.feature_log ??= []).push(...kept);
      say(b.log, kept.length
        ? `The as-built record is made. ${kept.length} behavior${kept.length === 1 ? " goes" : "s go"} to Requirements as proposed features marked as built, for you to approve, call a bug, or drop.`
        : "The as-built record is made. No behavior in it differs from the features the product holds.");
      delivered(b, ev, action, res.reply, res.handed.map((f) => ({ name: f.path, path: f.at, media_type: AS_BUILT_TYPES[f.path.slice(9)] ?? (CARRIED_FOLDERS.some((d) => f.path.startsWith(`as-built/${d}/`)) ? supportType(f.path) : "application/json") })));
    });
  }

  /** Code that cannot be packaged as an agent: the build stops at Code, in plain words. */
  function notAnAgent(id, action, stage, why) {
    return change(id, (b, ev) => {
      if (b.status !== "working") return;
      const s = b.stages[stage];
      const n = s.rounds.length + 1;
      s.rounds.push({ n, at: now(), label: `Round ${n}`, verdict: "Cannot be packaged as an agent", back: false, words: firstWords(why, 800) });
      s.handed_back = { words: [why], files: [] };
      s.state = "stopped";
      s.done_when_met = false;
      say(s.log, why);
      b.work.not_an_agent = why;
      ev({ type: "stopped", by: "Product Factory", reason: why });
      b.status = "stopped";
      say(b.log, `Stopped at Code: ${why}`);
    });
  }

  /** Code for a build started from existing code: the code at its commit is the first version of the scripts, and the gate runs it against the characterization suite. */
  async function adoptStep(r, action, stage, signal) {
    const id = r.id;
    const dir = dirOf(id);
    await sent(id, action, stage, `The existing code at ${short(r.source?.commit)} is taken as the first version of the scripts.`);
    const h = await handOff({ dir, adlc: config.adlc, ...handOffGiven(id, action), env: agentEnv(), signal });
    if (signal.aborted) return;
    if (!h.ok) return refused(id, action, stage, h.reply);
    const plan = adoptable(codeDir(id), namedScripts(h.folder), { commit: r.source?.commit });
    if (!plan.ok) return notAnAgent(id, action, stage, plan.why);
    const placed = adoptInto(h.folder, codeDir(id), plan);
    await store.update(id, (b) => {
      b.work.folder = rel(dir, h.folder);
      const s = b.stages[stage];
      say(s.log, `The build folder is laid out at ${h.folder}, with AGENTS.md, and the code at ${short(b.source.commit)} placed in it: ${placed.join(", ")}.`);
      if (plan.left.length) say(s.log, `Left out of the package, as an Agent Package ships its scripts and its own files: ${plan.left.slice(0, 12).join(", ")}${plan.left.length > 12 ? ", …" : ""}.`);
    });
    const n = store.read(id).stages[stage].rounds.length + 1;
    const res = await checkFolder({ dir, folder: h.folder, round: n, env: agentEnv(), signal });
    if (signal.aborted || res.stopped) return;
    const perFeature = byFeature(suiteNames(h.folder), res.pass ? [] : res.items);
    const verdict = res.pass ? "The existing code passes the suite" : "The existing code fails the suite";
    const said = [res.words, ...(res.items.length ? [`Failing: ${res.items.join("; ")}`] : []), byFeatureWords(perFeature)].filter(Boolean).join(" ");
    const scripts = scriptsHanded(dir, h.folder);
    await change(id, (b, ev) => {
      if (b.status !== "working") return;
      const s = b.stages[stage];
      s.rounds.push({ n, at: now(), label: `Round ${n}`, verdict, back: !res.pass, words: firstWords(said, 800), ...(perFeature.length ? { failing: res.pass ? [] : res.items, by_feature: perFeature } : {}) });
      s.handed_back = { words: [res.words], files: filesHanded(id, scripts) };
      say(s.log, `Round ${n}: ${verdict.toLowerCase()}.`);
      if (!res.pass) return;
      s.done_when_met = true;
      say(b.log, `The existing code at ${short(b.source.commit)} passes the characterization suite.`);
      delivered(b, ev, action, res.words, scripts.map((f) => ({ name: f.path.replace(/^code\//, ""), path: f.at, media_type: "text/javascript" })));
    });
    if (!res.pass) return refused(id, action, stage, `The existing code at ${short(r.source?.commit)} does not pass the characterization suite. ${said}`.trim());
  }

  async function specWriterStep(r, action, stage, signal) {
    const id = r.id;
    // Sent back to Requirements from Code (0.4.7): the spec was approved, so the runner sends the
    // spec writer its work again; it is a revision of the approved spec, with the person's words.
    const toReq = action.kind === "send-work" && r.work.back_to_requirements && !r.work.back_to_requirements.drafted ? r.work.back_to_requirements : null;
    const revise = action.kind === "send-revision" || Boolean(toReq);
    await sent(id, action, stage, revise ? "Sent back to the spec writer with your words." : "Sent to the spec writer.");
    const n = store.read(id).stages[stage].runs;
    const noModel = missingModel();
    if (noModel) return refused(id, action, stage, noModel, { round: { n, at: now(), label: `Round ${n}`, verdict: "Not run", back: false, words: noModel } });
    // The spec as it stands (spec.json and spec.md) and the agent's own files, for the spec writer to revise.
    const prior = toReq ? toReq.spec ?? [] : revise ? (action.prior?.record?.files ?? []).filter((f) => AGENT_FILE.test(f.name) || isSpecName(f.name)) : [];
    const steps = toReq ? [`${toReq.words}${toReq.conflict ? `\n\nThe coding agent said, in records/conflict.md:\n${toReq.conflict}` : ""}`] : action.steps;
    const res = await specWriter({
      dir: dirOf(id), adlc: config.adlc, n, signal, env: agentEnv(),
      text: withFeatures(revise ? `changes: ${steps.join("\n")}\n` : r.work.text ?? asked(r), r, action.phase),
      // A build with an as-built record (existing code, or a record brought): its behaviors, interfaces, architecture as built, and existing tests and gaps go with it, whole.
      attach: [...prior.map((f) => ({ abs: abs(id, f.path), media_type: f.media_type })), ...earlierFiles(r, revise, n), ...recordParts(r)],
    });
    if (signal.aborted) return;
    const round = { n, at: now(), label: `Round ${n}`, verdict: res.ok ? "Ready for your approval" : "Refused", back: false, words: firstWords(res.reply) };
    if (!res.ok) return refused(id, action, stage, res.reply, { round, handed: res.handed ?? [] });
    await change(id, (b, ev) => {
      if (b.status !== "working") return;
      const s = b.stages[stage];
      s.rounds.push(round);
      s.handed_back = { words: [res.reply], files: filesHanded(id, res.handed) };
      s.done_when_met = null;
      // The spec (stages.json 1.6.0), read where spec.mjs finds it, with the agent's own files made from it.
      const spec = readJsonAt(res.spec?.find((f) => f.path === SPEC_JSON)?.abs);
      say(s.log, isSpec(spec) ? "The spec writer handed back the spec, and the agent's own files made from it." : "The spec writer handed back the agent's own files, and no spec.");
      delete b.work.text;
      if (b.work.back_to_requirements) b.work.back_to_requirements.drafted = true;
      // The descriptor says the agent's name and version, else the spec's product does; a name the person gave stays.
      const d = readJsonAt(res.agentFiles.find((f) => f.path === "agent-descriptor.json")?.abs) ?? {};
      const named = words(d.name) || words(spec?.product?.name);
      const versioned = words(d.agent_version) || words(spec?.product?.version);
      if (!b.named && named) b.name = named;
      if (versioned && !b.versioned) b.version = versioned;
      // Each feature of the spec the product does not hold in the same words goes to the person as proposed (0.4.8).
      if (isSpec(spec)) {
        const builds = store.list().filter((x) => x.name === b.name && x.id !== b.id);
        const kept = specProposals([...builds, b], specFeatures(spec), { build: b.id, at: now() });
        if (kept.length) {
          (b.feature_log ??= []).push(...kept);
          say(s.log, `${kept.length} feature${kept.length === 1 ? " of the spec goes" : "s of the spec go"} to you as proposed: ${kept.map((e) => e.feature).join(", ")}. Approve each one, all of them, or approve the spec.`);
        }
      }
      const open = (res.handed ?? []).filter((f) => f.path === "requirements/still-open.md").map((f) => ({ name: "still-open.md", path: f.at, media_type: "text/markdown" }));
      delivered(b, ev, action, res.reply, [...asFiles(id, res.spec ?? []), ...asFiles(id, res.agentFiles), ...open]);
    });
  }

  // ---------- Architecture and Design ----------

  /** A build's architecture record as its Architecture stage handed it back: { abs, at } in its folder, or null. One builder's is shown there once its check passes it. */
  function recordOf(b) {
    const f = (b?.stages?.architecture?.handed_back?.files ?? []).find((x) => x.path === `architecture/${RECORD_PIECE}`);
    return f ? { abs: abs(b.id, f.at), at: f.at } : null;
  }

  /** The statement of the job: the person's own words, as Requirements was asked them. One builder's request.md holds them. */
  const statementText = (r) => `${asked(r).replace(/^Write a spec\.\n/, "").trim()}\n`;

  /**
   * A build whose lifecycle leaves out Architecture and Design: the phase there does
   * not run, and is delivered with no architecture record, so the build goes on.
   */
  async function notUsedStep(r, action, stage) {
    const p = phaseNamed(docOf(r), action.phase);
    const files = holderOf(docOf(r), action.phase) === "spec-writer" ? handed(action).filter((f) => AGENT_FILE.test(f.name)) : [];
    const said = `Not run: this build's lifecycle leaves out ${nameOf(stage)}, so ${files.length ? "the agent's own files go on as the spec was approved with them" : "no architecture record is made"}.`;
    await change(r.id, (b, ev) => {
      if (b.status !== "working") return;
      ev({ type: "holder", phase: action.phase, handle: action.to ?? p?.owner ?? "product-factory", how: "named in the roster" });
      ev({ type: "replied", phase: action.phase, from: "product-factory", handle: "product-factory", text: said, files: files.map((f) => ({ name: f.name, path: f.path, media_type: f.media_type ?? "" })), verdict: "delivered" });
      say(b.log, said);
    });
  }

  /**
   * The original's own tests a revision dropped (test-writer 0.10.0): the
   * files the record it handed back (test/carried-tests.json) names as dropped.
   */
  function droppedTests(id, files) {
    const rec = files.find((f) => f.name === CARRIED_RECORD);
    if (!rec) return [];
    const doc = readJsonAt(abs(id, rec.path));
    return (Array.isArray(doc?.dropped) ? doc.dropped : []).map((d) => words(d?.test)).filter((t) => isTestFile(t));
  }

  async function testWriterStep(r, action, stage, signal) {
    const id = r.id;
    await sent(id, action, stage, "Sent to the test writer with the spec and the agent's files.");
    const n = store.read(id).stages[stage].runs;
    const noModel = missingModel();
    if (noModel) return refused(id, action, stage, noModel, { round: { n, at: now(), label: `Round ${n}`, verdict: "Not run", back: false, words: noModel } });
    // The spec (spec.json) and the agent's own files made from it (stages.json 1.6.0).
    const agentFiles = suiteGiven(id, action);
    // Sent back from Code: the test writer revises the suite as it stands, with the person's words
    // (and the coding agent's, when it stopped on a conflict). The reference test writer reads a
    // message whose first line is "Revise the suite" as a revision, and hands back the files it revised.
    // Sent back to Requirements from Code: the spec was revised and approved, and the test writer
    // revises the suite as it stands against the revised spec (lifecycle API 0.4.7).
    const toReq = r.work.back_to_requirements ?? null;
    const back = r.work.back_to_test ?? (toReq ? { ...toReq, revisedSpec: true } : null);
    const said = back?.revisedSpec
      ? `Revise the suite.\n\nThe spec was revised at Requirements: the build was sent back from Code, and the spec and the agent's files attached are the revised spec, as approved. What was asked to change in the spec:\n${back.words}\n\nRevise the tests the revised spec changes, against the files attached, and leave every other test as it is.\n`
      : back ? `Revise the suite.\n\n${back.words}${back.conflict ? `\n\nThe coding agent said, in records/conflict.md:\n${back.conflict}` : ""}\n`
        : adopting(r) ? "Write characterization tests for the spec and the agent's files attached: the code already exists, and the behaviors, interfaces, architecture as built and existing tests and gaps of its as-built record are attached too.\n"
          : fromRecord(r) ? "Write the suite for the spec and the agent's files attached. The code is written fresh from them: the as-built record of the code kept elsewhere (its behaviors, interfaces, architecture as built and existing tests and gaps) is attached too, so each approved feature is pinned as the record says the code does it.\n"
            : "Write the suite for the spec and the agent's files attached.\n";
    const text = withFeatures(said, r, action.phase);
    // A build with an as-built record: its behaviors, interfaces, architecture as built, and existing tests and gaps go with it, whole.
    // The original's own tests, with the files they import and the carried manifest, go with a first suite; a revision's suite carries their record already.
    const attach = [...(back ? back.suite.map((f) => ({ abs: abs(id, f.path), media_type: f.media_type || "text/javascript" })) : []), ...recordParts(r), ...(back ? [] : carriedParts(r, n))];
    const res = await testWriter({ dir: dirOf(id), adlc: config.adlc, n, agentFiles, env: agentEnv(), signal, text, attach });
    if (signal.aborted) return;
    const round = { n, at: now(), label: `Round ${n}`, verdict: res.ok ? (back ? "Suite revised" : "Suite written") : "Refused", back: false, words: firstWords(res.reply) };
    if (!res.ok) return refused(id, action, stage, res.reply, { round, handed: res.handed ?? [] });
    await change(id, (b, ev) => {
      if (b.status !== "working") return;
      const s = b.stages[stage];
      s.rounds.push(round);
      // A revision hands back the files it revised; the suite goes on whole, each revised file in place of its earlier one.
      const revised = asFiles(id, res.suite);
      // A revision that drops one of the original's own tests, as the person named it, hands back their record with the drop in it: that test leaves the suite.
      const dropped = droppedTests(id, revised);
      const suite = (back ? [...back.suite.filter((f) => !revised.some((x) => x.name === f.name)), ...revised].sort((x, y) => (x.name < y.name ? -1 : 1)) : revised).filter((f) => !dropped.includes(f.name));
      s.handed_back = { words: [res.reply], files: back ? filesHanded(id, suite.map((f) => ({ path: f.name, at: f.path }))) : filesHanded(id, res.handed) };
      s.state = "done";
      const testFiles = res.suite.filter((f) => isTestFile(f.path)).length;
      say(s.log, back ? `The test writer revised ${revised.filter((f) => !dropped.length || f.name !== CARRIED_RECORD).map((f) => f.name).join(", ") || "nothing"}.${dropped.length ? ` It dropped the original test${dropped.length === 1 ? "" : "s"} ${dropped.join(", ")}, as you named ${dropped.length === 1 ? "it" : "them"}.` : ""}` : `The test writer handed back ${testFiles} test file${testFiles === 1 ? "" : "s"}.`);
      if (!b.work.pr) { delete b.work.folder; delete b.work.records; delete b.work.feedback; }
      say(b.log, back ? "The suite is revised." : "The suite is written.");
      delivered(b, ev, action, res.reply, suite);
    });
  }

  // ---------- Code on a pull request ----------

  /** Builds whose pull request is being judged or revised now: id -> the promise. */
  const busy = new Map();
  /** The gate runs going on now, so stopping a build stops its gate too: id -> AbortController. */
  const gates = new Map();
  let pollTimer = null;

  /** The code phase of the build's run, as an action the runner's events can name. */
  function codePhase(b) {
    const doc = docOf(b);
    const pid = Object.keys(b.run.phases).find((x) => stageOf(doc, x) === "code" && holderOf(doc, x) === "code");
    return pid ? { phase: pid, to: b.run.phases[pid].holder?.handle ?? "harness/pull-request" } : null;
  }

  /** A build Product Factory watches for pushes: at Code on a pull request, working or waiting for your OK. */
  const watched = (b) => Boolean(b && b.settings?.code?.holder === "pull-request" && b.at === "code" && b.work?.pr?.number && ["working", "waiting"].includes(b.status) && !b.work.back_to_test && !b.work.back_to_requirements);

  /** Says something about the pull request in Code's log once, until it changes. */
  const noteOnce = (id, words) => store.update(id, (b) => {
    // Code's pull request, or one builder's, which it keeps under work.builder.
    const p = b.work?.pr ?? b.work?.builder?.pr;
    if (!p || p.note === words) return;
    p.note = words;
    const s = b.work?.pr ? b.stages.code : b.stages[b.at];
    if (s) say(s.log, words);
  });

  async function pullRequestStep(r, action, stage, signal) {
    const id = r.id;
    const dir = dirOf(id);
    const pr = r.work.pr;
    await sent(id, action, stage, !pr ? "Sent to a pull request for your coding harness." : r.work.back_to_requirements ? "Sent back to the pull request with the revised spec and suite." : r.work.back_to_test ? "Sent back to the pull request with the revised suite." : `Sent to pull request #${pr.number} again.`);
    const c = connect(r.settings.repository, env);
    if (c.problem) return refused(id, action, stage, c.problem);

    if (!pr) {
      // The hand-off lays out the build folder as in local mode; the folder then goes to the pull request.
      const h = await handOff({ dir, adlc: config.adlc, ...handOffGiven(id, action), env: agentEnv(), signal });
      if (signal.aborted) return;
      if (!h.ok) return refused(id, action, stage, h.reply);
      const read = readBuildFolder(h.folder);
      if (!read.ok) return refused(id, action, stage, read.reason);
      const fresh = store.read(id);
      const agent = slugOf(fresh.name, id.replace(/_/g, "-"));
      const opened = await openPullRequest({ gh: c.gh, repo: c.repo, agent, version: fresh.version, folder: read.folder, now: () => new Date(now()) });
      if (signal.aborted) return;
      if (!opened.ok) return refused(id, action, stage, opened.reason);
      const p = opened.record;
      const loop = fixLoopOn(r.settings);
      await change(id, (b) => {
        if (b.status !== "working") return;
        b.work.folder = rel(dir, h.folder);
        b.work.pr = p;
        // Sent back to Requirements before any pull request: this one is opened from the revised spec and suite, so nothing is left to send.
        delete b.work.back_to_requirements;
        delete b.work.back_to_test;
        const s = b.stages[stage];
        say(s.log, `Opened pull request #${p.number} on ${p.repo}, with the build folder in ${p.folder}/ and AGENTS.md (the hand-off contract): ${p.url}`);
        say(s.log, loop ? `Product Factory runs your coding harness on it in the fix loop, up to ${fixRoundsOf(b.settings)} rounds: each round's scripts go on the branch as one commit, and the gate runs on it.` : "Point your coding harness at the pull request. Every push it makes runs the gate.");
        say(b.log, `Code is on pull request #${p.number}: ${p.url}`);
      });
      return loop ? fixLoop(id, action, stage, c, signal, { restart: true }) : undefined;
    }

    if (r.work.back_to_requirements) {
      await revisedSpecToPullRequest(r, action, stage, c, signal);
      return afterRevision(id, action, stage, c, signal);
    }
    const back = r.work.back_to_test;
    if (!back) return fixLoopOn(r.settings) ? fixLoop(id, action, stage, c, signal) : noteOnce(id, `Waiting for a push to pull request #${pr.number}.`);

    // Sent back to Test: the revised tests go on the same pull request, as one forward commit.
    const suite = handed(action).filter((f) => /^test\/[^/]+$/.test(f.name));
    const tests = [];
    for (const f of suite) {
      const bytes = readFileSync(abs(id, f.path));
      if (pr.digests[f.name] !== digestOf(bytes)) tests.push({ path: f.name, bytes });
    }
    const names = new Set(suite.map((f) => f.name));
    const removed = Object.keys(pr.digests).filter((p) => /^test\/[^/]+$/.test(p) && !names.has(p));
    if (!tests.length && !removed.length) {
      await change(id, (b) => {
        delete b.work.back_to_test;
        say(b.stages[stage].log, `The revised suite is the same as the one on pull request #${pr.number}, so nothing new went to it.${fixLoopOn(b.settings) ? "" : " Waiting for a push."}`);
      });
      return afterRevision(id, action, stage, c, signal);
    }
    const job = revisePullRequest(c.gh, pr, { tests, removed, words: back.words }, (d) => store.update(id, (b) => { if (b.work.pr) b.work.pr.digests = d; }));
    busy.set(id, job.then(() => ({ judged: false }), () => ({ judged: false })));
    let res;
    try { res = await job; } finally { busy.delete(id); }
    if (!res.ok) return refused(id, action, stage, res.reason);
    await change(id, (b) => {
      delete b.work.back_to_test;
      say(b.stages[stage].log, `The revised tests went to pull request #${pr.number} as ${res.sha.slice(0, 7)}: ${[...tests.map((t) => t.path), ...removed.map((p) => `${p} (taken out)`)].join(", ")}. ${fixLoopOn(b.settings) ? "The fix loop starts again from round 1 on them." : "The gate runs on it, and on every push after it."}`);
    });
    return afterRevision(id, action, stage, c, signal);
  }

  /** After Product Factory's own revision went to the branch (Send back to Test or Requirements): with the fix loop on, it starts again from round 1 on the revised spec and suite. */
  function afterRevision(id, action, stage, c, signal) {
    const b = store.read(id);
    if (!fixLoopOn(b.settings) || !b.work.pr || b.work.back_to_test || b.work.back_to_requirements || b.status !== "working" || signal.aborted) return undefined;
    return fixLoop(id, action, stage, c, signal, { restart: true });
  }

  /**
   * Sent back to Requirements from Code (lifecycle API 0.4.7), on a pull
   * request: the revised spec and the suite revised against it go on the same
   * branch as one forward commit. The hand-off lays out the build folder again
   * from them, and every pinned file that differs from what the pull request
   * holds (the agent's files, the tests, AGENTS.md and the rest the hand-off
   * writes) goes on the branch with the new build.lock.json; the coding
   * agent's scripts are left as they are. The fence moves to the new digests.
   */
  async function revisedSpecToPullRequest(r, action, stage, c, signal) {
    const id = r.id;
    const dir = dirOf(id);
    const pr = r.work.pr;
    const toReq = r.work.back_to_requirements;
    const h = await handOff({ dir, adlc: config.adlc, ...handOffGiven(id, action), env: agentEnv(), signal });
    if (signal.aborted) return;
    if (!h.ok) return refused(id, action, stage, h.reply);
    const read = readBuildFolder(h.folder);
    if (!read.ok) return refused(id, action, stage, read.reason);
    const { files: built, digests, scripts } = read.folder;
    const changed = Object.entries(digests).filter(([p, d]) => pr.digests[p] !== d).map(([p]) => ({ path: p, bytes: built.get(p) }));
    const removed = Object.keys(pr.digests).filter((p) => !(p in digests));
    if (!changed.length && !removed.length) {
      return change(id, (b) => {
        delete b.work.back_to_requirements;
        b.work.folder = rel(dir, h.folder);
        say(b.stages[stage].log, `The revised spec and suite are the same as the ones on pull request #${pr.number}, so nothing new went to it.${fixLoopOn(b.settings) ? "" : " Waiting for a push."}`);
      });
    }
    let lock;
    try { lock = JSON.parse(built.get(LOCK_FILE).toString("utf8")); } catch { return refused(id, action, stage, `The build folder's ${LOCK_FILE} could not be read.`); }
    const job = revisePullRequest(c.gh, pr, { tests: changed, removed, words: toReq.words, lock, spec: true }, (d) => store.update(id, (b) => { if (b.work.pr) b.work.pr.digests = d; }));
    busy.set(id, job.then(() => ({ judged: false }), () => ({ judged: false })));
    let res;
    try { res = await job; } finally { busy.delete(id); }
    if (!res.ok) return refused(id, action, stage, res.reason);
    return change(id, (b) => {
      delete b.work.back_to_requirements;
      b.work.folder = rel(dir, h.folder);
      if (b.work.pr) b.work.pr.scripts = scripts;
      say(b.stages[stage].log, `The revised spec and suite went to pull request #${pr.number} as ${res.sha.slice(0, 7)}: ${[...changed.map((t) => t.path), ...removed.map((p) => `${p} (taken out)`)].join(", ")}. ${fixLoopOn(b.settings) ? "The fix loop starts again from round 1 on them." : "The gate runs on it, and on every push after it."}`);
    });
  }

  /** The reviewers the lifecycle uses, where their holders can run, on files the suite passed. */
  async function reviews(r, pr, sha, judged, tested, base, signal, { oneBuilder = false } = {}) {
    const asks = {};
    const skipped = [];
    const { missing } = modelEnv(config, env);
    let pkg = null;
    for (const rv of REVIEWERS) {
      if (r.lifecycle.used?.[rv.stage]?.used === false) continue;
      const bound = r.lifecycle.holders?.[rv.role];
      const why = bound && bound.kind !== "reference_agent"
        ? `the lifecycle has ${bound.name} hold the ${roleById.get(rv.role)?.name ?? rv.role} role, and Product Factory cannot send work to it yet.`
        : reviewerMissing(config.adlc, rv.agent, rv.script) ?? (missing.length ? `the model is not set (${missing.join(", ")}).` : null);
      if (why) { skipped.push({ id: rv.id, why }); continue; }
      const dir = join(base, "review");
      mkdirSync(dir, { recursive: true });
      if (!pkg) {
        pkg = join(dir, `${pr.agent}-${pr.version}-${sha.slice(0, 7)}.tar.gz`);
        writeFileSync(pkg, writeTarGz([...packageFiles(judged)].map(([path, bytes]) => ({ path, bytes }))));
      }
      const files = [{ abs: pkg, media_type: "application/gzip" }];
      // The security reviewer reads the package against the architecture record, beside it as the record's own file.
      const record = rv.id === "security" ? recordOf(r) : null;
      if (record) files.push({ abs: record.abs, media_type: "text/markdown" });
      if (rv.id === "critic") {
        const d = changeDiff(pr, judged);
        if (d) { writeFileSync(join(dir, "change.diff"), d); files.push({ abs: join(dir, "change.diff"), media_type: "text/x-diff" }); }
      }
      const text = reviewText(rv.id, pr, sha, r.settings.review?.spending_limit ?? SPENDING_LIMIT_DEFAULT);
      const got = await reviewer({ adlc: config.adlc, agent: rv.agent, script: rv.script, base: join(dir, rv.id), text, files, env: agentEnv(), signal, minutes: r.settings.code.minutes });
      if (signal.aborted) break;
      asks[rv.id] = judgeRun(rv.id, got);
    }
    // Each reviewer's own verdict is kept on the gate run too, so Review and Security review can say what it was (view.mjs).
    return { ...finalVerdict({ tested, asks, skipped, oneBuilder }), reviews: asks, skipped };
  }

  /**
   * The gate on one new commit of the pull request, its word on the pull request, and a pass delivered.
   * fix: the fix round the commit is from ({ label, words, record }), kept as that round on Code.
   */
  async function gatePush(id, sha, c, { fix = null } = {}) {
    const ctl = new AbortController();
    gates.set(id, ctl);
    const signal = ctl.signal;
    try {
      await store.update(id, (b) => {
        const p = b.work.pr;
        p.head = sha; p.judging = sha; p.note = null;
        say(b.stages.code.log, fix ? `${fix.label}: the gate runs on ${sha.slice(0, 7)}.` : `A push came to pull request #${p.number}: ${sha.slice(0, 7)}. The gate runs on it.`);
      });
      const r = store.read(id);
      const pr = r.work.pr;
      const pend = await postResult(c.gh, pr, sha, null, { pending: true, statuses: !pr.status_refused });
      const base = join(dirOf(id), "stages", "code", "pr", sha.slice(0, 12));
      const folder = join(base, "build");
      let verdict;
      try {
        const read = await readCommitFiles(c.gh, pr.repo, sha);
        verdict = read.ok
          ? await judgeFolder(pr, read.files, {
            runSuite: (judged) => runGateSuite({ folder, files: judged, scripts: pr.scripts, seconds: r.settings.code.minutes * 60, env: sealedEnv(r), signal }),
            review: (judged, tested) => reviews(r, pr, sha, judged, tested, base, signal),
          })
          : { passed: false, title: "The files could not be read", summary: read.reason, items: [] };
      } catch (e) {
        verdict = { passed: false, title: "The gate failed", summary: `The gate could not finish: ${e.message}`, items: [] };
      }
      if (signal.aborted) {
        // Stopped mid-run: the commit is judged again the next time Product Factory checks.
        await store.update(id, (b) => { const p = b.work.pr; if (p?.judging === sha) { p.judging = null; p.head = p.runs.at(-1)?.sha ?? p.issued_sha; } });
        return { judged: false };
      }
      // The suite's results per feature: each test names its feature ("[F3] ..."), so the gate reports each one.
      const ran = Boolean(verdict.judged) && verdict.title !== "The test run did not finish";
      const failing = ran ? (verdict.title === "The tests did not pass" ? (verdict.items ?? []).filter((x) => !/^nothing tests /.test(x)) : []) : [];
      const perFeature = ran ? byFeature(suiteNames(folder), failing) : [];
      if (perFeature.length) verdict = { ...verdict, summary: `${verdict.summary}\n\n${byFeatureWords(perFeature)}` };
      const posted = await postResult(c.gh, pr, sha, verdict, { statuses: !pr.status_refused && pend.status !== "refused" });
      const scripts = verdict.judged && existsSync(join(folder, "scripts")) ? scriptsHanded(dirOf(id), folder) : [];
      let deliveredNow = false;
      await change(id, (b, ev) => {
        const p = b.work.pr;
        if (!p) return;
        p.judging = null;
        if (pend.status === "refused" && !p.status_refused) {
          p.status_refused = true;
          say(b.stages.code.log, "The token may not post commit statuses on the repository, so the gate's word goes on the pull request as a comment only.");
        }
        p.runs.push({ sha, at: now(), passed: verdict.passed, title: verdict.title, summary: verdict.summary, items: verdict.items ?? [], ...(verdict.conflict ? { conflict: verdict.conflict } : {}), ...(verdict.reviews && Object.keys(verdict.reviews).length ? { reviews: verdict.reviews } : {}), ...(verdict.skipped?.length ? { skipped: verdict.skipped } : {}) });
        const s = b.stages.code;
        const n = s.rounds.length + 1;
        const round = { n, at: now(), label: `Push ${sha.slice(0, 7)}`, verdict: verdict.title, back: !verdict.passed, words: firstWords(verdict.summary, 800), ...(perFeature.length ? { failing, by_feature: perFeature } : {}) };
        s.rounds.push(fix ? { ...round, label: fix.label, words: firstWords(`${fix.words} The gate on ${sha.slice(0, 7)}: ${verdict.title}. ${verdict.summary}`, 1200), fix: { ...fix.record, commit: fix.record.commit ?? sha, gate: verdict.title, passed: verdict.passed } } : round);
        if (scripts.length) s.handed_back = { words: [`${verdict.title} (${sha.slice(0, 7)}).`], files: filesHanded(id, scripts) };
        say(s.log, `The gate on ${sha.slice(0, 7)}: ${verdict.title}.${posted.commented ? " It said so on the pull request." : " Its comment could not be posted on the pull request."}`);
        // Sent back to Test while the gate ran: the run is kept, and nothing moves.
        if (b.work.back_to_test || b.work.back_to_requirements || b.at !== "code" || !["working", "waiting"].includes(b.status)) return;
        if (verdict.passed) {
          const a = codePhase(b);
          if (!a) return;
          p.passed = sha;
          s.done_when_met = true;
          s.state = "working";
          b.status = "working";
          say(b.log, `The gate passed ${sha.slice(0, 7)} on pull request #${p.number}.`);
          delivered(b, ev, a, verdict.summary, scripts.map((f) => ({ name: f.path.replace(/^code\//, ""), path: f.at, media_type: "text/javascript" })));
          deliveredNow = true;
        } else {
          p.passed = null;
          s.done_when_met = false;
          if (b.status === "waiting") {
            b.status = "working";
            s.state = "working";
            say(b.log, `A newer commit on pull request #${p.number}, ${sha.slice(0, 7)}, did not pass the gate, so your OK waits for one that does.`);
          }
        }
      });
      if (deliveredNow) advance(id);
      return { judged: true, passed: verdict.passed, title: verdict.title, delivered: deliveredNow, run: store.read(id).work.pr?.runs?.at(-1) ?? null };
    } finally {
      gates.delete(id);
    }
  }

  /**
   * Checks one build's pull request for a new push, and runs the gate on it.
   * Resolves to { judged, passed?, title? }. A build already being judged is not checked twice.
   */
  function poll(id) {
    if (busy.has(id)) return busy.get(id);
    const job = (async () => {
      const r = store.read(id);
      // One builder on a pull request: the folder's own check runs on each push (builderPush).
      if (builderWatched(r)) {
        const cb = connect(r.settings.repository, env);
        if (cb.problem) { await noteOnce(id, cb.problem); return { judged: false }; }
        return builderPush(id, cb);
      }
      if (!watched(r)) return { judged: false };
      const c = connect(r.settings.repository, env);
      if (c.problem) { await noteOnce(id, c.problem); return { judged: false }; }
      const head = await pullRequestHead(c.gh, store.read(id).work.pr);
      if (!head.ok) { await noteOnce(id, `Pull request #${r.work.pr.number} could not be checked: ${head.reason}`); return { judged: false }; }
      if (!head.open && !head.merged) { await noteOnce(id, `Pull request #${r.work.pr.number} was closed without merging. Reopen it to go on.`); return { judged: false }; }
      if (head.sha === r.work.pr.head) return { judged: false };
      return gatePush(id, head.sha, c);
    })().catch(async (e) => { await noteOnce(id, `Checking the pull request went wrong in Product Factory: ${e.message}`).catch(() => {}); return { judged: false }; })
      .finally(() => busy.delete(id));
    busy.set(id, job);
    return job;
  }

  /** Every watched build, checked once. */
  async function pollAll() {
    for (const r of store.list()) if (watched(r) || builderWatched(r)) await poll(r.id);
  }

  // ---------- the fix loop: Code on a pull request, with code.harness set (fix-loop.mjs) ----------

  /** The fix loops going on now, so Send back to Test or Requirements ends the round in hand: id -> AbortController. */
  const fixes = new Map();

  /**
   * Runs fix rounds on the build's pull request until the gate passes, the
   * loop stops on a conflict or a security refusal, or the rounds
   * (code.fix_rounds) are used up; the last two refuse Code with words. While
   * it runs, poll() leaves the pull request alone (busy): the loop gates its
   * own commits. restart: the loop starts again from round 1 (a new pull
   * request, or Product Factory's own revision on it); otherwise its rounds
   * go on from the last one, with the last gate run's findings.
   */
  async function fixLoop(id, action, stage, c, signal, { restart = false } = {}) {
    if (busy.has(id)) await busy.get(id);
    const ctl = new AbortController();
    fixes.set(id, ctl);
    await store.update(id, (b) => { const p = b.work.pr; p.fix = { round: restart ? 0 : p.fix?.round ?? 0, running: true, stopped: null }; });
    const job = fixRounds(id, action, stage, c, signal, AbortSignal.any([signal, ctl.signal]));
    busy.set(id, job.then(() => ({ judged: false }), () => ({ judged: false })));
    try { return await job; } finally {
      busy.delete(id);
      fixes.delete(id);
      await store.update(id, (b) => { if (b.work?.pr?.fix) b.work.pr.fix.running = false; }).catch(() => {});
    }
  }

  /** Whether the loop is to end now: stopped, sent back, or no longer at Code on the pull request. */
  const loopOver = (b, signal) => signal.aborted || !b || b.status !== "working" || b.at !== "code" || !b.work?.pr || Boolean(b.work.back_to_test || b.work.back_to_requirements);

  /** A fix round that did not reach the gate, kept as a round of Code. */
  const keepRound = (id, k, verdict, words, record) => store.update(id, (b) => {
    const s = b.stages.code;
    s.rounds.push({ n: s.rounds.length + 1, at: now(), label: `Fix round ${k}`, verdict, back: true, words: firstWords(words, 1200), fix: { ...record, gate: null, passed: false } });
    say(s.log, `Fix round ${k}: ${verdict}.`);
  });

  /** The loop ends on the person: Code is refused in words, and why it stopped decides what is offered (view.mjs actionsOf). */
  async function loopStops(id, action, stage, why, words) {
    await store.update(id, (b) => { if (b.work.pr?.fix) b.work.pr.fix.stopped = why; });
    return refused(id, action, stage, words);
  }

  /** The round in hand ended without a verdict: you stopped the build, or sent it back. */
  async function roundEnded(id, k, record, signal) {
    const b = store.read(id);
    const stopped = signal.aborted || b?.status === "stopped";
    const what = stopped ? "You stopped the build" : b?.work?.back_to_requirements ? "You sent the build back to Requirements" : b?.work?.back_to_test ? "You sent the build back to Test" : "The round ended";
    const left = record.commit ? `its commit ${record.commit.slice(0, 7)} is on the branch, and the gate did not finish on it.` : "nothing of it was committed.";
    await keepRound(id, k, stopped ? "Stopped" : "Ended", `${what} while fix round ${k} was running, so ${left}`, record);
  }

  async function fixRounds(id, action, stage, c, signal, sig) {
    const start = store.read(id);
    const budget = fixRoundsOf(start.settings);
    const code = start.settings.code;
    // The harness never holds a credential: no repository token, no model key, nothing in code.env_remove.
    const harnessEnv = sealedEnv(start);
    for (let used = 0; used < budget; used++) {
      const b = store.read(id);
      if (loopOver(b, sig)) return undefined;
      const pr = b.work.pr;
      const k = (pr.fix?.round ?? 0) + 1;
      const base = join(dirOf(id), "stages", "code", "fix", String(b.stages[stage].rounds.length + 1));
      const folder = join(base, "build");
      // 1. The round's folder: the build folder as the branch's newest commit has it, every pinned file as approved.
      const read = await readBranchFolder(c.gh, pr);
      if (loopOver(store.read(id), sig)) return undefined;
      if (!read.ok) return loopStops(id, action, stage, "pull-request", `Fix round ${k} could not read pull request #${pr.number}: ${read.reason}`);
      const { files, restored } = roundFiles(read.files, pr.digests, b.work.folder ? abs(id, b.work.folder) : null);
      writeFolder(folder, files);
      const before = snapshotOf(folder);
      // 2. The harness, with the round's prompt: from the second round on, the last gate run's findings word for word.
      const last = k > 1 ? pr.runs.at(-1) ?? null : null;
      const prompt = fixPrompt({ round: k, last });
      writeFileSync(join(base, "prompt.txt"), prompt);
      const findingsFile = last ? join(base, "findings.md") : null;
      if (last) writeFileSync(findingsFile, `${findingsText(last)}\n`);
      await store.update(id, (x) => {
        x.work.pr.fix.round = k;
        say(x.stages.code.log, `Fix round ${k}: your coding harness works on ${read.sha.slice(0, 7)}${last ? `, with the gate's findings on ${last.sha.slice(0, 7)}` : ""}.${restored.length ? ` The branch's ${pathWords(restored)} differed from what was approved, so the round's folder has the approved files.` : ""}`);
      });
      const h = await fixHarness({ base, folder, harness: code.harness, prompt, round: k, findingsFile, minutes: code.minutes, env: harnessEnv, signal: sig });
      const record = { round: k, from: read.sha, sent: firstWords(prompt, 4000), took_ms: h.ms, harness: h.said, files: [], left_out: [], commit: null };
      if (h.stopped || loopOver(store.read(id), sig)) return roundEnded(id, k, record, signal);
      if (h.error) {
        await keepRound(id, k, "Your coding harness could not run", `Your coding harness could not run: ${h.error}.`, record);
        return loopStops(id, action, stage, "harness", `Fix round ${k}: your coding harness could not run: ${h.error}. Set "code.harness" in product-factory.json to a command that runs, then give it more rounds.`);
      }
      // 3. What it changed under scripts/ (and records/conflict.md) goes on the branch as one commit; nothing else does.
      const ch = changesOf(before, folder);
      record.files = [...ch.files.map((f) => f.path), ...ch.removed.map((p) => `${p} (removed)`)];
      record.left_out = ch.leftOut;
      const ran = h.timedOut ? `It ran past ${code.minutes} minute${code.minutes === 1 ? "" : "s"} and was stopped` : `It took ${tookWords(h.ms)}${h.code ? ` and ended with code ${h.code}` : ""}`;
      const said = `Sent your coding harness the round's prompt${last ? `, with the gate's findings on ${last.sha.slice(0, 7)}` : ""}. ${ran}${h.said ? `, and said: ${firstWords(h.said, 300)}` : "."}`;
      const leftOut = ch.leftOut.length ? ` Not committed, as a fix round commits only scripts/ and records/conflict.md: ${pathWords(ch.leftOut)}.` : "";
      let sha = read.sha;
      if (ch.files.length || ch.removed.length) {
        const made = await commitFixRound(c.gh, pr, { files: ch.files, removed: ch.removed, message: `Fix round ${k}: ${last?.title ?? "Write the scripts"}`, parent: read.sha });
        if (loopOver(store.read(id), sig)) return roundEnded(id, k, { ...record, commit: made.ok ? made.sha : null }, signal);
        if (!made.ok && made.moved) { await keepRound(id, k, "The branch moved", `${said}${leftOut} ${made.reason}`, record); continue; }
        if (!made.ok) {
          await keepRound(id, k, "Not committed", `${said}${leftOut} ${made.reason}`, record);
          return loopStops(id, action, stage, "pull-request", `Fix round ${k}: what your coding harness wrote could not be committed to pull request #${pr.number}: ${made.reason}`);
        }
        sha = made.sha;
        record.commit = sha;
      } else if (pr.runs.some((x) => x.sha === read.sha)) {
        // Nothing changed, and the gate already judged this commit: the round is used, and its findings stand.
        await keepRound(id, k, "Nothing changed", `${said}${leftOut} It changed nothing under scripts/, so nothing was committed, and the gate's word on ${read.sha.slice(0, 7)} stands.`, record);
        continue;
      }
      const committed = record.commit ? ` Committed ${sha.slice(0, 7)} to pull request #${pr.number}: ${pathWords(record.files)}.` : ` It changed nothing under scripts/, so nothing was committed; the gate runs on ${sha.slice(0, 7)}, which it had not judged.`;
      // 4. The gate on that commit, as on any push.
      const g = await gatePush(id, sha, c, { fix: { label: `Fix round ${k}`, words: `${said}${committed}${leftOut}`, record } });
      if (!g.judged) return roundEnded(id, k, record, signal);
      // A pass is delivered (gatePush) and waits for your OK; a build sent back while the gate ran moves on from there.
      if (g.passed || loopOver(store.read(id), sig)) return undefined;
      const run = g.run ?? {};
      const why = stopOf(run);
      if (why === "conflict") {
        return loopStops(id, action, stage, "conflict", `Fix round ${k}: your coding harness stopped on a conflict, so the fix loop stopped. ${run.summary} Send back to Test if the test is wrong, or Send back to Requirements if the spec is.`);
      }
      if (why === "security") {
        return loopStops(id, action, stage, "security", `Fix round ${k}: the security reviewer refused the scripts at ${sha.slice(0, 7)}, so the fix loop stopped. What it refused may be something only the spec can settle, such as an address, a system or a limit the spec does not declare: if so, Send back to Requirements with what should change in the spec. If the scripts are what is wrong, give it more rounds.\n\n${run.title}\n\n${run.summary}`);
      }
    }
    const b = store.read(id);
    if (loopOver(b, sig)) return undefined;
    const last = b.work.pr.runs.at(-1);
    const n = budget;
    return loopStops(id, action, stage, "rounds", `The gate still does not pass after ${n} fix round${n === 1 ? "" : "s"}.${last ? ` What the last gate run on ${last.sha.slice(0, 7)} said:\n\n${findingsText(last)}` : ""}\n\nGive it more rounds, send the build back to Test or to Requirements, or stop it.`);
  }

  /** The scripts of the build folder Code had before the build went back to Requirements, read now: [{ path, bytes }]. Empty otherwise. */
  function keptScripts(r) {
    const from = r.work.back_to_requirements?.folder;
    if (!from) return [];
    const base = join(abs(r.id, from), "scripts");
    const out = [];
    const walk = (d) => {
      let names = [];
      try { names = readdirSync(d); } catch { return; }
      for (const name of names.sort()) {
        const at = join(d, name);
        const st = statSync(at);
        if (st.isDirectory()) walk(at);
        else if (st.isFile()) out.push({ path: `scripts/${rel(base, at)}`, bytes: readFileSync(at) });
      }
    };
    walk(base);
    return out;
  }

  async function codeStep(r, action, stage, signal) {
    if (adopting(r)) {
      // Adopting takes the code at its commit again, from the revised spec and suite.
      if (r.work.back_to_requirements) await store.update(r.id, (b) => { delete b.work.back_to_requirements; });
      return adoptStep(r, action, stage, signal);
    }
    if (r.settings.code.holder === "pull-request") return pullRequestStep(r, action, stage, signal);
    const id = r.id;
    const dir = dirOf(id);
    const mode = r.settings.code.holder;
    await sent(id, action, stage, mode === "code-writer" ? "Sent to the reference code writer." : "Sent to your coding harness.");
    if (!r.settings.code.harness) {
      return refused(id, action, stage, "No coding harness is set. Name the command in product-factory.json under code.harness, such as [\"claude\", \"-p\", \"{prompt}\"] or [\"codex\", \"exec\", \"{prompt}\"], then run it again.");
    }
    let { folder, records } = store.read(id).work;
    if (!folder) {
      // Sent back to Requirements from Code: the scripts written so far go on in the new folder, over its stubs, so Code carries on from them.
      const kept = keptScripts(r);
      const h = await handOff({ dir, adlc: config.adlc, ...handOffGiven(id, action), env: agentEnv(), signal });
      if (signal.aborted) return;
      if (!h.ok) return refused(id, action, stage, h.reply);
      folder = h.folder;
      if (mode === "code-writer") {
        const w = await codeWriterWorkspace({ dir, adlc: config.adlc, archive: h.archive, env: agentEnv(), signal });
        if (signal.aborted) return;
        if (!w.ok) return refused(id, action, stage, w.reply);
        folder = w.folder;
        records = w.records;
      }
      for (const k of kept) {
        const to = join(folder, ...k.path.split("/"));
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, k.bytes);
      }
      await store.update(id, (b) => {
        b.work.folder = rel(dir, folder);
        if (records) b.work.records = rel(dir, records);
        say(b.stages[stage].log, `The build folder is laid out at ${folder}, with AGENTS.md.`);
        if (kept.length) say(b.stages[stage].log, `The scripts written before the build went back to Requirements are in it, over the stubs: ${kept.map((k) => k.path).join(", ")}.`);
        delete b.work.back_to_requirements;
      });
    } else {
      folder = abs(id, folder);
      if (records) records = abs(id, records);
    }
    let feedback = r.work.feedback ? abs(id, r.work.feedback) : null;
    const limit = r.settings.code.rounds;
    for (let k = 1; k <= limit; k++) {
      const n =store.read(id).stages[stage].rounds.length + 1;
      const res = await codeRound({ dir, adlc: config.adlc, mode, folder, records, harness: r.settings.code.harness, round: n, feedbackFile: feedback, minutes: r.settings.code.minutes, env: agentEnv(), envRemove: r.settings.code.env_remove ?? config.code.env_remove, signal });
      if (signal.aborted || res.stopped) return;
      const verdict = res.pass ? "The suite passes" : res.code === 3 ? "A pinned file changed" : res.code === 4 ? "The check's rounds are used up" : "The suite fails";
      // The suite's results per feature, when it ran (a pass, or tests that failed): each test names its feature ("[F3] ...").
      const ran = res.pass || res.code === 1;
      const failing = ran ? (res.pass ? [] : res.items) : [];
      const perFeature = ran ? byFeature(suiteNames(folder), failing) : [];
      const roundWords = [res.words, ...(res.items.length ? [`Failing: ${res.items.join("; ")}`] : []), byFeatureWords(perFeature)].filter(Boolean).join(" ");
      const outcome = await change(id, (b, ev) => {
        if (b.status !== "working") return "gone";
        const s = b.stages[stage];
        const scripts = scriptsHanded(dir, folder);
        s.rounds.push({ n, at: now(), label: `Round ${n}`, verdict, back: !res.pass, words: firstWords(roundWords, 800), ...(perFeature.length ? { failing, by_feature: perFeature } : {}) });
        s.handed_back = { words: [res.words], files: filesHanded(id, scripts) };
        b.work.feedback = res.checkFile ? rel(dir, res.checkFile) : b.work.feedback;
        say(s.log, `Round ${n}: ${verdict.toLowerCase()}.`);
        if (!res.pass) return "again";
        s.done_when_met = true;
        delete b.work.feedback;
        say(b.log, "The suite passes.");
        delivered(b, ev, action, res.words, scripts.map((f) => ({ name: f.path.replace(/^code\//, ""), path: f.at, media_type: "text/javascript" })));
        return "passed";
      });
      if (outcome !== "again") return;
      feedback = res.checkFile ?? feedback;
      if (res.code === 4) break;
    }
    const s = store.read(id).stages[stage];
    return refused(id, action, stage, `The suite still does not pass after ${s.rounds.length} round${s.rounds.length === 1 ? "" : "s"}. Give it more rounds, or stop the build. What the last check said is the last round's words.`);
  }

  // ---------- One builder (make-a-new-agent-one-builder.txt, builder.mjs) ----------

  const builderFolder = (id) => join(dirOf(id), "build");

  /** The approved spec handed to build-the-agent: the spec-v1 among the handoff's files. */
  function handedSpec(id, action) {
    for (const f of handed(action)) {
      if (!/\.json$/.test(f.name)) continue;
      const doc = readJsonAt(abs(id, f.path));
      if (isSpec(doc)) return doc;
    }
    return null;
  }

  /**
   * The stages one builder holds, as the build folder's check has passed them: a stage of
   * stages.json is done when every check stage shown at it has passed (Architecture: the
   * architecture and the agent's own files), and the build is at the stage of the check's
   * current one. Called inside change.
   */
  function syncBuilderStages(b, folder, check) {
    const passed = new Set(passedStages(folder, check));
    const at = check?.stage ? STAGE_OF_CHECK[check.stage] : null;
    for (const s of BUILDER_STAGES) {
      const st = b.stages[s];
      if (!st) continue;
      const own = Object.entries(STAGE_OF_CHECK).filter(([, v]) => v === s).map(([k]) => k);
      if (own.every((k) => passed.has(k))) { st.state = "done"; st.done_when_met = true; }
      else if (s === at) st.state = "working";
      // A stage after the one the build is at has not started: it may have been working, or done, before a send back.
      else if (st.state === "done" || (at && BUILDER_STAGES.indexOf(s) > BUILDER_STAGES.indexOf(at))) { st.state = "not_started"; st.done_when_met = null; }
    }
    if (at && BUILDER_STAGES.includes(at)) b.at = at;
  }

  /** What build-the-agent hands on to make-the-package: every file of the folder the package is made from, and the record of each stage. */
  function builderDelivery(id, folder) {
    const dir = dirOf(id);
    const keep = (p) => /^(agent-descriptor\.json|agent-runtime-requirements\.json|plugin\.json|mcp\.json|spec\.json|architecture-record\.md|build\.lock\.json)$/.test(p) || /^skills\/[^/]+\/SKILL\.md$/.test(p) || /^scripts\//.test(p) || /^test\//.test(p);
    const out = [];
    const walk = (at, base) => {
      for (const e of readdirSync(at, { withFileTypes: true })) {
        const full = join(at, e.name);
        const p = relative(base, full).split(sep).join("/");
        if (e.isDirectory()) { if (![".adlc", "records", "node_modules", ".git"].includes(e.name)) walk(full, base); }
        else if (keep(p)) out.push({ name: p, path: rel(dir, full), media_type: /\.json$/.test(p) ? "application/json" : /\.md$/.test(p) ? "text/markdown" : "text/javascript" });
      }
    };
    walk(folder, folder);
    return out.sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  /**
   * The builder's files, shown at the stage whose gates passed them, under the names the
   * console's artifacts read, as the separate holders hand theirs back: the architecture
   * record (architecture/) and the agent's own files (design/) at Architecture and Design,
   * the suite (test/) at Test, and the scripts with everything else (code/) at Code.
   * A stage whose gates have not passed keeps what it showed. Called inside change.
   */
  function showBuilderFiles(b, id, folder, check) {
    const passed = new Set(passedStages(folder, check));
    const all = builderDelivery(id, folder);
    const agentFile = (p) => /^(agent-descriptor\.json|agent-runtime-requirements\.json|plugin\.json|mcp\.json)$/.test(p) || /^skills\/[^/]+\/SKILL\.md$/.test(p);
    const show = (s, words, picked) => {
      if (!b.stages[s] || !picked.length) return;
      b.stages[s].handed_back = { words: [words], files: filesHanded(id, picked) };
    };
    if (passed.has("architecture") && passed.has("files")) {
      show("architecture", "The architecture record and the agent's own files, passed by the build folder's check.", [
        ...all.filter((f) => f.name === "architecture-record.md").map((f) => ({ path: `architecture/${f.name}`, at: f.path })),
        ...all.filter((f) => agentFile(f.name)).map((f) => ({ path: `design/${f.name}`, at: f.path })),
      ]);
    }
    if (passed.has("test")) show("test", "The suite, passed by the build folder's check.", all.filter((f) => /^test\//.test(f.name)).map((f) => ({ path: f.name, at: f.path })));
    if (passed.has("code")) show("code", "The build passed the build folder's check: every gate.", all.map((f) => ({ path: `code/${f.name}`, at: f.path })));
  }

  /** The builder's phase, as the console's actions and the pull request's pushes deliver to it. */
  function builderAction(b) {
    const doc = docOf(b);
    const pid = Object.keys(b.run.phases).find((x) => holderOf(doc, x) === "builder");
    return pid ? { phase: pid, to: b.run.phases[pid].holder?.handle ?? "harness" } : null;
  }

  /** One builder on a pull request (code.where "pull-request"): your own coding assistant works the folder, and this machine runs none. */
  const onPullRequest = (s) => s?.code?.holder === "builder" && s?.code?.where === "pull-request";

  /** A build Product Factory watches for pushes to its builder's pull request: working at a stage the builder holds. */
  // Followed while the builder works and while the build waits on the person: the builder
  // pushes while a question is asked (the record written again with the answer, the next
  // stage started), and a push the folder's check judges must reach the console then too.
  const builderWatched = (b) => Boolean(b && onPullRequest(b.settings) && b.work?.builder?.pr?.number && (BUILDER_STAGES.includes(b.at) || (b.at === "requirements" && builderWritesSpec(b))) && ["working", "waiting"].includes(b.status));

  /**
   * The spec the person approved, into the folder, and their approval pressed there: when the
   * folder is new, and when it was sent back to Requirements and the spec revised.
   * Resolves to true, or false when it refused the phase.
   */
  async function prepareFolder(r, action, stage, signal, folder) {
    const id = r.id;
    const dir = dirOf(id);
    if (passedStages(folder).includes("requirements")) return true;
    // The builder wrote the spec in the folder: the person approves that spec, as they read it in the console.
    if (builderWritesSpec(r) && existsSync(join(folder, ".adlc")) && existsSync(join(folder, SPEC_JSON))) {
      const read = handedSpec(id, action);
      const there = readJsonAt(join(folder, SPEC_JSON));
      // A spec that changed after the one you approved is never approved for you; the build goes
      // back to Requirements, where the spec as it stands is handed to you and Approve works again.
      // (Approve reads the branch first, so this is the rare race, or a build from before that.)
      if (read && JSON.stringify(read) !== JSON.stringify(there)) { await specChangedUnderYou(id); return false; }
      const a = await approveSpec(folder, { env: agentEnv(), signal });
      if (signal.aborted) return false;
      if (!a.ok) { await refused(id, action, stage, `You approved the spec, and the build folder's own Requirements check holds it: ${a.reply} Send the build back to Requirements with what should change.`); return false; }
      await store.update(id, (b) => {
        b.work.folder = rel(dir, folder);
        b.work.builder = { ...b.work.builder, spec: rel(dir, join(folder, SPEC_JSON)) };
        say(b.stages[stage].log, "Your approval of the builder's spec is pinned in the build folder.");
      });
      return true;
    }
    const spec = handedSpec(id, action) ?? (r.work.builder?.spec ? readJsonAt(abs(id, r.work.builder.spec)) : null);
    if (!spec) { await refused(id, action, stage, "build-the-agent was handed no spec (spec.json, spec-v1), so there is nothing to build from. Send the build back to Requirements."); return false; }
    const l = await layOut({ folder, adlc: config.adlc, request: statementText(r), spec, answers: { ...(words(spec.product?.name) ? { name: words(spec.product.name) } : {}), ...(words(spec.price) ? { price: words(spec.price) } : {}) }, env: agentEnv(), signal });
    if (signal.aborted) return false;
    if (!l.ok) { await refused(id, action, stage, l.reply); return false; }
    const a = await approveSpec(folder, { env: agentEnv(), signal });
    if (signal.aborted) return false;
    if (!a.ok) { await refused(id, action, stage, `You approved the spec, and the build folder's own Requirements check holds it, so the build cannot start from it. ${a.reply} Send the build back to Requirements with what should change.`); return false; }
    await store.update(id, (b) => {
      b.work.folder = rel(dir, folder);
      b.work.builder = { ...b.work.builder, spec: rel(dir, join(folder, "spec.json")) };
      say(b.stages[stage].log, `The build folder is laid out at ${folder} with the ADLC plugin's kit, and your approval of the spec is pinned there.`);
    });
    return true;
  }

  /**
   * What the folder's check said, applied to the build: each stage as the check passed it,
   * delivered when the build passed, waiting on the person for what only they can answer,
   * or "again". sha: the pull request's commit the check ran on, when the builder is on one.
   * Resolves to "passed", "asked", "again" or "gone".
   */
  function builderOutcome(id, action, stage, folder, check, { sha = null } = {}) {
    return change(id, (b, ev) => {
      // A build waiting on the person's answers to the folder's questions still takes the
      // builder's pushes: the answer makes the builder go on, and its next push is judged here.
      const answering = b.status === "waiting" && (b.work.builder?.questions ?? []).length > 0;
      if (b.status !== "working" && !answering) return "gone";
      if (answering) { b.status = "working"; b.work.builder.questions = []; }
      syncBuilderStages(b, folder, check);
      showBuilderFiles(b, id, folder, check);
      b.work.builder = { ...b.work.builder, resumed: false, check: { stage: check.stage, code: check.code, problems: check.problems.slice(0, 40), said: check.said, ...(sha ? { sha } : {}) } };
      if (sha && b.work.builder.pr) b.work.builder.pr = { ...b.work.builder.pr, head: sha };
      if (check.done) {
        for (const s of BUILDER_STAGES) if (b.stages[s]) { b.stages[s].state = "done"; b.stages[s].done_when_met = true; }
        const files = builderDelivery(id, folder);
        const at = b.stages.code ?? b.stages[stage];
        at.handed_back = { words: [`The build passed the build folder's check${sha ? ` on ${sha.slice(0, 7)}` : ""}: every gate, the architecture, the agent's own files, the suite and the code.`], files: filesHanded(id, files.map((f) => ({ path: `code/${f.name}`, at: f.path }))) };
        say(b.log, "The build passed the build folder's own check: every gate, the architecture, the agent's own files, the suite and the code.");
        delivered(b, ev, action, "The build passed the build folder's own ADLC check.", files);
        return "passed";
      }
      const qs = questionsOf(check.problems);
      if (qs.length) {
        const s = b.stages[b.at];
        s.state = "waiting_on_you";
        s.handed_back = { words: [`Only you can answer: ${qs.map((q) => `${q.key}: ${q.question}`).join(" ")}`], files: s.handed_back?.files ?? [] };
        b.work.builder.questions = qs;
        b.status = "waiting";
        say(s.log, `The build folder asks what only you can answer: ${qs.map((q) => q.key).join(", ")}.`);
        say(b.log, `${nameOf(b.at)} waits for your answers.`);
        return "asked";
      }
      if (sha) say(b.stages[b.at].log, `The check on ${sha.slice(0, 7)}: ${nameOf(b.at)} is not passed yet. ${check.problems.slice(0, 3).join(" ")}`.trim());
      return "again";
    });
  }

  /**
   * What the folder's check said, as builderOutcome applies it, with Review and Security review
   * between a check that passed the build and its delivery: the code critic and the security
   * reviewer read the build folder (reviews, as on Code's gate), each where the lifecycle uses its
   * stage. A pass delivers. The check fixed the build's files when it passed it, so a refusal is
   * the person's to act on: the build waits refused, with the reviewers' words, and the person
   * sends it back to the start of the build so the builder can fix it, or gives it more rounds.
   * A reviewer that cannot run here is named and holds nothing. Files already reviewed and passed
   * are not reviewed again. Resolves to builderOutcome's answer, or "held" when the reviewers held it.
   */
  async function judgedOutcome(id, action, stage, folder, check, { sha = null, signal = null } = {}) {
    if (!check.done) return builderOutcome(id, action, stage, folder, check, { sha });
    const r = store.read(id);
    if (!REVIEWERS.some((rv) => r.lifecycle.used?.[rv.stage]?.used !== false)) return builderOutcome(id, action, stage, folder, check, { sha });
    const judged = new Map(builderDelivery(id, folder).map((f) => [f.name, readFileSync(abs(id, f.path))]));
    // Off a pull request there is no commit: the files themselves name what was reviewed.
    const key = sha ?? createHash("sha1").update([...judged].map(([p, bytes]) => `${p}\0${createHash("sha256").update(bytes).digest("hex")}`).join("\n")).digest("hex");
    if (r.work.builder?.gate?.passed !== key) {
      const base = join(dirOf(id), "stages", "code", "pr", key.slice(0, 12));
      const v = await reviews(r, { agent: r.name, version: r.version, digests: {} }, key, judged, check.said || "The build folder's own check passed the build.", base, signal ?? new AbortController().signal, { oneBuilder: true });
      if (signal?.aborted) return "gone";
      await store.update(id, (b) => {
        // The stages as the check passed them, and the files shown at each, before the reviewers' word.
        syncBuilderStages(b, folder, check);
        showBuilderFiles(b, id, folder, check);
        if (!v.passed && b.stages.code) b.at = "code";
        const g = b.work.builder.gate ?? { runs: [] };
        b.work.builder.gate = { ...g, runs: [...(g.runs ?? []), { sha: key, at: now(), passed: v.passed, title: v.title, summary: v.summary, reviews: v.reviews, skipped: v.skipped }], ...(v.passed ? { passed: key } : {}) };
        say(b.log, v.passed ? `The reviewers read the build at ${key.slice(0, 7)}: ${v.title}.` : `The reviewers held the build at ${key.slice(0, 7)}: ${v.title}.`);
      });
      // On a pull request the reviewers' word on the commit is said there too, after the check's.
      if (sha && onPullRequest(r.settings) && r.work.builder?.pr) {
        const c = connect(r.settings.repository, env);
        if (!c.problem) await postResult(c.gh, store.read(id).work.builder.pr, sha, { passed: v.passed, title: v.title, summary: v.summary }).catch(() => {});
      }
      if (!v.passed) {
        // Held at Code, as Code's gate held a refused push: the code is what the reviewers refused.
        await refused(id, action, store.read(id).stages.code ? "code" : store.read(id).at, `${v.summary}\n\nThe build folder's check fixed the build when it passed it, so the builder can change it only after you send it back: send it back to the start of the build with what should change, or to Requirements if it is the spec's to settle.`);
        return "held";
      }
    }
    return builderOutcome(id, action, stage, folder, check, { sha });
  }

  /**
   * build-the-agent, held by one builder: the build folder laid out with the ADLC plugin's
   * kit, the person's approval of the spec pressed there by Product Factory on their word in
   * the console (binding), then your coding harness round by round until the folder's own
   * check says the build has passed. Product Factory judges nothing itself: each stage is
   * done when the check passes the gates shown at it, a question only the person can answer waits for them, and
   * the rounds used up waits on them in the check's own words. On a pull request
   * (code.where "pull-request") your own coding assistant works the folder instead, and this
   * machine runs no coding agent: builderPullRequestStep.
   */
  async function builderStep(r, action, stage, signal) {
    const id = r.id;
    const dir = dirOf(id);
    const folder = builderFolder(id);
    if (onPullRequest(r.settings)) return builderPullRequestStep(r, action, stage, signal);
    if (!r.work.builder?.resumed) await sent(id, action, stage, "Sent to one builder: your coding harness with the ADLC plugin, in one build folder, from the approved spec through the code.");
    if (!r.settings.code.harness) return refused(id, action, stage, "No coding harness is set. Name the command in product-factory.json under code.harness, such as the one product-factory init writes, then run it again.");
    if (!(await prepareFolder(r, action, stage, signal, folder))) return;
    let check = await checkBuild(folder, { env: agentEnv(), signal });
    const limit = r.settings.code.rounds;
    for (let k = 0; k <= limit; k++) {
      if (signal.aborted || check.stopped) return;
      const outcome = await judgedOutcome(id, action, stage, folder, check, { signal });
      if (outcome !== "again") return;
      if (k === limit) break;
      const n = store.read(id).stages[store.read(id).at].rounds.length + 1;
      const res = await builderRound({ folder, adlc: config.adlc, harness: r.settings.code.harness, round: n, check, minutes: r.settings.code.minutes, env: agentEnv(), envRemove: r.settings.code.env_remove ?? config.code.env_remove, signal, log: join(dir, "stages", "build", `round-${n}.log`) });
      if (signal.aborted || res.stopped) return;
      const before = check;
      check = res.check;
      await store.update(id, (b) => {
        const s = b.stages[b.at];
        const verdict = check.done ? "The build passed" : check.stage === before.stage ? `${nameOf(b.at)}: the check still holds it` : `Passed up to ${check.stage}`;
        s.rounds.push({ n, at: now(), label: `Round ${n}`, verdict, back: !check.done, words: firstWords([res.harness, check.said, ...check.problems].filter(Boolean).join(" "), 800) });
        say(s.log, `Round ${n}: ${verdict.toLowerCase()}.`);
      });
    }
    if (check.done) return;
    const s = store.read(id).stages[store.read(id).at];
    return refused(id, action, store.read(id).at, `The build folder's check still holds ${check.stage ?? "the build"} after ${s.rounds.length} round${s.rounds.length === 1 ? "" : "s"}: ${check.problems.slice(0, 5).join(" ")} Give it more rounds, send it back to an earlier stage, or stop the build.`);
  }

  /** The folder made the pull request's newest commit, here: { ok, sha, files } or { ok: false, reason }. */
  async function mirrorBranch(c, pr, folder) {
    const read = await readBranchFolder(c.gh, pr);
    if (!read.ok) return read;
    mirror(folder, read.files);
    return read;
  }

  /**
   * build-the-agent on a pull request: the folder laid out and the person's approval pressed in
   * it here, then the folder goes to a branch of its own and a pull request, and your own coding
   * assistant works it there. Each push is checked by poll (builderPush). Product Factory's own
   * commits on the branch are the person's: the approved spec (after a send back to
   * Requirements), their answers and their send backs (act, onBranch).
   */
  async function builderPullRequestStep(r, action, stage, signal) {
    const id = r.id;
    const folder = builderFolder(id);
    const pr = r.work.builder?.pr ?? null;
    if (!r.work.builder?.resumed && !pr) await sent(id, action, stage, "Sent to one builder on a pull request: your own coding assistant with the ADLC plugin, in one build folder, from the approved spec through the code.");
    const c = connect(r.settings.repository, env);
    if (c.problem) return refused(id, action, stage, c.problem);
    let head = null;
    let headFiles = null;
    if (pr) {
      const read = await mirrorBranch(c, pr, folder);
      if (signal.aborted) return;
      if (!read.ok) return refused(id, action, stage, `Pull request #${pr.number} could not be read: ${read.reason}`);
      head = read.sha;
      headFiles = read.files;
    }
    if (!(await prepareFolder(r, action, stage, signal, folder))) return;
    if (!pr) {
      const fresh = store.read(id);
      const agent = slugOf(fresh.name, id.replace(/_/g, "-"));
      const opened = await openPullRequest({
        gh: c.gh, repo: c.repo, agent, version: fresh.version, folder: builtOf(folder), now: () => new Date(now()),
        title: `Build the agent: ${agent} ${fresh.version}`,
        body: builderPullRequestBody(agent, fresh.version, `agents/${agent}`),
        message: `Build ${agent} ${fresh.version}: the build folder, with the spec you approved`,
      });
      if (signal.aborted) return;
      if (!opened.ok) return refused(id, action, stage, opened.reason);
      const p = opened.record;
      head = p.issued_sha;
      await store.update(id, (b) => {
        b.work.builder = { ...b.work.builder, pr: { repo: p.repo, branch: p.branch, folder: p.folder, number: p.number, url: p.url, issued_sha: p.issued_sha, head: p.issued_sha } };
        say(b.stages[stage].log, `Opened pull request #${p.number} on ${p.repo}, with the build folder in ${p.folder}/: ${p.url}`);
        say(b.log, `The build is on pull request #${p.number}: build it with your own coding assistant and the ADLC plugin, and every push is checked here. ${p.url}`);
      });
    } else {
      // The approved spec laid out again after a send back to Requirements goes on the branch as the person's commit.
      const changed = changedFrom(folder, headFiles);
      if (changed.length) {
        const made = await commitOnBranch(c.gh, pr, { files: changed, message: "Product Factory: the spec you approved, in the build folder", parent: head });
        if (!made.ok) return refused(id, action, stage, `Your approval could not go on pull request #${pr.number}: ${made.reason} Run it again.`);
        head = made.sha;
      }
    }
    const check = await checkBuild(folder, { env: agentEnv(), signal });
    if (signal.aborted || check.stopped) return;
    const outcome = await judgedOutcome(id, action, stage, folder, check, { sha: head, signal });
    if (outcome === "again") await store.update(id, (b) => { say(b.stages[b.at].log, `Waiting for a push to pull request #${b.work.builder.pr.number}.`); });
  }

  /** A build held by one builder, who writes the spec too (code.holder "builder"): no reference spec writer runs. */
  const builderWritesSpec = (r) => r?.settings?.code?.holder === "builder";

  /** write-the-spec, as the build's working phase at Requirements: { phase, to }, or null. */
  function specAction(b) {
    const doc = docOf(b);
    const pid = Object.keys(b.run.phases).find((x) => stageOf(doc, x) === "requirements" && holderOf(doc, x) === "spec-writer");
    return pid ? { phase: pid, to: b.run.phases[pid].holder?.handle ?? "builder" } : null;
  }

  /**
   * The spec in the folder changed after the one you approved: back to Requirements by the
   * document's own ways (the build to the spec's gate, then the gate to write-the-spec, as a send
   * back does), with no words of yours, so the spec as it stands is handed to you.
   */
  async function specChangedUnderYou(id) {
    await change(id, (b, ev) => {
      if (b.status !== "working") return;
      const doc = docOf(b);
      const bpid = Object.keys(b.run.phases).find((x) => holderOf(doc, x) === "builder");
      const back = doc.deviations.find((d) => d.from === bpid && stageOf(doc, d.to) === "requirements" && holderOf(doc, d.to) === "person");
      const toSpec = back ? doc.deviations.find((d) => d.from === back.to && stageOf(doc, d.to) === "requirements" && holderOf(doc, d.to) !== "person") : null;
      if (!back || !toSpec) return;
      const t = now();
      const why = "The spec in the build folder changed after the one you approved";
      ev({ type: "deviated", key: back.key, from: back.from, to: back.to, by: "Product Factory", text: why, steps: [], at: t });
      ev({ type: "gated", phase: back.to, question: phaseNamed(doc, back.to)?.what ?? back.to, files: [], at: t });
      ev({ type: "deviated", key: toSpec.key, from: toSpec.from, to: toSpec.to, by: "Product Factory", text: why, steps: [], at: t });
      for (const st of BUILDER_STAGES) if (b.stages[st]) { b.stages[st].state = "not_started"; b.stages[st].done_when_met = null; }
      const req = b.stages.requirements;
      if (req) { req.state = "working"; req.done_when_met = null; say(req.log, `${why}, so nothing was approved. The spec as it stands is handed to you.`); }
      b.work.builder = { ...b.work.builder, revising: false };
      b.at = "requirements";
      say(b.log, `${why}, so nothing was approved: the build is back at Requirements with the spec as it stands, for you to read and approve.`);
    });
    advance(id);
  }

  /** The digest of the folder's spec.json, or null. */
  const specDigest = (folder) => (existsSync(join(folder, SPEC_JSON)) ? digestOf(readFileSync(join(folder, SPEC_JSON))) : null);

  /**
   * Whether the folder's spec goes to the person: the check says Requirements waits on them,
   * and, when they asked for changes (a send back, Changes at the spec's gate), the builder has
   * pushed a spec other than the one they were handed. The spec they sent back is never handed
   * to them again as if it were the revision.
   */
  function specDeliverable(id, folder, check) {
    if (check.stage !== "requirements" || check.code !== 4) return false;
    const w = store.read(id).work.builder ?? {};
    return !(w.revising && w.handed_spec && specDigest(folder) === w.handed_spec);
  }

  /**
   * The builder's spec, handed to the person: spec.json (and spec.md) of the folder, kept in the
   * round's folder as the spec writer's are, so the console shows it and approve-the-spec hands it on.
   */
  function deliverBuilderSpec(id, action, stage, folder, check, { sha = null } = {}) {
    return change(id, (b, ev) => {
      if (b.status !== "working") return "gone";
      const s = b.stages[stage];
      const n = s.runs || 1;
      const out = join(dirOf(id), "stages", "requirements", `r${n}`);
      mkdirSync(out, { recursive: true });
      const kept = [];
      for (const name of [SPEC_JSON, SPEC_MD]) {
        const from = join(folder, name);
        if (!existsSync(from)) continue;
        writeFileSync(join(out, name), readFileSync(from));
        kept.push({ path: name, abs: join(out, name), media_type: name.endsWith(".json") ? "application/json" : "text/markdown" });
      }
      const spec = readJsonAt(join(out, SPEC_JSON));
      const reply = `The builder's spec is ready for your approval${sha ? ` (pull request commit ${sha.slice(0, 7)})` : ""}: the build folder's own Requirements check passes it. ${check.said}`.trim();
      s.rounds.push({ n, at: now(), label: `Round ${n}`, verdict: "Ready for your approval", back: false, words: firstWords(reply) });
      s.handed_back = { words: [reply], files: filesHanded(id, kept.map((f) => ({ path: `requirements/${f.path}`, at: rel(dirOf(id), f.abs) }))) };
      s.done_when_met = null;
      // Which spec you were handed: what you approve must be this one, and after you ask for
      // changes the same spec is not handed again (specDeliverable).
      b.work.builder = { ...b.work.builder, wrote_spec: true, revising: false, handed_spec: specDigest(folder), check: { stage: check.stage, code: check.code, problems: check.problems.slice(0, 40), said: check.said, ...(sha ? { sha } : {}) } };
      if (sha && b.work.builder.pr) b.work.builder.pr = { ...b.work.builder.pr, head: sha };
      const named = words(spec?.product?.name);
      const versioned = words(spec?.product?.version);
      if (!b.named && named) b.name = named;
      if (versioned && !b.versioned) b.version = versioned;
      say(s.log, "The builder handed back the spec, and the build folder's own Requirements check passes it.");
      // Each feature of the spec the product does not hold in the same words goes to you as proposed, as from the spec writer (0.4.8).
      if (isSpec(spec)) {
        const builds = store.list().filter((x) => x.name === b.name && x.id !== b.id);
        const proposed = specProposals([...builds, b], specFeatures(spec), { build: b.id, at: now() });
        if (proposed.length) {
          (b.feature_log ??= []).push(...proposed);
          say(s.log, `${proposed.length} feature${proposed.length === 1 ? " of the spec goes" : "s of the spec go"} to you as proposed: ${proposed.map((e) => e.feature).join(", ")}. Approve each one, all of them, or approve the spec.`);
        }
      }
      delete b.work.text;
      delivered(b, ev, action, reply, asFiles(id, kept));
      return "delivered";
    });
  }

  /**
   * write-the-spec, held by one builder (code.holder "builder"): the build folder laid out with
   * the ADLC plugin's kit and the person's own words in request.md, and the builder writes the
   * spec there, until the folder's own Requirements check says it waits on the person. No
   * reference spec writer runs, so the spec and everything built from it have one author and
   * one check. The person's changes (send-revision) go into request.md under a dated heading.
   * Here, your coding harness writes it round by round; on a pull request (code.where
   * "pull-request") the pull request opens now, your own coding assistant writes it, and each
   * push is checked (builderPush).
   */
  async function builderSpecStep(r, action, stage, signal) {
    const id = r.id;
    const dir = dirOf(id);
    const folder = builderFolder(id);
    // Your words for the spec: asked for at its gate (send-revision), or carried by a send back to Requirements.
    const revise = action.kind === "send-revision" || ((action.steps ?? []).some((x) => words(x)) && existsSync(join(folder, SPEC_JSON)));
    await sent(id, action, stage, revise ? "Sent back to the builder with your words: they are in request.md." : "Sent to one builder: it writes the spec in the build folder, from your words.");
    const pr = r.work.builder?.pr ?? null;
    const c = onPullRequest(r.settings) ? connect(r.settings.repository, env) : null;
    if (c?.problem) return refused(id, action, stage, c.problem);
    let head = pr?.head ?? null;
    let headFiles = null;
    if (pr) {
      const read = await mirrorBranch(c, pr, folder);
      if (signal.aborted) return;
      if (!read.ok) return refused(id, action, stage, `Pull request #${pr.number} could not be read: ${read.reason}`);
      head = read.sha;
      headFiles = read.files;
    }
    // The product's approved features go with your words, as the spec writer is given them.
    const l = await startFolder({ folder, adlc: config.adlc, request: withFeatures(statementText(r), r, action.phase), env: agentEnv(), signal });
    if (signal.aborted) return;
    if (!l.ok) return refused(id, action, stage, l.reply);
    const asked = (action.steps ?? []).map(words).filter(Boolean).join("\n");
    if (revise) addChanges(folder, asked, now());
    // Your words ask for a revision: the spec you were handed is not handed again until the builder changes it.
    await store.update(id, (b) => { b.work.folder = rel(dir, folder); b.work.builder = { ...b.work.builder, wrote_spec: false, spec_action: { phase: action.phase, to: action.to }, ...(revise && asked ? { revising: true } : {}) }; });

    if (onPullRequest(r.settings)) {
      if (!pr) {
        const fresh = store.read(id);
        const agent = slugOf(fresh.name, id.replace(/_/g, "-"));
        const opened = await openPullRequest({
          gh: c.gh, repo: c.repo, agent, version: fresh.version, folder: builtOf(folder), now: () => new Date(now()),
          title: `Build the agent: ${agent} ${fresh.version}`,
          body: builderPullRequestBody(agent, fresh.version, `agents/${agent}`),
          message: `Build ${agent} ${fresh.version}: the build folder, with your words in request.md`,
        });
        if (signal.aborted) return;
        if (!opened.ok) return refused(id, action, stage, opened.reason);
        const p = opened.record;
        head = p.issued_sha;
        await store.update(id, (b) => {
          b.work.builder = { ...b.work.builder, pr: { repo: p.repo, branch: p.branch, folder: p.folder, number: p.number, url: p.url, issued_sha: p.issued_sha, head: p.issued_sha } };
          say(b.stages[stage].log, `Opened pull request #${p.number} on ${p.repo}, with the build folder in ${p.folder}/: ${p.url}`);
          say(b.log, `The build is on pull request #${p.number}: write the spec and build the agent with your own coding assistant and the ADLC plugin, and every push is checked here. ${p.url}`);
        });
      } else {
        const changed = changedFrom(folder, headFiles);
        if (changed.length) {
          const made = await commitOnBranch(c.gh, pr, { files: changed, message: "Product Factory: the changes you asked for, in request.md", parent: head });
          if (!made.ok) return refused(id, action, stage, `Your words could not go on pull request #${pr.number}: ${made.reason} Run it again.`);
          head = made.sha;
          await store.update(id, (b) => { b.work.builder.pr = { ...b.work.builder.pr, head: made.sha }; say(b.stages[stage].log, `Your changes are on pull request #${pr.number} in request.md: pull before going on.`); });
        }
      }
      const check = await checkBuild(folder, { env: agentEnv(), signal });
      if (signal.aborted || check.stopped) return;
      if (specDeliverable(id, folder, check)) return deliverBuilderSpec(id, action, stage, folder, check, { sha: head });
      await store.update(id, (b) => { say(b.stages[stage].log, `Waiting for a push to pull request #${b.work.builder.pr.number} with the spec.`); });
      return;
    }

    if (!r.settings.code.harness) return refused(id, action, stage, "No coding harness is set. Name the command in product-factory.json under code.harness, such as the one product-factory init writes, then run it again.");
    let check = await checkBuild(folder, { env: agentEnv(), signal });
    const limit = r.settings.code.rounds;
    for (let k = 0; k <= limit; k++) {
      if (signal.aborted || check.stopped) return;
      if ((!revise || k > 0) && check.stage === "requirements" && check.code === 4) return deliverBuilderSpec(id, action, stage, folder, check);
      if (k === limit) break;
      const n = (store.read(id).stages[stage].rounds?.length ?? 0) + 1;
      const res = await builderRound({ folder, adlc: config.adlc, harness: r.settings.code.harness, round: n, check, prompt: specPrompt(check), minutes: r.settings.code.minutes, env: agentEnv(), envRemove: r.settings.code.env_remove ?? config.code.env_remove, signal, log: join(dir, "stages", "requirements", `round-${n}.log`) });
      if (signal.aborted || res.stopped) return;
      check = res.check;
      if (res.harness) await store.update(id, (b) => { say(b.stages[stage].log, res.harness); });
    }
    return refused(id, action, stage, `The build folder's Requirements check still holds the spec after ${limit} round${limit === 1 ? "" : "s"}: ${check.problems.slice(0, 5).join(" ")} Give it more rounds, ask for changes, or stop the build.`);
  }

  /**
   * A push to the builder's pull request: the folder made that commit's, the folder's own check
   * run on it, and its word said on the pull request and applied to the build.
   * Resolves to { judged, passed? }.
   */
  async function builderPush(id, c) {
    const r = store.read(id);
    const pr = r.work.builder.pr;
    const head = await pullRequestHead(c.gh, pr);
    if (!head.ok) { await noteOnce(id, `Pull request #${pr.number} could not be checked: ${head.reason}`); return { judged: false }; }
    if (!head.open && !head.merged) { await noteOnce(id, `Pull request #${pr.number} was closed without merging. Reopen it to go on.`); return { judged: false }; }
    if (head.sha === pr.head) return { judged: false };
    const folder = builderFolder(id);
    const read = await mirrorBranch(c, pr, folder);
    if (!read.ok) { await noteOnce(id, `Pull request #${pr.number} could not be read: ${read.reason}`); return { judged: false }; }
    const check = await checkBuild(folder, { env: agentEnv() });
    if (check.stopped) return { judged: false };
    const title = check.done ? "the build has passed" : `${check.stage ?? "the build"} is not passed yet`;
    const summary = check.done ? "The build folder's own ADLC check passed the build: every gate. Product Factory makes the package, and you approve the deploy there." : [check.said, ...check.problems.map((p) => `- ${p}`)].filter(Boolean).join("\n");
    await postResult(c.gh, pr, read.sha, { passed: check.done, title, summary }).catch(() => {});
    // At Requirements the builder is writing the spec: a push the check says is ready goes to the person.
    if (store.read(id).at === "requirements") {
      const sa = store.read(id).work.builder?.spec_action ?? specAction(store.read(id));
      if (!sa) return { judged: false };
      if (specDeliverable(id, folder, check)) { if ((await deliverBuilderSpec(id, sa, "requirements", folder, check, { sha: read.sha })) === "delivered") advance(id); return { judged: true, passed: false, title }; }
      if (check.stage === "requirements" && check.code === 4) {
        await store.update(id, (b) => {
          b.work.builder.pr = { ...b.work.builder.pr, head: read.sha };
          say(b.stages.requirements.log, `The check on ${read.sha.slice(0, 7)}: the spec is the one you asked to change. Waiting for the builder's revision.`);
        });
        return { judged: true, passed: false, title };
      }
      await store.update(id, (b) => {
        b.work.builder.pr = { ...b.work.builder.pr, head: read.sha };
        say(b.stages.requirements.log, `The check on ${read.sha.slice(0, 7)}: the spec is not ready yet. ${check.problems.slice(0, 3).join(" ")}`.trim());
      });
      return { judged: true, passed: false, title };
    }
    const action = builderAction(store.read(id));
    if (!action) return { judged: false };
    const outcome = await judgedOutcome(id, action, store.read(id).at, folder, check, { sha: read.sha });
    // The builder's phase answered: the run goes on from it (Package, Conformance, your OK), as
    // the Requirements branch above does when the spec is delivered. On the cloud machine the
    // pushes that passed every stage were judged here and the build never went on.
    if (outcome === "passed") await advance(id);
    return { judged: true, passed: outcome === "passed", title };
  }

  /**
   * The person's word on a builder's pull request: the folder made the branch's newest commit,
   * the change made in it (their answers, their send back), and that change pushed to the branch
   * as Product Factory's commit, so the folder's lock records it. Off a pull request, the change
   * is made in the folder here only. Throws refusedHere when the branch cannot take it.
   */
  async function onBranch(r, apply, message) {
    const no = (why) => { const e = new Refused(409, why); e.build = store.read(r.id); return e; };
    const pr = onPullRequest(r.settings) ? r.work.builder?.pr : null;
    if (!pr) return apply();
    const c = connect(r.settings.repository, env);
    if (c.problem) throw no(c.problem);
    const folder = builderFolder(r.id);
    for (let tries = 0; tries < 2; tries++) {
      const read = await mirrorBranch(c, pr, folder);
      if (!read.ok) throw no(`Pull request #${pr.number} could not be read: ${read.reason}`);
      const out = await apply();
      const changed = changedFrom(folder, read.files);
      if (!changed.length) return out;
      const made = await commitOnBranch(c.gh, pr, { files: changed, message, parent: read.sha });
      if (made.ok) return out;
      if (!made.moved) throw no(`Your answer could not go on pull request #${pr.number}: ${made.reason}`);
    }
    throw no(`Pull request #${pr.number} kept moving while your answer was being put on it. Answer again.`);
  }

  async function packerStep(r, action, stage, signal) {
    const id = r.id;
    await sent(id, action, stage, "Packing the agent's files and the scripts as an Agent Package.");
    const n = store.read(id).stages[stage].runs;
    // The folder the package is made from: what the phase was handed, each file at its own name.
    const folder = join(dirOf(id), "stages", "package", `r${n}`, "handed");
    for (const f of handed(action)) {
      if (!AGENT_FILE.test(f.name) && !/^scripts\//.test(f.name)) continue;
      const to = join(folder, ...f.name.split("/"));
      mkdirSync(dirname(to), { recursive: true });
      cpSync(abs(id, f.path), to);
    }
    const res = await pack({ dir: dirOf(id), n, folder, packer: r.settings.packer, env: agentEnv(), signal });
    if (signal.aborted) return;
    const round = { n, at: now(), label: `Round ${n}`, verdict: res.ok ? "Packed and validated" : "Refused", back: false, words: firstWords(res.reply) };
    if (!res.ok) return refused(id, action, stage, res.reply, { round, handed: res.handed ?? [] });
    await change(id, (b, ev) => {
      if (b.status !== "working") return;
      const s = b.stages[stage];
      s.rounds.push(round);
      s.handed_back = { words: [res.reply], files: filesHanded(id, res.handed) };
      s.state = "done";
      s.done_when_met = true;
      say(s.log, "Packed and validated.");
      if (res.version) b.version = res.version;
      delivered(b, ev, action, res.reply, res.handed.map((f) => ({ name: f.path.replace(/^package\//, ""), path: f.at, media_type: f.path.endsWith(".tar.gz") ? "application/gzip" : "application/json" })));
    });
  }

  /** The person's gate: the runner records the question, and the build waits for an answer in the console. */
  function gate(r, action, stage, doc) {
    return change(r.id, (b, ev) => {
      if (b.status !== "working") return;
      ev({ type: "gated", phase: action.phase, question: phaseNamed(doc, action.phase)?.what ?? action.phase, files: [] });
      b.stages[stage].state = "waiting_on_you";
      b.status = "waiting";
      say(b.log, stage === "requirements" ? "The spec is ready. It waits for you to approve it." : stage === "code" ? "The code waits for your OK." : stage === "deploy" ? "The package and its run plan wait for you to approve the deploy." : `${nameOf(stage)} waits on you.`);
    });
  }

  /** The run reaches a phase milestone 1 does not run, or one the build's lifecycle leaves out: it ends there. */
  async function endRun(r, phase, stage, why) {
    await change(r.id, (b, ev) => {
      if (b.status !== "working") return;
      const open = Object.entries(b.run.phases).filter(([, p]) => p.status !== "closed").map(([pid]) => pid);
      ev({ type: "closed", outcome: "ended", result: `${why} The run ends before ${phase}.`, open });
      b.status = "done";
      say(b.log, b.at === "package" ? `Done: ${b.name} ${b.version} is packed and validated. ${why}` : b.at === "deploy" ? why : `Done at ${nameOf(b.at)}. ${why}`);
    });
  }

  // ---------- Deploy and Conformance ----------

  /**
   * deploy-the-agent, held by the runtime you bring: the package and the run plan
   * are handed to it (runtime.mjs), and what it answers is the phase's delivery.
   * With no runtime set, or one that refused, the phase stays out and the build
   * waits on you to hand it over again.
   */
  async function deployStep(r, action, signal) {
    const id = r.id;
    if (r.run.phases[action.phase].status === "waiting") {
      await change(id, (b, ev) => {
        ev({ type: "holder", phase: action.phase, handle: action.to, how: action.holder?.how ?? "named in the roster" });
        ev({ type: "sent", phase: action.phase, to: action.to, handle: action.to, kind: "work", text: "The package and its run plan, handed to your runtime." });
      });
    }
    await runtime.handOff(id, signal, { goesOn: true });
    if (signal.aborted) return true;
    const after = store.read(id);
    if (after.stages.deploy?.state !== "done" || after.status !== "working") return true;
    await change(id, (b, ev) => {
      const d = b.stages.deploy;
      const files = d.handed_back.files.map((f) => ({ name: f.path.replace(/^package\//, ""), path: f.at, media_type: f.path.endsWith(".tar.gz") ? "application/gzip" : "application/json" }));
      ev({ type: "replied", phase: action.phase, from: action.to, handle: action.to, text: d.handed_back.words.join(" ") || "Your runtime took the package.", files, verdict: "delivered" });
    });
    return true;
  }

  /** The package AgentDoc a build carries (Common Agent 13.2, beside the package in an agent repository): one a stage handed back, or the adopted code's own. */
  function packageAgentDoc(r) {
    const handed = Object.values(r.stages).flatMap((s) => s.handed_back?.files ?? []).find((f) => /(^|\/)agentdoc\.json$/.test(f.path));
    if (handed) return abs(r.id, handed.at);
    const own = join(dirOf(r.id), "source", "code", "agentdoc.json");
    return existsSync(own) ? own : null;
  }

  /**
   * check-conformance: the package that was deployed, held to the Common Agent
   * checks that run with node and no network (conformance.mjs). The attestation
   * is the delivery; a check that failed refuses the phase with it, so the build
   * waits on you and nothing reads as passed.
   */
  async function conformanceStep(r, action, stage, signal) {
    const id = r.id;
    await sent(id, action, stage, "The package that was deployed goes to the Common Agent checkers, which run with node and no network.");
    const n = store.read(id).stages[stage].runs;
    const archive = (r.stages.package?.handed_back?.files ?? []).find((f) => f.path.endsWith(".tar.gz"));
    if (!archive) return refused(id, action, stage, "There is no package to check: Package handed back no archive.", { round: { n, at: now(), label: `Round ${n}`, verdict: "Not run", back: false, words: "There is no package to check." } });
    const sha = /sha256 ([0-9a-f]{64})/.exec(r.stages.package.handed_back.words.join(" "))?.[1] ?? null;
    const base = join(dirOf(id), "stages", "conformance", `r${n}`);
    const res = await checkConformance({ base, archive: abs(id, archive.at), agentdoc: packageAgentDoc(r), packer: r.settings.packer, env: agentEnv(), signal, name: r.name, version: r.version, sha256: sha, at: now() });
    if (signal.aborted || res.stopped) return;
    const handedFiles = [{ path: `conformance/${ATTESTATION_FILE}`, at: rel(dirOf(id), res.file) }];
    const round = { n, at: now(), label: `Round ${n}`, verdict: res.passed ? "Passed the checks that ran" : "A check failed", back: !res.passed, words: firstWords(res.words) };
    if (!res.passed) return refused(id, action, stage, res.words, { round, handed: handedFiles });
    await change(id, (b, ev) => {
      if (b.status !== "working") return;
      const s = b.stages[stage];
      s.rounds.push(round);
      s.handed_back = { words: [res.words], files: filesHanded(id, handedFiles) };
      s.state = "done";
      s.done_when_met = true;
      say(s.log, "The package passed every Common Agent check that ran here; the checks that need the running agent are left to your runtime.");
      delivered(b, ev, action, res.words, [{ name: ATTESTATION_FILE, path: handedFiles[0].at, media_type: "text/markdown" }]);
    });
  }

  /**
   * One builder's steps never go quiet: a step that throws refuses its phase in words, so a
   * build can never sit "working" with nothing said, as one did on 2026-11-11 after an approval.
   */
  const guarded = (step) => async (r, a, stage, signal) => {
    try { return await step(r, a, stage, signal); }
    catch (e) { if (!signal?.aborted) return refused(r.id, a, stage, `Product Factory went wrong running ${nameOf(stage)}: ${e?.message ?? e}. Run it again, or stop the build.`); }
  };

  const STEPS = { "reverse-engineer": reverseStep, "spec-writer": (r, a, stage, signal) => (builderWritesSpec(r) ? guarded(builderSpecStep)(r, a, stage, signal) : specWriterStep(r, a, stage, signal)), "test-writer": testWriterStep, code: codeStep, packer: packerStep, conformance: conformanceStep, builder: guarded(builderStep) };

  // ---------- running a build ----------

  async function step(r, signal) {
    const doc = docOf(r);
    const ready = actionsFor(r.run, doc);
    const a = ready[0] ?? null;
    // Deploy is the runtime's: once the person approved the deploy (or hands it over again),
    // the run ends there and the package goes to the runtime with its run plan.
    if (r.at === "deploy") {
      const pid = Object.keys(r.run.phases).find((x) => stageOf(doc, x) === "deploy" && holderOf(doc, x) === "runtime");
      const goesOn = r.run.status === "open" && pid && rosterOf(r.run).has("deployment-manager");
      if (!goesOn) {
        if (r.run.status === "open") await endRun(r, a?.phase ?? "deploy-the-agent", "deploy", "You approved the deploy, so the package and its run plan go to the runtime you bring.");
        await runtime.handOff(r.id, signal);
        return true;
      }
      // Once the runtime took it, deploy-the-agent is delivered and the run goes on below.
      if (r.run.phases[pid].status !== "closed") return deployStep(r, a?.phase === pid ? a : { phase: pid, kind: "send-work", to: rosterOf(r.run).get("deployment-manager") }, signal);
    }
    // One builder goes on in its own phase: after your answers, or after you sent the folder back to one of its stages.
    const building = Object.entries(r.run.phases).find(([x, p]) => holderOf(doc, x) === "builder" && p.status === "working");
    if (building && r.work.builder?.resumed && r.status === "working") {
      const [phase, p] = building;
      await builderStep(r, { phase, kind: "send-work", to: p.holder?.handle ?? "harness", handoffs: [] }, stageOf(doc, phase), signal);
      return true;
    }
    if (!a) return false;
    // Phases no after: path connects are never made to wait for each other (Agent Processes 6.2):
    // when the runner has more than one phase ready to send, each goes to its holder now, at once.
    const sends = ready.filter((x) => ["send-work", "send-revision"].includes(x.kind));
    const sendable = (x) => { const s = stageOf(doc, x.phase); return RUNS.includes(s) && Boolean(r.stages[s]) && Boolean(STEPS[holderOf(doc, x.phase)]); };
    if (sends.length > 1 && sends.every(sendable)) {
      const first = stageOf(doc, sends[0].phase);
      if (r.at !== first) await store.update(r.id, (b) => { b.at = first; });
      const fresh = store.read(r.id);
      await Promise.all(sends.map((x) => STEPS[holderOf(doc, x.phase)](fresh, x, stageOf(doc, x.phase), signal)));
      return true;
    }
    const stage = a.phase ? stageOf(doc, a.phase) : null;
    if (["send-work", "send-revision", "ask-gate", "ask-approve", "ask-act-on-draft"].includes(a.kind)) {
      // The process document's "approve the deploy" gate, asked with the run plan to read.
      if (stage === "deploy" && a.kind === "ask-gate" && await runtime.prepare(r.id)) { await gate(store.read(r.id), a, stage, doc); return true; }
      // A deploy gate that could not be asked (nothing packed, or Deploy left out) ends the run as it always has.
      if (!RUNS.includes(stage) || stage === "deploy") { await endRun(r, a.phase, stage, `Product Factory runs no stage after Package; ${nameOf(stage)} and the stages after it go to the runtime you bring.`); await runtime.handOff(r.id, signal); return true; }
      // The publish gate after Conformance: Product Factory does not publish, so the run ends there.
      if (stage === "conformance" && a.kind.startsWith("ask-")) { await endRun(r, a.phase, stage, "Product Factory does not publish: the package, its run plan and the conformance attestation are with the runtime you bring, and the listing is made by the platform that hosts your catalog."); return true; }
      // Architecture and Design left out: its phase there does not run, and the build goes on.
      if (!r.stages[stage] && stage === "architecture" && a.kind === "send-work") { await notUsedStep(r, a, stage); return true; }
      if (!r.stages[stage]) { await endRun(r, a.phase, stage, `This build's lifecycle leaves out ${nameOf(stage)}.`); return true; }
      if (r.at !== stage) await store.update(r.id, (b) => { b.at = stage; });
      const fresh = store.read(r.id);
      if (a.kind.startsWith("ask-")) { await gate(fresh, a, stage, doc); return true; }
      const adapter = STEPS[holderOf(doc, a.phase)];
      if (!adapter) { await endRun(fresh, a.phase, stage, `Milestone 1 has nobody to send ${a.phase} to.`); return true; }
      await adapter(fresh, a, stage, signal);
      return true;
    }
    if (a.kind === "close") {
      await change(r.id, (b, ev) => { if (b.status !== "working") return; ev({ type: "closed", outcome: "completed" }); b.status = "done"; say(b.log, `Done: every phase of ${b.run.process.name} closed.`); });
      return true;
    }
    if (a.kind === "fail-refused") {
      // A phase that starts at the trigger refused: the run ends as failed, and the person may start it again.
      await change(r.id, (b, ev) => {
        ev({ type: "trigger-refused", phase: a.phase, holder: a.from, text: a.text });
        if (b.status === "working") { b.status = "refused"; b.at = stage ?? b.at; }
      });
      return true;
    }
    if (a.kind === "ask-refused") {
      await store.update(r.id, (b) => { if (b.status === "working") b.status = "refused"; });
      return true;
    }
    // Anything else the runner asks for (a holder to name, a person to act, a gap to fill) milestone 1 does not answer.
    await store.update(r.id, (b) => {
      if (b.status !== "working") return;
      b.status = "refused";
      if (b.stages[b.at]) b.stages[b.at].state = "refused";
      say(b.log, `The process runner asked for something milestone 1 does not answer (${a.kind}${a.phase ? ` at ${a.phase}` : ""}). It waits on you.`);
    });
    return true;
  }

  function advance(id) {
    if (running.has(id)) return running.get(id).done;
    const ctl = new AbortController();
    const entry = { ctl, done: null };
    running.set(id, entry);
    entry.done = (async () => {
      try {
        for (let guard = 0; guard < 500; guard++) {
          const r = store.read(id);
          if (!r || r.status !== "working" || ctl.signal.aborted) return;
          const before = JSON.stringify([r.status, r.run.events.length]);
          const moved = await step(r, ctl.signal);
          const after = store.read(id);
          if (!moved || JSON.stringify([after?.status, after?.run.events.length]) === before) return;
        }
      } catch (e) {
        await store.update(id, (b) => {
          if (b.status !== "working") return;
          if (b.stages[b.at]) { b.stages[b.at].state = "refused"; say(b.stages[b.at].log, `Something went wrong in Product Factory: ${e.message}`); }
          b.status = "refused";
          say(b.log, `${nameOf(b.at)} stopped on an error in Product Factory. It waits on you.`);
        }).catch(() => {});
      } finally {
        running.delete(id);
      }
    })();
    return entry.done;
  }

  /**
   * who: the person starting it (people.mjs); the runner's person when not given. issue: the GitHub
   * issue it came from ({ repo, number, url }), kept on the build (intake.mjs). version: the version
   * this build makes, kept over the spec's (the boss starts a product's next version with it).
   * earlier: an earlier build of the product, its prototype ({ build, version, files: [{ at, media_type }] }):
   * its approved agent files go to the spec writer with the first draft, to revise.
   * drift: the build before, when the product's code changed outside the lifecycle
   * ({ build, version, commit, files: [{ name, at, build }] }, its as-built record):
   * the build starts from existing code with that record, so only what changed is described.
   *
   * req.starting_point (lifecycle API 0.4.6): "idea" (the default) or "existing-code",
   * with req.source naming the codebase; the build then runs the process
   * "adopt existing code", entering at Reverse engineering.
   *
   * req.starting_point "as-built-record" (lifecycle API 0.4.7), with req.source
   * naming the record (a folder, or a repository, commit and path): the record
   * is read now, kept as the build's as_built artifact, and each behavior in it
   * goes to Requirements as a proposed feature marked as built. The build runs
   * the process "rebuild from an as-built record", entering at Requirements;
   * nothing is adopted, so Code writes the code fresh.
   */
  async function start(req, who = person, { issue = null, version = null, earlier = null, drift = null } = {}) {
    const by = who.email;
    if ("starting_point" in req && typeof req.starting_point !== "string") throw new Refused(400, "starting_point is words: the id of a starting point in stages.json, such as existing-code.");
    const point = words(req.starting_point) || "idea";
    if (!["idea", "existing-code", "as-built-record"].includes(point)) {
      const known = STAGES_DOC.starting_points?.some((p) => p.id === point);
      throw new Refused(400, known ? `Product Factory starts a build from an idea, from existing code, or from an as-built record. It does not start from ${point} yet.` : `${point} is not a starting point in stages.json.`);
    }
    const adopt = point === "existing-code";
    const fromRec = point === "as-built-record";
    let source = null;
    if (adopt) {
      if (!words(req.name)) throw new Refused(400, "Say what the product is called: name is required when it starts from existing code.");
      try { source = sourceOf(req.source); } catch (e) { throw new Refused(400, e.message); }
    } else if (fromRec) {
      if (!words(req.name)) throw new Refused(400, "Say what the product is called: name is required when it starts from an as-built record.");
      try { source = recordSourceOf(req.source); } catch (e) { throw new Refused(400, e.message); }
    } else if (req.source !== undefined) throw new Refused(400, "source names existing code or an as-built record, so it goes with the starting point existing-code or as-built-record.");
    const does = words(req?.does) || (adopt ? `Adopt the existing code of ${words(req.name)}` : fromRec ? `Rebuild ${words(req.name)} from its as-built record` : "");
    if (!does) throw new Refused(400, "Say what the agent should do: does is required.");
    if (req.kind && req.kind !== "agent") throw new Refused(400, "Product Factory milestone 1 builds agents only. A process is a later milestone.");
    for (const k of ["refuses", "more", "name", "prototype", "project"]) {
      if (k in req && typeof req[k] !== "string") throw new Refused(400, `${k} is words.`);
    }
    const project = words(req.project) || null;
    const snap = await lifecycle.snapshot(project);
    if (adopt && snap.used["reverse-engineering"]?.used === false) throw new Refused(400, `This ${project ? `project's` : "organization's"} lifecycle leaves out Reverse engineering, so a build cannot start from existing code. Use it in the lifecycle, or start from an idea.`);
    const settings = { code: { ...config.code }, packer: [...config.package.packer] };
    // One builder makes new agents only. Adopting existing code and rebuilding from an as-built
    // record run their own documents, held by the reference writers, so the build's settings say so:
    // the spec writer, the test writer and, for a rebuild, the reference code writer.
    if ((adopt || fromRec) && settings.code.holder === "builder") {
      const { where: _, ...rest } = settings.code;
      settings.code = { ...rest, holder: "code-writer" };
    }
    if (settings.code.holder === "pull-request" || settings.code.where === "pull-request") settings.repository = { ...config.repository };
    // The reviewers' settings: Code's gate on a pull request, and one builder's build, ask them.
    if (settings.code.holder === "pull-request" || settings.code.holder === "builder") settings.review = { ...config.review };
    const id = store.newId();
    // An as-built record is read now, so a record that is not whole is refused before a build starts.
    let brought = null;
    if (fromRec) {
      brought = await fetchRecord(source, join(dirname(dirOf(id)), `.record-${id}`), { env });
      if (!brought.ok) throw new Refused(400, brought.reason);
    }
    const holders = holdersFor(settings, { adopt, record: brought?.record ?? null });
    const at = now();
    const record = {
      format: RECORD_FORMAT, id,
      name: words(req.name) || "A new agent", named: Boolean(words(req.name)),
      does, refuses: words(req.refuses), more: words(req.more), prototype: words(req.prototype),
      ...(project ? { project } : {}),
      ...(issue ? { issue: { repo: issue.repo, number: issue.number, url: issue.url } } : {}),
      version: words(version) || "0.1.0", ...(words(version) ? { versioned: true } : {}), created: at, updated: at, archived: false,
      ...(earlier ? { earlier: { build: earlier.build, version: earlier.version, files: earlier.files.map((f) => ({ at: f.at, media_type: f.media_type ?? "" })) } } : {}),
      ...(adopt ? {
        starting_point: point,
        source: { starting_point: point, trigger: drift ? "drift" : "adoption", ...(source.repository ? { repository: source.repository } : {}), ...(source.folder ? { folder: source.folder } : {}), ...(source.commit ? { commit_asked: source.commit } : {}), shown: source.shown },
        ...(drift ? { drift: { build: drift.build, version: drift.version, commit: drift.commit, files: drift.files } } : {}),
      } : {}),
      // Started from an as-built record: where it was read, and the code it describes, which the build does not take on.
      ...(fromRec ? {
        starting_point: point,
        record: {
          ...(source.folder ? { folder: source.folder } : { repository: source.repository, ...(source.commit ? { commit: source.commit } : {}), ...(source.path ? { path: source.path } : {}) }),
          ...(brought.commit ? { read_at: brought.commit } : {}),
          shown: source.shown, at, words: brought.words,
          code: { repository: words(brought.record.repository), commit: words(brought.record.commit) },
        },
      } : {}),
      status: "working", at: adopt ? "reverse-engineering" : "requirements",
      lifecycle: { project, at, used: snap.used, holders: snap.holders, added: snap.added },
      settings,
      process: "run/document.txt",
      run: null,
      stages: {},
      work: {},
      log: [],
    };
    let opened;
    try {
      opened = openRun({ person: by, day: at.slice(0, 10), settings, material: asked(record), startedAt: at, adopt, record: fromRec });
    } catch (e) {
      throw new Refused(409, e.message);
    }
    record.run = opened.state;
    // One builder holds the build (make-a-new-agent-one-builder.txt): the build folder's check decides its stages.
    if (builtByOne(opened.doc)) record.one_builder = true;
    // Architecture and Design runs only where one builder holds the build; adopting and rebuilding have no architecture phase.
    const architected = opened.doc.phases.some((p) => holderOf(opened.doc, p.id) === "builder");
    for (const s of Object.keys(holders)) {
      if (!snap.used[s]?.used || (fromRec && s === "reverse-engineering") || (s === "architecture" && !architected) || (s === "conformance" && !rosterOf(opened.state).has("conformance-checker"))) continue;
      record.stages[s] = {
        state: "not_started", holder: holders[s], runs: 0, rounds: [],
        given: s === "reverse-engineering" ? reverseGiven(record)
          : s === "requirements" ? `${asked(record).replace(/^Write a spec\.\n/, "").trim()}${adopt ? "\nThe as-built record from Reverse engineering: each behavior in it comes to you as a proposed feature marked as built, to approve, call a bug, or drop." : fromRec ? "\nThe as-built record you brought: each behavior in it comes to you as a proposed feature marked as built, to approve, call a bug, or drop. The code it describes is not taken on." : ""}`
            : GIVEN[builtByOne(opened.doc) && BUILDER_STAGES.includes(s) ? `${s}-builder` : adopt && (s === "test" || s === "code") ? `${s}-adopt` : fromRec && s === "test" ? "test-record" : s === "code" && settings.code.holder === "pull-request" ? (fixLoopOn(settings) ? "code-pr-loop" : "code-pr") : s],
        handed_back: { words: [], files: [] }, done_when_met: null, log: [],
      };
    }
    if (fromRec) {
      // Reverse engineering did not run here: the record it would hand back was brought, made elsewhere.
      // It is kept as the stage's hand-back, so the build's as_built artifact and the material read it as they do an adopted build's.
      const handedBack = brought.files.map((f) => ({ path: `as-built/${f.path}`, at: `source/as-built/${f.path}`, size: f.bytes.length }));
      record.stages["reverse-engineering"] = {
        state: "done", holder: holders["reverse-engineering"], runs: 0,
        rounds: [{ n: 1, at, label: "Brought", verdict: "As-built record brought", back: false, words: brought.words }],
        given: broughtGiven(record),
        handed_back: { words: [brought.words], files: handedBack }, done_when_met: true, log: [{ at, said: brought.words }],
      };
      // Each behavior goes to Requirements as a proposed feature marked as built, as from Reverse engineering.
      const builds = store.list().filter((x) => x.name === record.name);
      const kept = asBuiltProposals(builds, brought.behaviors, { by: "The as-built record you brought", build: id, commit: record.record.code.commit, at });
      if (kept.length) record.feature_log = kept;
      say(record.log, `Started from an as-built record of code kept elsewhere, ${source.shown}, describing ${record.record.code.repository} at ${short(record.record.code.commit)}. It enters at Requirements; the code it describes is not taken on, so Code writes the code fresh.`);
      say(record.log, kept.length
        ? `${kept.length} behavior${kept.length === 1 ? " goes" : "s go"} to Requirements as proposed features marked as built, for you to approve, call a bug, or drop.`
        : "No behavior in the record differs from the features the product holds.");
    }
    say(record.log, `Started under ${project ? `the project ${project}'s` : "the organization's"} lifecycle, running the process ${opened.state.process.name} (${opened.doc.ref || opened.state.process.id} ${opened.state.process.version}).`);
    if (issue) say(record.log, `Started from issue #${issue.number} on ${issue.repo}: ${issue.url}`);
    if (adopt) say(record.log, drift ? `Started from existing code, because ${source.shown} changed outside the lifecycle since ${drift.version} knew it at ${short(drift.commit)}. It enters at Reverse engineering with the last as-built record.` : `Started from existing code, ${source.shown}. It enters at Reverse engineering.`);
    for (const s of Object.keys(record.stages)) {
      const bound = snap.holders[ROLE_OF[s]];
      if (bound && bound.kind !== "reference_agent" && !(s === "code" && bound.kind === "your_agent" && ["harness", "pull-request"].includes(settings.code.holder))) {
        say(record.log, `The lifecycle has ${bound.name} hold the ${roleById.get(ROLE_OF[s])?.name ?? ROLE_OF[s]} role. Milestone 1 sends ${nameOf(s)} to ${holders[s].name} instead.`);
      }
    }
    for (const a of snap.added) say(record.log, `The lifecycle adds a stage of its own, ${a.name}. Milestone 1 does not run stages of your own yet.`);
    store.create(record);
    for (const f of brought?.files ?? []) {
      const to = join(dirOf(id), "source", "as-built", ...f.path.split("/"));
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, f.bytes);
    }
    mkdirSync(join(dirOf(id), "run"), { recursive: true });
    writeFileSync(abs(id, record.process), opened.text);
    saveRun(join(dirOf(id), "run"), record.run);
    advance(id);
    return store.read(id);
  }

  /**
   * The product's code changed outside the lifecycle (drift): the next version
   * starts from existing code at the codebase's newest commit, with the last
   * build that knew it as the one before. Its as-built record goes to the
   * reverse engineer, so only what changed is described, and its approved
   * statement goes to the spec writer to revise. prev: that build. version:
   * the version to make. Resolves to the new build.
   */
  async function startDrift(prev, version, who = person) {
    const src = prev.source ?? {};
    const files = (prev.stages?.["reverse-engineering"]?.handed_back?.files ?? []).filter((f) => /^as-built\//.test(f.path)).map((f) => ({ name: f.path.slice("as-built/".length), at: f.at, build: prev.id }));
    const agent = (prev.stages?.requirements?.handed_back?.files ?? []).filter((f) => AGENT_FILE.test(f.path.replace(/^requirements\//, "")) || isSpecName(f.path)).map((f) => ({ at: f.at, media_type: /\.json$/.test(f.path) ? "application/json" : "text/markdown" }));
    return start({
      does: prev.does, name: prev.name, starting_point: "existing-code",
      source: src.folder ? { folder: src.folder } : { repository: src.repository },
      ...(prev.project ? { project: prev.project } : {}),
    }, who, { version, drift: { build: prev.id, version: prev.version, commit: src.commit, files }, ...(agent.length ? { earlier: { build: prev.id, version: prev.version, files: agent } } : {}) });
  }

  /** What a resume at a phase runs again: that phase, and every phase of the run that has not closed. */
  const reopenFrom = (b, pid) => [pid, ...Object.entries(b.run.phases).filter(([x, p]) => x !== pid && !["closed", "skipped"].includes(p.status)).map(([x]) => x)];

  const notOffered = (r) => { const e = new Refused(409, "That action is not offered now."); e.build = r; return e; };

  /** A person's answer at a gate, or stop, resume, archive: each one an event the runner reads. */
  async function act(id, name, needs = {}, who = person) {
    const by = who.email;
    const r = store.read(id);
    if (!r) throw new Refused(404, "There is no build with that id.");
    if (!actionsOf(r).some((a) => a.name === name)) throw notOffered(r);
    // Started from existing code: every behavior as built is answered before the spec is approved, one at a time (0.4.6).
    if (name === "approve" && r.at === "requirements") {
      const open = openAsBuilt(store.list().filter((b) => b.name === r.name), r);
      if (open.length) {
        const e = new Refused(409, `${open.length === 1 ? "One behavior" : `${open.length} behaviors`} as built ${open.length === 1 ? "waits" : "wait"} for your answer (${open.map((f) => f.id).join(", ")}). Approve each one you want kept, call it a bug, or drop it, then approve the spec.`);
        e.build = r;
        throw e;
      }
    }
    // One builder on a pull request: what you approve is the spec on the branch as it stands. A push
    // since the spec was handed to you is read first; if it changed the spec, nothing is approved,
    // and the new spec is handed to you, so Approve is your next action again.
    if (name === "approve" && r.at === "requirements" && builderWritesSpec(r) && onPullRequest(r.settings) && r.work.builder?.pr && r.work.builder?.handed_spec) {
      const c = connect(r.settings.repository, env);
      const folder = builderFolder(id);
      const read = c.problem ? { ok: false, reason: c.problem } : await mirrorBranch(c, r.work.builder.pr, folder);
      if (!read.ok) { const e = new Refused(409, `Nothing was approved: pull request #${r.work.builder.pr.number} could not be read to see the spec as it stands (${read.reason}). Approve again.`); e.build = store.read(id); throw e; }
      if (specDigest(folder) !== r.work.builder.handed_spec) {
        await change(id, (b, ev) => {
          const doc = docOf(b);
          const here = (pid) => stageOf(doc, pid) === "requirements";
          const way = doc.deviations.find((d) => here(d.from) && here(d.to));
          if (way) ev({ type: "deviated", key: way.key, from: way.from, to: way.to, by, text: "The builder pushed a new spec", steps: [] });
          b.stages.requirements.state = "working";
          b.status = "working";
          say(b.stages.requirements.log, `The builder pushed a new spec (${read.sha.slice(0, 7)}) after the one you read, so nothing was approved. It is handed to you now.`);
          say(b.log, "The builder pushed a new spec after the one you read: read it, then approve it.");
        });
        await advance(id);
        const e = new Refused(409, `Nothing was approved: the builder pushed a new spec (${read.sha.slice(0, 7)}) after the one you read. It is handed to you now; read it and approve it.`);
        e.build = store.read(id);
        throw e;
      }
    }
    const said = words(needs?.changes);
    if (name === "changes" && !said) throw new Refused(400, "Say what should change.");
    if (name === "back_to_test" && !said) throw new Refused(400, "Say what is wrong with the suite: the test writer revises it from your words.");
    if (name === "back_to_requirements" && !said) throw new Refused(400, "Say what should change in the spec: the spec writer revises it from your words.");
    const onPr = r.settings.code.holder === "pull-request" && r.at === "code" && r.work.pr;
    const refusedHere = (status, why) => { const e = new Refused(status, why); e.build = store.read(id); return e; };

    // Your OK on the pull request: the scripts from the exact commit the gate passed, merged there.
    let took = null;
    if (name === "accept" && onPr) {
      if (busy.has(id)) await busy.get(id);
      const c = connect(r.settings.repository, env);
      if (c.problem) throw refusedHere(409, c.problem);
      const t = await takePullRequest(c.gh, store.read(id).work.pr);
      if (!t.ok) {
        await store.update(id, (b) => say(b.stages.code.log, `Your OK was not taken: ${t.reason}`));
        throw refusedHere(409, t.reason);
      }
      const at = join(dirOf(id), "stages", "code", "accepted", t.sha.slice(0, 12));
      const files = [];
      for (const f of t.scripts) {
        const to = join(at, ...f.path.split("/"));
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, f.bytes);
        files.push({ name: f.path, path: rel(dirOf(id), to), media_type: "text/javascript" });
      }
      took = { ...t, files };
    }
    let backTo = null;
    if (name === "back_to_test") {
      const doc = docOf(r);
      // The document's way back from Code: [conflict], to the person's gate on the spec.
      backTo = doc.deviations.find((d) => stageOf(doc, d.from) === "code" && stageOf(doc, d.to) === "requirements" && holderOf(doc, d.to) === "person");
      if (!backTo) throw refusedHere(409, "This build's process has no way back from Code, so it cannot be sent back to Test.");
    }
    // Send back to Requirements (0.4.7): the same way back from Code to the spec's gate, then the spec's
    // own way back to the spec writer ([changes]), so the spec is revised, not kept.
    let toSpec = null;
    if (name === "back_to_requirements") {
      const doc = docOf(r);
      backTo = doc.deviations.find((d) => stageOf(doc, d.from) === "code" && stageOf(doc, d.to) === "requirements" && holderOf(doc, d.to) === "person");
      toSpec = backTo ? doc.deviations.find((d) => d.from === backTo.to && stageOf(doc, d.to) === "requirements" && holderOf(doc, d.to) !== "person") : null;
      if (!backTo || !toSpec) throw refusedHere(409, "This build's process has no way back from Code to the spec, so it cannot be sent back to Requirements.");
    }

    // One builder (lifecycle API 0.5.0): send the build folder back to an earlier stage, with your words.
    const oneBuilder = builtByOne(docOf(r));
    let sentBackTo = null;
    let toApproval = null;
    if (name === "send_back") {
      const want = words(needs?.to);
      const offered = actionsOf(r).find((x) => x.name === "send_back")?.needs.find((x) => x.name === "to")?.options ?? [];
      if (!offered.includes(want)) throw refusedHere(400, `Choose the stage to send the build back to: ${offered.join(", ")}.`);
      if (!said) throw refusedHere(400, "Say what should change: the stage opens again with your words.");
      const folder = builderFolder(id);
      if (existsSync(join(folder, ".adlc"))) {
        // The person's words go with the send back, in the same commit: the
        // builder reads them at the end of request.md, as it reads Changes.
        const back = await onBranch(r, async () => {
          const res = await sendFolderBack(folder, want, { env: agentEnv() });
          if (res.ok) addChanges(folder, said);
          return res;
        }, `Product Factory: you sent the build back to ${want === "requirements" ? "the spec" : "the start of the build"}`);
        if (!back.ok) throw refusedHere(409, back.reply);
      }
      if (want === "requirements") {
        const doc = docOf(r);
        const bpid = Object.keys(r.run.phases).find((x) => holderOf(doc, x) === "builder");
        backTo = doc.deviations.find((d) => d.from === bpid && stageOf(doc, d.to) === "requirements" && holderOf(doc, d.to) === "person");
        toApproval = backTo ? doc.deviations.find((d) => d.from === backTo.to && stageOf(doc, d.to) === "requirements" && holderOf(doc, d.to) !== "person") : null;
        if (!backTo || !toApproval) throw refusedHere(409, "This build's process has no way back from the build to the spec.");
      }
      sentBackTo = want;
    }
    // Your answers to what only you can answer in the build folder, one per line as key: answer.
    if (name === "changes" && oneBuilder && BUILDER_STAGES.includes(r.at) && r.work.builder?.questions?.length) {
      const answers = {};
      for (const line of said.split(/\r?\n/)) { const m = /^\s*([a-z0-9-]+)\s*:\s*(.+)$/i.exec(line); if (m) answers[m[1]] = m[2].trim(); }
      if (!Object.keys(answers).length) throw refusedHere(400, `Answer each question on its own line as key: answer, such as ${r.work.builder.questions[0].key}: yes.`);
      await onBranch(r, () => writeAnswers(builderFolder(id), answers, { said }), "Product Factory: your answers to what the build folder asked");
    }

    let go = false;
    await change(id, (b, ev) => {
      const doc = docOf(b);
      const s = b.stages[b.at];
      const last = s?.rounds[s.rounds.length - 1];
      const here = (pid) => stageOf(doc, pid) === b.at;
      if (name === "send_back") {
        const from = b.at;
        for (const st of BUILDER_STAGES.slice(Math.max(0, BUILDER_STAGES.indexOf(sentBackTo)))) if (b.stages[st]) { b.stages[st].state = "not_started"; b.stages[st].done_when_met = null; }
        say(b.stages[from].log, `You sent the build back to ${nameOf(sentBackTo)}: “${said}”`);
        if (sentBackTo === "requirements") {
          // The document's way back from the build to the spec's gate, then the spec's own way back
          // to the spec writer with your words; once you approve the revised spec, the build goes on from it.
          const t = now();
          ev({ type: "deviated", key: backTo.key, from: backTo.from, to: backTo.to, by, text: said, steps: [said], action: "send_back", at: t });
          ev({ type: "gated", phase: backTo.to, question: phaseNamed(doc, backTo.to)?.what ?? backTo.to, files: [], at: t });
          ev({ type: "deviated", key: toApproval.key, from: toApproval.from, to: toApproval.to, by, text: said, steps: [said], action: "send_back", at: t });
          const req = b.stages.requirements;
          if (req) { req.state = "working"; req.done_when_met = null; say(req.log, `You sent the build back to Requirements from ${nameOf(from)}: “${said}”`); }
          // The spec you sent back is not handed to you again: Requirements waits for the builder's revision.
          b.work.builder = { ...b.work.builder, questions: [], resumed: false, revising: true };
          b.at = "requirements";
          say(b.log, "You sent the build back to Requirements. The spec writer revises the spec from your words; once you approve it, the builder goes on from it.");
        } else {
          // Within the build folder: the whole build opens again, the tests included, and the builder goes on from your words.
          // A builder that was refused is sent the work again, as Give it more rounds does; one that waits on you goes on in place.
          const bpid = Object.keys(b.run.phases).find((x) => holderOf(doc, x) === "builder");
          const refusedPhase = b.run.phases[bpid]?.status === "refused";
          if (refusedPhase) ev({ type: "resumed", phase: bpid, reopen: reopenFrom(b, bpid), by });
          b.work.builder = { ...b.work.builder, questions: [], resumed: !refusedPhase, sent_back: { to: sentBackTo, from, words: said, by, at: now() } };
          b.at = sentBackTo;
          say(b.log, "You sent the build back to the start of the build: the architecture record, the agent's files, the tests and the code are judged again from your words, and the tests can change again.");
        }
        b.status = "working";
        go = true;
      } else if (name === "changes" && oneBuilder && BUILDER_STAGES.includes(b.at) && b.work.builder?.questions?.length) {
        s.state = "working";
        b.work.builder = { ...b.work.builder, questions: [], resumed: true };
        say(s.log, `You answered: “${said}”`);
        say(b.log, `You answered what the build folder asked. The builder goes on with your answers.`);
        b.status = "working";
        go = true;
      } else if (name === "stop") {
        ev({ type: "stopped", by, reason: "stopped in the console" });
        s.state = "stopped";
        b.status = "stopped";
        say(s.log, "You stopped the build.");
        say(b.log, `You stopped the build at ${nameOf(b.at)}.`);
      } else if (name === "archive" || name === "unarchive") {
        b.archived = name === "archive";
        say(b.log, b.archived ? "You archived the build." : "You unarchived the build.");
      } else if (name === "approve" && b.at === "deploy") {
        // The process document's "approve the deploy" gate: the person's yes, then the hand-off.
        for (let i = 0; i < 10; i++) {
          const waiting = Object.entries(b.run.phases).find(([pid, p]) => here(pid) && ["holding", "gated"].includes(p.status));
          if (!waiting) break;
          ev({ type: "approved", phase: waiting[0], by, text: "approved in the console" });
        }
        delete s.gate;
        s.state = "working";
        b.status = "working";
        say(s.log, "You approved the deploy.");
        say(b.log, "You approved the deploy.");
        go = true;
      } else if (name === "approve" || name === "accept") {
        // One answer from the person settles every phase of this stage that waits on them:
        // at Requirements the spec writer's draft (assisted) and the approve-the-spec gate.
        for (let i = 0; i < 10; i++) {
          const waiting = Object.entries(b.run.phases).find(([pid, p]) => here(pid) && ["holding", "gated"].includes(p.status));
          if (waiting) {
            // On a pull request, what goes on is the scripts at the commit you OK'd, in place of the delivery's.
            const files = took && holderOf(doc, waiting[0]) === "code" ? { files: took.files } : {};
            ev({ type: "approved", phase: waiting[0], by, text: name === "approve" ? "approved in the console" : took ? `OK'd in the console at ${took.sha.slice(0, 7)}` : "OK'd in the console", ...files });
            continue;
          }
          const ask = actionsFor(b.run, doc).find((x) => x.kind === "ask-gate" && here(x.phase));
          if (!ask) break;
          ev({ type: "gated", phase: ask.phase, question: phaseNamed(doc, ask.phase)?.what ?? ask.phase, files: [] });
        }
        if (last) last.verdict = name === "approve" ? "Approved" : "OK'd by you";
        s.state = "done";
        if (name === "approve") s.done_when_met = true;
        const yes = name === "approve" ? "You approved the spec." : "You OK'd the code.";
        say(s.log, yes);
        say(b.log, yes);
        if (took) {
          const merged = took.merged ? `, and pull request #${b.work.pr.number} was merged there as ${took.merged.slice(0, 7)}` : `; pull request #${b.work.pr.number} was already merged`;
          say(s.log, `The scripts were taken from ${took.sha.slice(0, 7)}, the commit the gate passed${merged}.`);
          s.handed_back = { words: [`The scripts at ${took.sha.slice(0, 7)}, the commit the gate passed.`], files: filesHanded(id, took.files.map((f) => ({ path: `code/${f.name}`, at: f.path }))) };
          b.work.pr.taken = { sha: took.sha, merged: took.merged, at: now() };
        }
        b.status = "working";
        go = true;
      } else if (name === "back_to_test") {
        // The person judged the suite wrong and the spec right: the document's way back from Code
        // reopens the spec's gate and every phase after it, and the same answer passes the gate again
        // with the spec as it was approved. The test writer then revises the suite from the person's words.
        const testPid = Object.keys(b.run.phases).find((x) => stageOf(doc, x) === "test");
        const lastRun = b.work.pr?.runs?.at(-1);
        b.work.back_to_test = { words: said, conflict: lastRun?.conflict ?? null, suite: b.run.phases[testPid]?.record?.files ?? [], at: now() };
        ev({ type: "deviated", key: backTo.key, from: backTo.from, to: backTo.to, by, text: said, steps: [said] });
        ev({ type: "gated", phase: backTo.to, question: phaseNamed(doc, backTo.to)?.what ?? backTo.to, files: [] });
        ev({ type: "approved", phase: backTo.to, by, text: `Sent back to Test from Code: the spec stands as approved, and the suite is revised. You said: ${said}` });
        if (b.stages.requirements) say(b.stages.requirements.log, "You sent the build back to Test from Code. The spec stands as you approved it.");
        s.state = "not_started";
        s.done_when_met = null;
        if (b.work.pr) { b.work.pr.passed = null; if (b.work.pr.fix) b.work.pr.fix.stopped = null; }
        say(s.log, `You sent the build back to Test: “${said}”`);
        say(b.log, "You sent the build back to Test. The test writer revises the suite, and the revised tests go to the pull request.");
        b.status = "working";
        go = true;
      } else if (name === "back_to_requirements") {
        // The person judged the spec wrong: the document's way back from Code reopens the spec's gate
        // and every phase after it, and the spec's own way back sends the spec writer the person's words
        // as an ask for changes. Once the person approves the revised spec, the test writer revises the
        // suite against it (testWriterStep), and Code goes on: on a pull request the revised spec and
        // suite go on the same branch as one forward commit (revisedSpecToPullRequest); here, the
        // scripts written so far carry over into the new build folder (codeStep).
        const testPid = Object.keys(b.run.phases).find((x) => stageOf(doc, x) === "test");
        const lastRun = b.work.pr?.runs?.at(-1);
        const conflict = lastRun?.conflict ?? null;
        // The approved spec (spec.json and spec.md) and the agent's own files, as the spec writer handed them back, for it to revise.
        const spec = (b.stages.requirements?.handed_back?.files ?? []).filter((f) => AGENT_FILE.test(f.path.replace(/^requirements\//, "")) || isSpecName(f.path)).map((f) => ({ name: f.path.replace(/^requirements\//, ""), path: f.at, media_type: /\.json$/.test(f.path) ? "application/json" : "text/markdown" }));
        b.work.back_to_requirements = { words: said, conflict, spec, suite: b.run.phases[testPid]?.record?.files ?? [], folder: b.work.folder ?? null, at: now() };
        delete b.work.back_to_test;
        const steps = [`${said}${conflict ? `\n\nThe coding agent said, in records/conflict.md:\n${conflict}` : ""}`];
        // One moment for the three, so the spec's gate reads as answered by this, not as a wait of its own.
        const t = now();
        ev({ type: "deviated", key: backTo.key, from: backTo.from, to: backTo.to, by, text: said, steps, action: "back_to_requirements", at: t });
        ev({ type: "gated", phase: backTo.to, question: phaseNamed(doc, backTo.to)?.what ?? backTo.to, files: [], at: t });
        ev({ type: "deviated", key: toSpec.key, from: toSpec.from, to: toSpec.to, by, text: said, steps, action: "back_to_requirements", at: t });
        s.state = "not_started";
        s.done_when_met = null;
        if (b.work.pr) { b.work.pr.passed = null; if (b.work.pr.fix) b.work.pr.fix.stopped = null; }
        say(s.log, `You sent the build back to Requirements: “${said}”`);
        const req = b.stages.requirements;
        if (req) {
          req.state = "working";
          req.done_when_met = null;
          say(req.log, `You sent the build back to Requirements from Code, asking for changes to the spec: “${said}”`);
        }
        if (b.stages.test) { b.stages.test.state = "not_started"; b.stages.test.done_when_met = null; }
        say(b.log, `You sent the build back to Requirements. The spec writer revises the spec from your words; once you approve it, the test writer revises the suite against it, and Code goes on${b.work.pr ? ` on pull request #${b.work.pr.number}` : ""}.`);
        b.at = "requirements";
        b.status = "working";
        go = true;
      } else if (name === "changes") {
        // The document's way back at this stage, such as [changes] from approve-the-spec to write-the-spec.
        const way = doc.deviations.find((d) => here(d.from) && here(d.to));
        if (last) { last.verdict = "You asked for changes"; last.back = true; last.words = firstWords(`${last.words} You said: “${said}”`, 800); }
        const prior = Object.entries(b.run.phases).some(([pid, p]) => here(pid) && p.record);
        if (way && prior) {
          ev({ type: "deviated", key: way.key, from: way.from, to: way.to, by, text: said, steps: [said] });
        } else {
          // Nothing was drafted yet: the request goes out again with the person's words added.
          const pid = Object.keys(b.run.phases).find((x) => here(x) && holderOf(doc, x) !== "person");
          b.work.text = requestText({ ...b, name: b.named ? b.name : "", more: [b.more, said].filter(Boolean).join(" ") });
          ev({ type: "resumed", phase: pid, reopen: reopenFrom(b, pid), by });
        }
        s.state = "working";
        b.status = "working";
        say(b.log, "You asked for changes to the spec.");
        go = true;
      } else if (name === "resume" && b.at === "deploy") {
        s.state = "working";
        b.status = "working";
        say(b.log, "You handed the package to your runtime again.");
        go = true;
      } else if (name === "resume") {
        const pid = Object.entries(b.run.phases).find(([x, p]) => here(x) && p.status === "refused")?.[0]
          ?? Object.keys(b.run.phases).find((x) => here(x) && holderOf(doc, x) !== "person");
        ev({ type: "resumed", phase: pid, reopen: reopenFrom(b, pid), by });
        s.state = "working";
        b.status = "working";
        say(b.log, `You ran ${nameOf(b.at)} again.`);
        go = true;
      }
    });
    if (name === "stop") { running.get(id)?.ctl.abort(); gates.get(id)?.abort(); }
    // Sent back while the fix loop runs: the round in hand ends (its harness and its gate), and the build goes back from there.
    if ((name === "back_to_test" || name === "back_to_requirements") && fixes.has(id)) { fixes.get(id).abort(); gates.get(id)?.abort(); }
    if (go) advance(id);
    return store.read(id);
  }

  /** Builds that were running when Product Factory stopped send their phase again. */
  async function resumeAll() {
    for (const r of store.list()) {
      if (r.status !== "working") continue;
      if (watched(r)) {
        // Waiting on pushes to its pull request: nothing to send again; checking the pull request goes on.
        // A gate that was running is run again on the same commit.
        const loop = fixLoopOn(r.settings);
        await store.update(r.id, (b) => {
          const p = b.work.pr;
          if (p.judging) { p.head = p.runs.at(-1)?.sha ?? p.issued_sha; p.judging = null; }
          if (!loop) say(b.log, `Product Factory started again; it goes on checking pull request #${p.number} for pushes.`);
        });
        // The fix loop runs in the build's own run, so it is sent again like any working phase, and goes on from its next round.
        if (!loop) continue;
      }
      await change(r.id, (b, ev) => {
        for (const [pid, p] of Object.entries(b.run.phases)) if (p.status === "working") ev({ type: "send-again", phase: pid, by: "Product Factory, started again" });
        say(b.log, `Product Factory started again while ${nameOf(b.at)} was running, so it runs again.`);
      });
      advance(r.id);
    }
  }

  // ---------- The spec of a version built before specs (lifecycle API 0.4.14) ----------

  const writingSpecs = new Set();
  const mediaOf = (p) => (/\.json$/.test(p) ? "application/json" : /\.md$/.test(p) ? "text/markdown" : "text/plain");

  /** The newest draft.json an earlier spec writer kept in build r's Requirements records, as { abs, media_type }, or null. */
  function earlierDraft(r) {
    const at = abs(r.id, join("stages", "requirements", "records"));
    let rounds = [];
    try { rounds = readdirSync(at).filter((n) => /^r\d+$/.test(n)).sort((a, b) => Number(b.slice(1)) - Number(a.slice(1))); } catch { return null; }
    const n = rounds.find((x) => existsSync(join(at, x, "draft.json")));
    return n ? { abs: join(at, n, "draft.json"), media_type: "application/json" } : null;
  }

  /**
   * Writes the spec of build r, made by a spec writer from before stages.json
   * 1.6.0 (the agent's own files and no spec). The spec writer's job runs in
   * stages/requirements/written-after/r<n>, given what the version was asked,
   * the earlier draft and the agent's own files, and only its spec is kept, as
   * spec_written_after. Nothing else in the version changes, nothing reruns and
   * no gate is answered. Resolves to { ok, words }.
   */
  async function writeSpecAfter(id, who = by) {
    if (writingSpecs.has(id)) return { ok: false, words: "The spec writer is writing it now." };
    const noModel = missingModel();
    if (noModel) return { ok: false, words: noModel };
    writingSpecs.add(id);
    try {
      const r = store.read(id);
      const own = (r.stages.requirements?.handed_back?.files ?? []).filter((f) => AGENT_FILE.test(f.path.replace(/^requirements\//, "")));
      const draft = earlierDraft(r);
      const n = (r.spec_written_after?.round ?? 0) + 1;
      const text = `${asked(r).replace(/\s+$/, "")}\n\nThis version (${r.name} ${r.version}) is already built: a spec writer from before specs made it, and its own files and that spec writer's draft are attached. Write the spec for the version as it was built. Keep the jobs, inputs, outputs, words and limits those files fix, and put what they leave unsettled in open.\n`;
      const res = await specWriter({
        dir: dirOf(id), adlc: config.adlc, n, signal: new AbortController().signal, env: agentEnv(), part: "written-after",
        text: withFeatures(text, r, "write-the-spec"),
        attach: [...own.map((f) => ({ abs: abs(id, f.at), media_type: mediaOf(f.path) })), ...(draft ? [draft] : [])],
      });
      const spec = res.ok ? readJsonAt(res.spec.find((f) => f.path === SPEC_JSON)?.abs) : null;
      if (!isSpec(spec)) return { ok: false, words: res.reply || "The spec writer handed back no spec." };
      const words = firstWords(res.reply);
      await change(id, (b) => {
        b.spec_written_after = {
          round: n, at: now(), by: who,
          words: `Written after version ${b.version} was built, from what it was asked, the earlier spec writer's draft and its own files.`,
          said: words,
          files: res.spec.map((f) => ({ path: `requirements/${f.path}`, at: relative(dirOf(id), f.abs).split(sep).join("/") })),
        };
        say(b.stages.requirements.log, "The spec writer wrote the spec of this version after it was built. Nothing else in the version changed.");
      });
      return { ok: true, words };
    } finally {
      writingSpecs.delete(id);
    }
  }

  return {
    start, act, resumeAll, startDrift,
    /** Writes the spec of a version built before specs (lifecycle API 0.4.14). */
    writeSpecAfter,
    /** Whether the spec of build id is being written now. */
    writingSpec: (id) => writingSpecs.has(id),
    /** Checks one build's pull request for a new push now, and runs the gate on it. */
    poll,
    /** Checks every watched pull request now. */
    pollAll,
    /** Checks every watched pull request every poll_seconds (product-factory.json repository.poll_seconds), until stopAll. */
    watch: () => {
      if (pollTimer || !config.repository) return;
      pollTimer = setInterval(() => { pollAll().catch(() => {}); }, config.repository.poll_seconds * 1000);
      pollTimer.unref?.();
    },
    /** The build's timeline (build.timeline): one bar per phase per round, with its stage. */
    timelineOf: (r) => { try { return r?.run ? timelineOf(r.run, docOf(r)) : []; } catch { return []; } },
    /** Resolves when the build has nothing running. */
    idle: async (id) => {
      for (let guard = 0; guard < 1000; guard++) {
        const waits = [...running].filter(([k]) => k === id).map(([, e]) => e.done).concat([...busy].filter(([k]) => k === id).map(([, p]) => p));
        if (!waits.length) return;
        await Promise.all(waits);
      }
    },
    stopAll: () => {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      for (const e of running.values()) e.ctl.abort();
      for (const g of gates.values()) g.abort();
      return Promise.all([...running.values()].map((e) => e.done).concat([...busy.values()]));
    },
  };
}
