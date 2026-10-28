import { PendingFeedbackBoundary } from "@/components/ui/PendingFeedback";
import { memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType } from "react";
import { Link, Outlet, useLocation, useNavigate, useNavigationType, useParams } from "react-router";
import { FileDown, MessageSquare, Radar } from "lucide-react";
import { webErrorMessage, WebApiError } from "@/lib/apiClient";
import { stepAllowanceWait } from "@/lib/allowanceWait";
import {
  GEO_STEP_KEYS,
  deleteGeoProject,
  exportGeo,
  getGeoDistribution,
  getGeoProgrammeRuns,
  getGeoProject,
  isGeoOff,
  patchGeoProject,
  useGeoFeature,
  type GeoProject,
  type GeoStartAnswer,
  type GeoStepKey,
} from "@/lib/geoClient";
import { GeoAnalysisWorkbench } from "@/components/geo/GeoAnalysisWorkbench";
import { GEO_ANALYSIS_OPTIONS, geoAnalysisChangeReplaces, geoAnalysisDescriptor, geoAnalysisDescriptorForView, geoAnalysisSearch } from "@/components/geo/geoAnalysisMode";
import { GeoConversationPane } from "@/components/geo/GeoConversationPane";
import { geoChatPath } from "@/lib/geoLocation";
import { useProjectStore } from "@/lib/projects";
import { toast } from "@/lib/toast";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { PageShell } from "@/components/layout/PageShell";
import { Button } from "@/components/ui/Button";
import { ProgrammeRunsDrawer } from "@/components/runs/ProgrammeRunsDrawer";
import { GeoSignalsWorkbench } from "@/components/geo/GeoSignalsWorkbench";
import { getGeoSignalRunRecord, geoSignalResultHref } from "@/lib/geoSignalsClient";
import type { ProgrammeRun } from "@/lib/programmeRuns";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { type MenuEntry } from "@/components/ui/Menu";
import { Tag } from "@/components/ui/Tag";
import { Note } from "@/components/ui/Note";
import type { ToolbarProps } from "@/components/ui/Toolbar";
import { GeoOffPage, GeoProjectSkeleton } from "@/components/geo/GeoStates";
import { TabSkeleton } from "@/components/geo/tabs/geoTabKit";
import { GeoScopeDialog } from "@/components/geo/GeoScopeDialog";
import { geoReadScopeFromSearch, geoReadScopeQuery, geoSearchWithScope } from "@/lib/geoReadScope";
import { GeoSettingsDrawer } from "@/components/geo/GeoSettingsDrawer";
import { MembersDialog } from "@/components/geo/MembersDialog";
import { ProducerDialog } from "@/components/geo/ProducerDialog";
import { RenameDialog } from "@/components/geo/RenameDialog";
import { bandNow, bandSteps } from "@/components/geo/geoBand";
import { GeoFrameContext, type GeoFrameApi, type GeoPanel } from "@/components/geo/geoFrame";
import { GeoDataCache, useGeoMonitoring } from "@/components/geo/geoProjectData";
import { scrollBlockToTop } from "@/components/geo/geoScroll";
import { coverageText, GEO_MONITORING_TITLE, weekOf } from "@/components/geo/geoText";
import {
  GEO_MONITORING_TABS,
  GEO_STEP_HOME,
  GEO_TABS,
  geoDestinationPath,
  geoViewedStep,
  resolveGeoTab,
  type GeoTabKey,
} from "@/components/geo/geoTabs";
import { useOpenGeoConversation } from "@/components/geo/useOpenGeoConversation";
import { BudgetDialog } from "@/components/geo/tabs/BudgetDialog";
import { marketConnected } from "@/components/geo/geoOverviewModel";
import { AccuracyTab } from "@/components/geo/tabs/AccuracyTab";
import { ActionsTab } from "@/components/geo/tabs/ActionsTab";
import { EvidenceTab } from "@/components/geo/tabs/EvidenceTab";
import { OverviewTab } from "@/components/geo/tabs/OverviewTab";
import { PlanTab } from "@/components/geo/tabs/PlanTab";
import { QuestionsTab } from "@/components/geo/tabs/QuestionsTab";
import { SourcesTab } from "@/components/geo/tabs/SourcesTab";
import { VisibilityTab } from "@/components/geo/tabs/VisibilityTab";

type TabComponent = ComponentType<{ geoId: string; project: GeoProject }>;

/** Reuse existing result components inside the eight business workbenches; their old addresses remain valid. */
const TABS: Record<GeoTabKey, TabComponent> = {
  overview: OverviewTab,
  visibility: VisibilityTab,
  accuracy: AccuracyTab,
  questions: QuestionsTab,
  sources: SourcesTab,
  actions: ActionsTab,
  plan: PlanTab,
  evidence: EvidenceTab,
};

type Loaded =
  | { kind: "loading" }
  | { kind: "off" }
  | { kind: "missing" }
  | { kind: "error"; message: string }
  | { kind: "ready"; project: GeoProject; scopeKey: string; refreshError?: string; refreshStale?: boolean; scopeError?: string };

