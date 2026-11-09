// A stand-in coding harness for the fix loop on a pull request. It runs in
// the round's build folder, as a harness does, and does what the mode in the
// file PF_FIX_MODE_FILE says (fix when there is none), so a test can change
// it between rounds:
//
//   fix       the wrong scripts/count.mjs, unless the prompt carries the gate's
//             findings (the failing test, by name), and then the right one
//   never     a wrong one, every round, each a little different
//   idle      nothing at all
//   conflict  records/conflict.md, saying a test contradicts the spec
//   security  the right one, marked TODO-SECURITY, which the stand-in security reviewer refuses
//   outside   as fix, and also a changed test, a new notes.txt and a file under records/
//   sleep     says it started, then waits until it is stopped
//
// Each call is appended to PF_STUB_LOG, so the tests can see what it was given.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const WRONG = "export function count() { return 0; }\n";
const RIGHT = "export function count(text) { return String(text).split(/\\s+/).filter(Boolean).length; }\n";
const prompt = process.argv[2] ?? "";
const modeFile = process.env.PF_FIX_MODE_FILE;
const mode = modeFile && existsSync(modeFile) ? readFileSync(modeFile, "utf8").trim() : "fix";
const findings = /The tests did not pass/.test(prompt) && /counts the words in a passage/.test(prompt);
const log = process.env.PF_STUB_LOG;
if (log) {
  appendFileSync(log, `${JSON.stringify({
    mode, prompt, cwd: process.cwd(), round: process.env.PF_ROUND, feedback: process.env.PF_FEEDBACK_FILE,
    same_prompt: process.env.PF_PROMPT === prompt, agents_md: existsSync("AGENTS.md"),
    token: "PF_T_GITHUB_TOKEN" in process.env, anthropic_key: "ANTHROPIC_API_KEY" in process.env,
  })}\n`);
}
if (mode === "sleep") {
  setTimeout(() => writeFileSync("scripts/count.mjs", RIGHT), 120_000);
} else if (mode === "idle") {
  console.log("Nothing to do.");
} else if (mode === "conflict") {
  mkdirSync("records", { recursive: true });
  writeFileSync("records/conflict.md", "The suite never says what an empty passage counts as.\n");
  console.log("A test contradicts the spec; I wrote records/conflict.md.");
} else {
  const right = mode !== "never" && (findings || mode === "security");
  writeFileSync("scripts/count.mjs", mode === "security" ? `${RIGHT}// TODO-SECURITY: sends the passage on\n` : right ? RIGHT : mode === "never" ? `${WRONG}// round ${process.env.PF_ROUND}\n` : WRONG);
  if (mode === "outside") {
    writeFileSync("test/count.test.mjs", "// the test, emptied\n");
    writeFileSync("notes.txt", "a note\n");
    mkdirSync("records", { recursive: true });
    writeFileSync("records/account.md", "Wrote scripts/count.mjs.\n");
  }
  console.log(right ? "Fixed scripts/count.mjs from the gate's findings." : "Wrote scripts/count.mjs.");
}
