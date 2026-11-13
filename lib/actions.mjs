// The when-needed actions (stages.json cadence "when_needed", lifecycle API
// 0.4.4): actions on a product, run when something happens, not build steps.
//
//   Impact        the reference impact analyst (CommonAgent/adlc agents/impact-analyst)
//                 compares the running version with a changed one, the way
//                 adapters.mjs runs every reference agent, and hands back its report
//   Rollback      the runtime's rollback verb, with the earlier version's own
//                 package and run plan (runtime.mjs runVerb)
//   Reconfigure   the setup chosen now, handed to the runtime as a new run plan
//                 for the same version (the reconfigure verb)
//   Retract       handed to whoever holds the Publisher role; with nobody, or
//                 with the reference publisher (which does not retract yet), a
//                 manual step the person confirms, and the record is kept
//   Decommission  the runtime's retire verb; every record is kept, and the
//                 product is marked retired
//   Reverse engineering (stages.json 1.4.0, lifecycle API 0.4.6)
//                 on drift: the code of a product started from existing code
//                 changed outside the lifecycle, seen when the codebase's commit
//                 now differs from the last one any build knew (source). It
//                 starts the next version from existing code with the last
//                 as-built record (runner.mjs startDrift), so the reverse
//                 engineer describes only what changed, and each changed
//                 behavior goes to Requirements as a proposed feature marked
//                 as built. Its record is kept on the build that knew the commit.
//
// Each is offered on the product's when_needed list (GET /products/:name)
// with a confirm card: who may act (the lifecycle's approvers for the stage,
// as people.mjs reads them), what will happen in the stage's own words, and
// for Rollback the version it goes back to and what cannot be undone. It is
// taken with the actions operation, POST /builds/{build}/actions/{stage},
// on the build the list names. Its result is kept on that build as the
// stage's record (so it is in the product's activity feed) and as the item's
// `last`. One that cannot run says why in words.
//
// Which version runs is read from the builds: the newest whose Deploy is done
// and that was not rolled back or retired (productState).

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { stageById } from "./standards.mjs";
import { WHEN_NEEDED_STAGES, settingsFor } from "./cadence.mjs";
import { runPlan, runVerb, PLAN_STAGES } from "./runtime.mjs";
import { reviewer, reverseEngineerMissing } from "./adapters.mjs";
import { currentCommit, short } from "./adopt.mjs";
import { buildsOf } from "./products.mjs";
import { Refused } from "./lifecycle.mjs";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const words = (v) => (typeof v === "string" ? v.trim() : "");
const rel = (base, at) => relative(base, at).split(sep).join("/");
const stageName = (id) => stageById.get(id)?.name ?? id;
const either = (list) => (list.length <= 1 ? list.join("") : `${list.slice(0, -1).join(", ")} or ${list.at(-1)}`);
const articled = (role) => (role === "admin" || role === "approver" ? `an ${role}` : `a ${role}`);
const sentence = (s) => { const t = words(s); return t && !/[.!?]$/.test(t) ? `${t}.` : t; };
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export const LABEL = { "reverse-engineering": "Reverse engineer the change", impact: "Check the impact", retract: "Retract", reconfigure: "Reconfigure", rollback: "Roll back", decommission: "Decommission" };
const VERB = { "reverse-engineering": "reverse engineer", impact: "check the impact on", retract: "retract", reconfigure: "reconfigure", rollback: "roll back", decommission: "decommission" };

/** The next patch version after the newest of a product's versions, not taken yet. */
export function nextVersion(builds) {
  const taken = new Set(builds.map((b) => b.version));
  const m = /^(d+).(d+).(d+)/.exec(builds[0]?.version ?? "0.1.0") ?? [null, "0", "1", "0"];
  let patch = Number(m[3]) + 1;
  while (taken.has(`${m[1]}.${m[2]}.${patch}`)) patch += 1;
  return `${m[1]}.${m[2]}.${patch}`;
}
const ANALYST = { agent: "impact-analyst", script: "analyze.mjs" };
const DESCRIPTOR = "requirements/agent-descriptor.json";
const REQUIREMENTS = "requirements/agent-runtime-requirements.json";
const T = { descriptor: "application/vnd.agentmesh.agent-descriptor+json", dependents: "application/vnd.agentmesh.dependents+json", runtime: "application/vnd.agentmesh.agent-runtime-requirements+json" };

