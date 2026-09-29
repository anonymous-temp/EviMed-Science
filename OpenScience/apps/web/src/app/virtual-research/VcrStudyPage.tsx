import { useCallback, useEffect, useState, type ComponentType } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { MessageSquare, MoreHorizontal, UsersRound } from "lucide-react";
import { webErrorMessage } from "@/lib/apiClient";
import {
  deleteVcrStudy,
  exportVcrStudy,
  getVcrStudy,
  isVcrMissing,
  isVcrOff,
  patchVcrStudy,
  useVcrFeature,
  type VcrStudy,
  type VcrTabKey,
} from "@/lib/vcrClient";
import { useProjectStore } from "@/lib/projects";
import { toast } from "@/lib/toast";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { PageShell } from "@/components/layout/PageShell";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { IconButton } from "@/components/ui/IconButton";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { ProgressRail, type RailState, type RailStep } from "@/components/ui/ProgressRail";
import { Tabs } from "@/components/ui/Tabs";
import { StudyTags } from "@/components/vcr/VcrMarks";
import { VcrOffPage, VcrStudySkeleton } from "@/components/vcr/VcrStates";
import { VcrBudgetDialog } from "@/components/vcr/VcrBudgetDialog";
import { VcrPackageReader } from "@/components/vcr/VcrPackageReader";
import { useOpenVcrConversation } from "@/components/vcr/useOpenVcrConversation";
import { OverviewTab } from "@/components/vcr/tabs/OverviewTab";
import { PopulationTab } from "@/components/vcr/tabs/PopulationTab";
import { PatientsTab } from "@/components/vcr/tabs/PatientsTab";
import { ComparatorTab } from "@/components/vcr/tabs/ComparatorTab";
import { TrialTab } from "@/components/vcr/tabs/TrialTab";
import { MatchingTab } from "@/components/vcr/tabs/MatchingTab";
import { DataTab } from "@/components/vcr/tabs/DataTab";
import { stepLabel, stepStatusLabel } from "@/components/vcr/vcrText";
import { resolveVcrTab, VCR_RAIL_STEPS, VCR_STEP_TABS, VCR_TAB_ITEMS, vcrTabPath } from "@/components/vcr/vcrTabs";

type TabComponent = ComponentType<{ studyId: string; study: VcrStudy }>;

const TABS: Record<VcrTabKey, TabComponent> = {
  overview: OverviewTab,
  population: PopulationTab,
  patients: PatientsTab,
  comparator: ComparatorTab,
  trial: TrialTab,
  matching: MatchingTab,
  data: DataTab,
};

type Loaded =
  | { kind: "loading" }
  | { kind: "off" }
  | { kind: "missing" }
  | { kind: "error"; message: string }
  | { kind: "ready"; study: VcrStudy };

/**
 * One study, on the wide column a data page needs.
 *
 * The header is the study, its data tier, what its results may be used for,
 * and the seven steps as one rail — with what each step produced. Then seven
 * tabs, which are the questions a reader arrives with rather than the order
 * the platform works in.
 *
 * **There is no second composer here** (2026-09-20 ruling, plan §9.5). 「对话」
 * in the header is the one way into the study's conversation, and every empty
 * tab offers 「让 AI 做」, which starts that step there. What can be edited on
 * the page itself is the structured cards — an assumption, a criterion, a
 * decision — and each edit makes a new version, which is what marks the
 * results downstream of it stale.
 */
