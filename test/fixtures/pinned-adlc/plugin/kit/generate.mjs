// The generators: the architecture record and the agent's own files, written
// from the approved spec, so no fact is typed twice.
//
// The builder writes only what needs judgement, and in one place each:
//   architecture.json  the facts the solution architect's model used to
//                      answer with (`node .adlc/generate.mjs brief` prints
//                      the shape and the rules)
//   prose.json         the words of the agent's files, by key
// Everything else is the ADLC agents' own code, carried into this kit byte for
// byte (plugin/sync.mjs): the architect's naming, binding and record, and the
// spec writer's structure and files. Where those agents asked a model, the
// builder's file is the answer, read once and checked the same way.
//
//   needs: node >= 22
//   node .adlc/generate.mjs brief    what architecture.json holds
//   node .adlc/generate.mjs record   spec.json + architecture.json -> architecture-record.md
//   node .adlc/generate.mjs files    spec.json + architecture-record.md + prose.json -> the agent's files
//   node .adlc/generate.mjs tests    spec.json -> the test writer's standard checks under test/
//
// Run in the build folder. `record` also reads answers.json (the person's
// answers to the record's questions, by key), stack.json (the organization's
// stack) and request.md (the person's own words), each when it is there.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INSTRUCTION, nameTheSystems, referenceAt } from "./solution-architect/scripts/name.mjs";
import { bindAll, houseAt, stackOf } from "./solution-architect/scripts/bind.mjs";
import { doneOf, forbiddenIn, publicAddressesOf, recordOf, stillOpenText } from "./solution-architect/scripts/check-record.mjs";
import { renderRecord } from "./solution-architect/scripts/architecture-record.mjs";
import { customerProducts } from "./solution-architect/scripts/no-provider.mjs";
import { parseRecord } from "./spec-writer/scripts/architecture-record.mjs";
import { proseAt, proseSlots, setProse, structureOf } from "./spec-writer/scripts/structure.mjs";
import { agentFilesOf } from "./spec-writer/scripts/files.mjs";
import { fitNeeds } from "./spec-writer/scripts/design.mjs";
import { fitCanUse, loadSchemas } from "./spec-writer/scripts/can-use.mjs";
import { keptInterfacesTest } from "./test-writer/scripts/kept-interfaces.mjs";
import { answerValues } from "./answers.mjs";

const KIT = dirname(fileURLToPath(import.meta.url));
const trim = (s) => String(s ?? "").trim();

export const FILES = {
  spec: "spec.json",
  architecture: "architecture.json",
  answers: "answers.json",
  stack: "stack.json",
  request: "request.md",
  record: "architecture-record.md",
  open: "still-open.md",
  prose: "prose.json",
};

/** The statement the record quotes: the person's own words where the build
 *  kept them, otherwise the spec's purpose and every phrase of the person's
 *  the spec quotes as a source. A system is kept only where these words call
 *  for it (the architect's calledFor). */
export function statementOf(spec, request = "") {
  if (trim(request)) return trim(request);
  const lines = [trim(spec?.purpose)].filter(Boolean);
  const add = (s) => { const t = trim(s); if (t && !lines.some((l) => l.toLowerCase().includes(t.toLowerCase()))) lines.push(t); };
  for (const f of spec?.features ?? []) for (const r of f?.requirements ?? []) add(r?.source?.said);
  for (const c of spec?.constraints ?? []) add(c?.source?.said);
  return lines.join("\n");
}

/** The architecture record from the builder's facts: the architect's own
 *  repair, called-for and settled steps (nameTheSystems, with the builder's
 *  file as the one answer), its binding (bindAll) and its record (recordOf).
 *  Returns the record's text and every reason it is not finished. */
export async function recordFrom({ spec, named, answers = {}, request = "", stack = null, defaults = null }) {
  const house = defaults ?? JSON.parse(readFileSync(houseAt(join(KIT, "solution-architect", "scripts")), "utf8"));
  // An answer to a destination's question is read against the record that
  // asked it, because the architect keys the question by its place there. So
  // the asking record is always made first, from the same facts, and the
  // answers read against it: the same inputs give the same record every time,
  // and a grant's decision never drops out on a later run.
  // The asking record is the one before any destination's answer: with the
  // answer in, its question would not be asked, and the answer not read.
  const ASKED_BY_PLACE = /^egress-\d+$/;
  const before = Object.fromEntries(Object.entries(answers ?? {}).filter(([k]) => !ASKED_BY_PLACE.test(k)));
  const first = await recordOnce({ spec, named, answers: before, request, stack, house, earlier: "" });
  const answersIt = first.questions.some((q) => ASKED_BY_PLACE.test(q.key) && trim(answers?.[q.key]));
  return answersIt ? recordOnce({ spec, named, answers, request, stack, house, earlier: first.text }) : first;
}

