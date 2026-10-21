import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { ChevronLeft, MessageSquare, MoreHorizontal } from "lucide-react";
import { vcrCalculationPath } from "@/lib/vcrMethodLocation";
import { toast } from "@/lib/toast";
import { webErrorMessage } from "@/lib/apiClient";
import { cancelVcrStudy, runVcrStep, type VcrStudy, type VcrTabKey } from "@/lib/vcrClient";
import { PageShell } from "@/components/layout/PageShell";
import type { ActivityStripProps } from "@/components/ui/ActivityStrip";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { IconButton } from "@/components/ui/IconButton";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import type { ToolbarProps } from "@/components/ui/Toolbar";
import { Tooltip } from "@/components/ui/Tooltip";
import { StudyFrameContext, type StudyFrameApi, type StudyPanelKey, type StudyPrimary } from "./studyFrameContext";
import { useVcrRun } from "./useVcrRun";
import { budgetWaitOf } from "./VcrBudgetDialog";
import { leadJob, isMoving, jobLabel, runDetailLine, stepAction, studyVersion, waitingSentence } from "./vcrActivity";
import { stepsOfTab, vcrWorkflowSteps, VCR_HOME_PATH, VCR_TAB_ITEMS } from "./vcrTabs";
import { intendedUseLabel, tierLabel } from "./vcrText";

/** The one view of a study that is not a tab: its conversation. */
export type StudyView = VcrTabKey | "chat";

/** The addressed result region, independent of the workflow rail and View selector. */
export const STUDY_PANEL_ID = "vcr-tab-panel";

/**
 * Shared study chrome for results and its canonical native conversation. The seven actual steps remain visible; one View selector
 * opens result workspaces, and each workspace contributes its contextual controls to the same toolbar. Calculations retain only
 * contextual result navigation. The runtime pane and composer are owned by the resident native frame.
 */
export interface StudyFrameProps {
  studyId: string;
  study: VcrStudy;
  view: StudyView;
  /** Read the study again now. */
  reload: () => void;
  /** The header's 「⋯」: the page owns what each entry opens. */
  menu: readonly MenuEntry[];
  /** The way into the conversation, with a draft waiting in its composer. Navigation inside the page. */
  onChat: (draft?: string) => void;
  /** Opens one of the page's panels (the menu's records and dialogs) for a tab that asks. */
  onPanel: (panel: StudyPanelKey) => void;
  /** Opens the study's own address for a tab. */
  onView: (view: StudyView) => void;
  children: ReactNode;
  onMethods?: () => void;
  methodsOpen?: boolean;
}

/**
 * The strip's facts, from `activity`: the run that is out (its person's sentence, what phase it is in, what it has counted, for how
 * long), else the engine job that moves (its done of total), else the step in line and what it waits for. Null when nothing is.
 * Each has 取消 for a reader who may run a step.
 */
export function activityStripOf(study: VcrStudy, handlers: { onCancel?: () => void; cancelling?: boolean }): ActivityStripProps | null {
  const activity = study.activity;
  if (!activity) return null;
  const cancel = { onCancel: handlers.onCancel, cancelling: handlers.cancelling };
  const open = activity.queue.length;
  if (activity.run) {
    const detail = runDetailLine(activity.run);
    return { label: activity.run.label || "推进研究", phase: detail || undefined, startedAt: activity.run.startedAt, queued: open || undefined, ...cancel };
  }
  const job = leadJob(activity);
  if (job) {
    const stalled = study.jobs.find((entry) => entry.id === job.id)?.waitingOn === "engine";
    const others = activity.jobs.filter((entry) => entry.id !== job.id && entry.state !== "awaiting_budget").length + open;
    return {
      label: jobLabel(job, study),
      ...(stalled ? { waiting: waitingSentence(null, true) } : {}),
      ...(job.done !== null && job.total ? { phase: "计算", counts: { done: job.done, total: job.total } } : {}),
      queued: others || undefined,
      ...cancel,
    };
  }
  // A step in line with nothing out yet (behind the conversation's own turn, or for its tick) can be stopped too: the cancel holds the
  // programme, so what is waiting is not taken up when its turn comes.
  const first = activity.queue[0];
  if (first) return { label: stepAction(first.step), waiting: waitingSentence(first.waitingFor), queued: open - 1 || undefined, ...cancel };
  return null;
}

