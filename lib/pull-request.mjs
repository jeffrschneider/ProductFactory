// One builder's pull request on your repository (code.where "pull-request"):
// everything Product Factory does on GitHub for it, and nothing else.
//
//   openPullRequest     the build folder as one commit on a branch of its own, and the pull request
//   pullRequestHead     the pull request's newest commit, read when Product Factory polls it
//   readCommitFiles     every file of one commit
//   postResult          the build folder's check, or the reviewers' word, as a comment, and as a
//                       commit status where the token allows
//   readBranchFolder    the build folder as the branch's newest commit has it
//   commitOnBranch      the person's own change (an approval, answers, a send back) as one forward commit
//
// Ported from AgentMesh's hand-off (services/src/handoffs/issue.ts) with the
// rules unchanged. What did not come over: the GitHub App and its
// installations (here a token you name does the calls), check runs (a GitHub
// App's alone; here a commit status), and the stores and messages of the platform.
//
// Every call goes through the adlc console's GitHub client
// (adlc-console/lib/github.mjs createGitHubClient), which holds the token and
// sends it only to the API address. The branch is written through GitHub's
// Git Data API, so nothing is cloned and no token reaches a shell.

import { createGitHubClient, GitHubProblem } from "adlc-console/lib/github.mjs";
import { folderFor, inFolder } from "./fence.mjs";

/** The commit status's context, and the name Product Factory's comments carry (kept as it was, so a repository's branch rules on it still hold). */
export const CHECK_NAME = "Product Factory gate";
export const DEFAULT_API = "https://api.github.com";

/** The most files and bytes a commit may have. A commit over either is refused by name; it is never read in part. */
export const MAX_FILES = 2000;
export const MAX_BYTES = 50 * 1024 * 1024;

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const short = (sha) => String(sha).slice(0, 7);
const encRef = (branch) => branch.split("/").map(encodeURIComponent).join("/");

/** The branch a hand-off goes to. */
export const branchFor = (agent, version) => `adlc/${agent}-${version}`;

/** A name a branch and a folder can carry: the build's name when it is one, otherwise made from it. */
export function slugOf(name, fallback) {
  const s = String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63).replace(/-+$/, "");
  return NAME_RE.test(s) ? s : fallback;
}

/**
 * The client for a build's repository: { gh, repo } or { problem } in words.
 * repository: { host, repo, token, api } as product-factory.json names it;
 * the token is read from the environment variable it names, here and nowhere else.
 */
export function connect(repository, env = process.env, { fetchImpl } = {}) {
  if (!repository || repository.host !== "github") return { problem: "No repository is set. Name it in product-factory.json under repository: { \"host\": \"github\", \"repo\": \"owner/name\", \"token\": \"GITHUB_TOKEN\" }." };
  if (!REPO_RE.test(repository.repo ?? "")) return { problem: `The repository "${repository.repo}" is not owner/name.` };
  const token = String(env[repository.token] ?? "").trim();
  if (!token) return { problem: `The token for ${repository.repo} is read from ${repository.token}, which is not set. Put a GitHub token that may write to ${repository.repo} in it, then run it again.` };
  const gh = createGitHubClient({ token, api: repository.api || DEFAULT_API, ...(fetchImpl ? { fetchImpl } : {}), version: "product-factory" });
  return { gh, repo: repository.repo };
}

/** One call that never throws: GitHub not answering is status 0. */
async function call(gh, method, path, payload) {
  try { return await gh.call(method, path, payload); } catch (e) {
    if (e instanceof GitHubProblem) return { status: 0, body: null };
    throw e;
  }
}

/**
 * Open the pull request: the build folder as one commit on top of the
 * repository's default branch, in agents/<name>/, on its own branch, and a
 * pull request from it, with the title, body and commit message given. Every other file in the
 * repository is the repository's own and stays exactly as it was.
 * Resolves to { ok, record } or { ok: false, reason }. Never throws.
 */