/**
 * Every workbench can change while it is open. Active work refreshes more often; quiet visible projects still discover scheduled work.
 */
const WATCHED_STEPS: readonly GeoStepKey[] = GEO_STEP_KEYS;
const WATCH_MS = 10_000;
const IDLE_WATCH_MS = 30_000;
/**
 * Articles, orders and placing can change without touching the project row. A poll that finds the work where it was re-reads only the
 * views on screen that are older than this, instead of every view on every poll.
 */
const QUIET_REFRESH_MS = 120_000;

/** The statuses of the steps that end, as one word: when it changes, a step began or finished and what the tabs read is stale. */
function stepsState(project: GeoProject): string {
  const steps = project.overview?.steps && Object.keys(project.overview.steps).length > 0 ? project.overview.steps : project.steps;
  return [project.status, project.updatedAt ?? "", ...WATCHED_STEPS.map((step) => `${step}:${steps[step]?.status ?? "none"}:${steps[step]?.updatedAt ?? ""}`)].join("|");
}

function stepsWorking(project: GeoProject): boolean {
  if (project.status === "paused") return false;
  return WATCHED_STEPS.some((step) => {
    const state = project.steps[step];
    return (state?.status === "running" || state?.status === "queued") && !stepAllowanceWait(state);
  });
}

/**
 * One authorized project shell for results, preserved answers and native conversations.
 * The compact workflow menu maps canonical steps to result destinations; one toolbar
 * holds result navigation and the active result's controls. Data and member abilities
 * remain shared, while SessionFrameHost places its resident conversation over the pane.
 * Anatomy: project header, eight-step rail and result pane. Variants: results/conversation.
 * States: loading, retry, empty and preserved partial results. Hit area: shared controls.
 * Keyboard: links/buttons retain native behavior. Long content: header truncation and wrapped results.
 * Theme: semantic tokens. Responsive: PageShell and native frame own their layouts.
 * Verification: GeoProjectPage.test.tsx covers host navigation and first actions; native input remains kernel-owned.
 */
export function GeoProjectLayout() {
  const { geoId = "" } = useParams();
  // Everything the page holds — the project it read, an open dialog, a busy button — belongs to one project: a switch to another
  // starts the page over, so a header still showing A never acts on B (rename, pause, export, delete all name `geoId`).
  return <GeoProjectView key={geoId} geoId={geoId} />;
}

