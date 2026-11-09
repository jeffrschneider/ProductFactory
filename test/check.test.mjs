// The start-up check: plain notes on the settings, and `product-factory check`,
// which makes one tiny real call through the reference agents' shared model
// caller. The caller here is a byte-for-byte copy of CommonAgent/adlc
// agents/spec-writer/scripts/model-caller.mjs (fixtures/caller-adlc), and the
// endpoint is a stand-in on 127.0.0.1 that answers the way the Anthropic
// Messages API does: an answer, a "credit balance too low" refusal, or a
// refused key.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig } from "../lib/config.mjs";
import { startupNotes, checkModel } from "../lib/check.mjs";
import { FAKE_ADLC, STUB_HARNESS, tempDir } from "./helpers.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CALLER_ADLC = join(HERE, "fixtures", "caller-adlc");
const BIN = join(HERE, "..", "bin", "product-factory.mjs");
const KEY = "sk-stand-in-0123456789abcdef";
const MODEL = { name: "PF_C_MODEL_NAME", endpoint: "PF_C_MODEL_ENDPOINT", key: "PF_C_MODEL_KEY", protocol: "PF_C_MODEL_PROTOCOL" };

/** A stand-in model endpoint. mode: "ok", "credit" or "key". It keeps what it was sent. */
async function standIn(mode) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({ url: req.url, key: req.headers["x-api-key"], body: JSON.parse(body || "{}") });
      res.setHeader("content-type", "application/json");
      if (mode === "credit") {
        res.statusCode = 400;
        return res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." } }));
      }
      if (mode === "key") {
        res.statusCode = 401;
        return res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${req.headers["x-api-key"]}` } }));
      }
      res.end(JSON.stringify({ type: "message", role: "assistant", model: "stand-in-model", content: [{ type: "text", text: "ready" }], stop_reason: "end_turn", usage: { input_tokens: 12, output_tokens: 1 } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

const envFor = (url, extra = {}) => ({ PATH: process.env.PATH, ...(process.env.Path ? { Path: process.env.Path } : {}), SYSTEMROOT: process.env.SYSTEMROOT ?? "", PF_C_MODEL_NAME: "stand-in-model", PF_C_MODEL_ENDPOINT: url, PF_C_MODEL_KEY: KEY, PF_C_MODEL_PROTOCOL: "anthropic-messages", ...extra });
const settings = (raw = {}) => readConfig({ adlc: CALLER_ADLC, model: MODEL, code: { harness: ["node", STUB_HARNESS, "{prompt}"] }, ...raw }, "/");

test("the notes name the missing model settings, a missing adlc checkout, a harness not on PATH and an unset token", () => {
  const c = readConfig({ adlc: join(HERE, "no-such-adlc"), model: MODEL, code: { harness: ["no-such-harness-pf", "-p", "{prompt}"] } }, "/");
  const { notes } = startupNotes(c, { PATH: "", PF_C_MODEL_NAME: "m" });
  assert.equal(notes.length, 3);
  assert.match(notes[0], /PF_C_MODEL_ENDPOINT, PF_C_MODEL_PROTOCOL, which are not set/);
  assert.doesNotMatch(notes[0], /PF_C_MODEL_KEY/, "the key may be empty");
  assert.match(notes[1], /There is no folder at .*no-such-adlc/);
  assert.match(notes[2], /"no-such-harness-pf", and it is not on PATH/);

  const notAdlc = readConfig({ adlc: HERE, model: MODEL, code: { harness: ["node", "x.mjs"] } }, "/");
  assert.match(startupNotes(notAdlc, envFor("http://x")).notes[0], /not a CommonAgent\/adlc checkout/);

  const pr = readConfig({ adlc: FAKE_ADLC, model: MODEL, code: { holder: "pull-request" }, repository: { host: "github", repo: "acme/agents", token: "PF_C_TOKEN" } }, "/");
  const unset = startupNotes(pr, envFor("http://x"));
  assert.deepEqual(unset.notes.length, 1);
  assert.match(unset.notes[0], /token is read from PF_C_TOKEN, which is not set/);
  const set = startupNotes(pr, envFor("http://x", { PF_C_TOKEN: "t" }));
  assert.deepEqual(set.notes, []);
  assert.match(set.info[0], /pull request on acme\/agents/);
});

test("with everything in place there are no notes", () => {
  assert.deepEqual(startupNotes(readConfig({ adlc: FAKE_ADLC, model: MODEL, code: { harness: ["node", STUB_HARNESS] } }, "/"), envFor("http://x")).notes, []);
});

test("the model check makes one tiny call through the shared caller and says the answer", async (t) => {
  const s = await standIn("ok");
  t.after(s.close);
  const m = await checkModel(settings(), envFor(s.url));
  assert.equal(m.ok, true);
  assert.match(m.words, /The model answered \(stand-in-model over anthropic-messages at 127\.0\.0\.1:\d+\): "ready"\. The model settings work\./);
  assert.equal(s.seen.length, 1);
  assert.equal(s.seen[0].url, "/v1/messages");
  assert.equal(s.seen[0].key, KEY, "the key goes to the endpoint");
  assert.equal(s.seen[0].body.max_tokens, 64, "the call is tiny");
  assert.doesNotMatch(m.words, new RegExp(KEY));
});

test("a credit balance too low refusal is said in words", async (t) => {
  const s = await standIn("credit");
  t.after(s.close);
  const m = await checkModel(settings(), envFor(s.url));
  assert.equal(m.ok, false);
  assert.match(m.words, /no credit: its credit balance is too low/);
  assert.match(m.words, /PF_C_MODEL_KEY/);
});

test("a refused key is said in words, and the key is never in them", async (t) => {
  const s = await standIn("key");
  t.after(s.close);
  const m = await checkModel(settings(), envFor(s.url));
  assert.equal(m.ok, false);
  assert.match(m.words, /refused the key in PF_C_MODEL_KEY \(401\)/);
  assert.doesNotMatch(m.words, new RegExp(KEY));
});

test("the model check says why it made no call", async () => {
  const missing = await checkModel(settings(), { PF_C_MODEL_NAME: "m" });
  assert.match(missing.words, /^The model was not called: PF_C_MODEL_ENDPOINT, PF_C_MODEL_PROTOCOL are not set\./);
  const noCaller = await checkModel(readConfig({ adlc: join(HERE, "no-such-adlc"), model: MODEL }, "/"), envFor("http://127.0.0.1:9"));
  assert.match(noCaller.words, /shared model caller .* is not in the adlc checkout/);
});

/** Runs the command line; resolves to { code, out }. */
function cli(args, env) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { out += c; });
    child.on("close", (code) => done({ code, out }));
  });
}

async function settingsFile(raw) {
  const dir = await tempDir("check");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "product-factory.json");
  writeFileSync(file, JSON.stringify({ adlc: CALLER_ADLC, model: MODEL, code: { harness: ["node", STUB_HARNESS, "{prompt}"] }, ...raw }));
  return file;
}

test("product-factory check prints the notes and the model's answer, and never the key", async (t) => {
  const s = await standIn("ok");
  t.after(s.close);
  const file = await settingsFile({});
  const good = await cli(["check", "--config", file], envFor(s.url));
  assert.equal(good.code, 0, good.out);
  assert.match(good.out, /The settings are in order\./);
  assert.match(good.out, /Model: The model answered .*"ready"/);
  assert.doesNotMatch(good.out, new RegExp(KEY));

  const credit = await standIn("credit");
  t.after(credit.close);
  const low = await cli(["check", "--config", file], envFor(credit.url));
  assert.equal(low.code, 1);
  assert.match(low.out, /credit balance is too low/);
  assert.doesNotMatch(low.out, new RegExp(KEY));

  const bad = await settingsFile({ code: { harness: ["no-such-harness-pf", "{prompt}"] } });
  const noted = await cli(["check", "--config", bad], envFor(s.url));
  assert.equal(noted.code, 1);
  assert.match(noted.out, /Note: The coding harness is "no-such-harness-pf", and it is not on PATH/);
  assert.match(noted.out, /Model: The model answered/);
});
