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
import { finishPremises } from "./vcrPremises.mjs";
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
    parts.push(`改善症状，最大效应在对数优势尺度上是 ${plain(Number(givenOf(progression, "treatment.symptomatic.logitEmax").value))}${half}`);
  }
  const fraction = numeric(treatment.diseaseModifyingFraction);
  if (fraction !== null && fraction > 0) parts.push(`病情恶化的速度减慢 ${plain(fraction * 100)}%（停药后保持）`);
  return parts.length ? parts.join("；") : null;
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
      value: "用的是 CAMD 阿尔茨海默病疾病—药物—试验模型（Rogers 等，2012）作者在 2013 年 8 月公开的 1600 组后验参数，没有重新估计；用它们算出的数与 EMA 2013 年资格认定意见表 7、表 9、表 11 公布的数一致，与表 10 的区间和图 15、图 16 对不上" },
    { key: "progression:ad:regulatory", label: "监管认可", decisive: true, source: "literature",
      value: "FDA 2013 年 6 月 12 日的信函和 EMA 2013 年 9 月 19 日通过的资格认定意见，针对的是原来的工具和它限定的用途，不适用于这里的计算" },
    { key: "progression:ad:scope", label: "适用范围", decisive: true, source: "literature",
      value: `描述一组人：轻中度阿尔茨海默病、ADAS-cog 11（0–70 分，越高越差）、两年以内的试验，不是对某一个人的预测${extrapolation.beyond === true ? `；最后一次随访在第 ${plain(Number(extrapolation.lastVisit))} 周，超过两年的部分是外推` : ""}` },
    { key: "progression:ad:mmse", label: "入组的人", decisive: true, source: assumedHas(progression, "population.mmseRange") ? "default" : BASIS_SOURCE[String(givenOf(progression, "population.mmseRange").basis)] ?? "assumed",
      value: mmse ? `基线 MMSE 在 ${plain(mmse[0])}–${plain(mmse[1])} 分之间均匀分布${ages ? `，年龄 ${plain(ages[0])}–${plain(ages[1])} 岁` : ""}` : "按模型默认的入组范围" },
  ];
  const uncertainty = String(progression.uncertainty ?? "");
  const uncertaintyWords = /** @type {Record<string, string>} */ ({
    new_study: "每次模拟的试验都按一项新研究抽取研究层面的参数（研究之间的差异算在功效里）",
    typical_study: "不考虑研究之间的差异，每次模拟都是同一个典型研究",
    posterior_draws: "每次模拟先抽一组后验参数，再按它抽一项新研究（参数的不确定性和研究之间的差异都算在功效里）",
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
    value: `第 ${visit} 周相对基线的变化，${analysis.kind === "ancova" ? "按基线分数校正的协方差分析" : "Welch t 检验"}，只算那时仍在随访的人；检验水平双侧 ${plain(Number(analysis.alpha ?? 0.05) * 100)}%` });
  if (effect) rows.push({ key: "progression:ad:dosing", label: "用药时间", source: assumedHas(progression, "treatment.doseEnd") ? "default" : "given",
    value: `第 ${plain(Number(treatment.doseBegin ?? 0))}–${plain(Number(treatment.doseEnd))} 周` });
  rows.push({ key: "progression:ad:curves", label: "曲线怎么算的", source: "default",
    value: "平均病程按典型研究、用参数的中位数精确计算；功效和估计差值是模拟的" });
  return finishPremises(rows);
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
  const power = list(result.measures).map(object).find((measure) => measure.name === (isNull ? "type_one_error" : "power")) ?? null;
  const approx = numeric(object(progression.approximation).power);
  const difference = list(result.measures).map(object).find((measure) => measure.name === "expected_difference") ?? null;
  const band = (/** @type {Record<string, any>} */ arm, /** @type {number} */ z) => {
    const m = numeric(object(arm.mean).value); const s = numeric(object(arm.sd).value);
    return m === null ? null : { y: m, low: s === null ? null : m - z * s, high: s === null ? null : m + z * s };
  };
  const series = ["control", "treated"].map((arm) => ({
    key: arm, label: arm === "control" ? "对照组" : "治疗组", source: "assumed", ours: arm === "treated", pooled: false,
    points: curves.map((curve) => ({ x: Number(curve.visit), ...(band(object(curve[arm]), 1.96) ?? { y: null, low: null, high: null }) })),
    bandKind: "prediction", bandLevel: 95, endLabel: null, endNote: null, atRisk: [], individuals: [], dashed: arm === "control", unobserved: [],
  }));
  const effect = alzheimer ? alzheimerEffectWords(progression) : null;
  return {
    id: String(result.id), version: Number(result.version),
    title: `${FAMILY_WORDS[family] ?? family}进展：人群的平均病程与检验的功效`,
    question: isNull
      ? "治疗什么都不改变时，这个检验会误判有效的概率是多少"
      : alzheimer
        ? `药物${effect ?? "按你设定的效果起作用"}时，比较第 ${plain(Number(analysis.visit))} 周相对基线的变化，检验判出有效的把握有多大`
        : `这么多人、把进展减慢 ${plain(Number(object(progression.treatment).slowing) * 100)}% 时，${slope ? "按每个人的进展斜率比较" : "按基线到所选随访的变化比较"}，检验判出有效的把握有多大`,
    label: "人群层面，不是对个人的预测",
    reason: "这条曲线只描述一组人的平均病程和人与人之间的散布，用来估计检验的把握；它不能告诉你某一个人会怎样。",
    power: power ? shown(power) : null,
    powerName: isNull ? "没有真实效应时误判有效的概率" : "判出有效的把握（模拟）",
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
    trials: numeric(progression.trials),
    premises: alzheimer ? alzheimerPremisesOf(progression) : premisesOf(progression, unit),
    limited: list(object(result.diagnostics).issues).some((issue) => object(issue).code === "cpu_budget_exhausted")
      ? `只模拟完了一部分试验（${numeric(progression.trials) ?? "?"} 次，原定 ${numeric(progression.trialsRequested) ?? "?"} 次），数字按已完成的给出。` : null,
  };
}

/**
 * The cards of the patients tab for the progression simulations the study holds now, newest first.
 * @param {Record<string, any>} bundle the patients tab's bundle (`results`, `allResults`, `stale`)
 * @param {{ nodeOf: (result: Record<string, any>) => string }} helpers
 */
export function presentProgressions(bundle, { nodeOf }) {
  const results = list(bundle.allResults ?? bundle.results).map(object).filter((row) => row.kind === "progression_simulation" && !row.supersededBy)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 8);
  return results.map((result) => cardOf(result, markFor(bundle.stale ?? [], nodeOf(result)))).filter(Boolean);
}

/** @param {Record<string, any>} result @param {any} staleMark exported for the tests that read one result */
export const progressionCard = (result, staleMark = null) => cardOf(result, staleMark);
