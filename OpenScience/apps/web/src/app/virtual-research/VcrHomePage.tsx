import { VcrLegacyDraftRecovery } from "@/components/vcr/VcrLegacyDraftRecovery";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { Plus, RefreshCw, UsersRound } from "lucide-react";
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
import { IconButton } from "@/components/ui/IconButton";
import { List, ListRow } from "@/components/ui/ListRow";
import { MasterDetail, type MasterDetailState } from "@/components/ui/MasterDetail";
import { VcrTaskRequirements } from "@/components/vcr/VcrTaskRequirements";
// The task selector chooses content in the new-research pane; it is not a page filter or view switch.
// eslint-disable-next-line no-restricted-imports -- task choice is local to the detail pane, not the page toolbar.
import { SegmentedControl } from "@/components/ui/SegmentedControl";
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
 * The room the preview is given beside the 340 px list. The task selector and the study preview both want about this
 * much, so the studies split from 340 + 560 = 900 px of the page's own width; below that the list and detail swap.
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
    updated.delete("new");
    if (next === "studies" || !next) updated.delete("tab"); else updated.set("tab", next);
    return updated;
  }),
});

/**
 * Component: VcrHomePage; owner: VCR; rules: one list and one selected task or research.
 * Anatomy: Research list beside a task selector or selected study preview.
 * Variants: Research list and the existing library views.
 * States: Loading, empty, retained data and retryable error.
 * Hit area: Shared toolbar, buttons and linked rows.
 * Keyboard: Native controls, roving task selection and focus on narrow navigation.
 * Long content: Task detail and study names wrap.
 * Theme: Shared page and control tokens.
 * Responsive: The detail replaces the list below the split width.
 * Verification: VcrHomePage.test.tsx and the shared MasterDetail tests.
 */
