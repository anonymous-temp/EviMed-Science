/**
 * The words and small decisions the 「前沿动态」 surfaces share: how a time is
 * said, which flags and tags a card carries, what a hot row's line says, how
 * a trend is drawn, what a 「深入研究」 draft holds, how a list falls into days.
 *
 * Pure functions only, so each is tested once here and the components stay
 * about layout. Nothing here explains how the feed works (plan 2026-09-23
 * §4); the 「热度怎么算」 fold was the one explanation left and went on
 * 2026-10-07 — a heat is shown as a number, and the domain keeps its method
 * (`FRONTIER_HEAT_METHOD_ZH`) for the operator's documents.
 */
import {
  FRONTIER_SCORE_PARTS,
  scoreTier,
  type FrontierDaily,
  type FrontierEvent,
  type FrontierHotEvent,
  type FrontierHotWindow,
  type FrontierItem,
  type FrontierPlatform,
  type FrontierPrimaryKind,
  type FrontierScoreBand,
  type FrontierTrendPoint,
} from "@/lib/frontierClient";
import { dayKey } from "@/lib/inboxGroups";
import { relativeTime } from "@/lib/runPresentation";

/* ------------------------------------------------------------------ actions */

/**
 * The feed's one small action — 「另有 3 家报道 ›」, a #tag, 「完整热榜 ›」,
 * 「全部 ›」, 「原文 ↗」: 28 px high (`h-sm`), the small control height a row's
 * icon buttons have (spec §8.3, §17.2) — it stood at 24 beside the card's
 * 28 px ☆ and ⋯, a height of its own — 8 px round, no ground until hovered.
 * The control is set in the interface size; words that read at the metadata
 * size sit in a `text-caption` span inside it, so every small action on the
 * page is one control look and not one per font size (the release walk counts
 * them; the page may spend nine).
 */
export const INLINE_ACTION =
  "inline-flex h-sm shrink-0 items-center gap-0.5 rounded text-ui outline-none transition-colors duration-fast hover:bg-surface-2";

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

/** At most this many #tags under a card: the item's own, in its order (the reader lists all of them). */
export const CARD_MAX_TAGS = 3;

/**
 * The eyebrow tag of a card: the evidence type of a paper (「RCT」), else the item's lane (「审批监管」) — one word for what it is.
 * None for a safety alert, which says 「安全警示」 first already.
 */
export function cardEyebrow(item: Pick<FrontierItem, "evidenceType" | "evidenceTypeLabel" | "safetyAlert" | "flags" | "laneLabel">): string | null {
  if (item.safetyAlert) return null;
  return evidenceTag(item) ?? (item.laneLabel || null);
}

/** 「AI 评分」: one name everywhere — the card's pill, the reader's 推荐理由, a screen reader. */
export const SCORE_LABEL = "AI 评分";

/** What 「AI 评分」 measures, under its breakdown. */
export const SCORE_NOTE = "衡量对临床和科研读者的重要程度，不代表证据等级";

/** The tier a score reads in: the server's (85 / 70), or from the score itself where a server sent none. */
export function scoreBand(item: Pick<FrontierItem, "score" | "scoreBand">): FrontierScoreBand | null {
  if (item.score === null) return null;
  return item.scoreBand ?? scoreTier(item.score);
}

/** The four parts of a score as its bars draw them — 实践影响 x/30, 权威性 x/30, 新颖性 x/20, 国内相关性 x/20 — or none. */
export function scoreBreakdown(item: Pick<FrontierItem, "scoreParts">): Array<{ key: string; label: string; value: number; max: number }> {
  const parts = item.scoreParts;
  return parts ? FRONTIER_SCORE_PARTS.map(({ key, label, max }) => ({ key, label, value: parts[key], max })) : [];
}

