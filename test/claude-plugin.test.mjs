// The Claude Code plugin's MCP server (claude-plugin/mcp), over stdio, against
// a whole Product Factory started in this process with stand-in holders
// (helpers.mjs) and the stand-in model caller, which proposes a change when
// the person's words say "change", a feature for "feature: <name> - <does>",
// and the next version when the boss is told "also". No test reaches a model
// or the network.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { factory, tempDir } from "./helpers.mjs";
import { fakeGitHub } from "./fixtures/fake-github.mjs";
import { locate, TOOLS } from "../claude-plugin/mcp/tools.mjs";

const SERVER = fileURLToPath(new URL("../claude-plugin/mcp/server.mjs", import.meta.url));

/** The plugin's MCP server over stdio, pointed at f by its address and key file. */
function mcp(t, f, env = {}) {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, PRODUCT_FACTORY_URL: f.base, PRODUCT_FACTORY_KEY_FILE: f.key.file, PRODUCT_FACTORY_CONFIG: "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map();
  const seen = [];
  let next = 1;
  createInterface({ input: child.stdout }).on("line", (line) => {
    seen.push(line);
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  });
  child.stderr.resume();
  t.after(() => child.kill());
  const rpc = (method, params) => new Promise((ok) => { const id = next++; waiting.set(id, ok); child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); });
  const call = async (name, args = {}) => {
    const got = await rpc("tools/call", { name, arguments: args });
    assert.equal(got.error, undefined, JSON.stringify(got.error));
    const [words, json] = got.result.content.map((c) => c.text);
    return { words, json: JSON.parse(json), error: Boolean(got.result.isError) };
  };
  return { rpc, call, seen };
}

/** A Product Factory and the plugin's server on it. */
async function setUp(t, opts = {}) {
  const f = await factory({ rounds: 1, ...opts });
  t.after(f.close);
  const m = mcp(t, f);
  const init = await m.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  assert.equal(init.result.serverInfo.name, "product-factory");
  return { f, m };
}

const said = "the engineer said so in the test";

test("the server lists its six tools, each with a schema", async (t) => {
  const { m } = await setUp(t);
  const got = await m.rpc("tools/list", {});
  assert.deepEqual(got.result.tools.map((x) => x.name), ["start_build", "waiting_on_me", "build_status", "stage", "ask", "act"]);
  for (const tool of got.result.tools) assert.equal(tool.inputSchema.type, "object", tool.name);
  assert.deepEqual(TOOLS.find((x) => x.name === "act").inputSchema.required, ["id", "engineer_said"]);
  assert.equal((await m.rpc("tools/call", { name: "nope", arguments: {} })).error.code, -32602);
});

test("start_build starts a build from words, and waiting_on_me shows its gate with the gate's words and action ids", async (t) => {
  const { f, m } = await setUp(t);
  const started = await m.call("start_build", { does: "Count the words in a passage.", name: "counter", wait_seconds: 30 });
  assert.equal(started.error, false, started.words);
  const id = started.json.build;
  assert.match(id, /^b_[a-z0-9]{12}$/);
  assert.match(started.words, new RegExp(`^Started counter 0\\.1\\.0 as build ${id}\\.`));
  assert.equal(started.json.summary, "Waiting on you at Requirements");
  assert.deepEqual(started.json.actions.map((a) => a.id), [`${id}/approve`, `${id}/changes`, `${id}/stop`]);

  const w = await m.call("waiting_on_me");
  assert.match(w.words, /^1 thing waits on you \(Test Person\)\./);
  assert.match(w.words, /counter 0\.1\.0 \(b_[a-z0-9]{12}\) at Requirements: Waiting on you at Requirements\./);
  assert.match(w.words, /It says: Drafted the spec for counter\./);
  assert.match(w.words, /Who may answer: Anyone may answer this gate/);
  assert.match(w.words, new RegExp(`Approve the spec \\[${id}/approve\\]; Ask for changes \\[${id}/changes\\]; Stop \\[${id}/stop\\]`));
  assert.equal(w.json.gates.length, 1);
  assert.deepEqual({ build: w.json.gates[0].build, stage: w.json.gates[0].stage }, { build: id, stage: "requirements" });
  assert.deepEqual(w.json.gates[0].gate.said, ["Drafted the spec for counter."]);
  assert.deepEqual(w.json.features, []);

  // build_status and stage read the same build, and change nothing.
  const s = await m.call("build_status", { product: "counter" });
  assert.equal(s.json.build, id);
  assert.match(s.words, /Current stage: Requirements, waiting_on_you\./);
  const ws = await m.call("stage", { build: id });
  assert.equal(ws.json.stage, "requirements");
  assert.deepEqual(ws.json.outputs.map((a) => [a.id, a.version]), [["spec", "v1"]]);
  assert.match(ws.words, /Spec v1, made: product: counter 0\.1\.0; purpose: Counts the words in a passage, for anyone who sends one\./);
  assert.match(ws.words, /Done when: every feature has requirements and at least one acceptance scenario a test can check/);
  assert.equal(f.store.read(id).status, "waiting");

  // The key is never in an answer.
  assert.ok(!m.seen.some((line) => line.includes(f.key.value)), "the key never leaves the server");
});

