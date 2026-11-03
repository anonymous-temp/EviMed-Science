/**
 * 「这个结论的前提」: the one block a result page opens with its assumptions (remediation plan 5.2).
 *
 * A result is only as good as the numbers it was computed from, and most of them were not typed by the researcher: an effect an
 * extraction pooled, a control level a model assumed, a dropout of 0 the engine took because nothing said otherwise. This module
 * turns the facts of a result (the scenario, the cards bound into it, the defaults the engine applied) into the list the page
 * shows, once per page and the same for the trial, the population and the comparator:
 *
 *   `{ key, label, value, source, decisive, reason? }` — `source` is one of 文献 / 假设 / 默认 / 你给的数据 (`VCR_PREMISE_SOURCES`).
 *
 * Rules the list keeps (the plan's presentation rule, which comes before each item's own "put it on the page"):
 *
 * - **At most five premises are decisive** (`VCR_PREMISES_DECISIVE_MAX`): the ones the conclusion turns on, in the order of
 *   `PRIORITY`. Every other premise is in the list too, not decisive, and the page folds them into one disclosure. The code
 *   ranks; it never writes a sentence about how much a premise matters.
 * - **A premise carries a value, or it is not a premise.** There is no banner here and no general caveat: a row exists because a
 *   number stands behind it, and each row has one way to change it (the page's 调整 draft into the native conversation, prefilled
 *   with the row's label).
 * - **A default is a premise.** A dropout of 0 the researcher never wrote is the commonest silent assumption of a survival design;
 *   it is listed as 默认 and, for survival, as decisive.
 * - **Pure.** Nothing is read from a store: the caller hands over what the page already holds, so the same inputs are the same
 *   list and the rules are testable without a database.
 *
 * @module vcrPremises
 */

import { VCR_EFFECT_DISCOUNT_LABEL_ZH, VCR_EFFECT_DISCOUNT_LIMITS_ZH, VCR_ESTIMAND_LABELS_ZH, VCR_PREMISES_DECISIVE_MAX, VCR_PREMISE_SOURCES } from "@evimed/domain";
import { imputationPremise } from "./vcrImputationView.mjs";
import { TIME_UNIT_WORDS, hazardLawWords, list, numeric, object, text } from "./vcrViewsKit.mjs";
import { biasEstimatePhrase, biasStatedWords } from "./vcrBiasAnalysis.mjs";

/**
 * @typedef {{ key: string, label: string, value: string, source: 'literature' | 'assumed' | 'default' | 'given', decisive: boolean,
 *   reason: string | null }} VcrPremise
 */

/**
 * The order premises are ranked in when more than five could be decisive: what moves a conclusion most first. A key not listed
 * ranks after every listed one and is never decisive.
 */
const PRIORITY = Object.freeze([
  "effect", "control", "dropout", "correlation", "similarity", "sampling", "accrual", "alpha", "assurance",
  // a comparison: how suitable it is, how far the target trial is emulated, what an indirect comparison leaves unadjusted, what a
  // borrowed prior rests on, how strong an unmeasured confounder would have to be
  "applicability", "targetTrial", "trimmedPopulation", "missingAtRandom", "maicTarget", "maicModifiers", "residual", "borrowedHistory", "priorWorth", "unmeasured",
  // a bias analysis: the estimate it analyses and the bias that was stated
  "biasEstimate", "biasStated",
]);

/**
 * A list of premises as the page reads it: well-formed rows only, one per key (the first wins), the decisive ones first in the
 * order of `PRIORITY` and no more than `VCR_PREMISES_DECISIVE_MAX` of them; a decisive row over the limit is a plain one.
 * @param {ReadonlyArray<Partial<VcrPremise> & { rank?: number }>} rows
 * @returns {VcrPremise[]}
 */
export function finishPremises(rows) {
  /** @type {Map<string, VcrPremise & { rank: number }>} */
  const byKey = new Map();
  for (const row of rows) {
    const key = text(row.key);
    const label = text(row.label);
    const value = text(row.value);
    if (!key || !label || !value || byKey.has(key)) continue;
    const source = /** @type {readonly string[]} */ (VCR_PREMISE_SOURCES).includes(String(row.source)) ? /** @type {VcrPremise["source"]} */ (row.source) : "assumed";
    const rank = PRIORITY.indexOf(key);
    byKey.set(key, { key, label, value, source, decisive: row.decisive === true, reason: text(row.reason), rank: rank < 0 ? PRIORITY.length : rank });
  }
  const ordered = [...byKey.values()].sort((a, b) => Number(b.decisive) - Number(a.decisive) || a.rank - b.rank);
  let open = 0;
  return ordered.map(({ rank: _rank, ...row }) => {
    if (!row.decisive) return row;
    open += 1;
    return open <= VCR_PREMISES_DECISIVE_MAX ? row : { ...row, decisive: false };
  });
}

