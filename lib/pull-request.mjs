// Code as a pull request: the "Write the scripts" pull request on your
// repository, everything Product Factory does on it, and nothing else.
//
//   openPullRequest     the build folder as one commit on a branch of its own, and the pull request
//   pullRequestHead     the pull request's newest commit, read when Product Factory polls it
//   readCommitFiles     every file of one commit, for the gate
//   postResult          the gate's result as a comment, and as a commit status where the token allows
//   revisePullRequest   the revised tests after Send back to Test, or the revised spec and tests
//                       after Send back to Requirements (0.4.7), as one forward commit
//   takePullRequest     your OK: the scripts from the exact commit the gate passed, and the merge there
//   readBranchFolder    the build folder as the branch's newest commit has it, for a fix round
//   commitFixRound      what your coding harness changed in a fix round (scripts/, and
//                       records/conflict.md), as one forward commit Product Factory makes
//   upToDatePullRequest a feature's pull request brought up to date with the version's base
//                       after another feature was merged there, as one merge commit
//
// Ported from AgentMesh's hand-off (services/src/handoffs/issue.ts, gate.ts,
// revise.ts and accept.ts) with the rules unchanged. What did not come over:
// the GitHub App and its installations (here a token you name does the
// calls), check runs (a GitHub App's alone; here a commit status), the daily
// cap on gate runs (it paid for sandbox jobs; here the gate runs on your
// computer), and the stores and messages of the platform.
//
// Every call goes through the adlc console's GitHub client
// (adlc-console/lib/github.mjs createGitHubClient), which holds the token and
// sends it only to the API address. The branch is written through GitHub's
// Git Data API, so nothing is cloned and no token reaches a shell.

import { createGitHubClient, GitHubProblem } from "adlc-console/lib/github.mjs";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { CONFLICT_FILE, LOCK_FILE, digestOf, folderFor, gitBlobSha, inFolder, scriptsOfHandoff } from "./fence.mjs";
import { upToDate, pinnedDigests } from "./feature-runs.mjs";

export const PR_TITLE_PREFIX = "Write the scripts:";
/** The commit status's context, and the name the gate's comments carry. */
export const CHECK_NAME = "Product Factory gate";
export const DEFAULT_API = "https://api.github.com";

/** The most files and bytes a commit may have. A commit over either is refused by name; it is never read in part. */
export const MAX_FILES = 2000;
export const MAX_BYTES = 50 * 1024 * 1024;

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const short = (sha) => String(sha).slice(0, 7);
const rel = (base, at) => relative(base, at).split(sep).join("/");
const encRef = (branch) => branch.split("/").map(encodeURIComponent).join("/");

/** The branch a hand-off goes to. */
export const branchFor = (agent, version) => `adlc/${agent}-${version}`;
/** The branch of one feature's run: the version's, with the feature's id. */
export const featureBranchFor = (agent, version, feature) => `${branchFor(agent, version)}-${String(feature).toLowerCase()}`;
const FEATURE_RE = /^[A-Za-z][A-Za-z0-9-]{0,40}$/;

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

