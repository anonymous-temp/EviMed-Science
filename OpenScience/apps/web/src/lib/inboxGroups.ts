import type { InboxItem, InboxSeverity } from "@/lib/inboxClient";

/**
 * How the inbox page arranges what the list route returns (contract C1,
 * appendix C §3.4): by day, with the day's routine completions folded into one
 * line, automated work kept out of the way, and unread clinical-safety
 * findings pinned above everything — the one class allowed to interrupt.
 */

/** An item's weight; items written before the field existed read as the server reads them. */
export function severityOf(item: InboxItem): InboxSeverity {
  if (item.severity === "safety" || item.severity === "attention" || item.severity === "info") return item.severity;
  return item.noticeType === "notify" ? "info" : "attention";
}

const RANK: Record<InboxSeverity, number> = { safety: 0, attention: 1, info: 2 };

/**
 * The titles the control plane gave a routine completion before it merged them
 * itself (a closed vocabulary: its own outcome table). Newer items arrive
 * merged with a `groupKey`; these are the per-run items written before that,
 * which a busy day turned into ten identical cards. 「研究已交付，待你复核」
 * is the wording that ran until 2026-09-20 and is still on stored rows.
 */
const LEGACY_ROUTINE_TITLES = new Set(["研究已完成", "研究已交付", "研究已交付，待你复核"]);

export function isLegacyRoutineCompletion(item: InboxItem): boolean {
  return item.noticeType === "notify"
    && item.source?.type === "run"
    && !item.groupKey
    && severityOf(item) !== "safety"
    && LEGACY_ROUTINE_TITLES.has(item.title);
}

export type InboxEntry =
  | { kind: "item"; item: InboxItem }
  /** Routine completions of one day, folded: 「研究已完成 × N」. */
  | { kind: "completions"; items: InboxItem[] };

export interface InboxDay {
  key: string;
  label: string;
  entries: InboxEntry[];
  /** Evaluation cells and autopilot episodes: recorded, never counted, shown quietly. */
  silent: InboxItem[];
}

export interface InboxLayout {
  /** Unread clinical-safety findings, whatever day they came. */
  pinned: InboxItem[];
  days: InboxDay[];
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

export function layoutInbox(items: readonly InboxItem[], now = Date.now()): InboxLayout {
  const pinned: InboxItem[] = [];
  const byDay = new Map<string, InboxItem[]>();
  for (const item of items) {
    if (!item.readAt && !item.silent && severityOf(item) === "safety") {
      pinned.push(item);
      continue;
    }
    const key = dayKey(item.createdAt) ?? "unknown";
    const bucket = byDay.get(key) ?? [];
    bucket.push(item);
    byDay.set(key, bucket);
  }
  const newestFirst = (a: InboxItem, b: InboxItem) => Date.parse(b.createdAt) - Date.parse(a.createdAt);
  const days = [...byDay.entries()]
    .sort(([a], [b]) => (a === "unknown" ? 1 : b === "unknown" ? -1 : b.localeCompare(a)))
    .map(([key, bucket]): InboxDay => {
      const silent = bucket.filter((item) => item.silent).sort(newestFirst);
      const loud = bucket
        .filter((item) => !item.silent)
        .sort((a, b) => RANK[severityOf(a)] - RANK[severityOf(b)] || newestFirst(a, b));
      const completions = loud.filter(isLegacyRoutineCompletion);
      const entries: InboxEntry[] = [];
      let placed = false;
      for (const item of loud) {
        if (completions.length > 1 && isLegacyRoutineCompletion(item)) {
          // The folded line sits where the day's newest completion would.
          if (!placed) entries.push({ kind: "completions", items: completions });
          placed = true;
          continue;
        }
        entries.push({ kind: "item", item });
      }
      return { key, label: key === "unknown" ? "日期不明" : dayLabel(key, now), entries, silent };
    });
  return { pinned: pinned.sort(newestFirst), days };
}

/** 14:02, in the reader's time zone. */
export function timeOfDay(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}