/**
 * The premises of a view. One function for the three result pages; each page hands over what it already holds.
 * @param {'trial' | 'population' | 'comparator'} view
 * @param {Record<string, any>} input what the page holds (see each builder)
 * @returns {VcrPremise[]}
 */
export function vcrPremises(view, input) {
  const rows = view === "trial" ? trialPremises(input) : view === "population" ? populationPremises(input) : comparatorPremises(input);
  return finishPremises(rows);
}

// --- values ---------------------------------------------------------------------------------------------------------------------

/** A number as a premise says it: at most three significant digits, no trailing zeros. @param {number} value */
const plain = (value) => String(Number(value.toPrecision(3)));
/** A proportion as a percentage. @param {number} value */
const percent = (value) => `${plain(value * 100)}%`;

/**
 * Where an assumption card's number came from: evidence pooled from the literature, the researcher's own data, or a value somebody
 * stated. The card's `valueSource` says it; a pooled card (`pooling.k`) has a literature under it whatever it was labelled.
 * @param {Record<string, any> | null | undefined} card @returns {VcrPremise["source"]}
 */
export function premiseSourceOfCard(card) {
  const value = String(card?.valueSource ?? "");
  if (value === "observed" || value === "imputed") return "given";
  if (["extracted", "aggregate", "calculated", "reconstructed"].includes(value) || (numeric(object(card?.pooling).k) ?? 0) > 0) return "literature";
  return "assumed";
}

/**
 * Where a figure that came from one paper comes from, in the words the page prints beside it: the paper by its identifier and, when
 * the platform could not hold the number against a text it read of that paper, that it did not. A card made of a registry record or a
 * pool says nothing here.
 * @param {Record<string, any> | null | undefined} card @returns {string | null}
 */
export function premiseReasonOfCard(card) {
  const pooling = object(card?.pooling);
  if (typeof pooling.citation !== "string" || !pooling.citation) return null;
  if (pooling.unchecked !== true) return `引自 ${pooling.citation}`;
  // A value computed from the paper's numbers has no quotation to find: the paper is where its inputs came from.
  return ["calculated", "imputed", "predicted"].includes(String(card?.valueSource ?? "")) ? `引自 ${pooling.citation}，由论文里的数算出，数值未核对`
    : `引自 ${pooling.citation}，引文没有在平台读到的原文里找到，数值未核对`;
}

/** The row's `reason` when the figure has one. @param {{ reason?: string | null } | null | undefined} stood */
const reasonOf = (stood) => (stood?.reason ? { reason: stood.reason } : {});

/**
 * The unit a time quantity is stated in: the scenario's, else months, which is the unit the engine always assumed.
 * @param {Record<string, any>} configuration @param {Record<string, any>} diagnostics
 */
function timeWord(configuration, diagnostics) {
  const unit = String(object(diagnostics.timeUnitBasis).unit ?? configuration.timeUnit ?? "months");
  return TIME_UNIT_WORDS[unit]?.after ?? TIME_UNIT_WORDS.months.after;
}

// --- the trial ------------------------------------------------------------------------------------------------------------------

/**
 * The premises of a trial result: the design a person is looking at, the cards bound into it and the defaults its stages took.
 *
 * @param {{ endpointType?: string | null, configuration?: Record<string, any>, diagnostics?: Record<string, any>, effectDiscount?: Record<string, any> | null,
 *   bound?: ReadonlyArray<{ key?: string, path?: string }>, cards?: ReadonlyArray<Record<string, any>>,
 *   appliedDefaults?: ReadonlyArray<{ path: string, value?: unknown }>, hasAssurance?: boolean, assuranceReason?: string | null,
 *   designKind?: string | null }} input
 * `bound`: the cards that were laid over the scenario (the job's own record), by the path each filled; `cards`: the study's cards.
 * @returns {Array<Partial<VcrPremise>>}
 */
