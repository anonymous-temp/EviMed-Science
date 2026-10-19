import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
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
import { useProjectStore } from "@/lib/projects";
import { vcrChatPath } from "@/lib/studyLocation";
import { toast } from "@/lib/toast";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { PageShell } from "@/components/layout/PageShell";
import { Button } from "@/components/ui/Button";
import { List } from "@/components/ui/ListRow";
import { Note } from "@/components/ui/Note";
import type { ToolbarFilter, ToolbarProps } from "@/components/ui/Toolbar";
import { VcrListSkeleton, VcrOffPage } from "@/components/vcr/VcrStates";
import { VcrStepProgress } from "@/components/vcr/VcrStepProgress";
import { announceVcrStudiesChanged, hintVcrDraftProject } from "@/components/vcr/useVcrProjectIds";
import { ToolbarSlotContext } from "@/components/vcr/studyFrameContext";
import { VcrDefinitionsPanel } from "@/components/vcr/VcrKnowledge";
import { VcrModelsPanel } from "@/components/vcr/VcrModelsPanel";
import { VcrPrecedentsPanel } from "@/components/vcr/VcrPrecedentsPanel";
import { tierLabel } from "@/components/vcr/vcrText";
import { vcrTabPath } from "@/components/vcr/vcrTabs";

type HomeTab = "studies" | "models" | "precedents" | "definitions";

const TABS: ReadonlyArray<{ value: HomeTab; label: string }> = Object.freeze([
  { value: "studies", label: "研究" },
  { value: "models", label: "方法库" },
  { value: "precedents", label: "参考试验" },
  { value: "definitions", label: "人群定义" },
]);

type Listing =
  | { kind: "loading" }
  | { kind: "off" }
  | { kind: "error"; message: string }
  | { kind: "ready"; home: VcrHome };

/** How a study stands, for the one filter and the one sort the list has. */
type StudyState = "need" | "running" | "done" | "other";
type StudyFilter = "all" | "need" | "running" | "done";
type StudySort = "recent" | "state";

const STATE_WORDS: Record<Exclude<StudyFilter, "all">, string> = { need: "需要你", running: "进行中", done: "已完成" };
/** The order of the state sort: what asks for the reader first, what is finished last. */
const STATE_RANK: Record<StudyState, number> = { need: 0, running: 1, other: 2, done: 3 };

/**
 * Where a study stands, read off what the row carries: a line the server marked as needing the reader (or a coordinator's todo) is
 * 需要你; a step under way is 进行中; all seven done is 已完成. A study that is none of these is only listed under 全部.
 */
export function studyStateOf(study: Pick<VcrStudySummary, "steps" | "attention">, todos: readonly VcrRecruitTodo[] = []): StudyState {
  const records = Object.values(study.steps);
  if (todos.length > 0 || study.attention.some((line) => line.tone === "attention")) return "need";
  if (records.some((record) => record?.status === "running" || record?.status === "queued")) return "running";
  const steps = ["definition", "evidence", "population", "patients", "comparator", "trial", "matching"] as const;
  if (steps.every((step) => study.steps[step]?.status === "done" || study.steps[step]?.status === "minimal")) return "done";
  return "other";
}

/**
 * 「虚拟临床研究」's home: the studies, and the libraries they draw on.
 *
 * One list and one way in. 「新建研究」 is the only entry: it makes a draft study and opens **its conversation view** with the study's
 * step bar already above it (R19, plan §5.3) — the first thing said there names the study, the bar and the title follow, and the
 * study stands at the top of the sidebar's group. It used to open the project's conversation in the chat surface, where nothing
 * pointed back at the study.
 *
 * Each row says what the study asks, what it has found and how far it has come — **all seven steps in order, each a link to its
 * tab**, how many are done and which is next — and a study that needs somebody (a failed step, a wait for the budget or the
 * allowance, a coordinator's confirmations) says so on its own row with the thing to do about it, so there is one column and nothing
 * to read twice. The toolbar holds the four views, the one filter (a state is not drawn when no study is in it), the sort and the
 * search, above the list they act on.
 */
