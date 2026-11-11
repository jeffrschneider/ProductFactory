// Each artifact's Common Agent checks (lifecycle API 0.4.13, Artifact.checks):
// which rules of the Common Agent Specification its stage applied, and with
// what result, so the console can show a table of rules per document and a
// tally for the version. Each check is built only from what the stage's own
// records already say. A rule the records do not speak to is left out, never
// passed, and a rule the stage could not apply here is not_checked with why.
//
//   securityChecks(head, { critic, packageDigest })  the security reviewer's record
//   packageChecks(validation, packer)                the packer's validate result
//   attestationChecks(text, packer)                  the conformance attestation
//   statementChecks({ descriptor, requirements, products })  the agent's own files
//   architectureChecks(head)                          the architecture record's header
//
// Nothing here reads or writes a file: artifacts.mjs reads the files and hands
// what it read.

import { SECRETS } from "./fence.mjs";
import { VERSION, NEEDS_THE_AGENT } from "./conformance.mjs";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const words = (s) => String(s ?? "").trim();
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const some = (list, n = 6) => `${list.slice(0, n).join("; ")}${list.length > n ? `; and ${list.length - n} more` : ""}`;
const shortDigest = (d) => (/^sha256:[0-9a-f]{12}/.test(d) ? `${d.slice(0, 19)}…` : d);

/** One check, in the lifecycle API's RuleCheck shape. */
function check(section, asks, result, detail, rule = null) {
  return { standard: "common-agent", version: VERSION, section, ...(rule ? { rule } : {}), asks, result, detail };
}

// ---------- the security record ----------

