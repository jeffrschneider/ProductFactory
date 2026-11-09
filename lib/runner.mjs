// The driver: runs each build's process document through the process runner
// (orchestrator.mjs) and does what the runner says with the holder adapters.
// It holds no order of steps of its own. For each build it asks the runner
// for its next action, and:
//
//   send-work, send-revision   hands the phase to its adapter (adapters.mjs), then tells
//                              the runner what came back (replied: delivered or refused)
//   ask-gate, ask-approve,     the person's gate: the build waits, and the console shows
//   ask-act-on-draft           the gate's actions; the person's answer is an event
//                              (approved, deviated, resumed, stopped)
//   ask-refused, fail-refused  the build waits on the person, in the holder's words
//   close                      the build is done
//
// A phase at a stage milestone 1 does not run (Deploy and later), or at a
// stage the build's lifecycle leaves out, ends the run there, and the run's
// record names the phases left open. At a packed build, the process
// document's "approve the deploy" gate is asked with the run plan to read;
// once the person says yes, the run ends there and the package and the plan
// go to the runtime you bring (runtime.mjs).
//
// Code on a pull request (code.holder "pull-request"): the code phase opens a
// "Write the scripts" pull request with the build folder (pull-request.mjs)
// and the build waits on pushes. poll() reads the pull request's newest
// commit; on each new one the gate runs (gate.mjs), its result goes on the
// pull request, and a pass is the holder's delivery. Your OK takes the
// scripts from that exact commit; Send back to Test has the test writer
// revise the suite, and the revised tests go on the same pull request.
//
// Every step writes the run's state and what the console shows into
// build.json before the next starts, so a build that was running when Product
// Factory stopped sends its phase again when it starts.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Refused } from "./lifecycle.mjs";
import { openRun, parse, nextAction, actionsFor, event, stageOf, holderOf, RUNS, phaseNamed, saveRun, timelineOf, phaseMaterial } from "./orchestrator.mjs";
import { stageById, roleById } from "./standards.mjs";
import { modelEnv, localPerson } from "./config.mjs";
import { RECORD_FORMAT } from "./store.mjs";
import { actionsOf } from "./view.mjs";
import { specWriter, testWriter, handOff, codeWriterWorkspace, codeRound, scriptsHanded, pack, requestText, reviewer, reviewerMissing } from "./adapters.mjs";
import { connect, openPullRequest, pullRequestHead, readCommitFiles, postResult, revisePullRequest, takePullRequest, readBuildFolder, slugOf } from "./pull-request.mjs";
import { judgeFolder, runGateSuite } from "./gate.mjs";
import { digestOf } from "./fence.mjs";
import { REVIEWERS, SPENDING_LIMIT_DEFAULT, packageFiles, changeDiff, requestText as reviewText, judgeRun, finalVerdict } from "./review.mjs";
import { writeTarGz } from "./tar.mjs";
import { createRuntime } from "./runtime.mjs";
import { registerOf, eventsOf, buildsUpTo, materialLines, byFeature, byFeatureWords } from "./features.mjs";
import { testNames } from "./artifacts.mjs";

