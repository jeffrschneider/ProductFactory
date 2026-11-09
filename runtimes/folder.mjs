#!/usr/bin/env node
// The reference runtime: the smallest thing that takes a finished package. It
// copies the package and its run plan into a folder, one folder per product
// version, so the hand-off can be seen with no platform at all. A real runtime
// takes the same two files and installs the product, then holds the stages the
// run plan names.
//
//   node runtimes/folder.mjs --into <folder> <package> <run plan>
//
// In product-factory.json:
//
//   "runtime": { "command": ["node", "runtimes/folder.mjs", "--into", "./installed"] }
//
// Product Factory adds the package's path and the run plan's path as the last
// two words, and says what to do with them in PRODUCT_FACTORY_VERB (lifecycle
// API 0.4.4, the runtime verbs; lib/runtime.mjs):
//
//   install      (or no verb) copy both into <folder>/<name>-<version>/; that
//                version is the one running
//   rollback     the two files are the earlier version's own (PRODUCT_FACTORY_VERSION):
//                restore them into its folder and make it the one running
//   reconfigure  the two files are the running version's package and a new
//                run plan: rewrite that version's run-plan.json
//   retire       remove every installed version's folder; nothing is running
//
// What runs, and every verb it took, is kept in <folder>/<name>.runtime.json,
// which retire keeps as the record. It prints one JSON object:
// { ok, said, verb, handle, where, cannot_undo? }.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

function fail(said) {
  console.error(said);
  console.log(JSON.stringify({ ok: false, said, verb: process.env.PRODUCT_FACTORY_VERB || "install" }));
  process.exit(1);
}

let values, positionals;
try {
  ({ values, positionals } = parseArgs({ allowPositionals: true, options: { into: { type: "string" } } }));
} catch (e) {
  fail(e.message);
}
if (!values.into) fail("Say which folder to install into: --into <folder>.");
const verb = process.env.PRODUCT_FACTORY_VERB || "install";
if (!["install", "rollback", "reconfigure", "retire"].includes(verb)) fail(`This runtime does not know the verb "${verb}". It knows install, rollback, reconfigure and retire.`);
const [pkg, planFile] = positionals;
if (!pkg || !planFile) fail("Give the package's path and the run plan's path.");
for (const f of [pkg, planFile]) if (!existsSync(f)) fail(`${f} is not there.`);

let plan;
try { plan = JSON.parse(readFileSync(planFile, "utf8")); } catch (e) { fail(`The run plan is not JSON: ${e.message}`); }
const safe = (s, or) => String(s ?? "").replace(/[^A-Za-z0-9._-]+/g, "-") || or;
const name = safe(plan?.product?.name, "product");
const version = safe(plan?.product?.version, "0");
const into = resolve(values.into);
const folderOf = (v) => join(into, `${name}-${v}`);
const stateFile = join(into, `${name}.runtime.json`);
const at = new Date().toISOString();

function readState() {
  try {
    const s = JSON.parse(readFileSync(stateFile, "utf8"));
    return { name, current: s.current ?? null, installed: Array.isArray(s.installed) ? s.installed : [], retired: s.retired ?? null, history: Array.isArray(s.history) ? s.history : [] };
  } catch { return { name, current: null, installed: [], retired: null, history: [] }; }
}
function writeState(s) {
  mkdirSync(into, { recursive: true });
  writeFileSync(stateFile, `${JSON.stringify(s, null, 2)}\n`);
}
function place(v) {
  const where = folderOf(v);
  mkdirSync(where, { recursive: true });
  copyFileSync(pkg, join(where, basename(pkg)));
  copyFileSync(planFile, join(where, "run-plan.json"));
  return where;
}
const answer = (o) => { console.log(JSON.stringify({ ok: true, verb, ...o })); };
const state = readState();
if (state.retired && verb !== "install") fail(`${name} was retired here on ${state.retired.at}: nothing is running.`);

if (verb === "install") {
  const where = place(version);
  state.current = version;
  state.retired = null;
  if (!state.installed.includes(version)) state.installed.push(version);
  state.history.push({ at, verb, version });
  writeState(state);
  const held = (plan.stages ?? []).filter((s) => s.used && s.chosen && s.stage !== "deploy").map((s) => s.name);
  answer({
    said: `Installed ${name} ${version} into ${where}: the package and its run plan are there.${held.length ? ` The run plan names holders for ${held.join(", ")}.` : ""}`,
    handle: `folder:${where}`,
    where,
  });
} else if (verb === "rollback") {
  const to = safe(process.env.PRODUCT_FACTORY_VERSION, version);
  if (to !== version) fail(`The package given is ${name} ${version}, not ${to}, so it is not the version to go back to.`);
  const from = state.current;
  if (from === to) fail(`${name} ${to} is already the one running here.`);
  const where = place(to);
  state.current = to;
  if (!state.installed.includes(to)) state.installed.push(to);
  state.history.push({ at, verb, version: to, from });
  writeState(state);
  answer({
    said: `Rolled ${name} back to ${to} in ${where}: its own package and run plan are restored${from ? `, and ${from} no longer runs` : ""}.`,
    handle: `folder:${where}`,
    where,
    cannot_undo: from ? [`The folder ${folderOf(from)} is left in place: a folder runtime keeps no state of its own to undo.`] : [],
  });
} else if (verb === "reconfigure") {
  if (state.current !== version) fail(`${name} ${version} is not the one running here${state.current ? ` (${state.current} is)` : ""}, so its run plan was not changed.`);
  const where = folderOf(version);
  if (!existsSync(where)) fail(`${where} is not there, so there is no install to reconfigure.`);
  copyFileSync(planFile, join(where, "run-plan.json"));
  state.history.push({ at, verb, version });
  writeState(state);
  answer({ said: `Reconfigured ${name} ${version} in ${where}: its run plan is rewritten, and the version is the same.`, handle: `folder:${where}`, where });
} else if (verb === "retire") {
  const removed = [];
  const kept = [];
  for (const v of state.installed) {
    const where = folderOf(v);
    if (!existsSync(where)) continue;
    // Only the files an install put there are removed, one by one; a folder inside is left, and said.
    let inner = false;
    for (const f of readdirSync(where)) {
      const p = join(where, f);
      if (statSync(p).isFile()) unlinkSync(p); else inner = true;
    }
    if (inner) kept.push(where); else { rmdirSync(where); removed.push(where); }
  }
  state.retired = { at, version: state.current };
  state.history.push({ at, verb, version: state.current });
  state.current = null;
  writeState(state);
  answer({
    said: `Retired ${name}: ${removed.length ? `removed ${removed.length === 1 ? "its install" : `${removed.length} installed versions`}` : "nothing was installed"}, and kept the record in ${stateFile}.${kept.length ? ` Left in place because they hold folders of their own: ${kept.join(", ")}.` : ""}`,
    handle: null,
    where: stateFile,
  });
}
