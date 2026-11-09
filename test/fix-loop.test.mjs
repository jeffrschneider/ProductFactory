// The fix loop: Code on a pull request with code.harness set, against a fake
// GitHub (fixtures/fake-github.mjs) and a stand-in harness
// (fixtures/bin/fix-harness.mjs) that writes the wrong script until the
// prompt carries the gate's findings. Product Factory runs the harness round
// by round, commits what it wrote under scripts/ to the branch itself, and
// gates each commit. No test reaches the network or a model.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { factory, stageOf, actionNames, tempDir, FIX_HARNESS } from "./helpers.mjs";
import { fakeGitHub } from "./fixtures/fake-github.mjs";
import { checkBuild } from "adlc-console/lib/contract.mjs";
import { validate } from "../standards/lifecycle-api-check.mjs";
import { STAGE_IDS } from "../lib/standards.mjs";
import { readConfig, credentialNames } from "../lib/config.mjs";
import { FIX_FIRST, fixPrompt } from "../lib/fix-loop.mjs";
import { resolveCommand } from "../lib/exec.mjs";

const BRANCH = "adlc/counter-0.1.0";
const SCRIPT = "agents/counter/scripts/count.mjs";
const RIGHT = "export function count(text) { return String(text).split(/\\s+/).filter(Boolean).length; }\n";
const ok = (b) => {
  assert.deepEqual(checkBuild({ build: b }, STAGE_IDS), []);
  assert.deepEqual(validate("BuildAnswer", { build: b }), []);
};
const calls = (f) => (existsSync(f.stubLog) ? readFileSync(f.stubLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const filesIn = (dir, at = "") => readdirSync(join(dir, at), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesIn(dir, `${at}${e.name}/`) : [`${at}${e.name}`])).sort();
const fixRounds = (b) => [...stageOf(b, "code").rounds].reverse().filter((x) => /^Fix round /.test(x.label));

/** A build started with the fix loop on, its spec approved; resolves once the loop has nothing running. mode: the stand-in harness's first mode. */
async function looped(t, { mode = "fix", rounds, doc, wait = true } = {}) {
  const gh = await fakeGitHub();
  const modeDir = await tempDir("fixmode");
  const modeFile = join(modeDir, "mode.txt");
  writeFileSync(modeFile, mode);
  const f = await factory({ holder: "pull-request", github: gh, harness: ["node", FIX_HARNESS, "{prompt}"], fixRounds: rounds, doc, extraEnv: { PF_FIX_MODE_FILE: modeFile, ANTHROPIC_API_KEY: "sk-ant-not-for-the-harness" } });
  t.after(async () => { await f.close(); await gh.close(); });
  const id = (await f.post("/builds", { does: "Count the words in a passage.", name: "counter" })).json.build.id;
  await f.settled(id);
  await f.post(`/builds/${id}/actions/approve`);
  const b = wait ? await f.settled(id) : null;
  return { gh, f, id, b, setMode: (m) => writeFileSync(modeFile, m) };
}

/** Waits until the stand-in harness has been called n times. */
async function harnessCalled(f, n) {
  for (let i = 0; i < 600 && calls(f).length < n; i++) await new Promise((ok) => setTimeout(ok, 50));
  assert.ok(calls(f).length >= n, `the harness was called ${n} times`);
}

test("the fix loop: the harness writes the wrong script, the gate's findings go back to it, round 2 passes and waits for your OK", async (t) => {
  const { gh, f, id, b } = await looped(t);
  ok(b);
  const code = stageOf(b, "code");
  assert.equal(f.store.read(id).status, "waiting");
  assert.equal(code.state, "waiting_on_you");
  assert.deepEqual(actionNames(b), ["accept", "back_to_test", "back_to_requirements", "stop"]);
  assert.equal(code.holder.name, "your coding harness (node), run by Product Factory on a pull request (acme/agents)");
  assert.match(code.given, /Product Factory runs your coding harness on it in the fix loop/);

  // Two rounds, each one round of Code: what was sent, how long it took, what the harness said, the commit, the gate's verdict.
  const rounds = fixRounds(b);
  assert.deepEqual(rounds.map((x) => [x.label, x.verdict, x.back]), [["Fix round 1", "The tests did not pass", true], ["Fix round 2", "Ready for your OK", false]]);
  const kept = f.store.read(id).stages.code.rounds.filter((x) => x.fix);
  assert.deepEqual(kept.map((x) => x.fix.round), [1, 2]);
  assert.equal(kept[0].fix.sent, FIX_FIRST);
  assert.match(kept[1].fix.sent, /This is fix round 2/);
  assert.deepEqual(kept.map((x) => x.fix.files), [["scripts/count.mjs"], ["scripts/count.mjs"]]);
  assert.deepEqual(kept.map((x) => x.fix.left_out), [[], []]);
  assert.ok(kept.every((x) => Number.isInteger(x.fix.took_ms) && x.fix.took_ms >= 0));
  assert.equal(kept[1].fix.harness, "Fixed scripts/count.mjs from the gate's findings.");
  assert.deepEqual(kept.map((x) => x.fix.gate), ["The tests did not pass", "Ready for your OK"]);
  assert.match(rounds[1].words, /Sent your coding harness the round's prompt, with the gate's findings on [0-9a-f]{7}\. It took \d+ s, and said: Fixed scripts\/count\.mjs from the gate's findings\. Committed [0-9a-f]{7} to pull request #1: scripts\/count\.mjs\. The gate on [0-9a-f]{7}: Ready for your OK\./);

  // Product Factory made each round's commit itself, on the branch, on top of the one before.
  const log = gh.log(BRANCH);
  assert.deepEqual(log.slice(0, 2).map((x) => x.message).reverse(), ["Fix round 1: Write the scripts", "Fix round 2: The tests did not pass"]);
  assert.deepEqual(kept.map((x) => x.fix.commit), [log[1].sha, log[0].sha]);
  assert.equal(gh.filesAt(BRANCH)[SCRIPT], RIGHT);
  assert.equal(stageOf(b, "code").where.check.title, "Ready for your OK");
  // The gate said its word on each commit, on the pull request.
  assert.deepEqual(gh.comments.map((x) => x.body.split("\n")[0].replace(/ \([0-9a-f]{7}\)$/, "")), ["**Product Factory gate: The tests did not pass**", "**Product Factory gate: Ready for your OK**"]);

  // What the harness was given: round 1 the instruction alone, round 2 with the gate's findings word for word; never the repository token.
  const c = calls(f);
  assert.equal(c.length, 2);
  assert.equal(c[0].prompt, FIX_FIRST);
  assert.match(c[0].prompt, /AGENTS\.md/);
  assert.match(c[0].prompt, /`node \.adlc\/check\.mjs` exits 0/);
  assert.match(c[0].prompt, /records\/conflict\.md/);
  const run1 = f.store.read(id).work.pr.runs[0];
  assert.equal(c[1].prompt, fixPrompt({ round: 2, last: run1 }));
  assert.ok(c[1].prompt.includes(`The tests did not pass\n\n${run1.summary}\n\nItems:\n- counts the words in a passage`));
  assert.deepEqual(c.map((x) => x.round), ["1", "2"]);
  assert.equal(c[0].feedback, "");
  assert.match(readFileSync(c[1].feedback, "utf8"), /^The tests did not pass\n/);
  assert.ok(c.every((x) => x.agents_md && x.same_prompt));
  assert.ok(c.every((x) => !x.token), "the harness never holds the repository token");
  assert.ok(c.every((x) => !x.anthropic_key), "code.env_remove goes for the fix loop too");
  assert.ok(c.every((x) => !x.model_key), "nor the model key");
  // The round's folder is the branch's build folder whole (the suite with any test/support/ files beside it), before the harness runs.
  const atIssue = Object.keys(gh.filesAt(f.store.read(id).work.pr.issued_sha)).filter((p) => p.startsWith("agents/counter/")).map((p) => p.slice("agents/counter/".length)).sort();
  assert.deepEqual(filesIn(join(f.store.folder(id), "stages", "code", "fix", "1", "build")), atIssue);
  // The log and the activity feed say each round.
  assert.ok(code.log.some((e) => /^Fix round 2: your coding harness works on [0-9a-f]{7}, with the gate's findings on [0-9a-f]{7}\.$/.test(e.said)));

  // Your OK takes the scripts from the commit the gate passed, as it does for any push.
  assert.equal((await f.post(`/builds/${id}/actions/accept`)).status, 200);
  const done = await f.settled(id);
  assert.equal(stageOf(done, "package").state, "done");
  assert.equal(gh.filesAt("main")[SCRIPT], RIGHT);
  assert.ok(!readFileSync(join(f.store.folder(id), "build.json"), "utf8").includes(gh.token));
});

test("the fix loop stops on a conflict and waits on you, offering Send back to Test and Send back to Requirements; after the revision it starts again from round 1", async (t) => {
  const { gh, f, id, b, setMode } = await looped(t, { mode: "conflict", doc: { version: "0.1", organization: { used: { review: false, security: false } } } });
  ok(b);
  assert.equal(f.store.read(id).status, "refused");
  assert.deepEqual(actionNames(b), ["back_to_test", "back_to_requirements", "stop"]);
  const code = stageOf(b, "code");
  assert.equal(code.state, "refused");
  assert.match(code.handed_back.words[0], /^Fix round 1: your coding harness stopped on a conflict, so the fix loop stopped\./);
  assert.match(code.handed_back.words[0], /The suite never says what an empty passage counts as\./);
  assert.match(code.handed_back.words[0], /Send back to Test if the test is wrong, or Send back to Requirements if the spec is\.$/);
  assert.equal(calls(f).length, 1, "a conflict starts no next round");
  assert.equal(gh.filesAt(BRANCH)["agents/counter/records/conflict.md"], "The suite never says what an empty passage counts as.\n");
  assert.equal(gh.log(BRANCH)[0].message, "Fix round 1: Write the scripts");

  // Send back to Test: the revised tests go to the branch as Product Factory's own commit, and the loop starts again from round 1.
  setMode("fix");
  assert.equal((await f.post(`/builds/${id}/actions/back_to_test`, { changes: "Say that an empty passage has no words." })).status, 200);
  const after = await f.settled(id);
  ok(after);
  assert.equal(stageOf(after, "code").state, "waiting_on_you");
  const log = gh.log(BRANCH).map((x) => x.message);
  assert.match(log[2], /^Revised tests for counter 0\.1\.0/);
  assert.deepEqual(log.slice(0, 2).reverse(), ["Fix round 1: Write the scripts", "Fix round 2: The tests did not pass"]);
  assert.deepEqual(fixRounds(after).map((x) => x.label), ["Fix round 1", "Fix round 1", "Fix round 2"]);
  const c = calls(f);
  assert.equal(c.length, 3);
  assert.equal(c[1].prompt, FIX_FIRST, "round 1 after the revision carries no findings");
  assert.match(stageOf(after, "code").where.check.words, /All 3 tests passed/);
  assert.ok(!("agents/counter/records/conflict.md" in gh.filesAt(BRANCH)));
});

test("a security refusal stops the fix loop and waits on you, saying the spec may need to change", async (t) => {
  const { f, id, b } = await looped(t, { mode: "security" });
  ok(b);
  assert.equal(f.store.read(id).status, "refused");
  assert.deepEqual(actionNames(b), ["back_to_requirements", "resume", "stop"]);
  const code = stageOf(b, "code");
  assert.equal(fixRounds(b).at(-1).verdict, "The security reviewer refused");
  const said = code.handed_back.words[0];
  assert.match(said, /^Fix round 1: the security reviewer refused the scripts at [0-9a-f]{7}, so the fix loop stopped\./);
  assert.match(said, /only the spec can settle/);
  assert.match(said, /Send back to Requirements with what should change in the spec/);
  assert.match(said, /scripts\/count\.mjs sends the passage to a system the spec does not declare/);
  assert.equal(calls(f).length, 1, "a security refusal starts no next round");
  assert.equal(stageOf(b, "security").state, "refused");
});

test("with the rounds used up, Code is refused with the last gate run's words, offering more rounds, Send back to Test, Send back to Requirements and Stop", async (t) => {
  const { gh, f, id, b, setMode } = await looped(t, { mode: "never", rounds: 2 });
  ok(b);
  assert.equal(f.store.read(id).status, "refused");
  assert.deepEqual(actionNames(b), ["resume", "back_to_test", "back_to_requirements", "stop"]);
  assert.equal(b.actions[0].label, "Give it more rounds");
  assert.deepEqual(fixRounds(b).map((x) => x.verdict), ["The tests did not pass", "The tests did not pass"]);
  const said = stageOf(b, "code").handed_back.words[0];
  const last = f.store.read(id).work.pr.runs.at(-1);
  assert.ok(said.startsWith(`The gate still does not pass after 2 fix rounds. What the last gate run on ${last.sha.slice(0, 7)} said:\n\nThe tests did not pass\n\n${last.summary}\n\nItems:\n- counts the words in a passage`));
  assert.equal(calls(f).length, 2);
  assert.equal(b.summary, "Refused at Code: waiting on you");

  // More rounds: the next round goes on from round 3, with the last gate run's findings, and passes.
  setMode("fix");
  await f.post(`/builds/${id}/actions/resume`);
  const after = await f.settled(id);
  ok(after);
  assert.equal(stageOf(after, "code").state, "waiting_on_you");
  assert.deepEqual(fixRounds(after).map((x) => x.label), ["Fix round 1", "Fix round 2", "Fix round 3"]);
  assert.match(calls(f)[2].prompt, /This is fix round 3/);
  assert.equal(gh.log(BRANCH)[0].message, "Fix round 3: The tests did not pass");
});

test("a round whose harness changes nothing commits nothing: the gate judges the branch's newest commit once, and then its word stands", async (t) => {
  const { gh, f, id, b } = await looped(t, { mode: "idle", rounds: 2 });
  ok(b);
  const issued = f.store.read(id).work.pr.issued_sha;
  assert.equal(gh.head(BRANCH), issued, "nothing was committed");
  const rounds = fixRounds(b);
  assert.deepEqual(rounds.map((x) => x.verdict), ["The tests did not pass", "Nothing changed"]);
  assert.match(rounds[0].words, new RegExp(`It changed nothing under scripts/, so nothing was committed; the gate runs on ${issued.slice(0, 7)}, which it had not judged\\.`));
  assert.match(rounds[1].words, new RegExp(`It changed nothing under scripts/, so nothing was committed, and the gate's word on ${issued.slice(0, 7)} stands\\.`));
  assert.equal(f.store.read(id).work.pr.runs.length, 1);
  assert.deepEqual(actionNames(b), ["resume", "back_to_test", "back_to_requirements", "stop"]);
});

test("what the harness changes outside scripts/ is not committed, and the round's record says so", async (t) => {
  const { gh, f, id, b } = await looped(t, { mode: "outside" });
  ok(b);
  assert.equal(stageOf(b, "code").state, "waiting_on_you");
  const files = gh.filesAt(BRANCH);
  assert.ok(!("agents/counter/notes.txt" in files));
  assert.ok(!("agents/counter/records/account.md" in files));
  assert.doesNotMatch(files["agents/counter/test/count.test.mjs"], /emptied/);
  assert.equal(files[SCRIPT], RIGHT);
  const rounds = fixRounds(b);
  assert.equal(rounds[0].verdict, "The tests did not pass", "the fence had nothing to refuse");
  assert.match(rounds[0].words, /Not committed, as a fix round commits only scripts\/ and records\/conflict\.md: notes\.txt, records\/account\.md, test\/count\.test\.mjs\./);
  assert.deepEqual(f.store.read(id).stages.code.rounds.find((x) => x.fix).fix.left_out, ["notes.txt", "records/account.md", "test/count.test.mjs"]);
});

test("with no code.harness on a pull request nothing changes: no harness runs, and the build waits for your harness's push", async (t) => {
  const gh = await fakeGitHub();
  const f = await factory({ holder: "pull-request", github: gh });
  t.after(async () => { await f.close(); await gh.close(); });
  assert.equal(f.config.code.harness, null);
  const id = (await f.post("/builds", { does: "Count the words in a passage.", name: "counter" })).json.build.id;
  await f.settled(id);
  await f.post(`/builds/${id}/actions/approve`);
  const b = await f.settled(id);
  ok(b);
  assert.equal(stageOf(b, "code").state, "working");
  assert.equal(b.summary, "Working at Code: waiting for a push to pull request #1");
  assert.ok(stageOf(b, "code").log.some((e) => e.said === "Point your coding harness at the pull request. Every push it makes runs the gate."));
  assert.equal(stageOf(b, "code").rounds.length, 0);
  assert.equal(calls(f).length, 0);
  assert.equal(gh.log(BRANCH).length, 2, "the hand-off's commit on main's, and nothing more");
  assert.equal(f.store.read(id).work.pr.fix, undefined);
  gh.push(BRANCH, { [SCRIPT]: RIGHT });
  await f.runner.poll(id);
  assert.equal(stageOf(await f.settled(id), "code").state, "waiting_on_you");
});

test("Stop works mid-round: the harness is stopped, nothing is committed, and the round says so", async (t) => {
  const { gh, f, id } = await looped(t, { mode: "sleep", wait: false });
  await harnessCalled(f, 1);
  const issued = f.store.read(id).work.pr.issued_sha;
  const started = Date.now();
  assert.equal((await f.post(`/builds/${id}/actions/stop`)).status, 200);
  const b = await f.settled(id);
  ok(b);
  assert.ok(Date.now() - started < 60_000, "the harness did not run on");
  assert.equal(f.store.read(id).status, "stopped");
  assert.equal(b.summary, "Stopped at Code");
  assert.equal(gh.head(BRANCH), issued, "nothing was committed");
  const last = fixRounds(b).at(-1);
  assert.equal(last.verdict, "Stopped");
  assert.equal(last.words, "You stopped the build while fix round 1 was running, so nothing of it was committed.");
  assert.equal(gh.comments.length, 0, "no gate ran");
});

test("Send back to Test mid-round ends the round in hand, and the loop starts again from round 1 on the revised suite", async (t) => {
  const { gh, f, id, setMode } = await looped(t, { mode: "sleep", wait: false, doc: { version: "0.1", organization: { used: { review: false, security: false } } } });
  await harnessCalled(f, 1);
  setMode("fix");
  assert.equal((await f.post(`/builds/${id}/actions/back_to_test`, { changes: "Say that an empty passage has no words." })).status, 200);
  const b = await f.settled(id);
  ok(b);
  assert.equal(stageOf(b, "code").state, "waiting_on_you");
  const rounds = fixRounds(b);
  assert.deepEqual(rounds.map((x) => [x.label, x.verdict]), [["Fix round 1", "Ended"], ["Fix round 1", "The tests did not pass"], ["Fix round 2", "Ready for your OK"]]);
  assert.equal(rounds[0].words, "You sent the build back to Test while fix round 1 was running, so nothing of it was committed.");
  assert.match(gh.log(BRANCH)[2].message, /^Revised tests for counter 0\.1\.0/);
});

test("the gate runs a pushed script without a credential: the token, the model key and code.env_remove are not there, and the rest is", async (t) => {
  const gh = await fakeGitHub();
  const seen = join(await tempDir("seen"), "env.jsonl").split("\\").join("/");
  const f = await factory({ holder: "pull-request", github: gh, doc: { version: "0.1", organization: { used: { review: false, security: false } } }, extraEnv: { PF_T_MODEL_KEY: "a-model-key", ANTHROPIC_API_KEY: "sk-ant-not-for-scripts", PF_T_JOB_SETTING: "kept" } });
  t.after(async () => { await f.close(); await gh.close(); });
  const id = (await f.post("/builds", { does: "Count the words in a passage.", name: "counter" })).json.build.id;
  await f.settled(id);
  await f.post(`/builds/${id}/actions/approve`);
  await f.settled(id);
  // A script that tries to read every credential and writes what it found where the test can see it.
  const names = ["PF_T_GITHUB_TOKEN", "PF_T_MODEL_KEY", "MODEL_KEY", "ANTHROPIC_API_KEY", "PF_T_JOB_SETTING"];
  gh.push(BRANCH, { [SCRIPT]: `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(seen)}, JSON.stringify({ ${names.map((n) => `${n}: process.env.${n} ?? null`).join(", ")}, path: Boolean(process.env.PATH || process.env.Path) }) + "\\n");\n${RIGHT}` });
  const r = await f.runner.poll(id);
  assert.equal(r.passed, true);
  const runs = readFileSync(seen, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(runs.length >= 1, "the script ran in the gate");
  for (const got of runs) {
    assert.deepEqual(got, { PF_T_GITHUB_TOKEN: null, PF_T_MODEL_KEY: null, MODEL_KEY: null, ANTHROPIC_API_KEY: null, PF_T_JOB_SETTING: "kept", path: true });
  }
  assert.ok(!readFileSync(seen, "utf8").includes(gh.token));
});

test("the credentials are named by their exact names: the token's, the model key's, each webhook's address, and code.env_remove", () => {
  const c = readConfig({ model: { key: "OUR_KEY" }, code: { holder: "pull-request", env_remove: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] }, repository: { host: "github", repo: "a/b", token: "GH_PAT" }, notify: [{ kind: "webhook", url_env: "SLACK_URL" }] }, "/");
  assert.deepEqual(credentialNames(c, { code: { env_remove: ["OLD_KEY"] }, repository: { token: "OLD_TOKEN" } }), ["ANTHROPIC_API_KEY", "GH_PAT", "MODEL_KEY", "OLD_KEY", "OLD_TOKEN", "OPENAI_API_KEY", "OUR_KEY", "SLACK_URL"]);
});

test("code.fix_rounds is a whole number from 1 to 1000, 3 when not set", () => {
  assert.equal(readConfig({}, "/").code.fix_rounds, 3);
  assert.equal(readConfig({ code: { fix_rounds: 5 } }, "/").code.fix_rounds, 5);
  assert.throws(() => readConfig({ code: { fix_rounds: 0 } }, "/"), /"code\.fix_rounds" is a whole number from 1 to 1000/);
  assert.throws(() => readConfig({ code: { fix_rounds: "3" } }, "/"), /whole number/);
  assert.throws(() => readConfig({ code: { fix_round: 3 } }, "/"), /it reads holder, harness, rounds, fix_rounds, minutes and env_remove/);
});

test("a word with line breaks goes to a .cmd program on one line, so cmd.exe cannot end the command there", { skip: process.platform !== "win32" }, async () => {
  const dir = await tempDir("cmd");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "harness.cmd"), "@echo off\r\n");
  const r = resolveCommand(["harness", "line one\nline two\r\nline three"], { PATH: dir, PATHEXT: ".CMD" });
  assert.equal(r.shell, true);
  assert.doesNotMatch(r.file, /[\r\n]/);
  assert.match(r.file, /"line one line two line three"$/);
});
