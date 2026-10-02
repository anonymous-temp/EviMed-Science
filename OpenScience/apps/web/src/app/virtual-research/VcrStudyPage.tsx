import { useCallback, useEffect, useState, type ComponentType } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { VCR_EXPORT_KIND_LABELS_ZH } from "@evimed/domain";
import { MessageSquare, MoreHorizontal, UsersRound } from "lucide-react";
import { webErrorMessage } from "@/lib/apiClient";
import {
  cancelVcrJob,
  deleteVcrStudy,
  exportVcrStudy,
  getVcrStudy,
  isVcrMissing,
  isVcrOff,
  patchVcrStudy,
  useVcrFeature,
  type VcrExportKind,
  type VcrJob,
  type VcrStudy,
  type VcrTabKey,
} from "@/lib/vcrClient";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
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
import { cpuTimeText, jobsAwaitingBudget, VcrBudgetDialog } from "@/components/vcr/VcrBudgetDialog";
import { VcrMembersDialog } from "@/components/vcr/VcrMembersDialog";
import { VcrPackageReader } from "@/components/vcr/VcrPackageReader";
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
import { jobStateLabel, numberText, stepLabel, stepStatusLabel } from "@/components/vcr/vcrText";
import { resolveVcrTab, VCR_HOME_PATH, VCR_RAIL_STEPS, VCR_STEP_TABS, VCR_TAB_ITEMS, vcrTabPath } from "@/components/vcr/vcrTabs";

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

/** What the page holds, and for which study: an answer for another id is not this page's. */
type Loaded =
  | { kind: "loading" }
  | { kind: "off"; id: string }
  | { kind: "missing"; id: string }
  | { kind: "error"; id: string; message: string }
  | { kind: "ready"; id: string; study: VcrStudy };

/** The job states the 「运行」 strip shows: what is going on now, and what did not finish. */
const LIVE_JOB_STATES: ReadonlySet<VcrJob["state"]> = new Set(["queued", "running", "awaiting_budget", "failed"]);

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
 *
 * Hidden knowledge:
 *  - **An answer belongs to the id it was asked for.** Moving from one study
 *    to another shows the skeleton, never the previous study's header under
 *    the new address.
 *  - **Each tab is behind its own boundary** (contract §5): a tab that cannot
 *    read its payload shows an error card inside the tab, and the header, the
 *    rail and the other six tabs stay.
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
      <PageShell title="虚拟临研" width="wide">
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
      <PageShell title="虚拟临研" width="wide">
        {shown.kind === "error" ? <LoadError message={shown.message} onRetry={reload} /> : <VcrStudySkeleton />}
      </PageShell>
    );
  }
  // Keyed by the study: the menu's dialogs and the run guard never outlive it.
  return <StudyView key={studyId} studyId={studyId} study={shown.study} tab={tab} reload={reload} />;
}

function StudyView({ studyId, study, tab, reload }: { studyId: string; study: VcrStudy; tab: VcrTabKey; reload: () => void }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const openConversation = useOpenVcrConversation();
  const { run, busy: running } = useVcrRun(study);
  const [opening, setOpening] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [changingStatus, setChangingStatus] = useState(false);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const packageId = params.get("package");
  const Tab = TABS[tab];
  // What this reader may do here, from the roles the server says they hold:
  // the menu offers only the actions that will not be refused (the routes check
  // for themselves, per operation — this is presentation).
  const can = (ability: string) => study.abilities.includes(ability);

  const exportAs = (kind: VcrExportKind, failure: string) => {
    // A deferred export stays on the page with its sentence; the overview's
    // deliverables are re-read so the queued package is listed.
    void run(() => exportVcrStudy(studyId, kind), failure, reload);
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
    ...(can("export") ? [
      { label: "导出研究包", disabled: running, onSelect: () => exportAs("study_package", "研究包暂时无法导出，请稍后重试。") },
      { label: "导出 CDE 沟通交流资料包", disabled: running, onSelect: () => exportAs("cde_communication_pack", "资料包暂时无法导出，请稍后重试。") },
      { label: `导出${VCR_EXPORT_KIND_LABELS_ZH.simulation_report}`, disabled: running, onSelect: () => exportAs("simulation_report", "模拟报告暂时无法导出，请稍后重试。") },
      { label: `导出${VCR_EXPORT_KIND_LABELS_ZH.validation_pack}`, disabled: running, onSelect: () => exportAs("validation_pack", "系统验证文档包暂时无法导出，请稍后重试。") },
    ] : []),
    // The compute budget, the study's status and its deletion are the lead's
    // (`manage_study`): the second human stop is confirmed by the person who
    // signs the study off, not by whoever queued the compute.
    ...(can("manage_study") ? [{ label: "设定计算预算", onSelect: () => setBudgetOpen(true) }] : []),
    ...(can("manage_members") ? [{ label: "成员与角色", onSelect: () => setMembersOpen(true) }] : []),
    ...(can("manage_study") ? [
      { label: paused ? "继续" : "暂停", disabled: changingStatus, onSelect: setStatus },
      "separator" as const,
      { label: "删除", destructive: true, onSelect: () => setConfirmDelete(true) },
    ] : []),
  ];

  const remove = () => {
    if (deleting) return;
    setDeleting(true);
    void deleteVcrStudy(studyId)
      .then(() => {
        toast.success("研究已从虚拟临研移除。");
        navigate(VCR_HOME_PATH, { replace: true });
      })
      .catch((error: unknown) => {
        toast.error(webErrorMessage(error, { fallback: "研究无法删除，请稍后重试。" }));
        setDeleting(false);
        setConfirmDelete(false);
      });
  };

  const openStudyConversation = () => {
    if (opening) return;
    setOpening(true);
    void openConversation({ projectId: study.projectId, sessionId: study.sessionId })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "对话暂时无法打开，请稍后重试。" })))
      .finally(() => setOpening(false));
  };

  return (
    <PageShell
      title={study.name}
      width="wide"
      meta={<StudyTags tier={study.tier} intendedUse={study.intendedUse} ceiling={study.ceiling} />}
      actions={(
        <>
          <Button variant="secondary" loading={opening} onClick={openStudyConversation}>
            <MessageSquare size={16} aria-hidden="true" />
            对话
          </Button>
          {menu.length > 0 && (
            <Menu label="更多操作" items={menu}>
              <IconButton icon={MoreHorizontal} label="更多操作" className="data-[state=open]:bg-surface-2 data-[state=open]:text-text" />
            </Menu>
          )}
        </>
      )}
    >
      <ProgressRail label="七步进度" steps={railSteps(study, studyId)} className="mb-6" />

      <JobStrip studyId={studyId} study={study} onBudget={() => setBudgetOpen(true)} onChanged={reload} />

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
            <VcrTabBoundary key={tab}>
              <Tab studyId={studyId} study={study} />
            </VcrTabBoundary>
          </div>
        </>
      )}

      {membersOpen && <VcrMembersDialog studyId={studyId} onClose={() => setMembersOpen(false)} />}

      {budgetOpen && (
        <VcrBudgetDialog
          studyId={studyId}
          budget={study.budget}
          jobs={study.jobs}
          onClose={() => setBudgetOpen(false)}
          onSaved={() => { setBudgetOpen(false); reload(); }}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={`删除“${study.name}”？`}
          body="研究会从虚拟临研移除；项目里的对话和文件仍在。"
          confirmLabel="删除"
          busy={deleting}
          onConfirm={remove}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </PageShell>
  );
}