export function StudyFrame({ studyId, study, view, reload, menu, onChat, onPanel, onView, children, onMethods, methodsOpen }: StudyFrameProps) {
  const { run, busy } = useVcrRun(study, { refresh: reload });
  const [toolbar, setToolbar] = useState<ToolbarProps | null | undefined>(undefined);
  const [tabPrimary, setTabPrimary] = useState<StudyPrimary | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [params] = useSearchParams();
  const programme = study.purpose !== "calculation";
  const mayRun = study.abilities.includes("run");
  const moving = isMoving(study.activity);
  const next = study.next;

  const cancel = useCallback(() => {
    if (cancelling) return;
    setCancelling(true);
    void cancelVcrStudy(studyId)
      .then(() => reload())
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "暂时无法取消，请稍后重试。" })))
      .finally(() => setCancelling(false));
  }, [cancelling, reload, studyId]);

  const api = useMemo<StudyFrameApi>(() => ({
    studyId,
    version: studyVersion(study),
    activity: study.activity,
    refresh: reload,
    openChat: onChat,
    openPanel: onPanel,
    setToolbar,
    setPrimary: setTabPrimary,
  }), [studyId, study, reload, onChat, onPanel]);

  // The primary action: the next step, in the header of every tab. While work goes on the strip under the header is what is said
  // and there is nothing to press for another step — it could only queue behind this one.
  const waitingBudget = study.abilities.includes("manage_study") && budgetWaitOf(study).count > 0;
  const budgetButton = waitingBudget ? <Button onClick={() => onPanel("budget")}>确认预算</Button> : null;
  // The open tab's own primary (选定方案 on 试验) takes the header's primary look unless the budget waits, which lets the study go on and
  // outranks it; either way the next step is the quiet one beside it, and the header never holds two solid buttons.
  const tabButton = tabPrimary ? <Button variant={waitingBudget ? "secondary" : "primary"} onClick={tabPrimary.onSelect}>{tabPrimary.label}</Button> : null;
  const primaryTaken = waitingBudget || tabPrimary !== null;
  const nextButton = programme && study.status !== "draft" && next && mayRun && !moving ? (() => {
    const button = (
      <Button variant={primaryTaken ? "secondary" : "primary"} loading={busy} onClick={() => run(() => runVcrStep(studyId, next.step), "这一步无法开始，请稍后重试。")}>
        {`${next.reason === "retry" ? "接着做" : next.reason === "refresh" ? "重新做" : "下一步"}：${next.label}`}
      </Button>
    );
    // Why it is the next one, when it is not simply the next: the step was not finished, or what it rests on changed.
    return next.reasonText ? <Tooltip content={next.reasonText}>{button}</Tooltip> : button;
  })() : null;
  const strip = activityStripOf(study, { onCancel: mayRun ? cancel : undefined, cancelling });
  // The domain steps remain visible in conversation; result views use one contextual selector.
  const steps = useMemo(() => vcrWorkflowSteps(study), [study]);
  const selectedStep = params.get("step") ?? (view === "chat" ? study.activity?.run?.step ?? study.next?.step : stepsOfTab(view)[0]);
  const controls = view === "chat" ? undefined : toolbar;
  const bandToolbar: ToolbarProps = {
    ...(controls ?? {}), views: undefined,
    actions: <>{controls?.actions}{view !== "chat" && onMethods && <Button variant="text" size="sm" onClick={onMethods}>{methodsOpen ? "返回本步结果" : "选择方法"}</Button>}</>,
    filters: [{ kind: "select", label: "查看", value: view, pinned: true,
      options: [...(programme || study.conversation.sessionId ? [{ value: "chat", label: "对话" }] : []), ...(programme ? VCR_TAB_ITEMS : VCR_TAB_ITEMS.filter(item => ["overview", "data", "population", "matching"].includes(item.key))).map(item => ({ value: item.key, label: item.label }))],
      onChange: next => { if (next) onView(next as StudyView); } },
      ...(controls?.views ? [{ kind: "select" as const, label: controls.views.label, value: controls.views.value, options: controls.views.items.map(item => ({ value: item.value, label: item.label })), onChange: (next: string | null) => { if (next) controls.views?.onChange(next); } }] : []),
      ...(controls?.filters ?? [])],
  };

  return (
    <StudyFrameContext.Provider value={api}>
      <PageShell<StudyView>
        title={study.name}
        width="wide"
        back={(
          // No left padding: the link's own box starts on the page's one left edge.
          <Link to={programme ? VCR_HOME_PATH : vcrCalculationPath(studyId)} className={buttonClasses({ variant: "text", size: "sm", className: "pl-0" })}>
            <ChevronLeft size={16} aria-hidden="true" />{programme ? "虚拟临床研究" : "独立计算"}
          </Link>
        )}
        meta={programme ? <StudyMeta study={study} /> : "独立计算"}
        actions={(
          <>
            {budgetButton}
            {tabButton}
            {nextButton}
            {view !== "chat" && (programme || study.conversation.sessionId) && <Button variant="secondary" onClick={() => onChat()}>
              <MessageSquare size={16} aria-hidden="true" />
              对话
            </Button>}
            <Menu label="更多操作" items={[...menu]}>
              <IconButton icon={MoreHorizontal} label="更多操作" className="data-[state=open]:bg-surface-2 data-[state=open]:text-text" />
            </Menu>
          </>
        )}
        steps={programme ? { label: "研究进度", steps, activeSteps: selectedStep ? [selectedStep] : [], visible: true, showState: true } : undefined}
        {...(strip ? { activity: strip } : {})}
        toolbar={bandToolbar}
        contentClassName={view === "chat" ? "mt-3" : undefined}
      >
        {view === "chat" ? children : <div id={STUDY_PANEL_ID} role="region" aria-label="研究内容">{children}</div>}
      </PageShell>
    </StudyFrameContext.Provider>
  );
}