/** One item as Markdown (「⋯ › 复制为 Markdown」): its title linked to the original, what it says, who said it. */
export function itemMarkdown(item: Pick<FrontierItem, "title" | "url" | "summary" | "source" | "evidenceTypeLabel" | "publishedAt">): string {
  const title = item.title.replace(/([[\]])/g, "\\$1");
  const who = [item.source.name, item.evidenceTypeLabel, item.publishedAt?.slice(0, 10)].filter(Boolean).join(" · ");
  return [`**[${title}](${item.url})**`, ...(item.summary ? ["", item.summary] : []), "", who].join("\n");
}

/* ---------------------------------------------------------------- platforms */

/** Where a post was published, as a reader names it; an ordinary web page names no platform. */
export const PLATFORM_LABELS: Readonly<Record<FrontierPlatform, string | null>> = Object.freeze({
  x: "X", wechat: "微信公众号", xiaohongshu: "小红书", douyin: "抖音", zhihu: "知乎", weibo: "微博", bilibili: "哔哩哔哩", channels: "视频号", web: null,
});

/** A post on a social platform: its account is who said it, and the publication it came through is that platform. */
export function isSocialItem(item: Pick<FrontierItem, "platform">): boolean {
  return item.platform !== null && item.platform !== "web";
}

/** The way to the original: a post is 「在 X 查看原帖」, an article (a page, a paper, a WeChat article) 「打开原文」. */
export function originalLinkLabel(item: Pick<FrontierItem, "platform">): string {
  if (!item.platform || item.platform === "web" || item.platform === "wechat") return "打开原文";
  const platform = PLATFORM_LABELS[item.platform];
  return /^[A-Za-z]/.test(platform ?? "") ? `在 ${platform} 查看原帖` : `在${platform}查看原帖`;
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
 * 「刚刚」「5 分钟前」「3 小时前」「2 天前」: how long ago, beside a line that already names the moment (the reader's byline, a follow-up's
 * row). Empty past thirty days, where the date says it better, and for a time that cannot be read or is ahead of the clock.
 */
export function sinceText(value: string | null, now = Date.now()): string {
  if (!value) return "";
  const at = Date.parse(value);
  if (Number.isNaN(at) || at > now + 60_000) return "";
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} 小时前`;
  const days = Math.floor(minutes / (24 * 60));
  return days <= 30 ? `${days} 天前` : "";
}

/**
 * When an item came, in a list that is not cut into days (与我相关, a search by relevance, an event's list), said in the card's meta row
 * after its source: the clock today (「09:06」), the day before (「10月20日」), the year too before this one. A day-grouped list
 * has the clock in its own column instead (`clock`).
 */
export function metaTime(item: Pick<FrontierItem, "timelineAt">, now = Date.now()): string {
  const key = dayKey(item.timelineAt);
  if (!key) return "";
  if (key === dayKey(now)) return clock(item.timelineAt);
  const [year, month, day] = key.split("-").map(Number);
  return year === new Date(now).getFullYear() ? `${month}月${day}日` : `${year}年${month}月${day}日`;
}

/** A day group's heading: 「今天 · 10月23日 周四 · 11 条」, 「10月22日 周三 · 40 条」 — the count once the whole day is on screen. */
export function dayHeading(day: Pick<ItemDay, "key" | "label" | "items">, whole: boolean, now = Date.now()): string {
  return [day.key === dayKey(now) ? "今天" : null, day.label, whole ? `${day.items.length} 条` : null].filter(Boolean).join(" · ");
}

/* ---------------------------------------------------------------------- links */

/**
 * A bare address in a text: http(s), up to the first space or a character no address carries in running Chinese text. What trails it
 * — a full stop, a comma, a closing bracket the address did not open — is the sentence's, not the address's (`trimUrl`).
 */
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`（）【】「」『』《》，。；：！？、“”‘’]+/g;

