// Bind each system in each environment: the organization's stack first, the
// House Stack for the rest, and a question wherever neither may stand.
//
// No judgment here, and no model. The role says what a binding is (Agent
// Roles, the solution architect: "the organization's own choice is the
// binding wherever it made one, a platform default fills each binding it left
// open"), walked in the order the deploy's own resolver uses (AgentMesh
// services/src/api/stack.ts, resolveSystem):
//
//   1. the organization's own binding for that environment;
//   2. its production binding, where the environment has none and the
//      organization said production may stand in;
//   3. the House Stack's product, where the House Stack covers the system,
//      marked as a platform default: the role's "a platform default fills
//      each binding it left open" (Agent Roles, the solution architect);
//   4. otherwise a question naming the system and the environment.
//
// One place the role and the deploy disagree, and it is said rather than
// hidden: the deploy's resolver refuses a test or production deploy for a
// system the organization bound in another environment and not that one
// (docs/account-stack.md, section 3, step 7), where the role fills it with a
// default. The record follows the role, and that binding's decision says that
// a deploy there needs the organization's own binding first, so nobody learns
// it at the approval.
//
// A binding names a product and says who provides it. It never carries the
// credential, the address, the settings or the key store the stack holds:
// those are what an install needs, and the owner's instruction supplies them.
// The one exception is a keyless public service the owner approved: it is
// bound to the service itself, and that binding names its address.
//
//   needs: node >= 22
//   NAMED=<named.json> ASKED=<asked.json> RECORDS=<records folder> node bind.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STACK_WORD } from "./architecture-record.mjs";
import { HOUSE_PRODUCT, MODEL_SYSTEMS, withoutProviders } from "./no-provider.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const trim = (s) => String(s ?? "").trim();

/** Where the platform's defaults are, when none were attached: the copy this
 *  package carries, in a built package or in this folder. */
export function houseAt(here = HERE) {
  return [join(here, "..", "references", "house-stack.json"), join(here, "..", "..", "references", "house-stack.json")].find((p) => existsSync(p)) ?? null;
}

/** The organization's binding for one system, from a stack in either of the
 *  shapes it travels in: the stack section ({bindings: [...]}) or the
 *  organization record that holds it ({stack: {bindings: [...]}}). */
export function stackOf(doc) {
  if (!doc || typeof doc !== "object") return null;
  const s = Array.isArray(doc.bindings) ? doc : doc.stack && Array.isArray(doc.stack.bindings) ? doc.stack : null;
  return s ? { bindings: s.bindings.filter((b) => b && trim(b.system)), production_stands_in: s.production_stands_in === true } : null;
}

const labelOf = (vocab, system, product) => {
  const v = vocab.find((s) => s.name === system);
  if (product === "platform" || product === v?.house?.product) {
    const label = trim(v?.house?.label) || product;
    return MODEL_SYSTEMS.includes(system) ? withoutProviders(label) || "AgentMesh's models" : label;
  }
  return product;
};

/** One system in one environment. */
export function bindOne(system, env, { stack = null, vocabulary = [] } = {}) {
  const word = STACK_WORD[env] ?? env;
  const v = vocabulary.find((s) => s.name === system);
  const covered = v?.house && v.house.covered && trim(v.house.product) && v.house.product !== "none" ? v.house : null;
  // The House Stack's product on a model system is written as the
  // platform's, with its own label: AgentMesh never says which provider
  // stands behind it, and the vocabulary it publishes still names one
  // (no-provider.mjs).
  const house = covered && MODEL_SYSTEMS.includes(system)
    ? { ...covered, product: HOUSE_PRODUCT, label: withoutProviders(covered.label) || "AgentMesh's models", why: withoutProviders(covered.why) }
    : covered;
  const org = stack?.bindings?.find((b) => b.system === system) ?? null;
  const fromOrg = (row, how) => {
    const product = org.product === "platform" && house ? house.product : trim(org.product);
    return {
      product, label: labelOf(vocabulary, system, org.product),
      provided_by: org.provided_by === "platform" ? "platform" : "customer",
      from: how, since: trim(org.since) || null,
    };
  };
  // An organization row that names the House Stack's product where the House
  // Stack covers nothing is no binding at all.
  if (org && org.product === "platform" && !house) return { unbound: true, question: `${system} is bound to the House Stack's product in your stack, and the House Stack does not cover ${system}. Which product stands behind it in ${env}?` };
  if (org?.environments?.[word]) return fromOrg(org.environments[word], "the organization's stack");
  if (org && env !== "production" && stack?.production_stands_in && org.environments?.production) {
    return fromOrg(org.environments.production, "the organization's production binding, which the organization lets stand in");
  }
  const elsewhere = org ? Object.keys(org.environments ?? {}).filter((k) => org.environments[k]).map((k) => ({ development: "dev", staging: "test" }[k] ?? k)) : [];
  if (house) {
    return {
      product: house.product, label: trim(house.label) || house.product, provided_by: "platform", from: "the House Stack", why: trim(house.why),
      ...(elsewhere.length ? { org_elsewhere: { product: trim(org.product), environments: elsewhere } } : {}),
    };
  }
  const gap = trim(v?.platform_gap) || trim(v?.house?.gap);
  const gapWords = gap ? `${gap.charAt(0).toLowerCase()}${gap.slice(1)}` : "the House Stack does not cover it.";
  if (elsewhere.length) {
    return {
      unbound: true,
      question: `${system} is bound to ${trim(org.product)} for ${elsewhere.join(" and ")} and to nothing in ${env}, and no platform default can fill it: ${gapWords} Which product stands behind ${system} in ${env}?`,
    };
  }
  return {
    unbound: true,
    question: !v
      ? `${system} is not a system the platform reserves, so nothing stands behind it in ${env}. Which product is it, and is it one your organization runs?`
      : `Nothing stands behind ${system} in ${env}: your organization has chosen no product for it${gap ? `, and ${gap.charAt(0).toLowerCase()}${gap.slice(1)}` : " and the House Stack does not cover it."} Which product should it be?`,
  };
}