/** The pull request's words: where the folder is, what to do, where the rules are, how it is judged. */
export function pullRequestBody(agent, version, scripts, folder, feature = null) {
  const at = folder ? `${folder}/` : "";
  return [
    `This branch holds the build folder for **${agent} ${version}**${at ? ` in \`${at}\`, a folder of its own` : ""}. Your coding agent writes ${scripts.map((s) => `\`${at}${s}\``).join(", ")} there.`,
    ...(feature ? ["", `It makes one feature of the version, **${feature.words}**, in a pull request of its own. The suite holds this feature's tests and every test of the features already accepted, so the gate holds it to all of them. When another feature is accepted and merged first, Product Factory brings this branch up to date with it before the gate runs again.`] : []),
    "",
    `- \`${at}AGENTS.md\` (and \`${at}CLAUDE.md\`) carry the house rules. Read them first.`,
    `- \`node .adlc/check.mjs\`, run in \`${at || "the top of the repository"}\`, runs the suite the way the gate will.`,
    `- Only \`${at}scripts/\` is yours to change. You may add a test under \`${at}test/\`. A change to an existing test or to the spec goes back through the spec and test steps, so the gate refuses it.`,
    ...(at ? [`- Nothing outside \`${at}\` may change, and the default branch need not be merged in: every hand-off has its own folder.`] : []),
    `- If a test cannot pass without breaking what the agent's files say, write why in \`${at}${CONFLICT_FILE}\` and push it. The gate stops there, and the owner decides whether to send the build back to Test.`,
    "",
    `Product Factory checks this pull request for new pushes and runs its gate on each: the fence on what may change, the suite, and the reviewers your lifecycle uses. It says the result here, and as the commit status "${CHECK_NAME}" where its token may post one. When it passes, the owner gives the OK in Product Factory, which takes the scripts from that commit and merges this pull request there. Nothing here merges by itself.`,
  ].join("\n");
}

