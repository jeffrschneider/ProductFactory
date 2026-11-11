// The packer: Common Agent's own program for whether a folder is a package
// (@common-agent/package, Common Agent Section 12). The check runs it on the
// agent's files and quotes its refusal in its own words.
//
// The version is the one pinned here, the version that implements the Common
// Agent version the lifecycle pins (common-agent-pin.json). ADLC_PACK names
// another command to run in its place, such as a packer built from source
// before that version is published; it is the whole command, and the folder
// and the flags are added after it.
//
//   needs: node >= 22
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PACKER = { package: "@common-agent/package", version: "0.2.0", bin: "common-agent-pack", common_agent: "0.41.0" };
export const PACK_SECONDS = 180;

/** The command, as [program, ...args], before the folder. */
export function packCommand(env = process.env) {
  const own = String(env.ADLC_PACK ?? "").trim();
  if (own) return { cmd: own, args: [], shell: true };
  return { cmd: "npx", args: ["-y", "-p", `${PACKER.package}@${PACKER.version}`, PACKER.bin], shell: process.platform === "win32" };
}

/** Run the packer on a folder: { ok, refused, warnings, ran } where `ran` is
 *  false when the packer itself could not be run. */
export function pack(dir, { env = process.env, spawn = spawnSync } = {}) {
  const out = mkdtempSync(join(tmpdir(), "adlc-pack-"));
  try {
    const { cmd, args, shell } = packCommand(env);
    const all = [...args, dir, "--out", out, "--json"];
    // Through a shell the command is one line, each argument quoted.
    const r = shell
      ? spawn([cmd, ...all.map((a) => `"${a}"`)].join(" "), { encoding: "utf8", shell: true, timeout: PACK_SECONDS * 1000 })
      : spawn(cmd, all, { encoding: "utf8", timeout: PACK_SECONDS * 1000 });
    const text = String(r.stdout ?? "");
    const start = text.indexOf("{");
    let doc = null;
    try { doc = start >= 0 ? JSON.parse(text.slice(start)) : null; } catch { doc = null; }
    if (!doc) return { ok: false, ran: false, refused: `the packer could not be run (${cmd}${args.length ? ` ${args.join(" ")}` : ""}): ${String(r.stderr || r.error?.message || text).trim().split("\n").slice(-3).join(" ")}`, warnings: [] };
    return { ok: doc.ok === true, ran: true, refused: doc.ok ? null : String(doc.refused ?? "it refused the folder"), warnings: doc.warnings ?? [] };
  } finally { rmSync(out, { recursive: true, force: true }); }
}
