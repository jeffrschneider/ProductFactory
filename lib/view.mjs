// A build's record (build.json) as the lifecycle API answers it: every stage
// of stages.json once, in its order, each in a state the API names, with its
// cadence (0.4.2), and the actions the person may take now.
//
// Review and Security review run inside Code's gate when Code is on a pull
// request (gate.mjs, review.mjs): their stages report what the gate's
// reviewers said on the commit Code's artifacts are from, done or refused.
//
// Lifecycle API 0.4.10: a version whose features are made in runs of their own
// (feature-runs.mjs) answers each one as a FeatureRun on the build
// (feature_runs: its feature, where it is, its Test and Code, its pull
// request, its actions and its timeline), and one board card per run on the
// build list (BuildListItem.feature_runs). The build's own Test and Code read
// across the runs, and its actions are the version's own and each open
// run's, every one naming the run it acts on (Action.run).

import { STAGES_DOC, stageById, roleById } from "./standards.mjs";
import { RUNS, BUILDER_STAGES as BUILT_BY_ONE } from "./orchestrator.mjs";
import { planStageView, handleOf } from "./runtime.mjs";
import { REVIEWERS } from "./review.mjs";
import { prCommit } from "./artifacts.mjs";
import { cadenceOf, carriedFor } from "./cadence.mjs";
import { agentSkills } from "./adapters.mjs";
import { runRecord, runAt, runWords, runEnded, FEATURE_ALL } from "./feature-runs.mjs";

const LAST_RUN = RUNS.indexOf("package");

/** Why a stage milestone 1 does not run reads not_offered, in words. */
export function notOfferedWords(stageId) {
  if (stageId === "reverse-engineering") return "Reverse engineering runs on existing code: when a build starts from it (New build, Start from existing code), or when the product's code changes outside the lifecycle. This build did not start from existing code, so it did not run.";
  // stages.json 1.6.0: the Design part makes the agent's own files from the spec; the reference spec writer makes them at Requirements.
  // A build on a process with no architecture phase (make-a-new-agent.txt before v3, or a build started from code or a record).
  if (stageId === "architecture") return "This build's process has no architecture phase, so no architecture record is made. The agent's own files, its Design part, are made from the spec by the spec writer, in the same job as the spec at Requirements; they are this stage's artifact.";
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
  // Code on a pull request: the build can be sent back to Test, or to Requirements (0.4.7), while it waits on pushes or on your OK.
  const onPr = at === "code" && r.settings?.code?.holder === "pull-request" && r.work?.pr?.number && !r.work?.back_to_test && !r.work?.back_to_requirements;
  const backToTest = a("back_to_test", "Send back to Test", [{ name: "changes", label: "What is wrong with the suite, for the test writer", kind: "words" }]);
  const backToReq = a("back_to_requirements", "Send back to Requirements", [{ name: "changes", label: "What should change in the spec, for the spec writer", kind: "words" }]);
  // A feature's own run (make-a-feature.txt): its OK waits while another feature accepted since is being
  // brought in (feature-runs.mjs). Send back to Requirements takes its version back to the spec.
  if (r.feature_run) return actionsOf({ ...r, feature_run: null }).filter((x) => !(x.name === "accept" && r.work?.behind));
  // One builder (lifecycle API 0.5.0): at a stage it holds, the build can be sent back to any earlier stage, with your words.
  // On a pull request (code.where "pull-request") it works while your assistant pushes, so it can be sent back then too.
  const builderOnPr = r.settings?.code?.where === "pull-request" && r.work?.builder?.pr?.number;
  if (r.one_builder && BUILT_BY_ONE.includes(at) && (["waiting", "refused"].includes(r.status) || (r.status === "working" && builderOnPr))) {
    const earlier = ["requirements", ...BUILT_BY_ONE].slice(0, ["requirements", ...BUILT_BY_ONE].indexOf(at)).filter((s) => r.stages?.[s]);
    const sendBack = earlier.length ? [a("send_back", "Send back", [{ name: "to", label: "The stage to send it back to", kind: "choice", options: earlier, default: earlier.at(-1) }, { name: "changes", label: "What should change, for that stage", kind: "words" }])] : [];
    if (r.status === "working") return [...sendBack, stop];
    if (r.status === "waiting") return [a("changes", "Answer the questions", [{ name: "changes", label: "Your answers to what the build folder asks, one per line as key: answer", kind: "words" }]), ...sendBack, stop];
    return [a("resume", "Give it more rounds"), ...sendBack, stop];
  }
  if (r.status === "working") return onPr ? [backToTest, backToReq, stop] : [stop];
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
      return onPr ? [a("accept", "OK the code"), backToTest, backToReq, stop] : [a("accept", "OK the code"), stop];
    }
    // The architecture record asked what only you can answer (make-a-new-agent.txt v3).
    if (at === "architecture") {
      return [a("changes", "Answer the questions", [{ name: "changes", label: "Your answers to the record's questions, one per line as key: answer", kind: "words" }]), stop];
    }
    return [stop];
  }
  if (r.status === "refused") {
    // The fix loop stopped (runner.mjs fixLoop): on a conflict the suite or the spec is the person's call; on a security
    // refusal the spec may have to change; with the rounds used up, any of the three.
    const stopped = at === "code" && r.work?.pr?.number ? r.work.pr.fix?.stopped : null;
    const more = a("resume", "Give it more rounds");
    if (stopped === "conflict") return [backToTest, backToReq, stop];
    if (stopped === "security") return [backToReq, more, stop];
    if (stopped === "rounds") return [more, backToTest, backToReq, stop];
    const out = [a("resume", at === "code" ? "Give it more rounds" : "Run it again")];
    if (at === "requirements") out.push(a("changes", "Ask for changes", [{ name: "changes", label: "What should change, or your answers to the open questions", kind: "words" }]));
    // Code was refused: the spec may be what has to change (0.4.7).
    if (at === "code") out.push(backToReq);
    return [...out, stop];
  }
  // Ended: done or stopped.
  return [r.archived ? a("unarchive", "Unarchive") : a("archive", "Archive")];
}

