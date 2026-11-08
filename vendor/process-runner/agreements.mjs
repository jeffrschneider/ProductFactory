// §19.5 coverage: whether the terms of every priced agent in a run's roster
// have already been accepted, checked BEFORE the first work message goes out.
//
// Why this exists. A priced agent's SDK refuses work at admission when the
// sending account holds no agreement at the SKU's CURRENT digest: one
// AGREEMENT_REQUIRED respond, no work done, nothing charged. It refuses every
// message the same way, so a run whose fourth phase is priced and unaccepted
// spends the three phases before it and then stops. Asking first costs one
// public read per holder and one read of this account's own agreements, and it
// happens in the same breath as the roster resolve, which already refuses a run
// whose names answer to nobody. The two refusals are the same kind of thing.
//
// WHOSE ACCOUNT. Not the document owner's. A seller reads the `from` on the
// envelope, and every envelope this Runner sends carries THIS agent's key: in a
// container the work leaves a line in out/outbox.jsonl and the supervisor signs
// it under the Runner's own identity (turn.mjs, leaveForTheHost). So the
// consumer of record is the account this Runner runs under, which is the
// account whose agreements are read here and the account the refusal names.
// Telling the person who instructed a run to go and look at their own list
// would send them to the wrong list.
//
// WHAT CANNOT BE KNOWN FROM OUT HERE. The storefront (§8.7) advertises a SKU's
// id, price and digest, and NOT its `covers`, so which SKU a given offering
// falls under is not readable from outside the seller. Where no SKU published
// its covers, EVERY priced SKU has to be accepted: picking one and guessing is
// the mistake this check exists to prevent. Where an operator has advertised
// covers as well, §19.1's most-specific-wins decides, and the check asks for
// less.
//
// AN UNANSWERED QUESTION IS NOT A REFUSAL. A Runner with no platform
// configured, a token without the `agreements` scope, a platform that is down:
// none of those is evidence that terms are unaccepted, and refusing on them
// would stop every run this Runner has ever taken, including all the free ones.
// Those say so in a note and the run goes ahead. The seller's own gate is the
// enforcement; this is the early warning that saves the phases before it.
//
//   needs: node >= 22
import { holderFor } from "./plan.mjs";
import { offeringOf } from "./parse-process.mjs";

/** How long one read may take. Shorter than a send, because two of these run
 *  before a run starts and a slow platform must not eat the job's cap. */
const TIMEOUT_MS = Number(process.env.COVERAGE_TIMEOUT_MS) || 6000;

/** Money the way a person writes it, in integer micro-units (§19.3). */
export function microToDisplay(amountMicro, currency) {
  const n = Number(amountMicro);
  if (!Number.isFinite(n)) return `${amountMicro} ${currency ?? ""}`.trim();
  const whole = (n - (n % 1_000_000)) / 1_000_000;
  const frac = String(n % 1_000_000).padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return currency === "USD" ? `$${whole}.${frac}` : `${whole}.${frac} ${currency ?? ""}`.trim();
}

/** One price in a sentence. The five closed shapes of §19.1; anything else is
 *  named as what it is rather than priced wrongly. */
export function priceLine(p) {
  if (!p?.model) return "a price it did not state";
  const money = () => microToDisplay(p.amount_micro, p.currency);
  const meter = () => String(p.meter ?? "unit").replace(/_/g, " ");
  switch (p.model) {
    case "free": return "free";
    case "flat": return `${money()} per request`;
    case "per_unit": return `${money()} per ${p.per && p.per !== 1 ? `${p.per} ` : ""}${meter()}`;
    case "package": return `${money()} for every ${p.size} ${meter()} each ${p.period ?? "month"}`;
    case "tiered": return `tiered by ${meter()}, ${p.tiers?.length ?? 0} tiers`;
    default: return `${p.model} pricing`;
  }
}

/** The SKU covering an offering under §19.1's most-specific-wins rule: an
 *  offering named explicitly beats an agent-wide SKU. Null means free. The
 *  SDK's own skuFor, written again here because a container runs plain .mjs
 *  and cannot import the TypeScript SDK. */
