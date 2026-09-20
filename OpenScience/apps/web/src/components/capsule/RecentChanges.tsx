import { useState } from "react";
import { Undo2 } from "lucide-react";
import { webErrorMessage } from "@/lib/apiClient";
import { formatDateTime } from "@/lib/format";
import { announceMemoryChanged, undoMemoryRecord, type TimelineEvent } from "@/lib/memoryClient";
import { memoryExcerpt } from "@/lib/memoryText";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";

/** How many lines 「最近变化」 shows. Five, because this is a glance at what
 *  moved since last time, not a log — the log is each memory's own history. */
export const RECENT_CHANGE_COUNT = 5;

/** What one event did, in the researcher's words. */
const MEMORY_CHANGE: Record<string, string> = {
  created: "记下了",
  updated: "改了",
  confirmed: "你确认了",
  archived: "不再提",
  restored: "恢复了",
  superseded: "被新的替代",
  status: "状态变了",
};

const METHOD_CHANGE: Record<string, string> = {
  learned: "学到一条做法",
  approved: "一条做法开始生效",
  retired: "停用了一条做法",
};

function day(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : formatDateTime(date, { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** The events this section shows: what was written, changed or undone, plus a
 *  method that started or stopped being used. A run finishing is not a change
 *  to memory, and the run ledger is not this page's subject. */
export function recentChanges(items: readonly TimelineEvent[]): TimelineEvent[] {
  return items
    .filter((item) => (item.type === "memory" && item.kind !== "run_summary")
      || (item.type === "method" && ["learned", "approved", "retired"].includes(item.change)))
    .slice(0, RECENT_CHANGE_COUNT);
}

/**
 * 「最近变化」 — the last five things that changed by themselves, each with the
 * way to take it back.
 *
 * This replaces the 时间轴 tab. The tab showed a year-long density band and a
 * paginated event list over four sources, which answered "what has this system
 * been doing" — a question about the platform. What a researcher asks when they
 * open this page is "what changed about me since I last looked", and five lines
 * with an 撤销 on each is the whole of that answer. The derivation underneath
 * is unchanged (`memoryTimeline.mjs`), read with a small limit.
 *
 * A retired method is here on purpose: since 2026-09-20 a method the loop
 * distils takes effect at once and the paired evaluation retires it when it
 * measures worse, so this is where that says so. It is taken back on the
 * method's own row, which has its版本 history; there is no undo here for one.
 */
export function RecentChanges({ items, onChanged }: { items: readonly TimelineEvent[]; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const shown = recentChanges(items);

  const undo = async (item: TimelineEvent) => {
    if (!item.recordId || !item.version) return;
    setBusy(item.id);
    try {
      const result = await undoMemoryRecord(item.recordId, item.version);
      toast.success(result.undone === "removed" ? "已撤销这条记忆" : "已撤销上次改动");
      announceMemoryChanged();
      onChanged();
    } catch (error) {
      toast.error(webErrorMessage(error, { fallback: "撤销没有完成，请重试。" }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="capsule-recent">
      <h2 id="capsule-recent" className="text-body font-semibold text-text">最近变化</h2>
      {shown.length === 0 ? (
        <p className="mt-2 text-ui text-muted">还没有变化。做过几次研究之后，EviMed 记下或改动了什么都会列在这里，每条都能撤销。</p>
      ) : (
        <ul className="mt-2 divide-y divide-border rounded-card border border-border bg-surface">
          {shown.map((item) => (
            <li key={item.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-4 py-3">
              <div className="min-w-0">
                <p className="text-ui text-text">
                  {item.type === "method"
                    ? `${METHOD_CHANGE[item.change] ?? "做法有变动"}：${memoryExcerpt(item.name ?? "", 60)}`
                    : `${MEMORY_CHANGE[item.change] ?? "有变动"}：${memoryExcerpt(item.after || item.before || "", 90)}`}
                </p>
                <p className="mt-0.5 text-caption text-muted">
                  {day(item.at)}
                  {item.type === "method" && item.reason ? ` · ${memoryExcerpt(item.reason, 80)}` : ""}
                </p>
              </div>
              {item.type === "memory" && item.recordId && item.version ? (
                <Button size="sm" variant="ghost" loading={busy === item.id} disabled={busy !== null} onClick={() => void undo(item)}>
                  <Undo2 size={13} aria-hidden="true" />撤销
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
