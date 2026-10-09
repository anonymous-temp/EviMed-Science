import { rememberFrontierPosition, useFrontierOrigin } from "./frontierReadingState";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { CalendarDays, Copy } from "lucide-react";
import {
  fetchFrontierDaily,
  frontierErrorMessage,
  listFrontierDailies,
  type FrontierDaily,
  type FrontierDailySchedule,
  type FrontierDailySummary,
  type FrontierFollowedZone,
  type FrontierItem,
} from "@/lib/frontierClient";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { Button } from "@/components/ui/Button";
import { FilterChip } from "@/components/ui/FilterChips";
import { Menu } from "@/components/ui/Menu";
import { FrontierDetails, frontierDetailsOffered } from "./FrontierDetails";
import { FrontierSkeleton } from "./FrontierSkeleton";
import { EXTERNAL, INLINE_ACTION, dailyMeta, rankLabel, scheduleLabel, shortDate } from "./frontierText";

/** 往期 lists this many issues: two weeks, a menu that fits a laptop screen. */
const ARCHIVE_SHOWN = 14;

/** The daily's archive and the issue on screen, read together. */
export interface DailyState {
  publication?: import("@/lib/frontierClient").FrontierPublication | null;
  /** null: the daily does not exist on this server yet. */
  index: FrontierDailySummary[] | null;
  issue: FrontierDaily | null;
  loading: boolean;
  error: string | null;
  retry: () => void;
  /** The issue asked for (`?day=`); null for "the newest". Names the day an empty state is about. */
  day?: string | null;
  /** When the server publishes, from its own configuration; absent from a server that names none. */
  schedule?: FrontierDailySchedule | null;
}

/**
 * The archive, then the issue asked for (`?day=`) or the newest one. The
 * archive answering 404 is the whole daily not existing yet, and the view says
 * so instead of failing.
 */
export function useFrontierDaily(day: string | null, enabled: boolean): DailyState {
  const [index, setIndex] = useState<FrontierDailySummary[] | null>(null);
  const [schedule, setSchedule] = useState<FrontierDailySchedule | null>(null);
  const [issue, setIssue] = useState<FrontierDaily | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [publication, setPublication] = useState<DailyState["publication"]>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setLoading(true);
    setError(null);
    (async () => {
      const archive = await listFrontierDailies(30, day);
      const wanted = day ?? archive?.publication?.day ?? archive?.dailies[0]?.day ?? null;
      const found = wanted && archive !== null ? await fetchFrontierDaily(wanted) : null;
      return { archive, found };
    })().then(
      ({ archive, found }) => { if (active) { setIndex(archive?.dailies ?? null); setSchedule(archive?.schedule ?? null); setIssue(found); setPublication(archive?.publication); } },
      (caught: unknown) => { if (active) setError(frontierErrorMessage(caught)); },
    ).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [day, enabled, attempt]);
  return { index, issue, loading, error, retry: () => setAttempt((value) => value + 1), day, schedule, publication };
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

/** 「分类」: the lane's heading to the top of the page, under the issue's header; the address does not change. */
function goToLane(id: string) {
  document.getElementById(`daily-${id}`)?.scrollIntoView({ block: "start" });
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
 * how long they take to read, 「复制」, 「分类 ▾」 and 「往期 ▾」; the lead story; the
 * safety alerts first, in red; one section per lane that has anything; the AI
 * minute; 「前一日 / 后一日」. Every row is a fixed number column and then its
 * title, so all the titles of the issue start on one line — the source's name
 * is the grey line under the summary, never a block before the title.
 *
 * The header stays at the top of the page while the issue scrolls — an issue is
 * 20 items of about seven minutes, a week's 70 — so the date, 「分类」 (the lanes
 * with their counts, each one tap from its heading), 「往期」 and 「复制」 are
 * never a long scroll away. `laneLimit` shows that many rows of each lane and
 * 「展开其余 N 条」 for the rest: the weekly's way to be read in a few minutes.
 */
