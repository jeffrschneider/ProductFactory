// What a build folder pins, and where a build folder goes in a repository:
// the lock's name and its digest form, the folder of one agent's hand-off,
// and what a credential value looks like (rule-checks.mjs reads it). One
// builder's build folder is judged by its own ADLC check (builder.mjs).
//
// Ported from AgentMesh's hand-off gate (services/src/handoffs/gate-fence.ts),
// as plain JavaScript. Pure.

import { createHash } from "node:crypto";

/** The lock a build folder carries: what it pins, by digest. */
export const LOCK_FILE = "build.lock.json";

/** The digest form build.lock.json uses. */
export const digestOf = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** Where a hand-off goes in the repository: a folder of its own, agents/<name>/,
 *  so two builds handed to the same repository never write the same paths. */
export const HANDOFF_ROOT = "agents";
export const folderFor = (agent) => `${HANDOFF_ROOT}/${agent}`;

// What a credential value looks like when somebody has committed one. A
// narrow list on purpose: a checker that cries wolf gets turned off, and the
// rule is about values, never names.
export const SECRETS = [
  [/-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, "a private key"],
  [/\bghp_[A-Za-z0-9]{30,}\b/, "a GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}\b/, "a GitHub token"],
  [/\bsk-[A-Za-z0-9]{32,}\b/, "an API key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key id"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, "a Slack token"],
  [/"private_key"\s*:\s*"-----BEGIN/, "a service account key"],
];

/** The files of a repository tree that belong to the build folder, by their path inside it. */
export function inFolder(folder, files) {
  const at = folder.replace(/^\/+|\/+$/g, "");
  if (!at) return new Map(files);
  const out = new Map();
  for (const [p, b] of files) if (p.startsWith(`${at}/`)) out.set(p.slice(at.length + 1), b);
  return out;
}
