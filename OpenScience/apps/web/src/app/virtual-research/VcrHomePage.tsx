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
import { useAskAbout } from "@/components/memory/useAskAbout";
import { VCR_TASKS } from "@/components/vcr/frameVcrOptions";
import { vcrCalculationPath } from "@/lib/vcrMethodLocation";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { PageShell } from "@/components/layout/PageShell";
import { Button } from "@/components/ui/Button";
import { List } from "@/components/ui/ListRow";
import { Note } from "@/components/ui/Note";
import { Tag } from "@/components/ui/Tag";
import { Disclosure } from "@/components/ui/Disclosure";
import type { ToolbarFilter, ToolbarProps } from "@/components/ui/Toolbar";
import { VcrListSkeleton, VcrOffPage } from "@/components/vcr/VcrStates";
import { ToolbarSlotContext } from "@/components/vcr/studyFrameContext";
import { VcrDefinitionsPanel } from "@/components/vcr/VcrKnowledge";
import { VcrPrecedentsPanel } from "@/components/vcr/VcrPrecedentsPanel";
import { tierLabel } from "@/components/vcr/vcrText";
import { vcrTabPath } from "@/components/vcr/vcrTabs";

type HomeTab = "studies" | "precedents" | "definitions";

const TABS: ReadonlyArray<{ value: HomeTab; label: string }> = Object.freeze([
  { value: "studies", label: "研究" },
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
 * A study is complete when its requested work is complete; unrequested work never contributes to its status.
 */
export function studyStateOf(study: Pick<VcrStudySummary, "steps" | "attention">): StudyState {
  const records = Object.values(study.steps);
  if (study.attention.some((line) => line.tone === "attention")) return "need";
  if (records.some((record) => record?.status === "running" || record?.status === "queued")) return "running";
  const requested = records.filter(record => record?.requested === true);
  if (requested.length > 0 && requested.every(record => record?.status === "done" || record?.status === "minimal")) return "done";
  return "other";
}

/**
 * Anatomy: task intents, scoped data requirements, study list and historical calculations.
 * Variants: studies, reference trials and population definitions retain compatible links.
 * States: first read, empty, failed, refreshing and stale-with-retry preserve useful results.
 * Hit area: shared Button and linked study rows.
 * Keyboard: native buttons and links open unsent drafts and saved studies.
 * Long content: task guidance and study summaries wrap within the content column.
 * Theme: semantic paper, text and status roles.
 * Responsive: task rows collapse into two columns on narrow screens.
 * Verification: VcrHomePage tests cover drafts, task requirements, history and refresh recovery.
 */
export function VcrHomePage() {
  const feature = useVcrFeature();
  const ask = useAskAbout();
  const [params] = useSearchParams();
  const tab = (TABS.find((item) => item.value === params.get("tab"))?.value ?? "studies") as HomeTab;
  const [listing, setListing] = useState<Listing>({ kind: "loading" });
  const [lastHome, setLastHome] = useState<VcrHome | null>(null);
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
      (home) => { if (live) setListing({ kind: "ready", home }); setLastHome(home); },
      (error: unknown) => {
        if (!live) return;
        setListing(isVcrOff(error)
          ? { kind: "off" }
          : { kind: "error", message: webErrorMessage(error, { fallback: "研究列表暂时无法读取。" }) });
      },
    );
    return () => { live = false; };
  }, [feature, reloads]);

  const ready = listing.kind === "ready" ? listing.home : lastHome;
  const studies = useMemo(() => ready?.studies.filter(study => study.purpose !== "calculation") ?? [], [ready]);
  const history = useMemo(() => ready?.studies.filter(study => study.purpose === "calculation") ?? [], [ready]);
  const stateOf = studyStateOf;

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

  const newStudy = <Button onClick={() => ask("我想开展虚拟临床研究，问题是：")}><Plus size={16} aria-hidden="true" />开始研究对话</Button>;

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
      actions={tab === "studies" ? <>{newStudy}<Button variant="secondary" onClick={() => setReloads(value => value + 1)} disabled={listing.kind === "loading"}>刷新研究列表</Button></> : undefined}
      toolbar={{
        ...(tab !== "studies" ? { label: TABS.find(item => item.value === tab)?.label ?? "研究" } : {}),
        ...(onStudies ? {
          filters,
          search: { label: "搜索研究", value: query, maxLength: 80, onChange: setQuery, onClear: () => setQuery("") },
          onClear: () => { setQuery(""); setState("all"); },
          summary: shown.length === studies.length ? `${studies.length} 项` : `${shown.length} / ${studies.length}`,
        } : {}),
      }}
    >
      {tab === "studies" && lastHome && listing.kind === "error" && <LoadError message={listing.message} onRetry={() => setReloads(value => value + 1)} />}
      {tab === "studies" && lastHome && listing.kind === "loading" && <p role="status" className="text-ui text-text-2">正在更新研究列表</p>}
      {tab === "studies" && !needle && state === "all" && <section aria-label="开始研究任务" className="mb-8">
        <List label="研究任务" divided>
          {VCR_TASKS.map((task, index) => {
            const Icon = [ScanSearch, UsersRound, GitCompareArrows, FlaskConical][index];
            return <li key={task.id} className="grid grid-cols-[auto_1fr] items-start gap-x-3 gap-y-2 px-2 py-4 md:grid-cols-[auto_10rem_1fr]">
              <Icon size={20} aria-hidden="true" className="mt-2 text-text-3" />
              <Button variant="text" aria-label={task.label} aria-describedby={`vcr-input-${task.id}`} onClick={() => ask(task.draft)} className="h-auto justify-start px-0 py-1 text-body font-semibold">{task.label}</Button>
              <span className="col-start-2 flex min-w-0 flex-col gap-2 md:col-start-3">
                <span className="text-ui text-text">{task.summary}</span>
                <span id={`vcr-input-${task.id}`} data-vcr-data-requirement={task.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-caption text-text-2"><Tag>{task.inputLabel}</Tag><span className="max-w-measure">{task.requirement}</span></span>
              </span>
            </li>;
          })}
        </List>
      </section>}
      {tab === "precedents" ? <VcrPrecedentsPanel />
          : tab === "definitions" ? <VcrDefinitionsPanel />
            : feature === "loading" || listing.kind === "loading" && !lastHome ? <VcrListSkeleton />
              : listing.kind === "error" && !lastHome ? <LoadError message={listing.message} onRetry={() => setReloads((value) => value + 1)} />
                : studies.length === 0
                  ? (
                    <EmptyState
                      icon={UsersRound}
                      title="研究结果会保留在这里"
                      description={(
                        <>
                          <p>从上方任务或首页对话开始。AI 会读取资料、调用计算，并把可复用的人群、患者与方案保存在研究中。</p>
                        </>
                      )}
                    />
                  )
                  : shown.length === 0
                    ? <EmptyState icon={UsersRound} title="没有匹配的研究" action={<Button variant="secondary" onClick={() => { setQuery(""); setState("all"); }}>清除筛选</Button>} />
                    : (
                      <List label="研究" divided>
                        {shown.map((study) => <StudyRow key={study.id} study={study} />)}
                      </List>
                    )}
      {tab === "studies" && history.length > 0 && <div className="mt-6"><Disclosure summary={`历史独立计算 · ${history.length}`}><List label="历史独立计算" divided>{history.map(study => <StudyRow key={study.id} study={study} />)}</List></Disclosure></div>}
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
      <PageShell title="虚拟临床研究" width="wide" actions={actions} back={toolbar.label ? <Link to="/app/virtual-research" className="rounded text-ui text-link">回到研究列表</Link> : undefined} toolbar={panel ? { ...toolbar, ...panel } : toolbar}>
        {children}
      </PageShell>
    </ToolbarSlotContext.Provider>
  );
}

/**
 * One study: its name and data tier, the question it asks, what it has found, how far it has come — and, when it waits for somebody,
 * the one thing to do about it. The title is the row's link (stretched over it); the steps and the cue are links of their own, above it.
 */
function StudyRow({ study }: { study: VcrStudySummary }) {
  const line = study.attention.find((item) => item.tone === "attention") ?? null;
  return (
    <li className="relative flex flex-col gap-3 px-2 py-5 hover:bg-surface-1">
      <div className="min-w-0">
        {/* The title has the row's whole line on a phone — the tier and the date go under it — and on a wide page the date stands at the right edge. */}
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <Link
            to={study.purpose === "calculation" ? vcrCalculationPath(study.id) : vcrTabPath(study.id, "overview")}
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
      {line && (
        // Above the stretched title, so its link stays a link.
        <div data-vcr-need="" className="relative z-sticky">
          <Note
            tone="warn"
            action={(
              <Link to={vcrTabPath(study.id, line?.tab ?? line?.action?.tab ?? "overview")} className="shrink-0 rounded text-link hover:underline">
                {line?.action?.label ?? "去处理"}
              </Link>
            )}
          >
            需要你
            {` · ${line?.text}`}
          </Note>
        </div>
      )}
    </li>
  );
}
