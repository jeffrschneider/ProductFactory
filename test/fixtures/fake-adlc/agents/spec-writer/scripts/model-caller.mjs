// A stand-in for the reference agents' shared model caller (model-caller.mjs):
// the same command line (PROMPT_FILE, the four model settings), no model and
// no network. It answers from the prompt it was given, so a test can see what
// the agent was told:
//
//   the person's words name "MODEL-FAILS"   it answers { ok: false } as a failed call does
//   they ask for a change ("change")        an answer, and the change in "change"
//   otherwise                               an answer naming the files it was shown
//
// It prints one JSON object, as the real caller does: { ok, text, model, protocol }.
import { readFileSync } from "node:fs";

if (!process.env.PROMPT_FILE) { console.error("PROMPT_FILE is required"); process.exit(2); }
for (const k of ["MODEL_NAME", "MODEL_ENDPOINT", "MODEL_PROTOCOL"]) {
  if (!process.env[k]) { console.log(JSON.stringify({ ok: false, error: `${k} is not set` })); process.exit(1); }
}
const prompt = readFileSync(process.env.PROMPT_FILE, "utf8");
const said = prompt.split("The person says:\n").pop().trim();
if (/MODEL-FAILS/.test(said)) {
  console.log(JSON.stringify({ ok: false, error: "the model service at model.example answered 503: busy", status: 503 }));
  process.exit(1);
}
const files = [...prompt.matchAll(/^File (\S+):$/gm)].map((m) => m[1]);
const change = /\bchange\b/i.test(said) ? said.replace(/^please\s+/i, "") : null;
const answer = change
  ? `I would make this change: ${said}`
  : `You asked: ${said} I read ${files.length ? files.join(", ") : "no files"}.`;
console.log(JSON.stringify({ ok: true, text: JSON.stringify({ answer, change }), model: process.env.MODEL_NAME, protocol: process.env.MODEL_PROTOCOL }));
