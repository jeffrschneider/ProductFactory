// Run stages handed to a runtime (SPEC 5.9): after Package, the build writes the
// run plan beside the package (each later stage's role, holder, settings and
// interface, and whether the holder is chosen), and hands both files to the
// runtime product-factory.json names. With no runtime, Deploy waits on the person.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBuild, checkBuildList } from "adlc-console/lib/contract.mjs";
import { factory, stageOf, actionNames } from "./helpers.mjs";
import { STAGE_IDS, stageById } from "../lib/standards.mjs";
import { readConfig } from "../lib/config.mjs";
import { PLAN_STAGES } from "../lib/runtime.mjs";

const FOLDER = join(dirname(fileURLToPath(import.meta.url)), "..", "runtimes", "folder.mjs");
const ok = (b) => assert.deepEqual(checkBuild({ build: b }, STAGE_IDS), []);
// Retract is left out; nobody holds the agent critic's role (Eval) by default.
const doc = { version: "0.1", organization: { used: { retract: false } } };
const WATCH = { every_minutes: 5, alert: { after_failures: 3 } };

/** Starts a build and walks it through your approval and your OK to the "approve the deploy" gate, and through it unless told not to. */
async function walk(f, { name = "counter", deploy = true } = {}) {
  const id = (await f.post("/builds", { does: "Count the words.", name })).json.build.id;
  await f.settled(id);
  await f.post(`/builds/${id}/actions/approve`);
  await f.settled(id);
  await f.post(`/builds/${id}/actions/accept`);
  const atGate = await f.settled(id);
  if (!deploy) return atGate;
  assert.deepEqual(actionNames(atGate), ["approve", "stop"]);
  await f.post(`/builds/${id}/actions/approve`);
  return f.settled(id);
}

const planOf = (f, b) => {
  const at = f.store.read(b.id).plan.at;
  return { at, plan: JSON.parse(readFileSync(join(f.store.folder(b.id), at), "utf8")) };
};
const entry = (plan, id) => plan.stages.find((s) => s.stage === id);

