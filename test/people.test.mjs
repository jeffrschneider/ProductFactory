// Teams: the people document, each person's own key, and who may do what,
// including who may approve each gate, by person and by team.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { factory, tempDir, stageOf, actionNames } from "./helpers.mjs";
import { readPeople, loadPeople, createKeys, readApprovers, peopleCommand, peoplePath, KEYS_FILE } from "../lib/people.mjs";
import { createLifecycle } from "../lib/lifecycle.mjs";
import { validate } from "../standards/lifecycle-api-check.mjs";

const PEOPLE = {
  organization: "Example Org",
  people: [
    { name: "Ada Admin", email: "ada@example.com", role: "admin" },
    { name: "Ana Lee", email: "ana@example.com", role: "approver" },
    { name: "Pat Park", email: "pat@example.com", role: "approver" },
    { name: "Max Member", email: "max@example.com", role: "member" },
  ],
  teams: [{ name: "Platform", members: ["pat@example.com", "max@example.com"] }],
  projects: [{ name: "web", teams: ["Platform"] }],
};

/** A Product Factory with PEOPLE and a key for each of them. */
async function withPeople(t, doc = null) {
  const f = await factory({ people: PEOPLE, doc });
  t.after(f.close);
  const keys = createKeys(join(f.config.data, KEYS_FILE));
  const key = Object.fromEntries(PEOPLE.people.map((p) => [p.email.split("@")[0], keys.make(p.email)]));
  const as = (who) => ({
    get: (p) => f.call("GET", p, undefined, { auth: key[who] }),
    post: (p, b = {}) => f.call("POST", p, b, { auth: key[who] }),
    put: (p, b) => f.call("PUT", p, b, { auth: key[who] }),
    del: (p) => f.call("DELETE", p, undefined, { auth: key[who] }),
  });
  return { f, keys, key, as };
}

test("the people document is read and checked, with every problem in words", async () => {
  const ok = readPeople(PEOPLE);
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.doc.organization, "Example Org");
  assert.equal(ok.doc.people.length, 4);

  const bad = readPeople({
    organization: "Example Org",
    people: [
      { email: "ana@example.com", role: "approver" },
      { email: "ANA@example.com", role: "member" },
      { email: "bob@example.com", role: "owner" },
      { name: "No Email", role: "member" },
    ],
    teams: [{ name: "Platform", members: ["ana@example.com", "nobody@example.com"] }, { name: "platform" }],
    projects: [{ name: "web", teams: ["Design"] }],
    extra: true,
  });
  const said = bad.problems.join("\n");
  assert.match(said, /"extra", which Product Factory does not read/);
  assert.match(said, /ANA@example.com is listed twice/);
  assert.match(said, /bob@example.com has the role "owner"; a role is member, approver or admin/);
  assert.match(said, /people\[3\] needs an email/);
  assert.match(said, /The team Platform lists "nobody@example.com", who is not in people/);
  assert.match(said, /The team platform is listed twice/);
  assert.match(said, /The project web belongs to "Design", which is not a team/);
  // A person without a name is named by their email.
  assert.equal(bad.doc.people[0].name, "ana@example.com");

  const dir = await tempDir("people");
  assert.deepEqual(loadPeople(join(dir, "people.json")), { doc: { organization: "", people: [], teams: [], projects: [] }, problems: [], missing: true });
  writeFileSync(join(dir, "people.json"), "{ not json");
  assert.match(loadPeople(join(dir, "people.json")).problems[0], /not valid JSON/);
  assert.equal(peoplePath(join(dir, "lifecycle.json")), join(dir, "people.json"));
});

test("a person's key is printed once, kept only as its hash, and stops working when revoked or remade", async () => {
  const dir = await tempDir("keys");
  const keys = createKeys(join(dir, KEYS_FILE));
  const k1 = keys.make("ana@example.com");
  assert.match(k1, /^pf_[0-9a-f]{64}$/);
  const kept = readFileSync(keys.file, "utf8");
  assert.ok(!kept.includes(k1.slice(3)), "the key itself is never written");
  assert.match(kept, /"sha256": "[0-9a-f]{64}"/);
  assert.equal(keys.find(k1), "ana@example.com");
  assert.equal(keys.find("pf_nope"), null);

  // A new key replaces the old one.
  const k2 = keys.make("ana@example.com");
  assert.equal(keys.find(k1), null);
  assert.equal(keys.find(k2), "ana@example.com");
  assert.equal(keys.revoke("ana@example.com"), 1);
  assert.equal(keys.find(k2), null);
  assert.equal(keys.revoke("ana@example.com"), 0);
});

