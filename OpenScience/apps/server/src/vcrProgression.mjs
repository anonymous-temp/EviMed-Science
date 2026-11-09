/**
 * What the virtual-patients page says of a disease-progression simulation (algorithm round P4, 2026-11-03): the result of a `generate_progression` job
 * (`patients.progression`).
 *
 * A progression simulation is not a set of virtual patients (no table of people is written) and belongs to no object of the study: it is a result of its
 * own kind, filed under the scenario it was asked on, that the conversation computes (`vcr_simulate`, kind `generate_progression`). The patients tab lists
 * the current one of each key as a card. This module turns the engine's result into the card's payload and is the only place that knows the words.
 *
 * Hidden knowledge:
 *
 * - **The card says it is population level before it says anything else.** 「人群层面，不是对个人的预测」: the curve is what a group does on average and how
 *   widely people scatter around it, and it cannot say what one person will do. The card says that in a sentence and carries no statistic of its own
 *   for it: a number typed into every card, whatever family or field the run stated and with no source, was a claim nobody could check (review RF2 P2-5).
 * - **The source of every number is a premise.** The scenario gave each value a basis (literature with its citation, assumed, the person's data); the
 *   premises block shows them in the words the page uses for those sources (文献 / 假设 / 你给的数据), the decisive five being the progression amplitude and its
 *   spread, the treatment's slowing, the baseline and the residual. Nothing is built in: no disease and no value is here that the run did not state.
 * - **The curve is exact and the power is simulated.** The means and spreads by arm at every visit are calculated; the power (or, with no slowing, the type I
 *   error) is a Monte Carlo proportion with its error, beside the closed-form power of the same test, and the card says the two are expected to agree.
 * - **Every number is a `VcrValue`** (`measureValue`). A back-office word is never shown: the family is named in words, a value with a basis the page does
 *   not word is left out.
 * - **The Alzheimer model says what it rests on in five sentences** (`beta_logit`, plan T06). Its numbers are not the person's but a published model's,
 *   so the decisive premises are: the drug effect is the person's hypothesis (never a prediction for a compound), the parameters are the published model's
 *   own and agree with the EMA tables they were checked against (and not with the ones they were not), no regulatory recognition carries over to this
 *   page, the result describes a group within the model's range (mild to moderate disease, ADAS-cog 11, up to two years; a later visit is said to be an
 *   extrapolation), and who was enrolled. The rest (uncertainty, covariates, dropout, placebo, the analysis) is folded. There is no closed-form power
 *   for it, so the card shows none.
 *
 * @module vcrProgression
 */

import { createHash } from "node:crypto";
import { VCR_RESULT_QUANTITY_LABELS_ZH, VCR_SIMULATION_ERROR_SENTENCE_ZH, VCR_UNCERTAINTY_MODE_QUANTITY, vcrEstimandAlignment } from "@evimed/domain";
import { finishPremises } from "./vcrPremises.mjs";
import { drugOriginPremises } from "./vcrDrugOriginPremises.mjs";
import { credibilityPremises } from "./vcrCredibilityPremises.mjs";
import { researchQuestionPremises, resultQuestionInput } from "./vcrResearchQuestionView.mjs";
import { list, markFor, measureValue, numeric, object, text, zhUnit } from "./vcrViewsKit.mjs";

/** @param {unknown} value @returns {unknown} the value with every object's keys in order, so the same scenario is the same text */
function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(/** @type {any} */ (value)[key])]));
  return value;
}

/**
 * The key a progression simulation is filed under (the result's `subject_id`): the scenario it was asked on. Another slowing, another size or another
 * analysis is another result; the same question asked again is the next version of one.
 * @param {Record<string, any>} scenario
 */
export function vcrProgressionSubjectId(scenario) {
  return `pg:${createHash("sha256").update(JSON.stringify(ordered(object(scenario)))).digest("hex").slice(0, 10)}`;
}

const FAMILY_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({ linear: "线性", exponential: "指数", logistic: "逻辑斯蒂（S 形）", emax: "Emax（逐渐饱和）", beta_logit: "阿尔茨海默病 ADAS-cog 11 " }));
const BASIS_SOURCE = Object.freeze(/** @type {Record<string, "literature" | "assumed" | "given">} */ ({ literature: "literature", assumed: "assumed", data: "given" }));
const PARAMETER_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({
  "model.amplitude": "进展的幅度（斜率或平台）", "model.betweenPersonSd": "人与人之间进展幅度的标准差", "model.acceleration": "指数加速度", "model.steepness": "S 形曲线的陡度",
  "model.midpoint": "S 形曲线的中点", "model.halfTime": "达到一半幅度的时间", "baseline.mean": "基线的均值", "baseline.sd": "基线的标准差", "residualSd": "同一个人两次测量之间的随机波动（标准差）",
  "treatment.slowing": "治疗把进展速度减慢的比例", "correlation": "基线与进展幅度的相关",
}));
const TIME_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({ days: "天", weeks: "周", months: "个月", years: "年" }));
const DECISIVE = new Set(["model.amplitude", "model.betweenPersonSd", "treatment.slowing", "baseline.sd", "residualSd"]);
/** @param {number} value @param {number} [digits] */
const plain = (value, digits = 3) => String(Number(value.toPrecision(digits)));

