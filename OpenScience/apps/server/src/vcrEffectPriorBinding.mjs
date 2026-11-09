/**
 * The drug effect of the Alzheimer simulation taken from a pooling the study already holds (plan R31, tier C, 2026-11-09): how a scenario names a
 * result as the source of its effect and how the control plane turns that into the frozen distribution.
 *
 * A scenario states `treatment.effectFrom: { input, target?, estimand? }`; `input` is the id of one of the call's `result` inputs
 * (`result:<id>@<version>`, the lineage node written by `lineageNode`). Enqueue reads the result through the store's guarded read, asks the domain
 * for the prior (`vcrEffectPriorFromPool`), writes it into the scenario where the model reads it (`treatment.symptomatic.pointsAt` or
 * `treatment.diseaseModifying.fraction`, as a distribution of tier C) and removes `effectFrom`, so the engine receives a scenario it already
 * understands and the same pooling is the same job.
 *
 * Hidden knowledge:
 *
 * - **The lineage rides on the job, not in the scenario.** The job's checkpoint names the result (`resultLineage`), and the store judges the job's
 *   result again on every read through the result it was made from (`VcrStore.#inLineage`): a pooling whose lineage was withdrawn, or that is gone,
 *   takes everything made from it with it, like every other lineage, so a frozen scenario cannot keep a withdrawn source alive.
 * - **Only a verified pooling is a source.** The result must be the study's own and the output of the pooling method with a receipt that verifies
 *   (the same test a saved model result passes before it is a design's baseline); a result of any other method is refused by name, and a pooling on
 *   a log or logit scale is refused by the domain, each with its reason and nothing else lost.
 * - **A named version is that version.** The node says which version of the result was meant; a result that has moved on is not silently substituted.
 * - **The estimand is the researcher's words.** The source may answer another question than this study asks; the premise says so (ICH E9(R1) A.4),
 *   and a source that stated none is used and says it did not.
 * - **A conflict is refused, never merged.** A scenario that also states the number the pooling would give is refused by name: the model never
 *   picks between two effects.
 *
 * @module vcrEffectPriorBinding
 */

import { VCR_EFFECT_PRIOR_TARGETS, lineageNode, parseLineageNode, vcrEffectPriorFromPool } from "@evimed/domain";
import { HttpError } from "./security.mjs";
import { VCR_SCHEMA } from "./vcrPersistence.mjs";
import { vcrExecutionReceiptVerified } from "./vcrEngineClient.mjs";

/** @param {unknown} value */
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
/** @param {string} detail @param {string} field @param {string} code */
const refuse = (detail, field, code) => {
  const error = new HttpError(400, "vcr_job_scenario_invalid", `作业不符合引擎协议：${field}（${code}）。`);
  /** @type {any} */ (error).issues = [{ code, field, detail }];
  return error;
};

/** Where each target sits in the scenario. */
const TARGET_PATH = Object.freeze(/** @type {Record<string, [string, string]>} */ ({
  symptomatic_points: ["symptomatic", "pointsAt"], disease_modifying_fraction: ["diseaseModifying", "fraction"],
}));

/**
 * @param {{ store: { result: (studyId: string, id: string) => Promise<any>, one: (sql: string, params: unknown[]) => Promise<any> }, studyId: string,
 *   scenario: Record<string, any>, inputs: unknown[] }} input `inputs` is what the caller sent (before resolution)
 * @returns {Promise<{ scenario: Record<string, any>, detail: Record<string, any> }>} the scenario with the effect written in (or the same one when it
 *   names no source) and what the job records of it
 */
