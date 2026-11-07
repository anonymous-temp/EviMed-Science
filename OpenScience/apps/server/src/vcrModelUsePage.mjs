/**
 * What the one 「这个结论的前提」 block says about the model behind a page's result (in silico plan section 6, S5 NEEDS item 3).
 *
 * Hidden knowledge:
 *
 * - **Every page that shows a model-based result asks the same question the same way**: the model the result names is looked up in
 *   the library the page already holds and put through the domain's use check (`vcrModelApplicabilityAssessment`); its premises are
 *   the `input.modelUse` that `vcrPremises` and `finishPremises` turn into sentences. A model the library no longer holds, or a card
 *   that declares nothing to be held against, gives no sentence: there is nothing to say, and nothing is invented.
 * - **Premises never remove a result.** Only `premises` are returned here; the execution issues belong to the run that already
 *   happened (or was refused with its reason) and are not shown a second time.
 * - **Pure.** The library rows come from the page's bundle.
 *
 * @module vcrModelUsePage
 */

import { vcrModelApplicabilityAssessment } from "./vcrModelApplicability.mjs";
import { finishPremises, modelUsePremises } from "./vcrPremises.mjs";
import { list, object, text } from "./vcrViewsKit.mjs";

/**
 * The library row a result names: by id or name and, when the result names one, version.
 * @param {readonly Record<string, any>[]} models @param {Record<string, any> | null | undefined} named `{ id?, name?, version? }`
 */
export function modelNamedBy(models, named) {
  const ref = object(named);
  const key = text(ref.id) ?? text(ref.name);
  if (!key) return null;
  const version = ref.version == null ? null : String(ref.version);
  return list(models).find((model) => (model.id === key || model.name === key) && (!version || String(model.version) === version)) ?? null;
}

/**
 * The use check's premises for a model-based result.
 * @param {readonly Record<string, any>[]} models the library rows the page holds
 * @param {Record<string, any> | null | undefined} named the model the result names
 * @param {{ mode?: string, endpoint?: string | null, population?: string | null, horizonHours?: number | null }} [use]
 *   what the result was asked of the model; a field not stated is not held against it
 * @returns {Array<{ code: string, field: string }>}
 */
export function modelUseOf(models, named, use = {}) {
  const model = modelNamedBy(models, named);
  if (!model) return [];
  return vcrModelApplicabilityAssessment(model, {
    endpointType: use.endpoint ?? null, variables: new Map(), mode: use.mode ?? "conditional_forecast",
    ...(use.endpoint ? { endpoint: use.endpoint } : {}), ...(use.population ? { population: use.population } : {}),
    ...(Number.isFinite(use.horizonHours) ? { horizonHours: /** @type {number} */ (use.horizonHours) } : {}),
  }).premises;
}

/**
 * The premises block of a page that shows a model's result and nothing else the shared builder reads (the patients page).
 * @param {readonly Record<string, any>[]} models @param {Record<string, any> | null | undefined} named @param {Parameters<typeof modelUseOf>[2]} [use]
 */
export const modelUsePremisesOf = (models, named, use) => finishPremises(modelUsePremises(modelUseOf(models, named, use)));
