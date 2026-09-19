import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { MEMORY_CHANGED_EVENT, fetchMemoryTimeline, type MemoryTimelinePage, type TimelineDensity, type TimelineEvent } from "@/lib/memoryClient";
import { MEMORY_BASIS_LABELS, memoryKindLabel } from "@/lib/memoryText";
import { Button } from "@/components/ui/Button";
import { inputClasses } from "@/components/ui/Input";
import { SectionShell } from "./SectionShell";

/** Who made a memory change, as the timeline says it. */
const CHANGED_BY: Record<string, string> = {
  extraction: "从任务中学到",
  user: "你改的",
  system: "系统整理",
};

/** What a run's status reads as on the timeline. */
const RUN_STATUS: Record<string, string> = {
  succeeded: "已完成",
  failed: "未完成",
  canceled: "已取消",
  running: "进行中",
};

/** How many weeks the density band shows. */
const BAND_WEEKS = 53;

function quoted(text: string | undefined) {
  return text ? `「${text}」` : "";
}

/** One event, in words. Codes a newer server adds read as what they are, not as a guess. */
export function timelineSentence(event: TimelineEvent): { label: string; text: string } {
  switch (event.type) {
    case "memory": {
      const kind = memoryKindLabel(event.kind ?? "");
      const by = event.by ? `（${CHANGED_BY[event.by] ?? "系统整理"}）` : "";
      switch (event.change) {
        case "created": return { label: `记下 · ${kind}`, text: `${quoted(event.after)}${event.basis ? ` · ${MEMORY_BASIS_LABELS[event.basis]}` : ""}` };
        case "updated": return { label: `改动 · ${kind}`, text: `${quoted(event.before)} → ${quoted(event.after)}${by}` };
        case "archived": return { label: `不再使用 · ${kind}`, text: `${quoted(event.before)}${by}` };
        case "restored": return { label: `恢复使用 · ${kind}`, text: `${quoted(event.after)}${by}` };
        case "confirmed": return { label: `你确认了 · ${kind}`, text: quoted(event.after) };
        case "superseded": return { label: `曾经如此 · ${kind}`, text: `${quoted(event.before)}${event.after ? ` → 现在是${quoted(event.after)}` : ""}` };
        default: return { label: `记忆变化 · ${kind}`, text: quoted(event.after) };
      }
    }
    case "run": {
      const used = [event.recalled ? `用了 ${event.recalled} 条记忆` : "", event.methods ? `${event.methods} 个方法` : ""].filter(Boolean).join("、");
      return { label: `任务 · ${RUN_STATUS[event.change] ?? "已结束"}`, text: `${event.title || "未命名任务"}${used ? `（${used}）` : ""}` };
    }
    case "method":
      switch (event.change) {
        case "learned": return { label: "学到方法", text: `${quoted(event.name)}，等评测` };
        case "approved": return { label: "方法生效", text: `${quoted(event.name)}，评测通过` };
        case "retired": return { label: "方法停用", text: `${quoted(event.name)}${event.reason ? `：${event.reason}` : ""}` };
        default: return { label: "方法变化", text: quoted(event.name) };
      }
    case "feedback":
      switch (event.change) {
        case "memory-deleted": return { label: "你删除了", text: `一条${memoryKindLabel(event.kind ?? "")}记忆` };
        case "memory-undone": return { label: "你撤销了", text: `一条${memoryKindLabel(event.kind ?? "")}记忆` };
        case "deliverable-adopted": return { label: "你采纳了", text: "一份交付物" };
        case "deliverable-edited": return { label: "你改过", text: "一份交付物" };
        default: return { label: "你的操作", text: "" };
      }
    default:
      return { label: "变化", text: "" };
  }
}

/** Days of the band, oldest first, ending today, in whole weeks. */
function bandDays(today: Date): string[] {
  const days: string[] = [];
  const format = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  for (let offset = BAND_WEEKS * 7 - 1; offset >= 0; offset -= 1) {
    days.push(format(new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset)));
  }
  return days;
}

function cellTone(total: number) {
  if (total === 0) return "bg-surface-2";
  if (total < 3) return "bg-accent-soft";
  return "bg-accent";
}

/**
 * 「时间轴」: how the capsule grew — memories written, changed and replaced
 * (the replaced ones marked 「曾经如此」, not gone), the tasks that used them,
 * the methods learned. A year's density on top; a month narrows the list.
 * No streaks, badges or rankings.
 */
