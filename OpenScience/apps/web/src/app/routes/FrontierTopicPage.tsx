import { rememberFrontierPosition, useFrontierOrigin } from "@/components/frontier/frontierReadingState";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { CalendarClock, ChevronLeft, SearchX } from "lucide-react";
import { WebApiError } from "@/lib/apiClient";
import { cn } from "@/lib/cn";
import {
  fetchFrontierTopic,
  frontierAbsence,
  frontierErrorMessage,
  hideFrontierItem,
  starFrontierItem,
  unstarFrontierItem,
  useFrontierFeature,
  type FrontierItem,
  type FrontierTopicPage as FrontierTopicPageData,
  type FrontierTopicRole,
  type FrontierTopicSummary,
} from "@/lib/frontierClient";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { toast } from "@/lib/toast";
import { LoadError } from "@/components/cards/LoadError";
import { PageShell } from "@/components/layout/PageShell";
import { PageTitle } from "@/components/layout/PageTitle";
import { Button, buttonClasses } from "@/components/ui/Button";
import { List, ListRow } from "@/components/ui/ListRow";
import { Section } from "@/components/ui/Section";
import { StateScreen } from "@/components/ui/StateScreen";
import { Tag } from "@/components/ui/Tag";
import { FrontierCard } from "@/components/frontier/FrontierCard";
import { FrontierSkeleton } from "@/components/frontier/FrontierSkeleton";
import { FrontierOffPage } from "@/components/frontier/FrontierStates";
import { EXTERNAL, INLINE_ACTION, ago, topicAskDraft } from "@/components/frontier/frontierText";

type TopicState =
  | { kind: "loading" }
  | { kind: "ready"; page: FrontierTopicPageData }
  | { kind: "not-offered" }
  | { kind: "missing" }
  | { kind: "off" }
  | { kind: "error"; message: string };

/** The topic's groups, in reading order: what was reported, the evidence, then the background. */
const GROUPS: ReadonlyArray<{ role: FrontierTopicRole; title: string }> = [
  { role: "report", title: "各方报道" },
  { role: "evidence", title: "研究证据" },
  { role: "background", title: "背景资料" },
];

const articlePath = (id: string) => `/app/frontier/items/${encodeURIComponent(id)}`;

/**
 * One hot-event topic (c2-leads 2026-10-25, contract §T): the general medical question a public event raised, as its title; the
 * event in one line with where it was said; the 「AI 概览」 — one paragraph written only from the topic's items, each fact marked
 * with the item it came from, each mark opening that item — then the items themselves, the feed's own cards, grouped 各方报道 ·
 * 研究证据 · 背景资料, and 「查看证据卡片」 when the platform answered the question with an official evidence card. The way back
 * returns to the list where the reader was.
 */
export function FrontierTopicPage() {
  const feature = useFrontierFeature();
  const { topicId = "" } = useParams();
  if (feature === "off") return <FrontierOffPage />;
  return <TopicView key={topicId} topicId={topicId} ready={feature !== "loading"} />;
}

function TopicView({ topicId, ready }: { topicId: string; ready: boolean }) {
  const [state, setState] = useState<TopicState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!ready) return;
    let active = true;
    fetchFrontierTopic(topicId).then(
      (page) => { if (active) setState({ kind: "ready", page }); },
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
  }, [topicId, ready, attempt]);

  if (state.kind === "off") return <FrontierOffPage />;
  if (state.kind === "not-offered" || state.kind === "missing") {
    return state.kind === "not-offered" ? (
      <StateScreen icon={CalendarClock} title="热点话题还在准备" titleAs="h1" back={{ to: "/app/frontier", label: "回到前沿动态" }}>
        <PageTitle page="热点话题" />
      </StateScreen>
    ) : (
      <StateScreen icon={SearchX} title="这个话题已不存在" titleAs="h1"
        action={<Link to="/app/frontier?view=hot" className={buttonClasses({ variant: "secondary" })}>看热榜</Link>}
        back={{ to: "/app/frontier", label: "回到前沿动态" }}>
        <PageTitle page="热点话题" />
      </StateScreen>
    );
  }
  if (state.kind !== "ready") {
    return (
      <TopicFrame title="热点话题">
        {state.kind === "loading" && <FrontierSkeleton />}
        {state.kind === "error" && <LoadError message={state.message} onRetry={() => setAttempt((value) => value + 1)} />}
      </TopicFrame>
    );
  }
  return <TopicBody page={state.page} onItem={(item) => setState((current) => current.kind !== "ready" ? current
    : { kind: "ready", page: { ...current.page, items: current.page.items.map((entry) => (entry.item.id === item.id ? { ...entry, item } : entry)) } })} />;
}

