import { rememberFrontierPosition, useFrontierOrigin } from "./frontierReadingState";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { CalendarDays, ChevronRight, ClipboardCheck, FileText } from "lucide-react";
import {
  frontierAbsence,
  frontierErrorMessage,
  listFrontierApprovals,
  listFrontierCongresses,
  listFrontierGuidelines,
  type FrontierApprovalRow,
  type FrontierApprovals,
  type FrontierCongress,
  type FrontierGuidelineRow,
  type FrontierGuidelines,
  type FrontierItem,
  type FrontierTrackSegment,
  FRONTIER_TRACK_SEGMENTS,
} from "@/lib/frontierClient";
import { cn } from "@/lib/cn";
import { serveFrontierList } from "@/lib/frontierTracking";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { buttonClasses } from "@/components/ui/Button";
import { Note, type NotePart, type NoteResult } from "@/components/ui/Note";
import { Section } from "@/components/ui/Section";
import { ShowMore } from "@/components/ui/ShowMore";
import { Tag } from "@/components/ui/Tag";
import type { ToolbarFilter } from "@/components/ui/Toolbar";
import { FrontierSkeleton } from "./FrontierSkeleton";

const articlePath = (id: string) => `/app/frontier/items/${encodeURIComponent(id)}`;
/** A congress's hub (`/app/frontier/congress/:id`). */
export const congressPath = (id: string) => `/app/frontier/congress/${encodeURIComponent(id)}`;

/** 追踪's segment from the address (`?segment=`): 审批 until a link says another. */
export function readTrackSegment(value: string | null): FrontierTrackSegment {
  return FRONTIER_TRACK_SEGMENTS.includes(value as FrontierTrackSegment) ? value as FrontierTrackSegment : "approvals";
}

const SEGMENT_OPTIONS: ReadonlyArray<{ value: FrontierTrackSegment; label: string }> = [
  { value: "approvals", label: "审批" },
  { value: "guidelines", label: "指南" },
  { value: "congresses", label: "会议" },
];

/* ------------------------------------------------------------------------------------------------ reading */

/** What a tracked list is while it is read: the first page, the pages after it, or why there is none. */
export type TrackListState<Page> =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; page: Page; rows: number }
  | { kind: "absent" }
  | { kind: "error"; message: string };

interface TrackPaging<Page, Row> {
  state: TrackListState<Page>;
  rows: Row[];
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  retry: () => void;
}

/**
 * A tracked list read a page at a time: the first page when `enabled` (and again when `key` changes — another agency, another
 * specialty), then the pages the cursor names, each registered as what the list served (surface `track`) so its impressions and opens
 * join it. A server without the route reads as `absent`; a refusal as an error with a retry.
 */
function useTrackPaging<Row extends { item: FrontierItem }, Page extends { items: Row[]; nextCursor: string | null; listId: string | null }>(
  enabled: boolean, key: string, read: (cursor: string | null) => Promise<Page | null>,
): TrackPaging<Page, Row> {
  const [state, setState] = useState<TrackListState<Page>>({ kind: "idle" });
  const [rows, setRows] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  const reader = useRef(read);
  reader.current = read;
  useEffect(() => {
    if (!enabled) return;
    const current = ++generation.current;
    setState({ kind: "loading" });
    setRows([]);
    setCursor(null);
    // A 显示更多 of the list before this one may still be in flight; its answer is dropped, so the button is free again here.
    setLoadingMore(false);
    reader.current(null).then(
      (page) => {
        if (current !== generation.current) return;
        if (!page) { setState({ kind: "absent" }); return; }
        serveFrontierList("track", page.listId, page.items.map((row) => ({ id: row.item.id, slot: null })));
        setRows(page.items);
        setCursor(page.nextCursor);
        setState({ kind: "ready", page, rows: page.items.length });
      },
      (error: unknown) => {
        if (current !== generation.current) return;
        setState(frontierAbsence(error) ? { kind: "absent" } : { kind: "error", message: frontierErrorMessage(error) });
      },
    );
    return () => { generation.current += 1; };
  }, [enabled, key, attempt]);
  const loadMore = useCallback(() => {
    if (!cursor || loadingMore) return;
    const current = generation.current;
    const offset = rows.length;
    setLoadingMore(true);
    reader.current(cursor).then(
      (page) => {
        if (current !== generation.current || !page) return;
        serveFrontierList("track", page.listId, page.items.map((row) => ({ id: row.item.id, slot: null })), { offset });
        setRows((existing) => {
          const known = new Set(existing.map((row) => row.item.id));
          return [...existing, ...page.items.filter((row) => !known.has(row.item.id))];
        });
        setCursor(page.nextCursor);
      },
      () => { /* the button stays: it asks again */ },
    ).finally(() => { if (current === generation.current) setLoadingMore(false); });
  }, [cursor, loadingMore, rows.length]);
  return { state, rows, hasMore: cursor !== null, loadingMore, loadMore, retry: () => setAttempt((value) => value + 1) };
}

