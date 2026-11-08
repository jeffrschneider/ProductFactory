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
//       "holder": "harness",                "harness" (your coding harness) or "code-writer" (the reference code writer)
//       "harness": ["claude", "-p", "{prompt}"],
//       "rounds": 3,                        how many rounds the harness gets before the build stops and asks you
//       "minutes": 30                       how long one round may take
//     },
//     "package": { "packer": ["npx", "--yes", "@common-agent/package@0.1.0"] }
//   }
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
  code: { holder: "harness", harness: null, rounds: 3, minutes: 30 },
  package: { packer: ["npx", "--yes", "@common-agent/package@0.1.0"] },
};

/** What `product-factory init` writes. */
export const STARTER = {
  adlc: "../adlc",
  lifecycle: "./lifecycle.json",
  data: "./builds",
  port: 4510,
  model: { ...MODEL_SETTINGS },
  code: { holder: "harness", harness: ["claude", "-p", "{prompt}", "--permission-mode", "acceptEdits", "--allowedTools", "Bash(node:*)"], rounds: 3, minutes: 30 },
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
    if (!code || typeof code !== "object" || Array.isArray(code)) throw new ConfigProblem(`"code" is an object: holder, harness, rounds, minutes.`);
    for (const k of Object.keys(code)) if (!["holder", "harness", "rounds", "minutes"].includes(k)) throw new ConfigProblem(`"code" has "${k}"; it reads holder, harness, rounds and minutes.`);
    if ("holder" in code) {
      if (!["harness", "code-writer"].includes(code.holder)) throw new ConfigProblem(`"code.holder" is "harness" (your coding harness) or "code-writer" (the reference code writer).`);
      c.code.holder = code.holder;
    }
    if ("harness" in code && code.harness !== null) c.code.harness = argv(code.harness, `"code.harness"`);
    for (const k of ["rounds", "minutes"]) {
      if (k in code) {
        if (!Number.isInteger(code[k]) || code[k] < 1 || code[k] > 1000) throw new ConfigProblem(`"code.${k}" is a whole number from 1 to 1000.`);
        c.code[k] = code[k];
      }
    }
  }
  if ("package" in raw) {
    const p = raw.package;
    if (!p || typeof p !== "object" || Array.isArray(p)) throw new ConfigProblem(`"package" is an object with "packer".`);
    for (const k of Object.keys(p)) if (k !== "packer") throw new ConfigProblem(`"package" has "${k}"; it reads only packer.`);
    if ("packer" in p) c.package.packer = argv(p.packer, `"package.packer"`);
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
