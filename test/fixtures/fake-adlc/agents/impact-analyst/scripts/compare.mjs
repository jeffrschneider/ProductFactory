// Compare the declaration before the change with the declaration after it, and
// say what each difference is to somebody who depends on the agent.
//
// The rules are the role's (https://agentroles.ai/impact-analyst.html, rule
// 4), and they are the same every time:
//   compatible  only adds something optional, offers something new, widens a
//               limit on what it takes or spends, or lowers a price;
//   breaking    changes what a dependent sends or gets back: an offering or an
//               output removed or renamed, a new required input, a narrower
//               limit, a higher price, a changed refusal or way of handling
//               data;
//   behaviour   the declaration does not say what differs, but the agent may
//               act differently (a new version, a new model, a new way of
//               doing the work). Only running the new version settles it.
// A difference these rules do not name is breaking, with the reason that it
// could not be told.
//
// An output whose kind changed is not answered here, because the answer
// depends on what reads it. It is returned as effect "kind", with both kinds,
// and answer.mjs answers it for each reader.
//
// Offerings are matched by id, inputs and outputs by name, as a canvas saves
// a line (`<offering>.<in|out>.<name>`): a renamed one is one removed and one
// added, because every saved line to the old name stops at nothing.
//
//   needs: node >= 22
//   import { compareDeclarations, compareRuntimes } from "./compare.mjs"
import { bareKind, refines, satisfies } from "./kinds.mjs";

const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const trim = (s) => String(s ?? "").trim();
const list = (x) => (Array.isArray(x) ? x : []);
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** A value with its object keys in order, so two documents that differ only
 *  in the order of their keys read as the same. */
export function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (isObject(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  return v;
}

/** Members of an input or output that only say how it is shown or asked for.
 *  A change to one of them changes nothing a dependent sends or gets. */
const WORDS_ONLY = new Set(["about", "description", "what", "label", "example", "given_by", "widget", "parts", "link"]);
/** Members compared by a rule of their own. */
const RULED = new Set(["name", "kind", "media_type", "required", "max_bytes", "when", "one_of", "working"]);

const kindOf = (p) => bareKind(p?.media_type ?? p?.kind);
const requiredOf = (p) => p?.required === true;
const maxOf = (p) => (typeof p?.max_bytes === "number" && p.max_bytes > 0 ? p.max_bytes : null);

/** How much a `how.cost` lets a job spend, least first (ports.ts SPEND_ORDER). */
const SPEND = ["none", "metered", "unbounded"];

function byKey(items, key) {
  const m = new Map();
  for (const it of list(items)) {
    if (!isObject(it)) continue;
    const k = trim(it[key] ?? (key === "id" ? it.name : ""));
    if (k && !m.has(k)) m.set(k, it);
  }
  return m;
}

function d(scope, change, effect, words, extra = {}) {
  return { scope, change, effect, words, offering: null, port: null, ...extra };
}

/** The other inputs of the group an input now belongs to, as canvas port
 *  ids, so a dependent that already sends one of them is not counted short. */
function groupOf(doc, off, group, name) {
  if (!group) return null;
  const o = list(doc?.offerings).find((x) => trim(x?.id ?? x?.name) === off);
  return new Set(list(o?.inputs).filter((p) => trim(p?.one_of) === group && trim(p?.name) !== name).map((p) => `${off}.in.${trim(p.name)}`));
}

/** The differences between two inputs of one offering. */
function inputDiffs(off, name, a, b, after) {
  const out = [];
  const at = { offering: off, port: name };
  const ka = kindOf(a);
  const kb = kindOf(b);
  if (ka !== kb) {
    if (ka && kb && satisfies(ka, kb)) out.push(d("input", "input-kind-wider", "compatible", `The input ${name} of ${off} now takes ${kb}, which takes everything ${ka} did.`, { ...at, before: ka, after: kb }));
    else out.push(d("input", "input-kind-changed", "breaking", `The input ${name} of ${off} took ${ka ?? "a kind it never stated"} and now takes ${kb ?? "a kind it does not state"}, so what a dependent sends it may no longer be taken.`, { ...at, before: ka, after: kb }));
  }
  if (requiredOf(a) !== requiredOf(b)) {
    out.push(requiredOf(b)
      ? d("input", "input-now-required", "breaking", `The input ${name} of ${off} was optional and is now required, so a dependent that does not send it is refused.`, at)
      : d("input", "input-now-optional", "compatible", `The input ${name} of ${off} was required and is now optional.`, at));
  }
  const ma = maxOf(a);
  const mb = maxOf(b);
  if (ma !== mb) {
    if (mb !== null && (ma === null || mb < ma)) out.push(d("input", "input-limit-narrower", "breaking", `The input ${name} of ${off} now takes at most ${mb} bytes${ma ? ` (it took ${ma})` : ""}, so a larger one is refused.`, at));
    else out.push(d("input", "input-limit-wider", "compatible", `The input ${name} of ${off} takes more than it did (${ma ?? "no limit"} bytes before, ${mb ?? "no limit"} after).`, at));
  }
  if (trim(a.when) !== trim(b.when)) out.push(d("input", "input-when-changed", "breaking", `The input ${name} of ${off} was ${trim(a.when) || "per task"} and is now ${trim(b.when) || "per task"}.`, at));
  if (trim(a.one_of) !== trim(b.one_of)) out.push(d("input", "input-group-changed", "breaking", `The input ${name} of ${off} moved from the group ${trim(a.one_of) || "(none)"} to ${trim(b.one_of) || "(none)"}, which changes what a job must be sent.`, { ...at, group: groupOf(after, off, trim(b.one_of), name) }));
  const other = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !RULED.has(k) && !WORDS_ONLY.has(k) && !same(a[k], b[k]));
  if (other.length) out.push(d("input", "input-other", "breaking", `The input ${name} of ${off} changed its ${other.sort().join(", ")}, which these rules do not name, so it could not be told whether a dependent would notice; it is answered breaking.`, at));
  return out;
}