function GeoProjectView({ geoId }: { geoId: string }) {
  const { tab: tabParam, snapshotId, sessionId: addressedSession } = useParams();
  const location = useLocation();
  const navigationType = useNavigationType();
  const scopeKey = geoReadScopeQuery(geoReadScopeFromSearch(location.search));
  const scope = useMemo(() => scopeKey ? geoReadScopeFromSearch(scopeKey) : undefined, [scopeKey]);
  const onChat = /\/chat(?:\/[^/]+)?\/?$/.test(location.pathname);
  const navigate = useNavigate();
  const feature = useGeoFeature();
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [reloads, setReloads] = useState(0);
  const [data] = useState(() => new GeoDataCache());
  const [toolbar, setToolbar] = useState<ToolbarProps | null | undefined>(undefined);
  /** The dialog the ⋯ menu — or a tab — opened: who else is in the project, who speaks for the product, its name, or the budget. */
  const [panel, setPanel] = useState<GeoPanel | null>(null);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [suggested, setSuggested] = useState<number | null>(null);
  const resolved = resolveGeoTab(onChat ? new URLSearchParams(location.search).get("result") : tabParam);
  // An answer is read inside the band and keeps 问题与回答 selected: it is where the answer was asked.
  const tab: GeoTabKey = snapshotId ? "questions" : resolved.tab;
  const viewParams = new URLSearchParams(location.search);
  const viewedStep = geoViewedStep(tab, { step: viewParams.get("step"), view: resolved.view ?? viewParams.get("view"),
    section: location.hash.slice(1), conversation: onChat || Boolean(snapshotId) });
  const shown = useRef<string | null>(null);
  const reading = useRef(false);
  const reloadQueued = useRef(false);
  const readEpoch = useRef(0);
  // The person came back to the page: the next read refreshes every view on screen, whatever it finds.
  const freshRead = useRef(false);

  useEffect(() => {
    // An address that named a step is rewritten to where that step is read now, in place, so the reader leaves with a link that
    // will keep working.
    const priorStep = new URLSearchParams(location.search).get("step");
    const keepWorkbench = Boolean(priorStep || location.hash) && priorStep !== viewedStep;
    if (!onChat && !snapshotId && (resolved.moved || keepWorkbench) && geoId) {
      const query = new URLSearchParams(location.search);
      const oldStep = GEO_STEP_KEYS.find(step => step === tabParam);
      const canonicalStep = resolved.moved && oldStep ? oldStep : viewedStep;
      if (canonicalStep) query.set("step", canonicalStep); else query.delete("step");
      const path = geoDestinationPath(geoId, { tab: resolved.tab, ...(resolved.view ? { view: resolved.view } : {}) }, query);
      const anchor = location.hash && (resolved.moved || navigationType !== "REPLACE") ? location.key : location.state?.geoLegacyAnchor;
      navigate(`${path}${location.hash}`, { replace: true, state: { ...location.state, geoLegacyAnchor: anchor } });
    }
  }, [onChat, snapshotId, resolved.moved, resolved.tab, resolved.view, viewedStep, geoId, navigate, navigationType, location.key, location.search, location.hash, location.state, tabParam]);

  useEffect(() => {
    if (feature === "loading" || feature === "off") return undefined;
    let live = true;
    const epoch = ++readEpoch.current;
    reading.current = true;
    reloadQueued.current = false;
    setLoaded(current => current.kind === "ready" && current.scopeError ? { ...current, scopeError: undefined } : current);
    void (scope ? getGeoProject(geoId, scope) : getGeoProject(geoId)).then(
      async (project) => {
        if (!live) return;
        // The shared views are read again when the work moved — a step began or ended, or the project's revision changed — and not
        // on every poll: each read of them is a set of requests of its own, every 10 s while a step runs. A view's own reads keep
        // their freshness (`STALE_MS`) and every write that changes one asks for it.
        const state = stepsState(project);
        if (shown.current !== null && document.visibilityState !== "hidden") {
          if (shown.current !== state || freshRead.current) data.invalidate();
          else data.refreshOlderThan(QUIET_REFRESH_MS);
        }
        if (document.visibilityState !== "hidden") freshRead.current = false;
        shown.current = state;
        setLoaded({ kind: "ready", project, scopeKey });
      },
      (error: unknown) => {
        if (!live) return;
        if (isGeoOff(error)) setLoaded({ kind: "off" });
        else if (error instanceof WebApiError && error.status === 404) setLoaded({ kind: "missing" });
        // A read that fails after the page has drawn keeps what it drew: a poll is not a reason to take the project away.
        else {
          const message = webErrorMessage(error, { fallback: "项目暂时无法读取。" });
          const denied = error instanceof WebApiError && [401, 403].includes(error.status);
          const stale = error instanceof WebApiError && error.status === 409;
          setLoaded(current => current.kind === "ready" && !denied
            ? current.scopeKey === scopeKey ? { ...current, refreshError: message, refreshStale: stale } : { ...current, scopeError: message }
            : { kind: "error", message });
        }
      },
    ).finally(() => {
      if (readEpoch.current !== epoch) return;
      reading.current = false;
      if (live && reloadQueued.current) {
        reloadQueued.current = false;
        if (document.visibilityState !== "hidden") setReloads(value => value + 1);
      }
    });
    return () => { live = false; };
  }, [feature, geoId, reloads, data, onChat, scope, scopeKey]);

  const reload = useCallback(() => {
    if (reading.current) { reloadQueued.current = true; return; }
    setReloads((value) => value + 1);
  }, []);

  // Hidden tabs do not poll; returning to the page gets a fresh view immediately.
  const watching = loaded.kind === "ready" && stepsWorking(loaded.project);
  useEffect(() => {
    if (loaded.kind !== "ready") return undefined;
    const refreshVisible = () => { if (document.visibilityState !== "hidden") reload(); };
    const returned = () => { if (document.visibilityState !== "hidden") { freshRead.current = true; reload(); } };
    const timer = window.setInterval(refreshVisible, watching ? WATCH_MS : IDLE_WATCH_MS);
    document.addEventListener("visibilitychange", returned);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", returned); };
  }, [loaded.kind, watching, reload]);

  const openPanel = useCallback((next: GeoPanel) => {
    if (next !== "budget") {
      setPanel(next);
      return;
    }
    // The tier's own suggestion fills the budget field; where it cannot be read the dialog opens empty and the person types the number.
    void getGeoDistribution(geoId)
      .then((distribution) => setSuggested(typeof distribution?.suggestedBudgetCny === "number" ? distribution.suggestedBudgetCny : null), () => setSuggested(null))
      .finally(() => setPanel("budget"));
  }, [geoId]);

  // The conversation the page holds: the one on screen, else the one the address carries from it (`?session=`), else the project's
  // own. The header's 「对话」 and every 「写纠错稿」 below it open this one (`useOpenGeoConversation`).
  const heldSession = addressedSession ?? new URLSearchParams(location.search).get("session");
  const api = useMemo<GeoFrameApi | null>(
    () => (loaded.kind === "ready" ? { geoId, scope, scopePending: loaded.scopeKey !== scopeKey, scopeError: loaded.scopeError,
      project: loaded.project, tab, conversation: heldSession ?? loaded.project.sessionId ?? null, step: viewedStep, refreshError: loaded.refreshError,
      refreshStale: loaded.refreshStale, reload, openPanel, data, setToolbar,
      openAnalysisScope: () => setScopeOpen(true),
      refreshScope: () => {
        // The stale refusal is answered by leaving the selection: what it said no longer stands, so it is not shown as pending.
        setLoaded(current => current.kind === "ready" ? { ...current, refreshError: undefined, refreshStale: undefined } : current);
        if (scope?.selectionRef && loaded.project.scope) {
          navigate({ pathname: location.pathname, search: geoSearchWithScope(location.search, { ...loaded.project.scope, selectionRef: undefined }) }, { replace: true });
        } else reload();
        data.invalidate();
      },
    } : null),
    [geoId, loaded, tab, heldSession, viewedStep, reload, openPanel, data, scope, scopeKey, navigate, location.pathname, location.search],
  );

  if (feature === "off" || loaded.kind === "off") return <GeoOffPage />;
  if (loaded.kind === "missing") {
    return (
      <PageShell title="循证 GEO" width="wide">
        <EmptyState icon={Radar} title="这个项目不存在或已删除。" action={<Button variant="secondary" onClick={() => navigate("/app/geo")}>回到项目列表</Button>} />
      </PageShell>
    );
  }
  if (loaded.kind !== "ready" || !api) {
    return (
      <PageShell title="循证 GEO" width="wide">
        {loaded.kind === "error" ? <>
          <LoadError message={loaded.message} onRetry={reload} />
          {scopeKey && <Button variant="text" onClick={() => navigate({ pathname: location.pathname, search: geoSearchWithScope(location.search, {}) }, { replace: true })}>清除分析范围</Button>}
        </> : <GeoProjectSkeleton />}
      </PageShell>
    );
  }

  return (
    <GeoFrameContext.Provider value={api}>
      <GeoBand api={api} onChat={onChat} addressedSession={addressedSession} toolbar={toolbar} panel={panel} suggested={suggested} onPanel={setPanel} scopeOpen={scopeOpen} onScopeOpen={setScopeOpen} />
    </GeoFrameContext.Provider>
  );
}

