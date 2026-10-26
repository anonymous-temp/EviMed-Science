import { rememberFrontierPosition, useFrontierOrigin } from "./frontierReadingState";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { CalendarDays, ChevronDown, Copy } from "lucide-react";
import {
  fetchFrontierDaily,
  frontierErrorMessage,
  listFrontierDailies,
  type FrontierDaily,
  type FrontierDailySchedule,
  type FrontierDailySummary,
  type FrontierFollowedQuery,
  type FrontierFollowedZone,
  type FrontierItem,
} from "@/lib/frontierClient";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Menu } from "@/components/ui/Menu";
import { navItemClasses } from "@/components/ui/NavItem";
import type { ToolbarFilter } from "@/components/ui/Toolbar";
import { useNarrow } from "@/lib/useMediaQuery";
import { FrontierSkeleton } from "./FrontierSkeleton";
import { INLINE_ACTION, dailyMeta, rankLabel, scheduleLabel, shortDate } from "./frontierText";
import { archiveEntryName, archiveMonths, dayInMonth, issuedStamp, monthKey, sectionsBelow, topThings, type TopThing } from "./frontierRecord";

/** 往期 in a menu (the weekly's, an empty day's, a phone's without months) lists this many issues: two weeks, a menu that fits a laptop screen. */
const ARCHIVE_SHOWN = 14;
/** The archive is read this many issues at a time (the server's most): two months, and 「更早的日报」 reads the next page. */
const ARCHIVE_PAGE = 60;

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
  /** The month a phone's 往期 lists (`null`: the open issue's), for the 「月份」 choice that narrows it. Absent: no months are offered. */
  browse?: { month: string | null; setMonth: (month: string | null) => void };
  /** Older issues than the archive holds so far, when there may be some: the column's 「更早的日报」. */
  more?: { loading: boolean; load: () => void } | null;
}

/** The archive's issues of two reads, newest first, each day once. */
function mergeArchive(held: FrontierDailySummary[] | null, read: readonly FrontierDailySummary[]): FrontierDailySummary[] {
  const byDay = new Map((held ?? []).map((entry) => [entry.day, entry]));
  for (const entry of read) byDay.set(entry.day, entry);
  return [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day));
}

/**
 * The archive, then the issue asked for (`?day=`) or the newest one. The
 * archive answering 404 is the whole daily not existing yet, and the view says
 * so instead of failing.
 *
 * The archive is read sixty issues at a time and kept while the reader moves from issue to issue (a read of the first page again
 * adds to what is held and takes nothing away), so the months a reader opened with 「更早的日报」 stay open on the issue they chose.
 */