export function VcrHomePage() {
  const feature = useVcrFeature();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((item) => item.value === params.get("tab"))?.value ?? "studies") as HomeTab;
  const [listing, setListing] = useState<Listing>({ kind: "loading" });
  const [reloads, setReloads] = useState(0);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [state, setState] = useState<StudyFilter>("all");
  const [sort, setSort] = useState<StudySort>("recent");

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
  const studies = useMemo(() => ready?.studies ?? [], [ready]);
  const todosOf = useCallback((study: VcrStudySummary): VcrRecruitTodo[] => (ready?.todos ?? []).filter((todo) => todo.studyId === study.id), [ready]);
  const stateOf = useCallback((study: VcrStudySummary) => studyStateOf(study, todosOf(study)), [todosOf]);

  const needle = query.trim().toLowerCase();
  const counts = useMemo(() => {
    const total = { all: studies.length, need: 0, running: 0, done: 0 } as Record<StudyFilter, number>;
    for (const study of studies) {
      const kind = stateOf(study);
      if (kind !== "other") total[kind] += 1;
    }
    return total;
  }, [studies, stateOf]);
  const shown = useMemo(() => {
    const matching = studies.filter((study) => (!needle || study.name.toLowerCase().includes(needle) || (study.question ?? "").toLowerCase().includes(needle))
      && (state === "all" || stateOf(study) === state));
    // The server lists newest first, and a stable sort keeps that order within a state.
    return sort === "state" ? [...matching].sort((a, b) => STATE_RANK[stateOf(a)] - STATE_RANK[stateOf(b)]) : matching;
  }, [studies, needle, state, sort, stateOf]);

  if (feature === "off" || listing.kind === "off") return <VcrOffPage />;

  const start = () => {
    if (creating) return;
    setCreating(true);
    void (async () => {
      const created = await createVcrStudy({});
      // The project exists from this moment and the list that would call it a draft is a request away: the sidebar is told now,
      // and which study it is, so its row can open the study's conversation.
      hintVcrDraftProject(created.projectId, created.id);
      const store = useProjectStore.getState();
      if (!store.projects.some((project) => project.id === created.projectId)) await store.load();
      announceVcrStudiesChanged();
      // The shell moves to the study's project and lands on its conversation in the same render: the page it lands on is the study's
      // own, with its step bar, and the first sentence said there names it.
      await useProjectStore.getState().select(created.projectId, () => navigate(vcrChatPath(created.id), { flushSync: true }));
    })()
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
  // The empty state carries the button, so the header does not.
  const none = tab === "studies" && feature !== "loading" && ready !== null && ready.studies.length === 0;

  // A state with no study in it is not a chip: 0 is not a filter.
  const filters: ToolbarFilter[] = [];
  const stateOptions = (["need", "running", "done"] as const).filter((key) => counts[key] > 0);
  if (stateOptions.length > 0) {
    filters.push({
      kind: "chips",
      label: "状态",
      value: state,
      onChange: (next) => setState(next as StudyFilter),
      options: [{ value: "all", label: "全部", count: counts.all }, ...stateOptions.map((key) => ({ value: key, label: STATE_WORDS[key], count: counts[key] }))],
    });
  }
  if (studies.length > 1) {
    filters.push({
      kind: "select",
      label: "排序",
      allLabel: "最近更新",
      value: sort === "state" ? "state" : null,
      onChange: (next) => setSort(next === "state" ? "state" : "recent"),
      options: [{ value: "state", label: "按状态" }],
    });
  }
  const onStudies = tab === "studies" && ready !== null && studies.length > 0;

  return (
    <HomeFrame
      actions={tab === "studies" && !none ? newStudy : undefined}
      toolbar={{
        views: {
          label: "虚拟临床研究的视图",
          items: TABS.map((item) => ({ value: item.value, label: item.label, ...(item.value === "studies" && ready && ready.studies.length > 0 ? { count: ready.studies.length } : {}) })),
          value: tab,
          onChange: (next) => setParams(next === "studies" ? {} : { tab: next }, { replace: true }),
          panelId: "vcr-home-panel",
        },
        ...(onStudies ? {
          filters,
          search: { label: "搜索研究", value: query, maxLength: 80, onChange: setQuery, onClear: () => setQuery("") },
          onClear: () => { setQuery(""); setState("all"); },
          summary: shown.length === studies.length ? `${studies.length} 项` : `${shown.length} / ${studies.length}`,
        } : {}),
      }}
    >
      {tab === "models" ? <VcrModelsPanel />
        : tab === "precedents" ? <VcrPrecedentsPanel />
          : tab === "definitions" ? <VcrDefinitionsPanel />
            : feature === "loading" || listing.kind === "loading" ? <VcrListSkeleton />
              : listing.kind === "error" ? <LoadError message={listing.message} onRetry={() => setReloads((value) => value + 1)} />
                : listing.home.studies.length === 0
                  ? (
                    <EmptyState
                      icon={UsersRound}
                      title="还没有研究"
                      description={(
                        <>
                          <p>用 已有证据和你的数据</p>
                          <p>得到 模拟人群、试验方案和样本量，再匹配合适的患者</p>
                        </>
                      )}
                      action={newStudy}
                    />
                  )
                  : shown.length === 0
                    ? <EmptyState icon={UsersRound} title="没有匹配的研究" action={<Button variant="secondary" onClick={() => { setQuery(""); setState("all"); }}>清除筛选</Button>} />
                    : (
                      <List label="研究" divided>
                        {shown.map((study) => <StudyRow key={study.id} study={study} todos={todosOf(study)} />)}
                      </List>
                    )}
    </HomeFrame>
  );
}

