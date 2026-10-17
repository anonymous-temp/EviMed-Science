import type { InboxItem, InboxSeverity } from "@/lib/inboxClient";

/**
 * How the inbox page arranges what the list route returns (contract C1): one
 * list of rows in the server's order, with unread clinical-safety findings
 * above it — the one class allowed to interrupt.
 *
 * It used to group by day, fold a day's routine completions into one line and
 * fold automated work into 「自动运行 N 条」 (2026-09-23 plan §5.8). The
 * server writes no notice for an evaluation, an internal project or an
 * autopilot run any more — a proactive result arrives as its digest — and
 * nothing is silent, so the page renders every item it is given as a row and
 * reads no grouping field. The day moved into each row's time column.
 *
 * One kind of repetition is folded (R19, audit D C2): a module that tells the reader something about a subject many times — a
 * 循证 GEO project's wrong statements, one notice for each engine and each fact, eleven of them from one project on the first
 * screen — is one row for the subject and the kind of notice (`groupInbox`), which opens the notices it holds.
 */

/** An item's weight; items written before the field existed read as the server reads them. */
export function severityOf(item: InboxItem): InboxSeverity {
  if (item.severity === "safety" || item.severity === "attention" || item.severity === "info") return item.severity;
  return item.noticeType === "notify" ? "info" : "attention";
}

export interface InboxOrder {
  /** Unread clinical-safety findings, newest first, whatever day they came. */
  pinned: InboxItem[];
  /** Everything else, as the server ordered it. */
  rest: InboxItem[];
}

/**
 * The page's two parts. `fetchedPinned` is the page the server returned for
 * `severity=safety, unread` — the list route orders by notice type, so a
 * safety notice written as a plain notify sits behind every briefing, and the
 * pinned section cannot be cut out of the loaded page. Whatever the loaded
 * page also holds of the class is pinned too, and is never drawn twice.
 */
export function orderInbox(items: readonly InboxItem[], fetchedPinned: readonly InboxItem[] = []): InboxOrder {
  const unreadSafety = (item: InboxItem) => !item.readAt && severityOf(item) === "safety";
  const pinned = new Map<string, InboxItem>();
  for (const item of [...fetchedPinned, ...items]) if (unreadSafety(item) && !pinned.has(item.id)) pinned.set(item.id, item);
  const newestFirst = (a: InboxItem, b: InboxItem) => Date.parse(b.createdAt) - Date.parse(a.createdAt);
  return {
    pinned: [...pinned.values()].sort(newestFirst),
    rest: items.filter((item) => !pinned.has(item.id)),
  };
}

/** `YYYY-MM-DD` of a moment in the reader's own time zone. */
export function dayKey(value: string | number | Date): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 今天 / 昨天 / 9月16日 / 2025年9月16日. */
export function dayLabel(key: string, now = Date.now()): string {
  const today = dayKey(now);
  const yesterday = dayKey(new Date(now).setDate(new Date(now).getDate() - 1));
  if (key === today) return "今天";
  if (key === yesterday) return "昨天";
  const [year, month, day] = key.split("-").map(Number);
  return year === new Date(now).getFullYear() ? `${month}月${day}日` : `${year}年${month}月${day}日`;
}

/** 14:02, in the reader's time zone. */
export function timeOfDay(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** A row's time column: 14:02 today, then 昨天, 9月22日, 2025年9月22日. */
export function inboxWhen(value: string, now = Date.now()): string {
  const key = dayKey(value);
  if (!key) return "";
  return key === dayKey(now) ? timeOfDay(value) : dayLabel(key, now);
}

/* ------------------------------------------------------------------- groups */

/**
 * The sources whose notices repeat about one subject, and so are folded: a notice of these says `<subject>/<page>/…` in its source
 * id (a GEO project and its tab, a study and its step). A run's, a briefing's or a memory's notice is its own thing — the server
 * has already merged what it merges (`groupKey`, `count`) — and stays a row each.
 */
const FOLDED_SOURCES: ReadonlySet<string> = new Set(["geo", "vcr"]);

/** How many notices of one subject and kind make a row of their own: two are two rows, a third is a pattern. */
export const GROUP_FROM = 3;

/** What the folded sources are called, in the toolbar's chips and a group's title. */
export const INBOX_SOURCE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  geo: "循证 GEO", vcr: "虚拟临床研究", run: "研究运行", thread: "对话", digest: "简报", memory: "记忆", share: "分享", system: "系统",
});

