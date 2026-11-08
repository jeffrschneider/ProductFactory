// The file store: one folder per build under <data>/builds/<id>/, holding
// build.json (the build's record) and everything its stages ran and handed
// back, and the service's key in <data>/service-key. No database.
//
// build.json is written whole to a temporary file that then replaces it, and
// writes to one build are made one at a time, so a reader never sees half a
// record.

import { randomBytes } from "node:crypto";
import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync, renameSync, unlinkSync, chmodSync, statSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";

export const RECORD_FORMAT = "product-factory-build-v1";
const ID = /^b_[a-z0-9]{12}$/;

export function createStore({ dir }) {
  const root = resolve(dir);
  const builds = join(root, "builds");
  mkdirSync(builds, { recursive: true });
  const chains = new Map();
  let seq = 0;

  const folder = (id) => {
    if (!ID.test(id)) throw new Error(`not a build id: ${id}`);
    return join(builds, id);
  };

  function writeWhole(file, text) {
    const tmp = `${file}.${process.pid}.${++seq}.tmp`;
    writeFileSync(tmp, text, "utf8");
    try { renameSync(tmp, file); } catch (e) { try { unlinkSync(tmp); } catch { /* gone */ } throw e; }
  }

  function read(id) {
    if (!ID.test(String(id))) return null;
    const file = join(builds, id, "build.json");
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8"));
  }

  function save(record) {
    record.updated = new Date().toISOString();
    const dirOf = folder(record.id);
    mkdirSync(dirOf, { recursive: true });
    writeWhole(join(dirOf, "build.json"), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  }

  return {
    root,
    folder,
    /** A new build id, never used before here. */
    newId() {
      for (;;) {
        const id = `b_${randomBytes(6).toString("hex")}`;
        if (!existsSync(join(builds, id))) return id;
      }
    },
    read,
    /** Every build, newest first. A folder whose record cannot be read is skipped. */
    list() {
      const out = [];
      for (const name of readdirSync(builds)) {
        if (!ID.test(name)) continue;
        try { const r = read(name); if (r?.format === RECORD_FORMAT) out.push(r); } catch { /* skipped */ }
      }
      return out.sort((a, b) => String(b.created).localeCompare(String(a.created)));
    },
    create(record) {
      mkdirSync(folder(record.id), { recursive: false });
      return save(record);
    },
    /** One change to a build, made after every change before it: fn(record) changes it in place. */
    update(id, fn) {
      const run = (chains.get(id) ?? Promise.resolve()).then(() => {
        const r = read(id);
        if (!r) throw new Error(`no build ${id}`);
        const out = fn(r);
        save(r);
        return out === undefined ? r : out;
      });
      chains.set(id, run.catch(() => {}));
      return run;
    },
    /** A file inside a build's folder, by its path relative to that folder; null when it is outside or missing. */
    fileIn(id, rel) {
      const base = folder(id);
      const at = resolve(base, rel);
      const back = relative(base, at);
      if (!back || back.startsWith("..") || isAbsolute(back)) return null;
      try { return statSync(at).isFile() ? at : null; } catch { return null; }
    },
    /** The service's key: made once, kept in <data>/service-key, readable only by its owner. */
    key() {
      const file = join(root, "service-key");
      if (!existsSync(file)) {
        writeFileSync(file, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
        try { chmodSync(file, 0o600); } catch { /* a hint on Windows */ }
      }
      return { file, value: readFileSync(file, "utf8").trim() };
    },
  };
}
