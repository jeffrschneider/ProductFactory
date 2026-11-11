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
// whose roster names the runtime for deploy-the-agent (make-a-new-agent.txt v3)
// goes on: the runtime's answer is that phase's delivery, check-conformance
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
// Each feature in a run of its own (make-a-new-agent.txt v2, make-a-feature.txt,
// feature-runs.mjs): the version's run waits at gather-the-features, where a
// run starts for each approved feature (startFeatureRuns), and a feature
// approved later starts its own then (featuresApproved). Each run is driven by
// its key, "<build id>~<run id>", through the lens store, at the same time as
// the others. Its OK makes its suite and scripts the version's base
// (accepted), and every other run at Code is brought up to date with it
// (syncRun). Once every run has closed, gather-the-features delivers the
// scripts and the version goes on to Package (gathered).
//
// Every step writes the run's state and what the console shows into
// build.json before the next starts, so a build that was running when Product
// Factory stopped sends its phase again when it starts.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Refused } from "./lifecycle.mjs";
import { openRun, parse, actionsFor, event, stageOf, holderOf, RUNS, phaseNamed, saveRun, timelineOf, phaseMaterial, madeByFeature, rosterOf } from "./orchestrator.mjs";
import { stageById, roleById, STAGES_DOC } from "./standards.mjs";
import { modelEnv, localPerson, credentialNames } from "./config.mjs";
import { withoutEnv } from "./exec.mjs";
import { RECORD_FORMAT } from "./store.mjs";
import { actionsOf } from "./view.mjs";
import { specWriter, solutionArchitect, RECORD_PIECE, testWriter, handOff, codeWriterWorkspace, codeRound, scriptsHanded, pack, requestText, reviewer, reviewerMissing, reverseEngineer, checkFolder, fixHarness, AS_BUILT_FILES, AS_BUILT_TYPES, CARRIED_RECORD, isTestFile } from "./adapters.mjs";
import { fixLoopOn, fixRoundsOf, fixPrompt, findingsText, writeFolder, snapshotOf, changesOf, roundFiles, stopOf, tookWords, pathWords } from "./fix-loop.mjs";
import { sourceOf, checkout, adoptable, adoptInto, namedScripts, codeFiles, short } from "./adopt.mjs";
import { recordSourceOf, fetchRecord, carriedOf, supportType, CARRIED_FOLDERS } from "./as-built-record.mjs";
import { connect, openPullRequest, pullRequestHead, readCommitFiles, postResult, revisePullRequest, takePullRequest, readBuildFolder, slugOf, readBranchFolder, commitFixRound, upToDatePullRequest } from "./pull-request.mjs";
import { judgeFolder, runGateSuite } from "./gate.mjs";
import { digestOf, LOCK_FILE } from "./fence.mjs";
import { REVIEWERS, SPENDING_LIMIT_DEFAULT, packageFiles, changeDiff, requestText as reviewText, judgeRun, finalVerdict } from "./review.mjs";
import { writeTarGz } from "./tar.mjs";
import { createRuntime } from "./runtime.mjs";
import { registerOf, eventsOf, buildsUpTo, materialLines, byFeature, byFeatureWords, asBuiltProposals, openAsBuilt, specProposals } from "./features.mjs";
import { testNames, gapWords } from "./artifacts.mjs";
import { specFilesOf, specOfBuild, specFeatures, isSpecName, isSpec, SPEC_JSON } from "./spec.mjs";
import { choiceOf, sameChoice } from "./cadence.mjs";
import { checkConformance, ATTESTATION_FILE } from "./conformance.mjs";
import { lensStore, runKey, keyParts, hasFeatureRuns, runWords, runEnded, upToDate, suiteWith, FEATURE_ALL, RUN_STAGES, UP_TO_DATE_FILE } from "./feature-runs.mjs";

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
  // The Architecture part, then the Design (make-a-new-agent.txt v3).
  architecture: "The spec from Requirements, as you approved it, for the solution architect to write the architecture record from. Product Factory holds no organization's stack, so each system is bound to the platform's default or asked. Then the spec writer makes the agent's own files again from the spec, within the record.",
  test: "The spec from Requirements, as you approved it (spec.json), and the agent's own files made from it at Design: agent-descriptor.json, agent-runtime-requirements.json, plugin.json and a SKILL.md per skill.",
  code: "The spec, the agent's files and the suite, laid out as a build folder with AGENTS.md (the hand-off contract), .adlc/check.mjs and build.lock.json.",
  "code-pr": "The spec, the agent's files and the suite, laid out as a build folder with AGENTS.md (the hand-off contract), .adlc/check.mjs and build.lock.json, on a \"Write the scripts\" pull request your coding harness pushes to.",
  "code-pr-loop": "The spec, the agent's files and the suite, laid out as a build folder with AGENTS.md (the hand-off contract), .adlc/check.mjs and build.lock.json, on a \"Write the scripts\" pull request. Product Factory runs your coding harness on it in the fix loop: each round's scripts go on the branch as one commit, and the gate's findings go back to the harness in the next round.",
  package: "The agent's files as you approved them, and the scripts Code wrote, placed under each skill as plugin.json's build entry names them.",
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
  return {
    requirements: { kind: "reference_agent", name: "spec-writer", role: "spec-writer" },
    // Only a build whose process has an architecture phase keeps this stage (start).
    architecture: { kind: "reference_agent", name: "solution-architect", role: "solution-architect" },
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

export function createRunner({ store: kept, lifecycle, config, env = process.env, person = localPerson(), now = () => new Date().toISOString() }) {
  // A feature's own run is read and changed through its key, "<build id>~<run id>", as if it were a build (feature-runs.mjs).
  const store = lensStore(kept);
  const running = new Map();
  const by = person.email;
  const runtime = createRuntime({ store: kept, config, env, now });

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
    const own = absOf(id, suite).map((f, i) => ({ ...f, path: suite[i].name, name: suite[i].name }));
    // A feature's own run: its tests go beside every test of the features already accepted (feature-runs.mjs).
    const r = keyParts(id).run ? store.read(id) : null;
    const whole = r ? suiteWith(own, baseSuite(r).map((f) => ({ ...f, path: f.name }))) : own;
    return { spec: absOf(id, specFilesOf(files)), agentFiles: absOf(id, files.filter((f) => AGENT_FILE.test(f.name))), suite: whole.map(({ name, ...f }) => f) };
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
    // A feature's own run reads its version's features, and is given its own feature's lines alone.
    const self = r.feature_run ? store.read(r.build) : r;
    const builds = store.list().filter((b) => b.name === self.name);
    const reg = registerOf(eventsOf(buildsUpTo(builds.some((b) => b.id === self.id) ? builds : [...builds, self], self)));
    // A build started from existing code also carries the code as built (asBuiltLines). With a spec (stages.json 1.6.0), tests are named by its scenarios.
    const scenarios = Boolean(specOfBuild(self, dirOf(self.id)));
    const list = [...reg.values()].filter((f) => !r.feature_run || r.feature === FEATURE_ALL || f.id === r.feature).sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
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

  // ---------- Architecture and Design: the solution architect, then the Design (make-a-new-agent.txt v3) ----------

  /** A build's architecture record as its Architecture stage handed it back: { abs, at } in its folder, or null. */
  function recordOf(b) {
    const f = (b?.stages?.architecture?.handed_back?.files ?? []).find((x) => x.path === `architecture/${RECORD_PIECE}`);
    return f ? { abs: abs(b.id, f.at), at: f.at } : null;
  }

  /**
   * The record a new version carries forward (stages.json: Architecture's cadence is
   * setup): the newest earlier build of the product whose record is finished and whose
   * lifecycle chose the same holder and settings for the stage (cadence.mjs), or null,
   * and the solution architect writes one.
   */
  function carriedRecord(r) {
    const mine = choiceOf(r.lifecycle, "architecture");
    return store.list()
      .filter((b) => b.name === r.name && b.id !== r.id && String(b.created) < String(r.created) && b.work?.architecture?.done && recordOf(b))
      .sort((x, y) => String(y.created).localeCompare(String(x.created)))
      .find((b) => sameChoice(choiceOf(b.lifecycle, "architecture"), mine)) ?? null;
  }

  /** The statement of the job the architecture is written from: the person's own words, as Requirements was asked them. */
  const statementText = (r) => `${asked(r).replace(/^Write a spec\.\n/, "").trim()}\n`;

  /**
   * write-the-architecture: the solution architect writes the record from the
   * spec as the owner approved it. A record this build already finished stands
   * (a way back reopened the phase), and a record an earlier version finished is
   * carried forward unchanged: neither asks the architect again. A record with a
   * question open is the architect's question to the owner (the runner's block):
   * the build waits for the answers (act "changes"), and the architect revises
   * the record with them.
   */
  async function architectStep(r, action, stage, signal) {
    const id = r.id;
    const own = r.work.architecture?.done ? recordOf(r) : null;
    const from = own ? null : carriedRecord(r);
    const answers = words(r.work.architecture?.answers);
    if (action.kind !== "send-answer") {
      await sent(id, action, stage, own ? "The architecture record this build finished stands." : from ? `Carried forward from ${from.version}.` : "Sent to the solution architect with the spec as you approved it.");
    } else {
      await change(id, (b) => { const s = b.stages[stage]; s.state = "working"; s.runs += 1; say(s.log, "Sent back to the solution architect with your answers."); });
    }
    const n = store.read(id).stages[stage].runs;
    const deliver = (said, file, extra = {}) => change(id, (b, ev) => {
      if (b.status !== "working") return;
      const s = b.stages[stage];
      s.rounds.push({ n, at: now(), label: `Round ${n}`, verdict: extra.verdict ?? "Record finished", back: false, words: firstWords(said) });
      s.handed_back = { words: [said], files: filesHanded(id, [{ path: `architecture/${RECORD_PIECE}`, at: file }]) };
      s.state = "working";
      s.done_when_met = true;
      say(s.log, extra.said ?? "The architecture record is finished: the spec writer makes the agent's own files within it next.");
      b.work.architecture = { record: file, n, done: true, questions: 0, ...(extra.carried ? { carried: extra.carried } : {}) };
      delivered(b, ev, action, said, [{ name: RECORD_PIECE, path: file, media_type: "text/markdown" }]);
    });
    if (own) return deliver(`The architecture record this build finished in round ${r.work.architecture.n} stands: Architecture is set up once for a product, so the solution architect is not asked again.`, own.at, { verdict: "Stands as written", said: "The record stands as written." });
    if (from) {
      const to = join(dirOf(id), "stages", "architecture", `r${n}`, "carried", RECORD_PIECE);
      mkdirSync(dirname(to), { recursive: true });
      cpSync(recordOf(from).abs, to);
      const said = `Unchanged since ${from.version}: the architecture record ${from.name} ${from.version} finished is carried forward, because Architecture is set up once for a product and its holder and settings are the same. The solution architect is not asked again.`;
      return deliver(said, rel(dirOf(id), to), { verdict: `Unchanged since ${from.version}`, said, carried: { build: from.id, version: from.version } });
    }
    const noModel = missingModel();
    if (noModel) return refused(id, action, stage, noModel, { round: { n, at: now(), label: `Round ${n}`, verdict: "Not run", back: false, words: noModel } });
    // The statement goes as a file beside the spec, so the architect reads both as the statement; a revision sends the record back with the answers.
    const base = join(dirOf(id), "stages", "architecture", `r${n}`);
    mkdirSync(base, { recursive: true });
    const prior = recordOf(r);
    let text;
    let attach;
    if (answers && prior) {
      // The revise-the-architecture skill reads each "key: answer" line under a key the record asked.
      text = `Revise the architecture record:\n${answers}\n`;
      attach = [{ abs: prior.abs, media_type: "text/markdown" }];
    } else {
      writeFileSync(join(base, "statement.md"), statementText(r));
      text = "Write the architecture, with the statement attached.\n";
      const md = specFilesOf(handed(action)).filter((f) => !f.name.endsWith(".json"));
      attach = [{ abs: join(base, "statement.md"), media_type: "text/markdown" }, ...absOf(id, md)];
    }
    const res = await solutionArchitect({ dir: dirOf(id), adlc: config.adlc, n, text, attach, env: agentEnv(), signal });
    if (signal.aborted) return;
    if (!res.ok) return refused(id, action, stage, res.reply, { round: { n, at: now(), label: `Round ${n}`, verdict: "Refused", back: false, words: firstWords(res.reply) }, handed: res.handed ?? [] });
    const file = rel(dirOf(id), res.record.abs);
    if (!res.questions) return deliver(res.reply, file, { said: "The architecture record is finished: the spec writer makes the agent's own files within it next." });
    // What only a person can answer: the record goes to the owner with its questions, and nothing is filled in.
    await change(id, (b, ev) => {
      if (b.status !== "working") return;
      const s = b.stages[stage];
      s.rounds.push({ n, at: now(), label: `Round ${n}`, verdict: "Asks you", back: false, words: firstWords(res.reply) });
      s.handed_back = { words: [res.reply], files: filesHanded(id, res.handed) };
      s.done_when_met = false;
      say(s.log, `The record asks ${res.questions === 1 ? "one question" : `${res.questions} questions`} only you can answer; nothing in it is filled in for you.`);
      b.work.architecture = { record: file, n, done: false, questions: res.questions };
      ev({ type: "replied", phase: action.phase, from: action.to, handle: action.to, text: res.reply, files: res.handed.map((f) => ({ name: f.path.replace(/^architecture\//, ""), path: f.at, media_type: "text/markdown" })), verdict: "block" });
    });
  }

  /**
   * design-the-agent: the Design part of Architecture and Design. The spec writer's
   * job again, given the spec as the owner approved it and the architecture record,
   * as an answer about the approved spec, so the spec stays as it was and the agent's
   * own files are made again from it, within the record (agents/spec-writer: "Given
   * an architecture record, the files declare exactly the systems the record names").
   */
  async function designStep(r, action, stage, signal) {
    const id = r.id;
    await sent(id, action, stage, "Sent to the spec writer for the Design, with the spec as you approved it and the architecture record.");
    // The Design's own jobs are counted apart (its folder, design/r<n>); its rounds go on the stage's count.
    const n = (r.work.design_runs ?? 0) + 1;
    await store.update(id, (b) => { b.work.design_runs = n; });
    const runs = store.read(id).stages[stage].runs;
    const noModel = missingModel();
    if (noModel) return refused(id, action, stage, noModel, { round: { n: runs, at: now(), label: `Design ${n}`, verdict: "Not run", back: false, words: noModel } });
    const files = handed(action);
    const record = files.filter((f) => f.name === RECORD_PIECE);
    const res = await specWriter({
      dir: dirOf(id), adlc: config.adlc, n, signal, env: agentEnv(), part: "design",
      text: "answer: Make the agent's own files from the approved spec attached, within the architecture record attached.\n",
      attach: absOf(id, [...specFilesOf(files), ...record]),
    });
    if (signal.aborted) return;
    const round = { n: runs, at: now(), label: `Design ${n}`, verdict: res.ok ? "The agent's own files made" : "Refused", back: false, words: firstWords(res.reply) };
    if (!res.ok) return refused(id, action, stage, res.reply, { round, handed: [...(store.read(id).stages[stage].handed_back.files ?? []).map((f) => ({ path: f.path, at: f.at })), ...(res.handed ?? [])] });
    await change(id, (b, ev) => {
      if (b.status !== "working") return;
      const s = b.stages[stage];
      s.rounds.push(round);
      const kept = s.handed_back.files.filter((f) => !/^design\//.test(f.path)).map((f) => ({ path: f.path, at: f.at }));
      s.handed_back = { words: [...s.handed_back.words.slice(0, 1), res.reply], files: filesHanded(id, [...kept, ...res.handed]) };
      s.state = "done";
      s.done_when_met = true;
      say(s.log, record.length ? "The spec writer made the agent's own files again from the spec, within the architecture record." : "The spec writer made the agent's own files again from the spec.");
      delivered(b, ev, action, res.reply, asFiles(id, res.agentFiles));
    });
  }

  /**
   * A build whose lifecycle leaves out Architecture and Design: neither phase runs.
   * write-the-architecture hands on no record, and design-the-agent hands on the
   * agent's own files as the spec was approved with them, so the build goes on as
   * it did before the stage ran.
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
            : featureAsk(r);
    const text = withFeatures(said, r, action.phase);
    // A build with an as-built record: its behaviors, interfaces, architecture as built, and existing tests and gaps go with it, whole.
    // The original's own tests, with the files they import and the carried manifest, go with a first suite; a revision's suite carries their record already.
    // A feature's own run is given the tests of the features already accepted, to add its own to.
    const accepted = !back && r.feature_run && r.feature !== FEATURE_ALL ? baseSuite(r).map((f) => ({ abs: f.abs, media_type: f.media_type || "text/javascript" })) : [];
    const attach = [...(back ? back.suite.map((f) => ({ abs: abs(id, f.path), media_type: f.media_type || "text/javascript" })) : []), ...accepted, ...recordParts(r), ...(back ? [] : carriedParts(r, n))];
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
    const p = b.work?.pr;
    if (!p || p.note === words) return;
    p.note = words;
    if (b.stages.code) say(b.stages.code.log, words);
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
      // A feature's own run starts from the scripts the features already accepted merged, not from stubs.
      const placed = placeBaseScripts(r, h.folder);
      const read = readBuildFolder(h.folder);
      if (!read.ok) return refused(id, action, stage, read.reason);
      const fresh = store.read(id);
      const agent = slugOf(fresh.name, keyParts(id).build.replace(/_/g, "-"));
      // The whole spec in one run has the version's pull request, as a build in one chain does; a feature has one of its own.
      const feature = r.feature_run && r.feature !== FEATURE_ALL ? { id: r.feature_run, words: runWords(r) } : null;
      const opened = await openPullRequest({ gh: c.gh, repo: c.repo, agent, version: fresh.version, folder: read.folder, feature, now: () => new Date(now()) });
      if (signal.aborted) return;
      if (!opened.ok) return refused(id, action, stage, opened.reason);
      const p = opened.record;
      const loop = fixLoopOn(r.settings);
      await change(id, (b) => {
        if (b.status !== "working") return;
        b.work.folder = rel(dir, h.folder);
        b.work.pr = p;
        if (b.feature_run) { p.base_n = placed.n; if (placed.files.length) say(b.stages[stage].log, `The scripts the features already accepted merged are the first version of this feature's: ${placed.files.join(", ")}.`); }
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
    // A feature's own run keeps the tests of the features already accepted beside its own.
    const names = new Set([...suite.map((f) => f.name), ...(r.feature_run ? baseSuite(r).map((f) => f.name) : [])]);
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
  async function reviews(r, pr, sha, judged, tested, base, signal) {
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
      const record = rv.id === "security" ? recordOf(versionOf(r)) : null;
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
    return { ...finalVerdict({ tested, asks, skipped }), reviews: asks, skipped };
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
    // A version whose features are made in runs of their own: each run's pull request is checked; the answer is the last one judged.
    const v = keyParts(id).run ? null : store.read(id);
    if (hasFeatureRuns(v)) {
      return (async () => {
        let out = { judged: false };
        for (const fr of v.feature_runs) {
          const got = await poll(runKey(id, fr.id));
          if (got?.judged || !out.judged) out = got ?? out;
        }
        return out;
      })();
    }
    if (busy.has(id)) return busy.get(id);
    const job = (async () => {
      const r = store.read(id);
      if (!watched(r)) return { judged: false };
      const c = connect(r.settings.repository, env);
      if (c.problem) { await noteOnce(id, c.problem); return { judged: false }; }
      // Another feature was accepted since this pull request last met the base: it is brought up to date before its gate runs.
      if (behind(r) && !fixes.has(id)) await syncPullRequest(id, c);
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
    for (const r of everyRun()) if (watched(r)) await poll(r.id);
  }

  /** Every build, and every feature run of each, as the runner reads them. */
  function everyRun() {
    return store.list().flatMap((b) => [b, ...(b.feature_runs ?? []).map((fr) => store.read(runKey(b.id, fr.id))).filter(Boolean)]);
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
      // Another feature was accepted since this pull request last met the base: the round starts from it brought up to date.
      if (behind(store.read(id))) await syncPullRequest(id, c);
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
      const note = files.get(UP_TO_DATE_FILE);
      const prompt = fixPrompt({ round: k, last, upToDate: note ? Buffer.from(note).toString("utf8") : null });
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
      // A feature's own run starts from the scripts the features already accepted merged, not from stubs;
      // after Send back to Requirements it goes on from its own, which met the base before.
      const placed = kept.length ? { n: r.work.base_n ?? 0, files: [], synced: r.feature_run ? syncedCopy(id, folder, r.work.base_n ?? 0) : null } : placeBaseScripts(r, folder);
      await store.update(id, (b) => {
        b.work.folder = rel(dir, folder);
        if (records) b.work.records = rel(dir, records);
        say(b.stages[stage].log, `The build folder is laid out at ${folder}, with AGENTS.md.`);
        if (kept.length) say(b.stages[stage].log, `The scripts written before the build went back to Requirements are in it, over the stubs: ${kept.map((k) => k.path).join(", ")}.`);
        if (b.feature_run) {
          b.work.base_n = placed.n;
          b.work.synced = placed.synced;
          if (placed.files.length) say(b.stages[stage].log, `The scripts the features already accepted merged are the first version of this feature's: ${placed.files.join(", ")}.`);
        }
        delete b.work.back_to_requirements;
      });
    } else {
      folder = abs(id, folder);
      if (records) records = abs(id, records);
    }
    let feedback = r.work.feedback ? abs(id, r.work.feedback) : null;
    const limit = r.settings.code.rounds;
    for (let k = 1; k <= limit; k++) {
      // Another feature was accepted since this folder was laid out: it is brought up to date with it first.
      if (behind(store.read(id))) {
        const u = await relayLocal(id, action, stage, signal);
        if (signal.aborted) return;
        if (!u.ok) return refused(id, action, stage, u.reason);
        ({ folder, records } = u);
        // The note of the scripts both changed goes to the harness as what to work in first.
        feedback = u.note;
      }
      const n = store.read(id).stages[stage].rounds.length + 1;
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
    if (r.feature_run) await runClosed(r.id);
  }

  // ---------- each feature in a run of its own (make-a-feature.txt, feature-runs.mjs) ----------

  /** The version's gather-the-features phase, where it waits while its features are made. */
  const gatherOf = (v) => { const doc = docOf(v); return Object.keys(v.run.phases).find((x) => holderOf(doc, x) === "features") ?? null; };
  /** Whether the version is making its features now: gather-the-features has its work out. */
  const gatheringNow = (v) => Boolean(v && hasFeatureRuns(v) && v.status === "working" && v.run.phases[gatherOf(v)]?.status === "working");
  /** The version a record belongs to: itself, or a feature run's version. */
  const versionOf = (r) => (r?.feature_run ? store.read(r.build) : r);

  /** The tests of the features already accepted (build.json "base"), each with its place on disk: [{ name, abs, media_type }]. */
  function baseSuite(r) {
    const v = versionOf(r);
    return (v?.base?.suite ?? []).map((f) => ({ name: f.name, abs: abs(v.id, f.path), media_type: f.media_type || "text/javascript" }));
  }

  /** The scripts the last feature accepted merged, by path in the build folder: Map<path, bytes>. */
  function baseScripts(r) {
    const v = versionOf(r);
    const out = new Map();
    for (const f of v?.base?.scripts ?? []) { try { out.set(f.name, readFileSync(abs(v.id, f.path))); } catch { /* gone */ } }
    return out;
  }

  /** The scripts under a build folder: Map<path, bytes>. */
  function scriptsIn(folder) {
    const out = new Map();
    const base = join(folder, "scripts");
    const walk = (d) => {
      let names = [];
      try { names = readdirSync(d); } catch { return; }
      for (const name of names.sort()) {
        const at = join(d, name);
        const st = statSync(at);
        if (st.isDirectory()) walk(at);
        else if (st.isFile()) out.set(`scripts/${rel(base, at)}`, readFileSync(at));
      }
    };
    walk(base);
    return out;
  }

  /** Files written into a folder by their path in it. */
  const writeInto = (folder, files) => {
    for (const [p, bytes] of files) {
      const to = join(folder, ...p.split("/"));
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, bytes);
    }
  };

  /** A copy of the folder's scripts as they meet the base, for the next time it moves: its place in the run's folder. */
  function syncedCopy(id, folder, n) {
    const to = join(dirOf(id), "stages", "code", "synced", `b${n}`);
    writeInto(to, scriptsIn(folder));
    return rel(dirOf(id), to);
  }

  /**
   * A feature run's build folder starts from the scripts the features already
   * accepted merged, in place of the stubs the hand-off writes. Returns
   * { n, files, synced }: the base it met, the scripts placed, and the copy of
   * them kept for the next time the base moves. Nothing for a version's own run.
   */
  function placeBaseScripts(r, folder) {
    if (!r.feature_run) return { n: 0, files: [], synced: null };
    const n = versionOf(r)?.base?.n ?? 0;
    const scripts = baseScripts(r);
    writeInto(folder, scripts);
    return { n, files: [...scripts.keys()], synced: syncedCopy(r.id, folder, n) };
  }

  /** Whether another feature was accepted since this run's code last met the base. */
  const behind = (r) => Boolean(r?.feature_run && r.work?.behind);

  /** What the test writer is asked in a feature's own run: that feature's tests alone, added to the accepted ones (test-writer 0.11.0). */
  function featureAsk(r) {
    if (!r.feature_run || r.feature === FEATURE_ALL) return "Write the suite for the spec and the agent's files attached.\n";
    const added = baseSuite(r).length > 0;
    return `Write the tests of feature ${r.feature}${r.title ? ` (${r.title})` : ""} alone, from the spec and the agent's files attached${added ? ", and add them to the suite attached, which holds the tests of the features of this version already accepted. Leave every test of the suite attached as it is" : ""}. Name each test file for the feature.\n\nfeature: ${r.feature}\n`;
  }

  /**
   * The files a version's features are made from: the spec as approve-the-spec handed it
   * on, and the agent's own files, made again at the Design within the architecture record
   * where the version has one (make-a-new-agent.txt v3, [designed]), else as the spec was
   * approved with them.
   */
  function approvedFiles(v) {
    const of = (key) => (Object.values(v.run.handoffs ?? {}).find((x) => x.key === key) ?? v.run.handoffs?.[key])?.files ?? [];
    const designed = of("designed").filter((f) => AGENT_FILE.test(f.name));
    if (designed.length) return [...of("approved-spec").filter((f) => isSpecName(f.name)), ...designed];
    return of("approved-spec").filter((f) => AGENT_FILE.test(f.name) || isSpecName(f.name));
  }

  /** A new feature run on version b: its own document and run, with what its trigger carries copied into its folder. */
  function featureRun(b, f, n) {
    const id = n > 1 ? `${f.id}-${n}` : f.id;
    const key = runKey(b.id, id);
    const dir = dirOf(key);
    const at = now();
    const given = [];
    for (const g of approvedFiles(b)) {
      const to = join(dir, "given", ...g.name.split("/"));
      mkdirSync(dirname(to), { recursive: true });
      cpSync(abs(b.id, g.path), to);
      given.push({ name: g.name, path: `given/${g.name}`, media_type: g.media_type ?? "" });
    }
    const spec = given.find((g) => g.name === SPEC_JSON);
    const digest = spec ? digestOf(readFileSync(join(dir, spec.path))) : null;
    const suite = b.base?.suite ?? [];
    const what = f.id === FEATURE_ALL ? "The whole spec" : `${f.id}${f.name ? ` ${f.name}` : ""}`;
    // What the run's trigger carries (make-a-feature.txt), one material line per item.
    const material = [
      `spec: ${spec ? `spec.json at ${digest}` : "the agent's own files"}, approved for ${b.name} ${b.version}`,
      `feature: ${f.id === FEATURE_ALL ? FEATURE_ALL : what}`,
      ...(suite.length ? [`suite: ${suite.length} test file${suite.length === 1 ? "" : "s"} of the features already accepted`] : []),
    ].join("\n");
    const owner = b.run.owner ?? by;
    const opened = openRun({ person: owner, day: at.slice(0, 10), settings: b.settings, material, files: given, startedAt: at, feature: true });
    mkdirSync(join(dir, "run"), { recursive: true });
    writeFileSync(join(dir, "run", "document.txt"), opened.text);
    saveRun(join(dir, "run"), opened.state);
    const stages = {};
    for (const s of RUN_STAGES) {
      if (!b.stages[s]) continue;
      stages[s] = {
        state: "not_started", holder: b.stages[s].holder, runs: 0, rounds: [],
        given: s === "test"
          ? `${b.stages[s].given} This run writes the tests of ${f.id === FEATURE_ALL ? "the whole spec" : `${what} alone`}${suite.length ? ", added to the tests of the features already accepted" : ""}, from the spec at ${digest ? digest.slice(0, 19) : "its approval"}.`
          : f.id === FEATURE_ALL ? b.stages[s].given : `${b.stages[s].given} The suite is this feature's tests and every test of the features already accepted, so the gate holds the scripts to all of them.`,
        handed_back: { words: [], files: [] }, done_when_met: null, log: [],
      };
    }
    return {
      id, feature: f.id, title: f.id === FEATURE_ALL ? "" : f.name ?? "", started: at, by: owner,
      process: "run/document.txt", run: opened.state, status: "working", at: stages.test ? "test" : "code",
      stages, work: {}, given, log: [{ at, said: `Started for ${what}, running the process ${opened.state.process.name} (${opened.state.process.id} ${opened.state.process.version}).` }],
    };
  }

  /**
   * Starts a run for each approved feature of the version that has none yet,
   * and for one approved again after its run closed. A feature approved again
   * while its run is open is queued, as its concurrency line has it: a new run
   * starts once that one closes. A spec with no features at all is made in
   * one run, the whole spec. again: a feature whose last run was stopped gets
   * a new one too (Code run again). Resolves to the new runs' keys, each
   * started.
   */
  function startFeatureRuns(vid, { again = false } = {}) {
    return store.update(vid, (b) => {
      if (!gatheringNow(b)) return [];
      const builds = store.list().filter((x) => x.name === b.name && x.id !== b.id);
      const reg = registerOf(eventsOf(buildsUpTo([...builds, b], b)));
      const wanted = reg.size ? [...reg.values()].filter((f) => f.state === "approved").sort((x, y) => x.id.localeCompare(y.id, "en", { numeric: true })) : [{ id: FEATURE_ALL, name: "", approvedAt: null }];
      const keys = [];
      for (const f of wanted) {
        const runs = b.feature_runs.filter((x) => x.feature === f.id);
        const last = runs.at(-1);
        const newer = Boolean(last && f.approvedAt && f.approvedAt > last.started);
        if (last && !runEnded(last)) {
          if (newer && (b.queued ??= {})[f.id] !== f.approvedAt) {
            b.queued[f.id] = f.approvedAt;
            say(b.log, `${f.id} was approved again while its run is open, so a new run of it starts once that one closes.`);
          }
          continue;
        }
        if (last && !newer && !(again && last.status === "stopped")) continue;
        const fr = featureRun(b, f, runs.length + 1);
        b.feature_runs.push(fr);
        keys.push(runKey(b.id, fr.id));
        if (b.queued) delete b.queued[f.id];
        say(b.log, `${runWords(fr)} is made in a run of its own: its tests, its scripts and your OK.`);
      }
      if (!wanted.length && !b.feature_runs.length && !b.none_approved) {
        b.none_approved = true;
        say(b.log, "No feature of the spec is approved, so nothing is made yet. Approve a feature in the chat, and its run starts.");
      }
      return keys;
    }).then((keys) => { for (const k of keys) advance(k); return keys; });
  }

  /** gather-the-features: the version's features are each made in a run of their own, and the phase closes once every run has. */
  async function gatherStep(r, action, stage) {
    const again = Boolean(r.run.phases[action.phase]?.resumed);
    await sent(r.id, action, stage, "Each approved feature is made in a run of its own: its tests, its scripts and your OK.");
    // Back from Requirements: the runs that waited for the revised spec go on with it.
    await resumeHeld(r.id);
    await startFeatureRuns(r.id, { again });
    await gathered(r.id);
  }

  /**
   * Once every feature run of the version has closed, gather-the-features
   * delivers the scripts as the last feature accepted merged them, and the
   * version goes on to Package. When every run was stopped, nothing was made,
   * and the version waits on the person.
   */
  async function gathered(vid) {
    const v = store.read(vid);
    if (!gatheringNow(v) || !v.feature_runs.length || v.feature_runs.some((x) => !runEnded(x))) return;
    const pid = gatherOf(v);
    const action = { phase: pid, to: v.run.phases[pid].holder?.handle ?? "product-factory/feature-runs" };
    const done = v.feature_runs.filter((x) => x.status === "done");
    if (!done.length || !v.base?.scripts?.length) return refused(vid, action, "code", "Every feature's run was stopped, so no feature was made. Run Code again to make each approved feature again, or stop the build.");
    const stopped = v.feature_runs.filter((x) => x.status === "stopped" && !done.some((d) => d.feature === x.feature));
    await change(vid, (b, ev) => {
      if (!gatheringNow(b)) return;
      const s = b.stages.code;
      const files = b.base.scripts.map((f) => ({ name: f.name, path: f.path, media_type: "text/javascript" }));
      s.state = "done";
      s.done_when_met = true;
      s.handed_back = { words: [`The scripts as ${b.base.feature === FEATURE_ALL ? "the whole spec's run" : b.base.feature} merged them, the last feature accepted.`], files: filesHanded(vid, files.map((f) => ({ path: `code/${f.name}`, at: f.path }))) };
      const words = `Every feature's run closed: ${done.map(runWords).join("; ")}.${stopped.length ? ` Stopped, so not in this version: ${stopped.map(runWords).join("; ")}.` : ""}`;
      say(s.log, words);
      say(b.log, words);
      delivered(b, ev, action, words, files);
    });
    advance(vid);
  }

  /** A feature run closed (its OK, or a stop): a queued run starts, and the version goes on once every run has closed. */
  async function runClosed(key) {
    const { build } = keyParts(key);
    await startFeatureRuns(build);
    await gathered(build);
  }

  /** The code phase of a feature run as an action its own steps can be sent, with what its handoffs carry now. */
  function codeAction(r) {
    const a = codePhase(r);
    if (!a) return null;
    const files = (k) => r.run.handoffs?.[k]?.files ?? [];
    return { ...a, kind: "send-work", holder: r.run.phases[a.phase].holder ?? null, handoffs: [{ key: "trigger", files: r.given ?? [] }, { key: "suite-written", files: files("suite-written") }] };
  }

  /**
   * A feature was accepted: its suite and its scripts are the version's base
   * now, and every other open run at Code is behind it, to be brought up to
   * date before its gate runs again (syncRun). took: the pull request's
   * merge, when the OK was on one.
   */
  async function accepted(key, took) {
    const { build } = keyParts(key);
    const r = store.read(key);
    const doc = docOf(r);
    const testPid = Object.keys(r.run.phases).find((x) => stageOf(doc, x) === "test");
    const codePid = codePhase(r)?.phase;
    const inVersion = (f) => ({ name: f.name, path: `runs/${r.feature_run}/${f.path}`, media_type: f.media_type ?? "" });
    const own = (r.run.phases[testPid]?.record?.files ?? []).filter((f) => /^test\//.test(f.name)).map(inVersion);
    const code = r.run.phases[codePid];
    const scripts = ((code?.record?.files?.length ? code.record.files : code?.drafted?.files) ?? []).filter((f) => /^scripts\//.test(f.name)).map(inVersion);
    const behindNow = [];
    await store.update(build, (b) => {
      const n = (b.base?.n ?? 0) + 1;
      b.base = { n, run: r.feature_run, feature: r.feature, at: now(), ...(took?.merged ? { merged: took.merged } : {}), suite: suiteWith(own, b.base?.suite ?? []), scripts };
      for (const fr of b.feature_runs) {
        if (fr.id === r.feature_run || runEnded(fr) || fr.at !== "code") continue;
        fr.work.behind = n;
        behindNow.push(runKey(b.id, fr.id));
      }
      say(b.log, `${runWords(r)} was accepted${took?.merged ? ` and merged as ${took.merged.slice(0, 7)}` : ""}. Its tests and scripts are the version's base now${behindNow.length ? `, and ${behindNow.length === 1 ? "the other feature at Code is" : `the ${behindNow.length} other features at Code are`} brought up to date with it` : ""}.`);
    });
    for (const k of behindNow) syncRun(k);
  }

  /**
   * Works one step of a feature run outside the runner's next action (the
   * way advance does), so stopping the build stops it, and idle waits for it.
   * Then the runner says what comes next, as after any step: a delivery it made
   * waits for your OK.
   */
  function runFor(id, fn) {
    if (running.has(id)) return running.get(id).done;
    const ctl = new AbortController();
    const entry = { ctl, done: null };
    running.set(id, entry);
    entry.done = (async () => {
      try { await fn(ctl.signal); } catch (e) {
        await store.update(id, (b) => { const s = b.stages.code; if (s) say(s.log, `Bringing this feature up to date went wrong in Product Factory: ${e.message}`); }).catch(() => {});
      } finally { running.delete(id); }
      if (!ctl.signal.aborted) await advance(id);
    })();
    return entry.done;
  }

  /**
   * A feature run behind the version's base is brought up to date, then judged
   * again. On a pull request: one merge commit (upToDatePullRequest), then the
   * gate on it, and the fix loop when the gate does not pass and it is on; a
   * fix loop running now brings it up to date before its next round. On this
   * computer: the build folder is laid out again with the new suite and the
   * scripts brought up to date, and Code runs its rounds on it; a run working
   * now does so before its next round. A run whose code has not started yet
   * meets the new base when it does.
   */
  async function syncRun(key) {
    const r = store.read(key);
    if (!r || runEnded(r) || !behind(r)) return;
    const onPr = r.settings.code.holder === "pull-request";
    const started = onPr ? Boolean(r.work.pr?.number) : Boolean(r.work.folder);
    if (!started) { await store.update(key, (b) => { delete b.work.behind; }); return; }
    if (onPr ? fixes.has(key) || busy.has(key) || running.has(key) : running.has(key)) return;
    const a = codeAction(r);
    if (!a) return;
    return runFor(key, async (signal) => {
      if (onPr) {
        const c = connect(r.settings.repository, env);
        if (c.problem) return noteOnce(key, c.problem);
        const u = await syncPullRequest(key, c);
        if (!u.ok || signal.aborted) return;
        const g = await poll(key);
        const now2 = store.read(key);
        if (g.judged && !g.passed && fixLoopOn(now2.settings) && now2.status === "working" && !signal.aborted) await fixLoop(key, a, "code", c, signal);
        return;
      }
      await change(key, (b) => {
        if (!["working", "waiting"].includes(b.status)) return;
        b.status = "working";
        b.stages.code.state = "working";
        say(b.log, "Another feature was accepted, so this one's code is brought up to date with it and checked again. Your OK waits until it passes.");
      });
      await codeStep(store.read(key), a, "code", signal);
    });
  }

  /** The pull request of a feature run behind the base, brought up to date with it (pull-request.mjs upToDatePullRequest). */
  async function syncPullRequest(id, c) {
    const r = store.read(id);
    const base = versionOf(r).base;
    const u = await upToDatePullRequest(c.gh, r.work.pr, { words: `${base.feature === FEATURE_ALL ? "The whole spec" : base.feature} was accepted and merged.` }, ({ digests, repoFiles }) => store.update(id, (b) => { b.work.pr.digests = digests; b.work.pr.repoFiles = repoFiles; }));
    await store.update(id, (b) => {
      const p = b.work.pr;
      const s = b.stages.code;
      if (!u.ok) { say(s.log, `Pull request #${p.number} could not be brought up to date with the version's base: ${u.reason}`); return; }
      p.synced_sha = u.sha;
      p.base_n = base.n;
      p.passed = null;
      delete b.work.behind;
      say(s.log, `Pull request #${p.number} was brought up to date with the version's base as ${u.sha.slice(0, 7)}${u.added.length ? `, with the accepted features' tests ${pathWords(u.added)}` : ""}.${u.conflicts.length ? ` This feature and the base both changed ${pathWords(u.conflicts)}: the base's version is in scripts/, and this feature's own is under records/yours/.` : ""} The gate runs on it.`);
      if (b.status === "waiting") {
        b.status = "working";
        s.state = "working";
        say(b.log, `Another feature was accepted, so pull request #${p.number} was brought up to date with it. Your OK waits for the gate to pass on it.`);
      }
    });
    return u;
  }

  /**
   * On this computer: the build folder of a feature run behind the base is
   * laid out again, with every accepted feature's test beside its own, and
   * its scripts brought up to date (feature-runs.mjs upToDate). Resolves to
   * { ok, folder, records, note } or { ok: false, reason }; note is the
   * note of the scripts both changed, when there are any.
   */
  async function relayLocal(id, action, stage, signal) {
    const r = store.read(id);
    const dir = dirOf(id);
    const n = versionOf(r).base?.n ?? 0;
    const ours = scriptsIn(abs(id, r.work.folder));
    const ancestor = r.work.synced ? scriptsIn(abs(id, r.work.synced)) : new Map();
    const h = await handOff({ dir, adlc: config.adlc, ...handOffGiven(id, action), env: agentEnv(), signal });
    if (signal.aborted) return { ok: false, reason: "stopped" };
    if (!h.ok) return { ok: false, reason: h.reply };
    let folder = h.folder;
    let records = null;
    if (r.settings.code.holder === "code-writer") {
      const w = await codeWriterWorkspace({ dir, adlc: config.adlc, archive: h.archive, env: agentEnv(), signal });
      if (!w.ok) return { ok: false, reason: w.reply };
      folder = w.folder;
      records = w.records;
    }
    const merged = upToDate({ ancestor, ours, base: baseScripts(r) });
    writeInto(folder, merged.files);
    const synced = syncedCopy(id, folder, n);
    await store.update(id, (b) => {
      b.work.folder = rel(dir, folder);
      if (records) b.work.records = rel(dir, records);
      b.work.base_n = n;
      b.work.synced = synced;
      delete b.work.behind;
      delete b.work.feedback;
      say(b.stages[stage].log, `Another feature was accepted, so the build folder is laid out again at ${folder}, with its tests beside this feature's own.${merged.conflicts.length ? ` This feature and the base both changed ${pathWords(merged.conflicts)}: the base's version is in scripts/, and this feature's own is under records/yours/.` : ""}`);
    });
    return { ok: true, folder, records, note: merged.conflicts.length ? join(folder, ...UP_TO_DATE_FILE.split("/")) : null };
  }

  /**
   * Send back to Requirements from a feature's own run (lifecycle API 0.4.7,
   * on make-a-new-agent.txt v2): the version takes its way back from
   * gather-the-features to the spec's gate ([conflict]), then the spec's own
   * way back to the spec writer ([changes]), with the person's words. Every
   * feature run still open waits for the revised spec (work.back_to_requirements,
   * held); once the person approves it, each revises its suite against it and
   * its Code goes on (resumeHeld), on the same pull request.
   */
  async function specBack(key, said, who) {
    const vid = keyParts(key).build;
    const v = store.read(vid);
    const vdoc = docOf(v);
    const gpid = gatherOf(v);
    const backTo = vdoc.deviations.find((d) => d.from === gpid && stageOf(vdoc, d.to) === "requirements" && holderOf(vdoc, d.to) === "person");
    const toSpec = backTo ? vdoc.deviations.find((d) => d.from === backTo.to && stageOf(vdoc, d.to) === "requirements" && holderOf(vdoc, d.to) !== "person") : null;
    if (!backTo || !toSpec) { const e = new Refused(409, "This build's process has no way back from its features to the spec, so it cannot be sent back to Requirements."); e.build = v; throw e; }
    const r = store.read(key);
    const conflict = r.work.pr?.runs?.at(-1)?.conflict ?? null;
    for (const fr of v.feature_runs.filter((x) => !runEnded(x))) {
      const k = runKey(vid, fr.id);
      await change(k, (b) => {
        const doc = docOf(b);
        const testPid = Object.keys(b.run.phases).find((x) => stageOf(doc, x) === "test");
        b.work.back_to_requirements = { words: said, conflict: k === key ? conflict : null, spec: [], suite: b.run.phases[testPid]?.record?.files ?? [], folder: b.work.folder ?? null, at: now(), held: true };
        delete b.work.back_to_test;
        if (b.work.pr) { b.work.pr.passed = null; if (b.work.pr.fix) b.work.pr.fix.stopped = null; }
        b.status = "working";
        if (b.stages[b.at]) { b.stages[b.at].state = "not_started"; b.stages[b.at].done_when_met = null; }
        say(b.log, k === key ? `You sent the build back to Requirements: “${said}” This feature waits for the revised spec.` : `${runWords(r)} sent the build back to Requirements, so this feature waits for the revised spec.`);
      });
      fixes.get(k)?.abort();
      gates.get(k)?.abort();
      running.get(k)?.ctl.abort();
    }
    const steps = [`${said}${conflict ? `\n\nThe coding agent said, in records/conflict.md:\n${conflict}` : ""}`];
    await change(vid, (b, ev) => {
      const t = now();
      const spec = (b.stages.requirements?.handed_back?.files ?? []).filter((f) => AGENT_FILE.test(f.path.replace(/^requirements\//, "")) || isSpecName(f.path)).map((f) => ({ name: f.path.replace(/^requirements\//, ""), path: f.at, media_type: /\.json$/.test(f.path) ? "application/json" : "text/markdown" }));
      b.work.back_to_requirements = { words: said, conflict, spec, suite: [], folder: null, at: t, from: r.feature_run };
      ev({ type: "deviated", key: backTo.key, from: backTo.from, to: backTo.to, by: who.email, text: said, steps, action: "back_to_requirements", at: t });
      ev({ type: "gated", phase: backTo.to, question: phaseNamed(vdoc, backTo.to)?.what ?? backTo.to, files: [], at: t });
      ev({ type: "deviated", key: toSpec.key, from: toSpec.from, to: toSpec.to, by: who.email, text: said, steps, action: "back_to_requirements", at: t });
      const req = b.stages.requirements;
      if (req) { req.state = "working"; req.done_when_met = null; say(req.log, `You sent the build back to Requirements from ${runWords(r)}, asking for changes to the spec: “${said}”`); }
      if (b.stages.code) b.stages.code.state = "not_started";
      say(b.log, `You sent the build back to Requirements from ${runWords(r)}. The spec writer revises the spec from your words; once you approve it, each feature's run still open revises its suite against it, and its Code goes on.`);
      b.at = "requirements";
      b.status = "working";
    });
    advance(vid);
    return store.read(vid);
  }

  /**
   * The revised spec is approved: each feature run held for it carries it
   * now, and goes back to its suite to revise it against the revised spec
   * (its way back from Code to Test), then on to Code, on the same pull
   * request. A run that had not handed back its suite yet writes it afresh.
   */
  async function resumeHeld(vid) {
    const v = store.read(vid);
    const files = approvedFiles(v);
    for (const fr of v.feature_runs.filter((x) => !runEnded(x) && x.work.back_to_requirements?.held)) {
      const k = runKey(vid, fr.id);
      const dir = dirOf(k);
      const given = files.map((g) => {
        const to = join(dir, "given", ...g.name.split("/"));
        mkdirSync(dirname(to), { recursive: true });
        cpSync(abs(vid, g.path), to);
        return { name: g.name, path: `given/${g.name}`, media_type: g.media_type ?? "" };
      });
      await change(k, (b, ev) => {
        const doc = docOf(b);
        const testPid = Object.keys(b.run.phases).find((x) => stageOf(doc, x) === "test");
        const way = doc.deviations.find((d) => stageOf(doc, d.from) === "code" && stageOf(doc, d.to) === "test");
        b.given = given;
        if (b.run.phases[testPid]?.status === "closed" && way) {
          b.work.back_to_requirements.held = false;
          ev({ type: "deviated", key: way.key, from: way.from, to: way.to, by: "Product Factory", text: b.work.back_to_requirements.words, steps: [b.work.back_to_requirements.words] });
        } else delete b.work.back_to_requirements;
        say(b.log, "The revised spec is approved: this feature's suite is revised against it, and its Code goes on.");
      });
      advance(k);
    }
    await store.update(vid, (b) => { delete b.work.back_to_requirements; });
  }

  /** The product's features were approved: each version making its features starts the runs it now has to (the person approved one in a chat). */
  async function featuresApproved(name) {
    for (const v of store.list().filter((b) => b.name === name && gatheringNow(b))) await startFeatureRuns(v.id);
  }

  // The spec writer holds two phases: the spec at Requirements, and the Design at Architecture and Design.
  // ---------- Deploy and Conformance (make-a-new-agent.txt v3) ----------

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

  const STEPS = { "reverse-engineer": reverseStep, "spec-writer": (r, a, stage, signal) => (stage === "architecture" ? designStep(r, a, stage, signal) : specWriterStep(r, a, stage, signal)), architect: architectStep, "test-writer": testWriterStep, code: codeStep, packer: packerStep, features: gatherStep, conformance: conformanceStep };

  // ---------- running a build ----------

  /** A feature run's phases are handed what its trigger carries too: the spec as approved, and the agent's own files. */
  const withGiven = (r, a) => (r.feature_run && a?.handoffs ? { ...a, handoffs: [{ key: "trigger", files: r.given ?? [] }, ...a.handoffs] } : a);

  async function step(r, signal) {
    // A feature run waiting for its version's revised spec (Send back to Requirements) has nothing to do until it is approved.
    if (r.feature_run && r.work.back_to_requirements?.held) return false;
    const doc = docOf(r);
    const ready = actionsFor(r.run, doc).map((x) => withGiven(r, x));
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
    // The owner answered the architecture record's questions (act "changes"): the solution architect revises it with them.
    const answered = Object.entries(r.run.phases).find(([x, p]) => holderOf(doc, x) === "architect" && p.status === "working" && p.block?.answered_at && words(r.work.architecture?.answers));
    if (answered && !(a && ["send-work", "send-revision"].includes(a.kind))) {
      if (r.at !== "architecture") await store.update(r.id, (b) => { b.at = "architecture"; });
      const [phase, p] = answered;
      await architectStep(store.read(r.id), { phase, kind: "send-answer", to: p.holder?.handle ?? "adlc/solution-architect", handoffs: [] }, "architecture", signal);
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
      // Architecture and Design left out: neither of its phases runs, and the build goes on as before the stage ran.
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
      // A feature's run closed: its version goes on once every one has.
      if (r.feature_run) await runClosed(r.id);
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
    // The solution architect asked what only a person can answer: the runner relays it to the owner, and the build waits for the answers.
    if (a.kind === "answer-block" && stage === "architecture" && r.stages[stage]) {
      await change(r.id, (b, ev) => {
        if (b.status !== "working") return;
        ev({ type: "gated", phase: a.phase, question: a.question, files: [] });
        b.at = stage;
        b.stages[stage].state = "waiting_on_you";
        b.status = "waiting";
        say(b.log, "The architecture record asks what only you can answer. It waits for your answers.");
      });
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
    if (settings.code.holder === "pull-request") {
      settings.repository = { ...config.repository };
      settings.review = { ...config.review };
    }
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
    // make-a-new-agent.txt v2: once the spec is approved, each feature is made in a run of its own.
    if (madeByFeature(opened.doc)) record.feature_runs = [];
    // Architecture and Design runs only where the process has a phase the solution architect holds (make-a-new-agent.txt v3).
    const architected = opened.doc.phases.some((p) => holderOf(opened.doc, p.id) === "architect");
    for (const s of Object.keys(holders)) {
      if (!snap.used[s]?.used || (fromRec && s === "reverse-engineering") || (s === "architecture" && !architected) || (s === "conformance" && !rosterOf(opened.state).has("conformance-checker"))) continue;
      record.stages[s] = {
        state: "not_started", holder: holders[s], runs: 0, rounds: [],
        given: s === "reverse-engineering" ? reverseGiven(record)
          : s === "requirements" ? `${asked(record).replace(/^Write a spec\.\n/, "").trim()}${adopt ? "\nThe as-built record from Reverse engineering: each behavior in it comes to you as a proposed feature marked as built, to approve, call a bug, or drop." : fromRec ? "\nThe as-built record you brought: each behavior in it comes to you as a proposed feature marked as built, to approve, call a bug, or drop. The code it describes is not taken on." : ""}`
            : GIVEN[adopt && (s === "test" || s === "code") ? `${s}-adopt` : fromRec && s === "test" ? "test-record" : s === "code" && settings.code.holder === "pull-request" ? (fixLoopOn(settings) ? "code-pr-loop" : "code-pr") : s],
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
    // A version whose features are made in runs of their own (lifecycle API 0.4.10): an action is for the
    // feature run it names (run), else the version's own, else the first feature run that offers it.
    if (hasFeatureRuns(r) && !keyParts(id).run) {
      const want = typeof needs?.run === "string" && needs.run ? needs.run : null;
      if (want && !r.feature_runs.some((x) => x.id === want)) throw new Refused(404, `This build has no feature run ${want}.`);
      const fr = want ? { id: want } : actionsOf(r).some((a) => a.name === name) ? null : r.feature_runs.find((x) => actionsOf(store.read(runKey(id, x.id))).some((a) => a.name === name));
      if (fr) {
        try { await act(runKey(id, fr.id), name, needs, who); } catch (e) {
          if (e.build) e.build = store.read(id);
          throw e;
        }
        return store.read(id);
      }
    }
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
    const said = words(needs?.changes);
    if (name === "changes" && !said) throw new Refused(400, "Say what should change.");
    if (name === "back_to_test" && !said) throw new Refused(400, "Say what is wrong with the suite: the test writer revises it from your words.");
    if (name === "back_to_requirements" && !said) throw new Refused(400, "Say what should change in the spec: the spec writer revises it from your words.");
    // A feature's own run: the spec is the version's, so the version goes back to it, and every feature's run waits for it.
    if (name === "back_to_requirements" && r.feature_run) return specBack(id, said, who);
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
      // The document's way back from Code: [conflict], to the person's gate on the spec; in a feature's
      // own run (make-a-feature.txt), straight back to its suite, since the spec is the version's.
      backTo = r.feature_run
        ? doc.deviations.find((d) => stageOf(doc, d.from) === "code" && stageOf(doc, d.to) === "test")
        : doc.deviations.find((d) => stageOf(doc, d.from) === "code" && stageOf(doc, d.to) === "requirements" && holderOf(doc, d.to) === "person");
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

    let go = false;
    await change(id, (b, ev) => {
      const doc = docOf(b);
      const s = b.stages[b.at];
      const last = s?.rounds[s.rounds.length - 1];
      const here = (pid) => stageOf(doc, pid) === b.at;
      if (name === "stop") {
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
        // A feature's own run goes straight back to its suite; the version's spec is not touched.
        if (!b.feature_run) {
          ev({ type: "gated", phase: backTo.to, question: phaseNamed(doc, backTo.to)?.what ?? backTo.to, files: [] });
          ev({ type: "approved", phase: backTo.to, by, text: `Sent back to Test from Code: the spec stands as approved, and the suite is revised. You said: ${said}` });
          if (b.stages.requirements) say(b.stages.requirements.log, "You sent the build back to Test from Code. The spec stands as you approved it.");
        } else if (b.stages.test) {
          b.stages.test.state = "working";
          say(b.stages.test.log, `You sent this feature back to Test from Code: “${said}”`);
        }
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
      } else if (name === "changes" && b.at === "architecture") {
        // Your answers to what the architecture record asked: the runner's answer to the solution
        // architect's question (Agent Processes: the holder blocked, and the owner answers).
        const [pid, p] = Object.entries(b.run.phases).find(([x, q]) => here(x) && q.status === "blocked") ?? [];
        if (!pid) throw notOffered(b);
        ev({ type: "sent", phase: pid, to: p.holder?.handle ?? null, handle: p.holder?.handle ?? null, kind: "answer", text: said, by });
        b.work.architecture = { ...b.work.architecture, answers: said };
        s.state = "working";
        b.status = "working";
        if (last) { last.verdict = "You answered"; last.words = firstWords(`${last.words} You answered: “${said}”`, 800); }
        say(s.log, `You answered: “${said}”`);
        say(b.log, "You answered the architecture record's questions. The solution architect revises the record with your answers.");
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
    // A feature's OK: its suite and scripts are the version's base before its run closes, so the version and the other runs see them.
    if (name === "accept" && r.feature_run) await accepted(id, took);
    // Stopping the version stops every feature run still open; a feature run stopped alone may let its version go on.
    if (name === "stop" && hasFeatureRuns(r)) await stopRuns(id, who);
    if (name === "stop" && r.feature_run) await runClosed(id);
    if (go) advance(id);
    return store.read(id);
  }

  /** The version was stopped: each of its feature runs still open is stopped with it. */
  async function stopRuns(vid, who) {
    for (const fr of store.read(vid).feature_runs.filter((x) => !runEnded(x))) {
      const key = runKey(vid, fr.id);
      await change(key, (b, ev) => {
        ev({ type: "stopped", by: who.email, reason: "the build was stopped in the console" });
        if (b.stages[b.at]) b.stages[b.at].state = "stopped";
        b.status = "stopped";
        say(b.log, `Stopped with the build at ${nameOf(b.at)}.`);
      });
      running.get(key)?.ctl.abort();
      gates.get(key)?.abort();
      fixes.get(key)?.abort();
    }
  }

  /** Builds that were running when Product Factory stopped send their phase again. */
  async function resumeAll() {
    for (const r of everyRun()) {
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

  return {
    start, act, resumeAll, startDrift,
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
    /** A feature run's timeline, by its version and its id. */
    runTimeline: (build, run) => { try { const r = store.read(runKey(build, run)); return r?.run ? timelineOf(r.run, docOf(r)) : []; } catch { return []; } },
    /** Resolves when the build has nothing running, nor any of its feature runs. */
    idle: async (id) => {
      const mine = (k) => k === id || keyParts(k).build === id;
      for (let guard = 0; guard < 1000; guard++) {
        const waits = [...running].filter(([k]) => mine(k)).map(([, e]) => e.done).concat([...busy].filter(([k]) => mine(k)).map(([, p]) => p));
        if (!waits.length) return;
        await Promise.all(waits);
      }
    },
    /** A feature of the product was approved (lifecycle API 0.4.3): a version making its features starts its run. */
    featuresApproved,
    stopAll: () => {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      for (const e of running.values()) e.ctl.abort();
      for (const g of gates.values()) g.abort();
      return Promise.all([...running.values()].map((e) => e.done).concat([...busy.values()]));
    },
  };
}