/** @param {Record<string, any>} progression @param {string} timeUnit */
function premisesOf(progression, timeUnit) {
  /** @type {Array<Record<string, any>>} */
  const rows = [];
  for (const entry of list(progression.given).map(object)) {
    const key = String(entry.key);
    const label = PARAMETER_WORDS[key];
    const value = numeric(entry.value);
    if (!label || value === null) continue;
    const citation = text(entry.citation);
    const unit = key === "model.midpoint" || key === "model.halfTime" ? ` ${TIME_WORDS[timeUnit] ?? timeUnit}` : "";
    rows.push({ key: `progression:${key}`, label, value: key === "treatment.slowing" ? `${plain(value * 100)}%` : `${plain(value)}${unit}`, source: BASIS_SOURCE[String(entry.basis)] ?? "assumed", decisive: DECISIVE.has(key), reason: citation });
  }
  for (const entry of list(progression.assumed).map(object)) {
    const key = String(entry.key);
    if (key === "correlation") rows.push({ key: "progression:correlation", label: PARAMETER_WORDS.correlation, value: "0（没有说，按没有相关算）", source: "default", decisive: false });
    else if (key === "analysis.alpha") rows.push({ key: "progression:alpha", label: "检验的水平", value: "双侧 5%", source: "default", decisive: false });
    else if (key === "analysis.visit") rows.push({ key: "progression:visit", label: "比较哪一次随访", value: `最后一次（${plain(Number(entry.value))} ${TIME_WORDS[timeUnit] ?? timeUnit}）`, source: "default", decisive: false });
  }
  rows.push({ key: "progression:clock", label: "治疗怎样起作用", value: "把病程的时钟拨慢：治疗组的曲线等于对照组的曲线在 (1 − 减慢比例) × 时间 处的值", source: "default", decisive: false });
  return finishPremises(rows);
}

/** The given entry of a key, or an empty object. @param {Record<string, any>} progression @param {string} key */
const givenOf = (progression, key) => object(list(progression.given).map(object).find((entry) => entry.key === key));
/** @param {Record<string, any>} progression @param {string} key */
const assumedHas = (progression, key) => list(progression.assumed).map(object).some((entry) => entry.key === key);
/** @param {unknown} value */
const pairOf = (value) => (Array.isArray(value) && value.length === 2 && value.every((x) => typeof x === "number" && Number.isFinite(x)) ? /** @type {[number, number]} */ (value) : null);

/** The drug the person stated, in one sentence; null when they stated none. @param {Record<string, any>} progression */
function alzheimerEffectWords(progression) {
  const treatment = object(progression.treatment);
  const parts = [];
  const points = givenOf(progression, "treatment.symptomatic.pointsAt");
  const et50 = numeric(givenOf(progression, "treatment.symptomatic.et50Weeks").value);
  const half = et50 === null ? "" : `，用药 ${plain(et50)} 周时达到最大效果的一半`;
  if (numeric(points.value) !== null) {
    const v = Number(points.value);
    parts.push(`第 ${plain(Number(points.atWeek))} 周比不用药${v < 0 ? "低" : "高"} ${plain(Math.abs(v))} 分（对基线 ${plain(Number(points.referenceAdas))} 分的人）${half}`);
  } else if (numeric(givenOf(progression, "treatment.symptomatic.logitEmax").value) !== null) {
    parts.push(`改善症状，最大效应强度是 ${plain(Number(givenOf(progression, "treatment.symptomatic.logitEmax").value))}${half}`);
  }
  const reference = object(treatment.reference);
  if (text(reference.drug)) parts.push(`已上市药物（${/** @type {Record<string, string>} */ ({ donepezil: "多奈哌齐", galantamine: "加兰他敏", rivastigmine: "卡巴拉汀" })[String(reference.drug)] ?? String(reference.drug)}，每天 ${plain(Number(reference.doseMg))} mg）按模型自己拟合的效果`);
  if (text(object(progression.mechanism).drug)) parts.push("按已发表的机制链（剂量、血药浓度、淀粉样蛋白 PET、认知量表）算出的效果");
  const fraction = numeric(treatment.diseaseModifyingFraction);
  if (fraction !== null && fraction > 0) parts.push(`病情恶化的速度减慢 ${plain(fraction * 100)}%（停药后保持）`);
  return parts.length ? parts.join("；") : null;
}