export async function openPullRequest({ gh, repo, agent, version, folder: built, now = () => new Date(), title, body, message }) {
  if (!NAME_RE.test(agent)) return { ok: false, reason: "The agent's name is not one a branch can carry." };
  if (!VERSION_RE.test(version)) return { ok: false, reason: "The version is not major.minor.patch." };
  if (!REPO_RE.test(repo)) return { ok: false, reason: "The repository is not owner/name." };
  const { files, digests, scripts } = built;
  const branch = branchFor(agent, version);
  const at = `/repos/${repo}`;

  const info = await call(gh, "GET", at);
  if (info.status === 401) return { ok: false, reason: `GitHub turned down the token for ${repo}.` };
  if (info.status !== 200) return { ok: false, reason: info.status === 0 ? "GitHub did not answer." : `The token cannot see ${repo} (${info.status}). It must be able to read and write that repository.` };
  const base = String(info.body?.default_branch ?? "");
  const head = await call(gh, "GET", `${at}/git/ref/heads/${encRef(base)}`);
  if (head.status !== 200) return { ok: false, reason: `${repo} has no commit on ${base || "its default branch"} yet. Give it a first commit, then run Code again.` };
  const parent = String(head.body?.object?.sha ?? "");
  const baseCommit = await call(gh, "GET", `${at}/git/commits/${parent}`);
  if (baseCommit.status !== 200) return { ok: false, reason: `GitHub would not give ${base}'s commit (${baseCommit.status}).` };
  const baseTreeSha = String(baseCommit.body?.tree?.sha ?? "");

  // The build folder goes to a folder of its own, agents/<name>/, so a second
  // hand-off to the same repository never writes the first one's paths.
  const folder = folderFor(agent);
  const lead = `${folder}/`;
  // The repository's own files stay beside the build folder. Those outside
  // it are recorded by git blob id, by their path from the top. What an earlier version left
  // in the folder and this build folder does not carry is taken out.
  const baseTree = await call(gh, "GET", `${at}/git/trees/${baseTreeSha}?recursive=1`);
  if (baseTree.status !== 200 || !Array.isArray(baseTree.body?.tree)) return { ok: false, reason: `GitHub would not list ${base}'s files (${baseTree.status}).` };
  if (baseTree.body.truncated === true) return { ok: false, reason: `${repo} has more files than GitHub lists in one answer; hand off to a smaller repository.` };
  const repoFiles = {};
  const stale = [];
  for (const e of baseTree.body.tree) {
    if (e.type !== "blob" || !e.path || !e.sha) continue;
    if (!e.path.startsWith(lead)) repoFiles[e.path] = e.sha;
    else if (!files.has(e.path.slice(lead.length))) stale.push(e.path);
  }

  const tree = [];
  for (const [path, bytes] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const blob = await call(gh, "POST", `${at}/git/blobs`, { content: Buffer.from(bytes).toString("base64"), encoding: "base64" });
    if (blob.status !== 201) return { ok: false, reason: `GitHub would not take ${path} (${blob.status}).` };
    tree.push({ path: `${lead}${path}`, mode: "100644", type: "blob", sha: String(blob.body?.sha ?? "") });
  }
  for (const path of stale.sort()) tree.push({ path, mode: "100644", type: "blob", sha: null });
  const madeTree = await call(gh, "POST", `${at}/git/trees`, { base_tree: baseTreeSha, tree });
  if (madeTree.status !== 201) return { ok: false, reason: `GitHub would not make the tree (${madeTree.status}).` };
  const commit = await call(gh, "POST", `${at}/git/commits`, { message, tree: String(madeTree.body?.sha ?? ""), parents: [parent] });
  if (commit.status !== 201) return { ok: false, reason: `GitHub would not make the commit (${commit.status}).` };
  const issuedSha = String(commit.body?.sha ?? "");
  const ref = await call(gh, "POST", `${at}/git/refs`, { ref: `refs/heads/${branch}`, sha: issuedSha });
  if (ref.status !== 201) return { ok: false, reason: ref.status === 422 ? `${repo} already has a branch ${branch}. Delete it, or give the build another version, then run Code again.` : `GitHub would not make the branch (${ref.status}).` };

  const record = {
    repo, branch, base, folder, agent, version, digests, scripts, hosts: [], repoFiles,
    issued_at: now().toISOString(), issued_sha: issuedSha, number: null, url: null,
    head: issuedSha, judging: null, passed: null, runs: [], status_refused: false,
    base_sha: parent,
  };
  const pr = await call(gh, "POST", `${at}/pulls`, { title, head: branch, base, body });
  if (pr.status !== 201 || !Number.isInteger(pr.body?.number)) return { ok: false, reason: `The branch ${branch} is there, and GitHub would not open its pull request (${pr.status}).`, record };
  record.number = pr.body.number;
  record.url = String(pr.body?.html_url ?? `https://github.com/${repo}/pull/${pr.body.number}`);
  return { ok: true, record };
}

