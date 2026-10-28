import { VcrLegacyDraftRecovery } from "@/components/vcr/VcrLegacyDraftRecovery";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { Plus, UsersRound, ScanSearch, GitCompareArrows, FlaskConical } from "lucide-react";
import { webErrorMessage } from "@/lib/apiClient";
import {
  getVcrHome,
  isVcrOff,
  useVcrFeature,
  type VcrHome,
  type VcrStudySummary,
} from "@/lib/vcrClient";
import { useGeneralResearchDraft } from "@/components/vcr/useGeneralResearchDraft";
import { VCR_TASKS } from "@/components/vcr/frameVcrOptions";
import { vcrCalculationPath } from "@/lib/vcrMethodLocation";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { Button } from "@/components/ui/Button";
import { List, ListRow } from "@/components/ui/ListRow";
import { MasterDetail, type MasterDetailState } from "@/components/ui/MasterDetail";
import { VcrTaskRequirements } from "@/components/vcr/VcrTaskRequirements";
import { Disclosure } from "@/components/ui/Disclosure";
import { Toolbar, type ToolbarFilter, type ToolbarProps, type ToolbarSelect } from "@/components/ui/Toolbar";
import type { PageActionPlan } from "@/components/layout/HeaderActions";
import { VcrListSkeleton, VcrOffPage } from "@/components/vcr/VcrStates";
import { ToolbarSlotContext } from "@/components/vcr/studyFrameContext";
import { VcrDefinitionsPanel } from "@/components/vcr/VcrKnowledge";
import { studyStateOf, studyStatusLine, VcrStudyPreview, type StudyState } from "@/components/vcr/VcrHomePreview";
import { VcrModelsPanel } from "@/components/vcr/VcrModelsPanel";
import { VcrPrecedentsPanel } from "@/components/vcr/VcrPrecedentsPanel";

export { studyStateOf };

type HomeTab = "studies" | "precedents" | "definitions" | "models";

const TABS: ReadonlyArray<{ value: HomeTab; label: string }> = Object.freeze([
  { value: "studies", label: "研究" },
  { value: "precedents", label: "参考试验" },
  { value: "definitions", label: "人群定义" },
  { value: "models", label: "模型与参数" },
]);

/**
 * The room the preview is given beside the 340 px list. The task entry's rows and the preview's four step columns both want about this
 * much, so the studies split from 340 + 560 = 900 px of the page's own width; below that the list is the page and a study opens in
 * the drawer.
 */
const PREVIEW_MIN = 560;

type Listing =
  | { kind: "loading" }
  | { kind: "off" }
  | { kind: "error"; message: string }
  | { kind: "ready"; home: VcrHome };

/** The one filter and the one sort the list has. */
type StudyFilter = "all" | "need" | "running" | "done";
type StudySort = "recent" | "state";

const STATE_WORDS: Record<Exclude<StudyFilter, "all">, string> = { need: "需要你", running: "进行中", done: "已完成" };
/** The order of the state sort: what asks for the reader first, what is finished last. */
const STATE_RANK: Record<StudyState, number> = { need: 0, running: 1, other: 2, done: 3 };

/**
 * The page's one view switch: studies, and the three libraries that load their own data. Leaving a view lets go of the study it had open.
 * It is the page's navigation and not a narrowing of the list, so it stands in the toolbar's `navigation`, never in its filters.
 */
const viewsNavigation = (selected: HomeTab, setParams: ReturnType<typeof useSearchParams>[1]): ToolbarSelect => ({
  kind: "select",
  label: "查看",
  value: selected,
  pinned: true,
  options: TABS.map((item) => ({ value: item.value, label: item.label })),
  onChange: (next) => setParams((previous) => {
    const updated = new URLSearchParams(previous);
    updated.delete("study");
    if (next === "studies" || !next) updated.delete("tab"); else updated.set("tab", next);
    return updated;
  }),
});

/**
 * 虚拟临床研究's home. The 研究 view is a list with a peek beside it (T2, 2026-10-28): the studies on the left — one row each, the
 * name, one line under it (what asks for the reader, what is being done, how far it has come) and when it last moved — and, on the
 * right, the four ways to start (a press on one opens an unsent draft in the native composer) until a study is chosen, then that
 * study: its question and latest finding, what waits for the reader, the seven steps with where each one is, 打开研究 and its original
 * conversation. A press on a row chooses it (`?study=`, so the choice survives a reload and Back); nothing is chosen for the reader, so
 * the four ways in stay in sight. 开始研究对话 is the list header's one solid button whichever study is chosen.
 *
 * The page's one toolbar stands in the list's column: the view switch, the state chips, the order and the search. Below the room for
 * both (the page's own width, not the window's) the list is the page — the four ways to start above its toolbar, as they always were
 * — and a row opens the preview in the drawer over it.
 *
 * 参考试验, 人群定义 and 模型与参数 load their own data, know their own filters and hand them to the page's one toolbar; they keep the
 * page as it was (`OtherViews`). Historical calculations stay readable below the studies, each a link to its own page.
 */