/**
 * The home's page: its views, and beside them whatever its libraries ask for. 方法库 and 试验先例 load their own data and know their
 * own filters, search and buttons, so they hand them to **the page's one toolbar** (`useVcrToolbar`, which finds this slot) instead of
 * drawing a second one under it. A component of its own, so that a panel handing the toolbar over re-renders the toolbar and never the
 * panel — the study page's frame does the same.
 */
function HomeFrame({ actions, toolbar, children }: { actions: ReactNode; toolbar: ToolbarProps; children: ReactNode }) {
  const [panel, setPanel] = useState<ToolbarProps | null | undefined>(undefined);
  return (
    <ToolbarSlotContext.Provider value={setPanel}>
      <PageShell title="虚拟临床研究" width="wide" actions={actions} toolbar={panel ? { ...toolbar, ...panel, views: toolbar.views } : toolbar}>
        {children}
      </PageShell>
    </ToolbarSlotContext.Provider>
  );
}

/**
 * One study: its name and data tier, the question it asks, what it has found, how far it has come — and, when it waits for somebody,
 * the one thing to do about it. The title is the row's link (stretched over it); the steps and the cue are links of their own, above it.
 */
function StudyRow({ study, todos }: { study: VcrStudySummary; todos: readonly VcrRecruitTodo[] }) {
  const need = todos[0] ?? null;
  const line = study.attention.find((item) => item.tone === "attention") ?? null;
  const described = Boolean(study.question) || ["done", "minimal", "stale"].includes(study.steps.definition?.status ?? "");
  return (
    <li className="relative flex flex-col gap-3 px-2 py-5 hover:bg-surface-1">
      <div className="min-w-0">
        {/* The title has the row's whole line on a phone — the tier and the date go under it — and on a wide page the date stands at the right edge. */}
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <Link
            to={vcrTabPath(study.id, "overview")}
            data-row-title
            className="min-w-0 text-body font-semibold text-text after:absolute after:inset-0 after:rounded after:content-[''] max-sm:basis-full"
          >
            {study.name}
          </Link>
          <span className="shrink-0 text-caption text-text-3">{tierLabel(study.tier)}</span>
          <span className="shrink-0 text-caption tabular-nums text-text-3 sm:ml-auto">{study.updatedAt}</span>
        </p>
        {study.question && <p className="mt-1 text-caption text-text-2">{study.question}</p>}
        {study.conclusion?.text && <p data-vcr-latest="" className="mt-2.5 text-ui text-text">{study.conclusion.text}</p>}
      </div>
      <VcrStepProgress studyId={study.id} steps={study.steps} described={described} paused={study.status === "paused"} />
      {(need || line) && (
        // Above the stretched title, so its link stays a link.
        <div data-vcr-need="" data-vcr-todo={need ? "" : undefined} className="relative z-sticky">
          <Note
            tone="warn"
            action={(
              <Link to={vcrTabPath(study.id, need ? need.action?.tab ?? "matching" : line?.tab ?? line?.action?.tab ?? "overview")} className="shrink-0 rounded text-link hover:underline">
                {need ? need.action?.label ?? "去处理" : line?.action?.label ?? "去处理"}
              </Link>
            )}
          >
            需要你
            {` · ${need ? (todos.length > 1 ? `${need.title}，另有 ${todos.length - 1} 件待办` : need.title) : line?.text}`}
          </Note>
        </div>
      )}
    </li>
  );
}
