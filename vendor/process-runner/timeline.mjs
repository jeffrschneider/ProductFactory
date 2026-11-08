// Durations for every run and step (0.30.0).
//
// One bar per phase per round, from the run's own record: who held it, what
// kind of time it was, when it began and ended, and, where the record's times
// say so, how much of it was spent waiting on a person. The run's state keeps
// it (state.timeline, written on every save), so the published run carries it
// and the platform can show where a run's time went without working it out.
//
//   kind     "person"    a gate, a held output's approval, a person's act
//            "external"  a phase the run's own owner holds as an agent phase:
//                        what the platform does for the owner (a pull request,
//                        the sandbox, an install, waiting on a verdict)
//            "agent"     any other holder
//   split    person_ms   a question put to the owner until it was answered,
//                        and a relayed block until its answer
//            agent_ms /  the rest of the bar, by its kind
//            external_ms
//
// Times are UTC ISO 8601 with milliseconds. A phase still open has no end and
// no duration. Phases that overlap keep their own start and end. Pure: the
// state in, the timeline out; nothing here reads a clock or a file.
//
//   needs: node >= 22

const iso = (t) => (Number.isFinite(t) ? new Date(t).toISOString() : null);
const ms = (s) => { const t = Date.parse(String(s ?? "")); return Number.isFinite(t) ? t : NaN; };
const same = (a, b) => { const x = String(a ?? "").trim().toLowerCase(); return x !== "" && x === String(b ?? "").trim().toLowerCase(); };

/** The kind of time a phase's round was. */
function kindOf(p, owner) {
  if (p.mode === "gate" || p.mode === "person-acts") return "person";
  if (same(p.holder?.handle, owner)) return "external";
  return "agent";
}

/** Where a round began: its opening, else its first send, else its question. */
function startOf(r) {
  const opened = ms(r.opened_at);
  if (Number.isFinite(opened)) return opened;
  const sends = (r.sent ?? []).map((x) => ms(x.at)).filter(Number.isFinite);
  if (sends.length) return Math.min(...sends);
  return ms(r.asked?.at);
}

/** Time spent waiting on a person inside a round that ran from a to b. */
function personWait(r, a, b) {
  let wait = 0;
  const span = (from, to) => {
    const f = ms(from);
    if (!Number.isFinite(f)) return;
    const t = Number.isFinite(ms(to)) ? ms(to) : b;
    if (Number.isFinite(t)) wait += Math.max(0, Math.min(t, b) - Math.max(f, a));
  };
  if (r.block?.relayed_at) span(r.block.relayed_at, r.block.answered_at);
  // A held output waiting for the owner's yes: its question to the end.
  if (r.mode === "hold-output" && r.asked?.at) span(r.asked.at, null);
  return wait;
}

function bar(phase, r, round, holder, kind, statusWord, owner) {
  const start = startOf(r);
  if (!Number.isFinite(start)) return null;
  const endRaw = ms(r.closed_at);
  const end = Number.isFinite(endRaw) ? endRaw : (Number.isFinite(ms(r.superseded_at)) ? ms(r.superseded_at) : NaN);
  const done = Number.isFinite(end);
  const duration = done ? Math.max(0, end - start) : null;
  const out = { phase, round, holder, kind, start: iso(start), end: done ? iso(end) : null, duration_ms: duration, status: statusWord };
  if (done) {
    const person = kind === "person" ? duration : Math.min(duration, personWait(r, start, end));
    const rest = duration - person;
    out.split = { person_ms: person, agent_ms: kind === "agent" ? rest : 0, external_ms: kind === "external" ? rest : 0 };
  } else {
    out.split = null;
  }
  void owner;
  return out;
}

/** The run's timeline: { bars, totals }. */
export function timeline(state) {
  const owner = state?.owner ?? null;
  const bars = [];
  for (const [id, p] of Object.entries(state?.phases ?? {})) {
    const holder = p.holder?.handle ?? null;
    const kind = kindOf(p, owner);
    for (const h of p.history ?? []) {
      const b = bar(id, { ...h, mode: p.mode }, h.round || 0, holder, kind, h.superseded_by ? "superseded" : (h.status ?? "closed"), owner);
      if (b) bars.push(b);
    }
    if (p.status === "waiting" && !(p.round > 0)) continue;
    const b = bar(id, p, p.round || 0, holder, kind, p.status, owner);
    if (b) bars.push(b);
  }
  bars.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const sum = { person: 0, agent: 0, external: 0 };
  for (const b of bars) {
    if (!b.split) continue;
    sum.person += b.split.person_ms;
    sum.agent += b.split.agent_ms;
    sum.external += b.split.external_ms;
  }
  const all = sum.person + sum.agent + sum.external;
  const started = ms(state?.started_at);
  const ended = ms(state?.closed_at);
  const ends = state?.status !== "open" && Number.isFinite(started) && Number.isFinite(ended);
  return {
    bars,
    totals: {
      total_ms: ends ? Math.max(0, ended - started) : null,
      person_ms: sum.person, agent_ms: sum.agent, external_ms: sum.external,
      share: all ? { person: sum.person / all, agent: sum.agent / all, external: sum.external / all } : { person: 0, agent: 0, external: 0 },
    },
  };
}
