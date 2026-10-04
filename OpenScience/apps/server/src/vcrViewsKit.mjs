/**
 * The vocabulary of a 「虚拟临研」 page, spoken once: how a stored measure
 * becomes the `VcrValue` the browser prints, how counts, times and stale marks
 * are worded, and the small pure helpers every page presenter shares
 * (contract 2026-09-29 §5).
 *
 * Hidden knowledge:
 *
 * - **A number is never a bare number.** Every measure leaves here as
 *   `{ value, unit, source, interval, mcse, review, stale, detail }`. The value
 *   source comes from the engine when it names one, and otherwise from the
 *   kind of result the measure lives in — a simulated trial measure is
 *   `predicted`, a pooled literature value `aggregate`, a reconstructed curve
 *   `reconstructed` — so an unlabelled number can never pass for an
 *   observation.
 * - **Proportions are shown as percentages**, and their Monte-Carlo error and
 *   interval move with them (0.712 ± 0.0031 becomes 71.2 % ± 0.31). The engine
 *   keeps proportions as fractions, and the page is the only place they are
 *   multiplied — once, here, so no component has to guess which scale a value
 *   is on.
 * - **The value is printed to the precision of its own error.** A number with a
 *   Monte-Carlo standard error carries `precision`: the decimal place of the
 *   error's first significant digit, so 71.2 ± 0.31 and never 71.23456. The
 *   browser honours a `precision` it is sent and otherwise falls back to the
 *   same rule.
 * - **A failed or missing measure is a word, never a zero.** A value that is
 *   not a finite number becomes `{ value: null, text }`, with the not-estimable
 *   rule as its reason when that is what happened.
 * - **Times are said the way a reader says them** (「今天 14:32」), in China
 *   standard time, from an injected clock — the fixture tests fix the clock and
 *   nothing else in a page depends on when it was rendered.
 * - **Nothing here computes a statistic.** Percent scaling, rounding and
 *   counting stored rows are the whole of the arithmetic.
 *
 * @module vcrViewsKit
 */

import {
  VCR_COUNT_KEYS, VCR_INTERVAL_KINDS, VCR_NOT_ESTIMABLE_RULE_LABELS_ZH, VCR_PERFORMANCE_MEASURE_LABELS_ZH,
  VCR_STALE_REASON_LABELS_ZH, VCR_VALUE_SOURCES,
} from "@evimed/domain";

/** @param {unknown} value */
export const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
/** @param {unknown} value */
export const list = (value) => (Array.isArray(value) ? value : []);
/** @param {unknown} value @returns {number | null} */
export const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
/** A number from a value that may be a numeric string (a `numeric` column). @param {unknown} value @returns {number | null} */
export const numeric = (value) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};
/** @param {unknown} value @returns {string | null} */
export const text = (value) => (typeof value === "string" && value.trim() ? value : null);

// --- people ------------------------------------------------------------------------

/** What a person whose account no longer exists is called: what they did stays on the study, their id never reaches a reader. */
export const VCR_PERSON_GONE_ZH = "已注销的账号";
/** What the platform's own hand is called where an account would be (the referral ledger's `control-plane`). */
export const VCR_PLATFORM_ACTOR_ZH = "平台";
/** The actors the platform writes in the place of an account. */
const PLATFORM_ACTORS = new Set(["control-plane", "system", "platform"]);

/**
 * A person as a reader sees them — by name, never by account id. `people` is the
 * names one page resolved (`VcrStoreBase.personNames`, the join `reviews()` makes):
 * the account's name; the platform's own label for the platform's own hand; a
 * neutral label for an account that no longer exists. Where nothing was resolved
 * at all (a presenter given a bundle without names) it says nothing, rather than
 * the id: an id in a person's place is the defect this exists to end.
 * @param {ReadonlyMap<string, string> | null | undefined} people @param {unknown} id @returns {string | null}
 */
export function personName(people, id) {
  const key = text(id);
  if (!key) return null;
  if (PLATFORM_ACTORS.has(key)) return VCR_PLATFORM_ACTOR_ZH;
  if (!(people instanceof Map)) return null;
  return people.get(key) ?? VCR_PERSON_GONE_ZH;
}

/** Round to a number of decimals without a string round-trip surprise. @param {number} value @param {number} decimals */
export function roundTo(value, decimals) {
  const scale = 10 ** decimals;
  return Math.round((value + Number.EPSILON * Math.sign(value)) * scale) / scale;
}

// --- time -------------------------------------------------------------------------

/** China standard time has no daylight saving: a fixed offset is the whole rule. */
const CST_OFFSET_MS = 8 * 3_600_000;

/** @param {number} value */
const two = (value) => String(value).padStart(2, "0");