/** The differences between two outputs of one offering. */
function outputDiffs(off, name, a, b) {
  const out = [];
  const at = { offering: off, port: name };
  const ka = kindOf(a);
  const kb = kindOf(b);
  if (ka !== kb) out.push(d("output", "output-kind-changed", "kind", `The output ${name} of ${off} was ${ka ?? "a kind it never stated"} and is now ${kb ?? "a kind it does not state"}.`, { ...at, before: ka, after: kb, refines: !!(ka && kb && refines(kb, ka)) }));
  if (trim(a.when) !== trim(b.when)) out.push(d("output", "output-when-changed", "breaking", `The output ${name} of ${off} was ${trim(a.when) || "per task"} and is now ${trim(b.when) || "per task"}.`, at));
  const ma = maxOf(a);
  const mb = maxOf(b);
  if (ma !== mb) {
    if (ma !== null && (mb === null || mb > ma)) out.push(d("output", "output-limit-wider", "breaking", `The output ${name} of ${off} may now be larger (${ma} bytes before, ${mb ?? "no limit"} after), so a reader that takes less refuses one; whether a reader's limit is that small could not be told.`, at));
    else out.push(d("output", "output-limit-narrower", "compatible", `The output ${name} of ${off} is now at most ${mb} bytes${ma ? ` (it was ${ma})` : ""}.`, at));
  }
  if ((a.working === true) !== (b.working === true)) out.push(d("output", "output-working-changed", "breaking", `The output ${name} of ${off} ${b.working === true ? "is now marked the agent's working, not the deliverable" : "is now the deliverable, not the agent's working"}, which changes what a reader gets back.`, at));
  const other = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !RULED.has(k) && !WORDS_ONLY.has(k) && !same(a[k], b[k]));
  if (other.length) out.push(d("output", "output-other", "breaking", `The output ${name} of ${off} changed its ${other.sort().join(", ")}, which these rules do not name, so it could not be told whether a reader would notice; it is answered breaking.`, at));
  return out;
}

