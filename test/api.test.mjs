// The lifecycle API as Product Factory answers it, over HTTP, run through
// the console's contract checks (CommonAgent/adlc-console lib/contract.mjs)
// and the lifecycle API's own check (CommonAgent/adlc standards/lifecycle-api-check.mjs).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { factory, stageOf } from "./helpers.mjs";
import { checkBuildList, checkBuild, checkRoles, checkStages, checkTries } from "adlc-console/lib/contract.mjs";
import { run as apiCheck, stageIds, stageRoles, stageFacts, validate } from "../standards/lifecycle-api-check.mjs";
import { STAGES_DOC, STAGE_IDS, API_SCHEMA } from "../lib/standards.mjs";

const ROLE_IDS = STAGES_DOC.roles.map((r) => r.id);
const doc = { version: "0.1", organization: { used: { impact: false }, holders: { "code-critic": { kind: "person", name: "Our review team" } } }, projects: { web: { used: { docs: false } } } };

test("the vendored schema is lifecycle API 0.4.9, and stages.json 1.6.0 has 25 stages, Reverse engineering numbered 0, and Requirements hands back the spec", () => {
  assert.equal(API_SCHEMA.version, "0.4.9");
  assert.equal(STAGES_DOC.version, "1.6.0");
  assert.equal(STAGES_DOC.stages.find((s) => s.id === "requirements").asset, "Spec");
  assert.ok(API_SCHEMA.$defs.SpecSummary);
  assert.equal(STAGE_IDS.length, 25);
  assert.equal(STAGE_IDS[0], "reverse-engineering");
});

test("every answer has the contract's shape, and the lifecycle API check finds nothing wrong", async (t) => {
  const f = await factory({ doc, failRounds: 1 });
  t.after(f.close);
  // Builds in several states: waiting at Requirements, refused, waiting at Code, done, stopped.
  const waiting = (await f.post("/builds", { does: "Count the words." })).json.build.id;
  const refused = (await f.post("/builds", { does: "Please refuse at requirements.", project: "web" })).json.build.id;
  const atCode = (await f.post("/builds", { does: "Count the words.", name: "counter" })).json.build.id;
  const done = (await f.post("/builds", { does: "Count the words.", name: "finished" })).json.build.id;
  const stopped = (await f.post("/builds", { does: "Count the words.", name: "halted" })).json.build.id;
  for (const id of [waiting, refused, atCode, done, stopped]) await f.settled(id);
  await f.post(`/builds/${atCode}/actions/approve`);
  await f.post(`/builds/${done}/actions/approve`);
  await f.settled(atCode);
  await f.settled(done);
  await f.post(`/builds/${done}/actions/accept`);
  await f.settled(done);
  await f.post(`/builds/${stopped}/actions/stop`);
  assert.equal((await f.get(`/builds/${done}`)).json.build.summary, "Packed and validated · finished 0.1.0 · Approve the deploy");

  // The console's checks.
  const list = await f.get("/builds");
  assert.equal(list.status, 200);
  assert.deepEqual(checkBuildList(list.json), []);
  assert.equal(list.json.builds.length, 5);
  for (const b of list.json.builds) {
    const one = await f.get(`/builds/${b.id}`);
    assert.equal(one.status, 200);
    assert.deepEqual(checkBuild(one.json, STAGE_IDS), [], b.id);
    assert.deepEqual(validate("BuildAnswer", one.json), [], b.id);
    assert.deepEqual(checkTries((await f.get(`/builds/${b.id}/tries`)).json), []);
  }
  const roles = await f.get("/roles");
  assert.deepEqual(checkRoles(roles.json, ROLE_IDS), []);
  assert.deepEqual(checkRoles((await f.get("/roles?project=web")).json, ROLE_IDS), []);
  assert.deepEqual(checkStages((await f.get("/stages")).json, { stages: STAGES_DOC.stages, project: null }), []);
  assert.deepEqual(checkStages((await f.get("/stages?project=web")).json, { stages: STAGES_DOC.stages, project: "web" }), []);

  // The lifecycle API's own check, over every build, every file and every role and stage answer.
  const said = [];
  const { calls, problems } = await apiCheck({ base: `${f.base}/v1/lifecycle/`, key: f.key.value, ids: stageIds(), roles: stageRoles(), stages: stageFacts(), allFiles: true, say: (s) => said.push(s) });
  assert.deepEqual(problems, []);
  assert.ok(calls > 15, `${calls} calls`);
  assert.ok(said.some((s) => s.includes("GET me")));
});

