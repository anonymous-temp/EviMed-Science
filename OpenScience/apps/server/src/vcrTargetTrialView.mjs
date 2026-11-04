/**
 * What the comparison page says of a target-trial emulation (algorithm round C3, C4, 2026-11-03): the question a person asked, which estimand was
 * computed (intention to treat or per protocol, the risk difference after how many periods), and the two arms' risks beside it.
 *
 * The engine writes the numbers (`diagnostics.targetTrial`: the estimands, the design and the checks of the table, the weights' summary); the risk curves are
 * `diagnostics.curves`, which the comparator tab draws as it draws any curve. This is the only place that words them.
 *
 * Hidden knowledge:
 *
 * - **The first sentence of the card is the person's question**, in plain words, and the second says which number answers it: "第 12 期末的累积风险差，
 *   按方案". The estimand is never left to be inferred from a measure's name: a result with both estimands has two blocks, each opening with what it
 *   ignores or corrects.
 * - **The naive comparison is on the card as a warning about the data, not as a result**: the same cohort split by whether a person ever started treatment
 *   shows a larger benefit when treatment takes time to start, because to start it a person has to be alive. It is worded as that and carries no interval.
 * - **Every number is a `VcrValue`**: the risks and their difference through the page's own value maker (percent, interval, source word).
 *
 * @module vcrTargetTrialView
 */

import { list, numeric, object } from "./vcrViewsKit.mjs";

/** @param {number} value @param {number} [digits] */
const plain = (value, digits = 3) => String(Number(value.toPrecision(digits)));
/** @param {number} value */
const percent = (value) => `${plain(value * 100, 3)}%`;

/** The periods as a person says them: "12 周" with a unit, "12 期" without. @param {number} n @param {string | null} unit */
function periodsWords(n, unit) {
  const words = /** @type {Record<string, string>} */ ({ days: "天", weeks: "周", months: "个月", years: "年" });
  return unit && words[unit] ? `${n} ${words[unit]}` : `${n} 期`;
}

/** @type {Record<string, { label: string, meaning: string }>} */
const ESTIMAND_WORDS = Object.freeze({
  itt: { label: "意向治疗", meaning: "按每个试验开始时的治疗分组算，开始之后治疗有没有变都不管" },
  pp: { label: "按方案", meaning: "一个人的治疗偏离了所在组，就在那一期删失，并按实际接受的治疗加权，补回被删失的人" },
  // a clone-censor-weight design: it reads when treatment started and nothing after it (a person who starts and then stops is still "started"), so it is not a per-protocol estimand
  start: { label: "宽限期内开始治疗", meaning: "只看治疗有没有在宽限期内开始，开始之后是否一直在用不管；到期还没开始的人被当作偏离策略并按权重补回" },
});

/**
 * @param {Record<string, any> | null} result the result the page shows
 * @param {(measure: any) => any} value the page's `VcrValue` maker for a measure of that result
 * @returns {Record<string, any> | null}
 */
