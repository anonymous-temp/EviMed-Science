/**
 * What the comparison page says of a bias analysis (algorithm round C1, C2, 2026-11-03): the result of a `bias_analysis` job, and how
 * the estimate it analyses is taken from a saved comparison.
 *
 * A bias analysis is a stage of a comparison (like the tipping-point analysis of the missing outcomes) or, when the call states its own
 * estimate and names no comparison, a comparison of its own (like a stand-alone E-value). Either way the comparator tab reads it from
 * `diagnostics.biasAnalysis` of the result it is filed under. This module turns the engine's record into the card's payload and is the
 * only place that knows the words.
 *
 * Hidden knowledge:
 *
 * - **The card opens with the question a person asked**, not the method: "未测混杂要造成多大的偏移，结论才翻". Each part under it opens
 *   with its own question, and a part the call did not ask for is not on the card (the tipping bias is always there; it needs no parameter).
 * - **The estimate is taken by code, never copied by the model.** `vcrBiasEstimateOf` reads the ratio (or the difference) and its interval
 *   from the saved comparison's result in a fixed order of preference; the call that names a comparison and states no estimate gets exactly
 *   those numbers, and a call that states its own estimate keeps it. The reply that said an E-value of 3.0 where the page read 2.22
 *   (2026-11-02) is the failure this closes.
 * - **Every number is a `VcrValue`** (`measureValue`): the percentage, the Monte-Carlo error of a simulated one, the source word. The
 *   numbers of the closed-form parts are `calculated`; the probabilistic ones are `simulated` and carry their error.
 * - **A bias is always the one that exaggerates the observed effect.** The words say "夸大" and give a ratio of at least 1 (an amount of at
 *   least 0 on the difference scale); the direction of a confounder is named by the arm that carries more of it.
 *
 * @module vcrBiasAnalysis
 */

import { list, numeric, object } from "./vcrViewsKit.mjs";

/** The measures of a saved result that are a ratio, in the order they are preferred, with the scale they are on. */
const RATIO_MEASURES = Object.freeze(/** @type {const} */ ([
  ["hazard_ratio", "hazard_ratio"], ["aipw_risk_ratio", "risk_ratio"], ["weighted_risk_ratio", "risk_ratio"],
  ["aipw_odds_ratio", "odds_ratio"], ["weighted_odds_ratio", "odds_ratio"],
  // a target-trial emulation's risk ratios: the intention-to-treat one first (the analysis that asks nothing of the censoring), then the per-protocol one
  ["risk_ratio_itt", "risk_ratio"], ["risk_ratio_pp", "risk_ratio"], ["risk_ratio_start", "risk_ratio"],
]));
/** The measures that are a difference, and a target-trial emulation's risk differences in the same order. */
const DIFFERENCE_MEASURES = Object.freeze(["rmst_difference", "aipw_difference", "weighted_difference", "risk_difference_itt", "risk_difference_pp", "risk_difference_start"]);

const SCALE_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({ hazard_ratio: "风险比（HR）", risk_ratio: "相对危险度（RR）", odds_ratio: "比值比（OR）", difference: "差值" }));

/** @param {number} value @param {number} [digits] */
const plain = (value, digits = 3) => String(Number(value.toPrecision(digits)));

/**
 * The estimate of a saved result that a bias analysis can take, and its interval: a ratio on its own scale, or a difference. `null` when
 * the result holds none (a result with no effect measure, or one whose interval is missing).
 * @param {Record<string, any> | null | undefined} result
 * @returns {{ scale: string, estimate: number, lower: number, upper: number, measure: string, level: number } | null}
 */
