/**
 * The words and small decisions the 「前沿动态」 surfaces share: how a time is
 * said, how a level is said, which tone a chip wears, what a 「深入研究」 draft
 * holds, how a list falls into days.
 *
 * Pure functions only, so each is tested once here and the components stay
 * about layout. Nothing in this file prints a number the server scored: levels
 * are 高 / 中 / 低 and nothing else (plan §4.3).
 */
import { FRONTIER_LEVEL_LABELS_ZH } from "@evimed/domain";
import type { FrontierEvent, FrontierHotEvent, FrontierItem, FrontierLevel, FrontierPrimaryKind } from "@/lib/frontierClient";
import { dayKey, dayLabel } from "@/lib/inboxGroups";
import { relativeTime } from "@/lib/runPresentation";

/* --------------------------------------------------------------------- tones */

/** The chip colours this surface uses — every one a token pair, and colour never alone. */
export type ChipTone = "neutral" | "outline" | "accent" | "ok" | "info" | "warn" | "danger";

/**
 * Who said it, at a glance (plan §4.3 「一眼分清一手和转述」). Journals green,
 * regulators blue, evidence bodies in the brand colour; preprints and company
 * newsrooms amber, because both are claims still waiting on someone else's
 * check; media neutral.
 */
export function sourceTypeTone(sourceType: string): ChipTone {
  switch (sourceType) {
    case "journal": return "ok";
    case "regulator": return "info";
    case "evidence-body": return "accent";
    case "preprint":
    case "company": return "warn";
    default: return "neutral";
  }
}

/**
 * The flags a card shows. Each changes how a reader should take the item.
 * 无摘要, 日期为推断 and 涉华 are the pipeline's own bookkeeping — true, but
 * on the first live run (2026-09-22) they turned most cards' label row into
 * two lines of chips that said nothing to a reader; they stay in the data.
 */
export const CARD_FLAG_KEYS: ReadonlySet<string> = new Set([
  "preprint", "press-release", "retracted", "corrected", "expression-of-concern", "published-version", "registry-unpublished", "data-updated",
]);

/** At most this many specialties on a card; the rest are one filter away. */
export const CARD_MAX_TOPICS = 2;

/** Flags that change how a reader should take the item wear a colour; the rest stay quiet. */
export function flagTone(flag: string): ChipTone {
  if (flag === "retracted") return "danger";
  if (["preprint", "press-release", "corrected", "expression-of-concern", "registry-unpublished"].includes(flag)) return "warn";
  return "neutral";
}

/* -------------------------------------------------------------------- levels */

/** 高 / 中 / 低, the vocabulary's words for a level. */
export const LEVEL_WORDS: Readonly<Record<FrontierLevel, string>> = FRONTIER_LEVEL_LABELS_ZH;

/** The four dimensions of 「为什么入选」, in the order the design names them. */
export const LEVEL_DIMENSIONS: ReadonlyArray<{ key: keyof FrontierItem["levels"]; label: string }> = Object.freeze([
  { key: "authority", label: "来源权威" },
  { key: "impact", label: "实践影响" },
  { key: "novelty", label: "新颖性" },
  { key: "relevance", label: "与国内相关" },
]);

/** What the number check found, in one sentence. */
export function verificationSentence(item: Pick<FrontierItem, "verification" | "summary">): string {
  switch (item.verification) {
    case "passed": return "导读里的数字都已在原文里核对到。";
    case "repaired": return "导读重写过一次，数字已在原文里核对到。";
    case "title-only": return "导读没有通过数字核对，这一条只保留原标题。";
    default: return item.summary ? "导读里的数字还在核对。" : "这一条还没有导读。";
  }
}

const SELECTED_RULES: Readonly<Record<string, string>> = Object.freeze({
  threshold: "综合评估达到精选线。",
  "lane-floor": "今天这个栏目里最值得看的一条。",
  "safety-bypass": "官方安全通告，不看热度直接入选。",
  "operator-pin": "编辑置顶。",
});

/** Why a selected item is in 精选; null when the rule is one this page has no words for. */
export function selectedRuleSentence(rule: string | null): string | null {
  return rule ? SELECTED_RULES[rule] ?? null : null;
}

