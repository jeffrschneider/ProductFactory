// product-factory.json: the one settings file. It names where things are and
// which environment variables hold the model settings. It never holds a key
// or any other secret value: the model settings are named by environment
// variable, and their values are read from the environment when a build runs.
//
//   {
//     "adlc": "../adlc",                    a local checkout of CommonAgent/adlc
//     "lifecycle": "./lifecycle.json",      the lifecycle document, made if missing
//     "data": "./builds",                   where builds are kept, one folder each
//     "port": 4510,                         the port on 127.0.0.1
//     "model": {                            the environment variable each model setting is read from
//       "name": "MODEL_NAME", "endpoint": "MODEL_ENDPOINT",
//       "key": "MODEL_KEY", "protocol": "MODEL_PROTOCOL"
//     },
//     "code": {
//       "holder": "harness",                "harness" (your coding harness, run here), "code-writer" (the reference
//                                           code writer) or "pull-request" (your coding harness, on a pull request)
//       "harness": ["claude", "-p", "{prompt}", ...],   your coding harness; init writes CLAUDE_HARNESS (below)
//       "rounds": 3,                        how many rounds the harness gets before the build stops and asks you
//       "fix_rounds": 3,                    on a pull request with a harness set: how many fix rounds Product Factory
//                                           runs (harness, commit, gate) before Code is refused and asks you
//       "minutes": 30,                      how long one round may take (on a pull request: one run of the suite, or one reviewer)
//       "env_remove": ["ANTHROPIC_API_KEY"] environment variables removed before the harness command runs, so a
//                                           harness uses its own sign-in (a plan, not a key); [] keeps them all
//     },
//     "repository": {                       where Code's pull request is opened, when code.holder is "pull-request"
//       "host": "github",
//       "repo": "owner/name",
//       "token": "GITHUB_TOKEN",            the environment variable the token is read from, never the token
//       "api": "https://api.github.com",    optional: a GitHub Enterprise Server's API address
//       "poll_seconds": 30                  optional: how often the pull request is checked for a new push
//     },
//     "review": { "spending_limit": "10 USD per day" },   optional: the line the security reviewer is told
//     "intake": {                           optional: builds start from issues on the repository named above
//       "github_issues": { "label": "product-factory", "poll_seconds": 60 }
//     },
//     "notify": [                           optional: who is told when a gate waits and when a build ends
//       { "kind": "webhook", "url_env": "SLACK_WEBHOOK_URL" },   the address is read from that variable
//       { "kind": "command", "command": ["node", "mail.mjs"] }   the message goes to the command on stdin
//     ],
//     "package": { "packer": ["npx", "--yes", "@common-agent/package@0.1.0"] },
//     "runtime": {                          the runtime you bring, optional: after Package, this command
//       "command": ["node", "runtimes/folder.mjs", "--into", "./installed"]
//     }                                     is given the package's path and the run plan's path, in that
//   }                                       order, as its last two words. Without it, Deploy waits on you.
//
// Paths are read relative to the folder the file is in.

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { userInfo } from "node:os";

export const CONFIG_FILE = "product-factory.json";

/** The four settings the reference agents read, by the name they read them under. */
export const MODEL_SETTINGS = { name: "MODEL_NAME", endpoint: "MODEL_ENDPOINT", key: "MODEL_KEY", protocol: "MODEL_PROTOCOL" };

export const DEFAULTS = {
  adlc: "../adlc",
  lifecycle: "./lifecycle.json",
  data: "./builds",
  port: 4510,
  model: { ...MODEL_SETTINGS },
  code: { holder: "harness", harness: null, rounds: 3, fix_rounds: 3, minutes: 30, env_remove: ["ANTHROPIC_API_KEY"] },
  repository: null,
  review: { spending_limit: "10 USD per day" },
  intake: null,
  notify: [],
  package: { packer: ["npx", "--yes", "@common-agent/package@0.1.0"] },
  runtime: null,
};

/** The code holders: your harness run here, the reference code writer, or your harness on a pull request. */
export const CODE_HOLDERS = ["harness", "code-writer", "pull-request"];

/**
 * Claude Code run headless as the harness: in the build folder, editing files
 * and running node, with the person's normal sign-in, and without their own
 * plugins, hooks and MCP servers. --setting-sources project reads only the
 * build folder's settings, so the user settings that enable plugins and hooks
 * are not read; --strict-mcp-config uses only MCP servers named with
 * --mcp-config, and none are. --bare would also skip them, but it ignores the
 * normal sign-in (it reads only ANTHROPIC_API_KEY), so it is not used.
 */
