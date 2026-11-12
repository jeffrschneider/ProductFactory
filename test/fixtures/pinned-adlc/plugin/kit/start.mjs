// Lay out a build folder for a new agent.
//
// The folder gets the check and the generators under .adlc/ (this kit, copied
// whole), AGENTS.md with the builder's instructions (the adlc skill's own
// text, so Cursor, Codex or a person can work the folder without the plugin),
// CLAUDE.md pointing to it, and the lock file build.lock.json, in which the
// kit is fixed from the start: a check that changed is caught like any other
// file that can no longer change.
//
// The person's own words go in request.md, written by the builder from what
// the person said, before anything else.
//
//   needs: node >= 22
//   node <plugin>/kit/start.mjs <folder>
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { LOCK_FILE, digestOf } from "./code-writer/scripts/workspace.mjs";
import { migrateLock } from "./stages.mjs";

const KIT = dirname(fileURLToPath(import.meta.url));
const SKILL = join(KIT, "..", "skills", "adlc", "SKILL.md");

/** The skill's text without its front matter: the instructions AGENTS.md holds. */
export function instructionsOf(skillText) {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n+/.exec(skillText);
  return m ? skillText.slice(m[0].length) : skillText;
}

function walk(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const at = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(at, base));
    else out.push(relative(base, at).split(sep).join("/"));
  }
  return out;
}

/** Lay the folder out. Refuses a folder that is already a build folder. */
export function start(folder, { kit = KIT, skill = SKILL } = {}) {
  const dir = resolve(folder);
  if (existsSync(join(dir, ".adlc"))) return { ok: false, said: `${dir} is already a build folder; run \`node .adlc/check.mjs\` there to see where it is.` };
  mkdirSync(dir, { recursive: true });
  cpSync(kit, join(dir, ".adlc"), { recursive: true });
  writeFileSync(join(dir, "AGENTS.md"), instructionsOf(readFileSync(skill, "utf8")));
  if (!existsSync(join(dir, "CLAUDE.md"))) writeFileSync(join(dir, "CLAUDE.md"), "@AGENTS.md\n");
  const digests = Object.fromEntries(walk(join(dir, ".adlc")).sort().map((r) => [`.adlc/${r}`, digestOf(readFileSync(join(dir, ".adlc", r)))]));
  writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ build_lock: "v1", digests, gates: {} }, null, 2) + "\n");
  return { ok: true, dir, said: `The build folder is ${dir}. Write the person's own words to request.md there, then follow AGENTS.md from the start.` };
}

/** Bring a build folder's kit up to this plugin's: .adlc/ replaced whole,
 *  AGENTS.md rewritten, and the kit fixed again. Every other fixed file and
 *  every phase passed stay as they were, so nothing the build settled moves;
 *  a gate that is now stricter says so the next time the check runs. A lock
 *  written in the five stages is brought to the two phases (migrateLock):
 *  an approved spec stays approved, and the build is checked again. */
export function update(folder, { kit = KIT, skill = SKILL } = {}) {
  const dir = resolve(folder);
  if (!existsSync(join(dir, ".adlc"))) return { ok: false, said: `${dir} is not a build folder; start one with start.mjs <folder>.` };
  const { lock, moved } = migrateLock(JSON.parse(readFileSync(join(dir, LOCK_FILE), "utf8")));
  rmSync(join(dir, ".adlc"), { recursive: true, force: true });
  cpSync(kit, join(dir, ".adlc"), { recursive: true });
  writeFileSync(join(dir, "AGENTS.md"), instructionsOf(readFileSync(skill, "utf8")));
  const kept = Object.entries(lock.digests ?? {}).filter(([p]) => !p.startsWith(".adlc/"));
  const kitPins = walk(join(dir, ".adlc")).map((r) => [`.adlc/${r}`, digestOf(readFileSync(join(dir, ".adlc", r)))]);
  const digests = Object.fromEntries([...kept, ...kitPins].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ ...lock, digests }, null, 2) + "\n");
  const how = moved ? (lock.gates.spec ? " Its five stages are now the two phases: the approved spec stays approved, and the build is checked again." : " Its five stages are now the two phases: the spec waits for the person's approval.") : "";
  return { ok: true, dir, moved, said: `The kit in ${dir} is this plugin's now.${how} Run \`node .adlc/check.mjs\` there.` };
}

const thisFile = process.argv[1] ? process.argv[1].replace(/\\/g, "/").split("/").pop() : "";
if (thisFile === "start.mjs" && import.meta.url.endsWith("/start.mjs")) {
  const updating = process.argv[2] === "--update";
  const folder = process.argv[updating ? 3 : 2];
  if (!folder) { console.error("usage: node start.mjs <folder> | node start.mjs --update <folder>"); process.exit(2); }
  const r = updating ? update(folder) : start(folder);
  console.log(r.said);
  process.exitCode = r.ok ? 0 : 1;
}
