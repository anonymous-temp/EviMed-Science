import { sessionOwner } from "@/lib/sessionLifecycle";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { UsersRound } from "lucide-react";
import { workStateLabel } from "@evimed/domain";
import { webErrorMessage } from "@/lib/apiClient";
import {
  cancelVcrStudy,
  deleteVcrStudy,
  exportVcrStudy,
  patchVcrStudy,
  useVcrFeature,
  type VcrExportKind,
  type VcrStudy,
  type VcrTabKey,
} from "@/lib/vcrClient";
import { useProjectStore } from "@/lib/projects";
import { vcrChatPath } from "@/lib/studyLocation";
import { announceOpenStudy } from "@/lib/studyPresence";
import { toast } from "@/lib/toast";
import { acceptVcrPendingDraft, prepareVcrPendingDraft, promoteVcrPendingDraft, retireVcrPendingDraft, vcrPendingDraftStatus } from "@/lib/vcrPendingDraft";
import { prepareRuntimeUiIntent, registerPendingRuntimeUiIntent, runtimeUiIntentFromState, sanitizeRuntimeUiHistoryState, type RuntimeUiIntent, type VcrObjectSelection } from "@/lib/runtimeUiNavigation";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { PageShell } from "@/components/layout/PageShell";
import { useContinueStudy } from "@/components/vcr/useContinueStudy";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Note } from "@/components/ui/Note";
import type { MenuEntry } from "@/components/ui/Menu";
import { VcrOffPage, VcrStudySkeleton } from "@/components/vcr/VcrStates";
import { VcrBudgetDialog, budgetWaitOf, cpuTimeText } from "@/components/vcr/VcrBudgetDialog";
import { VcrMembersDialog } from "@/components/vcr/VcrMembersDialog";
import { VcrPackageReader } from "@/components/vcr/VcrPackageReader";
import { VcrBackgroundRunsDrawer, VcrChangeLogDrawer } from "@/components/vcr/VcrStudyDrawers";
import { VcrExportDialog, VcrRenameDialog } from "@/components/vcr/VcrStudyDialogs";
import { VcrIntakeDrawer } from "@/components/vcr/VcrIntakeDrawer";
import { INTAKE_LABEL } from "@/components/vcr/vcrActionWords";
import { VcrTierOffer } from "@/components/vcr/VcrTierOffer";
import { STUDY_PANEL_ID, StudyFrame, type StudyView } from "@/components/vcr/StudyFrame";
import { NeedsBar, type WorkNeed } from "@/components/workspace/NeedsBar";
import { WorkspaceSplit } from "@/components/workspace/WorkspaceSplit";
import { vcrCalculationPath, vcrCalculationViewPath } from "@/lib/vcrMethodLocation";
import { StudyPane } from "@/components/vcr/StudyPane";
import { useStudy } from "@/components/vcr/useStudy";
import { useVcrRun } from "@/components/vcr/useVcrRun";
import { announceVcrStudiesChanged } from "@/components/vcr/useVcrProjectIds";
import { VcrRefreshContext, VcrRefreshNote, VcrTabBoundary, type VcrRefreshReporter } from "@/components/vcr/vcrTabKit";
import { OverviewTab } from "@/components/vcr/tabs/OverviewTab";
import { PopulationPatientsTab } from "@/components/vcr/tabs/PopulationPatientsTab";
import { PatientsTab } from "@/components/vcr/tabs/PatientsTab";
import { ComparatorTab } from "@/components/vcr/tabs/ComparatorTab";
import { TrialTab } from "@/components/vcr/tabs/TrialTab";
import { MatchingTab } from "@/components/vcr/tabs/MatchingTab";
import { DataTab } from "@/components/vcr/tabs/DataTab";
import { landingTab, resolveVcrTab, VCR_HOME_PATH, vcrStepPath, vcrTabPath } from "@/components/vcr/vcrTabs";
import { vcrWorkspaceAreaPath } from "@/lib/vcrWorkspaceNavigation";

/**
 * What a tab is given: the study, the id its routes are addressed by, and how to read the study again after a change that moves the
 * header, the dots or the notes. What the frame around it offers beyond that — opening the conversation with a draft, the tab's
 * toolbar in the sticky band, knowing when the study moved — is `useStudyFrame` / `useVcrToolbar` (`studyFrameContext.ts`).
 */
export interface VcrTabProps {
  studyId: string;
  study: VcrStudy;
  onStudyChanged?: () => void;
}

