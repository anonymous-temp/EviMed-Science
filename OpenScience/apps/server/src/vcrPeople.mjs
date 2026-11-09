/**
 * The record of virtual people (plan R23, 2026-11-09): how the control plane asks the engine to make it, and how a made one reads back.
 *
 * Hidden knowledge:
 *
 * - **The record is a result of the study, filed out of every card's way.** The engine's `patients.progression` 1.2.0 `instantiate` step draws
 *   one study and n people (their covariates and individual intercept and slope) once and writes them as the table `progression-people`; the
 *   job asks to keep it (`keepTables`), the data plane files it with its sha256, and the result is kind `experiment_candidate` under the
 *   subject `people:<identity>`, so it never decorates a design card and needs no new result kind. Its id is what an experiment names.
 * - **"Drawn once" is the seed.** The same request (the same scenario, the same population version) has the same seed unless the caller gives
 *   one, and the job queue deduplicates the same scenario at the same seed, so asking again returns the record already made instead of
 *   another sample; another record is another seed, stated.
 * - **A record is made from a generated population or from the model.** With a population version, the covariates it names by column (the MMSE,
 *   age, ApoE4 allele count and sex columns) are that population's, verbatim; the others, the study and the individual parameters are drawn.
 *   An observed cohort is never turned into virtual patients: its rows would be written under the derived tree the engine's user can read.
 * - **A model change marks the record, it does not erase it.** A record names the parameter set it was made for. When the engine carries
 *   another one (`VCR_PROGRESSION_PARAMETER_SETS`), the record reads `current: false` ("made for an earlier model") and a run on it still runs
 *   and says so, the way a patient set's readiness reads a changed model (`vcrPopulationBinding.mjs`).
 *
 * @module vcrPeople
 */

import { createHash } from "node:crypto";
import { VCR_PEOPLE_MODES, VCR_PROGRESSION_PARAMETER_SETS, canonicalScenarioJson } from "@evimed/domain";

/** The table the engine writes. */
export const VCR_PEOPLE_TABLE = "progression-people";
const ALLOWED = new Set(["n", "populationId", "columns", "population", "uncertainty", "seed"]);
const COLUMN_KEYS = ["mmse", "age", "apoe4", "female"];
const UNCERTAINTY = ["new_study", "typical_study"];
/** @param {unknown} value */
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
/** @param {unknown} value */
const list = (value) => (Array.isArray(value) ? value : []);
/** @param {string} text */
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/**
 * The job that makes a record: its scenario, the population table it reads (`derived`), what to keep, a seed and the identity it is filed under.
 * @param {unknown} input what a caller states: `n`, or `populationId` with `columns`; optional `population` overrides (the model's covariate
 *   model otherwise), `uncertainty` (`new_study` or `typical_study`) and `seed`
 * @param {{ populationId: string, populationVersion: number, resultId: string, table: string, inputId: string } | null} generation the
 *   generated table of the named population version (`vcrPopulationGenerationInput`), when one is named
 * @returns {{ issues: Array<{ code: string, field: string, detail: string }>, request: null | { scenario: Record<string, any>,
 *   derived: Array<{ resultId: string, table: string }>, detail: Record<string, any>, seed: number, identity: string } }}
 */
export function vcrPeopleInstantiateRequest(input, generation) {
  /** @type {Array<{ code: string, field: string, detail: string }>} */
  const issues = [];
  const bad = (/** @type {string} */ field, /** @type {string} */ detail, code = "people_value_invalid") => { issues.push({ code, field, detail }); };
  const asked = object(input);
  for (const key of Object.keys(asked)) if (!ALLOWED.has(key)) bad(key, "A record of people is made from n, a populationId with its columns, population overrides, uncertainty and a seed.", "people_field_unknown");
  const n = asked.n;
  if (n !== undefined && !(Number.isInteger(n) && n >= 2 && n <= 50_000)) bad("n", "The number of people is a whole number from 2 to 50,000.");
  if (asked.populationId !== undefined && !generation) bad("populationId", "This population version has no generated people to take covariates from (an observed cohort is never turned into virtual patients).", "people_population_unusable");
  if (asked.populationId === undefined && n === undefined) bad("n", "State how many people, or a population version to take them from.", "people_field_missing");
  const columns = object(asked.columns);
  if (asked.populationId !== undefined) {
    if (!Object.keys(columns).length) bad("columns", `Name the population's columns for at least one of ${COLUMN_KEYS.join(", ")}.`, "people_field_missing");
    for (const [key, value] of Object.entries(columns)) {
      if (!COLUMN_KEYS.includes(key)) bad(`columns.${key}`, `A column is named for one of ${COLUMN_KEYS.join(", ")}.`, "people_field_unknown");
      else if (typeof value !== "string" || !value) bad(`columns.${key}`, "A column is named by its name in the population table.");
    }
  } else if (asked.columns !== undefined) bad("columns", "Columns belong to a population version.", "people_field_unknown");
  if (asked.uncertainty !== undefined && !UNCERTAINTY.includes(asked.uncertainty)) bad("uncertainty", `A record is one study's: ${UNCERTAINTY.join(" or ")}.`);
  if (asked.seed !== undefined && !(Number.isInteger(asked.seed) && asked.seed >= 0 && asked.seed < 2 ** 31 - 1)) bad("seed", "A seed is a whole number below 2147483647.");
  if (issues.length) return { issues, request: null };
  const [set, version] = Object.entries(VCR_PROGRESSION_PARAMETER_SETS)[0];
  const instantiate = generation
    ? { covariates: { inputId: generation.inputId, columns: Object.fromEntries(COLUMN_KEYS.filter((key) => columns[key]).map((key) => [key, columns[key]])) } }
    : { n };
  const scenario = { timeUnit: "weeks", model: { family: "beta_logit", parameterSet: { id: set, version }, ...(asked.uncertainty ? { uncertainty: asked.uncertainty } : {}) },
    instantiate, ...(asked.population ? { population: asked.population } : {}) };
  const identity = sha256(canonicalScenarioJson({ scenario, population: generation ? { id: generation.populationId, version: generation.populationVersion, resultId: generation.resultId } : null })).slice(0, 24);
  const seed = Number.isInteger(asked.seed) ? Number(asked.seed) : Number.parseInt(identity.slice(0, 8), 16) % (2 ** 31 - 1);
  return { issues, request: { scenario, derived: generation ? [{ resultId: generation.resultId, table: generation.table }] : [], seed, identity,
    detail: { resultKind: "experiment_candidate", subjectId: `people:${identity}`, keepTables: [VCR_PEOPLE_TABLE],
      people: { populationId: generation?.populationId ?? null, populationVersion: generation?.populationVersion ?? null } } } };
}