export function useFrontierDaily(day: string | null, enabled: boolean): DailyState {
  const [index, setIndex] = useState<FrontierDailySummary[] | null>(null);
  const [schedule, setSchedule] = useState<FrontierDailySchedule | null>(null);
  const [issue, setIssue] = useState<FrontierDaily | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [publication, setPublication] = useState<DailyState["publication"]>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [older, setOlder] = useState<"maybe" | "none" | "loading">("none");
  const [browseMonth, setBrowseMonth] = useState<string | null>(null);
  const paged = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setLoading(true);
    setError(null);
    setBrowseMonth(null);
    (async () => {
      const archive = await listFrontierDailies(ARCHIVE_PAGE, day);
      const wanted = day ?? archive?.publication?.day ?? archive?.dailies[0]?.day ?? null;
      const found = wanted && archive !== null ? await fetchFrontierDaily(wanted) : null;
      return { archive, found };
    })().then(
      ({ archive, found }) => {
        if (!active) return;
        setIndex((held) => (archive ? mergeArchive(held, archive.dailies) : null));
        // Whether there may be older issues is known from the first page only; a page read again must not forget a page after it.
        if (!paged.current) setOlder(archive && archive.dailies.length >= ARCHIVE_PAGE ? "maybe" : "none");
        setSchedule(archive?.schedule ?? null);
        setIssue(found);
        setPublication(archive?.publication);
      },
      (caught: unknown) => { if (active) setError(frontierErrorMessage(caught)); },
    ).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [day, enabled, attempt]);
  const loadOlder = () => {
    const last = index?.at(-1)?.day;
    if (!last || older !== "maybe") return;
    setOlder("loading");
    paged.current = true;
    listFrontierDailies(ARCHIVE_PAGE, null, last).then(
      (page) => {
        setIndex((held) => mergeArchive(held, page?.dailies ?? []));
        setOlder(page && page.dailies.length >= ARCHIVE_PAGE ? "maybe" : "none");
      },
      (caught: unknown) => { setOlder("maybe"); toast.error(frontierErrorMessage(caught)); },
    );
  };
  return {
    index, issue, loading, error, retry: () => setAttempt((value) => value + 1), day, schedule, publication,
    browse: { month: browseMonth, setMonth: setBrowseMonth },
    more: older === "none" ? null : { loading: older === "loading", load: loadOlder },
  };
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
 * What an issue draws: its three things (a day's with enough to show; a week has none) and the lanes under them, which skip the items
 * already shown above — the lead is in no lane, and a lane that had nothing else is not drawn.
 */
function issueParts(issue: FrontierDaily, weekly: boolean) {
  const things = weekly ? null : topThings(issue);
  return { things, sections: sectionsBelow(issue, things) };
}

/** The lanes an issue draws, safety first, each with its count: what 「分类」 lists. */
function issueLanes(issue: FrontierDaily, weekly: boolean) {
  return [
    ...(issue.safety.length > 0 ? [{ id: "safety-alerts", title: "安全警示", count: issue.safety.length }] : []),
    ...issueParts(issue, weekly).sections.map((section) => ({ id: section.lane, title: section.laneLabel || "其他", count: section.items.length })),
  ];
}

/** A week's range, 「9月21日—9月27日」, from the day it starts. */
function weekRange(day: string): string {
  const last = new Date(`${day}T00:00:00Z`);
  last.setUTCDate(last.getUTCDate() + 6);
  return `${shortDate(day)}—${shortDate(last.toISOString().slice(0, 10))}`;
}

/**
 * Whether the daily's archive stands beside the issue, as a column of months: a daily (the weekly keeps its menu), on a screen with
 * the room, with more than the one issue to go to. Then the toolbar has no 往期 of its own — it would be the same list twice.
 */
export function archiveBeside(index: readonly FrontierDailySummary[] | null, { weekly, narrow }: { weekly: boolean; narrow: boolean }): boolean {
  return !weekly && !narrow && index !== null && index.length > 1;
}

/** The value of the 「月份」 choice that reads the next page of the archive. */
const OLDER_MONTHS = "older";

/**
 * The controls of the issue on screen, for the page's toolbar (R19, audit D C1c): 「分类」 (the lanes with their counts, each one tap
 * from its heading), 「往期」 (the issues before) and 「复制」. They were a second group of controls in the issue's own header, beside
 * the page's 日报 / 周报 chips; there is one row of controls now, and it stays at the top while the issue scrolls — which is what the
 * sticky header was for. A day with no issue has none of them (its past issues are the empty state's own button).
 *
 * 往期 is the toolbar's only where the archive is not beside the issue (`beside`, the column of `DailyIssue`): the weekly's, and a
 * daily's on a phone, where it is cut into months — 「月份」 first, and 往期 lists that month's issues — so two months of issues are not
 * one list of sixty.
 */
export function dailyControls(state: DailyState, { weekly = false, onDay, beside = false }: { weekly?: boolean; onDay: (day: string) => void; beside?: boolean }): { filters: ToolbarFilter[]; actions: ReactNode } {
  const issue = state.issue;
  if (!issue || state.error || state.index === null) return { filters: [], actions: null };
  const lanes = issueLanes(issue, weekly);
  const months = weekly ? [] : archiveMonths(state.index);
  const browse = state.browse;
  const column = beside && !weekly;
  const split = !column && months.length > 1 && browse !== undefined;
  // The month a phone's 往期 lists: the one chosen, else the open issue's.
  const month = split ? months.find((entry) => entry.key === (browse.month ?? monthKey(issue.day))) ?? months[0] : null;
  const archive = month ? month.entries : state.index.slice(0, ARCHIVE_SHOWN);
  const past = column || archive.length === 0 ? [] : [{ kind: "select" as const, label: "往期", options: archive.map((entry) => ({ value: entry.day, label: weekly ? weekRange(entry.day) : shortDate(entry.day) })), value: null, onChange: (day: string | null) => { if (day) onDay(day); } }];
  return {
    filters: [
      ...(lanes.length >= 3 ? [{ kind: "select" as const, label: "分类", options: lanes.map((lane) => ({ value: lane.id, label: `${lane.title} ${lane.count}` })), value: null, onChange: (id: string | null) => { if (id) goToLane(id); } }] : []),
      ...(split ? [{
        kind: "select" as const, label: "月份",
        // The page of the archive ends inside a month more often than at its edge: while older issues remain unread, the oldest month
        // held is not whole, and a count of it would be a wrong one — it is named without.
        options: [...months.map((entry, at) => ({ value: entry.key, label: state.more && at === months.length - 1 ? entry.label : `${entry.label} · ${entry.entries.length} 期` })), ...(state.more ? [{ value: OLDER_MONTHS, label: "更早的日报" }] : [])],
        value: null,
        onChange: (key: string | null) => { if (key === OLDER_MONTHS) state.more?.load(); else if (key) browse.setMonth(key); },
      }] : []),
      ...past,
    ],
    actions: (
      <Button variant="text" size="sm" disabled={!issue.markdown} onClick={() => void copyMarkdown(issue.markdown)}>
        <Copy size={16} aria-hidden="true" />复制
      </Button>
    ),
  };
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
export interface DigestExpansion { ids: string[]; onExpand: (id: string) => void }

export function DailyIssue({ state, onDay, weekly = false, laneLimit, expansion }: { state: DailyState; onDay: (day: string) => void; weekly?: boolean; laneLimit?: number; expansion?: DigestExpansion }) {
  const narrow = useNarrow();
  if (state.loading && !state.issue) return <FrontierSkeleton />;
  if (state.error) return <LoadError message={state.error} onRetry={state.retry} />;
  // Nothing to read here is not a dead end: the page's own feed is a link away (DESIGN.md rule 8).
  const toFeed = <Link to="/app/frontier" className={buttonClasses({ variant: "secondary" })}>看精选动态</Link>;
  if (state.index === null) return <EmptyState icon={CalendarDays} title={weekly ? "暂无周报" : "暂无日报"} action={toFeed} />;
  const archive = state.index.slice(0, ARCHIVE_SHOWN);
  const pastIssues = (current: string | null) => archive.length > 0 && (
    <Menu label="往期" items={archive.map((entry) => ({ label: weekly ? weekRange(entry.day) : shortDate(entry.day), checked: entry.day === current, onSelect: () => onDay(entry.day) }))}>
      <Button variant="secondary">往期<ChevronDown size={16} aria-hidden="true" /></Button>
    </Menu>
  );
  if (!state.issue) {
    // Only a durable publication outcome distinguishes an empty day from a failed issue. One sentence says which, once, and past
    // issues stay one tap away whenever there are any (R19, audit D C3: it was the same fact twice, and 「周三日报」 joined).
    const when = state.schedule ? scheduleLabel(state.schedule) : null;
    const asked = !weekly ? state.day ?? state.publication?.day ?? null : null;
    const outcome = !weekly ? state.publication?.state : null;
    const dateLabel = asked ? shortDate(asked) : "今日";
    return (
      <EmptyState
        icon={CalendarDays}
        title={outcome === "failed" ? `${dateLabel}的日报生成失败。`
          : outcome === "empty" ? `${dateLabel}没有符合条件的内容，没有出刊。`
            : outcome === "pending" ? `${dateLabel}的日报尚未发布${when ? `，每天 ${when}发布` : ""}。`
              : weekly ? "暂无周报"
                : asked ? `${dateLabel}没有日报：当天没有符合条件的内容时不出刊。`
                  : when ? `今日日报 ${when}发布` : "今日日报尚未发布"}
        action={pastIssues(asked) || toFeed}
      />
    );
  }
  const issue = state.issue;
  const issued = issuedStamp(issue.generatedAt, issue.day);
  const body = (
    <article aria-labelledby="frontier-daily-title">
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-border pb-2">
        <h2 id="frontier-daily-title" className="text-body font-semibold leading-6 text-text">{weekly ? weekRange(issue.day) : shortDate(issue.day)}</h2>
        <span className="text-caption tabular-nums text-text-3">{[dailyMeta(issue), issued].filter(Boolean).join(" · ")}</span>
      </header>

      <IssueBody issue={issue} state={state} weekly={weekly} laneLimit={laneLimit} expansion={expansion} onDay={onDay} />
    </article>
  );
  return archiveBeside(state.index, { weekly, narrow })
    ? (
      <div className="grid grid-cols-[12rem_minmax(0,1fr)] gap-8">
        <DailyArchive index={state.index} current={issue.day} onDay={onDay} more={state.more ?? null} />
        {body}
      </div>
    ) : body;
}

/** What follows an issue's header: its three things (or its lead), the safety alerts, the lanes, the reader's own follows, the AI minute and the way to the issues beside it. */
function IssueBody({ issue, state, weekly, laneLimit, expansion, onDay }: { issue: FrontierDaily; state: DailyState; weekly: boolean; laneLimit?: number; expansion?: DigestExpansion; onDay: (day: string) => void }) {
  const origin = useFrontierOrigin();
  const { previous, next } = neighbours(issue, state.index ?? []);
  const leadText = issue.lead ? issue.lead.text ?? issue.lead.item.summary : null;
  // 先看三件事: the issue's lead and the two items its lanes score highest, each as a title and its 导读; the lanes below skip them. A week keeps
  // its headline and its lanes, and a day with fewer than three to show keeps its lead as it was.
  const { things, sections } = issueParts(issue, weekly);
  return (
    <>
      {things && <TopThings things={things} />}

      {!things && issue.lead && (
        <section aria-label="头条" className="mt-5">
          {/* Feed and digest headlines share the same addressed reader. */}
          <h3 className="max-w-measure-body text-title font-semibold text-text"><ArticleLink item={issue.lead.item}>{issue.lead.item.title}</ArticleLink></h3>
          <p className="mt-1 text-caption text-text-3">{issue.lead.item.source.name}</p>
          {(leadText || issue.lead.event) && (
            // The issue's own text (`data-prose`), as a row's summary is: content of the issue, not a sentence of the page's.
            <p data-prose="" className="mt-2 max-w-measure text-ui text-text-2">
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

      {issue.safety.length > 0 && <DailySection key={`${issue.day}-safety-alerts`} expansion={expansion} expansionId={`digest:${weekly ? "week" : "day"}:${issue.day}:safety-alerts`} id="safety-alerts" title="安全警示" items={issue.safety} safety limit={laneLimit} />}
      {sections.map((section) => <DailySection key={`${issue.day}-${section.lane}`} expansion={expansion} expansionId={`digest:${weekly ? "week" : "day"}:${issue.day}:${section.lane}`} id={section.lane} title={section.laneLabel || "其他"} items={section.items} limit={laneLimit} />)}

      {issue.followedQueries && issue.followedQueries.length > 0 && <FollowedQueries follows={issue.followedQueries} />}
      {issue.followedZones && issue.followedZones.length > 0 && <FollowedZones zones={issue.followedZones} />}

      {issue.aiMinute && (
        <section aria-labelledby="daily-ai-minute" className="mt-8">
          <h3 id="daily-ai-minute" className="text-body font-semibold text-text">AI 一分钟</h3>
          <p data-prose="" className="mt-1 max-w-measure text-ui text-text-2">{issue.aiMinute}</p>
        </section>
      )}

      {(previous || next) && (
        <nav aria-label={weekly ? "周报翻页" : "日报翻页"} className="mt-8 flex items-center justify-between">
          {previous ? <Button variant="text" onClick={() => onDay(previous)}>{weekly ? "‹ 前一期" : "‹ 前一日"}</Button> : <span />}
          {next ? <Button variant="text" onClick={() => onDay(next)}>{weekly ? "后一期 ›" : "后一日 ›"}</Button> : <span />}
        </nav>
      )}
    </>
  );
}

/**
 * 往期 beside the issue, on a screen with the room: the archive cut into months, newest first, each issue a day with its number of
 * items, the open one marked. It stays in sight under the page's band while the issue scrolls and scrolls on its own when it is long. A
 * full page of issues ends in 「更早的日报」, which reads the next.
 */
function DailyArchive({ index, current, onDay, more }: { index: FrontierDailySummary[]; current: string; onDay: (day: string) => void; more: DailyState["more"] }) {
  const column = useRef<HTMLElement>(null);
  // The open issue is in sight in the column when it opens (a month down the list is a screen down): the column's own scroll, never the
  // page's — `scrollIntoView` would move the page's ground too. Only when the issue changes, so the reader's own scrolling in it is left alone.
  useEffect(() => {
    const box = column.current;
    const open = box?.querySelector<HTMLElement>("[aria-current='date']");
    if (!box || !open) return;
    if (open.offsetTop < box.scrollTop || open.offsetTop + open.offsetHeight > box.scrollTop + box.clientHeight) {
      box.scrollTop = Math.max(0, open.offsetTop - (box.clientHeight - open.offsetHeight) / 2);
    }
  }, [current]);
  return (
    <nav ref={column} aria-label="往期日报" data-daily-archive="" className="sticky top-[calc(var(--page-chrome-h,0px)+1rem)] max-h-[calc(100vh-var(--page-chrome-h,0px)-2rem)] space-y-4 self-start overflow-y-auto">
      {archiveMonths(index).map((month) => (
        <div key={month.key} role="group" aria-label={month.label}>
          <p aria-hidden="true" className="px-2 pb-1 text-caption text-text-3">{month.label}</p>
          <ul className="space-y-0.5">
            {month.entries.map((entry) => (
              <li key={entry.day}>
                <button type="button" aria-label={archiveEntryName(entry)} aria-current={entry.day === current ? "date" : undefined} className={navItemClasses({ current: entry.day === current })} onClick={() => onDay(entry.day)}>
                  <span className="min-w-0 flex-1 truncate">{dayInMonth(entry.day)}</span>
                  {entry.itemCount > 0 && <span className="shrink-0 text-caption tabular-nums text-text-3">{entry.itemCount}</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {more && <Button variant="text" size="sm" className="px-2" loading={more.loading} onClick={more.load}>更早的日报</Button>}
    </nav>
  );
}

/**
 * 先看三件事: the three things an issue is read for first, each a title (which opens the addressed reader) and its 导读 sentence and
 * nothing more — not a lane row, whose source and 详情 would be the same item drawn twice: the lanes below skip these three — and, for
 * the lead, the way to its event after its sentence. Numbered like the lanes' rows, since the order is the issue's.
 */
function TopThings({ things }: { things: TopThing[] }) {
  const origin = useFrontierOrigin();
  return (
    <section aria-labelledby="daily-top-things" className="mt-5">
      <h3 id="daily-top-things" className="flex items-baseline gap-2">
        <span className="text-body font-semibold text-text">先看三件事</span>
      </h3>
      <ol aria-label="先看三件事" className="mt-1">
        {things.map((thing, index) => (
          <li key={thing.item.id} className="flex gap-2 border-b border-border py-3">
            <span className="w-8 shrink-0 text-caption leading-6 tabular-nums text-text-3">{rankLabel(index + 1)}</span>
            <div className="min-w-0 flex-1">
              <p data-row-title data-prose="" className="text-body font-semibold leading-6 text-text"><ArticleLink item={thing.item}>{thing.item.title}</ArticleLink></p>
              {(thing.text || thing.event) && (
                <p data-prose="" className="mt-1 line-clamp-2 max-w-measure text-ui text-text-2">
                  {thing.text}
                  {thing.event && (
                    <Link state={origin} onClick={rememberFrontierPosition} to={`/app/frontier/events/${encodeURIComponent(thing.event.id)}`} className={cn(INLINE_ACTION, "ml-1 px-1 align-middle text-accent")}>
                      事件页 ›
                    </Link>
                  )}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * 「你关注的」: the things this reader typed to follow that have news, each one a link to its feed with the number of new items
 * (c3-watch). Theirs alone, like the zones below it.
 */
function FollowedQueries({ follows }: { follows: FrontierFollowedQuery[] }) {
  return (
    <section aria-labelledby="daily-followed-queries" className="mt-8">
      <h3 id="daily-followed-queries" className="text-body font-semibold text-text">你关注的</h3>
      <ul aria-label="有新动态的关注" className="mt-1">
        {follows.map((follow) => (
          <li key={follow.id} className="flex items-baseline gap-2 border-b border-border py-3">
            <Link to={`/app/frontier?view=following&follow=${encodeURIComponent(follow.id)}`} className="min-w-0 flex-1 text-body font-semibold leading-6 text-text hover:text-accent hover:underline">
              {follow.label}
            </Link>
            <span className="shrink-0 text-caption tabular-nums text-text-3">{follow.newItems >= 99 ? "99+" : follow.newItems} 条新动态</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * 「你关注的专区」: this reader's own followed zones, with the cards that are new or changed in the issue's window.
 * It is the reader's alone — the issue above it reads the same to everyone — so it is a section of its own, not a lane.
 */
function FollowedZones({ zones }: { zones: FrontierFollowedZone[] }) {
  return (
    <section aria-labelledby="daily-followed-zones" className="mt-8">
      <h3 id="daily-followed-zones" className="text-body font-semibold text-text">你关注的专区</h3>
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
                  {card.summary && <p data-prose="" className="mt-1 line-clamp-2 max-w-measure text-ui text-text-2">{card.summary}</p>}
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
function DailySection({ id, title, items, safety = false, limit, expansion, expansionId }: { id: string; title: string; items: FrontierItem[]; safety?: boolean; limit?: number; expansion?: DigestExpansion; expansionId: string }) {
  const [localAll, setAll] = useState(false);
  const all = expansion ? expansion.ids.includes(expansionId) : localAll;
  const shown = limit !== undefined && !all ? items.slice(0, limit) : items;
  const rest = items.length - shown.length;
  return (
    <section aria-labelledby={`daily-${id}`} className="mt-8">
      <h3 id={`daily-${id}`} className="flex scroll-mt-24 items-baseline gap-2">
        <span className={cn("text-body font-semibold", safety ? "text-danger-strong" : "text-text")}>{title}</span>
        <span className="text-caption tabular-nums text-text-3">{items.length}</span>
      </h3>
      <ol aria-label={title} className="mt-1">
        {shown.map((item, index) => <DailyRow key={item.id} item={item} number={index + 1} safety={safety} />)}
      </ol>
      {rest > 0 && <Button variant="text" size="sm" className="-ml-2 mt-1" onClick={() => expansion ? expansion.onExpand(expansionId) : setAll(true)}>展开其余 {rest} 条</Button>}
    </section>
  );
}

/**
 * A digest row keeps its source and opens the shared article reader. `summary` is the sentence under the title (the item's 导读 unless
 * the issue wrote another), `clamp` how many lines of it show, and `event` the lead's way to its event page.
 */
function DailyRow({ item, number, safety, summary = item.summary, clamp = "line-clamp-3", event = null }: {
  item: FrontierItem; number: number; safety: boolean; summary?: string | null; clamp?: string; event?: { id: string; title: string } | null;
}) {
  const origin = useFrontierOrigin();
  return (
    <li className="flex gap-2 border-b border-border py-3">
      <span className="w-8 shrink-0 text-caption leading-6 tabular-nums text-text-3">{rankLabel(number)}</span>
      <div className="min-w-0 flex-1">
        <p data-row-title data-prose="" className="text-body font-semibold leading-6 text-text"><ArticleLink item={item}>{item.title}</ArticleLink></p>
        {!safety && summary && <p data-prose="" className={cn("mt-1 max-w-measure text-ui text-text-2", clamp)}>{summary}</p>}
        <div className="mt-1 flex items-center gap-1.5 text-caption text-text-3">
          <span className="min-w-0 truncate">{item.source.name}</span>
          {/* The feed card's own look for this action: a sized button here was the page's tenth kind of control. */}
          <ArticleLink item={item} className={cn(INLINE_ACTION, "px-1 text-accent")}>详情</ArticleLink>
          {event && (
            <Link state={origin} onClick={rememberFrontierPosition} to={`/app/frontier/events/${encodeURIComponent(event.id)}`} className={cn(INLINE_ACTION, "px-1 text-accent")}>
              事件页 ›
            </Link>
          )}
        </div>
      </div>
    </li>
  );
}

function ArticleLink({ item, children, className = "hover:text-accent hover:underline" }: { item: FrontierItem; children: ReactNode; className?: string }) {
  const origin = useFrontierOrigin();
  const location = useLocation();
  return <Link to={`/app/frontier/items/${encodeURIComponent(item.id)}`} state={{ ...origin, evidenceFrom: { to: `${location.pathname}${location.search}`, label: "简报" } }} onClick={rememberFrontierPosition} className={className}>{children}</Link>;
}