/** The pull request's newest commit and state: { ok, sha, ref, open, merged } or { ok: false, reason }. */
export async function pullRequestHead(gh, record) {
  const pr = await call(gh, "GET", `/repos/${record.repo}/pulls/${record.number}`);
  const sha = String(pr.body?.head?.sha ?? "");
  if (pr.status !== 200 || !sha) return { ok: false, reason: pr.status === 0 ? "GitHub did not answer." : `GitHub would not show pull request #${record.number} on ${record.repo} (${pr.status}).` };
  return { ok: true, sha, ref: pr.body?.head?.ref ?? "", open: pr.body?.state === "open", merged: Boolean(pr.body?.merged) };
}

/** Every file of one commit: { ok, files: Map<path, bytes> } or { ok: false, reason }. */
export async function readCommitFiles(gh, repo, sha) {
  const tree = await call(gh, "GET", `/repos/${repo}/git/trees/${encodeURIComponent(sha)}?recursive=1`);
  if (tree.status !== 200 || !Array.isArray(tree.body?.tree)) return { ok: false, reason: `GitHub would not give the commit's files (${tree.status}).` };
  if (tree.body.truncated === true) return { ok: false, reason: "The commit has more files than GitHub lists in one answer, so it was not checked." };
  const blobs = tree.body.tree.filter((e) => e.type === "blob" && e.path && e.sha);
  if (blobs.length > MAX_FILES) return { ok: false, reason: `The commit has ${blobs.length} files; Product Factory reads at most ${MAX_FILES}.` };
  const total = blobs.reduce((n, e) => n + (Number(e.size) || 0), 0);
  if (total > MAX_BYTES) return { ok: false, reason: `The commit's files come to ${Math.round(total / 1024 / 1024)} MB; Product Factory reads at most ${MAX_BYTES / 1024 / 1024} MB.` };
  const files = new Map();
  for (const e of blobs) {
    const b = await call(gh, "GET", `/repos/${repo}/git/blobs/${e.sha}`);
    if (b.status !== 200 || typeof b.body?.content !== "string") return { ok: false, reason: `GitHub would not give ${e.path} (${b.status}).` };
    files.set(e.path, Buffer.from(b.body.content, b.body.encoding === "base64" ? "base64" : "utf8"));
  }
  return { ok: true, files };
}

/**
 * Put Product Factory's word (the build folder's check, or the reviewers') on a commit: a commit status (pending while it runs,
 * then success or failure), where the token may post one, and, for a result,
 * the same words as one comment on the pull request.
 * Resolves to { commented, status } where status is "posted", "refused" or "skipped".
 */
export async function postResult(gh, record, sha, verdict, { pending = false, statuses = true } = {}) {
  let status = "skipped";
  if (statuses) {
    const state = pending ? "pending" : verdict.passed ? "success" : "failure";
    const description = (pending ? "The gate is running." : verdict.title).slice(0, 139);
    const s = await call(gh, "POST", `/repos/${record.repo}/statuses/${encodeURIComponent(sha)}`, { state, context: CHECK_NAME, description });
    status = s.status === 201 ? "posted" : "refused";
  }
  if (pending) return { commented: false, status };
  const said = await call(gh, "POST", `/repos/${record.repo}/issues/${record.number}/comments`, { body: `**${CHECK_NAME}: ${verdict.title}** (${short(sha)})\n\n${verdict.summary}` });
  return { commented: said.status === 201, status };
}

