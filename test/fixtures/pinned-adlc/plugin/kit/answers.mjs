// The person's answers, and the words each one stands on.
//
// answers.json holds the person's answers by key. The name, the version and
// the price are read from the spec phase, where the person approves the spec
// that carries them. Every other answer (what the agent may reach, what it
// may spend, and each question the architecture record leaves open) comes
// after the approval, so each one carries the person's own words:
//
//   "egress-1": { "answer": "yes", "said": "It reaches one system, the public npm registry" }
//
// and the check finds those words in request.md (what the person asked for,
// fixed when they approved the spec) or in said.md (what they have said
// since, kept by the plugin as they said it, never by the builder). An answer
// whose words are in neither is one the person has not given, and it is
// asked.
//
//   needs: node >= 22
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ANSWERS = "answers.json";
export const SAID = "said.md";
/** The answers read before the spec is approved, from the spec itself. */
export const OF_THE_SPEC = new Set(["name", "version", "price"]);

const trim = (s) => String(s ?? "").trim();
const readText = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
/** Words compared as the person said them, whatever the spacing, case or quotes. */
const plain = (s) => String(s ?? "").toLowerCase().replace(/[‘’“”"'`]/g, "").replace(/\s+/g, " ").trim();

/** The answers as plain values by key: an answer written as
 *  { answer, said } is its answer. */
export function answerValues(answers) {
  const out = {};
  for (const [k, v] of Object.entries(answers ?? {})) out[k] = v && typeof v === "object" && !Array.isArray(v) ? trim(v.answer) : v;
  return out;
}

/** What is wrong with the words under each answer given after the spec:
 *  none given, or words the person did not say. */
export function saidProblems(answers, { request = "", said = "" } = {}) {
  const heard = plain(`${request}\n${said}`);
  const out = [];
  for (const [k, v] of Object.entries(answers ?? {})) {
    if (OF_THE_SPEC.has(k)) continue;
    const words = v && typeof v === "object" && !Array.isArray(v) ? trim(v.said) : "";
    if (!words) {
      out.push(`${ANSWERS}: ${k} has no words from the person under it. Write it as {"answer": ..., "said": "<their words, exactly>"}, quoting request.md or what they told you since (${SAID}); if they have not said it, ask them and wait`);
    } else if (!heard.includes(plain(words))) {
      out.push(`${ANSWERS}: the words under ${k} are not in request.md or ${SAID}, so the person has not said them. Quote them exactly, or ask the person and wait`);
    }
  }
  return out;
}

/** The folder's answers: their values, and what is wrong with their words. */
export function answersOf(dir) {
  let answers = {};
  try { answers = JSON.parse(readFileSync(join(dir, ANSWERS), "utf8")) ?? {}; } catch { answers = {}; }
  return {
    values: answerValues(answers),
    problems: saidProblems(answers, { request: readText(join(dir, "request.md")), said: readText(join(dir, SAID)) }),
  };
}
