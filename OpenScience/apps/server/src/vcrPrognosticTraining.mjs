/**
 * What the comparison page says of a prognostic model trained on the person's own historical table (algorithm round P3, 2026-11-03): the result of a
 * `train_prognostic_model` job (`model.prognostic_train`).
 *
 * A trained model is not one of the comparison's routes and belongs to no object of the study: it is a result of its own kind, filed under the
 * configuration it was trained on, that the conversation computes (`vcr_simulate`, kind `train_prognostic_model`). The comparator tab lists the current
 * one of each key as a card. This module turns the engine's result into the card's payload and is the only place that knows the words.
 *
 * Hidden knowledge:
 *
 * - **The card answers one question: how well does the score tell the people it never saw apart, and how much sample size would it save, soberly.**
 *   The headline numbers are out of fold (each person was predicted by a model that did not see them), the savings table is computed from the
 *   correlation measured out of fold and from the lower end of its interval, under discounts the person can read and change.
 * - **The label is on the card, not in a footnote.** 「用你自己的数据训练，没有在别的人群验证过」 is what the saved model is; the card never calls it
 *   validated, and says that the figures say how the method does on people like these and nothing about another population.
 * - **A model that was not estimated says why in a sentence and shows no numbers** (too few events, a fit that did not converge), as a card of its own,
 *   never a blank where the card should be.
 * - **A coefficient is shown as the effect a reader knows**: a hazard ratio per unit for Cox, an odds ratio for logistic, the change in the outcome for
 *   linear. A text predictor is one line per level against the commonest one.
 * - **Every number is a `VcrValue`** (`measureValue`): the percentage, the interval, the source word. No back-office word reaches the card.
 *
 * @module vcrPrognosticTraining
 */

import { createHash } from "node:crypto";
import { finishPremises } from "./vcrPremises.mjs";
import { list, markFor, measureLabel, measureValue, numeric, object, text } from "./vcrViewsKit.mjs";

/** @param {unknown} value @returns {unknown} the value with every object's keys in order, so the same configuration is the same text */
function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(/** @type {any} */ (value)[key])]));
  return value;
}

/**
 * The key a trained model is filed under (the result's `subject_id`): the configuration it was trained on. The same question asked again is the next
 * version of one result; another outcome, other predictors or another number of folds is another result.
 * @param {Record<string, any>} scenario
 */
export function vcrPrognosticSubjectId(scenario) {
  return `pt:${createHash("sha256").update(JSON.stringify(ordered(object(scenario)))).digest("hex").slice(0, 10)}`;
}

const FAMILY_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({
  linear: "线性回归（连续结局）", logistic: "逻辑回归（二分类结局）", cox: "Cox 回归（事件时间结局）",
}));
const EFFECT_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({
  linear: "每增加 1 个单位，结局的变化", logistic: "每增加 1 个单位，发生概率的优势比", cox: "每增加 1 个单位，风险比",
}));
/** How the correlation was computed, in words: the engine's own sentence is English and stays in the result. */
const CORRELATION_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({
  linear: "留出折上的预测值与结局的相关系数",
  logistic: "留出折上的预测概率与 0/1 结局的相关系数（点二列相关）",
  cox: "留出折上的风险分与「到时间点之前是否发生事件」的相关系数，只算时间点上状态已知的人；这是近似，因为样本量节省的公式本来是为连续结局写的",
}));
const DEFAULT_LAMBDAS = [1, 0.9, 0.75, 0.5];
const DEFAULT_GAMMAS = [1, 1.1, 1.25];
/** @param {number} value @param {number} [digits] */
const plain = (value, digits = 3) => String(Number(value.toPrecision(digits)));

/** The sentence a refusal rule is worded by. @param {Record<string, any>} diagnostics @param {string | null} rule */
function refusalWords(diagnostics, rule) {
  if (rule === "too_few_events") {
    return `用来训练的数据太少：这个模型有 ${numeric(diagnostics.parameters) ?? "?"} 个参数，较少的那一类（发生事件的人，或没发生的人）至少要 ${numeric(diagnostics.needed) ?? "?"} 个，现在只有 ${numeric(diagnostics.available) ?? "?"} 个。没有训练出模型，也没有给出任何数字。`;
  }
  if (rule === "nuisance_model_not_estimable") {
    return "某一折或最终的模型拟合不出来（没有收敛，或某个预测因子把结局分得一清二楚）。没有训练出模型，也没有给出任何数字。";
  }
  return "这份数据没有训练出模型。";
}

