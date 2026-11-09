// The Product Factory plugin's tools: a thin client over the lifecycle API a
// running Product Factory answers at /v1/lifecycle. Everything here is a call
// the adlc console makes too; nothing is decided here that the service
// decides. Each tool answers in plain words, then compact JSON.
//
// Where the service is, and its key, are found the way the console is given
// them: the service's address and a key file. From the environment:
//
//   PRODUCT_FACTORY_URL        the service, such as http://127.0.0.1:4510
//   PRODUCT_FACTORY_KEY_FILE   a key file: a person's own key, or the service's
//   PRODUCT_FACTORY_CONFIG     a product-factory.json, read for its port and data folder
//
// With no URL, the settings file is PRODUCT_FACTORY_CONFIG, or the first
// product-factory.json in the working folder or a folder above it: the
// address is 127.0.0.1 at its "port", and the key is <data>/service-key, the
// file the running instance made. The key is read on each call and is never
// printed, logged or put in an answer.
//
// The plugin is copied on its own when Claude Code installs it, so this file
// imports nothing from Product Factory's lib/ and uses only Node's own modules.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const BASE = "/v1/lifecycle";
const DEFAULT_PORT = 4510;
const DEFAULT_DATA = "./builds";
const SHORT_MS = 30_000;
const CHAT_MS = 6 * 60_000;
const WAIT_LIMIT = 600;
const POLL_MS = 2_000;
/** Actions that are housekeeping, not an answer at a gate. */
const HOUSEKEEPING = new Set(["stop", "archive", "unarchive"]);
const WHEN_NEEDED = new Set(["impact", "rollback", "reconfigure", "retract", "decommission"]);

// ---------- where the service is ----------

const set = (v) => typeof v === "string" && v.trim() !== "" && !v.startsWith("${");

