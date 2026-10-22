import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { UsersRound } from "lucide-react";
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
import type { RuntimeUiIntent } from "@/lib/runtimeUiNavigation";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { PageShell } from "@/components/layout/PageShell";
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
import { VcrTierOffer } from "@/components/vcr/VcrTierOffer";
import { StudyFrame, type StudyView } from "@/components/vcr/StudyFrame";
import { VcrStudyMethods } from "@/components/vcr/VcrStudyMethods";
import { VcrStudyBrief } from "@/components/vcr/VcrStudyBrief";
import { vcrCalculationPath } from "@/lib/vcrMethodLocation";
import { StudyPane } from "@/components/vcr/StudyPane";
import { useStudy } from "@/components/vcr/useStudy";
import { useVcrRun } from "@/components/vcr/useVcrRun";
import { announceVcrStudiesChanged } from "@/components/vcr/useVcrProjectIds";
import { VcrTabBoundary } from "@/components/vcr/vcrTabKit";
import { OverviewTab } from "@/components/vcr/tabs/OverviewTab";
import { PopulationTab } from "@/components/vcr/tabs/PopulationTab";
import { PatientsTab } from "@/components/vcr/tabs/PatientsTab";
import { ComparatorTab } from "@/components/vcr/tabs/ComparatorTab";
import { TrialTab } from "@/components/vcr/tabs/TrialTab";
import { MatchingTab } from "@/components/vcr/tabs/MatchingTab";
import { DataTab } from "@/components/vcr/tabs/DataTab";
import { resolveVcrTab, VCR_HOME_PATH, vcrStepPath, vcrTabPath } from "@/components/vcr/vcrTabs";

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
  population: PopulationTab,
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
  const chat = tabParam === "chat";
  const { tab, moved } = chat ? { tab: "overview" as VcrTabKey, moved: false } : resolveVcrTab(tabParam);
  const view: StudyView = chat ? "chat" : tab;
  const { loaded, reload } = useStudy(studyId, feature !== "loading" && feature !== "off", view);

  useEffect(() => {
    // An address that named a step is rewritten to the tab that holds it, in
    // place, so a reader who came in on a step link leaves with a tab link.
    if (moved && studyId) navigate(tabParam === "definition" || tabParam === "evidence" ? vcrStepPath(studyId, tabParam) : vcrTabPath(studyId, tab), { replace: true });
  }, [moved, studyId, tab, tabParam, navigate]);

  if (feature === "off" || loaded.kind === "off") return <VcrOffPage />;
  if (loaded.kind === "missing") {
    return (
      <PageShell title="虚拟临床研究" width="wide">
        <EmptyState
          icon={UsersRound}
          title="这个研究不存在或已删除。"
          action={<Button variant="secondary" onClick={() => navigate(VCR_HOME_PATH)}>回到研究列表</Button>}
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
  if (loaded.study.purpose === "calculation" && ((tab === "overview" && !query.has("package")) || (chat && !loaded.study.conversation.sessionId))) return <CalculationRedirect studyId={studyId} />;
  // Keyed by the study: the menu's dialogs and the run guard never outlive it.
  return <StudyView key={studyId} studyId={studyId} study={loaded.study} view={view} tab={tab} reload={reload} />;
}

function CalculationRedirect({ studyId }: { studyId: string }) {
  const navigate = useNavigate();
  useEffect(() => { navigate(vcrCalculationPath(studyId), { replace: true }); }, [navigate, studyId]);
  return <VcrStudySkeleton />;
}

/** Which of the page's panels is open over it. */
type Panel = "rename" | "export" | "members" | "budget" | "changes" | "runs" | "intake" | "delete" | null;

function StudyView({ studyId, study, view, tab, reload }: { studyId: string; study: VcrStudy; view: StudyView; tab: VcrTabKey; reload: () => void }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { run, busy: running } = useVcrRun(study, { refresh: reload });
  const [panel, setPanel] = useState<Panel>(() => params.get("intake") === "1" ? "intake" : null);
  const [deleting, setDeleting] = useState(false);
  const [changingStatus, setChangingStatus] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const packageId = params.get("package");
  const methodsOpen = params.get("methods") === "1";
  const Tab = TABS[tab];
  // What this reader may do here, from the roles the server says they hold:
  // the menu offers only the actions that will not be refused (the routes
  // check for themselves, per operation — this is presentation).
  const can = (ability: string) => study.abilities.includes(ability);

  // --- the shell moves to the study's project, once ------------------------------------------------------------------
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
  useEffect(() => announceOpenStudy({ studyId, projectId: study.projectId, sessionId: heldSession }), [studyId, study.projectId, heldSession]);

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
    ...(can("write") ? [{ label: "重命名", onSelect: () => setPanel("rename") }] : []),
    ...(can("export") ? [{ label: "导出…", disabled: running, onSelect: () => setPanel("export") }] : []),
    // 数据接入 is one entry on every tier: a study with no data plane to take it says so in the drawer, and a tier that takes real
    // data finds its sources there — it used to be the last block of 定义与证据.
    ...(can("manage_data") || can("read") ? [{ label: "数据接入", onSelect: () => setPanel("intake") }] : []),
    ...(can("manage_members") ? [{ label: "成员与角色", onSelect: () => setPanel("members") }] : []),
    // The compute budget, the study's status and its deletion are the lead's
    // (`manage_study`): the second human stop is confirmed by the person who
    // signs the study off, not by whoever queued the compute.
    ...(can("manage_study") ? [{ label: "计算预算", onSelect: () => setPanel("budget") }] : []),
    ...(can("manage_study") ? [{ label: paused ? "继续" : "暂停", disabled: changingStatus, onSelect: setStatus }] : []),
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
  const openChat = useCallback((draft?: string) => {
    // A draft waits in the composer of the study's own conversation and is never sent; with no conversation yet there is no
    // composer to hold it, and the view says so.
    const intent: RuntimeUiIntent | null = draft && sessionId
      ? { kind: "open", projectId: study.projectId, requestId: crypto.randomUUID(), sessionId, draft }
      : null;
    navigate(vcrChatPath(studyId), intent ? { state: { runtimeUiIntent: intent } } : undefined);
  }, [navigate, sessionId, study.projectId, studyId]);
  const openView = useCallback((next: StudyView) => {
    if (next === "chat") openChat();
    else navigate(study.purpose === "calculation" ? `${vcrCalculationPath(studyId)}/${next}` : vcrTabPath(studyId, next));
  }, [navigate, openChat, studyId, study.purpose]);

  const stop = () => { void cancelVcrStudy(studyId).then(reload).catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "暂时无法取消，请稍后重试。" }))); };

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

  // The tab's element is made once per study read: a toolbar its tab hands the band re-renders the band, never the tab.
  const body = useMemo(() => (
    <VcrTabBoundary key={tab}>
      <Tab studyId={studyId} study={study} onStudyChanged={reload} />
    </VcrTabBoundary>
  ), [Tab, tab, studyId, study, reload]);

  return (
    <StudyFrame studyId={studyId} study={study} view={view} reload={reload} menu={menu} onChat={openChat} onPanel={setPanel} onView={openView} methodsOpen={methodsOpen} onMethods={() => setParams(current => { const next = new URLSearchParams(current); if (methodsOpen) next.delete("methods"); else next.set("methods", "1"); return next; })}>
      {view === "chat" ? (
        study.status === "draft" && !submitted && !study.conversation.submitted && !study.activity?.run && !study.activity?.last ? <VcrStudyBrief study={study} onStarted={async (_remote, _answer, isCurrent) => { if (!isCurrent()) return false; setSubmitted(true); reload(); return true; }} onDataRequested={async (_remote, isCurrent) => { if (!isCurrent()) return false; setPanel("intake"); navigate(`${vcrTabPath(studyId, "data")}?intake=1`); return true; }} /> : <StudyPane study={study} unreachable={unreachable} onRetry={reload} onStop={can("run") ? stop : undefined} />
      ) : (
        <>
          {study.tierOffer && can("manage_study") && <VcrTierOffer studyId={studyId} offer={study.tierOffer} onMoved={reload} />}
          {budgetNote}
          {methodsOpen ? <VcrStudyMethods key={tab} studyId={studyId} tab={tab} /> : packageId ? (
            <VcrPackageReader
              studyId={studyId}
              exportId={packageId}
              onBack={() => { params.delete("package"); setParams(params, { replace: true }); }}
            />
          ) : body}
        </>
      )}

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
    </StudyFrame>
  );
}
