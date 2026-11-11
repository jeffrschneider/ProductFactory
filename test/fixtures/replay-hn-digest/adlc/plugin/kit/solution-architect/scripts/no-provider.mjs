// No provider in anything handed back.
//
// AgentMesh never says which AI provider or model stands behind the House
// Stack: the model is AgentMesh's choice and changes, and naming it ties the
// product to a vendor. The platform's own vocabulary (GET /v1/stack/
// vocabulary) still names one as the House Stack's product on each model
// system, so a record that copied it would hand the name back to whoever
// asked. Here a House Stack product on a model system is written as the
// platform's, with the House Stack's own label, and everything that leaves
// this agent is read for a provider or model word before it goes.
//
// One exception, and it is the organization's: a product it bound itself on
// its own stack is its own choice, written back as it chose it.
//
//   needs: node >= 22. Pure: nothing here reads a file or the network.

/** The model systems, each reached with access trigger. */
export const MODEL_SYSTEMS = ["text-reasoning", "image-reading", "speech-to-text", "text-to-speech"];

/** What a House Stack product on a model system is written as. */
export const HOUSE_PRODUCT = "platform";

/** Provider and model-family words. A product an organization bound is let
 *  through by name (`allowed`); nothing else here is. */
export const PROVIDER_WORDS = ["gemini", "gemma", "anthropic", "claude", "openai", "chatgpt", "gpt", "vertex", "bedrock", "elevenlabs",
  "mistral", "llama", "deepseek", "qwen", "grok", "cohere"];

const trim = (s) => String(s ?? "").trim();
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The House Stack's products on the model systems, as the vocabulary names
 *  them: the words a record must never carry. */
export function houseModelProducts(vocabulary = []) {
  const out = new Set();
  for (const s of vocabulary ?? []) {
    const p = trim(s?.house?.product);
    if (MODEL_SYSTEMS.includes(s?.name) && p && p !== "none" && p !== HOUSE_PRODUCT) out.add(p.toLowerCase());
  }
  return [...out];
}

/** The pattern of every word this file keeps out, longest first so a product
 *  is matched whole before a word inside it. */
function patternOf({ vocabulary = [], allowed = [] } = {}) {
  const keep = new Set((allowed ?? []).map((a) => trim(a).toLowerCase()).filter(Boolean));
  const words = [...new Set([...houseModelProducts(vocabulary), ...PROVIDER_WORDS])].filter((w) => !keep.has(w)).sort((a, b) => b.length - a.length);
  return words.length ? new RegExp(String.raw`(?<![\w-])(?:${words.map(escape).join("|")})(?![\w])(?:-[\w.:-]+)?`, "gi") : null;
}

/** Every provider or model word in a text, as found. */
export function providersIn(text, opts = {}) {
  const re = patternOf(opts);
  return re ? [...String(text ?? "").matchAll(re)].map((m) => m[0]) : [];
}

/** The text with each provider or model word taken out, in words that read. */
export function withoutProviders(text, opts = {}) {
  const re = patternOf(opts);
  return re ? String(text ?? "").replace(re, opts.instead ?? "a model provider") : String(text ?? "");
}

/** The products an organization bound itself, from bound systems
 *  ({bindings: {env: {product, provided_by}}}) or a record header's bindings
 *  ({system: {env: {product, provided_by}}}): the only provider words that
 *  may be written back. */
export function customerProducts(bindings) {
  const out = new Set();
  const rows = Array.isArray(bindings) ? bindings.map((s) => s?.bindings ?? {}) : Object.values(bindings ?? {});
  for (const perEnv of rows) {
    for (const b of Object.values(perEnv ?? {})) if (b?.provided_by === "customer" && trim(b.product)) out.add(trim(b.product).toLowerCase());
  }
  return [...out];
}
