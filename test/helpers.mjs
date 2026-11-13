// What the tests share: a temporary folder, and a whole Product Factory on
// 127.0.0.1 with fake holders (the stand-in agents under fixtures/fake-adlc,
// the stand-in harness and the stand-in packer under fixtures/bin).

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
export const STUB_BUILDER = join(HERE, "fixtures", "stub-builder.mjs");
export const STUB_PACKER = join(HERE, "fixtures", "bin", "stub-packer.mjs");

export const tempDir = (name) => mkdtemp(join(process.env.PF_TEST_TMP || tmpdir(), `pf-${name}-`));

/** The model settings the stand-in agents check for, under the names the test settings give them. */
export const MODEL_VARS = { PF_T_MODEL_NAME: "stand-in-model", PF_T_MODEL_ENDPOINT: "http://127.0.0.1:9/never-called", PF_T_MODEL_KEY: "", PF_T_MODEL_PROTOCOL: "openai-chat" };

/**
 * A Product Factory with fake holders. doc: a lifecycle document to start from.
 * holder: "builder", the only one (one builder makes new agents; a rebuild or an adoption runs on the
 * reference writers). failRounds: how many rounds of the stand-in harness, run for a rebuild's reference
 * code writer, write the wrong code. harness: true for the stand-in builder, false for none, or a command.
 * people: a people.json to start from; with it, each person's own key works (f.people).
 */
export async function factory({ doc = null, holder = "builder", rounds = 3, failRounds = 0, model = true, harness = undefined, github = null, review = undefined, history: withHistory = true, runtime = null, people = null, intake = undefined, notify = undefined, extraEnv = {}, envRemove = undefined, adlc = FAKE_ADLC, where = undefined } = {}) {
  const dir = await tempDir("factory");
  const stubLog = join(dir, "harness-calls.jsonl");
  if (doc) await writeFile(join(dir, "lifecycle.json"), JSON.stringify(doc, null, 2));
  const config = readConfig({
    adlc,
    lifecycle: "./lifecycle.json",
    data: "./data",
    port: 0,
    model: { name: "PF_T_MODEL_NAME", endpoint: "PF_T_MODEL_ENDPOINT", key: "PF_T_MODEL_KEY", protocol: "PF_T_MODEL_PROTOCOL" },
    code: { holder, harness: Array.isArray(harness) ? harness : (harness ?? true) ? ["node", STUB_BUILDER, "{prompt}", "{plugin}"] : null, rounds, minutes: 2, ...(where !== undefined ? { where } : {}), ...(envRemove !== undefined ? { env_remove: envRemove } : {}) },
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

/**
 * A whole as-built record of code kept elsewhere (record.json and its five parts) in a folder of its
 * own, in the reverse engineer's shape, with the behaviors given (none by default). Resolves to the folder.
 */
export async function asBuiltRecord(behaviors = []) {
  const dir = join(await tempDir("record"), "as-built");
  await mkdir(dir, { recursive: true });
  const files = {
    "record.json": { format: "as-built-record-v1", as_built: true, repository: "file:///work/orig", commit: "bfecc9cea70c5df651db5cf2530416832c6fc68d", read_mode: "read", trigger: "adoption", made_by: { agent: "reverse-engineer", version: "0.1.0" } },
    "behaviors.json": { format: "as-built-behaviors-v1", behaviors },
    "architecture.json": { format: "as-built-architecture-v1", settings: [], systems: [] },
    "interfaces.json": { format: "as-built-interfaces-v1", interfaces: [] },
    "sbom.cdx.json": { bomFormat: "CycloneDX", specVersion: "1.5", components: [] },
    "tests-and-gaps.json": { format: "as-built-tests-and-gaps-v1", tests: [], gaps: [] },
  };
  for (const [p, v] of Object.entries(files)) await writeFile(join(dir, p), JSON.stringify(v, null, 2));
  return dir;
}

/**
 * A build that runs on the reference writers: a rebuild from an as-built record (starting point
 * as-built-record), started as POST /builds starts one. One builder makes new agents only, so a test
 * of what the reference spec writer, test writer or code writer do starts one of these. body: the
 * request (name is required). behaviors: the record's, each proposed as built. Resolves to the build id.
 */
export async function startRebuild(f, body, { behaviors = [] } = {}) {
  const got = await f.post("/builds", { ...body, starting_point: "as-built-record", source: { folder: await asBuiltRecord(behaviors) } });
  if (got.status !== 201) throw new Error(`The rebuild did not start: ${JSON.stringify(got.json)}`);
  return got.json.build.id;
}

export const stageOf = (build, id) => build.stages.find((s) => s.stage === id);
export const actionNames = (build) => build.actions.map((a) => a.name);

/**
 * Walk a build through its gates as a person would, whichever kind of build it is: approve
 * what waits for approval (the spec, the deploy), answer what only the person can answer in a
 * one-builder build folder ("key: yes" for each question), and give the OK on the code where a
 * separate writer's build offers it. Stops at the first stage named in `until` that waits,
 * when nothing is offered to take, or after `steps`. Resolves to the build as it settled.
 */
export async function walk(f, id, { until = [], steps = 12 } = {}) {
  let b = await f.settled(id);
  for (let i = 0; i < steps; i++) {
    const names = (b.actions ?? []).map((a) => a.name);
    const at = (b.actions ?? [])[0]?.stage;
    if (until.includes(at)) return b;
    const questions = f.store.read(id).work?.builder?.questions ?? [];
    if (names.includes("approve")) await f.post(`/builds/${id}/actions/approve`);
    else if (names.includes("accept")) await f.post(`/builds/${id}/actions/accept`);
    else if (names.includes("changes") && questions.length) await f.post(`/builds/${id}/actions/changes`, { changes: questions.map((q) => `${q.key}: yes`).join("\n") });
    else return b;
    b = await f.settled(id);
  }
  return b;
}
