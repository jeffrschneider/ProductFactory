// The driver: runs each build's process document through the process runner
// (orchestrator.mjs) and does what the runner says with the holder adapters.
// It holds no order of steps of its own. For each build it asks the runner
// for its next action, and:
//
//   send-work, send-revision   hands the phase to its adapter (adapters.mjs), then tells
//                              the runner what came back (replied: delivered or refused)
//   ask-gate, ask-approve,     the person's gate: the build waits, and the console shows
//   ask-act-on-draft           the gate's actions; the person's answer is an event
//                              (approved, deviated, resumed, stopped)
//   ask-refused, fail-refused  the build waits on the person, in the holder's words
//   close                      the build is done
//
// A phase at a stage milestone 1 does not run (Deploy and later), or at a
// stage the build's lifecycle leaves out, ends the run there, and the run's
// record names the phases left open.
//
// Every step writes the run's state and what the console shows into
// build.json before the next starts, so a build that was running when Product
// Factory stopped sends its phase again when it starts.

import { cpSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Refused } from "./lifecycle.mjs";
import { openRun, parse, nextAction, actionsFor, event, stageOf, holderOf, RUNS, phaseNamed, saveRun, timelineOf } from "./orchestrator.mjs";
import { stageById, roleById } from "./standards.mjs";
import { modelEnv, localPerson } from "./config.mjs";
import { RECORD_FORMAT } from "./store.mjs";
import { actionsOf } from "./view.mjs";
import { specWriter, testWriter, handOff, codeWriterWorkspace, codeRound, scriptsHanded, pack, requestText } from "./adapters.mjs";