test("the stages and roles operations read and write the lifecycle document", async (t) => {
  const f = await factory({ doc });
  t.after(f.close);
  const at = (body, id) => body.stages.find((s) => s.stage === id);
  const org = (await f.get("/stages")).json;
  assert.equal(at(org, "impact").used, false);
  assert.equal(at(org, "impact").from, "org");
  assert.equal(at(org, "review").from, "default");
  for (const id of ["requirements", "test", "code"]) {
    assert.equal(at(org, id).can_leave_out, false, id);
    assert.match(at(org, id).why_not, /cannot build without it/);
  }
  assert.equal(at(org, "package").can_leave_out, true);

  const off = await f.put("/stages/package", { used: false });
  assert.equal(off.status, 200);
  assert.deepEqual(checkStages(off.json, { stages: STAGES_DOC.stages, project: null }), []);
  assert.equal(at(off.json, "package").used, false);
  const prj = await f.put("/stages/package?project=web", { used: true });
  assert.equal(at(prj.json, "package").from, "project");
  const back = await f.del("/stages/package?project=web");
  assert.equal(at(back.json, "package").from, "org");
  assert.equal(at((await f.del("/stages/package")).json, "package").from, "default");

  for (const [stage, body] of [["code", { used: false }], ["test", { used: false }], ["nothing", { used: false }], ["docs", { used: "no" }], ["docs", {}]]) {
    const r = await f.put(`/stages/${stage}`, body);
    assert.equal(r.status, 400, `${stage} ${JSON.stringify(body)}`);
    assert.equal(typeof r.json.error, "string");
  }
  assert.match((await f.put("/stages/test", { used: false })).json.error, /suite is Code's gate/);

  const holder = { kind: "outside_tool", name: "Our scanner", evidence: { formats: ["sarif"] } };
  const bound = await f.put("/roles/security-reviewer", { holder });
  assert.equal(bound.status, 200);
  assert.deepEqual(checkRoles(bound.json, ROLE_IDS), []);
  assert.deepEqual(bound.json.roles.find((r) => r.role === "security-reviewer").binding.holder, holder);
  const cleared = await f.del("/roles/security-reviewer");
  assert.equal(cleared.json.roles.find((r) => r.role === "security-reviewer").from, "default");
  for (const [role, h] of [["nobody", { kind: "person", name: "x" }], ["code-critic", { kind: "your_agent", name: "Ours" }], ["requester", { kind: "outside_tool", name: "A form" }], ["code-critic", { kind: "robot", name: "x" }]]) {
    const r = await f.put(`/roles/${role}`, { holder: h });
    assert.equal(r.status, 400, `${role} ${h.kind}`);
    assert.equal(typeof r.json.error, "string");
  }
  // What was written is a valid lifecycle document, kept in the file.
  const kept = JSON.parse(readFileSync(f.lifecycle.file, "utf8"));
  assert.equal(kept.version, "0.1");
  assert.equal(kept.organization.used.impact, false);
});

test("the service answers only with its key, and refuses what milestone 1 does not do in words", async (t) => {
  const f = await factory();
  t.after(f.close);
  assert.equal((await f.call("GET", "/builds", undefined, { auth: null })).status, 401);
  const wrong = await f.call("GET", "/builds", undefined, { auth: "not-the-key" });
  assert.equal(wrong.status, 401);
  assert.equal(typeof wrong.json.error, "string");
  const me = await f.get("/me");
  assert.deepEqual(validate("MeAnswer", me.json), []);
  assert.equal(me.json.service.name, "Product Factory");

  assert.equal((await f.post("/builds", {})).status, 400);
  const proc = await f.post("/builds", { does: "Approve expenses.", kind: "process" });
  assert.equal(proc.status, 400);
  assert.match(proc.json.error, /agents only/);
  assert.equal((await f.get("/builds/b_000000000000")).status, 404);

  const id = (await f.post("/builds", { does: "Count the words." })).json.build.id;
  const b = await f.settled(id);
  assert.equal((await f.post(`/builds/${id}/try`, { say: "hello", against: "pull_request" })).status, 409);
  assert.equal((await f.post(`/builds/${id}/actions/nothing`)).status, 409);
  const file = stageOf(b, "requirements").handed_back.files[0];
  const got = await f.call("GET", `/builds/${id}/files?path=${encodeURIComponent(file.path)}`, undefined, { raw: true });
  assert.equal(got.status, 200);
  assert.equal(Buffer.byteLength(got.text), file.size);
  for (const p of ["../build.json", "requirements/../../build.json", "stages/requirements/r1/job/message.txt", ""]) {
    assert.equal((await f.get(`/builds/${id}/files?path=${encodeURIComponent(p)}`)).status, 404, p);
  }
});
