import { VcrLegacyDraftRecovery } from "@/components/vcr/VcrLegacyDraftRecovery";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { ArrowRight, Plus, RefreshCw, UsersRound } from "lucide-react";
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
import { useContinueStudy } from "@/components/vcr/useContinueStudy";
import { Menu } from "@/components/ui/Menu";
import { PROFESSIONAL_RESEARCH_TASKS } from "@/components/vcr/professionalResearchTasks";
import { parseVcrWorkspaceArea, vcrWorkspaceAreaPath, type VcrWorkspaceArea } from "@/lib/vcrWorkspaceNavigation";
import { useVcrEntryDraft } from "@/lib/vcrEntryDraft";
import { vcrCalculationPath } from "@/lib/vcrMethodLocation";
import { vcrTabPath } from "@/components/vcr/vcrTabs";
import { VCR_LIBRARIES, isVcrLibraryTab, type VcrLibraryTab } from "@/components/vcr/vcrLibraries";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { PageShell } from "@/components/layout/PageShell";
import { Button } from "@/components/ui/Button";
import { Tag } from "@/components/ui/Tag";
import { IconButton } from "@/components/ui/IconButton";
import { List, ListRow } from "@/components/ui/ListRow";
import { Textarea } from "@/components/ui/Input";
import { Disclosure } from "@/components/ui/Disclosure";
import { Section } from "@/components/ui/Section";
import { type ToolbarFilter, type ToolbarProps } from "@/components/ui/Toolbar";
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
 * Component: VcrHomePage; owner: VCR; rules: the global sidebar owns the five entrances and the research history.
 * Anatomy: One question-entry page per entrance (the module root is the laboratory's), an addressed preview, or the retained records archive.
 * Variants: Entrance, new question, archive (`?area=records`) and compatible reference libraries.
 * States: Loading, empty, retained data and retryable error; unsent per-area drafts.
 * Hit area: Shared toolbar, buttons, textarea and linked rows.
 * Keyboard: Native controls, focus on mode changes and preview Escape.
 * Long content: Research names and questions wrap without truncating submitted text.
 * Theme: Shared page and control tokens.
 * Responsive: One main surface at every width; the shell owns mobile navigation.
 * Verification: VcrHomePage.test.tsx and studyComposition.test.tsx.
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
  const area = parseVcrWorkspaceArea(params.toString());
  // The module root is the laboratory's entry surface; the archive is `?area=records` or a study preview (`?study=`), kept readable but no entrance.
  const archive = area === "records" || (!params.has("area") && Boolean(asked));
  const entryMode = wantsNew || !archive;
  const needsListing = tab === "studies" && !entryMode;
  const [draft, setDraft] = useVcrEntryDraft(wantsNew ? "new" : area);
  const [listing, setListing] = useState<Listing>({ kind: "loading" });
  const [reloads, setReloads] = useState(0);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const listingRef = useRef(listing);
  listingRef.current = listing;
  const [query, setQuery] = useState("");
  const [state, setState] = useState<StudyFilter>("all");
  const [sort, setSort] = useState<StudySort>("recent");
  const surfaceFocus = useRef<HTMLDivElement>(null);
  const previousMode = useRef<string | null>(null);

  useEffect(() => {
    // `error`: `/api/me` could not be read. The list is asked anyway — the
    // route answers for itself, `vcr_not_enabled` included.
    if (feature === "loading" || feature === "off" || !needsListing) return undefined;
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
  }, [feature, reloads, needsListing]);

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

  const showingDetail = entryMode || Boolean(studies.find(study => study.id === asked));
  const mode = tab !== "studies" ? tab : entryMode ? (wantsNew ? "new" : area) : showingDetail ? `preview:${asked}` : "records";
  useEffect(() => {
    if (previousMode.current !== null && previousMode.current !== mode) surfaceFocus.current?.focus();
    previousMode.current = mode;
  }, [mode]);

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
  const newStudy: PageActionPlan = { primary: { id: "new-study", label: "新研究", icon: Plus, onSelect: () => setParams(current => { const next = new URLSearchParams(current); next.delete("study"); next.delete("area"); next.set("new", "1"); return next; }, opening) } };

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
      next.set("area", "records");
      return next;
    }, { replace: true });
  };
  const clearFilters = () => { setQuery(""); setState("all"); };

  const nothingYet = studies.length === 0 && conversation.length === 0;
  const rows = loading ? <VcrListSkeleton />
    : listing.kind === "error" ? <LoadError message={listing.message} onRetry={() => setReloads((value) => value + 1)} />
      : nothingYet
        ? (
          <EmptyState
            icon={UsersRound}
            title="暂无研究"
            reason="研究结果和正在进行的工作会显示在这里。"
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

  if (entryMode) {
    return (
      <div ref={surfaceFocus} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none">
        <TaskEntry area={wantsNew ? "records" : area} value={draft} onChange={setDraft} ask={ask} />
      </div>
    );
  }
  if (chosen) {
    return (
      <div ref={surfaceFocus} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none">
        <PageShell title={chosen.name} width="read" actionPlan={newStudy}
          back={<Button variant="text" onClick={closePreview}>研究列表</Button>}>
          <section aria-label="研究预览"><VcrStudyPreview study={chosen} heading={false} onClose={closePreview} /></section>
        </PageShell>
      </div>
    );
  }
  return (
    <div ref={surfaceFocus} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none">
      <PageShell title="研究记录" width="wide" actionPlan={newStudy} toolbar={toolbar}>
        <section aria-label="研究列表">{retainedWarning}{rows}{conversationRows}{below}</section>
      </PageShell>
    </div>
  );
}

