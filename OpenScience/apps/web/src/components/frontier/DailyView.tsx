import { useEffect, useState } from "react";
import { Link } from "react-router";
import { CalendarDays, Copy, RefreshCw, ShieldAlert } from "lucide-react";
import {
  fetchFrontierDaily,
  frontierErrorMessage,
  listFrontierDailies,
  type FrontierDaily,
  type FrontierDailySummary,
  type FrontierItem,
} from "@/lib/frontierClient";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { EmptyState } from "@/components/cards/EmptyState";
import { FrontierSkeleton } from "@/components/cards/Skeletons";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { FrontierChip } from "./FrontierChip";
import { clockOrDate, longDate, shortDate, sourceTypeTone } from "./frontierText";

/** The daily's archive and the issue on screen, read together. */
export interface DailyState {
  /** null: the daily does not exist on this server yet. */
  index: FrontierDailySummary[] | null;
  issue: FrontierDaily | null;
  loading: boolean;
  error: string | null;
  retry: () => void;
}

/**
 * The archive, then the issue asked for (`?day=`) or the newest one. The
 * archive answering 404 is the whole daily not existing yet, and the view says
 * 「还在准备」 instead of failing.
 */
export function useFrontierDaily(day: string | null, enabled: boolean): DailyState {
  const [index, setIndex] = useState<FrontierDailySummary[] | null>(null);
  const [issue, setIssue] = useState<FrontierDaily | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setLoading(true);
    setError(null);
    (async () => {
      const dailies = await listFrontierDailies(30);
      const wanted = day ?? dailies?.[0]?.day ?? null;
      const found = wanted && dailies !== null ? await fetchFrontierDaily(wanted) : null;
      return { dailies, found };
    })().then(
      ({ dailies, found }) => { if (active) { setIndex(dailies); setIssue(found); } },
      (caught: unknown) => { if (active) setError(frontierErrorMessage(caught)); },
    ).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [day, enabled, attempt]);
  return { index, issue, loading, error, retry: () => setAttempt((value) => value + 1) };
}

/** 「复制为 Markdown」: the issue exactly as the server composed it, for a department chat. */
async function copyMarkdown(markdown: string) {
  try {
    await navigator.clipboard.writeText(markdown);
    toast.success("已复制为 Markdown，可以直接粘贴到科室群或周会材料里。");
  } catch {
    toast.error("没有复制成功，请稍后再试。");
  }
}

/**
 * 日报 (plan §4.5): 07:00-to-07:00, finalised at 07:30, only items with a
 * verified summary; a lead, safety, one section per lane that has anything,
 * and 「AI 一分钟」. A quiet day has fewer sections, never padding.
 */
