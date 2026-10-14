import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ChevronLeft, MessageSquare, MoreHorizontal } from "lucide-react";
import { VCR_NEXT_REASON_LABELS_ZH } from "@evimed/domain";
import { toast } from "@/lib/toast";
import { webErrorMessage } from "@/lib/apiClient";
import { cancelVcrStudy, runVcrStep, type VcrStudy, type VcrTabKey } from "@/lib/vcrClient";
import { PageShell } from "@/components/layout/PageShell";
import type { ActivityStripProps } from "@/components/ui/ActivityStrip";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { IconButton } from "@/components/ui/IconButton";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { DOT_WORDS, type TabItem } from "@/components/ui/Tabs";
import type { ToolbarProps } from "@/components/ui/Toolbar";
import { Tooltip } from "@/components/ui/Tooltip";
import { StudyFrameContext, type StudyFrameApi, type StudyPanelKey } from "./studyFrameContext";
import { useVcrRun } from "./useVcrRun";
import { leadJob, isMoving, jobLabel, phaseWord, runCountsLine, stepAction, studyVersion, waitingSentence } from "./vcrActivity";
import { stepsOfTab, tabDot, VCR_HOME_PATH, VCR_TAB_ITEMS } from "./vcrTabs";
import { intendedUseLabel, tierLabel } from "./vcrText";

/** The one view of a study that is not a tab: its conversation. */
export type StudyView = VcrTabKey | "chat";

/** The tab panel's id: the body is the open tab's panel (`PageShell`'s `tabs.panelId`). */
export const STUDY_PANEL_ID = "vcr-tab-panel";

/**
 * A study's page: the header, the one fixed band over the tabs, and the body of the view that is open (R19, plan §5.3; audit B §4.1–§4.2,
 * D §3.3). One component for the seven tabs and the conversation, so that **what is above the body is the same on every one of them**.
 *
 * ```
 * ‹ 虚拟临床研究
 * EV-201 二线 NSCLC…   T0 公开资料                 [下一步：生成虚拟患者] [对话] [⋯]     ← the header scrolls away
 * ┌ band, sticky ──────────────────────────────────────────────────────────────────────┐
 * │ ● 正在生成虚拟患者 · 检索 6 次 · 2 分钟        另有 1 项排队                    取消    │  only while work goes on
 * │ 总览  ● 定义与证据 4 张假设卡  ● 人群 3,412 名  ◐ 虚拟患者 2,000 名  ○ 对照  ○ 试验  ○ 匹配 │  the tabs are the step bar
 * │ (the tab's one row of controls — drawn by `useVcrToolbar`, reserved when it has none)  │
 * └────────────────────────────────────────────────────────────────────────────────────┘
 * body: the tab, or the conversation
 * ```
 *
 * Hidden knowledge:
 *  - **The tab row is the step bar.** A study's seven steps and its seven tabs are the same things (定义 and 证据 share 定义与证据),
 *    so there is no second rail: each tab wears the state of its step as a dot — with the state in words as its tooltip and for a
 *    screen reader — and the server's one finding with its one number (`stepSummaries`). It is in the sticky band, so switching
 *    tabs never loses where the study is, and its height is the same on every tab.
 *  - **The primary action is the server's `next`** and is in the header on every tab, not only on the overview. While work is going
 *    on it is not drawn: the strip under the header says what is happening, with 取消 — a second button for the next step beside it
 *    could only queue another.
 *  - **「对话」 is a view, not a place.** It opens `/app/virtual-research/:studyId/chat` — this page, with the band still above it.
 *    It is not a tab (it is not one of the domain's `VCR_TABS`), so with it open no tab is selected.
 *  - **The tab's controls are the band's.** A tab calls `useVcrToolbar`; the frame draws that in the `toolbar` slot, or reserves the
 *    row empty (`toolbar={null}`), and draws nothing in the conversation, which has no tab-level controls.
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
}

/** The sentence a tab's dot has as its tooltip: the state in words, and why when it needs the reader. */
function tabHint(study: VcrStudy, tab: VcrTabKey): string | undefined {
  const dot = tabDot(study, tab);
  if (!dot) return undefined;
  const steps = stepsOfTab(tab);
  const records = steps.map((step) => study.steps[step]);
  const run = study.activity?.run;
  const reason = dot === "attention"
    ? records.some((record) => record?.status === "failed") ? VCR_NEXT_REASON_LABELS_ZH.retry
      : records.some((record) => record?.status === "stale") ? VCR_NEXT_REASON_LABELS_ZH.refresh : waitingSentence("allowance")
    : dot === "active" ? (run && run.steps.some((step) => steps.includes(step)) ? run.label : steps.map(stepAction).find(Boolean) ?? "") : "";
  return reason ? `${DOT_WORDS[dot]}：${reason}` : DOT_WORDS[dot];
}

