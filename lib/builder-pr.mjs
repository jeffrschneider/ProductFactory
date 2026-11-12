// One builder on a pull request (code.where "pull-request"): the build folder
// laid out by the ADLC plugin's kit goes to a branch of its own, and your coding
// assistant works it wherever you are. This machine runs no coding agent and
// holds no sign-in to one: it lays the folder out, presses the person's
// approvals in it (approve.mjs) and pushes those as commits of its own, and on
// each new push runs the folder's own check (node .adlc/check.mjs --json) on a
// copy of the branch. Nothing it decides about the agent is its own.
//
//   builderPullRequestBody(agent, version, folder)   the pull request's words: how to work the folder
//   folderFiles(folder)                              the folder's files as { path -> bytes }, without .git, records/ and node_modules/
//   builtOf(folder)                                  what openPullRequest takes: { files, digests, scripts }
//   mirror(folder, files)                            the local folder made the branch's: every file written, every other one taken out (records/ stays)
//   changedFrom(folder, files)                       what Product Factory changed in the folder since the branch: [{ path, bytes }]

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

const SKIP = new Set([".git", "records", "node_modules"]);
const posix = (p) => p.split(sep).join("/");

/** The pull request's words: what the branch holds and how to work it with your own coding assistant. */
export function builderPullRequestBody(agent, version, folder) {
  const at = `${folder}/`;
  return [
    `This branch holds the build folder for **${agent} ${version}** in \`${at}\`, laid out by the ADLC plugin's kit, with your words in \`request.md\`. Your coding assistant writes the spec here first; you approve it in Product Factory, and your later changes are added to the end of \`request.md\`.`,
    "",
    "Build it with your own coding assistant:",
    "",
    "1. In Claude Code, install the ADLC plugin: `/plugin install adlc --marketplace CommonAgent/adlc`. Another assistant reads the folder's `AGENTS.md` instead.",
    `2. Check this branch out and open \`${at}\`.`,
    "3. Follow `AGENTS.md` there: the spec first, then the rest of the build in whatever order works best. Run `node .adlc/check.mjs` after each change. It says which phase the folder is in and what each gate still needs.",
    "4. Push as you go.",
    "",
    "Product Factory runs the same check on each push and shows where the build is in the console. What only you can decide, such as whether the agent may reach a service, waits for you in the console: your answers (with your words in `said.md`) and any send back are pushed here as commits Product Factory makes, so pull before you go on. Your approvals are pressed in the console, never by the assistant. When the check says the build has passed, Product Factory makes the package, and you approve the deploy there.",
  ].join("\n");
}

/** Every file of the folder, by its path inside it. */
export function folderFiles(folder) {
  const out = new Map();
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const at = join(d, name);
      if (statSync(at).isDirectory()) {
        const skipped = name === "records" ? d === folder : SKIP.has(name);
        if (!skipped) walk(at);
      }
      else out.set(posix(relative(folder, at)), readFileSync(at));
    }
  };
  if (existsSync(folder)) walk(folder);
  return new Map([...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The folder as openPullRequest takes it: its files, the pins of its lock, and no scripts yet. */
export function builtOf(folder) {
  let digests = {};
  try { digests = JSON.parse(readFileSync(join(folder, "build.lock.json"), "utf8")).digests ?? {}; } catch { digests = {}; }
  return { files: folderFiles(folder), digests, scripts: [] };
}

/** The local folder made the branch's: each of its files written, each file the branch does not have taken out. records/ is the machine's own and stays. */
export function mirror(folder, files) {
  mkdirSync(folder, { recursive: true });
  for (const p of folderFiles(folder).keys()) if (!files.has(p)) rmSync(join(folder, ...p.split("/")), { force: true });
  for (const [p, bytes] of files) {
    const at = join(folder, ...p.split("/"));
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, bytes);
  }
}

/** What the folder holds now that the branch does not, or holds differently: [{ path, bytes }]. */
export function changedFrom(folder, files) {
  const out = [];
  for (const [p, bytes] of folderFiles(folder)) {
    const was = files.get(p);
    if (!was || !Buffer.from(was).equals(bytes)) out.push({ path: p, bytes });
  }
  return out;
}
