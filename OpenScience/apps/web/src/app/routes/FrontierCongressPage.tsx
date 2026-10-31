import { rememberFrontierPosition, useFrontierOrigin } from "@/components/frontier/frontierReadingState";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { CalendarClock, ChevronLeft, SearchX } from "lucide-react";
import { WebApiError } from "@/lib/apiClient";
import { cn } from "@/lib/cn";
import {
  addFrontierFollow,
  fetchFrontierCongress,
  frontierAbsence,
  frontierErrorMessage,
  hideFrontierItem,
  starFrontierItem,
  unstarFrontierItem,
  useFrontierFeature,
  type FrontierCongressHub,
  type FrontierCongressRecap,
  type FrontierItem,
} from "@/lib/frontierClient";
import { serveFrontierList } from "@/lib/frontierTracking";
import { toast } from "@/lib/toast";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { PageShell } from "@/components/layout/PageShell";
import { PageTitle } from "@/components/layout/PageTitle";
import { Button, buttonClasses } from "@/components/ui/Button";
import { StateScreen } from "@/components/ui/StateScreen";
import { Tag } from "@/components/ui/Tag";
import { useShowMore, ShowMore } from "@/components/ui/ShowMore";
import { FrontierCard } from "@/components/frontier/FrontierCard";
import { ReaderOutline } from "@/components/frontier/FrontierReader";
import { FrontierSkeleton } from "@/components/frontier/FrontierSkeleton";
import { FrontierOffPage } from "@/components/frontier/FrontierStates";
import { congressDates, monthDay } from "@/components/frontier/FrontierTrackView";
import { EXTERNAL, INLINE_ACTION, shortDate } from "@/components/frontier/frontierText";
import { overviewParts } from "@/app/routes/FrontierTopicPage";

type HubState =
  | { kind: "loading" }
  | { kind: "ready"; hub: FrontierCongressHub }
  | { kind: "not-offered" }
  | { kind: "missing" }
  | { kind: "off" }
  | { kind: "error"; message: string };

const articlePath = (id: string) => `/app/frontier/items/${encodeURIComponent(id)}`;
/** Where the congress list is, the page's way back. */
const LIST_PATH = "/app/frontier?view=track&segment=congresses";
/** A day shows this many items first; the rest are one press away. */
const DAY_FIRST = 10;
const DAY_STEP = 20;
/** A hub of this many days or more has its days as contents (a day is up to ten items and its 速递 before 「显示更多」). */
const OUTLINE_FROM_DAYS = 2;
/** A day's heading, which the contents go to. */
const dayHeadingId = (day: string) => `congress-day-${day}`;
/** The items a day shows: a card the reader said 不感兴趣 to leaves the day, as on the topic page. */
const dayRows = (day: FrontierCongressHub["days"][number]) => day.items.filter(({ item }) => !item.state.hidden);

const STATUS_WORDS: Record<string, string> = { ongoing: "进行中", upcoming: "即将召开", recent: "已结束", later: "尚未开始", past: "已结束" };

/**
 * One congress's hub (c3-track 2026-10-25): an addressed reading page in the frontier's frame. Its days, newest first, each with a
 * 「AI 速递」 — three to six sentences written only from that day's best items, every fact marked with the item it came from — and
 * then the day's items, the selected ones first, as the feed's own cards, a conference result with the design caveat its 速读 gives.
 * A congress that has not opened says when and what will appear; one with nothing says so with a way on.
 */
export function FrontierCongressPage() {
  const feature = useFrontierFeature();
  const { congressId = "" } = useParams();
  if (feature === "off") return <FrontierOffPage />;
  return <CongressView key={congressId} congressId={congressId} ready={feature !== "loading"} />;
}