export function DailyIssue({ state }: { state: DailyState }) {
  if (state.loading && !state.issue) return <FrontierSkeleton />;
  if (state.error) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 rounded-card border border-danger bg-danger-soft px-4 py-3 text-ui text-danger-strong">
        <span className="min-w-0 flex-1">{state.error}</span>
        <Button size="sm" variant="ghost" onClick={state.retry}><RefreshCw size={16} aria-hidden="true" />重试</Button>
      </div>
    );
  }
  if (state.index === null) {
    return <EmptyState icon={CalendarDays} title="日报还在准备" className="rounded-card border border-dashed border-border"
      description="每天 07:30 定稿，覆盖前一天 07:00 到当天 07:00，只收已经写好导读的条目。" />;
  }
  if (!state.issue) {
    return <EmptyState icon={CalendarDays} title="第一期日报还没有出" className="rounded-card border border-dashed border-border"
      description="每天 07:30 定稿；在那之前，「精选」里就是今天读到的。" />;
  }
  const issue = state.issue;
  const covers = issue.windowStart && issue.windowEnd
    ? `覆盖 ${clockOrDate(issue.windowStart)} 至 ${clockOrDate(issue.windowEnd)}` : null;
  return (
    <article aria-labelledby="frontier-daily-title" className="space-y-6 rounded-card border border-border bg-surface p-4">
      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="min-w-0 flex-1 text-caption text-muted">
            EviMed 医学前沿日报 · {longDate(issue.day)}
            {issue.generatedAt && <> · {clockOrDate(issue.generatedAt)} 生成</>}
            {covers && <> · {covers}</>}
          </p>
          <Button size="sm" variant="ghost" disabled={!issue.markdown} onClick={() => void copyMarkdown(issue.markdown)}>
            <Copy size={16} aria-hidden="true" />复制为 Markdown
          </Button>
        </div>
        <h2 id="frontier-daily-title" className="text-title font-semibold text-text">
          {issue.lead ? `头条：${issue.lead.item.title}` : `${shortDate(issue.day)}的日报`}
        </h2>
        {issue.lead && (issue.lead.text || issue.lead.item.summary) && (
          <p className="text-ui text-text-2">
            {issue.lead.text ?? issue.lead.item.summary}
            {issue.lead.event && <> <Link to={`/app/frontier/events/${encodeURIComponent(issue.lead.event.id)}`} className="text-link hover:underline">事件页 →</Link></>}
          </p>
        )}
      </header>

      {issue.safety.length > 0 && (
        <section aria-label="安全警示" className="rounded-card border border-danger bg-danger-soft px-4 py-3">
          <h3 className="flex items-center gap-1.5 text-ui font-semibold text-danger-strong"><ShieldAlert size={16} aria-hidden="true" />安全警示 {issue.safety.length} 条</h3>
          <ul className="mt-1 space-y-1">
            {issue.safety.map((item) => (
              <li key={item.id} className="text-ui text-text">
                <a href={item.url} target="_blank" rel="noopener noreferrer" className="hover:underline">{item.title}</a>
                <span className="text-caption text-muted">（{item.source.name}）</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {issue.sections.map((section) => (
        <section key={section.lane} aria-labelledby={`daily-${section.lane}`}>
          <h3 id={`daily-${section.lane}`} className="border-b border-border pb-1.5 text-ui font-semibold text-text">
            {section.laneLabel || "其他"} · {section.items.length} 条
          </h3>
          <ul className="divide-y divide-faint">
            {section.items.map((item) => <DailyRow key={item.id} item={item} />)}
          </ul>
        </section>
      ))}

      {issue.aiMinute && (
        <section aria-labelledby="daily-ai-minute">
          <h3 id="daily-ai-minute" className="text-ui font-semibold text-text">AI 一分钟</h3>
          <p className="mt-1 text-ui text-text-2">{issue.aiMinute}</p>
        </section>
      )}
    </article>
  );
}

function DailyRow({ item }: { item: FrontierItem }) {
  return (
    <li className="flex gap-3 py-2">
      <FrontierChip tone={sourceTypeTone(item.sourceType)} className="mt-0.5">{item.source.name}</FrontierChip>
      <div className="min-w-0">
        <p className="text-ui font-medium text-text">{item.title}</p>
        <p className="text-caption text-muted">
          {item.summary && <>{item.summary} · </>}
          <a href={item.url} target="_blank" rel="noopener noreferrer" className="text-link hover:underline">原文<span aria-hidden="true"> ↗</span></a>
        </p>
      </div>
    </li>
  );
}

/** 往期, in the rail: each issue by its day, its lead and how many items it held. */
export function DailyArchive({ index, current, onOpen }: { index: FrontierDailySummary[]; current: string | null; onOpen: (day: string) => void }) {
  if (index.length === 0) return null;
  return (
    <Card title="往期" padding="p-3">
      <ul className="divide-y divide-faint">
        {index.slice(0, 14).map((entry) => (
          <li key={entry.day} className="py-1.5 first:pt-0">
            <button type="button" onClick={() => onOpen(entry.day)} aria-current={entry.day === current ? "true" : undefined}
              className={cn("w-full text-left text-ui hover:underline", entry.day === current ? "font-medium text-text" : "text-text-2")}>
              {entry.title ?? `${shortDate(entry.day)}的日报`}
            </button>
            <p className="text-caption text-muted">{shortDate(entry.day)} · {entry.itemCount} 条</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}