/** What the Alzheimer model's parameters are and what they reproduce (a sentence the result card and the lab's experiments both say). */
export const ALZHEIMER_PARAMETERS_TEXT = "参数直接用 CAMD 模型（Rogers 等，2012）公开的原值，没有按你的数据重新估计。";
/** What those parameters reproduce of the 2013 EMA opinion: a folded detail, not a decisive row. */
export const ALZHEIMER_REPRODUCTION_TEXT = "用这些参数算出的结果，与 EMA 2013 年资格认定意见的表 7、表 9、表 11 一致，与表 10 和图 15、图 16 不一致。";
/** The 2013 regulatory documents concern the original tool, not this implementation. */
export const ALZHEIMER_REGULATORY_TEXT = "FDA 2013 年 6 月 12 日的信函和 EMA 2013 年 9 月 19 日通过的资格认定意见，针对的是原来的工具和它限定的用途，不适用于这里的计算";
/** @param {boolean} beyond @param {number} lastVisit */
export const alzheimerScopeText = (beyond, lastVisit, mmse = null) => `描述一组人：轻中度阿尔茨海默病、ADAS-cog 11（0–70 分，越高越差）、两年以内的试验，不是对某一个人的预测${beyond ? `；最后一次随访在第 ${plain(lastVisit)} 周，超过两年的部分是外推` : ""}${alzheimerOutsideContext(mmse) ? `；入组的基线 MMSE ${plain(mmse[0])}–${plain(mmse[1])} 分超出了轻中度的范围（约 ${ALZHEIMER_CONTEXT_MMSE[0]}–${ALZHEIMER_CONTEXT_MMSE[1]} 分），这部分人是模型适用范围之外的外推` : ""}`;
/**
 * The baseline MMSE of mild to moderate Alzheimer's disease, the model's context of use (moderate from 10, mild up to 26; the regulators
 * state "no validity outside this range, e.g. severe or prodromal", AD-SOURCE §2.1). An entry range reaching outside it is computed and
 * said to be an extrapolation, like a visit beyond two years (review stats P2-6).
 */
export const ALZHEIMER_CONTEXT_MMSE = Object.freeze([10, 26]);
/** @param {readonly number[] | null | undefined} mmse */
export const alzheimerOutsideContext = (mmse) => Array.isArray(mmse) && mmse.length === 2 && (Number(mmse[0]) < ALZHEIMER_CONTEXT_MMSE[0] || Number(mmse[1]) > ALZHEIMER_CONTEXT_MMSE[1]);

/** The estimators of the Alzheimer model in the words the page uses; the data each reads is said with it. @param {Record<string, any>} analysis */
function analysisWords(analysis) {
  const kind = String(analysis.kind ?? "change");
  const data = analysis.data === "on_treatment" ? "只用停药之前（用药期间）的数据" : analysis.data === "all_observed" ? "用了所有收集到的数据，停药之后的也算" : "";
  const delta = numeric(analysis.delta);
  const words = /** @type {Record<string, string>} */ ({
    ancova: "按基线分数校正的协方差分析", mmrm: "混合效应模型（MMRM）：每次随访各有各的均值，随访之间的相关不设限制，按基线和分组校正",
    cmi_jump_to_reference: "参照组插补（跳到对照组）：缺失的值按停药后随对照组的病程补上，再做协方差分析，标准误用分组刀切法",
    cmi_copy_reference: "参照组插补（复制对照组）：停药的人整个病程都按对照组补上，再做协方差分析，标准误用分组刀切法",
  });
  const base = words[kind] ?? "Welch t 检验";
  const who = kind === "change" || kind === "ancova" ? "只算那时仍在随访的人" : "";
  return [base, data, who, delta ? `补上的值在治疗组一律加 ${plain(delta)} 分（临界值分析）` : ""].filter(Boolean).join("，");
}

/**
 * What happens to a person besides finishing as planned, and which effect the analysis answers (plan R26): the events as stated, the realized shares, the true
 * value of each way of handling a stop with the analysis's bias and coverage against it. Rows only when the run had intercurrent events or an MMRM-class analysis.
 * @param {Record<string, any>} progression @returns {Array<Record<string, any>>}
 */
