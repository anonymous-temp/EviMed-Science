/**
 * How 「虚拟临研」 says a number.
 *
 * Every label table here is `@evimed/domain`'s: the nine value sources, the
 * three conclusions, the three review states, the four counts, the four
 * interval kinds, the seven steps, the data tiers and the intended uses all
 * come from `vcrVocabulary.mjs`, so the page, the schema, the routes and the
 * engine cannot disagree about a word.
 *
 * Hidden knowledge:
 *
 *  - **An interval is always named.** 「置信区间 3.6–4.6」 and
 *    「预测区间 3.0–5.6」 are different claims about the next study, and a page
 *    that writes 「区间」 has thrown the difference away (plan §9.6). There is
 *    no formatter here that prints a bare range.
 *  - **A number that does not exist is a word, never a zero.** `valueText`
 *    returns 「—」 (or the value's own `text`) for a missing number, and the
 *    tile that draws it uses the placeholder type size, so 「不可估计」 never
 *    shouts louder than a measurement.
 *  - The en dash inside a numeric interval and 「～」 in prose: the mockups'
 *    rule, kept here so both sides of a page agree.
 */
import {
  VCR_CONCLUSION_LABELS_ZH,
  VCR_COUNT_LABELS_ZH,
  VCR_CRITERION_STATE_LABELS_ZH,
  VCR_DATA_TIER_LABELS_ZH,
  VCR_ELIGIBILITY_SUMMARY_LABELS_ZH,
  VCR_INTENDED_USE_LABELS_ZH,
  VCR_INTERVAL_KIND_LABELS_ZH,
  VCR_JOB_STATE_LABELS_ZH,
  VCR_JOB_WAIT_LABELS_ZH,
  VCR_MEMBER_ROLE_LABELS_ZH,
  VCR_MODEL_RISK_LABELS_ZH,
  VCR_MODEL_TIER_LABELS_ZH,
  VCR_REFERRAL_STATE_LABELS_ZH,
  VCR_REVIEW_KIND_LABELS_ZH,
  VCR_REVIEW_STATE_LABELS_ZH,
  VCR_STEP_LABELS_ZH,
  VCR_STEP_STATUS_LABELS_ZH,
  VCR_VALUE_SOURCE_LABELS_ZH,
} from "@evimed/domain";
import type {
  VcrConclusion,
  VcrCountKey,
  VcrCriterionState,
  VcrDataTier,
  VcrEligibility,
  VcrIntendedUse,
  VcrInterval,
  VcrJobState,
  VcrJobWait,
  VcrMemberRole,
  VcrModelRisk,
  VcrModelTier,
  VcrReferralState,
  VcrReviewKind,
  VcrReviewState,
  VcrStepKey,
  VcrStepStatus,
  VcrValue,
  VcrValueSource,
} from "@/lib/vcrClient";

const table = <K extends string>(labels: unknown) => (key: K | null | undefined): string =>
  (labels as Record<string, string>)[String(key)] ?? "";

export const sourceLabel = table<VcrValueSource>(VCR_VALUE_SOURCE_LABELS_ZH);
export const conclusionLabel = table<VcrConclusion>(VCR_CONCLUSION_LABELS_ZH);
export const reviewLabel = table<VcrReviewState>(VCR_REVIEW_STATE_LABELS_ZH);
export const reviewKindLabel = table<VcrReviewKind>(VCR_REVIEW_KIND_LABELS_ZH);
export const countLabel = table<VcrCountKey>(VCR_COUNT_LABELS_ZH);
export const intervalLabel = table<VcrInterval["kind"]>(VCR_INTERVAL_KIND_LABELS_ZH);
export const tierLabel = table<VcrDataTier>(VCR_DATA_TIER_LABELS_ZH);
export const intendedUseLabel = table<VcrIntendedUse>(VCR_INTENDED_USE_LABELS_ZH);
export const stepLabel = table<VcrStepKey>(VCR_STEP_LABELS_ZH);
export const stepStatusLabel = table<VcrStepStatus>(VCR_STEP_STATUS_LABELS_ZH);
export const jobStateLabel = table<VcrJobState>(VCR_JOB_STATE_LABELS_ZH);
/** The one line under a live job that waits on something the reader has nothing to do about. */
export const jobWaitLabel = table<VcrJobWait>(VCR_JOB_WAIT_LABELS_ZH);
export const criterionStateLabel = table<VcrCriterionState>(VCR_CRITERION_STATE_LABELS_ZH);
export const eligibilityLabel = table<VcrEligibility>(VCR_ELIGIBILITY_SUMMARY_LABELS_ZH);
export const referralStateLabel = table<VcrReferralState>(VCR_REFERRAL_STATE_LABELS_ZH);
export const memberRoleLabel = table<VcrMemberRole>(VCR_MEMBER_ROLE_LABELS_ZH);
export const modelTierLabel = table<VcrModelTier>(VCR_MODEL_TIER_LABELS_ZH);
export const modelRiskLabel = table<VcrModelRisk>(VCR_MODEL_RISK_LABELS_ZH);

