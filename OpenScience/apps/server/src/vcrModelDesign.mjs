/** Deterministic adapters from saved scientific results to control-design parameters. */
import { lineageNode } from '@evimed/domain';
import { HttpError } from './security.mjs';
/** @param {any} value @returns {Record<string,any>} */
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
/** @param {string} message @returns {never} */
const fail = message => { throw new HttpError(400, 'vcr_model_not_applicable', message); };
/** @param {any} result @param {string} name */
const measure = (result, name) => (result.measures ?? []).find(row => row.name === name)?.value;

/** No treatment effect is inferred from a control prediction or a survival fit.
 * @param {any} result @param {any} scenario @param {string} quantile
 */
export function vcrModelDesignBinding(result, scenario, quantile = 'p50') {
  if (!result?.executionId || result.conclusion === 'not_estimable') fail('Select an estimable saved fit or prediction result.');
  const diag = object(result.diagnostics); const type = scenario.endpoint?.type;
  const single = ['single_arm', 'simon_two_stage'].includes(scenario.design?.kind);
  /** @type {Record<string,any>} */ let truth = {}; let basis;
  if (diag.fitted === true && diag.modelScope === 'population_baseline') {
    if (type !== 'time_to_event' || scenario.timeUnit !== diag.timeUnit) fail('The fitted baseline and design need the same endpoint and time unit.');
    if (!['control', 'natural_history', 'standard_care'].includes(diag.sourceCondition) || !diag.armSelection?.column) fail('The fit has no explicit source-condition and arm selection for a control baseline.');
    const variant = object(diag.model?.baselineParameterScenarios)[quantile];
    if (!['p10', 'p50', 'p90'].includes(quantile) || !variant) fail('Select one R-computed baseline parameter quantile.');
    if (!['exponential', 'weibull'].includes(variant.controlDistribution?.kind)) fail('This fitted curve is retained, but its distribution has no design adapter.');
    truth = { controlDistribution: structuredClone(variant.controlDistribution) };
    basis = { quantile, median: variant.median, method: diag.model.medianParameterQuantileBasis,
      uncertainty: 'Median-parameter sensitivity with fitted shape fixed; not joint parameter uncertainty or assurance.' };
  } else if (diag.modelScope === 'published_prognostic_equation') {
    if (quantile !== 'p50') fail('Published fixed-coefficient predictions have no parameter-quantile uncertainty model.');
    if (diag.absoluteRiskAvailable !== true || diag.endpoint?.type !== type) fail('Relative scores or a different endpoint cannot supply an absolute control benchmark.');
    if (scenario.endpoint?.horizon !== diag.endpoint.horizon || scenario.endpoint?.timeUnit !== diag.endpoint.timeUnit) fail('The prediction and design need the same declared horizon and unit.');
    const mean = measure(result, 'predicted_population_mean');
    if (!Number.isFinite(mean)) fail('The saved prediction has no estimable population mean.');
    if (type === 'binary') truth = { [single ? 'nullRate' : 'controlRate']: mean };
    else if (type === 'continuous') {
      const sd = measure(result, 'predicted_outcome_sd');
      if (diag.populationVarianceIncludesResidual !== true || !(sd > 0)) fail('Continuous design requires an outcome SD including the published residual variance.');
      truth = { sd, ...(single ? { benchmark: mean } : {}) };
    } else fail('One predicted survival risk does not identify a full time-to-event control distribution.');
    basis = { quantile: null, horizon: diag.endpoint.horizon, timeUnit: diag.endpoint.timeUnit,
      populationMean: mean, uncertainty: 'Fixed published coefficients; coefficient uncertainty and transportability not estimated.' };
  } else fail('This saved result has no supported control-design adapter.');
  const next = { ...scenario, endpoint: { type }, truth: { ...object(scenario.truth), ...truth } };
  if (truth.controlDistribution) delete next.truth.controlMedian;
  return { scenario: next, lockedPaths: [...Object.keys(truth).map(key => `truth.${key}`), ...(truth.controlDistribution ? ["truth.controlMedian"] : [])], provenance: {
    resultId: result.id, resultVersion: result.version, executionId: result.executionId, sourceModel: diag.sourceModel ?? null,
    populationId: diag.populationSelection?.populationId ?? null, populationVersion: diag.populationSelection?.populationVersion ?? null,
    sourceCondition: diag.sourceCondition, sourceKind: diag.modelScope, ...basis,
    interpretation: 'Control-baseline scenario comparison. Treatment effects require separate evidence or an explicit assumption.',
    causalEffectIdentified: false, clinicallyValidated: false, assurance: false,
  } };
}

/** Resolve only a saved subject's immutable result reference; caller numbers cannot replace its baseline.
 * @param {{store:any,study:any,subject:any,scenario:any,inputs:any[]}} input
 */
export async function prepareVcrModelDesign({ store, study, subject, scenario, inputs }) {
  const configuration = object(subject?.row?.configuration);
  if (subject?.objectKind !== 'trial_scenario' || !configuration.modelResultId) return { scenario, inputs, detail: {} };
  const result = await readVcrModelDesignResult(store, study.id, String(configuration.modelResultId));
  if (!result || result.version !== configuration.modelResultVersion) fail('The exact saved model result version is unavailable in this study.');
  const bound = vcrModelDesignBinding(result, scenario, configuration.modelParameterQuantile ?? 'p50');
  const { modelResultId: _result, modelResultVersion: _version, modelParameterQuantile: _quantile, ...executable } = bound.scenario;
  return { scenario: executable, inputs: [...inputs, { kind: 'evidence', id: lineageNode('result', result.id, result.version), value: bound.provenance }],
    detail: { modelDesign: bound.provenance } };
}

/** A model result is evidence only when its saved execution is the verified scientific method.
 * @param {any} store @param {string} studyId @param {string} resultId
 */
export async function readVcrModelDesignResult(store, studyId, resultId) {
  const result = await store.result(studyId, resultId);
  const execution = result?.executionId ? await store.one('SELECT method,receipt FROM evimed_vcr.executions WHERE id=$1 AND study_id=$2', [result.executionId, studyId]) : null;
  if (!['model.survival_fit', 'model.prognostic_apply'].includes(execution?.method) || object(execution?.receipt).signed !== true) fail('Select a verified saved scientific model result from this study.');
  return result;
}