type TabComponent = ComponentType<VcrTabProps>;

const TABS: Record<VcrTabKey, TabComponent> = {
  overview: OverviewTab,
  population: PopulationPatientsTab,
  patients: PatientsTab,
  comparator: ComparatorTab,
  trial: TrialTab,
  matching: MatchingTab,
  data: DataTab,
};

/**
 * One study, on the wide column a data page needs — the seven tabs and its conversation, in one frame (`StudyFrame`).
 *
 * **The conversation is a view of this page** (`/app/virtual-research/:studyId/chat`; R19, plan §5.3): one study is one project is one
 * conversation, and it opens under the same step bar the tabs have, in the shell's resident frame, which does not reload when the
 * reader goes to a tab and back. Starting a step takes nobody anywhere: the frame's strip says what is going on and the page reads
 * itself until it is done. There is **no second composer** on the page itself (2026-09-20 ruling, plan §9.5); what is edited on the
 * page is the structured cards, and each edit makes a new version, which is what marks the results downstream of it stale.
 *
 * Hidden knowledge:
 *  - **An answer belongs to the id it was asked for.** Moving from one study to another shows the skeleton, never the previous
 *    study's header under the new address.
 *  - **Each tab is behind its own boundary** (contract §5): a tab that cannot read its payload shows an error card inside the tab,
 *    and the header and the other tabs stay.
 *  - **Opening a study moves the shell to its project** (once per visit), so the sidebar has it first and highlighted, the runtime is
 *    warm when the conversation is wanted, and the conversation can be placed over its pane at all. A reader whose account the
 *    project is not in (another member of the study) stays where they are, and the tabs are theirs without it.
 *  - **`chat` is not a tab.** It is read here, before the address is read as a step or a tab, because the server has no such route.
 */
export function VcrStudyPage() {
  const { studyId = "", tab: tabParam } = useParams();
  const navigate = useNavigate();
  const feature = useVcrFeature();
  const [query] = useSearchParams();
  const location = useLocation();
  const chat = tabParam === "chat";
  // With the conversation open the address also says which result is beside it.
  const { tab, moved } = chat ? { tab: resolveVcrTab(query.get("result")).tab, moved: false } : resolveVcrTab(tabParam);
  const view: StudyView = chat ? "chat" : tab;
  const { loaded, reload, refreshError } = useStudy(studyId, feature !== "loading" && feature !== "off", view);

  useEffect(() => {
    // An address that named a step is rewritten to the tab that holds it, in
    // place, so a reader who came in on a step link leaves with a tab link.
    if (tabParam === "patients" && studyId) {
      const next = new URLSearchParams(query); next.set("level", "individual");
      navigate(`${vcrTabPath(studyId, "population")}?${next}`, { replace: true });
      return;
    }
    if (moved && studyId) navigate(tabParam === "definition" || tabParam === "evidence" ? vcrStepPath(studyId, tabParam) : vcrTabPath(studyId, tab), { replace: true });
  }, [moved, studyId, tab, tabParam, navigate, query]);

  if (feature === "off" || loaded.kind === "off") return <VcrOffPage />;
  if (loaded.kind === "missing") {
    return (
      <PageShell title="虚拟临床研究" width="wide">
        <EmptyState
          icon={UsersRound}
          title="这个研究不存在或已删除。"
          action={<Button variant="secondary" onClick={() => navigate(vcrWorkspaceAreaPath("records"))}>回到研究列表</Button>}
        />
      </PageShell>
    );
  }
  if (loaded.kind !== "ready") {
    return (
      <PageShell title="虚拟临床研究" width="wide">
        {loaded.kind === "error" ? <LoadError message={loaded.message} onRetry={reload} /> : <VcrStudySkeleton />}
      </PageShell>
    );
  }
  if (loaded.study.purpose === "calculation") {
    // A calculation has no overview (the history of its methods is its landing page), and each of its other views has one address: its own.
    if ((tab === "overview" && !query.has("package")) || (chat && !loaded.study.conversation.sessionId)) return <CalculationRedirect to={vcrCalculationPath(studyId)} />;
    if (!chat && location.pathname.startsWith(VCR_HOME_PATH)) return <CalculationRedirect to={`${vcrCalculationViewPath(studyId, tab)}${location.search}`} />;
  }
  // Keyed by the study: the menu's dialogs and the run guard never outlive it.
  return <StudyView key={studyId} studyId={studyId} study={loaded.study} view={view} tab={tab} reload={reload} refreshError={refreshError} />;
}

