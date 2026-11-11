// One builder (make-a-new-agent.txt v4, the reference make-a-new-agent v2 as
// published): build-the-agent is held by your coding harness with the ADLC
// plugin, from the approved spec through the code, in one build folder. Product
// Factory decides nothing about the agent itself: each stage passes when the
// folder's own ADLC check (`node .adlc/check.mjs --json`) says it does, and the
// person's approvals are pressed in the console, which runs the folder's
// approve.mjs (binding: the assistant's hook stops it from running it).
//
//   startFolder({ folder, adlc, request })            the folder for a builder that writes the spec: the plugin kit and request.md
//   addChanges(folder, said)                           the person's later words, added to request.md under a dated heading
//   specPrompt(check)                                  what the harness is asked at Requirements
//   layOut({ folder, adlc, request, spec, answers })   the folder, with the plugin kit, the person's words, the approved spec and the person's answers
//   approveSpec(folder)                                the person's approval of the spec, pressed in the console: approve.mjs
//   checkBuild(folder)                                 the check's answer, as JSON: { stage, code, passed, problems, waiting, said }
//   sendBack(folder, stage)                            the person's send back to a stage of the folder: approve.mjs --send-back
//   builderRound({ ... })                              one round of your harness in the folder, then the check
//   questionsOf(problems)                              the questions only the person can answer, out of the check's problems
//
// The folder's stages are the ADLC check's: requirements, architecture, files
// (the agent's own files), test and code. ADLC_STAGE_OF maps Product Factory's
// stages of stages.json onto them.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { run, lastJson, tail, withoutEnv } from "./exec.mjs";
import { fill } from "./adapters.mjs";

const NODE = (script, args = []) => [process.execPath, script, ...args];
const words = (s) => String(s ?? "").trim();

/** The ADLC check's stages, in order, and the stage of stages.json each is shown at. */
export const CHECK_STAGES = ["requirements", "architecture", "files", "test", "code"];
export const STAGE_OF_CHECK = { requirements: "requirements", architecture: "architecture", files: "architecture", test: "test", code: "code" };
/** The stage of the folder a send back to a stage of stages.json reopens. */
export const ADLC_STAGE_OF = { requirements: "requirements", architecture: "architecture", test: "test", code: "code" };

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
  writeFileSync(p, `${was}\n${CHANGES_HEADING} (${at.slice(0, 10)})\n\n${words(said)}\n`);
}

/** What the harness is asked at Requirements: write or revise the spec until the check says it waits on the person. */
export function specPrompt(check) {
  const said = check?.problems?.length ? `\n\nThe check says, at ${check.stage}:\n${check.problems.map((p) => `- ${p}`).join("\n")}` : "";
  return `Follow AGENTS.md in this folder, from Requirements: write spec.json from the person's words in request.md (and any changes they asked for at its end), running \`node .adlc/check.mjs\` after each change, until it says Requirements is ready for the person. Then stop. Never run approve.mjs. Where only the person can decide, put the question in the spec's open list and stop.${said}\n`;
}

/** answers.json, with these answers over the ones already there. */
export function writeAnswers(folder, answers = {}) {
  const at = join(folder, "answers.json");
  let kept = {};
  try { kept = JSON.parse(readFileSync(at, "utf8")); } catch { kept = {}; }
  writeFileSync(at, `${JSON.stringify({ ...kept, ...answers }, null, 2)}\n`);
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

/** The person's send back of the folder to one of its stages. Resolves to { ok, reply }. */
export async function sendBack(folder, stage, { env, signal } = {}) {
  const to = ADLC_STAGE_OF[stage];
  if (!to) return { ok: false, reply: `${stage} is not a stage the build folder has.` };
  const r = await folderCommand(folder, "approve.mjs", ["--send-back", to], { env, signal, timeoutMs: 60_000 });
  return { ok: r.code === 0, reply: r.out || `approve.mjs ended with code ${r.code}.` };
}

/**
 * The folder's check, as JSON. A check that did not answer JSON is a check
 * that could not run, said in its own words, and passes nothing.
 */
export async function checkBuild(folder, { env, signal, log } = {}) {
  const r = await folderCommand(folder, "check.mjs", ["--json"], { env, signal, log });
  if (r.stopped) return { stopped: true, stage: null, code: null, passed: false, problems: [], said: "It was stopped." };
  const d = r.doc;
  if (!d || typeof d !== "object") return { stage: null, code: r.code ?? 1, passed: false, problems: [r.out || "The check could not run."], said: r.out || "The check could not run." };
  return { stage: d.stage ?? null, code: d.code, passed: d.passed === true, problems: Array.isArray(d.problems) ? d.problems.map(String) : [], waiting: d.waiting === true, said: words(d.said), next: d.next ?? null, done: d.code === 0 && d.stage === null };
}

/** Every stage the folder has passed, from its pin file. */
export function passedStages(folder) {
  try { return Object.keys(JSON.parse(readFileSync(join(folder, "build.lock.json"), "utf8")).gates ?? {}); } catch { return []; }
}

/** The questions only the person can answer: the check names each by its key. */
export function questionsOf(problems = []) {
  const out = [];
  for (const p of problems) {
    const m = /^the person has not answered ([a-z0-9-]+): (.+?) Ask them, and put their answer in answers\.json under \1$/s.exec(String(p));
    if (m) out.push({ key: m[1], question: words(m[2]) });
  }
  return out;
}

/** What the harness is asked each round: the folder's own instructions, and what the check said last. */
export function builderPrompt(check) {
  const said = check?.problems?.length ? `\n\nThe check says, at ${check.stage}:\n${check.problems.map((p) => `- ${p}`).join("\n")}` : "";
  return `Follow AGENTS.md in this folder: build the agent from the approved spec, stage by stage, running \`node .adlc/check.mjs\` after each change, until it says every stage has passed. Never run approve.mjs, and never change a pinned file or anything under .adlc/. Where only the person can decide, stop and say what to ask them.${said}\n`;
}

/**
 * One round: your harness in the folder, then the folder's check.
 * Resolves to { stopped, harness, check }.
 */
export async function builderRound({ folder, adlc, harness, round, check = null, minutes = 30, env, envRemove = [], signal, log, prompt: asked = null }) {
  const prompt = asked ?? builderPrompt(check);
  const hEnv = { ...withoutEnv(env, envRemove), PF_PROMPT: prompt, PF_WORKSPACE: folder, PF_ROUND: String(round) };
  const h = await run(fill(harness, { prompt, workspace: folder, round, plugin: pluginOf(adlc) }), { cwd: folder, env: hEnv, signal, timeoutMs: minutes * 60 * 1000, log });
  if (h.stopped) return { stopped: true };
  const said = h.error ? `Your coding harness could not run: ${h.error}.` : h.timedOut ? `Your coding harness ran past ${minutes} minutes and was stopped.` : h.code !== 0 ? `Your coding harness ended with code ${h.code}.` : "";
  const c = await checkBuild(folder, { env: withoutEnv(env, envRemove), signal });
  return { stopped: Boolean(c.stopped), harness: said, check: c };
}
