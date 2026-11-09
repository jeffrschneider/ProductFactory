// A build's record (build.json) as the lifecycle API answers it: every stage
// of stages.json once, in its order, each in a state the API names, with its
// cadence (0.4.2), and the actions the person may take now.
//
// Review and Security review run inside Code's gate when Code is on a pull
// request (gate.mjs, review.mjs): their stages report what the gate's
// reviewers said on the commit Code's artifacts are from, done or refused.

import { STAGES_DOC, stageById } from "./standards.mjs";
import { RUNS } from "./orchestrator.mjs";
import { planStageView, handleOf } from "./runtime.mjs";
import { REVIEWERS } from "./review.mjs";
import { prCommit } from "./artifacts.mjs";
import { cadenceOf, carriedFor } from "./cadence.mjs";

const LAST_RUN = RUNS.indexOf("package");

/** Why a stage milestone 1 does not run reads not_offered, in words. */
export function notOfferedWords(stageId) {
  if (stageId === "reverse-engineering") return "Reverse engineering runs on existing code: when a build starts from it (New build, Start from existing code), or when the product's code changes outside the lifecycle. This build did not start from existing code, so it did not run.";
  const at = STAGES_DOC.stages.findIndex((s) => s.id === stageId);
  const pkg = STAGES_DOC.stages.findIndex((s) => s.id === RUNS[LAST_RUN]);
  return at > pkg
    ? "Product Factory does not run this stage. Once Package is done, it writes the run plan and hands the package to the runtime you bring."
    : "Product Factory milestone 1 does not run this stage yet, so the build goes on without it.";
}

/** The given words of a stage the build's lifecycle leaves out. */
export function notUsedWords(from, project) {
  return from === "project" && project
    ? `Not part of this build's lifecycle: the project ${project} leaves it out.`
    : "Not part of this build's lifecycle: the organization leaves it out.";
}

const nameOf = (id) => stageById.get(id)?.name ?? id;

/** The actions the build offers now, from its status and where it is. */
export function actionsOf(r) {
  const at = r.at;
  const a = (name, label, needs = []) => ({ stage: at, name, label, needs });
  const stop = a("stop", "Stop");
  // Code on a pull request: the build can be sent back to Test while it waits on pushes or on your OK.
  const onPr = at === "code" && r.settings?.code?.holder === "pull-request" && r.work?.pr?.number && !r.work?.back_to_test;
  const backToTest = a("back_to_test", "Send back to Test", [{ name: "changes", label: "What is wrong with the suite, for the test writer", kind: "words" }]);
  if (r.status === "working") return onPr ? [backToTest, stop] : [stop];
  // The process document's "approve the deploy" gate, before the package goes to the runtime.
  if (at === "deploy" && r.status === "waiting" && r.stages.deploy?.gate === "approve") return [a("approve", "Approve the deploy"), stop];
  // Deploy is the runtime's: the person may hand the package over again, once a runtime is set or fixed.
  if (at === "deploy" && ["waiting", "refused"].includes(r.status)) {
    return [a("resume", r.status === "waiting" ? "Hand it to your runtime" : "Hand it over again"), r.archived ? a("unarchive", "Unarchive") : a("archive", "Archive")];
  }
  if (r.status === "waiting") {
    if (at === "requirements") {
      return [a("approve", "Approve the spec"), a("changes", "Ask for changes", [{ name: "changes", label: "What should change, or your answers to the open questions", kind: "words" }]), stop];
    }
    if (at === "code") {
      return onPr ? [a("accept", "OK the code"), backToTest, stop] : [a("accept", "OK the code"), stop];
    }
    return [stop];
  }
  if (r.status === "refused") {
    const out = [a("resume", at === "code" ? "Give it more rounds" : "Run it again")];
    if (at === "requirements") out.push(a("changes", "Ask for changes", [{ name: "changes", label: "What should change, or your answers to the open questions", kind: "words" }]));
    return [...out, stop];
  }
  // Ended: done or stopped.
  return [r.archived ? a("unarchive", "Unarchive") : a("archive", "Archive")];
}

/** Where the build ended, or where it is, in words. */
export function summaryOf(r) {
  const name = nameOf(r.at);
  const pr = r.at === "code" ? r.work?.pr : null;
  if (r.status === "working" && pr?.number && !r.work.back_to_test) return pr.judging ? `Working at Code: the gate is running on pull request #${pr.number}` : `Working at Code: waiting for a push to pull request #${pr.number}`;
  if (r.at === "deploy" && r.status === "waiting" && r.stages.deploy?.gate === "approve") return `Packed and validated · ${r.name} ${r.version} · Approve the deploy`;
  if (r.at === "deploy" && r.status === "waiting") return `Packed and validated · ${r.name} ${r.version} · Hand this package to your runtime`;
  if (r.at === "deploy" && r.status === "done") return `Handed to your runtime · ${r.name} ${r.version}`;
  if (r.status === "working") return `Working at ${name}`;
  if (r.status === "waiting") return `Waiting on you at ${name}`;
  if (r.status === "refused") return `Refused at ${name}: waiting on you`;
  if (r.status === "stopped" && r.work?.not_an_agent) return "Stopped at Code: the code cannot be packaged as an agent";
  if (r.status === "stopped") return `Stopped at ${name}`;
  if (r.at === "package") return `Packed and validated · ${r.name} ${r.version}`;
  return `Code OK'd · ${r.name} ${r.version} · Package is not part of this lifecycle`;
}

