import { useCallback, useEffect, useState, type ComponentType } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { ChevronLeft, MessageSquare, MoreHorizontal, UsersRound } from "lucide-react";
import { webErrorMessage } from "@/lib/apiClient";
import {
  deleteVcrStudy,
  exportVcrStudy,
  getVcrStudy,
  isVcrMissing,
  isVcrOff,
  patchVcrStudy,
  useVcrFeature,
  type VcrExportKind,
  type VcrStudy,
  type VcrTabKey,
} from "@/lib/vcrClient";
import { useProjectStore } from "@/lib/projects";
import { toast } from "@/lib/toast";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { PageShell } from "@/components/layout/PageShell";
import { Button, buttonClasses } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { IconButton } from "@/components/ui/IconButton";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { Tabs } from "@/components/ui/Tabs";
import { StudyTags } from "@/components/vcr/VcrMarks";
import { VcrOffPage, VcrStudySkeleton } from "@/components/vcr/VcrStates";
import { VcrBudgetDialog } from "@/components/vcr/VcrBudgetDialog";
import { VcrJobLine } from "@/components/vcr/VcrJobLine";
import { VcrMembersDialog } from "@/components/vcr/VcrMembersDialog";
import { VcrPackageReader } from "@/components/vcr/VcrPackageReader";
import { VcrBackgroundRunsDrawer, VcrChangeLogDrawer } from "@/components/vcr/VcrStudyDrawers";
import { VcrExportDialog, VcrRenameDialog } from "@/components/vcr/VcrStudyDialogs";
import { VcrTierOffer } from "@/components/vcr/VcrTierOffer";
import { useOpenVcrConversation } from "@/components/vcr/useOpenVcrConversation";
import { useVcrRun } from "@/components/vcr/useVcrRun";
import { VcrTabBoundary } from "@/components/vcr/vcrTabKit";
import { OverviewTab } from "@/components/vcr/tabs/OverviewTab";
import { PopulationTab } from "@/components/vcr/tabs/PopulationTab";
import { PatientsTab } from "@/components/vcr/tabs/PatientsTab";
import { ComparatorTab } from "@/components/vcr/tabs/ComparatorTab";
import { TrialTab } from "@/components/vcr/tabs/TrialTab";
import { MatchingTab } from "@/components/vcr/tabs/MatchingTab";
import { DataTab } from "@/components/vcr/tabs/DataTab";
import { resolveVcrTab, tabDot, VCR_HOME_PATH, VCR_TAB_ITEMS, vcrTabPath } from "@/components/vcr/vcrTabs";

/** `onStudyChanged`: a tab that changes what the header shows (the data tab's intake moves the tier offer) asks the page to read the study again. */
type TabComponent = ComponentType<{ studyId: string; study: VcrStudy; onStudyChanged?: () => void }>;

const TABS: Record<VcrTabKey, TabComponent> = {
  overview: OverviewTab,
  population: PopulationTab,
  patients: PatientsTab,
  comparator: ComparatorTab,
  trial: TrialTab,
  matching: MatchingTab,
  data: DataTab,
};

/** What the page holds, and for which study: an answer for another id is not this page's. */
type Loaded =
  | { kind: "loading" }
  | { kind: "off"; id: string }
  | { kind: "missing"; id: string }
  | { kind: "error"; id: string; message: string }
  | { kind: "ready"; id: string; study: VcrStudy };

/** What the engine's absence says, once, at the top: the page used to learn it from a job that failed. */
export const VCR_ENGINE_LINE = "计算引擎暂不可用，计算类步骤会在引擎恢复后继续";

