/**
 * The reader's words for 「循证 GEO」's closed vocabularies.
 *
 * Every id the server sends — an engine, a pool, a step, a layer, an order
 * state — is mapped here before it reaches the screen; a page never prints a
 * raw id. An id this table does not know is dropped to 「—」 by the helpers
 * rather than printed (a code on screen is a code the reader has to learn),
 * except an engine, whose id is the only name there is.
 */
import type {
  GeoArticleLayer,
  GeoArticleStatus,
  GeoErrorAction,
  GeoErrorStatus,
  GeoErrorType,
  GeoOrderState,
  GeoOverviewMetricKey,
  GeoPool,
  GeoSourceLayer,
  GeoStepKey,
} from "@/lib/geoClient";

/* ------------------------------------------------------------- capabilities */

/**
 * The capabilities a GEO conversation can be bound to. A conversation bound to
 * any of them carries the 「循证 GEO」 chip. The frame holds the same list in
 * its vocabulary (`packages/harness-port/src/runtimeUiFrame.mjs`, `geo`); both
 * belong in the domain's GEO vocabulary once it exists.
 */
export const GEO_CAPABILITY_IDS: readonly string[] = Object.freeze(["geo-insight", "geo-strategy", "geo-content", "geo-proposal"]);

/* ------------------------------------------------------------------ engines */

export const GEO_ENGINE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  deepseek: "DeepSeek",
  doubao: "豆包",
  yuanbao: "元宝",
  qianwen: "千问",
  kimi: "Kimi",
  baidu: "百度",
  wenxin: "文心一言",
});

/** The five a new project measures unless told otherwise, in the order they are offered. */
export const GEO_DEFAULT_ENGINES: readonly string[] = Object.freeze(["doubao", "qianwen", "deepseek", "yuanbao", "kimi"]);

/** Every engine the composer offers; `baidu` only when the server lists it. */
export const GEO_OPTIONAL_ENGINES: readonly string[] = Object.freeze(["baidu"]);

export function engineName(engine: string | null | undefined): string {
  if (!engine) return "—";
  return GEO_ENGINE_NAMES[engine] ?? engine;
}

/* -------------------------------------------------------------------- pools */

export const GEO_POOLS: readonly GeoPool[] = Object.freeze(["P1", "P2", "P3", "P4"]);

/** The four question pools (plan §4.2). */
export const GEO_POOL_NAMES: Readonly<Record<GeoPool, string>> = Object.freeze({
  P1: "品牌明确类",
  P2: "通用名与品类类",
  P3: "泛症状场景类",
  P4: "风险监测类",
});

/** What each pool is for: 存量 / 增量 / 泛增量 / 风险监测. */
export const GEO_POOL_KINDS: Readonly<Record<GeoPool, string>> = Object.freeze({
  P1: "存量",
  P2: "增量",
  P3: "泛增量",
  P4: "风险监测",
});

export function poolName(pool: string | null | undefined): string {
  return pool && pool in GEO_POOL_NAMES ? GEO_POOL_NAMES[pool as GeoPool] : "—";
}

/* -------------------------------------------------------------- steps, tabs */

export const GEO_STEP_NAMES: Readonly<Record<GeoStepKey, string>> = Object.freeze({
  evidence: "证据",
  journey: "旅程",
  questions: "问题",
  diagnosis: "诊断",
  sources: "信源",
  content: "内容",
  distribution: "投放",
  monitoring: "监测",
});

/** A step as a piece of work, for 「只做了信源分析」. */
export const GEO_STEP_WORK: Readonly<Record<GeoStepKey, string>> = Object.freeze({
  evidence: "证据整理",
  journey: "旅程分析",
  questions: "问题清单",
  diagnosis: "诊断",
  sources: "信源分析",
  content: "写稿",
  distribution: "投放",
  monitoring: "监测",
});

export type GeoTabKey = "overview" | GeoStepKey;

/** The project page's tabs, in order: 概览 then the eight steps. */
export const GEO_TABS: ReadonlyArray<{ key: GeoTabKey; label: string }> = Object.freeze([
  { key: "overview", label: "概览" },
  ...(Object.entries(GEO_STEP_NAMES) as Array<[GeoStepKey, string]>).map(([key, label]) => ({ key, label })),
]);

