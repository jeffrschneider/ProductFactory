// One builder (make-a-new-agent.txt, the reference make-a-new-agent v3 as
// published): build-the-agent is held by your coding harness with the ADLC
// plugin, from the approved spec through the code, in one build folder. Product
// Factory decides nothing about the agent itself: the folder's own ADLC check
// (`node .adlc/check.mjs --json`) decides, and the person's approvals are
// pressed in the console, which runs the folder's approve.mjs (binding: the
// assistant's hook stops it from running it).
//
// The folder has two phases: the spec, which the person approves, and the
// build, in which the builder writes the rest in any order and the check runs
// every gate over it (architecture, the agent's files, test and code). The
// console shows the lifecycle's stages; a stage is done when the gates shown
// at it pass.
//
//   startFolder({ folder, adlc, request })            the folder for a builder that writes the spec: the plugin kit and request.md
//   addChanges(folder, said)                           the person's later words, added to request.md under a dated heading
//   specPrompt(check)                                  what the harness is asked at Requirements
//   layOut({ folder, adlc, request, spec, answers })   the folder, with the plugin kit, the person's words, the approved spec and the person's answers
//   approveSpec(folder)                                the person's approval of the spec, pressed in the console: approve.mjs
//   checkBuild(folder)                                 the check's answer: { phase, gates, stage, code, passed, problems, waiting, said, done }
//   sendBack(folder, stage)                            the person's send back of the folder to the spec or the build: approve.mjs --send-back
//   builderRound({ ... })                              one round of your harness in the folder, then the check
//   questionsOf(problems)                              the questions only the person can answer, out of the check's problems
//
// The check's stages are requirements (the spec) and the build's gates:
// architecture, files (the agent's own files), test and code. ADLC_PHASE_OF
// maps Product Factory's stages of stages.json onto the folder's phases.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { run, lastJson, tail, withoutEnv } from "./exec.mjs";
import { fill } from "./adapters.mjs";

const NODE = (script, args = []) => [process.execPath, script, ...args];
const words = (s) => String(s ?? "").trim();

/** The check's stages: the spec, then the build's gates, and the stage of stages.json each is shown at. */
export const GATES = ["architecture", "files", "test", "code"];
export const CHECK_STAGES = ["requirements", ...GATES];
export const STAGE_OF_CHECK = { requirements: "requirements", architecture: "architecture", files: "architecture", test: "test", code: "code" };
/** The phase of the folder a send back to a stage of stages.json reopens: the spec, or the build. */
export const ADLC_PHASE_OF = { requirements: "spec", architecture: "build", test: "build", code: "build" };

/** Where the ADLC plugin is in an adlc checkout, and its start script. */
export const pluginOf = (adlc) => join(adlc, "plugin");
const startScript = (adlc) => join(pluginOf(adlc), "kit", "start.mjs");

/**
 * Lay the build folder out with the plugin's kit, then write what the person
 * gave: request.md (their words), spec.json (the spec as they approved it) and
 * answers.json (their name and price, and any answer given since).
 * Resolves to { ok, reply }.
 */
export async function layOut({ folder, adlc, request, spec, answers = {}, env, signal }) {
  if (!existsSync(startScript(adlc))) return { ok: false, reply: `The adlc checkout at ${adlc} has no plugin/kit/start.mjs, so the build folder cannot be laid out. Check out the commit standards/ADLC.json pins there.` };
  mkdirSync(dirname(folder), { recursive: true });
  if (!existsSync(join(folder, ".adlc"))) {
    const r = await run(NODE(startScript(adlc), [folder]), { env, signal, timeoutMs: 60_000 });
    if (r.stopped) return { ok: false, reply: "It was stopped." };
    if (r.code !== 0) return { ok: false, reply: words(r.stdout) || tail(r.stderr, 400) || `The ADLC start script ended with code ${r.code}.` };
  }
  writeFileSync(join(folder, "request.md"), `${words(request)}\n`);
  writeFileSync(join(folder, "spec.json"), `${JSON.stringify(spec, null, 2)}\n`);
  writeAnswers(folder, answers);
  return { ok: true, reply: `The build folder is laid out with the ADLC plugin's kit, the person's words, the approved spec and their answers.` };
}

/**
 * Lay the build folder out for a builder that writes the spec too: the plugin's
 * kit, and request.md with the person's own words. No spec is written here: the
 * builder writes it, and the folder's Requirements check decides when it is
 * ready for the person. Resolves to { ok, reply }.
 */
