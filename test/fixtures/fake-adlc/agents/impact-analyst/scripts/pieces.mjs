// Fill a job folder with the impact report: out/impact-report.md, and
// pieces.json, the list the adapter reads when the reply is sent, one entry
// per piece with the step that made it. The adapter signs the job manifest
// from that list; a reply with no pieces.json carries no job. A job that
// wrote no report lists nothing.
//
//   needs: node >= 22
//   import { plan, fill } from "./pieces.mjs"
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ABOUT } from "./report.mjs";

export const STEP_OF = { "impact report": "write-the-report" };

/** What to list and what to write. Pure. */
export function plan({ report } = {}) {
  if (typeof report !== "string" || !report.trim()) throw new Error("there is no impact report to file");
  return {
    entries: [
      {
        name: "impact report", step: STEP_OF["impact report"], path: "out/impact-report.md",
        media_type: "text/markdown", produced_from: ["running version", "changed version", "what depends on it"],
        about: ABOUT,
        text: report.endsWith("\n") ? report : `${report}\n`,
      },
    ],
  };
}

/** Write the pieces and the list. */
export function fill(jobDir, { entries }) {
  const listed = entries.map((e) => {
    const { text, ...rest } = e;
    const dest = join(jobDir, rest.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, text);
    return rest;
  });
  writeFileSync(join(jobDir, "pieces.json"), `${JSON.stringify(listed, null, 2)}\n`);
  return listed;
}