/** 审批, read for the view while it is open; `agency` narrows it. */
export function useFrontierApprovals(enabled: boolean, agency: string): TrackPaging<FrontierApprovals, FrontierApprovalRow> {
  return useTrackPaging(enabled, `approvals:${agency}`, (cursor) => listFrontierApprovals({ agency: agency || null, cursor }));
}

/** 指南, read for the view while it is open; `specialty` narrows it. */
export function useFrontierGuidelines(enabled: boolean, specialty: string): TrackPaging<FrontierGuidelines, FrontierGuidelineRow> {
  return useTrackPaging(enabled, `guidelines:${specialty}`, (cursor) => listFrontierGuidelines({ specialty: specialty || null, cursor }));
}

/** The congresses on now, coming and just over; null while reading and for a server without the route. */
export type CongressesState = { kind: "loading" } | { kind: "ready"; congresses: FrontierCongress[] } | { kind: "absent" } | { kind: "error"; message: string };

export function useFrontierCongresses(enabled: boolean): CongressesState & { retry: () => void } {
  const [state, setState] = useState<CongressesState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    listFrontierCongresses().then(
      (congresses) => { if (active) setState(congresses ? { kind: "ready", congresses } : { kind: "absent" }); },
      (error: unknown) => { if (active) setState(frontierAbsence(error) ? { kind: "absent" } : { kind: "error", message: frontierErrorMessage(error) }); },
    );
    return () => { active = false; };
  }, [enabled, attempt]);
  return { ...state, retry: () => setAttempt((value) => value + 1) };
}

/* ------------------------------------------------------------------------------------------------ controls */

/**
 * 追踪's controls for the page's toolbar: the segment (审批 · 指南 · 会议, pinned, so a phone keeps it in sight) and, where it fits,
 * one filter — the agency for 审批, the specialty for 指南. 会议 has none.
 */
export function trackControls({ segment, onSegment, agency, onAgency, approvals, specialty, onSpecialty, guidelines }: {
  segment: FrontierTrackSegment;
  onSegment: (next: FrontierTrackSegment) => void;
  agency: string;
  onAgency: (next: string) => void;
  approvals: TrackListState<FrontierApprovals>;
  specialty: string;
  onSpecialty: (next: string) => void;
  guidelines: TrackListState<FrontierGuidelines>;
}): ToolbarFilter[] {
  const filters: ToolbarFilter[] = [
    { kind: "chips", label: "追踪类别", pinned: true, options: SEGMENT_OPTIONS, value: segment, onChange: (next) => onSegment(readTrackSegment(next)) },
  ];
  if (segment === "approvals" && approvals.kind === "ready" && approvals.page.agencies.length > 0) {
    filters.push({
      kind: "select", label: "机构", allLabel: "全部机构", emptyText: "全部机构", value: agency || null, onChange: (next) => onAgency(next ?? ""),
      options: approvals.page.agencies.map((entry) => ({ value: entry.key, label: `${entry.label} ${entry.count}` })),
    });
  }
  if (segment === "guidelines" && guidelines.kind === "ready" && guidelines.page.specialties.length > 0) {
    filters.push({
      kind: "select", label: "专科", allLabel: "全部专科", emptyText: "全部专科", value: specialty || null, onChange: (next) => onSpecialty(next ?? ""),
      options: guidelines.page.specialties.map((entry) => ({ value: entry.key, label: `${entry.label} ${entry.count}` })),
    });
  }
  return filters;
}

