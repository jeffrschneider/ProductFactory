// Word counting decides if an input is a single text sentence, refuses anything else,
// ensures no credentials or addresses are given, extracts the text from markdown,
// and counts words strictly by whitespace.
//
// What is worth pinning: each refusal is checked for its specific text;
// empty input yields exit 3 with the empty reply; words are counted exactly
// by whitespace as specified; records and pieces are kept correctly per job;
// the process contract requires --job; and the descriptor fields are present.
// Nothing here touches a network.
// Run: node --test test/count.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { worked } from "./worked-values.test.mjs";
import { checkDelivered } from "./delivered-formats.test.mjs";
import { checkRecordsPerJob } from "./records-per-job.test.mjs";

import {
  checkNoCredentialsOrAddresses,
  checkSingleSentence,
  countWords,
  EMPTY_REPLY,
  parseMarkdown,
  refuseImagesAndBinaries,
  runJob
} from "../scripts/count.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function countByWhitespace(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

const SAMPLE_SENTENCE = "The quick brown fox jumps over the lazy dog.";
const SAMPLE_COUNT = worked(9, () => countByWhitespace(SAMPLE_SENTENCE), "words in the sample sentence");

const SECOND_SENTENCE = "Another sentence to count.";
const SECOND_COUNT = worked(4, () => countByWhitespace(SECOND_SENTENCE), "words in the second sentence");

async function folders(body) {
  const at = mkdtempSync(join(tmpdir(), "wordcounter-"));
  const dirs = {
    root: at,
    records: join(at, "records"),
    job: join(at, "job"),
    job1: join(at, "job1"),
    job2: join(at, "job2")
  };
  for (const d of Object.values(dirs)) {
    mkdirSync(d, { recursive: true });
  }
  try {
    await body(dirs);
  } finally {
    rmSync(at, { recursive: true, force: true });
  }
}

// ── refusals ─────────────────────────────────────────────────────────────────

test("multiple sentences or non-text content are refused", () => {
  assert.throws(() => checkSingleSentence("First sentence. Second sentence."), /only a single sentence is accepted/);
});

test("binary files and images are refused immediately", () => {
  assert.throws(() => refuseImagesAndBinaries(Buffer.from([0x89, 0x50, 0x4e, 0x47])), /immediately reject them/);
});

test("empty or missing input stops and says what the agent takes", () => {
  assert.throws(() => checkSingleSentence(""), /stops and says what this agent takes/);
});

test("a credential value or system address is refused", () => {
  assert.throws(() => checkNoCredentialsOrAddresses("Sentence with https://address.com."), /strictly as a sentence to be counted and does not execute or connect to any provided address/);
});

// ── empty case ───────────────────────────────────────────────────────────────

test("the empty case exits 3 with the empty reply and files no pieces", async () => {
  await folders(async (at) => {
    const out = await runJob({ jobDir: at.job, records: at.records });
    assert.equal(out.code, 3);
    assert.equal(out.reply, EMPTY_REPLY);
    assert.equal(existsSync(join(at.job, "pieces.json")), false);
  });
});

// ── records per job and good case ────────────────────────────────────────────

test("two successful jobs each keep their own records, and pieces are in declared formats", async () => {
  await folders(async (at) => {
    mkdirSync(join(at.job1, "inputs"), { recursive: true });
    writeFileSync(join(at.job1, "inputs", "sentence.md"), `source, read_at\n\n## Text\n\n${SAMPLE_SENTENCE}`);

    mkdirSync(join(at.job2, "inputs"), { recursive: true });
    writeFileSync(join(at.job2, "inputs", "sentence.md"), `source, read_at\n\n## Text\n\n${SECOND_SENTENCE}`);
    
    const out1 = await runJob({ jobDir: at.job1, records: at.records });
    assert.equal(out1.code, 0);
    assert.match(out1.reply, new RegExp(`"count":\\s*${SAMPLE_COUNT}`));
    assert.deepEqual(checkDelivered(at.job1), []);

    const out2 = await runJob({ jobDir: at.job2, records: at.records });
    assert.equal(out2.code, 0);
    assert.match(out2.reply, new RegExp(`"count":\\s*${SECOND_COUNT}`));
    assert.deepEqual(checkDelivered(at.job2), []);

    assert.deepEqual(checkRecordsPerJob(at.records, [at.job1, at.job2], { except: ["the signed job manifest of each delivery"] }), []);
  });
});

test("the good case counts exactly the words and returns JSON with a count field, free of extraneous text", () => {
  const result = countWords(SAMPLE_SENTENCE);
  assert.equal(result.count, SAMPLE_COUNT);
  assert.equal(Object.keys(result).length, 1);
});

test("markdown is parsed to find the sentence", () => {
  const md = "source, read_at\n\n## Text\n\nJust a single sentence.";
  assert.equal(parseMarkdown(md), "Just a single sentence.");
});

// ── process contract ─────────────────────────────────────────────────────────

test("the process contract requires --job", () => {
  const script = join(here, "..", "scripts", "count.mjs");
  const res = spawnSync("node", [script], { encoding: "utf8" });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /--job is required/);
});

// ── descriptor ───────────────────────────────────────────────────────────────

test("the offering's how is what it claims", () => {
  const desc = JSON.parse(readFileSync(join(here, "..", "agent-descriptor.json"), "utf8"));
  const offering = desc.offerings.find((o) => o.id === "count-words");
  assert.ok(offering, "offering count-words exists");
  assert.equal(offering.name, "Count words");
  assert.equal(offering.how.control, "script");
  assert.equal(offering.how.intelligence, "none");
  assert.equal(offering.how.cost, "none");
});
