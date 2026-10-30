import { rememberFrontierPosition, useFrontierOrigin } from "@/components/frontier/frontierReadingState";
import { markFrontierEventRead } from "@/lib/frontierClient";
import { serveFrontierList, trackFrontierItemAction, useFrontierListTracking } from "@/lib/frontierTracking";
import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { CalendarClock, ChevronLeft, SearchX } from "lucide-react";
import { WebApiError } from "@/lib/apiClient";
import { cn } from "@/lib/cn";
import {
  fetchFrontierEvent,
  frontierAbsence,
  frontierErrorMessage,
  useFrontierFeature,
  type FrontierEvent,
  type FrontierEventOrder,
  type FrontierEventRole,
  type FrontierItem,
} from "@/lib/frontierClient";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { useWide } from "@/lib/useMediaQuery";
import { LoadError } from "@/components/cards/LoadError";
import { PageShell } from "@/components/layout/PageShell";
import { PageTitle } from "@/components/layout/PageTitle";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Section } from "@/components/ui/Section";
import { ShowMore, useShowMore } from "@/components/ui/ShowMore";
import { StateScreen } from "@/components/ui/StateScreen";
import { Tag } from "@/components/ui/Tag";
import { Toolbar } from "@/components/ui/Toolbar";
import { FrontierSkeleton } from "@/components/frontier/FrontierSkeleton";
import { openItemConversation } from "@/components/frontier/frontierAsk";
import { AskRows } from "@/components/frontier/FrontierReader";
import { FrontierOffPage } from "@/components/frontier/FrontierStates";
import { Sparkline } from "@/components/frontier/Sparkline";
import {
  EXTERNAL,
  FEED_ZONE_NOTE,
  INLINE_ACTION,
  ago,
  dateClock,
  dayHeading,
  eventResearchDraft,
  groupByDay,
  itemClock,
  primaryHeld,
  updatedText,
  type ItemDay,
} from "@/components/frontier/frontierText";
import { recordMoment } from "@/components/frontier/frontierRecord";

type EventState =
  | { kind: "loading" }
  | { kind: "ready"; event: FrontierEvent }
  | { kind: "not-offered" }
  | { kind: "missing" }
  | { kind: "off" }
  | { kind: "error"; message: string };

/** How one event follows from another (plan §14.8 #2), in the reader's words. */
const RELATION_WORDS: Readonly<Record<string, string>> = Object.freeze({
  follows: "后续进展",
  supersedes: "取代了之前的说法",
  "preprint-of": "预印本与正式发表",
  "retracted-by": "撤稿",
  "corrected-by": "更正",
  related: "相关",
});

/**
 * One event (plan 2026-09-23 §6.2; mockup m05): the title and one line — how
 * many institutions reported it, when it last moved, its specialty — with
 * 「深入研究」; what is known so far and the latest turn; the reports, the
 * parties' own texts first under 「一手材料」 (a paper, a notice, a label) and the
 * rest as 「报道时间线」, cut into Beijing days, the newest day first or, on 最早
 * (`?order=asc`, asked of the server too), the oldest — or, where nobody's own
 * text is among them, the timeline alone; from ten reports on a menu narrows
 * them to one kind of source; and on the right 「事件记录」: the heat and its
 * 72-hour trend, the first report and the last update (Beijing time, said
 * once), how many reports and sources, and whether first-hand material is
 * among them. On a window narrower than 1024 px the record is the strip above
 * the summary. No card explains itself.
 *
 * Hidden knowledge: an event merged into another keeps its old address — a
 * notification, a star or a Feishu card may carry it — and the server answers
 * that address with a permanent redirect that `fetch` follows. The page then
 * rewrites its own URL to the surviving id, so what the reader bookmarks next
 * is the address that will not move again. On a server without events yet,
 * the page says so instead of failing.
 */
export function FrontierEventPage() {
  const feature = useFrontierFeature();
  const { eventId = "" } = useParams();
  if (feature === "off") return <FrontierOffPage />;
  return <EventView key={eventId} eventId={eventId} ready={feature !== "loading"} />;
}

