// The guided setup and the when-needed actions (lifecycle API 0.4.4): each
// setup item's form, saved through the roles operation with each stage's
// settings under its id, picked up by the run plan and carried to later
// versions; and Impact, Rollback, Reconfigure, Retract and Decommission run
// end to end with the reference runtime (runtimes/folder.mjs) and the
// reference impact analyst, behind their confirm cards. Stand-in holders
// only: no test reaches a model or the network.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { factory, stageOf, walk } from "./helpers.mjs";
import { createKeys, KEYS_FILE } from "../lib/people.mjs";
import { holderToSave, withForms } from "../lib/setup.mjs";
import { checkProduct } from "../standards/lifecycle-api-check.mjs";
import { SETUP_STAGES } from "../lib/cadence.mjs";

const FOLDER = join(dirname(fileURLToPath(import.meta.url)), "..", "runtimes", "folder.mjs");
const PEOPLE = {
  organization: "Example Org",
  people: [
    { name: "Ada Admin", email: "ada@example.com", role: "admin" },
    { name: "Ana Lee", email: "ana@example.com", role: "approver" },
    { name: "Max Member", email: "max@example.com", role: "member" },
  ],
  teams: [{ name: "Platform", members: ["ana@example.com"] }],
  projects: [],
};
const runtime = () => ({ command: ["node", FOLDER, "--into", "./installed"] });
const one = (list, stage) => list.find((x) => x.stage === stage);

/** Walks a build of counter through your approval, your OK and the deploy gate. version: null for the first. */
async function deployed(f, version = null, { deploy = true } = {}) {
  const r = await f.runner.start({ does: "Count the words in a passage.", name: "counter" }, undefined, version ? { version } : {});
  await f.settled(r.id);
  // Not deployed: walked as far as the deploy's own approval, so the version's agent's own files are made.
  if (!deploy) return walk(f, r.id, { until: ["deploy"] });
  const b = await walk(f, r.id);
  assert.equal(stageOf(b, "deploy").state, "done", `${b.version} is deployed`);
  return b;
}

/** A Product Factory with people and a key each, and a runtime. */
async function withPeople(t, doc = {}) {
  const f = await factory({ people: PEOPLE, runtime: runtime(), doc: { version: "0.1", organization: doc } });
  t.after(f.close);
  const keys = createKeys(join(f.config.data, KEYS_FILE));
  const key = Object.fromEntries(PEOPLE.people.map((p) => [p.email.split("@")[0], keys.make(p.email)]));
  const as = (who) => ({
    get: (p) => f.call("GET", p, undefined, { auth: key[who] }),
    post: (p, b = {}) => f.call("POST", p, b, { auth: key[who] }),
  });
  return { f, as };
}

const product = async (f, who = null) => {
  const p = (who ? await who.get("/products/counter") : await f.get("/products/counter")).json;
  assert.deepEqual(checkProduct(p, "counter"), []);
  return p;
};
const planIn = (f, folder) => JSON.parse(readFileSync(join(f.dir, "installed", folder, "run-plan.json"), "utf8"));

test("each setup item carries a form with defaults, the question for the boss, and whether its holder is shared", async (t) => {
  const f = await factory({ people: PEOPLE });
  t.after(f.close);
  await deployed(f, null, { deploy: false });
  const p = await product(f);
  assert.deepEqual(p.setup.map((x) => x.stage), SETUP_STAGES);
  const monitor = one(p.setup, "monitor");
  assert.equal(monitor.form.ask, "Who should monitor counter?");
  assert.equal(monitor.form.reference_agent, "watcher");
  assert.deepEqual(monitor.form.fields.map((x) => [x.name, x.kind, x.default]), [["every_minutes", "number", 5], ["alert_after_minutes", "number", 15], ["alert_where", "text", "the console"]]);
  assert.match(monitor.form.shares, /^The watcher holds Monitor and Cost: one holder for both/);
  assert.deepEqual(one(p.setup, "cost").form.fields.map((x) => x.name), ["monthly_ceiling", "warn_at_percent", "at_ceiling"]);
  assert.deepEqual(one(p.setup, "eval").form.fields.map((x) => x.name), ["grades_against", "how_often", "sample"]);
  assert.equal(one(p.setup, "publish").form.ask, "Where should counter be listed?");
  // Who decides is chosen from the organization's people: the product's approvers, its teams, its approvers and admins.
  assert.deepEqual(one(p.setup, "incident").form.fields[0].options, ["an approver of the product", "the Platform team", "Ada Admin", "Ana Lee"]);
  assert.equal(one(p.setup, "update").form.fields[0].name, "approved_by");
  // Nobody holds the agent critic's role, so Eval is to do.
  assert.equal(one(p.setup, "eval").state, "not_chosen");
  // A service without people: who decides is words.
  assert.equal(withForms([{ stage: "incident", role: "incident-recorder" }], { product: "x" })[0].form.fields[0].kind, "text");
});

