import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Plus, UsersRound } from "lucide-react";
import { webErrorMessage } from "@/lib/apiClient";
import {
  createVcrStudy,
  getVcrHome,
  isVcrOff,
  useVcrFeature,
  type VcrHome,
  type VcrRecruitTodo,
  type VcrStudySummary,
} from "@/lib/vcrClient";
import { toast } from "@/lib/toast";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { PageShell } from "@/components/layout/PageShell";
import { Button } from "@/components/ui/Button";
import { SearchInput } from "@/components/ui/SearchInput";
import { Tabs } from "@/components/ui/Tabs";
import { Tag } from "@/components/ui/Tag";
import { VcrListSkeleton, VcrOffPage } from "@/components/vcr/VcrStates";
import { VcrStepProgress } from "@/components/vcr/VcrStepProgress";
import { hintVcrDraftProject } from "@/components/vcr/useVcrProjectIds";
import { useOpenVcrConversation } from "@/components/vcr/useOpenVcrConversation";
import { VcrDefinitionsPanel } from "@/components/vcr/VcrKnowledge";
import { VcrModelsPanel } from "@/components/vcr/VcrModelsPanel";
import { VcrPrecedentsPanel } from "@/components/vcr/VcrPrecedentsPanel";
import { tierLabel } from "@/components/vcr/vcrText";
import { vcrTabPath } from "@/components/vcr/vcrTabs";

type HomeTab = "studies" | "models" | "precedents" | "definitions";

const TABS: ReadonlyArray<{ value: HomeTab; label: string }> = Object.freeze([
  { value: "studies", label: "研究" },
  { value: "models", label: "方法库" },
  { value: "precedents", label: "试验先例" },
  { value: "definitions", label: "人群定义" },
]);

type Listing =
  | { kind: "loading" }
  | { kind: "off" }
  | { kind: "error"; message: string }
  | { kind: "ready"; home: VcrHome };

/**
 * 「虚拟临床研究」's home: the studies, and the libraries they draw on.
 *
 * One list and one way in. 「新建研究」 is the only entry: it makes a draft study
 * and opens its conversation with the module's chip and the six starting points
 * (plan §9.3 / R10 mockup v02), and the study appears here once the first thing
 * said in it has named it. The four action cards and the box of recent reviews
 * this page used to carry are gone — five ways in that all led to the same empty
 * composer, and a review box nobody could act on from here.
 *
 * Each row says what the study asks, what it has found and how far it has come
 * in words; a study that needs somebody (a coordinator's confirmations, 招募待办)
 * says so on its own row, so there is one column and nothing to read twice.
 */
export function VcrHomePage() {
  const feature = useVcrFeature();
  const openConversation = useOpenVcrConversation();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((item) => item.value === params.get("tab"))?.value ?? "studies") as HomeTab;
  const [listing, setListing] = useState<Listing>({ kind: "loading" });
  const [reloads, setReloads] = useState(0);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");

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

  const ready = listing.kind === "ready" ? listing.home : null;
  const needle = query.trim().toLowerCase();
  const shown = useMemo(() => (ready?.studies ?? []).filter((study) => !needle
    || study.name.toLowerCase().includes(needle) || (study.question ?? "").toLowerCase().includes(needle)), [ready, needle]);

  if (feature === "off" || listing.kind === "off") return <VcrOffPage />;

  const start = () => {
    if (creating) return;
    setCreating(true);
    void createVcrStudy({})
      .then((created) => {
        // The project exists from this moment and the list that would call it a draft is a request away: the sidebar is told now.
        hintVcrDraftProject(created.projectId);
        return openConversation({ projectId: created.projectId, sessionId: created.sessionId });
      })
      .catch((error: unknown) => {
        if (isVcrOff(error)) setListing({ kind: "off" });
        else toast.error(webErrorMessage(error, { fallback: "无法新建研究，请稍后重试。" }));
      })
      .finally(() => setCreating(false));
  };

  const newStudy = (
    <Button onClick={start} loading={creating}>
      <Plus size={16} aria-hidden="true" />
      新建研究
    </Button>
  );
  const todosOf = (study: VcrStudySummary): VcrRecruitTodo[] => (ready?.todos ?? []).filter((todo) => todo.studyId === study.id);

  return (
    <PageShell title="虚拟临床研究" width="wide" actions={newStudy}>
      <Tabs
        label="虚拟临床研究的视图"
        items={TABS.map((item) => ({ value: item.value, label: item.label, ...(item.value === "studies" && ready ? { count: ready.studies.length } : {}) }))}
        value={tab}
        onChange={(next) => setParams(next === "studies" ? {} : { tab: next }, { replace: true })}
        panelId="vcr-home-panel"
        trailing={tab === "studies" && ready && ready.studies.length > 0
          ? <SearchInput label="搜索研究" size="sm" value={query} maxLength={80} onChange={(event) => setQuery(event.target.value)} onClear={() => setQuery("")} />
          : undefined}
      />

      <div id="vcr-home-panel" role="tabpanel" aria-labelledby={`vcr-home-panel-tab-${tab}`} className="pt-6">
        {tab === "models" ? <VcrModelsPanel />
          : tab === "precedents" ? <VcrPrecedentsPanel />
            : tab === "definitions" ? <VcrDefinitionsPanel />
              : feature === "loading" || listing.kind === "loading" ? <VcrListSkeleton />
                : listing.kind === "error" ? <LoadError message={listing.message} onRetry={() => setReloads((value) => value + 1)} />
                  : listing.home.studies.length === 0
                    ? <EmptyState icon={UsersRound} title="还没有研究" action={newStudy} />
                    : shown.length === 0
                      ? <EmptyState icon={UsersRound} title="没有匹配的研究" />
                      : (
                        <ul className="divide-y divide-border">
                          {shown.map((study) => <StudyRow key={study.id} study={study} todos={todosOf(study)} />)}
                        </ul>
                      )}
      </div>
    </PageShell>
  );
}

/**
 * One study: its name and data tier, the question it asks, what it has found, and how far it has come — and, when it waits for a
 * coordinator, the one thing to do about it.
 */
function StudyRow({ study, todos }: { study: VcrStudySummary; todos: readonly VcrRecruitTodo[] }) {
  const need = todos[0] ?? null;
  return (
    <li className="relative flex flex-col gap-3 px-2 py-5 hover:bg-surface-1 md:flex-row md:items-start md:gap-6">
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
        {study.conclusion?.text && <p data-vcr-latest="" className="mt-2.5 text-ui text-text">{study.conclusion.text}</p>}
        {need && (
          // Above the stretched title, so the link stays a link.
          <p data-vcr-todo="" className="relative z-sticky mt-2 flex flex-wrap items-baseline gap-x-3 text-caption text-warn-strong">
            <span>{todos.length > 1 ? `${need.title}，另有 ${todos.length - 1} 件待办` : need.title}</span>
            {need.action && (
              <Link to={vcrTabPath(study.id, need.action.tab ?? "matching")} className="text-link hover:underline">{need.action.label}</Link>
            )}
          </p>
        )}
      </div>
      {/* Below `md` the progress goes under the conclusion: a fixed 288 px column beside the text left a phone one character per line. */}
      <div data-vcr-row-aside="" className="flex w-full flex-row flex-wrap items-center justify-between gap-2 md:w-72 md:shrink-0 md:flex-col md:items-end">
        <VcrStepProgress steps={study.steps} className="justify-start md:justify-end" />
        <span className="text-caption tabular-nums text-text-3">{study.updatedAt}</span>
      </div>
    </li>
  );
}
