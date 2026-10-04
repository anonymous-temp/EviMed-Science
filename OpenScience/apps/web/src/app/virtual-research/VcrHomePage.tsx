import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Activity, ArrowUpRight, Clock, FileSearch, FlaskConical, GitCompare, Plus, UserCheck, UsersRound } from "lucide-react";
import { webErrorMessage } from "@/lib/apiClient";
import {
  createVcrStudy,
  getVcrHome,
  isVcrOff,
  useVcrFeature,
  VCR_STEP_KEYS,
  type VcrAction,
  type VcrHome,
  type VcrRecruitTodo,
  type VcrStudySummary,
} from "@/lib/vcrClient";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { PageShell } from "@/components/layout/PageShell";
import { Button } from "@/components/ui/Button";
import { Tabs } from "@/components/ui/Tabs";
import { Tag } from "@/components/ui/Tag";
import { ConclusionChip, ReviewChip } from "@/components/vcr/VcrMarks";
import { VcrListSkeleton, VcrOffPage } from "@/components/vcr/VcrStates";
import { useOpenVcrConversation } from "@/components/vcr/useOpenVcrConversation";
import { VCR_ACTION_CARDS, type VcrActionCard } from "@/components/vcr/vcrActions";
import { VcrDefinitionsPanel } from "@/components/vcr/VcrKnowledge";
import { VcrModelsPanel } from "@/components/vcr/VcrModelsPanel";
import { VcrPrecedentsPanel } from "@/components/vcr/VcrPrecedentsPanel";
import { stepLabel, tierLabel } from "@/components/vcr/vcrText";
import { vcrTabPath } from "@/components/vcr/vcrTabs";

type HomeTab = "studies" | "models" | "precedents" | "definitions";

const TABS: ReadonlyArray<{ value: HomeTab; label: string }> = Object.freeze([
  { value: "studies", label: "研究" },
  { value: "models", label: "模型与方法" },
  { value: "precedents", label: "试验先例" },
  { value: "definitions", label: "人群定义库" },
]);

const ACTION_ICONS = {
  "users-round": UsersRound,
  activity: Activity,
  "git-compare": GitCompare,
  "flask-conical": FlaskConical,
} as const;

type Listing =
  | { kind: "loading" }
  | { kind: "off" }
  | { kind: "error"; message: string }
  | { kind: "ready"; home: VcrHome };

/**
 * 「虚拟临研」's home: the four things the module does, and the studies that
 * are running.
 *
 * The four action cards are this page's one brand moment, and none of them
 * opens a form (plan §9.2, §9.3): each creates the study and lands in its
 * conversation with the module's chip attached and a starting line already in
 * the composer. Everything a form would have asked for is set by the platform
 * and labelled 「AI 设定」 — a live value the reader changes in a sentence,
 * never a blank that blocks the work.
 *
 * 招募待办 is the one column that is not everyone's: it appears only where
 * `/api/vcr/studies` sent it, which is where the account has a recruiting
 * role. The routes decide that for themselves; this is presentation.
 */