function trialPremises(input) {
  const configuration = object(input.configuration);
  const diagnostics = object(input.diagnostics);
  const type = String(input.endpointType ?? object(configuration.endpoint).type ?? "");
  const truth = object(configuration.truth);
  const accrual = object(configuration.accrual);
  const analysis = object(configuration.analysis);
  const defaults = new Map(list(input.appliedDefaults).map(object).map((entry) => [String(entry.path), entry.value]));
  // A job that recorded the number it took from a card (a conversation's own start) is read through that card only while the card still states
  // it: a later version with another number is not this job's premise.
  const cardByPath = new Map(list(input.bound).map(object).map((entry) => {
    const card = list(input.cards).map(object).find((candidate) => candidate.key === entry.key) ?? null;
    return [String(entry.path), card && (numeric(entry.value) === null || numeric(card.pointValue) === numeric(entry.value)) ? card : null];
  }));
  /**
   * The value a path has in the run — the card's when one was laid over it, else what the scenario states — and where it came from.
   * @param {string} path @param {unknown} stated @returns {{ value: unknown, source: VcrPremise["source"], reason?: string | null } | null}
   */
  const stand = (path, stated) => {
    const card = cardByPath.get(path);
    if (card && numeric(card.pointValue) !== null) return { value: numeric(card.pointValue), source: premiseSourceOfCard(card), reason: premiseReasonOfCard(card) };
    if (defaults.has(path)) return { value: defaults.get(path), source: "default" };
    return stated === undefined || stated === null ? null : { value: stated, source: "assumed" };
  };
  /** @type {Array<Partial<VcrPremise>>} */
  const rows = [];
  const time = timeWord(configuration, diagnostics);

  // A single-arm binary design (exact, Simon) has no control arm: it is held to a response rate it must beat and sized for the one it is
  // expected to have.
  const single = ["single_arm", "simon_two_stage"].includes(String(input.designKind ?? object(configuration.design).kind)) && type === "binary";
  // A non-inferiority margin (design.analytic / design.simulate 1.4.0): what the design has to rule out, as large a premise as the effect.
  const hypothesis = object(configuration.hypothesis);
  if (hypothesis.kind === "non_inferiority" && numeric(hypothesis.margin) !== null) {
    const margin = Number(hypothesis.margin);
    const words = type === "time_to_event" ? `风险比不超过 ${plain(margin)}` : type === "binary" ? `率差不低于 −${percent(margin)}` : `均数差不低于 −${plain(margin)}`;
    rows.push({ key: "margin", label: "非劣效界值", value: words, source: "assumed", decisive: true });
  }
  // The effect the design is sized for.
  if (single) {
    const alternative = stand("truth.alternativeRate", truth.alternativeRate ?? truth.responseRate);
    const nullRate = stand("truth.nullRate", truth.nullRate);
    if (alternative && numeric(alternative.value) !== null) rows.push({ key: "effect", label: "预期应答率（备择）", value: percent(Number(alternative.value)), source: alternative.source, ...reasonOf(alternative), decisive: true });
    if (nullRate && numeric(nullRate.value) !== null) rows.push({ key: "control", label: "要超过的应答率（零假设）", value: percent(Number(nullRate.value)), source: nullRate.source, decisive: true });
  } else if (type === "time_to_event") {
    const hr = stand("truth.hazardRatio", truth.hazardRatio);
    const law = hazardLawWords(truth.treatmentHazardRatios, time);
    if (hr && numeric(hr.value) !== null) rows.push({ key: "effect", label: "真实效应（风险比）", value: plain(Number(hr.value)), source: hr.source, ...reasonOf(hr), decisive: true });
    // a hazard ratio that changes over time has no single number to state; it is the effect, in the words it was written in
    else if (law) rows.push({ key: "effect", label: "真实效应（风险比随时间变化）", value: law, source: stand("truth.treatmentHazardRatios", truth.treatmentHazardRatios)?.source ?? "assumed", decisive: true });
  } else if (type === "continuous") {
    const effect = stand("truth.effect", truth.effect);
    if (effect && numeric(effect.value) !== null) rows.push({ key: "effect", label: "真实效应（均数差）", value: plain(Number(effect.value)), source: effect.source, ...reasonOf(effect), decisive: true });
  } else if (type === "binary") {
    const control = stand("truth.controlRate", truth.controlRate);
    const treatment = stand("truth.treatmentRate", truth.treatmentRate);
    const difference = stand("truth.riskDifference", truth.riskDifference);
    const odds = stand("truth.oddsRatio", truth.oddsRatio);
    const given = treatment ?? difference ?? odds;
    if (treatment && control && numeric(treatment.value) !== null && numeric(control.value) !== null) {
      rows.push({ key: "effect", label: "真实效应（试验组事件率）", value: percent(Number(treatment.value)), source: treatment.source, ...reasonOf(treatment), decisive: true });
    } else if (difference && numeric(difference.value) !== null) {
      rows.push({ key: "effect", label: "真实效应（风险差）", value: plain(Number(difference.value)), source: difference.source, ...reasonOf(difference), decisive: true });
    } else if (odds && numeric(odds.value) !== null) {
      rows.push({ key: "effect", label: "真实效应（优势比）", value: plain(Number(odds.value)), source: odds.source, ...reasonOf(odds), decisive: true });
    } else if (given && numeric(given.value) !== null) {
      rows.push({ key: "effect", label: "真实效应", value: plain(Number(given.value)), source: given.source, ...reasonOf(given), decisive: true });
    }
  }

  // The level the effect is measured against.
  if (single) {
    // stated above
  } else if (type === "time_to_event") {
    const median = stand("truth.controlMedian", truth.controlMedian);
    if (median && numeric(median.value) !== null) rows.push({ key: "control", label: "对照组中位时间", value: `${plain(Number(median.value))} ${time}`, source: median.source, ...reasonOf(median), decisive: true });
    const shape = defaults.has("truth.controlDistribution.kind") ? "指数分布" : null;
    if (shape) rows.push({ key: "controlDistribution", label: "对照组生存分布", value: shape, source: "default", decisive: false });
  } else if (type === "binary") {
    const rate = stand("truth.controlRate", truth.controlRate);
    if (rate && numeric(rate.value) !== null) rows.push({ key: "control", label: "对照组事件率", value: percent(Number(rate.value)), source: rate.source, ...reasonOf(rate), decisive: true });
  } else if (type === "continuous") {
    const sd = stand("truth.sd", truth.sd);
    if (sd && numeric(sd.value) !== null) rows.push({ key: "control", label: "结局的标准差", value: plain(Number(sd.value)), source: sd.source, ...reasonOf(sd), decisive: true });
  }

  // Dropout: a survival design loses a proportion each year, and when nothing says how many it loses none. The other endpoints have no
  // dropout in the simulation at all, which is the same silent assumption said once.
  if (type === "time_to_event") {
    const dropout = stand("accrual.dropoutAnnual", accrual.dropoutAnnual);
    if (dropout && numeric(dropout.value) !== null) rows.push({ key: "dropout", label: "每年脱落率", value: percent(Number(dropout.value)), source: dropout.source, ...reasonOf(dropout), decisive: true });
  } else if (type === "binary" || type === "continuous") {
    rows.push({ key: "dropout", label: "脱落", value: "不模拟，每位受试者都有结局", source: "default", decisive: true });
  }

  // Accrual and follow-up (survival only): how long patients are enrolled and watched decides how many events there are.
  if (type === "time_to_event") {
    const duration = numeric(accrual.duration);
    const followup = numeric(accrual.followup);
    const parts = [duration !== null ? `入组 ${plain(duration)} ${time}` : null, followup !== null ? `随访 ${plain(followup)} ${time}` : null].filter(Boolean);
    if (parts.length) rows.push({ key: "accrual", label: "入组与随访", value: parts.join("，"), source: "assumed", decisive: true });
  }

  // The error rates the decision is made at.
  const alpha = numeric(analysis.alpha) ?? numeric(defaults.get("analysis.alpha"));
  if (alpha !== null) {
    const sided = numeric(analysis.sided) ?? numeric(defaults.get("analysis.sided"));
    rows.push({ key: "alpha", label: "显著性水平", value: `${sided === 2 ? "双侧" : sided === 1 ? "单侧" : ""}${percent(alpha)}`, source: defaults.has("analysis.alpha") ? "default" : "assumed", decisive: true });
  }

  // What is applied and not decisive.
  const method = defaults.get("analysis.method") ?? analysis.method;
  const methodWord = /** @type {Record<string, string>} */ ({ logrank: "log-rank 检验", rmst: "RMST 比较", ttest: "t 检验", ancova: "协方差分析", risk_difference: "风险差检验", logistic: "逻辑回归" })[String(method)];
  if (methodWord) rows.push({ key: "method", label: "分析方法", value: methodWord, source: defaults.has("analysis.method") ? "default" : "assumed", decisive: false });
  if (type === "time_to_event" && defaults.has("accrual.kind")) rows.push({ key: "accrualKind", label: "入组方式", value: "匀速入组", source: "default", decisive: false });
  const timeBasis = object(diagnostics.timeUnitBasis);
  if (type === "time_to_event" && timeBasis.unit) {
    rows.push({ key: "timeUnit", label: "时间单位", value: String(TIME_UNIT_WORDS[String(timeBasis.unit)]?.bare ?? timeBasis.unit),
      source: timeBasis.basis === "stated" ? "assumed" : timeBasis.basis === "evidence" ? "literature" : "default", decisive: false });
  }

  // The power the design keeps when its effect shrinks the way planned effects have been measured to (C6): one folded row with the
  // figure's source and its limits, only where the engine computed it (an event-time endpoint with an effect in favour).
  const discount = object(input.effectDiscount);
  if (numeric(discount.power) !== null) {
    const hr = numeric(discount.hazardRatio);
    const target = numeric(discount.targetPower);
    rows.push({ key: "effectDiscount", label: VCR_EFFECT_DISCOUNT_LABEL_ZH, value: `${percent(Number(discount.power))}${hr !== null ? `（效应 HR ${plain(hr)}${target !== null ? `，按计划的效应设计把握度是 ${percent(target)}` : ""}）` : ""}`,
      source: "assumed", decisive: false, reason: VCR_EFFECT_DISCOUNT_LIMITS_ZH });
  }

  // A success probability that is not there, and why (A14): the effect was a single value, and a single value has nothing to integrate.
  if (input.hasAssurance === false && text(input.assuranceReason)) {
    rows.push({ key: "assurance", label: "成功把握", value: String(input.assuranceReason), source: "default", decisive: false });
  }
  return rows;
}