export function isGeoTab(value: string | null | undefined): value is GeoTabKey {
  return !!value && GEO_TABS.some((tab) => tab.key === value);
}

/**
 * What an untouched step's tab says above 「让 AI 做」 — one sentence, what
 * the step will produce, never how the system works.
 */
export const GEO_STEP_EMPTY: Readonly<Record<GeoStepKey, string>> = Object.freeze({
  evidence: "还没有整理这个产品的说明书、证据和主张。",
  journey: "还没有画出患者和医生从起疑到用药的旅程。",
  questions: "还没有列出要问 AI 的问题。",
  diagnosis: "还没有问过各家 AI 怎么回答这个产品。",
  sources: "还没有分析 AI 引用了哪些信源、能做到什么程度。",
  content: "还没有写稿件。",
  distribution: "还没有投放。",
  monitoring: "还没有开始持续监测。",
});

/* ------------------------------------------------------------------ metrics */

/** The overview's four numbers (metrics package mapping, M report). */
export const GEO_METRIC_NAMES: Readonly<Record<GeoOverviewMetricKey, string>> = Object.freeze({
  gvi: "综合可见度指数",
  mention: "品牌提及率",
  accuracy: "事实准确率",
  citation: "引用命中率",
});

/** A GVI is an index 0–100; the other three are percentages. */
export type GeoUnit = "percent" | "index" | "count";
export const GEO_METRIC_UNITS: Readonly<Record<GeoOverviewMetricKey, GeoUnit>> = Object.freeze({
  gvi: "index",
  mention: "percent",
  accuracy: "percent",
  citation: "percent",
});

/** The coverage windows the composer offers, in days; 90 is the default. */
export const GEO_COVERAGE_DAYS: readonly number[] = Object.freeze([30, 60, 90, 180]);
export const GEO_DEFAULT_COVERAGE_DAYS = 90;

/* ---------------------------------------------------------- content, orders */

export const GEO_LAYER_NAMES: Readonly<Record<GeoArticleLayer, string>> = Object.freeze({
  deep: "深度分析",
  card: "证据卡片",
  popular: "科普稿件",
  qa: "问答",
  correction: "纠错材料",
});

export function layerName(layer: string | null | undefined): string {
  return layer && layer in GEO_LAYER_NAMES ? GEO_LAYER_NAMES[layer as GeoArticleLayer] : "—";
}

export const GEO_ARTICLE_STATUS_WORDS: Readonly<Record<GeoArticleStatus, string>> = Object.freeze({
  draft: "起草中",
  publishable: "可发布",
  placed: "已投放 · 待发布",
  published: "已发布",
  withdrawn: "已撤回",
});

/** The one article state that is a safety stop, said in its own words. */
export const GEO_ARTICLE_SAFETY_OPEN = "安全待复核";

export const GEO_ORDER_STATE_WORDS: Readonly<Record<GeoOrderState, string>> = Object.freeze({
  planned: "待下单",
  reserved: "下单中",
  submitted: "已下单",
  accepted: "媒体已接单",
  published: "已发布",
  verified: "已发布 · 已核对",
  settled: "已完成",
  unknown: "待核实",
  rejected: "退稿",
  cancelled: "已撤单",
  refunded: "退稿 · 已退款",
  problem: "有异议",
  lost: "未能发布",
});

export function orderStateWord(state: string | null | undefined): string {
  return state && state in GEO_ORDER_STATE_WORDS ? GEO_ORDER_STATE_WORDS[state as GeoOrderState] : "—";
}

/** Order states in which 「撤单」 is still possible (before the outlet accepted). */
export const GEO_ORDER_CANCELLABLE: ReadonlySet<GeoOrderState> = new Set<GeoOrderState>(["planned", "reserved", "submitted"]);

/* ------------------------------------------------------------------- errors */

export const GEO_ERROR_TYPE_WORDS: Readonly<Record<GeoErrorType, string>> = Object.freeze({
  label_conflict: "与说明书冲突",
  number: "数字说错",
  dropped_condition: "漏了限定条件",
  unfounded: "没有依据",
  attribute_swap: "张冠李戴",
});