/** The order a link names (`?order=asc`, 最早 first); newest first otherwise. */
function readOrder(value: string | null): FrontierEventOrder {
  return value === "asc" ? "asc" : "desc";
}

function EventView({ eventId, ready }: { eventId: string; ready: boolean }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const order = readOrder(params.get("order"));
  const wide = useWide();
  const [state, setState] = useState<EventState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!ready) return;
    let active = true;
    // A new order keeps the event on screen while it is read again in that order; only a first read shows the skeleton.
    setState((current) => (current.kind === "ready" ? current : { kind: "loading" }));
    fetchFrontierEvent(eventId, order === "asc" ? "asc" : undefined).then(
      (event) => {
        if (!active) return;
        setState({ kind: "ready", event });
        if (event.readingMark) void markFrontierEventRead(event.id, event.readingMark).catch(() => {});
        if (event.id !== eventId) navigate(`/app/frontier/events/${encodeURIComponent(event.id)}${location.search}`, { replace: true, state: location.state });
      },
      (error: unknown) => {
        if (!active) return;
        const absence = frontierAbsence(error);
        if (absence === "off") setState({ kind: "off" });
        else if (absence === "not-offered") setState({ kind: "not-offered" });
        else if (error instanceof WebApiError && error.status === 404) setState({ kind: "missing" });
        else setState({ kind: "error", message: frontierErrorMessage(error) });
      },
    );
    return () => { active = false; };
    // `location.search` is read for the redirect only; the order is its own dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, ready, attempt, navigate, location.state, order]);

  if (state.kind === "off") return <FrontierOffPage />;
  // A page that is not there is a screen of its own — an icon, one sentence, the way on and the way back — not an empty box in the
  // event's frame (R19, audit D C5).
  if (state.kind === "not-offered" || state.kind === "missing") {
    return state.kind === "not-offered" ? (
      <StateScreen icon={CalendarClock} title="事件页还在准备" titleAs="h1" back={{ to: "/app/frontier", label: "回到前沿动态" }}>
        <PageTitle page="事件" />
      </StateScreen>
    ) : (
      <StateScreen icon={SearchX} title="这个事件已不存在" titleAs="h1"
        action={<Link to="/app/frontier?view=hot" className={buttonClasses({ variant: "secondary" })}>看热榜</Link>}
        back={{ to: "/app/frontier", label: "回到前沿动态" }}>
        <PageTitle page="事件" />
      </StateScreen>
    );
  }
  if (state.kind !== "ready") {
    return (
      <EventFrame title="事件" wide={wide}>
        <div>
          {state.kind === "loading" && <FrontierSkeleton />}
          {state.kind === "error" && <LoadError message={state.message} onRetry={() => setAttempt((value) => value + 1)} />}
        </div>
      </EventFrame>
    );
  }
  const setOrder = (next: FrontierEventOrder) => setParams((current) => {
    const updated = new URLSearchParams(current);
    if (next === "asc") updated.set("order", "asc"); else updated.delete("order");
    return updated;
  }, { replace: true, state: location.state });
  return <EventBody event={state.event} order={order} onOrder={setOrder} wide={wide} />;
}

/**
 * The page's column — the list column, 1040, with the record beside it from 1024 px (`wide`), as the article has its notes; below that
 * the reading column, 720: an event is read, R13 V-2 — its way back and its one-line header, shared by every state of it. `facts` is
 * the one line under the title, when the event has one; it sits close to the title and the body starts a section below it. `aside` is
 * the right column.
 */
