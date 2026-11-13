// Each stage's cadence (stages.json 1.3.0, lifecycle API 0.4.2), over HTTP:
// every stage carries it; a reviewer one builder's build did not ask says why;
// a setup stage whose holder and settings are unchanged reads "Unchanged since
// <version>"; and a product lists its setup stages and its when-needed
// actions. Stand-in holders only: no test reaches a model or the network.

import test from "node:test";
import assert from "node:assert/strict";
import { factory, stageOf, walk, startRebuild } from "./helpers.mjs";
import { checkBuild, checkStageWorkspace, checkProduct, stageCadences } from "../standards/lifecycle-api-check.mjs";
import { STAGE_IDS, STAGES_DOC } from "../lib/standards.mjs";
import { setupList, whenNeededList, carriedFor, choiceOf, sameChoice } from "../lib/cadence.mjs";

const CAD = stageCadences();
const WATCH = { every_minutes: 5 };
const watcher = (settings = WATCH) => ({ kind: "your_agent", name: "Our watcher", handle: "watcher.ops@example.com", settings });

/** A build "counter" one builder holds, walked through its gates. */
async function walked(t, opts = {}) {
  const f = await factory(opts);
  t.after(f.close);
  const id = (await f.post("/builds", { does: "Count the words in a passage.", name: "counter" })).json.build.id;
  return { f, id, b: await walk(f, id) };
}

const held = (b) => assert.deepEqual(checkBuild({ build: b }, STAGE_IDS, b.id), []);
async function ws(f, b, stage) {
  const got = (await f.get(`/builds/${b.id}/stages/${stage}`)).json;
  assert.deepEqual(checkStageWorkspace(got, STAGE_IDS, stage, { build: b }), [], stage);
  return got;
}

test("every stage of the build and of each workspace carries its cadence from stages.json", async (t) => {
  const { f, b } = await walked(t);
  held(b);
  assert.deepEqual(Object.fromEntries(b.stages.map((s) => [s.stage, s.cadence])), CAD);
  for (const stage of ["requirements", "review", "monitor", "rollback"]) assert.equal((await ws(f, b, stage)).cadence, CAD[stage]);
});

test("a reviewer one builder's build did not ask says why, and a build on the reference writers never asks them", async (t) => {
  const { b } = await walked(t, { doc: { version: "0.1", organization: { holders: { "code-critic": { kind: "person", name: "Our review team" } } } } });
  held(b);
  assert.equal(stageOf(b, "review").state, "not_offered");
  assert.match(stageOf(b, "review").given, /did not ask the code critic: the lifecycle has Our review team hold the Code critic role/);
  assert.equal(stageOf(b, "security").state, "done");

  const local = await factory();
  t.after(local.close);
  const lid = await startRebuild(local, { does: "Count the words in a passage.", name: "counter" });
  const lb = await local.settled(lid);
  for (const s of ["review", "security"]) {
    assert.equal(stageOf(lb, s).state, "not_offered");
    assert.match(stageOf(lb, s).given, /This build runs on the reference writers, so the suite is the gate/);
  }
});

