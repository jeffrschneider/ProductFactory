// Conformance, the open-source way: the checks of the Common Agent
// Specification (0.41.0) that programs run with node and no network, run on
// the package that was deployed. The reference conformance checker and agent
// auditor need a platform and Python, so they do not run here. Section 14 says
// the floor and the documents are checked mechanically, by programs that need
// no network; these are two of them:
//
//   package    the package's mechanical checks of Section 12.10, by the packer's own
//              validate command (@common-agent/package, or the packer you name)
//   agentdoc   the package AgentDoc's static checks of Section 9.10 (Section 13.4 says
//              a package AgentDoc is assembled from the package alone), by
//              @common-agent/agentdoc, when the build carries one
//
// Three checks need the running agent, and the runtime you bring holds it, so
// they are named as not checked, never passed: the bound, signed Descriptor it
// serves (Section 4.9), the five questions answered from it (Section 4.3), and
// trials (Section 7.7). Nothing here signs: Product Factory holds no key.
//
//   checkConformance({ base, archive, agentdoc, packer, env, signal })
//     resolves to { passed, checks, words, file }: each check { id, section, name,
//     result: passed | failed | not_checked, words }, the attestation's words, and
//     the attestation (attestation.md, Markdown with a header) written in base

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { check as checkAgentDoc } from "@common-agent/agentdoc";
import { run, lastJson, tail } from "./exec.mjs";

/** The version of the Common Agent Specification the checks are read in. */
export const VERSION = "0.41.0";
export const STANDARD = `Common Agent ${VERSION}`;
export const ATTESTATION_FORMAT = "product-factory-conformance-v1";
export const ATTESTATION_FILE = "attestation.md";

const words = (s) => String(s ?? "").trim();
const said = (i) => (typeof i === "string" ? i : words(i?.message ?? i?.said ?? JSON.stringify(i)));
const lower = (s) => `${s[0].toLowerCase()}${s.slice(1)}`;
const some = (list, n = 8) => `${list.slice(0, n).join("; ")}${list.length > n ? `; and ${list.length - n} more` : ""}`;

/** The checks that need the running agent, which the runtime you bring holds. */
export const NEEDS_THE_AGENT = [
  { id: "descriptor-floor", section: "4.9", name: "The served Descriptor", words: "the bound, signed Descriptor the running agent serves, asked of the agent itself (Section 4.9): Product Factory does not run the agent, so it cannot ask it" },
  { id: "five-questions", section: "4.3", name: "The five questions", words: "the five questions, answered from the agent's signed bytes and diffed against what it says (Section 4.3): they are asked of the running agent" },
  { id: "trials", section: "7.7", name: "Trials", words: "trial requests, admitted and refused as the offerings declare (Section 7.7): they are sent to the running agent" },
];

/** The package's mechanical checks (12.10), by the packer's validate command. */
async function packageCheck({ archive, packer, env, signal, log }) {
  const done = await run([...packer, "validate", archive, "--json"], { env, signal, log, timeoutMs: 10 * 60 * 1000 });
  if (done.stopped) return { stopped: true };
  const v = lastJson(done.stdout);
  const issues = (Array.isArray(v?.issues) ? v.issues : []).map(said).filter(Boolean);
  const warnings = (Array.isArray(v?.warnings) ? v.warnings : []).map(said).filter(Boolean);
  const how = `${packer.join(" ")} validate`;
  if (done.error) return { result: "failed", words: `The packer could not run (${how}): ${done.error}.` };
  if (done.code !== 0 || v?.ok !== true) {
    return { result: "failed", words: `${basename(archive)} fails the mechanical checks of Section 12.10 (${how}): ${issues.length ? some(issues) : tail(done.stderr || done.stdout, 400) || `it ended with code ${done.code}`}.` };
  }
  return { result: "passed", words: `${basename(archive)} passes the mechanical checks of Section 12.10 (${how}), with no problem${warnings.length ? ` and ${warnings.length === 1 ? "one warning" : `${warnings.length} warnings`}, which do not fail it: ${some(warnings)}` : ""}.` };
}