/**
 * 「今天 14:32」「昨天 14:32」「9 月 27 日 17:40」「2025 年 12 月 3 日」 — the
 * way a reader says when something happened, in China standard time.
 * @param {string | Date | null | undefined} moment @param {Date} now
 * @returns {string | null}
 */
export function zhTime(moment, now) {
  if (moment == null || moment === "") return null;
  const at = new Date(moment);
  if (Number.isNaN(at.getTime())) return null;
  const local = new Date(at.getTime() + CST_OFFSET_MS);
  const today = new Date(now.getTime() + CST_OFFSET_MS);
  const day = (/** @type {Date} */ date) => Math.floor(date.getTime() / 86_400_000);
  const clock = `${two(local.getUTCHours())}:${two(local.getUTCMinutes())}`;
  const gap = day(today) - day(local);
  if (gap === 0) return `今天 ${clock}`;
  if (gap === 1) return `昨天 ${clock}`;
  if (local.getUTCFullYear() === today.getUTCFullYear()) return `${local.getUTCMonth() + 1} 月 ${local.getUTCDate()} 日 ${clock}`;
  return `${local.getUTCFullYear()} 年 ${local.getUTCMonth() + 1} 月 ${local.getUTCDate()} 日`;
}

/** The date alone: 「9 月 27 日」. @param {string | Date | null | undefined} moment @param {Date} now */
export function zhDate(moment, now) {
  const full = zhTime(moment, now);
  if (!full) return null;
  return full.replace(/^(今天|昨天) \d\d:\d\d$/, (word) => word.slice(0, 2)).replace(/ \d\d:\d\d$/, "");
}

// --- precision ----------------------------------------------------------------------

/**
 * The number of decimals that keeps `digits` significant digits of a positive
 * error term: 0.0031 → 4 for two digits, 3 for one.
 * @param {number} error @param {number} digits
 */
export function decimalsFor(error, digits) {
  if (!(error > 0) || !Number.isFinite(error)) return 0;
  return Math.max(0, Math.min(8, digits - 1 - Math.floor(Math.log10(error))));
}

// --- value sources ---------------------------------------------------------------------

/**
 * The source a measure has when the engine did not name one, from the kind of
 * result it lives in. Conservative on purpose: anything unclear reads as
 * `predicted` (a model's output), never as `observed`.
 * @param {string} kind @param {Record<string, any>} measure @param {Record<string, any>} [context]
 */
export function defaultSourceOf(kind, measure, context = {}) {
  const simulated = measure?.simulated === true;
  switch (kind) {
    case "trial_scenario": return simulated ? "predicted" : "calculated";
    case "design_grid": case "accrual_forecast": return "predicted";
    case "evidence_pool": return context.method === "evidence.reconstruct_km" ? "reconstructed" : "aggregate";
    case "population": {
      if (context.populationKind === "real") return "observed";
      if (context.populationKind === "literature") return "aggregate";
      if (context.populationKind === "empirical_synthetic") return "synthetic";
      return measure?.name === "cohort_size" ? "calculated" : "assumed";
    }
    case "patient_set": return String(measure?.name ?? "") === "generated_records" ? "synthetic" : "predicted";
    case "comparator": return context.route === "literature_control" ? "reconstructed" : "calculated";
    case "matching": case "snapshot_profile": return "calculated";
    default: return simulated ? "predicted" : "calculated";
  }
}

// --- measures ------------------------------------------------------------------------------

// --- robustness methods ---
/**
 * The measures the three robustness methods emit, said in Chinese: a negative-control screen, a tipping-point analysis (binary and
 * time to event) and a prognostic-adjusted marginal effect. One table, so the page's list of what it shows beside the comparison and
 * the labels cannot drift apart; a test walks the engine's own measure names against it.
 * @type {Readonly<Record<string, { label: string, unit?: string, percent?: boolean }>>}
 */