/** An address without what the sentence put after it: trailing punctuation, and closing brackets it did not open. */
export function trimUrl(raw: string): string {
  let url = raw;
  for (;;) {
    const last = url.slice(-1);
    if (/[.,;:!?'"]/.test(last)) { url = url.slice(0, -1); continue; }
    const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
    if (pairs[last] && url.split(last).length > url.split(pairs[last]).length) { url = url.slice(0, -1); continue; }
    return url;
  }
}

/** The longest an address is shown: its site and the start of its path (the whole address is its tooltip). */
const SHOWN_URL_MAX = 40;

/**
 * An address as a reader takes it in: the site without `www.`, then the path — whole if the two fit in 40 characters, else its first
 * segment and 「…」 (「fda.gov/vaccines-blood-biologics/…」), else cut at 40. The query and the fragment are not shown.
 */
export function shortUrl(url: string): string {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return url.length > SHOWN_URL_MAX ? `${url.slice(0, SHOWN_URL_MAX - 1)}…` : url; }
  const host = parsed.hostname.replace(/^www\./, "");
  let path = parsed.pathname.replace(/\/+$/, "");
  try { path = decodeURI(path); } catch { /* an address that is not valid percent-encoding is shown as it came */ }
  const whole = `${host}${path}`;
  if (whole.length <= SHOWN_URL_MAX) return whole;
  const first = path.split("/").filter(Boolean)[0];
  const head = first ? `${host}/${first}/…` : "";
  if (head && head.length <= SHOWN_URL_MAX) return head;
  return `${whole.slice(0, SHOWN_URL_MAX - 1)}…`;
}

/** A piece of a text: its own words, or an address in it. */
export type TextPiece = string | { url: string };

/** A text cut into its words and its bare addresses, in order; what trails an address stays with the words after it. */
export function splitUrls(text: string): TextPiece[] {
  const pieces: TextPiece[] = [];
  let rest = 0;
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const url = trimUrl(match[0]);
    if (!/^https?:\/\/[^/]+\.[^/]/.test(url)) continue;
    if (match.index > rest) pieces.push(text.slice(rest, match.index));
    pieces.push({ url });
    rest = match.index + url.length;
  }
  if (rest < text.length) pieces.push(text.slice(rest));
  return pieces;
}

