// Teams: the organization, its teams and projects, and people with roles, in
// people.json beside the lifecycle document; each person's own key; and who
// may do what.
//
//   {
//     "organization": "Example Org",
//     "people": [
//       { "name": "Ana Lee", "email": "ana@example.com", "role": "approver" }
//     ],
//     "teams": [{ "name": "Platform", "members": ["ana@example.com"] }],
//     "projects": [{ "name": "billing", "teams": ["Platform"] }]
//   }
//
// Roles, each able to do what the one before it does:
//
//   member     starts builds, stops and resumes them, and sees everything;
//   approver   also answers the gates the lifecycle names them for;
//   admin      also changes the lifecycle (and people, with the CLI).
//
// Who may answer a gate is set per lifecycle: the lifecycle document's
// approvers, by stage id, name people (by email) and teams (by name). A
// project's list for a stage replaces the organization's. Anyone may answer a
// gate whose stage is listed nowhere; otherwise only an approver or admin who
// is named, or is in a named team, may. Who may is read when the gate is
// answered, so a fix to the list helps a build that is already waiting.
//
// Keys: each person has their own, made with `product-factory person add` and
// printed once. Only its SHA-256 is kept, in <data>/people-keys.json. The
// service's own key (<data>/service-key) still works, as an admin.
//
// Single sign-on is not here. It plugs in at identify(): verify the
// organization's OIDC ID token (issuer, audience, signature) instead of a key,
// and look the person up in people.json by the token's email claim. The roles,
// teams and every rule below stay as they are.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync, chmodSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Refused } from "./lifecycle.mjs";
import { stageById } from "./standards.mjs";

export const ROLES = ["member", "approver", "admin"];
export const PEOPLE_FILE = "people.json";
export const KEYS_FILE = "people-keys.json";
/** The actions that answer a person's gate. */
export const GATE_ACTIONS = new Set(["approve", "changes", "accept"]);

const EMAIL = /^[^\s@]+@[^\s@]+$/;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const words = (v) => (typeof v === "string" ? v.trim() : "");
const low = (s) => String(s).trim().toLowerCase();
const rank = (role) => ROLES.indexOf(role);

/** people.json, beside the lifecycle document. */
export const peoplePath = (lifecyclePath) => join(dirname(resolve(lifecyclePath)), PEOPLE_FILE);

export const emptyPeople = () => ({ organization: "", people: [], teams: [], projects: [] });

/** Checks a parsed people document. Returns { doc, problems }: doc holds what could be read, problems are in words. */
export function readPeople(raw) {
  const problems = [];
  const doc = emptyPeople();
  if (!isObj(raw)) return { doc, problems: ["people.json holds one JSON object: organization, people, teams and projects."] };
  for (const k of Object.keys(raw)) if (!["organization", "people", "teams", "projects"].includes(k)) problems.push(`people.json has "${k}", which Product Factory does not read. It reads organization, people, teams and projects.`);
  if ("organization" in raw) {
    if (typeof raw.organization !== "string") problems.push(`"organization" is the organization's name, as words.`);
    else doc.organization = raw.organization.trim();
  }
  const list = (k) => {
    if (!(k in raw)) return [];
    if (!Array.isArray(raw[k])) { problems.push(`"${k}" is a list.`); return []; }
    return raw[k];
  };
  const emails = new Set();
  list("people").forEach((p, i) => {
    const at = `people[${i}]`;
    if (!isObj(p)) return problems.push(`${at} is a person: name, email and role.`);
    for (const k of Object.keys(p)) if (!["name", "email", "role"].includes(k)) problems.push(`${at} has "${k}"; a person has name, email and role.`);
    const email = words(p.email);
    if (!EMAIL.test(email)) return problems.push(`${at} needs an email, such as ana@example.com.`);
    if (emails.has(low(email))) return problems.push(`${email} is listed twice in people.`);
    if (!ROLES.includes(p.role)) return problems.push(`${email} has the role ${JSON.stringify(p.role ?? null)}; a role is member, approver or admin.`);
    if ("name" in p && typeof p.name !== "string") problems.push(`${at}: the name is words.`);
    emails.add(low(email));
    doc.people.push({ name: words(p.name) || email, email, role: p.role });
  });
  const teams = new Set();
  list("teams").forEach((t, i) => {
    const at = `teams[${i}]`;
    if (!isObj(t)) return problems.push(`${at} is a team: name and members.`);
    for (const k of Object.keys(t)) if (!["name", "members"].includes(k)) problems.push(`${at} has "${k}"; a team has name and members.`);
    const name = words(t.name);
    if (!name) return problems.push(`${at} needs a name.`);
    if (teams.has(low(name))) return problems.push(`The team ${name} is listed twice.`);
    teams.add(low(name));
    const members = [];
    if (t.members !== undefined && !Array.isArray(t.members)) problems.push(`The team ${name}: members is a list of emails.`);
    for (const m of Array.isArray(t.members) ? t.members : []) {
      if (typeof m !== "string" || !emails.has(low(m))) problems.push(`The team ${name} lists ${JSON.stringify(m)}, who is not in people.`);
      else members.push(m.trim());
    }
    doc.teams.push({ name, members });
  });
  const projects = new Set();
  list("projects").forEach((p, i) => {
    const at = `projects[${i}]`;
    if (!isObj(p)) return problems.push(`${at} is a project: name and teams.`);
    for (const k of Object.keys(p)) if (!["name", "teams"].includes(k)) problems.push(`${at} has "${k}"; a project has name and teams.`);
    const name = words(p.name);
    if (!name || name.length > 200) return problems.push(`${at} needs a name of at most 200 characters.`);
    if (projects.has(name)) return problems.push(`The project ${name} is listed twice.`);
    projects.add(name);
    const its = [];
    if (p.teams !== undefined && !Array.isArray(p.teams)) problems.push(`The project ${name}: teams is a list of team names.`);
    for (const t of Array.isArray(p.teams) ? p.teams : []) {
      if (typeof t !== "string" || !teams.has(low(t))) problems.push(`The project ${name} belongs to ${JSON.stringify(t)}, which is not a team.`);
      else its.push(t.trim());
    }
    doc.projects.push({ name, teams: its });
  });
  return { doc, problems };
}

