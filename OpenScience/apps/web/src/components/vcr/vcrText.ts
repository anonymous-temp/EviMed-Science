/**
 * How 「虚拟临床研究」 says a number.
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
  VCR_STEP_LABELS_ZH,
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
  VcrStepKey,
  VcrValue,
  VcrValueSource,
} from "@/lib/vcrClient";

const table = <K extends string>(labels: unknown) => (key: K | null | undefined): string =>
  (labels as Record<string, string>)[String(key)] ?? "";

export const sourceLabel = table<VcrValueSource>(VCR_VALUE_SOURCE_LABELS_ZH);
export const conclusionLabel = table<VcrConclusion>(VCR_CONCLUSION_LABELS_ZH);
export const reviewKindLabel = table<VcrReviewKind>(VCR_REVIEW_KIND_LABELS_ZH);
export const countLabel = table<VcrCountKey>(VCR_COUNT_LABELS_ZH);
export const intervalLabel = table<VcrInterval["kind"]>(VCR_INTERVAL_KIND_LABELS_ZH);
export const tierLabel = table<VcrDataTier>(VCR_DATA_TIER_LABELS_ZH);
export const intendedUseLabel = table<VcrIntendedUse>(VCR_INTENDED_USE_LABELS_ZH);
export const stepLabel = table<VcrStepKey>(VCR_STEP_LABELS_ZH);
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
 * Engine results store interval levels as fractions; page contracts use percentage
 * points. Apply only at a raw-engine display boundary, never to a page interval.
 * Older results with percentage-point levels (> 1) remain readable. Bounds and
 * the original result are preserved, including a genuine 1% engine level (0.01).
 */
export function engineIntervalForDisplay(interval: VcrInterval | null | undefined): VcrInterval | null {
  if (!interval) return null;
  const raw = interval.level;
  const level = typeof raw === "number" && Number.isFinite(raw) && raw > 0 && raw <= 100
    ? (raw <= 1 ? Math.round(raw * 100 * 1e8) / 1e8 : raw) : null;
  return { ...interval, level };
}

/** A page-level percentage, preserving a genuine 1% and fractional levels. */
export function intervalLevelText(level: number | null | undefined): string {
  return typeof level === "number" && Number.isFinite(level) && level > 0 && level <= 100
    ? `${numberText(level, significantDecimals(level))}% ` : "";
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
  const level = intervalLevelText(interval.level);
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

/**
 * A value recorded on a patient's chart, said the way a reader would: 是 / 否 for a yes or no, a list joined with 、, a record as
 * 「名称：值」 pairs joined with 「；」 — never `[object Object]` — and 「未知」 for a fact recorded without a value. A value nested
 * more than two levels deep is handed over as compact JSON: a reader can still read it and nothing loops.
 */
export function factValueText(value: unknown, depth = 0): string {
  if (value === null || value === undefined || value === "") return "未知";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "未知";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return String(value);
  if (depth >= 2) return JSON.stringify(value);
  if (Array.isArray(value)) return value.map((item) => factValueText(item, depth + 1)).join("、");
  return Object.entries(value as Record<string, unknown>).map(([name, item]) => `${name}：${factValueText(item, depth + 1)}`).join("；");
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
 * 「4.1 个月，汇总，预测区间 3.0–5.6」.
 */
export function valueSentence(value: VcrValue | null | undefined): string {
  if (!value) return NO_VALUE;
  return [
    `${valueText(value)}${value.unit ?? ""}`,
    sourceLabel(value.source),
    intervalText(value.interval, value.precision),
    value.mcse != null ? `蒙特卡洛标准误 ${mcseText(value.mcse)}` : "",
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

/**
 * What a step gives, as a noun phrase — the second half of an empty tab's recipe (「用 … 得到 …」, `StepState`), in the same block as
 * the button that starts it. Not an explanation of the tab: the first half is what the step uses, each a link.
 */
export const VCR_STEP_GIVES: Readonly<Record<VcrStepKey, string>> = Object.freeze({
  definition: "研究问题、对象、对照、终点和预期用途",
  evidence: "一张张可追溯的假设卡",
  population: "一批情景人群；接入数据（T1 及以上）后也可以筛出真实队列",
  patients: "分组曲线和每个虚拟患者的个体记录",
  comparator: "五条对照路线的诊断、效应或缺口清单",
  trial: "方案对比、运行特征和成功把握",
  matching: "逐条入排判定和补证建议",
});

/** What a step makes, as the empty tab's title says it (「还没有虚拟患者」). */
export const VCR_STEP_NOUNS: Readonly<Record<VcrStepKey, string>> = Object.freeze({
  definition: "研究定义",
  evidence: "假设卡",
  population: "人群",
  patients: "虚拟患者",
  comparator: "对照设计",
  trial: "试验方案",
  matching: "匹配评估",
});

/**
 * What a step produces, for a tab that has nothing yet.
 * @deprecated An empty tab is a recipe (`VCR_STEP_GIVES`, `StepState`); nothing draws this sentence any more.
 */
export const VCR_STEP_EMPTY: Readonly<Record<VcrStepKey, string>> = Object.freeze({
  definition: "研究定义还没写：研究问题、PICO、估计目标和预期用途。",
  evidence: "还没有假设卡：检索试验登记和文献，把参数变成一张张可追溯的卡。",
  population: "还没有人群：AI 会按研究定义生成一批情景人群；接入你的数据（T1 及以上）后，也可以筛出真实队列。",
  patients: "还没有虚拟患者：在给定模型和情景下推演个体轨迹与不确定性。",
  comparator: "还没有对照设计：五条对照路线的诊断、效应或缺口清单。",
  trial: "还没有试验情景：方案对比、运行特征和成功把握。",
  matching: "还没有匹配评估：逐条判定每个人是否符合入排条件，并给出补证建议。",
});

/**
 * What the matching step gives a study that has only public material (T0), as the second half of its recipe (「用 … 得到 …」): there is
 * nobody to match yet, and what the step does instead is structure the criteria. Above T0 the step's own `VCR_STEP_GIVES` stands.
 */
export const VCR_MATCHING_EMPTY_T0 = "逐条可判定的入排标准；接入你的数据（T1 及以上）后，再逐个匹配、转诊和随访";

/**
 * 给患者找试验: what the direction says before it has anything to list. One sentence each, and the one button the page has (为该患者找试验)
 * beside the ones that leave it something to do.
 */
export const VCR_PATIENT_TRIALS_CHOOSE = "选一位患者，看有哪些试验可以参加。";
export const VCR_PATIENT_TRIALS_NOBODY = "还没有登记患者，有了患者资料才能为患者找试验。";
export const VCR_PATIENT_TRIALS_OFF = "给患者找试验在本部署尚未接入。";
export const VCR_TRIAL_SEARCH_FAILED = "暂时无法开始查找，请稍后重试。";
/** The patient has no trial the study has judged them against yet. */
export const patientTrialsNoneSentence = (subject: string): string => `还没有为 ${subject} 找过试验。`;

/** What a tab says when the study has no definition yet: the programme is not waiting for anything, the study is waiting to be described. */
export const VCR_NO_DEFINITION = "先在对话里说一句要研究什么";

/**
 * What a step said when it was asked for and the programme had not started it yet.
 * @deprecated A step in line is `StepState`'s queued state and the page's strip (「排队中 · 等「证据」做完」); nothing draws this.
 */
export const VCR_STEP_QUEUED = "已安排，开始后这里会显示进度。";