/**
 * 「运行」: the computations queued, running, waiting on a budget confirmation
 * or not finished (plan §3.6 — the run state is one of the three, and is said
 * apart from the conclusion and the review).
 *
 * The line above the jobs is the second human stop made visible: a job past
 * the budget waits for the lead, and the page says so where the lead is
 * looking rather than only in the header's menu.
 */
function JobStrip({ studyId, study, onBudget, onChanged }: {
  studyId: string;
  study: VcrStudy;
  onBudget: () => void;
  onChanged: () => void;
}) {
  const [canceling, setCanceling] = useState<string | null>(null);
  const jobs = study.jobs.filter((job) => LIVE_JOB_STATES.has(job.state));
  const waiting = jobsAwaitingBudget(study.jobs);
  const awaiting = study.budget?.awaitingBudget ?? 0;
  if (jobs.length === 0 && awaiting <= 0) return null;
  const mayCancel = study.abilities.includes("run");

  const cancel = (job: VcrJob) => {
    if (canceling !== null) return;
    setCanceling(job.id);
    void cancelVcrJob(studyId, job.id)
      .then(() => { toast.success("已取消。"); onChanged(); })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "这项计算暂时无法取消，请稍后重试。" })))
      .finally(() => setCanceling(null));
  };

  return (
    <section data-vcr-jobs="" aria-labelledby="vcr-jobs-title" className="mb-6 rounded-card border border-border bg-surface px-4 py-3">
      <h2 id="vcr-jobs-title" className="text-caption text-text-3">运行</h2>
      {awaiting > 0 && (
        <p data-vcr-budget-wait="" className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-ui text-warn-strong">
          <span className="min-w-0 flex-1">
            {`有 ${numberText(awaiting, 0)} 项计算等待预算确认${waiting.seconds > 0 ? ` · 需 ${cpuTimeText(waiting.seconds)} CPU 时间` : ""}`}
          </span>
          {/* Confirming is the lead's; anyone else sees the line and not a button that would be refused. */}
          {study.abilities.includes("manage_study") && <Button size="sm" onClick={onBudget}>确认预算</Button>}
        </p>
      )}
      {jobs.length > 0 && (
        <ul className="mt-1 divide-y divide-faint">
          {jobs.map((job) => (
            <li key={job.id} data-vcr-job={job.id} data-vcr-job-state={job.state} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <span className="min-w-0 flex-1 truncate text-ui text-text">{job.label}</span>
              {job.progress && job.progress.total > 0 && (
                <span className="text-caption tabular-nums text-text-3">{`${numberText(job.progress.done, 0)} / ${numberText(job.progress.total, 0)}`}</span>
              )}
              <span className={cn("text-caption", job.state === "failed" ? "text-danger-strong" : job.state === "awaiting_budget" ? "text-warn-strong" : "text-text-3")}>
                {jobStateLabel(job.state)}
              </span>
              {job.state === "failed" && job.error?.message && (
                <span className="w-full text-caption text-text-2">{job.error.message}</span>
              )}
              {job.cancelable && mayCancel && (
                <Button size="sm" variant="text" loading={canceling === job.id} disabled={canceling !== null} onClick={() => cancel(job)}>
                  取消
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
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
