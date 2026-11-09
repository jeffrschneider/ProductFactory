// The model caller: the one way a package reaches its model, from the four
// settings the install places and nothing written here.
//
// Common Agent 0.39.0, Section 12.4.1: an agent's scripts reach its model
// system through four settings with the same names in every agent, read from
// the environment on every call and from nowhere else, never kept from one
// call to the next, with no value of this file's own for any of them:
//
//   MODEL_NAME      which model, as the endpoint names it; sent as written
//   MODEL_ENDPOINT  the base address the request is sent to
//   MODEL_KEY       the credential; may be empty where the endpoint needs none,
//                   as a model gateway on the agent's own host does, and then
//                   no credential is sent
//   MODEL_PROTOCOL  the request format, one of PROTOCOLS
//
// For this version only, TEXT_MODEL is read where MODEL_NAME is not set, and
// TEXT_API_KEY where MODEL_KEY is not set at all (an empty MODEL_KEY is a
// placed credential that is empty, and TEXT_API_KEY is then not read). There
// is no older name for the endpoint or the protocol. Where MODEL_NAME,
// MODEL_ENDPOINT or MODEL_PROTOCOL is empty, or MODEL_PROTOCOL is outside the
// list (or outside the package's own declared protocols, when the job passes
// them), nothing is sent and the refusal names the setting. No credential is
// taken from anything around the agent: not a metadata server, not a
// credential file, not a provider's own variable. A provider that signs in
// with a short-lived token is reached through a gateway the host supplies, at
// MODEL_ENDPOINT.
//
// The request, as 12.4.1's table says (one trailing slash is taken off
// MODEL_ENDPOINT before the path is added):
//   anthropic-messages  POST MODEL_ENDPOINT/v1/messages, the model in the body,
//                       an anthropic-version header, the key in x-api-key
//   openai-chat         POST MODEL_ENDPOINT/chat/completions, the model in the
//                       body, the key as a bearer authorization
//   gemini              POST MODEL_ENDPOINT/models/MODEL_NAME:generateContent,
//                       or :streamGenerateContent?alt=sse for an answer that
//                       streams, the key in x-goog-api-key
// The key is never in the address or the body.
//
// What a job gets: callModel(prompt, options) sends one prompt and answers
// {text, model, protocol, answered_by, tokens_in, tokens_out}. The prompt is a
// string, or a list of parts for a prompt that carries pictures: {type: "text",
// text} and {type: "image", media_type, data}, the picture's bytes in base64
// and its media type one of IMAGE_TYPES. The parts go in order as one user
// turn, in each protocol's own form: content blocks, image_url parts holding a
// data address, inline data parts. A string is sent exactly as before. A part
// that is neither, or a picture with no bytes or another media type, is refused
// before anything is sent. Options:
// maxOutputTokens (the answer's budget; when the job names none, the install's
// MODEL_MAX_OUTPUT_TOKENS, and OUTPUT_TOKENS when that is not set either), json
// (ask for one JSON value), system (a system prompt), effort (anthropic-messages
// only: low, medium, high, or off for no thinking), stream (the answer comes as
// events, so a long answer is never lost to a wait for headers), timeoutMs
// (the whole call's limit, timeoutFor(maxOutputTokens) when not given),
// signal, protocols (the formats the package's model system declares; a
// MODEL_PROTOCOL outside them is refused), env, fetchImpl, and exchange, which wraps the send so a job can keep or
// replay the whole exchange (it is called with {env, service, model, url, body,
// call}, and call() answers {status, text}). callerFor(env) is the same as an
// object with ask(prompt, options); replayCaller(paths) answers from files and
// sends nothing; readJson and askJson read a JSON answer.
//
// Nothing is silently cut. An answer stopped at its output limit, a prompt the
// model refused, and an answer that stopped early for any other reason are
// each a failure that says so (the error carries modelFailure: true), never
// read as if whole. A service that answers with an error status is a failure
// carrying that status, with what the service said, the key and any bearer
// token taken out.
//
// This file is kept once, here, and copied byte for byte into each package
// that calls a model, as scripts/model-caller.mjs, because a package carries
// its own scripts. model-caller.test.mjs holds every copy to this one.
//
//   needs: node >= 22; MODEL_NAME, MODEL_ENDPOINT, MODEL_PROTOCOL, and MODEL_KEY
//   where the endpoint asks for one; MODEL_MAX_OUTPUT_TOKENS where the install
//   sets the answer budget
//   MODEL_NAME=<model> MODEL_ENDPOINT=<url> MODEL_PROTOCOL=<protocol> MODEL_KEY=<key> PROMPT_FILE=<text> node model-caller.mjs
import { readFileSync } from "node:fs";