function CongressView({ congressId, ready }: { congressId: string; ready: boolean }) {
  const [state, setState] = useState<HubState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!ready) return;
    let active = true;
    fetchFrontierCongress(congressId).then(
      (hub) => {
        if (!active) return;
        serveFrontierList("congress", hub.listId, hub.days.flatMap((entry) => entry.items.map((row) => ({ id: row.item.id, slot: null }))));
        setState({ kind: "ready", hub });
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
  }, [congressId, ready, attempt]);

  if (state.kind === "off") return <FrontierOffPage />;
  if (state.kind === "not-offered") {
    return (
      <StateScreen icon={CalendarClock} title="会议追踪还在准备" titleAs="h1" back={{ to: "/app/frontier", label: "回到前沿动态" }}>
        <PageTitle page="会议" />
      </StateScreen>
    );
  }
  if (state.kind === "missing") {
    return (
      <StateScreen icon={SearchX} title="没有这个会议" titleAs="h1"
        action={<Link to={LIST_PATH} className={buttonClasses({ variant: "secondary" })}>看会议日历</Link>}
        back={{ to: "/app/frontier", label: "回到前沿动态" }}>
        <PageTitle page="会议" />
      </StateScreen>
    );
  }
  if (state.kind !== "ready") {
    return (
      <HubFrame title="学术会议">
        {state.kind === "loading" && <FrontierSkeleton />}
        {state.kind === "error" && <LoadError message={state.message} onRetry={() => setAttempt((value) => value + 1)} />}
      </HubFrame>
    );
  }
  return <HubBody hub={state.hub} onItem={(item) => setState((current) => current.kind !== "ready" ? current : {
    kind: "ready", hub: { ...current.hub, days: current.hub.days.map((entry) => ({ ...entry, items: entry.items.map((row) => (row.item.id === item.id ? { ...row, item } : row)) })) } })} />;
}