const words = (s) => String(s ?? "").trim();
const nameOf = (id) => stageById.get(id)?.name ?? id;
const rel = (base, at) => relative(base, at).split(sep).join("/");
const firstWords = (s, n = 500) => { const t = words(s).replace(/\s+/g, " "); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const AGENT_FILE = /^(agent-descriptor\.json|agent-runtime-requirements\.json|plugin\.json|mcp\.json|skills\/[^/]+\/SKILL\.md)$/;

/** The request as the spec writer reads it. A name is passed only when the person gave one. */
const asked = (r) => requestText({ ...r, name: r.named ? r.name : "", version: r.versioned ? r.version : "" });

const ROLE_OF = { requirements: "spec-writer", test: "test-writer", code: "code-writer", package: "package-maker" };

const GIVEN = {
  test: "The agent's own files from Requirements, as you approved them: agent-descriptor.json, agent-runtime-requirements.json, plugin.json and a SKILL.md per skill.",
  code: "The agent's files and the suite, laid out as a build folder with AGENTS.md (the hand-off contract), .adlc/check.mjs and build.lock.json.",
  "code-pr": "The agent's files and the suite, laid out as a build folder with AGENTS.md (the hand-off contract), .adlc/check.mjs and build.lock.json, on a \"Write the scripts\" pull request your coding harness pushes to.",
  package: "The agent's files as you approved them, and the scripts Code wrote, placed under each skill as plugin.json's build entry names them.",
};

/** Who holds each stage milestone 1 runs, from the settings in effect when the build started. */
export function holdersFor(settings) {
  const packer = settings.packer.join(" ");
  return {
    requirements: { kind: "reference_agent", name: "spec-writer", role: "spec-writer" },
    test: { kind: "reference_agent", name: "test-writer", role: "test-writer" },
    code: settings.code.holder === "code-writer"
      ? { kind: "reference_agent", name: "code-writer", role: "code-writer" }
      : settings.code.holder === "pull-request"
        ? { kind: "your_agent", name: `your coding harness, on a pull request (${settings.repository?.repo ?? "no repository set"})`, role: "code-writer" }
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
    const lines = materialLines([...reg.values()].sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true })));
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

  async function specWriterStep(r, action, stage, signal) {
    const id = r.id;
    const revise = action.kind === "send-revision";
    await sent(id, action, stage, revise ? "Sent back to the spec writer with your words." : "Sent to the spec writer.");
    const n = store.read(id).stages[stage].runs;
    const noModel = missingModel();
    if (noModel) return refused(id, action, stage, noModel, { round: { n, at: now(), label: `Round ${n}`, verdict: "Not run", back: false, words: noModel } });
    const prior = revise ? (action.prior?.record?.files ?? []).filter((f) => AGENT_FILE.test(f.name)) : [];
    const res = await specWriter({
      dir: dirOf(id), adlc: config.adlc, n, signal, env: agentEnv(),
      text: withFeatures(revise ? `changes: ${action.steps.join("\n")}\n` : r.work.text ?? asked(r), r, action.phase),
      attach: [...prior.map((f) => ({ abs: abs(id, f.path), media_type: f.media_type })), ...earlierFiles(r, revise, n)],
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
      say(s.log, "The spec writer handed back the agent's own files.");
      delete b.work.text;
      // The spec says the agent's name and version; a name the person gave stays.
      try {
        const d = JSON.parse(readFileSync(res.agentFiles.find((f) => f.path === "agent-descriptor.json")?.abs ?? "", "utf8"));
        if (!b.named && words(d.name)) b.name = words(d.name);
        if (words(d.agent_version) && !b.versioned) b.version = words(d.agent_version);
      } catch { /* the name and version stay as they were */ }
      const open = (res.handed ?? []).filter((f) => f.path === "requirements/still-open.md").map((f) => ({ name: "still-open.md", path: f.at, media_type: "text/markdown" }));
      delivered(b, ev, action, res.reply, [...asFiles(id, res.agentFiles), ...open]);
    });
  }

  async function testWriterStep(r, action, stage, signal) {
    const id = r.id;
    await sent(id, action, stage, "Sent to the test writer with the agent's files.");
    const n = store.read(id).stages[stage].runs;
    const noModel = missingModel();
    if (noModel) return refused(id, action, stage, noModel, { round: { n, at: now(), label: `Round ${n}`, verdict: "Not run", back: false, words: noModel } });
    const agentFiles = handed(action).filter((f) => AGENT_FILE.test(f.name)).map((f) => ({ abs: abs(id, f.path), media_type: f.media_type }));
    // Sent back from Code: the test writer revises the suite as it stands, with the person's words
    // (and the coding agent's, when it stopped on a conflict). The reference test writer reads a
    // message whose first line is "Revise the suite" as a revision, and hands back the files it revised.
    const back = r.work.back_to_test ?? null;
    const said = back ? `Revise the suite.\n\n${back.words}${back.conflict ? `\n\nThe coding agent said, in records/conflict.md:\n${back.conflict}` : ""}\n` : "Write the suite for the agent's files attached.\n";
    const text = withFeatures(said, r, action.phase);
    const attach = back ? back.suite.map((f) => ({ abs: abs(id, f.path), media_type: f.media_type || "text/javascript" })) : [];
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
      const suite = back ? [...back.suite.filter((f) => !revised.some((x) => x.name === f.name)), ...revised].sort((x, y) => (x.name < y.name ? -1 : 1)) : revised;
      s.handed_back = { words: [res.reply], files: back ? filesHanded(id, suite.map((f) => ({ path: f.name, at: f.path }))) : filesHanded(id, res.handed) };
      s.state = "done";
      say(s.log, back ? `The test writer revised ${revised.map((f) => f.name).join(", ") || "nothing"}.` : `The test writer handed back ${res.suite.length} test file${res.suite.length === 1 ? "" : "s"}.`);
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
  const watched = (b) => Boolean(b && b.settings?.code?.holder === "pull-request" && b.at === "code" && b.work?.pr?.number && ["working", "waiting"].includes(b.status) && !b.work.back_to_test);

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
    await sent(id, action, stage, !pr ? "Sent to a pull request for your coding harness." : r.work.back_to_test ? "Sent back to the pull request with the revised suite." : `Sent to pull request #${pr.number} again.`);
    const c = connect(r.settings.repository, env);
    if (c.problem) return refused(id, action, stage, c.problem);

    if (!pr) {
      // The hand-off lays out the build folder as in local mode; the folder then goes to the pull request.
      const files = handed(action);
      const agentFiles = files.filter((f) => AGENT_FILE.test(f.name)).map((f) => ({ abs: abs(id, f.path), media_type: f.media_type }));
      const suite = files.filter((f) => /^test\//.test(f.name)).map((f) => ({ abs: abs(id, f.path), media_type: f.media_type }));
      const h = await handOff({ dir, adlc: config.adlc, agentFiles, suite, env: agentEnv(), signal });
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
      return change(id, (b) => {
        if (b.status !== "working") return;
        b.work.folder = rel(dir, h.folder);
        b.work.pr = p;
        const s = b.stages[stage];
        say(s.log, `Opened pull request #${p.number} on ${p.repo}, with the build folder in ${p.folder}/ and AGENTS.md (the hand-off contract): ${p.url}`);
        say(s.log, "Point your coding harness at the pull request. Every push it makes runs the gate.");
        say(b.log, `Code is on pull request #${p.number}: ${p.url}`);
      });
    }

    const back = r.work.back_to_test;
    if (!back) return noteOnce(id, `Waiting for a push to pull request #${pr.number}.`);

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
      return change(id, (b) => {
        delete b.work.back_to_test;
        say(b.stages[stage].log, `The revised suite is the same as the one on pull request #${pr.number}, so nothing new went to it. Waiting for a push.`);
      });
    }
    const job = revisePullRequest(c.gh, pr, { tests, removed, words: back.words }, (d) => store.update(id, (b) => { if (b.work.pr) b.work.pr.digests = d; }));
    busy.set(id, job.then(() => ({ judged: false }), () => ({ judged: false })));
    let res;
    try { res = await job; } finally { busy.delete(id); }
    if (!res.ok) return refused(id, action, stage, res.reason);
    return change(id, (b) => {
      delete b.work.back_to_test;
      say(b.stages[stage].log, `The revised tests went to pull request #${pr.number} as ${res.sha.slice(0, 7)}: ${[...tests.map((t) => t.path), ...removed.map((p) => `${p} (taken out)`)].join(", ")}. The gate runs on it, and on every push after it.`);
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

  /** The gate on one new commit of the pull request, its word on the pull request, and a pass delivered. */
  async function gatePush(id, sha, c) {
    const ctl = new AbortController();
    gates.set(id, ctl);
    const signal = ctl.signal;
    try {
      await store.update(id, (b) => {
        const p = b.work.pr;
        p.head = sha; p.judging = sha; p.note = null;
        say(b.stages.code.log, `A push came to pull request #${p.number}: ${sha.slice(0, 7)}. The gate runs on it.`);
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
            runSuite: (judged) => runGateSuite({ folder, files: judged, scripts: pr.scripts, seconds: r.settings.code.minutes * 60, env: agentEnv(), signal }),
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
        s.rounds.push({ n, at: now(), label: `Push ${sha.slice(0, 7)}`, verdict: verdict.title, back: !verdict.passed, words: firstWords(verdict.summary, 800), ...(perFeature.length ? { failing, by_feature: perFeature } : {}) });
        if (scripts.length) s.handed_back = { words: [`${verdict.title} (${sha.slice(0, 7)}).`], files: filesHanded(id, scripts) };
        say(s.log, `The gate on ${sha.slice(0, 7)}: ${verdict.title}.${posted.commented ? " It said so on the pull request." : " Its comment could not be posted on the pull request."}`);
        // Sent back to Test while the gate ran: the run is kept, and nothing moves.
        if (b.work.back_to_test || b.at !== "code" || !["working", "waiting"].includes(b.status)) return;
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
      return { judged: true, passed: verdict.passed, title: verdict.title };
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
      if (!watched(r)) return { judged: false };
      const c = connect(r.settings.repository, env);
      if (c.problem) { await noteOnce(id, c.problem); return { judged: false }; }
      const head = await pullRequestHead(c.gh, r.work.pr);
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
    for (const r of store.list()) if (watched(r)) await poll(r.id);
  }

  async function codeStep(r, action, stage, signal) {
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
      const files = handed(action);
      const agentFiles = files.filter((f) => AGENT_FILE.test(f.name)).map((f) => ({ abs: abs(id, f.path), media_type: f.media_type }));
      const suite = files.filter((f) => /^test\//.test(f.name)).map((f) => ({ abs: abs(id, f.path), media_type: f.media_type }));
      const h = await handOff({ dir, adlc: config.adlc, agentFiles, suite, env: agentEnv(), signal });
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
      await store.update(id, (b) => {
        b.work.folder = rel(dir, folder);
        if (records) b.work.records = rel(dir, records);
        say(b.stages[stage].log, `The build folder is laid out at ${folder}, with AGENTS.md.`);
      });
    } else {
      folder = abs(id, folder);
      if (records) records = abs(id, records);
    }
    let feedback = r.work.feedback ? abs(id, r.work.feedback) : null;
    const limit = r.settings.code.rounds;
    for (let k = 1; k <= limit; k++) {
      const n = store.read(id).stages[stage].rounds.length + 1;
      const res = await codeRound({ dir, adlc: config.adlc, mode, folder, records, harness: r.settings.code.harness, round: n, feedbackFile: feedback, minutes: r.settings.code.minutes, env: agentEnv(), signal });
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
  function endRun(r, phase, stage, why) {
    return change(r.id, (b, ev) => {
      if (b.status !== "working") return;
      const open = Object.entries(b.run.phases).filter(([, p]) => p.status !== "closed").map(([pid]) => pid);
      ev({ type: "closed", outcome: "ended", result: `${why} The run ends before ${phase}.`, open });
      b.status = "done";
      say(b.log, b.at === "package" ? `Done: ${b.name} ${b.version} is packed and validated. ${why}` : b.at === "deploy" ? why : `Done at ${nameOf(b.at)}. ${why}`);
    });
  }

  const STEPS = { "spec-writer": specWriterStep, "test-writer": testWriterStep, code: codeStep, packer: packerStep };

  // ---------- running a build ----------

  async function step(r, signal) {
    const doc = docOf(r);
    const a = nextAction(r.run, doc);
    // Deploy is the runtime's: once the person approved the deploy (or hands it over again),
    // the run ends there and the package goes to the runtime with its run plan.
    if (r.at === "deploy") {
      if (r.run.status === "open") await endRun(r, a?.phase ?? "deploy-the-agent", "deploy", "You approved the deploy, so the package and its run plan go to the runtime you bring.");
      await runtime.handOff(r.id, signal);
      return true;
    }
    if (!a) return false;
    const stage = a.phase ? stageOf(doc, a.phase) : null;
    if (["send-work", "send-revision", "ask-gate", "ask-approve", "ask-act-on-draft"].includes(a.kind)) {
      // The process document's "approve the deploy" gate, asked with the run plan to read.
      if (stage === "deploy" && a.kind === "ask-gate" && await runtime.prepare(r.id)) { await gate(store.read(r.id), a, stage, doc); return true; }
      if (!RUNS.includes(stage)) { await endRun(r, a.phase, stage, `Product Factory runs no stage after Package; ${nameOf(stage)} and the stages after it go to the runtime you bring.`); await runtime.handOff(r.id, signal); return true; }
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
   */
  async function start(req, who = person, { issue = null, version = null, earlier = null } = {}) {
    const by = who.email;
    const does = words(req?.does);
    if (!does) throw new Refused(400, "Say what the agent should do: does is required.");
    if (req.kind && req.kind !== "agent") throw new Refused(400, "Product Factory milestone 1 builds agents only. A process is a later milestone.");
    for (const k of ["refuses", "more", "name", "prototype", "project"]) {
      if (k in req && typeof req[k] !== "string") throw new Refused(400, `${k} is words.`);
    }
    const project = words(req.project) || null;
    const snap = await lifecycle.snapshot(project);
    const settings = { code: { ...config.code }, packer: [...config.package.packer] };
    if (settings.code.holder === "pull-request") {
      settings.repository = { ...config.repository };
      settings.review = { ...config.review };
    }
    const holders = holdersFor(settings);
    const at = now();
    const id = store.newId();
    const record = {
      format: RECORD_FORMAT, id,
      name: words(req.name) || "A new agent", named: Boolean(words(req.name)),
      does, refuses: words(req.refuses), more: words(req.more), prototype: words(req.prototype),
      ...(project ? { project } : {}),
      ...(issue ? { issue: { repo: issue.repo, number: issue.number, url: issue.url } } : {}),
      version: words(version) || "0.1.0", ...(words(version) ? { versioned: true } : {}), created: at, updated: at, archived: false,
      ...(earlier ? { earlier: { build: earlier.build, version: earlier.version, files: earlier.files.map((f) => ({ at: f.at, media_type: f.media_type ?? "" })) } } : {}),
      status: "working", at: "requirements",
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
      opened = openRun({ person: by, day: at.slice(0, 10), settings, material: asked(record), startedAt: at });
    } catch (e) {
      throw new Refused(409, e.message);
    }
    record.run = opened.state;
    for (const s of Object.keys(holders)) {
      if (!snap.used[s]?.used) continue;
      record.stages[s] = {
        state: "not_started", holder: holders[s], runs: 0, rounds: [],
        given: s === "requirements" ? asked(record).replace(/^Write a spec\.\n/, "").trim() : GIVEN[s === "code" && settings.code.holder === "pull-request" ? "code-pr" : s],
        handed_back: { words: [], files: [] }, done_when_met: null, log: [],
      };
    }
    say(record.log, `Started under ${project ? `the project ${project}'s` : "the organization's"} lifecycle, running the process ${opened.state.process.name} (${opened.doc.ref || opened.state.process.id} ${opened.state.process.version}).`);
    if (issue) say(record.log, `Started from issue #${issue.number} on ${issue.repo}: ${issue.url}`);
    for (const s of Object.keys(record.stages)) {
      const bound = snap.holders[ROLE_OF[s]];
      if (bound && bound.kind !== "reference_agent" && !(s === "code" && bound.kind === "your_agent" && ["harness", "pull-request"].includes(settings.code.holder))) {
        say(record.log, `The lifecycle has ${bound.name} hold the ${roleById.get(ROLE_OF[s])?.name ?? ROLE_OF[s]} role. Milestone 1 sends ${nameOf(s)} to ${holders[s].name} instead.`);
      }
    }
    for (const a of snap.added) say(record.log, `The lifecycle adds a stage of its own, ${a.name}. Milestone 1 does not run stages of your own yet.`);
    store.create(record);
    mkdirSync(join(dirOf(id), "run"), { recursive: true });
    writeFileSync(abs(id, record.process), opened.text);
    saveRun(join(dirOf(id), "run"), record.run);
    advance(id);
    return store.read(id);
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
    const said = words(needs?.changes);
    if (name === "changes" && !said) throw new Refused(400, "Say what should change.");
    if (name === "back_to_test" && !said) throw new Refused(400, "Say what is wrong with the suite: the test writer revises it from your words.");
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
        ev({ type: "gated", phase: backTo.to, question: phaseNamed(doc, backTo.to)?.what ?? backTo.to, files: [] });
        ev({ type: "approved", phase: backTo.to, by, text: `Sent back to Test from Code: the spec stands as approved, and the suite is revised. You said: ${said}` });
        if (b.stages.requirements) say(b.stages.requirements.log, "You sent the build back to Test from Code. The spec stands as you approved it.");
        s.state = "not_started";
        s.done_when_met = null;
        if (b.work.pr) b.work.pr.passed = null;
        say(s.log, `You sent the build back to Test: “${said}”`);
        say(b.log, "You sent the build back to Test. The test writer revises the suite, and the revised tests go to the pull request.");
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
        await store.update(r.id, (b) => {
          const p = b.work.pr;
          if (p.judging) { p.head = p.runs.at(-1)?.sha ?? p.issued_sha; p.judging = null; }
          say(b.log, `Product Factory started again; it goes on checking pull request #${p.number} for pushes.`);
        });
        continue;
      }
      await change(r.id, (b, ev) => {
        for (const [pid, p] of Object.entries(b.run.phases)) if (p.status === "working") ev({ type: "send-again", phase: pid, by: "Product Factory, started again" });
        say(b.log, `Product Factory started again while ${nameOf(b.at)} was running, so it runs again.`);
      });
      advance(r.id);
    }
  }

  return {
    start, act, resumeAll,
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
    idle: (id) => Promise.all([running.get(id)?.done, busy.get(id)]).then(() => running.get(id)?.done),
    stopAll: () => {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      for (const e of running.values()) e.ctl.abort();
      for (const g of gates.values()) g.abort();
      return Promise.all([...running.values()].map((e) => e.done).concat([...busy.values()]));
    },
  };
}
