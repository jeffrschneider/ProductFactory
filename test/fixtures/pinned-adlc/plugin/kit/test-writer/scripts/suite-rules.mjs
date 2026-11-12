// Three checks on a suite that need no model, and the one repair a revision
// gets (test-writer 0.8.0). A round trip on 2026-11-09 rebuilt a real agent
// from its as-built record, and the suite this agent wrote for it showed
// three faults no earlier check saw:
//
// - The features said "a 10-second timeout", "up to 20 at a time" and
//   "2,000,000 characters", and no test of those features asserted the
//   numbers, so the code written to the suite dropped them. pinFindings
//   lists each number and each quoted word or pattern a feature (or a
//   refusal) states that no test of it carries.
// - A test wrapped a function that reads through an async fetch in
//   assert.throws, which only catches a throw made before the function
//   returns; no script that keeps the spec could pass it. asyncThrowsFindings
//   names each assert.throws or assert.doesNotThrow whose callback is async,
//   awaits, or reaches a function declared async or handed an async stand-in.
// - Sent back to fix that one test, with "change nothing else", the answer
//   also changed two other tests and a constant they used. restoreUnnamed
//   puts every test the person's words did not name back byte for byte, and
//   says what it put back.
//
// A test is a top-level `test(...)` (or `it(...)`, or a `describe(...)` with
// its tests) in the file, from its first line at the left margin to the line
// before the next statement there, with any comment lines just above it.
//
//   needs: node >= 22
//   import { pinFindings, asyncThrowsFindings, namedTestsIn, restoreUnnamed, scenarioIdsIn } from "./suite-rules.mjs"

const trim = (s) => String(s ?? "").trim();
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

// ── the top-level statements of a test file ─────────────────────────────────

/** Where each line of a file starts at bracket depth 0 and outside any
 *  string, template, comment or regular expression: those lines are where a
 *  top-level statement may begin. Read character by character, so a brace in
 *  a string or a pattern does not count. */
function topLevelLines(text) {
  const out = [];
  let depth = 0;
  let state = "code"; // code | line | block | ' | " | ` | regex | class
  const templ = []; // depth at each ${ inside a template
  let prev = ""; // the last significant character outside strings and comments
  let atLineStart = true;
  let line = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (atLineStart) { out[line] = state === "code" && depth === 0; atLineStart = false; }
    if (c === "\n") {
      if (state === "line") state = "code";
      line += 1; atLineStart = true;
      if (state === "'" || state === '"') state = "code"; // an unclosed quote opens no string
      continue;
    }
    if (state === "line") continue;
    if (state === "block") { if (c === "*" && text[i + 1] === "/") { state = "code"; i += 1; } continue; }
    if (state === "'" || state === '"') { if (c === "\\") i += 1; else if (c === state) { state = "code"; prev = "a"; } continue; }
    if (state === "`") {
      if (c === "\\") i += 1;
      else if (c === "`") { state = "code"; prev = "a"; }
      else if (c === "$" && text[i + 1] === "{") { templ.push(depth); depth += 1; state = "code"; i += 1; }
      continue;
    }
    if (state === "regex") {
      if (c === "\\") i += 1;
      else if (c === "[") state = "class";
      else if (c === "/") { state = "code"; prev = "a"; }
      continue;
    }
    if (state === "class") { if (c === "\\") i += 1; else if (c === "]") state = "regex"; continue; }
    // code
    if (c === "/" && text[i + 1] === "/") { state = "line"; continue; }
    if (c === "/" && text[i + 1] === "*") { state = "block"; i += 1; continue; }
    if (c === "'" || c === '"' || c === "`") { state = c; continue; }
    if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev) || /\b(?:return|typeof|case|of|in)\s*$/.test(text.slice(Math.max(0, i - 8), i)))) { state = "regex"; continue; }
    if (c === "}" && templ.length && templ[templ.length - 1] === depth - 1) { depth -= 1; templ.pop(); state = "`"; continue; }
    if ("([{".includes(c)) depth += 1;
    else if (")]}".includes(c)) depth = Math.max(0, depth - 1);
    if (!/\s/.test(c)) prev = c;
  }
  if (atLineStart) out[line] = state === "code" && depth === 0;
  return out;
}