/**
 * @param {Record<string, any>} result
 * @param {{ result: Record<string, any>, staleMark: any }} context
 * @returns {Array<Record<string, any>>}
 */
function termRows(result, context) {
  const model = object(object(object(result.diagnostics).model).equation);
  const family = String(model.family ?? "");
  return list(model.terms).map(object).map((term) => {
    const coefficient = numeric(term.coefficient);
    if (coefficient === null) return null;
    const effect = family === "linear" ? coefficient : Math.exp(coefficient);
    const label = term.transform === "indicator" ? `${text(term.column) ?? "?"} = ${text(term.category) ?? "?"}` : `${text(term.column) ?? "?"}${term.transform && term.transform !== "identity" ? `（先取 ${({ log: "对数", log1p: "对数(1+x)", square: "平方" })[/** @type {"log"} */ (String(term.transform))] ?? String(term.transform)}）` : ""}`;
    return { label, unit: term.transform === "indicator" ? null : text(term.unit), effect: measureValue({ name: family === "linear" ? "model_coefficient" : "model_ratio", value: effect, source: "calculated" }, { kind: "comparator", ...context, tab: "comparator" }) };
  }).filter(Boolean);
}

/** @param {Record<string, any>} diag @param {number[]} lambdas @param {number[]} gammas */
function premisesOf(diag, lambdas, gammas) {
  const model = object(diag.model);
  const trained = object(model.trainedOn);
  const family = String(object(model.equation).family ?? "");
  const same = (/** @type {number[]} */ a, /** @type {number[]} */ b) => a.length === b.length && a.every((value, index) => Math.abs(value - b[index]) < 1e-12);
  const discountSource = same(lambdas, DEFAULT_LAMBDAS) && same(gammas, DEFAULT_GAMMAS) ? "default" : "given";
  /** @type {Array<Record<string, any>>} */
  const rows = [];
  const n = numeric(trained.rows);
  const events = numeric(trained.events);
  rows.push({ key: "prognosticTraining", label: "训练用的数据", value: `你自己的历史表，${n ?? "?"} 人${events !== null ? `（${events} 个${family === "cox" ? "事件" : "阳性"}）` : ""}；没有在别的人群验证过`, source: "given", decisive: true });
  rows.push({ key: "prognosticFolds", label: "怎样避免高估", value: `${numeric(trained.folds) ?? numeric(diag.folds) ?? "?"} 折交叉拟合：每个人的预测都来自没见过他的模型，下面所有的区分度、校准和相关都是这样算的`, source: "default", decisive: true });
  if (CORRELATION_WORDS[family]) rows.push({ key: "prognosticRho", label: "相关系数怎么算", value: CORRELATION_WORDS[family], source: "default", decisive: true });
  rows.push({ key: "prognosticDiscount", label: "样本量节省的折扣", value: `相关系数打 ${lambdas.map((value) => plain(value)).join("、")} 折，对照组标准差放大 ${gammas.map((value) => plain(value)).join("、")} 倍；节省只在预后分的相关在新人群里还成立时才有`, source: discountSource, decisive: true });
  const comparison = object(diag.comparison);
  if (numeric(comparison.value) !== null) rows.push({ key: "prognosticForest", label: "保存的模型", value: "回归方程；随机森林只作对照，不保存，也不会拿去应用", source: "default", decisive: false });
  return finishPremises(rows);
}

/**
 * @param {Record<string, any>} result @param {any} staleMark
 */
