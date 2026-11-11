// Publishing decides on bytes, and says nothing is published until it has
// looked at the address.
//
// What is worth pinning: a file is typed by what it begins with and not by
// what it is called; a name and bytes that disagree are refused with both; a
// credential is refused whatever the file is named; a name cannot climb out of
// the bound folder however it is written; the destination is the agent's own
// folder of drafts, reached through the mesh's broker with the job's own
// credential and never named by the message; all files of one publish go into
// one folder named after the first; every address is read back and a digest
// that differs is reported rather than rounded off; a stopped agent places
// nothing; and a whole job files its pieces and answers with addresses it has
// checked.
// Nothing here touches a network: the broker, the storage and the addresses
// are functions the test hands in, and the job credential is one the test
// makes itself.
// Run: node --test test/publish.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  agrees, carriesASecret, inspectOne, looksLikeText, nameFor, readingOf, typeOf,
} from "../scripts/inspect.mjs";
import { API_DEFAULT, askBody, askCanonical, folderFor, jobCredentialOf, readBack, sha } from "../scripts/place.mjs";
import { NOTHING_GIVEN, fromArgv, knownNames, nameGiven, publish, rememberNames, replyText } from "../scripts/publish.mjs";
import { plan } from "../scripts/pieces.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const B = (s) => Buffer.from(s);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);

// A folder that goes away afterwards, whatever the test did in it.
async function folders(body) {
  const at = mkdtempSync(join(tmpdir(), "publisher-"));
  const dirs = { root: at, records: join(at, "records", "job1"), job: join(at, "job") };
  mkdirSync(dirs.records, { recursive: true });
  mkdirSync(join(dirs.job, "out"), { recursive: true });
  try { await body(dirs); } finally { rmSync(at, { recursive: true, force: true }); }
}

// ── what a file is ──────────────────────────────────────────────────────────

test("a file is typed by what it begins with, never by what it is called", () => {
  assert.equal(typeOf(PNG), "image/png");
  assert.equal(typeOf(B("<!doctype html><p>hi</p>")), "text/html");
  assert.equal(typeOf(B('{"a":1}')), "application/json");
  assert.equal(typeOf(B("<svg viewBox='0 0 1 1'></svg>")), "image/svg+xml");
  assert.equal(typeOf(B("%PDF-1.7 trailer")), "application/pdf");
  assert.equal(typeOf(B("just some words")), "text/plain");
  // Bytes that are neither a signature this agent knows nor text at all.
  assert.equal(typeOf(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04])), null);
});

test("text is bytes that decode and carry no control characters a document would not", () => {
  assert.equal(looksLikeText(B("hello")), true);
  assert.equal(looksLikeText(Buffer.from([104, 0, 105])), false, "a NUL is the usual sign it is not text");
  assert.equal(looksLikeText(Buffer.from([104, 0x07, 105])), false, "a bell is not in a document");
  assert.equal(looksLikeText(B("a\tb\r\nc")), true, "tab and newline are");
});

test("a claim may be more specific than the bytes can prove, and may not contradict them", () => {
  // A stylesheet has no signature and never will, so text is all the bytes say.
  assert.equal(agrees("text/plain", "text/css"), true);
  assert.equal(agrees("text/plain", "text/markdown"), true);
  assert.equal(agrees("application/json", "text/plain"), true);
  // And these are flat contradictions.
  assert.equal(agrees("image/png", "text/html"), false);
  assert.equal(agrees("text/html", "image/png"), false);
});

test("a file whose bytes are not what its name says is refused with both", () => {
  const one = inspectOne({ name: "page.html", bytes: PNG });
  assert.match(one.refused, /says it is text\/html/);
  assert.match(one.refused, /bytes are image\/png/);
  assert.equal(one.name, null, "and it gets no name, so nothing downstream can place it");
});

test("a stylesheet keeps the type its name claims, because the bytes cannot be more specific", () => {
  const one = inspectOne({ name: "site.css", bytes: B("body{color:red}") });
  assert.equal(one.refused, null);
  assert.equal(one.type, "text/css", "served as plain text a browser would not apply it");
});

// ── what must never go ──────────────────────────────────────────────────────