/** The package AgentDoc's static checks (9.10), or why they did not run. */
async function agentDocCheck(agentdoc) {
  if (!agentdoc) return { result: "not_checked", why: "the package AgentDoc's static checks (Section 9.10), because the build carries no package AgentDoc (Section 13.4)", words: "The build carries no package AgentDoc (Section 13.4), so the static AgentDoc checks of Section 9.10 had nothing to read." };
  let doc;
  try { doc = JSON.parse(readFileSync(agentdoc, "utf8")); } catch (e) { return { result: "failed", words: `${basename(agentdoc)} is not an AgentDoc that can be read: ${e.message}.` }; }
  const report = await checkAgentDoc(doc);
  const fails = report.findings.filter((f) => f.level === "fail").map((f) => `${f.rule}: ${f.message}`);
  const warns = report.findings.filter((f) => f.level !== "fail").length;
  const how = "@common-agent/agentdoc, its static checks, without fetching the sources";
  if (!report.ok) return { result: "failed", words: `The package AgentDoc ${basename(agentdoc)} fails the checks of Section 9.10 (${how}): ${some([...new Set(fails)])}.` };
  return { result: "passed", words: `The package AgentDoc ${basename(agentdoc)} passes the static checks of Section 9.10 (${how})${warns ? `, with ${warns === 1 ? "one warning" : `${warns} warnings`}, which do not fail it` : ""}.` };
}

/** The attestation's words: what ran and how it came out, and what did not run, with why. */
export function attestationWords(checks) {
  const ran = checks.filter((c) => c.result !== "not_checked");
  const failed = ran.filter((c) => c.result === "failed");
  const first = failed.length
    ? `The package fails ${failed.length === 1 ? "one" : failed.length} of the ${STANDARD} checks that ran here: ${failed.map((c) => `${lower(c.name)} (Section ${c.section})`).join(" and ")}.`
    : `The package passes every ${STANDARD} check that ran here: ${ran.map((c) => `${lower(c.name)} (Section ${c.section})`).join(" and ")}, run with node and no network as Section 14 allows.`;
  const notRun = checks.filter((c) => c.result === "not_checked");
  const rest = notRun.length ? ` Not checked: ${notRun.map((c) => c.why ?? c.words.replace(/\.$/, "")).join("; ")}. The runtime you bring holds the agent, so the checks that need the running agent are its to run.` : "";
  return `${first}${rest} Product Factory holds no key, so this attestation is not signed.`;
}

/** The attestation as Markdown: a header a program reads, then a section per kind of result. */
export function attestationText({ checks, archive, sha256 = null, name, version, at }) {
  const verdict = checks.some((c) => c.result === "failed") ? "failed" : "passed";
  const line = (c) => `- **${c.name}** (Section ${c.section}): ${c.result.replace("_", " ")}. ${c.words}`;
  return [
    "---",
    `attestation: ${ATTESTATION_FORMAT}`,
    `standard: ${JSON.stringify(STANDARD)}`,
    `agent: ${JSON.stringify(`${name} ${version}`)}`,
    `package: ${JSON.stringify(basename(archive))}`,
    ...(sha256 ? [`sha256: ${sha256}`] : []),
    `verdict: ${verdict}`,
    `checked_at: ${at}`,
    "signed: no",
    "checks:",
    ...checks.map((c) => `  - { id: ${c.id}, section: "${c.section}", result: ${c.result} }`),
    "---",
    "",
    `# Conformance attestation: ${name} ${version}`,
    "",
    attestationWords(checks),
    "",
    "## Checks that ran",
    "",
    ...checks.filter((c) => c.result !== "not_checked").map(line),
    "",
    "## Not checked",
    "",
    ...checks.filter((c) => c.result === "not_checked").map(line),
    "",
  ].join("\n");
}

export async function checkConformance({ base, archive, agentdoc = null, packer, env, signal, name, version, sha256 = null, at = new Date().toISOString() }) {
  mkdirSync(base, { recursive: true });
  const pkg = await packageCheck({ archive, packer, env, signal, log: join(base, "run.log") });
  if (pkg.stopped) return { stopped: true };
  const doc = await agentDocCheck(agentdoc && existsSync(agentdoc) ? agentdoc : null);
  const checks = [
    { id: "package", section: "12.10", name: "The package", ...pkg },
    { id: "package-agentdoc", section: "9.10", name: "The package AgentDoc", ...doc },
    ...NEEDS_THE_AGENT.map((c) => ({ ...c, why: c.words, result: "not_checked", words: `${c.words[0].toUpperCase()}${c.words.slice(1)}.` })),
  ];
  const file = join(base, ATTESTATION_FILE);
  writeFileSync(file, attestationText({ checks, archive, sha256, name, version, at }));
  return { passed: !checks.some((c) => c.result === "failed"), checks, words: attestationWords(checks), file };
}