export function vcrBiasEstimateOf(result) {
  // The comparison's own estimate is its primary analysis's: a comparison filed in stages also holds the other stages' numbers (a restricted
  // mean, a tipping point), and a result that holds no record of its stages is read whole.
  const primary = object(object(object(object(result).diagnostics).stageResults).primary);
  const measures = list(Object.keys(primary).length ? primary.measures : object(result).measures).map(object);
  const diagnostics = object(Object.keys(primary).length ? { ...object(object(result).diagnostics), ...object(primary.diagnostics) } : object(result).diagnostics);
  /** @param {string} name */
  const found = (name) => measures.find((measure) => measure.name === name && numeric(measure.value) !== null && numeric(object(measure.interval).low) !== null && numeric(object(measure.interval).high) !== null);
  for (const [name, scale] of RATIO_MEASURES) {
    const measure = found(name);
    if (measure && Number(measure.value) > 0 && Number(measure.interval.low) > 0) {
      return { scale, estimate: Number(measure.value), lower: Number(measure.interval.low), upper: Number(measure.interval.high), measure: name, level: numeric(measure.interval.level) ?? 0.95 };
    }
  }
  for (const name of DIFFERENCE_MEASURES) {
    const measure = found(name);
    if (measure) return { scale: "difference", estimate: Number(measure.value), lower: Number(measure.interval.low), upper: Number(measure.interval.high), measure: name, level: numeric(measure.interval.level) ?? 0.95 };
  }
  // A simulated treatment comparison states its estimate on the link scale: a logit-link contrast is a log odds ratio, a log-link one a log risk ratio.
  const indirect = found("indirect_estimate");
  if (indirect && (diagnostics.method === "g_computation")) {
    const link = String(diagnostics.link ?? "");
    const level = numeric(indirect.interval.level) ?? 0.95;
    if (link === "logit" || link === "log") {
      return { scale: link === "logit" ? "odds_ratio" : "risk_ratio", estimate: Math.exp(Number(indirect.value)), lower: Math.exp(Number(indirect.interval.low)), upper: Math.exp(Number(indirect.interval.high)), measure: "indirect_estimate", level };
    }
    return { scale: "difference", estimate: Number(indirect.value), lower: Number(indirect.interval.low), upper: Number(indirect.interval.high), measure: "indirect_estimate", level };
  }
  return null;
}

/**
 * A bias analysis that names a saved comparison and states no estimate takes the comparison's own: the scenario gets `scale`, `estimate`,
 * `lower`, `upper` (and `confidenceLevel` when the interval is not 95%) from its current result. A call that states an estimate is
 * left as it is, and so is one that names nothing (the validator then says which key is missing). A comparison with no usable result
 * is refused by name, with what to do about it.
 *
 * @param {{ store: any, study: { id: string }, subjectId?: string | null, scenario: Record<string, any> }} input
 * @returns {Promise<{ scenario: Record<string, any>, from: { resultId: string, measure: string } | null } | { refused: { code: string, message: string } }>}
 */
export async function vcrBiasScenarioFromComparison({ store, study, subjectId = null, scenario }) {
  if (scenario.estimate !== undefined || !subjectId) return { scenario, from: null };
  const comparison = list(await store.comparatorDesigns(study.id, 200)).map(object).find((entry) => entry.id === subjectId);
  if (!comparison) return { scenario, from: null };
  const result = comparison.resultId ? await store.result(study.id, String(comparison.resultId)) : null;
  const taken = result ? vcrBiasEstimateOf(result) : null;
  if (!taken) {
    // An estimate with an interval whose scale the result does not say (an indirect comparison by matching) is a different refusal from no estimate at all
    const primary = object(object(object(object(result).diagnostics).stageResults).primary);
    const unscaled = list(Object.keys(primary).length ? primary.measures : object(result).measures).map(object)
      .some((measure) => numeric(measure.value) !== null && numeric(object(measure.interval).low) !== null && numeric(object(measure.interval).high) !== null);
    return { refused: { code: "vcr_job_scenario_invalid",
      message: unscaled
        ? "这个对照的估计没有写明它是比值还是差值：在场景里写明 scale，以及 estimate 和区间（lower、upper）。"
        : "这个对照还没有可以做偏倚分析的效应估计（需要比值或差值，以及它的区间）：先算出对照的结果，或者在场景里写明 scale、estimate 和区间（lower、upper）。" } };
  }
  const { scale, estimate, lower, upper, level } = taken;
  return { scenario: { ...scenario, scale, estimate, lower, upper, ...(Math.abs(level - 0.95) > 1e-9 ? { confidenceLevel: level } : {}) },
    from: { resultId: String(result.id), measure: taken.measure } };
}