const trim = (s) => String(s ?? "").trim();

/** The request formats this caller speaks. The list is closed: any other
 *  MODEL_PROTOCOL is refused in words. */
export const PROTOCOLS = ["anthropic-messages", "openai-chat", "gemini"];

/** The answer budget when neither the job nor the install names one. 64000
 *  fits every model the three formats reach today (Claude's ceiling is
 *  128000, Gemini Flash's about 65000); an install changes it with
 *  MODEL_MAX_OUTPUT_TOKENS, read on every run. */
export const OUTPUT_TOKENS = 64000;

/** The answer budget the install sets (MODEL_MAX_OUTPUT_TOKENS), or
 *  OUTPUT_TOKENS when it sets none. A value that is not a whole number above
 *  zero is refused by cannotCall before anything is sent. */
export function outputBudget(env = process.env) {
  const set = trim(env?.MODEL_MAX_OUTPUT_TOKENS);
  const n = Number(set);
  return set && Number.isInteger(n) && n > 0 ? n : OUTPUT_TOKENS;
}
/** The Messages API version sent with every anthropic-messages call. */
export const ANTHROPIC_VERSION = "2023-06-01";
/** What a JSON answer is asked for in words, beside each protocol's own switch
 *  where it has one. */
export const JSON_SYSTEM = "Answer with JSON only: one JSON value, with no words before or after it and no code fence.";
/** The effort levels an anthropic-messages call may ask for, and "off" for no thinking. */
export const EFFORTS = ["off", "low", "medium", "high"];
/** The media types a picture in a prompt may have: the ones all three formats take. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** A prompt given as a list of parts, checked and in order: [{type: "text",
 *  text}, {type: "image", media_type, data}]. A string answers null, because
 *  it is sent as it is. A part this caller cannot send is refused in words. */
export function partsOf(prompt) {
  if (!Array.isArray(prompt)) return null;
  if (!prompt.length) throw new Error("the prompt is an empty list of parts");
  return prompt.map((p, i) => {
    const at = `prompt part ${i + 1}`;
    if (p?.type === "text") {
      if (typeof p.text !== "string") throw new Error(`${at} is a text part with no text`);
      return { type: "text", text: p.text };
    }
    if (p?.type === "image") {
      const media = trim(p.media_type).toLowerCase();
      if (!IMAGE_TYPES.includes(media)) throw new Error(`${at} is a picture of media type ${trim(p.media_type) || "none"}, and a picture is one of ${IMAGE_TYPES.join(", ")}`);
      const data = String(p.data ?? "").replace(/\s+/g, "");
      if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error(`${at} is a picture whose bytes are not base64`);
      return { type: "image", media_type: media, data };
    }
    throw new Error(`${at} is neither a text part nor a picture: its type is ${JSON.stringify(p?.type ?? null)}`);
  });
}

const has = (env, name) => Object.prototype.hasOwnProperty.call(env ?? {}, name) && env[name] !== undefined && env[name] !== null;

/** The four settings as this call reads them, the answer budget, and which
 *  variable gave the name and the key: {name, endpoint, key, protocol,
 *  maxOutputTokens, from: {name, key}}. */
export function modelSettings(env = process.env) {
  const fromName = trim(env?.MODEL_NAME) ? "MODEL_NAME" : trim(env?.TEXT_MODEL) ? "TEXT_MODEL" : null;
  const name = trim(env?.MODEL_NAME) || trim(env?.TEXT_MODEL);
  const fromKey = has(env, "MODEL_KEY") ? "MODEL_KEY" : has(env, "TEXT_API_KEY") ? "TEXT_API_KEY" : null;
  const key = fromKey ? trim(env[fromKey]) : "";
  return { name, endpoint: trim(env?.MODEL_ENDPOINT), key, protocol: trim(env?.MODEL_PROTOCOL), maxOutputTokens: outputBudget(env), from: { name: fromName, key: fromKey } };
}

