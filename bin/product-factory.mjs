#!/usr/bin/env node
// npx product-factory [--config <path>] [--port <n>]
// npx product-factory init [--config <path>]
// npx product-factory people | person ... | team add ... | project add ...   (lib/people.mjs)

import { parseArgs } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, writeStarter, modelEnv, localPerson, CONFIG_FILE } from "../lib/config.mjs";
import { createStore } from "../lib/store.mjs";
import { createLifecycle } from "../lib/lifecycle.mjs";
import { createRunner } from "../lib/runner.mjs";
import { createService } from "../lib/server.mjs";
import { createPeople, peopleCommand, peoplePath, PEOPLE_HELP, KEYS_FILE } from "../lib/people.mjs";
import { createHistory, HISTORY_UNAVAILABLE } from "../lib/history.mjs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const HELP = `Product Factory ${pkg.version}

Runs your agentic development lifecycle on this computer, and answers the
lifecycle API the adlc console reads.

  npx product-factory                 start it, reading ${CONFIG_FILE} in this folder
  npx product-factory init            write a starter ${CONFIG_FILE} here

  --config <path>   the settings file (default ./${CONFIG_FILE})
  --port <n>        listen on this port, overriding the settings (0 takes any free port)
  --help            show this

${PEOPLE_HELP}`;

async function main() {
  let parsed;
  try {
    parsed = parseArgs({ allowPositionals: true, options: { config: { type: "string" }, port: { type: "string" }, help: { type: "boolean", short: "h", default: false }, role: { type: "string" }, name: { type: "string" }, member: { type: "string", multiple: true }, team: { type: "string", multiple: true } } });
  } catch (e) {
    console.error(`${e.message}\n\n${HELP}`);
    process.exit(2);
  }
  const { values, positionals } = parsed;
  if (values.help) { console.log(HELP); return; }
  const configPath = resolve(values.config ?? CONFIG_FILE);

  if (positionals[0] === "init") {
    if (writeStarter(configPath)) console.log(`Wrote ${configPath}. Set "adlc" to your checkout of CommonAgent/adlc and "code.harness" to your coding harness, then run npx product-factory.`);
    else console.log(`${configPath} is already there; it was left as it is.`);
    return;
  }
  if (["people", "person", "team", "project"].includes(positionals[0])) {
    let config;
    try { config = loadConfig(configPath); } catch (e) { console.error(e.message); process.exit(2); }
    const { code, out } = peopleCommand(positionals, values, config);
    (code ? console.error : console.log)(out);
    process.exit(code);
  }
  if (positionals.length) { console.error(`There is no command ${positionals[0]}.\n\n${HELP}`); process.exit(2); }

  let config;
  try { config = loadConfig(configPath); } catch (e) { console.error(e.message); process.exit(2); }
  if (values.port !== undefined) {
    const p = Number(values.port);
    if (!Number.isInteger(p) || p < 0 || p > 65535) { console.error("The port is a number from 0 to 65535."); process.exit(2); }
    config.port = p;
  }

  const store = createStore({ dir: config.data });
  const lifecycle = createLifecycle({ path: config.lifecycle });
  const problem = await lifecycle.check();
  if (problem) console.error(`${problem}\nThe stages and roles will answer with this until the file is fixed.`);
  const key = store.key();
  const person = localPerson();
  const history = createHistory({ store });
  const runner = createRunner({ store, lifecycle, config, person });
  const people = createPeople({ file: peoplePath(config.lifecycle), keysFile: join(config.data, KEYS_FILE), lifecycle: lifecycle.file, serviceKey: key.value, admin: person });
  const peopleProblems = people.list().problems;
  if (peopleProblems.length) console.error(`People: ${peopleProblems.join(" ")}`);
  const service = createService({ store, lifecycle, runner, key: key.value, person, people, version: pkg.version, history });
  let base;
  try { base = await service.listen(config.port); } catch (e) {
    console.error(e.code === "EADDRINUSE" ? `Port ${config.port} is in use. Set another "port" in ${config.file}, or give --port.` : e.message);
    process.exit(1);
  }

  console.log(`Product Factory is at ${base}${"/v1/lifecycle"}`);
  console.log(`Builds are kept in ${join(config.data, "builds")}; the lifecycle document is ${lifecycle.file}.`);
  console.log("");
  console.log("Open the console against it, from a checkout of CommonAgent/adlc-console:");
  console.log(`  node bin/adlc-console.mjs --service ${base} --key-file ${key.file}`);
  console.log("");
  const notes = [];
  if (!existsSync(join(config.adlc, "agents", "spec-writer"))) notes.push(`There is no CommonAgent/adlc checkout at ${config.adlc}, so builds will stop at Requirements. Set "adlc" in ${config.file}.`);
  const { missing } = modelEnv(config, process.env);
  if (missing.length) notes.push(`The model settings are read from ${missing.join(", ")}, which ${missing.length === 1 ? "is" : "are"} not set, so Requirements and Test will stop and say so.`);
  if (HISTORY_UNAVAILABLE) notes.push(HISTORY_UNAVAILABLE);
  if (config.code.holder === "pull-request") {
    if (!String(process.env[config.repository.token] ?? "").trim()) notes.push(`Code goes to a pull request on ${config.repository.repo}, and the token is read from ${config.repository.token}, which is not set, so Code will stop and say so.`);
    else console.log(`Code goes to a pull request on ${config.repository.repo}. Product Factory checks it for pushes every ${config.repository.poll_seconds} seconds.`);
  } else if (!config.code.harness) notes.push(`No coding harness is set, so Code will stop and say so. Set "code.harness" in ${config.file}.`);
  for (const n of notes) console.log(`Note: ${n}`);
  if (notes.length) console.log("");
  console.log("Press Ctrl+C to stop it. A build that is running then runs its stage again the next time it starts.");

  await runner.resumeAll();
  runner.watch();
  const stop = async () => { await runner.stopAll(); await service.close(); history?.close(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
