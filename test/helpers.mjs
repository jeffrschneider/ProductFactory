// What the tests share: a temporary folder, and a whole Product Factory on
// 127.0.0.1 with fake holders (the stand-in agents under fixtures/fake-adlc,
// the stand-in harness and the stand-in packer under fixtures/bin).

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig } from "../lib/config.mjs";
import { createStore } from "../lib/store.mjs";
import { createLifecycle } from "../lib/lifecycle.mjs";
import { createRunner } from "../lib/runner.mjs";
import { createService } from "../lib/server.mjs";
import { createPeople, KEYS_FILE } from "../lib/people.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const FAKE_ADLC = join(HERE, "fixtures", "fake-adlc");
export const STUB_HARNESS = join(HERE, "fixtures", "bin", "stub-harness.mjs");
export const STUB_PACKER = join(HERE, "fixtures", "bin", "stub-packer.mjs");

export const tempDir = (name) => mkdtemp(join(process.env.PF_TEST_TMP || tmpdir(), `pf-${name}-`));

/** The model settings the stand-in agents check for, under the names the test settings give them. */
export const MODEL_VARS = { PF_T_MODEL_NAME: "stand-in-model", PF_T_MODEL_ENDPOINT: "http://127.0.0.1:9/never-called", PF_T_MODEL_KEY: "", PF_T_MODEL_PROTOCOL: "openai-chat" };

/**
 * A Product Factory with fake holders. doc: a lifecycle document to start from.
 * holder: "harness" or "code-writer". failRounds: how many harness rounds write the wrong code.
 * people: a people.json to start from; with it, each person's own key works (f.people).
 */
export async function factory({ doc = null, holder = "harness", rounds = 3, failRounds = 0, model = true, harness = true, people = null } = {}) {
  const dir = await tempDir("factory");
  const stubLog = join(dir, "harness-calls.jsonl");
  if (doc) await writeFile(join(dir, "lifecycle.json"), JSON.stringify(doc, null, 2));
  const config = readConfig({
    adlc: FAKE_ADLC,
    lifecycle: "./lifecycle.json",
    data: "./data",
    port: 0,
    model: { name: "PF_T_MODEL_NAME", endpoint: "PF_T_MODEL_ENDPOINT", key: "PF_T_MODEL_KEY", protocol: "PF_T_MODEL_PROTOCOL" },
    code: { holder, harness: harness ? ["node", STUB_HARNESS, "{prompt}"] : null, rounds, minutes: 2 },
    package: { packer: ["node", STUB_PACKER] },
  }, dir);
  const env = { ...process.env, ...(model ? MODEL_VARS : {}), PF_STUB_LOG: stubLog, PF_STUB_FAIL_ROUNDS: String(failRounds) };
  if (!model) for (const k of Object.keys(MODEL_VARS)) delete env[k];
  const store = createStore({ dir: config.data });
  const lifecycle = createLifecycle({ path: config.lifecycle });
  const person = { name: "Test Person", email: "person@example.com" };
  const runner = createRunner({ store, lifecycle, config, env, person });
  const key = store.key();
  if (people) await writeFile(join(dir, "people.json"), JSON.stringify(people, null, 2));
  const access = people ? createPeople({ file: join(dir, "people.json"), keysFile: join(config.data, KEYS_FILE), lifecycle: lifecycle.file, serviceKey: key.value, admin: person }) : null;
  const service = createService({ store, lifecycle, runner, key: key.value, person, people: access });
  const base = await service.listen(0);
  const call = async (method, path, body, { auth = key.value, raw = false } = {}) => {
    const r = await fetch(`${base}/v1/lifecycle${path}`, {
      method,
      headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, json, text: raw ? text : undefined, type: r.headers.get("content-type") };
  };
  return {
    dir, config, store, lifecycle, runner, service, base, key, stubLog, call, env, people: access,
    get: (p) => call("GET", p),
    post: (p, b = {}) => call("POST", p, b),
    put: (p, b) => call("PUT", p, b),
    del: (p) => call("DELETE", p),
    /** Waits until the build has nothing running, then reads it through the API. */
    settled: async (id) => { await runner.idle(id); return (await call("GET", `/builds/${id}`)).json.build; },
    close: async () => { await runner.stopAll(); await service.close(); },
  };
}

export const stageOf = (build, id) => build.stages.find((s) => s.stage === id);
export const actionNames = (build) => build.actions.map((a) => a.name);