export function DailyIssue({ state, onDay, weekly = false, laneLimit }: { state: DailyState; onDay: (day: string) => void; weekly?: boolean; laneLimit?: number }) {
  const origin = useFrontierOrigin();
  const rangeLabel = (day: string) => {
    const last = new Date(`${day}T00:00:00Z`);
    last.setUTCDate(last.getUTCDate() + 6);
    return `${shortDate(day)}—${shortDate(last.toISOString().slice(0, 10))}`;
  };
  if (state.loading && !state.issue) return <FrontierSkeleton />;
  if (state.error) return <LoadError message={state.error} onRetry={state.retry} />;
  if (state.index === null) return <EmptyState icon={CalendarDays} title={weekly ? "暂无周报" : "暂无日报"} />;
  const archive = state.index.slice(0, ARCHIVE_SHOWN);
  const pastIssues = (current: string | null) => archive.length > 0 && (
    <Menu label="往期" items={archive.map((entry) => ({ label: weekly ? rangeLabel(entry.day) : shortDate(entry.day), checked: entry.day === current, onSelect: () => onDay(entry.day) }))}>
      <FilterChip menu>往期</FilterChip>
    </Menu>
  );
  if (!state.issue) {
    // Only a durable publication outcome distinguishes an empty day from a failed issue.
    // Past issues stay one tap away whenever there are any.
    const when = state.schedule ? scheduleLabel(state.schedule) : null;
    const asked = !weekly ? state.day ?? state.publication?.day ?? null : null;
    const outcome = !weekly ? state.publication?.state : null;
    return (
      <EmptyState
        icon={CalendarDays}
        title={outcome === "failed" ? "日报生成失败" : outcome === "empty" ? `${state.day ? shortDate(state.day) : "今日"}没有符合条件的内容` : outcome === "pending" ? (when ? `日报尚未发布，每天 ${when}发布` : "日报尚未发布") : weekly ? "暂无周报" : asked ? `${shortDate(asked)}没有日报` : when ? `今日日报 ${when}发布` : "今日日报尚未发布"}
        description={outcome === "failed" ? "暂未生成这一期日报，可以先阅读往期。" : outcome === "empty" ? `${asked ? shortDate(asked) : "这一天"}未出刊，可以阅读往期。` : weekly ? undefined : asked && when ? `日报每天 ${when}发布；当天没有符合条件的内容时不出刊。` : "当天没有符合条件的内容时不出刊。"}
        action={pastIssues(asked) || undefined}
      />
    );
  }
  const issue = state.issue;
  const { previous, next } = neighbours(issue, state.index);
  const leadText = issue.lead ? issue.lead.text ?? issue.lead.item.summary : null;
  const lanes = [
    ...(issue.safety.length > 0 ? [{ id: "safety-alerts", title: "安全警示", count: issue.safety.length }] : []),
    ...issue.sections.map((section) => ({ id: section.lane, title: section.laneLabel || "其他", count: section.items.length })),
  ];
  return (
    <article aria-labelledby="frontier-daily-title">
      <header className="sticky top-0 z-sticky flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-bg py-2">
        <h2 id="frontier-daily-title" className="text-body font-semibold leading-6 text-text">{weekly ? rangeLabel(issue.day) : shortDate(issue.day)}</h2>
        <span className="text-caption tabular-nums text-text-3">{dailyMeta(issue)}</span>
        <span className="ml-auto flex items-center gap-1">
          <Button variant="text" disabled={!issue.markdown} onClick={() => void copyMarkdown(issue.markdown)}>
            <Copy size={16} aria-hidden="true" />复制
          </Button>
          {lanes.length >= 3 && (
            <Menu label="分类" items={lanes.map((lane) => ({ label: `${lane.title} ${lane.count}`, onSelect: () => goToLane(lane.id) }))}>
              <FilterChip menu>分类</FilterChip>
            </Menu>
          )}
          {pastIssues(issue.day)}
        </span>
      </header>

      {issue.lead && (
        <section aria-label="头条" className="mt-5">
          {/* The title is the way to the original, as on the feed's card and on every row below (§12.3): one kind of 「原文」 entry on the page. */}
          <h3 className="max-w-measure-body text-title font-semibold text-text"><a href={issue.lead.item.url} {...EXTERNAL} className="hover:text-accent hover:underline">{issue.lead.item.title}</a></h3>
          <p className="mt-1 text-caption text-text-3">{issue.lead.item.source.name}</p>
          {(leadText || issue.lead.event) && (
            <p className="mt-2 max-w-measure text-ui text-text-2">
              {leadText}
              {issue.lead.event && (
                <Link state={origin} onClick={rememberFrontierPosition} to={`/app/frontier/events/${encodeURIComponent(issue.lead.event.id)}`} className={cn(INLINE_ACTION, "ml-1 px-1 align-middle text-accent")}>
                  事件页 ›
                </Link>
              )}
            </p>
          )}
        </section>
      )}

      {issue.safety.length > 0 && <DailySection key={`${issue.day}-safety-alerts`} id="safety-alerts" title="安全警示" items={issue.safety} safety limit={laneLimit} />}
      {issue.sections.map((section) => <DailySection key={`${issue.day}-${section.lane}`} id={section.lane} title={section.laneLabel || "其他"} items={section.items} limit={laneLimit} />)}

      {issue.followedZones && issue.followedZones.length > 0 && <FollowedZones zones={issue.followedZones} />}

      {issue.aiMinute && (
        <section aria-labelledby="daily-ai-minute" className="mt-8">
          <h3 id="daily-ai-minute" className="text-ui font-semibold text-text">AI 一分钟</h3>
          <p className="mt-1 max-w-measure text-ui text-text-2">{issue.aiMinute}</p>
        </section>
      )}

      {(previous || next) && (
        <nav aria-label={weekly ? "周报翻页" : "日报翻页"} className="mt-8 flex items-center justify-between">
          {previous ? <Button variant="text" onClick={() => onDay(previous)}>{weekly ? "‹ 前一期" : "‹ 前一日"}</Button> : <span />}
          {next ? <Button variant="text" onClick={() => onDay(next)}>{weekly ? "后一期 ›" : "后一日 ›"}</Button> : <span />}
        </nav>
      )}
    </article>
  );
}