const TEST_START = /^(?:test|it|describe|suite)(?:\.(?:skip|only|todo))?\s*\(\s*(["'`])((?:(?!\1).)+)\1/;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

/** The names of the tests in a piece of a file, as written, nested ones too. */
export function testNamesIn(text) {
  return [...String(text ?? "").matchAll(/^\s*(?:test|it|describe|suite)(?:\.(?:skip|only|todo))?\(\s*(["'`])((?:(?!\1).)+)\1/gm)].map((m) => m[2]);
}

/** A file as its top-level statements, in order, each with its text, its
 *  first and last line (1-based), whether it is a test, the test names in it
 *  and the names it declares. Joined back together they are the file, byte
 *  for byte. A comment just above a statement belongs to it. */
export function chunksOf(text) {
  const src = String(text ?? "");
  const lines = src.split("\n");
  const top = topLevelLines(src);
  const starts = [];
  lines.forEach((l, i) => { if (top[i] && /^\S/.test(l) && !/^[}\])]/.test(l)) starts.push(i); });
  if (!starts.length || starts[0] !== 0) starts.unshift(0);
  const raw = starts.map((s, k) => ({ from: s, to: (k + 1 < starts.length ? starts[k + 1] : lines.length) - 1 }));
  // A piece that is only comments and blank lines joins the one after it.
  const merged = [];
  let carry = null;
  for (const r of raw) {
    const body = lines.slice(r.from, r.to + 1);
    const onlyComments = body.every((l) => !trim(l) || COMMENT_LINE.test(l));
    if (onlyComments && r !== raw[raw.length - 1]) { carry = carry ?? r.from; continue; }
    merged.push({ from: carry ?? r.from, to: r.to });
    carry = null;
  }
  return merged.map(({ from, to }) => {
    const t = lines.slice(from, to + 1).join("\n") + (to < lines.length - 1 ? "\n" : "");
    const code = lines.slice(from, to + 1).find((l) => trim(l) && !COMMENT_LINE.test(l)) ?? "";
    const m = TEST_START.exec(code);
    return {
      text: t, start: from + 1, end: to + 1,
      test: Boolean(m), name: m ? m[2] : null, names: m ? testNamesIn(t) : [],
      declares: m ? [] : declaredNames(code + "\n" + t),
      import: /^import\b/.test(code),
      from: /^import\b/.test(code) ? (/from\s*["']([^"']+)["']/.exec(t)?.[1] ?? /^import\s*["']([^"']+)["']/.exec(code)?.[1] ?? null) : null,
    };
  });
}

/** The names a top-level statement declares. */
function declaredNames(text) {
  const first = String(text);
  const out = new Set();
  let m;
  if ((m = /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(first))) out.add(m[1]);
  if ((m = /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(first))) out.add(m[1]);
  if ((m = /^\s*(?:export\s+)?(?:const|let|var)\s+([\s\S]*?)=/.exec(first))) {
    for (const n of m[1].matchAll(/[A-Za-z_$][\w$]*/g)) out.add(n[0]);
  }
  if (/^\s*import\b/.test(first)) {
    const head = /^\s*import\s+([\s\S]*?)\s+from\b/.exec(first)?.[1] ?? "";
    for (const part of head.replace(/[{}]/g, ",").split(",")) {
      const name = trim(part).split(/\s+as\s+/).pop().replace(/^\*\s*as\s+/, "");
      if (/^[A-Za-z_$][\w$]*$/.test(trim(name))) out.add(trim(name));
    }
  }
  return [...out];
}

// ── which tests the person's words name ─────────────────────────────────────

/** The quoted phrases in a person's words: in backticks, in double quotes
 *  (straight or curly), each 12 characters or more. */
export function quotedPhrases(words) {
  const out = [];
  for (const m of String(words ?? "").matchAll(/`([^`\n]{12,})`|"([^"\n]{12,})"|“([^”\n]{12,})”/g)) out.push(trim(m[1] ?? m[2] ?? m[3]));
  return [...new Set(out.filter(Boolean))];
}

/** The lines of `path` the words cite: "<file>:118", "line 118", "lines
 *  117 to 119" or "lines 117-119". A bare line number is read against every
 *  file the words name, which can only name more tests, never fewer. */
export function citedLines(words, path) {
  const text = String(words ?? "");
  const name = String(path).split("/").pop();
  const out = new Set();
  for (const m of text.matchAll(new RegExp(`${escapeRe(name)}:(\\d+)`, "g"))) out.add(Number(m[1]));
  for (const m of text.matchAll(/\blines?\s+(\d+)(?:\s*(?:-|–|to|through)\s*(\d+))?/gi)) {
    const a = Number(m[1]); const b = m[2] ? Number(m[2]) : a;
    for (let n = Math.min(a, b); n <= Math.max(a, b) && n - Math.min(a, b) < 500; n += 1) out.add(n);
  }
  return out;
}

/** Which tests of one file the person's words name, given that the words
 *  name the file (by its name or a test's name; see namedForRevision). A test
 *  is named by its own name written out (12 characters or more), by a line
 *  of it the words cite, by a phrase the words quote that appears in that
 *  test and in no other test of the file (an assertion copied into the
 *  words), or by the spec's id for an acceptance scenario its name opens
 *  with ("F1.A2" names "[F1.A2] ...", test-writer 0.9.0). When the words name
 *  the file and none of its tests, every test in it is named: the whole file
 *  was sent back. Returns { all, names }. */
export function namedTestsIn(file, words = "") {
  const text = String(words ?? "");
  const chunks = chunksOf(file?.text);
  const tests = chunks.filter((c) => c.test);
  const lines = citedLines(text, file?.path ?? "");
  const phrases = quotedPhrases(text);
  const scenarios = scenarioIdsIn(text);
  const names = new Set();
  for (const c of tests) {
    const byName = c.names.some((n) => n.length >= 12 && text.includes(n));
    let byLine = false;
    for (const n of lines) if (n >= c.start && n <= c.end) byLine = true;
    const byPhrase = phrases.some((p) => c.text.includes(p) && tests.filter((o) => o.text.includes(p)).length === 1);
    const byScenario = c.names.some((n) => namedByScenario(n, scenarios));
    if (byName || byLine || byPhrase || byScenario) c.names.forEach((n) => names.add(n));
  }
  return { all: names.size === 0, names };
}

// ── putting back what the words did not name ────────────────────────────────

const ensureNl = (t) => (t.endsWith("\n") ? t : `${t}\n`);

/** A statement's text without the blank lines after it, for comparing. */
const bare = (t) => String(t).replace(/\s*$/, "");

/** A statement's text with the blank lines after it taken from `like`, so a
 *  test put in another's place leaves the spacing of the file as it was. */
const withTail = (text, like) => String(text).replace(/\s*$/, "") + (/\s*$/.exec(String(like))?.[0] ?? "");

/** A revised file with every test the words did not name put back as it was.
 *
 *  `before` is the file as the suite had it, `after` the model's answer, and
 *  `named` what namedTestsIn found. With the whole file named, the answer
 *  stands. Otherwise the file is the one before, statement by statement:
 *  - a named test is the answer's (a named test the answer renamed takes the
 *    answer's test of a new name in its place);
 *  - a test not named is put back byte for byte, whatever the answer did to
 *    it, and so is one the answer dropped; a test the answer added under a
 *    name of its own is taken out;
 *  - every other statement before is kept as it was. An import the answer
 *    widened (the same module, every name kept, names added) is the
 *    answer's; a constant, function or import the answer changed or dropped
 *    is kept as it was, since a test not named may use it;
 *  - a statement the answer added that declares nothing the file already
 *    declares goes in: an import after the last import, anything else before
 *    the first test.
 *  Returns { text, restored, dropped, added, kept, fresh }: the names of the
 *  tests put back because the answer changed them, the tests put back because
 *  it dropped them, the tests it added that were taken out, the declarations
 *  kept as they were although it changed them, and the lines of the result
 *  that are the answer's own. */
export function restoreUnnamed(before, after, named = { all: true, names: new Set() }) {
  const lineCount = (t) => String(t).split("\n").length - (String(t).endsWith("\n") ? 1 : 0);
  if (named.all) {
    return { text: after, restored: [], dropped: [], added: [], kept: [], fresh: new Set(Array.from({ length: lineCount(after) }, (_, i) => i + 1)) };
  }
  const old = chunksOf(before);
  const got = chunksOf(after);
  const oldTestNames = new Set(old.filter((c) => c.test).map((c) => c.name));
  const gotTests = new Map();
  for (const c of got) if (c.test && !gotTests.has(c.name)) gotTests.set(c.name, c);
  const isNamed = (c) => c.names.some((n) => named.names.has(n));
  // The answer's tests under names the file did not have: a named test it
  // renamed, when one of those is missing, or an addition otherwise.
  const newcomers = got.filter((c) => c.test && !oldTestNames.has(c.name));
  const missingNamed = old.filter((c) => c.test && isNamed(c) && !gotTests.has(c.name));
  const restored = []; const dropped = []; const added = []; const kept = [];
  const out = []; // [{ text, fresh }]
  let renamesPlaced = false;
  const usedGot = new Set();
  for (const c of old) {
    if (c.test) {
      if (isNamed(c)) {
        const now = gotTests.get(c.name);
        if (now) { const t = withTail(now.text, c.text); out.push({ text: t, fresh: t !== c.text }); usedGot.add(now); }
        else if (!renamesPlaced && missingNamed.length && newcomers.length) {
          renamesPlaced = true;
          for (const n of newcomers) { out.push({ text: withTail(n.text, c.text), fresh: true }); usedGot.add(n); }
        }
        continue;
      }
      const now = gotTests.get(c.name);
      if (now) usedGot.add(now);
      if (!now) dropped.push(c.name);
      else if (bare(now.text) !== bare(c.text)) restored.push(c.name);
      out.push({ text: c.text, fresh: false });
      continue;
    }
    const same = got.find((g) => !g.test && !usedGot.has(g) && bare(g.text) === bare(c.text));
    if (same) { usedGot.add(same); out.push({ text: c.text, fresh: false }); continue; }
    const overlap = got.find((g) => !g.test && !usedGot.has(g) && g.declares.some((n) => c.declares.includes(n)));
    if (overlap) {
      usedGot.add(overlap);
      if (c.import && overlap.import && c.from && c.from === overlap.from && c.declares.every((n) => overlap.declares.includes(n))) {
        out.push({ text: overlap.text, fresh: true });
        continue;
      }
      kept.push(...c.declares.filter((n) => overlap.declares.includes(n)));
    }
    out.push({ text: c.text, fresh: false });
  }
  for (const n of newcomers) if (!usedGot.has(n)) added.push(n.name);
  // Statements the answer added that declare nothing the file has.
  const declaredBefore = new Set(old.flatMap((c) => c.declares));
  const extras = got.filter((g) => !g.test && !usedGot.has(g) && !g.declares.some((n) => declaredBefore.has(n))
    && !old.some((c) => bare(c.text) === bare(g.text)) && trim(g.text));
  for (const e of extras) {
    if (e.import) {
      let at = -1;
      out.forEach((o, i) => { if (/^\s*(?:\/\/[^\n]*\n|\s)*import\b/.test(o.text)) at = i; });
      out.splice(at + 1, 0, { text: e.text, fresh: true });
    } else {
      const firstTest = out.findIndex((o) => TEST_START.test((o.text.split("\n").find((l) => trim(l) && !COMMENT_LINE.test(l))) ?? ""));
      out.splice(firstTest === -1 ? out.length : firstTest, 0, { text: withTail(e.text, "\n\n"), fresh: true });
    }
  }
  let text = "";
  const fresh = new Set();
  out.forEach((o, i) => {
    const piece = i < out.length - 1 ? ensureNl(o.text) : o.text;
    const startLine = lineCount(text) + 1;
    if (o.fresh) for (let k = 0; k < lineCount(piece); k += 1) fresh.add(startLine + k);
    text += piece;
  });
  if (String(before).endsWith("\n") && !text.endsWith("\n")) text += "\n";
  return { text, restored, dropped, added, kept: [...new Set(kept)], fresh };
}

/** What restoreUnnamed put back, as sentences for the record and the reply. */
export function restoreNotes(path, r) {
  const out = [];
  const list = (xs) => xs.map((n) => `"${n}"`).join(", ");
  if (r.restored.length) out.push(`${path}: put back as it was, because the words did not name ${r.restored.length === 1 ? "it" : "them"}: ${list(r.restored)}`);
  if (r.dropped.length) out.push(`${path}: put back after the answer dropped ${r.dropped.length === 1 ? "it" : "them"}, because the words did not name ${r.dropped.length === 1 ? "it" : "them"}: ${list(r.dropped)}`);
  if (r.added.length) out.push(`${path}: taken out, because a revision changes only the tests the words name and these are new: ${list(r.added)}`);
  if (r.kept.length) out.push(`${path}: kept as ${r.kept.length === 1 ? "it was" : "they were"}, because a test the words did not name may use ${r.kept.length === 1 ? "it" : "them"}: ${r.kept.join(", ")}`);
  return out;
}

// ── assert.throws around something async ────────────────────────────────────

/** The first argument of a call whose text starts at `open` (just inside its
 *  parenthesis), as written. */
function firstArgument(text, open) {
  let depth = 0; let quote = null; let cur = "";
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) { cur += ch; if (ch === "\\") { cur += text[i + 1] ?? ""; i += 1; } else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; cur += ch; continue; }
    if ("([{".includes(ch)) depth += 1;
    if (")]}".includes(ch)) { if (depth === 0) return cur; depth -= 1; }
    if (ch === "," && depth === 0) return cur;
    cur += ch;
  }
  return cur;
}

/** The names a piece of code declares async: `async function name`,
 *  `name = async (...)` or `name = async x =>`, and `name: async`. */
export function asyncNamesIn(text) {
  const out = new Set();
  const t = String(text ?? "");
  for (const m of t.matchAll(/\basync\s+function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  for (const m of t.matchAll(/([A-Za-z_$][\w$]*)\s*[:=]\s*async\b/g)) out.add(m[1]);
  return out;
}

/** Each assert.throws or assert.doesNotThrow in a suite whose callback is
 *  async, awaits, or names a function declared async (in the same file or a
 *  file the change depends on) or handed an async stand-in, by file and line.
 *  assert.throws only sees a throw made before the function returns; an
 *  async function refuses by returning a rejected promise, so the test can
 *  never pass against a script that keeps the spec (round trip, 2026-11-09).
 *  `fresh`, a Set of lines per path, limits a file to those lines. */
export function asyncThrowsFindings(files = [], { dependencies = [], skip = [], fresh = null } = {}) {
  const out = [];
  const fromDeps = new Set();
  for (const d of dependencies) for (const n of asyncNamesIn(d.text)) fromDeps.add(n);
  for (const f of files) {
    if (skip.includes(f.path)) continue;
    const text = String(f.text ?? "");
    const names = new Set([...asyncNamesIn(text), ...fromDeps]);
    const bare = /import\s*\{[^}]*\b(?:throws|doesNotThrow)\b[^}]*\}\s*from\s*["']node:assert/.test(text);
    const re = bare ? /(?<![\w$])(?:assert\s*\.\s*)?(throws|doesNotThrow)\s*\(/g : /\bassert\s*\.\s*(throws|doesNotThrow)\s*\(/g;
    for (const m of text.matchAll(re)) {
      const line = text.slice(0, m.index).split("\n").length;
      if (fresh?.get?.(f.path) && !fresh.get(f.path).has(line)) continue;
      const arg = firstArgument(text, m.index + m[0].length);
      const why = /^\s*async\b/.test(arg) ? "its callback is an async function"
        : /\bawait\b/.test(arg) ? "its callback awaits"
          : /\basync\b/.test(arg) ? "its callback hands the function an async stand-in"
            : [...arg.matchAll(/[A-Za-z_$][\w$]*/g)].map((x) => x[0]).find((n) => names.has(n));
      if (!why) continue;
      const said = why.startsWith("its ") ? why : `it reaches ${why}, which is declared async or is an async stand-in`;
      const instead = m[1] === "throws" ? "await assert.rejects(promise, ...)" : "await assert.doesNotReject(promise)";
      out.push(`${f.path}:${line} wraps the call in assert.${m[1]}, and ${said}: assert.${m[1]} sees only a throw made before the function returns, and an async function refuses with a rejected promise, so no script that keeps the spec can pass it. Make the test async and use ${instead}`);
    }
  }
  return out;
}

// ── every number and quoted word a feature states, pinned ───────────────────

/** The features the message lists, as "- F3 (offering ...): Name. Words."
 *  lines: [{ id, text }]. */
export function featuresIn(words = "") {
  const out = [];
  for (const m of String(words ?? "").matchAll(/^\s*[-*]\s*\[?(F\d+)\]?(?:\s*\([^)\n]*\))?\s*:\s*(.+)$/gm)) out.push({ id: m[1], text: trim(m[2]) });
  return out;
}

const NUMBER_WORDS = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, hundred: 100 };
const SECONDS = /^(?:s|secs?|seconds?)$/i;
const MINUTES = /^(?:mins?|minutes?)$/i;

/** What a sentence states that a test can pin: each number (digits, with
 *  thousands commas, or a number word from two to a hundred), with the
 *  values a test may write it as (10 seconds as 10 or 10000, 2 minutes as 2,
 *  120 or 120000), and each phrase it quotes (in backticks, double quotes,
 *  curly quotes, or single quotes standing apart from the words around them).
 *  A feature's own id, a version and a number inside a word are not numbers
 *  it states. Returns { numbers: [{said, values}], phrases: [] }. */
export function statedIn(sentence = "") {
  const text = String(sentence ?? "");
  const phrases = [];
  for (const m of text.matchAll(/`([^`\n]+)`|"([^"\n]+)"|“([^”\n]+)”|(?<![\w])'([^'\n]{3,}?)'(?![\w])/g)) {
    const p = trim(m[1] ?? m[2] ?? m[3] ?? m[4]);
    if (p) phrases.push(p);
  }
  const numbers = [];
  const plain = text.replace(/\[?\bF\d+\]?/g, " ");
  for (const m of plain.matchAll(/(?<![\w.$-])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:(?:-|\s+)([A-Za-z]+))?/g)) {
    const after = plain[m.index + m[0].length] ?? "";
    if (/[\w]/.test(after) && !m[3]) continue;
    if (/^\.\d/.test(plain.slice(m.index + m[0].length))) continue; // a version such as 1.0.0
    const n = Number(m[1].replace(/,/g, "") + (m[2] ? `.${m[2]}` : ""));
    const values = new Set([String(n)]);
    if (m[3] && SECONDS.test(m[3])) values.add(String(n * 1000));
    if (m[3] && MINUTES.test(m[3])) { values.add(String(n * 60)); values.add(String(n * 60000)); }
    numbers.push({ said: m[3] && (SECONDS.test(m[3]) || MINUTES.test(m[3])) ? m[0].trim() : m[1], values });
  }
  for (const m of plain.matchAll(/\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|hundred)\b(?:(?:-|\s+)([A-Za-z]+))?/gi)) {
    const n = NUMBER_WORDS[m[1].toLowerCase()];
    const values = new Set([String(n)]);
    if (m[2] && SECONDS.test(m[2])) values.add(String(n * 1000));
    if (m[2] && MINUTES.test(m[2])) { values.add(String(n * 60)); values.add(String(n * 60000)); }
    numbers.push({ said: m[1], values });
  }
  return { numbers, phrases: [...new Set(phrases)] };
}

/** The numbers a piece of test code writes: 2000000, 2_000_000 and
 *  "2,000,000" are one number. */
export function numbersWritten(code = "") {
  const out = new Set();
  const t = String(code ?? "");
  for (const m of t.matchAll(/(?<![\w.$])\d[\d_]*(?:\.\d+)?(?![\w])/g)) out.add(String(Number(m[0].replace(/_/g, ""))));
  for (const m of t.matchAll(/(?<![\w.])\d{1,3}(?:,\d{3})+(?![\d])/g)) out.add(String(Number(m[0].replace(/,/g, ""))));
  return out;
}

/** Whether test code carries a quoted phrase as written, or escaped as it
 *  would be in a regular expression. */
const carriesPhrase = (code, phrase) => code.includes(phrase) || code.includes(escapeRe(phrase))
  || code.includes(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

/** The feature ids a test's name opens with, "[F3, F5] ..." giving F3 and
 *  F5. A spec's scenario or requirement id counts for its feature
 *  (test-writer 0.9.0): "[F1.A2] ..." gives F1. */
export const featureIdsOf = (name) => {
  const m = /^\s*\[([^\]]+)\]/.exec(String(name ?? ""));
  if (!m) return [];
  return [...new Set(m[1].split(/[,\s]+/).map((x) => /^(F\d+)(?:\.[AR]\d+)?$/.exec(x)?.[1]).filter(Boolean))];
};

/** The acceptance scenario ids a person's words name, "F1.A2" (test-writer
 *  0.9.0). An id is whole: F1.A1 is not named by F1.A10. */
export const scenarioIdsIn = (words) => [...new Set([...String(words ?? "").matchAll(/(?<![\w.])F\d+\.A\d+(?![\w])/g)].map((m) => m[0]))];

/** Whether a test name opens with one of these scenario ids in square
 *  brackets. */
export const namedByScenario = (name, ids) => {
  if (!ids.length) return false;
  const m = /^\s*((?:\[[^\]]+\]\s*)+)/.exec(String(name ?? ""));
  if (!m) return false;
  return [...m[1].matchAll(/\[([^\]]+)\]/g)].flatMap((x) => x[1].split(/[,\s]+/)).some((x) => ids.includes(x));
};