/** The estimate a bias analysis analysed, in one phrase: "风险比（HR） 0.7（95% 区间 0.5–0.98）". @param {Record<string, any>} diagnostics */
export function biasEstimatePhrase(diagnostics) {
  const given = object(diagnostics.given);
  const estimate = numeric(given.estimate);
  const interval = list(given.interval).map(numeric);
  if (estimate === null) return null;
  // the level the interval was stated at (`given.confidenceLevel`, written when the call gave an interval); an estimate taken from a saved result at 90% is not a 95% one
  const level = numeric(given.confidenceLevel);
  const range = interval.length === 2 && interval[0] !== null && interval[1] !== null ? `（${plain((level !== null && level > 0 && level < 1 ? level : 0.95) * 100)}% 区间 ${plain(interval[0])}–${plain(interval[1])}）` : "";
  return `${SCALE_WORDS[String(diagnostics.scale)] ?? "估计值"} ${plain(estimate)}${range}`;
}

/** A stated distribution in words. @param {Record<string, any>} dist @param {boolean} [ratio] */
function distributionWords(dist, ratio = false) {
  const n = (/** @type {string} */ key) => numeric(dist[key]);
  switch (String(dist.family)) {
    case "constant": return `固定为 ${plain(Number(n("value")))}`;
    case "uniform": return `在 ${plain(Number(n("min")))} 到 ${plain(Number(n("max")))} 之间均匀分布`;
    case "triangular": return `三角分布，${plain(Number(n("min")))} 到 ${plain(Number(n("max")))}，最可能 ${plain(Number(n("mode")))}`;
    case "normal": return ratio ? `对数尺度上正态，均值 ${plain(Number(n("mean")))}、标准差 ${plain(Number(n("sd")))}` : `正态，均值 ${plain(Number(n("mean")))}、标准差 ${plain(Number(n("sd")))}`;
    case "lognormal": return `对数正态，中位数 ${plain(Number(n("median")))}、对数标准差 ${plain(Number(n("sdlog")))}`;
    default: return "";
  }
}

/**
 * The bias the person stated for the probabilistic analysis, in a sentence for the premises; `null` when there is none.
 * @param {Record<string, any>} diagnostics the result's `diagnostics.biasAnalysis`
 */
export function biasStatedWords(diagnostics) {
  const stated = object(object(diagnostics.probabilistic).stated);
  const ratio = String(diagnostics.scale) !== "difference";
  if (stated.bias) return `偏倚${ratio ? "倍数" : "量"}${distributionWords(object(stated.bias), ratio)}`;
  const confounder = object(stated.confounder);
  if (!Object.keys(confounder).length) return null;
  return [`混杂因素在试验组的比例${distributionWords(object(confounder.exposedPrevalence))}`, `在对照组的比例${distributionWords(object(confounder.unexposedPrevalence))}`,
    `与结局的关联${distributionWords(object(confounder.association), ratio)}`].join("；");
}

/**
 * The card of a bias analysis on the comparator tab.
 * @param {Record<string, any> | null} result the result the page shows
 * @param {(measure: any) => any} value the page's `VcrValue` maker for a measure of that result
 * @returns {Record<string, any> | null}
 */