/** Reads people.json. A missing file is no people and no problem. */
export function loadPeople(file) {
  if (!existsSync(file)) return { doc: emptyPeople(), problems: [], missing: true };
  let raw;
  try { raw = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")); } catch (e) {
    return { doc: emptyPeople(), problems: [`${file} is not valid JSON: ${e.message}.`], missing: false };
  }
  return { ...readPeople(raw), missing: false };
}

function writeWhole(file, text, mode) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text, { encoding: "utf8", ...(mode ? { mode } : {}) });
  try { renameSync(tmp, file); } catch (e) { try { unlinkSync(tmp); } catch { /* gone */ } throw e; }
  if (mode) try { chmodSync(file, mode); } catch { /* a hint on Windows */ }
}

export const savePeople = (file, doc) => writeWhole(file, `${JSON.stringify(doc, null, 2)}\n`);

// ---------- keys ----------

const digest = (key) => createHash("sha256").update(String(key), "utf8").digest("hex");

/** Each person's keys, kept only as SHA-256 digests in one file readable by its owner. */
export function createKeys(file) {
  const read = () => {
    try {
      const v = JSON.parse(readFileSync(file, "utf8"));
      return Array.isArray(v?.keys) ? v.keys.filter((k) => isObj(k) && typeof k.email === "string" && /^[0-9a-f]{64}$/.test(k.sha256)) : [];
    } catch { return []; }
  };
  const write = (keys) => writeWhole(file, `${JSON.stringify({ keys }, null, 2)}\n`, 0o600);
  return {
    file,
    /** Makes a new key for this email and returns it; only its digest is kept. Earlier keys for the email stop working. */
    make(email) {
      const key = `pf_${randomBytes(32).toString("hex")}`;
      write([...read().filter((k) => low(k.email) !== low(email)), { email, sha256: digest(key), made: new Date().toISOString() }]);
      return key;
    },
    /** Every key for this email stops working. Returns how many there were. */
    revoke(email) {
      const all = read();
      const kept = all.filter((k) => low(k.email) !== low(email));
      if (kept.length !== all.length) write(kept);
      return all.length - kept.length;
    },
    /** The email a key belongs to, or null. */
    find(key) {
      const want = Buffer.from(digest(key), "hex");
      let hit = null;
      for (const k of read()) if (timingSafeEqual(want, Buffer.from(k.sha256, "hex")) && !hit) hit = k.email;
      return hit;
    },
    has: (email) => read().some((k) => low(k.email) === low(email)),
  };
}

// ---------- who may approve each gate ----------

