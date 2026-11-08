// went-without decides how to record what a job lacked but proceeded without.
//
// What is worth pinning: writing a note stores it in the job's records directory,
// reading from a missing file is not an error and returns an empty list, 
// repeated notes for the same missing item overwrite the previous, 
// and formatting paragraphs correctly joins the entries for the reply.
//
// Nothing here touches a network.
// Run: node --test test/went-without.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileIn, note, read, sentence, paragraph, FILE } from "../scripts/went-without.mjs";

async function folders(body) {
  const at = mkdtempSync(join(tmpdir(), "wentwithout-"));
  try {
    await body(at);
  } finally {
    rmSync(at, { recursive: true, force: true });
  }
}

test("reads as empty when no file exists", async () => {
  await folders(async (at) => {
    assert.deepEqual(read(at), []);
    assert.equal(sentence(read(at)), "");
    assert.equal(paragraph(at), "");
  });
});

test("note appends to the file and does not duplicate by wanted", async () => {
  await folders(async (at) => {
    note(at, { wanted: "context", did: "guessed from the title" });
    note(at, { wanted: "context", did: "made up a new one", why: "no file attached" });
    note(at, { wanted: "user", did: "used a default name" });

    const entries = read(at);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].wanted, "context");
    assert.equal(entries[0].did, "made up a new one");
    assert.equal(entries[0].why, "no file attached");
    assert.equal(entries[1].wanted, "user");
    
    const parsed = JSON.parse(readFileSync(fileIn(at), "utf8"));
    assert.equal(parsed.entries.length, 2);
  });
});

test("sentence formats a single missing item properly", () => {
  const entries = [{ wanted: "the image", did: "left a blank space", why: "it was corrupted" }];
  const s = sentence(entries);
  assert.match(s, /This job went ahead without the image \(it was corrupted\): left a blank space\./);
});

test("sentence formats multiple missing items properly", () => {
  const entries = [
    { wanted: "the image", did: "left a blank space" },
    { wanted: "the caption", did: "wrote nothing" }
  ];
  const s = sentence(entries);
  assert.match(s, /This job went ahead without two of the things it takes: the image and the caption\./);
  assert.match(s, /Without the image, it left a blank space\./);
  assert.match(s, /Without the caption, it wrote nothing\./);
});

test("FILE is exported correctly", () => {
  assert.equal(FILE, "went-without.json");
});
