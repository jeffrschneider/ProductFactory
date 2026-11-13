// product-factory.json: paths, model settings by variable name, the harness command.

import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { readConfig, loadConfig, writeStarter, modelEnv, STARTER } from "../lib/config.mjs";
import { fill, codeWriterPrompt } from "../lib/adapters.mjs";
import { resolveCommand } from "../lib/exec.mjs";
import { tempDir } from "./helpers.mjs";

test("paths are read from the settings file's folder, and the defaults fill the rest", () => {
  const c = readConfig({ adlc: "../adlc" }, join("/work", "pf"));
  assert.equal(c.adlc, resolve("/work", "adlc"));
  assert.equal(c.lifecycle, resolve("/work", "pf", "lifecycle.json"));
  assert.equal(c.code.holder, "builder", "new agents are built by one builder");
  assert.equal(c.code.rounds, 3);
  assert.deepEqual(c.model, { name: "MODEL_NAME", endpoint: "MODEL_ENDPOINT", key: "MODEL_KEY", protocol: "MODEL_PROTOCOL" });
});

test("a model setting is the name of an environment variable, never a value", () => {
  assert.throws(() => readConfig({ model: { key: "sk-ant-api03-abcdef" } }, "/"), /name of an environment variable/);
  assert.throws(() => readConfig({ model: { key: "https://example.com" } }, "/"), /never a value/);
  assert.throws(() => readConfig({ model: { temperature: "X" } }, "/"), /only name, endpoint, key and protocol/);
  const c = readConfig({ model: { key: "OUR_MODEL_KEY" } }, "/");
  const { env, missing } = modelEnv(c, { OUR_MODEL_KEY: "k", MODEL_NAME: "m", MODEL_ENDPOINT: "e" });
  assert.deepEqual(env, { MODEL_NAME: "m", MODEL_ENDPOINT: "e", MODEL_KEY: "k", MODEL_PROTOCOL: "" });
  assert.deepEqual(missing, ["MODEL_PROTOCOL"]);
});

test("the harness is a command as a list of words, with known placeholders filled in", () => {
  assert.throws(() => readConfig({ code: { harness: "claude -p" } }, "/"), /list of words/);
  assert.throws(() => readConfig({ code: { harness: ["claude", "{secret}"] } }, "/"), /\{secret\}/);
  assert.throws(() => readConfig({ code: { holder: "devin" } }, "/"), /"harness"/);
  assert.throws(() => readConfig({ code: { rounds: 0 } }, "/"), /whole number/);
  assert.throws(() => readConfig({ colour: "red" }, "/"), /does not read/);
  const c = readConfig({ code: { harness: ["codex", "exec", "{prompt}"], rounds: 5 } }, "/");
  const prompt = codeWriterPrompt({ adlc: "/adlc", feedbackFile: null });
  assert.deepEqual(fill(c.code.harness, { prompt }), ["codex", "exec", prompt]);
  assert.match(prompt, /reference code writer/);
  assert.doesNotMatch(prompt, /\n/);
  assert.match(codeWriterPrompt({ adlc: "/adlc", feedbackFile: "/x/check.txt" }), /First read \/x\/check\.txt/);
});

test("init writes a starter file once, and it reads back", async () => {
  const dir = await tempDir("config");
  const path = join(dir, "product-factory.json");
  assert.equal(writeStarter(path), true);
  assert.equal(writeStarter(path), false);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), STARTER);
  const c = loadConfig(path);
  assert.equal(c.file, path);
  assert.equal(c.code.harness[0], "claude");
  writeFileSync(path, "{ nope");
  assert.throws(() => loadConfig(path), /not valid JSON/);
  assert.throws(() => loadConfig(join(dir, "missing.json")), /npx product-factory init/);
});

test("a command runs without a shell; node is this node", () => {
  assert.deepEqual(resolveCommand(["node", "x.mjs"]), { file: process.execPath, args: ["x.mjs"], shell: false });
});

test("a word with line breaks goes to a .cmd program on one line, so cmd.exe cannot end the command there", { skip: process.platform !== "win32" }, async () => {
  const dir = await tempDir("cmd");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "harness.cmd"), "@echo off\r\n");
  const r = resolveCommand(["harness", "line one\nline two\r\nline three"], { PATH: dir, PATHEXT: ".CMD" });
  assert.equal(r.shell, true);
  assert.doesNotMatch(r.file, /[\r\n]/);
  assert.match(r.file, /"line one line two line three"$/);
});
