// Running a command: a reference agent's script, your coding harness, or the
// packer. Every command is a list of words and runs without a shell, so
// nothing a build carries (a spec, a test name) can become part of a command
// line. On Windows a program found as a .cmd or .bat file (npx, and most
// tools npm installs) can only run through cmd.exe, so it does, with each
// word quoted.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync, createWriteStream, mkdirSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join } from "node:path";

const CAP = 4 * 1024 * 1024;

/** Where a program is on PATH (Windows: with PATHEXT), or null. */
export function findProgram(name, env = process.env) {
  if (isAbsolute(name) || /[\\/]/.test(name)) return existsSync(name) ? name : null;
  const dirs = String(env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  // On Windows a name with no extension runs only as one of PATHEXT's (npx is npx.cmd, never the
  // shell script called npx beside it).
  const exts = process.platform === "win32" && !extname(name) ? String(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const d of dirs) {
    for (const e of exts) {
      const at = join(d, name + e);
      try { if (statSync(at).isFile()) return at; } catch { /* not here */ }
    }
  }
  return null;
}

// One word for cmd.exe, read back by the program the way the C runtime reads arguments. cmd.exe
// ends a command at a line break, so a word's line breaks go as spaces (a fix round's prompt has
// them; its words also reach the harness whole as PF_PROMPT).
const cmdQuote = (w) => `"${String(w).replace(/\r?\n|\r/g, " ").replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1").replace(/%/g, '"^%"')}"`;

/** How to start argv: { file, args, shell }. "node" is this node. */
export function resolveCommand(argv, env = process.env) {
  const [first, ...rest] = argv;
  if (first === "node") return { file: process.execPath, args: rest, shell: false };
  if (process.platform !== "win32") return { file: first, args: rest, shell: false };
  const found = findProgram(first, env);
  if (found && /\.(cmd|bat)$/i.test(extname(found))) {
    return { file: [found, ...rest].map(cmdQuote).join(" "), args: [], shell: true };
  }
  return { file: found ?? first, args: rest, shell: false };
}

function killTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    try { spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch { /* gone */ }
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
  }
}

/**
 * Runs argv. Resolves to { code, stdout, stderr, timedOut, stopped, error }
 * and never rejects. log, when given, is a file that gets everything the
 * command prints. signal stops it early.
 */
export function run(argv, { cwd, env = process.env, timeoutMs = 0, signal, log } = {}) {
  return new Promise((done) => {
    // Set when Product Factory itself runs under node --test; a suite the command runs must not inherit it.
    if ("NODE_TEST_CONTEXT" in env) { env = { ...env }; delete env.NODE_TEST_CONTEXT; }
    const { file, args, shell } = resolveCommand(argv, env);
    let out = "";
    let err = "";
    let timedOut = false;
    let stopped = false;
    let sink = null;
    if (log) { mkdirSync(dirname(log), { recursive: true }); sink = createWriteStream(log, { flags: "a" }); }
    let child;
    try {
      child = spawn(file, args, { cwd, env, shell, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      sink?.end();
      return done({ code: null, stdout: "", stderr: "", timedOut, stopped, error: e.message });
    }
    const take = (which) => (chunk) => {
      sink?.write(chunk);
      if (which === "out" && out.length < CAP) out += chunk.toString("utf8");
      if (which === "err" && err.length < CAP) err += chunk.toString("utf8");
    };
    child.stdout.on("data", take("out"));
    child.stderr.on("data", take("err"));
    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs) : null;
    const onAbort = () => { stopped = true; killTree(child); };
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true }); }
    let error = null;
    child.on("error", (e) => { error = e.code === "ENOENT" ? `${argv[0]} was not found` : e.message; });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      sink?.end();
      done({ code, stdout: out, stderr: err, timedOut, stopped, error });
    });
  });
}

/**
 * A copy of env without the variables named. On Windows a variable's name
 * has no case, so Anthropic_Api_Key goes as well as ANTHROPIC_API_KEY.
 */
export function withoutEnv(env, names = [], platform = process.platform) {
  const out = { ...env };
  if (!names?.length) return out;
  const gone = new Set(platform === "win32" ? names.map((n) => n.toUpperCase()) : names);
  for (const k of Object.keys(out)) if (gone.has(platform === "win32" ? k.toUpperCase() : k)) delete out[k];
  return out;
}

/** The last line of out that parses as a JSON object, or null. */
export function lastJson(out) {
  const lines = String(out ?? "").trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { const v = JSON.parse(lines[i]); if (v && typeof v === "object" && !Array.isArray(v)) return v; } catch { /* not this line */ }
  }
  // A command that prints one JSON object over several lines.
  try { const v = JSON.parse(String(out ?? "").trim()); if (v && typeof v === "object" && !Array.isArray(v)) return v; } catch { /* not JSON */ }
  return null;
}

/** The last words a command printed, for a person: at most n characters. */
export function tail(text, n = 600) {
  const t = String(text ?? "").trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
}