export async function startFolder({ folder, adlc, request, answers = {}, env, signal }) {
  if (!existsSync(startScript(adlc))) return { ok: false, reply: `The adlc checkout at ${adlc} has no plugin/kit/start.mjs, so the build folder cannot be laid out. Check out the commit standards/ADLC.json pins there.` };
  mkdirSync(dirname(folder), { recursive: true });
  if (!existsSync(join(folder, ".adlc"))) {
    const r = await run(NODE(startScript(adlc), [folder]), { env, signal, timeoutMs: 60_000 });
    if (r.stopped) return { ok: false, reply: "It was stopped." };
    if (r.code !== 0) return { ok: false, reply: words(r.stdout) || tail(r.stderr, 400) || `The ADLC start script ended with code ${r.code}.` };
  }
  if (!existsSync(join(folder, "request.md"))) writeFileSync(join(folder, "request.md"), `${words(request)}\n`);
  if (Object.keys(answers).length) writeAnswers(folder, answers);
  return { ok: true, reply: "The build folder is laid out with the ADLC plugin's kit and the person's words in request.md." };
}

/** The heading the person's later words go under in request.md, as the plugin's instructions name it. */
export const CHANGES_HEADING = "## The person asked for changes";

/** The person's later words, added to request.md under a dated heading: the builder reads them and revises the spec. */
export function addChanges(folder, said, at = new Date().toISOString()) {
  const p = join(folder, "request.md");
  const was = existsSync(p) ? readFileSync(p, "utf8").replace(/\s*$/, "\n") : "";
  // Nothing to add, or these words already end request.md (a send back puts them there, and
  // the spec step it reopens is handed the same words): once is enough.
  if (!words(said) || was.trimEnd().endsWith(words(said))) return;
  writeFileSync(p, `${was}\n${CHANGES_HEADING} (${at.slice(0, 10)})\n\n${words(said)}\n`);
}

/** What the check said last, for the harness. */
const lastSaid = (check) => (check?.problems?.length ? `\n\nThe check says:\n${check.problems.map((p) => `- ${p}`).join("\n")}` : "");

/** What the harness is asked in the spec phase: write or revise the spec until the check says it waits on the person. */
export function specPrompt(check) {
  return `Follow AGENTS.md in this folder, from its first phase, the spec: write spec.json from the person's words in request.md (and any changes they asked for at its end), running \`node .adlc/check.mjs\` after each change, until it says the spec is ready for the person. Then stop. Never run approve.mjs. Where only the person can decide, put the question in the spec's open list and stop.${lastSaid(check)}\n`;
}

/** The answers read from the spec, which the person approves with them in it; every other answer quotes the person. */
const OF_THE_SPEC = new Set(["name", "version", "price"]);
/** What the person has said since request.md, where the folder's check finds the words each answer quotes. */
export const SAID = "said.md";

/**
 * answers.json, with these answers over the ones already there. The name, the
 * version and the price are written as they are. Every other answer is the
 * person's reply in the console, written with their words ({ answer, said }),
 * and the reply they gave (`said`, else the answers themselves) is added to
 * said.md.
 */
export function writeAnswers(folder, answers = {}, { said = "", at = new Date().toISOString() } = {}) {
  const file = join(folder, "answers.json");
  let kept = {};
  try { kept = JSON.parse(readFileSync(file, "utf8")); } catch { kept = {}; }
  const quoted = {};
  const heard = [];
  for (const [k, v] of Object.entries(answers)) {
    if (OF_THE_SPEC.has(k) || (v && typeof v === "object")) { quoted[k] = v; continue; }
    const w = words(v);
    quoted[k] = { answer: w, said: w };
    if (w) heard.push(w);
  }
  writeFileSync(file, `${JSON.stringify({ ...kept, ...quoted }, null, 2)}\n`);
  if (!heard.length) return;
  const p = join(folder, SAID);
  const was = existsSync(p) ? readFileSync(p, "utf8") : "# What the person said\n\nKept as the person said it, after request.md: their replies in Product Factory. The builder does not write this file.\n\n";
  writeFileSync(p, `${was}## ${at}\n\n${words(said) || heard.join("\n\n")}\n\n`);
}

/** Run one of the folder's own commands: { code, doc, out }. */
async function folderCommand(folder, script, args, { env, signal, timeoutMs = 30 * 60 * 1000, log } = {}) {
  const r = await run(NODE(join(folder, ".adlc", script), args), { cwd: folder, env, signal, timeoutMs, log });
  return { stopped: r.stopped, code: r.code, out: words(r.stdout) || words(r.stderr), doc: lastJson(r.stdout) };
}

/** The person's approval of the spec, pressed in the console. Resolves to { ok, reply }. */
export async function approveSpec(folder, { env, signal } = {}) {
  const r = await folderCommand(folder, "approve.mjs", [], { env, signal, timeoutMs: 5 * 60 * 1000 });
  return { ok: r.code === 0, reply: r.out || `approve.mjs ended with code ${r.code}.` };
}

/** The person's send back of the folder: to the spec from Requirements, to the build from a stage of the build. Resolves to { ok, reply }. */
export async function sendBack(folder, stage, { env, signal } = {}) {
  const to = ADLC_PHASE_OF[stage];
  if (!to) return { ok: false, reply: `${stage} is not a stage the build folder has.` };
  const r = await folderCommand(folder, "approve.mjs", ["--send-back", to], { env, signal, timeoutMs: 60_000 });
  return { ok: r.code === 0, reply: r.out || `approve.mjs ended with code ${r.code}.` };
}

