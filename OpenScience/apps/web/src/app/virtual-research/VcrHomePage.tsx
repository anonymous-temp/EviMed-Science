import { VcrLegacyDraftRecovery } from "@/components/vcr/VcrLegacyDraftRecovery";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { PenLine, Plus, RefreshCw, UsersRound } from "lucide-react";
import { VCR_TAB_LABELS_ZH, workStateLabel } from "@evimed/domain";
import { webErrorMessage } from "@/lib/apiClient";
import {
  getVcrHome,
  isVcrOff,
  useVcrFeature,
  type VcrConversationStudy,
  type VcrHome,
  type VcrStudySummary,
} from "@/lib/vcrClient";
import { useGeneralResearchDraft } from "@/components/vcr/useGeneralResearchDraft";
import { VCR_TASKS } from "@/components/vcr/frameVcrOptions";
import { vcrCalculationPath } from "@/lib/vcrMethodLocation";
import { vcrTabPath } from "@/components/vcr/vcrTabs";
import { VCR_LIBRARIES, isVcrLibraryTab, type VcrLibraryTab } from "@/components/vcr/vcrLibraries";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { List, ListRow } from "@/components/ui/ListRow";
import { MasterDetail, type MasterDetailState } from "@/components/ui/MasterDetail";
import { Disclosure } from "@/components/ui/Disclosure";
import { Section } from "@/components/ui/Section";
import { Toolbar, type ToolbarFilter, type ToolbarProps } from "@/components/ui/Toolbar";
import type { PageActionPlan } from "@/components/layout/HeaderActions";
import { VcrListSkeleton, VcrOffPage } from "@/components/vcr/VcrStates";
import { ToolbarSlotContext } from "@/components/vcr/studyFrameContext";
import { VcrDefinitionsPanel } from "@/components/vcr/VcrKnowledge";
import { studyStateOf, studyStatusLine, VcrStudyPreview, type StudyState } from "@/components/vcr/VcrHomePreview";
import { VcrModelsPanel } from "@/components/vcr/VcrModelsPanel";
import { VcrPrecedentsPanel } from "@/components/vcr/VcrPrecedentsPanel";

export { studyStateOf };

/** The page is the list of studies; a library (参考试验, 人群定义, 模型与参数) opens at its old address and is no view of it (`vcrLibraries.ts`). */
type HomeTab = "studies" | VcrLibraryTab;

/** Router state on the entry the page pushed to open a preview: closing it goes back one entry, to the list it was pushed from. */
const PREVIEW_PUSHED = "vcrPreviewPushed";

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
type StudyFilter = "all" | Exclude<StudyState, "other">;
type StudySort = "recent" | "state";

/** The filter's words are the vocabulary of module work's (`@evimed/domain` `workState.mjs`), never a table of the page's own. */
const STATE_WORDS: Record<Exclude<StudyFilter, "all">, string> = {
  need: workStateLabel("waiting"), running: workStateLabel("running"), paused: workStateLabel("paused"), done: workStateLabel("done"),
};
const STATE_KEYS = ["need", "running", "paused", "done"] as const;
/** The order of the state sort: what asks for the reader first, what is finished last. */
const STATE_RANK: Record<StudyState, number> = { need: 0, running: 1, paused: 2, other: 3, done: 4 };

/**
 * Component: VcrHomePage; owner: VCR; rules: one list and one selected task or research.
 * Anatomy: Research list (the studies a conversation made, and the module's own) beside the four ways to begin or a selected study preview.
 * Variants: Research list; a library at its old address (`?tab=`), with no view switch.
 * States: Loading, empty, retained data and retryable error.
 * Hit area: Shared toolbar, buttons and linked rows.
 * Keyboard: Native controls and focus on narrow navigation.
 * Long content: Task detail and study names wrap.
 * Theme: Shared page and control tokens.
 * Responsive: The detail replaces the list below the split width.
 * Verification: VcrHomePage.test.tsx and the shared MasterDetail tests.
 */
