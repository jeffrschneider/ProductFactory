// A stand-in for the code writer's check.mjs: runs the suite in WORKSPACE.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runSuite } from "./suite.mjs";

const { WORKSPACE, RECORDS } = process.env;
if (!WORKSPACE || !RECORDS) { console.error("WORKSPACE and RECORDS are required"); process.exit(2); }
if (!existsSync(join(RECORDS, "workspace.json"))) { console.error("no workspace record: run workspace.mjs first"); process.exit(2); }
runSuite(WORKSPACE);