test("setup choices are saved through the roles operation, each stage under its own id, and the run plan and later versions pick them up", async (t) => {
  const f = await factory({ runtime: runtime() });
  t.after(f.close);
  // Monitor, then Cost: the same role, so the second keeps the first's settings beside its own.
  const watcher = { kind: "your_agent", name: "Our watcher", handle: "watcher.ops@example.com" };
  const MON = { every_minutes: 10, alert_after_minutes: 30, alert_where: "#ops" };
  const COST = { monthly_ceiling: 25, warn_at_percent: 75, at_ceiling: "pause it" };
  assert.equal((await f.put("/roles/watcher", { holder: holderToSave({ stage: "monitor", holder: watcher, values: MON }) })).status, 200);
  const existing = (await f.get("/roles")).json.roles.find((r) => r.role === "watcher").binding.holder;
  assert.equal((await f.put("/roles/watcher", { holder: holderToSave({ stage: "cost", holder: watcher, values: COST, existing }) })).status, 200);
  assert.deepEqual(JSON.parse(readFileSync(f.lifecycle.file, "utf8")).organization.holders.watcher.settings, { monitor: MON, cost: COST });
  const EVAL = { grades_against: "the spec's examples", how_often: "weekly", sample: 10 };
  assert.equal((await f.put("/roles/agent-critic", { holder: holderToSave({ stage: "eval", holder: { kind: "person", name: "Quality team" }, values: EVAL }) })).status, 200);

  const first = await deployed(f);
  let p = await product(f);
  assert.deepEqual([one(p.setup, "monitor").settings, one(p.setup, "cost").settings, one(p.setup, "eval").settings], [MON, COST, EVAL]);
  assert.deepEqual([one(p.setup, "eval").state, one(p.setup, "monitor").words], ["chosen", "Chosen at 0.1.0"]);
  // The run plan hands each stage its own settings, in the package's folder and the install.
  const plan = planIn(f, "counter-0.1.0");
  assert.deepEqual(one(plan.stages, "monitor").settings, MON);
  assert.deepEqual(one(plan.stages, "cost").settings, COST);
  assert.deepEqual([one(plan.stages, "eval").chosen, one(plan.stages, "eval").settings], [true, EVAL]);

  // The next version carries them forward: nothing is asked again.
  const second = await deployed(f, "0.2.0");
  for (const s of ["monitor", "cost", "eval"]) assert.equal(stageOf(second, s).carried.since, first.version, s);
  assert.deepEqual(one(planIn(f, "counter-0.2.0").stages, "monitor").settings, MON);
  p = await product(f);
  assert.deepEqual([one(p.setup, "monitor").words, one(p.setup, "monitor").since], ["Unchanged since 0.1.0", "0.1.0"]);

  // Changing Cost alone leaves Monitor unchanged since 0.1.0.
  const now = (await f.get("/roles")).json.roles.find((r) => r.role === "watcher").binding.holder;
  await f.put("/roles/watcher", { holder: holderToSave({ stage: "cost", holder: watcher, values: { ...COST, monthly_ceiling: 40 }, existing: now }) });
  p = await product(f);
  assert.equal(one(p.setup, "monitor").words, "Unchanged since 0.1.0");
  assert.equal(one(p.setup, "cost").words, "Chosen: it holds from the next version");
});