function intercurrentPremises(progression) {
  const ic = object(progression.intercurrent);
  if (!Object.keys(ic).length) return [];
  const config = object(ic.configuration);
  const stop = object(config.discontinuation); const leave = object(config.withdrawal); const death = object(config.death);
  const pct = (/** @type {unknown} */ x) => `${plain(Number(x) * 100, 3)}%`;
  /** @type {string[]} */
  const parts = [];
  if (numeric(stop.shareTreated) !== null) {
    parts.push(`到最后一次随访，治疗组约 ${pct(stop.shareTreated)}、对照组约 ${pct(stop.shareControl)} 的人停药；停药的人里约 ${pct(stop.retrievedShare)} 继续留在研究里随访${Number(stop.progressionLogHazardPerSd) ? `；病情进展越快的人越早停药（每个标准差对数风险 ${plain(Number(stop.progressionLogHazardPerSd))}）` : "；停不停药与病情无关"}`);
  }
  if (numeric(leave.treatedHazardRatio) !== null && (Number(leave.treatedHazardRatio) !== 1 || Number(leave.progressionLogHazardPerSd) !== 0)) parts.push("退出研究的风险与分组或病情有关");
  if (numeric(death.share) !== null) parts.push(`约 ${pct(death.share)} 的人死亡，死亡后的分数按最差值 70 分计`);
  /** @type {Array<Record<string, any>>} */
  const rows = [];
  if (parts.length) rows.push({ key: "progression:ad:events", label: "停药、退出和死亡", source: "given", decisive: false, value: `${parts.join("；")}。停药后对症的效果按设定的半衰期消退，疾病修饰的效果保留` });
  const strategyWords = /** @type {Record<string, string>} */ ({ treatment_policy: "不论是否停药（治疗策略）", hypothetical: "假如没有人停药（假想情境）" });
  const estimator = String(ic.estimator ?? "");
  const claimed = typeof ic.claimed === "string" ? ic.claimed : null;
  const table = list(ic.estimands).map(object).map((row) => {
    const truth = numeric(object(row.truth).value); const bias = numeric(object(row.bias).value); const mcse = numeric(object(row.bias).mcse); const cover = numeric(object(row.coverage).value);
    return truth === null ? null : `${strategyWords[String(row.strategy)] ?? String(row.strategy)}：真实差值 ${plain(truth)} 分，这个分析的偏差 ${bias === null ? "未知" : `${plain(bias)}${mcse === null ? "" : `（模拟误差 ${plain(mcse)}）`}`} 分，95% 区间覆盖 ${cover === null ? "未知" : pct(cover)}`;
  }).filter(Boolean);
  const alignment = claimed ? vcrEstimandAlignment({ strategy: claimed, estimator, data: String(ic.data ?? "") }) : null;
  if (table.length) rows.push({ key: "progression:ad:estimand", label: "这个分析回答的是哪个效应", source: "derived", decisive: claimed !== null,
    value: `${table.join("；")}。${alignment ? alignment.sentence : "两个真实值都由模型算出，偏差小、覆盖率接近 95% 的那个才是这个分析回答的问题"}` });
  return rows;
}

/**
 * The estimand table of a run with intercurrent events: for each way of handling a stop the model's true value, this analysis's bias against it and the
 * coverage of its 95% interval, each with its Monte Carlo error, and a sentence saying whether the analysis answers that question. Null for a run without them.
 * @param {Record<string, any>} progression @param {(measure: Record<string, any>) => unknown} shown
 */
function estimandsOf(progression, shown) {
  const ic = object(progression.intercurrent);
  const rows = list(ic.estimands).map(object);
  if (!rows.length) return null;
  const labels = /** @type {Record<string, string>} */ ({ treatment_policy: "不论是否停药（治疗策略）", hypothetical: "假如没有人停药（假想情境）" });
  return { rows: rows.map((row) => {
    const alignment = vcrEstimandAlignment({ strategy: String(row.strategy), estimator: String(ic.estimator ?? ""), data: String(ic.data ?? "") });
    return { key: String(row.strategy), label: labels[String(row.strategy)] ?? String(row.strategy), claimed: ic.claimed === row.strategy, truth: shown(object(row.truth)),
      bias: Object.keys(object(row.bias)).length ? shown(object(row.bias)) : null, coverage: Object.keys(object(row.coverage)).length ? shown(object(row.coverage)) : null,
      sentence: alignment.sentence };
  }) };
}