/** Why no call can be made with these settings, or "" when one can. */
export function cannotCall(env = process.env, { protocols } = {}) {
  const s = modelSettings(env);
  if (!s.name) return "MODEL_NAME is not set, so no model is called: the install chooses the model, and this package names none of its own";
  if (!s.endpoint) return "MODEL_ENDPOINT is not set, so there is nowhere to call the model: the install places the address of the model service, or of the host's model gateway, as MODEL_ENDPOINT";
  let u;
  try { u = new URL(s.endpoint); } catch { u = null; }
  if (!u || (u.protocol !== "http:" && u.protocol !== "https:")) return `MODEL_ENDPOINT is not an http or https address: ${s.endpoint}`;
  if (u.username || u.password) return "MODEL_ENDPOINT carries a credential in the address: the credential is MODEL_KEY, and the address holds none";
  if (!s.protocol) return `MODEL_PROTOCOL is not set, so this caller does not know how to speak to the model: it is one of ${PROTOCOLS.join(", ")}`;
  if (!PROTOCOLS.includes(s.protocol)) return `MODEL_PROTOCOL ${s.protocol} is not one this caller speaks: it is one of ${PROTOCOLS.join(", ")}`;
  if (Array.isArray(protocols) && protocols.length && !protocols.includes(s.protocol)) return `MODEL_PROTOCOL ${s.protocol} is not one this package's model system declares: it speaks ${protocols.join(", ")}`;
  const budget = trim(env?.MODEL_MAX_OUTPUT_TOKENS);
  if (budget && !(Number.isInteger(Number(budget)) && Number(budget) > 0)) return `MODEL_MAX_OUTPUT_TOKENS is ${budget}, and the answer budget is a whole number of tokens above zero`;
  return "";
}

/** How long a call may take, whole, in milliseconds: a minute to start, then
 *  the output it allows at 50 tokens a second, never more than 30 minutes
 *  (the job's own time limit still ends it first where that is shorter). */
export function timeoutFor(maxTokens = OUTPUT_TOKENS) {
  return Math.min(30 * 60_000, 60_000 + Math.ceil((Number(maxTokens) || 0) / 50) * 1000);
}

/** The address a protocol is called at: the endpoint with one trailing slash
 *  taken off, and the protocol's path added (12.4.1). */