/* ------------------------------------------------------------------------------------------------ dates */

/** 「10月24日」 from a day key. */
export function monthDay(day: string): string {
  const [, month, date] = day.split("-");
  return month && date ? `${Number(month)}月${Number(date)}日` : day;
}

/** 「10-24」 from a day key: the date column of a row. */
function numericDay(day: string): string {
  const [, month, date] = day.split("-");
  return month && date ? `${Number(month)}-${Number(date)}` : day;
}

/** 「2026年10月」 from a day key. */
function monthHeading(day: string): string {
  const [year, month] = day.split("-");
  return `${year}年${Number(month)}月`;
}

/** A congress's dates: 「10月23日—27日」, or both months when it crosses one. */
export function congressDates(start: string, end: string): string {
  if (start === end) return monthDay(start);
  const [, startMonth] = start.split("-");
  const [, endMonth, endDay] = end.split("-");
  return startMonth === endMonth ? `${monthDay(start)}—${Number(endDay)}日` : `${monthDay(start)}—${monthDay(end)}`;
}

/** Today's day key in the feed's zone (Asia/Shanghai), whatever the browser's zone is. */
function feedToday(now = Date.now()): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(now)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Whole days from one day key to another. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/* ------------------------------------------------------------------------------------------------ 审批 */

/** The line above the list: the year's count by agency, each figure the filter to that agency. */
function approvalsNote(page: FrontierApprovals, onAgency: (key: string) => void): readonly NotePart[] | null {
  const { ytd } = page;
  if (ytd.total === 0) return null;
  const since = ytd.since && ytd.since > `${ytd.year}-01-31` ? `${monthDay(ytd.since)}以来` : `${ytd.year} 年`;
  const top = ytd.byAgency.filter((entry) => entry.key !== "none").slice(0, 4);
  const parts: NotePart[] = [`${since}共收录 `, { n: ytd.total }, " 项审批"];
  top.forEach((entry, index) => {
    parts.push(index === 0 ? `：${entry.label} ` : `，${entry.label} `, { n: entry.count, onOpen: () => onAgency(entry.key), label: `${entry.label} ${entry.count} 项，只看这个机构` });
  });
  return parts;
}

/**
 * A row is one link to its article, as a feed card is: the title's link stretches over the row's box (`relative` on the box, the link's
 * `after:inset-0`), the title turns the accent under the pointer, and what else the row holds is its words. A whole row drawn as one
 * block link was a kind of control for every number of lines it wrapped to — 52, 74, 98 … px — on the release walk of
 * evimed-5ae53861dc26-1; the title's link is one look at any length.
 */
const ROW_BOX = "group relative isolate min-w-0";
const ROW_LINK = cn(
  "rounded outline-none transition-colors duration-fast group-hover:text-accent",
  "after:absolute after:inset-0 after:rounded after:content-[''] focus-visible:outline-none focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:outline-focus",
);
/** What sits above a row's stretched link, so the pointer reaches it (a mark's reason on hover). */
const ABOVE = "relative z-sticky";

