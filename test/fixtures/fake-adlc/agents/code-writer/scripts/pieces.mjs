// A stand-in for the code writer's pieces.mjs: lists the scripts in the job folder.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const { JOB_DIR, RECORDS } = process.env;
if (!JOB_DIR || !RECORDS) { console.error("JOB_DIR and RECORDS are required"); process.exit(2); }
writeFileSync(join(JOB_DIR, "pieces.json"), JSON.stringify([{ name: "scripts/count.mjs", step: "write-the-scripts", path: "out/scripts/count.mjs", media_type: "text/javascript" }]));
console.log("1 piece listed");