export function VcrHomePage() {
  const feature = useVcrFeature();
  const ask = useGeneralResearchDraft();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((item) => item.value === params.get("tab"))?.value ?? "studies") as HomeTab;
  const asked = params.get("study");
  const [listing, setListing] = useState<Listing>({ kind: "loading" });
  const [reloads, setReloads] = useState(0);
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
  const studies = useMemo(() => ready?.studies.filter(study => study.purpose !== "calculation") ?? [], [ready]);
  const history = useMemo(() => ready?.studies.filter(study => study.purpose === "calculation") ?? [], [ready]);

  const needle = query.trim().toLowerCase();
  const counts = useMemo(() => {
    const total = { all: studies.length, need: 0, running: 0, done: 0 } as Record<StudyFilter, number>;
    for (const study of studies) {
      const kind = studyStateOf(study);
      if (kind !== "other") total[kind] += 1;
    }
    return total;
  }, [studies]);
  const shown = useMemo(() => {
    const matching = studies.filter((study) => (!needle || study.name.toLowerCase().includes(needle) || (study.question ?? "").toLowerCase().includes(needle))
      && (state === "all" || studyStateOf(study) === state));
    // The server lists newest first, and a stable sort keeps that order within a state.
    return sort === "state" ? [...matching].sort((a, b) => STATE_RANK[studyStateOf(a)] - STATE_RANK[studyStateOf(b)]) : matching;
  }, [studies, needle, state, sort]);

  if (feature === "off" || listing.kind === "off") return <VcrOffPage />;

  if (tab !== "studies") {
    return (
      <OtherViews tab={tab}>
        {tab === "precedents" ? <VcrPrecedentsPanel /> : tab === "definitions" ? <VcrDefinitionsPanel /> : <VcrModelsPanel />}
      </OtherViews>
    );
  }

  const loading = feature === "loading" || listing.kind === "loading";
  const newStudy: PageActionPlan = { primary: { id: "new-study", label: "开始研究对话", icon: Plus, onSelect: () => ask("我想开展虚拟临床研究，问题是：") } };

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
  const onStudies = ready !== null && studies.length > 0;
  const toolbar: ToolbarProps = {
    navigation: [viewsNavigation("studies", setParams)],
    filters,
    ...(onStudies ? {
      search: { label: "搜索研究", value: query, maxLength: 80, onChange: setQuery, onClear: () => setQuery("") },
      onClear: () => { setQuery(""); setState("all"); },
      summary: shown.length === studies.length ? `${studies.length} 项` : `${shown.length} / ${studies.length}`,
    } : {}),
  };

  // The study the address names; one it does not know (deleted since, or a calculation) names none.
  const chosen = studies.find((study) => study.id === asked) ?? null;
  const choose = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("study", id);
    return `?${next.toString()}`;
  };
  const closePreview = () => setParams((current) => {
    const next = new URLSearchParams(current);
    next.delete("study");
    return next;
  }, { replace: true });
  const clearFilters = () => { setQuery(""); setState("all"); };

  const entry = (heading: boolean) => <TaskEntry heading={heading} inputs={ready?.taskInputs} ask={ask} />;

  const rows = loading ? <VcrListSkeleton />
    : listing.kind === "error" ? <LoadError message={listing.message} onRetry={() => setReloads((value) => value + 1)} />
      : studies.length === 0
        ? (
          <EmptyState
            icon={UsersRound}
            title="研究结果会保留在这里"
            reason={<p>从任务或首页对话开始。AI 会读取资料、调用计算，并把可复用的人群、患者与方案保存在研究中。</p>}
          />
        )
        : shown.length === 0
          ? <EmptyState icon={UsersRound} title="没有匹配的研究" action={<Button variant="secondary" onClick={clearFilters}>清除筛选</Button>} />
          : (
            <List label="研究">
              {shown.map((study) => <StudyRow key={study.id} study={study} to={choose(study.id)} selected={study.id === chosen?.id} />)}
            </List>
          );
  const below = (
    <>
      {feature === "on" && <VcrLegacyDraftRecovery />}
      {history.length > 0 && (
        <div className="mt-6">
          <Disclosure summary={`历史独立计算 · ${history.length}`}>
            <List label="历史独立计算" divided>{history.map((study) => <StudyRow key={study.id} study={study} to={vcrCalculationPath(study.id)} selected={false} />)}</List>
          </Disclosure>
        </div>
      )}
    </>
  );

  const list = ({ split }: MasterDetailState) => (split ? (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="虚拟临床研究" actionPlan={newStudy} className="shrink-0 px-4 pb-3 pt-5" />
      {/* The one row of controls, over the list it controls. It stands in a fixed column, as the band does on a page, so what does not fit folds. */}
      <div className="shrink-0 px-4 pb-2"><Toolbar {...toolbar} inBand /></div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-6">{rows}{below}</div>
    </div>
  ) : (
    // The list is the page: it keeps the page's column and gutter, the four ways to start above its toolbar, and the whole of it scrolls.
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-wide px-4 pb-6 md:px-6">
        <PageHeader title="虚拟临床研究" actionPlan={newStudy} className="pb-3 pt-5" />
        <div data-page-introduction="" className="mt-3 mb-4">{entry(false)}</div>
        <div className="sticky top-0 z-sticky -mx-4 bg-bg px-4 py-2 md:-mx-6 md:px-6"><Toolbar {...toolbar} inBand /></div>
        <div className="mt-2">{rows}{below}</div>
      </div>
    </div>
  ));

  const detail = ({ split }: MasterDetailState) => {
    if (!split) return chosen && <VcrStudyPreview study={chosen} heading={false} />;
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-6 py-6">
          {chosen ? <VcrStudyPreview study={chosen} heading /> : entry(true)}
        </div>
      </div>
    );
  };

  return (
    <MasterDetail
      list={list}
      detail={detail}
      selected={chosen !== null}
      listLabel="研究列表"
      detailLabel="研究预览"
      detailMin={PREVIEW_MIN}
      narrow="drawer"
      detailTitle={chosen?.name ?? "研究"}
      onCloseDetail={closePreview}
    />
  );
}