test("ask returns a stage agent's reply with the action it proposes, and a feature with its id; act approves the feature", async (t) => {
  const { f, m } = await setUp(t);
  const id = (await m.call("start_build", { does: "Count the words in a passage.", name: "counter", wait_seconds: 30 })).json.build;

  const change = await m.call("ask", { product: "counter", stage: "requirements", text: "Please change the name to tally." });
  assert.equal(change.error, false, change.words);
  assert.match(change.words, /^Spec writer: I would make this change: Please change the name to tally\./);
  assert.deepEqual(change.json.proposes, { id: `${id}/changes`, action: "changes", needs: { changes: "change the name to tally." } });
  assert.match(change.words, new RegExp(`It proposes the build's action changes \\[${id}/changes\\]`));
  assert.equal(f.store.read(id).status, "waiting", "asking takes nothing");

  const feat = await m.call("ask", { product: "counter", stage: "requirements", text: "Add a feature: Count lines - Says how many lines the passage has." });
  const p = feat.json.features[0];
  assert.match(p.id, /^fp_/);
  assert.deepEqual({ feature: p.feature, name: p.name, change: p.change, may: p.you_may_approve }, { feature: "F1", name: "Count lines", change: "new", may: true });
  assert.match(feat.words, new RegExp(`Feature proposed: counter F1 "Count lines": Says how many lines the passage has\\. \\(new\\) \\[${p.id}\\]`));

  const w = await m.call("waiting_on_me");
  assert.deepEqual(w.json.features.map((x) => x.id), [p.id]);
  assert.match(w.words, /Approving starts building with these features too: F1 Count lines/);

  const no = await m.call("act", { id: p.id, engineer_said: said });
  assert.equal(no.error, true);
  assert.match(no.words, /decision approve or not_now/);
  const yes = await m.call("act", { id: p.id, decision: "approve", engineer_said: said });
  assert.equal(yes.error, false, yes.words);
  assert.equal(yes.words, `Approved feature F1 "Count lines" of counter. The spec is now v2.`);
  assert.equal((await m.call("waiting_on_me")).json.features.length, 0);
  const twice = await m.call("act", { id: p.id, decision: "approve", engineer_said: said });
  assert.equal(twice.error, true);
  assert.match(twice.words, /No feature proposal fp_\w+ waits for an answer/);
});

test("act refuses an action the build does not offer now, says what it offers, and takes nothing", async (t) => {
  const { f, m } = await setUp(t);
  const id = (await m.call("start_build", { does: "Count the words in a passage.", name: "counter", wait_seconds: 30 })).json.build;
  const before = JSON.stringify(f.store.read(id).run.events);

  const got = await m.call("act", { id: `${id}/accept`, engineer_said: said });
  assert.equal(got.error, true);
  assert.equal(got.words, `counter 0.1.0 (${id}) does not offer accept to you now, so nothing was taken. It offers: Approve the spec [${id}/approve]; Ask for changes [${id}/changes] (needs changes); Stop [${id}/stop].`);
  assert.equal(got.json.taken, false);
  assert.deepEqual(got.json.offered.map((a) => a.id), [`${id}/approve`, `${id}/changes`, `${id}/stop`]);

  const needs = await m.call("act", { id: `${id}/changes`, engineer_said: said });
  assert.equal(needs.error, true);
  assert.match(needs.words, /^Ask for changes needs changes \(What should change, or your answers to the open questions\)\. Ask the engineer for it/);

  const unsaid = await m.call("act", { id: `${id}/approve`, engineer_said: " " });
  assert.equal(unsaid.error, true);
  assert.match(unsaid.words, /only when the engineer asked for it/);

  assert.equal((await m.call("act", { id: "approve the spec", engineer_said: said })).error, true);
  assert.equal((await m.call("act", { id: "b_000000000000/approve", engineer_said: said })).words, "There is no build b_000000000000.");
  assert.equal(JSON.stringify(f.store.read(id).run.events), before, "nothing was taken");
});