/**
 * The actions a build answer offers (lifecycle API 0.4.10): each open feature
 * run's, its label naming the feature and run naming the run it acts on,
 * then the version's own. A build without feature runs offers its own.
 */
export function buildActions(r) {
  const own = actionsOf(r.own_status ? { ...r, status: r.own_status, work: r.own_work } : r);
  if (!Array.isArray(r.feature_runs)) return own;
  const runs = r.feature_runs.filter((fr) => !runEnded(fr)).flatMap((fr) => runActions(r, fr));
  return [...runs, ...own];
}

/**
 * One feature run's actions, each naming the run. Archive belongs to the
 * version alone, and so does Stop for the whole spec's one run: stopping it
 * is stopping the build.
 */
const runActions = (r, fr) => actionsOf(runRecord(r, fr))
  .filter((x) => !["archive", "unarchive"].includes(x.name) && !(x.name === "stop" && fr.feature === FEATURE_ALL))
  .map((x) => ({ ...x, run: fr.id, label: fr.feature === FEATURE_ALL ? x.label : `${x.label}: ${fr.feature}` }));

/** Where the build ended, or where it is, in words. */
export function summaryOf(r) {
  const name = nameOf(r.at);
  // A version making its features in runs of their own: how many, and how many wait on you.
  if (Array.isArray(r.feature_runs) && r.feature_runs.length && r.own_status === "working" && r.at === "code") {
    const open = r.feature_runs.filter((fr) => !runEnded(fr));
    // The whole spec in one run reads as a build in one chain does.
    if (open.length === 1 && open[0].feature === FEATURE_ALL) return summaryOf(runRecord(r, open[0]));
    const waiting = open.filter((fr) => fr.status === "waiting").length;
    return `Making ${open.length === 1 ? "1 feature" : `${open.length} features`}, each in a run of its own${waiting ? `: ${waiting} ${waiting === 1 ? "waits" : "wait"} on you` : ""}`;
  }
  const pr = r.at === "code" ? r.work?.pr : null;
  if (r.status === "working" && pr?.number && pr.fix?.running && !r.work.back_to_test && !r.work.back_to_requirements) return pr.judging ? `Working at Code: fix round ${pr.fix.round}, the gate is running on pull request #${pr.number}` : `Working at Code: fix round ${pr.fix.round}, your coding harness is working on pull request #${pr.number}`;
  if (r.status === "working" && pr?.number && !r.work.back_to_test && !r.work.back_to_requirements) return pr.judging ? `Working at Code: the gate is running on pull request #${pr.number}` : `Working at Code: waiting for a push to pull request #${pr.number}`;
  if (r.at === "deploy" && r.status === "waiting" && r.stages.deploy?.gate === "approve") return `Packed and validated · ${r.name} ${r.version} · Approve the deploy`;
  if (r.at === "deploy" && r.status === "waiting") return `Packed and validated · ${r.name} ${r.version} · Hand this package to your runtime`;
  if (r.at === "deploy" && r.status === "done") return `Handed to your runtime · ${r.name} ${r.version}`;
  // The run went on past the deploy to Conformance (make-a-new-agent.txt v3), and ended before the publish gate.
  if (r.at === "conformance" && r.status === "done") return `Handed to your runtime · ${r.name} ${r.version} · Passed the Common Agent checks that run here`;
  if (r.status === "working") return `Working at ${name}`;
  if (r.status === "waiting") return `Waiting on you at ${name}`;
  if (r.status === "refused") return `Refused at ${name}: waiting on you`;
  if (r.status === "stopped" && r.work?.not_an_agent) return "Stopped at Code: the code cannot be packaged as an agent";
  if (r.status === "stopped") return `Stopped at ${name}`;
  // A feature run ends at your OK: what comes after Code is the version's, not the run's.
  if (r.feature_run && r.status === "done") return r.work?.pr?.number ? `You OK'd the code on pull request #${r.work.pr.number}` : "You OK'd the code";
  if (r.at === "package") return `Packed and validated · ${r.name} ${r.version}`;
  return `Code OK'd · ${r.name} ${r.version} · Package is not part of this lifecycle`;
}