/** The page's column, its way back (to the list the reader came from, at the place they left) and its one-line header. */
function TopicFrame({ title, actions, facts, children }: { title: string; actions?: ReactNode; facts?: ReactNode; children: ReactNode }) {
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
          <Link to={fromReader ? origin! : "/app/frontier?view=hot"} onClick={fromReader ? (event) => { event.preventDefault(); navigate(-1); } : undefined}
            className={cn(INLINE_ACTION, "-ml-1.5 gap-1 px-1.5 text-text-3 hover:text-text")}>
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

function TopicBody({ page, onItem }: { page: FrontierTopicPageData; onItem: (item: FrontierItem) => void }) {
  const { topic, items } = page;
  const location = useLocation();
  const navigate = useNavigate();
  const update = async (item: FrontierItem, action: "star" | "hide") => {
    try {
      const state = await (action === "hide" ? hideFrontierItem(item.id) : item.state.starred ? unstarFrontierItem(item.id) : starFrontierItem(item.id));
      onItem({ ...item, state });
    } catch (caught) { toast.error(frontierErrorMessage(caught)); }
  };
  const found = ago(topic.acceptedAt);
  // 就此提问: the topic's own question, in the composer for the reader to send or rewrite (a topic is no conversation origin).
  const ask = () => navigate("/app/chat", { state: { runtimeUiIntent: newRuntimeUiIntent(topicAskDraft(topic)) } });
  return (
    <TopicFrame
      title={topic.title}
      actions={(
        <>
          {topic.card && <Link to={topic.card.href} state={{ evidenceFrom: { to: `${location.pathname}${location.search}`, label: topic.title } }}
            className={buttonClasses({ variant: "secondary" })}>查看证据卡片</Link>}
          <Button variant="secondary" onClick={ask}>就此提问</Button>
        </>
      )}
      facts={(
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-text-3">
          <Tag>{topic.domainLabel}</Tag>
          {topic.itemCount > 0 && <span className="tabular-nums">{topic.itemCount} 篇报道与研究</span>}
          {topic.itemCount > 0 && found && <span aria-hidden="true">·</span>}
          {found && <span>{found}</span>}
        </div>
      )}
    >
      <div className="mt-6 space-y-8">
        {topic.question !== topic.title && <p data-prose="" className="max-w-measure text-ui text-text-2">{topic.question}</p>}
        {topic.peg && <TopicPeg peg={topic.peg} />}
        {topic.overview && <TopicOverview topic={topic} />}
        {GROUPS.map(({ role, title }) => {
          const rows = items.filter((entry) => entry.role === role && !entry.item.state.hidden);
          if (rows.length === 0) return null;
          return (
            <Section key={role} title={title} count={rows.length} className="mt-0">
              <ul aria-label={title}>
                {rows.map(({ item }) => <FrontierCard key={item.id} item={item} onStar={() => void update(item, "star")} onHide={() => void update(item, "hide")} />)}
              </ul>
            </Section>
          );
        })}
        {items.length === 0 && (
          // A link inside a sentence is underlined as the reader's are (`TextLink`): told from the words around it by more than its colour
          // (WCAG 1.4.1; axe's link-in-text-block on the release walk of evimed-5ae53861dc26-1).
          <p className="text-ui text-text-3">暂无报道与研究。<Link to="/app/frontier?view=all" className="rounded text-accent underline decoration-1 underline-offset-2">看全部动态</Link></p>
        )}
      </div>
    </TopicFrame>
  );
}

/** The event, in one attributed line: what was said, and where — the board's or the report's own page when it has one. */
function TopicPeg({ peg }: { peg: NonNullable<FrontierTopicSummary["peg"]> }) {
  const where = [peg.source.name, peg.source.date].filter(Boolean).join(" · ");
  return (
    <figure className="max-w-measure border-l-2 border-border pl-4">
      <blockquote data-prose="" className="text-ui text-text">{peg.text}</blockquote>
      {where && (
        <figcaption className="mt-1 text-caption text-text-3">
          {peg.source.url
            ? <a href={peg.source.url} {...EXTERNAL} className="hover:text-text hover:underline">{where}<span aria-hidden="true"> ↗</span></a>
            : where}
        </figcaption>
      )}
    </figure>
  );
}

/** A piece of the overview: its own words, or an item it cites. */
type OverviewPart = string | NonNullable<FrontierTopicSummary["overview"]>["refs"][number];

/** The overview as words and citations: a `[n]` that names one of its refs is that ref; one that names none stays words. */
export function overviewParts(text: string, refs: NonNullable<FrontierTopicSummary["overview"]>["refs"]): OverviewPart[] {
  const byNumber = new Map(refs.map((ref) => [ref.n, ref]));
  const parts: OverviewPart[] = [];
  let rest = 0;
  for (const match of text.matchAll(/\[(\d{1,2})\]/g)) {
    const ref = byNumber.get(Number(match[1]));
    if (!ref) continue;
    if (match.index > rest) parts.push(text.slice(rest, match.index));
    parts.push(ref);
    rest = match.index + match[0].length;
  }
  if (rest < text.length) parts.push(text.slice(rest));
  return parts;
}

/**
 * 「AI 概览」: labelled in the accent like the items' AI blocks; each fact's mark a small superscript link to the item it came from,
 * named by its title for a screen reader; under the paragraph the items it cites, one row each, each opening its article, whose
 * way back returns here.
 */
function TopicOverview({ topic }: { topic: FrontierTopicSummary }) {
  const origin = useFrontierOrigin();
  const location = useLocation();
  const overview = topic.overview!;
  const state = { ...origin, evidenceFrom: { to: `${location.pathname}${location.search}`, label: topic.title } };
  const parts = overviewParts(overview.text, overview.refs);
  const cited = overview.refs.filter((ref) => parts.includes(ref));
  return (
    <section aria-label="AI 概览">
      <h2 className="mb-3 text-caption text-accent">AI 概览</h2>
      <p data-prose="" className="max-w-measure-body whitespace-pre-line break-words text-reading text-text">
        {/* A citation is an inline link like the source line's: an inline-block one measured as a control of its own (the
            post-release walk of 2026-10-27 read this page at 10 kinds, one past its budget). */}
        {parts.map((part, index) => (typeof part === "string" ? part : (
          <sup key={index} className="text-caption leading-none">
            <Link to={articlePath(part.itemId)} state={state} onClick={rememberFrontierPosition} aria-label={part.title}
              className="rounded px-px leading-none tabular-nums text-link hover:underline">[{part.n}]</Link>
          </sup>
        )))}
      </p>
      {cited.length > 0 && (
        <List label="概览引用的报道与研究" className="mt-3 max-w-measure-body">
          {cited.map((ref) => (
            <ListRow key={ref.n} to={articlePath(ref.itemId)} state={state} title={ref.title}
              leading={<span className="w-5 text-caption tabular-nums text-text-3">{ref.n}</span>} meta={ref.sourceName || undefined} />
          ))}
        </List>
      )}
    </section>
  );
}
