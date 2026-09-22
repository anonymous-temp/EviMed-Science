import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { CalendarClock, Microscope, SearchX } from "lucide-react";
import { WebApiError } from "@/lib/apiClient";
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
import { FrontierSkeleton } from "@/components/cards/Skeletons";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageTitle } from "@/components/layout/PageTitle";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { FrontierChip } from "@/components/frontier/FrontierChip";
import { FrontierOffPage } from "@/components/frontier/FrontierStates";
import { ago, clockOrDate, eventResearchDraft, itemWhen, sourceTypeTone } from "@/components/frontier/frontierText";

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

type TimelineFilter = "all" | "primary" | "selected";

/**
 * One event (plan §4.4): what is known so far, the latest turn, the parties'
 * own texts ahead of any report, every report on one timeline, and the events
 * it follows from or leads to.
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
  return <EventView eventId={eventId} ready={feature !== "loading"} />;
}

function EventView({ eventId, ready }: { eventId: string; ready: boolean }) {
  const navigate = useNavigate();
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
        if (event.id !== eventId) navigate(`/app/frontier/events/${encodeURIComponent(event.id)}`, { replace: true });
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
  }, [eventId, ready, attempt, navigate]);

  if (state.kind === "off") return <FrontierOffPage />;
  if (state.kind !== "ready") {
    return (
      <EventFrame title="事件">
        {state.kind === "loading" && <FrontierSkeleton />}
        {state.kind === "error" && <LoadError message={state.message} onRetry={() => setAttempt((value) => value + 1)} />}
        {state.kind === "not-offered" && (
          <EmptyState icon={CalendarClock} title="事件页还在准备" className="rounded-card border border-dashed border-border"
            description="多个来源报道同一件事时，这里会把论文、公告和报道合成一条时间线。"
            action={<Link to="/app/frontier" className="text-ui text-link hover:underline">回到前沿动态</Link>} />
        )}
        {state.kind === "missing" && (
          <EmptyState icon={SearchX} title="这个事件已不存在" className="rounded-card border border-dashed border-border"
            description="它可能已被撤下。"
            action={<Link to="/app/frontier?view=hot" className="text-ui text-link hover:underline">看热点</Link>} />
        )}
      </EventFrame>
    );
  }
  return <EventBody event={state.event} />;
}

/** The page's container and breadcrumb, shared by every state of it. */
function EventFrame({ title, description, actions, children }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="h-full min-h-0 overflow-y-auto bg-bg">
      <PageTitle page={title} section="前沿动态" />
      <div className="mx-auto w-full max-w-content-wide space-y-6 px-6 py-6">
        <nav aria-label="位置" className="flex items-center gap-1.5 text-caption text-muted">
          <Link to="/app/frontier" className="hover:text-text hover:underline">前沿动态</Link>
          <span aria-hidden="true">›</span>
          <Link to="/app/frontier?view=hot" className="hover:text-text hover:underline">热点</Link>
          <span aria-hidden="true">›</span>
          <span aria-current="page">事件</span>
        </nav>
        <PageHeader title={title} description={description} actions={actions} />
        {children}
      </div>
    </div>
  );
}

