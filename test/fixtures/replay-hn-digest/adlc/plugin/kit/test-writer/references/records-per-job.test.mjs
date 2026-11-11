// Every job leaves its own records, in a folder of its own.
// Written by the test writer into every suite it writes, the same bytes each
// time; it is the test writer's file and not the package's, so it is never
// edited here. The next suite the test writer writes for this package brings
// its current copy.
//   node --test test/records-per-job.test.mjs
//
// What is worth pinning. The host hands every job of an agent the same
// records folder, the agent's own (RECORDS, or --records), and keeps it from
// one job to the next. A record the declaration keeps per job has a `file`
// pattern whose first part is the job's folder, such as `*/went-without.json`,
// read relative to that records folder (Common Agent 12.3, records[].file).
// So each job writes it under a folder of its own named after its job folder:
// <records>/<the job folder's name>/went-without.json, which a script makes
// as join(RECORDS, basename(JOB_DIR)). A script that writes it straight into
// the records folder overwrites the last job's record with every job, and the
// conformance check's records audit, which reads the same pattern, finds
// nothing there (technical debt 639).
//
// How it is reached. The suite's other tests run two jobs of the same kind,
// each with its own job folder and both with the same records folder, and
// then assert checkRecordsPerJob(records, [jobDir1, jobDir2]) returns no
// problems. A record the declaration says is written only in some cases, and
// that neither job writes, is named in `except` by its name or its file;
// went-without.json never is, since every job writes it, with no entries when
// it lacked nothing, and the conformance check reads it after jobs that may
// lack nothing (build ab_3508d5dec3d4642113 did not conform for that). This
// file's own tests check the checker; they run only when this file is run
// itself, so importing checkRecordsPerJob from it adds none.
//
// Nothing here touches a network, a model or a host.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const trim = (s) => String(s ?? "").trim();

/** The package's declaration: its agent-descriptor.json beside test/, or a
 *  spec.json there, or null when neither is. */
export function readDeclaration(dir = join(HERE, "..")) {
  for (const f of ["agent-descriptor.json", "spec.json"]) {
    const at = join(dir, f);
    if (existsSync(at)) {
      try { return JSON.parse(readFileSync(at, "utf8")); } catch { return null; }
    }
  }
  return null;
}

/** The per-job record every job writes, whatever it lacked: the one `except`
 *  never leaves out. */
export const WENT_WITHOUT = "went-without.json";

/** The records a declaration keeps per job: each with a `file` pattern whose
 *  first part is `*`, the job's folder, and not marked standing. `rest` is
 *  the pattern below the job's folder. */
export function perJobRecords(decl) {
  const out = [];
  for (const r of Array.isArray(decl?.records) ? decl.records : []) {
    const file = trim(r?.file).replace(/\\/g, "/");
    if (!file.startsWith("*/") || trim(r?.when) === "standing") continue;
    const rest = file.slice(2);
    if (!rest || rest.split("/").includes("..")) continue;
    out.push({ name: trim(r?.name) || file, file, rest });
  }
  return out;
}

/** The files under `dir` a pattern below it matches: `*` is any name within
 *  one part of the path, `**` any number of parts. */
