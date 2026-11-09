// Read the change: what was attached, sorted into what the analysis takes, and
// nothing judged.
//
// A job is given, as attached files:
//   - the agent's declaration before the change and after it, two
//     agent-descriptor-v1 documents (application/vnd.agentmesh.agent-descriptor+json);
//   - what depends on the agent, the platform's dependents list as
//     dependents_list answers it (application/vnd.agentmesh.dependents+json);
//   - optionally, each dependent solution as GET /v1/solutions/:id answers it,
//     its nodes and its lines (application/vnd.agentmesh.solution+json);
//   - optionally, agents that may take what the agent hands back, as the
//     platform reads an agent's ports (services/src/compose/ports.ts
//     readPorts: {agent, label, offerings}), one or a list
//     (application/vnd.agentmesh.agent-ports+json);
//   - optionally, the runtime requirements before and after
//     (application/vnd.agentmesh.agent-runtime-requirements+json), for the
//     price and the limits.
//
// Each file is known by what it holds, not only by the kind it was sent
// under, because a person attaching a file rarely chooses its kind: a JSON
// file whose `format` is agent-descriptor-v1 is a descriptor whatever it was
// called. Where the kind it was sent under says something else, that is noted.
//
// The report names no attached file: a host names the files it downloads its
// own way, and a report that carried those names would differ between two runs.
//
// Which descriptor is the running version: the one with the lower
// agent_version. When the versions are equal or cannot be read, the first one
// attached, and the reading says so. The runtime requirements are paired the
// same way: by a version in the file's name, else in the order attached.
//
//   needs: node >= 22
//   import { readChange, sortFiles } from "./read-change.mjs"
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { bareKind } from "./kinds.mjs";

export const KINDS = {
  descriptor: "application/vnd.agentmesh.agent-descriptor+json",
  dependents: "application/vnd.agentmesh.dependents+json",
  solution: "application/vnd.agentmesh.solution+json",
  ports: "application/vnd.agentmesh.agent-ports+json",
  runtime: "application/vnd.agentmesh.agent-runtime-requirements+json",
};

const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const trim = (s) => String(s ?? "").trim();

/** What a parsed JSON document is, by what it holds; null when it is none of them. */
export function sniff(doc) {
  if (isObject(doc) && doc.format === "agent-descriptor-v1") return "descriptor";
  if (isObject(doc) && doc.format === "agent-runtime-requirements-v1") return "runtime";
  if (isObject(doc) && isObject(doc.subject) && Array.isArray(doc.dependents)) return "dependents";
  if (isObject(doc) && Array.isArray(doc.nodes) && Array.isArray(doc.connections)) return "solution";
  const isPorts = (x) => isObject(x) && typeof x.agent === "string" && Array.isArray(x.offerings);
  if (isPorts(doc) || (Array.isArray(doc) && doc.length && doc.every(isPorts))) return "ports";
  return null;
}

/** "2.10.0" against "2.9.1": -1, 0 or 1; null when either is not a version. */
export function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(trim(v));
    return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null } : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] < y.n[i] ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** Sort parsed files into what the analysis takes. Pure: each file is
 *  {name, declared, doc} or {name, declared, error}. */
export function sortFiles(files = []) {
  const got = { descriptors: [], runtimes: [], dependents: [], solutions: [], ports: [], unread: [], notes: [] };
  for (const f of files) {
    if (f.error) { got.unread.push({ name: f.name, why: f.error }); continue; }
    const what = sniff(f.doc);
    if (!what) {
      got.unread.push({ name: f.name, why: "it is JSON, but not a descriptor, a dependents list, a solution, an agent's ports or runtime requirements" });
      continue;
    }
    const declared = bareKind(f.declared);
    if (declared && declared !== KINDS[what]) {
      got.notes.push(`A file sent as ${declared} was read as ${KINDS[what]}, by what it holds.`);
    }
    if (what === "descriptor") got.descriptors.push(f);
    else if (what === "runtime") got.runtimes.push(f);
    else if (what === "dependents") got.dependents.push(f);
    else if (what === "solution") got.solutions.push(f);
    else got.ports.push(...(Array.isArray(f.doc) ? f.doc : [f.doc]).map((doc) => ({ name: f.name, doc })));
  }
  return got;
}

/** Which descriptor runs today and which is the change, and why. */
export function pairDescriptors(descriptors) {
  if (descriptors.length !== 2) return null;
  const [a, b] = descriptors;
  const va = trim(a.doc.agent_version);
  const vb = trim(b.doc.agent_version);
  const c = compareVersions(va, vb);
  if (c === 1) return { running: b, changed: a, how: `The declaration with agent_version ${vb} is the running version, because ${vb} is lower than ${va}` };
  if (c === -1) return { running: a, changed: b, how: `The declaration with agent_version ${va} is the running version, because ${va} is lower than ${vb}` };
  const why = c === 0 ? `both say agent_version ${va}` : "their agent_version could not be compared";
  return { running: a, changed: b, how: `The declaration attached first is taken as the running version, because ${why}` };
}

/** The runtime requirements for each side: by a version in the file's name,
 *  else the order attached. */
export function pairRuntimes(runtimes, running, changed) {
  if (!runtimes.length) return { running: null, changed: null, how: "" };
  const rv = trim(running?.doc?.agent_version);
  const cv = trim(changed?.doc?.agent_version);
  const named = (v) => (v ? runtimes.find((r) => r.name.includes(v)) : null);
  if (rv && cv && rv !== cv && named(rv) && named(cv) && named(rv) !== named(cv)) {
    return { running: named(rv), changed: named(cv), how: "paired with the descriptors by the version in each file's name" };
  }
  if (runtimes.length === 1) return { running: null, changed: null, how: "only one runtime requirements file came, so the price and the limits before and after could not be compared" };
  return { running: runtimes[0], changed: runtimes[1], how: "the runtime requirements attached first are taken as the running version's and the next as the change's" };
}

/** Read the attached files from disk and sort them. */
export function readChange(files = []) {
  const parsed = files.map((f) => {
    const name = basename(f.path || "attached file");
    let text;
    try { text = readFileSync(f.path, "utf8"); } catch (e) { return { name, declared: f.declared, error: `it could not be read (${e.code ?? trim(e.message)})` }; }
    try { return { name, declared: f.declared, doc: JSON.parse(text) }; } catch { return { name, declared: f.declared, error: "it is not JSON" }; }
  });
  return sortFiles(parsed);
}

/** The few lines a message may carry, as `name: value` lines of their own:
 *  `what changed:` in the person's words. Only a line counts; a word in
 *  passing is not read as an instruction. */
export function fromText(text = "") {
  const t = String(text ?? "");
  const said = /^\s*(?:[-*]\s*)?(?:what\s+changed|the\s+change|change)\s*[:=]\s*(.+?)\s*$/im.exec(t);
  return { said: said ? trim(said[1]) : "" };
}

/** Whether the message asks this agent to approve, or to go ahead with, the
 *  change. The answer is always no; this only decides whether to say so. */
export function asksForApproval(text = "") {
  return /\b(approve|approval|sign[\s-]?off|go\s+ahead|green[\s-]?light|ok\s+to\s+(ship|deploy|release|build)|should\s+(we|i)\s+(ship|deploy|release|build|proceed|go)|proceed\s+with|can\s+(we|i)\s+(ship|deploy|release))\b/i.test(String(text ?? ""));
}
