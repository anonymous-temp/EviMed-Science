/**
 * The reader's words the eight step tabs and the answer page need beyond
 * `geoText.ts`: metric ids, source kinds and attributes, severities, round
 * kinds, the probe surface, a claim's source kind.
 *
 * Same rule as `geoText.ts`: an id this table does not know is never printed
 * — a code on screen is a code the reader has to learn.
 */
import type { GeoCell, GeoClaim, GeoEngine, GeoOverviewMetricKey, GeoSeverity, GeoSnapshotStatus } from "@/lib/geoClient";
import { geoCellPhrase } from "../GeoCellText";
import { engineName, GEO_METRIC_NAMES, GEO_METRIC_UNITS, monthDay, type GeoUnit } from "../geoText";

/* ------------------------------------------------------------------ metrics */

/**
 * The metric catalogue's names (geo-skills `metrics.yaml`, as converted into
 * `packages/domain/src/geo/metrics.json`) and each one's scale. The overview
 * keys (`gvi`, `mention` …) are accepted too, because the monitoring series
 * and the tier targets may name a metric either way.
 */
const METRICS: Readonly<Record<string, { name: string; unit: GeoUnit }>> = Object.freeze({
  "M-01": { name: "品牌提及率", unit: "percent" },
  "M-01S": { name: "品类问题可见率", unit: "percent" },
  "M-02": { name: "首位提及率", unit: "percent" },
  "M-03": { name: "推荐位提及率", unit: "percent" },
  "M-04": { name: "品牌声量份额", unit: "percent" },
  "M-04C": { name: "品牌登记覆盖率", unit: "percent" },
  "M-05": { name: "平均出现位序", unit: "index" },
  "M-06": { name: "事实准确率", unit: "percent" },
  "M-07": { name: "错误陈述条数", unit: "count" },
  "M-08": { name: "引用命中率", unit: "percent" },
  "M-08B": { name: "正文引用命中率", unit: "percent" },
  "M-08S": { name: "信源问题引用率", unit: "percent" },
  "M-09": { name: "自有内容被引条数", unit: "count" },
  "M-09S": { name: "信源数量引用率", unit: "percent" },
  "M-10": { name: "检索触发率", unit: "percent" },
  "M-11": { name: "就医红旗覆盖率", unit: "percent" },
  "M-12": { name: "禁忌与特殊人群提示率", unit: "percent" },
  "M-13": { name: "通用名到厂牌转化率", unit: "index" },
  "M-14": { name: "泛症状可见度", unit: "percent" },
  "M-15": { name: "风险问句被推荐率", unit: "percent" },
  "M-16": { name: "竞品提及率", unit: "percent" },
  "M-17": { name: "竞品声量份额", unit: "percent" },
  "M-19": { name: "综合可见度指数", unit: "index" },
  "M-20": { name: "回答有效率", unit: "percent" },
  "M-21": { name: "发布稿件被引篇数", unit: "count" },
  ...Object.fromEntries(
    (Object.keys(GEO_METRIC_NAMES) as GeoOverviewMetricKey[]).map((key) => [key, { name: GEO_METRIC_NAMES[key], unit: GEO_METRIC_UNITS[key] }]),
  ),
  retrieval: { name: "检索触发率", unit: "percent" },
});

export function metricName(metricId: string | null | undefined): string | null {
  return metricId && metricId in METRICS ? METRICS[metricId].name : null;
}

export function metricUnit(metricId: string | null | undefined): GeoUnit {
  return metricId && metricId in METRICS ? METRICS[metricId].unit : "percent";
}

/* ------------------------------------------------------------------ engines */

/**
 * Engines measured through the inclusion channel (百度 today): only whether
 * the answer mentions us is known, so accuracy and citation read 「只测提及」
 * rather than 「—」 — the reader should know it is a choice, not a gap.
 */
const MENTION_ONLY: ReadonlySet<string> = new Set(["baidu", "wenxin"]);

export function mentionOnly(engine: GeoEngine | null | undefined): boolean {
  return !!engine && MENTION_ONLY.has(engine);
}

export const MENTION_ONLY_WORD = "只测提及";

/* ------------------------------------------------------------------- claims */

export const CLAIM_SOURCE_KIND_WORDS: Readonly<Record<NonNullable<GeoClaim["sourceKind"]>, string>> = Object.freeze({
  label: "说明书",
  guideline: "指南",
  trial: "临床试验",
  review: "系统综述",
  literature: "文献",
  regulator: "监管",
  other: "其他",
});

export function claimSourceKindWord(kind: string | null | undefined): string | null {
  return kind && kind in CLAIM_SOURCE_KIND_WORDS ? CLAIM_SOURCE_KIND_WORDS[kind as keyof typeof CLAIM_SOURCE_KIND_WORDS] : null;
}

/* ------------------------------------------------------------------ sources */

/**
 * A source's kind as the reader says it. The strategy run may write the kind
 * in Chinese already (「健康媒体」) — then it is shown as written; a code this
 * table knows is translated; any other code is not shown.
 */
const SOURCE_KIND_WORDS: Readonly<Record<string, string>> = Object.freeze({
  health_media: "健康媒体",
  medical_media: "医学媒体",
  professional_media: "专业媒体",
  news: "新闻媒体",
  media: "媒体",
  encyclopedia: "百科",
  qa: "问答社区",
  qa_community: "问答社区",
  community: "社区",
  forum: "社区",
  society: "学会指南",
  guideline: "学会指南",
  journal: "期刊",
  official: "官方平台",
  government: "官方平台",
  regulator: "监管机构",
  hospital: "医院",
  owned: "自有",
  wemedia: "自媒体",
  video: "视频平台",
  social: "社交平台",
  ecommerce: "电商",
  farm: "内容农场",
});

