#!/usr/bin/env node
// Refreshes the copies this repository ships, byte for byte, from local checkouts:
//
//   standards/stages.json, lifecycle-api.schema.json, lifecycle-document.schema.json
//   and lifecycle-api-check.mjs          from CommonAgent/adlc, standards/, and
//   standards/ADLC.json                  the one pin of the ADLC: the commit those
//                                        copies came from, which the reference agents
//                                        and the plugin kit are read from too
//   vendor/process-runner/*.mjs          from AgentMesh-Community/process-runner, package/scripts/
//                                        (the files vendor/process-runner/SOURCE.json lists; its
//                                        commit and version are written back there)
//
//   node scripts/vendor.mjs [--adlc <adlc checkout>] [--process-runner <process-runner checkout>]
//
// Only maintainers run this. Product Factory never fetches either at run time.
// The lifecycle file store and the console's contract checks are not copied:
// they come from the adlc-console package (package.json), so there is one copy.

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: { adlc: { type: "string" }, "process-runner": { type: "string" } } });
if (!values.adlc && !values["process-runner"]) {
  console.error("Give --adlc <path to a CommonAgent/adlc checkout>, --process-runner <path to an AgentMesh-Community/process-runner checkout>, or both.");
  process.exit(2);
}

const copies = [];
if (values.adlc) {
  for (const f of ["stages.json", "lifecycle-api.schema.json", "lifecycle-document.schema.json", "lifecycle-api-check.mjs"]) {
    copies.push([join(resolve(values.adlc), "standards", f), join(ROOT, "standards", f)]);
  }
}
const sourceFile = join(ROOT, "vendor", "process-runner", "SOURCE.json");
const source = JSON.parse(readFileSync(sourceFile, "utf8"));
const runner = values["process-runner"] ? resolve(values["process-runner"]) : null;
if (runner) {
  for (const f of source.files) copies.push([join(runner, ...source.from.split("/").filter(Boolean), f), join(ROOT, "vendor", "process-runner", f)]);
  copies.push([join(runner, "LICENSE"), join(ROOT, "vendor", "process-runner", "LICENSE")]);
}

for (const [from] of copies) {
  if (!existsSync(from)) { console.error(`${from} is not there. Nothing was copied.`); process.exit(1); }
}
for (const [from, to] of copies) {
  copyFileSync(from, to);
  console.log(`copied ${from}`);
}
if (values.adlc) {
  const at = resolve(values.adlc);
  const commit = execFileSync("git", ["-C", at, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const stages = JSON.parse(readFileSync(join(at, "standards", "stages.json"), "utf8")).version;
  const api = JSON.parse(readFileSync(join(at, "standards", "lifecycle-api.schema.json"), "utf8")).version;
  writeFileSync(join(ROOT, "standards", "ADLC.json"), `${JSON.stringify({ adlc_pin: "v1", repository: "CommonAgent/adlc", commit, stages, lifecycle_api: api, about: "The one ADLC this Product Factory is built against: the standards in this folder are copies from this commit, and the adlc checkout it runs (product-factory.json, adlc) must be at it, for the reference agents and the ADLC plugin kit every build folder carries." }, null, 2)}
`);
  console.log(`the ADLC pinned at ${commit} (stages.json ${stages}, lifecycle API ${api})`);
}
if (runner) {
  source.commit = execFileSync("git", ["-C", runner, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  source.version = JSON.parse(readFileSync(join(runner, "package", "plugin.json"), "utf8")).version;
  writeFileSync(sourceFile, `${JSON.stringify(source, null, 2)}\n`);
  console.log(`process runner ${source.version} at ${source.commit}. Run npm test: run-state.mjs may import a module the list does not name yet.`);
}
