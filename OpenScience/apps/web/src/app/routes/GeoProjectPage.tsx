import { sanitizeRuntimeUiHistoryState } from "@/lib/runtimeUiNavigation";
import { PendingFeedbackBoundary } from "@/components/ui/PendingFeedback";
import { memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import { Link, Outlet, useLocation, useNavigate, useNavigationType, useParams } from "react-router";
import { FileDown, MessageSquare, PenLine, Radar } from "lucide-react";
import { workStateLabel } from "@evimed/domain";
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
import { geoResultDrawerProps } from "@/components/geo/spine/drawerParams";
import { GEO_ANALYSIS_OPTIONS, geoAnalysisChangeReplaces, geoAnalysisDescriptor, geoAnalysisDescriptorForView, geoAnalysisOptionsForTab, geoAnalysisSearch, geoAnalysisTabForView } from "@/components/geo/geoAnalysisMode";
import { GeoConversationPane } from "@/components/geo/GeoConversationPane";
import { GeoWorkDetails } from "@/components/geo/GeoWorkDetails";
import { geoChatPath, geoConversationPane, geoPanePath } from "@/lib/geoLocation";
import { sessionGeneration, subscribeSessionBoundary } from "@/lib/sessionLifecycle";
import { useProjectStore } from "@/lib/projects";
import { useContainerNarrow } from "@/lib/useContainerNarrow";
import { toast } from "@/lib/toast";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { PageShell } from "@/components/layout/PageShell";
import type { PageActionPlan } from "@/components/layout/HeaderActions";
import { useWorkspaceSplit, WorkspaceSplit } from "@/components/workspace/WorkspaceSplit";
import { GeoJourneySummary } from "@/components/geo/GeoJourneySummary";
import { NeedsYou } from "@/components/geo/NeedsYou";
import { geoJourney } from "@/components/geo/geoJourney";
import { geoScopeSummary } from "@/components/geo/geoScopeSummary";
import { geoPathWithContext } from "@/components/geo/useGeoPath";
import { tabPath } from "@/components/geo/tabs/geoTabText";
import { Button } from "@/components/ui/Button";
import { ProgrammeRunsDrawer } from "@/components/runs/ProgrammeRunsDrawer";
import { GeoSignalsWorkbench } from "@/components/geo/GeoSignalsWorkbench";
import { getGeoSignalRunRecord, geoSignalResultHref } from "@/lib/geoSignalsClient";
import type { ProgrammeRun } from "@/lib/programmeRuns";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { type MenuEntry } from "@/components/ui/Menu";
import { Tag } from "@/components/ui/Tag";
import { Note } from "@/components/ui/Note";
import { Select } from "@/components/ui/Input";
import type { ToolbarProps } from "@/components/ui/Toolbar";
import { GeoOffPage, GeoProjectSkeleton } from "@/components/geo/GeoStates";
import { TabSkeleton } from "@/components/geo/tabs/geoTabKit";
import { GeoScopeDialog } from "@/components/geo/GeoScopeDialog";
import { geoReadScopeFromSearch, geoReadScopeQuery, geoSearchWithScope } from "@/lib/geoReadScope";
import { GeoSettingsDrawer } from "@/components/geo/GeoSettingsDrawer";
import { MembersDialog } from "@/components/geo/MembersDialog";
import { ProducerDialog } from "@/components/geo/ProducerDialog";
import { RenameDialog } from "@/components/geo/RenameDialog";
import { bandNow, geoActivity, geoStepView } from "@/components/geo/geoBand";
import { stopGeoStepRun } from "@/lib/geoClient";
import { CONVERSATION_SETTLED_EVENT } from "@/lib/runtimeUiBridge";
import { GEO_ANSWER_BACK_NAMES, GeoFrameContext, type GeoAnswerBack, type GeoFrameApi, type GeoPanel } from "@/components/geo/geoFrame";
import { GeoDataCache, useGeoMonitoring } from "@/components/geo/geoProjectData";
import { scrollBlockToTop } from "@/components/geo/geoScroll";
import { coverageText, GEO_MONITORING_TITLE, weekOf } from "@/components/geo/geoText";
import {
  GEO_MONITORING_TABS,
  GEO_STEP_HOME,
  GEO_TABS,
  geoDestinationPath,
  geoWorkArea,
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
 * Contextual project navigation maps the preserved execution steps to result destinations;
 * the active area's tabs and toolbar hold its views. Data and member abilities remain
 * shared, while SessionFrameHost places its resident conversation over the pane.
 * Anatomy: project header, contextual tabs, results and optional conversation.
 * States: loading, retry, empty and preserved partial results. Hit area: shared controls.
 * Keyboard: links/buttons retain native behavior. Long content: header truncation and wrapped results.
 * Theme: semantic tokens. Responsive: PageShell and native frame own their layouts.
 * Verification: GeoProjectPage.test.tsx covers host navigation and first actions; native input remains kernel-owned.
 */
export function GeoProjectLayout() {
  const { geoId = "" } = useParams();
  const accountGeneration = useSyncExternalStore(subscribeSessionBoundary, sessionGeneration, sessionGeneration);
  // Everything the page holds — the project it read, an open dialog, a busy button — belongs to one project: a switch to another
  // starts the page over, so a header still showing A never acts on B (rename, pause, export, delete all name `geoId`).
  return <GeoProjectView key={`${accountGeneration}:${geoId}`} geoId={geoId} />;
}

function GeoProjectView({ geoId }: { geoId: string }) {
  const { tab: tabParam, snapshotId, sessionId: routeSession } = useParams();
  const location = useLocation();
  const navigationType = useNavigationType();
  const scopeKey = geoReadScopeQuery(geoReadScopeFromSearch(location.search));
  const scope = useMemo(() => scopeKey ? geoReadScopeFromSearch(scopeKey) : undefined, [scopeKey]);
  const legacyChat = /\/chat(?:\/[^/]+)?\/?$/.test(location.pathname);
  const queryPane = geoConversationPane(location.pathname, location.search);
  const onChat = legacyChat || queryPane !== null;
  const addressedSession = routeSession ?? queryPane?.sessionId;
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
  // Where the way back goes from the answer on the page (`useGeoAnswerBack`): the answer knows, the band draws the one control.
  const [answerBack, setAnswerBack] = useState<GeoAnswerBack | null>(null);
  const resolved = resolveGeoTab(legacyChat ? new URLSearchParams(location.search).get("result") : tabParam);
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
    if (!legacyChat && !snapshotId && (resolved.moved || keepWorkbench) && geoId) {
      const query = new URLSearchParams(location.search);
      const oldStep = GEO_STEP_KEYS.find(step => step === tabParam);
      const canonicalStep = resolved.moved && oldStep ? oldStep : viewedStep;
      if (canonicalStep) query.set("step", canonicalStep); else query.delete("step");
      const path = geoDestinationPath(geoId, { tab: resolved.tab, ...(resolved.view ? { view: resolved.view } : {}) }, query);
      const anchor = location.hash && (resolved.moved || navigationType !== "REPLACE") ? location.key : location.state?.geoLegacyAnchor;
      navigate(`${path}${location.hash}`, { replace: true, state: { ...sanitizeRuntimeUiHistoryState(location.state) as Record<string, unknown>, geoLegacyAnchor: anchor } });
    }
  }, [legacyChat, snapshotId, resolved.moved, resolved.tab, resolved.view, viewedStep, geoId, navigate, navigationType, location.key, location.search, location.hash, location.state, tabParam]);

  useEffect(() => {
    const query = new URLSearchParams(location.search);
    if (query.get("panel") !== "settings") return;
    setPanel("settings");
    query.delete("panel");
    navigate({ pathname: location.pathname, search: query.toString(), hash: location.hash }, { replace: true, state: sanitizeRuntimeUiHistoryState(location.state) });
  }, [location.pathname, location.search, location.hash, location.state, navigate]);

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

  // A turn of the conversation beside the page ended, and may have written what the page shows: read it now, with every view on screen.
  useEffect(() => {
    const settled = () => { freshRead.current = true; reload(); };
    window.addEventListener(CONVERSATION_SETTLED_EVENT, settled);
    return () => window.removeEventListener(CONVERSATION_SETTLED_EVENT, settled);
  }, [reload]);

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
  // own. The conversation dock and correction actions open this one (`useOpenGeoConversation`).
  const heldSession = addressedSession ?? new URLSearchParams(location.search).get("session");
  const api = useMemo<GeoFrameApi | null>(
    () => (loaded.kind === "ready" ? { geoId, scope, scopePending: loaded.scopeKey !== scopeKey, scopeError: loaded.scopeError,
      project: loaded.project, tab, conversation: heldSession ?? loaded.project.sessionId ?? null, step: viewedStep, refreshError: loaded.refreshError,
      refreshStale: loaded.refreshStale, reload, openPanel, data, setToolbar, setAnswerBack,
      openAnalysisScope: () => setScopeOpen(true),
      refreshScope: () => {
        // The stale refusal is answered by leaving the selection: what it said no longer stands, so it is not shown as pending.
        setLoaded(current => current.kind === "ready" ? { ...current, refreshError: undefined, refreshStale: undefined } : current);
        if (scope?.selectionRef && loaded.project.scope) {
          navigate({ pathname: location.pathname, search: geoSearchWithScope(location.search, { ...loaded.project.scope, selectionRef: undefined }), hash: location.hash }, { replace: true, state: sanitizeRuntimeUiHistoryState(location.state) });
        } else reload();
        data.invalidate();
      },
    } : null),
    [geoId, loaded, tab, heldSession, viewedStep, reload, openPanel, data, scope, scopeKey, navigate, location.pathname, location.search, location.hash, location.state, setAnswerBack],
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
          {scopeKey && <Button variant="text" onClick={() => navigate({ pathname: location.pathname, search: geoSearchWithScope(location.search, {}), hash: location.hash }, { replace: true, state: sanitizeRuntimeUiHistoryState(location.state) })}>清除分析范围</Button>}
        </> : <GeoProjectSkeleton />}
      </PageShell>
    );
  }

  return (
    <GeoFrameContext.Provider value={api}>
      <GeoBand api={api} onChat={onChat} legacyChat={legacyChat} addressedSession={addressedSession} toolbar={toolbar} answerBack={answerBack} panel={panel} suggested={suggested} onPanel={setPanel} scopeOpen={scopeOpen} onScopeOpen={setScopeOpen} />
    </GeoFrameContext.Provider>
  );
}