/** The em-free stand-in for a number nobody measured. */
export const NO_VALUE = "—";

/**
 * The decimals that keep `digits` significant digits of a positive error term:
 * 0.0031 keeps four for two digits and three for one. The same rule the server
 * uses (`decimalsFor` in `vcrViewsKit.mjs`), so a value the server rounded to
 * its own error is never re-rounded here to something else.
 */
export function decimalsForError(error: number, digits: number): number {
  if (!(error > 0) || !Number.isFinite(error)) return 0;
  return Math.max(0, Math.min(8, digits - 1 - Math.floor(Math.log10(error))));
}

/**
 * How many decimals a value prints with, and whether a zero that only the rule
 * wrote may be dropped.
 *
 * In order: the value's own `precision` (the server rounded it to its error);
 * the decimal place of its Monte-Carlo error's first significant digit; and
 * failing both, its magnitude — whole numbers as they are, ratios to two
 * decimals (1.04, 1.96), two significant digits below one (0.0031). Only the
 * magnitude rule drops a trailing zero (5.9, not 5.90): nothing said the second
 * decimal meant anything.
 */
function decimalsOf(value: number, precision: number | null | undefined, mcse?: number | null): { decimals: number; trim: boolean } {
  if (typeof precision === "number" && Number.isFinite(precision)) return { decimals: Math.max(0, Math.min(8, Math.round(precision))), trim: false };
  if (typeof mcse === "number" && Number.isFinite(mcse) && mcse > 0) return { decimals: Math.min(6, decimalsForError(mcse, 1)), trim: false };
  const magnitude = Math.abs(value);
  if (Number.isInteger(value) || magnitude >= 100) return { decimals: 0, trim: true };
  if (magnitude >= 10) return { decimals: 1, trim: true };
  if (magnitude >= 1) return { decimals: 2, trim: true };
  return { decimals: Math.max(2, Math.min(6, decimalsForError(magnitude || 1, 2))), trim: true };
}

/** A number with thousands separators, in the value's own precision. */
export function numberText(value: number | null | undefined, precision?: number | null, mcse?: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return NO_VALUE;
  const { decimals, trim } = decimalsOf(value, precision, mcse);
  return value.toLocaleString("zh-CN", { minimumFractionDigits: trim ? 0 : decimals, maximumFractionDigits: decimals });
}

/**
 * A count. Past ten thousand it becomes 「约 648 万」, because 6,480,000 in a
 * tile is a number nobody reads — and the exact figure stays in the tooltip
 * the tile carries.
 */
export function countText(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return NO_VALUE;
  if (Math.abs(value) >= 10_000) {
    const wan = value / 10_000;
    return `约 ${wan.toLocaleString("zh-CN", { maximumFractionDigits: wan >= 100 ? 0 : 1 })} 万`;
  }
  return value.toLocaleString("zh-CN");
}

/**
 * 「3.0–5.6」 — the numeric range alone, for a chart axis or a tooltip.
 *
 * Both ends take the **same** number of decimals, derived from the wider of
 * the two when the caller does not say. 「3–5.6」 reads as two different kinds
 * of number inside one interval; the mockups write 「3.0–5.6」 for that reason.
 */
/** The decimals a stored number actually has (up to six), so 3.6 and 4.65 share two. */
function significantDecimals(value: number): number {
  const [, fraction = ""] = String(Math.round(value * 1e6) / 1e6).split(".");
  return Math.min(6, fraction.length);
}

export function rangeText(low: number | null | undefined, high: number | null | undefined, precision?: number | null): string {
  const ends = [low, high].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  // Both ends take the decimals the finer of the two needs, whole numbers
  // apart: 3.0–5.6, never 3–5.6.
  const shared = precision ?? (ends.length ? Math.max(...ends.map((value) => significantDecimals(value))) : null);
  const a = typeof low === "number" && Number.isFinite(low) ? numberText(low, shared) : null;
  const b = typeof high === "number" && Number.isFinite(high) ? numberText(high, shared) : null;
  if (a === null && b === null) return "";
  if (a === null) return `≤ ${b}`;
  if (b === null) return `≥ ${a}`;
  return `${a}–${b}`;
}