/** The lifecycle document's approvers, checked. Returns { org, projects, problems }. */
export function readApprovers(lifecycleDoc, people) {
  const problems = [];
  const emails = new Set(people.people.map((p) => low(p.email)));
  const roleOf = new Map(people.people.map((p) => [low(p.email), p.role]));
  const teams = new Set(people.teams.map((t) => low(t.name)));
  const scope = (sc, where) => {
    const out = {};
    if (!isObj(sc) || sc.approvers === undefined) return out;
    if (!isObj(sc.approvers)) { problems.push(`${where}.approvers is an object: a list of approvers for each stage id.`); return out; }
    for (const [stage, list] of Object.entries(sc.approvers)) {
      const at = `${where}.approvers.${stage}`;
      if (!Array.isArray(list)) { problems.push(`${at} is a list of people and teams.`); continue; }
      const ok = [];
      list.forEach((a, i) => {
        const keys = isObj(a) ? Object.keys(a) : [];
        if (keys.length !== 1 || !["person", "team"].includes(keys[0]) || !words(a[keys[0]])) {
          return problems.push(`${at}[${i}] is one person, as {"person": "<email>"}, or one team, as {"team": "<name>"}.`);
        }
        if (a.person !== undefined) {
          if (!emails.has(low(a.person))) problems.push(`${at} names ${a.person}, who is not in people.json.`);
          else if (rank(roleOf.get(low(a.person))) < rank("approver")) problems.push(`${at} names ${a.person}, a member. Only approvers and admins answer gates; give them the approver role.`);
        } else if (!teams.has(low(a.team))) problems.push(`${at} names the team ${a.team}, which is not in people.json.`);
        ok.push(a.person !== undefined ? { person: a.person.trim() } : { team: a.team.trim() });
      });
      out[stage] = ok;
    }
    return out;
  };
  const org = scope(lifecycleDoc?.organization, "organization");
  const projects = {};
  for (const [name, sc] of Object.entries(isObj(lifecycleDoc?.projects) ? lifecycleDoc.projects : {})) projects[name] = scope(sc, `projects.${name}`);
  return { org, projects, problems };
}

/**
 * Who may do what. people: people.json; keys: the people's keys; lifecycle:
 * the lifecycle document's path; serviceKey and admin: the service's own key
 * and the person it acts as. With no files, only the service key answers.
 */
