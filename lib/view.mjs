// A build's record (build.json) as the lifecycle API answers it: every stage
// of stages.json once, in its order, each in a state the API names, with its
// cadence (0.4.2), and the actions the person may take now.
//
// Review and Security review run once one builder's build folder check passes
// the build (runner.mjs judgedOutcome, review.mjs): their stages report what
// the reviewers said on the build Code's artifacts are from, done or refused.
// A build made before, whose Code was on a pull request with its own gate,
// reads its reviewers' verdicts from that gate's runs as it always did.

import { STAGES_DOC, stageById, roleById } from "./standards.mjs";
import { RUNS, BUILDER_STAGES as BUILT_BY_ONE } from "./orchestrator.mjs";
import { planStageView, handleOf } from "./runtime.mjs";
import { REVIEWERS } from "./review.mjs";
import { gateOf, prCommit } from "./artifacts.mjs";
import { cadenceOf, carriedFor } from "./cadence.mjs";
import { agentSkills } from "./adapters.mjs";

const LAST_RUN = RUNS.indexOf("package");

/** Why a stage milestone 1 does not run reads not_offered, in words. */
export function notOfferedWords(stageId) {
  if (stageId === "reverse-engineering") return "Reverse engineering runs on existing code: when a build starts from it (New build, Start from existing code), or when the product's code changes outside the lifecycle. This build did not start from existing code, so it did not run.";
  // stages.json 1.6.0: the Design part makes the agent's own files from the spec; the reference spec writer makes them at Requirements.
  // A build on a process with no architecture phase: one started from existing code or an as-built record.
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
  const backToReq = a("back_to_requirements", "Send back to Requirements", [{ name: "changes", label: "What should change in the spec, for the spec writer", kind: "words" }]);
  // One builder (lifecycle API 0.5.0): at a stage it holds, the build can be sent back with your words, to one of
  // the folder's two phases: the spec (Requirements), or the start of the build (Architecture and Design), which
  // opens the whole build again, tests included. A stage of the build after its first is never a choice of its own.
  // On a pull request (code.where "pull-request") it works while your assistant pushes, so it can be sent back then too.
  const builderOnPr = r.settings?.code?.where === "pull-request" && r.work?.builder?.pr?.number;
  if (r.one_builder && BUILT_BY_ONE.includes(at) && (["waiting", "refused"].includes(r.status) || (r.status === "working" && builderOnPr))) {
    const order = ["requirements", ...BUILT_BY_ONE];
    const earlier = ["requirements", BUILT_BY_ONE[0]].filter((s) => order.indexOf(s) < order.indexOf(at) && r.stages?.[s]);
    const sendBack = earlier.length ? [a("send_back", "Send back", [{ name: "to", label: "Send it back to the spec (Requirements), or to the start of the build (Architecture and Design: the whole build is judged again, and the tests can change)", kind: "choice", options: earlier, default: earlier.at(-1) }, { name: "changes", label: "What should change", kind: "words" }])] : [];
    if (r.status === "working") return [...sendBack, stop];
    if (r.status === "waiting") return [a("changes", "Answer the questions", [{ name: "changes", label: "Your answers to what the build folder asks, one per line as key: answer", kind: "words" }]), ...sendBack, stop];
    return [a("resume", "Give it more rounds"), ...sendBack, stop];
  }
  if (r.status === "working") return [stop];
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
    if (at === "code") return [a("accept", "OK the code"), stop];
    return [stop];
  }
  if (r.status === "refused") {
    const out = [a("resume", at === "code" ? "Give it more rounds" : "Run it again")];
    if (at === "requirements") out.push(a("changes", "Ask for changes", [{ name: "changes", label: "What should change, or your answers to the open questions", kind: "words" }]));
    // Code was refused: the spec may be what has to change (0.4.7).
    if (at === "code") out.push(backToReq);
    return [...out, stop];
  }
  // Ended: done or stopped.
  return [r.archived ? a("unarchive", "Unarchive") : a("archive", "Archive")];
}

/** Where the build ended, or where it is, in words. */
export function summaryOf(r) {
  const name = nameOf(r.at);
  if (r.at === "deploy" && r.status === "waiting" && r.stages.deploy?.gate === "approve") return `Packed and validated · ${r.name} ${r.version} · Approve the deploy`;
  if (r.at === "deploy" && r.status === "waiting") return `Packed and validated · ${r.name} ${r.version} · Hand this package to your runtime`;
  if (r.at === "deploy" && r.status === "done") return `Handed to your runtime · ${r.name} ${r.version}`;
  // The run went on past the deploy to Conformance, and ended before the publish gate.
  if (r.at === "conformance" && r.status === "done") return `Handed to your runtime · ${r.name} ${r.version} · Passed the Common Agent checks that run here`;
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
 * Review or Security review, from the reviewers one builder's build was
 * judged by (or, for a build made before, Code's gate on its pull request),
 * or null when the build has a record of its own for the stage. A reviewer
 * asked on the build Code's artifacts are from reads done or refused, with
 * its words; one not asked says why; one not reached yet is not_started.
 * outputs: the stage's artifacts, for the files it handed back.
 */
export function reviewStageView(r, stage, outputs = []) {
  const rv = REVIEWERS.find((x) => x.stage === stage);
  if (!rv || r.stages[stage]) return null;
  const ref = { kind: "reference_agent", name: rv.agent, role: rv.role };
  const bound = r.lifecycle?.holders?.[rv.role];
  const holder = bound && bound.kind !== "reference_agent" ? { ...bound, role: rv.role } : ref;
  const one = Boolean(r.one_builder);
  if (r.settings?.code?.holder !== "pull-request" && !one) {
    return blank(stage, "not_offered", `Product Factory asks ${rv.who} to read a build one builder made, once its build folder's check passes it. This build runs on the reference writers, so the suite is the gate and ${rv.who} is not asked.`);
  }
  // One builder: the reviewers read the build folder once its own check passes the build.
  const pr = gateOf(r);
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
  const prNo = one ? r.work?.builder?.pr?.number : pr?.number;
  const where = prNo ? ` on pull request #${prNo}` : "";
  const v = run?.reviews?.[rv.id] ?? null;
  // A gate run kept before the reviewers' verdicts were: a pass means every reviewer it asked passed.
  const legacy = !v && run?.passed && !run.reviews && outputs.some((a) => a.state === "made");
  if (!v && !legacy) {
    const when = one ? `reads the build folder${where} once its own check passes the build` : `reads the code inside Code's gate${where}, once the fence and the suite pass on a push`;
    return { ...blank(stage, "not_started", `${Cap(rv.who)} ${when}.`, holder), runs: asked.length, rounds };
  }
  const files = outputs.filter((a) => a.state === "made").flatMap((a) => a.files ?? []).map((f) => ({ path: f.path, size: f.size, link: f.link }));
  const said = v ? [v.words, ...(v.reasons ?? [])] : [`The gate passed ${short(sha)}, with ${rv.who}'s review.`];
  return {
    stage, state: !v || v.passed ? "done" : "refused", holder, runs: asked.length, rounds,
    given: `${one ? `Read in the build folder${where}, once its check passed the build, at` : `Read inside Code's gate${where}, at commit`} ${short(sha)}: the scripts, the suite and the agent's files${rv.id === "critic" ? ", with the change as a diff" : ""}.`,
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