test("act takes an offered gate action, says what it did, and the build moves on", async (t) => {
  const { f, m } = await setUp(t);
  const id = (await m.call("start_build", { does: "Count the words in a passage.", name: "counter", wait_seconds: 30 })).json.build;

  const got = await m.call("act", { id: `${id}/approve`, engineer_said: "Approve the spec." });
  assert.equal(got.error, false, got.words);
  assert.match(got.words, new RegExp(`^Took Approve the spec on counter 0\\.1\\.0 \\(${id}\\)\\. Now: `));
  assert.deepEqual({ taken: got.json.taken, action: got.json.action, build: got.json.build }, { taken: true, action: "approve", build: id });

  const b = await f.settled(id);
  assert.equal(b.summary, "Waiting on you at Code");
  const s = await m.call("build_status", { build: id });
  assert.deepEqual(s.json.actions.map((a) => a.id), [`${id}/accept`, `${id}/stop`]);
  const w = await m.call("waiting_on_me");
  assert.equal(w.json.gates[0].stage, "code");

  // A proposed change goes back through its gate: Ask for changes, with the agent's words, from a fresh build.
  const id2 = (await m.call("start_build", { does: "Say hello.", name: "greeter", wait_seconds: 30 })).json.build;
  const asked = await m.call("ask", { product: "greeter", stage: "requirements", text: "Please change the greeting to a wave." });
  const changed = await m.call("act", { id: asked.json.proposes.id, needs: asked.json.proposes.needs, engineer_said: "Yes, ask for that change." });
  assert.equal(changed.error, false, changed.words);
  assert.match(changed.words, new RegExp(`^Took Ask for changes on greeter 0\\.1\\.0 \\(${id2}\\)`));
  assert.deepEqual(changed.json.needs, { changes: "change the greeting to a wave." });
});

test("the boss's start_version proposal is confirmed through act, which starts the next version", async (t) => {
  const { f, m } = await setUp(t);
  const id = (await m.call("start_build", { does: "Count the words in a passage.", name: "counter", wait_seconds: 30 })).json.build;
  const got = await m.call("ask", { product: "counter", stage: "boss", text: "It should also count the lines." });
  assert.equal(got.error, false, got.words);
  assert.match(got.json.proposes.id, /^bp_/);
  assert.equal(got.json.proposes.action, "start_version");
  assert.match((await m.call("waiting_on_me")).words, new RegExp(`The boss of counter proposes: Start version 0\\.2\\.0 of counter, with 0\\.1\\.0 as its prototype\\? \\[${got.json.proposes.id}\\]`));

  const yes = await m.call("act", { id: got.json.proposes.id, engineer_said: "Yes, start 0.2.0." });
  assert.equal(yes.error, false, yes.words);
  assert.equal(yes.json.started.version, "0.2.0");
  assert.notEqual(yes.json.started.build, id);
  await f.settled(yes.json.started.build);
  assert.equal((await m.call("act", { id: got.json.proposes.id, engineer_said: said })).error, true, "a proposal is taken once");
});

test("start_build from an issue number when intake is on, and says so when it is off", async (t) => {
  const gh = await fakeGitHub();
  const f = await factory({ github: gh, intake: { github_issues: { label: "product-factory", poll_seconds: 3600 } } });
  t.after(async () => { await f.close(); await gh.close(); });
  const m = mcp(t, f);
  const n = gh.addIssue({ title: "Count the words in a passage.", labels: ["product-factory"] });
  const got = await m.call("start_build", { issue: n });
  assert.equal(got.error, false, got.words);
  assert.match(got.words, new RegExp(`^Started A new agent 0\\.1\\.0 as build b_[a-z0-9]{12}, from issue #${n}\\.`));
  assert.equal(f.store.read(got.json.build).issue.number, n);
  await f.settled(got.json.build);
  const again = await m.call("start_build", { issue: n });
  assert.equal(again.error, true);
  assert.match(again.words, new RegExp(`^Issue #${n} already started build ${got.json.build}`));

  const off = await setUp(t);
  const no = await off.m.call("start_build", { issue: 3 });
  assert.equal(no.error, true);
  assert.match(no.words, /^Builds start from issues only when intake is on/);
});

test("the service and key are found from product-factory.json, and a missing service is said in words", async (t) => {
  const dir = await tempDir("plugin-locate");
  const deep = join(dir, "agents", "counter");
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(dir, "product-factory.json"), JSON.stringify({ port: 45999, data: "./pf-data" }));
  const w = locate({}, deep);
  assert.deepEqual({ url: w.url, keyFile: w.keyFile }, { url: "http://127.0.0.1:45999", keyFile: join(dir, "pf-data", "service-key") });
  assert.equal(locate({ PRODUCT_FACTORY_KEY_FILE: join(dir, "mine.key") }, deep).keyFile, join(dir, "mine.key"), "a person's own key file wins");
  assert.equal(locate({ PRODUCT_FACTORY_URL: "http://127.0.0.1:1234/v1/lifecycle", PRODUCT_FACTORY_KEY_FILE: "k" }, deep).url, "http://127.0.0.1:1234");
  assert.match(locate({ PRODUCT_FACTORY_URL: "http://127.0.0.1:1234" }, dir.slice(0, 3)).problem, /no key is/);

  // A service that is not running, with a key file that is there.
  writeFileSync(join(dir, "k"), "not-a-real-key\n");
  const f = { base: "http://127.0.0.1:9", key: { file: join(dir, "k"), value: "not-a-real-key" } };
  const m = mcp(t, f);
  const got = await m.call("waiting_on_me");
  assert.equal(got.error, true);
  assert.equal(got.words, "Product Factory is not answering at http://127.0.0.1:9. Start it (npx product-factory) in its folder, or set PRODUCT_FACTORY_URL to where it runs.");
  assert.ok(!m.seen.some((line) => line.includes("not-a-real-key")));
});