test("the command line adds people, teams and projects, and prints a key only when it makes one", async () => {
  const dir = await tempDir("cli");
  const config = { lifecycle: join(dir, "lifecycle.json"), data: join(dir, "data") };
  const added = peopleCommand(["person", "add", "ana@example.com"], { role: "approver", name: "Ana Lee" }, config);
  assert.equal(added.code, 0);
  const key = /pf_[0-9a-f]{64}/.exec(added.out)?.[0];
  assert.ok(key, "the key is printed");
  assert.equal(createKeys(join(config.data, KEYS_FILE)).find(key), "ana@example.com");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "people.json"), "utf8")).people, [{ name: "Ana Lee", email: "ana@example.com", role: "approver" }]);

  // Changing a role keeps the key, and prints none.
  const again = peopleCommand(["person", "add", "ana@example.com"], { role: "admin" }, config);
  assert.doesNotMatch(again.out, /pf_/);
  assert.equal(createKeys(join(config.data, KEYS_FILE)).find(key), "ana@example.com");

  assert.equal(peopleCommand(["person", "add", "bob@example.com"], { role: "owner" }, config).code, 2);
  assert.equal(peopleCommand(["team", "add", "Platform"], { member: ["nobody@example.com"] }, config).code, 2);
  assert.equal(peopleCommand(["team", "add", "Platform"], { member: ["ana@example.com"] }, config).code, 0);
  assert.equal(peopleCommand(["project", "add", "web"], { team: ["Design"] }, config).code, 2);
  assert.equal(peopleCommand(["project", "add", "web"], { team: ["Platform"] }, config).code, 0);
  const list = peopleCommand(["people"], {}, config);
  assert.match(list.out, /Ana Lee <ana@example.com>  admin/);
  assert.match(list.out, /Platform: ana@example.com/);
  assert.match(list.out, /web: Platform/);
  assert.doesNotMatch(list.out, /pf_/);

  const removed = peopleCommand(["person", "remove", "ana@example.com"], {}, config);
  assert.equal(removed.code, 0);
  assert.equal(createKeys(join(config.data, KEYS_FILE)).find(key), null);
  const left = JSON.parse(readFileSync(join(dir, "people.json"), "utf8"));
  assert.deepEqual(left.people, []);
  assert.deepEqual(left.teams[0].members, []);
});

test("every call is made as a person: members build and read, only admins change the lifecycle", async (t) => {
  const { f, keys, key, as } = await withPeople(t);

  const me = await as("max").get("/me");
  assert.equal(me.status, 200);
  assert.deepEqual(validate("MeAnswer", me.json), []);
  assert.deepEqual([me.json.account.email, me.json.role, me.json.teams], ["max@example.com", "member", ["Platform"]]);
  // The service's own key still works, as an admin.
  assert.equal((await f.get("/me")).json.role, "admin");

  // A member starts a build, and it is started as them.
  const started = await as("max").post("/builds", { does: "Count the words." });
  assert.equal(started.status, 201);
  const id = started.json.build.id;
  await f.settled(id);
  assert.match(JSON.stringify(f.store.read(id).run), /max@example.com/);
  assert.equal((await as("max").get("/builds")).json.builds.length, 1);
  assert.equal((await as("max").get("/people")).status, 200);

  // Only an admin changes the lifecycle; a refusal is a 403 in words.
  for (const who of ["max", "ana"]) {
    const put = await as(who).put("/stages/docs", { used: false });
    assert.equal(put.status, 403);
    assert.match(put.json.error, /Only an admin of the organization can change its lifecycle/);
    assert.equal((await as(who).del("/roles/code-critic")).status, 403);
    assert.equal((await as(who).put("/roles/code-critic", { holder: { kind: "person", name: "Us" } })).status, 403);
  }
  assert.equal((await as("ada").put("/stages/docs", { used: false })).status, 200);
  assert.equal((await f.put("/stages/docs", { used: true })).status, 200);
  assert.equal((await as("max").get("/stages")).status, 200);
  assert.equal((await as("max").post("/people")).status, 405);

  // A revoked key, or a person taken out of people.json, is refused in words.
  keys.revoke("max@example.com");
  const gone = await as("max").get("/me");
  assert.equal(gone.status, 401);
  assert.match(gone.json.error, /revoked/);
  writeFileSync(join(f.dir, "people.json"), JSON.stringify({ ...PEOPLE, people: PEOPLE.people.filter((p) => p.email !== "pat@example.com"), teams: [{ name: "Platform", members: ["max@example.com"] }] }));
  const removed = await as("pat").get("/me");
  assert.equal(removed.status, 401);
  assert.match(removed.json.error, /no longer in people.json/);
  assert.equal((await as("ana").get("/me")).status, 200, key.ana);
});

