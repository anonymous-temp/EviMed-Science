/**
 * Can this model answer for this study? The control plane's port of the
 * engine's applicability check (`R/quality.R`), read from the model's own card
 * and held against what the study has.
 *
 * Hidden knowledge:
 *
 * - **A model answers only for what it declares it covers.** What a card says
 *   (its endpoint types, the fields it needs, the ranges it was fitted on) is
 *   held against what the study has (the endpoint it asks about, the variables
 *   its population carries and the bounds it states). An empty list means
 *   nothing was found against it; a model of the first call shape with no
 *   declaration has none to fail.
 * - **The second call shape is checked against its contract first.** A model
 *   whose card says `interfaceShape: event_history_to_trajectories` must hold
 *   the card `vcrModelCardIssues` lists (what it reads, what it returns, where
 *   it holds, what it was validated on, where it fails). A card short of it is
 *   reported field by field, because a model that does not say what it covers
 *   cannot be held against what a study asks; its scope — the events it
 *   projects, the longest horizon, the most trajectories — is then checked
 *   against what the study states.
 * - **Nothing here refuses a study.** The caller decides what an issue means
 *   (the orchestrator refuses the patient set that names the model and goes on
 *   with everything else; the document says it in the 评估 section).
 * - It sits in its own module so the model analysis documents can ask the same
 *   question the planner does, without the documents importing the orchestrator.
 *
 * @module vcrModelApplicability
 */

import { vcrEventHistoryScopeIssues, vcrModelCardIssues } from "@evimed/domain";

/** @param {unknown} value */
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
/** @param {unknown} value */
const list = (value) => (Array.isArray(value) ? value : []);

/**
 * The variables a population carries, by name, with the bounds it states for them
 * (`min`/`max` of a bounded variable) — read from whichever shape the population
 * step stored: a scenario population's variable list, a literature population's
 * baseline table, a built cohort's profile rows.
 * @param {Record<string, any> | null | undefined} population
 * @returns {Map<string, { min: number | null, max: number | null }>}
 */
export function vcrPopulationVariables(population) {
  /** @type {Map<string, { min: number | null, max: number | null }>} */
  const found = new Map();
  const bound = (/** @type {unknown} */ value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const put = (/** @type {unknown} */ name, /** @type {Record<string, any>} */ entry) => {
    if (typeof name === "string" && name) found.set(name, { min: bound(entry.min), max: bound(entry.max) });
  };
  const definition = object(object(population).definition);
  for (const variable of list(object(definition.population).variables)) put(object(variable).name, object(variable));
  for (const row of list(definition.baselineTable)) put(object(row).variable, object(row));
  const profile = object(object(population).profile);
  for (const row of list(profile.rows ?? profile.covariates ?? (Array.isArray(profile) ? profile : []))) put(object(row).key ?? object(row).covariate, object(row));
  return found;
}

/**
 * Can this model answer for this study? An empty list means nothing was found
 * against it.
 * @param {Record<string, any>} model a row of the model library
 * @param {{ endpointType: string | null, variables: Map<string, { min: number | null, max: number | null }>,
 *   horizon?: { value: number, unit: string } | null, eventTypes?: readonly string[], trajectories?: number | null }} study
 *   `horizon`, `eventTypes` and `trajectories` are what a study asks of a model of the event-history shape; a limit the study
 *   does not state is not checked.
 * @returns {Array<{ code: string, field: string, text: string }>}
 */
export function vcrModelApplicabilityIssues(model, { endpointType, variables, horizon = null, eventTypes = [], trajectories = null }) {
  /** @type {Array<{ code: string, field: string, text: string }>} */
  const issues = [...vcrModelCardIssues(model)];
  const applicability = object(model.applicability);
  const card = object(model.card);
  const declared = list(applicability.endpoints).map(String);
  if (endpointType && declared.length && !declared.includes(endpointType)) {
    issues.push({ code: "endpoint_not_covered", field: "endpoint.type", text: `它只覆盖 ${declared.join("、")} 终点，这个研究的终点是 ${endpointType}` });
  } else if (endpointType && !declared.length && model.endpointType && String(model.endpointType) !== endpointType) {
    issues.push({ code: "endpoint_not_covered", field: "endpoint.type", text: `它是 ${model.endpointType} 终点的模型，这个研究的终点是 ${endpointType}` });
  }
  for (const field of list(applicability.requiredFields ?? card.requiredFields).map(String)) {
    if (!variables.has(field)) issues.push({ code: "required_field_missing", field, text: `它需要「${field}」，研究的人群里没有这个变量` });
  }
  for (const [field, range] of Object.entries(object(applicability.inputRanges ?? card.inputRanges))) {
    const limits = list(range).map(Number);
    const seen = variables.get(field);
    if (!seen || limits.length < 2 || !limits.every(Number.isFinite)) continue;
    if ((seen.min !== null && seen.min < limits[0]) || (seen.max !== null && seen.max > limits[1])) {
      issues.push({ code: "input_out_of_range", field, text: `「${field}」在人群里的取值范围超出了它声明的 ${limits[0]}–${limits[1]}` });
    }
  }
  issues.push(...vcrEventHistoryScopeIssues(model, { horizon, eventTypes, trajectories }));
  return issues;
}