function CalculationRedirect({ to }: { to: string }) {
  const navigate = useNavigate();
  useEffect(() => { navigate(to, { replace: true }); }, [navigate, to]);
  return <VcrStudySkeleton />;
}

/** Which of the page's panels is open over it. */
type Panel = "rename" | "export" | "members" | "budget" | "changes" | "runs" | "intake" | "delete" | null;

function StudyView({ studyId, study, view, tab, reload, refreshError }: { studyId: string; study: VcrStudy; view: StudyView; tab: VcrTabKey; reload: () => void; refreshError: string | null }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { run, busy: running } = useVcrRun(study, { refresh: reload });
  const [panel, setPanel] = useState<Panel>(() => params.get("intake") === "1" ? "intake" : null);
  const [deleting, setDeleting] = useState(false);
  const [changingStatus, setChangingStatus] = useState(false);
  // A read of this page that failed after it had answered (the study's own, or a tab's) keeps what it showed and says so once, here.
  const [failures, setFailures] = useState<Record<string, { message: string; retry: () => void }>>({});
  const reportFailure = useCallback<VcrRefreshReporter>((id, failure) => setFailures((current) => {
    if (!failure) { if (!(id in current)) return current; const rest = { ...current }; delete rest[id]; return rest; }
    return { ...current, [id]: failure };
  }), []);
  const refreshFailed = refreshError ?? Object.values(failures)[0]?.message ?? null;
  const retryFailed = () => { reload(); for (const failure of Object.values(failures)) failure.retry(); };
  const packageId = params.get("package");
  const Tab = TABS[tab];
  // What this reader may do here, from the roles the server says they hold:
  // the menu offers only the actions that will not be refused (the routes
  // check for themselves, per operation — this is presentation).
  const can = (ability: string) => study.abilities.includes(ability);
  const continueStudy = useContinueStudy();

  // --- the shell moves to the study's project, once ------------------------------------------------------------------
  // --- where a study opens: on what it holds, once -----------------------------------------------------------------------
  // An address that names no tab opens the study's overview. A study that was never asked a question and defined nothing -- a matching
  // done in a conversation -- has nothing to say there, so it opens on the first tab that holds its results instead. Once per visit:
  // the reader who then presses 总览 is not sent back, and an address that names a tab, the conversation or a package is honoured.
  const location = useLocation();
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current) return;
    landed.current = true;
    if (view !== "overview" || params.has("package")) return;
    const to = landingTab(study);
    if (to) navigate(`${vcrTabPath(studyId, to)}${location.search}`, { replace: true });
    // One look, at the first paint: a study read later does not move the reader.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentProjectId = useProjectStore((state) => state.currentId);
  const [unreachable, setUnreachable] = useState(false);
  const moving = useRef(false);
  useEffect(() => {
    if (moving.current) return;
    moving.current = true;
    if (!study.projectId || study.projectId === currentProjectId) return;
    // The shell remounts the routed page under the new project (`AppShell` keys it by the project), and this page paints its last
    // answer at once (`useStudy`); a project the account cannot open is left as it is and the conversation says so.
    void useProjectStore.getState().select(study.projectId).catch(() => setUnreachable(true));
  }, [study.projectId, currentProjectId]);

  // The sidebar is told which study is open and which conversation is its own, so that conversation's row opens this page's view of
  // it — and has a row before its first sentence.
  const heldSession = study.conversation.sessionId;
  useEffect(() => study.purpose === "task" ? undefined : announceOpenStudy({ studyId, projectId: study.projectId, sessionId: heldSession }), [studyId, study.projectId, heldSession, study.purpose]);

  // --- a study named in its conversation: the project list and the sidebar are told -----------------------------------
  const seen = useRef({ name: study.name, status: study.status });
  useEffect(() => {
    if (seen.current.name === study.name && seen.current.status === study.status) return;
    seen.current = { name: study.name, status: study.status };
    // The project carries the study's name, and a draft that was spoken in is a study now.
    void useProjectStore.getState().load();
    announceVcrStudiesChanged();
  }, [study.name, study.status]);

  const exportAs = (kind: VcrExportKind) => {
    // The document is written by a run the strip shows; the overview's deliverables list it when it is there.
    setPanel(null);
    void run(() => exportVcrStudy(studyId, kind), "文档暂时无法导出，请稍后重试。");
  };

  const paused = study.status === "paused";
  const setStatus = () => {
    if (changingStatus) return;
    setChangingStatus(true);
    void patchVcrStudy(studyId, { status: paused ? "active" : "paused" })
      .then(() => { toast.success(paused ? "已继续。" : "已暂停。"); reload(); })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "研究状态无法修改，请稍后重试。" })))
      .finally(() => setChangingStatus(false));
  };
  const menu: MenuEntry[] = [
    ...(can("read") ? [{ label: "在新对话中继续", onSelect: () => continueStudy({ id: studyId, projectId: study.projectId, name: study.name }) }] : []),
    ...(can("write") ? [{ label: "重命名", onSelect: () => setPanel("rename") }] : []),
    ...(can("export") ? [{ label: "导出…", disabled: running, onSelect: () => setPanel("export") }] : []),
    // 数据接入 is one entry on every tier: a study with no data plane to take it says so in the drawer, and a tier that takes real
    // data finds its sources there — it used to be the last block of 定义与证据.
    ...(can("manage_data") || can("read") ? [{ label: INTAKE_LABEL, onSelect: () => setPanel("intake") }] : []),
    ...(can("manage_members") ? [{ label: "成员与角色", onSelect: () => setPanel("members") }] : []),
    // The compute budget, the study's status and its deletion are the lead's
    // (`manage_study`): the second human stop is confirmed by the person who
    // signs the study off, not by whoever queued the compute.
    ...(can("manage_study") ? [{ label: "计算预算", onSelect: () => setPanel("budget") }] : []),
    ...(can("manage_study") ? [{ label: paused ? "继续研究" : "暂停研究", disabled: changingStatus, onSelect: setStatus }] : []),
    { label: "变更记录", onSelect: () => setPanel("changes") },
    { label: "AI 运行", onSelect: () => setPanel("runs") },
    ...(can("manage_study") ? ["separator" as const, { label: "删除", destructive: true, onSelect: () => setPanel("delete") }] : []),
  ];

  const remove = () => {
    if (deleting) return;
    setDeleting(true);
    void deleteVcrStudy(studyId)
      .then(() => {
        toast.success("研究已从虚拟临床研究移除。");
        announceVcrStudiesChanged();
        navigate(VCR_HOME_PATH, { replace: true });
      })
      .catch((error: unknown) => {
        toast.error(webErrorMessage(error, { fallback: "研究无法删除，请稍后重试。" }));
        setDeleting(false);
        setPanel(null);
      });
  };

  const renamed = () => {
    setPanel(null);
    reload();
    // The sidebar lists projects, and the project carries the study's name.
    void useProjectStore.getState().load();
    announceVcrStudiesChanged();
  };

  // --- the way into the conversation, and out of it ------------------------------------------------------------------
  const sessionId = study.conversation.sessionId;
  const hasProvisionalDraft = Boolean(location.state && typeof location.state === "object" && "vcrPendingDraft" in location.state);
  const provisionalDraft = view === "chat" && study.id === studyId ? vcrPendingDraftStatus(location.state, studyId, study.projectId) : null;
  const openChat = useCallback((draft?: string, reference?: VcrObjectSelection, restoreDraft = false) => {
    // Whatever is being read stays beside the conversation.
    const beside = new URLSearchParams(params);
    beside.set("result", tab);
    const path = `${vcrChatPath(studyId)}?${beside}`;
    const owner = sessionOwner();
    const state = { ...sanitizeRuntimeUiHistoryState(location.state) as Record<string, unknown> };
    if (draft && !sessionId) {
      const marker = prepareVcrPendingDraft(studyId, study.projectId, { draft, reference, restoreDraft });
      delete state.runtimeUiIntent;
      navigate(path, { state: { ...state, vcrPendingDraft: marker } });
      return;
    }
    if (draft && sessionId) {
      const intent: RuntimeUiIntent = {
        kind: "open", projectId: study.projectId, requestId: crypto.randomUUID(), owner, sessionId, draft,
        ...(restoreDraft ? { restoreDraft: true } : {}), ...(reference ? { vcrReference: reference } : {}),
      };
      delete state.vcrPendingDraft;
      state.runtimeUiIntent = prepareRuntimeUiIntent(intent);
    }
    navigate(path, { state });
  }, [navigate, sessionId, study.projectId, studyId, tab, params, location.state]);
  useEffect(() => {
    if (view !== "chat" || !sessionId) return;
    const intent = runtimeUiIntentFromState(location.state, study.projectId);
    // The verified study owns the session even while its pane is locked or unreachable.
    if (intent?.kind === "open" && !intent.scope && intent.sessionId === sessionId
      && (!intent.vcrReference?.studyId || intent.vcrReference.studyId === studyId)) {
      registerPendingRuntimeUiIntent(intent);
      retireVcrPendingDraft(studyId, study.projectId, intent);
    }
  }, [location.state, sessionId, study.projectId, studyId, view]);
  useEffect(() => {
    if (view === "chat" && study.id === studyId) acceptVcrPendingDraft(location.state, studyId, study.projectId);
  }, [location.state, study.id, study.projectId, studyId, view]);
  const promoteDraft = useCallback(() => {
    if (view !== "chat" || study.id !== studyId || !sessionId) return;
    const marker = promoteVcrPendingDraft(location.state, studyId, study.projectId, sessionId);
    if (!marker) return;
    const state = { ...sanitizeRuntimeUiHistoryState(location.state) as Record<string, unknown> };
    delete state.vcrPendingDraft;
    navigate({ pathname: location.pathname, search: location.search, hash: location.hash }, { replace: true, state: { ...state, runtimeUiIntent: marker } });
  }, [location.pathname, location.search, location.hash, location.state, navigate, sessionId, study.id, study.projectId, studyId, view]);
  const attemptedPromotion = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionId || provisionalDraft !== "waiting") return;
    const attempt = `${location.key}:${sessionId}`;
    if (attemptedPromotion.current === attempt) return;
    attemptedPromotion.current = attempt;
    promoteDraft();
  }, [location.key, promoteDraft, provisionalDraft, sessionId]);
  const restoredRemoteDraft = useRef<string | null>(null);
  useEffect(() => {
    if (view !== "chat" || study.status !== "draft" || !study.question || !sessionId || restoredRemoteDraft.current === studyId
      || hasProvisionalDraft || runtimeUiIntentFromState(location.state, study.projectId)) return;
    restoredRemoteDraft.current = studyId;
    openChat(study.question, undefined, true);
  }, [view, study.status, study.question, sessionId, study.projectId, studyId, openChat, location.state, hasProvisionalDraft]);
  const openView = useCallback((next: StudyView) => {
    if (next === "chat") openChat();
    // With the conversation open, a destination changes what is beside it and leaves the conversation where it is.
    else if (view === "chat") navigate(`${vcrChatPath(studyId)}?result=${next}`, { state: sanitizeRuntimeUiHistoryState(location.state) });
    else navigate(study.purpose === "calculation" ? vcrCalculationViewPath(studyId, next) : vcrTabPath(studyId, next));
  }, [navigate, openChat, studyId, study.purpose, view, location.state]);

  const stop = () => { void cancelVcrStudy(studyId).then(reload).catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "暂时无法停止，请稍后重试。" }))); };

  // What waits for the lead's word: a job past the budget. Said once, with the way to give it — and not to a reader who cannot.
  // The header's primary action is 确认预算 while this is so (`StudyFrame`); the sentence says how much, and its number opens the same dialog.
  const waiting = budgetWaitOf(study);
  const budgetNote = waiting.count > 0 && can("manage_study") ? (
    <Note
      tone="warn"
      className="mb-4"
      result={["有 ", { n: waiting.count, onOpen: () => setPanel("budget"), label: `${waiting.count} 项计算等待预算确认` }, ` 项计算等你确认预算${waiting.seconds > 0 ? `，需 ${cpuTimeText(waiting.seconds)} CPU 时间` : ""}`]}
    />
  ) : null;

  // A pause is the study's and not a step's: new work is not started until it goes on, and the one who paused it (the lead) goes on from here.
  const pausedNote = paused ? (
    <Note
      tone="warn"
      className="mb-4"
      action={can("manage_study") ? <Button size="sm" variant="secondary" actionKind="set" loading={changingStatus} onClick={setStatus}>继续</Button> : undefined}
    >
      {`${workStateLabel("paused")}：新的步骤不会开始，已有的结果仍可查看。`}
    </Note>
  ) : null;

  // The tab's element is made once per study read: a toolbar its tab hands the band re-renders the band, never the tab.
  const body = useMemo(() => (
    <VcrTabBoundary key={tab}>
      <Tab studyId={studyId} study={study} onStudyChanged={reload} />
    </VcrTabBoundary>
  ), [Tab, tab, studyId, study, reload]);

  // What the study waits for, over every result; the overview lists it all, and is where a line without a link of its own is done.
  const needs: WorkNeed[] = tab === "overview" ? [] : study.overview.attention.filter((line) => line.tone === "attention").map((line) => ({
    key: line.kind, kind: line.kind === "allowance_waiting" ? "resolve" as const : line.kind.startsWith("intake") || line.kind === "budget_confirm" ? "confirm" as const : "provide" as const, text: line.text,
    action: <Link className="rounded text-link hover:underline" to={vcrTabPath(studyId, line.action?.tab ?? line.tab ?? "overview")}>{line.action?.label ?? "去处理"}</Link>,
  }));
  const results = (
    <>
      {pausedNote}
      <NeedsBar needs={needs} more={<Link className="text-caption text-text-3 hover:underline" to={vcrTabPath(studyId, "overview")}>全部</Link>} />
      {study.tierOffer && can("manage_study") && <VcrTierOffer studyId={studyId} offer={study.tierOffer} onMoved={reload} />}
      {budgetNote}
      {packageId ? (
        <VcrPackageReader
          studyId={studyId}
          exportId={packageId}
          onBack={() => { params.delete("package"); setParams(params, { replace: true }); }}
        />
      ) : body}
    </>
  );
  const collapseTo = (() => {
    const kept = new URLSearchParams(params);
    kept.delete("result");
    const query = kept.toString();
    return `${study.purpose === "calculation" ? vcrCalculationViewPath(studyId, tab) : vcrTabPath(studyId, tab)}${query ? `?${query}` : ""}`;
  })();

  return (
    <StudyFrame studyId={studyId} study={study} view={view} tab={tab} reload={reload} menu={menu} onChat={openChat} onPanel={setPanel} onView={openView}>
      <VcrRefreshContext.Provider value={reportFailure}>
      {(refreshError !== null || Object.keys(failures).length > 0) && <VcrRefreshNote message={refreshFailed} onRetry={retryFailed} />}
      {provisionalDraft === "waiting" && <Note action={<Button size="sm" variant="text" onClick={sessionId ? promoteDraft : reload}>重试连接研究对话</Button>}>请求已保留。研究对话连接后会恢复到输入框，由你发送。</Note>}
      {provisionalDraft === "lost" && <Note tone="warn" action={null}>先前等待连接的草稿未恢复。请重新输入。</Note>}
      {view === "chat" ? (
        <WorkspaceSplit
          collapseTo={collapseTo}
          results={<div id={STUDY_PANEL_ID} role="region" aria-label="研究内容">{results}</div>}
          conversation={<StudyPane study={study} unreachable={unreachable} onRetry={reload} onStop={can("run") ? stop : undefined} />}
        />
      ) : results}

      {panel === "rename" && <VcrRenameDialog studyId={studyId} name={study.name} onClose={() => setPanel(null)} onRenamed={renamed} />}
      {panel === "export" && <VcrExportDialog busy={running} onClose={() => setPanel(null)} onExport={exportAs} />}
      {panel === "members" && <VcrMembersDialog studyId={studyId} onClose={() => setPanel(null)} />}
      {panel === "changes" && <VcrChangeLogDrawer study={study} onClose={() => setPanel(null)} />}
      {panel === "runs" && <VcrBackgroundRunsDrawer studyId={studyId} study={study} onClose={() => setPanel(null)} />}
      {panel === "intake" && <VcrIntakeDrawer studyId={studyId} onClose={() => { setPanel(null); if (params.has("intake")) setParams(current => { const next = new URLSearchParams(current); next.delete("intake"); return next; }, { replace: true }); }} onChanged={reload} />}

      {panel === "budget" && (
        <VcrBudgetDialog
          studyId={studyId}
          budget={study.budget}
          jobs={study.jobs}
          onClose={() => setPanel(null)}
          onSaved={() => { setPanel(null); reload(); }}
        />
      )}

      {panel === "delete" && (
        <ConfirmDialog
          title={`删除“${study.name}”？`}
          body="研究会从虚拟临床研究移除；项目里的对话和文件仍在。"
          confirmLabel="删除"
          busy={deleting}
          onConfirm={remove}
          onCancel={() => setPanel(null)}
        />
      )}
      </VcrRefreshContext.Provider>
    </StudyFrame>
  );
}
