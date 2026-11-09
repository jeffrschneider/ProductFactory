// Whether one kind takes another: the platform's own rule, copied.
//
// This is services/src/compose/ports.ts in the AgentMesh repository
// (bareMediaType and mediaTypeSatisfies, as of PR #672), which is what a
// canvas uses to say whether a line from one agent to the next fits. The
// impact analyst says whether a line that fitted still fits, so it reads kinds
// exactly the way the canvas does and no more cleverly: an exact match, `*/*`,
// `<type>/*`, and the structured syntax suffix of RFC 6839, by which
// `application/<name>+json` is JSON and so satisfies an input that takes
// `application/json` (and the same for `+xml`). The other way does not hold:
// plain `application/json` is not a site-read.
//
// A kind nobody stated is not "anything". It is null here, and a caller treats
// it as a third answer.
//
//   needs: node >= 22
//   import { bareKind, satisfies } from "./kinds.mjs"

/** A kind reduced to what a comparison looks at: lower case, parameters
 *  dropped. Null when there is none. */
export function bareKind(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.split(";")[0].trim().toLowerCase() || null;
}

/** Whether a piece of kind `offered` may go into an input that takes `wanted`. */
export function satisfies(offered, wanted) {
  const o = bareKind(offered);
  const w = bareKind(wanted);
  if (!o || !w) return false;
  if (o === w) return true;
  if (w === "*/*") return true;
  const suffix = /^application\/[^/]+\+(json|xml)$/.exec(o);
  if (suffix && w === `application/${suffix[1]}`) return true;
  const [wantType, wantSub] = w.split("/");
  const [offType] = o.split("/");
  return wantSub === "*" && !!wantType && wantType === offType;
}

/** Whether every input that took `before` also takes `after`: true when the
 *  new kind is the old one, or a narrower spelling of it (a `+json` type for
 *  `application/json`). Then a line that fitted still fits, whatever the
 *  input on the other end took, because satisfies() is transitive over the
 *  kinds it accepts. */
export function refines(after, before) {
  return satisfies(after, before);
}