const ROBUSTNESS_MEASURE_META = Object.freeze({
  negative_controls_analysed: { label: "能分析的阴性对照个数", unit: "个" },
  negative_controls_signalling_bias: { label: "提示残余偏倚的阴性对照个数", unit: "个" },
  empirical_null_mean: { label: "经验零分布的均值" },
  empirical_null_sd: { label: "经验零分布的标准差" },
  primary_log_effect: { label: "主要结局的效应（对数尺度）" },
  uncalibrated_p_value: { label: "主要结局的 P 值（未校准）" },
  calibrated_p_value: { label: "主要结局的 P 值（经阴性对照校准）" },
  primary_p_value: { label: "按已观察到的数据得出的 P 值" },
  grid_cells: { label: "检验过的缺失结局组合数", unit: "种" },
  cells_changing_conclusion: { label: "改变结论的组合数", unit: "种" },
  share_changing_conclusion: { label: "改变结论的组合占比", unit: "%", percent: true },
  worst_case_p_value: { label: "最不利组合的 P 值" },
  tipping_distance: { label: "最近的临界点需要改变的缺失结局数", unit: "例" },
  tipping_treatment_responders: { label: "临界点处试验组的有效例数", unit: "例" },
  tipping_control_responders: { label: "临界点处对照组的有效例数", unit: "例" },
  tipping_treatment_rate: { label: "临界点处试验组缺失者的有效比例", unit: "%", percent: true },
  tipping_control_rate: { label: "临界点处对照组缺失者的有效比例", unit: "%", percent: true },
  primary_log_hazard_ratio: { label: "主要分析的风险比对数" },
  primary_hazard_ratio: { label: "主要分析的风险比" },
  delta_one_log_hazard_ratio: { label: "偏移为 1（无附加惩罚）时的风险比对数" },
  imputed_early_censored_people: { label: "被插补的提前删失人数", unit: "人" },
  worst_case_log_hazard_ratio: { label: "极端情形（偏移趋于无穷）的风险比对数" },
  tipping_delta: { label: "改变结论的临界偏移倍数" },
  marginal_risk_difference: { label: "边际风险差" },
  marginal_risk_ratio: { label: "边际风险比（RR）" },
  marginal_odds_ratio: { label: "边际比值比（OR）" },
  conditional_odds_ratio: { label: "条件比值比（模型系数）" },
  risk_treatment_standardised: { label: "标准化后的试验组风险", unit: "%", percent: true },
  risk_control_standardised: { label: "标准化后的对照组风险", unit: "%", percent: true },
  unadjusted_risk_difference: { label: "未校正的风险差" },
  empirical_variance_ratio: { label: "校正后与未校正的方差比" },
  conditional_hazard_ratio: { label: "条件风险比（Cox 模型）" },
  marginal_rmst_difference: { label: "边际 RMST 差" },
  rmst_treatment_standardised: { label: "标准化后的试验组 RMST" },
  rmst_control_standardised: { label: "标准化后的对照组 RMST" },
  unadjusted_rmst_difference: { label: "未校正的 RMST 差" },
});
/** The measure names of the robustness methods, which the comparator page lists beside the comparison. */
export const VCR_ROBUSTNESS_MEASURES = Object.freeze(Object.keys(ROBUSTNESS_MEASURE_META));
// --- end robustness methods ---

/**
 * What a measure name means on a page: its label, its unit, and whether the
 * engine's fraction is shown as a percentage. The domain owns the names it
 * defines; the rest are the engine's own.
 * @type {Readonly<Record<string, { label: string, unit?: string, percent?: boolean }>>}
 */