const words = (s) => String(s ?? "").trim();
const nameOf = (id) => stageById.get(id)?.name ?? id;
const rel = (base, at) => relative(base, at).split(sep).join("/");
const firstWords = (s, n = 500) => { const t = words(s).replace(/\s+/g, " "); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const AGENT_FILE = /^(agent-descriptor\.json|agent-runtime-requirements\.json|plugin\.json|mcp\.json|skills\/[^/]+\/SKILL\.md)$/;

/** The request as the spec writer reads it. A name is passed only when the person gave one. */
const asked = (r) => requestText({ ...r, name: r.named ? r.name : "" });

const ROLE_OF = { requirements: "spec-writer", test: "test-writer", code: "code-writer", package: "package-maker" };

const GIVEN = {
  test: "The agent's own files from Requirements, as you approved them: agent-descriptor.json, agent-runtime-requirements.json, plugin.json and a SKILL.md per skill.",
  code: "The agent's files and the suite, laid out as a build folder with AGENTS.md (the hand-off contract), .adlc/check.mjs and build.lock.json.",
  package: "The agent's files as you approved them, and the scripts Code wrote, placed under each skill as plugin.json's build entry names them.",
};

/** Who holds each stage milestone 1 runs, from the settings in effect when the build started. */
export function holdersFor(settings) {
  const packer = settings.packer.join(" ");
  return {
    requirements: { kind: "reference_agent", name: "spec-writer", role: "spec-writer" },
    test: { kind: "reference_agent", name: "test-writer", role: "test-writer" },
    code: settings.code.holder === "code-writer"
      ? { kind: "reference_agent", name: "code-writer", role: "code-writer" }
      : { kind: "your_agent", name: `your coding harness (${settings.code.harness?.[0] ?? "not set"})`, role: "code-writer" },
    package: { kind: "outside_tool", name: packer.includes("@common-agent/package") ? "the Common Agent packer (@common-agent/package)" : `the packer (${settings.packer[0]})`, role: "package-maker" },
  };
}

export function createRunner({ store, lifecycle, config, env = process.env, person = localPerson(), now = () => new Date().toISOString() }) {
  const running = new Map();
  const by = person.email;

  const say = (list, said) => list.push({ at: now(), said });
  const dirOf = (id) => store.folder(id);
  const abs = (id, p) => resolve(dirOf(id), p);
  const docs = new Map();
  const docOf = (r) => {
    if (!docs.has(r.id)) docs.set(r.id, parse(readFileSync(abs(r.id, r.process), "utf8")));
    return docs.get(r.id);
  };

  /** One change to a build: fn(record, ev) may apply events to its run with ev(e). The run is kept on disk the runner's way too. */
  function change(id, fn) {
    return store.update(id, (b) => {
      const doc = docOf(b);
      const ev = (e) => { b.run = event(b.run, { at: now(), ...e }, doc); };
      const out = fn(b, ev);
      try { saveRun(join(dirOf(id), "run"), b.run); } catch { /* the run in build.json is the record */ }
      return out;
    });
  }

  function agentEnv() {
    const e = { ...env, ...modelEnv(config, env).env };
    // The spec writer would check its drafts with the package maker's Python builder if one were
    // on this machine; Product Factory runs no Python, so it never points the spec writer at one.
    delete e.BUILD_PY;
    return e;
  }

  function filesHanded(id, list) {
    return list.map((f) => {
      let size = 0;
      try { size = statSync(abs(id, f.at)).size; } catch { /* gone */ }
      return { path: f.path, at: f.at, size };
    });
  }

  /** The files a phase was handed, from the runner's handoffs: [{ name, path, media_type }] with path inside the build folder. */
  const handed = (action) => (action.handoffs ?? []).flatMap((h) => h.files ?? []);

  function missingModel() {
    const { missing } = modelEnv(config, env);
    if (!missing.length) return null;
    return `The reference agents need a model, and ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set. product-factory.json names the environment variables the four model settings are read from (model.name, model.endpoint, model.key, model.protocol); set them, then run it again.`;
  }

  // ---------- sending a phase to its adapter, and telling the runner what came back ----------

  /** The phase goes out: the runner records who holds it and that the work was sent. */
  function sent(id, action, stage, said) {
    return change(id, (b, ev) => {
      if (b.status !== "working") return;
      ev({ type: "holder", phase: action.phase, handle: action.to, how: action.holder?.how ?? "named in the roster" });
      ev({ type: "sent", phase: action.phase, to: action.to, handle: action.to, kind: action.kind === "send-revision" ? "revision" : "work", text: said });
      const s = b.stages[stage];
      s.state = "working";
      s.runs += 1;
      say(s.log, said);
    });
  }

  /** The holder refused: the runner records it, and the build waits on the person in the holder's words. */
  function refused(id, action, stage, reply, extra = {}) {
    return change(id, (b, ev) => {
      if (b.status !== "working") return;
      ev({ type: "replied", phase: action.phase, from: action.to, handle: action.to, text: reply, files: extra.files ?? [], verdict: "refused" });
      const s = b.stages[stage];
      s.state = "refused";
      s.done_when_met = false;
      if (extra.round) s.rounds.push(extra.round);
      if (extra.handed) s.handed_back = { words: [reply], files: filesHanded(id, extra.handed) };
      else s.handed_back.words = [reply];
      say(s.log, firstWords(reply));
      // The runner decides what a refusal means (it may end the run); the next step asks it.
      say(b.log, `${nameOf(stage)} was refused. It waits on you.`);
    });
  }

  /** The holder delivered: the runner records the delivery and its files. */
  function delivered(b, ev, action, reply, files) {
    ev({ type: "replied", phase: action.phase, from: action.to, handle: action.to, text: reply, files, verdict: "delivered" });
  }

  const asFiles = (id, list) => list.map((f) => ({ name: f.path, path: rel(dirOf(id), f.abs), media_type: f.media_type ?? "" }));

  async function specWriterStep(r, action, stage, signal) {
    const id = r.id;
    const revise = action.kind === "send-revision";
    await sent(id, action, stage, revise ? "Sent back to the spec writer with your words." : "Sent to the spec writer.");
    const n = store.read(id).stages[stage].runs;
    const noModel = missingModel();
    if (noModel) return refused(id, action, stage, noModel, { round: { n, at: now(), label: `Round ${n}`, verdict: "Not run", back: false, words: noModel } });
    const prior = revise ? (action.prior?.record?.files ?? []).filter((f) => AGENT_FILE.test(f.name)) : [];
    const res = await specWriter({
      dir: dirOf(id), adlc: config.adlc, n, signal, env: agentEnv(),
      text: revise ? `changes: ${action.steps.join("\n")}\n` : r.work.text ?? asked(r),
      attach: prior.map((f) => ({ abs: abs(id, f.path), media_type: f.media_type })),
    });
    if (signal.aborted) return;
    const round = { n, at: now(), label: `Round ${n}`, verdict: res.ok ? "Ready for your approval" : "Refused", back: false, words: firstWords(res.reply) };
    if (!res.ok) return refused(id, action, stage, res.reply, { round, handed: res.handed ?? [] });
    await change(id, (b, ev) => {
      if (b.status !== "working") return;
      const s = b.stages[stage];
      s.rounds.push(round);
      s.handed_back = { words: [res.reply], files: filesHanded(id, res.handed) };
      s.done_when_met = null;
      say(s.log, "The spec writer handed back the agent's own files.");
      delete b.work.text;
      // The spec says the agent's name and version; a name the person gave stays.
      try {
        const d = JSON.parse(readFileSync(res.agentFiles.find((f) => f.path === "agent-descriptor.json")?.abs ?? "", "utf8"));
        if (!b.named && words(d.name)) b.name = words(d.name);
        if (words(d.agent_version)) b.version = words(d.agent_version);
      } catch { /* the name and version stay as they were */ }
      const open = (res.handed ?? []).filter((f) => f.path === "requirements/still-open.md").map((f) => ({ name: "still-open.md", path: f.at, media_type: "text/markdown" }));
      delivered(b, ev, action, res.reply, [...asFiles(id, res.agentFiles), ...open]);
    });
  }

  async function testWriterStep(r, action, stage, signal) {
    const id = r.id;
    await sent(id, action, stage, "Sent to the test writer with the agent's files.");
    const n = store.read(id).stages[stage].runs;
    const noModel = missingModel();
    if (noModel) return refused(id, action, stage, noModel, { round: { n, at: now(), label: `Round ${n}`, verdict: "Not run", back: false, words: noModel } });
    const agentFiles = handed(action).filter((f) => AGENT_FILE.test(f.name)).map((f) => ({ abs: abs(id, f.path), media_type: f.media_type }));
    const res = await testWriter({ dir: dirOf(id), adlc: config.adlc, n, agentFiles, env: agentEnv(), signal });
    if (signal.aborted) return;
    const round = { n, at: now(), label: `Round ${n}`, verdict: res.ok ? "Suite written" : "Refused", back: false, words: firstWords(res.reply) };
    if (!res.ok) return refused(id, action, stage, res.reply, { round, handed: res.handed ?? [] });
    await change(id, (b, ev) => {
      if (b.status !== "working") return;
      const s = b.stages[stage];
      s.rounds.push(round);
      s.handed_back = { words: [res.reply], files: filesHanded(id, res.handed) };
      s.state = "done";
      say(s.log, `The test writer handed back ${res.suite.length} test file${res.suite.length === 1 ? "" : "s"}.`);
      delete b.work.folder; delete b.work.records; delete b.work.feedback;
      say(b.log, "The suite is written.");
      delivered(b, ev, action, res.reply, asFiles(id, res.suite));
    });
  }

  async function codeStep(r, action, stage, signal) {
    const id = r.id;
    const dir = dirOf(id);
    const mode = r.settings.code.holder;
    await sent(id, action, stage, mode === "code-writer" ? "Sent to the reference code writer." : "Sent to your coding harness.");
    if (!r.settings.code.harness) {
      return refused(id, action, stage, "No coding harness is set. Name the command in product-factory.json under code.harness, such as [\"claude\", \"-p\", \"{prompt}\"] or [\"codex\", \"exec\", \"{prompt}\"], then run it again.");
    }
    let { folder, records } = store.read(id).work;
    if (!folder) {
      const files = handed(action);
      const agentFiles = files.filter((f) => AGENT_FILE.test(f.name)).map((f) => ({ abs: abs(id, f.path), media_type: f.media_type }));
      const suite = files.filter((f) => /^test\//.test(f.name)).map((f) => ({ abs: abs(id, f.path), media_type: f.media_type }));
      const h = await handOff({ dir, adlc: config.adlc, agentFiles, suite, env: agentEnv(), signal });
      if (signal.aborted) return;
      if (!h.ok) return refused(id, action, stage, h.reply);
      folder = h.folder;
      if (mode === "code-writer") {
        const w = await codeWriterWorkspace({ dir, adlc: config.adlc, archive: h.archive, env: agentEnv(), signal });
        if (signal.aborted) return;
        if (!w.ok) return refused(id, action, stage, w.reply);
        folder = w.folder;
        records = w.records;
      }
      await store.update(id, (b) => {
        b.work.folder = rel(dir, folder);
        if (records) b.work.records = rel(dir, records);
        say(b.stages[stage].log, `The build folder is laid out at ${folder}, with AGENTS.md.`);
      });
    } else {
      folder = abs(id, folder);
      if (records) records = abs(id, records);
    }
    let feedback = r.work.feedback ? abs(id, r.work.feedback) : null;
    const limit = r.settings.code.rounds;
    for (let k = 1; k <= limit; k++) {
      const n = store.read(id).stages[stage].rounds.length + 1;
      const res = await codeRound({ dir, adlc: config.adlc, mode, folder, records, harness: r.settings.code.harness, round: n, feedbackFile: feedback, minutes: r.settings.code.minutes, env: agentEnv(), signal });
      if (signal.aborted || res.stopped) return;
      const verdict = res.pass ? "The suite passes" : res.code === 3 ? "A pinned file changed" : res.code === 4 ? "The check's rounds are used up" : "The suite fails";
      const roundWords = [res.words, ...(res.items.length ? [`Failing: ${res.items.join("; ")}`] : [])].join(" ");
      const outcome = await change(id, (b, ev) => {
        if (b.status !== "working") return "gone";
        const s = b.stages[stage];
        const scripts = scriptsHanded(dir, folder);
        s.rounds.push({ n, at: now(), label: `Round ${n}`, verdict, back: !res.pass, words: firstWords(roundWords, 800) });
        s.handed_back = { words: [res.words], files: filesHanded(id, scripts) };
        b.work.feedback = res.checkFile ? rel(dir, res.checkFile) : b.work.feedback;
        say(s.log, `Round ${n}: ${verdict.toLowerCase()}.`);
        if (!res.pass) return "again";
        s.done_when_met = true;
        delete b.work.feedback;
        say(b.log, "The suite passes.");
        delivered(b, ev, action, res.words, scripts.map((f) => ({ name: f.path.replace(/^code\//, ""), path: f.at, media_type: "text/javascript" })));
        return "passed";
      });
      if (outcome !== "again") return;
      feedback = res.checkFile ?? feedback;
      if (res.code === 4) break;
    }
    const s = store.read(id).stages[stage];
    return refused(id, action, stage, `The suite still does not pass after ${s.rounds.length} round${s.rounds.length === 1 ? "" : "s"}. Give it more rounds, or stop the build. What the last check said is the last round's words.`);
  }

  async function packerStep(r, action, stage, signal) {
    const id = r.id;
    await sent(id, action, stage, "Packing the agent's files and the scripts as an Agent Package.");
    const n = store.read(id).stages[stage].runs;
    // The folder the package is made from: what the phase was handed, each file at its own name.
    const folder = join(dirOf(id), "stages", "package", `r${n}`, "handed");
    for (const f of handed(action)) {
      if (!AGENT_FILE.test(f.name) && !/^scripts\//.test(f.name)) continue;
      const to = join(folder, ...f.name.split("/"));
      mkdirSync(dirname(to), { recursive: true });
      cpSync(abs(id, f.path), to);
    }
    const res = await pack({ dir: dirOf(id), n, folder, packer: r.settings.packer, env: agentEnv(), signal });
    if (signal.aborted) return;
    const round = { n, at: now(), label: `Round ${n}`, verdict: res.ok ? "Packed and validated" : "Refused", back: false, words: firstWords(res.reply) };
    if (!res.ok) return refused(id, action, stage, res.reply, { round, handed: res.handed ?? [] });
    await change(id, (b, ev) => {
      if (b.status !== "working") return;
      const s = b.stages[stage];
      s.rounds.push(round);
      s.handed_back = { words: [res.reply], files: filesHanded(id, res.handed) };
      s.state = "done";
      s.done_when_met = true;
      say(s.log, "Packed and validated.");
      if (res.version) b.version = res.version;
      delivered(b, ev, action, res.reply, res.handed.map((f) => ({ name: f.path.replace(/^package\//, ""), path: f.at, media_type: f.path.endsWith(".tar.gz") ? "application/gzip" : "application/json" })));
    });
  }

  /** The person's gate: the runner records the question, and the build waits for an answer in the console. */
  function gate(r, action, stage, doc) {
    return change(r.id, (b, ev) => {
      if (b.status !== "working") return;
      ev({ type: "gated", phase: action.phase, question: phaseNamed(doc, action.phase)?.what ?? action.phase, files: [] });
      b.stages[stage].state = "waiting_on_you";
      b.status = "waiting";
      say(b.log, stage === "requirements" ? "The spec is ready. It waits for you to approve it." : stage === "code" ? "The code waits for your OK." : `${nameOf(stage)} waits on you.`);
    });
  }

  /** The run reaches a phase milestone 1 does not run, or one the build's lifecycle leaves out: it ends there. */
  function endRun(r, phase, stage, why) {
    return change(r.id, (b, ev) => {
      if (b.status !== "working") return;
      const open = Object.entries(b.run.phases).filter(([, p]) => p.status !== "closed").map(([pid]) => pid);
      ev({ type: "closed", outcome: "ended", result: `${why} The run ends before ${phase}.`, open });
      b.status = "done";
      say(b.log, b.at === "package" ? `Done: ${b.name} ${b.version} is packed and validated. ${why}` : `Done at ${nameOf(b.at)}. ${why}`);
    });
  }

  const STEPS = { "spec-writer": specWriterStep, "test-writer": testWriterStep, code: codeStep, packer: packerStep };

  // ---------- running a build ----------

  async function step(r, signal) {
    const doc = docOf(r);
    const a = nextAction(r.run, doc);
    if (!a) return false;
    const stage = a.phase ? stageOf(doc, a.phase) : null;
    if (["send-work", "send-revision", "ask-gate", "ask-approve", "ask-act-on-draft"].includes(a.kind)) {
      if (!RUNS.includes(stage)) { await endRun(r, a.phase, stage, `Product Factory milestone 1 ends at Package; ${nameOf(stage)} is not run.`); return true; }
      if (!r.stages[stage]) { await endRun(r, a.phase, stage, `This build's lifecycle leaves out ${nameOf(stage)}.`); return true; }
      if (r.at !== stage) await store.update(r.id, (b) => { b.at = stage; });
      const fresh = store.read(r.id);
      if (a.kind.startsWith("ask-")) { await gate(fresh, a, stage, doc); return true; }
      const adapter = STEPS[holderOf(doc, a.phase)];
      if (!adapter) { await endRun(fresh, a.phase, stage, `Milestone 1 has nobody to send ${a.phase} to.`); return true; }
      await adapter(fresh, a, stage, signal);
      return true;
    }
    if (a.kind === "close") {
      await change(r.id, (b, ev) => { if (b.status !== "working") return; ev({ type: "closed", outcome: "completed" }); b.status = "done"; say(b.log, `Done: every phase of ${b.run.process.name} closed.`); });
      return true;
    }
    if (a.kind === "fail-refused") {
      // A phase that starts at the trigger refused: the run ends as failed, and the person may start it again.
      await change(r.id, (b, ev) => {
        ev({ type: "trigger-refused", phase: a.phase, holder: a.from, text: a.text });
        if (b.status === "working") { b.status = "refused"; b.at = stage ?? b.at; }
      });
      return true;
    }
    if (a.kind === "ask-refused") {
      await store.update(r.id, (b) => { if (b.status === "working") b.status = "refused"; });
      return true;
    }
    // Anything else the runner asks for (a holder to name, a person to act, a gap to fill) milestone 1 does not answer.
    await store.update(r.id, (b) => {
      if (b.status !== "working") return;
      b.status = "refused";
      if (b.stages[b.at]) b.stages[b.at].state = "refused";
      say(b.log, `The process runner asked for something milestone 1 does not answer (${a.kind}${a.phase ? ` at ${a.phase}` : ""}). It waits on you.`);
    });
    return true;
  }

  function advance(id) {
    if (running.has(id)) return running.get(id).done;
    const ctl = new AbortController();
    const entry = { ctl, done: null };
    running.set(id, entry);
    entry.done = (async () => {
      try {
        for (let guard = 0; guard < 500; guard++) {
          const r = store.read(id);
          if (!r || r.status !== "working" || ctl.signal.aborted) return;
          const before = JSON.stringify([r.status, r.run.events.length]);
          const moved = await step(r, ctl.signal);
          const after = store.read(id);
          if (!moved || JSON.stringify([after?.status, after?.run.events.length]) === before) return;
        }
      } catch (e) {
        await store.update(id, (b) => {
          if (b.status !== "working") return;
          if (b.stages[b.at]) { b.stages[b.at].state = "refused"; say(b.stages[b.at].log, `Something went wrong in Product Factory: ${e.message}`); }
          b.status = "refused";
          say(b.log, `${nameOf(b.at)} stopped on an error in Product Factory. It waits on you.`);
        }).catch(() => {});
      } finally {
        running.delete(id);
      }
    })();
    return entry.done;
  }

  async function start(req) {
    const does = words(req?.does);
    if (!does) throw new Refused(400, "Say what the agent should do: does is required.");
    if (req.kind && req.kind !== "agent") throw new Refused(400, "Product Factory milestone 1 builds agents only. A process is a later milestone.");
    for (const k of ["refuses", "more", "name", "prototype", "project"]) {
      if (k in req && typeof req[k] !== "string") throw new Refused(400, `${k} is words.`);
    }
    const project = words(req.project) || null;
    const snap = await lifecycle.snapshot(project);
    const settings = { code: { ...config.code }, packer: [...config.package.packer] };
    const holders = holdersFor(settings);
    const at = now();
    const id = store.newId();
    const record = {
      format: RECORD_FORMAT, id,
      name: words(req.name) || "A new agent", named: Boolean(words(req.name)),
      does, refuses: words(req.refuses), more: words(req.more), prototype: words(req.prototype),
      ...(project ? { project } : {}),
      version: "0.1.0", created: at, updated: at, archived: false,
      status: "working", at: "requirements",
      lifecycle: { project, at, used: snap.used, holders: snap.holders, added: snap.added },
      settings,
      process: "run/document.txt",
      run: null,
      stages: {},
      work: {},
      log: [],
    };
    let opened;
    try {
      opened = openRun({ person: by, day: at.slice(0, 10), settings, material: asked(record), startedAt: at });
    } catch (e) {
      throw new Refused(409, e.message);
    }
    record.run = opened.state;
    for (const s of Object.keys(holders)) {
      if (!snap.used[s]?.used) continue;
      record.stages[s] = {
        state: "not_started", holder: holders[s], runs: 0, rounds: [],
        given: s === "requirements" ? asked(record).replace(/^Write a spec\.\n/, "").trim() : GIVEN[s],
        handed_back: { words: [], files: [] }, done_when_met: null, log: [],
      };
    }
    say(record.log, `Started under ${project ? `the project ${project}'s` : "the organization's"} lifecycle, running the process ${opened.state.process.name} (${opened.doc.ref || opened.state.process.id} ${opened.state.process.version}).`);
    for (const s of Object.keys(record.stages)) {
      const bound = snap.holders[ROLE_OF[s]];
      if (bound && bound.kind !== "reference_agent" && !(s === "code" && bound.kind === "your_agent" && settings.code.holder === "harness")) {
        say(record.log, `The lifecycle has ${bound.name} hold the ${roleById.get(ROLE_OF[s])?.name ?? ROLE_OF[s]} role. Milestone 1 sends ${nameOf(s)} to ${holders[s].name} instead.`);
      }
    }
    for (const a of snap.added) say(record.log, `The lifecycle adds a stage of its own, ${a.name}. Milestone 1 does not run stages of your own yet.`);
    store.create(record);
    mkdirSync(join(dirOf(id), "run"), { recursive: true });
    writeFileSync(abs(id, record.process), opened.text);
    saveRun(join(dirOf(id), "run"), record.run);
    advance(id);
    return store.read(id);
  }

  /** What a resume at a phase runs again: that phase, and every phase of the run that has not closed. */
  const reopenFrom = (b, pid) => [pid, ...Object.entries(b.run.phases).filter(([x, p]) => x !== pid && !["closed", "skipped"].includes(p.status)).map(([x]) => x)];

  const notOffered = (r) => { const e = new Refused(409, "That action is not offered now."); e.build = r; return e; };

  /** A person's answer at a gate, or stop, resume, archive: each one an event the runner reads. */
  async function act(id, name, needs = {}) {
    const r = store.read(id);
    if (!r) throw new Refused(404, "There is no build with that id.");
    if (!actionsOf(r).some((a) => a.name === name)) throw notOffered(r);
    const said = words(needs?.changes);
    if (name === "changes" && !said) throw new Refused(400, "Say what should change.");
    let go = false;
    await change(id, (b, ev) => {
      const doc = docOf(b);
      const s = b.stages[b.at];
      const last = s?.rounds[s.rounds.length - 1];
      const here = (pid) => stageOf(doc, pid) === b.at;
      if (name === "stop") {
        ev({ type: "stopped", by, reason: "stopped in the console" });
        s.state = "stopped";
        b.status = "stopped";
        say(s.log, "You stopped the build.");
        say(b.log, `You stopped the build at ${nameOf(b.at)}.`);
      } else if (name === "archive" || name === "unarchive") {
        b.archived = name === "archive";
        say(b.log, b.archived ? "You archived the build." : "You unarchived the build.");
      } else if (name === "approve" || name === "accept") {
        // One answer from the person settles every phase of this stage that waits on them:
        // at Requirements the spec writer's draft (assisted) and the approve-the-spec gate.
        for (let i = 0; i < 10; i++) {
          const waiting = Object.entries(b.run.phases).find(([pid, p]) => here(pid) && ["holding", "gated"].includes(p.status));
          if (waiting) { ev({ type: "approved", phase: waiting[0], by, text: name === "approve" ? "approved in the console" : "OK'd in the console" }); continue; }
          const ask = actionsFor(b.run, doc).find((x) => x.kind === "ask-gate" && here(x.phase));
          if (!ask) break;
          ev({ type: "gated", phase: ask.phase, question: phaseNamed(doc, ask.phase)?.what ?? ask.phase, files: [] });
        }
        if (last) last.verdict = name === "approve" ? "Approved" : "OK'd by you";
        s.state = "done";
        if (name === "approve") s.done_when_met = true;
        const yes = name === "approve" ? "You approved the spec." : "You OK'd the code.";
        say(s.log, yes);
        say(b.log, yes);
        b.status = "working";
        go = true;
      } else if (name === "changes") {
        // The document's way back at this stage, such as [changes] from approve-the-spec to write-the-spec.
        const way = doc.deviations.find((d) => here(d.from) && here(d.to));
        if (last) { last.verdict = "You asked for changes"; last.back = true; last.words = firstWords(`${last.words} You said: “${said}”`, 800); }
        const prior = Object.entries(b.run.phases).some(([pid, p]) => here(pid) && p.record);
        if (way && prior) {
          ev({ type: "deviated", key: way.key, from: way.from, to: way.to, by, text: said, steps: [said] });
        } else {
          // Nothing was drafted yet: the request goes out again with the person's words added.
          const pid = Object.keys(b.run.phases).find((x) => here(x) && holderOf(doc, x) !== "person");
          b.work.text = requestText({ ...b, name: b.named ? b.name : "", more: [b.more, said].filter(Boolean).join(" ") });
          ev({ type: "resumed", phase: pid, reopen: reopenFrom(b, pid), by });
        }
        s.state = "working";
        b.status = "working";
        say(b.log, "You asked for changes to the spec.");
        go = true;
      } else if (name === "resume") {
        const pid = Object.entries(b.run.phases).find(([x, p]) => here(x) && p.status === "refused")?.[0]
          ?? Object.keys(b.run.phases).find((x) => here(x) && holderOf(doc, x) !== "person");
        ev({ type: "resumed", phase: pid, reopen: reopenFrom(b, pid), by });
        s.state = "working";
        b.status = "working";
        say(b.log, `You ran ${nameOf(b.at)} again.`);
        go = true;
      }
    });
    if (name === "stop") running.get(id)?.ctl.abort();
    if (go) advance(id);
    return store.read(id);
  }

  /** Builds that were running when Product Factory stopped send their phase again. */
  async function resumeAll() {
    for (const r of store.list()) {
      if (r.status !== "working") continue;
      await change(r.id, (b, ev) => {
        for (const [pid, p] of Object.entries(b.run.phases)) if (p.status === "working") ev({ type: "send-again", phase: pid, by: "Product Factory, started again" });
        say(b.log, `Product Factory started again while ${nameOf(b.at)} was running, so it runs again.`);
      });
      advance(r.id);
    }
  }

  return {
    start, act, resumeAll,
    /** The build's timeline (build.timeline): one bar per phase per round, with its stage. */
    timelineOf: (r) => { try { return r?.run ? timelineOf(r.run, docOf(r)) : []; } catch { return []; } },
    /** Resolves when the build has nothing running. */
    idle: (id) => running.get(id)?.done ?? Promise.resolve(),
    stopAll: () => { for (const e of running.values()) e.ctl.abort(); return Promise.all([...running.values()].map((e) => e.done)); },
  };
}