test("a credential is refused on its bytes, whatever the file is called", () => {
  // The seed is built rather than written out. A seed is 58 characters, and a
  // string that long sitting in a file reads as key material to every scanner
  // that looks at this repository, so a spelled-out one fails a secret scan
  // whether or not it decodes to anything. Built here, it is the shape the
  // detector looks for and nothing else: S, the kind, and 56 of base32.
  const seedShaped = `SU${"A".repeat(56)}`;
  for (const [what, body] of [
    ["a private key", "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----"],
    ["a private key", "-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl"],
    ["a service-account key", '{"type": "service_account", "project_id": "x"}'],
    ["an AWS access key", "export KEY=AKIAIOSFODNN7EXAMPLE"],
    ["an NKey seed", `seed: ${seedShaped}`],
  ]) {
    assert.equal(carriesASecret(B(body)), what, body.slice(0, 28));
    const one = inspectOne({ name: "notes.txt", bytes: B(body) });
    assert.match(one.refused, /does not publish one whatever it is called or who asks/);
  }
});

test("ordinary writing about credentials is not refused", () => {
  // A long list of clever patterns starts refusing the work, and then people
  // stop handing things over, which is worse than no list.
  for (const body of [
    "The private key never leaves the process and is never logged.",
    "Set aws_secret_access_key in your profile, not in the repo.",
    "A service account is named, never carried.",
  ]) assert.equal(carriesASecret(B(body)), null, body);
});

test("an empty file and an oversized one are both refused", () => {
  assert.match(inspectOne({ name: "a.txt", bytes: B("") }).refused, /empty file is not a publication/);
  assert.match(inspectOne({ name: "a.txt", bytes: B("hello"), bytesMax: 2 }).refused, /places nothing over 2/);
});

// ── where it may go ─────────────────────────────────────────────────────────

test("a name cannot climb out of the folder, however it is written", () => {
  assert.equal(nameFor("../../etc/passwd"), "passwd");
  assert.equal(nameFor("a.html", "../../secret"), "secret.html");
  assert.equal(nameFor("a.html", "/etc/shadow"), "etc-shadow.html");
  assert.equal(nameFor("a.html", "one two"), "one-two.html");
  assert.equal(nameFor("a.html", "..."), null, "a name with nothing in it is no name");
});

test("the name given is used for the first file only, so nothing quietly replaces anything", () => {
  assert.equal(nameFor("page.html", "report", 0), "report.html");
  assert.equal(nameFor("site.css", "report", 1), "site.css");
});

test("two files that would take the same name are both stopped, and the second is the one told", () => {
  const r = readingOf([
    { name: "one/index.html", bytes: B("<!doctype html>a") },
    { name: "two/index.html", bytes: B("<!doctype html>b") },
  ]);
  assert.equal(r.files[0].refused, null);
  assert.match(r.files[1].refused, /would both be published as index.html/);
});

// ── the broker: the job's own credential asks, per file ──────────────────────

// A job credential as the host hands one to a container: a real ed25519 seed
// in nkey form, because the agent really signs with it.
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32(bytes) {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function crc16(bytes) {
  let crc = 0;
  for (const b of bytes) { crc ^= b << 8; for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff; }
  return crc;
}
const withCrc = (body) => { const c = crc16(body); return Buffer.concat([body, Buffer.from([c & 0xff, c >> 8])]); };
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function jobWorker() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = base32(withCrc(Buffer.concat([Buffer.from([149, 0]), privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32)])));
  const id = base32(withCrc(Buffer.concat([Buffer.from([160]), publicKey.export({ format: "der", type: "spki" }).subarray(-32)])));
  return { id, publicKey, env: { MESH_JOB_JWT: `${b64u({ typ: "JWT" })}.${b64u({ sub: id })}.c2ln`, MESH_JOB_NKEY_SEED: seed } };
}

test("the broker is asked with the job's own credential, and a job without one stops the agent starting", () => {
  const w = jobWorker();
  assert.equal(jobCredentialOf(w.env).api, API_DEFAULT);
  assert.equal(API_DEFAULT, "https://api.agentmesh.ai/v1");
  assert.throws(() => jobCredentialOf({}), /MESH_JOB_JWT/);
  assert.throws(() => jobCredentialOf({ MESH_JOB_JWT: w.env.MESH_JOB_JWT }), /MESH_JOB_NKEY_SEED/);
  const body = askBody({ env: w.env, object: "my-report/my-report.html", now: () => 1_800_000_000_000 });
  assert.equal(body.system, "draft-host");
  assert.equal(body.job_jwt, w.env.MESH_JOB_JWT);
  const text = askCanonical({ ts: body.ts, worker: w.id, object: "my-report/my-report.html" });
  assert.equal(text, `mesh-stack-cred-job-v1:1800000000:${w.id}:draft-host:my-report/my-report.html`);
  assert.equal(verify(null, Buffer.from(text), w.publicKey, Buffer.from(body.sig, "base64")), true, "the broker would verify this signature");
});