const STATE_OF_STATUS = { working: "working", waiting: "waiting_on_you", refused: "refused", stopped: "stopped", done: "done" };

/** The list item for GET /builds. A version with feature runs carries one board card per run (0.4.10). */
export function listItem(r) {
  const s = r.stages[r.at];
  return {
    id: r.id, name: r.name, does: r.does, version: r.version, kind: "agent",
    at: { stage: r.at, state: s?.state ?? STATE_OF_STATUS[r.status], summary: summaryOf(r) },
    archived: Boolean(r.archived), updated: r.updated,
    ...(Array.isArray(r.feature_runs) && r.feature_runs.length ? { feature_runs: r.feature_runs.map((fr) => runCard(r, fr)) } : {}),
  };
}

/** A feature run as a board card (FeatureRunCard, 0.4.10): which feature, and where its run is. */
export function runCard(r, fr) {
  return { id: fr.id, feature: fr.feature, name: runWords(fr), started: fr.started, at: runAt(fr, summaryOf(runRecord(r, fr))), ended: runEnded(fr) };
}

/**
 * A feature run as the build answer shows it (FeatureRun, 0.4.10): its
 * feature, where it is, its Test and Code as stages, its pull request, the
 * actions it offers (each naming it), its log and its timeline.
 */
export function runView(r, fr, { timeline = [] } = {}) {
  const v = runRecord(r, fr);
  const files = (one) => ({ ...one, handed_back: { ...one.handed_back, files: one.handed_back.files.map((f) => ({ ...f, link: link(r.id, `runs/${fr.id}/${f.path}`) })) } });
  const stages = STAGES_DOC.stages.filter((d) => fr.stages?.[d.id]).map((d) => ({ ...files(stageOfBuild(v, d, null)), cadence: cadenceOf(d.id) }));
  return {
    ...runCard(r, fr),
    by: fr.by ?? null,
    stages,
    actions: runEnded(fr) ? [] : runActions(r, fr),
    pull_request: pullRequestWhere(fr.work?.pr),
    log: [...fr.log].reverse(),
    timeline,
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

/**
 * A stage's holder with its skills (lifecycle API 0.4.9), for the stage
 * workspace. A reference agent's are read from the adlc checkout, and one with
 * no skills folder lists none. An agent Product Factory only sends work to, such
 * as your coding harness, keeps its own, so one sentence says so. A person or an
 * outside tool is left as it is.
 */
export function holderWithSkills(h, adlc) {
  if (!h || typeof h !== "object") return h;
  if (h.kind === "reference_agent") {
    const skills = agentSkills(adlc, h.name) ?? agentSkills(adlc, roleById.get(h.role)?.reference_agent);
    return skills ? { ...h, skills } : h;
  }
  if (h.kind === "your_agent" || h.kind === "contracted") {
    const who = /coding harness/.test(h.name ?? "") ? "your coding harness" : "that agent";
    return { ...h, skills_note: `Its skills are whatever ${who} has installed; Product Factory cannot see them.` };
  }
  return h;
}

/** The build for GET /builds/:id. timeline: the run's bars, from the runner (build.timeline). artifacts: what it made and will make (artifacts.mjs, added in 0.4). earlier: the product's builds started before this one, newest first, for the setup stages carried forward (0.4.2). */
export function buildView(r, { timeline = [], artifacts = null, earlier = [], featureCounts = {}, runTimeline = () => [] } = {}) {
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
    actions: buildActions(r),
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
  // 0.4.10: each feature made in a run of its own.
  if (Array.isArray(r.feature_runs) && r.feature_runs.length) out.feature_runs = r.feature_runs.map((fr) => runView(r, fr, { timeline: runTimeline(fr.id) }));
  // 0.4.6: the codebase this build knew, at the commit it knew.
  const src = sourceView(r);
  if (src) out.source = src;
  return out;
}

/** The codebase a build knew (Build.source, 0.4.6), or null for a build that knew none. A build started from an as-built record (0.4.7) names the code the record describes, and where the record was read. */
export function sourceView(r) {
  if (r.starting_point === "as-built-record" && r.record?.code?.commit) {
    const c = r.record.code;
    const at = c.commit.startsWith("sha256:") ? c.commit.slice(0, 19) : c.commit.slice(0, 7);
    const record = r.record.folder ? { folder: r.record.folder } : { repository: r.record.repository, ...(r.record.read_at || r.record.commit ? { commit: r.record.read_at ?? r.record.commit } : {}), ...(r.record.path ? { path: r.record.path } : {}) };
    return { starting_point: "as-built-record", repository: c.repository, commit: c.commit, record, ...(r.record.at ? { at: r.record.at } : {}), words: `Rebuilt from the as-built record of ${c.repository} at ${at}, read from ${r.record.shown}. The code it describes is not taken on; Code writes the code fresh.` };
  }
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