export function VcrStudyPage() {
  const { studyId = "", tab: tabParam } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const feature = useVcrFeature();
  const openConversation = useOpenVcrConversation();
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [reloads, setReloads] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const { tab, moved } = resolveVcrTab(tabParam);
  const packageId = params.get("package");

  useEffect(() => {
    // An address that named a step is rewritten to the tab that holds it, in
    // place, so a reader who came in on a step link leaves with a tab link.
    if (moved && studyId) navigate(vcrTabPath(studyId, tab), { replace: true });
  }, [moved, studyId, tab, navigate]);

  useEffect(() => {
    if (feature === "loading" || feature === "off") return undefined;
    let live = true;
    void getVcrStudy(studyId).then(
      (study) => { if (live) setLoaded({ kind: "ready", study }); },
      (error: unknown) => {
        if (!live) return;
        if (isVcrOff(error)) setLoaded({ kind: "off" });
        else if (isVcrMissing(error)) setLoaded({ kind: "missing" });
        else setLoaded({ kind: "error", message: webErrorMessage(error, { fallback: "研究暂时无法读取。" }) });
      },
    );
    return () => { live = false; };
  }, [feature, studyId, reloads]);

  const reload = useCallback(() => setReloads((value) => value + 1), []);

  if (feature === "off" || loaded.kind === "off") return <VcrOffPage />;
  if (loaded.kind === "missing") {
    return (
      <PageShell title="虚拟临研" width="wide">
        <EmptyState
          icon={UsersRound}
          title="这个研究不存在或已删除。"
          action={<Button variant="secondary" onClick={() => navigate("/app/virtual-research")}>回到研究列表</Button>}
        />
      </PageShell>
    );
  }
  if (loaded.kind !== "ready") {
    return (
      <PageShell title="虚拟临研" width="wide">
        {loaded.kind === "error" ? <LoadError message={loaded.message} onRetry={reload} /> : <VcrStudySkeleton />}
      </PageShell>
    );
  }

  const study = loaded.study;
  const Tab = TABS[tab];

  /** An action that ends in the study's own conversation. */
  const act = (key: string, work: () => Promise<{ sessionId?: string | null } | void>, failure: string) => {
    if (busy) return;
    setBusy(key);
    void work()
      .then((result) => openConversation({ projectId: study.projectId, sessionId: result?.sessionId ?? study.sessionId }))
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: failure })))
      .finally(() => setBusy(null));
  };

  const paused = study.status === "paused";
  const menu: MenuEntry[] = [
    { label: "导出研究包", onSelect: () => act("study_package", () => exportVcrStudy(studyId, "study_package"), "研究包暂时无法导出，请稍后重试。") },
    { label: "导出 CDE 沟通交流资料包", onSelect: () => act("cde", () => exportVcrStudy(studyId, "cde_communication_pack"), "资料包暂时无法导出，请稍后重试。") },
    { label: "设定计算预算", onSelect: () => setBudgetOpen(true) },
    {
      label: paused ? "继续" : "暂停",
      onSelect: () => {
        void patchVcrStudy(studyId, { status: paused ? "active" : "paused" })
          .then(() => { toast.success(paused ? "已继续。" : "已暂停，排队中的计算停下了。"); reload(); })
          .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "研究状态无法修改，请稍后重试。" })));
      },
    },
    "separator",
    { label: "删除", destructive: true, onSelect: () => setConfirmDelete(true) },
  ];

  const remove = () => {
    setConfirmDelete(false);
    void deleteVcrStudy(studyId)
      .then(() => {
        // The control-plane project went with it: the sidebar's list is re-read.
        void useProjectStore.getState().load();
        navigate("/app/virtual-research", { replace: true });
      })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "研究无法删除，请稍后重试。" })));
  };

  return (
    <PageShell
      title={study.name}
      width="wide"
      meta={<StudyTags tier={study.tier} intendedUse={study.intendedUse} />}
      actions={(
        <>
          <Button
            variant="secondary"
            loading={busy === "conversation"}
            onClick={() => act("conversation", async () => ({ sessionId: study.sessionId }), "对话暂时无法打开，请稍后重试。")}
          >
            <MessageSquare size={16} aria-hidden="true" />
            对话
          </Button>
          <Menu label="更多操作" items={menu}>
            <IconButton icon={MoreHorizontal} label="更多操作" className="data-[state=open]:bg-surface-2 data-[state=open]:text-text" />
          </Menu>
        </>
      )}
    >
      <ProgressRail label="七步进度" steps={railSteps(study, studyId)} className="mb-6" />

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
            items={VCR_TAB_ITEMS.map((item) => ({ value: item.key, label: item.label }))}
            value={tab}
            onChange={(next) => navigate(vcrTabPath(studyId, next))}
            panelId="vcr-tab-panel"
            className="gap-4 overflow-x-auto sm:gap-6 [&>button]:shrink-0"
          />
          <div id="vcr-tab-panel" role="tabpanel" aria-labelledby={`vcr-tab-panel-tab-${tab}`} className="pt-6">
            <Tab studyId={studyId} study={study} />
          </div>
        </>
      )}

      {budgetOpen && (
        <VcrBudgetDialog
          studyId={studyId}
          budget={study.budget}
          onClose={() => setBudgetOpen(false)}
          onSaved={() => { setBudgetOpen(false); reload(); }}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={`删除“${study.name}”？`}
          body="这个研究的对话、文件、假设卡、人群版本和运行结果会一起删除，不能恢复。已经导出的研究包不会被撤回。"
          confirmLabel="删除"
          onConfirm={remove}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </PageShell>
  );
}

/** The rail's state for one step. `waiting` is the accent halo: it needs the reader. */
function railStateOf(status: string | undefined): RailState {
  switch (status) {
    case "done": case "minimal": return "done";
    case "running": case "queued": return "active";
    case "stale": case "failed": return "waiting";
    default: return "todo";
  }
}

/**
 * The seven steps as the header's rail, each linking to the tab that holds its
 * result. The note under a step is what it produced — 「12 张假设卡」「人群 v3」
 * — and, failing that, the state's own word; a step with no note at all reads
 * as an empty column.
 */
export function railSteps(study: VcrStudy, studyId: string): RailStep[] {
  return VCR_RAIL_STEPS.map(({ key }) => {
    const step = study.steps[key];
    const state = railStateOf(step?.status);
    return {
      key,
      name: stepLabel(key),
      note: step?.note ?? (step?.status && step.status !== "none" ? stepStatusLabel(step.status) : "未开始"),
      state,
      to: vcrTabPath(studyId, VCR_STEP_TABS[key]),
    };
  });
}