export function CapsuleTimeline() {
  const [pages, setPages] = useState<MemoryTimelinePage[]>([]);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [month, setMonth] = useState<string | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const current = ++generation.current;
    try {
      const first = await fetchMemoryTimeline({ limit: 50 });
      if (current === generation.current) { setPages([first]); setFailed(false); }
    } catch {
      if (current === generation.current) setFailed(true);
    }
  }, []);
  useEffect(() => {
    const reads = generation;
    void load();
    const reload = () => void load();
    window.addEventListener(MEMORY_CHANGED_EVENT, reload);
    return () => { reads.current++; window.removeEventListener(MEMORY_CHANGED_EVENT, reload); };
  }, [load]);

  const more = async () => {
    const before = pages.at(-1)?.nextBefore;
    if (!before) return;
    setLoadingMore(true);
    try {
      const next = await fetchMemoryTimeline({ before, limit: 50 });
      setPages((current) => [...current, next]);
    } catch {
      setFailed(true);
    } finally {
      setLoadingMore(false);
    }
  };

  const events = useMemo(() => pages.flatMap((page) => page.items), [pages]);
  const density = useMemo(() => new Map((pages[0]?.density ?? []).map((bucket: TimelineDensity) => [bucket.day, bucket])), [pages]);
  const days = useMemo(() => bandDays(new Date()), []);
  const months = useMemo(() => {
    const totals = new Map<string, number>();
    for (const bucket of density.values()) {
      const key = bucket.day.slice(0, 7);
      totals.set(key, (totals.get(key) ?? 0) + bucket.memory + bucket.run + bucket.method + bucket.feedback);
    }
    return [...totals.entries()].sort((left, right) => right[0].localeCompare(left[0])).map(([key, total]) => ({ month: key, total }));
  }, [density]);
  const shown = month ? events.filter((event) => event.day.startsWith(month)) : events;
  const grouped = useMemo(() => {
    const groups: { day: string; items: TimelineEvent[] }[] = [];
    for (const event of shown) {
      const last = groups.at(-1);
      if (last?.day === event.day) last.items.push(event);
      else groups.push({ day: event.day, items: [event] });
    }
    return groups;
  }, [shown]);
  const missing = pages[0]?.missing ?? [];
  const hasMore = Boolean(pages.at(-1)?.nextBefore);

  return (
    <SectionShell
      intro="你的记忆胶囊是怎么长起来的：每条记忆何时记下、怎么改过、被什么取代，每次任务用到了什么，学到了哪些方法。都从已有记录中读出，不另外记账。"
      loading={pages.length === 0}
      failed={failed}
      onRetry={() => void load()}
    >
      {missing.length > 0 && (
        <p className="text-ui text-muted">部分来源这次没有读到：{missing.map((name) => ({ memory: "记忆", runs: "任务记录", methods: "方法", feedback: "你的操作" })[name] ?? name).join("、")}。</p>
      )}
      <section aria-label="一年来的变化">
        {/* A picture of the year, not a control: 371 cells of ten pixels are no
            target for a finger or a keyboard. The month list below filters. */}
        <div
          role="img"
          aria-label={`过去一年共有 ${[...density.values()].reduce((sum, bucket) => sum + bucket.memory + bucket.run + bucket.method + bucket.feedback, 0)} 件变化`}
          className="grid grid-flow-col grid-rows-7 gap-0.5 overflow-x-auto"
        >
          {days.map((value) => {
            const bucket = density.get(value);
            const total = bucket ? bucket.memory + bucket.run + bucket.method + bucket.feedback : 0;
            return <div key={value} title={`${value}：${total} 件`} className={cn("h-2.5 w-2.5", cellTone(total), month && value.startsWith(month) && "outline outline-1 outline-strong")} />;
          })}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-ui text-muted">
          <label htmlFor="timeline-month">只看</label>
          <select id="timeline-month" value={month ?? ""} onChange={(event) => setMonth(event.target.value || null)} className={inputClasses({ className: "w-auto" })}>
            <option value="">全部</option>
            {months.map((item) => <option key={item.month} value={item.month}>{item.month}（{item.total} 件）</option>)}
          </select>
        </div>
      </section>
      {grouped.length === 0 ? (
        <p className="text-ui text-muted">{month ? "这个月在已读到的记录里没有变化，往下加载更早的看看。" : "还没有任何变化。和 EviMed 做几次任务，这里就会有记录。"}</p>
      ) : (
        <ol className="space-y-5">
          {grouped.map((group) => (
            <li key={group.day}>
              <h3 className="text-caption font-medium text-muted tabular-nums">{group.day}</h3>
              <ul className="mt-2 divide-y divide-border rounded-card border border-border bg-surface">
                {group.items.map((event) => {
                  const said = timelineSentence(event);
                  return (
                    <li key={event.id} className="px-4 py-2.5">
                      <p className="text-ui text-text">
                        <span className={cn("mr-2", event.wasTrue ? "text-muted" : "text-text")}>{said.label}</span>
                        <span className={event.wasTrue ? "text-muted" : "text-text"}>{said.text}</span>
                      </p>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ol>
      )}
      {hasMore && (
        <div className="flex justify-center">
          <Button variant="ghost" loading={loadingMore} onClick={() => void more()}>加载更早的</Button>
        </div>
      )}
    </SectionShell>
  );
}