/** The first product-factory.json in from or a folder above it, or null. */
export function findConfig(from) {
  let dir = resolve(from);
  for (;;) {
    const f = join(dir, "product-factory.json");
    if (existsSync(f)) return f;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * Where the service is and which key file to send: { url, keyFile, from } or
 * { problem } in words. Never reads the key itself.
 */
export function locate(env = process.env, cwd = process.cwd()) {
  const keyFile = set(env.PRODUCT_FACTORY_KEY_FILE) ? resolve(env.PRODUCT_FACTORY_KEY_FILE) : null;
  const configFile = set(env.PRODUCT_FACTORY_CONFIG) ? resolve(env.PRODUCT_FACTORY_CONFIG) : findConfig(cwd);
  let cfg = null;
  if (configFile) {
    if (!existsSync(configFile)) return { problem: `PRODUCT_FACTORY_CONFIG names ${configFile}, which is not there.` };
    try {
      const raw = JSON.parse(readFileSync(configFile, "utf8").replace(/^﻿/, ""));
      const port = raw.port ?? DEFAULT_PORT;
      const data = resolve(dirname(configFile), typeof raw.data === "string" && raw.data.trim() ? raw.data : DEFAULT_DATA);
      cfg = { port, keyFile: join(data, "service-key") };
    } catch (e) {
      return { problem: `${configFile} is not valid JSON: ${e.message}.` };
    }
  }
  let url = set(env.PRODUCT_FACTORY_URL) ? env.PRODUCT_FACTORY_URL.trim().replace(/\/+$/, "").replace(/\/v1\/lifecycle$/, "") : null;
  if (!url && cfg) {
    if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) return { problem: `${configFile} has port ${cfg.port}, so the address cannot be read from it. Set PRODUCT_FACTORY_URL to the address Product Factory printed when it started.` };
    url = `http://127.0.0.1:${cfg.port}`;
  }
  if (!url) return { problem: "No Product Factory found: there is no product-factory.json in this folder or above it. Start Claude Code in the folder you run Product Factory in, or set PRODUCT_FACTORY_URL and PRODUCT_FACTORY_KEY_FILE (or PRODUCT_FACTORY_CONFIG)." };
  if (!/^https?:\/\/[^/\s]+$/.test(url)) return { problem: `PRODUCT_FACTORY_URL is ${url}, which is not an address such as http://127.0.0.1:4510.` };
  const file = keyFile ?? cfg?.keyFile ?? null;
  if (!file) return { problem: "PRODUCT_FACTORY_URL is set but no key is: set PRODUCT_FACTORY_KEY_FILE to your key file, or PRODUCT_FACTORY_CONFIG to the product-factory.json the service runs from." };
  return { url, keyFile: file, from: keyFile ? "key file" : configFile };
}

// ---------- the client ----------

export class ToolProblem extends Error {
  constructor(message, { status = null, data = null } = {}) { super(message); this.status = status; this.data = data; }
}

/** A client of the service at where ({ url, keyFile }), or of the one locate() finds on each call. */
export function createClient({ where = null, env = process.env, cwd = process.cwd(), fetchImpl = fetch } = {}) {
  function target() {
    const w = where ?? locate(env, cwd);
    if (w.problem) throw new ToolProblem(w.problem);
    let key;
    try { key = readFileSync(w.keyFile, "utf8").trim(); } catch {
      throw new ToolProblem(`The key file ${w.keyFile} cannot be read. Product Factory makes it in its data folder when it first starts; start it, or set PRODUCT_FACTORY_KEY_FILE to your own key file.`);
    }
    if (!key) throw new ToolProblem(`The key file ${w.keyFile} is empty.`);
    return { url: w.url, key };
  }

  async function call(method, path, body, { timeoutMs = SHORT_MS } = {}) {
    const { url, key } = target();
    let res;
    try {
      res = await fetchImpl(`${url}${BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${key}`, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const late = e?.name === "TimeoutError";
      throw new ToolProblem(late ? `Product Factory at ${url} did not answer within ${Math.round(timeoutMs / 1000)} seconds.` : `Product Factory is not answering at ${url}. Start it (npx product-factory) in its folder, or set PRODUCT_FACTORY_URL to where it runs.`);
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok) {
      const words = json?.error ?? `Product Factory answered ${res.status}.`;
      throw new ToolProblem(res.status === 401 ? `${words} The key in use was refused; check PRODUCT_FACTORY_KEY_FILE or the service's data folder.` : words, { status: res.status, data: json });
    }
    return json;
  }

  return {
    get: (p) => call("GET", p),
    post: (p, b = {}, o) => call("POST", p, b, o),
  };
}

// ---------- words ----------

const enc = encodeURIComponent;
const clip = (s, n = 400) => { const x = String(s ?? "").replace(/\s+/g, " ").trim(); return x.length > n ? `${x.slice(0, n - 1)}...` : x; };

/** A summary object (an artifact's) in a line of words. */
export function summaryWords(summary) {
  if (!summary || typeof summary !== "object") return "";
  if (typeof summary.words === "string") return clip(summary.words, 300);
  const parts = [];
  for (const [k, v] of Object.entries(summary)) {
    if (v === null || v === undefined || v === "") continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") parts.push(`${k.replace(/_/g, " ")}: ${v}`);
    else if (Array.isArray(v)) {
      if (!v.length) continue;
      const items = v.map((x) => (typeof x === "object" && x ? (x.name ?? x.id ?? x.path ?? x.title ?? JSON.stringify(x)) : String(x)));
      parts.push(`${k.replace(/_/g, " ")}: ${items.slice(0, 8).join(", ")}${items.length > 8 ? ` and ${items.length - 8} more` : ""}`);
    }
  }
  return clip(parts.join("; "), 300);
}

const stageName = (id) => (id ? id[0].toUpperCase() + id.slice(1).replace(/_/g, " ") : id);
const actionId = (build, name) => `${build}/${name}`;
const actionOut = (build, a) => ({ id: actionId(build, a.name), label: a.label, stage: a.stage, ...(a.needs?.length ? { needs: a.needs.map((n) => ({ name: n.name, label: n.label, ...(n.optional ? { optional: true } : {}), ...(n.options ? { options: n.options } : {}), ...(n.default !== undefined ? { default: n.default } : {}) })) } : {}) });
const actionLine = (build, a) => `${a.label} [${actionId(build, a.name)}]${a.needs?.length ? ` (needs ${a.needs.map((n) => n.name).join(", ")})` : ""}`;

function result(words, data) {
  return { content: [{ type: "text", text: words }, { type: "text", text: JSON.stringify(data) }] };
}

// ---------- reading the service ----------

/** Where each build is (GET /builds): id -> list item. */
async function buildIndex(api, archived = true) {
  const got = await api.get(`/builds${archived ? "?archived=1" : ""}`);
  return new Map(got.builds.map((b) => [b.id, b]));
}

/** The build a tool is about: the build named, or the product's newest. Resolves to { id, item }. */
async function resolveBuild(api, { build, product }) {
  const index = await buildIndex(api);
  if (build) {
    const item = index.get(build);
    if (!item) throw new ToolProblem(`There is no build ${build}. waiting_on_me and build_status list the builds there are.`);
    return { id: build, item };
  }
  if (product) {
    const p = await api.get(`/products/${enc(product)}?archived=1`).catch((e) => { if (e.status === 404) throw new ToolProblem(`There is no product ${product}. A product is every build of one name.`); throw e; });
    const id = p.builds[0].id;
    return { id, item: index.get(id), product: p };
  }
  return null;
}

/** The current stage's gate words, from the build and its stage workspace. */
function gateOut(b, stageId, ws) {
  const s = b.stages.find((x) => x.stage === stageId);
  const out = {
    stage: stageId,
    state: s?.state ?? null,
    said: (s?.handed_back?.words ?? []).slice(-6),
    who_may: ws?.gate?.who_may ?? s?.gate?.words ?? null,
    you_may_answer: s?.gate ? s.gate.you_may_answer : null,
  };
  if (ws?.gate?.open?.length) out.open = ws.gate.open;
  if (ws?.gate?.features) out.features = ws.gate.features;
  if (s?.where) out.where = s.where;
  return out;
}

function gateWords(g) {
  const lines = [];
  if (g.said.length) lines.push(`   It says: ${g.said.map((x) => clip(x, 300)).join(" ")}`);
  if (g.open?.length) lines.push(`   Still open: ${g.open.map((x) => clip(x, 200)).join("; ")}`);
  if (g.features?.to_approve?.length) lines.push(`   Approving starts building with these features too: ${g.features.to_approve.map((f) => `${f.id} ${f.name}`).join(", ")}`);
  if (g.where?.kind === "pull_request") lines.push(`   Pull request: ${g.where.url}${g.where.head ? ` at ${g.where.head}` : ""}${g.where.check ? `. Check: ${g.where.check.title}${g.where.check.words ? `: ${clip(g.where.check.words, 300)}` : ""}` : ""}`);
  if (g.who_may) lines.push(`   Who may answer: ${g.who_may}`);
  return lines;
}

/** Every feature proposal of a product still waiting for an answer: [{ proposal, feature, ... }]. */
async function pendingFeatures(api, product) {
  const m = await api.get(`/products/${enc(product)}/features`).catch(() => null);
  if (!m?.features?.length) return [];
  const out = [];
  for (const row of m.features.slice(0, 100)) {
    const one = await api.get(`/products/${enc(product)}/features/${enc(row.id)}`).catch(() => null);
    const p = one?.feature?.pending;
    if (p && ["open", "asked", "not_now"].includes(p.state)) out.push({ ...p, product, build: m.build });
  }
  return out;
}

/** The product's boss proposals still open: [{ id, build, action, needs, words, when? }]. */
async function openBossProposals(api, product) {
  const got = await api.get(`/products/${enc(product)}/boss/messages`).catch(() => null);
  return (got?.messages ?? []).filter((m) => m.proposes && (m.proposes.state ?? "open") === "open").map((m) => ({ ...m.proposes, product, message: m.id }));
}

const featureOut = (p) => ({ id: p.proposal, product: p.product, feature: p.feature, name: p.name, does: p.does, change: p.change, ...(p.was ? { was: p.was } : {}), state: p.state, you_may_approve: p.you_may_approve, ...(p.approvers?.length ? { approvers: p.approvers } : {}) });
const featureLine = (p) => `${p.product} ${p.feature} "${p.name}": ${clip(p.does, 200)} (${p.change}${p.state === "asked" ? ", the approvers were asked" : ""}) [${p.proposal}]`;

// ---------- the tools ----------

const S = (props, required = []) => ({ type: "object", properties: props, required, additionalProperties: false });
const str = (description) => ({ type: "string", description });
const WAIT = { type: "integer", minimum: 0, maximum: WAIT_LIMIT, description: `Seconds to wait for the build to move on before answering (0 answers now; at most ${WAIT_LIMIT}).` };

export const TOOLS = [
  {
    name: "start_build",
    description: "Start a Product Factory build of an agent, from the engineer's words (does, and optionally name, refuses, more, project, prototype) or from a GitHub issue number when the factory's intake is on. Start a build only when the engineer asked for one. Answers with the build's id and where it is.",
    inputSchema: S({
      does: str("What the agent should do, in the engineer's words."),
      name: str("A name for the agent, such as word-counter, when the engineer gave one."),
      refuses: str("What it must refuse."),
      more: str("Anything else the engineer wants said."),
      project: str("The project whose lifecycle the build follows."),
      prototype: str("A public repository, as owner/name, to read as the agent's prototype."),
      issue: { type: "integer", minimum: 1, description: "Start from this GitHub issue instead of words (the factory's intake must be on, and the issue open with its label)." },
      wait_seconds: WAIT,
    }),
    annotations: { title: "Start a build", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "waiting_on_me",
    description: "What waits on the caller across Product Factory's products: gates they may answer (with each action's id for act and the gate's own words), feature proposals they may approve or defer, and the boss's open proposals. Also says what waits on someone else. Read only.",
    inputSchema: S({ product: str("Only this product.") }),
    annotations: { title: "What's waiting on me", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "build_status",
    description: "Where a build is: its summary, the current stage and its state, the gate there with its words and who may answer, the actions offered to the caller (ids for act), the pull request and its latest check when Code is on one, and the newest log lines. Give build, or product for its newest build; give neither to list the products. wait_seconds watches a working build until it moves (such as a gate result coming back on a push); one waiting on a person is answered at once. Read only.",
    inputSchema: S({ build: str("A build id, such as b_1a2b3c4d5e6f."), product: str("A product name; its newest build."), wait_seconds: WAIT }),
    annotations: { title: "Build status", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "stage",
    description: "A stage's workspace on a build: what it was given and what it handed back (its outputs), each with its summary and files, what done means for it, and its gate. stage defaults to the stage the build is at. Read only.",
    inputSchema: S({ build: str("A build id."), product: str("A product name; its newest build."), stage: str("A stage id from stages.json, such as requirements, test, code or package.") }),
    annotations: { title: "Stage workspace", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "ask",
    description: "Say something to the agent holding a stage of a product (stage: requirements, test, ...) or to the product's boss (stage: boss), and return its reply with any action it proposes and any feature it proposes, each with the id act takes. Asking changes nothing by itself; a proposal is taken only with act, when the engineer says so.",
    inputSchema: S({ product: str("The product, such as word-counter."), stage: str("A stage id, or boss."), text: str("What the engineer says."), build: str("The build it is about; the product's newest when left out. Not used for the boss.") }, ["product", "stage", "text"]),
    annotations: { title: "Ask a stage agent or the boss", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "act",
    description: "Take one action the engineer asked for in this conversation, by its id: a gate or other build action (<build>/<action>, such as b_1a2b3c4d5e6f/approve, from waiting_on_me, build_status or ask), a when-needed action on a product (<build>/rollback and the like), a boss proposal (bp_...), or a feature proposal (fp_..., with decision approve or not_now). It takes only an action the build offers the caller now, refuses anything else and says what is offered, and says what it did. Never call it on your own judgment: show the gate's words, ask the engineer, and act only on their yes, quoted in engineer_said.",
    inputSchema: S({
      id: str("The action's id: <build>/<action>, bp_..., or fp_..."),
      decision: { type: "string", enum: ["approve", "not_now"], description: "For a feature proposal (fp_...): approve it, or leave it for later." },
      needs: { type: "object", additionalProperties: { type: "string" }, description: "The action's needs, one member per need, such as { \"changes\": \"...\" } for Ask for changes. A proposal's own needs are used when this is left out." },
      engineer_said: str("The engineer's own words in this conversation asking for this action."),
    }, ["id", "engineer_said"]),
    annotations: { title: "Take an action", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
];

/** The tools' handlers over a client (createClient). Each resolves to an MCP tool result. */
export function createHandlers(api, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() } = {}) {
  async function readBuild(id) { return (await api.get(`/builds/${enc(id)}`)).build; }

  /** The build's state as one line, to tell when it has moved. */
  const signature = (b, item) => JSON.stringify([item?.at?.stage, item?.at?.state, b.summary, b.stages.find((s) => s.stage === "code")?.where?.check?.title ?? null, b.stages.find((s) => s.stage === "code")?.where?.head ?? null]);

  async function statusOf(id) {
    const index = await buildIndex(api);
    const item = index.get(id);
    const b = await readBuild(id); // the service shapes it for this person: only the actions they may take
    const at = item?.at?.stage ?? null;
    const ws = at ? await api.get(`/builds/${enc(id)}/stages/${enc(at)}`).catch(() => null) : null;
    return { b, item, at, ws };
  }

  async function watch(id, seconds) {
    let s = await statusOf(id);
    // Only a build that is working moves on its own; one waiting on a person is answered now.
    if (!seconds || s.item?.at?.state !== "working") return { ...s, moved: null };
    const first = signature(s.b, s.item);
    const until = now() + seconds * 1000;
    while (now() < until) {
      await sleep(Math.min(POLL_MS, Math.max(0, until - now())));
      s = await statusOf(id);
      if (signature(s.b, s.item) !== first) return { ...s, moved: true };
    }
    return { ...s, moved: false };
  }

  function statusAnswer({ b, item, at, ws, moved }) {
    const mine = b.actions.filter((a) => !["archive", "unarchive"].includes(a.name));
    const g = at ? gateOut(b, at, ws) : null;
    const lines = [`${b.name} ${b.version} (${b.id}): ${b.summary}.`];
    if (moved === true) lines.push("It moved while I watched.");
    if (moved === false) lines.push("It did not move while I watched.");
    if (at) lines.push(`Current stage: ${ws?.name ?? stageName(at)}, ${item?.at?.state ?? g?.state}.`);
    if (g) lines.push(...gateWords(g));
    if (mine.length) lines.push(`Actions offered to you: ${mine.map((a) => actionLine(b.id, a)).join("; ")}.`);
    else lines.push("No action is offered to you now.");
    const log = (b.log ?? []).slice(0, 5);
    if (log.length) lines.push(`Newest log: ${log.map((e) => clip(e.said ?? e.words ?? "", 200)).join(" | ")}`);
    const data = {
      build: b.id, product: b.name, version: b.version, summary: b.summary,
      at: item?.at ?? null, gate: g, actions: mine.map((a) => actionOut(b.id, a)),
      stages: b.stages.filter((s) => !["not_offered", "not_used"].includes(s.state)).map((s) => ({ stage: s.stage, state: s.state })),
      log: log.map((e) => ({ at: e.at, said: e.said })),
      ...(moved !== null ? { moved } : {}),
    };
    return result(lines.join("\n"), data);
  }

  const handlers = {
    async start_build(args) {
      const wait = args.wait_seconds ?? 0;
      let b;
      if (args.issue !== undefined) {
        if (args.does) throw new ToolProblem("Start from words (does) or from an issue, not both.");
        b = (await api.post(`/intake/issues/${enc(args.issue)}`, {})).build;
      } else {
        if (!args.does || !String(args.does).trim()) throw new ToolProblem("Say what the agent should do (does), or give an issue number.");
        const body = { does: args.does };
        for (const k of ["name", "refuses", "more", "project", "prototype"]) if (args[k]) body[k] = args[k];
        b = (await api.post("/builds", body)).build;
      }
      const s = await watch(b.id, wait);
      const out = statusAnswer(s);
      out.content[0].text = `Started ${b.name} ${b.version} as build ${b.id}${args.issue !== undefined ? `, from issue #${args.issue}` : ""}.\n${out.content[0].text}`;
      return out;
    },

    async waiting_on_me(args) {
      const me = await api.get("/me");
      const index = await buildIndex(api, false);
      const gates = [];
      const others = [];
      for (const item of index.values()) {
        if (args.product && item.name !== args.product) continue;
        if (!["waiting_on_you", "refused"].includes(item.at?.state)) continue;
        const b = await readBuild(item.id);
        const mine = b.actions.filter((a) => !HOUSEKEEPING.has(a.name));
        const ws = await api.get(`/builds/${enc(item.id)}/stages/${enc(item.at.stage)}`).catch(() => null);
        const g = gateOut(b, item.at.stage, ws);
        const entry = { product: b.name, version: b.version, build: b.id, stage: item.at.stage, stage_name: ws?.name ?? stageName(item.at.stage), summary: b.summary, gate: g };
        if (mine.length) gates.push({ ...entry, actions: b.actions.filter((a) => a.name !== "archive" && a.name !== "unarchive").map((a) => actionOut(b.id, a)) });
        else others.push({ ...entry, who_may: g.who_may });
      }
      const products = (await api.get("/products")).products.map((p) => p.name).filter((n) => !args.product || n === args.product);
      const features = [];
      const featuresOthers = [];
      const proposals = [];
      for (const name of products) {
        for (const p of await pendingFeatures(api, name)) {
          if (p.state === "not_now") continue;
          (p.you_may_approve ? features : featuresOthers).push(p);
        }
        proposals.push(...await openBossProposals(api, name));
      }
      const n = gates.length + features.length + proposals.length;
      const lines = [n ? `${n} ${n === 1 ? "thing waits" : "things wait"} on you (${me.account.name}).` : `Nothing waits on you (${me.account.name}).`];
      let i = 0;
      for (const g of gates) {
        lines.push(`${++i}. ${g.product} ${g.version} (${g.build}) at ${g.stage_name}: ${g.summary}.`);
        lines.push(...gateWords(g.gate));
        lines.push(`   Actions: ${g.actions.map((a) => `${a.label} [${a.id}]`).join("; ")}`);
      }
      for (const p of features) lines.push(`${++i}. Feature to approve or leave for later: ${featureLine(p)}`);
      for (const p of proposals) lines.push(`${++i}. The boss of ${p.product} proposes: ${p.words ?? p.action}${p.when ? ` (${p.when})` : ""} [${p.id}]`);
      if (others.length || featuresOthers.length) {
        lines.push("Waiting on someone else:");
        for (const o of others) lines.push(`- ${o.product} ${o.version} (${o.build}) at ${o.stage_name}. ${o.who_may ?? ""}`.trim());
        for (const p of featuresOthers) lines.push(`- ${featureLine(p)}. Who may approve: ${p.approvers?.join(", ") || "an approver"}.`);
      }
      return result(lines.join("\n"), {
        me: me.account,
        gates: gates.map((g) => ({ product: g.product, version: g.version, build: g.build, stage: g.stage, summary: g.summary, gate: g.gate, actions: g.actions })),
        features: features.map(featureOut),
        proposals: proposals.map((p) => ({ id: p.id, product: p.product, build: p.build, action: p.action, needs: p.needs, words: p.words, ...(p.when ? { when: p.when } : {}) })),
        waiting_on_others: [...others.map((o) => ({ product: o.product, build: o.build, stage: o.stage, who_may: o.who_may })), ...featuresOthers.map(featureOut)],
      });
    },

    async build_status(args) {
      const r = await resolveBuild(api, args);
      if (!r) {
        const { products } = await api.get("/products");
        if (!products.length) return result("There are no builds yet. Start one with start_build.", { products: [] });
        const lines = [`${products.length} ${products.length === 1 ? "product" : "products"}:`, ...products.map((p) => `- ${p.name} ${p.latest.version} (${p.latest.build}): ${p.latest.at?.summary ?? p.latest.state}`)];
        return result(lines.join("\n"), { products: products.map((p) => ({ name: p.name, build: p.latest.build, version: p.latest.version, state: p.latest.state, at: p.latest.at, versions: p.versions })) });
      }
      return statusAnswer(await watch(r.id, args.wait_seconds ?? 0));
    },

    async stage(args) {
      const r = await resolveBuild(api, args);
      if (!r) throw new ToolProblem("Name a build, or a product for its newest build.");
      const stageId = args.stage || r.item?.at?.stage;
      const ws = await api.get(`/builds/${enc(r.id)}/stages/${enc(stageId)}`);
      const b = await readBuild(r.id);
      const byId = new Map((b.artifacts ?? []).map((a) => [a.id, a]));
      const brief = (a) => ({ id: a.id, name: a.name, state: a.state, ...(a.version ? { version: a.version } : {}), ...(a.summary ? { summary: a.summary } : {}), ...(a.files?.length ? { files: a.files.map((f) => f.path) } : {}) });
      const given = ws.given.map((id) => byId.get(id)).filter(Boolean);
      const sv = b.stages.find((s) => s.stage === stageId);
      const lines = [`${ws.name} on ${b.name} ${b.version} (${b.id}): ${ws.state}${ws.holder ? `, held by ${ws.holder.name}` : ""}.`];
      if (sv?.given && typeof sv.given === "string") lines.push(`Asked: ${clip(sv.given, 400)}`);
      lines.push(given.length ? `Given: ${given.map((a) => `${a.name ?? a.id}${a.version ? ` ${a.version}` : ""}${a.summary ? ` (${summaryWords(a.summary)})` : ""}`).join("; ")}.` : "Given: nothing from an earlier stage.");
      if (ws.outputs.length) {
        lines.push("Outputs:");
        for (const a of ws.outputs) lines.push(`- ${a.name ?? a.id}${a.version ? ` ${a.version}` : ""}, ${a.state}${a.summary ? `: ${summaryWords(a.summary)}` : ""}${a.files?.length ? ` Files: ${a.files.map((f) => f.path).join(", ")}` : ""}`);
      } else lines.push("Outputs: none.");
      if (sv?.handed_back?.words?.length) lines.push(`It said: ${sv.handed_back.words.map((x) => clip(x, 300)).join(" ")}`);
      lines.push(`Done when: ${ws.done_when}`);
      if (ws.gate) lines.push(`Gate: ${ws.gate.state}${ws.gate.state === "open" ? `, actions ${ws.gate.actions.map((n) => `[${actionId(b.id, n)}]`).join(" ")}` : ws.gate.answered ? `, answered by ${ws.gate.answered.by} with ${ws.gate.answered.action}` : ""}. ${ws.gate.who_may}`);
      return result(lines.join("\n"), {
        build: b.id, product: b.name, version: b.version, stage: ws.stage, name: ws.name, state: ws.state, holder: ws.holder,
        given: given.map(brief), outputs: ws.outputs.map(brief), said: sv?.handed_back?.words ?? [], done_when: ws.done_when,
        ...(ws.gate ? { gate: ws.gate } : {}), ...(sv?.where ? { where: sv.where } : {}),
      });
    },

    async ask(args) {
      const text = String(args.text ?? "").trim();
      if (!text) throw new ToolProblem("Say something: text is the engineer's words.");
      const boss = args.stage === "boss";
      const path = boss ? `/products/${enc(args.product)}/boss/messages` : `/products/${enc(args.product)}/stages/${enc(args.stage)}/messages`;
      const got = await api.post(path, boss ? { text } : { text, ...(args.build ? { build: args.build } : {}) }, { timeoutMs: CHAT_MS });
      const reply = got.reply;
      const lines = [`${reply.from?.name ?? "The agent"}: ${reply.text}`];
      const data = { product: args.product, stage: args.stage, message: got.message.id, reply: { id: reply.id, build: reply.build, version: reply.version, from: reply.from, text: reply.text } };
      if (reply.proposes) {
        const p = reply.proposes;
        if (boss) {
          const id = p.id;
          data.proposes = { id, build: p.build, action: p.action, needs: p.needs, words: p.words, ...(p.when ? { when: p.when } : {}) };
          lines.push(`It proposes: ${p.words ?? p.action}${p.when ? ` (${p.when})` : ""} [${id}]`);
        } else {
          const id = actionId(reply.build, p.action);
          data.proposes = { id, action: p.action, needs: p.needs };
          lines.push(`It proposes the build's action ${p.action} [${id}] with: ${Object.entries(p.needs ?? {}).map(([k, v]) => `${k} = "${clip(v, 300)}"`).join("; ") || "nothing more"}`);
        }
      }
      if (reply.routed) { data.routed = reply.routed; lines.push(`Routed to ${stageName(reply.routed.stage)} on ${reply.routed.version ?? reply.routed.build}.`); }
      if (reply.plan?.length) { data.plan = reply.plan; lines.push(`Plan: ${reply.plan.map((s, i) => `${i + 1}. ${stageName(s.stage)}: ${clip(s.words, 200)}${s.gate ? ` (gate: ${s.gate})` : ""}`).join(" ")}`); }
      if (reply.started) { data.started = reply.started; lines.push(`Started ${reply.started.version} as build ${reply.started.build}.`); }
      if (reply.features?.length) {
        data.features = reply.features.map((f) => featureOut({ ...f, product: args.product }));
        for (const f of reply.features) lines.push(`Feature proposed: ${featureLine({ ...f, product: args.product })}${f.you_may_approve ? "" : `. Only ${f.approvers?.join(", ") || "an approver"} may approve it.`}`);
      }
      if (reply.proposes || reply.features?.length) lines.push("Nothing is taken until the engineer says so; then use act with the id.");
      return result(lines.join("\n"), data);
    },

    async act(args) {
      const id = String(args.id ?? "").trim();
      if (!String(args.engineer_said ?? "").trim()) throw new ToolProblem("act takes an action only when the engineer asked for it: put their words in engineer_said.");
      if (/^fp_/.test(id)) return actOnFeature(id, args);
      if (/^bp_/.test(id)) return actOnBossProposal(id, args);
      const m = /^(b_[a-z0-9]+)\/([a-z_]+)$/.exec(id);
      if (!m) throw new ToolProblem(`${id} is not an action id. Ids look like b_1a2b3c4d5e6f/approve, bp_... (a boss proposal) or fp_... (a feature proposal); waiting_on_me and build_status list them.`);
      return takeAction(m[1], m[2], args.needs ?? {}, "");
    },
  };

  /** Takes action name on build id, only when the build offers it to the caller now. */
  async function takeAction(buildId, name, given, via) {
    const b = await readBuild(buildId).catch((e) => { if (e.status === 404) throw new ToolProblem(`There is no build ${buildId}.`); throw e; });
    const offered = b.actions.find((a) => a.name === name);
    let needsList = offered?.needs ?? [];
    let label = offered?.label ?? name;
    let path = `/builds/${enc(buildId)}/actions/${enc(name)}`;
    let card = null;
    if (!offered && WHEN_NEEDED.has(name)) {
      const p = await api.get(`/products/${enc(b.name)}`);
      const item = (p.when_needed ?? []).find((x) => x.stage === name);
      if (!item?.can_run) throw new ToolProblem(`${stageName(name)} cannot run on ${b.name} now${item?.why_not ? `: ${item.why_not}` : "."} Nothing was taken.`, { data: { taken: false } });
      if (item.action.build !== buildId) throw new ToolProblem(`${stageName(name)} runs on build ${item.action.build} of ${b.name}, not ${buildId}. Its id is ${actionId(item.action.build, item.action.name)}. Nothing was taken.`, { data: { taken: false } });
      if (item.confirm && !item.confirm.you_may) throw new ToolProblem(`You may not take ${stageName(name)}: ${item.confirm.who_may} Nothing was taken.`, { data: { taken: false } });
      needsList = item.action.needs ?? [];
      label = item.action.label;
      path = `/builds/${enc(item.action.build)}/actions/${enc(item.action.name)}`;
      card = item.confirm ?? null;
    } else if (!offered) {
      const list = b.actions.map((a) => actionLine(b.id, a));
      throw new ToolProblem(`${b.name} ${b.version} (${b.id}) does not offer ${name} to you now, so nothing was taken. ${list.length ? `It offers: ${list.join("; ")}.` : "It offers you no action now."}`, { data: { taken: false, offered: b.actions.map((a) => actionOut(b.id, a)) } });
    }
    const body = {};
    for (const n of needsList) {
      const v = given[n.name] ?? n.default;
      if (v !== undefined && String(v).trim()) body[n.name] = String(v);
      else if (!n.optional) throw new ToolProblem(`${label} needs ${n.name} (${n.label}). Ask the engineer for it, then call act again with needs. Nothing was taken.`, { data: { taken: false, needs: needsList } });
    }
    const got = await api.post(path, body);
    const after = got.build ?? (await readBuild(buildId));
    const res = got.result ? ` It answered: ${clip(typeof got.result === "string" ? got.result : got.result.words ?? got.result.said ?? JSON.stringify(got.result), 400)}` : "";
    const words = `Took ${label}${via} on ${b.name} ${b.version} (${b.id}). Now: ${after.summary}.${res}`;
    return result(words, { taken: true, id: actionId(buildId, name), action: name, label, build: b.id, needs: body, now: after.summary, ...(card ? { confirm: card } : {}), ...(got.result ? { result: got.result } : {}) });
  }

  async function findInProducts(fn) {
    const { products } = await api.get("/products?archived=1");
    for (const p of products) { const hit = await fn(p.name); if (hit) return hit; }
    return null;
  }

  async function actOnFeature(id, args) {
    if (!["approve", "not_now"].includes(args.decision)) throw new ToolProblem("A feature proposal is answered with decision approve or not_now. Nothing was taken.");
    const p = await findInProducts(async (name) => (await pendingFeatures(api, name)).find((x) => x.proposal === id));
    if (!p) throw new ToolProblem(`No feature proposal ${id} waits for an answer. It may be answered already, or replaced by a newer one; waiting_on_me lists those that wait. Nothing was taken.`, { data: { taken: false } });
    if (args.decision === "approve" && !p.you_may_approve) throw new ToolProblem(`You may not approve ${p.feature}: only ${p.approvers?.join(", ") || "an approver"} may. Nothing was taken.`, { data: { taken: false } });
    if (args.decision === "not_now" && p.state === "not_now") throw new ToolProblem(`${p.feature} is already left for later. Nothing was taken.`, { data: { taken: false } });
    const got = await api.post(`/builds/${enc(p.build)}/features/${enc(p.feature)}/${args.decision}`, { proposal: id });
    const words = args.decision === "approve"
      ? `Approved feature ${p.feature} "${p.name}" of ${p.product}.${got.statement ? ` The statement of the job is now ${got.statement}.` : ""}`
      : `Left feature ${p.feature} "${p.name}" of ${p.product} for later. It stays proposed, as a backlog item.`;
    return result(words, { taken: true, id, decision: args.decision, product: p.product, feature: got.feature, ...(got.statement ? { statement: got.statement } : {}) });
  }

  async function actOnBossProposal(id, args) {
    const p = await findInProducts(async (name) => (await openBossProposals(api, name)).find((x) => x.id === id));
    if (!p) throw new ToolProblem(`No open boss proposal ${id}. It may be taken, declined or closed already. Nothing was taken.`, { data: { taken: false } });
    if (p.action === "start_version") {
      const got = await api.post(`/products/${enc(p.product)}/boss/messages`, { text: "Yes.", confirms: id }, { timeoutMs: CHAT_MS });
      const r = got.reply;
      const lines = [`Confirmed: ${p.words ?? `start ${p.needs?.version}`}.`, `${r.from?.name ?? "The boss"}: ${r.text}`];
      if (r.proposes) lines.push(`It proposes next: ${r.proposes.words ?? r.proposes.action}${r.proposes.when ? ` (${r.proposes.when})` : ""} [${r.proposes.id}]`);
      return result(lines.join("\n"), { taken: true, id, action: "start_version", product: p.product, ...(r.started ? { started: r.started } : {}), ...(r.proposes ? { proposes: r.proposes } : {}) });
    }
    return takeAction(p.build, p.action, { ...(p.needs ?? {}), ...(args.needs ?? {}) }, `, as the boss proposed`);
  }

  return handlers;
}

/** Runs a tool by name: an MCP tool result, with a problem said in words as an error result. */
export async function runTool(handlers, name, args = {}) {
  const h = handlers[name];
  if (!h) return { content: [{ type: "text", text: `There is no tool ${name}.` }], isError: true };
  try {
    return await h(args ?? {});
  } catch (e) {
    const words = e instanceof ToolProblem ? e.message : `Something went wrong: ${e?.message ?? e}`;
    return { content: [{ type: "text", text: words }, { type: "text", text: JSON.stringify({ error: words, ...(e?.data && typeof e.data === "object" && !e.data.error ? e.data : {}), ...(e?.status ? { status: e.status } : {}) }) }], isError: true };
  }
}
