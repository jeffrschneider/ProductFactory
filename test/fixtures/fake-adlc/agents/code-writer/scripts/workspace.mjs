// A stand-in for workspace.mjs: unpacks the stand-in archive (which names the build folder) into WORKSPACE.
import { cpSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const { WORKSPACE, RECORDS, FILES } = process.env;
if (!WORKSPACE || !RECORDS || !FILES) { console.error("WORKSPACE, RECORDS and FILES are required"); process.exit(2); }
const archive = FILES.split(",")[0].split("::")[0];
cpSync(readFileSync(archive, "utf8").trim(), WORKSPACE, { recursive: true });
mkdirSync(RECORDS, { recursive: true });
writeFileSync(join(RECORDS, "workspace.json"), JSON.stringify({ workspace: "v1", folder: WORKSPACE }));
console.log(JSON.stringify({ ok: true, code: 0, reply: "The workspace is laid out." }));
