// The start-up check: what in the settings will stop a build, in plain notes,
// printed when Product Factory starts and by `product-factory check`.
//
//   startupNotes(config, env)   { notes, info }: the model settings that are
//                               missing, whether the adlc checkout is there
//                               and at the commit standards/ADLC.json pins,
//                               whether the harness command is on PATH, and
//                               whether the repository token is set when one
//                               builder works on a pull request (and the same for
//                               issue intake and webhook notices)
//   checkModel(config, env)     one tiny real call to the model endpoint through
//                               the reference agents' shared model caller, and
//                               what came back, in words
//
// Nothing here prints or returns a key: the model key is read only to hand it
// to the caller, and any words that come back have it taken out.

import { existsSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { modelEnv } from "./config.mjs";
import { findProgram, run, lastJson } from "./exec.mjs";
import { modelCallerIn } from "./thread.mjs";
import { ADLC_PIN } from "./standards.mjs";
import { execFileSync } from "node:child_process";

/** The commit an adlc checkout is at, or null when git cannot say or the folder is not a checkout of its own. */
export function adlcCommit(dir) {
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    const top = git("rev-parse", "--show-toplevel");
    if (resolve(top).toLowerCase() !== resolve(dir).toLowerCase()) return null;
    return git("rev-parse", "HEAD") || null;
  } catch { return null; }
}

const isSet = (env, name) => Boolean(String(env[name] ?? "").trim());

/** The notes for these settings and this environment: { notes, info }. */
export function startupNotes(config, env = process.env) {
  const notes = [];
  const info = [];
  const { missing } = modelEnv(config, env);
  if (missing.length) notes.push(`The model settings are read from ${missing.join(", ")}, which ${missing.length === 1 ? "is" : "are"} not set, so Requirements and Test will stop and say so.`);

  if (!existsSync(config.adlc)) notes.push(`There is no folder at ${config.adlc}, where "adlc" says the CommonAgent/adlc checkout is, so builds will stop at Requirements. Clone CommonAgent/adlc there, or set "adlc" in ${config.file ?? "product-factory.json"}.`);
  else if (!existsSync(join(config.adlc, "agents", "spec-writer"))) notes.push(`The folder at ${config.adlc} is not a CommonAgent/adlc checkout (it has no agents/spec-writer), so builds will stop at Requirements. Set "adlc" in ${config.file ?? "product-factory.json"}.`);
  else {
    // One pin of the ADLC: the standards copied here, the reference agents and the plugin kit a build folder carries all come from one commit.
    const at = adlcCommit(config.adlc);
    if (at && ADLC_PIN?.commit && at !== ADLC_PIN.commit) notes.push(`The adlc checkout at ${config.adlc} is at ${at.slice(0, 7)}, and this Product Factory is pinned to the ADLC at ${ADLC_PIN.commit.slice(0, 7)} (standards/ADLC.json: stages.json ${ADLC_PIN.stages}, lifecycle API ${ADLC_PIN.lifecycle_api}). Check out that commit there, so the standards, the reference agents and the build folder's check are one version.`);
    if (config.code.holder === "builder" && !existsSync(join(config.adlc, "plugin", "kit", "start.mjs"))) notes.push(`Code is held by one builder, and the adlc checkout at ${config.adlc} has no plugin/kit/start.mjs to lay out its build folder. Check out the pinned commit there.`);
  }

  if (config.code.where === "pull-request") {
    if (!isSet(env, config.repository.token)) notes.push(`One builder works on a pull request on ${config.repository.repo}, and the token is read from ${config.repository.token}, which is not set, so the build will stop and say so.`);
    else info.push(`One builder works on a pull request on ${config.repository.repo}: your own coding assistant builds the agent there, and this machine runs no coding agent. Product Factory checks the pull request for pushes every ${config.repository.poll_seconds} seconds and runs the folder's own check on each.`);
  } else if (!config.code.harness) {
    notes.push(`No coding harness is set, so Code will stop and say so. Set "code.harness" in ${config.file ?? "product-factory.json"}.`);
  } else {
    const program = config.code.harness[0];
    if (program !== "node" && !findProgram(program, env)) notes.push(`The coding harness is "${program}", and it is not on PATH, so Code will stop with "${program} was not found". Install it, or set "code.harness" in ${config.file ?? "product-factory.json"} to a command that is.`);
  }

  if (config.intake) {
    if (!isSet(env, config.repository.token)) notes.push(`Builds start from issues labelled "${config.intake.github_issues.label}" on ${config.repository.repo}, and the token is read from ${config.repository.token}, which is not set, so no issue starts a build until it is.`);
    else info.push(`Open issues labelled "${config.intake.github_issues.label}" on ${config.repository.repo} start builds. Product Factory reads them every ${config.intake.github_issues.poll_seconds} seconds.`);
  }
  for (const t of config.notify) if (t.kind === "webhook" && !isSet(env, t.url_env)) notes.push(`A webhook notice reads its address from ${t.url_env}, which is not set, so that notice will not be sent.`);
  return { notes, info };
}

