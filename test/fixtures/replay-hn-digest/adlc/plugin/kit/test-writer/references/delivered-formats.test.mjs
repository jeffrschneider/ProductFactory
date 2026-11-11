// Every piece a job delivers is what its declared kind says it is.
// Written by the test writer into every suite it writes, the same bytes each
// time; it is the test writer's file and not the package's, so it is never
// edited here. The next suite the test writer writes for this package brings
// its current copy.
//   node --test test/delivered-formats.test.mjs
//
// What is worth pinning. An agent declares a kind for every output, and the
// next agent, the person reviewing it and the App all go by that kind, so a
// piece sent as one thing and declared as another breaks the hand-off. This
// holds each delivered piece to its kind, by its bytes:
//   - Markdown (text/markdown) parses as Markdown, not JSON or an HTML page,
//     and carries the convention its `about` sketches: the header's fields
//     and each fixed heading written in backticks, unless it is a case the
//     `about` gives a shape of its own ("When there was no sentence, the only
//     content is `## Nothing to count`"), and then it carries that case's;
//   - a JSON kind (application/vnd.<name>+json, or any +json) parses, and has
//     the top-level shape its `about` sketches in backticks, `{a, b}` or `[...]`;
//   - HTML is HTML, a URL is an address, an image, audio, video, PDF or
//     archive starts with its own signature, text is text;
//   - the media type pieces.json lists for a piece is the kind declared.
//
// How it is reached. The suite's other tests call checkDelivered(jobDir) on
// each job folder they fill, and assert it returns no problems. This file's
// own tests check the checker, check that every Markdown or JSON output's
// sketched convention is one a piece can be held to, and check each job folder
// under test/fixtures/delivered/ and under the folders DELIVERED names
// (separated by the path separator). Its tests run only when this file is run
// itself, so importing checkDelivered from it adds none.
//
// Nothing here touches a network, a model or a host.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const trim = (s) => String(s ?? "").trim();
const base = (kind) => trim(kind).split(";")[0].trim().toLowerCase();

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

/** Every declared output, by name: {kind, about}. Offerings and their steps
 *  (a descriptor) or jobs (a spec). */
export function declaredOutputs(decl) {
  const out = new Map();
  const add = (job) => {
    for (const o of Array.isArray(job?.outputs) ? job.outputs : []) {
      if (trim(o?.name) && trim(o?.kind) && !out.has(trim(o.name))) out.set(trim(o.name), { kind: trim(o.kind), about: trim(o.about) });
    }
  };
  for (const o of Array.isArray(decl?.offerings) ? decl.offerings : []) {
    add(o);
    for (const s of Array.isArray(o?.steps) ? o.steps : []) add(s);
  }
  for (const j of Array.isArray(decl?.jobs) ? decl.jobs : []) add(j);
  return out;
}

/** What a piece's `about` sketches: the fixed headings (`## ...` in
 *  backticks), the header's fields (`a, b` in backticks after "header" or
 *  "front matter"), and a JSON top-level shape (`{a, b?}` or `[...]`).
 *  A heading the `about` gives only to one case is not fixed: one in a
 *  sentence that opens on a case ("When there was no sentence, ... only
 *  `## Nothing to count`"), says it is only for one, or names the case
 *  straight after the heading (`## None` when nothing was found) is that
 *  case's, and each such sentence's headings are one of `cases`, a shape a
 *  piece may take instead (technical debt 647). */
