import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { CalendarClock, ChevronLeft, SearchX } from "lucide-react";
import { WebApiError } from "@/lib/apiClient";
import { cn } from "@/lib/cn";
import {
  fetchFrontierEvent,
  frontierAbsence,
  frontierErrorMessage,
  useFrontierFeature,
  type FrontierEvent,
  type FrontierEventRole,
  type FrontierItem,
} from "@/lib/frontierClient";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button, buttonClasses } from "@/components/ui/Button";
import { FilterSelect } from "@/components/ui/FilterChips";
import { Tag } from "@/components/ui/Tag";
import { FrontierSkeleton } from "@/components/frontier/FrontierSkeleton";
import { FrontierOffPage } from "@/components/frontier/FrontierStates";
import { Sparkline } from "@/components/frontier/Sparkline";
import {
  EXTERNAL,
  INLINE_ACTION,
  ago,
  dateClock,
  eventResearchDraft,
  institutionsLine,
  primaryHeld,
  updatedText,
} from "@/components/frontier/frontierText";

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
 * rest as 「其他报道」, newest first — or, where nobody's own text is among them,
 * one line that says so; from ten reports on a menu narrows them to one kind
 * of source; and on the right the heat, its 72-hour trend, the institutions
 * by kind, the first report and whether first-hand material is among the
 * reports. No card explains itself.
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

function EventView({ eventId, ready }: { eventId: string; ready: boolean }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [state, setState] = useState<EventState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!ready) return;
    let active = true;
    setState({ kind: "loading" });
    fetchFrontierEvent(eventId).then(
      (event) => {
        if (!active) return;
        setState({ kind: "ready", event });
        if (event.id !== eventId) navigate(`/app/frontier/events/${encodeURIComponent(event.id)}`, { replace: true, state: location.state });
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
  }, [eventId, ready, attempt, navigate, location.state]);

  if (state.kind === "off") return <FrontierOffPage />;
  if (state.kind !== "ready") {
    return (
      <EventFrame title="事件">
        <div className="mt-6">
          {state.kind === "loading" && <FrontierSkeleton />}
          {state.kind === "error" && <LoadError message={state.message} onRetry={() => setAttempt((value) => value + 1)} />}
          {state.kind === "not-offered" && (
            <EmptyState icon={CalendarClock} title="事件页还在准备"
              action={<Link to="/app/frontier" className={buttonClasses({ variant: "secondary" })}>回到前沿动态</Link>} />
          )}
          {state.kind === "missing" && (
            <EmptyState icon={SearchX} title="这个事件已不存在"
              action={<Link to="/app/frontier?view=hot" className={buttonClasses({ variant: "secondary" })}>看热榜</Link>} />
          )}
        </div>
      </EventFrame>
    );
  }
  return <EventBody event={state.event} />;
}

