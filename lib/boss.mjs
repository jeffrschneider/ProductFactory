// The product's boss (lifecycle API 0.4.1; Agent Roles §39, role-boss): the
// agent a person talks to about one product. It sits on top of the process
// runner, which keeps running each build's stages.
//
//   GET  /products/:name/boss/messages                 the conversation, oldest first
//   POST /products/:name/boss/messages { text, confirms?, declines? }
//   GET  /products/:name/boss/commitments              everything it committed, in full
//
// From the product's record it does three things:
//   1. answers a question about the product, naming where in the record;
//   2. routes a directive to the stage whose agent owns it: posts it into that
//      stage's chat (thread.mjs) with the context and the person's own words,
//      and says where it went (routed);
//   3. plans a larger request across the stages, in the lifecycle's order, with
//      the gate the person meets at each (plan), and proposes the first stage's
//      existing action. A request that changes the agent's statement first
//      proposes starting the next version (start_version), with the newest
//      build as its prototype; the person confirms that here (confirms), and the
//      boss starts it through the runner's own start (runner.start), then
//      proposes the spec writer's changes action with the person's words.
//
// It never answers a gate, never changes an artifact, and takes no action: a
// stage's action is the build's own, which the person takes with the actions
// route (server.mjs tells the boss, so the answer is in its commitments). It
// commits no money, accepts no price and messages nobody outside the product's
// stages. It answers through the reference agents' shared model caller, as each
// stage's agent does (thread.mjs), and what it says is kept in the same place
// as the stage chats: the build record's thread. Its commitments are kept once
// each, in the build record's commitments, and an answer to a proposal is a
// record of its own, so nothing is rewritten.
//
// Features (lifecycle API 0.4.3): when the person and the boss land on a new or
// changed feature, the reply proposes it ("features"), as a stage's agent does,
// and the person answers each one on the reply (features.mjs). The boss never
// approves one itself.

import { Refused } from "./lifecycle.mjs";
import { STAGES_DOC, stageById, roleById } from "./standards.mjs";
import { answererAt, CHANGE_ACTION } from "./thread.mjs";
import { buildView, summaryOf } from "./view.mjs";
import { featuresInReply } from "./features.mjs";

const words = (s) => String(s ?? "").trim();
const nameOf = (id) => stageById.get(id)?.name ?? id;
const roleName = (id) => roleById.get(id)?.name ?? id;
const ORDER = new Map(STAGES_DOC.stages.map((s, i) => [s.id, i]));
const OFF = new Set(["not_used", "not_offered", "not_applicable", "not_bound"]);
const TEXT_LIMIT = 4000;
const HISTORY_KEPT = 12;
const SUMMARY_LIMIT = 1500;
/** The spec (spec.json and spec.md, stages.json 1.6.0) and the agent's own files, as Requirements handed them back. */
const AGENT_FILE = /^requirements\/(spec\.json|spec\.md|agent-descriptor\.json|agent-runtime-requirements\.json|plugin\.json|mcp\.json|skills\/[^/]+\/SKILL\.md)$/;
const KINDS = new Set(["answer", "route", "ask", "plan", "gate", "edit", "limit", "commitments", "drop"]);
const CHANGE_ROLE = { requirements: "spec-writer", test: "test-writer", code: "code-writer" };
const byTime = (a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0);

/** The next minor version after the newest of a product's versions: 0.1.0 -> 0.2.0. */
export function nextVersion(versions) {
  let top = [0, 0, 0];
  for (const v of versions) {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ""));
    if (!m) continue;
    const n = m.slice(1, 4).map(Number);
    if (n[0] > top[0] || (n[0] === top[0] && (n[1] > top[1] || (n[1] === top[1] && n[2] > top[2])))) top = n;
  }
  return `${top[0]}.${top[1] + 1}.0`;
}

