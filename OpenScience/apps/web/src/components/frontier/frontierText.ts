/**
 * The words and small decisions the 「前沿动态」 surfaces share: how a time is
 * said, which flags and tags a card carries, what a hot row's line says, how
 * a trend is drawn, what a 「深入研究」 draft holds, how a list falls into days.
 *
 * Pure functions only, so each is tested once here and the components stay
 * about layout. Nothing here explains how the feed works (plan 2026-09-23
 * §4): the one explanation the page keeps is 「热度怎么算」, folded, because
 * a number on screen needs a way to find out what it counts — and its words
 * are `@evimed/domain`'s `FRONTIER_HEAT_METHOD_ZH`, stated from the numbers
 * the control plane computes heat with.
 */
import type {
  FrontierDaily,
  FrontierEvent,
  FrontierHotEvent,
  FrontierHotWindow,
  FrontierItem,
  FrontierPrimaryKind,
  FrontierScoreBand,
  FrontierTrendPoint,
} from "@/lib/frontierClient";
import { dayKey, dayLabel } from "@/lib/inboxGroups";
import { relativeTime } from "@/lib/runPresentation";

/* ------------------------------------------------------------------ actions */

/**
 * The feed's one small action — 「另有 3 家报道 ›」, a #tag, 「完整热榜 ›」,
 * 「全部 ›」, 「原文 ↗」: 24 px high, the minimum target (WCAG 2.5.8), 8 px
 * round, no ground until hovered. The control is set in the interface size;
 * words that read at the metadata size sit in a `text-caption` span inside it,
 * so every small action on the page is one control look and not one per
 * font size (the release walk counts them; the page may spend eight).
 */
export const INLINE_ACTION =
  "inline-flex h-6 shrink-0 items-center gap-0.5 rounded text-ui outline-none transition-colors duration-fast hover:bg-surface-2";

/** A new tab, and nothing of this page's context handed to the site. */
export const EXTERNAL = { target: "_blank", rel: "noopener noreferrer" } as const;

/* -------------------------------------------------------------------- cards */

/**
 * The flags a card says in words beside its evidence type: each changes how
 * a reader should take the item. A retraction is said in the safety colour —
 * it is a reason not to rely on the item at all. The rest (无摘要, 日期为推断,
 * 涉华, 已正式发表, 数据已更新, 多事汇总, 注册未发表) are the pipeline's own
 * bookkeeping and stay in the data (inventory 2026-09-23 §1.4).
 */
export const CARD_FLAG_KEYS: ReadonlySet<string> = new Set(["retracted", "corrected", "expression-of-concern", "preprint", "press-release"]);

/** The one evidence-type tag a card carries; none where the type says nothing more than the card already does. */
export function evidenceTag(item: Pick<FrontierItem, "evidenceType" | "evidenceTypeLabel" | "safetyAlert" | "flags">): string | null {
  const type = item.evidenceType;
  if (!type || type === "other" || !item.evidenceTypeLabel) return null;
  // A safety alert says 「安全警示」 already; a newsroom's flag says 「企业新闻稿」 and more.
  if (type === "safety-notice" && item.safetyAlert) return null;
  if (type === "press-release" && item.flags.some((flag) => flag.key === "press-release")) return null;
  return item.evidenceTypeLabel;
}

/** At most this many #tags under a card: its specialties first, then its diseases. */
export const CARD_MAX_TAGS = 3;

/** A #tag under a card: a specialty filters the feed by it, a disease searches for it. */
export type CardTag = { kind: "specialty" | "term"; key: string; label: string };

/** 「#消化 #结直肠癌」: the specialties (at most two), then the diseases, three in all. */
export function cardTags(item: Pick<FrontierItem, "specialties" | "entities">): CardTag[] {
  const tags: CardTag[] = item.specialties.slice(0, 2).map((specialty) => ({ kind: "specialty", key: specialty.key, label: specialty.label }));
  for (const disease of item.entities.diseases) {
    if (tags.length >= CARD_MAX_TAGS) break;
    const label = disease.trim();
    if (label && !tags.some((tag) => tag.label === label)) tags.push({ kind: "term", key: label, label });
  }
  return tags;
}