export const CLAUDE_HARNESS = ["claude", "-p", "{prompt}", "--permission-mode", "acceptEdits", "--allowedTools", "Bash(node:*)", "--setting-sources", "project", "--strict-mcp-config"];

/** What `product-factory init` writes. */
export const STARTER = {
  adlc: "../adlc",
  lifecycle: "./lifecycle.json",
  data: "./builds",
  port: 4510,
  model: { ...MODEL_SETTINGS },
  code: { holder: "harness", harness: [...CLAUDE_HARNESS], rounds: 3, minutes: 30, env_remove: ["ANTHROPIC_API_KEY"] },
  package: { packer: ["npx", "--yes", "@common-agent/package@0.1.0"] },
};

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const PLACEHOLDERS = new Set(["prompt", "workspace", "feedback_file", "round"]);

class ConfigProblem extends Error {}

function argv(v, where) {
  if (!Array.isArray(v) || !v.length || !v.every((x) => typeof x === "string" && x.length)) {
    throw new ConfigProblem(`${where} is a command as a list of words, such as ["claude", "-p", "{prompt}"].`);
  }
  for (const word of v) {
    for (const m of word.matchAll(/\{([a-z_]+)\}/g)) {
      if (!PLACEHOLDERS.has(m[1])) throw new ConfigProblem(`${where} uses {${m[1]}}, which is not one of ${[...PLACEHOLDERS].map((p) => `{${p}}`).join(", ")}.`);
    }
  }
  return [...v];
}