export function VcrHomePage() {
  const feature = useVcrFeature();
  const openConversation = useOpenVcrConversation();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((item) => item.value === params.get("tab"))?.value ?? "studies") as HomeTab;
  const [listing, setListing] = useState<Listing>({ kind: "loading" });
  const [reloads, setReloads] = useState(0);
  const [creating, setCreating] = useState<VcrAction | "new" | null>(null);

  useEffect(() => {
    // `error`: `/api/me` could not be read. The list is asked anyway — the
    // route answers for itself, `vcr_not_enabled` included.
    if (feature === "loading" || feature === "off") return undefined;
    let live = true;
    setListing({ kind: "loading" });
    void getVcrHome().then(
      (home) => { if (live) setListing({ kind: "ready", home }); },
      (error: unknown) => {
        if (!live) return;
        setListing(isVcrOff(error)
          ? { kind: "off" }
          : { kind: "error", message: webErrorMessage(error, { fallback: "研究列表暂时无法读取。" }) });
      },
    );
    return () => { live = false; };
  }, [feature, reloads]);

  if (feature === "off" || listing.kind === "off") return <VcrOffPage />;

  const start = (action: VcrAction | "new", draft?: string) => {
    if (creating) return;
    setCreating(action);
    void createVcrStudy(action === "new" ? {} : { action })
      .then((created) => openConversation({ projectId: created.projectId, sessionId: created.sessionId }, draft))
      .catch((error: unknown) => {
        if (isVcrOff(error)) setListing({ kind: "off" });
        else toast.error(webErrorMessage(error, { fallback: "无法新建研究，请稍后重试。" }));
      })
      .finally(() => setCreating(null));
  };

  const ready = listing.kind === "ready" ? listing.home : null;

  return (
    <PageShell
      title="虚拟临研"
      width="wide"
      actions={(
        <Button onClick={() => start("new")} loading={creating === "new"}>
          <Plus size={16} aria-hidden="true" />
          新建研究
        </Button>
      )}
    >
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {VCR_ACTION_CARDS.map((card) => (
          <li key={card.id}>
            <ActionCard card={card} busy={creating === card.id} onStart={() => start(card.id, card.draft)} />
          </li>
        ))}
      </ul>

      <Tabs
        label="虚拟临研的视图"
        className="mt-8"
        items={TABS.map((item) => ({ value: item.value, label: item.label, ...(item.value === "studies" && ready ? { count: ready.studies.length } : {}) }))}
        value={tab}
        onChange={(next) => setParams(next === "studies" ? {} : { tab: next }, { replace: true })}
        panelId="vcr-home-panel"
      />

      <div id="vcr-home-panel" role="tabpanel" aria-labelledby={`vcr-home-panel-tab-${tab}`} className="pt-6">
        {tab === "models" ? <VcrModelsPanel />
          : tab === "precedents" ? <VcrPrecedentsPanel />
            : tab === "definitions" ? <VcrDefinitionsPanel />
              : feature === "loading" || listing.kind === "loading" ? <VcrListSkeleton />
              : listing.kind === "error" ? <LoadError message={listing.message} onRetry={() => setReloads((value) => value + 1)} />
                : listing.home.studies.length === 0
                  ? <EmptyState icon={UsersRound} title="还没有研究" />
                  : <Studies home={listing.home} />}
      </div>
    </PageShell>
  );
}

/**
 * One of the four. It is a button and not a link: pressing it creates a study
 * before there is an address to go to.
 */
function ActionCard({ card, busy, onStart }: { card: VcrActionCard; busy: boolean; onStart: () => void }) {
  const Icon = ACTION_ICONS[card.icon];
  return (
    <button
      type="button"
      data-vcr-action={card.id}
      onClick={onStart}
      aria-busy={busy || undefined}
      className="group flex w-full items-center gap-3.5 rounded-card bg-surface p-4 text-left outline-none ring-1 ring-border transition-colors duration-fast hover:ring-border-control"
    >
      <span aria-hidden="true" className="grid h-11 w-11 shrink-0 place-items-center rounded-card bg-accent text-accent-fg">
        <Icon size={20} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body font-semibold text-text">{card.label}</span>
        <span className="block truncate text-caption text-text-3">{card.produces}</span>
      </span>
      <ArrowUpRight size={16} aria-hidden="true" className="shrink-0 text-text-3 group-hover:text-accent" />
    </button>
  );
}

