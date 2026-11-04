/**
 * What a result page says of a spline survival fit (algorithm round C13, 2026-11-03): the `spline` family of `model.survival_fit`.
 *
 * Hidden knowledge:
 *
 * - **The page answers one question**: 「风险曲线不单调时，长期生存和 RMST 是多少？」. The median, the survival at each time and the restricted
 *   mean to the last time come with their intervals, and each time says how many times the longest follow-up it is: a number beyond the data is
 *   an extrapolation along a straight line in log time on the log cumulative hazard, and the page says so beside the number.
 * - **The spread over the numbers of knots is shown, the interval is not widened by it.** The fit's interval is the sampling error of the one
 *   curve; what a different number of knots gives at the last time is the model-form uncertainty, and it is a range the reader sees next to it.
 * - **「这个结论的前提」 has three decisive rows**: how far beyond the data the last time lies, how flexible the curve was allowed to be (and what
 *   the others give), and the shape the model assumes beyond the last knot. Nothing about tools, packages or the fit's internals.
 *
 * @module vcrSplineFit
 */

import { TIME_UNIT_WORDS, list, markFor, measureValue, numeric, object } from "./vcrViewsKit.mjs";
import { finishPremises } from "./vcrPremises.mjs";

/** @param {number} value @param {number} [digits] */
const plain = (value, digits = 3) => String(Number(value.toPrecision(digits)));

/**
 * @param {Record<string, any> | null | undefined} result the saved fit
 * @param {(measure: Record<string, any>) => unknown} value measure -> the page's VcrValue
 */
