// One command starts the service and the adlc console in one process: the
// console holds the service's key in memory, so nobody copies a key.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { factory, tempDir, stageOf, FAKE_ADLC } from "./helpers.mjs";
import { startConsole } from "../lib/console.mjs";
import { CONFIG_FILE, MODEL_SETTINGS } from "../lib/config.mjs";

const BIN = fileURLToPath(new URL("../bin/product-factory.mjs", import.meta.url));

/** Starts the one command in `dir` and waits for its first line. */
async function start(dir, args, extraEnv = {}) {
  const env = { ...process.env, ADLC_CONSOLE_CONFIG_DIR: join(dir, "console-config"), ...extraEnv };
  delete env.ADLC_KEY;
  for (const v of Object.values(MODEL_SETTINGS)) delete env[v];
  const child = spawn(process.execPath, [BIN, "--port", "0", "--no-open", ...args], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { err += c; });
  const exited = new Promise((ok) => child.on("exit", (code) => ok(code)));
  const first = await Promise.race([
    new Promise((ok) => { const tick = setInterval(() => { if (/\n/.test(out)) { clearInterval(tick); ok(out.split("\n")[0]); } }, 20); }),
    exited.then((code) => { throw new Error(`It stopped (${code}): ${err}${out}`); }),
  ]);
  return { child, first, out: () => out, exited, stop: async () => { if (child.exitCode === null) { child.kill(); await exited; } } };
}

/** A request to the console the way its page makes one. */
async function viaConsole(url, path, body) {
  const r = await fetch(new URL(path, url), body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json", "x-adlc-console": "1" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function settings(dir, extra = {}) {
  await writeFile(join(dir, CONFIG_FILE), JSON.stringify({ adlc: FAKE_ADLC, port: 0, ...extra }, null, 2));
}

test("the console started in this process reaches the service with the service's key, held in memory", async (t) => {
  const f = await factory();
  t.after(f.close);
  const c = await startConsole({ service: f.base, key: f.key.value });
  t.after(c.close);
  const st = await viaConsole(c.url, "/local/status");
  assert.equal(st.json.signed_in, true);
  assert.equal(st.json.key_from, "service");
  const list = await viaConsole(c.url, "/api/v1/lifecycle/builds");
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.builds, []);
});

test("one command starts the service and the console in one process, on free ports, with no key file to handle", async (t) => {
  const dir = await tempDir("one");
  await settings(dir);
  const run = await start(dir, ["--console-port", "0"]);
  t.after(run.stop);
  const m = /^Product Factory and its console are at (http:\/\/127\.0\.0\.1:\d+\/) \(press Ctrl\+C to stop both\)\.$/.exec(run.first.trim());
  assert.ok(m, run.first);
  const url = m[1];
  const st = await viaConsole(url, "/local/status");
  assert.equal(st.json.signed_in, true);
  assert.equal(st.json.key_from, "service");
  // A build started from the console reaches the service, with the key the console was handed.
  const made = await viaConsole(url, "/api/v1/lifecycle/builds", { does: "Count the words." });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const list = await viaConsole(url, "/api/v1/lifecycle/builds");
  assert.equal(list.json.builds.length, 1);
  // The console kept no key of its own.
  assert.equal(existsSync(join(dir, "console-config", "keys.json")), false);
  // One process: stopping it stops both.
  await run.stop();
  await assert.rejects(fetch(new URL("/local/status", url)));
});

test("--no-console starts only the service, as before", async (t) => {
  const dir = await tempDir("noconsole");
  await settings(dir);
  const run = await start(dir, ["--no-console"]);
  t.after(run.stop);
  const m = /^Product Factory is at (http:\/\/127\.0\.0\.1:\d+)\/v1\/lifecycle$/.exec(run.first.trim());
  assert.ok(m, run.first);
  await new Promise((ok) => setTimeout(ok, 200));
  assert.match(run.out(), /--key-file /);
  assert.doesNotMatch(run.out(), /its console are at/);
  const key = readFileSync(join(dir, "builds", "service-key"), "utf8").trim();
  const r = await fetch(`${m[1]}/v1/lifecycle/builds`, { headers: { authorization: `Bearer ${key}` } });
  assert.equal(r.status, 200);
});

test("--console-port and --no-console together are refused in words", async () => {
  const dir = await tempDir("both");
  await settings(dir);
  const child = spawn(process.execPath, [BIN, "--no-console", "--console-port", "0"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (c) => { err += c; });
  const code = await new Promise((ok) => child.on("exit", ok));
  assert.equal(code, 2);
  assert.match(err, /give one of them/);
});

test("the first run, with no settings file, writes the starter and still starts; a build says what is missing", async (t) => {
  const dir = await tempDir("first");
  await mkdir(join(dir, "here"));
  const here = join(dir, "here");
  const run = await start(here, []);
  t.after(run.stop);
  const url = /(http:\/\/127\.0\.0\.1:\d+\/)/.exec(run.first)[1];
  assert.ok(existsSync(join(here, CONFIG_FILE)));
  await new Promise((ok) => setTimeout(ok, 200));
  assert.match(run.out(), /This is the first run here/);
  // The lifecycle page reads the stages and the roles through the console.
  const stages = await viaConsole(url, "/api/v1/lifecycle/stages");
  assert.equal(stages.status, 200);
  assert.ok(Array.isArray(stages.json.stages) && stages.json.stages.length > 0);
  assert.equal((await viaConsole(url, "/api/v1/lifecycle/roles")).status, 200);
  // A build stops at Requirements and says, in words, which model settings are missing.
  const id = (await viaConsole(url, "/api/v1/lifecycle/builds", { does: "Count the words." })).json.build.id;
  let b;
  for (let i = 0; i < 100; i++) {
    b = (await viaConsole(url, `/api/v1/lifecycle/builds/${id}`)).json.build;
    if (stageOf(b, "requirements").state === "refused") break;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  assert.equal(stageOf(b, "requirements").state, "refused");
  assert.match(stageOf(b, "requirements").handed_back.words[0], /MODEL_NAME, MODEL_ENDPOINT, MODEL_PROTOCOL are not set/);
  // It is still running.
  assert.equal(run.child.exitCode, null);
  assert.equal((await viaConsole(url, "/local/status")).status, 200);
});
