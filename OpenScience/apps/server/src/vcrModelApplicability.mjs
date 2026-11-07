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
 * - **Findings are two lists, not a verdict.** `vcrModelApplicabilityAssessment` splits them: what makes this calculation
 *   impossible (a card short of its contract, a field the population lacks, an endpoint the model does not produce, more
 *   trajectories than it holds) refuses it, and a range the model was fitted on or a horizon beyond what it declares is a
 *   premise the result page says in one sentence. `vcrModelApplicabilityIssues` keeps returning every finding, as before.
 *   The evidence of use (validated population, endpoint, horizon, independent data) is the domain's `assessModelUse`, read from
 *   what the card holds in `card.useEvidence` (a list of `{ mode, population, endpoint, horizonHours, evidenceRef, independent }`);
 *   a card with none is not asked for it.
 * - It sits in its own module so the model analysis documents can ask the same
 *   question the planner does, without the documents importing the orchestrator.
 *
 * @module vcrModelApplicability
 */

import { assessModelUse, vcrEventHistoryScopeIssues, vcrMechanisticRuntimeIssues, vcrModelCardIssues } from "@evimed/domain";

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
  if (endpointType && !declared.length && !model.endpointType) {
    issues.push({ code: "endpoint_not_covered", field: "endpoint.type", text: "模型未声明覆盖的终点，尚不能判断是否适用于本研究。" });
  } else if (endpointType && declared.length && !declared.includes(endpointType)) {
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

/**
 * What each finding of the domain's use check says to a reader: a sentence that names the question it answers. Premises read as
 * what the result may be taken to mean, refusals as what to supply; neither names a code, a tool or a job.
 */
export const VCR_USE_TEXT_ZH = Object.freeze({
  adapter_unavailable: "这个模型目前没有可执行的计算程序，无法为它算出结果。",
  mode_unknown: "没有说明要做哪一种预测，无法开始计算。",
  mode_not_executable: "这个模型不能做所要求的这种预测。",
  intervention_input_unavailable: "这个模型没有可以放入治疗或干预的输入，无法做治疗比较。",
  output_not_produced: "这个模型不产出所要求的结果量。",
  invalid_parameters: "给定的参数在数学上不成立（不是有限数、为负或超出取值范围），这一项算不了。",
  units_not_convertible: "给定的单位无法互相换算，这一项算不了。",
  authorization_lost: "模型、来源或数据的使用授权已经撤回，这一项不能再算。",
  runtime_limit_exceeded: "超出了计算环境声明的上限，这一项算不了。",
  runtime_unavailable: "这个机理模型需要的求解器没有安装在计算环境里，这一项算不了。",
  use_not_validated: "这个模型尚未验证过这种用途；结果表示在所列模型假设下可能怎样变化。",
  population_outside_validation: "这个模型验证过的人群不包括这一次的人群；结果是把模型用到了它验证范围之外。",
  endpoint_outside_validation: "这个模型验证过的终点不包括这一次的终点；结果是把模型用到了它验证范围之外。",
  horizon_beyond_validation: "这次推演的时间比模型验证过的更长；超出的部分是外推。",
  no_independent_data: "这个模型的验证没有用到独立于建模的数据。",
  provenance_missing: "模型说明里的验证没有注明出处，不能当作验证。",
});

/** @param {{ code: string, field: string, detail?: string, text?: string }} finding */
const withText = (finding) => ({ ...finding, text: finding.text ?? /** @type {Record<string, string>} */ (VCR_USE_TEXT_ZH)[finding.code] ?? finding.detail ?? "" });

/** Findings that are a premise of the answer, not a reason it cannot be computed: the model runs outside what it was fitted on. */
const PREMISE_CODES = new Set(["input_out_of_range", "horizon_exceeded"]);

/**
 * The model row read as the domain's pack: what it can execute and what it was validated on, from the card's own metadata.
 * A card that declares none of it gives a pack that fails and says nothing, which is what an old card is.
 * @param {Record<string, any>} model a row of the model library
 * @returns {Record<string, any>}
 */
export function vcrModelPackOf(model) {
  const card = object(model.card);
  return {
    ...(typeof card.executable === "boolean" ? { executable: card.executable } : {}),
    ...(Array.isArray(card.executableModes) ? { executableModes: card.executableModes } : {}),
    ...(Array.isArray(card.outputList) ? { outputs: card.outputList } : {}),
    ...(Array.isArray(card.useEvidence) ? { validation: card.useEvidence } : {}),
    ...(card.limits && typeof card.limits === "object" ? { limits: card.limits } : {}),
  };
}

/**
 * Every finding about whether a model answers for a study, split into what refuses this calculation and what the result says.
 * @param {Record<string, any>} model
 * @param {Parameters<typeof vcrModelApplicabilityIssues>[1] & { mode?: string, population?: string, endpoint?: string, horizonHours?: number,
 *   authorized?: boolean, installedPackages?: Iterable<string> }} study
 * @returns {{ executionIssues: Array<{ code: string, field: string, text?: string, detail?: string }>,
 *   premises: Array<{ code: string, field: string, text?: string, detail?: string }> }}
 */
export function vcrModelApplicabilityAssessment(model, study) {
  const legacy = vcrModelApplicabilityIssues(model, study);
  const use = assessModelUse(vcrModelPackOf(model), {
    mode: study.mode ?? "conditional_forecast", population: study.population, endpoint: study.endpoint ?? study.endpointType ?? undefined,
    horizonHours: study.horizonHours, authorized: study.authorized,
  });
  const mechanism = object(model.card).mechanism ? vcrMechanisticRuntimeIssues(object(object(model.card).mechanism), study.installedPackages ?? []) : [];
  return {
    executionIssues: [...legacy.filter((issue) => !PREMISE_CODES.has(issue.code)), ...use.executionIssues, ...mechanism].map(withText),
    premises: [...legacy.filter((issue) => PREMISE_CODES.has(issue.code)), ...use.premises].map(withText),
  };
}

/**
 * What refuses this calculation; a premise never does. Callers that used to refuse on any finding refuse on these.
 * @param {Record<string, any>} model @param {Parameters<typeof vcrModelApplicabilityAssessment>[1]} study
 */
export function vcrModelExecutionIssues(model, study) {
  return vcrModelApplicabilityAssessment(model, study).executionIssues;
}
