// Inputs are only the material a job is about; options are settings. The
// audit checklist's options-are-settings and settings-declared-fully, held
// here as the package maker holds them (build.py option_findings), so a
// draft that breaks them is asked again rather than refused at packing.
//
//   - An input of an offered job that only shapes how the job runs (a voice,
//     a tone, a length, a style, a format choice) is a run-config setting with
//     a label, an about, a default and its allowed values. Brand or palette
//     material is a can_use standing asset, never an input.
//   - Every setting declares label, about and default; allowed whenever its
//     value has a natural set of choices (its name says so, or it is a rule);
//     value_labels for each allowed value; and min, max and step for a number.
//
// The solution architect carries a copy of this file; a test holds the two
// equal. Change them together.
//
//   needs: node >= 22. Nothing here reads or writes a file.

const trim = (s) => String(s ?? "").trim();

export const OPTION_WORDS = /\b(voice|tone|sounds?|style|length|word[ -]?count|format|duration|pace|speed|level|mode|size|register|formality|persona)\b/i;
export const LIBRARY_WORDS = /\b(brand|palette|colou?rs?|logo|fonts?|typefaces?|style[ -]guide|glossary)\b/i;
export const VALUE_INPUT_KINDS = ["text", "identifier"];

export const wordsOf = (name) => String(name ?? "").replace(/[-_]+/g, " ");

/** Whether a piece a person gives is library material, an option, or neither. */
export function inputIs(name, kind) {
  const n = wordsOf(name);
  if (LIBRARY_WORDS.test(n)) return "library";
  if (OPTION_WORDS.test(n) && VALUE_INPUT_KINDS.includes(trim(kind))) return "option";
  return null;
}

/** What a setting does not declare that it should, as member names. */
export function settingMissing(s) {
  const missing = [];
  for (const k of ["label", "about"]) if (!trim(s?.[k])) missing.push(k);
  if (!s || !("default" in s)) missing.push("default");
  const d = s?.default;
  const numeric = typeof d === "number";
  if (!("allowed" in (s ?? {})) && !numeric && (s?.kind === "rule" || OPTION_WORDS.test(wordsOf(s?.name)))) missing.push("allowed (its natural set of choices)");
  if (Array.isArray(s?.allowed)) {
    const labels = s.value_labels && typeof s.value_labels === "object" ? s.value_labels : {};
    const unlabelled = s.allowed.filter((a) => !(String(a) in labels));
    if (unlabelled.length) missing.push(`value_labels for ${unlabelled.map((a) => JSON.stringify(a)).join(", ")}`);
  }
  if (numeric && !("allowed" in s)) for (const k of ["min", "max", "step"]) if (!(k in s)) missing.push(k);
  return missing;
}

/** Every option problem in a spec, as sentences a model can act on, each
 *  starting with its check id. */
export function optionProblems(spec) {
  const out = [];
  const jobs = Array.isArray(spec?.jobs) ? spec.jobs : [];
  const anyOffered = jobs.some((j) => "offered" in (j ?? {}));
  for (const j of jobs) {
    if (anyOffered && j?.offered !== true) continue;
    for (const i of Array.isArray(j?.inputs) ? j.inputs : []) {
      const is = inputIs(i?.name, i?.kind);
      if (is === "library") out.push(`options-are-settings: job ${trim(j.slug)}: input ${JSON.stringify(i.name)} is brand or library material; declare it as a can_use standing asset with what the agent does without it, not as an input`);
      if (is === "option") out.push(`options-are-settings: job ${trim(j.slug)}: input ${JSON.stringify(i.name)} only shapes how the job runs; declare it as a run_config setting with a label, an about, a default and its allowed values, and take it out of the inputs`);
    }
  }
  for (const s of Array.isArray(spec?.run_config?.settings) ? spec.run_config.settings : []) {
    const missing = settingMissing(s);
    if (missing.length) out.push(`settings-declared-fully: run_config setting ${JSON.stringify(s?.name)} does not declare ${missing.join(", ")}; every option gets a label, an about, a default and its choices, decided now`);
  }
  return out;
}