function EventFrame({ title, actions, facts, aside, wide, children }: { title: string; actions?: ReactNode; facts?: ReactNode; aside?: ReactNode; wide: boolean; children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const origin = (location.state as { frontierOrigin?: string } | null)?.frontierOrigin;
  const fromReader = origin === "/app/frontier" || (typeof origin === "string" && origin.startsWith("/app/frontier?"));
  return (
    <PageShell
      title={title}
      documentTitle={`${title} · 前沿动态`}
      titleVariant="document"
      width={wide ? "page" : "read"}
      asideLabel="事件记录"
      aside={aside}
      back={(
        <nav aria-label="返回">
          <Link to={fromReader ? origin! : "/app/frontier"} onClick={fromReader ? (event) => { event.preventDefault(); navigate(-1); } : undefined} className={cn(INLINE_ACTION, "-ml-1.5 gap-1 px-1.5 text-text-3 hover:text-text")}>
            <ChevronLeft size={16} aria-hidden="true" />前沿动态
          </Link>
        </nav>
      )}
      actions={actions}
      contentClassName={facts ? "mt-1.5" : undefined}
    >
      {facts}
      {children}
    </PageShell>
  );
}

function EventBody({ event, order, onOrder, wide }: { event: FrontierEvent; order: FrontierEventOrder; onOrder: (order: FrontierEventOrder) => void; wide: boolean }) {
  const navigate = useNavigate();
  const location = useLocation();
  // The server reads the event in the order asked; the page sorts it too, so a server that does not know the order reads the same.
  const timeline = useMemo(() => [...event.items]
    .sort((a, b) => (order === "asc" ? 1 : -1) * (Date.parse(a.timelineAt) - Date.parse(b.timelineAt))), [event.items, order]);
  const research = () => navigate("/app/chat", { state: { runtimeUiIntent: { ...newRuntimeUiIntent(eventResearchDraft(event)), originReference: { kind: "frontier-event", id: event.id, title: event.title } } } });
  // 就此提问: the questions of the event's first-hand report open the conversation with that report as its origin (c3-ask).
  const askEntry = event.ask ?? null;
  const askReport = askEntry ? event.items.find((item) => item.id === askEntry.itemId) : undefined;
  const ask = (question: string | null) => {
    if (!askEntry) return;
    trackFrontierItemAction("ask", askEntry.itemId, { surface: "event", detail: question ? "suggested" : "own" });
    openItemConversation(navigate, { id: askEntry.itemId, title: askEntry.title, source: askReport?.source, publishedAt: askReport?.publishedAt, url: askReport?.url }, question);
  };
  // From ten reports on, a kind of source narrows the list: the kinds the rows already name, in the order they first appear.
  const [sourceType, setSourceType] = useState<string | null>(null);
  const sourceTypes = useMemo(() => [...new Set(timeline.flatMap((item) => (item.sourceTypeLabel ? [item.sourceTypeLabel] : [])))], [timeline]);
  const visible = sourceType ? timeline.filter((item) => item.sourceTypeLabel === sourceType) : timeline;
  const firstHand = timeline.some((item) => item.role === "primary");
  // The reports are a list a reader opens an article from, registered like the other lists (G12, 2026-10-25): an open from here is
  // `event`, with its position in the order shown — the parties' own texts first — not a `direct` arrival.
  const root = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => (firstHand ? [...visible.filter((item) => item.role === "primary"), ...visible.filter((item) => item.role !== "primary")] : visible), [firstHand, visible]);
  useEffect(() => { serveFrontierList("event", null, shown.map((item) => ({ id: item.id }))); }, [shown]);
  useFrontierListTracking(root, [event.id, shown]);
  const specialty = event.specialties[0] ?? null;
  const updated = ago(event.lastAt);
  const studies = event.counts && event.counts.studies > 0
    ? `${event.counts.studies} 项已识别研究${event.counts.unlinkedReports > 0 ? `（${event.counts.unlinkedReports} 篇尚未关联研究）` : ""}` : null;
  // The reports' controls are the toolbar of the first group, at its heading, over the rows they order and narrow (the source filter was a
  // menu on a row of its own between two sections, with no word for what it filters): 最新 · 最早 from two reports on, and from ten
  // reports on a kind of source.
  const reportControls = [
    ...(timeline.length > 1 ? [{ kind: "chips" as const, label: "报道顺序", pinned: true, value: order,
      options: [{ value: "desc", label: "最新" }, { value: "asc", label: "最早" }], onChange: (next: string) => onOrder(next === "asc" ? "asc" : "desc") }] : []),
    ...(timeline.length >= 10 && sourceTypes.length > 1 ? [{ kind: "select" as const, label: "全部来源", allLabel: "全部来源", value: sourceType,
      options: sourceTypes.map((label) => ({ value: label, label })), onChange: setSourceType }] : []),
  ];
  const sourceFilter = reportControls.length > 0 ? <Toolbar label="报道的顺序与来源" filters={reportControls} /> : null;

  return (
    <EventFrame
      title={event.title}
      actions={<Button onClick={research}>深入研究</Button>}
      aside={wide ? <EventRecord event={event} layout="column" /> : undefined}
      wide={wide}
      facts={(
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-text-3">
          {/* How many reports and from how many sources is the record's (事件记录); this line keeps what the record does not say. */}
          {studies && <span>{studies}</span>}
          {studies && updated && <span aria-hidden="true">·</span>}
          {updated && <span>{updatedText(updated)}</span>}
          {specialty && <Tag className="ml-1">{specialty.label}</Tag>}
        </div>
      )}
    >
      {Boolean(event.changes?.length) && (
        <Section title="自上次阅读以来" className="mt-0">
          <div className="space-y-2">
            {event.changes?.map(change => <div key={change.id} className="text-ui">
              <p className="text-text"><span className="text-accent">{change.kind === "added" ? "新增报道" : "内容更新"} · </span>{change.title}</p>
              {change.summary && <p data-prose="" className="mt-1 text-text-2">{change.summary}</p>}
            </div>)}
          </div>
        </Section>
      )}
      {/* From 1024 px the record stands in the right column; below it, a strip above the summary, where a reader weighing the event
        * looks first. */}
      <div ref={root} className="mt-6 flex flex-col gap-8">
        {!wide && <EventRecord event={event} layout="strip" />}

        <div className="min-w-0 space-y-8">
          <Section title="概要" className="mt-0">
            <p className={cn("max-w-measure whitespace-pre-line text-ui", event.digest ? "text-text" : "text-text-3")}>{event.digest ?? "暂无综述"}</p>
            {event.latest && (
              <p className="mt-3 max-w-measure text-ui text-text-2">
                <span className="mr-1.5 text-accent">最新</span>
                {event.latest.text}
                {event.latest.at && <span className="text-text-3"> · {ago(event.latest.at)}</span>}
              </p>
            )}
          </Section>

          {askEntry && <Section title="就此提问" className="mt-0"><AskRows questions={askEntry.questions} onAsk={ask} /></Section>}

          {timeline.length > 0 && (
            <div data-frontier-list="event" className="space-y-8">
              {firstHand ? (
                <>
                  <ReportGroup id="event-primary" title="一手材料" rows={visible.filter((item) => item.role === "primary")} toolbar={sourceFilter} />
                  <ReportTimeline rows={visible.filter((item) => item.role !== "primary")} />
                </>
              ) : <ReportTimeline rows={visible} toolbar={sourceFilter} />}
            </div>
          )}

          {event.related.length > 0 && (
            <Section title="相关事件" className="mt-0">
              <ul className="space-y-2">
                {event.related.map((related) => (
                  <li key={`${related.relation}-${related.id}`}>
                    <Link state={location.state} replace to={`/app/frontier/events/${encodeURIComponent(related.id)}`} className="text-ui text-text hover:text-accent">{related.title}</Link>
                    <p className="text-caption text-text-3">{RELATION_WORDS[related.relation] ?? "相关"}{related.at ? ` · ${dateClock(related.at)}` : ""}</p>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      </div>
    </EventFrame>
  );
}

/**
 * 「事件记录」 (c5-reader, 2026-10-26): the event's heat and its 72-hour trend, then the record — when it was first reported and when it
 * last moved (Beijing time, said once in the heading), how many reports and from how many sources, and whether first-hand material is
 * among them. Only what is known is a row; nothing is explained. A column on the right from 1024 px (`column`: the shell's own aside), a
 * strip above the summary below it (`strip`).
 */
function EventRecord({ event, layout }: { event: FrontierEvent; layout: "column" | "strip" }) {
  const heat = event.heat ?? null;
  const first = recordMoment(event.firstAt);
  const last = recordMoment(event.lastAt);
  const reports = event.counts?.reports ?? event.reportCount;
  const sources = event.counts?.institutions ?? event.institutions72h?.total ?? event.sourceCount72h;
  // The kinds are those of the last 72 hours: they are said beside the number only where they add up to it.
  const kinds = event.institutions72h && event.institutions72h.total === sources ? event.institutions72h.byType.map((kind) => `${kind.label} ${kind.count}`).join(" · ") : "";
  const rows: Array<[string, string]> = [
    ...(first ? [["最早报道", first] as [string, string]] : []),
    ...(last ? [["最近更新", last] as [string, string]] : []),
    ...(reports > 0 ? [["报道", `${reports} 篇`] as [string, string]] : []),
    ...(sources > 0 ? [["来源", kinds ? `${sources} 家（${kinds}）` : `${sources} 家`] as [string, string]] : []),
    ["一手材料", primaryHeld(event)],
  ];
  const record = (
    <div className="min-w-0 flex-1">
      {/* The section heading's own type (18 / 600, as 概要 and the groups), with the zone in the metadata size: the page holds four size × weight pairs. */}
      <h2 className="flex items-baseline gap-1 font-semibold text-section text-text">事件记录{(first || last) && <span className="text-caption font-normal text-text-3">{FEED_ZONE_NOTE}</span>}</h2>
      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-ui">
        {rows.map(([term, value]) => <Fragment key={term}><dt className="text-text-3">{term}</dt><dd className="text-text">{value}</dd></Fragment>)}
      </dl>
    </div>
  );
  const trend = heat !== null && (
    <div>
      <p className="flex items-baseline gap-1">
        <span className="text-display font-semibold tabular-nums text-text">{heat}</span>
        <span className="text-caption text-text-3">热度</span>
      </p>
      <Sparkline points={event.trend} width={120} height={32} className="mt-2" />
    </div>
  );
  return layout === "strip"
    ? <aside aria-label="事件记录" className="flex flex-wrap items-start gap-x-10 gap-y-4">{trend}{record}</aside>
    : <div className="flex flex-col gap-5">{trend}{record}</div>;
}

/**
 * A group of reports: its heading and count, then the rows — nothing at all with no rows, except the group that carries the page's
 * source filter: the filter narrows every group, so the one it sits in stays (with a count of nothing) when a kind has no reports
 * there, and the way back to all of them is where it was.
 */
function ReportGroup({ id, title, rows, toolbar }: { id: string; title: string; rows: Array<FrontierItem & { role: FrontierEventRole }>; toolbar?: ReactNode }) {
  const page = useShowMore(rows, { first: TIMELINE_PAGE, step: TIMELINE_PAGE, resetKey: `${rows.length}:${rows[0]?.id ?? ""}` });
  if (rows.length === 0 && !toolbar) return null;
  return (
    <Section title={title} count={rows.length} toolbar={toolbar} className="mt-0">
      <ol id={id} aria-label={title} className="ml-1 border-l border-border">
        {page.visible.map((item) => <TimelineRow key={item.id} item={item} />)}
      </ol>
      <ShowMore remaining={page.remaining} unit="篇" onMore={page.more} />
    </Section>
  );
}

/** Reports in a group or on the timeline before 「显示更多」: twenty keep a hot event's page within six phone windows (thirty drew
 * 5,209 px on a 844 px phone, 2026-10-30). */
const TIMELINE_PAGE = 20;

/**
 * 「报道时间线」: the reports cut into Beijing days, in the order the page reads them (newest day first, or oldest on 最早), each day a
 * heading with its number of reports over its rows, which say the clock they stand at. Where there is a first-hand group it holds the
 * parties' own texts and this holds the rest; the filter, when the page has one, is the first group's. Like a group, nothing at all with
 * no rows unless it carries the filter.
 */
function ReportTimeline({ rows, toolbar }: { rows: Array<FrontierItem & { role: FrontierEventRole }>; toolbar?: ReactNode }) {
  // A hot event gathers a hundred reports and more: the timeline reads a page at a time (a 6,455 px page on production, 2026-10-30),
  // back to its first page when the order or the source filter changes what heads it.
  const page = useShowMore(rows, { first: TIMELINE_PAGE, step: TIMELINE_PAGE, resetKey: `${rows.length}:${rows[0]?.id ?? ""}` });
  if (rows.length === 0 && !toolbar) return null;
  return (
    <Section title="报道时间线" count={rows.length} toolbar={toolbar} className="mt-0">
      <div data-event-timeline="">
        {groupByDay(page.visible).map((day) => <TimelineDay key={day.key} day={day} />)}
      </div>
      <ShowMore remaining={page.remaining} unit="篇" onMore={page.more} />
    </Section>
  );
}

/**
 * One Beijing day of the timeline: its label (in the page's own 14 / 400, the heading level under the timeline's) and how many reports it
 * holds, over its rows.
 */
function TimelineDay({ day }: { day: ItemDay<FrontierItem & { role: FrontierEventRole }> }) {
  const headingId = useId();
  const label = dayHeading(day, false);
  return (
    <section aria-labelledby={headingId} className="mt-6 first:mt-0">
      <h3 id={headingId} className="mb-1 flex items-baseline gap-2 text-ui text-text">
        {label}
        <span className="text-caption tabular-nums text-text-3">{day.items.length} 篇</span>
      </h3>
      <ol aria-label={`${label}的报道`} className="ml-1 border-l border-border">
        {day.items.map((item) => <TimelineRow key={item.id} item={item} clock />)}
      </ol>
    </section>
  );
}

/**
 * One report on the timeline: a dot on the line — filled for the parties' own
 * texts (a paper, a notice, a label), hollow for a report — its title, and
 * who said it, what kind of source that is, when, and the link to it. On a
 * day's list `when` is the clock it stands at in Beijing time (the day is the
 * heading above it, and a source that stated no hour has none to show);
 * elsewhere, how long ago.
 */
function TimelineRow({ item, clock = false }: { item: FrontierItem & { role: FrontierEventRole }; clock?: boolean }) {
  const primary = item.role === "primary";
  const origin = useFrontierOrigin();
  const location = useLocation();
  const when = clock ? itemClock(item) : ago(item.timelineAt);
  return (
    <li className="relative py-2 pl-5">
      <span aria-hidden="true" className={cn("absolute -left-[5px] top-3.5 h-2.5 w-2.5 rounded-full", primary ? "bg-accent" : "bg-bg ring-1 ring-inset ring-border-control")} />
      <p className="text-ui text-text">{primary && <span className="sr-only">一手来源：</span>}<Link to={`/app/frontier/items/${encodeURIComponent(item.id)}`} state={{ ...origin, evidenceFrom: { to: `${location.pathname}${location.search}`, label: "事件报道" } }} onClick={rememberFrontierPosition} className="hover:text-accent hover:underline">{item.title}</Link></p>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-caption text-text-3">
        <span>{item.source.name}</span>
        {item.sourceTypeLabel && <><span aria-hidden="true">·</span><span>{item.sourceTypeLabel}</span></>}
        {when && <><span aria-hidden="true">·</span><span className={clock ? "tabular-nums" : undefined}>{when}</span></>}
        <span aria-hidden="true">·</span>
        <a href={item.url} {...EXTERNAL} className={cn(INLINE_ACTION, "-ml-1 px-1 text-accent")}>
          <span className="text-caption">原文<span aria-hidden="true"> ↗</span></span>
        </a>
      </div>
    </li>
  );
}
