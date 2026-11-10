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
import { createHistory } from "../lib/history.mjs";
import { createNotices } from "../lib/notices.mjs";
import { createIssueIntake } from "../lib/intake.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const FAKE_ADLC = join(HERE, "fixtures", "fake-adlc");
export const STUB_HARNESS = join(HERE, "fixtures", "bin", "stub-harness.mjs");
export const STUB_PACKER = join(HERE, "fixtures", "bin", "stub-packer.mjs");
export const FIX_HARNESS = join(HERE, "fixtures", "bin", "fix-harness.mjs");

export const tempDir = (name) => mkdtemp(join(process.env.PF_TEST_TMP || tmpdir(), `pf-${name}-`));

/** The model settings the stand-in agents check for, under the names the test settings give them. */
export const MODEL_VARS = { PF_T_MODEL_NAME: "stand-in-model", PF_T_MODEL_ENDPOINT: "http://127.0.0.1:9/never-called", PF_T_MODEL_KEY: "", PF_T_MODEL_PROTOCOL: "openai-chat" };

/**
 * A Product Factory with fake holders. doc: a lifecycle document to start from.
 * holder: "harness", "code-writer" or "pull-request". failRounds: how many harness rounds write the wrong code.
 * harness: true for the stand-in harness, false for none, or a command; on a pull request the default is none
 * (your own harness pushes), and a harness turns on the fix loop. fixRounds: code.fix_rounds.
 * people: a people.json to start from; with it, each person's own key works (f.people).
 */
export async function factory({ doc = null, holder = "harness", rounds = 3, failRounds = 0, model = true, harness = undefined, fixRounds = undefined, github = null, review = undefined, history: withHistory = true, runtime = null, people = null, intake = undefined, notify = undefined, extraEnv = {}, envRemove = undefined } = {}) {
  const dir = await tempDir("factory");
  const stubLog = join(dir, "harness-calls.jsonl");
  if (doc) await writeFile(join(dir, "lifecycle.json"), JSON.stringify(doc, null, 2));
  const config = readConfig({
    adlc: FAKE_ADLC,
    lifecycle: "./lifecycle.json",
    data: "./data",
    port: 0,
    model: { name: "PF_T_MODEL_NAME", endpoint: "PF_T_MODEL_ENDPOINT", key: "PF_T_MODEL_KEY", protocol: "PF_T_MODEL_PROTOCOL" },
    code: { holder, harness: Array.isArray(harness) ? harness : (harness ?? holder !== "pull-request") ? ["node", STUB_HARNESS, "{prompt}"] : null, rounds, minutes: 2, ...(fixRounds !== undefined ? { fix_rounds: fixRounds } : {}), ...(envRemove !== undefined ? { env_remove: envRemove } : {}) },
    // A fake GitHub (fixtures/fake-github.mjs): the token is read from PF_T_GITHUB_TOKEN, and the pull request is checked only when a test says so.
    ...(github ? { repository: { host: "github", repo: github.repo, token: "PF_T_GITHUB_TOKEN", api: github.url, poll_seconds: 3600 } } : {}),
    ...(review !== undefined ? { review } : {}),
    ...(intake !== undefined ? { intake } : {}),
    ...(notify !== undefined ? { notify } : {}),
    package: { packer: ["node", STUB_PACKER] },
    ...(runtime ? { runtime } : {}),
  }, dir);
  const env = { ...process.env, ...(model ? MODEL_VARS : {}), PF_STUB_LOG: stubLog, PF_STUB_FAIL_ROUNDS: String(failRounds), ...(github ? { PF_T_GITHUB_TOKEN: github.token } : {}), ...extraEnv };
  if (!model) for (const k of Object.keys(MODEL_VARS)) delete env[k];
  const store = createStore({ dir: config.data });
  const lifecycle = createLifecycle({ path: config.lifecycle });
  const person = { name: "Test Person", email: "person@example.com" };
  const runner = createRunner({ store, lifecycle, config, env, person });
  const issues = createIssueIntake({ config, env, store, runner });
  const key = store.key();
  const history = withHistory ? createHistory({ store }) : null;
  if (people) await writeFile(join(dir, "people.json"), JSON.stringify(people, null, 2));
  const access = people ? createPeople({ file: join(dir, "people.json"), keysFile: join(config.data, KEYS_FILE), lifecycle: lifecycle.file, serviceKey: key.value, admin: person }) : null;
  const service = createService({ store, lifecycle, runner, key: key.value, person, people: access, history, config, env, intake: issues });
  const notices = createNotices({ config, env, store, people: access, settled: (id) => runner.idle(id) });
  notices.watch();
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
    dir, config, store, lifecycle, runner, notices, issues, service, base, key, stubLog, call, env, history, people: access,
    get: (p) => call("GET", p),
    post: (p, b = {}) => call("POST", p, b),
    put: (p, b) => call("PUT", p, b),
    del: (p) => call("DELETE", p),
    /** Waits until the build has nothing running, then reads it through the API. */
    settled: async (id) => { await runner.idle(id); return (await call("GET", `/builds/${id}`)).json.build; },
    close: async () => { await issues.stop(); await runner.stopAll(); await notices.idle(); await service.close(); history?.close(); },
  };
}

export const stageOf = (build, id) => build.stages.find((s) => s.stage === id);
/**
 * The record of the run that made a build's Test and Code, as build.json keeps it: a version's newest
 * feature run (make-a-feature.txt), or the build itself when it made them in one chain (an old build,
 * or one started from existing code or an as-built record). feature: the run of that feature.
 */
export const codeRun = (f, id, feature = null) => {
  const b = f.store.read(id);
  const runs = b?.feature_runs ?? [];
  return (feature ? runs.find((x) => x.feature === feature) : runs.at(-1)) ?? b;
};
/** The folder that run keeps its files in: the feature run's own (runs/<id>/), or the build's. */
export const codeDir = (f, id, feature = null) => {
  const r = codeRun(f, id, feature);
  return r.feature ? join(f.store.folder(id), "runs", r.id) : f.store.folder(id);
};
export const actionNames = (build) => build.actions.map((a) => a.name);