export function presentTargetTrial(result, value) {
  const diagnostics = object(object(result).diagnostics);
  const tt = object(diagnostics.targetTrial);
  if (!Object.keys(tt).length) return null;
  const strategy = String(tt.strategy ?? "");
  const horizon = numeric(tt.horizon);
  const unit = tt.periodUnit ? String(tt.periodUnit) : null;
  const measures = list(object(result).measures).map(object);
  const find = (/** @type {string} */ name) => measures.find((entry) => entry.name === name);
  const design = object(tt.design);
  const checks = object(tt.checks);
  const when = horizon === null ? "" : `第 ${periodsWords(horizon, unit)}`;
  const grace = numeric(design.gracePeriod);
  const question = strategy === "clone_censor_weight"
    ? `符合条件后 ${grace === null ? "一段宽限期" : periodsWords(grace, unit)}内开始治疗，与不开始治疗相比，效应是多少？`
    : "治疗起始时间各不相同的队列，开始治疗和不开始治疗的效应是多少，而且没有永恒时间偏倚？";
  const estimands = list(tt.estimands).map(object).flatMap((entry) => {
    const kind = entry.kind === "itt" ? "itt" : entry.kind === "pp" ? "pp" : entry.kind === "start" ? "start" : null;
    if (!kind) return [];
    const words = ESTIMAND_WORDS[kind];
    const t = find(`risk_treated_${kind}`);
    const c = find(`risk_control_${kind}`);
    const d = find(`risk_difference_${kind}`);
    if (!d) return [];
    const rr = find(`risk_ratio_${kind}`);
    return [{
      kind, label: words.label, meaning: words.meaning,
      answers: `${when}末的累积风险差 = 试验组风险 − 对照组风险（${words.label}）`,
      riskTreated: t ? value(t) : null, riskControl: c ? value(c) : null, riskDifference: value(d), riskRatio: rr ? value(rr) : null,
    }];
  });
  if (!estimands.length) return null;
  const sentence = strategy === "clone_censor_weight"
    ? `每个人从符合条件的第一期起同时放进“宽限期内开始治疗”和“不开始治疗”两组：宽限期的最后一期开始时还没开始治疗的人，在“开始”组里被删失；开始了治疗的人，在“不开始”组里被删失；被删失造成的偏差用权重补回。算的是${when}末的风险差：宽限期内开始治疗，对始终不开始。`
    : `每一期符合条件的人都开一个模拟试验，当期是否在治疗决定分组，一个人可以进多个试验，区间按人重抽样。算的是${when}末的风险差：${estimands.map((entry) => entry.label).join("和")}。`;
  /** @type {string[]} */
  const checkSentences = [];
  const cut = numeric(checks.recordsCutShort);
  if (cut !== null && cut > 0) checkSentences.push(`${cut} 个人的记录在事件之后、缺失值或间断的那一期截断了，随访只算到那里（没有补任何值）。`);
  const treatedAtStart = numeric(checks.eligibleAlreadyTreated);
  if (treatedAtStart !== null && treatedAtStart > 0) checkSentences.push(`符合条件的人-期里，开始时就已经在治疗的占 ${percent(treatedAtStart)}${strategy === "clone_censor_weight" ? "，他们算作宽限期内开始" : "，他们进入试验组"}。`);
  if (strategy === "clone_censor_weight") {
    const wait = object(design.waitingTime);
    if (numeric(wait.median) !== null) checkSentences.push(`开始治疗的人中，从时间零点到开始的中位等待时间是 ${periodsWords(Number(wait.median), unit)}：这段时间里他们不可能出现要比较的事件，所以只按“用过药没有”分组会高估治疗的好处。`);
    const naive = object(design.naive);
    const naiveMeasure = numeric(naive.difference) === null ? null : { name: "risk_difference_pp", value: naive.difference, simulated: false, source: "calculated" };
    // the people treated before time zero are said only when there are some (an older result has no such count)
    const before = numeric(design.treatedBeforeTimeZero);
    const people = [["宽限期内开始", design.startedWithinGrace], ["宽限期后才开始", design.startedAfterGrace], ["始终没有开始", design.neverStarted], ...(before !== null && before > 0 ? [["时间零点之前用过药、之后没再用", before]] : [])]
      .filter(([, n]) => numeric(n) !== null).map(([label, n]) => `${label} ${numeric(n)} 人`);
    if (people.length) checkSentences.push(`${people.join("，")}。`);
    if (design.horizonInsideGracePeriod === true && grace !== null && horizon !== null) {
      checkSentences.push(`随访终点（${when}）还在宽限期（${periodsWords(grace, unit)}）之内：试验组里没有人因为没开始治疗而被删失，它的风险就是不加干预的自然进程，不是“宽限期内开始治疗”的风险；把随访终点放到宽限期之后再读。`);
    }
    checkSentences.push(...armsWithoutEventsSentences(tt));
    return {
      question, sentence, strategy, horizon: horizon, estimands, checks: checkSentences,
      naive: naiveMeasure ? value(naiveMeasure) : null,
      naiveSentence: naiveMeasure ? "只按“后来有没有用过药”分组的朴素风险差：用来看等待时间造成的偏差，不是结果。" : null,
      weights: weightsSentence(object(design.weights).control, object(design.weights).treated),
      bootstrap: bootstrapSentence(object(tt.bootstrap), result),
    };
  }
  for (const entry of list(tt.droppedEstimands).map(object)) {
    const arm = entry.arm === "treated" ? "试验组" : "对照组";
    checkSentences.push(`按方案的结果没有给出：${arm}里没有人在方案上待满 ${horizon === null ? "" : periodsWords(horizon, unit)}（最长 ${numeric(entry.longestOnProtocol) ?? "?"} 期），读到那一期的按方案风险只会是模型外推出来的；意向治疗的结果照常给出。`);
  }
  checkSentences.push(...armsWithoutEventsSentences(tt));
  if (numeric(design.personTrials) !== null) checkSentences.push(`共 ${numeric(design.personTrials)} 个模拟试验（每个符合条件的人-期一个），展开成 ${numeric(design.expandedRows)} 行随访记录。`);
  return {
    question, sentence, strategy, horizon, estimands, checks: checkSentences, naive: null, naiveSentence: null,
    weights: weightsSentence(object(object(tt.weights).summary)),
    bootstrap: bootstrapSentence(object(tt.bootstrap), result),
  };
}