export const GEO_ERROR_STATUS_WORDS: Readonly<Record<GeoErrorStatus, string>> = Object.freeze({
  open: "待纠正",
  acting: "纠正中",
  awaiting_remeasure: "等复测",
  closed: "已消失",
});

export const GEO_ERROR_ACTION_WORDS: Readonly<Record<GeoErrorAction, string>> = Object.freeze({
  own_edit: "改自有页面",
  correction_letter: "发纠错函",
  encyclopedia_fix: "修改百科词条",
  report_and_cover: "举报并用正确内容覆盖",
  no_contact: "无法联系信源",
  continuous_supply: "持续供给正确内容",
});

export const GEO_STABILITY_WORDS: Readonly<Record<string, string>> = Object.freeze({
  stable: "稳定出现",
  sporadic: "偶尔出现",
  unconfirmed: "待复核",
});

export const GEO_SOURCE_LAYER_WORDS: Readonly<Record<GeoSourceLayer, string>> = Object.freeze({
  anchor: "锚点",
  coverage: "覆盖",
  owned: "自有",
});

/* ----------------------------------------------------------------- starters */

/**
 * The single-step starters under the composer (plan §5.2). Each puts a
 * sentence into the composer and never sends it; `product` is filled in when
 * the project already knows its product, otherwise the sentence ends where the
 * reader types the name.
 */
export interface GeoStarter {
  key: string;
  label: string;
  draft: (product: string | null) => string;
}

const naming = (product: string | null) => (product ? `产品是${product}。` : "产品是：");

export const GEO_STARTERS: readonly GeoStarter[] = Object.freeze([
  { key: "full", label: "完整方案", draft: (product) => `做一套完整的 GEO 方案，从证据、问题、诊断到内容、投放和监测，${naming(product)}` },
  { key: "answers", label: "AI 怎么说我的产品", draft: (product) => `看看各家 AI 怎么回答我的产品，哪里讲对了、哪里讲错了，${naming(product)}` },
  { key: "sources", label: "信源分析与预期", draft: (product) => `看看 AI 回答里引用了谁、我们投内容能做到什么程度，${naming(product)}` },
  { key: "optimize", label: "优化已有稿件", draft: () => "把我已有的稿件逐篇优化，让 AI 更愿意引用，稿件我附在下面：" },
  { key: "humanize", label: "去 AI 味", draft: () => "给这批稿件去 AI 味，只改语言，数字、引文、出处和药名保持不变，稿件我附在下面：" },
  { key: "monitor", label: "持续监测", draft: (product) => `持续监测各家 AI 怎么回答我的产品，每周告诉我变化，${naming(product)}` },
]);

/* -------------------------------------------------------------------- dates */

/** A date or an instant; a bare `YYYY-MM-DD` is that day in the reader's calendar, not UTC midnight. */
export function parseGeoDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const date = typeof value === "string" ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value) : value;
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 「10月1日」 for a date, in the reader's calendar. */
export function monthDay(value: string | Date | null | undefined): string | null {
  const date = parseGeoDate(value);
  return date ? `${date.getMonth() + 1}月${date.getDate()}日` : null;
}

/**
 * A project's coverage window as the reader sees it: 「10月1日 – 12月31日」
 * when the start is known, 「覆盖 90 天」 otherwise.
 */
export function coverageText(coverageDays: number | null | undefined, startedAt?: string | null): string {
  const days = typeof coverageDays === "number" && coverageDays > 0 ? coverageDays : GEO_DEFAULT_COVERAGE_DAYS;
  const start = parseGeoDate(startedAt);
  if (start) {
    const end = new Date(start.getTime() + (days - 1) * 86_400_000);
    return `${monthDay(start)} – ${monthDay(end)}`;
  }
  return `覆盖 ${days} 天`;
}

/** 「第 3 周」 since the window started, or null before it has. */
export function weekOf(startedAt: string | null | undefined, now: Date = new Date()): number | null {
  const start = parseGeoDate(startedAt);
  if (!start || now < start) return null;
  return Math.floor((now.getTime() - start.getTime()) / (7 * 86_400_000)) + 1;
}