export function skuFor(skus, offering) {
  let agentWide = null;
  for (const s of skus ?? []) {
    const covered = s?.covers?.offerings ?? s?.covers?.skills ?? null;
    if (Array.isArray(covered) && covered.includes(offering)) return s;
    if (s?.covers?.agent === true && agentWide === null) agentWide = s;
  }
  return agentWide;
}

/** Which of a seller's advertised SKUs this run would have to have accepted.
 *  Free is the default and is never asked about (§19.1: uncovered is free). */
export function skusWanted(skus, offerings = []) {
  const priced = (skus ?? []).filter((s) => s?.sku && s.price?.model && s.price.model !== "free");
  if (!priced.length) return [];
  // Without `covers` there is no way to say which SKU a phase's offering falls
  // under, so all of them are wanted. See the header.
  if (!offerings.length || !priced.every((s) => s?.covers)) return priced;
  const out = new Map();
  for (const off of offerings) {
    const s = skuFor(priced, off);
    if (s) out.set(s.sku, s);
  }
  return [...out.values()];
}

/** Whether one held agreement answers for one advertised SKU. The three ways
 *  it does not are kept apart, because they are three different sentences to
 *  the owner and three different things to do about it. */
export function heldFor(agreements, sellerAgent, sku, now = Date.now()) {
  const mine = (agreements ?? []).filter((a) => a?.seller_agent === sellerAgent && a?.sku === sku.sku);
  if (!mine.length) return { ok: false, why: "never accepted" };
  const current = mine.find((a) => a.sku_digest === sku.digest);
  if (!current) {
    const when = mine.map((a) => a.agreed_at).filter(Boolean).sort().pop();
    return { ok: false, why: "the terms moved since it was accepted", agreed_at: when ?? null, stale: true };
  }
  if (current.expires_at) {
    const at = Date.parse(current.expires_at);
    // An undatable expiry is expired, the same reading agreementCovers takes.
    if (!Number.isFinite(at) || now >= at) return { ok: false, why: `it expired ${current.expires_at}`, agreed_at: current.agreed_at ?? null, expired: true };
  }
  return { ok: true, agreed_at: current.agreed_at ?? null };
}

/** Every distinct handle the roster binds, with the phases it holds and the
 *  offerings those phases buy. Pure, so the check below is testable without a
 *  platform. */
export function holdersToPrice(doc, roster) {
  const out = new Map();
  for (const p of doc.phases) {
    const h = holderFor(doc, roster, p.id);
    if (!h?.handle) continue;
    const e = out.get(h.handle) ?? { handle: h.handle, phases: [], offerings: [] };
    e.phases.push(p.id);
    const off = offeringOf(p);
    if (off && !e.offerings.includes(off)) e.offerings.push(off);
    out.set(h.handle, e);
  }
  return [...out.values()];
}

/** What one holder's coverage is, from what was read. Pure. */
export function coverageOf({ handle, agent_id = null, phases = [], offerings = [], skus = null, agreements = [], now = Date.now(), why = null }) {
  const base = { handle, agent_id, phases, offerings };
  if (skus === null) return { ...base, state: "unknown", wanted: [], missing: [], why: why ?? "its storefront could not be read" };
  const wanted = skusWanted(skus, offerings);
  if (!wanted.length) return { ...base, state: "free", wanted: [], missing: [] };
  // A priced seller whose key could not be resolved cannot be matched against
  // an agreement, which binds to the key and not to the name.
  if (!agent_id) return { ...base, state: "unknown", wanted, missing: [], why: why ?? "its key could not be resolved, and an agreement names a key" };
  const missing = [];
  for (const s of wanted) {
    const held = heldFor(agreements, agent_id, s, now);
    if (!held.ok) missing.push({ sku: s.sku, digest: s.digest, price: s.price, ...held });
  }
  return { ...base, state: missing.length ? "needs-terms" : "covered", wanted, missing };
}

// ── the reads ───────────────────────────────────────────────────────────────