test("Rollback: the confirm card, a refusal for someone not allowed, then the runtime puts the earlier version back", async (t) => {
  const { f, as } = await withPeople(t, { approvers: { rollback: [{ person: "ana@example.com" }], decommission: [{ team: "Platform" }] } });
  const ana = as("ana");
  const max = as("max");
  const first = await deployed(f);
  const second = await deployed(f, "0.2.0");

  let p = await product(f, max);
  assert.deepEqual(p.running, { build: second.id, version: "0.2.0", words: "0.2.0 runs" });
  // Impact compares a newer version with the one that runs, never an older one.
  assert.equal(one(p.when_needed, "impact").can_run, false);
  const rb = one(p.when_needed, "rollback");
  assert.equal(rb.can_run, true);
  assert.deepEqual(rb.action, { build: second.id, name: "rollback", label: "Roll back", needs: [{ name: "to_version", label: "Go back to", kind: "choice", options: ["0.1.0"], default: "0.1.0" }, { name: "why", label: "Why", kind: "words" }] });
  assert.equal(rb.confirm.title, "Roll back counter to 0.1.0?");
  assert.deepEqual([rb.confirm.from_version, rb.confirm.to_version], ["0.2.0", "0.1.0"]);
  // In the stage's own words, and naming what can't be undone.
  assert.equal(rb.confirm.will, "The agent back on that version, why, and what can't be undone.");
  assert.match(rb.confirm.done_when, /side effects are named/);
  assert.match(rb.confirm.cannot_undo[0], /What counter 0\.2\.0 did while it ran stays done/);
  assert.equal(rb.confirm.cannot_undo.length, 2);
  assert.match(rb.confirm.steps[2], /^0\.1\.0 was set up the same way as 0\.2\.0/);
  // Who may act, as each person sees it.
  assert.deepEqual([rb.confirm.who_may, rb.confirm.you_may], ["Only Ana Lee (ana@example.com) may roll back counter.", false]);
  assert.equal(one((await product(f, ana)).when_needed, "rollback").confirm.you_may, true);

  // Someone not allowed is refused, in words, and nothing changes.
  const no = await max.post(`/builds/${second.id}/actions/rollback`, { to_version: "0.1.0", why: "It miscounts hyphens." });
  assert.equal(no.status, 403);
  assert.equal(no.json.error, "Only Ana Lee (ana@example.com) may roll back counter. You are signed in as Max Member (max@example.com), a member.");
  assert.equal((await product(f)).running.version, "0.2.0");
  // Why is needed; and it runs only on the build the list names.
  assert.equal((await ana.post(`/builds/${second.id}/actions/rollback`, { to_version: "0.1.0" })).json.error, "Say why.");
  assert.equal((await ana.post(`/builds/${first.id}/actions/rollback`, { why: "x" })).status, 409);

  const yes = await ana.post(`/builds/${second.id}/actions/rollback`, { to_version: "0.1.0", why: "It miscounts hyphens." });
  assert.equal(yes.status, 200);
  assert.equal(yes.json.result.ok, true);
  assert.match(yes.json.result.words, /^counter is back on 0\.1\.0\. Why: It miscounts hyphens\. Rolled counter back to 0\.1\.0/);
  assert.ok(yes.json.result.cannot_undo.some((c) => /stays done/.test(c)));
  assert.ok(yes.json.result.cannot_undo.some((c) => /is left in place/.test(c)), "the runtime's own side effects are named too");
  assert.equal(stageOf(yes.json.build, "rollback").state, "done");
  // The runtime's record says 0.1.0 runs.
  const state = JSON.parse(readFileSync(join(f.dir, "installed", "counter.runtime.json"), "utf8"));
  assert.equal(state.current, "0.1.0");
  assert.deepEqual(state.history.map((h) => h.verb), ["install", "install", "rollback"]);

  p = await product(f);
  assert.deepEqual(p.running, { build: first.id, version: "0.1.0", words: "0.1.0 runs again: rolled back from 0.2.0" });
  assert.ok(p.activity.some((e) => e.stage === "rollback" && e.words === "Rolled back from 0.2.0 to 0.1.0. Why: It miscounts hyphens."));
  const after = one(p.when_needed, "rollback");
  assert.equal(after.can_run, false);
  assert.match(after.why_not, /0\.1\.0 is the only version installed/);
  assert.deepEqual([after.last.ok, after.last.version, after.last.by], [true, "0.2.0", "ana@example.com"]);
});