/**
 * The four ways to start: each opens an unsent draft in the native composer, with what the task needs and what the account already
 * has. Beside the list this is the pane's recipe; where the list is the page it stands above the toolbar.
 */
function TaskEntry({ heading, inputs, ask }: { heading: boolean; inputs: VcrHome["taskInputs"] | undefined; ask: ReturnType<typeof useGeneralResearchDraft> }) {
  return (
    <section aria-label="开始研究任务">
      {heading && <h2 className="mb-3 text-section font-semibold text-text">开始研究任务</h2>}
      <List label="研究任务" divided>
        {VCR_TASKS.map((task, index) => {
          const Icon = [ScanSearch, UsersRound, GitCompareArrows, FlaskConical][index];
          return <li key={task.id} className="grid grid-cols-[auto_1fr] items-start gap-x-3 gap-y-2 px-2 py-4 md:grid-cols-[auto_10rem_1fr]">
            <Icon size={20} aria-hidden="true" className="mt-2 text-text-3" />
            <Button variant="text" aria-label={task.label} aria-describedby={`vcr-input-${task.id}`} onClick={() => ask(task.draft)} className="h-auto justify-start px-0 py-1 text-body font-semibold">{task.label}</Button>
            <span className="col-start-2 flex min-w-0 flex-col gap-2 md:col-start-3">
              <span className="text-ui text-text">{task.summary}</span>
              <VcrTaskRequirements task={task} inputs={inputs} onInspect={() => ask(`请先检查这项${task.label}任务已有资料的授权、最低字段与缺失信息，并帮助我添加资料。`)} />
            </span>
          </li>;
        })}
      </List>
    </section>
  );
}

/**
 * The libraries' page: its views, and beside them whatever the libraries ask for. 方法库 and 试验先例 load their own data and know their
 * own filters, search and buttons, so they hand them to **the page's one toolbar** (`useVcrToolbar`, which finds this slot) instead of
 * drawing a second one under it. A component of its own, so that a panel handing the toolbar over re-renders the toolbar and never the
 * panel — the study page's frame does the same.
 */
function OtherViews({ tab, children }: { tab: HomeTab; children: ReactNode }) {
  const [panel, setPanel] = useState<ToolbarProps | null | undefined>(undefined);
  const [, setParams] = useSearchParams();
  const base: ToolbarProps = { label: TABS.find((item) => item.value === tab)?.label ?? "研究" };
  const merged = panel ? { ...base, ...panel } : base;
  const controls: ToolbarProps = { ...merged, navigation: [viewsNavigation(tab, setParams), ...(merged.navigation ?? [])] };
  return (
    <ToolbarSlotContext.Provider value={setPanel}>
      <PageShell title="虚拟临床研究" width="wide" back={<Link to="/app/virtual-research" className="rounded text-ui text-link">回到研究列表</Link>} toolbar={controls}>
        {children}
      </PageShell>
    </ToolbarSlotContext.Provider>
  );
}

/**
 * One study in the list: its name, one line under it and when it last moved. The row chooses the study (the preview shows it), and a
 * historical calculation's row is a link to its own page: `to` is where the press goes.
 */
function StudyRow({ study, to, selected }: { study: VcrStudySummary; to: string; selected: boolean }) {
  return (
    <ListRow
      to={to}
      selected={selected}
      title={<span className="line-clamp-2">{study.name}</span>}
      meta={<span data-vcr-status="" className="block truncate">{studyStatusLine(study)}</span>}
      trailing={study.updatedAt ? <span className="tabular-nums">{study.updatedAt}</span> : undefined}
    />
  );
}