test("all files of one publish go into one folder named after the first file's settled name", () => {
  assert.equal(folderFor("my-report.html"), "my-report");
  assert.equal(folderFor("archive.tar.gz"), "archive.tar");
  assert.equal(folderFor("README"), "README");
});

// ── what is actually served ─────────────────────────────────────────────────

test("an address that serves something else is reported, not rounded off", async () => {
  const bytes = B("<!doctype html>the real one");
  const placed = { name: "a.html", object: "draft/a.html", type: "text/html", bytes: bytes.length, sha256: sha(bytes) };
  const wrong = B("<!doctype html>a stale one");

  const ok = await readBack({ url: "https://x.test/draft/", placed, fetchImpl: async () => ({ ok: true, arrayBuffer: async () => bytes }) });
  assert.equal(ok.ok, true);
  assert.equal(ok.address, "https://x.test/draft/a.html");

  const stale = await readBack({ url: "https://x.test/draft/", placed, fetchImpl: async () => ({ ok: true, arrayBuffer: async () => wrong }) });
  assert.equal(stale.ok, false);
  assert.match(stale.why, /hash to/);

  const gone = await readBack({ url: "https://x.test/draft/", placed, fetchImpl: async () => ({ ok: false, status: 404 }) });
  assert.equal(gone.ok, false);
  assert.match(gone.why, /answered 404/);

  const dead = await readBack({ url: "https://x.test/draft/", placed, fetchImpl: async () => { throw new Error("no route"); } });
  assert.equal(dead.ok, false);
  assert.match(dead.why, /could not be reached: no route/);
});

test("the reply never names an address that was not read back", () => {
  const said = replyText({
    served: [
      { ok: true, name: "a.html", address: "https://x.test/draft/a.html" },
      { ok: false, name: "b.css", address: "https://x.test/draft/b.css", why: "the address answered 404" },
    ],
  });
  assert.match(said, /https:\/\/x\.test\/draft\/a\.html/);
  assert.equal(said.includes("https://x.test/draft/b.css"), false, "the one that is not serving is named, its address is not given");
  assert.match(said, /b\.css, because the address answered 404/);
  assert.equal(said.includes("—"), false, "no em dashes");
});

// ── the command line, the name, and the standing record ─────────────────────

test("files arrive as a path and the type the host was told, and both are kept", () => {
  const a = fromArgv(["--job", "/j", "--records", "/r", "--file", "/a/p.html::text/html", "--file", "/a/x"]);
  assert.equal(a.job, "/j");
  assert.deepEqual(a.files, [{ path: "/a/p.html", declared: "text/html" }, { path: "/a/x", declared: "" }]);
});

test("the name comes from the setting first and the message second", () => {
  assert.equal(nameGiven({ env: { NAME: "from-env" }, text: "name: from-text" }), "from-env");
  assert.equal(nameGiven({ env: {}, text: "please publish\nName: From-Text\nthanks" }), "From-Text");
  assert.equal(nameGiven({ env: {}, text: "no name here" }), "");
});

test("the names this agent has placed survive a job, and an unknown name is not one of them", async () => {
  await folders(async (at) => {
    const path = join(at.root, "names.json");
    assert.equal(knownNames(path).size, 0, "a missing record reads as nothing placed, never as an error");
    rememberNames(path, new Map([["a.html", "this agent"]]));
    assert.deepEqual([...knownNames(path).entries()], [["a.html", "this agent"]]);
  });
});

// ── a whole job ─────────────────────────────────────────────────────────────