test("anyone may answer a gate the lifecycle names no approvers for", async (t) => {
  const { f, as } = await withPeople(t);
  const id = (await as("max").post("/builds", { does: "Count the words." })).json.build.id;
  await f.settled(id);
  const b = (await as("max").get(`/builds/${id}`)).json.build;
  assert.ok(actionNames(b).includes("approve"));
  assert.deepEqual(stageOf(b, "requirements").gate, { you_may_answer: true, who: [], words: "Anyone may answer this gate: the lifecycle names no approvers for it." });
  assert.equal((await as("max").post(`/builds/${id}/actions/approve`)).status, 200);
});

test("a gate's approvers by person: only they answer; anyone else sees who may, and is refused in words", async (t) => {
  const doc = { version: "0.1", organization: { approvers: { requirements: [{ person: "ana@example.com" }] } } };
  const { f, as } = await withPeople(t, doc);
  const id = (await as("max").post("/builds", { does: "Count the words." })).json.build.id;
  await f.settled(id);

  for (const who of ["max", "pat", "ada"]) {
    const b = (await as(who).get(`/builds/${id}`)).json.build;
    assert.deepEqual(actionNames(b), ["stop"], who);
    assert.deepEqual(validate("BuildAnswer", { build: b }), [], who);
    const g = stageOf(b, "requirements").gate;
    assert.equal(g.you_may_answer, false);
    assert.deepEqual(g.who, ["Ana Lee (ana@example.com)"]);
    assert.equal(g.words, "Only Ana Lee (ana@example.com) may answer the Requirements gate.");
    const no = await as(who).post(`/builds/${id}/actions/approve`);
    assert.equal(no.status, 403);
    assert.match(no.json.error, /^Only Ana Lee \(ana@example.com\) may answer the Requirements gate\. You are signed in as /);
    assert.equal((await as(who).post(`/builds/${id}/actions/changes`, { changes: "Shorter." })).status, 403);
  }
  // Stopping is not a gate: a member may still stop a build, which the next test does not need.
  const ana = (await as("ana").get(`/builds/${id}`)).json.build;
  assert.deepEqual(actionNames(ana), ["approve", "changes", "stop"]);
  assert.equal(stageOf(ana, "requirements").gate.you_may_answer, true);
  const yes = await as("ana").post(`/builds/${id}/actions/approve`);
  assert.equal(yes.status, 200);
  assert.match(JSON.stringify(f.store.read(id).run), /"approved"[^}]*ana@example.com|ana@example.com[^}]*"approved"/);
  // What the build folder asks next names nobody, so anyone may answer it.
  await f.settled(id);
  assert.ok(actionNames((await as("max").get(`/builds/${id}`)).json.build).includes("changes"));
});