const EVIDENCE_BASIS: Readonly<Record<string, string>> = Object.freeze({
  "pubmed-types": "证据类型取自 PubMed 的文献类型。",
  registry: "证据类型取自试验注册信息。",
  model: "证据类型由模型按摘要判断，PubMed 标引后由程序复核。",
});

export function evidenceBasisSentence(basis: FrontierItem["evidenceBasis"]): string | null {
  return basis ? EVIDENCE_BASIS[basis] ?? null : null;
}

/* --------------------------------------------------------------------- times */

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

/** 「2026 年 9 月 21 日 周一」, the daily's dateline. */
export function longDate(key: string): string {
  const date = localDay(key);
  return date ? `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日 ${WEEKDAYS[date.getDay()]}` : key;
}

/** 14:05 today, 「昨天 14:05」, else 「9月20日 14:05」: when something last happened. */
export function clockOrDate(value: string | null, now = Date.now()): string {
  if (!value) return "";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "";
  const clock = at.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const key = dayKey(at);
  if (!key) return clock;
  const label = dayLabel(key, now);
  return label === "今天" ? clock : `${label} ${clock}`;
}

/**
 * When the item was published, the way the card says it: 「2 小时前」 for a
 * precise moment, the day alone — 「今天」「昨天」「9月18日」 — for a date the
 * source only gave to the day or that had to be inferred (build spec C).
 */
export function itemWhen(item: Pick<FrontierItem, "publishedAt" | "timelineAt" | "datePrecision">, now = Date.now()): string {
  const at = item.publishedAt ?? item.timelineAt;
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return "";
  if (item.publishedAt && item.datePrecision !== "instant") {
    const key = dayKey(ms);
    return key ? dayLabel(key, now) : "";
  }
  return relativeTime(ms, now);
}

/** A moment as 「N 分钟前」 / a date, or empty. */
export function ago(value: string | null, now = Date.now()): string {
  if (!value) return "";
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? "" : relativeTime(ms, now);
}

/* ---------------------------------------------------------------------- days */

export interface ItemDay {
  key: string;
  /** 「今天 · 9月22日 周二」 or 「9月20日 周日」. */
  label: string;
  items: FrontierItem[];
}

/**
 * The list, cut into the reader's days by the list's own axis (`timelineAt`).
 * Items arrive newest first, so a day is a run of neighbours; a day is never
 * split in two even when the server's order and the local calendar disagree.
 */
export function groupByDay(items: readonly FrontierItem[], now = Date.now()): ItemDay[] {
  const days: ItemDay[] = [];
  const byKey = new Map<string, ItemDay>();
  for (const item of items) {
    const key = dayKey(item.timelineAt) ?? "unknown";
    let day = byKey.get(key);
    if (!day) {
      const relative = key === "unknown" ? "日期不明" : dayLabel(key, now);
      const label = key === "unknown" ? relative
        : relative === "今天" || relative === "昨天" ? `${relative} · ${shortDate(key)}` : shortDate(key);
      day = { key, label, items: [] };
      byKey.set(key, day);
      days.push(day);
    }
    day.items.push(item);
  }
  return days;
}

/* ---------------------------------------------------------------------- hot */

const PRIMARY_WORDS: Readonly<Record<FrontierPrimaryKind, string>> = Object.freeze({
  paper: "含原始论文",
  official: "含官方公告",
  guideline: "含指南原文",
  label: "含说明书原文",
});

/** 「近 72 小时 6 个来源 · 累计 9 篇报道 · 含原始论文」 — three separate quantities, never a heat value. */
export function hotMeta(event: Pick<FrontierHotEvent, "sourceCount72h" | "reportCount" | "primary">, compact = false): string {
  const parts = [
    compact ? `${event.sourceCount72h} 个来源` : `近 72 小时 ${event.sourceCount72h} 个来源`,
    ...(compact ? [] : [`累计 ${event.reportCount} 篇报道`]),
    ...(event.primary ? [PRIMARY_WORDS[event.primary]] : []),
  ];
  return parts.join(" · ");
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

/** 「深入研究这个事件」: the event with its first-hand sources, for the composer. */
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