/**
 * 「你关注的专区」: this reader's own followed zones, with the cards that are new or changed in the issue's window.
 * It is the reader's alone — the issue above it reads the same to everyone — so it is a section of its own, not a lane.
 */
function FollowedZones({ zones }: { zones: FrontierFollowedZone[] }) {
  return (
    <section aria-labelledby="daily-followed-zones" className="mt-8">
      <h3 id="daily-followed-zones" className="text-ui font-semibold text-text">你关注的专区</h3>
      {zones.map((zone) => (
        <div key={zone.zoneId} className="mt-2">
          <Link to={`/app/frontier/zones/${encodeURIComponent(zone.zoneId)}`} className={cn(INLINE_ACTION, "-ml-1 px-1 text-text-3 hover:text-accent")}>
            <span className="text-caption">{zone.zoneTitle}</span>
          </Link>
          <ul aria-label={zone.zoneTitle}>
            {zone.cards.map((card) => (
              <li key={card.id} className="flex gap-2 border-b border-border py-3">
                <span className="w-8 shrink-0 text-caption leading-6 text-text-3">{card.change === "new" ? "新" : "更新"}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-body font-semibold leading-6 text-text">
                    <Link to={`/app/frontier/zones/${encodeURIComponent(zone.zoneId)}/evidence/${encodeURIComponent(card.id)}`} className="hover:text-accent hover:underline">{card.title}</Link>
                  </p>
                  {card.summary && <p className="mt-1 line-clamp-2 max-w-measure text-ui text-text-2">{card.summary}</p>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

/**
 * One lane of the issue, or its safety alerts: a heading and its count, then numbered rows — all of
 * them, or the first `limit` and 「展开其余 N 条」, which opens the rest where it stands.
 */
function DailySection({ id, title, items, safety = false, limit }: { id: string; title: string; items: FrontierItem[]; safety?: boolean; limit?: number }) {
  const [all, setAll] = useState(false);
  const shown = limit !== undefined && !all ? items.slice(0, limit) : items;
  const rest = items.length - shown.length;
  return (
    <section aria-labelledby={`daily-${id}`} className="mt-8">
      <h3 id={`daily-${id}`} className="flex scroll-mt-24 items-baseline gap-2">
        <span className={cn("text-ui font-semibold", safety ? "text-danger-strong" : "text-text")}>{title}</span>
        <span className="text-caption tabular-nums text-text-3">{items.length}</span>
      </h3>
      <ol aria-label={title} className="mt-1">
        {shown.map((item, index) => <DailyRow key={item.id} item={item} number={index + 1} safety={safety} />)}
      </ol>
      {rest > 0 && <Button variant="text" size="sm" className="-ml-2 mt-1" onClick={() => setAll(true)}>展开其余 {rest} 条</Button>}
    </section>
  );
}

/**
 * A row: 「01」, the title — the way to the original, as on the feed's card — the summary in at
 * most three lines (a safety notice has its title and no more), and a grey line naming the
 * institution — FDA, 英国 MHRA, never the interface it was read through — with 「详情」 where the
 * drawer holds more than the row does.
 */
function DailyRow({ item, number, safety }: { item: FrontierItem; number: number; safety: boolean }) {
  const [details, setDetails] = useState(false);
  return (
    <li className="flex gap-2 border-b border-border py-3">
      <span className="w-8 shrink-0 text-caption leading-6 tabular-nums text-text-3">{rankLabel(number)}</span>
      <div className="min-w-0 flex-1">
        <p data-row-title className="text-body font-semibold leading-6 text-text"><a href={item.url} {...EXTERNAL} className="hover:text-accent hover:underline">{item.title}</a></p>
        {!safety && item.summary && <p className="mt-1 line-clamp-3 max-w-measure text-ui text-text-2">{item.summary}</p>}
        <div className="mt-1 flex items-center gap-1.5 text-caption text-text-3">
          <span className="min-w-0 truncate">{item.source.name}</span>
          {/* The feed card's own look for this action: a sized button here was the page's tenth kind of control. */}
          {frontierDetailsOffered(item) && <button type="button" onClick={() => setDetails(true)} className={cn(INLINE_ACTION, "px-1 text-accent")}><span className="text-caption">详情</span></button>}
        </div>
      </div>
      {details && <FrontierDetails item={item} onClose={() => setDetails(false)} />}
    </li>
  );
}