/** An address as compared with an item's own: no trailing slash, no fragment, `http` and `https` alike, the site's `www.` aside. */
export function sameAddress(a: string, b: string): boolean {
  const key = (value: string) => value.trim().replace(/#.*$/, "").replace(/\/+$/, "").replace(/^https?:\/\/(www\.)?/i, "").toLowerCase();
  return key(a) === key(b);
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

/**
 * “3 小时前更新”, “9月20日更新”, “2025-09-20 更新”: a time that ends in a digit
 * takes the typed half-width space before 更新 (spec §5.5).
 */
export function updatedText(when: string): string {
  return /[A-Za-z0-9]$/.test(when) ? `${when} 更新` : `${when}更新`;
}

function updated(value: string | null, now: number): string | null {
  const when = ago(value, now);
  return when ? updatedText(when) : null;
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
 *
 * A reading that is missing keeps its place on the time axis and breaks the
 * line: each run of consecutive readings is its own `M … L …` segment, and no
 * stroke crosses a gap (design reference §11.2 — a gap is shown, never joined
 * over). A reading with a gap on both sides has no neighbour to be joined to,
 * so it is returned in `dots` for the chart to mark and is not in `path`.
 */
export function sparkline(points: readonly FrontierTrendPoint[], width: number, height: number, inset = 2): { path: string; last: { x: number; y: number }; dots: { x: number; y: number }[] } | null {
  const read = points.flatMap((point, index) => (point.heat === null ? [] : [{ index, heat: point.heat }]));
  if (read.length < 2) return null;
  const span = Math.max(1, points.length - 1);
  const low = Math.min(...read.map((point) => point.heat));
  const high = Math.max(...read.map((point) => point.heat));
  const x = (index: number) => inset + (index / span) * (width - inset * 2);
  const y = (heat: number) => (high === low ? height / 2 : inset + (1 - (heat - low) / (high - low)) * (height - inset * 2));
  const round = (value: number) => Math.round(value * 10) / 10;
  const runs: { x: number; y: number }[][] = [];
  let before = -2;
  for (const point of read) {
    const coord = { x: round(x(point.index)), y: round(y(point.heat)) };
    if (point.index === before + 1) runs[runs.length - 1].push(coord);
    else runs.push([coord]);
    before = point.index;
  }
  const lastRun = runs[runs.length - 1];
  return {
    path: runs.filter((run) => run.length > 1).map((run) => run.map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`).join(" ")).join(" "),
    last: lastRun[lastRun.length - 1],
    dots: runs.filter((run) => run.length === 1).map((run) => run[0]),
  };
}

/* --------------------------------------------------------------------- event */

/** 「期刊 1 · 媒体 1」: the institutions of the last 72 hours by kind; else their number; else nothing. */
export function institutionsLine(event: Pick<FrontierEvent, "institutions72h" | "sourceCount72h">): string | null {
  const kinds = event.institutions72h?.byType ?? [];
  if (kinds.length > 0) return kinds.map((kind) => `${kind.label} ${kind.count}`).join(" · ");
  return event.sourceCount72h > 0 ? `${event.sourceCount72h} 家` : null;
}

/** 「有论文原文」, 「有一手材料」 or 「暂无」: whether the parties' own texts are among the reports. */
export function primaryHeld(event: Pick<FrontierEvent, "primary" | "hasPrimary" | "items">): string {
  if (event.primary) return PRIMARY_HELD[event.primary];
  return event.hasPrimary || event.items.some((item) => item.role === "primary") ? "有一手材料" : "暂无";
}

/* --------------------------------------------------------------------- daily */

/** The name a reader knows a time zone by: 「北京时间」 for the platform's own; else the browser's long name for it; else its IANA name. */
export function zoneName(timeZone: string): string {
  if (timeZone === "Asia/Shanghai") return "北京时间";
  try {
    const name = new Intl.DateTimeFormat("zh-CN", { timeZone, timeZoneName: "long" }).formatToParts(new Date()).find((part) => part.type === "timeZoneName")?.value;
    return name || timeZone;
  } catch {
    return timeZone;
  }
}

/** 「07:30（北京时间）」: the clock the server publishes by and whose clock it is. */
export function scheduleLabel(schedule: { time: string; timeZone: string }): string {
  return `${schedule.time}（${zoneName(schedule.timeZone)}）`;
}

/** 「52 条 · 约 9 分钟」; the minutes only where the server has counted them. */
export function dailyMeta(issue: Pick<FrontierDaily, "itemCount" | "readingMinutes">): string {
  return [`${issue.itemCount} 条`, ...(issue.readingMinutes > 0 ? [`约 ${issue.readingMinutes} 分钟`] : [])].join(" · ");
}

/* ------------------------------------------------------------------ research */

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

const FIRST_QUESTION: Readonly<Record<Grounds, string>> = Object.freeze({
  study: "这项研究可靠吗？请读原文，评估研究设计、样本、对照和偏倚风险，说明结论能不能用于临床决策。",
  guideline: "这份指南的推荐依据是什么？请读原文，列出主要推荐、各自的证据等级和所依据的研究，说明与现行做法有什么不同。",
  decision: "这项决定依据什么？请读原文，说明决定的内容、所依据的数据，涉及哪些药品、器械或患者，临床上需要怎么做。",
  claim: "这条消息的依据是什么？请读原文，找出它所依据的研究、数据或文件，说明哪些说法有证据支持、哪些还没有。",
});

/** The item as the conversation should receive it: what it is, who said it, where the original is. */
export function itemBrief(item: FrontierItem): string {
  const kind = [item.sourceTypeLabel, item.evidenceTypeLabel].filter(Boolean).join(" · ");
  const lines = [
    `“${item.title}”`,
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
 * The card's 「深入研究」: one question that fits the item — a study's
 * reliability, a guideline's grounds, a decision's basis, a claim's evidence —
 * and what it means in practice, then the item itself. It lands in the
 * composer as a draft the researcher sends or rewrites (owner, 2026-09-24:
 * no menu of prepared questions to choose from first).
 */
export function researchDraft(item: FrontierItem): string {
  return `${FIRST_QUESTION[groundsOf(item)]}它对临床实践和我的研究意味着什么，也请一并说明。\n\n${itemBrief(item)}`;
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
