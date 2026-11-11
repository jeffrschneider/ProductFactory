// A stand-in for check-record.mjs: writes record.md in the record's own form
// (architecture-record-v1: the header, then the fixed headings), still-open.md
// when a question is open, and checks.json.
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const { ASKED, NAMED, BOUND, RECORDS } = process.env;
if (!ASKED || !NAMED || !BOUND || !RECORDS) { console.error("ASKED, NAMED, BOUND and RECORDS are required"); process.exit(2); }
const asked = JSON.parse(readFileSync(ASKED, "utf8"));
const named = JSON.parse(readFileSync(NAMED, "utf8"));
const bound = JSON.parse(readFileSync(BOUND, "utf8"));
const envs = ["dev", "test", "production"];
const q = named.questions;
const done = q.length === 0;
const statement = String(asked.statement).replace(/\s+/g, " ").trim().slice(0, 240);
const head = [
  "record: architecture-record-v1",
  `statement: ${JSON.stringify(statement)}`,
  `environments: [${envs.join(", ")}]`,
  `kind: ${named.kind}`,
  `done: ${done ? "yes" : "no"}`,
  `questions: ${q.length}`,
  `systems: [${named.systems.join(", ")}]`,
  "bindings:",
  ...named.systems.flatMap((s) => [`  ${s}:`, ...envs.map((e) => `    ${e}: ${bound.bindings[s][e].product} (${bound.bindings[s][e].provided_by})`)]),
].join("\n");
const body = [
  "# Architecture record: an agent",
  "",
  done ? "This record is finished: every system is named and bound in each environment, and every decision has its reason." : "This record is not finished: one question is still open, under Questions.",
  "", "## Statement", "", `> ${statement}`,
  "", "## Systems", "", "- `text-reasoning` (text reasoning), trigger, for text: Counting is code; the reply is a judgment.",
  "", "## Bindings", "", "| System | dev | test | production |", "|---|---|---|---|", "| text-reasoning | platform, platform default | platform, platform default | platform, platform default |",
  "", "## Dependencies", "", "None.",
  "", "## Kind", "", `**${named.kind}**: A short program with one judgment. A harness reading skills carries it.`,
  "", "## Limits", "", `- **Cost**: ${named.limit ?? "not set; asked, because a spending limit is a commitment."}`, "- **Speed**: an answer within 60 seconds. A passage is one pass.", "- **Data**: reads the passage it is sent and keeps nothing.", "- **Trust**: takes work from its owner.",
  "", "## Egress", "", ...envs.map((e) => `- ${e}: the target runs the agent open (it enforces no allowlist today).`), "- None beyond the derived set (its systems, the network, the registrar, the model it is given).",
  "", "## Formats", "", "- It hands back the count as `text/markdown`. A person reads it.",
  "", "## Standing assets", "", "- None, because no output is read by a person.",
  "", "## Settings", "", "No setting beyond the bindings' own.",
  "", "## Decisions", "", "### Decision 1. Bind text-reasoning to platform in dev, test and production", "", "Why: The organization chose no product for text-reasoning, so the platform's default fills each.", "", "Weighed: A model provider of the organization's own.", "", "What follows: The install places the model in the four model settings.",
  "", "## Questions", "", done ? "None. Every system is named and bound in each environment, and every decision has its reason." : q.map((x) => `- ${x.key}: ${x.question}`).join("\n"), "",
].join("\n");
writeFileSync(join(RECORDS, "record.md"), `---\n${head}\n---\n\n${body}`);
if (done) rmSync(join(RECORDS, "still-open.md"), { force: true });
else writeFileSync(join(RECORDS, "still-open.md"), `---\nrecord: architecture-record-v1\nquestions: ${q.length}\n---\n\n## Questions\n\n${q.map((x) => `- ${x.key}: ${x.question}`).join("\n")}\n\n## How to answer\n\nOne line per question, key: answer.\n`);
writeFileSync(join(RECORDS, "checks.json"), JSON.stringify({ done, problems: done ? [] : ["a question is open"] }, null, 2));
console.log(JSON.stringify({ ok: true, code: 0, done }));