const deployed = (b) => b?.stages?.deploy?.state === "done";

/**
 * Which version of a product runs: { running, retired, deployed }. builds:
 * the product's builds, newest first. running: the newest deployed build that
 * was not rolled back or retired, or null. retired: the decommission record
 * when nothing runs because the product was retired.
 */
export function productState(builds) {
  const dep = builds.filter(deployed);
  const running = dep.find((b) => !b.rolled_back && !b.retired) ?? null;
  const retired = !running ? dep.find((b) => b.retired)?.retired ?? null : null;
  return { running, retired, deployed: dep };
}

/** The product answer's running and retired fields (0.4.4). */
export function stateFields(builds) {
  const { running, retired } = productState(builds);
  const out = {
    running: running ? { build: running.id, version: running.version, words: running.rolled_back_to ? `${running.version} runs again: rolled back from ${running.rolled_back_to.from}` : `${running.version} runs` } : null,
  };
  if (retired) out.retired = retired;
  return out;
}

/** A setup choice in words, for the confirm card of Reconfigure. */
function choiceWords(e) {
  if (!e?.used) return "not used";
  if (!e.chosen) return "nobody chosen";
  const s = Object.entries(isObj(e.settings) ? e.settings : {}).map(([k, v]) => `${k.replace(/_/g, " ")}: ${isObj(v) || Array.isArray(v) ? JSON.stringify(v) : v}`).join("; ");
  return `${e.holder?.name ?? "someone"}${s ? ` (${s})` : ""}`;
}
const sameEntry = (a, b) => JSON.stringify([a?.used, a?.chosen, a?.holder ?? null, a?.settings ?? {}]) === JSON.stringify([b?.used, b?.chosen, b?.holder ?? null, b?.settings ?? {}]);