/** The boss's reading of the model's text: { kind, answer, stage, directive, change, statement_change, plan, drop, features }. Text that is not JSON is an answer as it is. */
export function readBossReply(text) {
  const t = words(text);
  const tryJson = (s) => { try { const v = JSON.parse(s); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; } };
  const unfenced = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const v = tryJson(unfenced) ?? tryJson(unfenced.slice(unfenced.indexOf("{"), unfenced.lastIndexOf("}") + 1));
  if (!v || !KINDS.has(v.kind)) return { kind: "answer", answer: t, features: [] };
  return {
    kind: v.kind,
    answer: words(v.answer),
    stage: words(v.stage) || null,
    directive: words(v.directive) || null,
    change: words(v.change) || null,
    statement_change: v.statement_change === true,
    plan: Array.isArray(v.plan) ? v.plan.filter((s) => s && typeof s.stage === "string").map((s) => ({ stage: words(s.stage), words: words(s.words) })) : [],
    drop: Array.isArray(v.drop) ? v.drop.filter((x) => typeof x === "string") : [],
    features: featuresInReply(v),
  };
}

/** Who holds a stage, in words: the role's name for a reference agent, the holder's own name otherwise. */
function holderWords(s) {
  const h = s?.holder;
  if (!h) return "nobody";
  return h.kind === "reference_agent" ? `the ${roleName(h.role ?? h.name).toLowerCase()}` : h.name;
}

/** The stages a build runs, in the lifecycle's order, as the build answer shows them. */
const runStages = (r) => buildView(r).stages.filter((s) => !OFF.has(s.state));

/** The gate a person meets at a stage of a build like r, in words, or null when it has none. */
function gateAt(r, stage) {
  if (stage === "requirements") return "You approve the spec, or ask for changes.";
  if (stage === "code") return r.settings?.code?.holder === "pull-request" ? "You OK the code on its pull request, or send it back to Test." : "You OK the code.";
  if (stage === "deploy") return "You approve the deploy, then the package goes to your runtime.";
  return null;
}

/**
 * The boss's prompt: who it is, its rules, the product's record (each version,
 * the newest build stage by stage with holders, gates and what each made), the
 * stages it may post to, its commitments, the conversation, and what the person said.
 */
export function bossPrompt({ name, builds, artifacts, mayPost, gateWords, commitments, history, text, who, features = [] }) {
  const r = builds[0];
  const L = [
    `You are the boss of the product ${name}, holding the Agent Roles role "the boss" (role-boss). ${who} owns the product and is talking to you. You sit on top of the process runner, which runs each build's stages and stops at every gate.`,
    "",
    "Rules:",
    "- Answer in plain words, short, from the product's record below and nothing else, and name where in the record the answer comes from: the build and its version, the stage, the artifact or the gate. When the record does not say, say so.",
    "- You do no stage's work: you never write or change a statement, a test, a script, a package or anything a stage makes.",
    "- You never answer a gate: you never approve, accept or reject anything, and you never speak for the person at a gate.",
    "- You commit no money, accept no price, start no build the person has not confirmed, and message nobody outside this product's stages.",
    "- Every constraint the person states goes with the work you pass on.",
    "- Answer with one JSON object and nothing else: {\"kind\": ..., \"answer\": \"your words to the person\", ...}. kind is one of:",
    "  \"answer\": a question about the product.",
    "  \"route\": a directive for the work of one stage. Add \"stage\" (one of the stage ids you may post to, below) and \"directive\" (the directive as that stage's agent should read it, with every constraint the person stated).",
    "  \"ask\": a directive no single stage owns, or you cannot tell which. In \"answer\", ask the person which stage.",
    "  \"plan\": a request larger than one stage, such as a change to what the agent does. Add \"statement_change\": true when it changes the agent's statement, \"change\" (the change as the first stage's agent should work from it, with every constraint), and \"plan\": [{\"stage\": id, \"words\": what that stage must do}].",
    "  \"gate\": the person asks you to approve, accept, reject or answer a gate for them.",
    "  \"edit\": the person asks you to change something a stage made, yourself. Add \"change\" as the stage's agent should work from it.",
    "  \"limit\": the person asks you to commit money, accept a price, start a build without their confirmation, or message someone outside this product.",
    "  \"commitments\": the person asks what you committed or did on their behalf.",
    "  \"drop\": the person withdraws a directive or a plan. Add \"drop\": the ids of the commitments it withdraws, from the list below.",
    "- With any kind: when you and the person land on a new feature of the agent, or a change to one listed below, add \"features\": a list of {\"id\": the listed feature's id when it changes one, else null, \"name\": a few words, \"does\": one sentence, \"offering\": the offering it belongs to, by name}. The person approves each one; you never do.",
    "",
    `The product ${name}, every version, newest first:`,
  ];
  for (const b of builds) L.push(`- ${b.version}, build ${b.id}: ${summaryOf(b)}. Started ${b.created}.${b.earlier ? ` Its prototype was ${b.earlier.version} (build ${b.earlier.build}).` : ""}`);
  L.push("", `The newest build, ${r.id} (${r.version}). What it should do: ${words(r.does)}${words(r.refuses) ? ` What it must refuse: ${words(r.refuses)}` : ""}`, "Its stages, in order:");
  const arts = artifacts(r);
  for (const s of runStages(r)) {
    const gate = ["waiting", "refused"].includes(r.status) && r.at === s.stage ? ` Its gate is open: ${gateWords(s.stage)}` : "";
    const made = arts.filter((a) => a.stage === s.stage).map((a) => `${a.name} (${a.state}${a.version ? `, ${a.version}` : ""})`);
    L.push(`- ${s.stage} (${nameOf(s.stage)}): ${s.state}, held by ${holderWords(s)}.${gate}${made.length ? ` Its outputs: ${made.join(", ")}.` : ""}`);
  }
  L.push(features.length ? "Its features:" : "It has no features listed yet.");
  for (const f of features) L.push(`- ${f.id} (${f.state}${f.backlog ? ", left for later" : ""}, offering ${f.offering || "not named"}): ${f.name}. ${f.does}`);
  for (const a of arts.filter((x) => x.state === "made" && x.summary)) {
    L.push("", `${a.name} (${nameOf(a.stage)}, ${a.version ?? "made"}):`, JSON.stringify(a.summary).slice(0, SUMMARY_LIMIT));
  }
  L.push("", `Stages you may post a directive to on ${r.version}: ${mayPost.length ? mayPost.map((s) => `${s.stage} (${s.who})`).join(", ") : "none"}.`);
  if (commitments.length) {
    L.push("", "What you committed so far:");
    for (const c of commitments) L.push(`- ${c.id} (${c.kind}, ${c.at}): to ${c.to}: ${c.what}`);
  }
  if (history.length) {
    L.push("", "What the person and you said before:");
    for (const m of history) L.push(`- (${m.version}) ${m.from.kind === "person" ? "The person" : "You"}: ${m.text}`);
  }
  L.push("", "The person says:", text);
  return `${L.join("\n")}\n`;
}

