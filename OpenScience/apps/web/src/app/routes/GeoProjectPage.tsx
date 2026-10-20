import { memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { Outlet, useLocation, useNavigate, useNavigationType, useParams } from "react-router";
import { FileDown, MessageSquare, MoreHorizontal, Radar } from "lucide-react";
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
import { geoChatPath } from "@/lib/geoLocation";
import { newRuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { GeoConversationPane } from "@/components/geo/GeoConversationPane";
import { useProjectStore } from "@/lib/projects";
import { toast } from "@/lib/toast";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { PageShell } from "@/components/layout/PageShell";
import { Button } from "@/components/ui/Button";
import { ProgrammeRunsDrawer } from "@/components/runs/ProgrammeRunsDrawer";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { IconButton } from "@/components/ui/IconButton";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { Tag } from "@/components/ui/Tag";
import type { ToolbarProps } from "@/components/ui/Toolbar";
import { GeoOffPage, GeoProjectSkeleton } from "@/components/geo/GeoStates";
import { TabSkeleton } from "@/components/geo/tabs/geoTabKit";
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
  GEO_TAB_STEPS,
  GEO_TABS,
  geoDestinationPath,
  geoQuestionsView,
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

/** One component per view; the eight steps are not places, they are the rail above them (plan §8.1, R19). */
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
  | { kind: "ready"; project: GeoProject };

/**
 * The finite steps of the programme: they begin, run and end, so a page that started one reads the project again until it has. The
 * three after them (内容, 投放, 监测) are the programme itself — they stay 「进行中」 for the life of the project — and are not polled.
 */
const WATCHED_STEPS: readonly GeoStepKey[] = ["evidence", "journey", "questions", "diagnosis", "sources"];
const WATCH_MS = 10_000;

/** The statuses of the steps that end, as one word: when it changes, a step began or finished and what the tabs read is stale. */
function stepsState(project: GeoProject): string {
  const steps = project.overview?.steps && Object.keys(project.overview.steps).length > 0 ? project.overview.steps : project.steps;
  return WATCHED_STEPS.map((step) => `${step}:${steps[step]?.status ?? "none"}`).join("|");
}

function stepsWorking(project: GeoProject): boolean {
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
  const onChat = /\/chat(?:\/[^/]+)?\/?$/.test(location.pathname);
  const navigate = useNavigate();
  const feature = useGeoFeature();
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [conversationError, setConversationError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const [data] = useState(() => new GeoDataCache());
  const [toolbar, setToolbar] = useState<ToolbarProps | null | undefined>(undefined);
  /** The dialog the ⋯ menu — or a tab — opened: who else is in the project, who speaks for the product, its name, or the budget. */
  const [panel, setPanel] = useState<GeoPanel | null>(null);
  const [suggested, setSuggested] = useState<number | null>(null);
  const resolved = resolveGeoTab(onChat ? new URLSearchParams(location.search).get("result") : tabParam);
  // An answer is read inside the band and keeps 问题与回答 selected: it is where the answer was asked.
  const tab: GeoTabKey = snapshotId ? "questions" : resolved.tab;
  const shown = useRef<string | null>(null);

  useEffect(() => {
    // An address that named a step is rewritten to where that step is read now, in place, so the reader leaves with a link that
    // will keep working.
    if (!onChat && !snapshotId && resolved.moved && geoId) {
      navigate(geoDestinationPath(geoId, { tab: resolved.tab, ...(resolved.view ? { view: resolved.view } : {}) }), { replace: true });
    }
  }, [onChat, snapshotId, resolved.moved, resolved.tab, resolved.view, geoId, navigate]);

  useEffect(() => {
    if (feature === "loading" || feature === "off") return undefined;
    let live = true;
    setConversationError(null);
    void getGeoProject(geoId).then(
      async (project) => {
        if (!live) return;
        try {
          const store = useProjectStore.getState();
          if (onChat && store.currentId !== project.projectId) {
            if (!store.projects.some((item) => item.id === project.projectId)) await store.load();
            if (!live) return;
            await useProjectStore.getState().select(project.projectId);
          }
          if (!live) return;
        } catch (error: unknown) {
          if (!live) return;
          setConversationError(webErrorMessage(error, { fallback: "对话暂时无法打开。" }));
        }
        // A step that began or ended makes what the tabs have read stale; the cache re-reads what is on screen.
        const state = stepsState(project);
        if (shown.current !== null && shown.current !== state) data.invalidate();
        shown.current = state;
        setLoaded({ kind: "ready", project });
      },
      (error: unknown) => {
        if (!live) return;
        if (isGeoOff(error)) setLoaded({ kind: "off" });
        else if (error instanceof WebApiError && error.status === 404) setLoaded({ kind: "missing" });
        // A read that fails after the page has drawn keeps what it drew: a poll is not a reason to take the project away.
        else setLoaded((current) => (current.kind === "ready" ? current : { kind: "error", message: webErrorMessage(error, { fallback: "项目暂时无法读取。" }) }));
      },
    );
    return () => { live = false; };
  }, [feature, geoId, reloads, data, onChat]);

  const reload = useCallback(() => setReloads((value) => value + 1), []);

  // The page updates itself while a step that ends is being worked on.
  const watching = loaded.kind === "ready" && stepsWorking(loaded.project);
  useEffect(() => {
    if (!watching) return undefined;
    const timer = window.setInterval(reload, WATCH_MS);
    return () => window.clearInterval(timer);
  }, [watching, reload]);

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

  const api = useMemo<GeoFrameApi | null>(
    () => (loaded.kind === "ready" ? { geoId, project: loaded.project, tab, reload, openPanel, data, setToolbar } : null),
    [geoId, loaded, tab, reload, openPanel, data],
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
        {loaded.kind === "error" ? <LoadError message={loaded.message} onRetry={reload} /> : <GeoProjectSkeleton />}
      </PageShell>
    );
  }

  return (
    <GeoFrameContext.Provider value={api}>
      <GeoBand api={api} onChat={onChat} addressedSession={addressedSession} conversationError={conversationError} toolbar={toolbar} panel={panel} suggested={suggested} onPanel={setPanel} />
    </GeoFrameContext.Provider>
  );
}

/** The page: the header, the fixed band and the body that is the route's child. Below the cache's provider, so it reads through it. */
function GeoBand({
  api,
  onChat,
  addressedSession,
  conversationError,
  toolbar,
  panel,
  suggested,
  onPanel,
}: {
  api: GeoFrameApi;
  onChat: boolean;
  addressedSession?: string;
  conversationError: string | null;
  toolbar: ToolbarProps | null | undefined;
  panel: GeoPanel | null;
  suggested: number | null;
  onPanel: (panel: GeoPanel | null) => void;
}) {
  const { geoId, project, tab, reload } = api;
  const { snapshotId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const openConversation = useOpenGeoConversation();
  const monitoring = useGeoMonitoring(geoId);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // A destination with a block (`#geo-errors`) is scrolled to once it is on the page, below the band (the scroller's
  // `scroll-padding-top` is the band's height). A block that never comes leaves the tab at its top.
  // It is each navigation's, not each address's: pressing 「诊断」 again after scrolling away brings the block back, while a filter
  // chip (which rewrites the query in place) leaves the reader where they are.
  const arrived = useNavigationType();
  useEffect(() => {
    const id = location.hash.slice(1);
    if (!id || arrived === "REPLACE") return undefined;
    let tries = 0;
    const find = () => {
      const element = document.getElementById(id);
      if (element) {
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
  /** The person's own conversation in the project (the server's `sessionId`: never a step the programme ran); none yet opens a new one. */
  const params = new URLSearchParams(location.search);
  const heldSession = addressedSession ?? params.get("session") ?? project.sessionId;
  const target = { geoId, projectId: project.projectId, sessionId: heldSession };
  useEffect(() => {
    if (!onChat || addressedSession) return;
    const intent = newRuntimeUiIntent(undefined, heldSession ?? undefined);
    navigate(`${geoChatPath(geoId, intent.sessionId)}${location.search}`, {
      replace: true, state: { ...location.state, runtimeUiIntent: intent },
    });
  }, [onChat, addressedSession, heldSession, geoId, location.search, location.state, navigate]);
  const openChat = () => {
    if (busy) return;
    setBusy("conversation");
    void openConversation(target).finally(() => setBusy(null));
  };
  // What a reader of the AI-run record needs to know to read it again: a step that began or ended, or the project moving on.
  const runsVersion = [project.updatedAt ?? "", ...GEO_STEP_KEYS.map((step) => `${step}:${project.steps[step]?.status ?? "none"}`)].join("|");

  const paused = project.status === "paused";
  // What the account may do here: the owner everything, a member what their roles allow. The server judges every operation all the
  // same; the menu only does not offer what would be refused.
  const abilities = project.access?.abilities;
  const can = (ability: string) => !abilities || abilities.includes(ability);
  const menu: MenuEntry[] = [
    ...(can("edit") ? [{ label: "重命名", onSelect: () => onPanel("rename") }] : []),
    // The engines, the window, the budget, who speaks for the product and the members: one drawer, not four entries.
    { label: "项目设置", onSelect: () => onPanel("settings") },
    ...(can("run") ? [{ label: "导出提案资料包", onSelect: startProposal }] : []),
    // What the programme did in the background, read-only — the steps are in no conversation list.
    { label: "AI 运行", onSelect: () => onPanel("runs") },
    ...(can("edit") ? [{
      label: paused ? "继续" : "暂停",
      onSelect: () => {
        void patchGeoProject(geoId, { status: paused ? "active" : "paused" })
          .then(() => { toast.success(paused ? "已继续。" : "已暂停，测量和投放都停下了。"); reload(); })
          .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "项目状态无法修改，请稍后重试。" })));
      },
    }] : []),
    ...(can("delete") ? ["separator" as const, { label: "删除", destructive: true, onSelect: () => setConfirmDelete(true) }] : []),
  ];

  const remove = () => {
    setConfirmDelete(false);
    void deleteGeoProject(geoId)
      .then(() => {
        // The control-plane project went with it: the sidebar's list is re-read.
        void useProjectStore.getState().load();
        navigate("/app/geo", { replace: true });
      })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "项目无法删除，请稍后重试。" })));
  };

  const week = weekOf(project.startedAt ?? project.createdAt ?? null);
  const now = bandNow(project, monitoring.state.kind === "ready" ? monitoring.state.data.next : null);
  const destination = (next: GeoTabKey, view?: string, step?: string, section?: string) => geoDestinationPath(geoId, { tab: next, view: view ?? (next === tab ? params.get("view") ?? undefined : undefined), section }, {
    session: heldSession, step: step ?? params.get("step"),
  });
  const steps = bandSteps(project, (step) => destination(GEO_STEP_HOME[step].tab, GEO_STEP_HOME[step].view, step, GEO_STEP_HOME[step].section));
  const selectedStep = params.get("step") ?? GEO_TAB_STEPS[tab][0] ?? null;

  // The one text button that continues this tab's step. It is drawn here, so it is there whether the tab has anything yet or not.
  const product = project.product?.brandName || project.product?.genericName || project.name;
  const ask = (draft: string) => () => { void openConversation(target, draft); };
  const view = new URLSearchParams(location.search).get("view");
  const needsBudget = marketConnected(project) && !(project.budget && project.budget.totalCny > 0);
  const continues: { label: string; onClick: () => void } | null = !can("run") ? null
    : tab === "evidence" ? { label: "让 AI 补充结论", onClick: ask(`请在现有结论库的基础上，补充${product}还没有覆盖的说明书内容和临床证据，每条结论都带原文出处。`) }
      : tab === "questions" ? (geoQuestionsView(view) === "journey"
        ? { label: "让 AI 重画旅程", onClick: ask(`请根据最新的结论和 AI 的回答，重新画一遍${product}的患者与医生旅程。`) }
        : { label: "加问", onClick: ask(`请再补几个值得测量的问题，覆盖${product}现有问句池里还没有问到的情形。`) })
        : tab === "sources" ? { label: "选目标档", onClick: () => navigate(geoDestinationPath(geoId, { tab: "plan", section: "targets" })) }
          : tab === "actions" ? (needsBudget
            ? { label: "设预算", onClick: () => api.openPanel("budget") }
            : { label: "让 AI 写下一批", onClick: ask("请为现在还没有稿件的问题群写下一批稿件，先写讲错最严重、离目标最远的。") })
            : null;
  const controls = onChat ? undefined : toolbar;
  const bandToolbar: ToolbarProps = {
    ...(controls ?? {}),
    views: undefined,
    summary: controls?.summary,
    filters: [
      { kind: "select", label: "查看", value: onChat ? "chat" : tab, pinned: true,
        options: [{ value: "chat", label: "对话" }, ...GEO_TABS.map((item) => ({ value: item.key, label: item.label }))],
        onChange: (next) => {
          if (next === "chat") openChat();
          else if (next) navigate(destination(next as GeoTabKey));
        } },
      ...(controls?.views ? [{ kind: "select" as const, label: controls.views.label,
        value: controls.views.value, options: controls.views.items.map((item) => ({ value: item.value, label: item.label })),
        onChange: (next: string | null) => { if (next) controls.views?.onChange(next); } }] : []),
      ...(controls?.filters ?? []),
    ],
    actions: <>{controls?.actions}{!onChat && continues && <Button variant="text" size="sm" onClick={continues.onClick}>{continues.label}</Button>}</>,
  };

  return (
    <PageShell<GeoTabKey>
      title={project.name}
      steps={{ label: "循证 GEO 进度", steps, activeSteps: selectedStep ? [selectedStep] : [], trailing: now, visible: true, showState: true }}
      documentTitle={GEO_MONITORING_TABS.includes(tab) ? `${project.name} · ${GEO_MONITORING_TITLE}` : undefined}
      width={onChat ? "full" : "wide"}
      contentClassName={onChat ? "flex min-h-96 flex-col" : undefined}
      meta={<Tag title={now ?? undefined}>{week ? `第 ${week} 周` : coverageText(project.coverageDays, project.startedAt ?? project.createdAt ?? null)}</Tag>}
      actions={(
        <>
          <Button variant="secondary" loading={busy === "weekly"} onClick={startWeekly}>
            <FileDown size={16} aria-hidden="true" />
            周报
          </Button>
          {!onChat && <Button variant="secondary" loading={busy === "conversation"} onClick={openChat}>
            <MessageSquare size={16} aria-hidden="true" />
            对话
          </Button>}
          {/* The header's 「⋯」 is the header's icon button, 36 beside the two
            * 36 px buttons (spec §8.3) — the menu's own trigger is a row's 28. */}
          <Menu label="更多操作" items={menu}>
            <IconButton icon={MoreHorizontal} label="更多操作" className="data-[state=open]:bg-surface-2 data-[state=open]:text-text" />
          </Menu>
        </>
      )}
      toolbar={bandToolbar}
    >
      {onChat ? (
        conversationError ? <LoadError message={conversationError} onRetry={reload} /> : addressedSession ? <GeoConversationPane projectId={project.projectId} sessionId={addressedSession} /> : <TabSkeleton rows={4} />
      ) : snapshotId ? (
        // One answer, read inside the band: the route's own element, which may still be on its way.
        <Suspense fallback={<TabSkeleton rows={4} />}><Outlet context={api} /></Suspense>
      ) : (
        <GeoTab api={api} />
      )}
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
      {panel === "runs" && <ProgrammeRunsDrawer projectId={project.projectId} load={() => getGeoProgrammeRuns(geoId)} version={runsVersion} onClose={() => onPanel(null)} />}
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
          body="这个项目的对话、文件、测量记录和稿件会一起删除，不能恢复。已经发出的稿件不会被撤下。"
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
      <Tab geoId={api.geoId} project={api.project} />
    </>
  );
});