/** The premises of the Alzheimer model (beta_logit): five decisive sentences, the rest folded. @param {Record<string, any>} progression */
function alzheimerPremisesOf(progression) {
  const effect = alzheimerEffectWords(progression);
  const effectBasis = String(givenOf(progression, "treatment.diseaseModifying.fraction").basis ?? givenOf(progression, "treatment.symptomatic.pointsAt").basis ?? givenOf(progression, "treatment.symptomatic.logitEmax").basis ?? "assumed");
  const extrapolation = object(progression.extrapolation);
  const population = object(progression.population);
  const mmse = pairOf(population.mmseRange);
  const ages = pairOf(population.ageBounds);
  const analysis = object(progression.analysis);
  const treatment = object(progression.treatment);
  const visit = plain(Number(analysis.visit));
  /** @type {Array<Record<string, any>>} */
  const rows = [
    { key: "progression:ad:effect", label: "药物效果", decisive: true, source: effect ? BASIS_SOURCE[effectBasis] ?? "assumed" : "default",
      value: effect ? `${effect}。这是你设定的假设，不是对某个药物疗效的预测` : "没有设定药物效果，两组相同：这里看的是检验误判有效的概率" },
    { key: "progression:ad:parameters", label: "模型参数", decisive: true, source: "literature",
      value: ALZHEIMER_PARAMETERS_TEXT },
    { key: "progression:ad:reproduction", label: "复现情况", decisive: false, source: "literature", value: ALZHEIMER_REPRODUCTION_TEXT },
    { key: "progression:ad:regulatory", label: "监管认可", decisive: false, source: "literature",
      value: ALZHEIMER_REGULATORY_TEXT },
    { key: "progression:ad:scope", label: "适用范围", decisive: true, source: "literature",
      value: alzheimerScopeText(extrapolation.beyond === true, Number(extrapolation.lastVisit), mmse) },
    { key: "progression:ad:mmse", label: "入组的人", decisive: true, source: assumedHas(progression, "population.mmseRange") ? "default" : BASIS_SOURCE[String(givenOf(progression, "population.mmseRange").basis)] ?? "assumed",
      value: mmse ? `基线 MMSE 在 ${plain(mmse[0])}–${plain(mmse[1])} 分之间均匀分布${ages ? `，年龄 ${plain(ages[0])}–${plain(ages[1])} 岁` : ""}` : "按模型默认的入组范围" },
  ];
  const uncertainty = String(progression.uncertainty ?? "");
  const uncertaintyWords = /** @type {Record<string, string>} */ ({
    new_study: `每次模拟的试验都按一项新研究抽取研究层面的参数（研究之间的差异算在“${VCR_RESULT_QUANTITY_LABELS_ZH.expected_power_over_studies}”里）`,
    typical_study: "不考虑研究之间的差异，每次模拟都是同一个典型研究",
    posterior_draws: `每次模拟先抽一组后验参数，再按它抽一项新研究（参数的不确定性和研究之间的差异都算在“${VCR_RESULT_QUANTITY_LABELS_ZH.expected_power_over_parameters}”里）`,
  });
  if (uncertaintyWords[uncertainty]) rows.push({ key: "progression:ad:uncertainty", label: "试验之间的差异", value: uncertaintyWords[uncertainty], source: assumedHas(progression, "model.uncertainty") ? "default" : "given" });
  const apoe = list(population.apoe4).map(Number); const means = list(population.ageMeanByApoe4).map(Number);
  if (apoe.length === 3 && means.length === 3 && numeric(population.femaleShare) !== null) {
    rows.push({ key: "progression:ad:covariates", label: "年龄、性别和 ApoE4", source: assumedHas(progression, "population.covariates") ? "default" : "given",
      value: `带 0、1、2 个 ApoE4 等位基因的人各占 ${apoe.map((x) => plain(x * 100, 3)).join("%、")}%，女性 ${plain(Number(population.femaleShare) * 100, 3)}%，三组的平均年龄 ${means.map((x) => plain(x, 3)).join("、")} 岁` });
  }
  rows.push({ key: "progression:ad:dropout", label: "脱落", source: assumedHas(progression, "dropoutModel") ? "default" : "given",
    value: progression.dropoutModel === "none" ? "不考虑脱落，每个人都看到最后" : "按模型的脱落规律：与年龄和 MMSE 有关，与分组和病情无关" });
  rows.push({ key: "progression:ad:placebo", label: "安慰剂反应", source: assumedHas(progression, "placebo") ? "default" : "given",
    value: progression.placebo === false ? "不加安慰剂反应" : "两组从第 0 周起都有安慰剂反应" });
  rows.push({ key: "progression:ad:analysis", label: "比较方法", source: assumedHas(progression, "analysis.kind") || assumedHas(progression, "analysis.visit") ? "default" : "given",
    value: `第 ${visit} 周相对基线的变化，${analysisWords(analysis)}；检验水平双侧 ${plain(Number(analysis.alpha ?? 0.05) * 100)}%` });
  rows.push(...intercurrentPremises(progression));
  if (effect) rows.push({ key: "progression:ad:dosing", label: "用药时间", source: assumedHas(progression, "treatment.doseEnd") ? "default" : "given",
    value: `第 ${plain(Number(treatment.doseBegin ?? 0))}–${plain(Number(treatment.doseEnd))} 周` });
  rows.push({ key: "progression:ad:curves", label: "曲线怎么算的", source: "default",
    value: "平均病程按典型研究、用参数的中位数精确计算；检验的把握度和估计差值是模拟的" });
  rows.push(...drugOriginPremises(progression));
  rows.push(...credibilityPremises(progression));
  rows.push({ key: "lab:replicates", label: "模拟的误差", source: "default", decisive: false, value: VCR_SIMULATION_ERROR_SENTENCE_ZH });
  return finishPremises(rows);
}

