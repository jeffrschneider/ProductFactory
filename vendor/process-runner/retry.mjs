// The retry policy (0.20.0; docs/runner-retry-plan.md, owner 2026-10-07).
//
// A step that fails for a reason that may not happen again is tried again,
// here and nowhere else: the agents keep no retries of their own. Whether a
// failure is worth another try is the agent's own word, the label its host
// puts at the end of the reply:
//
//   Retry: could help (model-output, check scene-layouts).
//   Retry: will not help (input).
//
// The host's own sentences for a job that ended with nothing say it too: "I
// could not finish this job: I ran out of time" is a time-out, "... and have
// no answer to give" a crash. Both could go another way.
//
// How many times is the run config's rule `retry.attempts` (default 1, at
// most 3), counted from the phase's last fresh send. A model's answer that
// failed a check is tried once more for that check: the same check failing
// again means another try will not change it.
//
// A retry is never a blind rerun: its work message names the earlier
// attempt's job and what went wrong (retryLine), and the agent reuses what
// that attempt was already answered and fixes only what broke.
//
//   needs: node >= 22; pure
//
// Two budgets (0.21.0, owner 2026-10-08). A failure is the model's (its
// answer failed a check) or the infrastructure's (a storage write, a
// time-out, a crashed container, a busy or failing model service, the
// network). Each has its own allowance, counted apart: retry.attempts for
// the model's answer (default 1), retry.infrastructure_attempts for the
// infrastructure (default 2), each at most 3. A storage glitch on a retry no
// longer spends the try a failed check was owed, which is how
// run_4e504339e7a5b283b5 stopped on dev.
export const DEFAULT_RETRIES = 1;
export const DEFAULT_INFRA_RETRIES = 2;
export const MAX_RETRIES = 3;
// fetch (0.23.0): a holder delivered and its files could not be fetched, by
// the host and then by this runner through the platform (refetch.mjs). The
// runner puts this label on the attempt itself; no holder writes it.
export const KINDS = ["input", "setting", "model-output", "model-service", "internal", "timeout", "crashed", "storage", "network", "fetch"];
/** The failures that are the infrastructure's, not the model's. */
export const INFRA_KINDS = ["model-service", "timeout", "crashed", "storage", "network", "fetch"];

/**
 * Which budget a failure counts against: "model" for a model's answer that
 * failed a check, "infrastructure" for the infrastructure's, null for a
 * failure no retry can help. A retryable label of any other kind counts
 * against the model's budget, the stricter one.
 */
export function budgetOf(label) {
  if (!label?.retryable) return null;
  return INFRA_KINDS.includes(label.kind) ? "infrastructure" : "model";
}

const LINE = /^Retry:\s*(could help|will not help)\s*\(([a-z-]+)(?:,\s*check\s+([a-z0-9-]+))?\)\.?\s*$/i;
const TIMED_OUT = /^I could not finish this job: I ran out of time\b/i;
const NO_ANSWER = /^I could not finish this job and have no answer to give\b/i;

/**
 * The label a reply carries, and its words without it: { label, text }. The
 * label line is the reply's last line that is not blank; label is null when
 * the reply carries none and is not one of the host's own sentences for a
 * job that ended with nothing.
 */
export function readRetryLabel(text) {
  const raw = String(text ?? "");
  const lines = raw.split(/\r?\n/);
  let last = lines.length - 1;
  while (last >= 0 && !lines[last].trim()) last--;
  const m = last >= 0 ? LINE.exec(lines[last].trim()) : null;
  if (m) {
    const kind = KINDS.includes(m[2].toLowerCase()) ? m[2].toLowerCase() : "internal";
    const label = { retryable: /could/i.test(m[1]), kind, ...(kind === "model-output" && m[3] ? { check: m[3].toLowerCase() } : {}) };
    return { label, text: lines.slice(0, last).join("\n").trimEnd() }; // cut-ok: only the label line is taken off, and it is kept as the label
  }
  const opening = raw.trim();
  if (TIMED_OUT.test(opening)) return { label: { retryable: true, kind: "timeout" }, text: raw };
  if (NO_ANSWER.test(opening)) return { label: { retryable: true, kind: "crashed" }, text: raw };
  return { label: null, text: raw };
}

