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
// The product's boss (boss.mjs): it reads the person's words for what kind of message they are.
//   "what did you commit"       commitments
//   "approve" / "accept"        gate: asked to answer a gate
//   "edit the statement"        edit: asked to change an artifact itself
//   "price" / "pay"             limit, as is "without asking"
//   "drop" / "withdraw"         drop the newest routed directive
//   "test" and "should"         route to Test, the directive with its constraint
//   "somewhere"                 ask: no single stage owns it
//   "also" / "change what"      plan: a change to the statement
//   otherwise                   an answer quoting where the record says the build is
if (/^You are the boss of the product /.test(prompt)) {
  const out = (o) => console.log(JSON.stringify({ ok: true, text: JSON.stringify(o), model: process.env.MODEL_NAME, protocol: process.env.MODEL_PROTOCOL }));
  const newest = /^- (\S+), build (\S+): ([^\n]*?)\. Started/m.exec(prompt);
  if (/what did you commit/i.test(said)) out({ kind: "commitments", answer: "" });
  else if (/\b(approve|accept)\b/i.test(said)) out({ kind: "gate", answer: "I will not." });
  else if (/edit the statement/i.test(said)) out({ kind: "edit", answer: "", change: said });
  else if (/\b(price|pay)\b|without asking/i.test(said)) out({ kind: "limit", answer: "" });
  else if (/\b(drop|withdraw)\b/i.test(said)) out({ kind: "drop", answer: "", drop: [] });
  else if (/\bsomewhere\b/i.test(said)) out({ kind: "ask", answer: "Which stage owns that: Requirements or Test?" });
  else if (/\btests?\b/i.test(said) && /\bshould\b/i.test(said)) out({ kind: "route", stage: "test", directive: `Add a test: ${said}`, answer: "That is the test writer's." });
  else if (/\balso\b|change what/i.test(said)) out({ kind: "plan", statement_change: true, change: said, answer: "That changes what the agent does.", plan: [{ stage: "requirements", words: "The spec writer revises the statement to say it." }, { stage: "test", words: "The test writer adds cases for it." }] });
  else out({ kind: "answer", answer: newest ? `From the record: ${newest[1]} (build ${newest[2]}) is ${newest[3]}.` : "The record does not say." });
  process.exit(0);
}
const files = [...prompt.matchAll(/^File (\S+):$/gm)].map((m) => m[1]);
const change = /\bchange\b/i.test(said) ? said.replace(/^please\s+/i, "") : null;
const answer = change
  ? `I would make this change: ${said}`
  : `You asked: ${said} I read ${files.length ? files.join(", ") : "no files"}.`;
console.log(JSON.stringify({ ok: true, text: JSON.stringify({ answer, change }), model: process.env.MODEL_NAME, protocol: process.env.MODEL_PROTOCOL }));
