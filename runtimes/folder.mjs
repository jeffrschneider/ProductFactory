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
// two words. It prints one JSON object: { ok, said, handle, where }.

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

function fail(said) {
  console.error(said);
  console.log(JSON.stringify({ ok: false, said }));
  process.exit(1);
}

let values, positionals;
try {
  ({ values, positionals } = parseArgs({ allowPositionals: true, options: { into: { type: "string" } } }));
} catch (e) {
  fail(e.message);
}
if (!values.into) fail("Say which folder to install into: --into <folder>.");
const [pkg, planFile] = positionals;
if (!pkg || !planFile) fail("Give the package's path and the run plan's path.");
for (const f of [pkg, planFile]) if (!existsSync(f)) fail(`${f} is not there.`);

let plan;
try { plan = JSON.parse(readFileSync(planFile, "utf8")); } catch (e) { fail(`The run plan is not JSON: ${e.message}`); }
const name = String(plan?.product?.name ?? "").replace(/[^A-Za-z0-9._-]+/g, "-") || "product";
const version = String(plan?.product?.version ?? "").replace(/[^A-Za-z0-9._-]+/g, "-") || "0";

const where = join(resolve(values.into), `${name}-${version}`);
mkdirSync(where, { recursive: true });
copyFileSync(pkg, join(where, basename(pkg)));
copyFileSync(planFile, join(where, "run-plan.json"));

const held = (plan.stages ?? []).filter((s) => s.used && s.chosen && s.stage !== "deploy").map((s) => s.name);
console.log(JSON.stringify({
  ok: true,
  said: `Installed ${name} ${version} into ${where}: the package and its run plan are there.${held.length ? ` The run plan names holders for ${held.join(", ")}.` : ""}`,
  handle: `folder:${where}`,
  where,
}));