const STATE_OF_STATUS = { working: "working", waiting: "waiting_on_you", refused: "refused", stopped: "stopped", done: "done" };

/** The list item for GET /builds. */
export function listItem(r) {
  const s = r.stages[r.at];
  return {
    id: r.id, name: r.name, does: r.does, version: r.version, kind: "agent",
    at: { stage: r.at, state: s?.state ?? STATE_OF_STATUS[r.status], summary: summaryOf(r) },
    archived: Boolean(r.archived), updated: r.updated,
  };
}

/** Where Code's work is when it is on a pull request: the pull request, its newest commit, and the check on it. */
export function pullRequestWhere(pr) {
  if (!pr?.url) return null;
  const head = pr.head ?? null;
  let check = null;
  if (pr.judging) check = { title: "The gate is running", words: `The gate is running on ${pr.judging.slice(0, 7)}: the fence, the suite, and the reviewers the lifecycle uses.`, items: [], passed: null };
  else {
    const run = [...(pr.runs ?? [])].reverse().find((x) => x.sha === pr.head);
    if (run) check = { title: run.title, words: run.summary, items: [...(run.items ?? [])], passed: run.passed };
  }
  return { kind: "pull_request", url: pr.url, head: head ? head.slice(0, 7) : null, check };
}

/** Where a build's file is read on the service. */
export function link(id, path) {
  return `/v1/lifecycle/builds/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}`;
}

const short = (sha) => String(sha ?? "").slice(0, 7);
const clip = (s, n = 800) => { const x = String(s ?? "").replace(/\s+/g, " ").trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x; };
const blank = (stage, state, given, holder = null) => ({ stage, state, holder, runs: 0, rounds: [], given, handed_back: { words: [], files: [] }, done_when_met: null, log: [], where: null });
const Cap = (s) => s[0].toUpperCase() + s.slice(1);

/**
 * Review or Security review, from Code's gate on the pull request, or null
 * when the build has a record of its own for the stage. A reviewer the gate
 * asked on the commit Code's artifacts are from reads done or refused, with
 * its words; one it did not ask says why; one the gate has not reached yet
 * is not_started. outputs: the stage's artifacts, for the files it handed back.
 */
export function reviewStageView(r, stage, outputs = []) {
  const rv = REVIEWERS.find((x) => x.stage === stage);
  if (!rv || r.stages[stage]) return null;
  const ref = { kind: "reference_agent", name: rv.agent, role: rv.role };
  const bound = r.lifecycle?.holders?.[rv.role];
  const holder = bound && bound.kind !== "reference_agent" ? { ...bound, role: rv.role } : ref;
  if (r.settings?.code?.holder !== "pull-request") {
    return blank(stage, "not_offered", `Product Factory asks ${rv.who} inside Code's gate on a pull request. This build's Code is held on this computer, so the suite is the gate and ${rv.who} is not asked.`);
  }
  const pr = r.work?.pr ?? null;
  const runs = Array.isArray(pr?.runs) ? pr.runs : [];
  const sha = prCommit(r);
  const run = [...runs].reverse().find((x) => x.sha === sha) ?? null;
  const skipped = (run?.skipped ?? []).find((s) => s.id === rv.id);
  if (skipped) return blank(stage, "not_offered", `The gate on ${short(sha)} did not ask ${rv.who}: ${skipped.why}`);
  const asked = runs.filter((x) => x.reviews?.[rv.id]);
  const rounds = asked.map((x, i) => {
    const v = x.reviews[rv.id];
    return { n: i + 1, at: x.at, label: `Push ${short(x.sha)}`, verdict: v.passed ? "Passed" : "Refused", back: !v.passed, words: clip([v.words, ...(v.reasons ?? [])].join(" ")) };
  }).reverse();
  const where = pr?.number ? ` on pull request #${pr.number}` : "";
  const v = run?.reviews?.[rv.id] ?? null;
  // A gate run kept before the reviewers' verdicts were: a pass means every reviewer it asked passed.
  const legacy = !v && run?.passed && !run.reviews && outputs.some((a) => a.state === "made");
  if (!v && !legacy) {
    return { ...blank(stage, "not_started", `${Cap(rv.who)} reads the code inside Code's gate${where}, once the fence and the suite pass on a push.`, holder), runs: asked.length, rounds };
  }
  const files = outputs.filter((a) => a.state === "made").flatMap((a) => a.files ?? []).map((f) => ({ path: f.path, size: f.size, link: f.link }));
  const said = v ? [v.words, ...(v.reasons ?? [])] : [`The gate passed ${short(sha)}, with ${rv.who}'s review.`];
  return {
    stage, state: !v || v.passed ? "done" : "refused", holder, runs: asked.length, rounds,
    given: `Read inside Code's gate${where}, at commit ${short(sha)}: the scripts, the suite and the agent's files${rv.id === "critic" ? ", with the change as a diff" : ""}.`,
    handed_back: { words: said.filter(Boolean), files },
    done_when_met: !v || v.passed, log: [], where: null,
  };
}