export function VcrHomePage() {
  const feature = useVcrFeature();
  const ask = useGeneralResearchDraft();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((item) => item.value === params.get("tab"))?.value ?? "studies") as HomeTab;
  const asked = params.get("study");
  const wantsNew = params.get("new") === "1";
  const [listing, setListing] = useState<Listing>({ kind: "loading" });
  const [reloads, setReloads] = useState(0);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const listingRef = useRef(listing);
  listingRef.current = listing;
  const [query, setQuery] = useState("");
  const [state, setState] = useState<StudyFilter>("all");
  const [sort, setSort] = useState<StudySort>("recent");
  const listFocus = useRef<HTMLDivElement>(null);
  const detailFocus = useRef<HTMLDivElement>(null);
  const wasDetail = useRef(false);

  useEffect(() => {
    // `error`: `/api/me` could not be read. The list is asked anyway — the
    // route answers for itself, `vcr_not_enabled` included.
    if (feature === "loading" || feature === "off") return undefined;
    let live = true;
    setListing(current => current.kind === "ready" ? current : { kind: "loading" });
    void getVcrHome().then(
      (home) => { if (live) { setRefreshError(null); setListing({ kind: "ready", home }); } },
      (error: unknown) => {
        if (!live) return;
        if (isVcrOff(error)) { setListing({ kind: "off" }); return; }
        const message = webErrorMessage(error, { fallback: "研究列表暂时无法读取。" });
        if (listingRef.current.kind === "ready") setRefreshError(message);
        else setListing({ kind: "error", message });
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

  const showingDetail = wantsNew || Boolean(studies.find(study => study.id === asked));
  useEffect(() => {
    const focus = detailFocus.current ?? listFocus.current;
    if (!focus?.closest('[data-master-detail="single"]')) { wasDetail.current = showingDetail; return; }
    if (showingDetail) detailFocus.current?.focus();
    else if (wasDetail.current) listFocus.current?.focus();
    wasDetail.current = showingDetail;
  }, [showingDetail, asked]);

  if (feature === "off" || listing.kind === "off") return <VcrOffPage />;

  if (tab !== "studies") {
    return (
      <OtherViews tab={tab}>
        {tab === "precedents" ? <VcrPrecedentsPanel /> : tab === "definitions" ? <VcrDefinitionsPanel /> : <VcrModelsPanel />}
      </OtherViews>
    );
  }

  const loading = feature === "loading" || listing.kind === "loading";
  const newStudy: PageActionPlan = { primary: { id: "new-study", label: "新研究", icon: Plus, onSelect: () => setParams(current => { const next = new URLSearchParams(current); next.delete("study"); next.set("new", "1"); return next; }) } };

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
    ...(ready ? { actions: <IconButton icon={RefreshCw} label="刷新研究列表" onClick={() => setReloads(value => value + 1)} /> } : {}),
    ...(onStudies ? {
      search: { label: "搜索研究", value: query, maxLength: 80, onChange: setQuery, onClear: () => setQuery("") },
      onClear: () => { setQuery(""); setState("all"); },
      summary: shown.length === studies.length ? `${studies.length} 项` : `${shown.length} / ${studies.length}`,
    } : {}),
  };

  // The study the address names; one it does not know (deleted since, or a calculation) names none.
  const chosen = wantsNew ? null : studies.find((study) => study.id === asked) ?? null;
  const choose = (id: string) => {
    const next = new URLSearchParams(params);
    next.delete("new");
    next.set("study", id);
    return `?${next.toString()}`;
  };
  const closePreview = () => setParams((current) => {
    const next = new URLSearchParams(current);
    next.delete("study");
    next.delete("new");
    return next;
  });
  const clearFilters = () => { setQuery(""); setState("all"); };

  const entry = <TaskEntry ask={ask} />;

  const rows = loading ? <VcrListSkeleton />
    : listing.kind === "error" ? <LoadError message={listing.message} onRetry={() => setReloads((value) => value + 1)} />
      : studies.length === 0
        ? (
          <EmptyState
            icon={UsersRound}
            title="暂无研究"
          />
        )
        : shown.length === 0
          ? <EmptyState icon={UsersRound} title="没有匹配的研究" action={<Button variant="secondary" onClick={clearFilters}>清除筛选</Button>} />
          : (
            <List label="研究">
              {shown.map((study) => <StudyRow key={study.id} study={study} to={choose(study.id)} selected={study.id === chosen?.id} />)}
            </List>
          );
  const retainedWarning = refreshError ? <LoadError message={refreshError} onRetry={() => setReloads(value => value + 1)} /> : null;
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
      <PageHeader title="虚拟临床研究" actionPlan={chosen ? newStudy : undefined} className="shrink-0 px-4 pb-3 pt-5" />
      {/* The one row of controls, over the list it controls. It stands in a fixed column, as the band does on a page, so what does not fit folds. */}
      <div className="shrink-0 px-4 pb-2"><Toolbar {...toolbar} inBand /></div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-6">{retainedWarning}{rows}{below}</div>
    </div>
  ) : (
    // On a narrow page the list fills the available width; detail replaces it when selected.
    <div ref={listFocus} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none">
      <div className="mx-auto w-full max-w-wide px-4 pb-6 md:px-6">
        <PageHeader title="虚拟临床研究" actionPlan={newStudy} className="pb-3 pt-5" />
        <div className="sticky top-0 z-sticky -mx-4 bg-bg px-4 py-2 md:-mx-6 md:px-6"><Toolbar {...toolbar} inBand /></div>
        <div className="mt-2">{retainedWarning}{rows}{below}</div>
      </div>
    </div>
  ));

  const detail = ({ split }: MasterDetailState) => (
    <div ref={detailFocus} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none">
      <div className="mx-auto w-full max-w-2xl px-4 py-6 md:px-6">
        {!split && <><h1 className="sr-only">虚拟临床研究</h1><Button variant="text" onClick={closePreview} className="mb-4">研究列表</Button></>}
        {chosen && !wantsNew ? <VcrStudyPreview study={chosen} heading onClose={split ? closePreview : undefined} /> : entry}
      </div>
    </div>
  );

  return (
    <MasterDetail
      list={list}
      detail={detail}
      selected={chosen !== null || wantsNew}
      listLabel="研究列表"
      detailLabel="研究预览"
      detailMin={PREVIEW_MIN}
      narrow="swap"
    />
  );
}

/**
 * Component: TaskEntry; owner: VCR; rules: one selected task opens an unsent native draft.
 * Anatomy: Heading, task selector, purpose, data requirements and start action.
 * Variants: Four task types share the same controls.
 * States: Exactly one task is selected.
 * Hit area: Shared segmented control, disclosure and button.
 * Keyboard: Arrow keys select; native controls activate with keyboard.
 * Long content: Details wrap and the selector may scroll horizontally.
 * Theme: Shared text and control tokens.
 * Responsive: Selector stays within the pane.
 * Verification: VcrHomePage.test.tsx.
 */
function TaskEntry({ ask }: { ask: ReturnType<typeof useGeneralResearchDraft> }) {
  const [selected, setSelected] = useState<string>(VCR_TASKS[0].id);
  const task = VCR_TASKS.find((item) => item.id === selected) ?? VCR_TASKS[0];
  return (
    <section aria-label="新研究" className="flex flex-col items-start gap-5">
      <h2 className="text-section font-semibold text-text">新研究</h2>
      <div className="max-w-full overflow-x-auto">
        <SegmentedControl className="whitespace-nowrap" aria-label="研究任务" value={selected} onChange={setSelected} options={VCR_TASKS.map(item => ({ value: item.id, label: item.label }))} />
      </div>
      <p className="text-ui text-text-2">{task.summary}</p>
      <VcrTaskRequirements task={task} />
      <Button onClick={() => ask(task.draft)}>开始</Button>
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
