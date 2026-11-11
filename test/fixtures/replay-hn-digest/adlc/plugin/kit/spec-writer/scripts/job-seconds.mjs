// job_seconds: the longest one job may take, and the range the package maker
// takes for it. A drafted value outside the range is the model's to get wrong
// and not the person's to decide, so it is set to the nearest bound and said;
// and where the builder is not on the host to refuse it, this says what it
// would (technical debt 648: a draft's 30 stopped a build at Package).
//
//   needs: node >= 22
//   import { JOB_SECONDS_MIN, JOB_SECONDS_MAX, jobSecondsProblem, fitJobSeconds } from "./job-seconds.mjs"

/** The longest one job may take, in whole seconds: the range the package
 *  maker takes for job_seconds. The package maker names it once, in build.py
 *  (JOB_SECONDS_MIN, JOB_SECONDS_MAX); test/job-seconds.test.mjs reads them
 *  there and holds these to them (technical debt 648). */
export const JOB_SECONDS_MIN = 60;
export const JOB_SECONDS_MAX = 7200;

/** Why a draft's job_seconds would be refused at Package, in the package
 *  maker's own words and saying where it is set, or "" when it is absent or
 *  one the package maker takes. */
export function jobSecondsProblem(spec) {
  const v = spec?.job_seconds;
  if (v === undefined || v === null || (Number.isInteger(v) && v >= JOB_SECONDS_MIN && v <= JOB_SECONDS_MAX)) return "";
  return `job_seconds is the longest one job may take, a whole number of seconds from ${JOB_SECONDS_MIN} to ${JOB_SECONDS_MAX}; bad: ${JSON.stringify(v)}. `
    + `It is set in agent-runtime-requirements.json; the package maker refuses the package until it is one of those`;
}

/** The draft with a job_seconds the package maker takes, and what was changed
 *  in a sentence for the person ("" when nothing was). A value outside the
 *  range is brought to the nearest bound and a fraction rounded; one that is
 *  not a number is taken out, so the package maker's default holds. It is
 *  the cap on one job, a host fact and not one of the person's questions, so
 *  it is set here rather than asked for, and said. */
export function fitJobSeconds(spec) {
  if (!spec || typeof spec !== "object" || !("job_seconds" in spec) || !jobSecondsProblem(spec)) return { spec, note: "" };
  const v = spec.job_seconds;
  const range = `${JOB_SECONDS_MIN} to ${JOB_SECONDS_MAX}`;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    const { job_seconds: _gone, ...rest } = spec;
    return { spec: rest, note: `The draft named job_seconds ${JSON.stringify(v)}, which is not a number of seconds, so it was taken out and the package maker's default holds (it takes ${range}).` };
  }
  const fitted = Math.min(JOB_SECONDS_MAX, Math.max(JOB_SECONDS_MIN, Math.round(v)));
  return {
    spec: { ...spec, job_seconds: fitted },
    note: `The draft named job_seconds ${JSON.stringify(v)}; the package maker takes ${range} seconds for the longest one job may take, so it is written as ${fitted}.`,
  };
}