export const MEASURE_META = Object.freeze({
  power: { label: VCR_PERFORMANCE_MEASURE_LABELS_ZH.power, unit: "%", percent: true },
  type_one_error: { label: VCR_PERFORMANCE_MEASURE_LABELS_ZH.type_one_error, unit: "%", percent: true },
  coverage: { label: VCR_PERFORMANCE_MEASURE_LABELS_ZH.coverage, unit: "%", percent: true },
  assurance: { label: "成功把握", unit: "%", percent: true },
  power_at_prior_mean: { label: "先验均值处的功效", unit: "%", percent: true },
  bias: { label: VCR_PERFORMANCE_MEASURE_LABELS_ZH.bias },
  empirical_se: { label: "经验标准误" },
  mse: { label: "均方误差" },
  expected_sample_size: { label: VCR_PERFORMANCE_MEASURE_LABELS_ZH.expected_sample_size, unit: "例" },
  expected_events: { label: "期望事件数", unit: "个" },
  expected_analyses: { label: "期望分析次数" },
  required_total: { label: "所需样本量", unit: "例" },
  required_per_arm: { label: "每组所需样本量", unit: "例" },
  required_control: { label: "对照组所需样本量", unit: "例" },
  required_patients: { label: "所需患者数", unit: "例" },
  required_events: { label: "所需事件数", unit: "个" },
  event_probability: { label: "事件发生概率", unit: "%", percent: true },
  last_patient_in_months: { label: "末例入组", unit: "个月" },
  target_events_months: { label: "达到目标事件数", unit: "个月" },
  expected_completion_time: { label: "预计入组完成", unit: "个月" },
  median_survival: { label: "中位生存时间", unit: "个月" },
  rmst_difference: { label: "RMST 差" },
  rmst_treatment: { label: "试验组 RMST" },
  rmst_control: { label: "对照组 RMST" },
  survival_difference_at_tau: { label: "τ 时的生存率差", unit: "%", percent: true },
  weighted_difference: { label: "加权后的效应差" },
  effective_sample_size: { label: "有效样本量", unit: "例" },
  worst_standardized_difference: { label: "加权后最大标准化差异" },
  indirect_estimate: { label: "间接比较估计" },
  hazard_ratio: { label: "风险比" },
  hazard_ratio_robust: { label: "风险比（稳健方差）" },
  hazard_ratio_unadjusted: { label: "未调整的风险比" },
  hazard_ratio_ac_adjusted: { label: "调整后的 A 对 C 风险比" },
  hazard_ratio_ac_unadjusted: { label: "未调整的 A 对 C 风险比" },
  hazard_ratio_bc: { label: "B 对 C 风险比" },
  log_hazard_ratio_se_robust: { label: "对数风险比的标准误（稳健）" },
  log_hazard_ratio_se_bootstrap: { label: "对数风险比的标准误（自助法）" },
  ph_test_chisq: { label: "等比例风险检验统计量" },
  ph_test_p: { label: "等比例风险检验 P 值" },
  aipw_difference: { label: "双重稳健效应差" },
  aipw_difference_influence: { label: "双重稳健效应差（影响函数区间）" },
  aipw_difference_se_influence: { label: "效应差的标准误（影响函数）" },
  aipw_difference_se_bootstrap: { label: "效应差的标准误（自助法）" },
  aipw_risk_ratio: { label: "双重稳健风险比（RR）" },
  aipw_odds_ratio: { label: "双重稳健比值比（OR）" },
  outcome_mean_treated: { label: "试验组的结局均值" },
  outcome_mean_control_adjusted: { label: "校正后的对照结局均值" },
  covariate_set_range_low: { label: "各协变量集估计的最小值" },
  covariate_set_range_high: { label: "各协变量集估计的最大值" },
  covariate_set_range_width: { label: "各协变量集估计的范围宽度" },
  covariate_sets_total: { label: "协变量集个数", unit: "组" },
  covariate_sets_estimable: { label: "能估计的协变量集个数", unit: "组" },
  e_value: { label: "E 值" },
  e_value_confidence_limit: { label: "E 值（置信限）" },
  pooled: { label: "合并估计" },
  i_squared: { label: "I²", unit: "%", percent: true },
  tau_squared: { label: "τ²" },
  tau: { label: "τ" },
  k: { label: "纳入的研究数", unit: "项" },
  cohort_size: { label: "队列人数", unit: "人" },
  generated_records: { label: "生成记录数" },
  criteria_total: { label: "入排条件数" },
  criteria_unknown: { label: "无法判断的条件数" },
  criteria_not_satisfied: { label: "不满足的条件数" },
  variance_ratio: { label: "方差比" },
  map_mean: { label: "MAP 先验均值" },
  map_sd: { label: "MAP 先验标准差" },
  prior_effective_sample_size: { label: "先验有效样本量", unit: "例" },
  eligible: { label: "符合", unit: "人" },
  insufficient_evidence: { label: "证据不足", unit: "人" },
  pending: { label: "待复评", unit: "人" },
  ineligible: { label: "不符合", unit: "人" },
  rows: { label: "行数" },
  columns: { label: "列数" },
  cells: { label: "网格单元数" },
  median_pfs_control: { label: "对照组中位 PFS", unit: "个月" },
  events: { label: "事件数", unit: "个" },
  events_control: { label: "对照组事件数", unit: "个" },
  events_treatment: { label: "试验组事件数", unit: "个" },
  median_survival_control: { label: "对照组中位生存时间", unit: "个月" },
  median_survival_treatment: { label: "试验组中位生存时间", unit: "个月" },
  log_hazard_ratio: { label: "风险比的对数（重建）" },
  prior_effective_sample_size_moment: { label: "先验有效样本量（矩法）", unit: "例" },
  prior_effective_sample_size_elir: { label: "先验有效样本量（ELIR）", unit: "例" },
  prior_effective_sample_size_ceiling: { label: "先验有效样本量的上界", unit: "例" },
  map_effective_sample_size_moment: { label: "MAP 先验有效样本量（矩法）", unit: "例" },
  map_effective_sample_size_elir: { label: "MAP 先验有效样本量（ELIR）", unit: "例" },
  tau_posterior_median: { label: "研究间异质性 τ（后验中位数）" },
  ...ROBUSTNESS_MEASURE_META,
});

/** The unit words the engine writes, said in Chinese. */
const UNIT_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({
  months: "个月", month: "个月", days: "天", day: "天", weeks: "周", years: "年", "%": "%",
}));

/** @param {string} name */
const isProportionName = (name) => MEASURE_META[name]?.percent === true || name.startsWith("probability_by_");