test("the run plan records each later stage: chosen, not chosen, not used, and the holder's settings", async (t) => {
  const f = await factory({ doc });
  t.after(f.close);
  // The watcher's settings go into the lifecycle document through the roles route.
  const set = await f.put("/roles/watcher", { holder: { kind: "your_agent", name: "Our watcher", handle: "watcher.ops@example.com", settings: WATCH } });
  assert.equal(set.status, 200);
  assert.deepEqual(JSON.parse(readFileSync(f.lifecycle.file, "utf8")).organization.holders.watcher.settings, WATCH);

  const b = await walk(f);
  ok(b);
  assert.equal(stageOf(b, "package").state, "done");
  const { at, plan } = planOf(f, b);

  // Beside the package, naming it.
  const archive = stageOf(b, "package").handed_back.files.find((x) => x.path.endsWith(".tar.gz"));
  const archiveAt = f.store.read(b.id).stages.package.handed_back.files.find((x) => x.path === archive.path).at;
  assert.equal(dirname(at), dirname(archiveAt));
  assert.equal(plan.format, "product-factory-run-plan-v1");
  assert.equal(plan.package, archive.path.replace(/^package\//, ""));
  assert.deepEqual(plan.product, { name: "counter", version: "0.1.0", kind: "agent", build: b.id });
  assert.deepEqual(plan.stages.map((s) => s.stage), PLAN_STAGES);

  // Each entry quotes its stage's "hands back" line as the interface.
  for (const s of plan.stages) assert.equal(s.interface, stageById.get(s.stage).hands_back, s.stage);

  // Chosen, with settings: the watcher holds Monitor and Cost.
  for (const id of ["monitor", "cost"]) {
    const e = entry(plan, id);
    assert.deepEqual([e.used, e.chosen, e.reads, e.role], [true, true, "chosen", "watcher"], id);
    assert.deepEqual(e.holder, { kind: "your_agent", name: "Our watcher", handle: "watcher.ops@example.com" });
    assert.deepEqual(e.settings, WATCH);
  }
  // Chosen by default: the reference deployment manager, with no settings.
  const update = entry(plan, "update");
  assert.deepEqual([update.chosen, update.role, update.holder, update.settings], [true, "deployment-manager", { kind: "reference_agent", name: "deployment-manager" }, {}]);
  // Not chosen: nobody holds the agent critic's role.
  const ev = entry(plan, "eval");
  assert.deepEqual([ev.used, ev.chosen, ev.reads, ev.holder], [true, false, "not chosen", null]);
  // Not used: the lifecycle leaves Retract out.
  const retract = entry(plan, "retract");
  assert.deepEqual([retract.used, retract.chosen, retract.reads, retract.holder], [false, false, "not used", null]);

  // The build view shows the run plan's stages with their holders and settings, as recorded.
  const monitor = stageOf(b, "monitor");
  assert.equal(monitor.state, "not_started");
  assert.deepEqual(monitor.holder, { kind: "your_agent", name: "Our watcher", handle: "watcher.ops@example.com", role: "watcher", settings: WATCH });
  assert.match(monitor.given, /hands back: “whether each agent is alive, answering, and inside its limits”/);
  assert.match(monitor.given, /Settings: \{"every_minutes":5,"alert":\{"after_failures":3\}\}/);
  assert.equal(stageOf(b, "eval").state, "not_bound");
  assert.equal(stageOf(b, "eval").holder, null);
  assert.match(stageOf(b, "eval").given, /^Not chosen: nobody holds the Agent critic role/);
  assert.equal(stageOf(b, "retract").state, "not_used");
  assert.equal(stageOf(b, "release").state, "not_offered");
  assert.ok(b.log.some((e) => /^Not chosen: Eval \(Agent critic\)/.test(e.said)));

  // A later change to the lifecycle does not change the build's run plan.
  await f.put("/roles/watcher", { holder: { kind: "person", name: "Ops", settings: { every_minutes: 60 } } });
  assert.deepEqual(stageOf((await f.get(`/builds/${b.id}`)).json.build, "monitor").holder.settings, WATCH);
});

test("the process document's \"approve the deploy\" gate waits for the person before the runtime is handed anything", async (t) => {
  const f = await factory({ doc, runtime: { command: ["node", FOLDER, "--into", "./installed"] } });
  t.after(f.close);
  let b = await walk(f, { deploy: false });
  ok(b);
  const d = stageOf(b, "deploy");
  assert.equal(d.state, "waiting_on_you");
  assert.equal(d.holder.kind, "person");
  assert.equal(d.runs, 0);
  assert.match(d.given, /^Approve the deploy: read the package's build record and the run plan/);
  assert.deepEqual(d.handed_back.files.map((x) => x.path.replace(/^package\/[^/]+(\.tar\.gz|-build\.json)$/, "package/<$1>")), ["package/<.tar.gz>", "package/<-build.json>", "package/run-plan.json"]);
  assert.equal(b.summary, "Packed and validated · counter 0.1.0 · Approve the deploy");
  assert.deepEqual(b.actions.map((a) => [a.name, a.label]), [["approve", "Approve the deploy"], ["stop", "Stop"]]);
  // The run plan is there to read, and the runtime has not been handed anything.
  assert.equal(planOf(f, b).plan.format, "product-factory-run-plan-v1");
  assert.equal(stageOf(b, "monitor").state, "not_started");
  assert.ok(!existsSync(join(f.dir, "installed")));
  const run = f.store.read(b.id).run;
  assert.equal(run.status, "open");
  assert.equal(run.phases["approve-the-deploy"].status, "gated");

  // Your yes: the package goes to the runtime, which holds deploy-the-agent; Conformance checks the package, and the run ends before the publish gate.
  ok((await f.post(`/builds/${b.id}/actions/approve`)).json.build);
  b = await f.settled(b.id);
  ok(b);
  assert.equal(stageOf(b, "deploy").state, "done");
  assert.ok(existsSync(join(f.dir, "installed", "counter-0.1.0", "run-plan.json")));
  const after = f.store.read(b.id).run;
  assert.deepEqual([after.status, after.outcome], ["closed", "ended"]);
  assert.deepEqual(after.open, ["publish-the-agent"]);
  for (const p of ["deploy-the-agent", "check-conformance"]) assert.equal(after.phases[p].status, "closed", p);
  assert.equal(after.phases["deploy-the-agent"].holder.handle, "runtime/your-runtime");
  assert.ok(after.approvals.some((x) => x.phase === "approve-the-deploy" && x.by === "person@example.com"));
  assert.ok(b.log.some((e) => e.said === "You approved the deploy."));
});

test("stopping at the \"approve the deploy\" gate ends the build, and nothing is handed over", async (t) => {
  const f = await factory({ doc, runtime: { command: ["node", FOLDER, "--into", "./installed"] } });
  t.after(f.close);
  const b = await walk(f, { deploy: false });
  const stopped = (await f.post(`/builds/${b.id}/actions/stop`)).json.build;
  ok(stopped);
  assert.equal(stopped.summary, "Stopped at Deploy");
  assert.deepEqual(actionNames(stopped), ["archive"]);
  assert.ok(!existsSync(join(f.dir, "installed")));
});

test("with no runtime set, Deploy waits: hand this package to your runtime, with both paths shown", async (t) => {
  const f = await factory({ doc });
  t.after(f.close);
  let b = await walk(f);
  ok(b);
  const d = stageOf(b, "deploy");
  assert.equal(d.state, "waiting_on_you");
  assert.equal(d.holder.kind, "person");
  assert.match(d.given, /^Hand this package to your runtime/);
  assert.deepEqual(d.handed_back.files.map((x) => x.path.replace(/[^/]+\.tar\.gz$/, "<archive>")), ["package/<archive>", "package/run-plan.json"]);
  const r = f.store.read(b.id);
  const pkg = join(f.store.folder(b.id), r.stages.deploy.handed_back.files[0].at);
  const plan = join(f.store.folder(b.id), r.plan.at);
  assert.ok(d.handed_back.words[0].includes(pkg), "the package's path is shown");
  assert.ok(d.handed_back.words[0].includes(plan), "the run plan's path is shown");
  const got = await f.call("GET", `/builds/${b.id}/files?path=${encodeURIComponent("package/run-plan.json")}`, undefined, { raw: true });
  assert.equal(got.status, 200);
  assert.equal(JSON.parse(got.text).format, "product-factory-run-plan-v1");
  assert.equal(b.summary, "Packed and validated · counter 0.1.0 · Hand this package to your runtime");
  assert.deepEqual(actionNames(b), ["resume", "archive"]);
  assert.equal(b.actions[0].label, "Hand it to your runtime");
  assert.deepEqual(checkBuildList((await f.get("/builds")).json), []);

  // Once a runtime is set, handing it over runs it.
  f.config.runtime = { command: ["node", FOLDER, "--into", "./installed"], cwd: f.dir };
  ok((await f.post(`/builds/${b.id}/actions/resume`)).json.build);
  b = await f.settled(b.id);
  ok(b);
  assert.equal(stageOf(b, "deploy").state, "done");
  assert.ok(existsSync(join(f.dir, "installed", "counter-0.1.0", "run-plan.json")));
});

test("Deploy with the reference runtime: the package and the run plan are copied into its folder", async (t) => {
  const f = await factory({ doc, runtime: { command: ["node", FOLDER, "--into", "./installed"] } });
  t.after(f.close);
  const b = await walk(f);
  ok(b);
  const d = stageOf(b, "deploy");
  assert.equal(d.state, "done");
  assert.deepEqual([d.holder.kind, d.holder.role], ["outside_tool", "deployment-manager"]);
  assert.match(d.holder.name, /^your runtime \(node /);
  assert.equal(d.runs, 1);
  assert.equal(d.rounds[0].verdict, "Handed to your runtime");
  assert.match(d.handed_back.words[0], /^Installed counter 0\.1\.0 into .*counter-0\.1\.0: the package and its run plan are there\. The run plan names holders for Publish, Monitor, Incident response, Cost, Update, Reconfigure, Rollback, Decommission\.$/);
  // The command ran in the settings file's folder, so ./installed is beside it.
  const where = join(f.dir, "installed", "counter-0.1.0");
  const archive = d.handed_back.files[0].path.replace(/^package\//, "");
  assert.ok(existsSync(join(where, archive)));
  assert.deepEqual(JSON.parse(readFileSync(join(where, "run-plan.json"), "utf8")), planOf(f, b).plan);
  assert.equal(b.handle, `folder:${where}`);
  assert.equal(b.summary, "Handed to your runtime · counter 0.1.0 · Passed the Common Agent checks that run here");
  assert.equal(stageOf(b, "conformance").state, "done");
  assert.deepEqual(actionNames(b), ["archive"]);
  assert.ok(existsSync(join(f.store.folder(b.id), "stages", "deploy", "r1", "run.log")));
});

test("a runtime that fails: Deploy is refused in its words, and can be handed over again", async (t) => {
  const f = await factory({ doc, runtime: { command: ["node", "-e", "console.error('The host is full.'); process.exit(3)"] } });
  t.after(f.close);
  let b = await walk(f);
  ok(b);
  let d = stageOf(b, "deploy");
  assert.equal(d.state, "refused");
  assert.equal(d.done_when_met, false);
  assert.match(d.handed_back.words[0], /^Your runtime refused the package: The host is full\./);
  assert.equal(d.rounds[0].verdict, "Refused");
  assert.equal(b.summary, "Refused at Deploy: waiting on you");
  assert.deepEqual(actionNames(b), ["resume", "archive"]);
  assert.equal(b.actions[0].label, "Hand it over again");
  // The run plan is written even so.
  assert.ok(planOf(f, b).plan.stages.length);

  await f.post(`/builds/${b.id}/actions/resume`);
  b = await f.settled(b.id);
  ok(b);
  d = stageOf(b, "deploy");
  assert.equal(d.state, "refused");
  assert.equal(d.runs, 2);
  assert.deepEqual(d.rounds.map((x) => x.n), [2, 1]);

  // A runtime that is not there says so.
  f.config.runtime = { command: ["no-such-runtime-on-this-computer"], cwd: f.dir };
  await f.post(`/builds/${b.id}/actions/resume`);
  b = await f.settled(b.id);
  assert.match(stageOf(b, "deploy").handed_back.words[0], /^Your runtime (could not run|refused the package)/);
});

test("runtime.command is a command as a list of words, run from the settings file's folder", () => {
  assert.equal(readConfig({}, "/").runtime, null);
  assert.throws(() => readConfig({ runtime: { command: "deploy-it" } }, "/"), /list of words/);
  assert.throws(() => readConfig({ runtime: { command: ["x"], where: "y" } }, "/"), /reads only command/);
  assert.throws(() => readConfig({ runtime: ["x"] }, "/"), /object with "command"/);
  const c = readConfig({ runtime: { command: ["node", "runtimes/folder.mjs", "--into", "./installed"] } }, join("/work", "pf"));
  assert.deepEqual(c.runtime.command, ["node", "runtimes/folder.mjs", "--into", "./installed"]);
  assert.equal(c.runtime.cwd, resolve("/work", "pf"));
});