/** The page: the header, the fixed band and the body that is the route's child. Below the cache's provider, so it reads through it. */
function GeoBand({
  api,
  onChat,
  legacyChat,
  addressedSession,
  toolbar,
  answerBack,
  panel,
  suggested,
  onPanel,
  scopeOpen,
  onScopeOpen: setScopeOpen,
}: {
  api: GeoFrameApi;
  onChat: boolean;
  legacyChat: boolean;
  addressedSession?: string;
  toolbar: ToolbarProps | null | undefined;
  answerBack: GeoAnswerBack | null;
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
  const workspaceWidth = useRef<HTMLDivElement>(null);
  const viewportSplit = useWorkspaceSplit();
  const narrowWorkspace = useContainerNarrow(workspaceWidth, 960);
  const split = viewportSplit && !narrowWorkspace;
  // Under the breakpoint an open conversation covers the results, and what controls them goes with them.
  const coverChat = onChat && !split;
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
  const answerArrival = useRef<{ id: string; navigation: typeof arrived } | null>(null);
  if (!snapshotId) answerArrival.current = null;
  else if (answerArrival.current?.id !== snapshotId) answerArrival.current = { id: snapshotId, navigation: arrived };
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
  // Both start a generation run on the server (`exportGeo` queues the programme's step), so both say 生成 and declare themselves starts.
  const startProposal = () => start("proposal", () => exportGeo(geoId, "proposal"),
    { started: "已开始生成提案资料包。", queued: "提案资料包排在前一项之后，做完会自动开始。" }, "提案资料包暂时无法生成，请稍后重试。");
  const startWeekly = () => start("weekly", () => exportGeo(geoId, "weekly"),
    { started: "已开始生成周报。", queued: "周报排在前一项之后，做完会自动开始。" }, "周报暂时无法生成，请稍后重试。");
  /** The conversation the page holds (`GeoFrameApi.conversation`: never a step the programme ran); none yet opens a new one. */
  const params = new URLSearchParams(location.search);
  const heldSession = api.conversation;
  const implicitSession = Boolean(heldSession && (location.state as { geoImplicitPrimary?: unknown } | null)?.geoImplicitPrimary === heldSession);
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
  const readOnlyChat = heldSession ? geoPanePath(location.pathname, location.search, location.hash, heldSession) : null;
  // The bare conversation address: opened for a role that may converse, the kept one for a role that reads, and said in place when
  // neither can be shown — a page left on its skeleton is a page that never says what happened.
  const [conversationError, setConversationError] = useState<string | null>(null);
  const [conversationAttempt, setConversationAttempt] = useState(0);
  useEffect(() => {
    if (!onChat || addressedSession) return undefined;
    setConversationError(null);
    if (!canConverse) {
      if (heldSession) navigate(`${geoChatPath(geoId, heldSession)}${location.search}`, { replace: true, state: sanitizeRuntimeUiHistoryState(location.state) });
      return undefined;
    }
    let live = true;
    void openConversation({ geoId, projectId: project.projectId, sessionId: heldSession, primarySessionId: project.sessionId ?? null })
      .then((opened) => { if (live && !opened) setConversationError("对话暂时无法打开，请稍后重试。"); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the search is carried along, never a reason to open again
  }, [onChat, addressedSession, heldSession, geoId, project.projectId, openConversation, canConverse, conversationAttempt, navigate]);
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
  // Whether anything has happened in the project: the same answer before and after the monitoring read lands, so the header does not
  // change under the reader; the week a project is in is no progress of its own.
  const started = Object.values(project.steps).some(step => step.status !== "none" || step.runId || step.roundId || step.summary) || project.overview.week.length > 0;
  const setPaused = (pause: boolean) => {
    void patchGeoProject(geoId, { status: pause ? "paused" : "active" })
      .then(() => { toast.success(pause ? "已暂停，测量和投放都停下了。" : "已继续。"); reload(); })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "项目状态无法修改，请稍后重试。" })));
  };
  const menu: MenuEntry[] = [
    ...(can("edit") ? [{ label: "重命名", onSelect: () => onPanel("rename") }] : []),
    // The engines, the window, the budget, who speaks for the product and the members: one drawer, not four entries.
    { label: "项目设置", onSelect: () => onPanel("settings") },
    ...(can("run") && !paused && started ? [{ label: "生成提案资料包", onSelect: startProposal }] : []),
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
  const now = bandNow(project, watched?.next ?? null, undefined, watched?.measurement ?? null, geoActivity(project) !== null);
  const destination = (next: GeoTabKey, view?: string, step?: string, section?: string) => {
    const kept = new URLSearchParams(geoAnalysisSearch(params.toString(), null));
    kept.delete("questionMode");
    if (next !== "overview") kept.delete("work");
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
    // A signal's detail hides the tab's body: left open, a step's press would move the underline and show nothing new.
    kept.delete("signal"); kept.delete("signals");
    const path = geoDestinationPath(geoId, { tab: next, view: nextView, section }, kept);
    // With the conversation open, a step changes what is beside it and leaves the conversation where it is.
    return onChat ? geoPathWithContext(path, location) : path;
  };
  // One answer's way back is the band's, as every page's is. A reader who came from inside the app goes back to where they came from —
  // the list as they left it, its filter in the address included; one who opened the answer from a link has no such place, and is taken
  // to the tab that holds it (the answer says which: `useGeoAnswerBack`).
  const answerFallback = answerBack ?? "questions";
  const answerNavigation = answerArrival.current?.navigation ?? arrived;
  const answerBackLabel = answerNavigation !== "POP" ? "返回" : `返回${GEO_ANSWER_BACK_NAMES[answerFallback]}`;
  const answerBackLink = <Link className="inline-block text-ui text-accent"
    state={sanitizeRuntimeUiHistoryState(location.state)} to={geoPathWithContext(answerFallback === "overview" ? `/app/geo/${encodeURIComponent(geoId)}` : tabPath(geoId, answerFallback), location)}
    onClick={(event) => { if (answerNavigation !== "POP") { event.preventDefault(); navigate(-1); } }}>{answerBackLabel}</Link>;
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
          : selectedStep === "questions" ? { label: "让 AI 补充问题", onClick: ask(`请再补几个值得测量的问题，覆盖${product}现有问句池里还没有问到的情形。`) }
            : selectedStep === "sources" ? { label: "选目标档", onClick: () => navigate(destination("plan", undefined, "sources", "targets"), { state: sanitizeRuntimeUiHistoryState(location.state) }) }
              : selectedStep === "content" ? { label: "让 AI 写下一批稿件", onClick: ask("请为现在还没有稿件的问题群写下一批稿件，先写讲错最严重、离目标最远的。") } : null;
  const strip = geoActivity(project);
  const stopStep = () => {
    if (!strip?.runId || busy) return;
    setBusy("stop");
    void stopGeoStepRun(geoId, strip.runId)
      .then(() => { toast.success("已停止这一项。已完成的部分保留。"); reload(); })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "暂时无法停止，请稍后重试。" })))
      .finally(() => setBusy(null));
  };
  const journey = geoJourney(project);
  const budgetOwed = geoStepView(project, "distribution").waitingFor === "设预算";
  const primary: PageActionPlan["primary"] = (() => {
    // A budget is owed once placing was asked for or is moving, as the rail says (「等你设预算」); a new project, which has asked for nothing,
    // is not asked for money first.
    if (budgetOwed && can("manage_money") && !paused) return { id: "budget", label: "设投放预算", kind: "external" as const, onSelect: () => api.openPanel("budget") };
    const next = journey.next;
    // What is missing to begin is its own list on the overview, with its own way on; the header adds nothing to it.
    if (journey.stage === "inputs") return undefined;
    if (next.kind === "conversation") return canConverse ? { id: "next", label: next.label, kind: "draft" as const, icon: PenLine, loading: busy === "conversation", onSelect: () => { setBusy("conversation"); void openConversation(target, next.draft).finally(() => setBusy(null)); } } : undefined;
    // Already where it leads: the page is the next step, and has nothing to press for it.
    if (!next.step || next.step === selectedStep || onChat && next.kind === "view") return undefined;
    return { id: "next", label: next.label, to: destination(GEO_STEP_HOME[next.step].tab, GEO_STEP_HOME[next.step].view, next.step, GEO_STEP_HOME[next.step].section), state: sanitizeRuntimeUiHistoryState(location.state) };
  })();
  const addressAnalysis = geoAnalysisDescriptor(location.search);
  const analysis = !snapshotId ? addressAnalysis : null;
  const projectWork = tab === "overview" && !snapshotId && !geoAnalysisDescriptor(location.search) && !params.has("signal");
  const workTasks = projectWork && params.get("work") === "tasks";
  const workHome = projectWork && !workTasks;
  const presentedTab = analysis ? geoAnalysisTabForView(analysis.viewId) : tab;
  const area = snapshotId ? "analytics" : geoWorkArea(presentedTab, analysis ? null : params.get("view"));
  const [workAttempt, setWorkAttempt] = useState(0);
  const [workError, setWorkError] = useState(false);
  const retryArrival = useRef<string | null>(null);
  useEffect(() => {
    if (!workHome || onChat) { retryArrival.current = null; return undefined; }
    if (!canConverse) {
      if (heldSession) navigate(geoPanePath(location.pathname, location.search, location.hash, heldSession), { replace: true, state: sanitizeRuntimeUiHistoryState(location.state) });
      return undefined;
    }
    let live = true;
    setWorkError(false);
    // Only an explicit retry by an owner may repair the default primary. A URL-addressed session is never swapped.
    const explicitlyAddressed = new URLSearchParams(location.search).has("session") && !implicitSession;
    const mayRepairPrimary = retryArrival.current === location.key && !explicitlyAddressed && project.access?.owner !== false;
    retryArrival.current = null;
    const exactSession = Boolean(heldSession) && !mayRepairPrimary;
    void openConversation({ geoId, projectId: project.projectId, sessionId: heldSession, primarySessionId: mayRepairPrimary ? heldSession : project.sessionId, exactSession,
      ...(!explicitlyAddressed && (!heldSession || heldSession === project.sessionId || implicitSession) ? { implicitPrimary: true } : {}) })
      .then((opened) => { if (live && !opened) setWorkError(true); });
    return () => { live = false; };
    // Entering project work can open a new primary; a kept session is always resumed by its exact identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workHome, onChat, heldSession, geoId, project.projectId, canConverse, workAttempt, location.key]);
  /** The same result without the conversation: what 收起 goes to. */
  const collapseTo = (() => {
    if (!legacyChat) {
      const kept = new URLSearchParams(location.search);
      kept.delete("conversation");
      if (heldSession && heldSession !== project.sessionId) kept.set("session", heldSession); else kept.delete("session");
      const search = kept.toString();
      return `${location.pathname}${search ? `?${search}` : ""}${location.hash}`;
    }
    const kept = new URLSearchParams(geoAnalysisSearch(params.toString(), addressAnalysis));
    kept.delete("result");
    if (heldSession && heldSession !== project.sessionId) kept.set("session", heldSession); else kept.delete("session");
    return `${geoDestinationPath(geoId, { tab }, kept)}${location.hash}`;
  })();
  const controls = coverChat ? undefined : toolbar;
  const analysisView = analysis ? null : params.get("view");
  const analysisId = analysis?.viewId ?? null;
  const analysisOptions = useMemo(() => geoAnalysisOptionsForTab(presentedTab, analysisView, analysisId), [presentedTab, analysisView, analysisId]);
  const effectiveScope = api.scope?.selectionRef && project.scope ? { ...project.scope, selectionRef: api.scope.selectionRef } : api.scope;
  const citationPage = presentedTab === "sources" && analysis?.viewId === "V18" && analysis.sourceLevel === "page";
  const showAnalysisSelector = !snapshotId && !workHome && !workTasks && !params.has("signal") && analysisOptions.length > 1;
  const selectAnalysis = useCallback((viewId: string) => {
    const descriptor = viewId ? geoAnalysisDescriptorForView(viewId as NonNullable<typeof analysis>["viewId"], geoAnalysisDescriptor(location.search)) : null;
    navigate({ pathname: location.pathname, search: geoAnalysisSearch(location.search, descriptor), hash: location.hash },
      { state: sanitizeRuntimeUiHistoryState(location.state) });
  }, [location.pathname, location.search, location.hash, location.state, navigate]);
  const analysisSelector = useMemo(() => showAnalysisSelector ? <div className="w-full max-w-64" data-geo-analysis-selector="">
    <Select label="分析视角" value={analysisId ?? ""} onChange={event => selectAnalysis(event.target.value)}>
      <option value="">当前结果</option>
      {analysisOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </Select>
  </div> : null, [analysisId, analysisOptions, selectAnalysis, showAnalysisSelector]);
  const changeCitationLevel = (value: string) => {
    const descriptor = value === "page" ? { viewId: "V18" as const, dimension: "project" as const, sourceLevel: "page" as const,
      ...(params.get("sourceSearch") ? { sourceSearch: params.get("sourceSearch")! } : {}) } : null;
    const next = new URLSearchParams(geoAnalysisSearch(location.search, descriptor));
    const clearsDomainFilters = value === "page" && (next.has("only") || next.has("kind") || next.has("cluster") || next.has("engine") && next.has("engines"));
    if (value === "page") {
      // `cluster` also names a domain-association filter. Preserve its observation scope, but not that distinct site filter.
      const groups = geoReadScopeFromSearch(location.search).groupIds;
      if (next.has("cluster") && !next.has("groupIds")) for (const group of groups ?? []) next.append("groupIds", group);
      next.delete("cluster");
      if (next.has("engines")) next.delete("engine");
      next.delete("only"); next.delete("kind"); next.delete("sourceSort"); next.delete("sourceOrder");
    }
    if (clearsDomainFilters) next.set("sourceFiltersReset", "1");
    else if (value !== "page") next.delete("sourceFiltersReset");
    navigate({ pathname: location.pathname, search: next.toString(), hash: location.hash }, { state: sanitizeRuntimeUiHistoryState(location.state) });
  };
  const bandToolbar: ToolbarProps = {
    ...(controls ?? {}),
    views: undefined,
    summary: controls?.summary ?? now,
    navigation: [
      ...(presentedTab === "sources" && params.get("view") !== "placeable" && (!analysis || citationPage) ? [{
        kind: "chips" as const, label: "引用粒度", options: [{ value: "domain", label: "域名" }, { value: "page", label: "页面" }],
        value: citationPage ? "page" : "domain",
        onChange: changeCitationLevel,
      }] : []),
      ...(controls?.navigation ?? []),
      ...(controls?.views ? [{ kind: "select" as const, label: controls.views.label,
        value: controls.views.value, options: controls.views.items.map((item) => ({ value: item.value, label: item.label })),
        onChange: (next: string | null) => { if (next) controls.views?.onChange(next); } }] : []),
    ],
    filters: controls?.filters,
    // The range is shown wherever it narrows what is read — every view's analysis and 方案's strategy — so a range carried in the
    // address never applies unsaid; 行动's monitoring view reads none.
    scopeParts: area === "analytics" && !coverChat ? geoScopeSummary(effectiveScope).map(part => ({ ...part, onSelect: () => setScopeOpen(true) })) : undefined,
    scopeAction: !workHome && !coverChat && (analysis || !(tab === "actions" && selectedStep === "monitoring")) ? {id:"analysis-scope",label:`分析范围${geoReadScopeQuery(api.scope) ? " · 已筛选" : ""}`,onSelect:()=>setScopeOpen(true)} : undefined,
    // The open step's own action is the toolbar's, beside what it acts on, and a quiet text button: the page's one primary is the
    // header's next-step action (DESIGN.md 「页面结构」 rule 3; the fixture walk of df17091ad read “加问” as a second one at 156 px). A tab's own
    // `actionPlan` or `actions` (the journey's downloads) stay as the tab declared them.
    // Its view and scope choices cannot fold into 「筛选」, so on a phone the row scrolls: the band is one line, the same on every tab.
    nowrap: true,
    contextAction: !coverChat && !analysis && continues ? { id: "continue-step", label: continues.label, onSelect: continues.onClick } : undefined,
  };

  const diagnosisUnmeasured = selectedStep === "diagnosis" && !coverChat && (project.steps.diagnosis?.status ?? "none") === "none" && canConverse;
  const results = workTasks ? (
    <ProgrammeRunsDrawer inline projectId={project.projectId} load={() => getGeoProgrammeRuns(geoId)} loadMore={cursor => getGeoProgrammeRuns(geoId, cursor)} readRecord={project.signalsSupported ? readRunRecord : undefined} version={runsVersion} onClose={() => undefined} />
  ) : snapshotId ? (
    // One answer, read inside the band: the route's own element, which may still be on its way.
    <Suspense fallback={<TabSkeleton rows={4} />}><Outlet context={api} /></Suspense>
  ) : (
    <div className="flex flex-col gap-8">
      {!analysis && <h2 className="sr-only">{GEO_TABS.find((item) => item.key === tab)?.label}</h2>}
      {/* The work's one 「现在」, before anything else the project has to show. */}
      {tab === "overview" && !analysis && <GeoJourneySummary project={project} compact={started} />}
      {!analysis && project.signalsSupported && params.has("signal") && <GeoSignalsWorkbench geoId={geoId} project={project} step={api.step} compact />}
      {api.scopePending && (api.scopeError ? <LoadError message={api.scopeError} onRetry={reload} /> : <TabSkeleton />)}
      <div hidden={api.scopePending || !analysis && project.signalsSupported && params.has("signal")}><PendingFeedbackBoundary mode={api.scopePending || !analysis && project.signalsSupported && params.has("signal") ? "inactive" : "active"}>
        <section aria-label="当前结果分析" className="flex flex-col gap-5">
          {(tab !== "visibility" || analysis) && analysisSelector}
          {!analysis && <GeoTab api={api} analysisSelector={analysisSelector} />}
          {analysis && <GeoAnalysisMainArea api={api} />}
        </section>
      </PendingFeedbackBoundary></div>
    </div>
  );

  const tabs = coverChat && !workHome ? undefined : area === "analytics" ? {
    label: "AI 表现",
    items: [
      { value: "visibility", label: "可见度" },
      { value: "accuracy", label: "医学核查" },
      { value: "sources", label: "引用来源" },
      { value: "questions", label: "问题与回答" },
    ],
    value: presentedTab,
    onChange: (value: string) => navigate(destination(value as GeoTabKey), { state: sanitizeRuntimeUiHistoryState(location.state) }),
  } : area === "content" ? {
    label: "内容与发布",
    items: [{ value: "content", label: "稿件" }, { value: "distribution", label: "发布记录" }],
    value: analysis ? analysis.viewId === "V24" || analysis.viewId === "V25" ? "distribution" : "content"
      : selectedStep === "distribution" ? "distribution" : "content",
    onChange: (value: string) => navigate(destination("actions", undefined, value, value === "distribution" ? "delivery" : undefined), { state: sanitizeRuntimeUiHistoryState(location.state) }),
  } : area === "context" ? {
    label: "产品与资料",
    items: [{ value: "evidence", label: "产品依据" }, { value: "journey", label: "人群与旅程" }],
    value: analysis?.viewId === "V10" || !analysis && tab === "questions" ? "journey" : "evidence",
    onChange: (value: string) => navigate(value === "journey" ? destination("questions", "journey", "journey") : destination("evidence", undefined, "evidence"), { state: sanitizeRuntimeUiHistoryState(location.state) }),
  } : {
    label: "项目工作",
    items: [{ value: "overview", label: "项目对话" }, { value: "tasks", label: "任务与成果" }, { value: "plan", label: "方案" }],
    value: workTasks ? "tasks" : presentedTab === "plan" ? "plan" : "overview",
    onChange: (value: string) => {
      if (value === "plan") { navigate(destination("plan"), { state: sanitizeRuntimeUiHistoryState(location.state) }); return; }
      const search = new URLSearchParams(geoAnalysisSearch(location.search, null));
      for (const key of ["conversation", "result", "step", "view", "signal", "signals"]) search.delete(key);
      if (heldSession) search.set("session", heldSession); else search.delete("session");
      if (value === "tasks") search.set("work", "tasks"); else search.delete("work");
      navigate({ pathname: `/app/geo/${encodeURIComponent(geoId)}`, search: search.toString() }, { state: sanitizeRuntimeUiHistoryState(location.state) });
    },
  };
  const openChat = () => {
    if (busy) return;
    setBusy("conversation");
    void openConversation(target).finally(() => setBusy(null));
  };
  const conversation = conversationError ? <LoadError message={conversationError} onRetry={() => setConversationAttempt((value) => value + 1)} />
    : !addressedSession && !canConverse && !heldSession ? <EmptyState icon={MessageSquare} title="这个项目还没有对话" action={<Button variant="secondary" onClick={() => navigate(destination("overview"), { state: sanitizeRuntimeUiHistoryState(location.state) })}>回到项目工作</Button>} />
      : addressedSession ? <GeoConversationPane canRun={can("run") && can("edit")} owner={project.access?.owner ?? true} geoId={geoId} projectId={project.projectId} sessionId={addressedSession} /> : <TabSkeleton rows={4} />;
  const workDetails = <div className="flex min-w-0 flex-col gap-6">
    <GeoWorkDetails project={project} sessionId={onChat ? addressedSession ?? null : null} onOpenRuns={() => onPanel("runs")} onOpenSettings={() => onPanel("settings")} />
    <NeedsYou geoId={geoId} project={project} showMeasurement={false} />
    {project.signalsSupported && <GeoSignalsWorkbench geoId={geoId} project={project} compact />}
  </div>;
  const workSurface = <div data-geo-work="" className="flex min-w-0 flex-col gap-6 lg:flex-row">
    <section aria-label="项目工作" className="min-w-0 flex-1">
      {onChat ? conversation : <div className="flex flex-col gap-4">
        {workError && <LoadError message={heldSession && (!params.has("session") || implicitSession) && project.access?.owner !== false
          ? "原对话暂时无法恢复。重试时如原会话已不存在，会打开新对话。" : "项目对话暂时无法打开。"} onRetry={() => { retryArrival.current = location.key; setWorkAttempt((value) => value + 1); }} />}
        <GeoJourneySummary project={project} compact={started} />
        {canConverse && <Button variant="secondary" loading={busy === "conversation"} onClick={openChat}>打开项目对话</Button>}
        {!canConverse && readOnlyChat && <Link to={readOnlyChat} state={sanitizeRuntimeUiHistoryState(location.state)} className="text-link hover:underline">查看项目对话</Link>}
      </div>}
    </section>
    <div className="min-w-0 lg:w-80 lg:shrink-0">{workDetails}</div>
  </div>;

  return (
    <PageShell<string>
      title={project.name}
      // The way back is on every tab, so the band stands at the same place on each (the walk's module-chrome): 项目总览 from a step's
      // tab and the conversation, the project list from the overview. A block link — an inline one is a kind of control of its own.
      back={snapshotId ? answerBackLink : tab !== "overview" || onChat
        ? <Link className="inline-block text-ui text-accent" to={destination("overview")} state={sanitizeRuntimeUiHistoryState(location.state)}>项目总览</Link>
        : <Link className="inline-block text-ui text-accent" to="/app/geo">循证 GEO</Link>}
      {...(strip ? { activity: { quiet: true, label: strip.label, startedAt: strip.startedAt, waiting: strip.waiting, queued: strip.queued, to: destination(GEO_STEP_HOME[strip.step].tab, GEO_STEP_HOME[strip.step].view, strip.step, GEO_STEP_HOME[strip.step].section), ...(can("run") && strip.runId ? { onCancel: stopStep, cancelLabel: "停止这一项", cancelling: busy === "stop" } : {}) } } : {})}
      tabs={tabs}
      documentTitle={GEO_MONITORING_TABS.includes(tab) ? `${project.name} · ${GEO_MONITORING_TITLE}` : undefined}
      width="wide"
      meta={paused ? <Tag>{workStateLabel("paused")}</Tag> : started ? <Tag title={week ? "按项目开始日期计算。" : now ?? undefined}>{week ? `项目第 ${week} 周` : coverageText(project.coverageDays, project.startedAt ?? project.createdAt ?? null)}</Tag> : undefined}
      actionPlan={{
        // The one primary is the next step; the conversation has its own place on every view and takes no button in the header.
        ...(!workHome && !onChat && canConverse ? { primary: { id: "conversation", label: "询问 AI", icon: MessageSquare, loading: busy === "conversation", onSelect: openChat } }
          : !workHome && !onChat && readOnlyChat ? { primary: { id: "conversation-read", label: "查看项目对话", to: readOnlyChat, replace: true, state: sanitizeRuntimeUiHistoryState(location.state) } }
          : workHome && !onChat && primary ? { primary } : {}),
        secondary: [
          ...(can("run") && !paused && started ? [{ id: "weekly", label: "生成周报", icon: FileDown, kind: "start" as const, loading: busy === "weekly", onSelect: startWeekly }] : []),
          ...(paused && can("edit") ? [{ id: "resume", label: "继续", kind: "set" as const, onSelect: () => setPaused(false) }] : []),
        ],
        overflow: menu,
      }}
      toolbar={workHome || workTasks ? null : bandToolbar}
    >
      {selectionStale ? <Note action={<Button variant="secondary" size="sm" onClick={() => api.refreshScope?.()}>读取最新结果</Button>}>
        所选范围里的数据已经更新，仍显示上次结果。
      </Note> : (api.refreshError || dataRefreshError) && <Note action={<Button variant="secondary" size="sm" onClick={() => { reload(); api.data.invalidate(); }}>重试更新</Button>}>
        更新暂时失败，仍显示上次结果。{api.refreshError || dataRefreshError}
      </Note>}
      {diagnosisUnmeasured && <Note action={<Link className="rounded text-link hover:underline" to={destination("questions", undefined, "questions")} state={sanitizeRuntimeUiHistoryState(location.state)}>去开始诊断</Link>}>还没有测量结果。核对要问的问题后，可以开始第一轮诊断。</Note>}
      {citationPage && params.has("sourceFiltersReset") && <Note action={<Button variant="text" size="sm" onClick={() => {
        const search = new URLSearchParams(location.search); search.delete("sourceFiltersReset");
        navigate({ pathname: location.pathname, search: search.toString(), hash: location.hash }, { replace: true, state: sanitizeRuntimeUiHistoryState(location.state) });
      }}>关闭</Button>}>域名专用筛选已清除；时间、平台和问题群测量范围保留。</Note>}
      <div ref={workspaceWidth}>
      {workHome ? workSurface : (
        <WorkspaceSplit
          collapseTo={collapseTo}
          results={results}
          conversation={conversation}
          splitOverride={split}
          open={onChat}
          retainResults
          {...geoResultDrawerProps(params, location.state, tab, {
            snapshotId, analysis: Boolean(analysis), distribution: selectedStep === "distribution",
          })}
          replaceOnCollapse={!legacyChat}
        />
      )}
      </div>
      {scopeOpen && <GeoScopeDialog geoId={geoId} project={project} initial={api.scope?.selectionRef && project.scope ? { ...project.scope, selectionRef: api.scope.selectionRef } : api.scope} onClose={() => setScopeOpen(false)} onApply={next => {
        setScopeOpen(false);
        const query = geoSearchWithScope(location.search, next);
        navigate({ pathname: location.pathname, search: query ? `?${query}` : "", hash: location.hash }, { replace: true, state: sanitizeRuntimeUiHistoryState(location.state) });
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
const GeoTab = memo(function GeoTab({ api, analysisSelector }: { api: GeoFrameApi; analysisSelector?: ReactNode }) {
  const Tab = TABS[api.tab];
  return (
    <>
      {api.tab === "visibility" ? <VisibilityTab geoId={api.geoId} project={api.project} analysisSelector={analysisSelector} />
        : api.tab === "actions" ? <ActionsTab key={api.step} geoId={api.geoId} project={api.project}
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
  const citationPage = api.tab === "sources" && analysis.viewId === "V18" && analysis.sourceLevel === "page";
  // A filter or a search inside the open view replaces its history entry; opening, switching and leaving a view add one.
  const change = (descriptor: Parameters<typeof geoAnalysisSearch>[1]) => navigate({ pathname: location.pathname, search: geoAnalysisSearch(location.search, descriptor), hash: location.hash },
    { replace: geoAnalysisChangeReplaces(location.search, descriptor), state: sanitizeRuntimeUiHistoryState(location.state) });
  return <section data-geo-main-area="analysis" className="flex flex-col gap-4">
    {!citationPage && <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-section font-semibold">{GEO_ANALYSIS_OPTIONS.find(item => item.value === analysis.viewId)?.label}</h2><Button variant="text" onClick={() => change(null)}>返回{GEO_TABS.find(item => item.key === api.tab)?.label}</Button></div>}
    <GeoAnalysisWorkbench geoId={api.geoId} project={api.project} mainArea={{ descriptor: analysis, onChange: change }} />
  </section>;
});
