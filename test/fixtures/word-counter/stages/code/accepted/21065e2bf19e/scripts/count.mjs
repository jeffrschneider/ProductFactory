// count.mjs: count the words in one sentence of text.
//
// Reads the sentence from the job's inputs (inputs/sentence.md, Markdown with
// a header `source, read_at` and the sentence under `## Text`), refuses what
// is not one sentence of plain text, counts the words separated by
// whitespace, files the count as the piece "word count" ({count}) and prints
// one JSON object whose `reply` member is what the sender reads.
//
// Exit codes: 0 counted; 2 no --job; 3 nothing to count (the empty reply);
// 4 refused (the reply says why).
//
//   needs: node >= 22; nothing else. No network, no model.
//   node count.mjs --job <job folder> [--records <records folder>]
//   (RECORDS in the environment stands for --records.)
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keep } from "./went-without.mjs";

export const OUTPUT_NAME = "word count";
export const OUTPUT_KIND = "application/vnd.agentmesh.wordcount+json";
export const OUTPUT_PATH = "out/word-count.json";

export const EMPTY_REPLY = "There was no sentence to count. This agent takes exactly one sentence of text, as the input `sentence` "
  + "(Markdown: a header `source, read_at`, then `## Text` with the sentence), and answers with its number of words. "
  + "It stops and says what this agent takes rather than guessing a count.";

const MULTIPLE = "Only a single sentence is accepted: this counts the words of one sentence of text, and multiple sentences or non-text content were provided, so it stops; only a single sentence is accepted.";
const EMPTY = "There is no text to count, so it stops and says what this agent takes: exactly one sentence of text.";
const BINARY = "This is not plain text. Binary files, images and other media are not processed: this agent does not attempt to extract text from them and will immediately reject them.";
const ADDRESS = "The text holds a credential value or a system address. This agent reads the input strictly as a sentence to be counted and does not execute or connect to any provided address, so it refuses it.";

/** A refusal: the words the sender reads. */
export class Refusal extends Error {}

const SIGNATURES = [
  [0x89, 0x50, 0x4e, 0x47], // png
  [0xff, 0xd8, 0xff], // jpeg
  [0x47, 0x49, 0x46, 0x38], // gif
  [0x25, 0x50, 0x44, 0x46], // pdf
  [0x50, 0x4b, 0x03, 0x04], // zip, docx and the like
  [0x1f, 0x8b], // gzip
  [0x52, 0x49, 0x46, 0x46], // riff: webp, wav
];

/** The bytes as text, or a refusal when they are an image, a binary file or
 *  anything that is not UTF-8 text. */
export function refuseImagesAndBinaries(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes ?? ""), "utf8");
  if (SIGNATURES.some((sig) => b.length >= sig.length && sig.every((x, i) => b[i] === x))) throw new Refusal(BINARY);
  if (b.includes(0)) throw new Refusal(BINARY);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    throw new Refusal(BINARY);
  }
}

/** The sentence under `## Text`, or the whole text when there is no such
 *  heading (a sentence handed over in the message itself). */
