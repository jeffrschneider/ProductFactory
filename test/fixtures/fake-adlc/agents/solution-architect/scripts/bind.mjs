// A stand-in for bind.mjs: every system bound to the platform's default in
// each environment, as the reference architect binds when no stack came.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { NAMED, ASKED, RECORDS } = process.env;
if (!NAMED || !ASKED || !RECORDS) { console.error("NAMED, ASKED and RECORDS are required"); process.exit(2); }
const named = JSON.parse(readFileSync(NAMED, "utf8"));
const envs = ["dev", "test", "production"];
writeFileSync(join(RECORDS, "bound.json"), JSON.stringify({ bindings: Object.fromEntries(named.systems.map((s) => [s, Object.fromEntries(envs.map((e) => [e, { product: "platform", provided_by: "platform" }]))])) }, null, 2));
console.log(JSON.stringify({ ok: true, code: 0 }));