/** The products the platform knows for a system, by the words a person
 *  writes them in. */
export function productsFor(system, vocabulary = []) {
  const v = vocabulary.find((s) => s.name === system);
  // The House Stack's product on a model system is the platform's, never a
  // product a person names (no-provider.mjs).
  const house = v?.house?.product && v.house.product !== "none" && !MODEL_SYSTEMS.includes(system) ? [v.house.product] : [];
  return [...new Set([...(v?.products ?? []), ...house]
    .map((p) => String(p).toLowerCase()).filter((p) => p && p !== "platform"))];
}

const list = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** Bind every system in every environment, and write the decision each
 *  system's bindings make, with its reason. A binding a person gave in an
 *  answer (`binding-<system>-<env>: <product>`) stands where the stacks left
 *  a question. */
export function bindAll(arch, { stack = null, vocabulary = [], answers = {}, targets = {} } = {}) {
  const environments = arch.environments?.length ? arch.environments : ["dev", "test", "production"];
  const questions = [];
  const decisions = [];
  const systems = (arch.systems ?? []).map((s) => {
    // A keyless public service the owner approved is bound to the service
    // itself in every environment: its address, no key, its access and the
    // approval. There is no product behind it, and that is a binding (the
    // architecture standard, section 2).
    if (s.public) {
      const b = { public: true, product: "itself", address: trim(s.public.address), key: "none", access: trim(s.access) || "read", ...(trim(s.public.approved) ? { approved: trim(s.public.approved) } : {}) };
      decisions.push({
        kind: "ruling",
        decided: `Bind ${s.name} to the service itself in ${list(environments)}`,
        why: `It is a public service that takes no key and has no product behind it, so nobody chooses one; the owner approved reaching it${b.approved ? ` (${b.approved})` : ""}`,
        weighed: "",
        follows: "The Design declares the service with its address as a setting whose default is the address the binding names; the scripts read the setting and hold no address of their own (Common Agent Section 12.6, rule 2)",
        from_binding: s.name,
      });
      return { ...s, bindings: Object.fromEntries(environments.map((e) => [e, { ...b }])) };
    }
    const bindings = {};
    for (const env of environments) {
      let b = bindOne(s.name, env, { stack, vocabulary });
      const key = `binding-${s.name}-${env}`;
      const given = trim(answers[key]);
      if (b.unbound && given) {
        // The answer binds a product the platform knows for this system,
        // named anywhere in it. Anything else is asked again, with the
        // products it could be: a product word lifted out of a sentence, or a
        // model's name or an address, is not a binding.
        const known = productsFor(s.name, vocabulary);
        const words = given.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);
        const product = known.find((p) => words.includes(p));
        if (product) b = { product, label: product, provided_by: "customer", from: "the person's answer" };
        else b = { ...b, question: `${b.question} Your answer named no product the platform knows for ${s.name}${known.length ? `; it knows ${list(known)}` : ""}.` };
      }
      if (b.unbound) questions.push({ key, question: b.question });
      bindings[env] = b;
    }
    // One decision per system: what stands behind it, and why, in the
    // stack's own words.
    const bound = environments.filter((e) => !bindings[e].unbound);
    if (bound.length) {
      const groups = new Map();
      for (const e of bound) {
        const b = bindings[e];
        const k = `${b.product}|${b.provided_by}|${b.from}`;
        if (!groups.has(k)) groups.set(k, { b, envs: [] });
        groups.get(k).envs.push(e);
      }
      const parts = [...groups.values()];
      const decided = `Bind ${s.name} to ${parts.map(({ b, envs }) => `${b.product}${b.label && b.label !== b.product ? ` (${b.label})` : ""} in ${list(envs)}`).join(", and ")}`;
      const why = parts.map(({ b, envs }) => {
        if (b.from === "the House Stack") {
          return `The organization chose no product for ${s.name}${envs.length < environments.length ? ` in ${list(envs)}` : ""}, so the House Stack's product fills ${envs.length === 1 ? "it" : "each"} as a platform default${b.why ? `: ${b.why.replace(/\.$/, "")}` : ""}`;
        }
        if (b.from === "the person's answer") return `The person named ${b.product} for ${list(envs)} in an answer`;
        return `The organization chose ${b.product} for ${list(envs)} (${b.from}${b.since ? `, bound since ${b.since}` : ""})`;
      }).join(". ");
      const v = vocabulary.find((x) => x.name === s.name);
      const swaps = (v?.house?.swap ?? []).filter(Boolean);
      // A default beside the organization's own product: the AgentMesh deploy
      // refuses that environment today until the organization binds it too.
      const beside = parts.filter(({ b, envs }) => b.org_elsewhere && envs.some((e) => e !== "dev"));
      const deployNote = beside.map(({ b, envs }) => `The organization bound ${b.org_elsewhere.product} for ${list(b.org_elsewhere.environments)}, so the AgentMesh deploy refuses ${list(envs.filter((e) => e !== "dev"))} on the default today until the organization binds ${s.name} there too`).join(". ");
      const follows = ["text-reasoning", "image-reading", "speech-to-text", "text-to-speech"].includes(s.name)
        ? "The install places the model from this binding in the four settings MODEL_NAME, MODEL_ENDPOINT, MODEL_KEY and MODEL_PROTOCOL, and the scripts read them on every call through the shared model caller and name no model, so changing the model is a setting and not a rebuild"
        : "The install places the credential and address this binding names; the package names neither";
      decisions.push({
        kind: "ruling",
        decided,
        why,
        // A model system's other products are not listed by their providers'
        // names beside the House Stack's: the record would say whose it is not.
        weighed: MODEL_SYSTEMS.includes(s.name)
          ? `Another product behind ${s.name}: a model provider of the organization's own, bound on its stack with its own key`
          : swaps.length ? `Another product behind ${s.name}: ${list(swaps)}, which the organization can choose on its stack` : "",
        follows: deployNote ? `${follows}. ${deployNote}` : follows,
        from_binding: s.name,
      });
    }
    return { ...s, bindings };
  });
  const egress_policy = Object.fromEntries(environments.map((e) => [e, trim(targets?.[e]?.egress) || "not known"]));
  return { environments, systems, questions, decisions, egress_policy };
}