/**
 * What one run compared, said in its title so that no two runs of a study read alike (live 2026-11-07: twelve Alzheimer runs -- no drug,
 * a symptomatic and a disease-modifying hypothesis at 200 per arm, then sample sizes from 800 to 1,800 with and without study-to-study
 * variation -- each read 「阿尔茨海默病 ADAS-cog 11 进展：人群的平均病程与检验的把握度」). The hypothesis is the scenario's own values, the arm
 * sizes are the engine's count of people at the first visit (everyone is observed then), else the people of one simulated trial.
 * @param {Record<string, any>} result @param {Record<string, any>} progression @param {boolean} alzheimer
 * @returns {string}
 */
function runWords(result, progression, alzheimer) {
  const treatment = object(progression.treatment);
  let arms;
  if (alzheimer) {
    const points = givenOf(progression, "treatment.symptomatic.pointsAt");
    const fraction = numeric(treatment.diseaseModifyingFraction);
    const drugs = [
      numeric(points.value) !== null ? `对症药物（第 ${plain(Number(points.atWeek))} 周${Number(points.value) < 0 ? "少" : "多"} ${plain(Math.abs(Number(points.value)))} 分）`
        : numeric(treatment.symptomaticLogitEmax) ? "对症药物" : null,
      fraction !== null && fraction > 0 ? `疾病修饰药物（减慢 ${plain(fraction * 100)}%）` : null,
    ].filter(Boolean);
    arms = progression.isNull === true || !drugs.length ? "两组都不用药" : `${drugs.join("加")}对比不用药`;
  } else {
    const slowing = numeric(treatment.slowing);
    arms = progression.isNull === true || !slowing ? "治疗不改变进展" : `进展减慢 ${plain(slowing * 100)}%`;
  }
  const first = object(list(progression.observed)[0]);
  const control = numeric(object(first.control).value);
  const treated = numeric(object(first.treated).value);
  const total = numeric(object(result.counts).generatedRecords) !== null && numeric(progression.trials) ? Number(object(result.counts).generatedRecords) / Number(progression.trials) : null;
  const size = control !== null && treated !== null && Number.isInteger(control) && Number.isInteger(treated)
    ? (control === treated ? `每组 ${control} 人` : `治疗组 ${treated} 人、对照组 ${control} 人`)
    : total !== null && Number.isInteger(total) ? `共 ${total} 人` : null;
  const variation = alzheimer ? /** @type {Record<string, string>} */ ({ typical_study: "同一个典型研究", new_study: "含研究之间的差异", posterior_draws: "含参数的不确定性" })[String(progression.uncertainty)] : null;
  const slope = object(progression.analysis).kind === "slope" ? "按斜率比较" : null;
  return [arms, size, slope].filter(Boolean).join("，") + (variation ? `（${variation}）` : "");
}

/**
 * @param {Record<string, any>} result @param {any} staleMark
 */