function filesOnDisk(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const at = join(d, name);
      if (statSync(at).isDirectory()) { if (name !== ".git") walk(at); } else out.push(rel(dir, at));
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * The build folder the hand-off laid out on disk, checked against its own
 * lock once, here: a folder that does not match what it says it pins is not
 * handed to anybody. From then on the lock's digests are Product Factory's,
 * kept on the build, and the gate reads only those.
 * Resolves to { ok, folder: { files, digests, scripts } } or { ok: false, reason }.
 */
export function readBuildFolder(dir) {
  if (!existsSync(join(dir, LOCK_FILE))) return { ok: false, reason: `The build folder carries no ${LOCK_FILE}.` };
  const files = new Map(filesOnDisk(dir).map((p) => [p, readFileSync(join(dir, ...p.split("/")))]));
  let lock;
  try { lock = JSON.parse(files.get(LOCK_FILE).toString("utf8")); } catch { return { ok: false, reason: `The build folder's ${LOCK_FILE} is not valid JSON.` }; }
  const digests = Object.fromEntries(Object.entries(lock?.digests ?? {}).filter(([, v]) => typeof v === "string"));
  const scripts = (Array.isArray(lock?.scripts) ? lock.scripts : []).map((s) => String(s?.path ?? "")).filter((p) => p.startsWith("scripts/"));
  const wrong = [];
  for (const [p, d] of Object.entries(digests)) {
    const got = files.get(p);
    if (!got) wrong.push(`${p} is missing`);
    else if (digestOf(got) !== d) wrong.push(`${p} differs from its digest`);
  }
  for (const p of files.keys()) {
    if (p in digests || p === LOCK_FILE || p.startsWith("scripts/") || p.startsWith("records/")) continue;
    wrong.push(`${p} is outside scripts/ and not pinned`);
  }
  if (wrong.length) return { ok: false, reason: `The build folder does not match its ${LOCK_FILE}: ${wrong.join("; ")}.` };
  if (!scripts.length) return { ok: false, reason: `The build folder's ${LOCK_FILE} names no scripts to write.` };
  return { ok: true, folder: { files, digests, scripts } };
}

/**
 * Open the pull request: the build folder as one commit on top of the
 * repository's default branch, in agents/<name>/, on its own branch, and a
 * "Write the scripts" pull request from it. Every other file in the
 * repository is the repository's own and stays exactly as it was.
 * Resolves to { ok, record } or { ok: false, reason }. Never throws.
 */
export async function openPullRequest({ gh, repo, agent, version, folder: built, feature = null, now = () => new Date(), title: givenTitle = null, body: givenBody = null, message: givenMessage = null }) {
  if (!NAME_RE.test(agent)) return { ok: false, reason: "The agent's name is not one a branch can carry." };
  if (!VERSION_RE.test(version)) return { ok: false, reason: "The version is not major.minor.patch." };
  if (!REPO_RE.test(repo)) return { ok: false, reason: "The repository is not owner/name." };
  if (feature && !FEATURE_RE.test(feature.id)) return { ok: false, reason: "The feature's id is not one a branch can carry." };
  const { files, digests, scripts } = built;
  // A feature made in a run of its own (make-a-feature.txt) has a branch and a pull request of its own.
  const branch = feature ? featureBranchFor(agent, version, feature.id) : branchFor(agent, version);
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
  // it are recorded by git blob id, by their path from the top, so the gate
  // lets them be as they were and nothing else. What an earlier version left
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
  const commit = await call(gh, "POST", `${at}/git/commits`, { message: givenMessage ?? `Hand off ${agent} ${version}: the build folder`, tree: String(madeTree.body?.sha ?? ""), parents: [parent] });
  if (commit.status !== 201) return { ok: false, reason: `GitHub would not make the commit (${commit.status}).` };
  const issuedSha = String(commit.body?.sha ?? "");
  const ref = await call(gh, "POST", `${at}/git/refs`, { ref: `refs/heads/${branch}`, sha: issuedSha });
  if (ref.status !== 201) return { ok: false, reason: ref.status === 422 ? `${repo} already has a branch ${branch}. Delete it, or give the build another version, then run Code again.` : `GitHub would not make the branch (${ref.status}).` };

  // base_sha and synced_sha: the base this branch was made on, and the commit of the branch that last met it (upToDatePullRequest).
  const record = {
    repo, branch, base, folder, agent, version, digests, scripts, hosts: [], repoFiles,
    issued_at: now().toISOString(), issued_sha: issuedSha, number: null, url: null,
    head: issuedSha, judging: null, passed: null, runs: [], status_refused: false,
    base_sha: parent, synced_sha: issuedSha,
    ...(feature ? { feature: feature.id } : {}),
  };
  const title = givenTitle ?? `${PR_TITLE_PREFIX} ${agent} ${version}${feature ? `, ${feature.words}` : ""}`;
  const pr = await call(gh, "POST", `${at}/pulls`, { title, head: branch, base, body: givenBody ?? pullRequestBody(agent, version, scripts, folder, feature) });
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
  if (blobs.length > MAX_FILES) return { ok: false, reason: `The commit has ${blobs.length} files; the gate checks at most ${MAX_FILES}.` };
  const total = blobs.reduce((n, e) => n + (Number(e.size) || 0), 0);
  if (total > MAX_BYTES) return { ok: false, reason: `The commit's files come to ${Math.round(total / 1024 / 1024)} MB; the gate checks at most ${MAX_BYTES / 1024 / 1024} MB.` };
  const files = new Map();
  for (const e of blobs) {
    const b = await call(gh, "GET", `/repos/${repo}/git/blobs/${e.sha}`);
    if (b.status !== 200 || typeof b.body?.content !== "string") return { ok: false, reason: `GitHub would not give ${e.path} (${b.status}).` };
    files.set(e.path, Buffer.from(b.body.content, b.body.encoding === "base64" ? "base64" : "utf8"));
  }
  return { ok: true, files };
}

/**
 * Put the gate's word on a commit: a commit status (pending while it runs,
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

/** The checks the test writer adds to every suite itself. */
const OWN = /^test\/(delivered-formats|records-per-job|worked-values)\.test\.mjs$/;
const isTestPath = (p) => /^test\/[A-Za-z0-9._-]+$/.test(p);
/** A pinned file's path in the build folder that a revised spec may change: anything the hand-off pins, never scripts/, records/ or the lock. */
const isPinnedPath = (p) => /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(p) && !p.split("/").includes("..") && !p.startsWith("scripts/") && !p.startsWith("records/") && p !== LOCK_FILE;

/** The fence's digests and the lock's, with each revised test's moved and each removed test's taken out. Pure. */
export function revisedDigests(digests, tests, removed = []) {
  const out = { ...digests };
  for (const t of tests) out[t.path] = digestOf(Buffer.from(t.bytes));
  for (const p of removed) delete out[p];
  return out;
}

/** The comment the new round puts on the pull request. Pure. */
export function revisedComment(tests, removed, words, sha) {
  const mine = tests.filter((t) => !OWN.test(t.path)).map((t) => `\`${t.path}\``);
  const own = tests.filter((t) => OWN.test(t.path)).map((t) => `\`${t.path}\``);
  return [
    `**The tests were revised** (${short(sha)}), after the owner sent the build back to Test in Product Factory.`,
    "",
    `The test writer revised ${mine.join(", ") || "no file of its own"}.${own.length ? ` Its standard checks, which every suite carries, came back current: ${own.join(", ")}.` : ""}${removed.length ? ` It no longer carries ${removed.map((p) => `\`${p}\``).join(", ")}, so they are taken out.` : ""} This commit also updates \`${LOCK_FILE}\` with their digests and removes \`${CONFLICT_FILE}\`. Your scripts are as you left them.`,
    ...(words.trim() ? ["", "The owner said:", ...words.trim().split(/\r?\n/).map((l) => `> ${l}`)] : []),
    "",
    "Pull this commit and carry on writing the scripts against the suite as it now stands. Every push runs the gate again.",
  ].join("\n");
}

/** The comment the new round puts on the pull request after Send back to Requirements (lifecycle API 0.4.7). Pure. */
export function revisedSpecComment(files, removed, words, sha) {
  const quote = (p) => `\`${p}\``;
  const tests = files.filter((t) => t.path.startsWith("test/")).map((t) => quote(t.path));
  // The spec itself (spec.json and spec.md, stages.json 1.6.0), then what the hand-off made from it: the agent's own files and the rest it pins.
  const isSpec = (p) => p === "spec.json" || p === "spec.md";
  const spec = files.filter((t) => isSpec(t.path)).map((t) => quote(t.path));
  const made = files.filter((t) => !t.path.startsWith("test/") && !isSpec(t.path)).map((t) => quote(t.path));
  const specWords = spec.length ? `The revised spec changed ${spec.join(", ")}.` : "The spec's files are as they were.";
  const madeWords = made.length ? ` The files made from it changed: ${made.join(", ")}.` : " The agent's own files are as they were.";
  return [
    `**The spec and the tests were revised** (${short(sha)}), after the owner sent the build back to Requirements in Product Factory and approved the revised spec.`,
    "",
    `${specWords}${madeWords} ${tests.length ? `The test writer revised ${tests.join(", ")} against it.` : "No test changed."}${removed.length ? ` The build folder no longer carries ${removed.map(quote).join(", ")}, so they are taken out.` : ""} This commit also writes ${quote(LOCK_FILE)} with the new digests and removes ${quote(CONFLICT_FILE)}. Your scripts are as you left them.`,
    ...(words.trim() ? ["", "The owner asked the spec to change:", ...words.trim().split(/\r?\n/).map((l) => `> ${l}`)] : []),
    "",
    "Pull this commit and carry on writing the scripts against the spec and the suite as they now stand. Every push runs the gate again.",
  ].join("\n");
}

/**
 * Write the revised tests on the pull request's branch, as one forward commit:
 * each revised test at its path in the build folder, build.lock.json with
 * their digests moved (so the coding agent's local check agrees), and
 * records/conflict.md removed (so the next gate run does not stop on the old
 * conflict). The coding agent's scripts are left exactly as they are. The
 * branch moves only forward, never forced.
 *
 * THE FENCE MOVES FIRST. The gate judges every push against the digests
 * Product Factory keeps, never the lock on the branch, so setDigests moves
 * them to the revised tests before the branch moves, and back if it cannot.
 *
 * With spec (Send back to Requirements, lifecycle API 0.4.7), tests may be
 * any pinned file of the build folder the revised spec and suite changed (the
 * agent's files, the tests, AGENTS.md and the rest the hand-off writes, never
 * scripts/), and lock is the new build folder's own build.lock.json, written
 * whole; its digests become the fence's.
 * Resolves to { ok, sha, digests } or { ok: false, reason }. Never throws.
 */
export async function revisePullRequest(gh, record, { tests, removed = [], words = "", spec = false, lock: given = null }, setDigests) {
  if (!record.number) return { ok: false, reason: `The hand-off to ${record.repo} has no pull request on record.` };
  if (!tests.length && !removed.length) return { ok: false, reason: spec ? "Nothing revised came back to write." : "No revised test came back to write." };
  if (spec && !(given && typeof given.digests === "object" && given.digests)) return { ok: false, reason: `The revised build folder's ${LOCK_FILE} has no digests.` };
  const bad = [...tests.map((t) => t.path), ...removed].find((p) => !(spec ? isPinnedPath(p) : isTestPath(p)));
  if (bad) return { ok: false, reason: spec ? `${bad} is not a pinned file's path in the build folder.` : `${bad} is not a test file's path in the build folder.` };
  const backTo = spec ? "Requirements" : "Test";
  const at = `/repos/${record.repo}`;
  const prefix = record.folder.replace(/^\/+|\/+$/g, "");
  const full = (p) => (prefix ? `${prefix}/${p}` : p);

  const pr = await call(gh, "GET", `${at}/pulls/${record.number}`);
  const head = String(pr.body?.head?.sha ?? "");
  if (pr.status !== 200 || !head) return { ok: false, reason: `GitHub would not show pull request #${record.number} on ${record.repo} (${pr.status}).` };
  if (pr.body?.head?.ref !== record.branch) return { ok: false, reason: `Pull request #${record.number} is no longer on ${record.branch}.` };
  if (pr.body?.state !== "open" || pr.body?.merged) return { ok: false, reason: `Pull request #${record.number} is not open. Reopen it, then send the build back to ${backTo} again.` };

  const read = await readCommitFiles(gh, record.repo, head);
  if (!read.ok) return { ok: false, reason: read.reason };
  let lock = {};
  const lockBytes = read.files.get(full(LOCK_FILE));
  if (lockBytes) { try { lock = JSON.parse(Buffer.from(lockBytes).toString("utf8")); } catch { lock = {}; } }
  const lockDigests = lock.digests && typeof lock.digests === "object" ? lock.digests : {};
  const newLock = spec ? given : { ...lock, digests: revisedDigests(lockDigests, tests, removed) };
  const digests = spec ? Object.fromEntries(Object.entries(given.digests).filter(([, v]) => typeof v === "string")) : revisedDigests(record.digests, tests, removed);

  const commit = await call(gh, "GET", `${at}/git/commits/${head}`);
  const baseTree = String(commit.body?.tree?.sha ?? "");
  if (commit.status !== 200 || !baseTree) return { ok: false, reason: `GitHub would not give the branch's newest commit (${commit.status}).` };
  const tree = [];
  const files = [...tests.map((t) => [t.path, Buffer.from(t.bytes)]), [LOCK_FILE, Buffer.from(`${JSON.stringify(newLock, null, 2)}\n`, "utf8")]];
  for (const [path, bytes] of files) {
    const blob = await call(gh, "POST", `${at}/git/blobs`, { content: bytes.toString("base64"), encoding: "base64" });
    if (blob.status !== 201) return { ok: false, reason: `GitHub would not take ${path} (${blob.status}).` };
    tree.push({ path: full(path), mode: "100644", type: "blob", sha: String(blob.body?.sha ?? "") });
  }
  for (const p of removed) if (read.files.has(full(p))) tree.push({ path: full(p), mode: "100644", type: "blob", sha: null });
  if (read.files.has(full(CONFLICT_FILE))) tree.push({ path: full(CONFLICT_FILE), mode: "100644", type: "blob", sha: null });
  const madeTree = await call(gh, "POST", `${at}/git/trees`, { base_tree: baseTree, tree });
  if (madeTree.status !== 201) return { ok: false, reason: `GitHub would not make the tree (${madeTree.status}).` };
  const names = [...tests.map((t) => t.path), ...removed];
  const made = await call(gh, "POST", `${at}/git/commits`, { message: `${spec ? "Revised spec and tests" : "Revised tests"} for ${record.agent} ${record.version}: ${names.join(", ")}`, tree: String(madeTree.body?.sha ?? ""), parents: [head] });
  const sha = String(made.body?.sha ?? "");
  if (made.status !== 201 || !sha) return { ok: false, reason: `GitHub would not make the commit (${made.status}).` };

  // Ours first, so the push this makes passes the fence; put back if the branch does not move.
  const before = record.digests;
  await setDigests(digests);
  const moved = await call(gh, "PATCH", `${at}/git/refs/heads/${encRef(record.branch)}`, { sha, force: false });
  if (moved.status !== 200) {
    await setDigests(before);
    return { ok: false, reason: moved.status === 422 ? `${record.branch} moved while the ${spec ? "spec and tests" : "tests"} were being written; send it back to ${backTo} again.` : `GitHub would not move ${record.branch} (${moved.status}).` };
  }
  await call(gh, "POST", `${at}/issues/${record.number}/comments`, { body: spec ? revisedSpecComment(tests, removed, words, sha) : revisedComment(tests, removed, words, sha) });
  return { ok: true, sha, digests };
}

/**
 * Your OK on the pull request. The gate's verdict is Product Factory's own
 * record of the run on the pull request's newest commit, so nothing pushed
 * after the gate ran can ride along: a later commit has no pass until the gate
 * runs on it. The scripts are read from that commit, and the pull request is
 * merged at that commit, so what is packed is what was merged.
 * Resolves to { ok, sha, merged, scripts: [{ path, bytes }] } or { ok: false, reason }. Never throws.
 */
export async function takePullRequest(gh, record) {
  if (!record.number) return { ok: false, reason: `The hand-off to ${record.repo} has no pull request on record, so there is nothing to take.` };
  const at = `/repos/${record.repo}`;
  const pr = await call(gh, "GET", `${at}/pulls/${record.number}`);
  const p = pr.body;
  const sha = String(p?.head?.sha ?? "");
  if (pr.status !== 200 || !sha) return { ok: false, reason: `GitHub would not show pull request #${record.number} on ${record.repo} (${pr.status}).` };
  if (p?.head?.ref !== record.branch) return { ok: false, reason: `Pull request #${record.number} is no longer on ${record.branch}.` };
  if (p?.state !== "open" && !p?.merged) return { ok: false, reason: `Pull request #${record.number} was closed without merging. Reopen it to go on.` };

  const run = [...(record.runs ?? [])].reverse().find((r) => r.sha === sha);
  if (record.passed !== sha || !run?.passed) {
    const why = record.judging === sha ? "is still running on it" : !run ? "has not run on it yet" : "did not pass on it";
    return { ok: false, reason: `The gate ${why}: the newest commit on pull request #${record.number} is ${short(sha)}. Give your OK once the gate says "Ready for your OK" on it.` };
  }

  const read = await readCommitFiles(gh, record.repo, sha);
  if (!read.ok) return { ok: false, reason: read.reason };
  const scripts = scriptsOfHandoff(record, read.files);
  if (!scripts.length) return { ok: false, reason: `Commit ${short(sha)} has no ${record.folder ? `${record.folder}/` : ""}scripts/ folder.` };

  if (p?.merged) return { ok: true, sha, merged: null, scripts };
  const merge = await call(gh, "PUT", `${at}/pulls/${record.number}/merge`, { sha, merge_method: "merge" });
  const mergedSha = String(merge.body?.sha ?? "");
  if (merge.status !== 200 || !mergedSha) {
    return { ok: false, reason: `GitHub would not merge pull request #${record.number} at ${short(sha)} (${merge.status}). Merge it there, then give your OK again.` };
  }
  return { ok: true, sha, merged: mergedSha, scripts };
}

/** The comment a pull request brought up to date carries. Pure. */
export function upToDateComment(sha, baseSha, { added = [], conflicts = [], words = "" } = {}) {
  const quote = (p) => `\`${p}\``;
  return [
    `**Brought up to date with the version's base** (${short(sha)}, merging ${short(baseSha)}).${words ? ` ${words}` : ""}`,
    "",
    `${added.length ? `The tests of the features already accepted came in beside this feature's own: ${added.map(quote).join(", ")}.` : "No test came in."} \`${LOCK_FILE}\` pins them, so the gate holds this pull request to every one of them.`,
    ...(conflicts.length ? ["", `Both this feature and the base changed ${conflicts.map(quote).join(", ")}. The base's version is in \`scripts/\`, and this feature's own is beside it under \`records/yours/\`: carry this feature's change into the base's version. \`records/up-to-date.md\` says the same.`] : []),
    "",
    "Pull this commit and carry on from it. Every push runs the gate again.",
  ].join("\n");
}

/**
 * Bring a feature's pull request up to date with the version's base, after
 * another feature was accepted and merged there: one merge commit on the
 * branch, its parents the branch's newest commit and the base's, so the
 * pull request merges cleanly later. Its folder is what upToDate makes of the
 * branch's folder, the base's, and the folder as the branch last met the base
 * (synced_sha); build.lock.json pins the new suite. The repository's own
 * files are the base's.
 *
 * THE FENCE MOVES FIRST, as in revisePullRequest: keep({ digests, repoFiles })
 * moves Product Factory's fence to the new folder before the branch moves,
 * and back if it cannot.
 * baseSha: the base's commit to bring it up to date with; the base branch's newest when not given.
 * Resolves to { ok, sha, added, conflicts } or { ok: false, reason, moved? }. Never throws.
 */
export async function upToDatePullRequest(gh, record, { baseSha = null, words = "" }, keep) {
  if (!record.number) return { ok: false, reason: `The hand-off to ${record.repo} has no pull request on record.` };
  const at = `/repos/${record.repo}`;
  const prefix = String(record.folder ?? "").replace(/^\/+|\/+$/g, "");
  const full = (p) => (prefix ? `${prefix}/${p}` : p);
  const h = await openHead(gh, record);
  if (!h.ok) return h;
  // The base as it stands now, unless the caller named the commit.
  if (!baseSha) {
    const ref = await call(gh, "GET", `${at}/git/ref/heads/${encRef(record.base)}`);
    baseSha = String(ref.body?.object?.sha ?? "");
    if (ref.status !== 200 || !baseSha) return { ok: false, reason: `GitHub would not give ${record.base}'s newest commit (${ref.status}).` };
  }
  const read = async (sha) => { const r = await readCommitFiles(gh, record.repo, sha); return r.ok ? r.files : null; };
  const [head, since, base] = [await read(h.head), await read(record.synced_sha ?? record.issued_sha), await read(baseSha)];
  if (!head || !since || !base) return { ok: false, reason: "GitHub would not give the files of the branch, of the base, or of the commit where they last met." };
  const merged = upToDate({ ancestor: inFolder(prefix, since), ours: inFolder(prefix, head), base: inFolder(prefix, base) });
  let lock = {};
  try { lock = JSON.parse(Buffer.from(inFolder(prefix, head).get(LOCK_FILE) ?? "{}").toString("utf8")); } catch { lock = {}; }
  const digests = pinnedDigests(record.digests, merged.files);
  merged.files.set(LOCK_FILE, Buffer.from(`${JSON.stringify({ ...lock, digests }, null, 2)}\n`, "utf8"));
  // The repository's own files are the base's from now on.
  const repoFiles = {};
  for (const [p, b] of base) if (!prefix || !p.startsWith(`${prefix}/`)) repoFiles[p] = gitBlobSha(b);

  const commit = await call(gh, "GET", `${at}/git/commits/${baseSha}`);
  const baseTree = String(commit.body?.tree?.sha ?? "");
  if (commit.status !== 200 || !baseTree) return { ok: false, reason: `GitHub would not give the base's commit (${commit.status}).` };
  const tree = [];
  for (const [p, bytes] of [...merged.files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const blob = await call(gh, "POST", `${at}/git/blobs`, { content: Buffer.from(bytes).toString("base64"), encoding: "base64" });
    if (blob.status !== 201) return { ok: false, reason: `GitHub would not take ${p} (${blob.status}).` };
    tree.push({ path: full(p), mode: "100644", type: "blob", sha: String(blob.body?.sha ?? "") });
  }
  for (const p of inFolder(prefix, base).keys()) if (!merged.files.has(p)) tree.push({ path: full(p), mode: "100644", type: "blob", sha: null });
  const madeTree = await call(gh, "POST", `${at}/git/trees`, { base_tree: baseTree, tree });
  if (madeTree.status !== 201) return { ok: false, reason: `GitHub would not make the tree (${madeTree.status}).` };
  const made = await call(gh, "POST", `${at}/git/commits`, { message: `Bring ${record.branch} up to date with ${record.base} at ${short(baseSha)}`, tree: String(madeTree.body?.sha ?? ""), parents: [h.head, baseSha] });
  const sha = String(made.body?.sha ?? "");
  if (made.status !== 201 || !sha) return { ok: false, reason: `GitHub would not make the commit (${made.status}).` };

  const before = { digests: record.digests, repoFiles: record.repoFiles };
  await keep({ digests, repoFiles });
  const moved = await call(gh, "PATCH", `${at}/git/refs/heads/${encRef(record.branch)}`, { sha, force: false });
  if (moved.status !== 200) {
    await keep(before);
    return moved.status === 422 ? { ok: false, moved: true, reason: `${record.branch} moved while it was being brought up to date.` } : { ok: false, reason: `GitHub would not move ${record.branch} (${moved.status}).` };
  }
  await call(gh, "POST", `${at}/issues/${record.number}/comments`, { body: upToDateComment(sha, baseSha, { added: merged.added, conflicts: merged.conflicts, words }) });
  return { ok: true, sha, added: merged.added, conflicts: merged.conflicts };
}

/** The pull request, checked as a fix round needs it: open, on its branch. { ok, head } or { ok: false, reason }. */
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

/** A path a fix round may commit: under scripts/, or records/conflict.md. */
export const fixRoundPath = (p) => typeof p === "string" && (/^scripts\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(p) && !p.split("/").some((x) => x === "." || x === "..") || p === CONFLICT_FILE);

/**
 * A fix round's commit: what your coding harness changed under scripts/ (and
 * records/conflict.md when it wrote one), as one forward commit on the pull
 * request's branch, on top of parent, the commit the round's folder was read
 * from. Product Factory makes the commit through the API with its own token;
 * the harness never holds one. files: [{ path, bytes }], removed: [path],
 * both inside the build folder. The branch moves only forward, never forced:
 * when it moved while the harness worked, nothing is written and moved is true.
 * Resolves to { ok, sha } or { ok: false, reason, moved? }. Never throws.
 */
export async function commitFixRound(gh, record, { files = [], removed = [], message, parent }) {
  if (!record.number) return { ok: false, reason: `The hand-off to ${record.repo} has no pull request on record.` };
  if (!files.length && !removed.length) return { ok: false, reason: "Nothing changed to commit." };
  const bad = [...files.map((f) => f.path), ...removed].find((p) => !fixRoundPath(p));
  if (bad) return { ok: false, reason: `${bad} is not a path a fix round commits: only scripts/ and ${CONFLICT_FILE}.` };
  return commitOnBranch(gh, record, { files, removed, message, parent });
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