const HAN = /\p{Script=Han}/u;

export function sourceKindWord(kind: string | null | undefined): string | null {
  if (!kind) return null;
  if (HAN.test(kind)) return kind;
  return SOURCE_KIND_WORDS[kind.toLowerCase()] ?? null;
}

/** What the source cited behind a wrong sentence is (error trace, column three). */
export const CITED_ATTRIBUTE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  owned: "自有内容",
  partner: "合作媒体",
  encyclopedia: "百科词条",
  farm: "内容农场",
  impostor: "冒名站",
  none: "没有引用源",
});

/* ------------------------------------------------------------------- errors */

/**
 * The five consequence grades of a wrong sentence about us (plan §3.4, after
 * the medication-error scale): what the reader needs is the consequence, the
 * grade itself follows it.
 */
export const GEO_SEVERITY_WORDS: Readonly<Record<GeoSeverity, string>> = Object.freeze({
  S0: "几乎无影响",
  S1: "影响轻微",
  S2: "需监测或干预",
  S3: "可致暂时伤害",
  S4: "可致永久伤害或危及生命",
});

export function severityWord(severity: string | null | undefined): string | null {
  return severity && severity in GEO_SEVERITY_WORDS ? GEO_SEVERITY_WORDS[severity as GeoSeverity] : null;
}

/* ------------------------------------------------------------------- rounds */

const ROUND_KIND_WORDS: Readonly<Record<string, string>> = Object.freeze({
  baseline: "基线",
  weekly: "每周复测",
  sentinel: "每日哨点",
  post_publication: "发布后复测",
  confirm: "错误确认",
  noise: "波动测量",
  single_step: "单项测量",
});

export function roundKindWord(kind: string | null | undefined): string | null {
  return kind && kind in ROUND_KIND_WORDS ? ROUND_KIND_WORDS[kind] : null;
}

/** A round as a chip: 「基线 · 9月22日」, 「每周复测 · 10月13日」. */
export function roundLabel(round: { kind: string; sampleDate: string | null }): string {
  return [roundKindWord(round.kind) ?? "测量", monthDay(round.sampleDate)].filter(Boolean).join(" · ");
}

/**
 * The probe surface in one line (plan §4.3: every board says what was
 * measured): 「网页端、非深度思考、每题新对话」.
 */
export function surfaceText(surface: Record<string, unknown> | null | undefined): string | null {
  if (!surface) return null;
  const parts: string[] = [];
  if (surface.mode === "web") parts.push("网页端");
  else if (surface.mode === "app") parts.push("App 端");
  else if (surface.mode === "inclusion") parts.push("收录查询");
  if (surface.deep === false) parts.push("非深度思考");
  else if (surface.deep === true) parts.push("深度思考");
  if (surface.newChat === true) parts.push("每题新对话");
  if (typeof surface.city === "string" && surface.city) parts.push(surface.city);
  return parts.length ? parts.join("、") : null;
}

/* ---------------------------------------------------------------- answers */

/** What stands in an answer's place when there is none to read. */
export const SNAPSHOT_STATUS_WORDS: Readonly<Record<GeoSnapshotStatus | "absent", string>> = Object.freeze({
  valid: "有回答",
  refusal: "没有正面回答",
  suspect: "没拿到有效回答",
  failed: "没有问成",
  absent: "未测",
});

/** The route of one answer. */
export function answerPath(geoId: string, snapshotId: string): string {
  return `/app/geo/${encodeURIComponent(geoId)}/answers/${encodeURIComponent(snapshotId)}`;
}

/** The route of one tab of the project. */
export function tabPath(geoId: string, tab: string): string {
  return `/app/geo/${encodeURIComponent(geoId)}/${tab}`;
}

/* ---------------------------------------------------------------- numbers */

/** 「¥8,000」; null reads 「—」. */
export function yuan(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 100) / 100;
  return `¥${rounded.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`;
}

/** 「+12」「-3」「0」 — a change on the metric's own scale. */
export function signed(value: number, unit: GeoUnit = "index"): string {
  const rounded = Math.abs(value) >= 1 || value === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  const body = unit === "percent" ? `${Math.abs(rounded)} 个百分点` : String(Math.abs(rounded));
  return rounded > 0 ? `+${body}` : rounded < 0 ? `-${body}` : unit === "percent" ? "0 个百分点" : "0";
}

/**
 * A draft for 「问 AI」 about several numbers of one row: 「豆包：品牌提及率
 * 22%，310 次里 68 次；事实准确率 94%，…（10月13日测量）。这些数说明了什么，
 * 接下来该做什么？」
 */
export function rowDraft({
  product,
  scope,
  cells,
  date,
}: {
  product?: string | null;
  scope: string;
  cells: Array<{ name: string; cell: GeoCell | null | undefined; unit?: GeoUnit; word?: string }>;
  date?: string | null;
}): string {
  const subject = [product, scope].filter((part): part is string => !!part).join(" · ");
  const numbers = cells.map(({ name, cell, unit, word }) => `${name} ${word ?? geoCellPhrase(cell, unit)}`).join("；");
  const when = date ? `（${date}测量）` : "";
  return `${subject}：${numbers}${when}。这些数说明了什么，接下来该做什么？`;
}

/** 「DeepSeek：它需要每天注射一次」 — a wrong sentence with the engine that said it. */
export function errorLine(error: { engine: GeoEngine; statement: string }): string {
  return `${engineName(error.engine)}：${error.statement}`;
}
