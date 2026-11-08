// The file store and the lifecycle document file.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers.mjs";
import { createStore, RECORD_FORMAT } from "../lib/store.mjs";
import { createLifecycle } from "../lib/lifecycle.mjs";

const record = (id, created) => ({ format: RECORD_FORMAT, id, created, name: "n", does: "d", version: "0.1.0", status: "working", stages: {}, log: [] });

test("a build is a folder with build.json, written whole, and listed newest first", async () => {
  const store = createStore({ dir: await tempDir("store") });
  const a = store.newId();
  const b = store.newId();
  assert.match(a, /^b_[a-z0-9]{12}$/);
  assert.notEqual(a, b);
  store.create(record(a, "2026-11-08T10:00:00Z"));
  store.create(record(b, "2026-11-08T11:00:00Z"));
  assert.deepEqual(store.list().map((r) => r.id), [b, a]);
  assert.equal(store.read(a).name, "n");
  assert.ok(store.read(a).updated);
  assert.throws(() => store.create(record(a, "2026-11-08T12:00:00Z")));
  assert.equal(store.read("../etc"), null);
  assert.equal(store.read("b_nothinghere0"), null);
});

test("changes to one build are made one at a time, each on the one before", async () => {
  const store = createStore({ dir: await tempDir("store") });
  const id = store.newId();
  store.create({ ...record(id, "2026-11-08T10:00:00Z"), n: 0 });
  await Promise.all(Array.from({ length: 25 }, () => store.update(id, (r) => { r.n += 1; })));
  assert.equal(store.read(id).n, 25);
  const text = readFileSync(join(store.folder(id), "build.json"), "utf8");
  assert.doesNotThrow(() => JSON.parse(text));
});

test("a file is found only inside its build's folder", async () => {
  const store = createStore({ dir: await tempDir("store") });
  const id = store.newId();
  store.create(record(id, "2026-11-08T10:00:00Z"));
  writeFileSync(join(store.folder(id), "a.txt"), "x");
  assert.ok(store.fileIn(id, "a.txt"));
  assert.equal(store.fileIn(id, "../service-key"), null);
  assert.equal(store.fileIn(id, "missing.txt"), null);
  assert.equal(store.fileIn(id, "."), null);
});

test("the service key is made once and kept", async () => {
  const store = createStore({ dir: await tempDir("store") });
  const k1 = store.key();
  const k2 = store.key();
  assert.match(k1.value, /^[0-9a-f]{64}$/);
  assert.equal(k1.value, k2.value);
  if (process.platform !== "win32") assert.equal(statSync(k1.file).mode & 0o777, 0o600);
});

test("the lifecycle file is made when missing, read on every request, and refused in words when it is wrong", async () => {
  const dir = await tempDir("lifecycle");
  const path = join(dir, "lifecycle.json");
  const lc = createLifecycle({ path });
  assert.equal(await lc.check(), null);
  assert.ok(existsSync(path));
  assert.equal(JSON.parse(readFileSync(path, "utf8")).version, "0.1");
  assert.equal((await lc.stages(null)).stages.every((s) => s.used && s.from === "default"), true);

  // A change made by hand shows on the next read.
  writeFileSync(path, JSON.stringify({ version: "0.1", organization: { used: { eval: false } } }));
  assert.equal((await lc.stages(null)).stages.find((s) => s.stage === "eval").used, false);
  // A stage this service needs stays used even when the file leaves it out.
  writeFileSync(path, JSON.stringify({ version: "0.1", organization: { used: { test: false } } }));
  const t = (await lc.stages(null)).stages.find((s) => s.stage === "test");
  assert.equal(t.used, true);
  assert.equal(t.from, "default");

  writeFileSync(path, "{ not json");
  await assert.rejects(lc.stages(null), (e) => e.status === 409 && /not valid JSON/.test(e.message));
  writeFileSync(path, JSON.stringify({ version: "0.2", organization: {} }));
  await assert.rejects(lc.stages(null), (e) => e.status === 409 && /not a valid lifecycle document/.test(e.message));
  assert.match(await lc.check(), /not a valid lifecycle document/);
  writeFileSync(path, JSON.stringify({ version: "0.1", organization: { holders: { "code-critic": { kind: "your_agent", name: "Ours" } } } }));
  await assert.rejects(lc.roles(null), (e) => e.status === 409 && /handle/.test(e.message));
});

test("a build's snapshot is the lifecycle in effect, with the project's choices over the organization's", async () => {
  const dir = await tempDir("lifecycle");
  const path = join(dir, "lifecycle.json");
  writeFileSync(path, JSON.stringify({
    version: "0.1",
    organization: { used: { docs: false, eval: false }, added_stages: [{ id: "legal-review", name: "Legal review", phase: "make", after: "review", role: "legal", role_name: "Legal", given: "the code", hands_back: "a yes or a no", done_when: "legal says yes", person_gate: true }] },
    projects: { web: { used: { docs: true }, holders: { "code-writer": { kind: "your_agent", name: "Our coder", handle: "coder.web@example.com" } } } },
  }));
  const lc = createLifecycle({ path });
  const org = await lc.snapshot(null);
  assert.deepEqual(org.used.docs, { used: false, from: "org" });
  assert.equal(org.holders["code-writer"].kind, "reference_agent");
  assert.deepEqual(org.added, [{ id: "legal-review", name: "Legal review" }]);
  const web = await lc.snapshot("web");
  assert.deepEqual(web.used.docs, { used: true, from: "project" });
  assert.deepEqual(web.used.eval, { used: false, from: "org" });
  assert.equal(web.holders["code-writer"].name, "Our coder");
  // The stages answer lists the stages of stages.json and no others.
  assert.equal((await lc.stages(null)).stages.length, 24);
});