export function urlFor(settings, { stream = false } = {}) {
  const base = settings.endpoint.replace(/\/$/, "");
  if (settings.protocol === "anthropic-messages") return `${base}/v1/messages`;
  if (settings.protocol === "openai-chat") return `${base}/chat/completions`;
  return `${base}/models/${encodeURI(settings.name)}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
}

/** The HTTP call for one prompt, as plain values: {url, headers, body}, the
 *  body an object. Nothing is sent here. */
export function requestFor(prompt, settings, { maxOutputTokens, json = false, system = "", effort, stream = false } = {}) {
  const parts = partsOf(prompt);
  const text = parts ? "" : String(prompt ?? "");
  const limit = Math.max(1, Math.ceil(Number(maxOutputTokens) || Number(settings?.maxOutputTokens) || OUTPUT_TOKENS));
  const sys = [trim(system), json ? JSON_SYSTEM : ""].filter(Boolean).join("\n\n");
  const headers = { "content-type": "application/json", ...(stream ? { accept: "text/event-stream" } : {}) };
  if (settings.protocol === "anthropic-messages") {
    if (effort !== undefined && !EFFORTS.includes(effort)) throw new Error(`effort ${effort} is not one of ${EFFORTS.join(", ")}`);
    headers["anthropic-version"] = ANTHROPIC_VERSION;
    if (settings.key) headers["x-api-key"] = settings.key;
    const content = parts
      ? parts.map((p) => (p.type === "text" ? { type: "text", text: p.text } : { type: "image", source: { type: "base64", media_type: p.media_type, data: p.data } }))
      : text;
    const body = { model: settings.name, max_tokens: limit, messages: [{ role: "user", content }] };
    if (sys) body.system = sys;
    if (effort === "off") body.thinking = { type: "disabled" };
    else if (effort) body.output_config = { effort };
    if (stream) body.stream = true;
    return { url: urlFor(settings), headers, body };
  }
  if (settings.protocol === "openai-chat") {
    if (settings.key) headers.authorization = `Bearer ${settings.key}`;
    const content = parts
      ? parts.map((p) => (p.type === "text" ? { type: "text", text: p.text } : { type: "image_url", image_url: { url: `data:${p.media_type};base64,${p.data}` } }))
      : text;
    const body = { model: settings.name, max_tokens: limit, messages: [...(sys ? [{ role: "system", content: sys }] : []), { role: "user", content }] };
    if (json) body.response_format = { type: "json_object" };
    if (stream) Object.assign(body, { stream: true, stream_options: { include_usage: true } });
    return { url: urlFor(settings), headers, body };
  }
  if (settings.key) headers["x-goog-api-key"] = settings.key;
  const geminiParts = parts
    ? parts.map((p) => (p.type === "text" ? { text: p.text } : { inlineData: { mimeType: p.media_type, data: p.data } }))
    : [{ text }];
  const body = { contents: [{ role: "user", parts: geminiParts }], generationConfig: { maxOutputTokens: limit } };
  if (sys) body.systemInstruction = { parts: [{ text: sys }] };
  if (json) body.generationConfig.responseMimeType = "application/json";
  // A streamed call asks for thought summaries too, only so bytes flow while
  // the model thinks: without them the service sends nothing, headers
  // included, until its thinking is done. Thought parts are never the answer.
  if (stream) body.generationConfig.thinkingConfig = { includeThoughts: true };
  return { url: urlFor(settings, { stream }), headers, body };
}

const STREAM_ERROR_STATUS = { overloaded_error: 529, rate_limit_error: 429, api_error: 500, timeout_error: 504, invalid_request_error: 400, authentication_error: 401, permission_error: 403, not_found_error: 404 };

/** A streamed answer, added up into the one answer the same call unstreamed
 *  would have given: {message}, or {status, error} when the stream said it
 *  failed or ended before its answer was finished. */
export function readStream(protocol, raw) {
  const text = String(raw ?? "").replace(/\r\n/g, "\n");
  if (protocol === "anthropic-messages") {
    const message = { type: "message", model: null, content: [], stop_reason: null, stop_details: null, usage: {} };
    const blocks = new Map();
    let stopped = false;
    for (const chunk of text.split("\n\n")) {
      const data = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (!data) continue;
      let e;
      try { e = JSON.parse(data); } catch { continue; }
      if (e.type === "message_start") {
        message.model = e.message?.model ?? null;
        Object.assign(message.usage, e.message?.usage ?? {});
      } else if (e.type === "content_block_start") {
        blocks.set(e.index, { type: e.content_block?.type, text: typeof e.content_block?.text === "string" ? e.content_block.text : "" });
      } else if (e.type === "content_block_delta" && e.delta?.type === "text_delta") {
        const b = blocks.get(e.index) ?? { type: "text", text: "" };
        b.text += String(e.delta.text ?? "");
        blocks.set(e.index, b);
      } else if (e.type === "message_delta") {
        if (e.delta?.stop_reason !== undefined) message.stop_reason = e.delta.stop_reason;
        if (e.delta?.stop_details !== undefined) message.stop_details = e.delta.stop_details;
        Object.assign(message.usage, e.usage ?? {});
      } else if (e.type === "message_stop") {
        stopped = true;
      } else if (e.type === "error") {
        const type = String(e.error?.type ?? "api_error");
        return { status: STREAM_ERROR_STATUS[type] ?? 500, error: `${type}: ${String(e.error?.message ?? "the model stopped with an error")}` };
      }
    }
    if (!stopped) return { status: 502, error: "the answer's stream ended before the message was finished" };
    message.content = [...blocks.entries()].sort((a, b) => a[0] - b[0]).filter(([, b]) => b.type === "text").map(([, b]) => ({ type: "text", text: b.text }));
    return { message };
  }
  if (protocol === "openai-chat") {
    let content = "", finish = null, usage = null, model = null, seen = 0;
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let c;
      try { c = JSON.parse(data); } catch { continue; }
      seen++;
      if (c?.error) return { status: Number(c.error.code) || 500, error: String(c.error.message ?? "the model stopped with an error") };
      if (c?.model) model = c.model;
      const choice = c?.choices?.[0];
      if (typeof choice?.delta?.content === "string") content += choice.delta.content;
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (c?.usage) usage = c.usage;
    }
    if (!seen || !finish) return { status: 502, error: "the answer's stream ended before the answer was finished" };
    return { message: { model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finish }], ...(usage ? { usage } : {}) } };
  }
  let out = "", finishReason = null, usageMetadata = null, promptFeedback = null, modelVersion = null, seen = 0;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let c;
    try { c = JSON.parse(line.slice(5).trim()); } catch { continue; }
    seen++;
    if (c?.error) return { status: Number(c.error.code) || 500, error: `${c.error.status ?? "error"}: ${String(c.error.message ?? "the model stopped with an error")}` };
    const cand = c?.candidates?.[0];
    for (const p of Array.isArray(cand?.content?.parts) ? cand.content.parts : []) if (p && p.thought !== true && typeof p.text === "string") out += p.text;
    if (cand?.finishReason) finishReason = cand.finishReason;
    if (c?.usageMetadata) usageMetadata = c.usageMetadata;
    if (c?.promptFeedback) promptFeedback = c.promptFeedback;
    if (c?.modelVersion) modelVersion = c.modelVersion;
  }
  if (promptFeedback?.blockReason && !finishReason) return { message: { promptFeedback, ...(usageMetadata ? { usageMetadata } : {}) } };
  if (!seen || !finishReason) return { status: 502, error: "the answer's stream ended before the answer was finished" };
  return { message: { candidates: [{ content: { role: "model", parts: [{ text: out }] }, finishReason }], ...(usageMetadata ? { usageMetadata } : {}), ...(modelVersion ? { modelVersion } : {}) } };
}

/** A failure of the model itself: the answer was cut, refused or stopped early. */
function failure(message, said, extra = {}) {
  return Object.assign(new Error(message), { modelFailure: true, said, ...extra });
}

const count = (n) => (n === null || n === undefined || n === "" || !Number.isFinite(Number(n)) ? null : Number(n));

/** The text of an answer, which model gave it and what it used:
 *  {text, answered_by, tokens_in, tokens_out}. An answer cut at its limit,
 *  refused, or stopped early throws, saying so. `limit` is only for the words. */
export function answerOf(protocol, data, { limit } = {}) {
  const at = limit ? ` of ${limit} tokens` : "";
  if (protocol === "anthropic-messages") {
    if (data?.type === "error" || data?.error) throw new Error(`the model service refused: ${trim(data?.error?.message) || "no reason given"}`);
    const text = (Array.isArray(data?.content) ? data.content : []).filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text).join("");
    const reason = trim(data?.stop_reason);
    if (reason === "max_tokens") throw failure(`the model's answer was cut at its limit${at}, so it was not read`, text.slice(0, 300), { cutAtLimit: true, limit });
    if (reason === "refusal") throw failure(`the model refused the prompt${data?.stop_details?.category ? ` (${data.stop_details.category})` : ""}`, "");
    if (reason && reason !== "end_turn" && reason !== "stop_sequence") throw failure(`the model stopped its answer early (stop reason ${reason}), so it was not read`, text.slice(0, 300), { finishReason: reason });
    return { text, answered_by: trim(data?.model) || null, tokens_in: count(data?.usage?.input_tokens), tokens_out: count(data?.usage?.output_tokens) };
  }
  if (protocol === "openai-chat") {
    if (data?.error) throw new Error(`the model service refused: ${trim(data.error.message) || "no reason given"}`);
    const choice = data?.choices?.[0];
    const content = choice?.message?.content;
    const text = typeof content === "string" ? content
      : Array.isArray(content) ? content.filter((p) => typeof p?.text === "string").map((p) => p.text).join("") : "";
    const reason = trim(choice?.finish_reason);
    if (reason === "length") throw failure(`the model's answer was cut at its limit${at}, so it was not read`, text.slice(0, 300), { cutAtLimit: true, limit });
    if (reason === "content_filter") throw failure("the model refused the prompt (content_filter)", "");
    if (!choice) throw failure("the model service answered with no choice to read", "");
    if (reason && reason !== "stop") throw failure(`the model stopped its answer early (finish reason ${reason}), so it was not read`, text.slice(0, 300), { finishReason: reason });
    return { text, answered_by: trim(data?.model) || null, tokens_in: count(data?.usage?.prompt_tokens), tokens_out: count(data?.usage?.completion_tokens) };
  }
  if (data?.error) throw new Error(`the model service refused: ${trim(data.error.message) || "no reason given"}`);
  const candidate = data?.candidates?.[0];
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  const text = parts.filter((p) => p && p.thought !== true && typeof p.text === "string").map((p) => p.text).join("");
  const reason = trim(candidate?.finishReason);
  if (!candidate && data?.promptFeedback?.blockReason) throw failure(`the model refused the prompt (${data.promptFeedback.blockReason})`, "");
  if (reason === "MAX_TOKENS") throw failure(`the model's answer was cut at its limit${at}, so it was not read`, text.slice(0, 300), { cutAtLimit: true, limit });
  if (reason && reason !== "STOP" && reason !== "FINISH_REASON_UNSPECIFIED") throw failure(`the model stopped its answer early (finish reason ${reason}), so it was not read`, text.slice(0, 300), { finishReason: reason });
  return { text, answered_by: trim(data?.modelVersion) || null, tokens_in: count(data?.usageMetadata?.promptTokenCount), tokens_out: count(data?.usageMetadata?.candidatesTokenCount) };
}