/**
 * The stabilised weights, in a sentence a reader can act on; null when the estimand used none. A clone-censor-weight design has two arms' weights
 * and says both (the second arm's can be the large ones).
 * @param {Record<string, any>} summary the first (or only) set of weights
 * @param {Record<string, any>} [other] the second arm's, when there is one
 */
function weightsSentence(summary, other) {
  const mean = numeric(summary.mean);
  if (mean === null) return null;
  const range = (/** @type {Record<string, any>} */ w) => `平均 ${plain(Number(w.mean))}，范围 ${plain(Number(w.min))} 到 ${plain(Number(w.max))}`;
  if (other && numeric(other.mean) !== null) return `补回删失的权重（稳定化）：始终不开始的一组${range(summary)}；宽限期内开始的一组${range(other)}。`;
  return `补回删失的权重（稳定化）${range(summary)}。`;
}

/**
 * An arm with no event at all, in a sentence: its risk is "no higher than about" the exact upper limit, and the resampling interval of the risk, of the
 * difference and of the ratio is not drawn.
 * @param {Record<string, any>} tt the result's target-trial block
 * @returns {string[]}
 */
function armsWithoutEventsSentences(tt) {
  return list(tt.armsWithoutEvents).map(object).flatMap((entry) => list(entry.arms).map(String).map((arm) => {
    const upper = object(object(entry.upperLimits)[arm]);
    const risk = numeric(upper.risk);
    const people = numeric(upper.n);
    return `${arm === "treated" ? "试验组" : "对照组"}一例事件也没有：它的风险只能说不高于大约 ${risk === null ? "?" : percent(risk)}${people === null ? "" : `（${people} 人里 0 例的 95% 上限）`}，所以风险差和风险比的区间没有给出，读它们要当作方向而不是精确的数。`;
  }));
}

/** How many resamples the interval stands on, in a sentence. @param {Record<string, any>} bootstrap @param {Record<string, any> | null} result */
function bootstrapSentence(bootstrap, result) {
  const draws = numeric(object(object(result).diagnostics).bootstrapReplicates) ?? numeric(bootstrap.replicates);
  if (draws === null) return null;
  const requested = numeric(bootstrap.requested);
  return requested !== null && draws < requested
    ? `区间来自对人的整条记录重抽样 ${draws} 次（计划 ${requested} 次，计算时间用完了），比计划的粗。`
    : `区间来自对人的整条记录重抽样 ${draws} 次，每次重新估计权重和结局模型。`;
}

/**
 * The premises a target-trial emulation rests on, in the rows of the page's block: which strategy, what follow-up means, and what the weights assume.
 * @param {Record<string, any> | null | undefined} diagnostics the result's diagnostics
 * @returns {Array<{ key: string, label: string, value: string, source: 'assumed' | 'default', decisive: boolean }>}
 */
export function targetTrialPremises(diagnostics) {
  const tt = object(object(diagnostics).targetTrial);
  if (!Object.keys(tt).length) return [];
  const horizon = numeric(tt.horizon);
  const unit = tt.periodUnit ? String(tt.periodUnit) : null;
  /** @type {Array<{ key: string, label: string, value: string, source: 'assumed' | 'default', decisive: boolean }>} */
  const rows = [];
  if (tt.strategy === "clone_censor_weight") {
    const grace = numeric(object(tt.design).gracePeriod);
    rows.push({ key: "trialStrategy", label: "比较的两个策略", decisive: true, source: "assumed",
      value: `${grace === null ? "宽限期内" : `${periodsWords(grace, unit)}内`}开始治疗，对比始终不开始；到期还没开始的人被当作偏离策略` });
    rows.push({ key: "trialWeights", label: "补回删失的权重", decisive: true, source: "default",
      value: "用每一期的协变量（含随时间变化的）按它在那一期的取值，估计这一期开始治疗的概率；开始治疗只取决于这些协变量，没有未测量的混杂，协变量也不受开始治疗的影响" });
  } else {
    rows.push({ key: "trialStrategy", label: "比较的两个策略", decisive: true, source: "assumed",
      value: `每一期符合条件时，当期在治疗对比不在治疗；随访 ${horizon === null ? "" : periodsWords(horizon, unit)}` });
    if (list(tt.estimands).map(object).some((entry) => entry.kind === "pp")) {
      rows.push({ key: "trialWeights", label: "补回删失的权重", decisive: true, source: "default",
        value: "每一期是否继续用药只取决于模型里的协变量（含随时间变化的），没有未测量的混杂" });
    }
  }
  rows.push({ key: "trialFollowUp", label: "随访", decisive: false, source: "default", value: "随访到每个人记录的最后一期；失访与治疗和协变量无关（没有对失访加权）" });
  return rows;
}