/**
 * The folder's check, as JSON. A check that did not answer JSON is a check
 * that could not run, said in its own words, and passes nothing. `stage` is
 * where the build is: requirements in the spec phase, else the first gate
 * that still has something missing, and null once the build has passed.
 */
export async function checkBuild(folder, { env, signal, log } = {}) {
  const r = await folderCommand(folder, "check.mjs", ["--json"], { env, signal, log });
  if (r.stopped) return { stopped: true, stage: null, code: null, passed: false, problems: [], said: "It was stopped." };
  const d = r.doc;
  if (!d || typeof d !== "object") return { stage: null, code: r.code ?? 1, passed: false, problems: [r.out || "The check could not run."], said: r.out || "The check could not run." };
  // A folder laid out before the two phases answers with stages, and its "passed" means one stage
  // passed, never the build. It is never read as this check: it passes nothing and says why.
  if (!("phase" in d)) {
    const said = "This build folder carries the ADLC plugin's kit from before its two phases (its check answers by stage), so Product Factory reads nothing from it as passed. Bring the folder to this plugin's kit with node <plugin>/kit/start.mjs --update <folder>, or start the build again.";
    return { phase: null, gates: null, stage: null, code: 2, passed: false, problems: [said], waiting: false, said, tests_fixed: false, done: false, old_kit: true };
  }
  const gates = d.gates && typeof d.gates === "object" ? Object.fromEntries(GATES.map((g) => [g, Array.isArray(d.gates[g]) ? d.gates[g].map(String) : []])) : null;
  const done = d.code === 0 && d.passed === true;
  const stage = done ? null : d.phase === "spec" ? "requirements" : d.phase === "build" ? (GATES.find((g) => gates?.[g]?.length) ?? null) : null;
  return { phase: d.phase ?? null, gates, stage, code: d.code, passed: d.passed === true, problems: Array.isArray(d.problems) ? d.problems.map(String) : [], waiting: d.waiting === true, said: words(d.said), tests_fixed: d.tests_fixed === true, done };
}

/**
 * Every stage of the check the folder has passed: requirements once the person
 * approved the spec (the lock file), every gate once the build has passed, and
 * before that each gate the last check found nothing missing at.
 */
export function passedStages(folder, check = null) {
  let gates = {};
  try { gates = JSON.parse(readFileSync(join(folder, "build.lock.json"), "utf8")).gates ?? {}; } catch { gates = {}; }
  if (!gates.spec?.passed) return [];
  if (gates.build?.passed) return [...CHECK_STAGES];
  return ["requirements", ...(check?.gates ? GATES.filter((g) => !check.gates[g].length) : [])];
}

/** The questions only the person can answer: the check names each by its key, under the gate it is at. */
export function questionsOf(problems = []) {
  const out = [];
  for (const p of problems) {
    const m = /^(?:[A-Z][\w' ]*: )?the person has not answered ([a-z0-9-]+): (.+?) Ask them, and put their answer in answers\.json under \1(?: with their words.*)?$/s.exec(String(p));
    if (m) out.push({ key: m[1], question: words(m[2]) });
  }
  return out;
}

/** What the harness is asked each round: the folder's own instructions, and what the check said last. */
export function builderPrompt(check) {
  return `Follow AGENTS.md in this folder: build the agent from the approved spec, in whatever order works best, running \`node .adlc/check.mjs\` after each change, until it says the build has passed. Never run approve.mjs, and never change the approved spec, the tests once they are fixed, said.md, or anything under .adlc/. Where only the person can decide, stop and say what to ask them.${lastSaid(check)}\n`;
}

/**
 * One round: your harness in the folder, then the folder's check.
 * Resolves to { stopped, harness, check }.
 */
export async function builderRound({ folder, adlc, harness, round, check = null, minutes = 30, env, envRemove = [], signal, log, prompt: asked = null }) {
  const prompt = asked ?? builderPrompt(check);
  // The prompts are Product Factory's, not the person's: the plugin keeps none of them in
  // said.md, where writeAnswers keeps the person's own replies.
  const hEnv = { ...withoutEnv(env, envRemove), PF_PROMPT: prompt, PF_WORKSPACE: folder, PF_ROUND: String(round), ADLC_NOT_THE_PERSON: "1" };
  const h = await run(fill(harness, { prompt, workspace: folder, round, plugin: pluginOf(adlc) }), { cwd: folder, env: hEnv, signal, timeoutMs: minutes * 60 * 1000, log });
  if (h.stopped) return { stopped: true };
  const said = h.error ? `Your coding harness could not run: ${h.error}.` : h.timedOut ? `Your coding harness ran past ${minutes} minutes and was stopped.` : h.code !== 0 ? `Your coding harness ended with code ${h.code}.` : "";
  const c = await checkBuild(folder, { env: withoutEnv(env, envRemove), signal });
  return { stopped: Boolean(c.stopped), harness: said, check: c };
}