/** What a service said, with the key and any bearer token taken out. */
function cleaned(said, key) {
  let s = String(said ?? "").replace(/Bearer\s+\S+/gi, "Bearer [left out]");
  if (key && key.length >= 4) s = s.split(key).join("[left out]");
  return s;
}

/** One call. Returns {text, model, protocol, answered_by, tokens_in, tokens_out}. */
export async function callModel(prompt, options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const why = cannotCall(env, options);
  if (why) throw new Error(why);
  const settings = modelSettings(env);
  const stream = options.stream === true;
  const limit = Math.max(1, Math.ceil(Number(options.maxOutputTokens) || outputBudget(env)));
  const req = requestFor(prompt, settings, { ...options, maxOutputTokens: limit, stream });
  const timeout = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : timeoutFor(limit);
  const where = new URL(req.url).host;
  const send = async () => {
    const signals = [AbortSignal.timeout(timeout), ...(options.signal ? [options.signal] : [])];
    let response;
    try {
      response = await fetchImpl(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body), signal: AbortSignal.any(signals) });
      const status = Number(response.status ?? (response.ok ? 200 : 500));
      const raw = await response.text();
      if (!response.ok) return { status, text: cleaned(raw, settings.key) };
      if (!stream) return { status, text: raw };
      const read = readStream(settings.protocol, raw);
      return read.message ? { status, text: JSON.stringify(read.message) } : { status: read.status, text: read.error };
    } catch (e) {
      const timedOut = e?.name === "TimeoutError" || (e?.name === "AbortError" && !options.signal?.aborted);
      if (timedOut) throw Object.assign(new Error(`the model service at ${where} gave no whole answer within ${timeout < 10_000 ? (timeout / 1000).toFixed(1) : Math.round(timeout / 1000)} seconds`), { status: 504 });
      if (options.signal?.aborted) throw Object.assign(new Error("the call to the model was stopped by the job"), { status: 499 });
      throw Object.assign(new Error(`the model service at ${where} could not be reached: ${cleaned(e?.cause?.message ?? e?.message ?? e, settings.key)}`), { status: 503 });
    }
  };
  const exchange = typeof options.exchange === "function" ? options.exchange : ({ call }) => call();
  const answered = await exchange({ env, service: settings.protocol, model: settings.name, url: req.url, body: req.body, call: send });
  const status = Number(answered?.status);
  if (!(status >= 200 && status <= 299)) {
    const said = trim(answered?.text);
    throw Object.assign(new Error(`the model service at ${where} answered ${status || "nothing"}${said ? `: ${said.slice(0, 300)}` : ""}`), { status: status || 502 });
  }
  let data;
  try { data = JSON.parse(answered.text); } catch {
    throw Object.assign(new Error(`the model service at ${where} answered with something that is not JSON: ${String(answered.text ?? "").slice(0, 200)}`), { status: 502 });
  }
  return { model: settings.name, protocol: settings.protocol, ...answerOf(settings.protocol, data, { limit }) };
}