/**
 * Whether a result is a record of people, and what it says of itself. Never reads the table: the people stay in the data plane.
 * @param {Record<string, any> | null | undefined} result
 * @returns {null | { id: string, createdAt: string | null, people: number, uncertainty: string | null, parameterSet: { id: string, version: string } | null,
 *   current: boolean, outsideFittedMmse: number, fittedMmse: number[] | null, covariatesFrom: string | null, tableSha256: string | null }}
 */
export function vcrPeopleRecordView(result) {
  const progression = object(object(result?.diagnostics).progression);
  if (!result || progression.instantiate !== true) return null;
  const table = list(result.tables).map(object).find((entry) => entry.name === VCR_PEOPLE_TABLE && String(entry.location ?? "").startsWith("derived/"));
  if (!table) return null;
  const set = object(progression.parameterSet);
  const made = set.id ? { id: String(set.id), version: String(set.version ?? "") } : null;
  return { id: String(result.id), createdAt: result.createdAt ?? null, people: Number(progression.people ?? 0), uncertainty: progression.uncertainty ?? null, parameterSet: made,
    current: made !== null && /** @type {Record<string, string>} */ (VCR_PROGRESSION_PARAMETER_SETS)[made.id] === made.version,
    outsideFittedMmse: Number(progression.outsideFittedMmse ?? 0), fittedMmse: Array.isArray(progression.fittedMmse) ? progression.fittedMmse.map(Number) : null,
    covariatesFrom: progression.covariatesFrom ?? null, tableSha256: table.sha256 ? String(table.sha256) : null };
}

/**
 * A plain start of a disease-progression simulation that names a record of virtual people (`people: { recordId, mode }`): the same fields a comparison
 * carries, bound the same way, so one start on a record is one arm of a comparison on it. The people are the record's, so a scenario that states
 * its own people, population or study-level uncertainty is refused by name; a paired run is on everyone in the record, so the arm's own group
 * sizes are not carried. The seed is a function of the record and the mode alone, so two starts that differ only in the drug draw the same people,
 * dropout and residuals and their difference is the drug's.
 * @param {Record<string, any>} scenario @param {unknown} people the call's `people`
 * @returns {{ ok: true, scenario: Record<string, any>, derived: Array<{ resultId: string, table: string, shape: string }>, recordId: string, mode: string, seed: number }
 *   | { ok: false, issues: Array<{ code: string, field: string, detail: string }> }}
 */
export function vcrPeopleStartBinding(scenario, people) {
  const asked = object(people);
  const recordId = typeof asked.recordId === "string" ? asked.recordId : "";
  /** @type {Array<{ code: string, field: string, detail: string }>} */
  const issues = [];
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,120}$/.test(recordId)) issues.push({ code: "start_people_invalid", field: "people.recordId", detail: "The record of people is named by the id its instantiate step answered with." });
  if (!VCR_PEOPLE_MODES.includes(asked.mode)) issues.push({ code: "start_people_invalid", field: "people.mode", detail: `A run on a record is ${VCR_PEOPLE_MODES.join(" or ")}.` });
  for (const key of Object.keys(asked)) if (key !== "recordId" && key !== "mode") issues.push({ code: "start_people_invalid", field: `people.${key}`, detail: "people is { recordId, mode } and nothing else." });
  for (const key of ["population", "people", "instantiate"]) {
    if (scenario[key] !== undefined) issues.push({ code: "start_people_conflict", field: `scenario.${key}`, detail: "A start on a record of people takes the people from the record: the scenario does not state them." });
  }
  if (object(scenario.model).uncertainty !== undefined) issues.push({ code: "start_people_conflict", field: "scenario.model.uncertainty", detail: "A run on a record is on the study the record was made in; the study is not drawn again." });
  if (issues.length) return { ok: false, issues };
  const mode = String(asked.mode);
  const { design: _sizes, ...withoutSizes } = scenario;
  const bound = { ...(mode === "paired_counterfactual" ? withoutSizes : scenario), people: { inputId: `${recordId}:${VCR_PEOPLE_TABLE}`, mode } };
  const seed = Number.parseInt(sha256(`start-on-people|${recordId}|${mode}`).slice(0, 8), 16) % (2 ** 31 - 1);
  return { ok: true, scenario: bound, derived: [{ resultId: recordId, table: VCR_PEOPLE_TABLE, shape: "subject" }], recordId, mode, seed };
}