export function createPeople({ file = null, keysFile = null, lifecycle = null, serviceKey, admin }) {
  const keys = keysFile ? createKeys(keysFile) : null;
  const serviceBuf = Buffer.from(String(serviceKey));
  const load = () => (file ? loadPeople(file) : { doc: emptyPeople(), problems: [], missing: true });
  const lifecycleDoc = () => {
    if (!lifecycle) return {};
    try { return JSON.parse(readFileSync(lifecycle, "utf8").replace(/^﻿/, "")); } catch { return {}; }
  };
  const teamsOf = (doc, email) => doc.teams.filter((t) => t.members.some((m) => low(m) === low(email))).map((t) => t.name);

  /**
   * The person a request comes from, by its bearer key: { person } or { refused: words }.
   * Single sign-on would answer here too, from a verified OIDC ID token's email.
   */
  function identify(key) {
    if (!key) return { refused: "Give your key as Authorization: Bearer <key>. An admin makes one with `product-factory person add <email>`; the service's own key also works." };
    const got = Buffer.from(key);
    if (got.length === serviceBuf.length && timingSafeEqual(got, serviceBuf)) {
      return { person: { name: admin.name, email: admin.email, role: "admin", teams: [], service_key: true } };
    }
    const email = keys?.find(key);
    if (!email) return { refused: "That key is not one this service made, or it was revoked. Ask an admin for a new one." };
    const { doc, problems } = load();
    const p = doc.people.find((x) => low(x.email) === low(email));
    if (!p) return { refused: problems.length ? `people.json has a problem, so personal keys are refused until it is fixed: ${problems[0]}` : `That key belongs to ${email}, who is no longer in people.json.` };
    return { person: { name: p.name, email: p.email, role: p.role, teams: teamsOf(doc, p.email) } };
  }

  /** The approvers named for a stage under a project: the project's list replaces the organization's. */
  function approversOf(stage, project) {
    const { doc } = load();
    const a = readApprovers(lifecycleDoc(), doc);
    return (project && a.projects[project]?.[stage]) ?? a.org[stage] ?? [];
  }

  function nameOf(doc, a) {
    if (a.team) return `an approver in the team ${a.team}`;
    const p = doc.people.find((x) => low(x.email) === low(a.person));
    return p && p.name !== p.email ? `${p.name} (${p.email})` : a.person;
  }
  const either = (list) => (list.length <= 1 ? list.join("") : `${list.slice(0, -1).join(", ")} or ${list[list.length - 1]}`);

  /** Whether this person may answer the gate at a stage: { yes, who, words }. */
  function gate(who, stage, project) {
    const named = approversOf(stage, project);
    const { doc } = load();
    if (!named.length) return { yes: true, who: [], words: "Anyone may answer this gate: the lifecycle names no approvers for it." };
    const names = named.map((a) => nameOf(doc, a));
    const inIt = named.some((a) => (a.person ? low(a.person) === low(who.email) : who.teams.some((t) => low(t) === low(a.team))));
    const yes = inIt && rank(who.role) >= rank("approver");
    const stageName = stageById.get(stage)?.name ?? stage;
    return { yes, who: names, words: yes ? `You may answer this gate. The lifecycle names ${either(names)}.` : `Only ${either(names)} may answer the ${stageName} gate.` };
  }

  return {
    file, keysFile,
    identify,
    gate,
    /** Refuses with 403 in words unless the person may answer this build's gate with this action. */
    mustAnswer(who, build, action) {
      if (!GATE_ACTIONS.has(action) || build.status !== "waiting") return;
      const g = gate(who, build.at, build.lifecycle?.project ?? null);
      if (!g.yes) throw new Refused(403, `${g.words} You are signed in as ${who.name}${who.email !== who.name ? ` (${who.email})` : ""}, ${articled(who.role)}.`);
    },
    /** Refuses with 403 in words unless the person is an admin. */
    mustBeAdmin(who) {
      if (who.role !== "admin") throw new Refused(403, `Only an admin of the organization can change its lifecycle. You are signed in as ${who.name}, ${articled(who.role)}.`);
    },
    /** A build as this person sees it: a gate they may not answer is not offered, and the stage says who may. */
    shape(view, who) {
      const waiting = new Set(view.stages.filter((s) => s.state === "waiting_on_you").map((s) => s.stage));
      const gates = new Set(view.actions.filter((a) => GATE_ACTIONS.has(a.name) && waiting.has(a.stage)).map((a) => a.stage));
      if (!gates.size) return view;
      const project = view.lifecycle?.project ?? null;
      const by = new Map([...gates].map((s) => [s, gate(who, s, project)]));
      return {
        ...view,
        actions: view.actions.filter((a) => !GATE_ACTIONS.has(a.name) || !by.has(a.stage) || by.get(a.stage).yes),
        stages: view.stages.map((s) => (by.has(s.stage) ? { ...s, gate: { you_may_answer: by.get(s.stage).yes, who: by.get(s.stage).who, words: by.get(s.stage).words } } : s)),
      };
    },
    /** GET /people: the organization, its people with their teams, teams and projects, and any problems, in words. */
    list() {
      const { doc, problems, missing } = load();
      const a = readApprovers(lifecycleDoc(), doc);
      return {
        organization: doc.organization || null,
        people: doc.people.map((p) => ({ ...p, teams: teamsOf(doc, p.email), has_key: keys ? keys.has(p.email) : false })),
        teams: doc.teams,
        projects: doc.projects,
        approvers: { organization: a.org, projects: a.projects },
        problems: [...problems, ...a.problems],
        kept_in: missing ? null : PEOPLE_FILE,
        change: "People, teams and projects are changed with the command line: product-factory person add <email> --role member|approver|admin, person key, person revoke, person remove, team add and project add. Who may approve each gate is the lifecycle document's approvers.",
      };
    },
  };
}

const articled = (role) => (role === "admin" || role === "approver" ? `an ${role}` : `a ${role}`);

// ---------- the command line ----------

export const PEOPLE_HELP = `People, teams and projects (an admin's commands; they change people.json beside the lifecycle document):

  product-factory people                                  list people, teams and projects
  product-factory person add <email> --role <role> [--name <name>]
                                                          add a person (member, approver or admin) and print their key, once
  product-factory person key <email>                      print a new key for them; their old one stops working
  product-factory person revoke <email>                   their key stops working
  product-factory person remove <email>                   take them out of people.json and its teams, and revoke their key
  product-factory team add <name> [--member <email>]...   add a team, or set an existing team's members
  product-factory project add <name> [--team <name>]...   add a project, or set the teams it belongs to
`;

/**
 * Runs one people command. config: the settings (lifecycle and data paths).
 * Returns { code, out } with what to print; never prints a key except the one it just made.
 */