function cardOf(result, staleMark) {
  const diag = object(result.diagnostics);
  const context = { result, staleMark };
  const base = { id: String(result.id), version: Number(result.version) };
  if (result.conclusion === "not_estimable" || !object(diag.model).equation) {
    return { ...base, form: "refused", title: "预后模型没有训练出来", question: "这个预后分在没见过的人里区分得有多好？",
      refusal: refusalWords(diag, text(result.notEstimableRule)), headline: [], label: null, savings: null, terms: [], comparison: null, correlationNote: null, trainedOn: null, premises: [], limited: null };
  }
  const model = object(diag.model);
  const equation = object(model.equation);
  const family = String(equation.family ?? "");
  const shown = (/** @type {Record<string, any>} */ measure) => measureValue(measure, { kind: "comparator", ...context, tab: "comparator" });
  const byName = (/** @type {string} */ name) => list(result.measures).map(object).find((measure) => measure.name === name) ?? null;
  const headline = ["out_of_fold_c_index", "out_of_fold_auc", "out_of_fold_r_squared", "calibration_slope", "calibration_intercept", "calibration_in_the_large", "prognostic_correlation"]
    .map((name) => ({ name, measure: byName(name) })).filter((entry) => entry.measure)
    .map((entry) => ({ key: entry.name, label: measureLabel(entry.name), value: shown(/** @type {Record<string, any>} */ (entry.measure)) }));
  const procova = object(diag.procova);
  const lambdas = list(procova.lambdas).map(Number).filter(Number.isFinite);
  const gammas = list(procova.gammas).map(Number).filter(Number.isFinite);
  const rows = list(procova.rows).map(object);
  const savings = rows.length ? {
    columns: [{ key: "estimate", label: "按留出折上估计的相关" }, { key: "lower", label: "按相关的置信下限" }],
    rows: lambdas.flatMap((lambda) => gammas.map((gamma) => {
      const pick = (/** @type {string} */ which) => rows.find((row) => numeric(row.lambda) === lambda && numeric(row.gamma) === gamma && row.rhoAt === which) ?? null;
      const cell = (/** @type {Record<string, any> | null} */ row) => row ? { rho: numeric(row.rhoApplied), saving: shown(object(row.saving)), ratio: shown(object(row.sampleSizeRatio)) } : null;
      return { key: `${lambda}:${gamma}`, lambda, gamma, estimate: cell(pick("estimate")), lower: cell(pick("lower")) };
    })),
  } : null;
  const comparison = object(diag.comparison);
  const forest = numeric(comparison.value) !== null ? {
    label: "随机森林（同样的折，只作对照）", value: shown({ name: String(comparison.metric === "c_index" ? "out_of_fold_c_index" : comparison.metric === "auc" ? "out_of_fold_auc" : "out_of_fold_r_squared"), value: comparison.value, source: "calculated" }),
    difference: shown({ name: "comparison_forest_difference", value: comparison.difference, source: "calculated" }),
  } : null;
  const trained = object(model.trainedOn);
  const absolute = model.absoluteRiskAvailable !== false;
  return {
    ...base, form: "trained",
    title: `用你自己的历史数据训练的预后模型（${FAMILY_WORDS[family] ?? family}）`,
    question: "这个预后分在没见过的人里区分得有多好、校准得怎样；保守地估，用它做协变量调整能省多少样本？",
    label: "用你自己的数据训练，没有在别的人群验证过",
    headline, savings, terms: termRows(result, context), effectWords: EFFECT_WORDS[family] ?? null, comparison: forest,
    correlationNote: CORRELATION_WORDS[family] ?? null,
    trainedOn: { rows: numeric(trained.rows), events: numeric(trained.events), folds: numeric(trained.folds) ?? numeric(diag.folds), excluded: numeric(diag.excludedRows) },
    premises: premisesOf(diag, lambdas, gammas),
    limited: !absolute ? "时间点超出了数据的随访范围，保存的方程只给相对分数，没有绝对风险。" : null,
  };
}

/**
 * The cards of the comparator tab for the trained models the study holds now, newest first.
 * @param {Record<string, any>} bundle the comparator tab's bundle (`results`, `allResults`, `stale`)
 * @param {{ nodeOf: (result: Record<string, any>) => string }} helpers
 */
export function presentPrognosticModels(bundle, { nodeOf }) {
  const results = list(bundle.allResults ?? bundle.results).map(object).filter((row) => row.kind === "prognostic_training" && !row.supersededBy)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 8);
  return results.map((result) => cardOf(result, markFor(bundle.stale ?? [], nodeOf(result)))).filter(Boolean);
}

/** @param {Record<string, any>} result @param {any} staleMark exported for the tests that read one result */
export const prognosticCard = (result, staleMark = null) => cardOf(result, staleMark);