/** Checks a parsed settings object and fills in the defaults. `base` is the folder paths are read from. */
export function readConfig(raw, base) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigProblem("The settings file holds one JSON object.");
  const known = new Set(Object.keys(DEFAULTS));
  for (const k of Object.keys(raw)) if (!known.has(k)) throw new ConfigProblem(`The settings have "${k}", which Product Factory does not read. It reads ${[...known].join(", ")}.`);
  const c = structuredClone(DEFAULTS);
  for (const k of ["adlc", "lifecycle", "data"]) {
    if (k in raw) {
      if (typeof raw[k] !== "string" || !raw[k].trim()) throw new ConfigProblem(`"${k}" is a path.`);
      c[k] = raw[k];
    }
    c[k] = resolve(base, c[k]);
  }
  if ("port" in raw) {
    if (!Number.isInteger(raw.port) || raw.port < 0 || raw.port > 65535) throw new ConfigProblem(`"port" is a number from 0 to 65535 (0 takes any free port).`);
    c.port = raw.port;
  }
  if ("model" in raw) {
    const m = raw.model;
    if (!m || typeof m !== "object" || Array.isArray(m)) throw new ConfigProblem(`"model" names an environment variable for each of name, endpoint, key and protocol.`);
    for (const [k, v] of Object.entries(m)) {
      if (!(k in MODEL_SETTINGS)) throw new ConfigProblem(`"model" has "${k}"; it names only name, endpoint, key and protocol.`);
      if (typeof v !== "string" || !ENV_NAME.test(v)) {
        throw new ConfigProblem(`"model.${k}" is the name of an environment variable (letters, digits and _), never a value. Put the value in that variable.`);
      }
      c.model[k] = v;
    }
  }
  if ("code" in raw) {
    const code = raw.code;
    if (!code || typeof code !== "object" || Array.isArray(code)) throw new ConfigProblem(`"code" is an object: holder, harness, rounds, fix_rounds, minutes, env_remove.`);
    for (const k of Object.keys(code)) if (!["holder", "harness", "rounds", "fix_rounds", "minutes", "env_remove"].includes(k)) throw new ConfigProblem(`"code" has "${k}"; it reads holder, harness, rounds, fix_rounds, minutes and env_remove.`);
    if ("holder" in code) {
      if (!CODE_HOLDERS.includes(code.holder)) throw new ConfigProblem(`"code.holder" is "harness" (your coding harness, run here), "code-writer" (the reference code writer) or "pull-request" (your coding harness, on a pull request).`);
      c.code.holder = code.holder;
    }
    if ("harness" in code && code.harness !== null) c.code.harness = argv(code.harness, `"code.harness"`);
    for (const k of ["rounds", "fix_rounds", "minutes"]) {
      if (k in code) {
        if (!Number.isInteger(code[k]) || code[k] < 1 || code[k] > 1000) throw new ConfigProblem(`"code.${k}" is a whole number from 1 to 1000.`);
        c.code[k] = code[k];
      }
    }
    if ("env_remove" in code) {
      const list = code.env_remove;
      if (!Array.isArray(list) || list.length > 100 || !list.every((v) => typeof v === "string" && ENV_NAME.test(v))) {
        throw new ConfigProblem(`"code.env_remove" is a list of environment variable names (letters, digits and _), such as ["ANTHROPIC_API_KEY"], or [] to keep them all.`);
      }
      c.code.env_remove = [...new Set(list)];
    }
  }
  if ("repository" in raw && raw.repository !== null) {
    const r = raw.repository;
    if (!r || typeof r !== "object" || Array.isArray(r)) throw new ConfigProblem(`"repository" is an object: host, repo, token, and optionally api and poll_seconds.`);
    for (const k of Object.keys(r)) if (!["host", "repo", "token", "api", "poll_seconds"].includes(k)) throw new ConfigProblem(`"repository" has "${k}"; it reads host, repo, token, api and poll_seconds.`);
    if (r.host !== "github") throw new ConfigProblem(`"repository.host" is "github". Other hosts come later.`);
    if (typeof r.repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r.repo)) throw new ConfigProblem(`"repository.repo" is owner/name, such as "acme/agents".`);
    if (typeof r.token !== "string" || !ENV_NAME.test(r.token) || /^(gh[pousr]|github_pat)_/i.test(r.token)) throw new ConfigProblem(`"repository.token" is the name of an environment variable (letters, digits and _), never a token. Put the token in that variable.`);
    const api = r.api ?? "https://api.github.com";
    if (typeof api !== "string" || !/^https?:\/\/[^/\s]+(\/\S*)?$/.test(api)) throw new ConfigProblem(`"repository.api" is the address of GitHub's API, such as "https://github.example.com/api/v3".`);
    const poll = r.poll_seconds ?? 30;
    if (!Number.isInteger(poll) || poll < 1 || poll > 3600) throw new ConfigProblem(`"repository.poll_seconds" is a whole number from 1 to 3600.`);
    c.repository = { host: "github", repo: r.repo, token: r.token, api: api.replace(/\/+$/, ""), poll_seconds: poll };
  }
  if ("review" in raw) {
    const v = raw.review;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new ConfigProblem(`"review" is an object with "spending_limit".`);
    for (const k of Object.keys(v)) if (k !== "spending_limit") throw new ConfigProblem(`"review" has "${k}"; it reads only spending_limit.`);
    if ("spending_limit" in v) {
      if (typeof v.spending_limit !== "string" || !v.spending_limit.trim() || v.spending_limit.length > 100 || /[\r\n]/.test(v.spending_limit)) throw new ConfigProblem(`"review.spending_limit" is one line, such as "10 USD per day".`);
      c.review.spending_limit = v.spending_limit.trim();
    }
  }
  if (c.code.holder === "pull-request" && !c.repository) throw new ConfigProblem(`"code.holder" is "pull-request", so "repository" names where the pull request goes: { "host": "github", "repo": "owner/name", "token": "GITHUB_TOKEN" }.`);
  if ("intake" in raw && raw.intake !== null) {
    const v = raw.intake;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new ConfigProblem(`"intake" is an object with "github_issues".`);
    for (const k of Object.keys(v)) if (k !== "github_issues") throw new ConfigProblem(`"intake" has "${k}"; it reads only github_issues.`);
    const g = v.github_issues ?? {};
    if (!g || typeof g !== "object" || Array.isArray(g)) throw new ConfigProblem(`"intake.github_issues" is an object: label and poll_seconds.`);
    for (const k of Object.keys(g)) if (!["label", "poll_seconds"].includes(k)) throw new ConfigProblem(`"intake.github_issues" has "${k}"; it reads label and poll_seconds.`);
    const label = g.label ?? "product-factory";
    if (typeof label !== "string" || !label.trim() || label.length > 50 || /[,\r\n]/.test(label)) throw new ConfigProblem(`"intake.github_issues.label" is one GitHub label, such as "product-factory".`);
    const poll = g.poll_seconds ?? 60;
    if (!Number.isInteger(poll) || poll < 5 || poll > 86400) throw new ConfigProblem(`"intake.github_issues.poll_seconds" is a whole number from 5 to 86400.`);
    if (!c.repository) throw new ConfigProblem(`"intake.github_issues" reads issues from "repository", so name it: { "host": "github", "repo": "owner/name", "token": "GITHUB_TOKEN" }.`);
    c.intake = { github_issues: { label: label.trim(), poll_seconds: poll } };
  }
  if ("notify" in raw && raw.notify !== null) {
    if (!Array.isArray(raw.notify) || raw.notify.length > 20) throw new ConfigProblem(`"notify" is a list of at most 20 notices, such as [{ "kind": "webhook", "url_env": "SLACK_WEBHOOK_URL" }].`);
    c.notify = raw.notify.map((n, i) => {
      const where = `"notify[${i}]"`;
      if (!n || typeof n !== "object" || Array.isArray(n)) throw new ConfigProblem(`${where} is an object with a kind: "webhook" or "command".`);
      if (n.kind === "webhook") {
        for (const k of Object.keys(n)) if (!["kind", "url_env"].includes(k)) throw new ConfigProblem(`${where} has "${k}"; a webhook reads kind and url_env.`);
        if (typeof n.url_env !== "string" || !ENV_NAME.test(n.url_env)) throw new ConfigProblem(`${where}.url_env is the name of an environment variable that holds the webhook's address, never the address.`);
        return { kind: "webhook", url_env: n.url_env };
      }
      if (n.kind === "command") {
        for (const k of Object.keys(n)) if (!["kind", "command"].includes(k)) throw new ConfigProblem(`${where} has "${k}"; a command reads kind and command.`);
        if (!Array.isArray(n.command) || !n.command.length || !n.command.every((x) => typeof x === "string" && x.length)) throw new ConfigProblem(`${where}.command is a command as a list of words, such as ["node", "mail.mjs"]. The message goes to it on stdin.`);
        return { kind: "command", command: [...n.command] };
      }
      throw new ConfigProblem(`${where}.kind is "webhook" or "command".`);
    });
  }
  if ("package" in raw) {
    const p = raw.package;
    if (!p || typeof p !== "object" || Array.isArray(p)) throw new ConfigProblem(`"package" is an object with "packer".`);
    for (const k of Object.keys(p)) if (k !== "packer") throw new ConfigProblem(`"package" has "${k}"; it reads only packer.`);
    if ("packer" in p) c.package.packer = argv(p.packer, `"package.packer"`);
  }
  if ("runtime" in raw && raw.runtime !== null) {
    const rt = raw.runtime;
    if (!rt || typeof rt !== "object" || Array.isArray(rt)) throw new ConfigProblem(`"runtime" is an object with "command".`);
    for (const k of Object.keys(rt)) if (k !== "command") throw new ConfigProblem(`"runtime" has "${k}"; it reads only command.`);
    // The command runs in the settings file's folder, so its words may name paths relative to it.
    c.runtime = { command: argv(rt.command, `"runtime.command"`), cwd: resolve(base) };
  }
  return c;
}

