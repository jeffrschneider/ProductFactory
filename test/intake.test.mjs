// Builds from GitHub issues and the notices when a gate waits, against a fake
// GitHub (fixtures/fake-github.mjs) and a fake webhook receiver on 127.0.0.1.
// No test reaches the network.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { factory, tempDir } from "./helpers.mjs";
import { fakeGitHub } from "./fixtures/fake-github.mjs";
import { checkBuild } from "adlc-console/lib/contract.mjs";
import { STAGE_IDS } from "../lib/standards.mjs";
import { readConfig } from "../lib/config.mjs";

const SINK = fileURLToPath(new URL("./fixtures/bin/notice-sink.mjs", import.meta.url));
const RUNTIME = { command: ["node", fileURLToPath(new URL("../runtimes/folder.mjs", import.meta.url)), "--into", "./installed"] };
const ok = (b) => assert.deepEqual(checkBuild({ build: b }, STAGE_IDS), []);
const leftOut = { version: "0.1", organization: { used: { review: false, docs: false } } };

/** A fake webhook receiver: keeps every JSON body it is sent, and answers with status. */
async function receiver(status = 200) {
  const got = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    got.push({ method: req.method, type: req.headers["content-type"], body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    res.writeHead(status, { "content-type": "text/plain" });
    res.end(status === 200 ? "ok" : "no");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${server.address().port}/hook`, got, close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); }) };
}

/** Waits for the build to settle and for every notice it set off. */
async function settled(f, id) {
  const b = await f.settled(id);
  await f.notices.idle();
  return b;
}

async function fromIssues(t) {
  const gh = await fakeGitHub();
  const f = await factory({ doc: leftOut, runtime: RUNTIME, github: gh, intake: { github_issues: { label: "product-factory", poll_seconds: 3600 } } });
  t.after(async () => { await f.close(); await gh.close(); });
  return { gh, f };
}

test("a labelled issue starts one build that links back to it; a second poll starts none; an unlabelled issue starts nothing", async (t) => {
  const { gh, f } = await fromIssues(t);
  const n = gh.addIssue({ title: "Count the words in a passage.", body: "It should refuse to change the passage.", labels: ["product-factory", "agents"] });
  gh.addIssue({ title: "Fix the footer", body: "Not for the factory.", labels: ["bug"] });

  const started = await f.issues.pollOnce();
  assert.equal(started.length, 1);
  const id = started[0].id;
  const b = await settled(f, id);
  ok(b);
  assert.equal(b.does, "Count the words in a passage.");
  const url = `https://github.example/acme/agents/issues/${n}`;
  assert.ok(b.log.some((l) => l.said === `Started from issue #${n} on acme/agents: ${url}`), "the build's log links to its issue");
  assert.deepEqual(f.store.read(id).issue, { repo: "acme/agents", number: n, url });
  // The issue's words are the person's words in the build folder's request.md, which the builder writes the spec from.
  const asked = { said: readFileSync(join(f.store.folder(id), "build", "request.md"), "utf8") };
  assert.match(asked.said,/what it should do: Count the words in a passage\.\nmore: It should refuse to change the passage\./);

  assert.deepEqual(await f.issues.pollOnce(), [], "an issue that has a build starts no other");
  assert.equal(f.store.list().length, 1, "the unlabelled issue started nothing");
});

test("POST /intake/issues/:number starts the build for one labelled issue now, once, and refuses the rest in words", async (t) => {
  const { gh, f } = await fromIssues(t);
  const n = gh.addIssue({ title: "Count the words in a passage.", body: "It should refuse to change the passage.", labels: ["product-factory"] });
  const bug = gh.addIssue({ title: "Fix the footer", labels: ["bug"] });

  const got = await f.post(`/intake/issues/${n}`);
  assert.equal(got.status, 201, JSON.stringify(got.json));
  ok(got.json.build);
  const id = got.json.build.id;
  assert.deepEqual(f.store.read(id).issue, { repo: "acme/agents", number: n, url: `https://github.example/acme/agents/issues/${n}` });
  assert.equal(f.store.read(id).does, "Count the words in a passage.");
  await settled(f, id);

  const again = await f.post(`/intake/issues/${n}`);
  assert.equal(again.status, 409);
  assert.match(again.json.error, new RegExp(`^Issue #${n} already started build ${id} `));
  assert.equal(again.json.build.id, id);
  assert.deepEqual(await f.issues.pollOnce(), [], "the poll starts no second build for it");

  const unlabelled = await f.post(`/intake/issues/${bug}`);
  assert.equal(unlabelled.status, 404);
  assert.equal(unlabelled.json.error, `Issue #${bug} is not an open issue labelled "product-factory" on acme/agents. Only those start builds.`);
  assert.equal((await f.post("/intake/issues/twelve")).status, 400);
  assert.equal((await f.get(`/intake/issues/${n}`)).status, 405);
  assert.equal(f.store.list().length, 1);
});

test("POST /intake/issues/:number says so when intake is off", async (t) => {
  const f = await factory();
  t.after(f.close);
  const got = await f.post("/intake/issues/7");
  assert.equal(got.status, 409);
  assert.match(got.json.error, /^Builds start from issues only when intake is on/);
  assert.equal(f.store.list().length, 0);
});

test("the build comments on its issue when a gate waits on a person and when it ends", async (t) => {
  const { gh, f } = await fromIssues(t);
  const n = gh.addIssue({ title: "Count the words in a passage.", labels: ["product-factory"] });
  const [{ id }] = await f.issues.pollOnce();
  const on = () => gh.comments.filter((c) => c.number === n).map((c) => c.body);

  let b = await settled(f, id);
  assert.equal(b.summary, "Waiting on you at Requirements");
  assert.deepEqual(on(), [`Product Factory build \`${id}\` waits at **Requirements**: Approve the spec. Who may answer: anyone.`]);

  await f.post(`/builds/${id}/actions/approve`);
  b = await settled(f, id);
  assert.equal(b.summary, "Waiting on you at Architecture and Design");
  assert.ok(on()[1].startsWith(`Product Factory build \`${id}\` waits at **Architecture and Design**: `), "the build folder asks what only you can answer");

  await f.post(`/builds/${id}/actions/changes`, { changes: "egress-1: yes" });
  b = await settled(f, id);
  assert.equal(on()[2], `Product Factory build \`${id}\` waits at **Deploy**: Approve the deploy. Who may answer: anyone.`);

  await f.post(`/builds/${id}/actions/approve`);
  b = await settled(f, id);
  ok(b);
  assert.match(b.summary, /^Handed to your runtime/);
  assert.equal(on().length, 4);
  assert.match(on()[3], new RegExp(`^Product Factory build \`${id}\` ended \\(done\\): Handed to your runtime`));
});

test("the webhook and command notices are sent when a gate waits and when a build ends", async (t) => {
  const hook = await receiver();
  const out = join(await tempDir("notices"), "notices.jsonl");
  const f = await factory({ notify: [{ kind: "webhook", url_env: "PF_T_HOOK" }, { kind: "command", command: ["node", SINK, out] }], extraEnv: { PF_T_HOOK: hook.url } });
  t.after(async () => { await f.close(); await hook.close(); });

  const id = (await f.post("/builds", { does: "Count the words in a passage." })).json.build.id;
  await settled(f, id);
  assert.equal(hook.got.length, 1);
  const first = hook.got[0];
  assert.equal(first.method, "POST");
  assert.match(first.type, /application\/json/);
  assert.equal(first.body.build, id);
  assert.equal(first.body.gate, "Approve the spec");
  assert.equal(first.body.waiting_on, "anyone", "the lifecycle names no approvers");
  assert.equal(first.body.event, "waiting");
  assert.ok("link" in first.body);
  assert.equal(first.body.text, `word-counter (${id}) waits at Requirements: Approve the spec. Who may answer: anyone.`, "Slack and Teams show the text field");

  await f.post(`/builds/${id}/actions/stop`);
  await settled(f, id);
  assert.equal(hook.got.length, 2);
  assert.equal(hook.got[1].body.event, "ended");
  assert.equal(hook.got[1].body.state, "stopped");
  assert.match(hook.got[1].body.text, /ended: Stopped at Requirements\./);

  const lines = readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines, hook.got.map((g) => g.body), "the command reads the same message on stdin");
});

