// A stage's chat (lifecycle API 0.4): the session with the agent holding a
// stage, kept per product per stage across builds.
//
//   GET  /products/:name/stages/:stage/messages            the chat, oldest first
//   POST /products/:name/stages/:stage/messages { text, build? }   the agent holding the stage answers
//
// Each message is kept with the build it was said in (build.json "thread"),
// carrying that build's id and version, so a product's chat at a stage is
// every message at that stage across its builds. Gates are not messages: a
// gate lives on its stage (products.mjs).
//
// An agent answers through the reference agents' shared model caller
// (CommonAgent/adlc agents/*/scripts/model-caller.mjs), run the way the holder
// adapters run reference scripts, with the four model settings. It reads the
// stage's outputs, its given and the build's record, and answering never
// changes anything. When the person asks for a change, the reply proposes the
// build's existing action for that stage (Requirements: changes; Code:
// resume, when Code was refused; and Requirements, once Code was refused:
// back_to_requirements, 0.4.7), with
// its needs filled, and only when this person may take it now. The person
// confirms it with the actions route, so a change always goes back through
// its gate.
//
// Features (lifecycle API 0.4.3): the agent is shown the product's feature list
// and the offerings of the agent's own files, and when the conversation lands on a new or
// changed feature its reply proposes it ("features"), each with its own
// answer: Approve feature, Not now, or Ask <approver> (features.mjs).

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Refused } from "./lifecycle.mjs";
import { stageById, roleById } from "./standards.mjs";
import { modelEnv } from "./config.mjs";
import { run, lastJson } from "./exec.mjs";
import { summaryOf } from "./view.mjs";
import { featuresInReply } from "./features.mjs";

const words = (s) => String(s ?? "").trim();
const nameOf = (id) => stageById.get(id)?.name ?? id;
const roleName = (id) => roleById.get(id)?.name ?? id;
const TEXT_LIMIT = 4000;
const FILE_BUDGET = 60_000;
const FILE_LIMIT = 20_000;
const HISTORY_KEPT = 12;

/** The role whose agent answers at a stage on this build. */
export function roleAt(r, stage) {
  if (stage === "review") return "code-critic";
  if (stage === "security") return "security-reviewer";
  return r.stages[stage]?.holder?.role ?? stageById.get(stage)?.role_ids?.[0] ?? null;
}

/** The action a change at a stage goes through. */
export const CHANGE_ACTION = { requirements: "changes", code: "resume" };
/** The actions a change at a stage may go through, in order: the first the build offers now is proposed. At Requirements, once Code was refused, a change to the spec sends the build back to Requirements (0.4.7). */
export const CHANGE_ACTIONS = { requirements: ["changes", "back_to_requirements"], code: ["resume"] };
/** The action a change at a stage goes through on this build now: the first of CHANGE_ACTIONS the build offers, else the stage's own. */
export const changeActionAt = (stage, offered = []) => (CHANGE_ACTIONS[stage] ?? []).find((n) => offered.some((a) => a.name === n)) ?? CHANGE_ACTION[stage];

/** Whether an agent Product Factory can reach answers at a stage of this build: { role } or { refused: words } (400). */
export function answererAt(r, stage) {
  const def = stageById.get(stage);
  if (!def) return { refused: `There is no stage "${stage}" in stages.json.` };
  if (r.lifecycle?.used?.[stage]?.used === false) return { refused: `This build's lifecycle leaves out ${def.name}, so no agent holds it to answer.` };
  const role = roleAt(r, stage);
  const name = roleName(role);
  const bound = r.lifecycle?.holders?.[role] ?? null;
  if (stage === "review" || stage === "security") {
    if (bound && bound.kind !== "reference_agent") return { refused: `The lifecycle has ${bound.name} hold the ${name} role${bound.kind === "person" ? ", a person" : bound.kind === "outside_tool" ? ", an outside tool" : ""}. Product Factory cannot send it messages; ask them where they work.` };
    return { refused: `The ${name.toLowerCase()} answers no messages here: Product Factory asks it to read a build once one builder's build folder check passes it, and keeps its verdict at ${def.name}.` };
  }
  const held = r.stages[stage]?.holder ?? null;
  if (!held) return { refused: `Product Factory does not run ${def.name} on this build, so no agent holds it to answer.` };
  if (held.kind === "person") return { refused: `${def.name} is held by ${held.name}, a person. Ask them directly.` };
  if (held.kind === "outside_tool") return { refused: `${def.name} is held by ${held.name}, an outside tool, which does not answer messages.` };
  if (held.kind !== "reference_agent") return { refused: `${def.name} is held by ${held.name}, which Product Factory cannot send messages to. Talk to it where it runs.` };
  return { role };
}