export function conventionOf(about) {
  const text = String(about ?? "");
  const ticks = [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
  const isHeading = (t) => /^#{1,6} \S/.test(t);
  // Sentences, never ended inside backticks.
  const sentences = []; let cur = ""; let inTick = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    cur += ch;
    if (ch === "`") inTick = !inTick;
    else if (!inTick && /[.!?]/.test(ch) && (i + 1 === text.length || /\s/.test(text[i + 1]))) { sentences.push(cur); cur = ""; }
  }
  if (cur.trim()) sentences.push(cur);
  const OPENS_ON_A_CASE = /^[\s"'(*_-]*(?:when|whenever|if|unless|otherwise|instead|without|where there (?:is|are|was|were) no|with no|for an? (?:empty|failed|refused|missing)|on (?:an? )?(?:empty|failure|refusal|error)|in (?:the|an?) (?:empty|failure|error|refusal) case)\b/i;
  const ONLY_FOR_ONE = /\bonly (?:when|if|for|in|on)\b|\binstead\b/i;
  const CASE_AFTER = /^`\s*(?:\([^)]*\)\s*)?(?:only\s+)?(?:when|if|unless|for an? (?:empty|failed|refused)|on (?:an? )?(?:empty|failure|refusal))\b/i;
  const fixed = []; const cases = [];
  for (const s of sentences) {
    const found = [...s.matchAll(/`([^`]+)`/g)].filter((m) => isHeading(m[1].trim()));
    if (!found.length) continue;
    if (OPENS_ON_A_CASE.test(s) || ONLY_FOR_ONE.test(s)) { cases.push(found.map((m) => m[1].trim())); continue; }
    const own = [];
    for (const m of found) {
      if (CASE_AFTER.test(s.slice(m.index + m[0].length - 1))) own.push(m[1].trim());
      else fixed.push(m[1].trim());
    }
    if (own.length) cases.push(own);
  }
  const headings = [...new Set(fixed)];
  const fm = /(?:header|front matter)[^`]{0,40}`([^`#]+)`/i.exec(String(about ?? ""));
  const header = fm ? fm[1].split(",").map((f) => f.trim().replace(/\?$/, "")).filter((f) => /^[A-Za-z_][\w .-]*$/.test(f)) : [];
  const sketch = ticks.find((t) => /^[{[]/.test(t)) ?? null;
  let shape = null;
  if (sketch?.startsWith("[")) shape = { type: "array" };
  else if (sketch?.startsWith("{")) {
    const inner = sketch.replace(/^\{/, "").replace(/\}$/, "");
    const keys = []; let depth = 0; let cur = "";
    for (const ch of inner) {
      if ("{[(".includes(ch)) depth += 1;
      if ("}])".includes(ch)) depth -= 1;
      if (ch === "," && depth === 0) { keys.push(cur); cur = ""; } else cur += ch;
    }
    keys.push(cur);
    const names = keys.map((k) => /^\s*([A-Za-z_$][\w$-]*)(\??)/.exec(k)).filter(Boolean);
    shape = { type: "object", keys: names.filter((m) => !m[2]).map((m) => m[1]) };
  }
  return { headings, cases, header, shape };
}

const SIGNATURES = {
  "image/png": (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/gif": (b) => /^GIF8[79]a/.test(b.subarray(0, 6).toString("latin1")),
  "image/webp": (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
  "application/pdf": (b) => b.subarray(0, 5).toString("latin1") === "%PDF-",
  "audio/wav": (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WAVE",
  "audio/mpeg": (b) => b.subarray(0, 3).toString("latin1") === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0),
  "video/mp4": (b) => b.subarray(4, 8).toString("latin1") === "ftyp",
  "application/gzip": (b) => b[0] === 0x1f && b[1] === 0x8b,
  "application/zip": (b) => b.subarray(0, 4).toString("latin1") === "PK\u0003\u0004",
  "application/x-tar": (b) => b.subarray(257, 262).toString("latin1") === "ustar",
};
SIGNATURES["audio/x-wav"] = SIGNATURES["audio/wave"] = SIGNATURES["audio/wav"];
SIGNATURES["application/x-gzip"] = SIGNATURES["application/gzip"];

/** The bytes as UTF-8 text, or null when they are not text. */
export function textOf(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes ?? ""), "utf8");
  if (b.includes(0)) return null;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(b); } catch { return null; }
}

const parsesAsJson = (text) => { try { JSON.parse(text); return true; } catch { return false; } };
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A heading line as a pattern: `## <title>` stands for any title. */
const headingPattern = (h) => new RegExp(`^${escape(h).replace(/<[^>]*>/g, ".+")}\\s*$`, "im");

/** Every way these bytes are not what `kind` (with its `about`) says, as
 *  sentences; empty when they are. */
export function formatProblems(bytes, kind, about = "", what = "the piece") {
  const k = base(kind);
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes ?? ""), "utf8");
  const out = [];
  if (!b.length) return [`${what} is empty`];
  const text = textOf(b);
  const conv = conventionOf(about);
  if (k === "text/markdown") {
    if (text === null) return [`${what} is declared text/markdown and is not text`];
    const t = text.trim();
    if (/^[{[]/.test(t) && parsesAsJson(t)) return [`${what} is declared text/markdown and is JSON`];
    if (/^<(!doctype html|html)\b/i.test(t)) return [`${what} is declared text/markdown and is an HTML page`];
    // A piece carrying every heading of a case the about gives its own shape
    // is that case, and is held to nothing more (technical debt 647).
    if ((conv.cases ?? []).some((c) => c.length && c.every((h) => headingPattern(h).test(text)))) return out;
    for (const h of conv.headings) if (!headingPattern(h).test(text)) out.push(`${what} is missing the heading ${h} its convention names`);
    if (conv.header.length) {
      // The header is front matter, or the lines before the first heading of
      // the second level, so a title line (# Title) may come first. A field
      // may be bold or a list item: "source: x", "**Source:** x", "- source: x".
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(t);
      const top = fm ? fm[1] : t.split(/^#{2,6} /m)[0];
      for (const f of conv.header) {
        if (!new RegExp(`^\\s*(?:[-*]\\s+)?(?:\\*\\*|__)?${escape(f)}(?:\\*\\*|__)?\\s*:`, "im").test(top)
          && !new RegExp(`^\\s*(?:[-*]\\s+)?(?:\\*\\*|__)${escape(f)}\\s*:(?:\\*\\*|__)`, "im").test(top)) {
          out.push(`${what} has no ${f}: line in its header`);
        }
      }
    }
    return out;
  }
  if (k === "application/json" || k.endsWith("+json")) {
    if (text === null) return [`${what} is declared ${k} and is not text`];
    let doc;
    try { doc = JSON.parse(text); } catch (e) { return [`${what} is declared ${k} and does not parse as JSON: ${e.message}`]; }
    if (conv.shape?.type === "array" && !Array.isArray(doc)) out.push(`${what} is declared as a JSON list and is not one`);
    if (conv.shape?.type === "object") {
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) out.push(`${what} is declared as a JSON object and is not one`);
      else for (const key of conv.shape.keys) if (!(key in doc)) out.push(`${what} has no top-level ${key} its shape names`);
    }
    return out;
  }
  if (k === "text/html") {
    if (text === null) return [`${what} is declared text/html and is not text`];
    if (/^[{[]/.test(text.trim()) && parsesAsJson(text.trim())) return [`${what} is declared text/html and is JSON`];
    if (!/<(html|head|body|main|section|article|div|p|h[1-6]|table|ul|ol)\b/i.test(text)) out.push(`${what} is declared text/html and carries no HTML element`);
    return out;
  }
  if (k === "image/svg+xml" || k === "application/xml" || k === "text/xml" || k.endsWith("+xml")) {
    if (text === null || !text.trim().startsWith("<")) return [`${what} is declared ${k} and is not XML`];
    if (k === "image/svg+xml" && !/<svg\b/i.test(text)) out.push(`${what} is declared image/svg+xml and carries no svg element`);
    return out;
  }
  if (SIGNATURES[k]) return SIGNATURES[k](b) ? [] : [`${what} is declared ${k} and does not start the way a ${k} file does`];
  if (k === "text/vtt") return text !== null && text.startsWith("WEBVTT") ? [] : [`${what} is declared text/vtt and does not start WEBVTT`];
  if (k === "application/x-subrip") return text !== null && text.includes("-->") ? [] : [`${what} is declared application/x-subrip and carries no cue`];
  if (k === "url" || k === "text/uri-list") {
    const lines = (text ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    if (text === null || !lines.length || !lines.every((l) => /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(l))) return [`${what} is declared ${k} and is not one address per line`];
    return [];
  }
  if (k === "identifier") {
    if (text === null || /\r?\n./.test(text.trim()) || text.trim().length > 512) return [`${what} is declared identifier and is not one short line`];
    return [];
  }
  if (k === "text" || k.startsWith("text/")) return text === null ? [`${what} is declared ${k} and is not text`] : [];
  return [];
}

/** The pieces a job folder delivered: pieces.json, as {name, path, media_type}. */
export function piecesIn(jobDir) {
  const at = join(jobDir, "pieces.json");
  if (!existsSync(at)) return [];
  const doc = JSON.parse(readFileSync(at, "utf8"));
  const list = Array.isArray(doc) ? doc : Array.isArray(doc?.pieces) ? doc.pieces : [];
  return list.filter((e) => e && typeof e === "object" && trim(e.name));
}

/** The declared output a piece is filed under: its own name, or "<output>
 *  (<file>)" for one of several files under one output. */
export function outputFor(name, outputs) {
  const n = trim(name).toLowerCase();
  for (const [d, o] of outputs) {
    const dl = d.toLowerCase();
    if (n === dl || n.startsWith(`${dl} (`)) return { name: d, ...o };
  }
  return null;
}

/** Every delivered piece in a job folder that is not what its declared kind
 *  says, as sentences. A piece no output declares is said only with
 *  { undeclared: true }, because the package maker already warns on it and
 *  an agent released before the format rules may carry one. */
export function checkDelivered(jobDir, { declaration = readDeclaration(), undeclared = false } = {}) {
  const outputs = declaredOutputs(declaration);
  const problems = [];
  for (const p of piecesIn(jobDir)) {
    const o = outputFor(p.name, outputs);
    if (!o) {
      if (undeclared) problems.push(`the piece ${JSON.stringify(p.name)} is delivered and no output declares it`);
      continue;
    }
    const what = `the piece ${JSON.stringify(p.name)}`;
    if (trim(p.media_type) && o.kind.includes("/") && base(p.media_type) !== base(o.kind)) {
      problems.push(`${what} is listed as ${base(p.media_type)} and declared ${base(o.kind)}`);
    }
    if (!trim(p.path)) continue;
    const at = join(jobDir, p.path);
    if (!existsSync(at) || !statSync(at).isFile()) { problems.push(`${what} is listed at ${p.path} and is not there`); continue; }
    problems.push(...formatProblems(readFileSync(at), o.kind, o.about, what));
  }
  return problems;
}

/** A piece made from a convention, the smallest one that keeps it: the
 *  header's fields, then each heading with a line under it; or the JSON
 *  shape's keys. Null for a kind with nothing sketched to make. */
export function sampleOf(kind, about) {
  const k = base(kind); const c = conventionOf(about);
  if (k === "text/markdown") {
    // A Markdown piece whose about sketches no convention has nothing to make
    // a sample from; it is held only to being Markdown and not JSON or a page.
    if (!c.headings.length && !c.header.length) return null;
    const head = c.header.length ? `---\n${c.header.map((f) => `${f}: x`).join("\n")}\n---\n\n` : "";
    return head + c.headings.map((h) => `${h.replace(/<[^>]*>/g, "Example")}\n\nA line.\n`).join("\n");
  }
  if ((k === "application/json" || k.endsWith("+json")) && c.shape) {
    return JSON.stringify(c.shape.type === "array" ? [] : Object.fromEntries(c.shape.keys.map((key) => [key, null])));
  }
  return null;
}

/** The job folders this file checks by itself. */
export function jobFoldersToCheck(env = process.env, here = HERE) {
  const roots = [join(here, "fixtures", "delivered"), ...trim(env.DELIVERED).split(delimiter).filter(Boolean)];
  const out = [];
  for (const r of roots) {
    if (!existsSync(r) || !statSync(r).isDirectory()) continue;
    if (existsSync(join(r, "pieces.json"))) out.push(r);
    for (const n of readdirSync(r)) if (existsSync(join(r, n, "pieces.json"))) out.push(join(r, n));
  }
  return out;
}

const ranDirectly = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (ranDirectly) {
  test("markdown is held to its convention, and JSON or a page is not markdown", () => {
    const about = "Markdown: a header `source, read_at`, then `## Key points`, then `## <page title>` per page.";
    const good = "---\nsource: https://example.com\nread_at: 2026-10-27\n---\n\n## Key points\n\n- one\n\n## Example page\n\ntext\n";
    assert.deepEqual(formatProblems(good, "text/markdown", about), []);
    assert.match(formatProblems('{"points":[]}', "text/markdown", about).join(" "), /is JSON/);
    assert.match(formatProblems("## Points\n", "text/markdown", about).join(" "), /missing the heading ## Key points/);
    assert.match(formatProblems("## Key points\n## A page\n", "text/markdown", about).join(" "), /no source: line/);
  });

  test("a json kind parses and has the top-level shape its about sketches", () => {
    const about = "the cues, `{cues, font?, at}`";
    assert.deepEqual(formatProblems('{"cues":[],"at":1}', "application/vnd.example.cues+json", about), []);
    assert.match(formatProblems('{"cues":[]}', "application/vnd.example.cues+json", about).join(" "), /no top-level at/);
    assert.match(formatProblems("cues: none", "application/vnd.example.cues+json", about).join(" "), /does not parse as JSON/);
    assert.match(formatProblems("{}", "application/vnd.example.list+json", "`[ids]`").join(" "), /JSON list/);
  });

  test("html, addresses, identifiers, text and signed binaries are each what they say", () => {
    assert.deepEqual(formatProblems("<!doctype html><html><body><p>x</p></body></html>", "text/html"), []);
    assert.match(formatProblems('{"a":1}', "text/html").join(" "), /is JSON/);
    assert.deepEqual(formatProblems("https://example.com/a\nhttps://example.com/b\n", "url"), []);
    assert.match(formatProblems("see the page", "url").join(" "), /one address per line/);
    assert.match(formatProblems("a\nb", "identifier").join(" "), /one short line/);
    assert.deepEqual(formatProblems(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), "image/png"), []);
    assert.match(formatProblems("not a picture", "image/png").join(" "), /does not start the way/);
    assert.match(formatProblems(Buffer.from([0xff, 0xfe, 0x00]), "text/plain").join(" "), /is not text/);
    assert.match(formatProblems("", "text/plain").join(" "), /is empty/);
  });

  test("every declared markdown or json output sketches a convention a piece can be held to", () => {
    const outputs = declaredOutputs(readDeclaration());
    for (const [name, o] of outputs) {
      const sample = sampleOf(o.kind, o.about);
      if (sample === null) continue;
      assert.deepEqual(formatProblems(sample, o.kind, o.about, name), [], `${name}: a piece made from its own convention fails it`);
      if (base(o.kind) === "text/markdown" && conventionOf(o.about).headings.length) {
        assert.ok(formatProblems(JSON.stringify({ [name]: sample }), o.kind, o.about, name).length, `${name}: a JSON dump would pass as its markdown`);
      }
    }
  });

  test("every job folder kept as a delivered example holds pieces in their declared formats", (t) => {
    const folders = jobFoldersToCheck();
    if (!folders.length) { t.skip("no delivered examples under test/fixtures/delivered and none named by DELIVERED"); return; }
    for (const d of folders) assert.deepEqual(checkDelivered(d), [], d);
  });
}