async function recordOnce({ spec, named, answers, request, stack, house, earlier }) {
  const asked = { statement: statementOf(spec, request), answers, defaults: house, stack, ...(trim(earlier) ? { revision: true, earlier: { text: earlier } } : {}) };
  const out = await nameTheSystems({ ask: async () => ({ text: JSON.stringify(named) }), asked, tries: 1 });
  if (out.declined) throw new Error(`architecture.json declines (${out.declined}): it holds the architecture and nothing else`);
  const vocabulary = house.systems ?? [];
  const bound = bindAll(out.architecture, { stack: stackOf(stack), vocabulary, answers, targets: house.targets ?? {} });
  const rec = recordOf({ asked, named: { architecture: out.architecture, questions: out.questions }, bound });
  const done = doneOf(rec, vocabulary);
  rec.done = done.done;
  const text = renderRecord(rec);
  const open = rec.questions.length ? stillOpenText(rec) : "";
  const forbidden = forbiddenIn(`${text}\n${open}`, undefined, { vocabulary, allowed: customerProducts(bound.systems), addresses: publicAddressesOf(rec) });
  return { text, open, done: done.done, problems: done.problems, findings: out.findings, notes: out.notes, questions: rec.questions, forbidden };
}

const isEmpty = (v) => v == null || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && !v.some((x) => trim(x)));
// What the refusals are is a list of sentences; every other prose key is one.
const shapeOf = (key) => (key === "refuses" ? [] : "");
const fitsShape = (key, v) => (key === "refuses" ? Array.isArray(v) && v.every((x) => typeof x === "string") : typeof v === "string");

/** The agent's own files: the structure from the spec and the record by code,
 *  the words from prose.json by key. A key the spec fixes is the spec's, and
 *  a key the files do not have is named, never guessed at. */
export function filesFrom({ spec, recordText = "", prose = {} }) {
  const architecture = trim(recordText) ? parseRecord(recordText) : null;
  const built = structureOf(spec, { architecture });
  const draft = structuredClone(built.draft);
  const fixed = new Set(built.fixed);
  const slots = proseSlots(draft);
  const unknown = [];
  const refused = [];
  const misshapen = [];
  for (const [k, v] of Object.entries(prose ?? {})) {
    if (!slots.includes(k)) unknown.push(k);
    else if (fixed.has(k)) refused.push(k);
    else if (isEmpty(v)) continue;
    else if (!fitsShape(k, v)) misshapen.push(k);
    else setProse(draft, k, k === "refuses" ? v.map(trim).filter(Boolean) : v);
  }
  const writable = slots.filter((k) => !fixed.has(k));
  const empty = writable.filter((k) => isEmpty(proseAt(draft, k)));
  // What the Design's code settled after the words, the same here: the hosts
  // in each service's needs, and the standing assets the record decides, in
  // can_use. (A system the record does not name is never in the structure.)
  const needs = fitNeeds(draft, spec);
  const assets = fitCanUse(needs.draft, architecture, loadSchemas());
  const done = assets.spec;
  // prose.json as it should stand: the builder's words kept, every key the
  // files now have laid out, and a key they no longer have left for the
  // builder to move or delete, never dropped here.
  const laidOut = { ...Object.fromEntries(writable.map((k) => [k, prose?.[k] ?? shapeOf(k)])), ...Object.fromEntries(unknown.map((k) => [k, prose[k]])) };
  // `worded` is the draft before the standing assets: the Design checked its
  // addresses there, because a can_use schema is a name and never fetched.
  return { files: agentFilesOf(done), draft: done, worded: needs.draft, architecture, notes: [...built.notes, ...needs.notes, ...[assets.notes].flat()].filter(Boolean), problems: built.problems, asks: built.asks, slots: writable, fixed: [...fixed], empty, unknown, refused, misshapen, laidOut };
}

/** The test writer's standard checks, which every suite carries and nobody
 *  writes: four copied as they are, and the kept-interfaces check made from
 *  the spec when it keeps an interface. {path: text}. */
