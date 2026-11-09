// Run stages handed to a runtime (SPEC 5.9). Product Factory does not run the
// product. The stages after Package are bindings, not work it does: the stage's
// "hands back" line in stages.json is the interface its holder meets, and the
// build's lifecycle (kept when the build started) says who holds each role and
// with what settings. At the end of a build this module:
//
//   1. writes the run plan beside the package: for Deploy and each later stage,
//      the role, the holder, the holder's settings, the interface, and whether
//      the holder is chosen. A stage the lifecycle leaves out reads "not used";
//      a role nobody holds reads "not chosen".
//   2. asks the process document's "approve the deploy" gate: the person reads
//      the package's build record and the run plan, and says yes in the console.
//   3. hands the package and the run plan to the runtime the team brought: the
//      command in product-factory.json under runtime.command, given the two paths
//      as its last two words. Its answer is recorded on Deploy. With no runtime,
//      Deploy waits on the person: "Hand this package to your runtime".
//
// No platform is named here. Any command that takes the two files is a runtime;
// runtimes/folder.mjs, which copies both into a folder, is the reference one.
//
// Runtime verbs (lifecycle API 0.4.4, standards/runtime-verbs.md in
// CommonAgent/adlc). The command is always given a package and a run plan as
// its last two words, so a runtime that knows only install still works. What
// to do with them is in the environment:
//
//   PRODUCT_FACTORY_VERB         install | rollback | reconfigure | retire
//   PRODUCT_FACTORY_PRODUCT      the product's name
//   PRODUCT_FACTORY_VERSION      the version the two files are (rollback: the one to go back to)
//   PRODUCT_FACTORY_FROM_VERSION the version running now (rollback, reconfigure, retire)
//
//   install      the package and its run plan, as at Deploy
//   rollback     the earlier version's own package and run plan: put it back
//   reconfigure  the running version's package with a new run plan: the same
//                version, with the setup chosen now
//   retire       the running version's package and run plan: remove the
//                install, keep a record
//
// A runtime that knows a verb says so with "verb": "<verb>" in its answer. One
// that reads no verb installs what it is given, which for rollback is the
// earlier version and for reconfigure the new run plan, and for retire is the
// running version again, changing nothing; Product Factory then says in words
// that the runtime did not take the verb. A runtime may add "cannot_undo", a
// list of words naming side effects it could not undo.

import { writeFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { stageById, roleById } from "./standards.mjs";
import { run, lastJson, tail } from "./exec.mjs";
import { settingsFor } from "./cadence.mjs";

export const RUN_PLAN_FORMAT = "product-factory-run-plan-v1";
export const RUN_PLAN_FILE = "run-plan.json";

/** The stages after Package the run plan records, in the order of stages.json. */
export const PLAN_STAGES = ["deploy", "publish", "retract", "monitor", "eval", "incident", "cost", "update", "reconfigure", "rollback", "decommission"];

const words = (s) => String(s ?? "").trim();
const rel = (base, at) => relative(base, at).split(sep).join("/");
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const roleName = (id) => roleById.get(id)?.name ?? id;

/** A holder as the run plan names it: who it is, without its settings (they have their own field). */
function holderOnly(h) {
  if (!h) return null;
  const out = { kind: h.kind, name: h.name };
  if (h.handle) out.handle = h.handle;
  return out;
}

/** One stage's entry in the run plan, from the lifecycle the build kept. */
export function planEntry(lifecycle, id) {
  const d = stageById.get(id);
  const role = d.role_ids[0];
  const used = lifecycle.used?.[id]?.used !== false;
  const base = { stage: id, name: d.name, role, role_name: roleName(role), contract: roleById.get(role)?.contract ?? null, interface: d.hands_back };
  if (!used) return { ...base, used: false, chosen: false, reads: "not used", holder: null, settings: {} };
  const h = lifecycle.holders?.[role] ?? null;
  if (!h) return { ...base, used: true, chosen: false, reads: "not chosen", holder: null, settings: {} };
  return { ...base, used: true, chosen: true, reads: "chosen", holder: holderOnly(h), settings: settingsFor(h, id) };
}

/** The run plan document for a packed build. pkg: the package's file name, beside the plan. */
export function runPlan(r, { pkg, at }) {
  return {
    format: RUN_PLAN_FORMAT,
    made: at,
    product: { name: r.name, version: r.version, kind: "agent", build: r.id },
    package: pkg,
    lifecycle: { project: r.lifecycle.project ?? null, at: r.lifecycle.at },
    about: "Product Factory does not run the product. Each stage below is a binding the runtime takes on: its holder, the holder's settings, and the interface the holder meets, which is the stage's \"hands back\" line in stages.json.",
    stages: PLAN_STAGES.map((id) => planEntry(r.lifecycle, id)),
  };
}

const settingsWords = (s) => (Object.keys(s ?? {}).length ? ` Settings: ${JSON.stringify(s)}.` : " No settings.");

/**
 * A stage of the run plan as the lifecycle API shows it, or null when the
 * build has no run plan or the plan does not hold the stage. A chosen holder
 * reads not_started (it is held outside the service, and nothing has come back
 * from it); a role nobody holds reads not_bound.
 */
export function planStageView(r, id) {
  const e = r.plan?.stages?.find((x) => x.stage === id);
  if (!e || !e.used) return null;
  const empty = { runs: 0, rounds: [], handed_back: { words: [], files: [] }, done_when_met: null, log: [], where: null };
  if (!e.chosen) {
    return { stage: id, state: "not_bound", holder: null, ...empty, given: `Not chosen: nobody holds the ${e.role_name} role, so the run plan hands this stage to no one. Its holder would hand back: “${e.interface}”.` };
  }
  return {
    stage: id, state: "not_started",
    holder: { ...e.holder, role: e.role, settings: e.settings },
    ...empty,
    given: `In the run plan handed to your runtime. ${e.holder.name} holds it as ${e.role_name}, and hands back: “${e.interface}”.${settingsWords(e.settings)}`,
  };
}

export const VERBS = ["install", "rollback", "reconfigure", "retire"];
const REFUSED = { install: "refused the package", rollback: "refused the rollback", reconfigure: "refused the new run plan", retire: "refused to retire it" };
const TOOK = { install: "took the package and the run plan", rollback: "took the earlier version back", reconfigure: "took the new run plan", retire: "retired it" };

/**
 * The runtime's answer to one verb: { ok, words, handle, verb_known, cannot_undo }.
 * It runs the command with the two paths as its last words and the verb in the
 * environment (see the top of this file). verb_known: the runtime answered with
 * this verb, so it did what the verb says rather than an install.
 */
export async function runVerb({ verb = "install", command, cwd, packagePath, planPath, env = process.env, signal, log, minutes = 10, product = null, version = null, from = null }) {
  const vEnv = { ...env, PRODUCT_FACTORY_VERB: verb };
  if (product) vEnv.PRODUCT_FACTORY_PRODUCT = product;
  if (version) vEnv.PRODUCT_FACTORY_VERSION = version;
  if (from) vEnv.PRODUCT_FACTORY_FROM_VERSION = from;
  const done = await run([...command, packagePath, planPath], { cwd, env: vEnv, signal, log, timeoutMs: minutes * 60 * 1000 });
  if (done.stopped) return { ok: false, stopped: true, words: "It was stopped." };
  const said = lastJson(done.stdout);
  if (done.error) return { ok: false, words: `Your runtime could not run: ${done.error}.` };
  if (done.timedOut) return { ok: false, words: `Your runtime did not answer within ${minutes} minutes, so it was stopped.` };
  if (done.code !== 0 || said?.ok === false) {
    return { ok: false, words: `Your runtime ${REFUSED[verb] ?? "refused"}: ${words(said?.said) || tail(done.stderr || done.stdout, 600) || `it ended with code ${done.code}`}` };
  }
  const cannot = Array.isArray(said?.cannot_undo) ? said.cannot_undo.map(words).filter(Boolean) : [];
  return { ok: true, words: words(said?.said) || tail(done.stdout, 600) || `Your runtime ${TOOK[verb] ?? "answered"}.`, handle: words(said?.handle) || null, verb_known: said?.verb === verb, cannot_undo: cannot };
}

/** The runtime's answer to the install at Deploy: { ok, words, handle }. */
export const deploy = (o) => runVerb({ ...o, verb: "install" });

export function createRuntime({ store, config, env = process.env, now = () => new Date().toISOString() }) {
  const say = (list, said) => list.push({ at: now(), said });
  const size = (at) => { try { return statSync(at).size; } catch { return 0; } };

  /** Writes the run plan beside a packed build's package: { packagePath, planPath, planAt, plan, files }, or null when it was not packed. */
  function writePlan(r) {
    if (!r || r.stages.package?.state !== "done" || !["package", "deploy"].includes(r.at)) return null;
    const archive = r.stages.package.handed_back.files.find((f) => f.path.endsWith(".tar.gz"));
    const packagePath = archive ? store.fileIn(r.id, archive.at) : null;
    if (!packagePath) return null;
    const dir = store.folder(r.id);
    const planPath = join(dirname(packagePath), RUN_PLAN_FILE);
    const plan = runPlan(r, { pkg: basename(packagePath), at: now() });
    writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
    const files = [
      { path: archive.path, at: archive.at, size: size(packagePath) },
      { path: `package/${RUN_PLAN_FILE}`, at: rel(dir, planPath), size: size(planPath) },
    ];
    const record = r.stages.package.handed_back.files.filter((f) => f.path.endsWith("-build.json"));
    return { packagePath, planPath, planAt: rel(dir, planPath), plan, files, record };
  }

  /** The run plan kept on the build, and said once in its log. */
  function keepPlan(b, w) {
    const first = !b.plan;
    b.plan = { at: w.planAt, stages: w.plan.stages };
    if (!first) return;
    say(b.log, `The run plan is written beside the package, for ${w.plan.stages.filter((e) => e.used).length} stages after Package.`);
    const open = w.plan.stages.filter((e) => e.used && !e.chosen);
    if (open.length) say(b.log, `Not chosen: ${open.map((e) => `${e.name} (${e.role_name})`).join(", ")}. Nobody holds ${open.length === 1 ? "that role" : "those roles"}, so the run plan hands ${open.length === 1 ? "it" : "them"} to no one.`);
  }

  const deployStage = (b) => (b.stages.deploy ??= { state: "not_started", holder: null, runs: 0, rounds: [], given: "", handed_back: { words: [], files: [] }, done_when_met: null, log: [] });

  /**
   * Before the process document's "approve the deploy" gate: writes the run plan
   * and lays out Deploy, so the person reads the package's build record and the
   * plan before saying yes. Resolves to true when the gate should be asked; false
   * when the build was not packed or its lifecycle leaves out Deploy.
   */
  async function prepare(id) {
    const w = writePlan(store.read(id));
    if (!w || !w.plan.stages[0].used) return false;
    await store.update(id, (b) => {
      keepPlan(b, w);
      b.at = "deploy";
      const s = deployStage(b);
      s.gate = "approve";
      s.holder = { kind: "person", name: "you", role: "deployment-manager" };
      s.given = "Approve the deploy: read the package's build record and the run plan, and say whether the package goes to your runtime.";
      s.handed_back = { words: [], files: [w.files[0], ...w.record, w.files[1]] };
    });
    return true;
  }

  /**
   * Once the person approved the deploy, or when they hand it over again: writes
   * the run plan and hands the package and the plan to the runtime. Does nothing
   * for a build that was not packed.
   */
  async function handOff(id, signal) {
    const w = writePlan(store.read(id));
    if (!w) return;
    const { packagePath, planPath, plan, files } = w;
    const dir = store.folder(id);
    const deployUsed = plan.stages[0].used;
    const rt = config.runtime;

    const n = await store.update(id, (b) => {
      keepPlan(b, w);
      if (!deployUsed) { say(b.log, "This build's lifecycle leaves out Deploy, so the package is not handed to a runtime."); return 0; }
      b.at = "deploy";
      const s = deployStage(b);
      delete s.gate;
      s.handed_back = { words: [], files };
      if (!rt) {
        s.state = "waiting_on_you";
        s.holder = { kind: "person", name: "you", role: "deployment-manager" };
        s.given = "Hand this package to your runtime, with its run plan.";
        s.handed_back.words = [`Hand this package to your runtime: ${packagePath}, with the run plan ${planPath}. To have Product Factory hand it over, name your runtime's command in product-factory.json under runtime.command.`];
        say(s.log, "No runtime is set, so the package waits for you to hand it over.");
        b.status = "waiting";
        say(b.log, "Deploy waits on you: hand this package to your runtime.");
        return 0;
      }
      s.state = "working";
      s.runs += 1;
      s.holder = { kind: "outside_tool", name: `your runtime (${rt.command.slice(0, 2).join(" ")})`, role: "deployment-manager" };
      s.given = "The package and its run plan, handed to your runtime.";
      say(s.log, "Handed the package and the run plan to your runtime.");
      b.status = "working";
      return s.runs;
    });
    if (!n || !rt) return;

    const res = await deploy({ command: rt.command, cwd: rt.cwd, packagePath, planPath, env, signal, log: join(dir, "stages", "deploy", `r${n}`, "run.log"), product: plan.product.name, version: plan.product.version });
    if (signal?.aborted || res.stopped) return;
    await store.update(id, (b) => {
      if (b.status !== "working" || b.at !== "deploy") return;
      const s = b.stages.deploy;
      s.rounds.push({ n, at: now(), label: `Round ${n}`, verdict: res.ok ? "Handed to your runtime" : "Refused", back: false, words: res.words });
      s.handed_back.words = [res.words];
      s.state = res.ok ? "done" : "refused";
      s.done_when_met = res.ok ? null : false;
      say(s.log, res.ok ? "Your runtime took it." : "Your runtime refused it.");
      if (res.ok && res.handle) b.handle = res.handle;
      b.status = res.ok ? "done" : "refused";
      say(b.log, res.ok ? `Done: ${b.name} ${b.version} is handed to your runtime, with its run plan.` : "Your runtime refused the package. It waits on you.");
    });
  }

  return { prepare, handOff };
}

/** The words a build view shows at Deploy and after, from the record. */
export const handleOf = (r) => r.handle ?? (r.stages.deploy?.state === "done" ? "handed to your runtime" : "not installed: Product Factory hands the package to the runtime you bring");