/** Reads the settings file. Throws with the problem in words. */
export function loadConfig(path) {
  const file = resolve(path);
  if (!existsSync(file)) throw new ConfigProblem(`There is no ${file}. Run \`npx product-factory init\` to write one, then set the adlc path and your coding harness in it.`);
  let raw;
  try { raw = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")); } catch (e) {
    throw new ConfigProblem(`${file} is not valid JSON: ${e.message}.`);
  }
  try { return { ...readConfig(raw, dirname(file)), file }; } catch (e) {
    if (e instanceof ConfigProblem) throw new ConfigProblem(`${file}: ${e.message}`);
    throw e;
  }
}

/** Writes the starter settings file, unless one is there. Returns whether it wrote. */
export function writeStarter(path) {
  if (existsSync(path)) return false;
  writeFileSync(path, `${JSON.stringify(STARTER, null, 2)}\n`, { flag: "wx" });
  return true;
}

/**
 * The four model settings, read from the environment variables the settings
 * name. Returns { env, missing }: env holds MODEL_NAME, MODEL_ENDPOINT,
 * MODEL_KEY and MODEL_PROTOCOL as the reference agents read them; missing
 * lists the variables that are not set (the key may be empty).
 */
export function modelEnv(config, from = process.env) {
  const env = {};
  const missing = [];
  for (const [k, setting] of Object.entries(MODEL_SETTINGS)) {
    const variable = config.model[k];
    const value = from[variable];
    env[setting] = value ?? "";
    if (k !== "key" && !String(value ?? "").trim()) missing.push(variable);
  }
  return { env, missing };
}

export { ConfigProblem };

/** The person on this computer, as the service names them: no accounts in milestone 1. */
export function localPerson() {
  let u = "you";
  try { u = userInfo().username || u; } catch { /* no user name */ }
  const id = u.toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || "you";
  return { name: u, email: `${id}@localhost` };
}