async function readJson(url, { headers = {}, fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  try {
    const r = await fetchImpl(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) {
      let why = `${r.status}`;
      try { const said = await r.json(); if (said?.error) why = `${r.status}: ${said.error}`; } catch { /* a status with no body is still a status */ }
      return { ok: false, status: r.status, why };
    }
    return { ok: true, body: await r.json() };
  } catch (e) {
    return { ok: false, status: 0, why: e.message };
  }
}

/** One seller's advertised SKUs, from the public storefront door (§8.7). No
 *  token: this is the same document a stranger reads before knocking, which is
 *  the whole point of putting price in it. */
export async function storefrontSkus(base, target, opts = {}) {
  const r = await readJson(`${base}/a/${encodeURIComponent(target)}`, opts);
  // NOTHING THERE IS NOT THE SAME AS COULD NOT ASK. A 404 is the door saying
  // this agent advertises nothing at all, which §19.1 reads as free: paid is
  // the declared exception, and an undeclared price is not one. It is also the
  // answer for a private agent, and a note about that would name something the
  // owner can do nothing about, because terms nobody can read are terms nobody
  // can accept. A timeout or a 500 is a different thing and stays unknown.
  if (!r.ok && r.status === 404) return { ok: true, skus: [] };
  if (!r.ok) return { ok: false, why: `its storefront could not be read (${r.why})` };
  const skus = r.body?.public?.skus;
  return { ok: true, skus: Array.isArray(skus) ? skus : [] };
}

/** What this account has accepted, across every key it controls (§19.5, the
 *  buyer's side). Needs an amt_ token carrying the `agreements` scope; a token
 *  scoped only `process-runs` is refused here and the run goes ahead with a
 *  note, because a token we were not given is not a missing agreement. */
export async function heldAgreements({ base, account, token }, opts = {}) {
  const r = await readJson(`${base}/v1/accounts/${encodeURIComponent(account)}/agreements`, {
    ...opts,
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) {
    return {
      ok: false,
      why: r.status === 401 || r.status === 403
        ? `this Runner's platform token may not read the account's agreements (${r.why}); it needs the agreements scope`
        : `the account's agreements could not be read (${r.why})`,
    };
  }
  const list = r.body?.agreements;
  return { ok: true, agreements: Array.isArray(list) ? list : [] };
}

/**
 * Read both sides and say where each holder stands. `holders` is what
 * holdersToPrice returned, with an agent_id added from the roster resolve the
 * run has already done. `to` is publish.mjs's target(), or null when this
 * Runner has been connected to no platform.
 *
 * Never throws: every failure comes back as a holder in state "unknown" with
 * the reason in words.
 */
export async function checkCoverage({ holders = [], to = null, fetchImpl = fetch, now = Date.now(), timeoutMs = TIMEOUT_MS } = {}) {
  if (!holders.length) return { asked: false, why: null, results: [] };
  // A Runner connected to no platform has no account whose agreements could be
  // read and no storefront door it was told to trust, so there is nothing here
  // to be right or wrong about. It says nothing rather than putting a line
  // about terms on every free run it has ever taken. Publishing takes the same
  // posture on the same configuration.
  if (!to) return { asked: false, why: null, results: [] };
  const opts = { fetchImpl, timeoutMs };
  // The storefronts and the agreement list are independent reads, so they go
  // at once: four holders one after another is four round trips inside a turn
  // that has a job cap over it.
  const [held, ...fronts] = await Promise.all([
    heldAgreements(to, opts),
    ...holders.map((h) => storefrontSkus(to.base, h.agent_id ?? h.handle, opts)),
  ]);
  const results = holders.map((h, i) => {
    const front = fronts[i];
    if (!front.ok) return coverageOf({ ...h, skus: null, why: front.why });
    // A free holder is settled by its own storefront and needs no agreement
    // list, so an unreadable list never makes free work look doubtful.
    if (!skusWanted(front.skus, h.offerings).length) return coverageOf({ ...h, skus: front.skus, agreements: [], now });
    // Priced, and the list could not be read: an empty list is not an answer,
    // so this is unknown and never uncovered.
    if (!held.ok) return coverageOf({ ...h, skus: null, why: held.why });
    return coverageOf({ ...h, skus: front.skus, agreements: held.agreements, now });
  });
  return { asked: true, why: held.ok ? null : held.why, results };
}

// ── the words ───────────────────────────────────────────────────────────────

const list = (xs) => xs.map((x) => `  ${x}`).join("\n");

/** The refusal a roster with unaccepted terms earns, or null when every priced
 *  holder is covered. Separated from the I/O so both halves are testable. */
export function coverageRefusal(results, to = null) {
  const bad = (results ?? []).filter((r) => r.state === "needs-terms" && r.missing.length);
  if (!bad.length) return null;
  const account = to?.account ? ` (${to.account})` : "";
  const site = to?.base ?? "https://app.agentmesh.ai";
  const lines = [
    `I did not start a run: the account I send under${account} has not accepted the terms of ${bad.length === 1 ? "an agent" : `${bad.length} agents`} this process needs.`,
  ];
  for (const r of bad) {
    lines.push(`  ${r.handle} holds ${r.phases.join(", ")}:`);
    for (const m of r.missing) lines.push(`    sku ${m.sku}, ${priceLine(m.price)}; ${m.why}${m.agreed_at ? ` (accepted ${m.agreed_at})` : ""}`);
  }
  lines.push(
    "",
    `${bad.length === 1 ? "It refuses" : "Each of them refuses"} work at its own door while the terms stand unaccepted, so the run would stop at that phase with the phases before it already done.`,
    "Accept them from a machine holding this account's key, one line each:",
    list(bad.map((r) => `agentmesh agree ${r.handle} --sku ${r.missing[0].sku} --yes`)),
    `What the account has already accepted is listed at ${site}/#/buying .`,
    "",
    "Nothing was started and nothing was charged. Send this again once the terms are accepted.",
  );
  return lines.join("\n");
}

/** What the run records about a check that could not be made. One note per
 *  reason, not one per holder: four holders behind one unreadable list is one
 *  thing that happened. */
export function coverageNotes({ asked, results } = {}) {
  const notes = [];
  if (!asked) return notes;
  const unknown = (results ?? []).filter((r) => r.state === "unknown");
  if (unknown.length) {
    const reasons = [...new Set(unknown.map((r) => r.why).filter(Boolean))];
    notes.push(`I could not tell whether the terms of ${unknown.map((r) => r.handle).join(", ")} have been accepted: ${reasons.join("; ")}. The run went ahead; a priced holder refuses its own work when the terms are not accepted.`);
  }
  const covered = (results ?? []).filter((r) => r.state === "covered");
  if (covered.length) notes.push(`the terms of ${covered.map((r) => r.handle).join(", ")} were already accepted by the account I send under`);
  return notes;
}

// ── a refusal that arrives mid-run ──────────────────────────────────────────
//
// A seller may re-price at any time, and a moved price moves the SKU digest,
// which makes every standing agreement for it stale at once (§19.1). So a run
// that passed the check above can still meet AGREEMENT_REQUIRED at phase three.
//
// WHAT THIS RUNNER DOES ABOUT IT, and what it deliberately does not. It does
// NOT accept the new terms: accepting a price on the owner's behalf is a
// decision with money in it and this Runner accepts no price itself. It does
// not re-check the whole roster either, because nothing about the other
// holders changed. It tells the phase apart from an ordinary refusal, which is
// the whole of the fix: an ordinary refusal asks the owner who holds the phase
// INSTEAD, and that is the wrong question here. The holder is right, the work
// is right, and the only thing missing is an acceptance. So the owner is asked
// to accept and say "retry", and the same work goes to the same holder again.
// One message, no loop, and the phases already delivered stay delivered.

/** The §19.5 refusal inside a holder's reply, or null when it is an ordinary
 *  refusal. Matched on the typed code first and on the SDK's own sentence
 *  second, because how an adapter renders an error respond into inbox text is
 *  not this Runner's to pin down. */
export function termsRefusal(text) {
  const t = String(text ?? "");
  const typed = /AGREEMENT_REQUIRED/.test(t);
  const said = /holds no agreement for its current terms|§\s*19\.5/i.test(t) && /agreement/i.test(t);
  if (!typed && !said) return null;
  const sku = /'([a-z0-9-]{1,64})'\s+is a paid offering/i.exec(t)?.[1]
    ?? /\bsku[_\s"':]+([a-z0-9-]{1,64})\b/i.exec(t)?.[1]
    ?? null;
  const digest = /sku_digest["'\s:]+([A-Za-z0-9_-]{16,})/i.exec(t)?.[1] ?? null;
  const url = /\bhttps?:\/\/\S+/.exec(t)?.[0]?.replace(/[).,'"]+$/, "") ?? null;
  return { sku, digest, url };
}
