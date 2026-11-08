// The gate's test run, in a folder holding the build folder as one commit of
// the pull request has it: `node gate-suite.mjs`, run in that folder. It runs
// the suite as the folder has it, then once per script the spec names with
// that script blanked, each in its own copy: a suite that still passes with a
// script blanked is not testing it. It always exits 0 and says everything on
// its last line: GATE_RESULT <json>. gate.mjs reads that line and judges.
//
// Ported from AgentMesh's hand-off gate (services/src/handoffs/gate-sandbox.mjs).
// There it ran in a sandbox job whose output was cut to its last 2000
// characters, so it kept five failing names; here it runs on your computer,
// as your coding harness and the suite already do in local mode, and keeps
// twenty. One self-contained module, node 22, no imports outside node.
//
//   GATE_SCRIPTS_FILE   the JSON list of scripts to blank (default .gate/scripts.json)
//   GATE_SUITE_SECONDS  how long one run of the suite may take (default 120)
//   GATE_BLANKS_DIR     where the blanked copies are made (default the system's temporary folder)

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const here = process.cwd();
const SUITE_SECONDS = Number(process.env.GATE_SUITE_SECONDS) > 0 ? Number(process.env.GATE_SUITE_SECONDS) : 120;
const NAMES_KEPT = 20;
const NAME_MAX = 200;

const suiteFiles = (dir) => (existsSync(join(dir, "test")) ? readdirSync(join(dir, "test")).filter((n) => n.endsWith(".test.mjs")).sort().map((n) => `test/${n}`) : []);

function runSuite(dir) {
  const files = suiteFiles(dir);
  if (!files.length) return { exit: null, tests: 0, pass: 0, fail: 0, failing: [], timed_out: false, said: "there are no test files" };
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...files], { cwd: dir, env, encoding: "utf8", timeout: SUITE_SECONDS * 1000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  const out = String(r.stdout ?? "");
  const n = (k) => Number(new RegExp(`^# ${k} (\\d+)$`, "m").exec(out)?.[1] ?? 0);
  const failing = [...out.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1].trim()).filter((t) => !/^test[\\/]/.test(t));
  const timedOut = r.error?.code === "ETIMEDOUT";
  const names = failing.slice(0, NAMES_KEPT).map((t) => (t.length > NAME_MAX ? `${t.slice(0, NAME_MAX - 3)}...` : t));
  return { exit: timedOut ? null : r.status, tests: n("tests"), pass: n("pass"), fail: n("fail"), failing: names, failing_count: failing.length, timed_out: timedOut };
}

const result = { format: "gate-suite-v1", suite: null, blanks: [], error: null };
try {
  const listFile = process.env.GATE_SCRIPTS_FILE || join(here, ".gate", "scripts.json");
  const scripts = JSON.parse(readFileSync(listFile, "utf8"));
  const gateDir = resolve(here, ".gate");
  result.suite = runSuite(here);
  const blanks = process.env.GATE_BLANKS_DIR || tmpdir();
  mkdirSync(blanks, { recursive: true });
  for (const script of Array.isArray(scripts) ? scripts : []) {
    const copy = mkdtempSync(join(blanks, "gate-blank-"));
    try {
      cpSync(here, copy, { recursive: true, filter: (src) => !resolve(src).startsWith(gateDir) });
      writeFileSync(join(copy, ...String(script).split("/")), "export {};\n");
      const r = runSuite(copy);
      result.blanks.push({ script, noticed: r.exit !== 0 || r.timed_out, fail: r.fail, tests: r.tests });
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }
} catch (err) {
  result.error = String((err && err.message) || err);
}
console.log(`GATE_RESULT ${JSON.stringify(result)}`);