// The broker, the storage and the read links, as one fake. An ask answers
// with a write link and a read link for that one object; a PUT to the write
// link stores the bytes with the type the link named; a GET on the read link
// serves what was stored. `refuse` makes the broker say no.
const READ = "https://api.test/v1/drafts/T/";
const host = (state, { refuse = null } = {}) => async (url, init = {}) => {
  const u = String(url);
  if (u.endsWith("/stack-credential")) {
    const body = JSON.parse(init.body);
    state.asks.push(body.object);
    if (refuse) return { ok: false, status: refuse.status, json: async () => refuse.body, text: async () => JSON.stringify(refuse.body) };
    const type = body.object.endsWith(".html") ? "text/html" : body.object.endsWith(".css") ? "text/css" : "application/octet-stream";
    return { ok: true, status: 200, json: async () => ({ ok: true, credential: {
      kind: "signed-url", method: "PUT", url: `https://store.test/put/${body.object}`, headers: { "content-type": type },
      expires_at: "x", read_url: `${READ}${body.object}`, public_url: `${READ}${body.object}`,
    } }) };
  }
  if (u.startsWith("https://store.test/put/")) {
    const object = u.slice("https://store.test/put/".length);
    state.objects.set(object, Buffer.from(init.body));
    state.types.set(object, init.headers?.["content-type"]);
    return { ok: true, status: 200, text: async () => "" };
  }
  const bytes = state.objects.get(u.replace(READ, ""));
  if (!bytes) return { ok: false, status: 404 };
  return { ok: true, arrayBuffer: async () => bytes };
};
const newState = () => ({ objects: new Map(), types: new Map(), asks: [] });

// A real job credential, because the agent really signs with it: a made-up
// string gets as far as the signer and fails there, which would have made every
// job test pass for the wrong reason.
const ENV = jobWorker().env;