/** @param {string} name */
export function measureLabel(name) {
  const known = MEASURE_META[name]?.label;
  if (known) return known;
  const by = /^probability_by_(.+)$/.exec(name);
  if (by) return `${by[1].replace(/_/g, "-")} 前完成的概率`;
  const set = /^covariate_set_estimate_(\d+)$/.exec(name);
  if (set) return `第 ${set[1]} 个协变量集的估计`;
  return name;
}

/** @param {unknown} moment */
const textOrNull = (moment) => (typeof moment === "string" && moment ? moment : null);

/**
 * An interval on the page's scale, with its name kept. `decimals` is the
 * precision the value beside it is printed to: an interval read off a CI with no
 * Monte-Carlo error (an RMST difference) is stated to the decimals its own width
 * supports, so 1.64 (0.39–2.88) and never 0.38681–2.883581.
 * @param {unknown} raw @param {number} scale @param {number | null} [decimals]
 */
export function intervalView(raw, scale = 1, decimals = null) {
  const interval = object(raw);
  const kind = String(interval.kind ?? "");
  if (!VCR_INTERVAL_KINDS.includes(kind)) return null;
  const low = finite(interval.low);
  const high = finite(interval.high);
  if (low === null && high === null) return null;
  const level = finite(interval.level);
  const places = decimals === null ? 6 : Math.min(6, Math.max(0, decimals));
  return {
    kind,
    low: low === null ? null : roundTo(low * scale, places),
    high: high === null ? null : roundTo(high * scale, places),
    // The engine keeps a level as a fraction (0.95); the page says 95.
    level: level === null ? null : (level <= 1 ? roundTo(level * 100, 6) : level),
  };
}

/**
 * One measure as a page value.
 *
 * @param {Record<string, any>} measure the stored measure
 * @param {{ kind: string, result?: Record<string, any> | null, execution?: Record<string, any> | null,
 *   staleMark?: Record<string, any> | null, context?: Record<string, any>, tab?: string | null, label?: string }} options
 */
export function measureValue(measure, options) {
  const { kind, result = null, execution = null, staleMark = null, context = {}, tab = null } = options;
  const name = String(measure?.name ?? "");
  /** @type {{ label?: string, unit?: string, percent?: boolean }} */
  const meta = MEASURE_META[name] ?? {};
  const percent = isProportionName(name);
  const scale = percent ? 100 : 1;
  const raw = finite(measure?.value);
  const mcseRaw = finite(measure?.mcse);
  const value = raw === null ? null : roundTo(raw * scale, 8);
  const mcse = mcseRaw === null ? null : roundTo(mcseRaw * scale, 8);
  const unitWord = textOrNull(measure?.unit);
  const unit = meta.unit ?? (percent ? "%" : (unitWord ? (UNIT_WORDS[unitWord] ?? unitWord) : null));
  const named = String(measure?.source ?? "");
  const source = VCR_VALUE_SOURCES.includes(named) ? named : defaultSourceOf(kind, measure, context);
  const notEstimable = result?.conclusion === "not_estimable";
  const label = options.label ?? measureLabel(name);
  // The decimals of the value's own error: 71.2 beside ±0.31, never 71.2345. A value with
  // an interval and no Monte-Carlo error (a confidence interval on an RMST difference)
  // takes its decimals from the interval's width — three significant digits of it.
  const shown = intervalView(measure?.interval, scale);
  const width = shown && shown.low !== null && shown.high !== null ? shown.high - shown.low : null;
  /** @type {number | null} */
  let precision = null;
  if (value !== null && mcse !== null && mcse > 0) precision = decimalsFor(mcse, 1);
  else if (percent && value !== null) precision = 1;
  else if (value !== null && width !== null && width > 0) precision = decimalsFor(width, 3);
  return {
    value,
    text: value === null ? (notEstimable ? "不可估计" : "—") : null,
    unit,
    source,
    interval: mcse === null && !percent && precision !== null ? intervalView(measure?.interval, scale, precision) : shown,
    mcse,
    review: result ? String(result.reviewState ?? "ai_set") : null,
    precision,
    reason: value === null
      ? (notEstimable && result?.notEstimableRule
        ? /** @type {Record<string, string>} */ (VCR_NOT_ESTIMABLE_RULE_LABELS_ZH)[String(result.notEstimableRule)] ?? String(result.notEstimableRule)
        : "没有算出这个数")
      : null,
    // Stale when the result or the object it belongs to is marked, and when the number is
    // one carried over from before a change that its own stage has not yet recomputed.
    stale: Boolean(staleMark) || measure?.stale === true,
    detail: runDetail({ label, measure, result, execution, mcse, tab }),
  };
}

