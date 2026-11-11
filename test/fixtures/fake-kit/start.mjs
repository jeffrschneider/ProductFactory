// A stand-in for the ADLC plugin's kit/start.mjs: it lays a build folder out
// with a stand-in check and approval under .adlc/ and an empty pin file. Its
// check answers as the plugin's does (node .adlc/check.mjs --json), from which
// files the stand-in builder wrote and the person's answers in answers.json.
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(process.argv[2]);
mkdirSync(join(dir, ".adlc"), { recursive: true });
for (const f of ["check.mjs", "approve.mjs", "stages.mjs"]) cpSync(join(here, f), join(dir, ".adlc", f));
writeFileSync(join(dir, "AGENTS.md"), "# Building an agent through the ADLC\n");
writeFileSync(join(dir, "build.lock.json"), JSON.stringify({ build_lock: "v1", digests: {}, scripts: [], gates: {} }, null, 2) + "\n");
console.log(`The build folder is ${dir}.`);