function EventBody({ event }: { event: FrontierEvent }) {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const primary = event.items.filter((item) => item.role === "primary");
  const timeline = useMemo(() => [...event.items]
    .sort((a, b) => Date.parse(b.timelineAt) - Date.parse(a.timelineAt)), [event.items]);
  const shown = timeline.filter((item) => filter === "all" || (filter === "primary" ? item.role === "primary" : item.selected));
  const research = () => navigate("/app/chat", { state: { runtimeUiIntent: newRuntimeUiIntent(eventResearchDraft(event)) } });

  const meta = [
    event.firstAt ? `最早 ${clockOrDate(event.firstAt)}` : null,
    event.lastAt ? `最近更新 ${ago(event.lastAt)}` : null,
  ].filter(Boolean).join(" · ");

  // The event's state and its three quantities sit where a page's one line
  // under the title goes: they are what this page is about at a glance.
  const facts = (
    <span className="flex flex-wrap items-center gap-2 text-caption">
      <FrontierChip tone={event.status === "developing" ? "accent" : "neutral"}>{event.status === "developing" ? "仍在发展" : "已收束"}</FrontierChip>
      <FrontierChip>{event.reportCount} 篇报道</FrontierChip>
      <FrontierChip>近 72 小时 {event.sourceCount72h} 个来源</FrontierChip>
      {event.specialties.map((specialty) => <FrontierChip key={specialty.key}>{specialty.label}</FrontierChip>)}
      {event.laneLabel && <FrontierChip>{event.laneLabel}</FrontierChip>}
      {meta && <span>{meta}</span>}
    </span>
  );

  return (
    <EventFrame
      title={event.title}
      description={facts}
      actions={<Button onClick={research}><Microscope size={14} aria-hidden="true" />深入研究这个事件</Button>}
    >
      <div className="flex flex-col gap-6 xl:flex-row xl:items-start">
        <div className="min-w-0 flex-1 space-y-4">
          <Card title="先了解这件事" hint="由多篇报道综合，随事件更新；与早先说法矛盾的地方会标出">
            {event.digest ? <p className="whitespace-pre-line text-ui text-text">{event.digest}</p> : <p className="text-ui text-muted">暂无综述</p>}
            {event.latest && (
              <p className="mt-3 rounded bg-accent-soft px-3 py-2 text-ui text-text">
                <span className="mr-2 font-medium text-accent-strong">最新进展{event.latest.at ? ` · ${ago(event.latest.at)}` : ""}</span>
                {event.latest.text}
              </p>
            )}
          </Card>
          <Card title="一手来源" hint="当事方自己的说法，排在媒体报道之前">
            {primary.length === 0 ? <p className="text-ui text-muted">这件事还没有收到论文、公告或说明书原文，下面的时间线都是报道。</p> : (
              <ul className="divide-y divide-faint">
                {primary.map((item) => <PrimaryRow key={item.id} item={item} />)}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-4 xl:w-80 xl:shrink-0">
          <Card title="报道时间线" hint="最新在前">
            <SegmentedControl<TimelineFilter>
              aria-label="时间线筛选"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: `全部 ${timeline.length}` },
                { value: "primary", label: `一手 ${primary.length}` },
                { value: "selected", label: `精选 ${timeline.filter((item) => item.selected).length}` },
              ]}
            />
            {shown.length === 0 ? <p className="mt-3 text-ui text-muted">这一类还没有。</p> : (
              <ol className="ml-1.5 mt-3 space-y-3 border-l border-border pl-4">
                {shown.map((item) => <TimelineRow key={item.id} item={item} />)}
              </ol>
            )}
          </Card>
          {event.related.length > 0 && (
            <Card title="相关事件">
              <ul className="divide-y divide-faint">
                {event.related.map((related) => (
                  <li key={`${related.relation}-${related.id}`} className="py-2 first:pt-0">
                    <p className="text-caption text-muted">{RELATION_WORDS[related.relation] ?? "相关"}{related.at ? ` · ${clockOrDate(related.at)}` : ""}</p>
                    <Link to={`/app/frontier/events/${encodeURIComponent(related.id)}`} className="text-ui text-text hover:underline">{related.title}</Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </EventFrame>
  );
}

function PrimaryRow({ item }: { item: FrontierItem }) {
  return (
    <li className="flex gap-3 py-2 first:pt-0">
      {item.sourceTypeLabel && <FrontierChip tone={sourceTypeTone(item.sourceType)} className="mt-0.5">{item.sourceTypeLabel}</FrontierChip>}
      <div className="min-w-0">
        <p className="text-ui text-text"><span className="font-medium">{item.source.name}</span> · {item.title}</p>
        <p className="flex flex-wrap items-center gap-x-2 text-caption text-muted">
          <span>{itemWhen(item)}</span>
          {item.evidenceTypeLabel && <FrontierChip tone="outline">{item.evidenceTypeLabel}</FrontierChip>}
          <a href={item.url} target="_blank" rel="noopener noreferrer" className="text-link hover:underline">原文<span aria-hidden="true"> ↗</span></a>
        </p>
      </div>
    </li>
  );
}

function TimelineRow({ item }: { item: FrontierItem & { role: FrontierEventRole } }) {
  return (
    <li className="relative">
      {/* The dot sits on the line: the list's own left border. */}
      <span aria-hidden="true" className={`absolute -left-4 top-1.5 h-2.5 w-2.5 -translate-x-1/2 rounded-full border-2 border-accent ${item.role === "primary" ? "bg-accent" : "bg-surface"}`} />
      <p className="flex flex-wrap items-center gap-x-1.5 text-caption text-muted">
        <span>{itemWhen(item)} · {item.source.name}</span>
        {item.sourceTypeLabel && <FrontierChip tone={sourceTypeTone(item.sourceType)}>{item.sourceTypeLabel}</FrontierChip>}
      </p>
      <a href={item.url} target="_blank" rel="noopener noreferrer" className="text-ui font-medium text-text hover:underline">{item.title}</a>
    </li>
  );
}