/** The prompt of the check's one call, and the answer budget it is given. */
export const CHECK_PROMPT = "This is a connection check. Answer with the one word: ready";
export const CHECK_TOKENS = 64;

/** Words with the key taken out, wherever it appears. */
function withoutKey(text, key) {
  let s = String(text ?? "");
  if (key && key.length >= 4) s = s.split(key).join("[key left out]");
  return s;
}

/** What a failed call said, as a person reads it. */
export function failureWords(error, status, { keyVar, model }) {
  const said = String(error ?? "").trim();
  if (/credit balance|insufficient[_ ]quota|exceeded your current quota|billing|purchase credits/i.test(said)) {
    return `The model service refused the call because the account behind the key has no credit: its credit balance is too low. Add credit to that account, or put a key that has credit in ${keyVar}. It said: ${said}`;
  }
  if (/cut at its limit/i.test(said)) return null;
  if (status === 401) return `The model service refused the key in ${keyVar} (401). Check that ${keyVar} holds a key this endpoint accepts. It said: ${said}`;
  if (status === 403) return `The model service refused the call for want of permission (403): the key in ${keyVar} may not use this model or endpoint. It said: ${said}`;
  if (status === 404) return `The model service answered 404: it does not know the model "${model}" or the endpoint's address is wrong. It said: ${said}`;
  if (status === 429 || status === 529) return `The model service is busy or limiting calls (${status}); the settings may be right, so try again shortly. It said: ${said}`;
  if (status === 503) return `The model endpoint could not be reached: ${said}`;
  if (status === 504) return `The model endpoint did not answer in time: ${said}`;
  return `The model call failed: ${said || "the caller gave no reason"}`;
}

/**
 * One tiny real call to the model endpoint through the shared model caller in
 * the adlc checkout. Resolves to { ok, words } and never throws.
 */
export async function checkModel(config, env = process.env, { timeoutMs = 60_000 } = {}) {
  const { env: model, missing } = modelEnv(config, env);
  const keyVar = config.model.key;
  const key = model.MODEL_KEY;
  if (missing.length) return { ok: false, words: `The model was not called: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set.` };
  const caller = existsSync(config.adlc) ? modelCallerIn(config.adlc, "spec-writer") : null;
  if (!caller) return { ok: false, words: `The model was not called: the reference agents' shared model caller (agents/*/scripts/model-caller.mjs) is not in the adlc checkout at ${config.adlc}.` };

  const dir = mkdtempSync(join(tmpdir(), "pf-check-"));
  const promptFile = join(dir, "prompt.txt");
  let got;
  try {
    writeFileSync(promptFile, CHECK_PROMPT);
    got = await run([process.execPath, caller], { cwd: dir, env: { ...env, ...model, PROMPT_FILE: promptFile, MODEL_MAX_OUTPUT_TOKENS: String(CHECK_TOKENS) }, timeoutMs });
  } finally {
    try { unlinkSync(promptFile); } catch { /* not written */ }
    try { rmdirSync(dir); } catch { /* left for the system to clear */ }
  }
  const said = lastJson(got.stdout);
  const where = (() => { try { return new URL(model.MODEL_ENDPOINT).host; } catch { return model.MODEL_ENDPOINT; } })();
  const named = `${model.MODEL_NAME} over ${model.MODEL_PROTOCOL} at ${where}`;
  if (said?.ok) {
    const text = String(said.text ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    return { ok: true, words: withoutKey(`The model answered (${named}): "${text}". The model settings work.`, key) };
  }
  if (!said) {
    const why = got.timedOut ? `it did not finish within ${Math.round(timeoutMs / 1000)} seconds` : got.error ? got.error : `it ended with code ${got.code} and printed no answer`;
    return { ok: false, words: withoutKey(`The model caller could not run: ${why}.`, key) };
  }
  const words = failureWords(said.error, Number(said.status) || null, { keyVar, model: model.MODEL_NAME });
  if (words === null) return { ok: true, words: withoutKey(`The model answered (${named}), cut at the ${CHECK_TOKENS}-token limit this check sets. The model settings work.`, key) };
  return { ok: false, words: withoutKey(`${words} (${named})`, key) };
}
