// A fake GitHub on 127.0.0.1: the REST calls Product Factory makes on a pull
// request, over a small git kept in memory (blobs named by their real git blob
// id, trees, commits, branches), so no test reaches the network.
//
//   const gh = await fakeGitHub({ repo: "acme/agents", files: { "README.md": "..." } });
//   gh.url                       the API address to give Product Factory
//   gh.push(branch, changes)     a commit on top of the branch: { path: text | null }, as a coding harness pushes
//   gh.filesAt(ref)              { path: text } at a branch or commit
//   gh.log(ref)                  the commits from a branch or commit back, newest first: [{ sha, message }]
//   gh.branch(name), gh.dropBranch(name)  a branch made from main, or deleted
//   gh.addIssue({ title, body, labels })  an open issue, as a person files one
//   gh.pulls, gh.issues, gh.comments, gh.statuses, gh.calls

import { createServer } from "node:http";
import { createHash } from "node:crypto";

export async function fakeGitHub({ token = "ghs_fake_token_for_tests", repo = "acme/agents", files = { "README.md": "# agents\n" }, statuses = true } = {}) {
  const blobs = new Map();
  const trees = new Map();
  const commits = new Map();
  const refs = new Map();
  const pulls = new Map();
  const comments = [];
  const issues = [];
  const statusList = [];
  const calls = [];
  let seq = 0;

  const blobSha = (b) => createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex");
  const putBlob = (b) => { const s = blobSha(b); blobs.set(s, b); return s; };
  const putTree = (m) => { const s = createHash("sha1").update(JSON.stringify([...m].sort())).digest("hex"); trees.set(s, new Map(m)); return s; };
  const putCommit = (tree, parents, message) => { const s = createHash("sha1").update(JSON.stringify({ tree, parents, message, n: ++seq })).digest("hex"); commits.set(s, { tree, parents, message }); return s; };
  const treeOf = (ish) => (commits.has(ish) ? commits.get(ish).tree : ish);
  const resolve = (ref) => (commits.has(ref) ? ref : refs.get(`heads/${ref}`));
  const ancestors = (sha) => { const out = new Set(); const todo = [sha]; while (todo.length) { const x = todo.pop(); if (!x || out.has(x)) continue; out.add(x); todo.push(...(commits.get(x)?.parents ?? [])); } return out; };

  refs.set("heads/main", putCommit(putTree(new Map(Object.entries(files).map(([p, t]) => [p, putBlob(Buffer.from(t))]))), [], "First commit"));

  const A = `/repos/${repo}`;
  const routes = [
    ["GET", new RegExp(`^${A}$`), () => [200, { full_name: repo, default_branch: "main" }]],
    ["GET", new RegExp(`^${A}/git/ref/heads/(.+)$`), (m) => (refs.has(`heads/${decodeURIComponent(m[1])}`) ? [200, { object: { sha: refs.get(`heads/${decodeURIComponent(m[1])}`) } }] : [404, { message: "Not Found" }])],
    ["GET", new RegExp(`^${A}/git/commits/([0-9a-f]{40})$`), (m) => (commits.has(m[1]) ? [200, { sha: m[1], tree: { sha: commits.get(m[1]).tree }, parents: commits.get(m[1]).parents.map((sha) => ({ sha })) }] : [404, { message: "Not Found" }])],
    ["GET", new RegExp(`^${A}/git/trees/([0-9a-f]{40})\\?recursive=1$`), (m) => {
      const t = trees.get(treeOf(m[1]));
      if (!t) return [404, { message: "Not Found" }];
      return [200, { sha: treeOf(m[1]), truncated: false, tree: [...t].sort().map(([path, sha]) => ({ path, type: "blob", mode: "100644", sha, size: blobs.get(sha).length })) }];
    }],
    ["GET", new RegExp(`^${A}/git/blobs/([0-9a-f]{40})$`), (m) => (blobs.has(m[1]) ? [200, { sha: m[1], content: blobs.get(m[1]).toString("base64"), encoding: "base64" }] : [404, { message: "Not Found" }])],
    ["POST", new RegExp(`^${A}/git/blobs$`), (m, b) => [201, { sha: putBlob(Buffer.from(b.content, b.encoding === "base64" ? "base64" : "utf8")) }]],
    ["POST", new RegExp(`^${A}/git/trees$`), (m, b) => {
      const t = new Map(b.base_tree ? trees.get(b.base_tree) : []);
      for (const e of b.tree) { if (e.sha === null) t.delete(e.path); else t.set(e.path, e.sha); }
      return [201, { sha: putTree(t) }];
    }],
    ["POST", new RegExp(`^${A}/git/commits$`), (m, b) => [201, { sha: putCommit(b.tree, b.parents, b.message) }]],
    ["POST", new RegExp(`^${A}/git/refs$`), (m, b) => {
      const k = b.ref.replace(/^refs\//, "");
      if (refs.has(k)) return [422, { message: "Reference already exists" }];
      refs.set(k, b.sha);
      return [201, { ref: b.ref, object: { sha: b.sha } }];
    }],
    ["PATCH", new RegExp(`^${A}/git/refs/heads/(.+)$`), (m, b) => {
      const k = `heads/${decodeURIComponent(m[1])}`;
      if (!refs.has(k)) return [404, { message: "Not Found" }];
      if (!b.force && !ancestors(b.sha).has(refs.get(k))) return [422, { message: "Update is not a fast forward" }];
      refs.set(k, b.sha);
      return [200, { object: { sha: b.sha } }];
    }],
    ["POST", new RegExp(`^${A}/pulls$`), (m, b) => {
      const number = pulls.size + 1;
      pulls.set(number, { number, title: b.title, body: b.body, head: b.head, base: b.base, state: "open", merged: false });
      return [201, { number, html_url: `https://github.example/${repo}/pull/${number}` }];
    }],
    ["GET", new RegExp(`^${A}/pulls/(\\d+)$`), (m) => {
      const p = pulls.get(Number(m[1]));
      if (!p) return [404, { message: "Not Found" }];
      return [200, { number: p.number, state: p.state, merged: p.merged, head: { sha: p.merged ? p.merged_head : refs.get(`heads/${p.head}`), ref: p.head }, base: { ref: p.base }, html_url: `https://github.example/${repo}/pull/${p.number}` }];
    }],
    ["PUT", new RegExp(`^${A}/pulls/(\\d+)/merge$`), (m, b) => {
      const p = pulls.get(Number(m[1]));
      const head = refs.get(`heads/${p.head}`);
      if (b.sha && b.sha !== head) return [409, { message: "Head branch was modified" }];
      const sha = putCommit(commits.get(head).tree, [refs.get(`heads/${p.base}`), head], `Merge pull request #${p.number}`);
      refs.set(`heads/${p.base}`, sha);
      Object.assign(p, { state: "closed", merged: true, merged_head: head });
      return [200, { sha, merged: true }];
    }],
    ["GET", new RegExp(`^${A}/issues\\?(.*)$`), (m) => {
      const q = new URLSearchParams(m[1]);
      const want = (q.get("labels") ?? "").split(",").filter(Boolean);
      const page = Number(q.get("page") ?? 1);
      const per = Number(q.get("per_page") ?? 30);
      const open = issues.filter((i) => i.state === (q.get("state") ?? "open") && want.every((l) => i.labels.includes(l)));
      return [200, open.slice((page - 1) * per, page * per).map((i) => ({ number: i.number, title: i.title, body: i.body, state: i.state, labels: i.labels.map((name) => ({ name })), html_url: `https://github.example/${repo}/issues/${i.number}` }))];
    }],
    ["POST", new RegExp(`^${A}/issues/(\\d+)/comments$`), (m, b) => { comments.push({ number: Number(m[1]), body: b.body }); return [201, { id: comments.length }]; }],
    ["POST", new RegExp(`^${A}/statuses/([0-9a-f]{40})$`), (m, b) => {
      if (!statuses) return [403, { message: "Resource not accessible by personal access token" }];
      statusList.push({ sha: m[1], ...b });
      return [201, { id: statusList.length }];
    }],
  ];

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    calls.push({ method: req.method, path: req.url, auth: req.headers.authorization });
    const send = (status, json) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(json)); };
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { message: "Bad credentials" });
    for (const [method, re, fn] of routes) {
      const m = method === req.method ? re.exec(req.url) : null;
      if (m) { const [status, json] = fn(m, body); return send(status, json); }
    }
    send(404, { message: `Not Found: ${req.method} ${req.url}` });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${server.address().port}`;

  return {
    url, token, repo, pulls, issues, comments, statuses: statusList, calls,
    /** An open issue, as a person files one: numbered from 101, so it never shares a number with a pull request here. */
    addIssue({ title, body = "", labels = [] }) { const number = 101 + issues.length; issues.push({ number, title, body, labels, state: "open" }); return number; },
    head: (branch) => refs.get(`heads/${branch}`),
    /** A branch made from main, as one left over from an earlier build; and a branch deleted. */
    branch: (name) => refs.set(`heads/${name}`, refs.get("heads/main")),
    dropBranch: (name) => refs.delete(`heads/${name}`),
    /** A commit on top of the branch, as a coding harness pushes one: { path: text | null }. */
    push(branch, changes, message = "A push") {
      const parent = refs.get(`heads/${branch}`);
      const t = new Map(trees.get(commits.get(parent).tree));
      for (const [path, text] of Object.entries(changes)) { if (text === null) t.delete(path); else t.set(path, putBlob(Buffer.from(text))); }
      const sha = putCommit(putTree(t), [parent], message);
      refs.set(`heads/${branch}`, sha);
      return sha;
    },
    /** A commit's parents, by sha: a merge commit has two. */
    parents: (ref) => commits.get(resolve(ref))?.parents ?? [],
    /** The commits on a branch or from a commit, newest first, following first parents: [{ sha, message }]. */
    log(ref) {
      const out = [];
      for (let sha = resolve(ref); sha; sha = commits.get(sha)?.parents?.[0]) out.push({ sha, message: commits.get(sha).message });
      return out;
    },
    filesAt(ref) {
      const t = trees.get(commits.get(resolve(ref)).tree);
      return Object.fromEntries([...t].map(([p, s]) => [p, blobs.get(s).toString("utf8")]));
    },
    close: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(() => ok()); }),
  };
}