/** @param {number | null | undefined} seconds */
export function cpuText(seconds) {
  const total = Number(seconds);
  if (!Number.isFinite(total) || total < 0) return "—";
  if (total < 60) return `${roundTo(total, total < 10 ? 1 : 0)} 秒`;
  if (total < 3_600) return `${roundTo(total / 60, 1)} 分钟`;
  return `${roundTo(total / 3_600, 1)} 小时`;
}

/**
 * What a click on a number opens: the run it came from — method, seed,
 * replicates, error — so a simulated value can always be traced to its
 * configuration (plan §9.5).
 * @param {{ label: string, measure: Record<string, any>, result: Record<string, any> | null,
 *   execution: Record<string, any> | null, mcse: number | null, tab: string | null }} input
 */
function runDetail({ label, measure, result, execution, mcse, tab }) {
  if (!result && !execution) return null;
  /** @type {Array<{ label: string, value: string }>} */
  const fields = [];
  if (execution?.method) fields.push({ label: "方法", value: `${execution.method}${execution.methodVersion ? ` v${execution.methodVersion}` : ""}` });
  if (execution?.seed != null) fields.push({ label: "种子", value: String(execution.seed) });
  if (execution?.replicates != null) fields.push({ label: "重复次数", value: Number(execution.replicates).toLocaleString("en-US") });
  if (mcse !== null) fields.push({ label: "蒙特卡洛标准误", value: String(roundTo(mcse, 6)) });
  if (execution?.cpuSeconds != null) fields.push({ label: "计算用时", value: cpuText(Number(execution.cpuSeconds)) });
  if (execution?.scenarioHash) fields.push({ label: "情景哈希", value: String(execution.scenarioHash).slice(0, 12) });
  if (measure?.simulated !== true && !fields.length) return null;
  return {
    kind: "run",
    title: label,
    fields,
    quote: null,
    quoteSource: null,
    ref: result ? { kind: "result", id: String(result.id), tab } : null,
  };
}

// --- counts ----------------------------------------------------------------------------------

/**
 * The four counts, said apart (plan §3.5), plus the two optional ones when
 * their route was used. A count nobody has is `null`, never zero; a real zero
 * is a zero.
 * @param {Record<string, any> | null | undefined} counts
 * @param {{ tier?: string, scope?: string | null, note?: string | null }} [options]
 */
export function countsView(counts, options = {}) {
  const row = object(counts);
  /** @type {Record<string, any>} */
  const view = {};
  for (const key of VCR_COUNT_KEYS) view[key] = row[key] == null ? null : numeric(row[key]);
  for (const key of ["priorEffectiveSampleSize", "reconstructedPseudoPatients"]) {
    if (row[key] != null) view[key] = numeric(row[key]);
  }
  /** @type {Record<string, string>} */
  const notes = {};
  if (options.tier === "T0" && view.realPatients === 0) view.note = "设计阶段：尚无真实患者";
  if (options.tier === "T1" && view.events == null) notes.events = "T1 无结局记录";
  if (options.note) view.note = options.note;
  view.notes = Object.keys(notes).length ? notes : undefined;
  view.scope = options.scope ?? null;
  return view;
}

// --- stale ---------------------------------------------------------------------------------------

/**
 * The stale note of a block of results: why, and whether a recomputation is
 * actually queued — the browser says 「排队重算中」 only when one is (plan §6.3).
 * @param {ReadonlyArray<Record<string, any> | null | undefined>} marks
 */
export function staleNote(marks) {
  const open = marks.filter(Boolean);
  if (!open.length) return null;
  const first = /** @type {Record<string, any>} */ (open[0]);
  return {
    reason: /** @type {Record<string, string>} */ (VCR_STALE_REASON_LABELS_ZH)[String(first.reason)] ?? null,
    queued: open.some((mark) => Boolean(mark?.queuedJobId)),
    since: textOrNull(first.markedAt),
  };
}

/** The stale mark of a lineage node, if any. @param {readonly Record<string, any>[]} marks @param {string} node */
export const markFor = (marks, node) => marks.find((mark) => mark.node === node) ?? null;

// --- reviews -------------------------------------------------------------------------------------------

/**
 * What the countersignatures say about one version node. A review names the
 * exact versions it signed: the newest review that names this version says
 * `reviewed` — who, when, which version — and one that names only an earlier
 * version of the same object says `changed_after_review`. Derived on every read
 * from the reviews and never stored on the row, because the row did not change;
 * the world moved past what was signed (plan §10.2, AC-33).
 * @param {string} node @param {readonly Record<string, any>[]} reviews newest first
 * @returns {{ state: "reviewed" | "changed_after_review", reviewedBy: string | null, reviewedAt: string | null, reviewedVersion: number, reviewKind: string | null } | null}
 */
