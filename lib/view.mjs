// A build's record (build.json) as the lifecycle API 0.3 answers it: every
// stage of stages.json once, in its order, each in a state the API names,
// and the actions the person may take now.

import { STAGES_DOC, stageById } from "./standards.mjs";
import { RUNS } from "./orchestrator.mjs";

const LAST_RUN = RUNS.indexOf("package");

/** Why a stage milestone 1 does not run reads not_offered, in words. */
export function notOfferedWords(stageId) {
  const at = STAGES_DOC.stages.findIndex((s) => s.id === stageId);
  const pkg = STAGES_DOC.stages.findIndex((s) => s.id === RUNS[LAST_RUN]);
  return at > pkg
    ? "Product Factory milestone 1 ends at Package, so it does not run this stage. A later milestone hands it to the runtime you bring."
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
  if (r.status === "working") return `Working at ${name}`;
  if (r.status === "waiting") return `Waiting on you at ${name}`;
  if (r.status === "refused") return `Refused at ${name}: waiting on you`;
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

function link(id, path) {
  return `/v1/lifecycle/builds/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}`;
}

/** The build for GET /builds/:id. timeline: the run's bars, from the runner (build.timeline). */
export function buildView(r, { timeline = [] } = {}) {
  const stages = STAGES_DOC.stages.map((d) => {
    const choice = r.lifecycle.used[d.id] ?? { used: true, from: "default" };
    if (!choice.used) {
      return { stage: d.id, state: "not_used", holder: null, runs: 0, rounds: [], given: notUsedWords(choice.from, r.lifecycle.project), handed_back: { words: [], files: [] }, done_when_met: null, log: [], where: null };
    }
    const s = r.stages[d.id];
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
  });
  const out = {
    id: r.id, name: r.name, does: r.does, version: r.version, kind: "agent",
    handle: "not installed: milestone 1 ends at Package",
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
  if (r.project) out.project = r.project;
  return out;
}