function howDiffs(off, a, b, where) {
  const out = [];
  if ((a != null && !isObject(a)) || (b != null && !isObject(b))) {
    if (!same(a ?? null, b ?? null)) out.push(d("offering", "how-unreadable", "breaking", `${where} states how it is done in a form these rules do not read, and it changed, so it could not be told whether a dependent would notice.`, { offering: off }));
    return out;
  }
  const ha = isObject(a) ? a : {};
  const hb = isObject(b) ? b : {};
  if (same(ha, hb)) return out;
  const at = { offering: off };
  const ca = SPEND.indexOf(trim(ha.cost));
  const cb = SPEND.indexOf(trim(hb.cost));
  if (trim(ha.cost) !== trim(hb.cost)) {
    if (ca >= 0 && cb >= 0 && cb < ca) out.push(d("offering", "spend-lower", "compatible", `${where} may now spend less (${ha.cost} before, ${hb.cost} after).`, at));
    else out.push(d("offering", "spend-higher", "breaking", `${where} may now spend more, or in a way not stated (${trim(ha.cost) || "unstated"} before, ${trim(hb.cost) || "unstated"} after).`, at));
  }
  for (const k of ["control", "intelligence", "contract"]) {
    if (trim(ha[k]) !== trim(hb[k])) out.push(d("offering", `how-${k}`, "behaviour", `${where} is done differently: its ${k} was ${trim(ha[k]) || "unstated"} and is now ${trim(hb[k]) || "unstated"}.`, at));
  }
  return out;
}

