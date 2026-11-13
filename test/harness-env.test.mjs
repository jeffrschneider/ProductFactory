// code.env_remove: variables taken out of the harness's environment before it
// runs, so a harness such as Claude Code uses its own sign-in (the person's
// plan) rather than an ANTHROPIC_API_KEY that happens to be set.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { readConfig, STARTER } from "../lib/config.mjs";
import { withoutEnv } from "../lib/exec.mjs";
import { factory, stageOf } from "./helpers.mjs";

const calls = (f) => (existsSync(f.stubLog) ? readFileSync(f.stubLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const leftOut = { version: "0.1", organization: { used: { review: false, docs: false } } };

test("code.env_remove defaults to ANTHROPIC_API_KEY, takes [] and refuses anything but variable names", () => {
  assert.deepEqual(readConfig({}, "/").code.env_remove, ["ANTHROPIC_API_KEY"]);
  assert.deepEqual(STARTER.code.env_remove, ["ANTHROPIC_API_KEY"]);
  assert.deepEqual(readConfig({ code: { env_remove: [] } }, "/").code.env_remove, []);
  assert.deepEqual(readConfig({ code: { env_remove: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"] } }, "/").code.env_remove, ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);
  assert.throws(() => readConfig({ code: { env_remove: "ANTHROPIC_API_KEY" } }, "/"), /list of environment variable names/);
  assert.throws(() => readConfig({ code: { env_remove: ["sk-ant-api03-x"] } }, "/"), /list of environment variable names/);
  assert.throws(() => readConfig({ code: { env_remove: [""] } }, "/"), /list of environment variable names/);
});

test("withoutEnv takes the named variables out of a copy, with no case on Windows", () => {
  const env = { ANTHROPIC_API_KEY: "a", Anthropic_Api_Key: "b", PATH: "/bin" };
  assert.deepEqual(withoutEnv(env, ["ANTHROPIC_API_KEY"], "linux"), { Anthropic_Api_Key: "b", PATH: "/bin" });
  assert.deepEqual(withoutEnv(env, ["ANTHROPIC_API_KEY"], "win32"), { PATH: "/bin" });
  assert.deepEqual(withoutEnv(env, [], "linux"), env);
  assert.equal(env.ANTHROPIC_API_KEY, "a", "the environment given is left as it is");
});

async function toCode(f) {
  const started = await f.post("/builds", { does: "Count the words in a passage." });
  assert.equal(started.status, 201);
  const id = started.json.build.id;
  await f.settled(id);
  assert.equal((await f.post(`/builds/${id}/actions/approve`)).status, 200);
  const b = await f.settled(id);
  assert.equal(stageOf(b, "code").state, "waiting_on_you");
  return calls(f);
}

test("by default the harness runs without ANTHROPIC_API_KEY, and the model settings still reach it", async (t) => {
  const f = await factory({ holder: "harness", doc: leftOut, extraEnv: { ANTHROPIC_API_KEY: "stand-in-key-with-no-credit" } });
  t.after(f.close);
  const h = await toCode(f);
  assert.ok(h.length >= 1);
  assert.ok(h.every((c) => c.anthropic_key === false), "the key is taken out before the harness runs");
  assert.ok(h.every((c) => c.model_name === "stand-in-model"));
  assert.equal(f.env.ANTHROPIC_API_KEY, "stand-in-key-with-no-credit", "Product Factory's own environment keeps it");
});

test("code.env_remove [] keeps ANTHROPIC_API_KEY for the harness", async (t) => {
  const f = await factory({ holder: "harness", doc: leftOut, envRemove: [], extraEnv: { ANTHROPIC_API_KEY: "stand-in-key" } });
  t.after(f.close);
  const h = await toCode(f);
  assert.ok(h.length >= 1);
  assert.ok(h.every((c) => c.anthropic_key === true));
});