/**
 * What the header says of the study beside its name: the data tier — and, when the results cannot carry the use it asked for, both
 * (「指定研究分析 → 研究设计支持」), a button that opens the reasons. Plain text and a text button: a tag is a label, never a control.
 */
function StudyMeta({ study }: { study: Pick<VcrStudy, "tier" | "ceiling"> }) {
  const [open, setOpen] = useState(false);
  const downgraded = study.ceiling && !study.ceiling.withinCeiling ? study.ceiling : null;
  return (
    <>
      <span>{tierLabel(study.tier)}</span>
      {downgraded && (
        <Button
          variant="text"
          size="sm"
          data-vcr-ceiling="downgraded"
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
          className="ml-3 text-warn-strong"
        >
          {`${intendedUseLabel(downgraded.requested)} → ${intendedUseLabel(downgraded.ceiling)}`}
        </Button>
      )}
      {open && downgraded && (
        <Drawer title="预期用途" onClose={() => setOpen(false)} widthClassName="max-w-md">
          <dl data-vcr-ceiling-reasons="" className="divide-y divide-faint">
            <div className="flex items-baseline justify-between gap-4 py-2">
              <dt className="text-caption text-text-3">研究设定的用途</dt>
              <dd className="text-ui text-text">{intendedUseLabel(downgraded.requested)}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 py-2">
              <dt className="text-caption text-text-3">结果能承载的最高用途</dt>
              <dd className="text-ui text-text">{intendedUseLabel(downgraded.ceiling)}</dd>
            </div>
          </dl>
          {downgraded.reasons.length > 0 && (
            <ul className="mt-4 flex list-disc flex-col gap-1.5 pl-4 text-ui text-text-2">
              {downgraded.reasons.map((reason) => <li key={`${reason.code}:${reason.detail}`}>{reason.detail}</li>)}
            </ul>
          )}
        </Drawer>
      )}
    </>
  );
}