/** The page: the header, the fixed band and the body that is the route's child. Below the cache's provider, so it reads through it. */
function GeoBand({
  api,
  onChat,
  addressedSession,
  toolbar,
  panel,
  suggested,
  onPanel,
  scopeOpen,
  onScopeOpen: setScopeOpen,
}: {
  api: GeoFrameApi;
  onChat: boolean;
  addressedSession?: string;
  toolbar: ToolbarProps | null | undefined;
  panel: GeoPanel | null;
  suggested: number | null;
  onPanel: (panel: GeoPanel | null) => void;
  scopeOpen: boolean;
  onScopeOpen: (open: boolean) => void;
}) {
  const { geoId, project, tab, reload } = api;
  const { snapshotId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const openConversation = useOpenGeoConversation();
  const monitoring = useGeoMonitoring(geoId);
  const dataRefreshError = useSyncExternalStore(api.data.subscribe, api.data.refreshError, api.data.refreshError);
  const dataRefreshStale = useSyncExternalStore(api.data.subscribe, api.data.refreshStale, api.data.refreshStale);
  // A saved selection (`selectionRef`) is refused with 409 once its data changed; 重试更新 would send the same reference forever.
  const selectionStale = Boolean(api.scope?.selectionRef) && (api.refreshStale === true || dataRefreshStale);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const handledAnchors = useRef(new Set<string>());

  // A destination with a block (`#geo-errors`) is scrolled to once it is on the page, below the band (the scroller's
  // `scroll-padding-top` is the band's height). A block that never comes leaves the tab at its top.
  // It is each navigation's, not each address's: pressing 「诊断」 again after scrolling away brings the block back, while a filter
  // chip (which rewrites the query in place) leaves the reader where they are.
  const arrived = useNavigationType();
  useEffect(() => {
    const id = location.hash.slice(1);
    const legacy = typeof location.state?.geoLegacyAnchor === "string" ? location.state.geoLegacyAnchor : null;
    if (!id || (arrived === "REPLACE" && (!legacy || handledAnchors.current.has(legacy)))) return undefined;
    let tries = 0;
    const find = () => {
      const element = document.getElementById(id);
      if (element) {
        handledAnchors.current.add(legacy ?? location.key);
        scrollBlockToTop(element);
        return true;
      }
      return ++tries > 25;
    };
    if (find()) return undefined;
    const timer = window.setInterval(() => { if (find()) window.clearInterval(timer); }, 120);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

  /**
   * Starts work and keeps the person where they are: the request is taken, the toast says so (and where the run is read), and the page
   * reads itself again. The run is a step of the programme, not a conversation — there is no session in the answer to go to.
   */
  const start = (key: string, work: () => Promise<GeoStartAnswer>, said: { started: string; queued: string }, failure: string) => {
    if (busy) return;
    setBusy(key);
    void work()
      .then((answer) => {
        toast.success(answer.runId ? said.started : said.queued, { action: { label: "查看", onClick: () => onPanel("runs") } });
        reload();
      })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: failure })))
      .finally(() => setBusy(null));
  };
  const startProposal = () => start("proposal", () => exportGeo(geoId, "proposal"),
    { started: "已开始生成提案资料包。", queued: "提案资料包排在前一项之后，做完会自动开始。" }, "提案资料包无法导出，请稍后重试。");
  const startWeekly = () => start("weekly", () => exportGeo(geoId, "weekly"),
    { started: "已开始生成周报。", queued: "周报排在前一项之后，做完会自动开始。" }, "周报无法导出，请稍后重试。");
  /** The conversation the page holds (`GeoFrameApi.conversation`: never a step the programme ran); none yet opens a new one. */
  const params = new URLSearchParams(location.search);
  const heldSession = api.conversation;
  // The project's own conversation is opened as the primary (`primarySessionId`): the server swaps in a new one for its owner when the
  // kernel has lost it. Only an addressed conversation is asked for by name.
  const target = { geoId, projectId: project.projectId, sessionId: heldSession, primarySessionId: project.sessionId ?? null };
  // What the account may do here: the owner everything, a member what their roles allow. The server judges every operation all the
  // same; the page only does not offer what would be refused.
  const abilities = project.access?.abilities;
  const can = (ability: string) => !abilities || abilities.includes(ability);
  // Opening the conversation (and everything that hands it a draft) takes both, as the module's descriptor does. A role without them
  // reads the conversation the project keeps, as it was.
  const canConverse = can("run") && can("edit");
  const readOnlyChat = heldSession ? `${geoChatPath(geoId, heldSession)}?${(() => {
    const kept = new URLSearchParams(location.search);
    if (!onChat) kept.set("result", snapshotId ? "questions" : tab);
    return kept.toString();
  })()}` : null;
  // The bare conversation address: opened for a role that may converse, the kept one for a role that reads, and said in place when
  // neither can be shown — a page left on its skeleton is a page that never says what happened.
  const [conversationError, setConversationError] = useState<string | null>(null);
  const [conversationAttempt, setConversationAttempt] = useState(0);
  useEffect(() => {
    if (!onChat || addressedSession) return undefined;
    setConversationError(null);
    if (!canConverse) {
      if (heldSession) navigate(`${geoChatPath(geoId, heldSession)}${location.search}`, { replace: true });
      return undefined;
    }
    let live = true;
    void openConversation({ geoId, projectId: project.projectId, sessionId: heldSession, primarySessionId: project.sessionId ?? null })
      .then((opened) => { if (live && !opened) setConversationError("对话暂时无法打开，请稍后重试。"); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the search is carried along, never a reason to open again
  }, [onChat, addressedSession, heldSession, geoId, project.projectId, openConversation, canConverse, conversationAttempt, navigate]);
  const openChat = () => {
    if (busy) return;
    if (!canConverse) { if (readOnlyChat) navigate(readOnlyChat); return; }
    setBusy("conversation");
    void openConversation(target).finally(() => setBusy(null));
  };
  // What a reader of the AI-run record needs to know to read it again: a step that began or ended, or the project moving on.
  const runsVersion = [project.updatedAt ?? "", ...GEO_STEP_KEYS.map((step) => `${step}:${project.steps[step]?.status ?? "none"}`)].join("|");
  const readRunRecord = useCallback(async (run: ProgrammeRun) => {
    if (!run.runId) throw new Error('An exact execution is required.');
    const record = await getGeoSignalRunRecord(geoId, null, run.runId);
    if (record.runId !== run.runId || record.sessionId !== run.sessionId) throw new Error('The returned execution does not match.');
    return { history: record.history, files: record.files.map(file => ({ ...file, href: geoSignalResultHref(geoId, null, file) })) };
  }, [geoId]);

  const paused = project.status === "paused";
  const watched = monitoring.state.kind === "ready" ? monitoring.state.data : null;
  // Only a confirmed empty project changes the first action; historical partial work keeps its exports.
  const unstarted = Boolean(watched && Object.values(project.steps).every(step => step.status === "none" && !step.requested && !step.runId && !step.roundId && !step.summary)
    && project.overview.week.length === 0 && project.overview.metrics.every(metric => metric.cell.value == null && !(metric.cell.denominator || metric.cell.numerator) && metric.trend.length === 0)
    && !watched.series.some(series => series.points.length > 0) && !watched.byEngine.some(engine => engine.points.length > 0));
  const setPaused = (pause: boolean) => {
    void patchGeoProject(geoId, { status: pause ? "paused" : "active" })
      .then(() => { toast.success(pause ? "已暂停，测量和投放都停下了。" : "已继续。"); reload(); })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "项目状态无法修改，请稍后重试。" })));
  };
  const menu: MenuEntry[] = [
    ...(can("edit") ? [{ label: "重命名", onSelect: () => onPanel("rename") }] : []),
    // The engines, the window, the budget, who speaks for the product and the members: one drawer, not four entries.
    { label: "项目设置", onSelect: () => onPanel("settings") },
    ...(can("run") && unstarted ? [{ label: "导出周报", onSelect: startWeekly }] : []),
    ...(can("run") ? [{ label: "导出提案资料包", onSelect: startProposal }] : []),
    // What the programme did in the background, read-only — the steps are in no conversation list.
    { label: "AI 运行", onSelect: () => onPanel("runs") },
    // A paused project's 「继续」 is in the header, beside the word that says it is paused.
    ...(can("edit") && !paused ? [{ label: "暂停", onSelect: () => setPaused(true) }] : []),
    ...(can("delete") ? ["separator" as const, { label: "删除", destructive: true, onSelect: () => setConfirmDelete(true) }] : []),
  ];

  const remove = () => {
    setConfirmDelete(false);
    void deleteGeoProject(geoId)
      .then(() => {
        // GEO removal leaves the ordinary project and its conversations/files intact.
        void useProjectStore.getState().load();
        navigate("/app/geo", { replace: true });
      })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "项目无法删除，请稍后重试。" })));
  };

  const week = weekOf(project.startedAt ?? project.createdAt ?? null);
  const now = bandNow(project, watched?.next ?? null, undefined, watched?.measurement ?? null);
  const destination = (next: GeoTabKey, view?: string, step?: string, section?: string) => {
    const kept = new URLSearchParams(geoAnalysisSearch(params.toString(), null));
    kept.delete("questionMode");
    // 方案's focus on one source or page belongs to the visit that set it (a source's 「打开实施方案」); leaving 方案 ends it, so a later
    // visit — 「调整方案」 included — reads the whole plan again. The analysis range (selectionRef) stays: the band shows it as 「分析范围」.
    if (!(next === "plan" && tab === "plan")) { kept.delete("planSource"); kept.delete("planUrl"); }
    const nextView = view ?? (next === tab && step === undefined ? params.get("view") ?? undefined : undefined);
    if (!nextView) kept.delete("view");
    // Only an addressed conversation travels in the address: the project's own is where every open begins, and a copy of its id turned
    // an open into a request for exactly that session, which a kernel that had lost it could only refuse.
    if (heldSession && heldSession !== project.sessionId) kept.set("session", heldSession); else kept.delete("session");
    const nextStep = step ?? geoViewedStep(next, { view: nextView, section });
    if (nextStep) kept.set("step", nextStep); else kept.delete("step");
    return geoDestinationPath(geoId, { tab: next, view: nextView, section }, kept);
  };
  const steps = bandSteps(project, (step) => destination(GEO_STEP_HOME[step].tab, GEO_STEP_HOME[step].view, step, GEO_STEP_HOME[step].section));
  const selectedStep = api.step ?? null;

  // The one text button that continues this tab's step. It is drawn here, so it is there whether the tab has anything yet or not.
  const product = project.product?.brandName || project.product?.genericName || project.name;
  const ask = (draft: string) => () => { void openConversation(target, draft); };
  const needsBudget = marketConnected(project) && !(project.budget && project.budget.totalCny > 0);
  const continues: { label: string; onClick: () => void } | null = selectedStep === "distribution" && needsBudget && can("manage_money")
    ? { label: "设预算", onClick: () => api.openPanel("budget") }
    : !canConverse ? null
      : selectedStep === "evidence" ? { label: "让 AI 补充结论", onClick: ask(`请在现有结论库的基础上，补充${product}还没有覆盖的说明书内容和临床证据，每条结论都带原文出处。`) }
        : selectedStep === "journey" ? { label: "让 AI 重画旅程", onClick: ask(`请根据最新的结论和 AI 的回答，重新画一遍${product}的患者与医生旅程。`) }
          : selectedStep === "questions" ? { label: "加问", onClick: ask(`请再补几个值得测量的问题，覆盖${product}现有问句池里还没有问到的情形。`) }
            : selectedStep === "sources" ? { label: "选目标档", onClick: () => navigate(destination("plan", undefined, "sources", "targets")) }
              : selectedStep === "content" ? { label: "让 AI 写下一批", onClick: ask("请为现在还没有稿件的问题群写下一批稿件，先写讲错最严重、离目标最远的。") } : null;
  const analysis = !onChat && !snapshotId ? geoAnalysisDescriptor(location.search) : null;
  const changeAnalysis = (descriptor: Parameters<typeof geoAnalysisSearch>[1]) => navigate({ pathname: location.pathname, search: geoAnalysisSearch(location.search, descriptor), hash: location.hash },
    { replace: geoAnalysisChangeReplaces(location.search, descriptor) });
  const controls = onChat ? undefined : toolbar;
  const relatedViews: Array<{ value: GeoTabKey; label: string }> = selectedStep === "diagnosis"
    ? [{ value: "visibility", label: "可见度" }, { value: "accuracy", label: "准确与安全" }]
    : selectedStep === "sources" ? [{ value: "sources", label: "信源" }, { value: "plan", label: "方案" }]
      : selectedStep === "monitoring" ? [{ value: "visibility", label: "趋势" }, { value: "actions", label: "执行记录" }] : [];
  const bandToolbar: ToolbarProps = {
    ...(controls ?? {}),
    views: undefined,
    summary: controls?.summary,
    navigation: [
      ...(!onChat && !snapshotId ? [{ kind: "select" as const, label: "数据分析", value: analysis?.viewId ?? null, allLabel: "当前业务", options: GEO_ANALYSIS_OPTIONS, onChange: (value: string | null) => changeAnalysis(value ? geoAnalysisDescriptorForView(value as NonNullable<typeof analysis>["viewId"], analysis) : null) }] : []),
      ...(!onChat && !analysis && relatedViews.length > 1 ? [{ kind: "select" as const, label: "分析视图", value: tab, pinned: true,
        options: relatedViews, onChange: (next: string | null) => { if (next) navigate(destination(next as GeoTabKey, undefined, selectedStep ?? undefined)); } }] : []),
      ...(controls?.navigation ?? []),
      ...(controls?.views ? [{ kind: "select" as const, label: controls.views.label,
        value: controls.views.value, options: controls.views.items.map((item) => ({ value: item.value, label: item.label })),
        onChange: (next: string | null) => { if (next) controls.views?.onChange(next); } }] : []),
    ],
    filters: controls?.filters,
    // The range is shown wherever it narrows what is read — every view's analysis and 方案's strategy — so a range carried in the
    // address never applies unsaid; 行动's monitoring view reads none.
    scopeAction: !onChat && (analysis || !(tab === "actions" && selectedStep === "monitoring")) ? {id:"analysis-scope",label:`分析范围${geoReadScopeQuery(api.scope) ? " · 已筛选" : ""}`,onSelect:()=>setScopeOpen(true)} : undefined,
    actionPlan: !controls?.actions && !onChat && !analysis && continues
      ? {...controls?.actionPlan, ...(controls?.actionPlan?.primary
        ? {secondary:[{id:"continue-step",label:continues.label,onSelect:continues.onClick},...(controls.actionPlan.secondary??[])]}
        : {primary:{id:"continue-step",label:continues.label,onSelect:continues.onClick}})} : controls?.actionPlan,
    // Journey downloads own their stateful producer. Preserve it while the scope action remains separately declared.
    actions: controls?.actions ? <>{controls.actions}{!onChat && !analysis && continues && <Button variant="text" size="sm" onClick={continues.onClick}>{continues.label}</Button>}</> : undefined,
  };

  return (
    <PageShell<GeoTabKey>
      title={project.name}
      back={tab !== "overview" || onChat ? <Link className="text-ui text-accent" to={destination("overview")}>项目总览</Link> : undefined}
      steps={{ label: "循证 GEO 进度", steps, activeSteps: selectedStep ? [selectedStep] : [], trailing: now, visible: true, showState: true }}
      documentTitle={GEO_MONITORING_TABS.includes(tab) ? `${project.name} · ${GEO_MONITORING_TITLE}` : undefined}
      width={onChat ? "full" : "wide"}
      contentClassName={onChat ? "flex min-h-96 flex-col" : undefined}
      meta={<Tag title={week ? "按项目开始日期计算，不代表已经完成测量。" : now ?? undefined}>{`${paused ? "已暂停 · " : ""}${week ? `项目第 ${week} 周` : coverageText(project.coverageDays, project.startedAt ?? project.createdAt ?? null)}`}</Tag>}
      actionPlan={{
        // A project nothing has run in yet starts in its conversation; the weekly report waits in the overflow until there is a week to report.
        ...(!onChat && (canConverse || readOnlyChat) ? { primary: { id: "conversation", label: unstarted && canConverse ? "开始项目" : "对话", icon: MessageSquare, loading: busy === "conversation", onSelect: openChat } } : {}),
        secondary: [
          ...(can("run") && !unstarted ? [{ id: "weekly", label: "周报", icon: FileDown, loading: busy === "weekly", onSelect: startWeekly }] : []),
          ...(paused && can("edit") ? [{ id: "resume", label: "继续", onSelect: () => setPaused(false) }] : []),
        ],
        overflow: menu,
      }}
      toolbar={bandToolbar}
    >
      {selectionStale ? <Note action={<Button variant="secondary" size="sm" onClick={() => api.refreshScope?.()}>读取最新结果</Button>}>
        所选范围里的数据已经更新，仍显示上次结果。
      </Note> : (api.refreshError || dataRefreshError) && <Note action={<Button variant="secondary" size="sm" onClick={() => { reload(); api.data.invalidate(); }}>重试更新</Button>}>
        更新暂时失败，仍显示上次结果。{api.refreshError || dataRefreshError}
      </Note>}
      {onChat ? (
        conversationError ? <LoadError message={conversationError} onRetry={() => setConversationAttempt((value) => value + 1)} />
          : !addressedSession && !canConverse && !heldSession ? <EmptyState icon={MessageSquare} title="这个项目还没有对话" action={<Button variant="secondary" onClick={() => navigate(destination("overview"))}>回到项目总览</Button>} />
          : addressedSession ? <GeoConversationPane canRun={can("run") && can("edit")} owner={project.access?.owner ?? true} geoId={geoId} projectId={project.projectId} sessionId={addressedSession} /> : <TabSkeleton rows={4} />
      ) : snapshotId ? (
        // One answer, read inside the band: the route's own element, which may still be on its way.
        <Suspense fallback={<TabSkeleton rows={4} />}><Outlet context={api} /></Suspense>
      ) : (
        <>
          {!analysis && project.signalsSupported && <GeoSignalsWorkbench geoId={geoId} project={project} step={api.step} />}
          {api.scopePending && (api.scopeError ? <LoadError message={api.scopeError} onRetry={reload} /> : <TabSkeleton />)}
          <div hidden={api.scopePending || !analysis && project.signalsSupported && params.has("signal")}><PendingFeedbackBoundary mode={api.scopePending || !analysis && project.signalsSupported && params.has("signal") ? "inactive" : "active"}>{analysis ? <GeoAnalysisMainArea api={api} /> : <GeoTab api={api} />}</PendingFeedbackBoundary></div>
        </>
      )}
      {scopeOpen && <GeoScopeDialog geoId={geoId} project={project} initial={api.scope?.selectionRef && project.scope ? { ...project.scope, selectionRef: api.scope.selectionRef } : api.scope} onClose={() => setScopeOpen(false)} onApply={next => {
        setScopeOpen(false);
        const query = geoSearchWithScope(location.search, next);
        navigate({ pathname: location.pathname, search: query ? `?${query}` : "", hash: location.hash }, { replace: true });
      }} />}
      {panel === "settings" && (
        <GeoSettingsDrawer
          geoId={geoId}
          project={project}
          onClose={() => onPanel(null)}
          onOpen={(next) => api.openPanel(next)}
          onChanged={() => { reload(); api.data.invalidate(); }}
        />
      )}
      {panel === "members" && <MembersDialog geoId={geoId} onClose={() => onPanel(null)} />}
      {panel === "runs" && <ProgrammeRunsDrawer projectId={project.projectId} load={() => getGeoProgrammeRuns(geoId)} loadMore={(cursor) => getGeoProgrammeRuns(geoId, cursor)} readRecord={project.signalsSupported ? readRunRecord : undefined} version={runsVersion} onClose={() => onPanel(null)} />}
      {panel === "rename" && (
        <RenameDialog
          geoId={geoId}
          initial={project.name}
          onCancel={() => onPanel(null)}
          onSaved={() => {
            onPanel(null);
            reload();
            // The sidebar lists the project by this name too.
            void useProjectStore.getState().load();
            toast.success("已重命名。");
          }}
        />
      )}
      {panel === "producer" && <ProducerDialog geoId={geoId} initial={project.producer ?? null} onSaved={() => { onPanel(null); reload(); }} onCancel={() => onPanel(null)} />}
      {panel === "budget" && (
        <BudgetDialog
          geoId={geoId}
          initial={project.budget && project.budget.totalCny > 0 ? project.budget : null}
          suggestedTotal={suggested}
          onCancel={() => onPanel(null)}
          onSaved={() => {
            onPanel(null);
            toast.success("预算已设好，稿件会在预算内自动投放。");
            reload();
            api.data.invalidate();
          }}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={`删除“${project.name}”？`}
          body="此操作会将项目从循证 GEO 列表中移除，并停止后续处理。项目的对话和文件会保留，已经发布的稿件不会被撤下。"
          confirmLabel="删除"
          onConfirm={remove}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </PageShell>
  );
}

/**
 * The tab the address names, and the one heading the outline needs — page title, tab, blocks — whose blocks' own titles are
 * third-level. It is drawn by the layout and not by a route element of its own (see `router.tsx`).
 *
 * Memoised on the frame: a tab calls `useGeoToolbar` after each of its renders, which sets the band's state, which re-renders the
 * band — and a tab re-rendered by that would set the state again. The frame's value changes only when the project, the tab or a
 * callback does, so the band re-rendering for its toolbar leaves the tab alone.
 */
const GeoTab = memo(function GeoTab({ api }: { api: GeoFrameApi }) {
  const Tab = TABS[api.tab];
  return (
    <>
      <h2 className="sr-only">{GEO_TABS.find((item) => item.key === api.tab)?.label}</h2>
      {api.tab === "actions" ? <ActionsTab key={api.step} geoId={api.geoId} project={api.project}
        mode={api.step === "distribution" ? "distribution" : api.step === "monitoring" ? "monitoring" : "content"} />
        : <Tab geoId={api.geoId} project={api.project} />}
    </>
  );
});

/** The analysis owns its controls; memoization prevents toolbar publication from remounting/rerendering its producer. */
const GeoAnalysisMainArea = memo(function GeoAnalysisMainArea({ api }: { api: GeoFrameApi }) {
  const location = useLocation();
  const navigate = useNavigate();
  const analysis = geoAnalysisDescriptor(location.search);
  if (!analysis) return null;
  // A filter or a search inside the open view replaces its history entry; opening, switching and leaving a view add one.
  const change = (descriptor: Parameters<typeof geoAnalysisSearch>[1]) => navigate({ pathname: location.pathname, search: geoAnalysisSearch(location.search, descriptor), hash: location.hash },
    { replace: geoAnalysisChangeReplaces(location.search, descriptor) });
  return <section data-geo-main-area="analysis" className="flex flex-col gap-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-section font-semibold">{GEO_ANALYSIS_OPTIONS.find(item => item.value === analysis.viewId)?.label}</h2><Button variant="text" onClick={() => change(null)}>返回{GEO_TABS.find(item => item.key === api.tab)?.label}</Button></div>
    <GeoAnalysisWorkbench geoId={api.geoId} project={api.project} mainArea={{ descriptor: analysis, onChange: change }} />
  </section>;
});