// --- the population -------------------------------------------------------------------------------------------------------------

/**
 * The premises of a generated population: how its variables relate, how far it is the source trial's, and how far its parameters
 * were allowed to move. A real cohort is its data, not a premise, and has none.
 *
 * @param {{ kind?: string | null, diagnostics?: Record<string, any> }} input `kind`: the population's kind (`literature`, `scenario`, …)
 * @returns {Array<Partial<VcrPremise>>}
 */
function populationPremises(input) {
  const kind = String(input.kind ?? "");
  if (kind === "real") return [];
  const diagnostics = object(input.diagnostics);
  const sources = object(diagnostics.columnSources);
  /** @type {Array<Partial<VcrPremise>>} */
  const rows = [];
  if (kind === "literature" || kind === "scenario") {
    // Without a matrix every variable is drawn on its own. Said as an assumption either way: a stated matrix is the author's, and the
    // engine does not check it against the source (`correlationVerification`).
    // A result from before the engine said it (`correlationVerification`) still tells by its sources: a matrix has a source row.
    const verification = diagnostics.correlationVerification;
    const hasSources = Object.keys(sources).length > 0;
    const independent = verification === "independence_assumed" || (hasSources && !Object.hasOwn(sources, "(correlation)"));
    const cited = verification === "declared_citation_not_verified_by_engine";
    if (verification !== undefined || hasSources) {
      rows.push({
        key: "correlation", label: "变量之间的相关性",
        value: independent ? "假设相互独立" : cited ? "引自文献的相关矩阵，引擎不核实" : "给定的相关矩阵，未经来源核实",
        source: kind === "literature" && cited ? "literature" : "assumed", decisive: true,
      });
    }
  }
  if (kind === "literature") {
    rows.push({ key: "similarity", label: "与来源试验人群的相似性", value: "未验证，只复现来源给出的汇总数", source: "assumed", decisive: true });
  }
  const draws = numeric(diagnostics.parameterDraws);
  const spread = list(diagnostics.parameterSpread).map(object);
  if (kind === "literature" || kind === "scenario") {
    rows.push({
      key: "sampling", label: "参数的不确定度",
      value: draws !== null && draws > 1
        ? `重抽 ${draws} 次${spread.length ? `，${spread.slice(0, 3).map((entry) => `${entry.variable} ${entry.parameter} 的标准差 ${plain(Number(entry.value))}`).join("；")}` : ""}`
        : "没有重抽：参数按给定值固定",
      source: draws !== null && draws > 1 ? "assumed" : "default", decisive: true,
    });
  }
  return rows;
}