test("a notice that fails is said in the build's log and never stops the build", async (t) => {
  const hook = await receiver(500);
  const f = await factory({
    doc: leftOut,
    notify: [{ kind: "webhook", url_env: "PF_T_HOOK" }, { kind: "webhook", url_env: "PF_T_NOT_SET" }, { kind: "command", command: ["node", "-e", "process.exit(3)"] }],
    extraEnv: { PF_T_HOOK: hook.url },
  });
  t.after(async () => { await f.close(); await hook.close(); });

  const id = (await f.post("/builds", { does: "Count the words in a passage." })).json.build.id;
  await settled(f, id);
  const b = (await f.get(`/builds/${id}`)).json.build;
  assert.equal(hook.got.length, 1, "the webhook was tried");
  const said = b.log.map((l) => l.said);
  assert.ok(said.includes("The webhook notice was not sent: the webhook in PF_T_HOOK answered 500."));
  assert.ok(said.includes("The webhook notice was not sent: PF_T_NOT_SET is not set."));
  assert.ok(said.some((s) => /^The command notice was not sent: node exited 3/.test(s)));

  await f.post(`/builds/${id}/actions/approve`);
  const after = await settled(f, id);
  assert.equal(after.summary, "Waiting on you at Architecture and Design", "the build went on");
});