function Studies({ home }: { home: VcrHome }) {
  const aside = (home.todos && home.todos.length > 0) || (home.reviews && home.reviews.length > 0);
  return (
    <div className={cn("grid gap-6", aside && "xl:grid-cols-[minmax(0,1fr)_minmax(0,21rem)]")}>
      <ul className="divide-y divide-border">
        {home.studies.map((study) => <StudyRow key={study.id} study={study} />)}
      </ul>
      {aside && (
        <div className="flex flex-col gap-4">
          {home.todos && home.todos.length > 0 && <TodoCard todos={home.todos} />}
          {home.reviews && home.reviews.length > 0 && (
            <section className="rounded-card border border-border bg-surface p-4">
              <h2 className="text-section font-semibold text-text">最近复核</h2>
              <ul className="mt-2 divide-y divide-faint">
                {home.reviews.map((review) => (
                  <li key={review.id} className="flex items-start justify-between gap-3 py-2.5">
                    <span className="min-w-0">
                      <span className="block truncate text-ui text-text">{review.subject}</span>
                      <span className="block truncate text-caption text-text-3">
                        {[review.by, review.at, review.studyName].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    <ReviewChip state={review.state} />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

/** One study: what it asks, what it has concluded, and how far along it is. */
function StudyRow({ study }: { study: VcrStudySummary }) {
  const done = VCR_STEP_KEYS.filter((key) => study.steps[key]?.status === "done").length;
  const running = VCR_STEP_KEYS.find((key) => study.steps[key]?.status === "running" || study.steps[key]?.status === "queued");
  return (
    <li className="relative flex items-start gap-6 px-2 py-5 hover:bg-surface-1">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2">
          <Link
            to={vcrTabPath(study.id, "overview")}
            data-row-title
            className="min-w-0 text-body font-semibold text-text after:absolute after:inset-0 after:rounded after:content-['']"
          >
            {study.name}
          </Link>
          <Tag>{tierLabel(study.tier)}</Tag>
        </p>
        {study.question && <p className="mt-1 text-caption text-text-2">{study.question}</p>}
        {study.conclusion?.text && (
          <p className="mt-2.5 flex flex-wrap items-baseline gap-2 text-ui text-text">
            <span className="shrink-0 text-caption text-text-3">最近结论</span>
            <ConclusionChip state={study.conclusion.state} />
            <span className="min-w-0">{study.conclusion.text}</span>
          </p>
        )}
        {study.attention.length > 0 && (
          <ul className="mt-2.5 flex flex-wrap gap-1.5">
            {study.attention.map((item, index) => (
              <li key={`${item.kind}-${index}`}>
                <Tag tone={item.tone === "attention" ? "warn" : "neutral"}>{item.text}</Tag>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">
        <StepDots study={study} />
        <span className={cn("text-caption tabular-nums", running ? "font-medium text-accent-strong" : "text-text-2")}>
          {running ? `${stepLabel(running)} · 进行中` : `${done} / ${VCR_STEP_KEYS.length} 步`}
        </span>
        <span className="text-caption tabular-nums text-text-3">{study.updatedAt}</span>
      </div>
    </li>
  );
}

/** The seven steps as seven dots — the rail's shorthand, not a progress bar. */
function StepDots({ study }: { study: VcrStudySummary }) {
  const done = VCR_STEP_KEYS.filter((key) => study.steps[key]?.status === "done").length;
  return (
    <span role="img" aria-label={`七步中已完成 ${done} 步`} className="flex items-center gap-1">
      {VCR_STEP_KEYS.map((key) => {
        const status = study.steps[key]?.status ?? "none";
        return (
          <span
            key={key}
            aria-hidden="true"
            data-vcr-step-dot={status}
            data-forced-colors="preserve"
            className={cn(
              "block h-2 w-2 rounded-full",
              status === "done" ? "bg-accent"
                : status === "running" || status === "queued" ? "bg-surface ring-2 ring-accent"
                  : status === "failed" ? "bg-surface ring-1 ring-danger"
                    : status === "stale" ? "bg-surface-2 ring-1 ring-border-control"
                      : "bg-surface-2",
            )}
          />
        );
      })}
    </span>
  );
}

const TODO_ICONS = { contact: UserCheck, evidence: FileSearch, site: Clock } as const;

/** 招募待办, for the coordinator whose confirmations the first human stop waits on. */
function TodoCard({ todos }: { todos: readonly VcrRecruitTodo[] }) {
  return (
    <section data-vcr-todos="" className="rounded-card border border-border bg-surface p-4">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-section font-semibold text-text">招募待办</h2>
        <span className="text-caption tabular-nums text-text-3">{todos.length}</span>
      </header>
      <ul className="mt-2 divide-y divide-faint">
        {todos.map((todo) => {
          const Icon = TODO_ICONS[todo.kind];
          return (
            <li key={todo.id} className="flex items-start gap-3 py-3">
              <span
                aria-hidden="true"
                className={cn("grid h-8 w-8 shrink-0 place-items-center rounded",
                  todo.kind === "contact" ? "bg-accent-soft text-accent" : todo.kind === "site" ? "bg-warn-soft text-warn-strong" : "bg-surface-1 text-text-2")}
              >
                <Icon size={16} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-ui font-medium text-text">{todo.title}</span>
                {todo.detail && <span className="block truncate text-caption tabular-nums text-text-3">{todo.detail}</span>}
                {todo.action && todo.studyId && (
                  <Link
                    to={vcrTabPath(todo.studyId, todo.action.tab ?? "matching")}
                    className="mt-1.5 inline-block text-caption text-link hover:underline"
                  >
                    {todo.action.label}
                  </Link>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