/** Each number, and each word or pattern quoted, that a feature the message
 *  lists, or a refusal the spec declares, states and no test of it pins. A
 *  feature's tests are those whose name opens with its id in square
 *  brackets; what they pin is their own text and that of each top-level
 *  constant or function in their file they name. A refusal has no id, so
 *  what it states is looked for anywhere in the suite. A feature that no
 *  test is named for is a finding too, once the suite names any test for a
 *  feature; a suite that names none is not read for features at all. The
 *  test writer's standard checks are left out. */
export function pinFindings(files = [], { words = "", declared = null, skip = [] } = {}) {
  const out = [];
  const own = files.filter((f) => !skip.includes(f.path));
  const perFile = own.map((f) => ({ f, chunks: chunksOf(f.text) }));
  const features = featuresIn(words);
  const anyNamed = perFile.some(({ chunks }) => chunks.some((c) => c.test && featureIdsOf(c.name).length));
  if (features.length && anyNamed) {
    for (const feat of features) {
      const scope = [];
      for (const { chunks } of perFile) {
        const tests = chunks.filter((c) => c.test && featureIdsOf(c.name).includes(feat.id));
        if (!tests.length) continue;
        const body = tests.map((c) => c.text).join("\n");
        const used = new Set([...body.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]));
        // A constant counts when it is a worked value or fits on one line: a
        // stand-in or a block of sample data holds ids and sizes that pin
        // nothing, and would let a number through that no test asserts.
        const constant = (c) => /^\s*(?:export\s+)?const\b/m.test(c.text)
          && (/=\s*worked\s*\(/.test(c.text) || c.text.split("\n").filter((l) => trim(l) && !COMMENT_LINE.test(l)).length === 1);
        scope.push(body, ...chunks.filter((c) => !c.test && constant(c) && c.declares.some((n) => used.has(n))).map((c) => c.text));
      }
      if (!scope.length) {
        out.push(`no test is named for ${feat.id} (${feat.text.slice(0, 80)}${feat.text.length > 80 ? "..." : ""}); name each test that checks a feature with the feature's id in square brackets, such as "[${feat.id}] ...", and give every feature at least one`);
        continue;
      }
      const missing = unpinned(feat.text, scope.join("\n"));
      if (missing.length) out.push(`${feat.id} states ${missing.join("; ")}, and no test named [${feat.id}] pins ${missing.length === 1 ? "it" : "them"}: assert each in a test of ${feat.id}, the number as the feature gives it (a time limit of 10 seconds may be written 10 or 10000) and the words or pattern exactly as quoted`);
    }
  }
  const all = own.map((f) => String(f.text ?? "")).join("\n");
  (declared?.refuses ?? []).forEach((r, i) => {
    const said = typeof r === "string" ? r : trim(r?.what ?? r?.name ?? "");
    if (!said) return;
    const missing = unpinned(said, all);
    if (missing.length) out.push(`refusal ${i + 1} ("${said.slice(0, 80)}${said.length > 80 ? "..." : ""}") states ${missing.join("; ")}, and no test pins ${missing.length === 1 ? "it" : "them"}: try the thing at the limit the refusal names and assert it is refused`);
  });
  return out;
}

/** What `sentence` states that `code` does not carry, as short phrases. */
function unpinned(sentence, code) {
  const { numbers, phrases } = statedIn(sentence);
  const written = numbersWritten(code);
  const out = [];
  const seen = new Set();
  for (const n of numbers) {
    const key = [...n.values].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    if (![...n.values].some((v) => written.has(v))) out.push(`the number ${n.said}`);
  }
  for (const p of phrases) if (!carriesPhrase(code, p)) out.push(`the words "${p}"`);
  return out;
}