/** The shared model caller in the adlc checkout: the role's own agent's copy first, then any reference agent's. */
export function modelCallerIn(adlc, agent) {
  for (const a of [agent, "spec-writer", "test-writer", "code-critic", "security-reviewer", "solution-architect", "solution-planner"]) {
    if (!a) continue;
    const at = join(adlc, "agents", a, "scripts", "model-caller.mjs");
    if (existsSync(at)) return at;
  }
  return null;
}

/** The reply's JSON from the model's text: { answer, change, features }. Text that is not JSON is the answer as it is. limit: how many features are kept. */
export function readReply(text, { limit = 12 } = {}) {
  const t = words(text);
  const tryJson = (s) => { try { const v = JSON.parse(s); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; } };
  const unfenced = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const v = tryJson(unfenced) ?? tryJson(unfenced.slice(unfenced.indexOf("{"), unfenced.lastIndexOf("}") + 1));
  if (!v || typeof v.answer !== "string") return { answer: t, change: null, features: [] };
  return { answer: words(v.answer), change: typeof v.change === "string" && words(v.change) ? words(v.change) : null, features: featuresInReply(v, { limit }) };
}

/** What the person says when they ask the spec writer to list a product's features after the build (0.4.5). */
export const BACKFILL_TEXT = "List this product's features from the approved spec, and map the tests already in the build to them.";

/** How many features a listing after the build may propose. */
export const BACKFILL_LIMIT = 40;

/**
 * The rules a listing after the build adds (0.4.5): every feature the
 * spec describes, each with the suite's tests that clearly check it, and
 * nothing guessed. tests: the suite's test names, or null with no suite.
 */
export function backfillRules(tests) {
  const L = [
    "",
    "This product was built before it had a feature list. The person asks you to list its features now, from the spec below, or, for a build made before specs, from the agent's own files below.",
    "- Put every feature the spec describes in \"features\": one entry per distinct thing the agent does, or refuses, each with \"id\": null, \"name\": a few words, \"does\": one sentence, \"offering\": the offering it belongs to, by name.",
    "- Take them from the spec only. Do not add a feature the spec does not say.",
  ];
  if (tests?.length) {
    L.push(
      "- Give each feature \"tests\": the names of the tests already in the build that check it, each copied exactly from the list below. Put a test there only when its name or its content makes clear it checks that feature. When it is not clear, leave it out: never guess. A test may check more than one feature, and a test may check none.",
      "The suite's test names:",
      ...tests.map((t) => `- ${t}`),
    );
  } else L.push("- The build has no suite, so give each feature \"tests\": [].");
  L.push("- Say in \"answer\" how many features you listed and how many tests you could not tie to one.");
  return L;
}