/** The build for GET /builds/:id. timeline: the run's bars, from the runner (build.timeline). artifacts: what it made and will make (artifacts.mjs, added in 0.4). earlier: the product's builds started before this one, newest first, for the setup stages carried forward (0.4.2). */
export function buildView(r, { timeline = [], artifacts = null, earlier = [], featureCounts = {} } = {}) {
  const stages = STAGES_DOC.stages.map((d) => {
    const one = stageOfBuild(r, d, artifacts);
    one.cadence = cadenceOf(d.id);
    // 0.4.5: how many of the product's features the stage covers, for the spine ("Test · 4 of 5 features").
    if (featureCounts[d.id] && one.state !== "not_used") one.features = featureCounts[d.id];
    if (one.state !== "not_used") {
      const carried = carriedFor(r, d.id, earlier);
      if (carried) {
        one.carried = carried;
        one.given = `${carried.words}: the same holder and settings as ${carried.since}, so nothing is asked again. ${one.given}`.trim();
      }
    }
    return one;
  });
  const out = {
    id: r.id, name: r.name, does: r.does, version: r.version, kind: "agent",
    handle: handleOf(r),
    stages,
    actions: actionsOf(r),
    log: [...r.log].reverse(),
    can_try: { pull_request: false, installed: false },
    summary: summaryOf(r),
    paused: null,
    archived: Boolean(r.archived),
    lifecycle: { project: r.lifecycle.project, at: r.lifecycle.at },
    timeline,
  };
  if (artifacts) out.artifacts = artifacts;
  if (r.project) out.project = r.project;
  // 0.4.6: the codebase this build knew, at the commit it knew.
  const src = sourceView(r);
  if (src) out.source = src;
  return out;
}

/** The codebase a build knew (Build.source, 0.4.6), or null for a build that knew none. */
export function sourceView(r) {
  const s = r.source;
  if (!s?.commit) return null;
  const at = s.commit.startsWith("sha256:") ? s.commit.slice(0, 19) : s.commit.slice(0, 7);
  return {
    starting_point: s.starting_point ?? "existing-code", trigger: s.trigger ?? "adoption", repository: s.shown, commit: s.commit,
    ...(s.at ? { at: s.at } : {}),
    words: s.trigger === "drift" ? `Reverse engineered again at ${at}, after ${s.shown} changed outside the lifecycle.` : `Taken on from ${s.shown} at ${at}.`,
  };
}

/** One stage of a build as the build answer shows it, before its cadence. */
function stageOfBuild(r, d, artifacts) {
  const choice = r.lifecycle.used[d.id] ?? { used: true, from: "default" };
  if (!choice.used) {
    return { stage: d.id, state: "not_used", holder: null, runs: 0, rounds: [], given: notUsedWords(choice.from, r.lifecycle.project), handed_back: { words: [], files: [] }, done_when_met: null, log: [], where: null };
  }
  const reviewed = reviewStageView(r, d.id, (artifacts ?? []).filter((a) => a.stage === d.id));
  if (reviewed) return reviewed;
  const s = r.stages[d.id];
  const planned = s ? null : planStageView(r, d.id);
  if (planned) return planned;
  if (!s) {
    return { stage: d.id, state: "not_offered", holder: null, runs: 0, rounds: [], given: notOfferedWords(d.id), handed_back: { words: [], files: [] }, done_when_met: null, log: [], where: null };
  }
  return {
    stage: d.id,
    state: s.state,
    holder: s.holder,
    runs: s.runs,
    rounds: [...s.rounds].reverse(),
    given: s.given,
    handed_back: { words: [...s.handed_back.words], files: s.handed_back.files.map((f) => ({ path: f.path, size: f.size, link: link(r.id, f.path) })) },
    done_when_met: s.done_when_met,
    log: [...s.log].reverse(),
    where: d.id === "code" ? pullRequestWhere(r.work?.pr) : null,
  };
}