export function reviewOfNode(node, reviews) {
  const at = node.lastIndexOf("@");
  if (at < 0) return null;
  const head = node.slice(0, at + 1);
  const version = Number(node.slice(at + 1));
  if (!Number.isFinite(version)) return null;
  /** @type {Record<string, any> | null} */
  let exact = null;
  /** @type {{ review: Record<string, any>, version: number } | null} */
  let earlier = null;
  for (const review of reviews) {
    if ((review.status && review.status !== 'done') || (review.reviewerKind === 'ai' && (!review.platformReviewId || !review.provenance?.model))) continue;
    for (const named of list(review.nodes).map(String)) {
      if (!named.startsWith(head)) continue;
      const named_ = Number(named.slice(at + 1));
      if (named_ === version) { exact ??= review; continue; }
      if (named_ < version && (!earlier || named_ > earlier.version)) earlier = { review, version: named_ };
    }
  }
  const found = exact ? { review: exact, version, state: /** @type {const} */ ("reviewed") }
    : earlier ? { review: earlier.review, version: earlier.version, state: /** @type {const} */ ("changed_after_review") } : null;
  return found ? { state: found.state, reviewedBy: found.review.reviewerKind === "ai" ? `AI · ${found.review.provenance?.model ?? ""}` : text(found.review.reviewerName), reviewedAt: textOrNull(found.review.createdAt),
    reviewedVersion: found.version, reviewKind: text(found.review.kind) } : null;
}

/**
 * A row with the review state its node has earned. A row already stored
 * `reviewed` was written by a person (the state follows who wrote it) and stays;
 * otherwise the countersignatures decide, and a row nobody has signed is what it
 * was stored as.
 * @template {Record<string, any>} T
 * @param {T} row @param {string} node @param {readonly Record<string, any>[]} reviews
 * @returns {T & { reviewedBy?: string | null, reviewedAt?: string | null, reviewedVersion?: number, reviewKind?: string | null }}
 */
export function withReviewState(row, node, reviews) {
  const derived = reviewOfNode(node, reviews);
  if (!derived) return row;
  const { state, ...who } = derived;
  return { ...row, ...who, reviewState: row.reviewState === "reviewed" ? "reviewed" : state };
}

// --- small text --------------------------------------------------------------------------------------