test("waiting_on names the gate's approvers, people and teams, as the lifecycle names them", async (t) => {
  const hook = await receiver();
  const people = {
    organization: "Example Org",
    people: [{ name: "Ana Lee", email: "ana@example.com", role: "approver" }, { name: "Bo Diaz", email: "bo@example.com", role: "approver" }],
    teams: [{ name: "Platform", members: ["bo@example.com"] }],
    projects: [],
  };
  const doc = { version: "0.1", organization: { approvers: { requirements: [{ person: "ana@example.com" }, { team: "Platform" }] } } };
  const f = await factory({ doc, people, notify: [{ kind: "webhook", url_env: "PF_T_HOOK" }], extraEnv: { PF_T_HOOK: hook.url } });
  t.after(async () => { await f.close(); await hook.close(); });

  const id = (await f.post("/builds", { does: "Count the words in a passage." })).json.build.id;
  await settled(f, id);
  assert.equal(hook.got.length, 1);
  assert.equal(hook.got[0].body.waiting_on, "Ana Lee (ana@example.com) or an approver in the team Platform");
  assert.ok(hook.got[0].body.text.endsWith("Who may answer: Ana Lee (ana@example.com) or an approver in the team Platform."));
});

test("each notice is sent once: a repeated save of the same wait or the same end sends nothing more", async (t) => {
  const hook = await receiver();
  const f = await factory({ notify: [{ kind: "webhook", url_env: "PF_T_HOOK" }], extraEnv: { PF_T_HOOK: hook.url } });
  t.after(async () => { await f.close(); await hook.close(); });
  const flip = async (id, to, back) => {
    await f.store.update(id, (b) => { b.status = to; });
    await f.store.update(id, (b) => { b.status = back; });
    await f.notices.idle();
  };

  const id = (await f.post("/builds", { does: "Count the words in a passage." })).json.build.id;
  await settled(f, id);
  assert.equal(hook.got.length, 1);
  await flip(id, "working", "waiting");
  await flip(id, "working", "waiting");
  assert.equal(hook.got.length, 1, "the same gate's wait at the same round is told once");
  assert.deepEqual(f.store.read(id).notices, ["wait:requirements:1.1:Approve the spec"]);

  await f.post(`/builds/${id}/actions/stop`);
  await settled(f, id);
  assert.equal(hook.got.length, 2);
  await flip(id, "working", "stopped");
  assert.equal(hook.got.length, 2, "the end is told once");
  assert.deepEqual(f.store.read(id).notices, ["wait:requirements:1.1:Approve the spec", "end:stopped"]);
});

test("intake and notify are checked when the settings are read", () => {
  const repository = { host: "github", repo: "acme/agents", token: "GITHUB_TOKEN" };
  assert.deepEqual(readConfig({ repository, intake: { github_issues: {} } }, ".").intake, { github_issues: { label: "product-factory", poll_seconds: 60 } });
  assert.throws(() => readConfig({ intake: { github_issues: {} } }, "."), /reads issues from "repository"/);
  assert.throws(() => readConfig({ notify: [{ kind: "webhook", url_env: "https://hooks.slack.com/services/x" }] }, "."), /never the address/);
  assert.throws(() => readConfig({ notify: [{ kind: "email" }] }, "."), /"webhook" or "command"/);
  assert.deepEqual(readConfig({}, ".").notify, []);
});