/** The page's column, its way back (to where the reader came from, else the congress list) and its header. */
function HubFrame({ title, facts, children }: { title: string; facts?: ReactNode; children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const origin = (location.state as { frontierOrigin?: string } | null)?.frontierOrigin;
  const fromReader = origin === "/app/frontier" || (typeof origin === "string" && origin.startsWith("/app/frontier?"));
  return (
    <PageShell
      title={title}
      documentTitle={`${title} · 前沿动态`}
      titleVariant="document"
      width="read"
      back={(
        <nav aria-label="返回">
          <Link to={fromReader ? origin! : LIST_PATH} onClick={fromReader ? (event) => { event.preventDefault(); navigate(-1); } : undefined}
            className={cn(INLINE_ACTION, "-ml-1.5 gap-1 px-1.5 text-text-3 hover:text-text")}>
            <ChevronLeft size={16} aria-hidden="true" />前沿动态
          </Link>
        </nav>
      )}
      contentClassName={facts ? "mt-1.5" : undefined}
    >
      {facts}
      {children}
    </PageShell>
  );
}

function HubBody({ hub, onItem }: { hub: FrontierCongressHub; onItem: (item: FrontierItem) => void }) {
  const { congress, days } = hub;
  const update = async (item: FrontierItem, action: "star" | "hide") => {
    try {
      const state = await (action === "hide" ? hideFrontierItem(item.id) : item.state.starred ? unstarFrontierItem(item.id) : starFrontierItem(item.id));
      onItem({ ...item, state });
    } catch (caught) { toast.error(frontierErrorMessage(caught)); }
  };
  const heading = congress.name && congress.name !== congress.code ? `${congress.code} · ${congress.name}` : congress.code;
  const shown = days.filter((entry) => entry.items.length > 0 || entry.recap);
  // The days are the page's contents (DESIGN.md T5: a long reading page has an outline): folded above them at every width, because the
  // reading column has no room for a column beside it; each day a press away. A congress of a week ran to 17 windows with none (release
  // walk of evimed-b559d4b7ebd0-1).
  const outline = shown.length >= OUTLINE_FROM_DAYS ? shown.map((entry) => {
    const count = dayRows(entry).length;
    return { id: dayHeadingId(entry.day), text: count > 0 ? `${shortDate(entry.day)} · ${count} 条` : shortDate(entry.day), level: 2 as const };
  }) : [];
  return (
    <HubFrame
      title={heading}
      facts={(
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-text-3">
          <Tag tone={congress.status === "ongoing" ? "accent" : "neutral"}>{STATUS_WORDS[congress.status] ?? "学术会议"}</Tag>
          <span className="tabular-nums">{congressDates(congress.start, congress.end)}</span>
          {congress.city && <><span aria-hidden="true">·</span><span>{congress.city}</span></>}
          {congress.specialtyLabel && <><span aria-hidden="true">·</span><span>{congress.specialtyLabel}</span></>}
          {/* The congress's own count, the one its list line says (owner, 2026-10-27: this said 400 where that said 624); where the
            * hub lists fewer than it holds, it says which. */}
          {hub.itemCount > 0 && <><span aria-hidden="true">·</span><span className="tabular-nums">
            {hub.listedCount < hub.itemCount ? `收录 ${hub.itemCount} 条，显示最新 ${hub.listedCount} 条` : `收录 ${hub.itemCount} 条`}
          </span></>}
          {congress.sourceUrl && <a href={congress.sourceUrl} {...EXTERNAL} className="text-link hover:underline">会议信息<span aria-hidden="true"> ↗</span></a>}
        </div>
      )}
    >
      {outline.length > 0 && <div className="mt-6"><ReaderOutline entries={outline} layout="folded" /></div>}
      <div data-frontier-list="congress" className="mt-6 space-y-8">
        {shown.length === 0 ? <CongressEmpty hub={hub} /> : shown.map((entry) => (
          <DaySection key={entry.day} day={entry} onStar={(item) => void update(item, "star")} onHide={(item) => void update(item, "hide")} />
        ))}
      </div>
    </HubFrame>
  );
}

/** A congress with nothing yet: when it opens, or that nothing was found, and the two ways on. */
function CongressEmpty({ hub }: { hub: FrontierCongressHub }) {
  const { congress } = hub;
  const [following, setFollowing] = useState(false);
  const follow = async () => {
    setFollowing(true);
    try {
      await addFrontierFollow({ kind: "topic", key: congress.code, label: congress.code });
      toast.success(`已关注“${congress.code}”`);
    } catch (caught) {
      toast.error(frontierErrorMessage(caught));
      setFollowing(false);
    }
  };
  const upcoming = congress.status === "upcoming" || congress.status === "later";
  const action = (
    <div className="flex flex-wrap items-center justify-center gap-3">
      <Button variant="secondary" disabled={following} onClick={() => void follow()}>{following ? "已关注" : `关注“${congress.code}”`}</Button>
      <Link to={LIST_PATH} className={buttonClasses({ variant: "text" })}>看会议日历</Link>
    </div>
  );
  return upcoming
    ? <EmptyState icon={CalendarClock} title={`${congress.code} 将于 ${monthDay(congress.start)} 开幕`} description="开幕后，这里按天列出会议上公布的研究，并写一段当天速递。" action={action} />
    : <EmptyState icon={SearchX} title={`还没有收录到 ${congress.code} 的报道`} description="会议期间公布的研究会陆续出现在这里。" action={action} />;
}

/** One day: its heading, its recap, its items (the first few, the rest on demand). */
function DaySection({ day, onStar, onHide }: { day: FrontierCongressHub["days"][number]; onStar: (item: FrontierItem) => void; onHide: (item: FrontierItem) => void }) {
  const rows = dayRows(day);
  const more = useShowMore(rows, { first: DAY_FIRST, step: DAY_STEP, resetKey: day.day });
  const headingId = dayHeadingId(day.day);
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="mb-3 flex min-w-0 items-baseline gap-2 text-section font-semibold text-text">
        {shortDate(day.day)}
        {rows.length > 0 && <span className="text-caption font-normal tabular-nums text-text-3">{rows.length} 条</span>}
      </h2>
      {day.recap && <DayRecap recap={day.recap} />}
      {rows.length > 0 && (
        <ul aria-label={`${shortDate(day.day)}的报道`}>
          {more.visible.map(({ item, caveat }) => (
            <FrontierCard key={item.id} item={item} onStar={onStar} onHide={onHide}
              note={caveat ? <p data-prose="" className="mt-1 text-caption text-text-3">设计与局限：{caveat}</p> : undefined} />
          ))}
        </ul>
      )}
      <ShowMore remaining={more.remaining} unit="条" onMore={more.more} />
    </section>
  );
}

/** 「AI 速递」: labelled in the accent like the topic's overview; each fact's mark opens the item it came from. */
function DayRecap({ recap }: { recap: FrontierCongressRecap }) {
  const origin = useFrontierOrigin();
  const parts = overviewParts(recap.text, recap.refs);
  return (
    <div className="mb-4">
      <p className="mb-1 text-caption text-accent">AI 速递</p>
      <p data-prose="" className="max-w-measure-body whitespace-pre-line break-words text-reading text-text">
        {parts.map((part, index) => (typeof part === "string" ? part : (
          <sup key={index} className="text-caption leading-none">
            <Link to={articlePath(part.itemId)} state={origin} onClick={rememberFrontierPosition} aria-label={part.title}
              className="inline-block rounded px-px leading-none tabular-nums text-link hover:underline">[{part.n}]</Link>
          </sup>
        )))}
      </p>
    </div>
  );
}
