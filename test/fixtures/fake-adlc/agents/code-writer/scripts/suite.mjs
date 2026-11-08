// Shared by the stand-in checks: runs a folder's suite with node's runner and
// says what happened the way the real check does (a verdict line, then one
// "  not ok: <name>" line per failing test). Exits 0 on a pass, 1 otherwise.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export function runSuite(folder) {
  const files = readdirSync(join(folder, "test")).filter((f) => f.endsWith(".test.mjs")).map((f) => join("test", f));
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...files], { cwd: folder, encoding: "utf8" });
  const failing = [...String(r.stdout).matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1].trim()).filter((n) => !n.endsWith(".mjs"));
  if (r.status === 0) {
    console.log(`Done. All ${files.length} test file${files.length === 1 ? "" : "s"} pass.`);
    process.exit(0);
  }
  console.log(`${failing.length || "Some"} test${failing.length === 1 ? "" : "s"} failed.`);
  for (const n of failing) console.log(`  not ok: ${n}`);
  process.exit(1);
}