test("Reconfigure hands the runtime a new run plan once a setup item changes; a runtime that refuses is shown in words", async (t) => {
  const f = await factory({ runtime: runtime() });
  t.after(f.close);
  const b = await deployed(f);
  let rc = one((await product(f)).when_needed, "reconfigure");
  assert.equal(rc.can_run, false);
  assert.match(rc.why_not, /^Nothing to reconfigure: the setup chosen now is the same as the run plan counter 0\.1\.0 runs with/);

  const MON = { every_minutes: 1, alert_after_minutes: 5, alert_where: "#ops" };
  await f.put("/roles/watcher", { holder: holderToSave({ stage: "monitor", holder: { kind: "your_agent", name: "Our watcher", handle: "watcher.ops@example.com" }, values: MON }) });
  rc = one((await product(f)).when_needed, "reconfigure");
  assert.equal(rc.can_run, true);
  assert.deepEqual(rc.confirm.changes.map((c) => [c.stage, c.from, c.to]), [
    ["monitor", "watcher", "Our watcher (every minutes: 1; alert after minutes: 5; alert where: #ops)"],
    ["cost", "watcher", "Our watcher"],
  ]);
  assert.equal(rc.confirm.will, "The same agent on the same version, and a signed record of what changed.");

  // A runtime that refuses: the words come back, and the record keeps them.
  const good = f.config.runtime;
  f.config.runtime = { command: ["node", "-e", "console.log(JSON.stringify({ ok: false, said: 'The cluster is read-only today.' })); process.exit(1)"], cwd: f.dir };
  const bad = await f.post(`/builds/${b.id}/actions/reconfigure`, {});
  assert.equal(bad.status, 409);
  assert.equal(bad.json.error, "Your runtime refused the new run plan: The cluster is read-only today.");
  assert.equal(stageOf(bad.json.build, "reconfigure").state, "refused");
  let p = await product(f);
  assert.ok(p.activity.some((e) => e.stage === "reconfigure" && /refused: Your runtime refused the new run plan: The cluster is read-only today\./.test(e.words)));
  assert.equal(one(p.when_needed, "reconfigure").last.ok, false);
  f.config.runtime = good;

  const ok = await f.post(`/builds/${b.id}/actions/reconfigure`, { why: "Check more often." });
  assert.equal(ok.status, 200);
  assert.match(ok.json.result.words, /^counter 0\.1\.0 runs with the new run plan\. Monitor: watcher → Our watcher/);
  // The install's run plan is rewritten; the version is the same.
  assert.deepEqual(one(planIn(f, "counter-0.1.0").stages, "monitor").settings, MON);
  assert.equal(planIn(f, "counter-0.1.0").product.version, "0.1.0");
  // The build's own run plan follows it, and the one before is kept in the round.
  const rec = f.store.read(b.id);
  assert.deepEqual(one(rec.plan.stages, "monitor").settings, MON);
  assert.ok(existsSync(join(f.store.folder(b.id), "stages", "reconfigure", "r2", "run-plan-before.json")));
  p = await product(f);
  assert.equal(one(p.when_needed, "reconfigure").can_run, false);
  assert.ok(p.activity.some((e) => e.stage === "reconfigure" && /^Reconfigured: Monitor/.test(e.words)));
});

test("Retract is a recorded manual step with the reference publisher, and goes to a publisher you chose", async (t) => {
  const f = await factory({ runtime: runtime() });
  t.after(f.close);
  const b = await deployed(f);
  let rt = one((await product(f)).when_needed, "retract");
  assert.equal(rt.can_run, true);
  assert.match(rt.confirm.steps[0], /^The reference publisher does not retract yet, so this is a manual step: take counter 0\.1\.0 down from where it was listed, then confirm here\./);
  assert.equal((await f.post(`/builds/${b.id}/actions/retract`, {})).json.error, "Say why it comes down.");

  // With a publisher of your own, it is handed to them, from where it is listed.
  await f.put("/roles/publisher", { holder: holderToSave({ stage: "publish", holder: { kind: "person", name: "Catalog team" }, values: { listed_in: "the team catalog", visible_to: "our organization" } }) });
  rt = one((await product(f)).when_needed, "retract");
  assert.equal(rt.confirm.steps[0], "It is handed to Catalog team, who holds the Publisher role, to take counter 0.1.0 down from the team catalog.");
  const ok = await f.post(`/builds/${b.id}/actions/retract`, { why: "It was listed by mistake." });
  assert.equal(ok.status, 200);
  assert.match(ok.json.result.words, /^Handed to Catalog team, who holds the Publisher role, to take counter 0\.1\.0 down\. Why: It was listed by mistake\./);
  assert.deepEqual(stageOf(ok.json.build, "retract").holder, { kind: "person", name: "Catalog team", role: "publisher" });
  rt = one((await product(f)).when_needed, "retract");
  assert.equal(rt.can_run, false);
  assert.match(rt.why_not, /^counter 0\.1\.0 was retracted /);
});