// --- the comparator ---------------------------------------------------------------------------------------------------------------

/**
 * The premises of a comparator result: how suitable the run judged the comparison, how far the target trial can be emulated, what an
 * indirect comparison leaves unadjusted, what a borrowed prior rests on, and how strong an unmeasured confounder would have to be.
 * A record the run has not written is not a premise (no row has a value to show); the run is reminded of it in the answer of the
 * write, and what it costs the result is on the page as a limit.
 *
 * What an E-value is: how strong an unmeasured confounder would have to be to explain the estimate away. It is worded that way, as
 * the simplest level of bias analysis (it estimates no bias), and never as the absence of bias, which no number from the data can show.
 *
 * @param {{ route?: string | null, estimand?: string | null, estimandStated?: boolean, diagnostics?: Record<string, any>,
 *   measures?: Record<string, number | null>, applicability?: Record<string, any> | null,
 *   targetTrial?: { components: ReadonlyArray<{ key: string, label: string, status: string | null, statusLabel: string | null, text: string | null }> } | null,
 *   covariates?: readonly string[], anchored?: boolean | null }} input
 * `measures`: the result's numbers by name, for the few a premise quotes.
 * @returns {Array<Partial<VcrPremise>>}
 */
function comparatorPremises(input) {
  const diagnostics = object(input.diagnostics);
  const measures = object(input.measures);
  const route = String(input.route ?? "");
  /** @type {Array<Partial<VcrPremise>>} */
  const rows = [];

  // The run's own judgement of the comparison, first: FDA, EMA and the CDE all put it before the statistics.
  const applicability = object(input.applicability);
  if (applicability.present === true) {
    const value = [applicability.stateLabel, applicability.claimLabel ? `要支持${applicability.claimLabel}结论` : null].filter(Boolean).join("，")
      + (text(applicability.note) ? `：${text(applicability.note)}` : "");
    rows.push({ key: "applicability", label: "这项对照是否适用", value, source: "assumed", decisive: true });
  }

  // How far the control emulates the target trial: the components it cannot reproduce exactly are what the conclusion turns on. A
  // record whose components say nothing of how far they are emulated (the older shapes) has no value to show here; the page lists it.
  const components = list(object(input.targetTrial).components).map(object);
  if (components.some((entry) => entry.status !== null && entry.status !== undefined)) {
    const weak = components.filter((entry) => entry.status === "approximate" || entry.status === "not_possible");
    const value = weak.length ? weak.map((entry) => `${entry.label}：${entry.statusLabel}`).join("；")
      : components.every((entry) => entry.status === "exact") ? "已记录的要素都可以精确复现" : "已标注的要素都可以精确复现";
    rows.push({ key: "targetTrial", label: "目标试验的复现程度", value, source: "assumed", decisive: weak.length > 0 });
  }

  // An indirect comparison of a published trial (MAIC): who the effect is for, what is left unadjusted, and, without a common
  // comparator, that the size of the residual error is not known.
  if (typeof input.anchored === "boolean") {
    if (diagnostics.targetPopulation === "aggregate_data_trial") {
      rows.push({ key: "maicTarget", label: "目标人群", value: "对方试验已发表的人群（只有汇总数）", source: "literature", decisive: true });
    }
    const modifiers = list(diagnostics.unadjustedEffectModifiers).map(String).filter(Boolean);
    rows.push({ key: "maicModifiers", label: "未调整的效应修饰因子", value: modifiers.length ? modifiers.join("、") : "没有列出", source: "assumed", decisive: true });
    // Without a common comparator the comparison is unbiased only if every prognostic factor and effect modifier was adjusted: that is the
    // premise itself, said once with its value, and not a caveat about error of an unknown size.
    if (input.anchored === false) rows.push({ key: "residual", label: "无锚定", value: "假定所有预后因子和效应修饰因子都已调整", source: "default", decisive: true });
  }

  // A borrowed prior rests on the historical numbers it was built from, and is worth some number of this study's patients.
  if (route === "hybrid_control") {
    rows.push({ key: "borrowedHistory", label: "历史对照的数字",
      value: diagnostics.inputsAssumed === true ? "没有经过核对的来源（输入为假设）" : "来自核对过的证据",
      source: diagnostics.inputsAssumed === true ? "assumed" : "literature", decisive: true });
    const worth = numeric(measures.prior_effective_sample_size_elir) ?? numeric(measures.map_effective_sample_size_elir);
    if (worth !== null) rows.push({ key: "priorWorth", label: "先验相当于多少例患者", value: `${plain(worth)} 例`, source: "literature", decisive: true });
  }

  // How strong an unmeasured confounder would have to be (E-value, after the estimate).
  const point = numeric(measures.e_value);
  if (point !== null) {
    const limit = numeric(measures.e_value_confidence_limit);
    rows.push({ key: "unmeasured", label: "未测量的混杂",
      value: `E 值 ${plain(point)}${limit !== null ? `（置信限 ${plain(limit)}）` : ""}：未测量的混杂要和处理、结局各有这么强的关联，才能解释掉这个结果；它只回答“要多强”，是偏倚分析里最简单的一层，不估计偏倚本身`,
      source: "assumed", decisive: true });
  }

  // The bias analysis of an estimate (C1, C2): which estimate, and the bias the person said, with the grid of associations the engine took
  // when none was said (a default, not a finding). Only the exaggerating bias is considered, and that is a premise too.
  const bias = object(diagnostics.biasAnalysis);
  if (Object.keys(bias).length) {
    const phrase = biasEstimatePhrase(bias);
    if (phrase) rows.push({ key: "biasEstimate", label: "被分析的估计", value: phrase, source: "given", decisive: true });
    const stated = biasStatedWords(bias);
    if (stated) rows.push({ key: "biasStated", label: "设定的偏倚", value: stated, source: "assumed", decisive: true });
    const grid = list(bias.assumed).map(object).find((entry) => entry.key === "confounderTipping.associations");
    if (grid) rows.push({ key: "biasGrid", label: "混杂强度的取值", value: `${list(grid.value).map((entry) => plain(Number(entry))).join("、")}（没有设定，按参考网格算）`, source: "default", decisive: false });
    rows.push({ key: "biasDirection", label: "偏倚的方向", value: "只考虑把效应夸大的偏倚（去掉它，估计值向无效线靠近）", source: "default", decisive: false });
  }

  // Who the estimate is about after a propensity trimming: the people with no comparable counterpart are removed, so the conclusion is the
  // kept people's (EU HTA guideline 6.2). A fixed bound is the person's; Crump's rule is the engine's default.
  const trim = object(diagnostics.trim);
  if (Object.keys(trim).length && Number(trim.removedTotal) > 0) {
    const arms = list(trim.arms).map(object);
    const removed = (/** @type {string} */ arm) => Number(arms.find((entry) => entry.arm === arm)?.removed ?? 0);
    rows.push({ key: "trimmedPopulation", label: "修剪后的目标人群",
      value: `去掉试验组 ${removed("treated")} 例、对照组 ${removed("control")} 例（倾向评分低于 ${plain(Number(trim.lower))} 或高于 ${plain(Number(trim.upper))}）；结论只适用于留下的人`,
      source: trim.rule === "fixed" ? "assumed" : "default", decisive: true });
  }

  // Missing covariates that were imputed: how much, how often, and the assumption about why (missing at random given what was seen).
  const imputed = imputationPremise(diagnostics);
  if (imputed) rows.push(imputed);

  // A time-to-event doubly robust estimate rests on pseudo-observations, which need censoring not to depend on the covariates within an arm.
  if (object(diagnostics.timeToEvent).censoring) {
    rows.push({ key: "censoringIndependent", label: "删失的假定", value: "每一组内，删失与协变量无关（伪观测值法的前提）", source: "default", decisive: false });
  }

  // What an external control is estimated for, and what it is adjusted by: stated, and folded.
  if (route === "external_control") {
    const estimand = text(input.estimand);
    if (estimand) {
      rows.push({ key: "estimand", label: "估计目标", value: /** @type {Record<string, string>} */ (VCR_ESTIMAND_LABELS_ZH)[estimand] ?? estimand,
        source: input.estimandStated === true ? "assumed" : "default", decisive: false });
    }
    const covariates = list(input.covariates).map(String).filter(Boolean);
    if (covariates.length) {
      rows.push({ key: "covariates", label: "调整的协变量", value: `${covariates.slice(0, 6).join("、")}${covariates.length > 6 ? ` 等 ${covariates.length} 个` : ""}`, source: "assumed", decisive: false });
    }
  }
  return rows;
}