test("a whole job: two files placed, both addresses read back, and the pieces filed", async () => {
  await folders(async (at) => {
    const page = join(at.root, "index.html");
    const css = join(at.root, "site.css");
    writeFileSync(page, "<!doctype html><link rel=stylesheet href=site.css><p>hello");
    writeFileSync(css, "body{color:#111}");
    const state = newState();

    const out = await publish({
      env: { ...ENV, NAME: "my-report" },
      argv: ["--job", at.job, "--records", at.records, "--file", `${page}::text/html`, "--file", `${css}::text/css`],
      fetchImpl: host(state),
    });

    assert.equal(out.code, 0, out.reply);
    assert.deepEqual(out.addresses, [`${READ}my-report/my-report.html`, `${READ}my-report/site.css`]);
    assert.deepEqual(state.asks, ["my-report/my-report.html", "my-report/site.css"], "both in one folder named after the first");
    assert.equal(state.objects.get("my-report/my-report.html").toString(), readFileSync(page, "utf8"));
    assert.equal(state.objects.get("my-report/site.css").toString(), readFileSync(css, "utf8"));
    assert.equal(state.types.get("my-report/site.css"), "text/css", "the PUT carried the type the link named");
    assert.match(out.reply, new RegExp(`${READ}my-report/my-report.html`.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")));

    for (const f of ["reading.json", "placed.json", "served.json"]) {
      assert.ok(existsSync(join(at.records, f)), `${f} was not written`);
    }
    const served = JSON.parse(readFileSync(join(at.records, "served.json"), "utf8"));
    assert.deepEqual(served.files.map((s) => s.ok), [true, true]);
    assert.equal(served.files[0].sha256, createHash("sha256").update(readFileSync(page)).digest("hex"));

    const listed = JSON.parse(readFileSync(join(at.job, "pieces.json"), "utf8"));
    assert.deepEqual(listed.map((e) => e.name), ["address", "publication record"]);
    assert.equal(readFileSync(join(at.job, "out", "addresses.txt"), "utf8").trim().split("\n").length, 2);
    assert.match(out.reply, /2 files are published/);
    assert.equal(out.reply.includes("—"), false);
  });
});

test("a refused file stops itself and not the others, and the reply says which and why", async () => {
  await folders(async (at) => {
    const good = join(at.root, "ok.html");
    const key = join(at.root, "config.json");
    writeFileSync(good, "<!doctype html>fine");
    writeFileSync(key, '{"type": "service_account", "private_key": "x"}');
    const state = newState();

    const out = await publish({
      env: ENV,
      argv: ["--job", at.job, "--records", at.records, "--file", `${good}::text/html`, "--file", `${key}::application/json`],
      fetchImpl: host(state),
    });

    assert.equal(out.code, 0, out.reply);
    assert.deepEqual(out.addresses, [`${READ}ok/ok.html`]);
    assert.equal([...state.objects.keys()].some((k) => k.endsWith("config.json")), false, "the credential never went anywhere");
    assert.match(out.reply, /carries a service-account key/);
    assert.deepEqual(out.refused.map((r) => r.file), ["config.json"]);
  });
});

test("nothing attached is a stop that says what this job takes and makes no call", async () => {
  await folders(async (at) => {
    let calls = 0;
    const out = await publish({
      env: ENV, argv: ["--job", at.job, "--records", at.records],
      fetchImpl: async () => { calls += 1; return { ok: true }; },
    });
    assert.equal(out.code, 3);
    assert.equal(out.reply, NOTHING_GIVEN);
    assert.equal(calls, 0);
    assert.equal(existsSync(join(at.job, "pieces.json")), false, "a stop files no pieces");
  });
});

test("when every file is refused, nothing is placed and nothing is altered to make it publishable", async () => {
  await folders(async (at) => {
    const key = join(at.root, "id_rsa");
    writeFileSync(key, "-----BEGIN RSA PRIVATE KEY-----\nMIIE");
    let calls = 0;
    const out = await publish({
      env: ENV, argv: ["--job", at.job, "--records", at.records, "--file", key],
      fetchImpl: async () => { calls += 1; return { ok: true, json: async () => ({}) }; },
    });
    assert.equal(out.code, 3);
    assert.equal(calls, 0, "it did not even ask the broker for a link");
    assert.match(out.reply, /a private key/);
    assert.match(out.reply, /I have not altered any of these files/);
  });
});

test("a stopped agent places nothing, and the reply says it is stopped", async () => {
  await folders(async (at) => {
    const page = join(at.root, "a.html");
    const css = join(at.root, "b.css");
    writeFileSync(page, "<!doctype html>a");
    writeFileSync(css, "p{}");
    const state = newState();
    const out = await publish({
      env: ENV, argv: ["--job", at.job, "--records", at.records, "--file", `${page}::text/html`, "--file", `${css}::text/css`],
      fetchImpl: host(state, { refuse: { status: 403, body: { error: "This agent is paused by its owner.", code: "agent_paused" } } }),
    });
    assert.equal(out.code, 3);
    assert.match(out.reply, /stopped/);
    assert.equal(state.asks.length, 1, "it asked once and placed nothing more");
    assert.equal(state.objects.size, 0);
    assert.deepEqual(out.addresses, []);
    assert.equal(existsSync(join(at.job, "pieces.json")), false);
  });
});

test("a broker that says no for another reason stops the job in the broker's own words", async () => {
  await folders(async (at) => {
    const page = join(at.root, "a.html");
    writeFileSync(page, "<!doctype html>a");
    const out = await publish({
      env: ENV, argv: ["--job", at.job, "--records", at.records, "--file", `${page}::text/html`],
      fetchImpl: host(newState(), { refuse: { status: 403, body: { error: "This agent's deployment did not bind draft-host to the House Stack.", code: "not_bound" } } }),
    });
    assert.equal(out.code, 3);
    assert.match(out.reply, /did not bind draft-host/);
    assert.match(out.reply, /Nothing was published|Nothing went up/);
  });
});

test("a file that went up but is not being served is not given as done", async () => {
  await folders(async (at) => {
    const page = join(at.root, "a.html");
    writeFileSync(page, "<!doctype html>a");
    const state = newState();
    const real = host(state);
    const out = await publish({
      env: ENV, argv: ["--job", at.job, "--records", at.records, "--file", `${page}::text/html`],
      fetchImpl: async (url, init) => {
        if (String(url).startsWith(READ)) return { ok: true, arrayBuffer: async () => Buffer.from("something else entirely") };
        return real(url, init);
      },
    });
    assert.equal(out.code, 3);
    assert.deepEqual(out.addresses, []);
    assert.match(out.reply, /no address is serving what went up/);
    assert.equal(existsSync(join(at.job, "pieces.json")), false);
  });
});

test("the pieces refuse to be filed when nothing is at an address", () => {
  assert.throws(() => plan({ served: [{ ok: false }], recordPath: "/r/served.json" }), /nothing is at an address/);
  assert.throws(() => plan({ served: [{ ok: true, address: "https://x" }], recordPath: "" }), /publication record is missing/);
});

test("every step of this job is one of the three the offering names", () => {
  // The package's own declaration, beside test/ in the package root.
  const desc = JSON.parse(readFileSync(join(here, "..", "agent-descriptor.json"), "utf8"));
  const offered = desc.offerings.find((o) => o.id === "publish");
  assert.deepEqual(offered.steps.map((s) => s.id), ["read-what-was-given", "place-the-files", "check-what-is-served"]);
  // No model is woken anywhere in this offering, which is why it costs nothing.
  for (const j of [offered, ...offered.steps]) assert.equal(j.how.intelligence, "none", j.id);
});
