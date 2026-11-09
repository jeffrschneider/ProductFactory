// Builds from GitHub issues: an open issue with the label named in
// product-factory.json (intake.github_issues.label, default "product-factory")
// on the repository named under "repository" starts a build, with the
// issue's title as what the agent should do and its body as more. Product
// Factory reads the issues every poll_seconds; no webhook is needed.
//
// Each issue starts at most one build: the build keeps its issue (repo,
// number, address) in build.json, and an issue that already has a build is
// passed over. The build's log names the issue, and notices.mjs comments on
// it when a gate waits and when the build ends.
//
// One issue can also be started now, by its number (startIssue), for a
// client that should not wait for the next poll, such as the Claude Code
// plugin. It reads the same labelled issues, so the same rules hold: the
// issue is open, carries the label, and starts one build at most.

import { connect } from "./pull-request.mjs";
import { Refused } from "./lifecycle.mjs";

export const DEFAULT_LABEL = "product-factory";
const BODY_LIMIT = 20000;

/** Every open issue with the label (pull requests are left out). Resolves to { ok, issues, why? }. */
export async function labelledIssues(gh, repo, label) {
  const issues = [];
  for (let page = 1; page <= 10; page++) {
    let res;
    try {
      res = await gh.call("GET", `/repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100&page=${page}`);
    } catch {
      return { ok: false, issues, why: "GitHub did not answer" };
    }
    if (res.status !== 200 || !Array.isArray(res.body)) return { ok: false, issues, why: `GitHub answered ${res.status} for the issues of ${repo}` };
    for (const i of res.body) {
      if (i.pull_request || !Number.isInteger(i.number)) continue;
      if (!(i.labels ?? []).some((l) => (typeof l === "string" ? l : l?.name) === label)) continue;
      issues.push({ number: i.number, title: String(i.title ?? "").trim(), body: String(i.body ?? "").trim(), url: String(i.html_url ?? "") });
    }
    if (res.body.length < 100) break;
  }
  return { ok: true, issues };
}

export function createIssueIntake({ config, env = process.env, store, runner, log = () => {}, fetchImpl }) {
  const settings = config.intake?.github_issues ?? null;
  let timer = null;
  let polling = null;
  let lastProblem = null;

  const problem = (why) => { if (why !== lastProblem) log(`Issues on ${config.repository?.repo}: ${why}`); lastProblem = why; };

  /** Reads the labelled issues once, and starts a build for each one that has none. Resolves to the builds started. */
  async function pollOnce() {
    if (!settings) return [];
    if (polling) return polling;
    polling = (async () => {
      const c = connect(config.repository, env, fetchImpl ? { fetchImpl } : {});
      if (c.problem) { problem(c.problem); return []; }
      const got = await labelledIssues(c.gh, c.repo, settings.label);
      if (!got.ok) { problem(got.why); return []; }
      lastProblem = null;
      const had = new Set(store.list().filter((r) => r.issue?.repo === c.repo).map((r) => r.issue.number));
      const started = [];
      for (const i of got.issues) {
        if (had.has(i.number)) continue;
        try {
          started.push(await startOne(c.repo, i));
        } catch (e) {
          problem(`issue #${i.number} did not start a build: ${e.message}`);
        }
      }
      return started;
    })().finally(() => { polling = null; });
    return polling;
  }

  /** Starts the build for one issue, with the issue kept on it. who: the person who asked, when one did. */
  const startOne = (repo, i, who = undefined) => runner.start({ does: i.title || `Issue #${i.number}`, more: i.body.slice(0, BODY_LIMIT) }, who, { issue: { repo, number: i.number, url: i.url } });

  /**
   * Starts the build for one issue now, by its number, as who. Resolves to the build.
   * Throws Refused in words: intake is off, GitHub cannot be read, the issue
   * is not open with the label, or it already has a build (409, with .build).
   */
  async function startIssue(number, who = undefined) {
    if (!settings) throw new Refused(409, "Builds start from issues only when intake is on: add \"intake\": { \"github_issues\": { \"label\": \"product-factory\" } } to product-factory.json, with the repository it reads.");
    if (!Number.isInteger(number) || number < 1) throw new Refused(400, "An issue is named by its number, such as 12.");
    await polling;
    const c = connect(config.repository, env, fetchImpl ? { fetchImpl } : {});
    if (c.problem) throw new Refused(409, c.problem);
    const had = store.list().find((r) => r.issue?.repo === c.repo && r.issue.number === number);
    if (had) { const e = new Refused(409, `Issue #${number} already started build ${had.id} (${had.name} ${had.version}). An issue starts one build at most.`); e.build = had; throw e; }
    const got = await labelledIssues(c.gh, c.repo, settings.label);
    if (!got.ok) throw new Refused(502, `Issues on ${c.repo}: ${got.why}.`);
    const i = got.issues.find((x) => x.number === number);
    if (!i) throw new Refused(404, `Issue #${number} is not an open issue labelled "${settings.label}" on ${c.repo}. Only those start builds.`);
    return startOne(c.repo, i, who);
  }

  return {
    pollOnce,
    startIssue,
    /** Reads the issues now and every poll_seconds, until stop. */
    watch() {
      if (!settings || timer) return;
      pollOnce().catch(() => {});
      timer = setInterval(() => { pollOnce().catch(() => {}); }, settings.poll_seconds * 1000);
      timer.unref?.();
    },
    stop: async () => { if (timer) { clearInterval(timer); timer = null; } await polling; },
  };
}
