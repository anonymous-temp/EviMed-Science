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

import { VCR_PREMISES_DECISIVE_MAX, VCR_PREMISE_SOURCES } from "@evimed/domain";
import { TIME_UNIT_WORDS, list, numeric, object, text } from "./vcrViewsKit.mjs";

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
 * @param {{ endpointType?: string | null, configuration?: Record<string, any>, diagnostics?: Record<string, any>,
 *   bound?: ReadonlyArray<{ key?: string, path?: string }>, cards?: ReadonlyArray<Record<string, any>>,
 *   appliedDefaults?: ReadonlyArray<{ path: string, value?: unknown }>, hasAssurance?: boolean, assuranceReason?: string | null,
 *   design?: string | null }} input
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
  const cardByPath = new Map(list(input.bound).map(object).map((entry) => [String(entry.path), list(input.cards).map(object).find((card) => card.key === entry.key) ?? null]));
  /**
   * The value a path has in the run — the card's when one was laid over it, else what the scenario states — and where it came from.
   * @param {string} path @param {unknown} stated @returns {{ value: unknown, source: VcrPremise["source"] } | null}
   */
  const stand = (path, stated) => {
    const card = cardByPath.get(path);
    if (card && numeric(card.pointValue) !== null) return { value: numeric(card.pointValue), source: premiseSourceOfCard(card) };
    if (defaults.has(path)) return { value: defaults.get(path), source: "default" };
    return stated === undefined || stated === null ? null : { value: stated, source: "assumed" };
  };
  /** @type {Array<Partial<VcrPremise>>} */
  const rows = [];
  const time = timeWord(configuration, diagnostics);

  // The effect the design is sized for.
  if (type === "time_to_event") {
    const hr = stand("truth.hazardRatio", truth.hazardRatio);
    if (hr && numeric(hr.value) !== null) rows.push({ key: "effect", label: "真实效应（风险比）", value: plain(Number(hr.value)), source: hr.source, decisive: true });
  } else if (type === "continuous") {
    const effect = stand("truth.effect", truth.effect);
    if (effect && numeric(effect.value) !== null) rows.push({ key: "effect", label: "真实效应（均数差）", value: plain(Number(effect.value)), source: effect.source, decisive: true });
  } else if (type === "binary") {
    const control = stand("truth.controlRate", truth.controlRate);
    const treatment = stand("truth.treatmentRate", truth.treatmentRate);
    const difference = stand("truth.riskDifference", truth.riskDifference);
    const odds = stand("truth.oddsRatio", truth.oddsRatio);
    const given = treatment ?? difference ?? odds;
    if (treatment && control && numeric(treatment.value) !== null && numeric(control.value) !== null) {
      rows.push({ key: "effect", label: "真实效应（试验组事件率）", value: percent(Number(treatment.value)), source: treatment.source, decisive: true });
    } else if (difference && numeric(difference.value) !== null) {
      rows.push({ key: "effect", label: "真实效应（风险差）", value: plain(Number(difference.value)), source: difference.source, decisive: true });
    } else if (odds && numeric(odds.value) !== null) {
      rows.push({ key: "effect", label: "真实效应（优势比）", value: plain(Number(odds.value)), source: odds.source, decisive: true });
    } else if (given && numeric(given.value) !== null) {
      rows.push({ key: "effect", label: "真实效应", value: plain(Number(given.value)), source: given.source, decisive: true });
    }
  }

  // The level the effect is measured against.
  if (type === "time_to_event") {
    const median = stand("truth.controlMedian", truth.controlMedian);
    if (median && numeric(median.value) !== null) rows.push({ key: "control", label: "对照组中位时间", value: `${plain(Number(median.value))} ${time}`, source: median.source, decisive: true });
    const shape = defaults.has("truth.controlDistribution.kind") ? "指数分布" : null;
    if (shape) rows.push({ key: "controlDistribution", label: "对照组生存分布", value: shape, source: "default", decisive: false });
  } else if (type === "binary") {
    const rate = stand("truth.controlRate", truth.controlRate);
    if (rate && numeric(rate.value) !== null) rows.push({ key: "control", label: "对照组事件率", value: percent(Number(rate.value)), source: rate.source, decisive: true });
  } else if (type === "continuous") {
    const sd = stand("truth.sd", truth.sd);
    if (sd && numeric(sd.value) !== null) rows.push({ key: "control", label: "结局的标准差", value: plain(Number(sd.value)), source: sd.source, decisive: true });
  }

  // Dropout: a survival design loses a proportion each year, and when nothing says how many it loses none. The other endpoints have no
  // dropout in the simulation at all, which is the same silent assumption said once.
  if (type === "time_to_event") {
    const dropout = stand("accrual.dropoutAnnual", accrual.dropoutAnnual);
    if (dropout && numeric(dropout.value) !== null) rows.push({ key: "dropout", label: "每年脱落率", value: percent(Number(dropout.value)), source: dropout.source, decisive: true });
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
 * The premises of a comparator result. The comparator page fills this in (the route's estimand, the covariates the comparison
 * adjusts for, the borrowing weight): the list and its rules are this module's, the facts are that page's.
 * @param {Record<string, any>} _input
 * @returns {Array<Partial<VcrPremise>>}
 */
function comparatorPremises(_input) {
  return [];
}
