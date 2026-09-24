import { useEffect, useState } from "react";
import { Link } from "react-router";
import { CalendarDays, Copy } from "lucide-react";
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
import { LoadError } from "@/components/cards/LoadError";
import { Button } from "@/components/ui/Button";
import { FilterChip } from "@/components/ui/FilterChips";
import { Menu } from "@/components/ui/Menu";
import { FrontierSkeleton } from "./FrontierSkeleton";
import { EXTERNAL, INLINE_ACTION, dailyMeta, rankLabel, shortDate } from "./frontierText";

/** 往期 lists this many issues: two weeks, a menu that fits a laptop screen. */
const ARCHIVE_SHOWN = 14;

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
 * so instead of failing.
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

/**
 * The issues on either side of this one: the server's, or — from a server
 * that does not name them — the archive's neighbours. A quiet day has no
 * issue, so these are the nearest issues, not the calendar's days.
 */
function neighbours(issue: FrontierDaily, index: readonly FrontierDailySummary[]): { previous: string | null; next: string | null } {
  const at = index.findIndex((entry) => entry.day === issue.day);
  return {
    previous: issue.previousDay ?? (at >= 0 ? index[at + 1]?.day ?? null : null),
    next: issue.nextDay ?? (at > 0 ? index[at - 1]?.day ?? null : null),
  };
}

/** 「复制」: the issue exactly as the server composed it, for a department chat. */
async function copyMarkdown(markdown: string) {
  try {
    await navigator.clipboard.writeText(markdown);
    toast.success("已复制");
  } catch {
    toast.error("没有复制成功");
  }
}

/**
 * 日报 (plan 2026-09-23 §6.2; research B §8 #28): the day, how many items and
 * how long they take to read, 「复制」 and 「往期 ▾」; the lead story; the
 * safety alerts first, in red; one section per lane that has anything; the AI
 * minute; 「前一日 / 后一日」. Every row is a fixed number column and then its
 * title, so all the titles of the issue start on one line — the source's name
 * is the grey line under the summary, never a block before the title.
 */
export function DailyIssue({ state, onDay }: { state: DailyState; onDay: (day: string) => void }) {
  if (state.loading && !state.issue) return <FrontierSkeleton />;
  if (state.error) return <LoadError message={state.error} onRetry={state.retry} />;
  if (state.index === null) return <EmptyState icon={CalendarDays} title="暂无日报" />;
  if (!state.issue) return <EmptyState icon={CalendarDays} title="今日日报 07:30 发布" />;
  const issue = state.issue;
  const { previous, next } = neighbours(issue, state.index);
  const archive = state.index.slice(0, ARCHIVE_SHOWN);
  const leadText = issue.lead ? issue.lead.text ?? issue.lead.item.summary : null;
  return (
    <article aria-labelledby="frontier-daily-title">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h2 id="frontier-daily-title" className="text-body font-semibold leading-6 text-text">{shortDate(issue.day)}</h2>
        <span className="text-caption tabular-nums text-text-3">{dailyMeta(issue)}</span>
        <span className="ml-auto flex items-center gap-1">
          <Button variant="text" disabled={!issue.markdown} onClick={() => void copyMarkdown(issue.markdown)}>
            <Copy size={16} aria-hidden="true" />复制
          </Button>
          {archive.length > 0 && (
            <Menu label="往期" items={archive.map((entry) => ({ label: shortDate(entry.day), checked: entry.day === issue.day, onSelect: () => onDay(entry.day) }))}>
              <FilterChip menu>往期</FilterChip>
            </Menu>
          )}
        </span>
      </header>

      {issue.lead && (
        <section aria-label="头条" className="mt-5">
          <h3 className="max-w-measure-body text-title font-semibold text-text">{issue.lead.item.title}</h3>
          {(leadText || issue.lead.event) && (
            <p className="mt-2 max-w-measure text-ui text-text-2">
              {leadText}
              {issue.lead.event && (
                <Link to={`/app/frontier/events/${encodeURIComponent(issue.lead.event.id)}`} className={cn(INLINE_ACTION, "ml-1 px-1 align-middle text-accent")}>
                  事件页 ›
                </Link>
              )}
            </p>
          )}
        </section>
      )}

      {issue.safety.length > 0 && <DailySection id="safety" title="安全警示" items={issue.safety} safety />}
      {issue.sections.map((section) => <DailySection key={section.lane} id={section.lane} title={section.laneLabel || "其他"} items={section.items} />)}

      {issue.aiMinute && (
        <section aria-labelledby="daily-ai-minute" className="mt-8">
          <h3 id="daily-ai-minute" className="text-ui font-semibold text-text">AI 一分钟</h3>
          <p className="mt-1 max-w-measure text-ui text-text-2">{issue.aiMinute}</p>
        </section>
      )}

      {(previous || next) && (
        <nav aria-label="日报翻页" className="mt-8 flex items-center justify-between">
          {previous ? <Button variant="text" onClick={() => onDay(previous)}>‹ 前一日</Button> : <span />}
          {next ? <Button variant="text" onClick={() => onDay(next)}>后一日 ›</Button> : <span />}
        </nav>
      )}
    </article>
  );
}

/** One lane of the issue, or its safety alerts: a heading and its count, then numbered rows. */
function DailySection({ id, title, items, safety = false }: { id: string; title: string; items: FrontierItem[]; safety?: boolean }) {
  return (
    <section aria-labelledby={`daily-${id}`} className="mt-8">
      <h3 id={`daily-${id}`} className="flex items-baseline gap-2">
        <span className={cn("text-ui font-semibold", safety ? "text-danger-strong" : "text-text")}>{title}</span>
        <span className="text-caption tabular-nums text-text-3">{items.length}</span>
      </h3>
      <ol aria-label={title} className="mt-1">
        {items.map((item, index) => <DailyRow key={item.id} item={item} number={index + 1} safety={safety} />)}
      </ol>
    </section>
  );
}

/**
 * A row: 「01」, the title, the summary in at most three lines (a safety notice has its title
 * and no more), and a grey line naming the institution — FDA, 英国 MHRA, never
 * the interface it was read through — with 「原文 ↗」.
 */
function DailyRow({ item, number, safety }: { item: FrontierItem; number: number; safety: boolean }) {
  return (
    <li className="flex gap-2 border-b border-border py-3">
      <span className="w-8 shrink-0 text-caption leading-6 tabular-nums text-text-3">{rankLabel(number)}</span>
      <div className="min-w-0 flex-1">
        <p data-row-title className="text-body font-semibold leading-6 text-text">{item.title}</p>
        {!safety && item.summary && <p className="mt-1 line-clamp-3 max-w-measure text-ui text-text-2">{item.summary}</p>}
        <div className="mt-1 flex items-center gap-1.5 text-caption text-text-3">
          <span className="min-w-0 truncate">{item.source.name}</span>
          <span aria-hidden="true">·</span>
          <a href={item.url} {...EXTERNAL} className={cn(INLINE_ACTION, "-ml-1 px-1 text-accent")}>
            <span className="text-caption">原文<span aria-hidden="true"> ↗</span></span>
          </a>
        </div>
      </div>
    </li>
  );
}