const matchingEntry = {
  label: "患者匹配", summary: "按试验条件核对患者资料，或为患者检索可能适合的试验。",
  badge: "需患者资料", requirement: "需要患者资料；批量匹配需要患者数据集。试验方案可上传或检索。",
  examples: ["按一项临床试验的入排标准逐条核对患者资料", "为一位患者检索可能适合的临床试验，并列出需要补充的信息"],
};

/**
 * Component: TaskEntry; owner: VCR; rules: a directory scopes examples, never a mandatory workflow.
 * Anatomy: One question field, optional data guidance and two editable examples.
 * Variants: A professional directory, independent patient matching, or an open research question.
 * States: Empty/edited draft; blank submission disabled; examples fill without sending.
 * Hit area: Shared textarea, disclosure and buttons.
 * Keyboard: Native form submission and multiline editing; examples return focus to the field.
 * Long content: Drafts retain their original whitespace and have no arbitrary length cap.
 * Theme: Shared page, text, border and input tokens.
 * Responsive: One reading-width surface with wrapping controls.
 * Verification: VcrHomePage.test.tsx.
 */
function TaskEntry({ area, value, onChange, ask }: {
  area: VcrWorkspaceArea;
  value: string;
  onChange: (value: string) => void;
  ask: ReturnType<typeof useGeneralResearchDraft>;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const task = area === "patient-matching" ? matchingEntry : PROFESSIONAL_RESEARCH_TASKS.find(item => item.id === area);
  return (
    <PageShell title={task?.label ?? "新研究"} width="read">
      <div className="flex flex-col gap-6">
        <p className="max-w-measure text-body text-text-2">{task?.summary ?? "从一个研究问题开始，资料可以在对话中补充。"}</p>
        <form className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); if (value.trim()) ask(value); }}>
          <Textarea ref={input} label="研究问题" rows={5} value={value} onChange={event => onChange(event.target.value)}
            placeholder="描述你想研究的问题、已有资料和希望得到的结果" hint="进入对话后可继续编辑问题、上传资料，再发送。" />
          <div className="flex flex-wrap items-center justify-between gap-3">
            {task && <Tag>{task.badge}</Tag>}
            <Button type="submit" actionKind="draft" disabled={!value.trim()}><ArrowRight size={16} aria-hidden="true" />进入研究对话</Button>
          </div>
        </form>
        {task && <Disclosure summary="查看数据要求"><p data-vcr-data-requirement={area} className="text-ui text-text-2">{task.requirement}</p></Disclosure>}
        {task && (
          <Section title="可以这样问" compact>
            <ul aria-label="问题示例" className="flex flex-col items-start gap-2">
              {task.examples.map(example => <li key={example}><Button variant="text" actionKind="draft" className="h-auto whitespace-normal text-left" onClick={() => { onChange(example); input.current?.focus(); }}>{example}</Button></li>)}
            </ul>
          </Section>
        )}
      </div>
    </PageShell>
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
      <PageShell title="虚拟临床研究" width="wide" back={<Link to={vcrWorkspaceAreaPath("records")} className="rounded text-ui text-link">回到研究列表</Link>} toolbar={controls}>
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
 * A study a conversation made, in the list: its name (the model's title for the research question, or the kind of work and the day), the tabs that hold something and
 * when it last moved. The press opens the study's page at the first of those tabs -- the way back to a result; the original conversation
 * is the page's own 「对话」.
 */
function ConversationStudyRow({ study }: { study: VcrConversationStudy }) {
  const tab = study.tabs[0] ?? "overview";
  const continueStudy = useContinueStudy();
  const holds = [...new Set(study.tabs.map((key) => (VCR_TAB_LABELS_ZH as Record<string, string>)[key]).filter(Boolean))];
  return (
    <ListRow
      to={vcrTabPath(study.id, tab)}
      title={<span className="line-clamp-2">{study.name}</span>}
      meta={holds.length > 0 ? <span data-vcr-holds="" className="block truncate">{holds.join(" · ")}</span> : undefined}
      trailing={study.updatedAt ? <span className="tabular-nums">{study.updatedAt}</span> : undefined}
      menu={<Menu label={`“${study.name}”的操作`} items={[{ label: "在新对话中继续", onSelect: () => continueStudy({ id: study.id, projectId: study.projectId, name: study.name }) }]} />}
    />
  );
}