/**
 * store, runner: Product Factory's. chat: the stage chats (thread.mjs), whose
 * model caller the boss answers through. now: the clock.
 */
export function createBoss({ store, runner, chat, now = () => new Date().toISOString() }) {
  const newId = (p) => `${p}_${chat.newId().slice(2)}`;

  /** Everything the boss kept for a product, from each build's record. */
  const kept = (builds, key) => builds.flatMap((r) => (Array.isArray(r[key]) ? r[key] : []));

  /**
   * Its commitments, oldest first, each proposal with the person's answer folded
   * in: open until answered; closed when a newer proposal of the same action on
   * the same build replaced it, or its build ended without it.
   */
  function commitmentsOf(builds) {
    const all = kept(builds, "commitments").sort(byTime);
    const answers = new Map(all.filter((c) => c.kind === "answer").map((c) => [c.proposal, c]));
    const list = all.filter((c) => c.kind !== "answer");
    return list.map((c, i) => {
      const out = c;
      if (c.kind !== "proposed") return out;
      const a = answers.get(c.proposal.id);
      if (a) return { ...out, answer: { state: a.state, by: a.by, at: a.at } };
      const replaced = list.slice(i + 1).some((x) => x.kind === "proposed" && x.proposal.action === c.proposal.action && x.proposal.build === c.proposal.build);
      const b = builds.find((x) => x.id === c.proposal.build);
      const ended = c.proposal.action !== "start_version" && b && ["done", "stopped"].includes(b.status) && c.proposal.action !== "stop";
      return { ...out, answer: { state: replaced || ended ? "closed" : "open" } };
    });
  }

  /** The conversation, oldest first; a kept proposal says whether it is still open. */
  function messagesOf(builds) {
    const state = new Map(commitmentsOf(builds).filter((c) => c.kind === "proposed").map((c) => [c.proposal.id, c.answer.state]));
    return kept(builds, "thread").filter((m) => m.boss).sort(byTime).map(({ boss, ...m }) => (m.proposes ? { ...m, proposes: { ...m.proposes, state: state.get(m.proposes.id) ?? "open" } } : m));
  }

  /** Keeps a message of the boss's conversation, and commitments, on build id. */
  const keep = (id, messages, commitments = []) => store.update(id, (b) => {
    for (const m of messages) (b.thread ??= []).push({ ...m, boss: true });
    for (const c of commitments) (b.commitments ??= []).push(c);
  });

  /** The person's answer to a proposal, kept once as a record of its own. */
  const answerOf = (proposal, state, who) => ({ id: newId("c"), at: now(), kind: "answer", proposal, state, by: who.name });

  /** The person took one of a build's actions (the actions route): every open proposal of it on that build is answered. */
  async function taken(r, action, who, builds) {
    const open = commitmentsOf(builds).filter((c) => c.kind === "proposed" && c.answer.state === "open" && c.proposal.build === r.id && c.proposal.action === action);
    if (open.length) await store.update(r.id, (b) => { for (const c of open) (b.commitments ??= []).push(answerOf(c.proposal.id, "taken", who)); });
  }

  /**
   * A proposal of a build's existing action at a stage, made only when this person
   * may take it: { proposes } or { words } saying why not.
   * view: the build as this person sees it. offered: every action it offers now.
   */
  function proposeAction(r, stage, needsWords, { view, offered, gate, soon = false }) {
    const action = CHANGE_ACTION[stage];
    if (!action) return { words: `${nameOf(stage)} has no action that takes a change, so I have not proposed one.` };
    const mine = view.actions.find((a) => a.name === action);
    const any = offered.find((a) => a.name === action);
    const g = gate(stage, r.lifecycle?.project ?? null);
    if (mine || (soon && g.yes)) {
      const needs = {};
      const named = mine?.needs?.length ? mine.needs : [{ name: "changes" }];
      for (const n of named) needs[n.name] = needsWords;
      const when = mine ? {} : { when: `When ${nameOf(stage)} of ${r.version} waits on you, after the ${roleName(CHANGE_ROLE[stage]).toLowerCase()}'s first draft.` };
      return { proposes: { id: newId("bp"), build: r.id, action, needs, words: `${mine?.label ?? (action === "changes" ? "Ask for changes" : action)} on ${nameOf(stage)}, ${r.version}?`, ...when } };
    }
    if (any || soon) return { words: `${g.words} So I have not proposed it.` };
    return { words: `${r.version} offers no way to make that change at ${nameOf(stage)} now, so I have not proposed one.` };
  }

  /** The plan's steps: each stage in the lifecycle's order, what it must do, and the gate the person meets there. */
  function stepsFor(r, stages, said, { gate, next = null }) {
    const run = runStages(r);
    const keepStage = new Set(stages);
    const v = next ?? r.version;
    return run.filter((s) => keepStage.has(s.stage)).map((s) => {
      const holder = holderWords(s);
      const Holder = `${holder[0].toUpperCase()}${holder.slice(1)}`;
      const fallback = {
        requirements: next ? `The spec writer drafts ${next} from ${r.version}, then revises it with your change.` : "The spec writer revises the statement with your change.",
        // Architecture is set up once for a product: a later version carries the record forward (make-a-new-agent.txt v3).
        architecture: next ? `The architecture record is carried forward unchanged, and the spec writer makes ${next}'s own files within it.` : "The spec writer makes the agent's own files again within the architecture record.",
        test: `The test writer writes the suite for ${v}'s statement.`,
        code: `${Holder} writes the scripts until the suite passes.`,
        package: `${Holder} packs and validates ${v}.`,
        deploy: `The package goes to your runtime.`,
      }[s.stage] ?? `${Holder} does ${nameOf(s.stage)} for ${v}.`;
      const g = gateAt(r, s.stage);
      const who = g ? gate(s.stage, r.lifecycle?.project ?? null).words : "";
      return { stage: s.stage, words: said.get(s.stage) || fallback, ...(g ? { gate: `${g} ${who}`.trim() } : {}) };
    });
  }

  /** The gates of a plan, in words: "Requirements (you approve the spec, or ask for changes), Code (...)". */
  const gatesWords = (plan) => plan.filter((s) => s.gate).map((s) => `${nameOf(s.stage)} (${s.gate.split(". ")[0].replace(/\.$/, "").replace(/^You/, "you")})`).join(", ");

  /** Everything committed, in words, in full. */
  function committedWords(list) {
    if (!list.length) return "I have committed nothing on your behalf yet.";
    const line = (c) => {
      if (c.kind === "routed") return `${c.at}: posted to ${c.to} on ${c.version} (message ${c.message_id}): ${c.what}`;
      if (c.kind === "dropped") return `${c.at}: told ${c.to} on ${c.version} that work is no longer wanted (message ${c.message_id}): ${c.what}`;
      if (c.kind === "started") return `${c.at}: started ${c.version} (build ${c.build}) on your confirmation at ${c.confirmation.at}.`;
      const a = c.answer.state === "open" ? "not answered yet" : c.answer.state === "closed" ? "closed without an answer" : `${c.answer.state} by ${c.answer.by} at ${c.answer.at}`;
      return `${c.at}: proposed to you on ${c.version}: ${c.what} (${a}).`;
    };
    return `Everything I committed on your behalf, ${list.length} in all:\n${list.map((c) => `- ${line(c)}`).join("\n")}`;
  }

  /**
   * POST /products/:name/boss/messages. builds: the product's builds, newest first.
   * ctx: view(r), the build as this person sees it; offered(r), every action it
   * offers now; gate(stage, project), people.mjs's gate for this person;
   * artifacts(r); toStage(r, stage, text), which posts a directive into a
   * stage's chat as the boss and has its agent answer (thread.mjs post).
   * Resolves to { message, reply }. Throws Refused in words.
   */
  async function post(name, builds, who, body, ctx) {
    const text = words(body?.text);
    if (typeof body?.text !== "string" || !text) throw new Refused(400, "Say something: text is your words.");
    if (text.length > TEXT_LIMIT) throw new Refused(400, `A message is at most ${TEXT_LIMIT} characters.`);
    for (const k of ["confirms", "declines"]) if (body[k] !== undefined && (typeof body[k] !== "string" || !body[k])) throw new Refused(400, `${k} is a proposal's id.`);
    if (body.confirms && body.declines) throw new Refused(400, "Confirm a proposal or decline it, not both.");
    const r = builds[0];
    const stamp = (b) => ({ build: b.id, version: b.version });
    const me = { kind: "agent", name: "The boss", role: "boss" };
    const said = (b, t, extra = {}) => ({ id: chat.newId(), at: now(), ...stamp(b), from: me, text: t, ...extra });
    const commitments = commitmentsOf(builds);

    // ---- an answer to one of its proposals: no model, nothing but what the person said ----
    const answering = body.confirms ?? body.declines;
    if (answering) {
      const c = commitments.find((x) => x.kind === "proposed" && x.proposal.id === answering);
      if (!c) throw new Refused(400, `${name} has no proposal ${answering}.`);
      if (c.answer.state !== "open") throw new Refused(400, `That proposal is ${c.answer.state}, so there is nothing to ${body.confirms ? "confirm" : "decline"}.`);
      const message = { id: chat.newId(), at: now(), ...stamp(r), from: { kind: "person", name: who.name }, text, ...(body.confirms ? { confirms: answering } : { declines: answering }) };
      if (body.declines) {
        const reply = said(r, `All right: I have not done it. ${c.what} Nothing changed.`);
        await keep(r.id, [message, reply], [answerOf(answering, "declined", who)]);
        return { message, reply };
      }
      if (c.proposal.action !== "start_version") throw new Refused(400, `That proposal is ${c.proposal.build === r.id ? "the build's" : "a build's"} own action. Confirm it with its button, which takes it through the build's actions, so it goes back through its gate.`);
      const earlier = builds.find((b) => b.id === c.proposal.build);
      const version = c.proposal.needs.version;
      if (!earlier) throw new Refused(409, `The build that proposal starts from is gone, so I cannot start ${version}.`);
      if (builds.some((b) => b.version === version)) throw new Refused(409, `${name} already has a build of ${version}, so I have not started another.`);
      const files = (earlier.stages.requirements?.handed_back?.files ?? []).filter((f) => AGENT_FILE.test(f.path)).map((f) => ({ at: f.at, media_type: /\.json$/.test(f.path) ? "application/json" : "text/markdown" }));
      const fresh = await runner.start({
        does: earlier.does, refuses: earlier.refuses, more: earlier.more, name,
        prototype: `${name} ${earlier.version} (build ${earlier.id}): its approved spec and the agent's own files are attached, to revise.`,
        ...(earlier.project ? { project: earlier.project } : {}),
      }, who, { version, earlier: { build: earlier.id, version: earlier.version, files } });
      const stored = await keepStart(earlier, fresh, c, message, who, ctx);
      return stored;
    }

    // ---- everything else is answered through the model ----
    const ready = chat.modelFor("the boss", null);
    const message = { id: chat.newId(), at: now(), ...stamp(r), from: { kind: "person", name: who.name }, text };
    await keep(r.id, [message]);
    const mayPost = Object.keys(r.stages).filter((s) => answererAt(r, s).role).sort((a, b) => ORDER.get(a) - ORDER.get(b))
      .map((s) => ({ stage: s, who: `the ${roleName(answererAt(r, s).role).toLowerCase()}` }));
    const gateWords = (stage) => ctx.gate(stage, r.lifecycle?.project ?? null).words;
    const prompt = bossPrompt({ name, builds, artifacts: ctx.artifacts, mayPost, gateWords, commitments, history: messagesOf(builds).filter((m) => m.id !== message.id).slice(-HISTORY_KEPT), text, who: who.name, features: ctx.features ?? [] });
    const got = await chat.ask(ready, r.id, message.id, prompt);
    if (!got.ok) {
      const reply = { id: chat.newId(), at: now(), ...stamp(r), from: { kind: "system", name: "Product Factory" }, text: `The boss could not answer: ${got.why}. Nothing changed.` };
      await keep(r.id, [reply]);
      return { message, reply };
    }
    const m = readBossReply(got.text);
    const view = ctx.view(r);
    const offered = ctx.offered(r);
    const out = await answer(m, { name, builds, r, who, text, view, offered, mayPost, commitments, ctx, said, message });
    // The features it proposes are kept as proposals, each with its id, and shown on the reply.
    const kept = m.features.length && ctx.proposeFeatures ? await ctx.proposeFeatures(m.features, { message: out.reply.id }) : [];
    if (kept.length) out.reply.features = kept;
    await keep(r.id, [out.reply], out.commitments ?? []);
    return { message, reply: out.reply };
  }

  /** After the person confirmed start_version: the new build started; keep the answer, the start, and the next proposal. */
  async function keepStart(earlier, fresh, c, message, who, ctx) {
    const at = now();
    const view = ctx.view(fresh);
    const offered = ctx.offered(fresh);
    const change = c.then?.needs?.changes ?? null;
    const p = change ? proposeAction(fresh, "requirements", change, { view, offered, gate: ctx.gate, soon: true }) : null;
    const parts = [`I started ${fresh.version} (build ${fresh.id}) on your confirmation, with ${earlier.version} as its prototype. The spec writer drafts ${fresh.version} from ${earlier.version} first.`];
    if (p?.proposes) parts.push("When that draft waits at Requirements, confirm Ask for changes below and the spec writer revises it with your words. It goes back through the Requirements gate.");
    else if (p?.words) parts.push(p.words);
    const reply = { id: chat.newId(), at, build: fresh.id, version: fresh.version, from: { kind: "agent", name: "The boss", role: "boss" }, text: parts.join(" "), started: { build: fresh.id, version: fresh.version }, ...(p?.proposes ? { proposes: p.proposes } : {}) };
    const commitments = [
      answerOf(c.proposal.id, "taken", who),
      { id: newId("c"), at, kind: "started", to: "you", what: `Started ${fresh.version} of ${fresh.name} with ${earlier.version} as its prototype.`, build: fresh.id, version: fresh.version, reply: reply.id, confirmation: { message_id: message.id, by: who.name, at: message.at } },
      ...(p?.proposes ? [{ id: newId("c"), at, kind: "proposed", to: "you", what: `Ask for changes on Requirements of ${fresh.version}: ${change}`, build: fresh.id, version: fresh.version, reply: reply.id, proposal: p.proposes }] : []),
    ];
    await keep(earlier.id, [message]);
    await keep(fresh.id, [reply], commitments);
    return { message, reply };
  }

  /** The reply to what the model made of the person's words, with the rules applied here, not left to the model. */
  async function answer(m, { name, builds, r, who, text, view, offered, mayPost, commitments, ctx, said, message }) {
    const project = r.lifecycle?.project ?? null;
    const gate = ctx.gate;
    const proposed = (p, what) => ({ id: newId("c"), at: now(), kind: "proposed", to: "you", what, build: p.build, version: builds.find((b) => b.id === p.build)?.version ?? r.version, reply: null, proposal: p });
    const finish = (reply, list = []) => ({ reply, commitments: list.map((c) => ({ ...c, reply: reply.id })) });

    if (m.kind === "gate") {
      const waiting = builds.find((b) => ["waiting", "refused"].includes(b.status));
      const where = waiting
        ? `${nameOf(waiting.at)} on ${waiting.version} (build ${waiting.id}) waits at its gate. ${gate(waiting.at, waiting.lifecycle?.project ?? null).words} Answer it on that stage, where its buttons are.`
        : `No gate of ${name} waits now.`;
      return finish(said(r, `I do not answer gates, so I have not approved anything: a gate answered by whoever proposed the work is not a gate. ${where}`));
    }
    if (m.kind === "limit") {
      return finish(said(r, "I will not do that: it is past my authority. I may post into this product's stage chats, propose, and start the next version when you confirm it. I commit no money, accept no price, start no build you have not confirmed, and message nobody outside this product's stages. Nothing changed."));
    }
    if (m.kind === "commitments") return finish(said(r, committedWords(commitments)));
    if (m.kind === "ask") return finish(said(r, m.answer || `Which stage should this go to? I may post to ${mayPost.map((s) => nameOf(s.stage)).join(", ") || "no stage"} on ${r.version}.`));

    if (m.kind === "route") {
      const stage = m.stage;
      const ok = stage && mayPost.some((s) => s.stage === stage);
      if (!ok) {
        const why = stage && stageById.has(stage) ? answererAt(r, stage).refused ?? `I may not post to ${nameOf(stage)} on ${r.version}.` : "I could not tell which stage owns that.";
        return finish(said(r, `${why} So I have not passed it on. Which stage should it go to? I may post to ${mayPost.map((s) => nameOf(s.stage)).join(", ") || "no stage"}.`));
      }
      const directive = `${m.directive || text}\n\nThe person's own words: “${text}”\nFrom the boss, for ${who.name}, on ${name} ${r.version} (build ${r.id}).`;
      let posted;
      try {
        posted = await ctx.toStage(r, stage, directive);
      } catch (e) {
        if (!(e instanceof Refused)) throw e;
        return finish(said(r, `I could not post it to ${nameOf(stage)}: ${e.message} Nothing changed.`));
      }
      const to = mayPost.find((s) => s.stage === stage).who;
      const reply = said(r, `${m.answer ? `${m.answer} ` : ""}I posted it in the ${nameOf(stage)} chat, to ${to}, on ${r.version}. Its answer is there.`, { routed: { stage, message_id: posted.message.id, build: r.id } });
      return finish(reply, [{ id: newId("c"), at: now(), kind: "routed", to: `${to}, at ${nameOf(stage)}`, stage, what: m.directive || text, build: r.id, version: r.version, message_id: posted.message.id }]);
    }

    if (m.kind === "drop") {
      const live = commitments.filter((c) => c.kind === "routed" && !commitments.some((d) => d.kind === "dropped" && d.withdraws === c.id));
      const ids = new Set(m.drop);
      const pick = ids.size ? live.filter((c) => ids.has(c.id)) : live.slice(-1);
      if (!pick.length) return finish(said(r, "I have routed nothing that is still wanted, so there is no one to tell. Nothing changed."));
      const dropped = [];
      const list = [];
      for (const c of pick) {
        const b = builds.find((x) => x.id === c.build) ?? r;
        const note = await chat.note(b, c.stage, `The person withdrew this, so it is no longer wanted: “${c.what}” Stop any work on it. (Withdrawn from message ${c.message_id}.)`);
        dropped.push({ stage: c.stage, message_id: note.id, build: b.id });
        list.push({ id: newId("c"), at: now(), kind: "dropped", to: c.to, stage: c.stage, what: `Withdrew “${c.what}” (message ${c.message_id}).`, build: b.id, version: b.version, message_id: note.id, withdraws: c.id });
      }
      // Where a build is running for a withdrawn plan, its own action for stopping is proposed.
      const started = commitments.filter((c) => c.kind === "started" && ids.has(c.id)).map((c) => builds.find((b) => b.id === c.build)).filter((b) => b && ["working", "waiting", "refused"].includes(b.status));
      let proposes = null;
      if (started.length && ctx.view(started[0]).actions.some((a) => a.name === "stop")) {
        proposes = { id: newId("bp"), build: started[0].id, action: "stop", needs: {}, words: `Stop ${started[0].version} (build ${started[0].id})?` };
        list.push(proposed(proposes, `Stop ${started[0].version}, which ran for the withdrawn plan.`));
      }
      const reply = said(r, `I told ${dropped.map((d) => nameOf(d.stage)).join(", ")} that the work is no longer wanted.${proposes ? ` ${started[0].version} is running for it; confirm Stop below to stop it.` : ""}`, { dropped, ...(proposes ? { proposes } : {}) });
      return finish(reply, list);
    }

    if (m.kind === "plan" || m.kind === "edit") {
      const refusal = m.kind === "edit" ? "I do not change what a stage made: each artifact is checked by roles its maker does not control, and one I made would skip that check. " : "";
      const change = m.change || text;
      // An edit goes through the stage's own action when the newest build offers it to this person now.
      if (m.kind === "edit") {
        const p = proposeAction(r, "requirements", change, { view, offered, gate });
        if (p.proposes) {
          const reply = said(r, `${refusal}The spec writer can make it: confirm Ask for changes below and it goes back through the Requirements gate of ${r.version}.`, { proposes: p.proposes });
          return finish(reply, [proposed(p.proposes, `Ask for changes on Requirements of ${r.version}: ${change}`)]);
        }
      }
      const statement = m.kind === "edit" || m.statement_change;
      const plannedWords = new Map(m.plan.filter((s) => stageById.has(s.stage) && s.words).map((s) => [s.stage, s.words]));
      if (statement) {
        const next = nextVersion(builds.map((b) => b.version));
        const plan = stepsFor(r, runStages(r).map((s) => s.stage), plannedWords, { gate, next });
        const start = { id: newId("bp"), build: r.id, action: "start_version", needs: { version: next }, words: `Start version ${next} of ${name}, with ${r.version} as its prototype?` };
        const text2 = `${refusal}${m.kind === "plan" && m.answer ? `${m.answer} ` : ""}This changes the agent's statement, so it needs version ${next}: a new build, with ${r.version} as its prototype. Once it starts, I will propose Ask for changes to the spec writer with your words. You will meet these gates: ${gatesWords(plan) || "none"}. Nothing changes until you confirm.`;
        const reply = said(r, text2, { plan, proposes: start });
        const c = { ...proposed(start, `Start ${next} of ${name} with ${r.version} as its prototype, then ask the spec writer for this change: ${change}`), then: { action: "changes", needs: { changes: change } } };
        return finish(reply, [c]);
      }
      const stages = [...plannedWords.keys()];
      const plan = stepsFor(r, stages.length ? stages : [r.at], plannedWords, { gate });
      if (!plan.length) return finish(said(r, `${m.answer ? `${m.answer} ` : ""}None of the stages that names runs on ${r.version}, so I have no plan to offer. Nothing changed.`));
      const p = proposeAction(r, plan[0].stage, change, { view, offered, gate });
      const reply = said(r, `${m.answer ? `${m.answer} ` : ""}You will meet these gates: ${gatesWords(plan) || "none"}. ${p.proposes ? `Confirm ${p.proposes.words.replace(/\?$/, "")} below to begin.` : p.words}`, { plan, ...(p.proposes ? { proposes: p.proposes } : {}) });
      return finish(reply, p.proposes ? [proposed(p.proposes, `${p.proposes.words.replace(/\?$/, "")}: ${change}`)] : []);
    }

    return finish(said(r, m.answer || "The record does not say, so I have no answer to that."));
  }

  return {
    post, taken,
    messages: (builds) => ({ messages: messagesOf(builds) }),
    // What the start of a next version proposes after it ("then") is the boss's own note, not a commitment's field.
    commitments: (builds) => ({ commitments: commitmentsOf(builds).map(({ then, ...c }) => c) }),
  };
}