export function matchesIn(dir, rest) {
  const parts = trim(rest).split("/").filter(Boolean);
  const re = (p) => new RegExp(`^${p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);
  const walk = (at, i) => {
    if (i === parts.length) return existsSync(at) && statSync(at).isFile() ? [at] : [];
    if (!existsSync(at) || !statSync(at).isDirectory()) return [];
    if (parts[i] === "**") return [...walk(at, i + 1), ...readdirSync(at).flatMap((n) => (statSync(join(at, n)).isDirectory() ? walk(join(at, n), i) : []))];
    const m = re(parts[i]);
    return readdirSync(at).filter((n) => !n.startsWith(".") && m.test(n)).flatMap((n) => walk(join(at, n), i + 1));
  };
  return walk(dir, 0);
}

/** What is wrong with the records two or more jobs left in one records
 *  folder, as sentences; [] when each job left every per-job record under a
 *  folder named after its job folder and none sits straight in the records
 *  folder. */
export function checkRecordsPerJob(records, jobDirs = [], { declaration = readDeclaration(), except = [] } = {}) {
  // went-without.json is never left out: every job writes it, with no
  // entries when it lacked nothing, because the conformance check reads it
  // after whatever jobs it ran, and those may lack nothing.
  const everyJob = (r) => r.rest === WENT_WITHOUT;
  const wanted = perJobRecords(declaration).filter((r) => everyJob(r) || (!except.includes(r.name) && !except.includes(r.file)));
  if (!wanted.length) return [];
  const names = jobDirs.map((j) => basename(resolve(String(j))));
  if (names.length < 2) return ["hand in at least two job folders that shared one records folder: one job cannot show that the next keeps its record"];
  if (new Set(names).size !== names.length) return [`the job folders have the same name (${names.join(", ")}), so their records would share one folder; give each job a folder with a name of its own`];
  const out = [];
  for (const r of wanted) {
    if (matchesIn(records, r.rest).length) {
      out.push(`the record "${r.name}" (${r.file}) is written straight into the records folder as ${r.rest}, so each job overwrites the last; write it under a folder named after the job folder, join(RECORDS, basename(JOB_DIR))`);
    }
    for (const n of names) {
      if (!matchesIn(join(records, n), r.rest).length) {
        out.push(`the job in ${n} left no record "${r.name}" of its own: nothing matches ${n}/${r.rest} under the records folder`
          + (everyJob(r) ? `; every job writes went-without.json, with no entries when it lacked nothing, since the conformance check reads it after jobs that may lack nothing` : ""));
      }
    }
  }
  return out;
}

const ranDirectly = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (ranDirectly) {
  const DECL = { records: [
    { name: "went without", when: "per_task", file: "*/went-without.json" },
    { name: "calls", when: "per_task", file: "*/calls/*.json" },
    { name: "every name used", when: "standing", file: "names.json" },
  ] };
  const folders = (fn) => {
    const at = mkdtempSync(join(tmpdir(), "records-per-job-"));
    try { return fn(at); } finally { rmSync(at, { recursive: true, force: true }); }
  };
  const put = (p) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, "{}"); };

  test("a record is kept per job only when its pattern starts with the job's folder", () => {
    assert.deepEqual(perJobRecords(DECL).map((r) => r.rest), ["went-without.json", "calls/*.json"]);
    assert.deepEqual(perJobRecords({ records: ["a name only", { name: "x", file: "*/../x.json" }, { name: "y", when: "standing", file: "*/y.json" }] }), []);
  });

  test("each job's records under its own folder pass, and one straight in the records folder does not", () => {
    folders((at) => {
      const rec = join(at, "records");
      for (const j of ["m1", "m2"]) { put(join(rec, j, "went-without.json")); put(join(rec, j, "calls", "1.json")); }
      put(join(rec, "names.json"));
      const jobs = [join(at, "jobs", "m1"), join(at, "jobs", "m2")];
      assert.deepEqual(checkRecordsPerJob(rec, jobs, { declaration: DECL }), []);
      put(join(rec, "went-without.json"));
      assert.match(checkRecordsPerJob(rec, jobs, { declaration: DECL }).join(" "), /straight into the records folder/);
    });
  });

  test("a job that left a record nowhere of its own is named, unless the record is excepted", () => {
    folders((at) => {
      const rec = join(at, "records");
      put(join(rec, "m1", "went-without.json"));
      const jobs = [join(at, "m1"), join(at, "m2")];
      const found = checkRecordsPerJob(rec, jobs, { declaration: DECL, except: ["calls"] });
      assert.deepEqual(found.length, 1);
      assert.match(found[0], /m2 left no record "went without"/);
    });
  });

  test("fewer than two jobs, or two folders of one name, are said rather than passed", () => {
    assert.match(checkRecordsPerJob("/r", ["/j/m1"], { declaration: DECL }).join(" "), /two job folders/);
    assert.match(checkRecordsPerJob("/r", ["/a/m1", "/b/m1"], { declaration: DECL }).join(" "), /same name/);
    assert.deepEqual(checkRecordsPerJob("/r", ["/j/m1"], { declaration: { records: [] } }), []);
  });

  test("every per-job record this package declares names a file below the job's folder", () => {
    for (const r of perJobRecords(readDeclaration())) assert.ok(r.rest && !r.rest.startsWith("/"), `${r.name}: ${r.file}`);
  });
}