test("a gate's approvers by team: an approver in the team answers, a member in it does not", async (t) => {
  const doc = { version: "0.1", organization: { approvers: { requirements: [{ team: "Platform" }] } }, projects: { web: { approvers: { requirements: [{ person: "ana@example.com" }] } } } };
  const { f, as } = await withPeople(t, doc);
  const id = (await as("max").post("/builds", { does: "Count the words." })).json.build.id;
  await f.settled(id);
  const max = (await as("max").get(`/builds/${id}`)).json.build;
  assert.equal(stageOf(max, "requirements").gate.words, "Only an approver in the team Platform may answer the Requirements gate.");
  assert.equal((await as("max").post(`/builds/${id}/actions/approve`)).status, 403);
  assert.equal((await as("ana").post(`/builds/${id}/actions/approve`)).status, 403);
  assert.equal((await as("pat").post(`/builds/${id}/actions/approve`)).status, 200);

  // A project's list replaces the organization's for that stage.
  const web = (await as("max").post("/builds", { does: "Count the words.", project: "web" })).json.build.id;
  await f.settled(web);
  assert.equal((await as("pat").post(`/builds/${web}/actions/approve`)).status, 403);
  assert.equal((await as("ana").post(`/builds/${web}/actions/approve`)).status, 200);
});

test("approvers stay in the lifecycle file when the lifecycle is changed, and wrong ones are named in words", async (t) => {
  // Names the schema cannot check (people.json's) are named by this service; the file stays valid.
  const doc = {
    version: "0.1",
    organization: { approvers: { requirements: [{ team: "Platform" }, { person: "max@example.com" }, { person: "zed@example.com" }, { team: "Design" }] } },
    projects: { web: { approvers: { code: [{ person: "ana@example.com" }] } } },
  };
  const { f } = await withPeople(t, doc);
  assert.equal((await f.put("/stages/docs?project=web", { used: false })).status, 200);
  assert.equal((await f.put("/stages/eval", { used: false })).status, 200);
  const kept = JSON.parse(readFileSync(f.lifecycle.file, "utf8"));
  assert.deepEqual(kept.organization.approvers, doc.organization.approvers);
  assert.deepEqual(kept.projects.web.approvers, doc.projects.web.approvers);
  assert.equal(kept.projects.web.used.docs, false);
  assert.equal(kept.organization.used.eval, false);

  const people = (await f.get("/people")).json;
  assert.equal(people.organization, "Example Org");
  assert.deepEqual(people.people.find((p) => p.email === "pat@example.com"), { name: "Pat Park", email: "pat@example.com", role: "approver", teams: ["Platform"], has_key: true });
  assert.deepEqual(people.projects, [{ name: "web", teams: ["Platform"] }]);
  const said = people.problems.join("\n");
  assert.match(said, /organization.approvers.requirements names max@example.com, a member/);
  assert.match(said, /names zed@example.com, who is not in people.json/);
  assert.match(said, /names the team Design, which is not in people.json/);
  assert.ok(!JSON.stringify(people).includes("pf_"), "no key is ever listed");
  assert.equal(await createLifecycle({ path: f.lifecycle.file }).check(), null);
  assert.equal(readApprovers(kept, readPeople(PEOPLE).doc).org.requirements.length, 4);
});

test("an approver entry the schema does not allow makes the lifecycle file invalid, named in words", async (t) => {
  // The lifecycle document schema says what an approver is, so a wrong one is a wrong file,
  // as the console treats every other wrong field: the lifecycle routes answer 409 with the problem.
  const doc = { version: "0.1", organization: { approvers: { requirements: [{ team: "Platform" }, { who: "x" }] } } };
  const { f } = await withPeople(t, doc);
  const put = await f.put("/stages/docs", { used: false });
  assert.equal(put.status, 409);
  assert.match(put.json.error, /not a valid lifecycle document: organization\.approvers\.requirements\[1\] has "who"/);
  assert.equal((await f.get("/stages")).status, 409);
  assert.match(await createLifecycle({ path: f.lifecycle.file }).check(), /approvers\.requirements\[1\]/);
  // The file is left as it was, this service names the entry too, and no build starts under it.
  assert.deepEqual(JSON.parse(readFileSync(f.lifecycle.file, "utf8")), doc);
  assert.match((await f.get("/people")).json.problems.join("\n"), /requirements\[1\] is one person/);
  assert.equal((await f.post("/builds", { does: "Count the words." })).status, 409);
});