/** The prompt an agent answers: who it is, the rules, the stage's given and outputs with their files, the build's record, and what the person said. backfill: { tests } when the person asks for the features to be listed after the build (0.4.5). */
export function promptFor({ r, role, stage, given, outputs, files, history, text, boss = false, features = [], offerings = [], backfill = null }) {
  const s = r.stages[stage];
  const change = CHANGE_ACTION[stage];
  const L = [
    `You are the ${roleName(role)} on a build in an agent development lifecycle that Product Factory runs. You hold ${nameOf(stage)}. The person who owns the build is talking to you.`,
    "",
    "Rules:",
    "- Answer in plain words, short, from the record below and nothing else. When the record does not say, say so.",
    "- Answering changes nothing. You never say you changed, sent or approved anything.",
    change
      ? "- When the person asks for something you make to change, say in your answer what you would change, and put the change itself in \"change\", written as the instruction you would work from. A change goes back through its gate when the person confirms it."
      : "- Nothing you make can be sent back from here. When the person asks for a change, say what would make it, and leave \"change\" null.",
    "- When what you and the person settle on is a new feature of the agent, or a change to one listed below, put it in \"features\": a list of {\"id\": the listed feature's id when it changes one, else null, \"name\": a few words, \"does\": one sentence, \"offering\": the offering it belongs to, by name}. The person approves each one. Otherwise leave \"features\" empty.",
    "- Answer with one JSON object and nothing else: {\"answer\": \"your words to the person\", \"change\": null or \"the change\", \"features\": []}.",
    "",
    `The build: ${r.name} ${r.version}. What it should do: ${words(r.does)}${words(r.refuses) ? ` What it must refuse: ${words(r.refuses)}` : ""}`,
    `Where it is now: ${summaryOf(r)}.`,
  ];
  if (backfill) L.splice(L.indexOf("- Answer with one JSON object and nothing else: {\"answer\": \"your words to the person\", \"change\": null or \"the change\", \"features\": []}."), 0, ...backfillRules(backfill.tests).slice(1));
  if (offerings.length) L.push(`Its offerings: ${offerings.map((o) => `${words(o.name) || words(o.id)}${words(o.does) ? ` (${words(o.does)})` : ""}`).join("; ")}.`);
  if (features.length) {
    L.push("Its features:");
    for (const f of features) L.push(`- ${f.id} (${f.state}${f.backlog ? ", left for later" : ""}, offering ${f.offering || "not named"}): ${f.name}. ${f.does}`);
  } else L.push("It has no features listed yet.");
  if (s) {
    L.push("", `${nameOf(stage)}, as the build records it: ${s.state}.`);
    if (words(s.given)) L.push(`Given: ${words(s.given)}`);
    for (const round of s.rounds) L.push(`- ${round.label}: ${round.verdict}. ${words(round.words)}`);
    if (s.handed_back.words.length) L.push(`Handed back: ${s.handed_back.words.join(" ")}`);
  }
  for (const a of given) L.push("", `What you were given, ${a.name} (${nameOf(a.stage)}, ${a.state}${a.version ? `, ${a.version}` : ""}):`, JSON.stringify(a.summary ?? {}, null, 1));
  for (const a of outputs) L.push("", `What you made, ${a.name} (${a.state}${a.version ? `, ${a.version}` : ""}):`, JSON.stringify(a.summary ?? {}, null, 1));
  for (const f of files) L.push("", `File ${f.path}:`, "```", f.text, "```");
  if (history.length) {
    L.push("", "What the person and you said before, on this build and earlier ones:");
    for (const m of history) L.push(`- (${m.version}) ${m.from.kind === "person" ? "The person" : m.from.role === "boss" ? "The boss, for the person" : "You"}: ${m.text}`);
  }
  // The product's boss routes a directive here on the person's behalf (boss.mjs); it is the person's, carried by the boss.
  L.push("", boss ? "The product's boss passes on a directive from the person, with its context. The person says:" : "The person says:", text);
  return `${L.join("\n")}\n`;
}