export async function bindVcrEffectPrior({ store, studyId, scenario, inputs }) {
  const treatment = object(scenario.treatment);
  if (treatment.effectFrom === undefined) return { scenario, detail: {} };
  const from = object(treatment.effectFrom);
  const allowed = new Set(["input", "target", "estimand"]);
  for (const key of Object.keys(from)) if (!allowed.has(key)) throw refuse("effectFrom is { input, target, estimand } and nothing else.", `scenario.treatment.effectFrom.${key}`, "scenario_field_unknown");
  const target = from.target ?? "symptomatic_points";
  if (!VCR_EFFECT_PRIOR_TARGETS.includes(target)) throw refuse(`target is one of: ${VCR_EFFECT_PRIOR_TARGETS.join(", ")}.`, "scenario.treatment.effectFrom.target", "effect_prior_target_unknown");
  if (from.estimand !== undefined && typeof from.estimand !== "string" && (typeof from.estimand !== "object" || from.estimand === null || Array.isArray(from.estimand))) {
    throw refuse("estimand is the researcher's words: a sentence, or { treatment, population, endpoint, strategy, summary } of sentences.", "scenario.treatment.effectFrom.estimand", "scenario_value_invalid");
  }
  const named = typeof from.input === "string" ? from.input : "";
  const entry = (Array.isArray(inputs) ? inputs : []).map(object).find((item) => item.kind === "result" && item.id === named);
  if (!entry) throw refuse("effectFrom.input names one of the call's inputs of kind result (`result:<id>@<version>`).", "scenario.treatment.effectFrom.input", "effect_prior_input_missing");
  const node = parseLineageNode(named);
  if (!node || node.kind !== "result") throw refuse("The input is a result node, `result:<id>@<version>`.", "scenario.treatment.effectFrom.input", "effect_prior_input_missing");
  const [group, key] = TARGET_PATH[target];
  const slot = object(treatment[group]);
  if (slot[key] !== undefined) throw refuse(`The scenario states treatment.${group}.${key} and also takes it from a result; give one of them.`, `scenario.treatment.${group}.${key}`, "effect_prior_conflict");
  if (treatment.reference !== undefined || treatment.mechanism !== undefined) {
    throw refuse("An effect from a result is the effect itself: it is not combined with a reference drug or a mechanism chain.", "scenario.treatment", "effect_prior_conflict");
  }

  const result = await store.result(studyId, node.id);
  if (!result) throw new HttpError(404, "vcr_effect_prior_unavailable", "这个研究里没有这项汇总结果，或它已不可读（来源被撤回）。");
  if (Number(result.version) !== node.version) {
    throw new HttpError(409, "vcr_effect_prior_version_changed", "所选汇总结果已更新到另一个版本：请使用当前版本，不会悄悄换用。");
  }
  const execution = result.executionId
    ? await store.one(`SELECT method, receipt, output_hash FROM ${VCR_SCHEMA}.executions WHERE id = $1 AND study_id = $2`, [result.executionId, studyId]) : null;
  if (execution?.method !== "evidence.pool" || !vcrExecutionReceiptVerified(execution)) {
    throw new HttpError(400, "vcr_effect_prior_not_a_pooling", "药效先验只能取自本研究一次已核验的证据汇总结果。");
  }
  const prior = vcrEffectPriorFromPool(result, { target, estimand: from.estimand });
  if (prior.ok === false) {
    const error = new HttpError(400, "vcr_effect_prior_refused", `这项汇总结果不能作为药效先验：${prior.detail}`);
    /** @type {any} */ (error).issues = [{ code: prior.reason, field: "scenario.treatment.effectFrom.input", detail: prior.detail }];
    throw error;
  }
  // the note is what a person reads of where the effect came from: the researcher's words for the estimand, and no id
  const note = `已汇总的研究；它们回答的估计目标：${prior.estimand.stated ? prior.estimand.text : "没有说明"}`.slice(0, 300);
  const distribution = { ...prior.distribution, source: { ...prior.distribution.source, note } };
  const { effectFrom: _named, ...rest } = treatment;
  const next = { ...scenario, treatment: { ...rest, [group]: { ...slot, [key]: { distribution } } } };
  return {
    scenario: next,
    detail: {
      // the lineage the store judges again on every read of the job's result (`#inLineage`)
      resultLineage: [String(result.id)],
      effectPrior: { resultId: String(result.id), resultVersion: Number(result.version), node: lineageNode("result", String(result.id), Number(result.version)),
        target, basis: prior.basis, estimandStated: prior.estimand.stated, premises: prior.premises },
    },
  };
}
