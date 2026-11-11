// What a draft reaches over the network, declared the way the security
// reviewer reads it.
//
// A script carries no address of its own (Common Agent 12.6 rule 2, the
// address check of 12.10): where a system is, the install places in a
// setting, and the script reads it from there. The security reviewer
// (agents/security-reviewer, scripts/trace-programs.mjs) passes a call to an
// address a program is handed in a few cases, and two of them are a spec's to
// declare:
//
//   - the program reads a setting a declared service lists as its address:
//     a variable whose name ends in _ENDPOINT, _URL, _BASE, _HOST or
//     _ADDRESS;
//   - a declared read or trigger service whose stated reason (`needs`) is
//     fetching what it is handed, such as each page a story links to.
//
// On 2026-11-09 a rebuild of hn-reader was refused at Code because its spec
// declared two services with neither: no address setting for the Hacker News
// API and a reason that said "request" rather than "fetch". The scripts then
// read the address from a variable nobody declared, and the deployed agent
// reached nothing.
//
// So every service a draft reaches over the network, other than a model
// system and the brokered draft-host, says one of the two. An address setting
// on a service that holds no credential (a public read) carries the real
// address as its `default`, and the service's `needs` names that address's
// host, the shape the reviewer matches a destination by. The default is the
// one place in a spec an address may sit: the builder writes a setting's
// variable and purpose into the install file and leaves its default out, and
// the install supplies the value.
//
//   needs: node >= 22. Nothing here reads or writes a file.
//   import { ADDRESS_SETTING, FETCHING, addressSettingsOf, reachProblems } from "./reaches.mjs"

const trim = (s) => String(s ?? "").trim();

/** A variable the security reviewer reads as a service's address, by name. */
export const ADDRESS_SETTING = /_(?:ENDPOINT|URL|BASE|HOST|ADDRESS)$/;

/** A stated reason the security reviewer reads as fetching what the program
 *  is handed (trace-programs.mjs, FETCHING), word for word. */
export const FETCHING = /\b(?:fetch(?:es|ing)?|download(?:s|ing)?|crawl(?:s|ing)?|brows(?:e|es|ing)|open(?:s|ing)? (?:the |those |each )?pages)\b/i;

/** An address as a setting's default: http or https, then a host. */
export const ADDRESS = /^https?:\/\/[A-Za-z0-9[][^\s"'`<>]*$/i;

/** Systems the platform brokers or places: no address of their own. */
const NOT_REACHED_BY_SCRIPTS = ["draft-host"];

/** An address, written one way: scheme and host in lower case, no trailing
 *  slash. Two spellings of one place compare equal. */
export function sameAddress(a) {
  const t = trim(a).replace(/\/+$/, "");
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/i.exec(t);
  return m ? `${m[1].toLowerCase()}${m[2].toLowerCase()}${m[3]}` : t;
}

/** The host of an address, or "". */
export const hostOf = (a) => /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i.exec(trim(a))?.[1]?.toLowerCase() ?? "";

const servicesOf = (spec) => (Array.isArray(spec?.systems) ? spec.systems : [])
  .filter((s) => s && typeof s === "object" && trim(s.kind) === "service" && !NOT_REACHED_BY_SCRIPTS.includes(trim(s.name)));

/** The address settings a draft declares: each service setting whose variable
 *  the reviewer reads as an address, with its system and default. */
export function addressSettingsOf(spec) {
  const out = [];
  for (const s of servicesOf(spec)) {
    for (const st of Array.isArray(s.settings) ? s.settings : []) {
      if (st && ADDRESS_SETTING.test(trim(st.env))) out.push({ system: trim(s.name), env: trim(st.env), default: st.default, credential: !!trim(s.credential) });
    }
  }
  return out;
}

/** Whether a service's stated reason is fetching what it is handed. */
export const fetchesHanded = (s) => FETCHING.test(String(s?.needs ?? s?.purpose ?? ""));

/** Each service the draft reaches over the network that the security
 *  reviewer could not match, as sentences a model can act on. Empty when
 *  every one names an address setting (a public read with its real address
 *  as the default, and that address's host in its needs) or says it fetches
 *  what it is handed. */
export function reachProblems(spec) {
  const out = [];
  for (const s of servicesOf(spec)) {
    const name = trim(s.name) || "a system with no name";
    const settings = (Array.isArray(s.settings) ? s.settings : []).filter((st) => st && ADDRESS_SETTING.test(trim(st.env)));
    const publicRead = !trim(s.credential);
    if (!settings.length) {
      if (publicRead && !fetchesHanded(s)) {
        out.push(`system ${name} is reached over the network and declares no address setting, so the scripts have nowhere to read where it is and the security reviewer refuses the call. `
          + `Give it a setting named for the address, ending in _ADDRESS, _URL, _BASE, _ENDPOINT or _HOST (such as ${envFor(name)}), with the real address as its default, and name that address's host in its needs; `
          + `or, where it reaches whatever address it is handed (each page a story links to), say so in its needs with the word fetches`);
      }
      continue;
    }
    for (const st of settings) {
      const d = st.default;
      if (publicRead && !(typeof d === "string" && ADDRESS.test(trim(d)))) {
        out.push(`system ${name}: the address setting ${trim(st.env)} has no default address. A public read has one real address: give it, with its scheme, as the setting's default, and the install supplies it`);
        continue;
      }
      if (typeof d === "string" && ADDRESS.test(trim(d))) {
        const host = hostOf(d);
        const said = `${s.needs ?? ""} ${s.purpose ?? ""}`.toLowerCase();
        if (host && !said.includes(host)) {
          out.push(`system ${name}: its needs does not name ${host}, the host its address setting ${trim(st.env)} defaults to; the security reviewer matches a destination to a system by its stated reason, so say it there`);
        }
      }
    }
  }
  return out;
}

/** A setting name drafted from a system's name, for the example in a finding. */
const envFor = (name) => `${String(name).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "SERVICE"}_ADDRESS`;