/** The pull request, checked before Product Factory reads or writes its branch: open, on its branch. { ok, head } or { ok: false, reason }. */
async function openHead(gh, record) {
  const pr = await call(gh, "GET", `/repos/${record.repo}/pulls/${record.number}`);
  const head = String(pr.body?.head?.sha ?? "");
  if (pr.status !== 200 || !head) return { ok: false, reason: pr.status === 0 ? "GitHub did not answer." : `GitHub would not show pull request #${record.number} on ${record.repo} (${pr.status}).` };
  if (pr.body?.head?.ref !== record.branch) return { ok: false, reason: `Pull request #${record.number} is no longer on ${record.branch}.` };
  if (pr.body?.state !== "open" || pr.body?.merged) return { ok: false, reason: `Pull request #${record.number} is not open. Reopen it, then give it more rounds.` };
  return { ok: true, head };
}

/**
 * The build folder as the pull request's newest commit has it, for a fix
 * round: every file in the hand-off's folder, by its path inside it.
 * Resolves to { ok, sha, files: Map<path, bytes> } or { ok: false, reason }. Never throws.
 */
export async function readBranchFolder(gh, record) {
  if (!record.number) return { ok: false, reason: `The hand-off to ${record.repo} has no pull request on record.` };
  const h = await openHead(gh, record);
  if (!h.ok) return h;
  const read = await readCommitFiles(gh, record.repo, h.head);
  if (!read.ok) return { ok: false, reason: read.reason };
  return { ok: true, sha: h.head, files: inFolder(record.folder ?? "", read.files) };
}

/**
 * One forward commit on the pull request's branch, on top of parent, with
 * these files written and these removed, inside the hand-off's folder. The
 * branch moves only forward, never forced: when it moved since parent, nothing
 * is written and moved is true. Resolves to { ok, sha } or { ok: false, reason, moved? }.
 */
export async function commitOnBranch(gh, record, { files = [], removed = [], message, parent }) {
  if (!record.number) return { ok: false, reason: `The hand-off to ${record.repo} has no pull request on record.` };
  if (!files.length && !removed.length) return { ok: false, reason: "Nothing changed to commit." };
  const at = `/repos/${record.repo}`;
  const prefix = String(record.folder ?? "").replace(/^\/+|\/+$/g, "");
  const full = (p) => (prefix ? `${prefix}/${p}` : p);
  const h = await openHead(gh, record);
  if (!h.ok) return h;
  if (h.head !== parent) return { ok: false, moved: true, reason: `${record.branch} moved to ${short(h.head)} since ${short(parent)}, so these changes were not committed.` };
  const commit = await call(gh, "GET", `${at}/git/commits/${parent}`);
  const baseTree = String(commit.body?.tree?.sha ?? "");
  if (commit.status !== 200 || !baseTree) return { ok: false, reason: `GitHub would not give the branch's newest commit (${commit.status}).` };
  const tree = [];
  for (const f of files) {
    const blob = await call(gh, "POST", `${at}/git/blobs`, { content: Buffer.from(f.bytes).toString("base64"), encoding: "base64" });
    if (blob.status !== 201) return { ok: false, reason: `GitHub would not take ${f.path} (${blob.status}).` };
    tree.push({ path: full(f.path), mode: "100644", type: "blob", sha: String(blob.body?.sha ?? "") });
  }
  for (const p of removed) tree.push({ path: full(p), mode: "100644", type: "blob", sha: null });
  const madeTree = await call(gh, "POST", `${at}/git/trees`, { base_tree: baseTree, tree });
  if (madeTree.status !== 201) return { ok: false, reason: `GitHub would not make the tree (${madeTree.status}).` };
  const made = await call(gh, "POST", `${at}/git/commits`, { message, tree: String(madeTree.body?.sha ?? ""), parents: [parent] });
  const sha = String(made.body?.sha ?? "");
  if (made.status !== 201 || !sha) return { ok: false, reason: `GitHub would not make the commit (${made.status}).` };
  const moved = await call(gh, "PATCH", `${at}/git/refs/heads/${encRef(record.branch)}`, { sha, force: false });
  if (moved.status !== 200) return moved.status === 422 ? { ok: false, moved: true, reason: `${record.branch} moved while the round's commit was being made, so it was not committed.` } : { ok: false, reason: `GitHub would not move ${record.branch} (${moved.status}).` };
  return { ok: true, sha };
}