export function createActions({ store, config = null, lifecycle, access, env = process.env, now = () => new Date().toISOString(), startDrift = null }) {
  const busy = new Set();
  // A repository's newest commit is read over the network, so it is kept a few seconds; a folder is read each time.
  const remote = new Map();

  /**
   * The product's codebase and the last commit any of its builds knew, and
   * whether the code moved since (ProductAnswer.source, 0.4.6), or null when
   * no build knew a codebase. builds: newest first.
   */
  async function sourceOf(builds) {
    const knew = builds.filter((b) => b.source?.commit).sort((a, b) => String(b.created).localeCompare(String(a.created)))[0];
    if (!knew) return null;
    const s = knew.source;
    let cur;
    if (s.folder) cur = await currentCommit(s, { env });
    else {
      const kept = remote.get(s.repository);
      if (kept && Date.now() - kept.t < 15_000) cur = kept.v;
      else { cur = await currentCommit(s, { env }); remote.set(s.repository, { t: Date.now(), v: cur }); }
    }
    const base = { repository: s.shown, commit: s.commit, build: knew.id, version: knew.version };
    if (!cur.ok) return { ...base, current: null, drift: false, words: `${s.shown} could not be read now: ${cur.reason} The last build that knew it, ${knew.version}, knew ${short(s.commit)}.` };
    const drift = cur.commit !== s.commit;
    return {
      ...base, current: cur.commit, drift,
      words: drift
        ? `The code changed outside the lifecycle: ${s.shown} is at ${short(cur.commit)}, and the last build that knew it, ${knew.version}, knew ${short(s.commit)}.`
        : `${s.shown} is at ${short(s.commit)}, the commit ${knew.version} knew, so the code has not changed outside the lifecycle.`,
    };
  }
  const fileOf = (r, path) => {
    const all = Object.values(r.stages ?? {}).flatMap((s) => s.handed_back?.files ?? []);
    // The agent's own file shown at Architecture and Design (design/) stands for the one Requirements drafted.
    const f = all.find((x) => x.path === path.replace(/^requirements\//, "design/")) ?? all.find((x) => x.path === path);
    return f ? store.fileIn(r.id, f.at) : null;
  };
  /** The package and the run plan a deployed build handed to the runtime. */
  const filesOf = (r) => {
    const archive = r.stages?.package?.handed_back.files.find((f) => f.path.endsWith(".tar.gz"));
    return { packagePath: archive ? store.fileIn(r.id, archive.at) : null, planPath: r.plan?.at ? store.fileIn(r.id, r.plan.at) : null };
  };
  const analystMissing = () => {
    if (!config?.adlc) return "This service was started without its settings, so it does not know where the reference impact analyst is.";
    return existsSync(join(config.adlc, "agents", ANALYST.agent, "scripts", ANALYST.script)) ? null
      : `The reference impact analyst is not in the adlc checkout at ${config.adlc} (agents/${ANALYST.agent}/scripts/${ANALYST.script} is missing). Set "adlc" in product-factory.json to a checkout of CommonAgent/adlc.`;
  };

  /** Who may take a when-needed action: { yes, words }, from the lifecycle's approvers for its stage. */
  function mayAct(who, stage, project, product) {
    const g = access.gate(who, stage, project);
    if (!g.who.length) return { yes: true, words: `Anyone may ${VERB[stage]} ${product}: the lifecycle names no approvers for ${stageName(stage)}.` };
    return { yes: g.yes, words: g.yes ? `You may ${VERB[stage]} ${product}. The lifecycle names ${either(g.who)}.` : `Only ${either(g.who)} may ${VERB[stage]} ${product}.` };
  }

  /** The newest record of a stage kept on the product's builds, as the item's last. */
  function lastOf(builds, stage) {
    let best = null;
    for (const b of builds) {
      for (const x of b.when_needed ?? []) if (x.stage === stage && (!best || x.at > best.at)) best = { ...x, build: b.id };
    }
    if (!best) return null;
    const out = { at: best.at, by: best.by, ok: best.ok, words: best.words, version: best.version, build: best.build };
    if (best.files?.length) out.files = best.files.map((f) => ({ path: f.path, size: f.size ?? 0, link: `/v1/lifecycle/builds/${encodeURIComponent(best.build)}/files?path=${encodeURIComponent(f.path)}` }));
    return out;
  }

  /** The plan the setup chosen now makes for a running build. */
  const planNow = (r, current, at) => runPlan({ ...r, lifecycle: { ...current, at } }, { pkg: basename(filesOf(r).packagePath ?? "package.tar.gz"), at });

  /** The cards a person reads before each action, and whether it can run: one per when-needed stage, in order. src: sourceOf(builds). */
  function plan(builds, current, who, src = null) {
    const name = builds[0]?.name ?? "";
    const project = builds[0]?.lifecycle?.project ?? null;
    const { running, retired, deployed: dep } = productState(builds);
    const rt = config?.runtime ?? null;
    const noRuntime = "No runtime is set, so there is nothing for Product Factory to ask. Name your runtime's command in product-factory.json under runtime.command.";
    const notRunning = (what) => `Nothing of ${name} is running yet, so there is nothing to ${what}. A version runs once its Deploy is done.`;

    return WHEN_NEEDED_STAGES.map((stage) => {
      const d = stageById.get(stage);
      const base = { stage, name: d.name };
      const off = (why) => {
        const out = { ...base, can_run: false, why_not: why };
        const last = lastOf(builds, stage);
        if (last) out.last = last;
        return out;
      };
      if (current?.used?.[stage]?.used === false) return off(`This product's lifecycle leaves ${d.name} out.`);
      if (retired) return off(`${name} is decommissioned: nothing of it is running, and its records are kept.`);

      // What each action needs, and what its card says.
      let build = running;
      let card = null;
      let needs = [];
      if (stage === "reverse-engineering") {
        if (!src) return off(`No build of ${name} knew a codebase. Reverse engineering runs on existing code: start a build from it (New build, Start from existing code), and it can run here again when that code changes outside the lifecycle.`);
        if (!src.drift) return off(`${src.words}${src.current ? " Reverse engineering runs when they differ." : ""}`);
        const going = builds.find((b) => b.at !== "deploy" && ["working", "waiting", "refused"].includes(b.status));
        if (going) return off(`${src.words} ${name} ${going.version} is still being built, at ${stageName(going.at)}. Finish or stop it, then reverse engineer the change.`);
        const missing = config?.adlc ? reverseEngineerMissing(config.adlc) : "This service was started without its settings, so it does not know where the reference reverse engineer is.";
        if (missing) return off(missing);
        const prev = builds.find((b) => b.id === src.build);
        const to = nextVersion(builds);
        build = prev;
        card = {
          title: `Reverse engineer what changed in ${name}?`,
          steps: [
            src.words,
            `A new version, ${to}, starts from the code at ${short(src.current)}. Reverse engineering is given the last as-built record (${prev.version}, at ${short(src.commit)}), so the reverse engineer describes only what changed.`,
            "Each changed behavior goes to Requirements as a proposed feature marked as built, for you to approve, call a bug, or drop. Test then pins what you approved, and Code adopts the code as it is now.",
          ],
          from_version: prev.version, to_version: to, cannot_undo: [],
        };
      } else if (stage === "impact") {
        if (!running) return off(notRunning("check a change against"));
        // The changed version is a newer one than runs: the newest build started after it with its declaration.
        const changed = builds.find((b) => b.id !== running.id && b.version !== running.version && String(b.created) > String(running.created) && fileOf(b, DESCRIPTOR));
        if (!changed) return off(`${name} ${running.version} runs, and no newer version has its declaration yet. Start a new version: once its agent-descriptor.json is made, Impact compares the two.`);
        if (!fileOf(running, DESCRIPTOR)) return off(`${name} ${running.version}'s declaration is not in its build folder, so there is nothing to compare against.`);
        const missing = analystMissing();
        if (missing) return off(missing);
        build = changed;
        card = {
          title: `Check the impact of ${name} ${changed.version}?`,
          steps: [
            `The reference impact analyst compares ${running.version}, which runs, with ${changed.version}, and answers each dependent compatible, breaking or a change of behavior.`,
            `Product Factory keeps no list of what depends on ${name}, so the analyst is given an empty one and the report says so under Not read.`,
            "It changes nothing and approves nothing: the report is for you to decide from.",
          ],
          from_version: running.version, to_version: changed.version, cannot_undo: [],
        };
      } else if (stage === "rollback") {
        if (!rt) return off(noRuntime);
        if (!running) return off(notRunning("roll back"));
        const earlier = dep.filter((b) => b.id !== running.id && !b.rolled_back && !b.retired && b.version !== running.version && String(b.created) < String(running.created));
        if (!earlier.length) return off(`${name} ${running.version} is the only version installed, so there is no earlier version to roll back to.`);
        const to = earlier[0];
        const plans = (b) => b.plan?.stages ?? [];
        const changedSetup = PLAN_STAGES.filter((s) => s !== "deploy" && !sameEntry(plans(running).find((e) => e.stage === s), plans(to).find((e) => e.stage === s))).map(stageName);
        card = {
          title: `Roll back ${name} to ${to.version}?`,
          steps: [
            `Your runtime puts ${name} back on ${to.version}, with ${to.version}'s own package and run plan.`,
            `${running.version} is marked rolled back. Its build and every record of it are kept.`,
            ...(changedSetup.length ? [] : [`${to.version} was set up the same way as ${running.version}, so no setup choice changes.`]),
          ],
          from_version: running.version, to_version: to.version,
          cannot_undo: [
            `What ${name} ${running.version} did while it ran stays done: messages it sent, records it wrote and calls it made are not taken back.`,
            ...(changedSetup.length ? [`${to.version}'s run plan comes back with it, so ${either(changedSetup)} go${changedSetup.length === 1 ? "es" : ""} back to how ${changedSetup.length === 1 ? "it was" : "they were"} set up at ${to.version}, until you reconfigure.`] : []),
            `Whatever was built on what ${running.version} added stops working the way it expects.`,
          ],
        };
        needs = [
          { name: "to_version", label: "Go back to", kind: "choice", options: earlier.map((b) => b.version), default: to.version },
          { name: "why", label: "Why", kind: "words" },
        ];
      } else if (stage === "reconfigure") {
        if (!rt) return off(noRuntime);
        if (!running) return off(notRunning("reconfigure"));
        if (!running.plan?.stages) return off(`${name} ${running.version} has no run plan kept, so there is nothing to change.`);
        const next = planNow(running, current, now());
        const changes = next.stages.filter((e) => e.stage !== "deploy").filter((e) => !sameEntry(running.plan.stages.find((x) => x.stage === e.stage), e))
          .map((e) => ({ stage: e.stage, name: e.name, from: choiceWords(running.plan.stages.find((x) => x.stage === e.stage)), to: choiceWords(e) }));
        if (!changes.length) return off(`Nothing to reconfigure: the setup chosen now is the same as the run plan ${name} ${running.version} runs with. Change a setup item first.`);
        card = {
          title: `Reconfigure ${name} ${running.version}?`,
          steps: [`Your runtime gets a new run plan for ${name} ${running.version}: the same version, with the setup chosen now.`],
          from_version: running.version, changes, cannot_undo: [],
        };
        needs = [{ name: "why", label: "Why", kind: "words", optional: true }];
      } else if (stage === "retract") {
        if (!running) return off(notRunning("take down"));
        if (running.retracted) return off(`${name} ${running.version} was retracted ${running.retracted.at}. ${running.retracted.words}`);
        const h = current?.holders?.publisher ?? null;
        const where = words(settingsFor(h, "publish").listed_in) || "where it was listed";
        const by = isObj(h) && h.kind !== "reference_agent" ? h : null;
        card = {
          title: `Retract ${name} ${running.version}?`,
          steps: by
            ? [`It is handed to ${by.name}, who holds the Publisher role, to take ${name} ${running.version} down from ${where}.`, "Product Factory cannot read the address back, so the record says it was handed over, and whether it reads empty is theirs to confirm."]
            : [`${isObj(h) ? "The reference publisher does not retract yet" : "Nobody holds the Publisher role"}, so this is a manual step: take ${name} ${running.version} down from ${where}, then confirm here.`, "Product Factory records who took it down, when and why."],
          from_version: running.version, cannot_undo: ["Anyone who already copied it keeps their copy."],
        };
        needs = [{ name: "why", label: "Why it comes down", kind: "words" }];
      } else if (stage === "decommission") {
        if (!rt) return off(noRuntime);
        if (!running) return off(notRunning("retire"));
        card = {
          title: `Decommission ${name}?`,
          steps: [
            `Your runtime retires ${name} ${running.version}: it removes the install and keeps a record.`,
            "Every build of it, and every file and record, stays in Product Factory.",
            `${name} is marked retired, and its when-needed actions turn off.`,
          ],
          from_version: running.version,
          cannot_undo: [`${name} stops answering: work sent to it after this is refused.`, "Its address is retired and never reused.", "Bringing it back means building and deploying it again."],
        };
        needs = [{ name: "why", label: "Why", kind: "words" }];
      }
      const may = mayAct(who, stage, project, name);
      const out = {
        ...base, can_run: true,
        action: { build: build.id, name: stage, label: LABEL[stage], needs },
        confirm: { ...card, will: sentence(cap(d.hands_back)), done_when: sentence(cap(d.done_when)), who_may: may.words, you_may: may.yes },
      };
      const last = lastOf(builds, stage);
      if (last) out.last = last;
      return out;
    });
  }

  /** The product's when-needed list as this person sees it. builds: newest first. src: sourceOf(builds). */
  const list = (builds, current, who, src = null) => plan(builds, current, who, src);

  // ---------- running one ----------

  const recordOn = (b, stage) => (b.stages[stage] ??= { state: "not_started", holder: null, runs: 0, rounds: [], given: "", handed_back: { words: [], files: [] }, done_when_met: null, log: [] });
  const say = (list, said) => list.push({ at: now(), said });

  /** Keeps one action's outcome on the build it ran on: the stage's record, the build's log, and the item's last. */
  async function keep(id, stage, { ok, words: w, by, holder, given, files = [], extra = [], change = null, log = null }) {
    return store.update(id, (b) => {
      const s = recordOn(b, stage);
      s.runs += 1;
      s.holder = holder;
      s.given = given;
      s.state = ok ? "done" : "refused";
      s.done_when_met = ok ? null : false;
      s.rounds.push({ n: s.runs, at: now(), label: `${LABEL[stage]} ${s.runs}`, verdict: ok ? "Done" : "Refused", back: !ok, words: [w, ...extra].join(" ") });
      s.handed_back = { words: [w, ...extra], files };
      say(s.log, log ?? w);
      say(b.log, `${LABEL[stage]}: ${log ?? w}`);
      (b.when_needed ??= []).push({ stage, at: now(), by, ok, words: [w, ...extra].join(" "), version: b.version, files: files.map((f) => ({ path: f.path, size: f.size ?? 0 })) });
      change?.(b);
    });
  }

  /**
   * Takes a when-needed action on build id (POST /builds/{id}/actions/{stage}).
   * Refuses 409 when it is not offered on that build now, 403 when this person
   * may not take it, 400 when a need is missing. A runtime that refuses is kept
   * on the record and answered 409 with its words. Resolves to the result:
   * { stage, ok, words, files, report? }.
   */
  async function run(id, stage, needs = {}, who) {
    const r = store.read(id);
    if (!r) throw new Refused(404, "There is no build with that id.");
    const builds = buildsOf(store.list(), r.name);
    const current = await lifecycle.snapshot(builds[0]?.lifecycle?.project ?? undefined);
    const item = plan(builds, current, who, stage === "reverse-engineering" ? await sourceOf(builds) : null).find((x) => x.stage === stage);
    const refuse = (status, why) => { const e = new Refused(status, why); e.build = store.read(id); return e; };
    if (!item?.can_run) throw refuse(409, `That action is not offered now. ${item?.why_not ?? ""}`.trim());
    if (item.action.build !== id) throw refuse(409, `${item.name} runs on ${r.name} ${builds.find((b) => b.id === item.action.build)?.version ?? item.action.build}, not on ${r.version}.`);
    if (!item.confirm.you_may) throw refuse(403, `${item.confirm.who_may} You are signed in as ${who.name}${who.email !== who.name ? ` (${who.email})` : ""}, ${articled(who.role)}.`);
    const why = words(needs?.why);
    for (const n of item.action.needs) if (!n.optional && n.kind === "words" && !words(needs?.[n.name])) throw refuse(400, `Say ${n.label.toLowerCase()}.`);
    if (busy.has(r.name)) throw refuse(409, `Another action on ${r.name} is running. Wait for it to finish.`);
    busy.add(r.name);
    try {
      const by = who.email;
      const rt = config?.runtime ?? null;
      const dir = store.folder(id);
      const roundDir = (n) => join(dir, "stages", stage, `r${n}`);
      const nextRound = () => (r.stages[stage]?.runs ?? 0) + 1;
      const n = nextRound();
      const why2 = why ? ` Why: ${sentence(why)}` : "";
      const runtimeHolder = { kind: "outside_tool", name: `your runtime (${rt?.command.slice(0, 2).join(" ") ?? ""})`, role: "deployment-manager" };

      if (stage === "rollback") {
        const toVersion = words(needs?.to_version) || item.action.needs[0].default;
        if (!item.action.needs[0].options.includes(toVersion)) throw refuse(400, `${r.name} cannot roll back to ${toVersion}. It can go back to ${either(item.action.needs[0].options)}.`);
        const to = builds.find((b) => b.version === toVersion && deployed(b));
        const { packagePath, planPath } = filesOf(to);
        if (!packagePath || !planPath) throw refuse(409, `${r.name} ${to.version}'s package or run plan is no longer in its build folder, so there is nothing to hand back to your runtime.`);
        const res = await runVerb({ verb: "rollback", command: rt.command, cwd: rt.cwd, packagePath, planPath, env, log: join(roundDir(n), "run.log"), product: r.name, version: to.version, from: r.version });
        const cannot = [...item.confirm.cannot_undo, ...(res.cannot_undo ?? [])];
        const known = res.verb_known ? "" : ` Your runtime did not say it knows rollback, so it took ${to.version}'s package as an install; check that ${to.version} is the one answering.`;
        const given = `${r.name} running ${r.version}, and ${to.version}, the version before.`;
        if (!res.ok) {
          await keep(id, stage, { ok: false, words: res.words, by, holder: runtimeHolder, given, log: `The rollback to ${to.version} was refused: ${res.words}` });
          throw refuse(409, res.words);
        }
        const w = `${r.name} is back on ${to.version}.${why2} ${res.words}${known}`.replace(/\s+/g, " ").trim();
        await keep(id, stage, {
          ok: true, words: w, by, holder: runtimeHolder, given, extra: cannot.length ? [`What can't be undone: ${cannot.join(" ")}`] : [],
          log: `Rolled back from ${r.version} to ${to.version}.${why2}`,
          change: (b) => { b.rolled_back = { at: now(), by, to: to.version, why }; },
        });
        await store.update(to.id, (b) => {
          b.rolled_back_to = { at: now(), from: r.version };
          delete b.rolled_back;
          say(b.log, `${to.version} runs again: ${r.name} was rolled back from ${r.version}.`);
        });
        return { stage, ok: true, words: w, cannot_undo: cannot, files: [] };
      }

      if (stage === "reconfigure") {
        const at = now();
        const next = planNow(r, current, at);
        const { packagePath } = filesOf(r);
        if (!packagePath) throw refuse(409, `${r.name} ${r.version}'s package is no longer in its build folder, so the new run plan cannot go with it.`);
        const folder = roundDir(n);
        mkdirSync(folder, { recursive: true });
        const planPath = join(folder, "run-plan.json");
        writeFileSync(planPath, `${JSON.stringify(next, null, 2)}\n`);
        const res = await runVerb({ verb: "reconfigure", command: rt.command, cwd: rt.cwd, packagePath, planPath, env, log: join(folder, "run.log"), product: r.name, version: r.version, from: r.version });
        const changes = item.confirm.changes.map((c) => `${c.name}: ${c.from} → ${c.to}`).join("; ");
        const given = `${r.name} ${r.version}, and the change: ${changes}.`;
        if (!res.ok) {
          await keep(id, stage, { ok: false, words: res.words, by, holder: runtimeHolder, given, log: `The new run plan was refused: ${res.words}` });
          throw refuse(409, res.words);
        }
        const known = res.verb_known ? "" : " Your runtime did not say it knows reconfigure, so it took the package again with the new run plan as an install.";
        const w = `${r.name} ${r.version} runs with the new run plan. ${changes}.${why2} ${res.words}${known}`.replace(/\s+/g, " ").trim();
        // The new plan becomes the build's run plan, beside the package; the one before is kept in the round.
        const official = r.plan?.at ? store.fileIn(id, r.plan.at) : null;
        if (official) { copyFileSync(official, join(folder, "run-plan-before.json")); copyFileSync(planPath, official); }
        const files = [{ path: `reconfigure/r${n}/run-plan.json`, at: rel(dir, planPath) }];
        await keep(id, stage, {
          ok: true, words: w, by, holder: runtimeHolder, given, files, log: `Reconfigured: ${changes}.${why2}`,
          change: (b) => { b.plan = { at: b.plan.at, stages: next.stages }; },
        });
        return { stage, ok: true, words: w, files };
      }

      if (stage === "retract") {
        const h = current?.holders?.publisher ?? null;
        const handed = isObj(h) && h.kind !== "reference_agent";
        const w = handed
          ? `Handed to ${h.name}, who holds the Publisher role, to take ${r.name} ${r.version} down.${why2} Whether the address reads back empty is theirs to confirm.`
          : `${r.name} ${r.version} was taken down by hand, as a manual step${isObj(h) ? " (the reference publisher does not retract yet)" : ""}, and ${who.name} confirmed it.${why2}`;
        const holder = handed ? { kind: h.kind, name: h.name, ...(h.handle ? { handle: h.handle } : {}), role: "publisher" } : { kind: "person", name: who.name, role: "publisher" };
        await keep(id, stage, {
          ok: true, words: w, by, holder, given: `The address ${r.name} ${r.version} went out under.`, log: w,
          change: (b) => { b.retracted = { at: now(), by, why, words: w }; },
        });
        return { stage, ok: true, words: w, files: [] };
      }

      if (stage === "decommission") {
        const { packagePath, planPath } = filesOf(r);
        if (!packagePath || !planPath) throw refuse(409, `${r.name} ${r.version}'s package or run plan is no longer in its build folder, so your runtime cannot be told which install to retire.`);
        const res = await runVerb({ verb: "retire", command: rt.command, cwd: rt.cwd, packagePath, planPath, env, log: join(roundDir(n), "run.log"), product: r.name, version: r.version, from: r.version });
        const given = `The instruction to retire ${r.name}, and ${r.version}, which runs.`;
        const failed = !res.ok ? res.words : !res.verb_known ? `Your runtime does not say it knows retire: it took the package as an install, so ${r.name} ${r.version} is still running there. Retire it there by hand, or give it a runtime that knows retire, then decommission again.` : null;
        if (failed) {
          await keep(id, stage, { ok: false, words: failed, by, holder: runtimeHolder, given, log: `Decommission was not done: ${failed}` });
          throw refuse(409, failed);
        }
        const w = `${r.name} is retired.${why2} ${res.words} Every build and record is kept.`.replace(/\s+/g, " ").trim();
        await keep(id, stage, { ok: true, words: w, by, holder: runtimeHolder, given, log: `Decommissioned ${r.name}.${why2}` });
        const retired = { at: now(), by, version: r.version, why, words: `Decommissioned at ${r.version}.${why2}`.trim() };
        for (const b of builds) await store.update(b.id, (x) => { x.retired = retired; });
        return { stage, ok: true, words: w, files: [] };
      }

      if (stage === "reverse-engineering") {
        if (!startDrift) throw refuse(409, "This service cannot start a build from here.");
        const to = item.confirm.to_version;
        const fresh = await startDrift(r, to, who);
        const w = `Started ${r.name} ${to} from the code as it is now, at Reverse engineering, with the last as-built record (${r.version}). Each changed behavior goes to Requirements, marked as built.`;
        await store.update(id, (b) => {
          say(b.log, `${LABEL[stage]}: ${w}`);
          (b.when_needed ??= []).push({ stage, at: now(), by: who.email, ok: true, words: w, version: b.version, files: [] });
        });
        return { stage, ok: true, words: w, files: [], build: fresh.id };
      }

      if (stage === "impact") {
        const { running } = productState(builds);
        const base = roundDir(n);
        mkdirSync(base, { recursive: true });
        const dependents = join(base, "dependents.json");
        writeFileSync(dependents, `${JSON.stringify({
          subject: { kind: "agent", id: r.name, name: r.name }, view: "owner", window_days: 90, read_at: now(),
          dependents: [], unread: [],
          not_read: [`what depends on ${r.name} outside Product Factory: it keeps no list of dependents`],
        }, null, 2)}\n`);
        const files = [
          { abs: fileOf(running, DESCRIPTOR), media_type: T.descriptor },
          { abs: fileOf(r, DESCRIPTOR), media_type: T.descriptor },
          { abs: dependents, media_type: T.dependents },
          ...[fileOf(running, REQUIREMENTS), fileOf(r, REQUIREMENTS)].every(Boolean) ? [{ abs: fileOf(running, REQUIREMENTS), media_type: T.runtime }, { abs: fileOf(r, REQUIREMENTS), media_type: T.runtime }] : [],
        ];
        const got = await reviewer({ adlc: config.adlc, agent: ANALYST.agent, script: ANALYST.script, base, text: `Check the impact of ${r.name} ${r.version} on what depends on ${running.version}.\n`, files, env, minutes: 5 });
        const holder = { kind: "reference_agent", name: ANALYST.agent, role: "impact-analyst" };
        const given = `The change to ${r.version}, ${running.version}, which runs, and what depends on it (Product Factory keeps no list, so an empty one).`;
        const reportAt = join(base, "job", "out", "impact-report.md");
        if (!got.ok || !existsSync(reportAt)) {
          const w = got.why || got.reply || "The impact analyst handed back no report.";
          await keep(id, stage, { ok: false, words: w, by, holder, given, log: `The impact analyst could not report: ${w}` });
          throw refuse(409, w);
        }
        const report = readFileSync(reportAt, "utf8");
        const handed = [{ path: "impact/impact-report.md", at: rel(dir, reportAt) }];
        const w = got.reply || `The impact analyst compared ${running.version} with ${r.version}.`;
        await keep(id, stage, { ok: true, words: w, by, holder, given, files: handed, log: `The impact analyst compared ${running.version} with ${r.version} and handed back its report.` });
        return { stage, ok: true, words: w, files: handed.map((f) => ({ path: f.path })), report };
      }
      throw refuse(409, "That action is not offered now.");
    } finally {
      busy.delete(r.name);
    }
  }

  return { list, run, source: sourceOf, productState, stateFields, isAction: (name) => WHEN_NEEDED_STAGES.includes(name) };
}