/** The address warnings under the code critic's ## Warnings heading, one per bullet, or null when it has none. */
export function criticWarnings(doc) {
  const m = /^## Warnings\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(String(doc ?? ""));
  if (!m) return null;
  return m[1].split(/\r?\n/).map((l) => /^-\s+(.+)$/.exec(l.trim())?.[1]).filter(Boolean).map((b) => b.replace(/`/g, ""));
}

/**
 * The security record's checks: every permission with its reason (Section
 * 12.4), from no_reason_recorded; no address in its scripts (Section 12.6,
 * rule 2), from the reviewer's address warnings or the code critic's; and the
 * review naming the archive's digest (Section 12.6, rule 5), from the
 * record's digest and the package the build holds.
 */
export function securityChecks(head, { critic = null, packageDigest = null } = {}) {
  const out = [];
  if (Array.isArray(head.no_reason_recorded)) {
    const missing = head.no_reason_recorded.map((x) => words(isObj(x) ? x.permission ?? x.system ?? JSON.stringify(x) : x)).filter(Boolean);
    const reaches = Array.isArray(head.reaches) ? head.reaches.length : 0;
    const spends = Array.isArray(head.spends) ? head.spends.length : 0;
    out.push(missing.length
      ? check("12.4", "Every permission asked for has a reason", "not_met", `The security reviewer found no recorded reason for ${plural(missing.length, "permission")}: ${some(missing)}.`)
      : check("12.4", "Every permission asked for has a reason", "met", `The security reviewer found a recorded reason for every permission the package asks for (${plural(reaches, "reach", "reaches")}, ${plural(spends, "spend")}).`));
  }
  const fromReviewer = Array.isArray(head.warnings) ? head.warnings.map((w) => (isObj(w) ? `${words(w.file)}, line ${words(w.line)}: ${words(w.address)}` : words(w))).filter(Boolean) : null;
  const fromCritic = criticWarnings(critic);
  if (fromReviewer || fromCritic) {
    const found = [...new Set([...(fromReviewer ?? []), ...(fromCritic ?? [])])];
    const who = fromReviewer && fromCritic !== null ? "The security reviewer's and the code critic's address checks" : fromReviewer ? "The security reviewer's address check" : "The code critic's address check";
    out.push(found.length
      ? check("12.6", "No address in its scripts", "not_met", `${who} found ${plural(found.length, "address", "addresses")} written into the scripts or run commands: ${some(found)}.`, "2")
      : check("12.6", "No address in its scripts", "met", `${who} read the scripts and run commands; none carries an http, https, ws or wss address, or one in 169.254.0.0/16.`, "2"));
  }
  const reviewed = words(head.digest);
  if (reviewed && packageDigest) {
    out.push(reviewed === packageDigest
      ? check("12.6", "The review names the archive's digest", "met", `The review names ${shortDigest(reviewed)}, the digest of the package the build holds.`, "5")
      : check("12.6", "The review names the archive's digest", "not_met", `The review names ${shortDigest(reviewed)}, and the package the build holds is ${shortDigest(packageDigest)}, so the review does not apply to it.`, "5"));
  }
  return out;
}

// ---------- the package ----------

/** What the packer is, and how current its reading of Section 12 is, in one sentence. */
export function packerWords(packer) {
  const cmd = (Array.isArray(packer) ? packer : []).join(" ");
  if (!cmd.includes("@common-agent/package")) return cmd ? `The packer (${(packer ?? [])[0]}) is your own, and the build does not record which version of Section 12 it implements.` : "";
  const version = /@common-agent\/package@([0-9][\w.-]*)/.exec(cmd)?.[1] ?? "0.1.0";
  return version === "0.1.0"
    ? "The packer (@common-agent/package 0.1.0) implements Section 12 as of Common Agent 0.30.0-draft, so this check is only as current as it."
    : `The packer is @common-agent/package ${version}, and the build does not record which version of Section 12 it implements.`;
}

/** The package's check: it validates (Section 12.10), from the packer's validate result the build records. */
export function packageChecks(validation, packer) {
  if (!isObj(validation) || typeof validation.ok !== "boolean") return [];
  const said = (i) => (typeof i === "string" ? i : words(i?.message ?? i?.said ?? JSON.stringify(i)));
  const issues = (Array.isArray(validation.issues) ? validation.issues : []).map(said).filter(Boolean);
  const warnings = (Array.isArray(validation.warnings) ? validation.warnings : []).map(said).filter(Boolean);
  const caveat = packerWords(packer);
  const detail = validation.ok
    ? `The packer's validate found no problem${warnings.length ? `, with ${plural(warnings.length, "warning")}, which do not fail it: ${some(warnings)}` : ""}.`
    : `The packer's validate found ${issues.length ? `${plural(issues.length, "problem")}: ${some(issues)}` : `a problem${validation.said ? `: ${words(validation.said).split(/\r?\n/).pop()}` : ""}`}.`;
  return [check("12.10", "The package validates", validation.ok ? "met" : "not_met", `${detail}${caveat ? ` ${caveat}` : ""}`)];
}

// ---------- the conformance attestation ----------

const ATTESTED = {
  "package": "The deployed package passes the mechanical checks",
  "package-agentdoc": "The package AgentDoc passes the static checks",
  "descriptor-floor": "It serves a bound, signed Descriptor",
  "five-questions": "It answers the five questions from its signed bytes",
  "trials": "It admits and refuses trial requests as its offerings declare",
};
const RESULT = { passed: "met", failed: "not_met", not_checked: "not_checked" };
const RUNTIME_HOLDS = new Set(NEEDS_THE_AGENT.map((c) => c.id));

/**
 * The attestation's checks, one per section it reports: its header gives each
 * check's section and result, and its body the words of what was done.
 */
export function attestationChecks(text, packer = null) {
  const t = String(text ?? "");
  const said = new Map([...t.matchAll(/^- \*\*.+?\*\* \(Section ([0-9.]+)\): (?:passed|failed|not checked)\. (.+)$/gm)].map((m) => [m[1], words(m[2])]));
  const out = [];
  for (const m of t.matchAll(/^\s+-\s+\{\s*id:\s*([a-z0-9-]+),\s*section:\s*"([0-9.]+)",\s*result:\s*([a-z_]+)\s*\}\s*$/gm)) {
    const [, id, section, result] = m;
    if (!RESULT[result]) continue;
    const asks = ATTESTED[id] ?? `Section ${section}`;
    let detail = RUNTIME_HOLDS.has(id) && result === "not_checked" ? "Your runtime holds the agent, so this check is its to run." : said.get(section) ?? "";
    if (id === "package" && result !== "not_checked") detail = `${detail} ${packerWords(packer)}`.trim();
    if (!detail) continue;
    out.push(check(section, asks, RESULT[result], detail));
  }
  return out;
}

// ---------- Design: the agent's own files, and the architecture record ----------

/** Why a system name is not in system words, or null when it is: lowercase words, no address, account or product. */
function notSystemWords(name, products) {
  const n = words(name);
  if (/:\/\/|^\d{1,3}(\.\d{1,3}){3}$/.test(n) || /\.[a-z]{2,}$/i.test(n)) return `${n} is an address`;
  if (/@/.test(n) || /\d{6,}/.test(n)) return `${n} is an account`;
  if (!/^[a-z][a-z0-9-]*$/.test(n)) return `${n} is not lowercase words joined by hyphens`;
  if (products.has(n)) return `${n} is a product the architecture record binds`;
  return null;
}

/**
 * Systems named in system words (Section 12.4): each a lowercase name with no
 * address or account, and none a product. Products are known only from an
 * architecture record's bindings; without one, the name is held to the rest
 * and the product question is said to be open.
 */
function systemWordsCheck(names, products, who) {
  const asks = "Systems named in system words";
  const bad = names.map((n) => notSystemWords(n, products ?? new Set())).filter(Boolean);
  if (bad.length) return check("12.4", asks, "not_met", `In ${who}, ${some(bad)}.`);
  if (!names.length) return check("12.4", asks, "met", `There is no system in ${who}, so there is no name to hold to system words.`);
  const list = names.join(", ");
  if (!products) return check("12.4", asks, "not_checked", `Each system in ${who} (${list}) is lowercase words with no address or account; no architecture record binds products, so whether a name is a product was not checked.`);
  return check("12.4", asks, "met", `Each system in ${who} (${list}) is lowercase words with no address or account, and none is a product the architecture record binds.`);
}

/** The products an architecture record binds, from its header's bindings, lowercased. */
export function productsOf(head) {
  const out = new Set();
  for (const per of Object.values(isObj(head?.bindings) ? head.bindings : {})) for (const b of Object.values(isObj(per) ? per : {})) if (words(b?.product)) out.add(words(b.product).toLowerCase());
  return out;
}

const ADDRESS = /\b(?:https?|wss?):\/\/[A-Za-z0-9[]|(?<![\w.])169\.254\.\d{1,3}\.\d{1,3}(?![\w.])/i;
const ACCOUNT = /\b[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/;

/** Each string in a Descriptor with its path, leaving out the members Section 12.6, rule 3 and Section 6.13.8 allow an address in. */
function stringsOf(v, at = "", out = []) {
  if (typeof v === "string") out.push([at, v]);
  else if (Array.isArray(v)) v.forEach((x, i) => stringsOf(x, `${at}[${i}]`, out));
  else if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) {
      const here = at ? `${at}.${k}` : k;
      // The schema of a can_use entry is a name spelled as an address (Section 12.6, rule 3); an example's public file is at an https address (Section 6.13.8).
      if (/^can_use\[\d+\]\.schema$/.test(here) || /^offerings\[\d+\]\.example\.inputs\.[^.]+\.url$/.test(here)) continue;
      stringsOf(x, here, out);
    }
  }
  return out;
}

/** No credential, key, address or account in the Descriptor (Section 6.4, rule 3). */
function shapesOnlyCheck(descriptor) {
  const all = stringsOf(descriptor);
  const found = [];
  for (const [at, s] of all) {
    for (const [re, what] of SECRETS) if (re.test(s)) found.push(`${at} carries ${what}`);
    if (ADDRESS.test(s)) found.push(`${at} carries an address`);
    if (ACCOUNT.test(s)) found.push(`${at} carries an account`);
  }
  return found.length
    ? check("6.4", "No credential, key, address or account in a declaration", "not_met", `In the draft Descriptor, ${some(found)}.`, "3")
    : check("6.4", "No credential, key, address or account in a declaration", "met", `All ${plural(all.length, "value")} of the draft Descriptor read; none carries a credential value, a key, an address or an account.`, "3");
}

/** An example for each offering a person starts (Section 6.13.8): started_by holds person, or is absent, which offers it to a person (Section 6.13.2). */
function examplesCheck(descriptor) {
  const offerings = (Array.isArray(descriptor.offerings) ? descriptor.offerings : []).filter(isObj);
  const name = (o) => words(o.name) || words(o.id);
  const byPerson = offerings.filter((o) => !Array.isArray(o.started_by) || o.started_by.includes("person"));
  const without = byPerson.filter((o) => !isObj(o.example));
  if (!byPerson.length) return check("6.13.8", "An example for each offering a person starts", "met", offerings.length ? `Every offering says only agents start it, so none must carry an example.` : "It declares no offering, so none must carry an example.");
  if (without.length) {
    const say = without.map((o) => `${name(o)} ${Array.isArray(o.started_by) ? "says a person starts it" : "does not say who starts it, so a person may (Section 6.13.2)"}, and carries no example`);
    return check("6.13.8", "An example for each offering a person starts", "not_met", `${some(say)}.`);
  }
  return check("6.13.8", "An example for each offering a person starts", "met", `${byPerson.map(name).join(", ")}: each offering a person starts carries an example.`);
}

/**
 * The agent's own files: systems in system words (Section 12.4) from the
 * runtime requirements, shapes only (Section 6.4, rule 3) and an example per
 * offering a person starts (Section 6.13.8) from the draft Descriptor. A file
 * the build folder does not hold leaves its checks out.
 */
export function statementChecks({ descriptor = null, requirements = null, products = null } = {}) {
  const out = [];
  if (isObj(requirements) && Array.isArray(requirements.systems)) {
    out.push(systemWordsCheck(requirements.systems.filter(isObj).map((s) => words(s.name ?? s.role)), products, "the runtime requirements"));
  }
  if (isObj(descriptor)) out.push(shapesOnlyCheck(descriptor), examplesCheck(descriptor));
  return out;
}

/** The architecture record: its systems in system words (Section 12.4), held against the products it binds. */
export function architectureChecks(head) {
  if (!head || !Array.isArray(head.systems)) return [];
  return [systemWordsCheck(head.systems.map(words), productsOf(head), "the architecture record")];
}