/** The tab row: each stage's dot and name, its one finding, and what that dot means. */
function tabItems(study: VcrStudy): TabItem<StudyView>[] {
  return VCR_TAB_ITEMS.map((item) => {
    const steps = stepsOfTab(item.key);
    // 定义与证据 says what its evidence found; a bare 「v1」 is no finding.
    const summary = item.key === "data" ? study.stepSummaries.evidence : steps.length ? study.stepSummaries[steps[0]] : undefined;
    return {
      value: item.key,
      label: item.label,
      ...(tabDot(study, item.key) ? { dot: tabDot(study, item.key) } : {}),
      ...(summary?.note ? { note: summary.note } : {}),
      ...(tabHint(study, item.key) ? { hint: tabHint(study, item.key) } : {}),
    };
  });
}

/**
 * The strip's facts, from `activity`: the run that is out (its person's sentence, what phase it is in, what it has counted, for how
 * long), else the engine job that moves (its done of total), else the step in line and what it waits for. Null when nothing is.
 */
export function activityStripOf(study: VcrStudy, handlers: { onCancel?: () => void; cancelling?: boolean }): ActivityStripProps | null {
  const activity = study.activity;
  if (!activity) return null;
  const cancel = { onCancel: handlers.onCancel, cancelling: handlers.cancelling };
  const open = activity.queue.length;
  if (activity.run) {
    const detail = [phaseWord(activity.run.phase), runCountsLine(activity.run.counts)].filter(Boolean).join(" · ");
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
  const first = activity.queue[0];
  if (first) return { label: stepAction(first.step), waiting: waitingSentence(first.waitingFor), queued: open - 1 || undefined };
  return null;
}

export function StudyFrame({ studyId, study, view, reload, menu, onChat, onPanel, onView, children }: StudyFrameProps) {
  const { run, busy } = useVcrRun(study, { refresh: reload });
  const [toolbar, setToolbar] = useState<ToolbarProps | null | undefined>(undefined);
  const [cancelling, setCancelling] = useState(false);
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
  }), [studyId, study, reload, onChat, onPanel]);

  // The primary action: the next step, in the header of every tab. While work goes on the strip under the header is what is said
  // and there is nothing to press for another step — it could only queue behind this one.
  const nextButton = next && mayRun && !moving ? (() => {
    const button = (
      <Button loading={busy} onClick={() => run(() => runVcrStep(studyId, next.step), "这一步无法开始，请稍后重试。")}>
        {`${next.reason === "retry" ? "接着做" : next.reason === "refresh" ? "重新做" : "下一步"}：${next.label}`}
      </Button>
    );
    // Why it is the next one, when it is not simply the next: the step was not finished, or what it rests on changed.
    return next.reasonText ? <Tooltip content={next.reasonText}>{button}</Tooltip> : button;
  })() : null;
  const strip = activityStripOf(study, { onCancel: mayRun ? cancel : undefined, cancelling });
  // The step bar: no percentage and no second row. In the conversation view none of the tabs is the open one.
  const items = useMemo(() => tabItems(study), [study]);

  return (
    <StudyFrameContext.Provider value={api}>
      <PageShell<StudyView>
        title={study.name}
        width="wide"
        back={(
          // No left padding: the link's own box starts on the page's one left edge.
          <Link to={VCR_HOME_PATH} className={buttonClasses({ variant: "text", size: "sm", className: "pl-0" })}>
            <ChevronLeft size={16} aria-hidden="true" />虚拟临床研究
          </Link>
        )}
        meta={<StudyMeta study={study} />}
        actions={(
          <>
            {nextButton}
            <Button variant="secondary" aria-pressed={view === "chat"} onClick={() => { if (view !== "chat") onChat(); }}>
              <MessageSquare size={16} aria-hidden="true" />
              对话
            </Button>
            <Menu label="更多操作" items={[...menu]}>
              <IconButton icon={MoreHorizontal} label="更多操作" className="data-[state=open]:bg-surface-2 data-[state=open]:text-text" />
            </Menu>
          </>
        )}
        tabs={{ label: "研究视图", items, value: view, onChange: onView, panelId: view === "chat" ? undefined : STUDY_PANEL_ID }}
        {...(strip ? { activity: strip } : {})}
        toolbar={view === "chat" ? undefined : (toolbar ?? null)}
        contentClassName={view === "chat" ? "mt-3" : undefined}
      >
        {children}
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
        <button
          type="button"
          data-vcr-ceiling="downgraded"
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
          className="ml-3 rounded text-caption text-warn-strong hover:underline"
        >
          {`${intendedUseLabel(downgraded.requested)} → ${intendedUseLabel(downgraded.ceiling)}`}
        </button>
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
              <dd className="text-ui font-medium text-text">{intendedUseLabel(downgraded.ceiling)}</dd>
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