/**
 * One study, on the wide column a data page needs.
 *
 * The header is the study's name and its data tier, the way into its conversation and a menu — and then **one row of tabs, each
 * with a dot that says how far its stage has come** (总览 · 定义与证据 · 人群 · 虚拟患者 · 对照 · 试验 · 匹配与招募). A step rail used
 * to sit above the tabs and repeat five of their seven names as a second navigation; the rail is gone and the state is the dot. A
 * computation under way is one line under the row, and only while there is one.
 *
 * **There is no second composer here** (2026-09-20 ruling, plan §9.5). 「对话」 in the header is the one way into the study's
 * conversation — the one it was opened with, never the newest background run's — and every empty tab sends the reader there or
 * offers 「让 AI 做」, which starts that step in it. What can be edited on the page itself is the structured cards — an assumption,
 * the population's and a design's numbers, a criterion's threshold, a decision — and each edit makes a new version, which is what
 * marks the results downstream of it stale.
 *
 * Hidden knowledge:
 *  - **An answer belongs to the id it was asked for.** Moving from one study to another shows the skeleton, never the previous
 *    study's header under the new address.
 *  - **Each tab is behind its own boundary** (contract §5): a tab that cannot read its payload shows an error card inside the tab,
 *    and the header and the other six tabs stay.
 */