/** The page's column, its way back and its one-line header, shared by every state of it. */
function EventFrame({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const origin = (location.state as { frontierOrigin?: string } | null)?.frontierOrigin;
  const fromReader = origin === "/app/frontier" || (typeof origin === "string" && origin.startsWith("/app/frontier?"));
  return (
    <div className="h-full min-h-0 overflow-y-auto bg-bg">
      <div className="mx-auto w-full max-w-page px-6 py-6">
        <nav aria-label="返回">
          <Link to={fromReader ? origin! : "/app/frontier"} onClick={fromReader ? (event) => { event.preventDefault(); navigate(-1); } : undefined} className={cn(INLINE_ACTION, "-ml-1.5 gap-1 px-1.5 text-text-3 hover:text-text")}>
            <ChevronLeft size={16} aria-hidden="true" />前沿动态
          </Link>
        </nav>
        <PageHeader className="mt-2" title={title} documentTitle={`${title} · 前沿动态`} actions={actions} />
        {children}
      </div>
    </div>
  );
}

function EventBody({ event }: { event: FrontierEvent }) {
  const navigate = useNavigate();
  const location = useLocation();
  const timeline = useMemo(() => [...event.items]
    .sort((a, b) => Date.parse(b.timelineAt) - Date.parse(a.timelineAt)), [event.items]);
  const research = () => navigate("/app/chat", { state: { runtimeUiIntent: newRuntimeUiIntent(eventResearchDraft(event)) } });
  // From ten reports on, a kind of source narrows the list: the kinds the rows already name, in the order they first appear.
  const [sourceType, setSourceType] = useState<string | null>(null);
  const sourceTypes = useMemo(() => [...new Set(timeline.flatMap((item) => (item.sourceTypeLabel ? [item.sourceTypeLabel] : [])))], [timeline]);
  const visible = sourceType ? timeline.filter((item) => item.sourceTypeLabel === sourceType) : timeline;
  const firstHand = timeline.some((item) => item.role === "primary");
  const institutions = institutionsLine(event);
  const specialty = event.specialties[0] ?? null;
  const updated = ago(event.lastAt);
  const heat = event.heat ?? null;

  return (
    <EventFrame title={event.title} actions={<Button onClick={research}>深入研究</Button>}>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-text-3">
        {event.sourceCount72h > 0 && <span>{event.sourceCount72h} 家机构报道</span>}
        {event.sourceCount72h > 0 && updated && <span aria-hidden="true">·</span>}
        {updated && <span>{updatedText(updated)}</span>}
        {specialty && <Tag className="ml-1">{specialty.label}</Tag>}
      </div>

      <div className="mt-6 flex flex-col gap-10 lg:flex-row lg:items-start lg:gap-12">
        <div className="min-w-0 flex-1 space-y-8">
          <section aria-labelledby="event-digest">
            <h2 id="event-digest" className="text-ui font-semibold text-text">概要</h2>
            <p className={cn("mt-2 max-w-measure whitespace-pre-line text-ui", event.digest ? "text-text" : "text-text-3")}>{event.digest ?? "暂无综述"}</p>
            {event.latest && (
              <p className="mt-3 max-w-measure text-ui text-text-2">
                <span className="mr-1.5 font-medium text-accent">最新</span>
                {event.latest.text}
                {event.latest.at && <span className="text-text-3"> · {ago(event.latest.at)}</span>}
              </p>
            )}
          </section>

          {timeline.length >= 10 && sourceTypes.length > 1 && (
            <div>
              <FilterSelect label="全部来源" allLabel="全部来源" value={sourceType}
                options={sourceTypes.map((label) => ({ value: label, label }))} onChange={setSourceType} />
            </div>
          )}
          {firstHand ? (
            <>
              <ReportGroup id="event-primary" title="一手材料" rows={visible.filter((item) => item.role === "primary")} />
              <ReportGroup id="event-reports" title="其他报道" rows={visible.filter((item) => item.role !== "primary")} />
            </>
          ) : <ReportGroup id="event-reports" title="报道" rows={visible} note="暂无一手材料，以下均为转述报道。" />}

          {event.related.length > 0 && (
            <section aria-labelledby="event-related">
              <h2 id="event-related" className="text-ui font-semibold text-text">相关事件</h2>
              <ul className="mt-2 space-y-2">
                {event.related.map((related) => (
                  <li key={`${related.relation}-${related.id}`}>
                    <Link state={location.state} replace to={`/app/frontier/events/${encodeURIComponent(related.id)}`} className="text-ui text-text hover:text-accent">{related.title}</Link>
                    <p className="text-caption text-text-3">{RELATION_WORDS[related.relation] ?? "相关"}{related.at ? ` · ${dateClock(related.at)}` : ""}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <aside aria-label="热度与来源" className="w-full shrink-0 lg:w-60">
          {heat !== null && (
            <div className="mb-4">
              <p className="flex items-baseline gap-1">
                <span className="text-display font-semibold tabular-nums text-text">{heat}</span>
                <span className="text-caption text-text-3">热度</span>
              </p>
              <Sparkline points={event.trend} width={120} height={32} className="mt-2" />
            </div>
          )}
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-ui">
            {institutions && <><dt className="text-text-3">机构</dt><dd className="text-text">{institutions}</dd></>}
            {event.firstAt && <><dt className="text-text-3">首报</dt><dd className="tabular-nums text-text">{dateClock(event.firstAt)}</dd></>}
            <dt className="text-text-3">一手材料</dt><dd className="text-text">{primaryHeld(event)}</dd>
          </dl>
        </aside>
      </div>
    </EventFrame>
  );
}

/** A group of reports: its heading and count, the line that explains an absence, then the rows — nothing at all with no rows and no line. */
function ReportGroup({ id, title, rows, note }: { id: string; title: string; rows: Array<FrontierItem & { role: FrontierEventRole }>; note?: string }) {
  if (rows.length === 0 && !note) return null;
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="flex items-baseline gap-2">
        <span className="text-ui font-semibold text-text">{title}</span>
        <span className="text-caption tabular-nums text-text-3">{rows.length}</span>
      </h2>
      {note && <p className="mt-2 text-ui text-text-3">{note}</p>}
      <ol aria-label={title} className="ml-1 mt-2 border-l border-border">
        {rows.map((item) => <TimelineRow key={item.id} item={item} />)}
      </ol>
    </section>
  );
}

/**
 * One report on the timeline: a dot on the line — filled for the parties' own
 * texts (a paper, a notice, a label), hollow for a report — its title, and
 * who said it, what kind of source that is, when, and the link to it.
 */
function TimelineRow({ item }: { item: FrontierItem & { role: FrontierEventRole } }) {
  const primary = item.role === "primary";
  return (
    <li className="relative py-2 pl-5">
      <span aria-hidden="true" className={cn("absolute -left-[5px] top-3.5 h-2.5 w-2.5 rounded-full", primary ? "bg-accent" : "bg-bg ring-1 ring-inset ring-border-control")} />
      <p className="text-ui font-medium text-text">{primary && <span className="sr-only">一手来源：</span>}<a href={item.url} {...EXTERNAL} className="hover:text-accent hover:underline">{item.title}</a></p>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-caption text-text-3">
        <span>{item.source.name}</span>
        {item.sourceTypeLabel && <><span aria-hidden="true">·</span><span>{item.sourceTypeLabel}</span></>}
        <span aria-hidden="true">·</span>
        <span>{ago(item.timelineAt)}</span>
        <span aria-hidden="true">·</span>
        <a href={item.url} {...EXTERNAL} className={cn(INLINE_ACTION, "-ml-1 px-1 text-accent")}>
          <span className="text-caption">原文<span aria-hidden="true"> ↗</span></span>
        </a>
      </div>
    </li>
  );
}