/** The word for 「N 条…」 in a group's title, by the page the notices open — closed vocabularies, not a reading of their titles. */
const GROUP_WORDS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  geo: { answers: "新的讲错", diagnosis: "诊断动态", content: "稿件动态", monitoring: "监测动态", actions: "行动动态" },
  vcr: {},
});
const GROUP_DEFAULT_WORDS: Readonly<Record<string, string>> = Object.freeze({ geo: "项目动态", vcr: "研究动态" });

/** The source family of a notice, as the toolbar's chips name it. */
export function inboxSourceOf(item: InboxItem): string {
  return item.source?.type ?? "system";
}

/** Notices folded into one row. */
export interface InboxGroup {
  /** Stable across loads: `<source>:<subject>:<page>:<weight>`. */
  key: string;
  source: string;
  /** The GEO project's or the study's id. */
  subject: string;
  page: string;
  /** The members, newest first. */
  items: InboxItem[];
  unread: number;
  latest: InboxItem;
  /** The group is clinical-safety findings; they are read one by one, never as a sweep. */
  safety: boolean;
  /** The project the notices were written under, when they say one: where the subject's name is looked up. */
  projectId: string | null;
}

export type InboxEntry = { kind: "item"; item: InboxItem } | { kind: "group"; group: InboxGroup };

/** The key a notice folds under, or null for one that is not folded. */
function foldKey(item: InboxItem): { key: string; source: string; subject: string; page: string; safety: boolean } | null {
  const source = item.source;
  if (!source || !FOLDED_SOURCES.has(source.type)) return null;
  const [subject, page = ""] = source.id.split("/");
  if (!subject) return null;
  const safety = severityOf(item) === "safety";
  return { key: `${source.type}:${subject}:${page}:${safety ? "safety" : "other"}`, source: source.type, subject, page, safety };
}

/**
 * The rows of a list of notices: a folded source's repeating notices become one group row, where the first of them stood, and
 * everything else stays a row. A subject with fewer than `GROUP_FROM` notices of a kind is not folded.
 */
export function groupInbox(items: readonly InboxItem[]): InboxEntry[] {
  const folded = new Map<string, InboxItem[]>();
  for (const item of items) {
    const found = foldKey(item);
    if (found) folded.set(found.key, [...(folded.get(found.key) ?? []), item]);
  }
  const newestFirst = (a: InboxItem, b: InboxItem) => Date.parse(b.createdAt) - Date.parse(a.createdAt);
  const entries: InboxEntry[] = [];
  const placed = new Set<string>();
  for (const item of items) {
    const found = foldKey(item);
    const members = found ? folded.get(found.key) ?? [] : [];
    if (!found || members.length < GROUP_FROM) {
      entries.push({ kind: "item", item });
      continue;
    }
    if (placed.has(found.key)) continue;
    placed.add(found.key);
    const sorted = [...members].sort(newestFirst);
    entries.push({
      kind: "group",
      group: {
        key: found.key, source: found.source, subject: found.subject, page: found.page, items: sorted,
        unread: sorted.filter((member) => !member.readAt).length, latest: sorted[0], safety: found.safety,
        projectId: sorted.find((member) => member.projectId)?.projectId ?? null,
      },
    });
  }
  return entries;
}

/** 「信尔美：18 条新的讲错」: the subject's name where it is known, the count and what the notices are about. */
export function inboxGroupTitle(group: Pick<InboxGroup, "source" | "page" | "items">, name?: string | null): string {
  const word = GROUP_WORDS[group.source]?.[group.page] ?? GROUP_DEFAULT_WORDS[group.source] ?? "消息";
  return `${name ? `${name}：` : ""}${group.items.length} 条${word}`;
}