/** A product's chat at a stage: every message said at that stage on any of its builds, oldest first. */
export function chatOf(builds, stage) {
  const out = [];
  for (const r of builds) {
    for (const m of Array.isArray(r.thread) ? r.thread : []) {
      if (m.from?.stage !== stage) continue;
      out.push({ ...m, build: m.build ?? r.id, version: m.version ?? r.version });
    }
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/**
 * The agents' side of the chat. config and env: the settings, for the adlc
 * checkout and the four model settings. now: the clock.
 */
export function createThread({ store, config, env = process.env, now = () => new Date().toISOString() }) {
  const newId = () => `t_${randomBytes(6).toString("hex")}`;

  /** The files of a stage's outputs and given, as text, within a budget. */
  function filesOf(list, fileAt) {
    const out = [];
    let left = FILE_BUDGET;
    for (const a of list.filter((x) => x.state === "made")) {
      for (const f of a.files ?? []) {
        if (/\.(tar\.gz|tgz|zip|png|jpe?g|gif|webp)$/i.test(f.path) || left <= 0) continue;
        const at = fileAt(f.path);
        if (!at) continue;
        let text;
        try { text = readFileSync(at, "utf8"); } catch { continue; }
        if (text.length > FILE_LIMIT) text = `${text.slice(0, FILE_LIMIT)}\n… (the rest of this file is left out)`;
        text = text.slice(0, left);
        left -= text.length;
        out.push({ path: f.path, text });
      }
    }
    return out;
  }

  /**
   * The shared model caller, ready to run for an agent called who (words, such as
   * "the spec writer"), or Refused 409 in words when a model setting or the
   * caller is missing. agent: the reference agent whose caller is tried first.
   */
  function modelFor(who, agent) {
    const { env: model, missing } = modelEnv(config, env);
    if (missing.length) throw new Refused(409, `${who[0].toUpperCase()}${who.slice(1)} answers through the model, and ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set. product-factory.json names the environment variables the four model settings are read from; set them, then ask again.`);
    const caller = modelCallerIn(config.adlc, agent);
    if (!caller) throw new Refused(409, `The reference agents' model caller (agents/*/scripts/model-caller.mjs) is not in the adlc checkout at ${config.adlc}. Set "adlc" in product-factory.json to a checkout of CommonAgent/adlc.`);
    return { model, caller };
  }

  /**
   * Runs the shared model caller on a prompt, kept in <build folder>/thread/<message id>.
   * Resolves to { ok: true, text } or { ok: false, why } in words.
   */
  async function ask({ model, caller }, buildId, messageId, prompt) {
    const base = join(store.folder(buildId), "thread", messageId);
    mkdirSync(base, { recursive: true });
    const promptFile = join(base, "prompt.txt");
    writeFileSync(promptFile, prompt);
    const got = await run([process.execPath, caller], { cwd: base, env: { ...env, ...model, PROMPT_FILE: promptFile }, timeoutMs: 5 * 60 * 1000, log: join(base, "model.log") });
    const said = lastJson(got.stdout);
    if (said?.ok && typeof said.text === "string") return { ok: true, text: said.text };
    return { ok: false, why: said?.error || got.error || (got.timedOut ? "the model did not answer in time" : `the model caller ended with code ${got.code}`) };
  }

  /**
   * The person's message to the agent holding a stage of build r, and its answer.
   * view: the build as this person sees it (its actions). offered: every action
   * the build offers now, whoever may take it. gateWords: why this person may
   * not, by stage. given, outputs: the stage's artifacts. history: the product's
   * chat at the stage. fileAt(path): a file's place in the build folder.
   * boss: the message is a directive the product's boss posts on this person's
   * behalf (boss.mjs), kept as from the boss. Resolves to { message, reply }.
   * Throws Refused in words.
   */
  async function post(r, stage, who, body, { view, offered, gateWords = {}, given, outputs, history, fileAt, boss = false, features = [], offerings = [], proposeFeatures = null, backfill = null }) {
    const text = words(body?.text);
    if (typeof body?.text !== "string" || !text) throw new Refused(400, "Say something: text is your words.");
    if (text.length > TEXT_LIMIT) throw new Refused(400, `A message is at most ${TEXT_LIMIT} characters.`);
    const at = answererAt(r, stage);
    if (at.refused) throw new Refused(400, at.refused);
    const { role } = at;
    const ready = modelFor(`the ${roleName(role).toLowerCase()}`, roleById.get(role)?.reference_agent ?? role);

    const stamp = { build: r.id, version: r.version };
    const from = boss ? { kind: "agent", name: "The boss", role: "boss", stage } : { kind: "person", name: who.name, stage };
    const message = { id: newId(), at: now(), ...stamp, from, to: { role }, text };
    await store.update(r.id, (b) => { (b.thread ??= []).push(message); });

    const prompt = promptFor({ r, role, stage, given, outputs, files: filesOf([...outputs, ...given], fileAt), history: history.slice(-HISTORY_KEPT), text, boss, features, offerings, backfill });
    const got = await ask(ready, r.id, message.id, prompt);

    let reply;
    if (!got.ok) {
      reply = { id: newId(), at: now(), ...stamp, from: { kind: "system", name: "Product Factory", stage }, text: `The ${roleName(role).toLowerCase()} could not answer: ${got.why}. Nothing changed.` };
    } else {
      const { answer, change, features: said } = readReply(got.text, { limit: backfill ? BACKFILL_LIMIT : 12 });
      const parts = [answer || "I have no answer to that from the record."];
      let proposes = null;
      const action = changeActionAt(stage, offered);
      if (change && action) {
        const mine = view.actions.find((a) => a.name === action);
        const any = offered.find((a) => a.name === action);
        if (mine) {
          const needs = {};
          for (const n of mine.needs ?? []) needs[n.name] = change;
          proposes = { action, needs };
        } else if (any) {
          parts.push(`${gateWords[any.stage] ?? "You may not take that action on this build."} So I have not proposed it.`);
        } else {
          parts.push(`The build offers no way to make that change now, so I have not proposed one.`);
        }
      }
      reply = { id: newId(), at: now(), ...stamp, from: { kind: "agent", name: roleName(role), role, stage }, text: parts.join(" "), ...(proposes ? { proposes } : {}) };
      // The features it proposes are kept as proposals now, each with its id, and shown on the reply.
      const kept = said.length && proposeFeatures ? await proposeFeatures(said, { stage, message: reply.id }, roleName(role)) : [];
      if (kept.length) reply.features = kept;
    }
    await store.update(r.id, (b) => { (b.thread ??= []).push(reply); });
    return { message, reply };
  }

  /** A message the product's boss posts into a stage's chat with no answer asked for, such as word that work was dropped. */
  async function note(r, stage, text) {
    const at = answererAt(r, stage);
    const message = { id: newId(), at: now(), build: r.id, version: r.version, from: { kind: "agent", name: "The boss", role: "boss", stage }, ...(at.role ? { to: { role: at.role } } : {}), text };
    await store.update(r.id, (b) => { (b.thread ??= []).push(message); });
    return message;
  }

  return { post, note, ask, modelFor, newId };
}
