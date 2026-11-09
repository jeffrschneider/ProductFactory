#!/usr/bin/env node
// The Product Factory plugin's MCP server: `node <plugin>/mcp/server.mjs`,
// over stdio, one JSON-RPC message per line. Node 22, no dependencies. The
// tools are in tools.mjs; this file only speaks the protocol.

import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { TOOLS, createClient, createHandlers, runTool, locate } from "./tools.mjs";

const VERSION = JSON.parse(readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8")).version;
const PROTOCOL = "2025-06-18";

const INSTRUCTIONS = [
  "Product Factory runs builds of agents on the agentic development lifecycle; these tools drive a running Product Factory.",
  "Read freely: waiting_on_me, build_status and stage change nothing.",
  "Before act, show the engineer the gate's words and ask; take an action only on their yes, and put their words in engineer_said.",
  "act takes only what the build offers now, and says what it did.",
].join(" ");

const handlers = createHandlers(createClient());

const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id, result) => write({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => write({ jsonrpc: "2.0", id, error: { code, message } });

const where = locate();
process.stderr.write(`product-factory mcp ${VERSION}: ${TOOLS.length} tools over stdio; ${where.problem ? where.problem : `the service at ${where.url}`}\n`);

const rl = createInterface({ input: process.stdin, terminal: false });
for await (const line of rl) {
  if (!line.trim()) continue;
  let msg;
  try { msg = JSON.parse(line); } catch { fail(null, -32700, "That line is not JSON."); continue; }
  const { id, method, params } = msg;
  if (method === "initialize") {
    reply(id, { protocolVersion: params?.protocolVersion ?? PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "product-factory", version: VERSION }, instructions: INSTRUCTIONS });
  } else if (method === "ping") {
    reply(id, {});
  } else if (method === "tools/list") {
    reply(id, { tools: TOOLS });
  } else if (method === "tools/call") {
    const name = params?.name;
    if (!TOOLS.some((t) => t.name === name)) { fail(id, -32602, `There is no tool ${name}.`); continue; }
    // Not awaited here: a slow answer (a stage agent thinking) never holds up another call.
    runTool(handlers, name, params?.arguments ?? {}).then((r) => reply(id, r));
  } else if (typeof method === "string" && method.startsWith("notifications/")) {
    // a notification has no id and wants no answer
  } else if (id !== undefined) {
    fail(id, -32601, `${method} is not a method this server answers.`);
  }
}