/** 「方案 A」-style letter code by position (A, B, … Z, then AA). @param {number} index */
export function letterCode(index) {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** Percent from a fraction, for prose. @param {number} fraction @param {number} [decimals] */
export function percentText(fraction, decimals = 0) {
  return `${roundTo(fraction * 100, decimals)}%`;
}

/**
 * Convert a value on an analysis scale back to the natural scale the reader
 * knows (a pooled log hazard ratio is shown as a hazard ratio).
 * @param {string} scale @param {number | null} value
 */
export function naturalScale(scale, value) {
  if (value === null || !Number.isFinite(value)) return null;
  if (scale === "log") return Math.exp(value);
  if (scale === "logit") return 1 / (1 + Math.exp(-value));
  return value;
}

/**
 * 「3.0–5.6」: the two ends of a range on the same number of decimals, so the
 * sentence never reads two different kinds of number inside one interval.
 * @param {number} low @param {number} high
 */
export function rangeString(low, high) {
  const places = (/** @type {number} */ value) => {
    const [, fraction = ""] = String(roundTo(value, 2)).split(".");
    return fraction.length;
  };
  const decimals = Math.max(places(low), places(high));
  return `${low.toFixed(decimals)}–${high.toFixed(decimals)}`;
}

/**
 * A stored plain number (a forecast's prediction, an actual) said in words:
 * proportions as percentages, durations in months, the rest as they are.
 * @param {string} name @param {unknown} value
 */
export function plainText(name, value) {
  const number = numeric(value);
  if (number === null) return String(value ?? "—");
  if (isProportionName(name)) return `${roundTo(number * 100, 1)}%`;
  const meta = MEASURE_META[name];
  return meta?.unit ? `${roundTo(number, 2)} ${meta.unit}` : String(roundTo(number, 2));
}

/**
 * Every result of a study, superseded ones included: a design's own result is
 * found by the id its row points at, and a result another design's later run
 * superseded is still that design's result. The current list answers 「what is
 * true now」; this answers 「what did this object produce」.
 * @param {Record<string, any>} bundle @returns {readonly Record<string, any>[]}
 */
export const allResultsOf = (bundle) => bundle.allResults ?? bundle.results ?? [];

/** How an engine method is named on the model library's method rows. */
export const METHOD_LABELS = Object.freeze(/** @type {Record<string, string>} */ ({
  "profile.snapshot": "数据快照画像", "cohort.build": "构建队列", "population.scenario": "情景人群生成", "population.literature": "文献人群",
  "population.synthpop": "经验合成人群", "population.quality": "人群质量报告", "patients.continuous": "虚拟患者（连续终点）",
  "patients.binary": "虚拟患者（二分类终点）", "patients.time_to_event": "虚拟患者（事件时间终点）", "evidence.pool": "证据合并",
  "evidence.reconstruct_km": "生存曲线重建（Guyot）", "comparator.entropy_balance": "熵平衡加权", "comparator.propensity_weight": "倾向评分加权",
  "comparator.rmst": "RMST 比较", "comparator.maic": "匹配调整间接比较", "comparator.evalue": "E 值", "comparator.map_prior": "MAP 先验",
  "comparator.weighted_cox": "加权 Cox 风险比", "comparator.maic_time_to_event": "事件时间终点的匹配调整间接比较",
  "comparator.aipw": "双重稳健估计（AIPW）", "comparator.covariate_sets": "协变量集敏感性分析",
  "design.analytic": "方案的解析计算", "design.simulate": "方案的模拟运行", "design.grid": "设计网格", "design.assurance": "成功把握",
  "design.procova": "预后协变量调整", "accrual.poisson_gamma": "Poisson–Gamma 入组预测", "matching.evaluate": "逐条匹配",
  "comparator.negative_control": "阴性对照结局", "comparator.tipping_point": "缺失数据的临界点分析", "comparator.prognostic_adjustment": "预后评分校正（二分类/事件时间）",
}));

/** The parameters a precedent is used for, said in words. A key with no word is not printed. */
export const PARAMETER_LABELS = Object.freeze(/** @type {Record<string, string>} */ ({
  control_event_rate: "对照组事件率", response_rate: "缓解率", outcome_value: "终点取值", survival_at_time: "某时点生存率",
  dropout_rate: "脱落率", screen_failure_rate: "筛选失败率", median_time: "中位时间", median_survival_months: "中位生存时间",
  accrual_to_primary_completion_months: "入组至主要终点完成的月数", hazard_ratio: "风险比", odds_ratio: "比值比", risk_ratio: "风险比（RR）",
  mean_value: "均值", least_squares_mean: "最小二乘均值",
}));

/**
 * A series with its y values (and band) multiplied, for a curve whose axis is a
 * proportion the page shows as a percentage.
 * @param {Record<string, any>} series @param {number} factor
 */
export function scaledSeries(series, factor) {
  const scale = (/** @type {unknown} */ value) => (typeof value === "number" && Number.isFinite(value) ? roundTo(value * factor, 6) : value);
  return { ...series, points: series.points.map((/** @type {any} */ point) => ({ ...point, y: scale(point.y), low: scale(point.low), high: scale(point.high) })) };
}

/** Reader-facing review provenance, distinct from method or numerical validation.
 * @param {any} review */
export function presentVcrReview(review) {
  const ai = review.reviewerKind === 'ai';
  const status = review.status ?? (['queued', 'running', 'failed'].includes(review.state) ? review.state : review.state === 'ai_set' ? 'queued' : 'done');
  const provenance = review.provenance ?? {};
  const findings = provenance.findings ?? [];
  const state = status === 'queued' ? '等待审查' : status === 'running' ? '审查中' : status === 'failed' ? '审查未完成'
    : review.current === false ? '研究已有更新' : !ai ? '已复核' : findings.length ? '有修订建议' : '未发现明确问题';
  return { id: review.id ?? review.platformReviewId ?? `legacy:${review.kind}:${review.createdAt}:${(review.nodes ?? []).join(",")}`, reviewerKind: ai ? 'ai' : 'human', role: review.kind,
    label: `${ai ? 'AI' : '人工'}${review.kind === 'clinical' ? '临床' : review.kind === 'statistical' ? '统计' : '数据'}复核`,
    state, status, current: review.current !== false, by: ai ? provenance.model ?? null : review.reviewerName ?? null,
    configuredModel: ai ? provenance.configuration?.model ?? null : null, configurationRevision: ai ? provenance.configuration?.revision ?? null : null,
    inputDigest: provenance.inputDigest ?? null, at: provenance.finishedAt ?? review.createdAt ?? null,
    note: status === 'failed' ? '审查暂未完成；已完成的研究与导出仍可使用。' : '审查意见供参考，不代表实证验证。',
    findings: findings.map(finding => ({ id: finding.id, kind: finding.kind, location: finding.location, evidence: finding.evidence,
      message: finding.message, fix: finding.fix, response: finding.response ?? null })) };
}