/**
 * The band an editorial score reads in: the server's, measured against its
 * selection line. A score that came without one is at most 「中」 — only the
 * server knows where the line is.
 */
export function scoreBand(item: Pick<FrontierItem, "score" | "scoreBand">): FrontierScoreBand | null {
  if (item.score === null) return null;
  return item.scoreBand ?? (item.score >= 60 ? "medium" : "low");
}

/** One item as Markdown (「⋯ › 复制为 Markdown」): its title linked to the original, what it says, who said it. */
export function itemMarkdown(item: Pick<FrontierItem, "title" | "url" | "summary" | "source" | "evidenceTypeLabel" | "publishedAt">): string {
  const title = item.title.replace(/([[\]])/g, "\\$1");
  const who = [item.source.name, item.evidenceTypeLabel, item.publishedAt?.slice(0, 10)].filter(Boolean).join(" · ");
  return [`**[${title}](${item.url})**`, ...(item.summary ? ["", item.summary] : []), "", who].join("\n");
}

/* -------------------------------------------------------------------- times */

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** `YYYY-MM-DD` → a Date at local midnight, or null. */
function localDay(key: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 「9月22日 周二」. */
export function shortDate(key: string): string {
  const date = localDay(key);
  return date ? `${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAYS[date.getDay()]}` : key;
}

/** 「14:05」, the local clock; empty for a time that cannot be read. */
export function clock(value: string | number | null): string {
  if (value === null) return "";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "";
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/** 「9月22日 18:01」: a moment named in full, when it is the fact itself (an event's first report). */
export function dateClock(value: string | null): string {
  if (!value) return "";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "";
  return `${at.getMonth() + 1}月${at.getDate()}日 ${clock(value)}`;
}

/** 「14:05」 today, 「9月22日 14:05」 before: when something was last read. */
export function stamp(value: string | null, now = Date.now()): string {
  if (!value) return "";
  return dayKey(value) === dayKey(now) ? clock(value) : dateClock(value);
}

/** 「2 小时前」 / 「9/20」: how long ago something happened; empty for no time. */
export function ago(value: string | null, now = Date.now()): string {
  if (!value) return "";
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? "" : relativeTime(ms, now);
}

/**
 * The feed's time column. Inside a day group the day is its heading, so the
 * column is the clock; where the list is not cut into days (a search, 与我相关)
 * it is the clock today and the day (「9月20日」) before.
 */
export function timeColumn(item: Pick<FrontierItem, "timelineAt">, grouped: boolean, now = Date.now()): string {
  if (grouped) return clock(item.timelineAt);
  const key = dayKey(item.timelineAt);
  if (!key) return "";
  const label = dayLabel(key, now);
  return label === "今天" ? clock(item.timelineAt) : label;
}

/* ---------------------------------------------------------------------- days */

export interface ItemDay {
  key: string;
  /** 「9月22日 周二」. */
  label: string;
  items: FrontierItem[];
}

/**
 * The list, cut into the reader's days by the list's own axis (`timelineAt`).
 * Items arrive newest first, so a day is a run of neighbours; a day is never
 * split in two even when the server's order and the local calendar disagree.
 */
export function groupByDay(items: readonly FrontierItem[]): ItemDay[] {
  const days: ItemDay[] = [];
  const byKey = new Map<string, ItemDay>();
  for (const item of items) {
    const key = dayKey(item.timelineAt) ?? "unknown";
    let day = byKey.get(key);
    if (!day) {
      day = { key, label: key === "unknown" ? "日期不明" : shortDate(key), items: [] };
      byKey.set(key, day);
      days.push(day);
    }
    day.items.push(item);
  }
  return days;
}

/* ----------------------------------------------------------------------- hot */

const PRIMARY_WORDS: Readonly<Record<FrontierPrimaryKind, string>> = Object.freeze({
  paper: "含原始论文",
  official: "含官方公告",
  guideline: "含指南原文",
  label: "含说明书原文",
});

const PRIMARY_HELD: Readonly<Record<FrontierPrimaryKind, string>> = Object.freeze({
  paper: "有论文原文",
  official: "有官方公告",
  guideline: "有指南原文",
  label: "有说明书原文",
});

/** 「01」: a rank as the hot list sets it, two digits and tabular. */
export function rankLabel(rank: number): string {
  return String(rank).padStart(2, "0");
}

/**
 * The colour of a rank: the first three in 青 / 浅青 / 琥珀 (plan §6.2) —
 * never red, which is the safety alerts'. Three steps that each read at
 * 4.5:1 and more on white, and that are the colours the 「新」 and 「升温」
 * tags already wear on the same list, so the ranks spend no colour of their
 * own. The rest are metadata grey.
 */
export function rankTone(rank: number): string {
  return rank === 1 ? "text-accent-strong" : rank === 2 ? "text-accent" : rank === 3 ? "text-warn" : "text-text-3";
}

/** 「↑2」 or 「新」: a hot event's move against the list six hours before. A fall is not said (plan §6.2). */
export function rankChangeLabel(change: FrontierHotEvent["rankChange"]): string | null {
  if (change === "new") return "新";
  return typeof change === "number" && change > 0 ? `↑${change}` : null;
}

/** 「3 小时前更新」, 「9/20更新」. */
function updated(value: string | null, now: number): string | null {
  const when = ago(value, now);
  return when ? `${when}更新` : null;
}

/**
 * A hot row's line: 「2 家机构报道 · 含原始论文 · 3 小时前更新」 on the current
 * list; on a week's or a month's ranking what the window held —
 * 「9 家机构报道 · 含原始论文 · 在榜 31 小时 · 最高第 2 名」. Counts are of
 * institutions, never of feeds; nothing is said that the server did not count.
 */
export function hotRowMeta(event: Pick<FrontierHotEvent, "sourceCount72h" | "primary" | "hasPrimary" | "lastAt" | "period">, now = Date.now()): string {
  const primary = event.primary ? PRIMARY_WORDS[event.primary] : event.hasPrimary ? "含一手材料" : null;
  if (event.period) {
    return [
      event.period.institutions > 0 ? `${event.period.institutions} 家机构报道` : null,
      primary,
      event.period.hoursOnList ? `在榜 ${event.period.hoursOnList} 小时` : null,
      event.period.bestRank ? `最高第 ${event.period.bestRank} 名` : null,
    ].filter(Boolean).join(" · ");
  }
  return [
    event.sourceCount72h > 0 ? `${event.sourceCount72h} 家机构报道` : null,
    primary,
    updated(event.lastAt, now),
  ].filter(Boolean).join(" · ");
}

const WINDOW_SPANS: Readonly<Record<FrontierHotWindow, string>> = Object.freeze({ current: "近 72 小时", week: "近 7 天", month: "近 30 天" });

/** 「近 72 小时 · 22:40 更新」: the span a ranking covers and when it was taken. */
export function hotBoardStamp(window: FrontierHotWindow, takenAt: string | null): string {
  const taken = clock(takenAt);
  return taken ? `${WINDOW_SPANS[window]} · ${taken} 更新` : WINDOW_SPANS[window];
}

/**
 * A trend as an SVG polyline in a `width` × `height` box: the points with a
 * reading, oldest first, scaled between their own lowest and highest (a flat
 * line sits in the middle), and the last point, which the chart marks. Null
 * with fewer than two readings — nothing to draw a line through.
 */
export function sparkline(points: readonly FrontierTrendPoint[], width: number, height: number, inset = 2): { path: string; last: { x: number; y: number } } | null {
  const read = points.flatMap((point, index) => (point.heat === null ? [] : [{ index, heat: point.heat }]));
  if (read.length < 2) return null;
  const span = Math.max(1, points.length - 1);
  const low = Math.min(...read.map((point) => point.heat));
  const high = Math.max(...read.map((point) => point.heat));
  const x = (index: number) => inset + (index / span) * (width - inset * 2);
  const y = (heat: number) => (high === low ? height / 2 : inset + (1 - (heat - low) / (high - low)) * (height - inset * 2));
  const round = (value: number) => Math.round(value * 10) / 10;
  const coords = read.map((point) => ({ x: round(x(point.index)), y: round(y(point.heat)) }));
  return { path: coords.map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`).join(" "), last: coords[coords.length - 1] };
}

/* --------------------------------------------------------------------- event */

/** 「期刊 1 · 媒体 1」: the institutions of the last 72 hours by kind; else their number; else nothing. */
export function institutionsLine(event: Pick<FrontierEvent, "institutions72h" | "sourceCount72h">): string | null {
  const kinds = event.institutions72h?.byType ?? [];
  if (kinds.length > 0) return kinds.map((kind) => `${kind.label} ${kind.count}`).join(" · ");
  return event.sourceCount72h > 0 ? `${event.sourceCount72h} 家` : null;
}

/** 「有论文原文」, 「有一手材料」 or 「无」: whether the parties' own texts are among the reports. */
export function primaryHeld(event: Pick<FrontierEvent, "primary" | "hasPrimary" | "items">): string {
  if (event.primary) return PRIMARY_HELD[event.primary];
  return event.hasPrimary || event.items.some((item) => item.role === "primary") ? "有一手材料" : "无";
}

/* --------------------------------------------------------------------- daily */

/** 「52 条 · 约 9 分钟」; the minutes only where the server has counted them. */
export function dailyMeta(issue: Pick<FrontierDaily, "itemCount" | "readingMinutes">): string {
  return [`${issue.itemCount} 条`, ...(issue.readingMinutes > 0 ? [`约 ${issue.readingMinutes} 分钟`] : [])].join(" · ");
}

/* ------------------------------------------------------------------ research */

export type ResearchIntent = "reliability" | "my-project" | "synthesis" | "own";

/** What the first question asks about: a study's design, a guideline's grounds, a decision's grounds, or a claim's. */
type Grounds = "study" | "guideline" | "decision" | "claim";

const STUDY_TYPES: ReadonlySet<string> = new Set(["rct", "systematic-review", "observational", "real-world"]);

/**
 * The first question follows what the item is: 「这项研究可靠吗」 on a policy
 * reading or a recall asks after a design it does not have (acceptance
 * 2026-09-22, F13).
 */
function groundsOf(item: Pick<FrontierItem, "evidenceType" | "sourceType">): Grounds {
  if ((item.evidenceType && STUDY_TYPES.has(item.evidenceType)) || item.sourceType === "preprint") return "study";
  if (item.evidenceType === "guideline") return "guideline";
  if (item.evidenceType === "regulatory-decision" || item.evidenceType === "safety-notice") return "decision";
  return "claim";
}

const FIRST_QUESTION: Readonly<Record<Grounds, { label: string; ask: string }>> = Object.freeze({
  study: { label: "这项研究可靠吗", ask: "这项研究可靠吗？请读原文，评估研究设计、样本、对照和偏倚风险，说明结论能不能用于临床决策。" },
  guideline: { label: "这份指南的推荐依据是什么", ask: "这份指南的推荐依据是什么？请读原文，列出主要推荐、各自的证据等级和所依据的研究，说明与现行做法有什么不同。" },
  decision: { label: "这项决定依据什么", ask: "这项决定依据什么？请读原文，说明决定的内容、所依据的数据，涉及哪些药品、器械或患者，临床上需要怎么做。" },
  claim: { label: "这条消息的依据是什么", ask: "这条消息的依据是什么？请读原文，找出它所依据的研究、数据或文件，说明哪些说法有证据支持、哪些还没有。" },
});

/** The three prepared questions and the free one (plan §4.7), in menu order; the first one fits the item. */
export function researchIntents(item: Pick<FrontierItem, "evidenceType" | "sourceType">): ReadonlyArray<{ key: ResearchIntent; label: string }> {
  return [
    { key: "reliability", label: FIRST_QUESTION[groundsOf(item)].label },
    { key: "my-project", label: "对我的课题意味着什么" },
    { key: "synthesis", label: "围绕这个问题做一份证据综合" },
    { key: "own", label: "自己写问题" },
  ];
}

const RESEARCH_ASKS: Readonly<Record<Exclude<ResearchIntent, "own" | "reliability">, string>> = Object.freeze({
  "my-project": "这条进展对我的课题意味着什么？请结合我在做的研究，说明它带来的新证据、需要调整的地方和值得跟进的问题。",
  synthesis: "围绕这条进展涉及的临床问题做一份证据综合：检索相关的随机对照试验、系统评价和指南，给出结论和证据确定性。",
});

/** The item as the conversation should receive it: what it is, who said it, where the original is. */
export function itemBrief(item: FrontierItem): string {
  const kind = [item.sourceTypeLabel, item.evidenceTypeLabel].filter(Boolean).join(" · ");
  const lines = [
    `「${item.title}」`,
    ...(item.titleZh && item.titleRaw !== item.titleZh ? [`原标题：${item.titleRaw}`] : []),
    `来源：${item.source.name}${kind ? `（${kind}）` : ""}`,
    ...item.flags.filter((flag) => ["preprint", "press-release", "retracted", "corrected"].includes(flag.key)).map((flag) => `注意：${flag.label}`),
    ...(item.publishedAt ? [`发布时间：${item.publishedAt.slice(0, 10)}`] : []),
    `原文：${item.url}`,
    ...(item.doi ? [`DOI：${item.doi}`] : []),
    ...(item.pmid ? [`PMID：${item.pmid}`] : []),
    ...(item.registryIds.length > 0 ? [`注册号：${item.registryIds.join("、")}`] : []),
    ...(item.summary ? [`导读：${item.summary}`] : []),
  ];
  return lines.join("\n");
}

/**
 * The draft 「深入研究」 puts in the composer. Never sent from here: the reader
 * reads it and presses send (plan §4.7). The free question keeps the item
 * first and leaves the cursor after 「我的问题：」.
 */
export function researchDraft(item: FrontierItem, intent: ResearchIntent): string {
  if (intent === "own") return `关于这条动态：\n${itemBrief(item)}\n\n我的问题：`;
  const ask = intent === "reliability" ? FIRST_QUESTION[groundsOf(item)].ask : RESEARCH_ASKS[intent];
  return `${ask}\n\n${itemBrief(item)}`;
}

/** The event page's 「深入研究」: the event with its first-hand sources, for the composer. */
export function eventResearchDraft(event: FrontierEvent): string {
  const primary = event.items.filter((item) => item.role === "primary");
  const sources = (primary.length > 0 ? primary : event.items).slice(0, 8)
    .map((item) => `- ${item.source.name}：${item.title}（${item.url}）`);
  return [
    "请围绕这个事件做一次深入研究：一手来源各自说了什么，报道之间有哪些出入，对临床实践和我的研究意味着什么。",
    "",
    `事件：${event.title}`,
    ...(event.digest ? [`综述：${event.digest}`] : []),
    ...(sources.length > 0 ? [primary.length > 0 ? "一手来源：" : "报道：", ...sources] : []),
  ].join("\n");
}