function cardOf(result, staleMark) {
  const progression = object(object(result.diagnostics).progression);
  const family = String(progression.family ?? "");
  const curves = list(progression.curves).map(object);
  if (!family || !curves.length) return null;
  const context = { result, staleMark };
  // the Alzheimer model's outcome is ADAS-cog points, a unit of the parameter set and not a word the person wrote: the page says it in Chinese
  const alzheimer = family === "beta_logit";
  const adUnit = (/** @type {Record<string, any>} */ measure) => (alzheimer && measure?.unit === progression.outcomeUnit ? { ...measure, unit: "分" } : measure);
  // A unit as the page says it: the time word of the engine ("months", also inside "points / months") in Chinese, the outcome's own unit as the person wrote it.
  const unitWords = (/** @type {string} */ words) => words.split(" / ").map((part) => zhUnit(part) ?? part).join(" / ");
  const shown = (/** @type {Record<string, any>} */ given) => { const measure = adUnit(given); return measureValue({ ...(measure?.mcse === 0 ? { ...measure, mcse: undefined } : measure),
    ...(typeof measure?.unit === "string" && measure.unit.includes(" / ") ? { unit: unitWords(measure.unit) } : {}) }, { kind: "patient_set", ...context, tab: "patients" }); };
  const unit = text(object(curves[0]).timeUnit) ?? "";
  const outcomeUnit = text(progression.outcomeUnit);
  const inUnit = (/** @type {Record<string, any>} */ measure) => (outcomeUnit && !measure.unit ? { ...measure, unit: outcomeUnit } : measure);
  const isNull = progression.isNull === true;
  const analysis = object(progression.analysis);
  const slope = analysis.kind === "slope";
  // an effect stated as a distribution (1.2.0) reports an assurance, named so, not a power
  const distributed = list(progression.effectDistributions).length > 0;
  const power = list(result.measures).map(object).find((measure) => measure.name === (isNull ? "type_one_error" : distributed ? "assurance" : "power")) ?? null;
  const approx = numeric(object(progression.approximation).power);
  const difference = list(result.measures).map(object).find((measure) => measure.name === "expected_difference") ?? null;
  const band = (/** @type {Record<string, any>} */ arm, /** @type {number} */ z) => {
    const m = numeric(object(arm.mean).value); const s = numeric(object(arm.sd).value);
    return m === null ? null : { y: m, low: s === null ? null : m - z * s, high: s === null ? null : m + z * s };
  };
  const series = ["control", "treated"].map((arm) => ({
    key: arm, label: arm === "control" ? "对照组" : "治疗组", source: "assumed", ours: arm === "treated", pooled: false,
    points: curves.map((curve) => ({ x: Number(curve.visit), ...(band(object(curve[arm]), 1.96) ?? { y: null, low: null, high: null }) })),
    // mean ± 1.96 SD is no 95% prediction band of a bounded, skewed score (it leaves the 0–70 scale near its ends): the Alzheimer curve
    // draws its mean only (review stats P2-7)
    bandKind: alzheimer ? null : "prediction", bandLevel: alzheimer ? null : 95, endLabel: null, endNote: null, atRisk: [], individuals: [], dashed: arm === "control", unobserved: [],
  }));
  return {
    id: String(result.id), version: Number(result.version),
    title: `${FAMILY_WORDS[family] ?? family}进展：${runWords(result, progression, alzheimer)}`,
    question: isNull
      ? "治疗什么都不改变时，这个检验会误判有效的概率是多少"
      : alzheimer
        ? `药物按你设定的效果起作用时，第 ${plain(Number(analysis.visit))} 周检验判出有效的把握有多大`
        : `这么多人、把进展减慢 ${plain(Number(object(progression.treatment).slowing) * 100)}% 时，${slope ? "按每个人的进展斜率比较" : "按基线到所选随访的变化比较"}，检验判出有效的把握有多大`,
    label: "人群层面，不是对个人的预测",
    reason: "这条曲线只描述一组人的平均病程和人与人之间的散布，用来估计检验的把握；它不能告诉你某一个人会怎样。",
    power: power ? shown(power) : null,
    powerName: isNull ? "没有真实效应时误判有效的概率" : distributed ? VCR_RESULT_QUANTITY_LABELS_ZH.assurance : VCR_RESULT_QUANTITY_LABELS_ZH[VCR_UNCERTAINTY_MODE_QUANTITY[String(progression.uncertainty ?? "typical_study")] ?? "conditional_power_typical_study"],
    powerQuantity: isNull ? null : distributed ? "assurance" : VCR_UNCERTAINTY_MODE_QUANTITY[String(progression.uncertainty ?? "typical_study")] ?? "conditional_power_typical_study",
    approximation: approx === null ? null : shown({ name: isNull ? "type_one_error" : "power", value: approx, source: "calculated" }),
    expected: difference ? { value: shown(difference), words: slope ? "治疗组减对照组的平均斜率之差" : alzheimer ? "治疗组减对照组的平均变化之差（典型研究，按那时仍在随访的人）" : "治疗组减对照组的平均变化之差" } : null,
    timeUnit: unit ? unitWords(unit) : unit, visits: curves.map((curve) => Number(curve.visit)),
    series,
    table: {
      columns: [{ key: "control", label: "对照组均值（标准差）" }, { key: "treated", label: "治疗组均值（标准差）" }, { key: "gap", label: "治疗减对照" }],
      rows: curves.map((curve) => {
        const c = object(curve.control); const t = object(curve.treated);
        return { key: String(curve.visit), visit: Number(curve.visit),
          control: { mean: shown(inUnit(object(c.mean))), sd: shown(inUnit(object(c.sd))) }, treated: { mean: shown(inUnit(object(t.mean))), sd: shown(inUnit(object(t.sd))) },
          gap: shown(inUnit({ name: "curve_gap", value: Number(object(t.mean).value) - Number(object(c.mean).value), source: "calculated" })) };
      }),
    },
    estimands: alzheimer ? estimandsOf(progression, shown) : null,
    trials: numeric(progression.trials),
    premises: alzheimer ? alzheimerPremisesOf(progression) : premisesOf(progression, unit),
    limited: list(object(result.diagnostics).issues).some((issue) => object(issue).code === "cpu_budget_exhausted")
      ? `只模拟完了一部分试验（${numeric(progression.trials) ?? "?"} 次，原定 ${numeric(progression.trialsRequested) ?? "?"} 次），数字按已完成的给出。` : null,
  };
}