export function VcrHomePage() {
  const feature = useVcrFeature();
  const ask = useGeneralResearchDraft();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const pushedHere = (useLocation().state as Record<string, unknown> | null)?.[PREVIEW_PUSHED] === true;
  const tab: HomeTab = isVcrLibraryTab(params.get("tab")) ? params.get("tab") as VcrLibraryTab : "studies";
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
  // The studies the conversations made: a list of their own, read by this page alone (`VcrHome.conversationStudies`).
  const conversation = useMemo(() => ready?.conversationStudies ?? [], [ready]);

  const needle = query.trim().toLowerCase();
  const counts = useMemo(() => {
    const total = { all: studies.length, need: 0, running: 0, paused: 0, done: 0 } as Record<StudyFilter, number>;
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

  // The state words are the module-work studies'; a study a conversation made has none, so it is left out while one is chosen.
  const conversationShown = useMemo(() => (state !== "all" ? [] : conversation.filter((study) => !needle
    || study.name.toLowerCase().includes(needle) || (study.question ?? "").toLowerCase().includes(needle))), [conversation, needle, state]);

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
  // How the page moves to a preview: onto the list as a new entry when nothing is open (Back returns to the list), in place of the open one
  // when one is (switching studies is one preview, not a trail of them), keeping whether the entry under it is the list's.
  const opening = { replace: showingDetail, state: { [PREVIEW_PUSHED]: showingDetail ? pushedHere : true } };
  const newStudy: PageActionPlan = { primary: { id: "new-study", label: "新研究", icon: Plus, onSelect: () => setParams(current => { const next = new URLSearchParams(current); next.delete("study"); next.set("new", "1"); return next; }, opening) } };

  // A state with no study in it is not a chip: 0 is not a filter. The one that is applied stays, though a refresh took its count to 0:
  // a selected filter is never erased from under the reader, who would be looking at an empty list with nothing to say why.
  const filters: ToolbarFilter[] = [];
  const stateOptions = STATE_KEYS.filter((key) => counts[key] > 0 || key === state);
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
  const onStudies = ready !== null && studies.length + conversation.length > 0;
  const toolbar: ToolbarProps = {
    label: "研究",
    filters,
    ...(ready ? { actions: <IconButton icon={RefreshCw} label="刷新研究列表" onClick={() => setReloads(value => value + 1)} /> } : {}),
    ...(onStudies ? {
      search: { label: "搜索研究", value: query, maxLength: 80, onChange: setQuery, onClear: () => setQuery("") },
      onClear: () => { setQuery(""); setState("all"); },
      summary: shown.length + conversationShown.length === studies.length + conversation.length
        ? `${studies.length + conversation.length} 项` : `${shown.length + conversationShown.length} / ${studies.length + conversation.length}`,
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
  // A preview this page pushed onto the list is closed by going back to the list's own entry, so Back from the list leaves the page in one
  // press and does not open the preview again. One a link or a reload opened has no list entry under it: it is closed in place.
  const closePreview = () => {
    if (pushedHere) { navigate(-1); return; }
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.delete("study");
      next.delete("new");
      return next;
    }, { replace: true });
  };
  const clearFilters = () => { setQuery(""); setState("all"); };

  const entry = <TaskEntry ask={ask} />;

  const nothingYet = studies.length === 0 && conversation.length === 0;
  const rows = loading ? <VcrListSkeleton />
    : listing.kind === "error" ? <LoadError message={listing.message} onRetry={() => setReloads((value) => value + 1)} />
      : nothingYet
        ? (
          <EmptyState
            icon={UsersRound}
            title="暂无研究"
            reason="在对话里说明要研究什么，AI 保存第一项结果后，研究会列在这里。"
          />
        )
        : studies.length === 0 ? null
          : shown.length === 0 && conversationShown.length === 0
            ? <EmptyState icon={UsersRound} title="没有匹配的研究" action={<Button variant="secondary" onClick={clearFilters}>清除筛选</Button>} />
            : shown.length === 0 ? null : (
              <List label="研究">
                {shown.map((study) => <StudyRow key={study.id} study={study} to={choose(study.id)} selected={study.id === chosen?.id} opening={opening} />)}
              </List>
            );
  // The studies the conversations made: each row opens that study's page where it holds something. With none of the module's own, this is the list.
  const conversationRows = ready && !loading && listing.kind === "ready" ? (
    <>
      {ready.conversationStudiesUnreadable && <LoadError message="对话里的研究暂时无法读取。" onRetry={() => setReloads((value) => value + 1)} />}
      {conversationShown.length > 0 && (
        <Section title="对话里的研究" level="sub" count={conversationShown.length}>
          <List label="对话里的研究">
            {conversationShown.map((study) => <ConversationStudyRow key={study.id} study={study} />)}
          </List>
        </Section>
      )}
      {studies.length === 0 && conversation.length > 0 && conversationShown.length === 0
        && <EmptyState icon={UsersRound} title="没有匹配的研究" action={<Button variant="secondary" onClick={clearFilters}>清除筛选</Button>} />}
    </>
  ) : null;
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
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-6">{retainedWarning}{rows}{conversationRows}{below}</div>
    </div>
  ) : (
    // On a narrow page the list fills the available width; detail replaces it when selected.
    <div ref={listFocus} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none">
      <div className="mx-auto w-full max-w-wide px-4 pb-6 md:px-6">
        <PageHeader title="虚拟临床研究" actionPlan={newStudy} className="pb-3 pt-5" />
        <div className="sticky top-0 z-sticky -mx-4 bg-bg px-4 py-2 md:-mx-6 md:px-6"><Toolbar {...toolbar} inBand /></div>
        <div className="mt-2">{retainedWarning}{rows}{conversationRows}{below}</div>
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
 * Component: TaskEntry; owner: VCR; rules: four examples fill the native composer's draft and nothing else.
 * Anatomy: Heading, one line saying that saying what to study is enough, and four examples each with what it needs.
 * Variants: One per kind of work (匹配, 人群与患者, 对照, 试验).
 * States: None; nothing here has a state, nothing is sent and no study exists until its first result is saved.
 * Hit area: Shared secondary buttons.
 * Keyboard: Native buttons.
 * Long content: Sentences wrap.
 * Theme: Shared text and control tokens.
 * Responsive: Examples stack in the pane.
 * Verification: VcrHomePage.test.tsx.
 */
function TaskEntry({ ask }: { ask: ReturnType<typeof useGeneralResearchDraft> }) {
  return (
    <section aria-label="新研究" className="flex flex-col items-start gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-section font-semibold text-text">新研究</h2>
        <p className="max-w-measure text-ui text-text-2">说清要研究什么就能开始，不用先建研究。</p>
      </div>
      <ul aria-label="研究示例" className="flex w-full flex-col gap-4">
        {VCR_TASKS.map((task) => (
          <li key={task.id} data-vcr-task={task.id} className="flex flex-col items-start gap-1.5">
            {/* Nothing starts here: the sentence waits in the composer and the study exists once its first result is saved (the VCR reset ruling). */}
            <Button variant="secondary" actionKind="draft" onClick={() => ask(task.draft)}><PenLine size={16} aria-hidden="true" />{task.example}</Button>
            <p data-vcr-data-requirement={task.id} className="max-w-measure text-ui text-text-2">{task.requirement}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * A library's page, at its old address: 参考试验, 人群定义 and 模型与参数 are no views of the home (a study's 依据 goes to them), and what
 * they ask for is handed to **the page's one toolbar** (`useVcrToolbar`, which finds this slot) instead of drawing a second one under it. A
 * component of its own, so that a panel handing the toolbar over re-renders the toolbar and never the panel — the study page's frame does
 * the same.
 */
function OtherViews({ tab, children }: { tab: VcrLibraryTab; children: ReactNode }) {
  const [panel, setPanel] = useState<ToolbarProps | null | undefined>(undefined);
  const base: ToolbarProps = { label: VCR_LIBRARIES.find((library) => library.tab === tab)?.label ?? "研究" };
  const controls: ToolbarProps = panel ? { ...base, ...panel } : base;
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
function StudyRow({ study, to, selected, opening }: { study: VcrStudySummary; to: string; selected: boolean; opening?: { replace: boolean; state: unknown } }) {
  return (
    <ListRow
      to={to}
      {...(opening ?? {})}
      selected={selected}
      title={<span className="line-clamp-2">{study.name}</span>}
      meta={<span data-vcr-status="" className="block truncate">{studyStatusLine(study)}</span>}
      trailing={study.updatedAt ? <span className="tabular-nums">{study.updatedAt}</span> : undefined}
    />
  );
}

/**
 * A study a conversation made, in the list: its name (the first sentence said in the conversation), the tabs that hold something and
 * when it last moved. The press opens the study's page at the first of those tabs -- the way back to a result; the original conversation
 * is the page's own 「对话」.
 */
function ConversationStudyRow({ study }: { study: VcrConversationStudy }) {
  const tab = study.tabs[0] ?? "overview";
  const holds = [...new Set(study.tabs.map((key) => (VCR_TAB_LABELS_ZH as Record<string, string>)[key]).filter(Boolean))];
  return (
    <ListRow
      to={vcrTabPath(study.id, tab)}
      title={<span className="line-clamp-2">{study.name}</span>}
      meta={holds.length > 0 ? <span data-vcr-holds="" className="block truncate">{holds.join(" · ")}</span> : undefined}
      trailing={study.updatedAt ? <span className="tabular-nums">{study.updatedAt}</span> : undefined}
    />
  );
}