test("a setup stage with the same holder and settings as an earlier version reads unchanged since that version", async (t) => {
  const f = await factory({ doc: { version: "0.1", organization: { holders: { watcher: watcher() } } } });
  t.after(f.close);
  const start = async (version) => {
    const r = await f.runner.start({ does: "Count the words in a passage.", name: "counter" }, undefined, version ? { version } : {});
    return f.settled(r.id);
  };
  const first = await start(null);
  held(first);
  assert.equal(stageOf(first, "monitor").carried, undefined);

  const second = await start("0.2.0");
  held(second);
  for (const s of ["monitor", "cost", "update", "architecture"]) {
    assert.deepEqual(stageOf(second, s).carried, { since: first.version, build: first.id, words: `Unchanged since ${first.version}` }, s);
  }
  assert.match(stageOf(second, "monitor").given, /^Unchanged since 0\.1\.0: the same holder and settings as 0\.1\.0, so nothing is asked again\./);
  // Nobody holds the agent critic's role, so Eval is not carried: it still asks.
  assert.equal(stageOf(second, "eval").carried, undefined);
  // Only a setup stage is carried.
  assert.equal(stageOf(second, "requirements").carried, undefined);
  const mw = await ws(f, second, "monitor");
  assert.deepEqual(mw.carried, stageOf(second, "monitor").carried);
  assert.equal(mw.cadence, "setup");

  // The product: its setup stages and when-needed actions, held to the check.
  let p = (await f.get("/products/counter")).json;
  assert.deepEqual(checkProduct(p, "counter"), []);
  // Each setup item also carries its form (0.4.4), tested in setup-actions.test.mjs.
  const one = (list, stage) => { const { form, ...x } = list.find((i) => i.stage === stage); return x; };
  assert.deepEqual(p.setup.map((x) => x.stage), STAGES_DOC.stages.filter((s) => s.cadence === "setup").map((s) => s.id));
  assert.deepEqual(one(p.setup, "monitor"), { stage: "monitor", name: "Monitor", role: "watcher", project: null, state: "chosen", holder: { kind: "your_agent", name: "Our watcher", handle: "watcher.ops@example.com" }, settings: WATCH, since: "0.1.0", words: "Unchanged since 0.1.0" });
  assert.deepEqual(one(p.setup, "eval"), { stage: "eval", name: "Eval", role: "agent-critic", project: null, state: "not_chosen", holder: null, settings: {}, since: null, words: "Nobody chosen: nobody holds the Agent critic role" });
  assert.equal(one(p.setup, "architecture").role, "solution-architect");
  assert.deepEqual(p.when_needed.map((x) => [x.stage, x.can_run]), [["reverse-engineering", false], ["impact", false], ["retract", false], ["reconfigure", false], ["rollback", false], ["decommission", false]]);
  // No runtime is set and nothing is deployed, so each says why in words (0.4.4: setup-actions.test.mjs runs them).
  assert.match(one(p.when_needed, "rollback").why_not, /^No runtime is set, so there is nothing for Product Factory to ask\./);
  assert.match(one(p.when_needed, "impact").why_not, /^Nothing of counter is running yet, so there is nothing to check a change against\./);

  // A new choice holds from the next version; the builds already started keep theirs.
  assert.equal((await f.put("/roles/watcher", { holder: watcher({ every_minutes: 60 }) })).status, 200);
  p = (await f.get("/products/counter")).json;
  assert.deepEqual(checkProduct(p, "counter"), []);
  assert.deepEqual([one(p.setup, "monitor").since, one(p.setup, "monitor").words, one(p.setup, "monitor").settings], [null, "Chosen: it holds from the next version", { every_minutes: 60 }]);
  assert.equal(one(p.setup, "update").since, "0.1.0");
  assert.equal(stageOf((await f.get(`/builds/${second.id}`)).json.build, "monitor").carried.since, "0.1.0");

  // The next version takes it, so it is chosen at that version and not carried.
  const third = await start("0.3.0");
  held(third);
  assert.equal(stageOf(third, "monitor").carried, undefined);
  assert.equal(stageOf(third, "update").carried.since, "0.1.0");
  p = (await f.get("/products/counter")).json;
  assert.deepEqual([one(p.setup, "monitor").since, one(p.setup, "monitor").words], ["0.3.0", "Chosen at 0.3.0"]);

  // Leaving a stage out of the lifecycle reads not_used, and a when-needed one says so.
  await f.put("/stages/retract", { used: false });
  await f.put("/stages/publish", { used: false });
  p = (await f.get("/products/counter")).json;
  assert.deepEqual(checkProduct(p, "counter"), []);
  assert.deepEqual([one(p.setup, "publish").state, one(p.setup, "publish").holder], ["not_used", null]);
  assert.equal(one(p.when_needed, "retract").why_not, "This product's lifecycle leaves Retract out.");
});

test("the cadence rules as functions: a choice, its comparison, carried and the lists", () => {
  const lc = (settings) => ({ project: null, used: {}, holders: { watcher: watcher(settings), "deployment-manager": { kind: "reference_agent", name: "deployment-manager" } } });
  assert.deepEqual(choiceOf(lc(WATCH), "monitor"), { role: "watcher", used: true, holder: { kind: "your_agent", name: "Our watcher", handle: "watcher.ops@example.com" }, settings: WATCH });
  // Settings compare by content, whatever the order of their keys.
  assert.ok(sameChoice(choiceOf(lc({ a: 1, b: 2 }), "monitor"), choiceOf(lc({ b: 2, a: 1 }), "monitor")));
  assert.ok(!sameChoice(choiceOf(lc({ a: 1 }), "monitor"), choiceOf(lc({ a: 2 }), "monitor")));
  const b = (id, version, settings) => ({ id, version, lifecycle: lc(settings) });
  // The unbroken run back from the build: a change in between ends it.
  assert.deepEqual(carriedFor(b("c", "0.3.0", WATCH), "monitor", [b("b", "0.2.0", WATCH), b("a", "0.1.0", WATCH)]), { since: "0.1.0", build: "a", words: "Unchanged since 0.1.0" });
  assert.deepEqual(carriedFor(b("c", "0.3.0", WATCH), "monitor", [b("b", "0.2.0", WATCH), b("a", "0.1.0", { every_minutes: 1 })]).since, "0.2.0");
  assert.equal(carriedFor(b("c", "0.3.0", WATCH), "monitor", [b("b", "0.2.0", { every_minutes: 1 }), b("a", "0.1.0", WATCH)]), null);
  assert.equal(carriedFor(b("c", "0.3.0", WATCH), "code", [b("b", "0.2.0", WATCH)]), null);
  const list = setupList([b("b", "0.2.0", WATCH), b("a", "0.1.0", WATCH)], lc(WATCH));
  assert.equal(list.find((x) => x.stage === "monitor").since, "0.1.0");
  assert.ok(whenNeededList(lc(WATCH)).every((x) => x.can_run === false && x.why_not));
});