export function presentBiasAnalysis(result, value) {
  const diagnostics = object(object(result?.diagnostics).biasAnalysis);
  if (!Object.keys(diagnostics).length) return null;
  const ratio = String(diagnostics.scale) !== "difference";
  const nullWord = ratio ? "无效线（1）" : "无效线（0）";
  const calculated = (/** @type {string} */ name, /** @type {unknown} */ number) => (numeric(number) === null ? null : value({ name, value: Number(number), simulated: false, source: "calculated" }));
  const measureOf = (/** @type {string} */ name) => list(result?.measures).map(object).find((measure) => measure.name === name);
  const bias = (/** @type {number} */ x) => (ratio ? `${plain(x)} 倍` : plain(x));
  const tipping = object(diagnostics.tipping);

  const tippingPart = {
    question: "未测混杂要造成多大的偏移，结论才翻？",
    sentence: tipping.alreadyIncludesNull === true
      ? `这个估计的区间本来就包含${nullWord}，不需要任何偏倚结论就站不住；要让估计值本身碰到${nullWord}，偏倚要把效应夸大 ${bias(Number(tipping.estimate))}。`
      : `偏倚要把效应夸大 ${bias(Number(tipping.limit))}，区间靠近${nullWord}的那一端才碰到${nullWord}，结论就翻；要让估计值本身碰到${nullWord}，需要夸大 ${bias(Number(tipping.estimate))}。`,
    limit: calculated("bias_tipping_limit", tipping.limit),
    estimate: calculated("bias_tipping_estimate", tipping.estimate),
    alreadyIncludesNull: tipping.alreadyIncludesNull === true,
  };

  const shifted = list(object(diagnostics.shiftedNull).rows).map(object);
  const shiftedPart = shifted.length ? {
    question: "如果偏倚真有这么大，效应还站得住吗？",
    rows: shifted.map((row) => ({
      bias: bias(Number(row.bias)),
      adjusted: calculated("bias_shifted_estimate", row.adjustedEstimate),
      lower: calculated("bias_shifted_estimate", row.lower),
      upper: calculated("bias_shifted_estimate", row.upper),
      p: calculated("bias_shifted_p", row.p),
      holds: row.excludesNull === true,
      sentence: row.excludesNull === true ? `去掉${bias(Number(row.bias))}的偏倚后，区间仍不含${nullWord}` : `去掉${bias(Number(row.bias))}的偏倚后，区间已含${nullWord}，结论站不住`,
    })),
    note: "检验的是“效应不超过这个偏倚”（单侧）；P 值小说明效应大到单靠这个偏倚解释不了。",
  } : null;

  const confounderRows = list(object(diagnostics.confounderTipping).rows).map(object);
  const baseline = numeric(object(diagnostics.confounderTipping).baselinePrevalence) ?? 0;
  const sideWord = (/** @type {string} */ carrier) => (carrier === "treated" ? "试验组" : "对照组");
  /** @param {Record<string, any> | null} row @param {string} what */
  const tippingRow = (row, what) => {
    if (!row || !Object.keys(row).length) return null;
    return {
      what, carrier: sideWord(String(row.carrier)), feasible: row.feasible === true,
      carrierPrevalence: calculated("bias_confounder_prevalence", row.carrierPrevalence),
      difference: calculated("bias_confounder_prevalence", row.prevalenceDifference),
      standardized: calculated("bias_confounder_standardized", row.standardizedDifference),
      sentence: row.feasible === true
        ? `该混杂因素在${sideWord(String(row.carrier))}要比另一组多 ${plain(Number(row.prevalenceDifference) * 100)} 个百分点（${plain(Number(row.carrierPrevalence) * 100)}%）`
        : "需要的比例超过 100%，这样的混杂因素不存在",
    };
  };
  const confounderPart = confounderRows.length ? {
    question: "要多不均衡、多强的混杂因素，才能把结论翻过来？",
    baseline: calculated("bias_confounder_prevalence", baseline),
    rows: confounderRows.map((row) => ({
      association: calculated("bias_confounder_association", row.association),
      estimate: tippingRow(object(row.estimate), "翻转估计值"),
      limit: tippingRow(object(row.limit), "翻转区间"),
    })),
    note: `混杂因素与结局的关联越强，需要的不均衡越小；另一组中该因素的比例按 ${plain(baseline * 100)}% 计${baseline === 0 ? "（这时所需的差异最小）" : ""}。`,
  } : null;

  const prob = object(diagnostics.probabilistic);
  const adjusted = measureOf("bias_adjusted_estimate");
  const persists = measureOf("bias_adjusted_effect_persists");
  const sys = object(prob.systematic);
  const probabilisticPart = adjusted && persists ? {
    question: "按你设定的偏倚范围，校正后的效应和区间是多少？",
    stated: biasStatedWords(diagnostics),
    adjusted: value(adjusted),
    persists: value(persists),
    systematic: { median: calculated("bias_adjusted_estimate", sys.median), lower: calculated("bias_adjusted_estimate", sys.low), upper: calculated("bias_adjusted_estimate", sys.high) },
    draws: numeric(prob.draws),
    interrupted: typeof prob.interrupted === "string" ? "模拟被计算预算截断，只用了跑完的几批" : null,
    note: "区间包含抽样误差；只含偏倚的区间在下面单独列出。",
  } : null;

  return {
    question: tippingPart.question,
    estimate: biasEstimatePhrase(diagnostics),
    direction: ratio ? "这里的偏倚都是把效应夸大的偏倚：去掉它，估计值向无效线靠近。" : "这里的偏倚都是把差值夸大的偏倚：去掉它，差值向 0 靠近。",
    tipping: tippingPart,
    shiftedNull: shiftedPart,
    confounder: confounderPart,
    probabilistic: probabilisticPart,
  };
}
