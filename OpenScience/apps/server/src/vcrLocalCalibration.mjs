/**
 * The local calibration of an applied published model, as the comparison page prints it (remediation plan D3).
 *
 * The engine (`model.prognostic_apply` 1.1.0) holds the applied equation against the outcome the table itself has and reports the
 * calibration intercept and slope with intervals, the observed and the predicted risk and the reason for anything it did not compute.
 * This module only puts them in the page's words: a number is a number with the ideal beside it (an intercept of 0, a slope of 1), and
 * a missing one says what it needed. Whether the equation is calibrated enough is not decided here, and neither is it by the engine:
 * the conclusion stays limited and the interval is for the reader.
 *
 * @module vcrLocalCalibration
 */

import { VCR_LOCAL_CALIBRATION_MIN } from "@evimed/domain";

const object = (/** @type {unknown} */ value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
const finite = (/** @type {unknown} */ value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** What an estimate is, once: a value and its interval, or nothing. @param {unknown} raw */
function estimateOf(raw) {
  const entry = object(raw);
  const value = finite(entry.value);
  if (value === null) return null;
  return { value, low: finite(entry.low), high: finite(entry.high) };
}

const SLOPE_WHY = Object.freeze(/** @type {Record<string, (c: Record<string, any>) => string>} */ ({
  too_few_events: (c) => c.family === "cox"
    ? `斜率没有算：事件太少（至少要 ${VCR_LOCAL_CALIBRATION_MIN.slopeEvents} 个，这里 ${finite(c.events) ?? 0} 个）`
    : `斜率没有算：事件或非事件太少（各至少要 ${VCR_LOCAL_CALIBRATION_MIN.slopeEvents} 个，这里 ${finite(c.events) ?? 0} 个事件、${finite(c.nonEvents) ?? 0} 个非事件）`,
  too_few_pairs: (c) => `斜率没有算：成对的预测值和观察值太少（至少要 ${VCR_LOCAL_CALIBRATION_MIN.slopePairs} 对，这里 ${finite(c.n) ?? 0} 对）`,
  predictions_do_not_vary: () => "斜率没有算：所有预测值都一样，没有可比较的跨度",
  model_did_not_converge: () => "斜率没有算：拟合没有收敛",
  no_events: () => "斜率没有算：这张表里没有人发生事件",
  no_non_events: () => "斜率没有算：这张表里每个人都发生了事件",
}));
const INTERCEPT_WHY = Object.freeze(/** @type {Record<string, (c: Record<string, any>) => string>} */ ({
  no_events: () => "截距没有算：这张表里没有人发生事件，只能比较观察到的和预测的风险",
  no_non_events: () => "截距没有算：这张表里每个人都发生了事件，只能比较观察到的和预测的风险",
  too_few_pairs: () => "截距没有算：成对的预测值和观察值太少",
  model_did_not_converge: () => "截距没有算：拟合没有收敛",
  // a time-to-event outcome has the in-the-large difference instead, which the rows below carry
  not_defined_for_time_to_event: () => "",
}));
const RISK_WHY = Object.freeze(/** @type {Record<string, string>} */ ({
  no_baseline_risk: "观察到的风险没有算：方程没有基线风险，只有相对评分，不能比较绝对风险",
  horizon_beyond_follow_up: "观察到的风险没有算：随访没有到预测的时间点",
  too_few_events: "观察到的风险没有算：事件太少",
}));

/**
 * @param {unknown} raw `diagnostics.localCalibration`
 * @returns {null | {
 *   n: number | null, events: number | null, nonEvents: number | null,
 *   observedRisk: number | null, predictedRisk: number | null, calibrationInLarge: number | null,
 *   intercept: { value: number, low: number | null, high: number | null } | null,
 *   slope: { value: number, low: number | null, high: number | null } | null,
 *   notes: string[] }}
 */
export function localCalibrationView(raw) {
  const c = object(raw);
  if (!Object.keys(c).length) return null;
  const linear = c.family === "linear";
  const intercept = estimateOf(c.intercept);
  const slope = estimateOf(c.slope);
  const notes = [];
  if (!intercept && typeof c.interceptUnavailable === "string") {
    const words = INTERCEPT_WHY[c.interceptUnavailable]?.(c);
    if (words) notes.push(words);
  }
  if (!slope && typeof c.slopeUnavailable === "string" && c.slopeUnavailable !== c.interceptUnavailable) {
    const words = SLOPE_WHY[c.slopeUnavailable]?.(c);
    if (words) notes.push(words);
  }
  if (typeof c.observedRiskUnavailable === "string" && RISK_WHY[c.observedRiskUnavailable]) notes.push(RISK_WHY[c.observedRiskUnavailable]);
  return {
    n: finite(c.n), events: finite(c.events), nonEvents: finite(c.nonEvents),
    // a linear model's observed and predicted values are means of the outcome, not risks; the same two numbers in the same two slots
    observedRisk: finite(linear ? c.observedMean : c.observedRisk), predictedRisk: finite(linear ? c.predictedMean : c.predictedRisk),
    calibrationInLarge: finite(c.calibrationInLarge), intercept, slope, notes,
  };
}