/**
 * 「95% 置信区间 3.6–4.6」 / 「预测区间 3.0–5.6」 — the interval, with its own
 * name. An interval without a name is not written at all.
 */
export function intervalText(interval: VcrInterval | null | undefined, precision?: number | null): string {
  if (!interval) return "";
  const range = rangeText(interval.low, interval.high, precision);
  if (!range) return "";
  const name = intervalLabel(interval.kind);
  if (!name) return "";
  const level = typeof interval.level === "number" && Number.isFinite(interval.level) ? `${numberText(interval.level, 0)}% ` : "";
  return `${level}${name} ${range}`;
}

/**
 * 「±0.31」 — the Monte-Carlo standard error every simulated measure carries,
 * to two significant digits (±0.0031, ±0.40, ±1.0): an error is stated with
 * less precision than a value, and a third digit of it would be noise.
 */
export function mcseText(mcse: number | null | undefined): string {
  if (typeof mcse !== "number" || !Number.isFinite(mcse)) return "";
  const decimals = decimalsForError(mcse, 2);
  return `±${mcse.toLocaleString("zh-CN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

/** The number itself, or the word that stands in its place. */
export function valueText(value: VcrValue | null | undefined): string {
  if (!value) return NO_VALUE;
  if (typeof value.value === "number" && Number.isFinite(value.value)) return numberText(value.value, value.precision, value.mcse);
  return value.text ?? NO_VALUE;
}

/** Whether a value is a word rather than a number (the placeholder type size). */
export function isPlaceholder(value: VcrValue | null | undefined): boolean {
  return !value || typeof value.value !== "number" || !Number.isFinite(value.value);
}

/**
 * The whole value as one line, for a screen reader, a tooltip and a test:
 * 「4.1 个月，汇总，预测区间 3.0–5.6，AI 设定」.
 */
export function valueSentence(value: VcrValue | null | undefined): string {
  if (!value) return NO_VALUE;
  return [
    `${valueText(value)}${value.unit ?? ""}`,
    sourceLabel(value.source),
    intervalText(value.interval, value.precision),
    value.mcse != null ? `蒙特卡洛标准误 ${mcseText(value.mcse)}` : "",
    value.review ? reviewLabel(value.review) : "",
    value.stale ? "已过期" : "",
    value.reason ?? "",
  ].filter(Boolean).join("，");
}

/**
 * The sentence a stale result carries (plan §9.6). The numbers stay on screen.
 * 「排队重算中」 is said only when a recomputation is actually queued: a
 * light result recomputes at once and a heavy one may wait for a person, and a
 * sentence that promised a queue that does not exist would be a false one.
 */
export const STALE_SENTENCE = "输入已变更，排队重算中";
export const STALE_SENTENCE_NOT_QUEUED = "输入已变更，这些数字可能已过期";
export const staleSentence = (queued: boolean | null | undefined) => (queued ? STALE_SENTENCE : STALE_SENTENCE_NOT_QUEUED);

/** What a step produces, for a tab that has nothing yet. */
export const VCR_STEP_EMPTY: Readonly<Record<VcrStepKey, string>> = Object.freeze({
  definition: "研究定义还没写：研究问题、PICO、估计目标和预期用途。",
  evidence: "还没有假设卡：检索试验登记和文献，把参数变成一张张可追溯的卡。",
  population: "还没有人群版本：入排条件、逐条筛选和人群画像。",
  patients: "还没有虚拟患者：在给定模型和情景下推演个体轨迹与不确定性。",
  comparator: "还没有对照设计：五条对照路线的诊断、效应或缺口清单。",
  trial: "还没有试验情景：方案对比、运行特征和成功把握。",
  matching: "还没有匹配评估：逐条判定每个人是否符合入排条件，并给出补证建议。",
});

/** What a step waits for, when it was asked for but its input is not ready. */
export const VCR_STEP_WAITING: Readonly<Record<VcrStepKey, string>> = Object.freeze({
  definition: "研究定义正在排队。",
  evidence: "研究定义写好后开始找证据。",
  population: "研究定义写好后开始构建人群。",
  patients: "人群版本定下来后开始生成虚拟患者。",
  comparator: "研究定义写好后开始设计对照。",
  trial: "研究定义写好后开始模拟试验。",
  matching: "研究定义写好后开始匹配。",
});