/**
 * Whether the analysis a result used answers what the study's question asked of each intercurrent event (plan R26): one row for the strategies the
 * engine computes a truth for, said in the question's own words. A result of a run with no such events says nothing.
 * @param {Record<string, any>} bundle @param {Record<string, any>} result @returns {Array<Record<string, any>>}
 */
function estimatorForQuestionRows(bundle, result) {
  const ic = object(object(object(result.diagnostics).progression).intercurrent);
  if (!Object.keys(ic).length) return [];
  const strategies = [...new Set(list(object(object(bundle.researchQuestion).fields).intercurrentEvents).map((entry) => object(entry).strategy).filter((value) => value === "treatment_policy" || value === "hypothetical"))];
  const words = /** @type {Record<string, string>} */ ({ treatment_policy: "不论是否停药", hypothetical: "假如没有人停药" });
  return strategies.map((strategy) => {
    const alignment = vcrEstimandAlignment({ strategy: String(strategy), estimator: String(ic.estimator ?? ""), data: String(ic.data ?? "") });
    return { key: `question:estimator:${strategy}`, label: "分析是否回答了研究问题", source: "derived", decisive: alignment.state === "not_aligned", value: `研究问题要的是“${words[String(strategy)]}”的效应。${alignment.sentence}` };
  });
}

/**
 * The cards of the patients tab for every progression simulation the study holds now, newest first.
 * @param {Record<string, any>} bundle the patients tab's bundle (`results`, `allResults`, `stale`)
 * @param {{ nodeOf: (result: Record<string, any>) => string }} helpers
 */
export function presentProgressions(bundle, { nodeOf }) {
  // Every current one: a run asked on another scenario is another result, and none is left off (a cap of eight hid the first four of
  // twelve live runs, 2026-11-07).
  const results = list(bundle.allResults ?? bundle.results).map(object).filter((row) => row.kind === "progression_simulation" && !row.supersededBy)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return results.map((result) => {
    const card = cardOf(result, markFor(bundle.stale ?? [], nodeOf(result)));
    // The Alzheimer model's calibration estimand is the parameter set's: only a result computed with it is judged against it.
    const modelId = object(object(object(result.diagnostics).progression)).family === "beta_logit" ? "camd-adas-cog-11" : null;
    const rows = card ? [...researchQuestionPremises(resultQuestionInput(bundle, result, modelId)), ...estimatorForQuestionRows(bundle, result)] : [];
    return card && rows.length ? { ...card, premises: finishPremises([...list(card.premises), ...rows]) } : card;
  }).filter(Boolean);
}

/** @param {Record<string, any>} result @param {any} staleMark exported for the tests that read one result */
export const progressionCard = (result, staleMark = null) => cardOf(result, staleMark);

/**
 * A progression result as a conversation reads it, with the difference between its arms at each visit said by code: each curve's
 * `difference` is the treated group's mean less the untreated group's, the 「治疗减对照」 column of the card, calculated exactly in the
 * typical study like the means it is made of (no Monte Carlo error; the simulated difference at the analysis visit, `simulated_difference`,
 * carries its own). Live D6 (2026-11-07, phase 3): three Alzheimer arms were compared by a reply that subtracted the means itself. A copy;
 * a result of another kind, or a curve without both means, is unchanged.
 * @param {Record<string, any>} result as the answer carries it
 * @returns {Record<string, any>}
 */
export function vcrProgressionWithDifferences(result) {
  const diagnostics = object(result?.diagnostics);
  const progression = object(diagnostics.progression);
  const curves = list(progression.curves);
  if (result?.kind !== "progression_simulation" || !curves.length) return result;
  const unit = text(progression.outcomeUnit);
  const withDifference = curves.map((raw) => {
    const curve = object(raw);
    const treated = numeric(object(object(curve.treated).mean).value);
    const control = numeric(object(object(curve.control).mean).value);
    return treated === null || control === null ? raw
      : { ...curve, difference: { name: "curve_difference", value: treated - control, source: "calculated", ...(unit ? { unit } : {}),
        note: "treated less untreated mean at this visit, calculated exactly in the typical study" } };
  });
  return { ...result, diagnostics: { ...diagnostics, progression: { ...progression, curves: withDifference } } };
}
