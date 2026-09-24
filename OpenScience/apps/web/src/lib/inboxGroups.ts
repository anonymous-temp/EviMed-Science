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

export function orderInbox(items: readonly InboxItem[]): InboxOrder {
  const pinnedIds = new Set(items
    .filter((item) => !item.readAt && severityOf(item) === "safety")
    .map((item) => item.id));
  const newestFirst = (a: InboxItem, b: InboxItem) => Date.parse(b.createdAt) - Date.parse(a.createdAt);
  return {
    pinned: items.filter((item) => pinnedIds.has(item.id)).sort(newestFirst),
    rest: items.filter((item) => !pinnedIds.has(item.id)),
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