export function peopleCommand(positionals, opts, config) {
  const file = peoplePath(config.lifecycle);
  const keys = createKeys(join(config.data, KEYS_FILE));
  const [noun, verb, arg] = positionals;
  const fail = (out) => ({ code: 2, out });
  const { doc: read, problems, missing } = loadPeople(file);
  if (problems.length && !(noun === "people")) return fail(`${file} has problems; fix them first:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  const doc = missing ? { ...emptyPeople(), organization: "" } : read;
  const person = (email) => doc.people.find((p) => low(p.email) === low(email));

  if (noun === "people") {
    const lines = [`${doc.organization || "The organization"} (${missing ? `no ${PEOPLE_FILE} yet` : file})`, ""];
    lines.push("People:");
    for (const p of doc.people) lines.push(`  ${p.name} <${p.email}>  ${p.role}${keys.has(p.email) ? "" : "  (no key)"}`);
    if (!doc.people.length) lines.push("  none yet");
    lines.push("Teams:");
    for (const t of doc.teams) lines.push(`  ${t.name}: ${t.members.join(", ") || "no members"}`);
    if (!doc.teams.length) lines.push("  none yet");
    lines.push("Projects:");
    for (const p of doc.projects) lines.push(`  ${p.name}: ${p.teams.join(", ") || "no teams"}`);
    if (!doc.projects.length) lines.push("  none yet");
    if (problems.length) lines.push("", "Problems:", ...problems.map((p) => `  - ${p}`));
    return { code: problems.length ? 1 : 0, out: lines.join("\n") };
  }

  if (noun === "person") {
    const email = words(arg);
    if (!EMAIL.test(email)) return fail(`Give the person's email: product-factory person ${verb ?? "add"} <email>.`);
    if (verb === "add") {
      const role = opts.role ?? "member";
      if (!ROLES.includes(role)) return fail("The role is member, approver or admin.");
      const was = person(email);
      if (was) { was.role = role; if (opts.name) was.name = opts.name; } else doc.people.push({ name: words(opts.name) || email, email, role });
      savePeople(file, doc);
      if (was && keys.has(email)) return { code: 0, out: `${email} is now ${articled(role)}. Their key is unchanged.` };
      const key = keys.make(email);
      return { code: 0, out: `${was ? "Updated" : "Added"} ${email} as ${articled(role)}.\n\nTheir key, shown only this once:\n\n  ${key}\n\nGive it to them; they keep it in a file and open the console with --key-file <that file>.` };
    }
    if (!person(email)) return fail(`${email} is not in ${file}.`);
    if (verb === "key") return { code: 0, out: `A new key for ${email}, shown only this once. Their old key no longer works.\n\n  ${keys.make(email)}\n` };
    if (verb === "revoke") return { code: 0, out: keys.revoke(email) ? `${email}'s key no longer works.` : `${email} had no key.` };
    if (verb === "remove") {
      doc.people = doc.people.filter((p) => low(p.email) !== low(email));
      for (const t of doc.teams) t.members = t.members.filter((m) => low(m) !== low(email));
      savePeople(file, doc);
      keys.revoke(email);
      return { code: 0, out: `Removed ${email} from people and every team, and revoked their key.` };
    }
    return fail(PEOPLE_HELP);
  }

  if ((noun === "team" || noun === "project") && verb === "add") {
    const name = words(arg);
    if (!name) return fail(`Give the ${noun}'s name: product-factory ${noun} add <name>.`);
    if (noun === "team") {
      const members = [opts.member ?? []].flat();
      for (const m of members) if (!person(m)) return fail(`${m} is not in people; add them first with product-factory person add ${m}.`);
      const t = doc.teams.find((x) => low(x.name) === low(name));
      if (t) t.members = members; else doc.teams.push({ name, members });
      savePeople(file, doc);
      return { code: 0, out: `The team ${name}: ${members.join(", ") || "no members yet"}.` };
    }
    const teams = [opts.team ?? []].flat();
    for (const t of teams) if (!doc.teams.some((x) => low(x.name) === low(t))) return fail(`There is no team ${t}; add it first with product-factory team add ${t}.`);
    const p = doc.projects.find((x) => x.name === name);
    if (p) p.teams = teams; else doc.projects.push({ name, teams });
    savePeople(file, doc);
    return { code: 0, out: `The project ${name} belongs to ${teams.join(", ") || "no team yet"}.` };
  }
  return fail(PEOPLE_HELP);
}
