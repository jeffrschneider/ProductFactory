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

import { connect } from "./pull-request.mjs";

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
        const issue = { repo: c.repo, number: i.number, url: i.url };
        try {
          const r = await runner.start({ does: i.title || `Issue #${i.number}`, more: i.body.slice(0, BODY_LIMIT) }, undefined, { issue });
          started.push(r);
        } catch (e) {
          problem(`issue #${i.number} did not start a build: ${e.message}`);
        }
      }
      return started;
    })().finally(() => { polling = null; });
    return polling;
  }

  return {
    pollOnce,
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