/** A caller for one job: ask(prompt, options) is callModel with this env,
 *  fetch and declared protocols. It refuses in words, before anything is
 *  sent, when the settings cannot make a call. The settings are read again on
 *  every ask. */
export function callerFor(env = process.env, fetchImpl = fetch, { protocols } = {}) {
  const why = cannotCall(env, { protocols });
  if (why) throw new Error(why);
  return {
    get model() { return modelSettings(env).name; },
    get protocol() { return modelSettings(env).protocol; },
    ask: (prompt, options = {}) => callModel(prompt, { env, fetchImpl, protocols, ...options }),
  };
}

/** A caller that answers from files instead of a model, in order, for a test
 *  or a replay: the files are named comma separated. Nothing is sent. */
export function replayCaller(paths) {
  const files = String(paths ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  let i = 0;
  return {
    model: "replay",
    protocol: "replay",
    async ask() {
      if (!files.length) throw new Error("the replay names no answer files");
      const p = files[Math.min(i, files.length - 1)];
      i += 1;
      return { text: readFileSync(p, "utf8"), model: "replay", protocol: "replay", answered_by: "replay", tokens_in: null, tokens_out: null };
    },
  };
}

/** The first whole JSON object or array wrapped in prose, or null. A span
 *  that opens is read to its close or not at all, so a cut list is never read
 *  as its first complete item. */
function embeddedJson(str) {
  let i = 0;
  while (i < str.length) {
    const ch = str[i];
    if (ch !== "{" && ch !== "[") { i++; continue; }
    const stack = [ch];
    let inString = false, escape = false, closed = false, j = i + 1;
    for (; j < str.length; j++) {
      const c = str[j];
      if (inString) {
        if (escape) escape = false;
        else if (c === "\\") escape = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === "{" || c === "[") stack.push(c);
      else if (c === "}" || c === "]") {
        if (stack[stack.length - 1] !== (c === "}" ? "{" : "[")) break;
        stack.pop();
        if (!stack.length) { closed = true; break; }
      }
    }
    // An opening never closed runs to the end of the answer: the answer was cut.
    if (!closed && j >= str.length) return null;
    if (closed) {
      try { return JSON.parse(str.slice(i, j + 1)); } catch { /* a bracket in prose: look on past it */ }
    }
    i = j + 1;
  }
  return null;
}

/** JSON read from an answer as it is, inside a code fence, or wrapped in
 *  prose; only a whole answer. Throws a model failure when there is none. */
export function readJson(text) {
  const raw = String(text ?? "");
  const t = raw.trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try { return JSON.parse(t); } catch { /* look inside */ }
  }
  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(raw);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch {
      const inner = embeddedJson(fence[1].trim());
      if (inner !== null) return inner;
    }
  }
  const found = embeddedJson(raw);
  if (found !== null) return found;
  const snippet = raw.slice(0, 300);
  throw failure(`the model returned no whole JSON: ${snippet}`, snippet);
}

/** One call asking for JSON, and the JSON read from the answer. */
export async function askJson(prompt, options = {}) {
  const out = await callModel(prompt, { ...options, json: true });
  return readJson(out.text);
}

const thisFile = process.argv[1] ? process.argv[1].replace(/\\/g, "/").split("/").pop() : "";
if (thisFile && import.meta.url.endsWith(`/${thisFile}`)) {
  if (!process.env.PROMPT_FILE) { console.error("PROMPT_FILE is required"); process.exit(2); }
  try {
    const out = await callModel(readFileSync(process.env.PROMPT_FILE, "utf8"));
    console.log(JSON.stringify({ ok: true, ...out }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e.message, ...(e.status ? { status: e.status } : {}) }));
    process.exitCode = 1;
  }
}
