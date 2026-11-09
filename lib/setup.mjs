// The guided setup (lifecycle API 0.4.4): for each stage set up once per
// product, the small form a person fills in on the product's Setup tab. Each
// setup item in GET /products/:name carries its form: who may hold it (the
// reference agent, if the role has one, your agent, a person or an outside
// tool), a few settings with sensible defaults, and the question "Ask the
// boss" sends for it. The service says what the form is; the console draws it.
//
// Nothing here saves. A form is saved with the roles operation the lifecycle
// already has: PUT /roles/{role} with the holder, whose settings keep this
// stage's values under the stage's id (cadence.mjs settingsFor), beside any
// other stage the same role holds. The run plan and every later version read
// them from the lifecycle the build keeps.

import { roleById, stageById } from "./standards.mjs";
import { setupRole } from "./cadence.mjs";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const roleName = (id) => roleById.get(id)?.name ?? id;

/** Who decides, from the organization's people: the product's approvers, each team, each approver or admin. */
function deciders(people) {
  const out = ["an approver of the product"];
  for (const t of people?.teams ?? []) if (t?.name) out.push(`the ${t.name} team`);
  for (const p of people?.people ?? []) if (p?.name && ["approver", "admin"].includes(p.role)) out.push(p.name);
  return [...new Set(out)];
}

/** A choice of people when the organization has some; words otherwise. */
const whoField = (name, label, people) => {
  const options = deciders(people);
  return options.length > 1
    ? { name, label, kind: "choice", options, default: options[0] }
    : { name, label, kind: "text", default: options[0] };
};

/** Each setup stage's settings: name, label, kind (number, text or choice), default, and unit, options, min, max where they help. */
export function fieldsFor(stage, people = null) {
  switch (stage) {
    case "source": return [{ name: "look_first_in", label: "Look first in", kind: "text", default: "our organization's catalog" }];
    case "architecture": return [{ name: "stack", label: "Build on", kind: "text", default: "the organization's stack first, a platform default for the rest" }];
    case "publish": return [
      { name: "listed_in", label: "Where it's listed", kind: "text", default: "our organization's catalog" },
      { name: "visible_to", label: "Who can see it", kind: "choice", options: ["our organization", "everyone"], default: "our organization" },
    ];
    case "monitor": return [
      { name: "every_minutes", label: "Check every", kind: "number", unit: "minutes", default: 5, min: 1 },
      { name: "alert_after_minutes", label: "Alert after no answer for", kind: "number", unit: "minutes", default: 15, min: 1 },
      { name: "alert_where", label: "Alert where", kind: "text", default: "the console" },
    ];
    case "eval": return [
      { name: "grades_against", label: "Grades against", kind: "text", default: "the spec's examples, set before the work" },
      { name: "how_often", label: "How often", kind: "choice", options: ["each version", "weekly", "monthly"], default: "each version" },
      { name: "sample", label: "Sample", kind: "number", unit: "jobs", default: 20, min: 1 },
    ];
    case "incident": return [whoField("who_decides", "Who decides", people)];
    case "cost": return [
      { name: "monthly_ceiling", label: "Monthly ceiling", kind: "number", unit: "dollars", default: 50, min: 0 },
      { name: "warn_at_percent", label: "Warn at", kind: "number", unit: "percent", default: 80, min: 1, max: 100 },
      { name: "at_ceiling", label: "At the ceiling", kind: "choice", options: ["pause it", "warn only", "ask an approver"], default: "pause it" },
    ];
    case "update": return [whoField("approved_by", "Who approves an update", people)];
    default: return [];
  }
}

/** The question "Ask the boss" sends for a setup stage of the product. */
export function askFor(stage, product) {
  const n = product;
  return {
    source: `Where should ${n} look first for agents that already fit?`,
    architecture: `Who should hold the architecture for ${n}, and on what stack?`,
    publish: `Where should ${n} be listed?`,
    monitor: `Who should monitor ${n}?`,
    eval: `Who should grade ${n}, and against what?`,
    incident: `Who should decide when ${n} has an incident?`,
    cost: `Who should watch what ${n} spends, and what ceiling fits?`,
    update: `Who should approve an update to ${n}?`,
  }[stage] ?? `Who should hold ${stageById.get(stage)?.name ?? stage} for ${n}?`;
}

/** The setup stages another stage's role also holds: Monitor and Cost share the watcher. */
function sharedWith(stage, setupStages) {
  const role = setupRole(stage);
  return setupStages.filter((s) => s !== stage && setupRole(s) === role);
}

/**
 * The form for one setup item: { ask, reference_agent, fields, shares? }.
 * reference_agent: the role's reference agent, or null when it has none.
 * shares: words, when the role holds another setup stage too.
 */
export function formFor(item, { product, people = null, setupStages = [] } = {}) {
  const role = roleById.get(item.role);
  const others = sharedWith(item.stage, setupStages);
  const form = { ask: askFor(item.stage, product), reference_agent: role?.reference_agent ?? null, fields: fieldsFor(item.stage, people) };
  if (others.length) {
    const names = [item.stage, ...others].map((s) => stageById.get(s)?.name ?? s);
    form.shares = `The ${roleName(item.role).toLowerCase()} holds ${names.slice(0, -1).join(", ")} and ${names.at(-1)}: one holder for both, each with its own settings.`;
  }
  return form;
}

/** The product's setup list with each item's form. */
export function withForms(setup, { product, people = null } = {}) {
  if (!Array.isArray(setup)) return setup;
  const stages = setup.map((x) => x.stage);
  return setup.map((x) => (isObj(x) ? { ...x, form: formFor(x, { product, people, setupStages: stages }) } : x));
}

/**
 * The holder PUT /roles/{role} is sent to save one setup form: the holder
 * chosen, with this stage's values under its id beside the settings it already
 * keeps for any other stage. existing: the holder the lifecycle has now, or null.
 */
export function holderToSave({ stage, holder, values, existing = null }) {
  const kept = isObj(existing?.settings) ? structuredClone(existing.settings) : {};
  const out = { kind: holder.kind, name: holder.name };
  if (holder.handle) out.handle = holder.handle;
  out.settings = { ...kept, [stage]: { ...values } };
  return out;
}