/** Lines of a refusals text, or of a list of them, each trimmed. */
function refusalLines(r) {
  if (Array.isArray(r)) return r.map((x) => trim(typeof x === "string" ? x : JSON.stringify(canonical(x)))).filter(Boolean);
  return String(r ?? "").split(/\r?\n/).map(trim).filter(Boolean);
}
const short = (s, n = 140) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Every difference between the two declarations, in a fixed order. */
export function compareDeclarations(before, after) {
  const out = [];
  const a = isObject(before) ? before : {};
  const b = isObject(after) ? after : {};
  if (trim(a.format) !== trim(b.format)) out.push(d("agent", "format-changed", "breaking", `The declaration's format was ${trim(a.format) || "unstated"} and is now ${trim(b.format) || "unstated"}.`));

  const oa = byKey(a.offerings, "id");
  const ob = byKey(b.offerings, "id");
  for (const [id, o] of oa) {
    if (!ob.has(id)) { out.push(d("offering", "offering-removed", "breaking", `The offering ${id} (${trim(o.name) || id}) is gone, so a dependent that orders it is refused.`, { offering: id })); continue; }
    const n = ob.get(id);
    if (trim(o.name) !== trim(n.name)) out.push(d("offering", "offering-name", "words", `The offering ${id} is now called "${trim(n.name)}" (it was "${trim(o.name)}"); its id, which a line names, is the same.`, { offering: id }));
    if (trim(o.does) !== trim(n.does)) out.push(d("offering", "offering-does", "words", `The words saying what ${id} does changed.`, { offering: id }));
    const ia = byKey(o.inputs, "name");
    const ib = byKey(n.inputs, "name");
    for (const [name, p] of ia) {
      if (!ib.has(name)) out.push(d("input", "input-removed", "breaking", `The input ${name} of ${id} is gone, so a dependent that sends it sends something no longer taken.`, { offering: id, port: name }));
      else out.push(...inputDiffs(id, name, p, ib.get(name), b));
    }
    for (const [name, p] of ib) {
      if (ia.has(name)) continue;
      out.push(requiredOf(p)
        ? d("input", "input-added-required", "breaking", `The offering ${id} has a new required input, ${name} (${kindOf(p) ?? "kind not stated"}), which no dependent sends yet.`, { offering: id, port: name })
        : d("input", "input-added-optional", "compatible", `The offering ${id} has a new optional input, ${name} (${kindOf(p) ?? "kind not stated"}).`, { offering: id, port: name }));
    }
    const pa = byKey(o.outputs, "name");
    const pb = byKey(n.outputs, "name");
    for (const [name, p] of pa) {
      if (!pb.has(name)) out.push(d("output", "output-removed", "breaking", `The output ${name} of ${id} (${kindOf(p) ?? "kind not stated"}) is gone, so a dependent that reads it gets nothing.`, { offering: id, port: name, before: kindOf(p) }));
      else out.push(...outputDiffs(id, name, p, pb.get(name)));
    }
    for (const [name, p] of pb) {
      if (!pa.has(name)) out.push(d("output", "output-added", "compatible", `The offering ${id} hands back something new, ${name} (${kindOf(p) ?? "kind not stated"}).`, { offering: id, port: name, after: kindOf(p) }));
    }
    out.push(...howDiffs(id, o.how, n.how, `The offering ${id}`));
    const sa = list(o.steps).map((s) => [trim(s?.id), trim(s?.name), trim(s?.does), canonical(s?.how ?? null)]);
    const sb = list(n.steps).map((s) => [trim(s?.id), trim(s?.name), trim(s?.does), canonical(s?.how ?? null)]);
    if (!same(sa, sb)) out.push(d("offering", "steps-changed", "behaviour", `The steps ${id} is delivered in changed, so it may do the work differently.`, { offering: id }));
  }
  for (const [id, o] of ob) {
    if (!oa.has(id)) out.push(d("offering", "offering-added", "compatible", `There is a new offering, ${id} (${trim(o.name) || id}).`, { offering: id }));
  }

  const ra = refusalLines(a.refusals);
  const rb = refusalLines(b.refusals);
  for (const r of ra) if (!rb.includes(r)) out.push(d("agent", "refusal-removed", "breaking", `A refusal was taken out or reworded: "${short(r)}".`));
  for (const r of rb) if (!ra.includes(r)) out.push(d("agent", "refusal-added", "breaking", `A refusal was added or reworded: "${short(r)}".`));

  const sysKey = (s) => trim(s?.name ?? s?.role);
  const sa = byKey(list(a.systems).map((s) => ({ ...s, _k: sysKey(s) })), "_k");
  const sb = byKey(list(b.systems).map((s) => ({ ...s, _k: sysKey(s) })), "_k");
  for (const [k, s] of sa) {
    if (!sb.has(k)) out.push(d("agent", "system-removed", "breaking", `It no longer reaches the system ${k}, which changes how it handles data.`));
    else {
      const n = sb.get(k);
      if (trim(s.access) !== trim(n.access)) out.push(d("agent", "system-access", "breaking", `Its access to ${k} was ${trim(s.access) || "unstated"} and is now ${trim(n.access) || "unstated"}.`));
      if ((s.leaves === true) !== (n.leaves === true)) out.push(d("agent", "system-leaves", "breaking", `What it sends to ${k} ${n.leaves === true ? "now leaves" : "no longer leaves"} the platform.`));
    }
  }
  for (const [k, s] of sb) if (!sa.has(k)) out.push(d("agent", "system-added", "breaking", `It now reaches the system ${k} (${trim(s.access) || "access not stated"}), which changes how it handles data.`));

  const recKey = (r) => JSON.stringify(canonical({ name: trim(r?.name), when: trim(r?.when), file: trim(r?.file) }));
  const reca = new Set(list(a.records).map(recKey));
  const recb = new Set(list(b.records).map(recKey));
  if (reca.size !== recb.size || [...reca].some((r) => !recb.has(r))) out.push(d("agent", "records-changed", "breaking", "What it keeps about each job changed, which is a change to how it handles data."));
  if (!same(list(a.escalates).map(trim), list(b.escalates).map(trim))) out.push(d("agent", "escalates-changed", "behaviour", "When it hands a decision to a person changed, so a job may stop, or not stop, where it did before."));
  if (trim(a.does) !== trim(b.does)) out.push(d("agent", "does-changed", "words", "The words saying what the agent does changed."));
  const known = new Set(["format", "agent_version", "does", "offerings", "refusals", "systems", "records", "escalates"]);
  const other = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !known.has(k) && !same(a[k], b[k]));
  if (other.length) out.push(d("agent", "other-changed", "breaking", `The declaration's ${other.sort().join(", ")} changed, which these rules do not name, so it could not be told whether a dependent would notice; it is answered breaking.`));
  return out;
}

