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
  const f = await factory({ doc: leftOut, github: gh, intake: { github_issues: { label: "product-factory", poll_seconds: 3600 } } });
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
  const asked = JSON.parse(readFileSync(join(f.store.folder(id), "stages", "requirements", "records", "r1", "asked.json"), "utf8"));
  assert.match(asked.said, /what it should do: Count the words in a passage\.\nmore: It should refuse to change the passage\./);

  assert.deepEqual(await f.issues.pollOnce(), [], "an issue that has a build starts no other");
  assert.equal(f.store.list().length, 1, "the unlabelled issue started nothing");
});

test("the build comments on its issue when a gate waits on a person and when it ends", async (t) => {
  const { gh, f } = await fromIssues(t);
  const n = gh.addIssue({ title: "Count the words in a passage.", labels: ["product-factory"] });
  const [{ id }] = await f.issues.pollOnce();
  const on = () => gh.comments.filter((c) => c.number === n).map((c) => c.body);

  let b = await settled(f, id);
  assert.equal(b.summary, "Waiting on you at Requirements");
  assert.deepEqual(on(), [`Product Factory build \`${id}\` waits on Test Person at **Requirements**: Approve the spec.`]);

  await f.post(`/builds/${id}/actions/approve`);
  b = await settled(f, id);
  assert.equal(b.summary, "Waiting on you at Code");
  assert.equal(on()[1], `Product Factory build \`${id}\` waits on Test Person at **Code**: OK the code.`);

  await f.post(`/builds/${id}/actions/accept`);
  b = await settled(f, id);
  ok(b);
  assert.match(b.summary, /^Packed and validated/);
  assert.equal(on().length, 3);
  assert.match(on()[2], new RegExp(`^Product Factory build \`${id}\` ended \\(done\\): Packed and validated`));
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
  assert.equal(first.body.waiting_on, "Test Person");
  assert.equal(first.body.event, "waiting");
  assert.ok("link" in first.body);
  assert.equal(first.body.text, `word-counter (${id}) waits on Test Person at Requirements: Approve the spec.`, "Slack and Teams show the text field");

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
  assert.equal(after.summary, "Waiting on you at Code", "the build went on");
});

test("intake and notify are checked when the settings are read", () => {
  const repository = { host: "github", repo: "acme/agents", token: "GITHUB_TOKEN" };
  assert.deepEqual(readConfig({ repository, intake: { github_issues: {} } }, ".").intake, { github_issues: { label: "product-factory", poll_seconds: 60 } });
  assert.throws(() => readConfig({ intake: { github_issues: {} } }, "."), /reads issues from "repository"/);
  assert.throws(() => readConfig({ notify: [{ kind: "webhook", url_env: "https://hooks.slack.com/services/x" }] }, "."), /never the address/);
  assert.throws(() => readConfig({ notify: [{ kind: "email" }] }, "."), /"webhook" or "command"/);
  assert.deepEqual(readConfig({}, ".").notify, []);
});