export function parseMarkdown(md) {
  const text = String(md ?? "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^#{1,6}\s+text\s*$/i.test(l.trim()));
  if (at < 0) return text.trim();
  const body = [];
  for (const line of lines.slice(at + 1)) {
    if (/^#{1,6}\s/.test(line.trim())) break;
    body.push(line);
  }
  return body.join("\n").trim();
}

/** One sentence, or a refusal: empty, or more than one. */
export function checkSingleSentence(text) {
  const t = String(text ?? "").trim();
  if (!t) throw new Refusal(EMPTY);
  // A sentence ends at . ! or ? followed by space and more text.
  if (/[.!?]["')\]]*\s+\S/.test(t)) throw new Refusal(MULTIPLE);
  return t;
}

const ADDRESS_PATTERNS = [
  /\b[a-z][a-z0-9+.-]*:\/\/\S+/i, // any scheme://
  /\bwww\.\S+/i,
  /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/, // an IPv4 address
  /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/, // a mail address
  /\b(?:localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|dev|internal|local|ai|cloud))(?::\d+)?(?:\/\S*)?/i,
];
const CREDENTIAL_PATTERNS = [
  /\b(?:api[_-]?key|secret|token|password|passwd|bearer|authorization)\b\s*[:=]/i,
  /\bbearer\s+\S{12,}/i,
  /\b(?=[A-Za-z0-9_\-]*\d)(?=[A-Za-z0-9_\-]*[A-Za-z])[A-Za-z0-9_\-]{32,}\b/, // a long mixed token
  /-----BEGIN [A-Z ]+-----/,
];

/** The text, or a refusal when it carries a credential value or an address. */
export function checkNoCredentialsOrAddresses(text) {
  const t = String(text ?? "");
  if ([...ADDRESS_PATTERNS, ...CREDENTIAL_PATTERNS].some((re) => re.test(t))) throw new Refusal(ADDRESS);
  return t;
}

/** The words, separated by whitespace: { count }. */
export function countWords(text) {
  const words = String(text ?? "").trim().split(/\s+/).filter(Boolean);
  return { count: words.length };
}

/** The sentence's bytes from the job folder: inputs/sentence.md, else any
 *  other single input, else the message; null when nothing was handed over. */
function inputOf(jobDir) {
  const inputs = join(jobDir, "inputs");
  if (existsSync(inputs) && statSync(inputs).isDirectory()) {
    const files = readdirSync(inputs).filter((n) => statSync(join(inputs, n)).isFile()).sort();
    const named = files.find((n) => /^sentence(\.|$)/i.test(n)) ?? files[0];
    if (named) return readFileSync(join(inputs, named));
  }
  for (const n of ["message.md", "message.txt"]) {
    const at = join(jobDir, n);
    if (existsSync(at) && statSync(at).isFile()) return readFileSync(at);
  }
  return null;
}

function filePieces(jobDir, count) {
  const at = join(jobDir, OUTPUT_PATH);
  mkdirSync(join(jobDir, "out"), { recursive: true });
  writeFileSync(at, JSON.stringify({ count }) + "\n");
  const pieces = [{ name: OUTPUT_NAME, path: OUTPUT_PATH, media_type: OUTPUT_KIND }];
  writeFileSync(join(jobDir, "pieces.json"), JSON.stringify(pieces, null, 2) + "\n");
}

/** One job: { code, reply }. */
export async function runJob({ jobDir, records = "" } = {}) {
  if (!jobDir) throw new Error("--job is required");
  // Every job keeps its own went-without record, with no entries when it
  // lacked nothing.
  if (records) keep(join(records, basename(resolve(jobDir))));
  const bytes = inputOf(jobDir);
  if (bytes === null || !bytes.length) return { code: 3, reply: EMPTY_REPLY };
  try {
    const text = refuseImagesAndBinaries(bytes);
    const sentence = parseMarkdown(text);
    if (!sentence.trim()) return { code: 3, reply: EMPTY_REPLY };
    checkSingleSentence(sentence);
    checkNoCredentialsOrAddresses(sentence);
    const result = countWords(sentence);
    filePieces(jobDir, result.count);
    return { code: 0, reply: JSON.stringify(result) };
  } catch (e) {
    if (e instanceof Refusal) return { code: 4, reply: e.message };
    throw e;
  }
}

/** --name value pairs from argv. */
function argsOf(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m) continue;
    out[m[1]] = m[2] ?? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[(i += 1)] : "");
  }
  return out;
}

const ranDirectly = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (ranDirectly) {
  const args = argsOf(process.argv.slice(2));
  if (!args.job) {
    process.stderr.write("--job is required: node count.mjs --job <job folder> [--records <records folder>]\n");
    process.exit(2);
  }
  const records = args.records || process.env.RECORDS || "";
  try {
    const out = await runJob({ jobDir: args.job, records });
    process.stdout.write(JSON.stringify(out) + "\n");
    process.exit(out.code);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.stdout.write(JSON.stringify({ code: 1, reply: `The count could not be made: ${e.message}` }) + "\n");
    process.exit(1);
  }
}