function ApprovalRow({ row }: { row: FrontierApprovalRow }) {
  const origin = useFrontierOrigin();
  return (
    <li data-frontier-item={row.item.id} className="border-b border-border py-3">
      <div className={cn(ROW_BOX, "flex flex-wrap items-baseline gap-x-3 gap-y-1")}>
        <span className="w-12 shrink-0 text-caption tabular-nums text-text-3">{numericDay(row.at)}</span>
        <span className="min-w-0 flex-1 basis-60">
          <span data-row-title data-prose="" className="block text-body font-semibold text-text">
            <Link to={articlePath(row.item.id)} state={origin} onClick={rememberFrontierPosition} className={ROW_LINK}>{row.drug}</Link>
          </span>
          {row.indication && <span data-prose="" className="mt-0.5 block text-ui text-text-2">{row.indication}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-caption text-text-3">
          {row.agency && <span>{row.agency.label}</span>}
          {row.agency && <span aria-hidden="true">·</span>}
          <span>{row.approvalLabel}</span>
        </span>
      </div>
    </li>
  );
}

/** 审批: a line with the year's count, then the approvals grouped by month, newest first. */
export function ApprovalsBody({ paging, agency, onAgency }: { paging: TrackPaging<FrontierApprovals, FrontierApprovalRow>; agency: string; onAgency: (key: string) => void }) {
  const { state, rows } = paging;
  const months = useMemo(() => {
    const groups: Array<{ key: string; rows: FrontierApprovalRow[] }> = [];
    for (const row of rows) {
      const key = row.at.slice(0, 7);
      const last = groups[groups.length - 1];
      if (last?.key === key) last.rows.push(row); else groups.push({ key, rows: [row] });
    }
    return groups;
  }, [rows]);
  if (state.kind === "idle" || state.kind === "loading") return <FrontierSkeleton />;
  if (state.kind === "error") return <LoadError message={state.message} onRetry={paging.retry} />;
  if (state.kind === "absent") {
    return <EmptyState icon={ClipboardCheck} title="审批追踪还在准备" action={<Link to="/app/frontier?view=all&channel=official" className={buttonClasses({ variant: "secondary" })}>看官方来源的动态</Link>} />;
  }
  const note = approvalsNote(state.page, onAgency);
  return (
    <div data-frontier-list="track" className="contents">
      {note && <Note result={note as NoteResult} />}
      {rows.length === 0 ? (
        <EmptyState icon={ClipboardCheck} title={agency ? "这个机构最近 90 天没有收录到审批" : "最近 90 天还没有收录到审批"}
          action={agency ? <button type="button" className={buttonClasses({ variant: "secondary" })} onClick={() => onAgency("")}>看全部机构</button>
            : <Link to="/app/frontier?view=all&channel=official" className={buttonClasses({ variant: "secondary" })}>看官方来源的动态</Link>} />
      ) : months.map((group) => (
        <Section key={group.key} title={monthHeading(`${group.key}-01`)} count={`${group.rows.length} 项`}>
          <ul aria-label={monthHeading(`${group.key}-01`)}>{group.rows.map((row) => <ApprovalRow key={row.item.id} row={row} />)}</ul>
        </Section>
      ))}
      {paging.hasMore && <ShowMore remaining={null} unit="项" loading={paging.loadingMore} onMore={paging.loadMore} />}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ 指南 */

/**
 * The small mark of an item that may change practice (c3-select): its reason on hover and tap. Shown only where the item carries
 * one, so a server that does not label yet draws nothing.
 */
function PracticeMark({ item }: { item: FrontierItem }) {
  const practice = (item as FrontierItem & { practice?: { reason?: string } | null }).practice;
  if (!practice) return null;
  return <Tag title={practice.reason || undefined} className={ABOVE}>可能改变实践</Tag>;
}

function GuidelineRow({ row }: { row: FrontierGuidelineRow }) {
  const origin = useFrontierOrigin();
  const shown = row.recommendations.slice(0, 3);
  return (
    <li data-frontier-item={row.item.id} className="border-b border-border py-3">
      <div className={ROW_BOX}>
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-caption text-text-3">
          {row.body && <span data-prose="" className="max-w-full truncate">{row.body}</span>}
          {row.body && <span aria-hidden="true">·</span>}
          <span className="tabular-nums">{monthDay(row.at)}</span>
          <PracticeMark item={row.item} />
        </span>
        <span data-row-title data-prose="" className="mt-0.5 block text-body font-semibold text-text">
          <Link to={articlePath(row.item.id)} state={origin} onClick={rememberFrontierPosition} className={ROW_LINK}>{row.item.title}</Link>
        </span>
        {row.scope && shown.length === 0 && <span data-prose="" className="mt-0.5 block text-ui text-text-2">{row.scope}</span>}
      </div>
      {shown.length > 0 && (
        <ul aria-label="主要推荐" className="mt-2 space-y-1.5 border-l-2 border-border pl-3">
          {shown.map((rec, index) => (
            <li key={index} data-prose="" className="text-ui text-text-2">
              {rec.text}
              {rec.grade && <span className="ml-1.5 whitespace-nowrap text-caption text-text-3">{rec.grade}</span>}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** 指南: the guideline updates, newest first; each with the issuing body, the date and up to three key recommendations. */
export function GuidelinesBody({ paging, specialty, onSpecialty }: { paging: TrackPaging<FrontierGuidelines, FrontierGuidelineRow>; specialty: string; onSpecialty: (key: string) => void }) {
  const { state, rows } = paging;
  if (state.kind === "idle" || state.kind === "loading") return <FrontierSkeleton />;
  if (state.kind === "error") return <LoadError message={state.message} onRetry={paging.retry} />;
  if (state.kind === "absent") {
    return <EmptyState icon={FileText} title="指南追踪还在准备" action={<Link to="/app/frontier?view=all&lane=guideline" className={buttonClasses({ variant: "secondary" })}>看指南类动态</Link>} />;
  }
  return (
    <div data-frontier-list="track" className="contents">
      {rows.length === 0 ? (
        <EmptyState icon={FileText} title={specialty ? "这个专科最近没有收录到指南更新" : "最近还没有收录到指南更新"}
          action={specialty ? <button type="button" className={buttonClasses({ variant: "secondary" })} onClick={() => onSpecialty("")}>看全部专科</button>
            : <Link to="/app/frontier?view=all" className={buttonClasses({ variant: "secondary" })}>看全部动态</Link>} />
      ) : <ul aria-label="指南更新">{rows.map((row) => <GuidelineRow key={row.item.id} row={row} />)}</ul>}
      {paging.hasMore && <ShowMore remaining={null} unit="项" loading={paging.loadingMore} onMore={paging.loadMore} />}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ 会议 */

const STATUS_GROUPS: ReadonlyArray<{ status: FrontierCongress["status"]; title: string }> = [
  { status: "ongoing", title: "正在进行" },
  { status: "upcoming", title: "即将召开" },
  { status: "recent", title: "近期结束" },
];

function CongressRow({ congress }: { congress: FrontierCongress }) {
  const origin = useFrontierOrigin();
  const today = feedToday();
  const until = congress.status === "upcoming" ? daysBetween(today, congress.start) : 0;
  const meta = [congressDates(congress.start, congress.end), congress.city, congress.specialtyLabel].filter(Boolean).join(" · ");
  return (
    <li className="border-b border-border">
      <Link to={congressPath(congress.id)} state={origin} onClick={rememberFrontierPosition} className="group flex min-h-control min-w-0 items-center gap-3 rounded py-3">
        <span className="min-w-0 flex-1">
          <span data-row-title data-prose="" className="block text-body font-semibold text-text group-hover:text-accent">
            {congress.code}{congress.name && congress.name !== congress.code ? ` · ${congress.name}` : ""}
          </span>
          <span className="mt-0.5 block text-caption text-text-3">{meta}</span>
        </span>
        <span className="shrink-0 text-caption tabular-nums text-text-3">
          {congress.itemCount > 0 ? `${congress.itemCount} 条` : congress.status === "upcoming" ? (until > 0 ? `${until} 天后开始` : "即将开始") : "暂无报道"}
        </span>
        <ChevronRight size={16} className="shrink-0 text-text-3" aria-hidden="true" />
      </Link>
    </li>
  );
}

/** 会议: the congresses on now, coming in the next 60 days and over within the last 30. Each opens its hub. */
export function CongressesBody({ state }: { state: CongressesState & { retry: () => void } }) {
  if (state.kind === "loading") return <FrontierSkeleton />;
  if (state.kind === "error") return <LoadError message={state.message} onRetry={state.retry} />;
  if (state.kind === "absent") return <EmptyState icon={CalendarDays} title="会议追踪还在准备" action={<Link to="/app/frontier?view=all" className={buttonClasses({ variant: "secondary" })}>看全部动态</Link>} />;
  if (state.congresses.length === 0) {
    return <EmptyState icon={CalendarDays} title="近期没有大型学术会议" description="未来 60 天和最近 30 天的日历里没有收录会议。" action={<Link to="/app/frontier?view=all" className={buttonClasses({ variant: "secondary" })}>看全部动态</Link>} />;
  }
  return (
    <div className="contents">
      {STATUS_GROUPS.map(({ status, title }) => {
        const rows = state.congresses.filter((congress) => congress.status === status);
        if (rows.length === 0) return null;
        return (
          <Section key={status} title={title} count={rows.length}>
            <ul aria-label={title}>{rows.map((congress) => <CongressRow key={congress.id} congress={congress} />)}</ul>
          </Section>
        );
      })}
    </div>
  );
}

/**
 * 热榜's line while a congress is on (「ESMO 2026 进行中 · 57 条」): the congress on now with the most items, opening its hub.
 * Nothing while none is on or none has an item, or where the route does not exist.
 */
export function CongressNowLine() {
  const state = useFrontierCongresses(true);
  const origin = useFrontierOrigin();
  if (state.kind !== "ready") return null;
  const now = state.congresses.filter((congress) => congress.status === "ongoing" && congress.itemCount > 0).sort((a, b) => b.itemCount - a.itemCount)[0];
  if (!now) return null;
  return (
    <Link to={congressPath(now.id)} state={origin} onClick={rememberFrontierPosition}
      className="mb-6 flex min-h-control items-center gap-2 rounded text-ui text-text hover:text-accent">
      <CalendarDays size={16} className="shrink-0 text-text-3" aria-hidden="true" />
      <span className="font-semibold">{now.code}</span>
      <span>进行中</span>
      <span aria-hidden="true" className="text-text-3">·</span>
      <span className="tabular-nums">{now.itemCount} 条</span>
      <ChevronRight size={16} className="shrink-0 text-text-3" aria-hidden="true" />
    </Link>
  );
}

/** The segment's body, with the controls it answers to. */
export function TrackBody({ segment, approvals, agency, onAgency, guidelines, specialty, onSpecialty, congresses }: {
  segment: FrontierTrackSegment;
  approvals: TrackPaging<FrontierApprovals, FrontierApprovalRow>;
  agency: string;
  onAgency: (key: string) => void;
  guidelines: TrackPaging<FrontierGuidelines, FrontierGuidelineRow>;
  specialty: string;
  onSpecialty: (key: string) => void;
  congresses: CongressesState & { retry: () => void };
}) {
  if (segment === "guidelines") return <GuidelinesBody paging={guidelines} specialty={specialty} onSpecialty={onSpecialty} />;
  if (segment === "congresses") return <CongressesBody state={congresses} />;
  return <ApprovalsBody paging={approvals} agency={agency} onAgency={onAgency} />;
}