const thisFile = process.argv[1] ? process.argv[1].replace(/\\/g, "/").split("/").pop() : "";
if (thisFile && import.meta.url.endsWith(thisFile)) {
  const { NAMED, ASKED, RECORDS } = process.env;
  if (!NAMED || !ASKED || !RECORDS) { console.error("NAMED, ASKED and RECORDS are required"); process.exit(2); }
  try {
    const named = JSON.parse(readFileSync(NAMED, "utf8"));
    const asked = JSON.parse(readFileSync(ASKED, "utf8"));
    if (named.declined) {
      console.log(JSON.stringify({ ok: false, code: 3, reply: named.reply }));
      process.exit(3);
    }
    const defaults = asked.defaults ?? JSON.parse(readFileSync(houseAt(), "utf8"));
    const out = bindAll(named.architecture, {
      stack: stackOf(asked.stack), vocabulary: defaults.systems ?? [], answers: asked.answers ?? {}, targets: defaults.targets ?? {},
    });
    mkdirSync(RECORDS, { recursive: true });
    writeFileSync(join(RECORDS, "bound.json"), JSON.stringify({ bound: "v1", ...out }, null, 2) + "\n");
    console.log(JSON.stringify({ ok: true, code: 0, bound: join(RECORDS, "bound.json"), unbound: out.questions.map((q) => q.key) }));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