/** The run's retry limit: its run config's retry.attempts, else the default; never past the cap. */
export function retryLimit(state) {
  const v = state?.run_config?.retry_attempts;
  return Number.isInteger(v) && v >= 0 ? Math.min(v, MAX_RETRIES) : DEFAULT_RETRIES;
}

/** The run's infrastructure allowance: its run config's retry.infrastructure_attempts, else the default; never past the cap. */
export function infraLimit(state) {
  const v = state?.run_config?.infra_attempts;
  return Number.isInteger(v) && v >= 0 ? Math.min(v, MAX_RETRIES) : DEFAULT_INFRA_RETRIES;
}

/** The attempts of a phase since its last fresh send: the last one first back to the one that opened it. */
function sinceOpening(p) {
  const all = Array.isArray(p?.attempts) ? p.attempts : [];
  let i = all.length - 1;
  while (i > 0 && all[i - 1]?.retried) i--;
  return all.slice(i);
}

/**
 * Whether a phase that just refused is tried again: { retry: true, attempt,
 * of } or { retry: false, why } in words. Read after the refusal is recorded
 * as the phase's latest attempt.
 */
export function retryDecision(state, phaseId) {
  const p = state?.phases?.[phaseId];
  const tries = sinceOpening(p);
  const now = tries[tries.length - 1];
  const label = now?.label ?? null;
  // The most attempts a phase can take: the first, and both allowances.
  const of = 1 + retryLimit(state) + infraLimit(state);
  if (!now || now.outcome !== "refused") return { retry: false, why: "the phase did not refuse" };
  if (!label) return { retry: false, why: "the reply did not say whether another try could help" };
  if (!label.retryable) return { retry: false, why: `its holder said another try will not help (${label.kind})` };
  if (label.kind === "model-output") {
    const before = tries.slice(0, -1).reverse().find((t) => t.label?.kind === "model-output");
    if (before && (before.label.check ?? null) === (label.check ?? null)) {
      return { retry: false, why: `the same check failed again (${label.check ?? "the model's answer"}), so another try will not change it` };
    }
  }
  // Each budget counts only its own failures since the phase's last fresh send.
  const budget = budgetOf(label);
  const limit = budget === "infrastructure" ? infraLimit(state) : retryLimit(state);
  const what = budget === "infrastructure" ? "the infrastructure failed" : "the model's answer failed a check";
  const after = budget === "infrastructure" ? "an infrastructure failure" : "the model's answer fails a check";
  const used = tries.filter((t) => t.outcome === "refused" && budgetOf(t.label) === budget).length;
  if (used > limit) {
    return { retry: false, why: limit ? `${what} ${used} times, more than the ${limit} extra attempt${limit === 1 ? "" : "s"} this run allows for it` : `this run allows no extra attempts after ${after}` };
  }
  return { retry: true, attempt: tries.length + 1, of };
}

/** How a label reads in words: "the model's answer failed its check scene-layouts". */
export function labelWords(label) {
  if (!label) return "it did not say why";
  switch (label.kind) {
    case "model-output": return `the model's answer failed ${label.check ? `its check ${label.check}` : "a check"}`;
    case "model-service": return "the model service was busy or did not answer";
    case "timeout": return "it ran out of time";
    case "crashed": return "it stopped with no answer";
    case "storage": return "saving a file to storage failed";
    case "network": return "the network failed";
    case "fetch": return "its delivered files could not be fetched";
    case "input": return "what it was handed could not be used";
    case "setting": return "a setting it needs could not be used";
    default: return "it failed inside the agent";
  }
}

/**
 * The line a retry's work message carries under its first line: which job
 * it retries, which attempt this is, and what went wrong, in the holder's
 * own words.
 */
export function retryLine({ job, attempt, of, label, said }) {
  const words = String(said ?? "").replace(/\s+/g, " ").trim();
  return `retry of job: ${job ?? "unknown"} (attempt ${attempt} of at most ${of}; the earlier attempt failed: ${label?.kind ?? "unknown"}${label?.check ? `, check ${label.check}` : ""}${words ? `: ${words}` : ""})`;
}

/** A work message with the retry line under its first line. */
export function withRetryLine(text, line) {
  if (!line) return text;
  const at = String(text).indexOf("\n");
  return at < 0 ? `${text}\n${line}` : `${text.slice(0, at)}\n${line}${text.slice(at)}`; // cut-ok: the text is split at its first line and put back whole around the retry line
}