/** The price as one comparable thing: {model, amount, unit}. */
function priceOf(rt) {
  const p = rt?.price;
  if (!isObject(p)) return null;
  const inner = isObject(p.price) ? p.price : p;
  return { model: trim(inner.model), amount: typeof inner.amount_micro === "number" ? inner.amount_micro : null, unit: trim(inner.unit ?? inner.per), currency: trim(inner.currency), covers: canonical(p.covers ?? null) };
}

export function priceWords(rt) {
  const p = priceOf(rt);
  if (!p) return "not stated";
  if (p.model === "free") return "free";
  if (p.amount !== null) return `${p.model} ${(p.amount / 1e6).toFixed(2)} ${p.currency || "USD"}${p.unit ? ` per ${p.unit}` : ""}`;
  return p.model || "stated in a form these rules do not read";
}

/** The differences between the two runtime requirements: the price, the job
 *  limit, the ceilings, and what is installed or set. */
export function compareRuntimes(before, after) {
  const out = [];
  if (!isObject(before) || !isObject(after)) return out;
  const pa = priceOf(before);
  const pb = priceOf(after);
  if (!same(pa, pb)) {
    const wa = priceWords(before);
    const wb = priceWords(after);
    const lower = pa && pb && pa.model === pb.model && pa.unit === pb.unit && pa.currency === pb.currency && same(pa.covers, pb.covers)
      && pa.amount !== null && pb.amount !== null && pb.amount < pa.amount;
    const freeNow = pb && pb.model === "free" && same(pa?.covers ?? null, pb.covers);
    if (lower || freeNow) out.push(d("runtime", "price-lower", "compatible", `The price is lower: ${wa} before, ${wb} after.`));
    else out.push(d("runtime", "price-changed", "breaking", `The price changed from ${wa} to ${wb}${pa && pb && !same(pa.covers, pb.covers) ? ", and what it covers changed" : ""}; a dependent pays what it did not agree to.`));
  }
  const ja = typeof before.job_seconds === "number" ? before.job_seconds : null;
  const jb = typeof after.job_seconds === "number" ? after.job_seconds : null;
  if (ja !== jb) {
    if (jb !== null && (ja === null || jb < ja)) out.push(d("runtime", "job-limit-narrower", "breaking", `A job may now run for at most ${jb} seconds${ja ? ` (it was ${ja})` : ""}, so a longer one is stopped.`));
    else out.push(d("runtime", "job-limit-wider", "compatible", `A job may run longer (${ja ?? "no limit"} seconds before, ${jb ?? "no limit"} after).`));
  }
  // Ceilings by system and period; a second one of the same pair is told
  // apart by its place among them.
  const ceilings = (rt) => {
    const m = new Map();
    const n = new Map();
    for (const c of list(rt.ceilings)) {
      const base = `${trim(c?.system)}|${trim(c?.per)}`;
      n.set(base, (n.get(base) ?? 0) + 1);
      m.set(n.get(base) === 1 ? base : `${base}|${n.get(base)}`, c);
    }
    return m;
  };
  const cab = ceilings(before);
  const cbb = ceilings(after);
  for (const [k, c] of cbb) {
    const o = cab.get(k);
    const [sys, per] = k.split("|");
    if (!o) out.push(d("runtime", "ceiling-added", "breaking", `There is a new ceiling on ${sys} per ${per || "job"}, so work it did before may now be stopped.`));
    else if (same(o, c)) continue;
    else {
      // Every number in it is a limit: higher everywhere it changed is wider,
      // lower anywhere is narrower, and anything else could not be told.
      const keys = [...new Set([...Object.keys(o), ...Object.keys(c)])];
      const numeric = keys.filter((k) => typeof o[k] === "number" && typeof c[k] === "number");
      const words = keys.filter((k) => !numeric.includes(k));
      const wordsSame = words.every((k) => same(o[k] ?? null, c[k] ?? null));
      const lower = numeric.some((k) => c[k] < o[k]);
      const higher = numeric.some((k) => c[k] > o[k]);
      if (wordsSame && lower) out.push(d("runtime", "ceiling-lower", "breaking", `The ceiling on ${sys} per ${per || "job"} is lower (${numeric.filter((k) => c[k] < o[k]).map((k) => `${k} ${o[k]} before, ${c[k]} after`).join("; ")}).`));
      else if (wordsSame && higher) out.push(d("runtime", "ceiling-wider", "compatible", `The ceiling on ${sys} per ${per || "job"} is higher (${numeric.filter((k) => c[k] > o[k]).map((k) => `${k} ${o[k]} before, ${c[k]} after`).join("; ")}).`));
      else out.push(d("runtime", "ceiling-changed", "breaking", `The ceiling on ${sys} per ${per || "job"} changed in a way these rules do not read as higher, so it could not be told whether work it did before is now stopped.`));
    }
  }
  for (const [k] of cab) if (!cbb.has(k)) out.push(d("runtime", "ceiling-removed", "compatible", `The ceiling on ${k.split("|")[0]} was taken off.`));
  const settings = (rt) => list(rt.systems).flatMap((s) => list(s?.settings).map((x) => `${trim(s?.name ?? s?.role)}:${trim(x?.env)}:${trim(x?.purpose)}`)).sort();
  const sa = settings(before);
  const sb = settings(after);
  if (!same(sa, sb)) {
    const model = [...sa, ...sb].filter((x) => !sa.includes(x) || !sb.includes(x)).some((x) => /MODEL/i.test(x.split(":")[1] ?? ""));
    out.push(d("runtime", model ? "model-setting-changed" : "settings-changed", "behaviour", model ? "The setting that chooses the model changed, so the agent may answer differently under the same declaration." : "What the agent is set up with changed, so it may act differently under the same declaration."));
  }
  for (const k of ["runtimes", "binaries", "dependencies", "run", "wants_replies"]) {
    if (!same(before[k] ?? null, after[k] ?? null)) out.push(d("runtime", `${k}-changed`, "behaviour", `What it is installed or started with (${k}) changed, so it may act differently under the same declaration.`));
  }
  // Each bound system whole, but for its settings, which have their own rule above.
  const bound = (rt) => list(rt.systems).map((s) => { const { settings, ...rest } = isObject(s) ? s : { value: s }; return JSON.stringify(canonical(rest)); }).sort();
  if (!same(bound(before), bound(after))) out.push(d("runtime", "bound-systems-changed", "breaking", "The systems it is bound to when installed changed, which is a change to how it handles data."));
  if (!same(before.directories ?? null, after.directories ?? null)) out.push(d("runtime", "directories-changed", "breaking", "Where it keeps what it keeps changed, which is a change to how it handles data."));
  const known = new Set(["format", "runtimes", "binaries", "dependencies", "systems", "ceilings", "directories", "job_seconds", "price", "run", "wants_replies"]);
  const other = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !known.has(k) && !same(before[k] ?? null, after[k] ?? null));
  if (other.length) out.push(d("runtime", "runtime-other-changed", "breaking", `The runtime requirements' ${other.sort().join(", ")} changed, which these rules do not name, so it could not be told whether a dependent would notice; it is answered breaking.`));
  if (trim(before.format) !== trim(after.format)) out.push(d("runtime", "runtime-format-changed", "breaking", `The runtime requirements' format was ${trim(before.format) || "unstated"} and is now ${trim(after.format) || "unstated"}.`));
  return out;
}

/** The differences that say the agent may act differently although nothing a
 *  dependent sends or gets back changed: a new version under the same
 *  contract, or a change the person named in words. */
export function unseenChange({ before, after, said = "", contractChanged }) {
  if (contractChanged) return [];
  const va = trim(before?.agent_version);
  const vb = trim(after?.agent_version);
  if (va !== vb) return [d("agent", "version-only", "behaviour", `The version moves from ${va || "unstated"} to ${vb || "unstated"} and nothing a dependent sends or gets back changes in the declaration, so only running the new version can show whether it acts the same${said ? ` (the change, as given: ${said})` : ""}.`)];
  if (said) return [d("agent", "said-only", "behaviour", `The declaration is the same, and the change was given as: ${said}. Only running the new version can show whether it acts the same.`)];
  return [];
}

/** Whether any difference touches what a dependent sends or gets back, or how
 *  the agent is set up (anything that is not words). */
export const contractChanged = (diffs) => diffs.some((x) => x.effect !== "words");