export function presentSplineFit(result, value) {
  const diagnostics = object(result?.diagnostics);
  const model = object(diagnostics.model);
  if (object(model.distribution).kind !== "spline") return null;
  const unitWord = TIME_UNIT_WORDS[String(diagnostics.timeUnit)]?.after ?? "";
  // the fit is as observed as its table was: every number carries the source the engine gave the fit
  const source = String(list(result?.measures).map(object).find((measure) => measure.name === "fitted_median")?.source ?? "observed");
  const exact = (/** @type {string} */ name, /** @type {unknown} */ number, /** @type {Record<string, unknown>} */ more = {}) =>
    (numeric(number) === null ? null : value({ name, value: Number(number), simulated: false, source, ...more }));
  const interval = (/** @type {unknown} */ low, /** @type {unknown} */ high) => (numeric(low) === null || numeric(high) === null ? {} : { interval: { kind: "confidence", low: Number(low), high: Number(high), level: 0.95 } });
  const measureOf = (/** @type {string} */ name) => list(result?.measures).map(object).find((measure) => measure.name === name);
  const medianMeasure = object(measureOf("fitted_median"));
  const rmst = object(model.rmst);
  const extrapolation = object(model.extrapolation);
  const longest = numeric(model.maxObservedTime);
  const tau = numeric(extrapolation.lastHorizon);
  const times = numeric(extrapolation.timesLongestFollowUp);
  const beyond = extrapolation.beyondData === true;

  const curve = list(model.curve).map(object).map((point) => ({
    time: Number(point.time), timeWords: `${plain(Number(point.time))}${unitWord}`,
    survival: exact("survival_probability", point.survival, interval(point.lower, point.upper)),
    beyondData: point.extrapolated === true,
    timesLongestFollowUp: numeric(point.timesLongestFollowUp),
  }));

  const specs = list(model.specifications).map(object).map((spec) => ({
    knots: Number(spec.knots), selected: spec.selected === true, estimable: spec.estimable === true,
    aic: numeric(spec.aic), median: exact("fitted_median", spec.median), rmst: exact("restricted_mean_survival_time", spec.rmst),
    survival: exact("survival_probability", spec.survival),
  }));
  const survivals = specs.filter((spec) => spec.estimable).map((spec) => numeric(object(spec.survival).value)).filter((x) => x !== null).map(Number);
  const range = survivals.length > 1 ? { low: Math.min(...survivals), high: Math.max(...survivals) } : null;

  const knots = Number(object(model.distribution).knots);
  const knotTimes = list(object(model.spline).knotTimes).map(numeric).filter((x) => x !== null).map(Number);
  /** @type {Array<Record<string, any>>} */
  const rows = [];
  if (tau !== null && longest !== null) {
    rows.push({ key: "splineBeyond", label: "最后一个时间点离数据有多远",
      value: beyond
        ? `${plain(tau)}${unitWord}，是最长随访 ${plain(longest)}${unitWord}的 ${plain(times ?? tau / longest)} 倍；超出随访的部分没有观察到的人，是按模型外推的`
        : `${plain(tau)}${unitWord}，没有超出最长随访 ${plain(longest)}${unitWord}`,
      source: "default", decisive: true });
  }
  const medianValue = numeric(medianMeasure.value);
  if (model.medianBeyondData === true && medianValue !== null && longest !== null) {
    // the fitted median is read off the curve; past the longest follow-up nobody observed it (review stats2 finding 7)
    rows.push({ key: "splineMedianBeyond", label: "生存中位时间离数据有多远",
      value: `${plain(medianValue)}${unitWord}，是最长随访 ${plain(longest)}${unitWord}的 ${plain(numeric(model.medianTimesLongestFollowUp) ?? medianValue / longest)} 倍；随访里没有人观察到它，是按曲线外推的`,
      source: "default", decisive: true });
  }
  rows.push({ key: "splineKnots", label: "曲线的灵活程度",
    value: `${knots} 个内部结点${knotTimes.length > 2 ? `（在 ${knotTimes.slice(1, -1).map((x) => plain(x)).join("、")}${unitWord}处）` : ""}${range ? `；换成 0 到 3 个结点，最后一个时间点的生存率在 ${plain(range.low * 100)}% 到 ${plain(range.high * 100)}% 之间` : ""}`,
    source: "given", decisive: true });
  rows.push({ key: "splineTail", label: "最后一个结点之后的形状",
    value: "对数累积风险随对数时间走直线（相当于韦伯分布的尾部）；真实的风险未必如此", source: "default", decisive: true });

  return {
    question: "风险曲线不单调时，长期生存和 RMST 是多少？",
    median: exact("fitted_median", medianMeasure.value, { unit: diagnostics.timeUnit, ...interval(object(medianMeasure.interval).low, object(medianMeasure.interval).high) }),
    rmst: rmst.value === undefined ? null : { tau: numeric(rmst.tau), tauWords: `${plain(Number(rmst.tau))}${unitWord}`,
      value: exact("restricted_mean_survival_time", rmst.value, { unit: diagnostics.timeUnit, ...interval(rmst.lower, rmst.upper) }) },
    curve,
    longestFollowUp: longest === null ? null : `${plain(longest)}${unitWord}`,
    specifications: specs,
    note: "区间只含这一条曲线的抽样误差；不同结点数给出的差别是模型形式带来的不确定性，没有算进区间。",
    premises: finishPremises(rows),
  };
}

/**
 * The spline fits the patients tab shows: the study's current survival fits (one per result, newest first) that used the spline family, each
 * with the card and premises of `presentSplineFit`. A fit made from a conversation reached the page only from the method workbench; the
 * model's reply says the page puts the premises beside the number, so the page that the reply links to must (review RF2 P1-5).
 * @param {Record<string, any>} bundle the patients tab's bundle (`allResults`, `stale`)
 * @param {{ nodeOf: (result: Record<string, any>) => string }} helpers
 */
export function presentSplineFits(bundle, { nodeOf }) {
  const results = list(bundle.allResults ?? bundle.results).map(object).filter((row) => row.kind === "model_fit" && !row.supersededBy)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 4);
  return results.map((result) => {
    const staleMark = markFor(bundle.stale ?? [], nodeOf(result));
    const block = presentSplineFit(result, (measure) => measureValue(measure, { kind: "model_fit", result, tab: "patients", staleMark }));
    return block ? { id: String(result.id), version: Number(result.version), ...block, stale: Boolean(staleMark) } : null;
  }).filter(Boolean);
}