export function VcrStudyPage() {
  const { studyId = "", tab: tabParam } = useParams();
  const navigate = useNavigate();
  const feature = useVcrFeature();
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [reloads, setReloads] = useState(0);
  const { tab, moved } = resolveVcrTab(tabParam);

  useEffect(() => {
    // An address that named a step is rewritten to the tab that holds it, in
    // place, so a reader who came in on a step link leaves with a tab link.
    if (moved && studyId) navigate(vcrTabPath(studyId, tab), { replace: true });
  }, [moved, studyId, tab, navigate]);

  useEffect(() => {
    if (feature === "loading" || feature === "off") return undefined;
    let live = true;
    void getVcrStudy(studyId).then(
      (study) => { if (live) setLoaded({ kind: "ready", id: studyId, study }); },
      (error: unknown) => {
        if (!live) return;
        if (isVcrOff(error)) setLoaded({ kind: "off", id: studyId });
        else if (isVcrMissing(error)) setLoaded({ kind: "missing", id: studyId });
        else setLoaded({ kind: "error", id: studyId, message: webErrorMessage(error, { fallback: "研究暂时无法读取。" }) });
      },
    );
    return () => { live = false; };
  }, [feature, studyId, reloads]);

  const reload = useCallback(() => setReloads((value) => value + 1), []);
  const shown: Loaded = loaded.kind !== "loading" && loaded.id !== studyId ? { kind: "loading" } : loaded;

  if (feature === "off" || shown.kind === "off") return <VcrOffPage />;
  if (shown.kind === "missing") {
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
  if (shown.kind !== "ready") {
    return (
      <PageShell title="虚拟临床研究" width="wide">
        {shown.kind === "error" ? <LoadError message={shown.message} onRetry={reload} /> : <VcrStudySkeleton />}
      </PageShell>
    );
  }
  // Keyed by the study: the menu's dialogs and the run guard never outlive it.
  return <StudyView key={studyId} studyId={studyId} study={shown.study} tab={tab} reload={reload} />;
}

/** Which of the page's panels is open over it. */
type Panel = "rename" | "export" | "members" | "budget" | "changes" | "runs" | "delete" | null;

function StudyView({ studyId, study, tab, reload }: { studyId: string; study: VcrStudy; tab: VcrTabKey; reload: () => void }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const openConversation = useOpenVcrConversation();
  const { run, busy: running } = useVcrRun(study);
  const [opening, setOpening] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [deleting, setDeleting] = useState(false);
  const [changingStatus, setChangingStatus] = useState(false);
  const packageId = params.get("package");
  const Tab = TABS[tab];
  // What this reader may do here, from the roles the server says they hold:
  // the menu offers only the actions that will not be refused (the routes
  // check for themselves, per operation — this is presentation).
  const can = (ability: string) => study.abilities.includes(ability);
  const engineLine = study.engine === "missing" || study.engine === "not_answering";

  const exportAs = (kind: VcrExportKind) => {
    // A deferred export stays on the page with its sentence; the overview's
    // deliverables are re-read so the queued package is listed.
    setPanel(null);
    void run(() => exportVcrStudy(studyId, kind), "文档暂时无法导出，请稍后重试。", reload);
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
        navigate(VCR_HOME_PATH, { replace: true });
      })
      .catch((error: unknown) => {
        toast.error(webErrorMessage(error, { fallback: "研究无法删除，请稍后重试。" }));
        setDeleting(false);
        setPanel(null);
      });
  };

  const openStudyConversation = () => {
    if (opening) return;
    setOpening(true);
    void openConversation({ projectId: study.projectId, sessionId: study.sessionId })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "对话暂时无法打开，请稍后重试。" })))
      .finally(() => setOpening(false));
  };

  const renamed = () => {
    setPanel(null);
    reload();
    // The sidebar lists projects, and the project carries the study's name.
    void useProjectStore.getState().load();
  };

  return (
    <PageShell
      title={study.name}
      width="wide"
      back={(
        // No left padding: the link's own box starts on the page's one left edge. It used to be padded 10 px and pulled back by -10 px, so
        // the chevron sat on the edge and the box 10 px outside it — the second left edge the release walk found on every tab.
        <Link to={VCR_HOME_PATH} className={buttonClasses({ variant: "text", size: "sm", className: "pl-0" })}>
          <ChevronLeft size={16} aria-hidden="true" />虚拟临床研究
        </Link>
      )}
      meta={<StudyTags tier={study.tier} ceiling={study.ceiling} />}
      actions={(
        <>
          <Button variant="secondary" loading={opening} onClick={openStudyConversation}>
            <MessageSquare size={16} aria-hidden="true" />
            对话
          </Button>
          <Menu label="更多操作" items={menu}>
            <IconButton icon={MoreHorizontal} label="更多操作" className="data-[state=open]:bg-surface-2 data-[state=open]:text-text" />
          </Menu>
        </>
      )}
    >
      {engineLine && <p data-vcr-engine={study.engine} role="status" className="mb-4 rounded bg-warn-soft px-3 py-2 text-ui text-warn-strong">{VCR_ENGINE_LINE}</p>}

      {study.tierOffer && can("manage_study") && <VcrTierOffer studyId={studyId} offer={study.tierOffer} onMoved={reload} />}

      {packageId ? (
        <VcrPackageReader
          studyId={studyId}
          exportId={packageId}
          onBack={() => { params.delete("package"); setParams(params, { replace: true }); }}
        />
      ) : (
        <>
          <Tabs
            label="研究视图"
            items={VCR_TAB_ITEMS.map((item) => ({ value: item.key, label: item.label, dot: tabDot(study, item.key) }))}
            value={tab}
            onChange={(next) => navigate(vcrTabPath(studyId, next))}
            panelId="vcr-tab-panel"
          />
          <VcrJobLine studyId={studyId} study={study} onBudget={() => setPanel("budget")} onChanged={reload} />
          <div id="vcr-tab-panel" role="tabpanel" aria-labelledby={`vcr-tab-panel-tab-${tab}`} className="pt-6">
            <VcrTabBoundary key={tab}>
              <Tab studyId={studyId} study={study} onStudyChanged={reload} />
            </VcrTabBoundary>
          </div>
        </>
      )}

      {panel === "rename" && <VcrRenameDialog studyId={studyId} name={study.name} onClose={() => setPanel(null)} onRenamed={renamed} />}
      {panel === "export" && <VcrExportDialog busy={running} onClose={() => setPanel(null)} onExport={exportAs} />}
      {panel === "members" && <VcrMembersDialog studyId={studyId} onClose={() => setPanel(null)} />}
      {panel === "changes" && <VcrChangeLogDrawer study={study} onClose={() => setPanel(null)} />}
      {panel === "runs" && <VcrBackgroundRunsDrawer studyId={studyId} study={study} onClose={() => setPanel(null)} />}

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
    </PageShell>
  );
}