export const STANDARD_TESTS = ["delivered-formats.test.mjs", "records-per-job.test.mjs", "worked-values.test.mjs", "printed-reply.test.mjs"];
export function standardTestsOf(spec) {
  const ref = (n) => readFileSync(join(KIT, "test-writer", "references", n), "utf8");
  const out = Object.fromEntries(STANDARD_TESTS.map((n) => [`test/${n}`, ref(n)]));
  const kept = keptInterfacesTest(spec, ref("kept-interfaces.test.mjs"));
  if (kept) out[kept.path] = kept.text;
  return out;
}

const readJson = (dir, name) => (existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), "utf8")) : null);
const readText = (dir, name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : "");

async function main(cmd, dir) {
  if (cmd === "brief") {
    const std = referenceAt("architecture-standard.md", join(KIT, "solution-architect", "scripts"));
    const example = referenceAt("a-record-that-works.md", join(KIT, "solution-architect", "scripts"));
    console.log(`Write ${FILES.architecture} as the solution architect's answer below asks. Read the standard first: ${std}\nA record that works: ${example}\n\n${INSTRUCTION}`);
    return 0;
  }
  const spec = readJson(dir, FILES.spec);
  if (!spec) { console.error(`${FILES.spec} is not in ${dir}: the generators write from the approved spec`); return 2; }
  if (cmd === "record") {
    const named = readJson(dir, FILES.architecture);
    if (!named) { console.error(`${FILES.architecture} is not in ${dir}: run \`node .adlc/generate.mjs brief\` for what it holds`); return 2; }
    const r = await recordFrom({ spec, named, answers: answerValues(readJson(dir, FILES.answers) ?? {}), request: readText(dir, FILES.request), stack: readJson(dir, FILES.stack) });
    if (r.forbidden.length) {
      console.log(JSON.stringify({ ok: false, wrote: [], refused: r.forbidden.map((f) => `the record would carry ${f}; a record names no model, model provider, address or credential`) }, null, 2));
      return 1;
    }
    writeFileSync(join(dir, FILES.record), r.text);
    if (r.open) writeFileSync(join(dir, FILES.open), r.open);
    else rmSync(join(dir, FILES.open), { force: true });
    console.log(JSON.stringify({ ok: true, wrote: [FILES.record, ...(r.open ? [FILES.open] : [])], done: r.done, problems: r.problems, findings: r.findings, notes: r.notes, questions: r.questions }, null, 2));
    return 0;
  }
  if (cmd === "files") {
    const prose = readJson(dir, FILES.prose) ?? {};
    const r = filesFrom({ spec, recordText: readText(dir, FILES.record), prose });
    for (const [rel, text] of Object.entries(r.files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    writeFileSync(join(dir, FILES.prose), JSON.stringify(r.laidOut, null, 2) + "\n");
    const ok = !r.empty.length && !r.unknown.length && !r.refused.length && !r.misshapen.length && !r.problems.length;
    console.log(JSON.stringify({
      ok, wrote: Object.keys(r.files), record: Boolean(readText(dir, FILES.record)),
      empty: r.empty, unknown: r.unknown.map((k) => `${k} is not a key of the agent's files; move its words to the key that is, or delete it`),
      refused: r.refused.map((k) => `${k} is fixed by the spec; change the spec, not the prose`),
      misshapen: r.misshapen.map((k) => (k === "refuses" ? "refuses is a list of sentences" : `${k} is one string`)),
      problems: r.problems, notes: r.notes, asks: r.asks,
    }, null, 2));
    return ok ? 0 : 1;
  }
  if (cmd === "tests") {
    const files = standardTestsOf(spec);
    for (const [rel, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); }
    const scenarios = (spec.features ?? []).flatMap((f) => (f.acceptance ?? []).map((a) => a.id));
    console.log(JSON.stringify({
      ok: true, wrote: Object.keys(files),
      write: `one test file per feature under test/, each test named with the scenario it checks in square brackets ("[F1.A1] ..."): ${scenarios.join(", ")}`,
      read_first: [join(KIT, "test-writer", "references", "what-a-good-suite-carries.md"), join(KIT, "test-writer", "references", "a-suite-that-works.test.mjs")],
    }, null, 2));
    return 0;
  }
  console.error("usage: node .adlc/generate.mjs brief | record | files | tests");
  return 2;
}

const thisFile = process.argv[1] ? process.argv[1].replace(/\\/g, "/").split("/").pop() : "";
if (thisFile === "generate.mjs" && import.meta.url.endsWith("/generate.mjs")) {
  const dirAt = process.argv.indexOf("--dir");
  const dir = dirAt > 0 ? process.argv[dirAt + 1] : process.cwd();
  main(process.argv[2], dir).then((code) => { process.exitCode = code; }, (e) => { console.error(e.message); process.exitCode = 1; });
}