test("Decommission retires the install, keeps every record, and marks the product retired; a runtime that does not know retire is not taken as done", async (t) => {
  const { f, as } = await withPeople(t, { approvers: { decommission: [{ team: "Platform" }] } });
  const ana = as("ana");
  const b = await deployed(f);
  let dc = one((await product(f, ana)).when_needed, "decommission");
  assert.deepEqual([dc.can_run, dc.confirm.you_may, dc.confirm.who_may], [true, true, "You may decommission counter. The lifecycle names an approver in the team Platform."]);
  assert.ok(dc.confirm.cannot_undo.includes("Its address is retired and never reused."));
  assert.equal((await as("max").post(`/builds/${b.id}/actions/decommission`, { why: "x" })).status, 403);

  // A runtime that installs whatever it is given and knows no verbs: not retired, said in words.
  const good = f.config.runtime;
  f.config.runtime = { command: ["node", "-e", "console.log(JSON.stringify({ ok: true, said: 'Installed.' }))"], cwd: f.dir };
  const old = await ana.post(`/builds/${b.id}/actions/decommission`, { why: "Replaced by the team counter." });
  assert.equal(old.status, 409);
  assert.match(old.json.error, /^Your runtime does not say it knows retire: it took the package as an install, so counter 0\.1\.0 is still running there\./);
  assert.equal((await product(f)).retired, undefined);
  f.config.runtime = good;

  const yes = await ana.post(`/builds/${b.id}/actions/decommission`, { why: "Replaced by the team counter." });
  assert.equal(yes.status, 200);
  assert.match(yes.json.result.words, /^counter is retired\. Why: Replaced by the team counter\. Retired counter: removed its install/);
  assert.ok(!existsSync(join(f.dir, "installed", "counter-0.1.0")));
  assert.ok(JSON.parse(readFileSync(join(f.dir, "installed", "counter.runtime.json"), "utf8")).retired);
  // Every record is kept.
  assert.ok(f.store.read(b.id));
  assert.equal((await f.get(`/builds/${b.id}`)).status, 200);
  const p = await product(f);
  assert.equal(p.running, null);
  assert.deepEqual([p.retired.version, p.retired.by, p.retired.why], ["0.1.0", "ana@example.com", "Replaced by the team counter."]);
  for (const x of p.when_needed) {
    assert.equal(x.can_run, false, x.stage);
    assert.match(x.why_not, /^counter is decommissioned: nothing of it is running, and its records are kept\.$/);
  }
});

test("Impact runs the reference impact analyst between the running version and a new one, and hands back its report", async (t) => {
  const f = await factory({ runtime: runtime() });
  t.after(f.close);
  const first = await deployed(f);
  let im = one((await product(f)).when_needed, "impact");
  assert.equal(im.can_run, false);
  assert.match(im.why_not, /no newer version has its declaration yet/);

  // Version 0.2.0 has its declaration once its agent's own files are made, before it is deployed.
  const next = await deployed(f, "0.2.0", { deploy: false });
  im = one((await product(f)).when_needed, "impact");
  assert.equal(im.can_run, true);
  assert.deepEqual(im.action, { build: next.id, name: "impact", label: "Check the impact", needs: [] });
  assert.equal(im.confirm.title, "Check the impact of counter 0.2.0?");
  assert.equal(im.confirm.will, "The impact report: each dependent marked compatible, breaking or a change of behavior.");

  const got = await f.post(`/builds/${next.id}/actions/impact`, {});
  assert.equal(got.status, 200, got.json.error);
  assert.match(got.json.result.words, /^I compared counter 0\.1\.0 with 0\.2\.0 against 0 dependents/);
  assert.match(got.json.result.report, /^---\nreport: impact-report-v1\nsubject: "counter"\nrunning: "0\.1\.0"\nchanged: "0\.2\.0"/);
  assert.match(got.json.result.report, /# What changing counter from 0\.1\.0 to 0\.2\.0 touches/);
  assert.match(got.json.result.report, /what depends on counter outside Product Factory: it keeps no list of dependents/);
  // The report is the stage's output, read like any file the build handed back.
  const st = stageOf(got.json.build, "impact");
  assert.deepEqual([st.state, st.holder.name, st.handed_back.files.map((x) => x.path)], ["done", "impact-analyst", ["impact/impact-report.md"]]);
  const file = await f.call("GET", `/builds/${next.id}/files?path=${encodeURIComponent("impact/impact-report.md")}`, undefined, { raw: true });
  assert.equal(file.status, 200);
  assert.match(file.text, /impact-report-v1/);
  const p = await product(f);
  const last = one(p.when_needed, "impact").last;
  assert.deepEqual([last.ok, last.version, last.files[0].path], [true, "0.2.0", "impact/impact-report.md"]);
  assert.ok(p.activity.some((e) => e.stage === "impact" && /compared 0\.1\.0 with 0\.2\.0/.test(e.words)));
  assert.equal(p.running.build, first.id);
});
