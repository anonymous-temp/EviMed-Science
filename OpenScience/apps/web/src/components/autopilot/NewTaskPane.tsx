import { useEffect, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { Link } from "react-router";
import type { AgendaRecord } from "@/lib/autopilotClient";
import { useUnsavedGuard } from "@/lib/useUnsavedGuard";
import { EvolutionOpportunities } from "@/components/evolution/EvolutionOpportunities";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PageHeader } from "@/components/layout/PageHeader";
import { TaskForm } from "./TaskForm";
import { RECOMMENDATIONS, type Recommendation } from "./taskPresentation";

/** What a scheduled task is, said where there is none yet: the work, and where the result is. */
export const FIRST_RUN_SENTENCE = "按你定的时间，让 EviMed 自己去做一件事，比如每天一份行业要闻、每周一份工作汇总，结果留在这里。";

/** What the page needs to know of the form it holds beside the list: whether it has an edit to lose, and whether nothing may replace it now. */
export interface NewTaskDraft { dirty: boolean; locked: boolean }

/**
 * 「新建定时任务」: the main area of the page while a task is being made — what to keep doing, and how often — beside the list of the
 * tasks, as the list's own pane (`/app/autopilot/new`; with no task at all, the bare address). It is the form the dialog was, inline:
 * the same fields, 「创建并启用」 and 「取消」, and nothing is created until the researcher presses it.
 *
 * The starting points are the page's `examples`: in the list column while the project has no task (`TaskExamples`), and as the
 * buttons over the form once the column holds tasks (`examples`). Where the evolution module is on, the platform's research
 * opportunities follow the form: an opportunity is adopted into a task of its own and the page moves to it. A form with an edit
 * asks 「放弃未保存的修改？」 before 取消 and, through the shell's route guard, before the researcher leaves the page; the page asks
 * the same before an example replaces it (`onDraftChange`).
 *
 * Beside the list the heading is the pane's own; where the form is the whole page (`backTo`), it is the page's standard header with the
 * way back over it, as a task's is (`TaskBar`).
 */
export function NewTaskPane({ projectId, available = true, recommendation, intro = false, examples = false, backTo, onChooseExample, onCancel, onDraftChange, onRecorded, onSaved, onAdopted }: {
  projectId: string;
  available?: boolean;
  /** The example the form starts from. */
  recommendation?: Recommendation;
  /** First use: one sentence under the heading saying what a scheduled task is. */
  intro?: boolean;
  /** The examples as buttons over the form, for a page whose list column holds tasks. */
  examples?: boolean;
  /** The list this page came from, when the list is not beside it. */
  backTo?: string;
  onChooseExample: (item: Recommendation) => void;
  /** Where 取消 goes; no 取消 where there is nowhere to go back to. */
  onCancel?: () => void;
  onDraftChange: (draft: NewTaskDraft) => void;
  onRecorded: (record: AgendaRecord) => void;
  onSaved: (record: AgendaRecord) => void;
  /** An opportunity was adopted: the id of the task it became. */
  onAdopted: (id: string) => void;
}) {
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [recorded, setRecorded] = useState(false);
  const [adopting, setAdopting] = useState(false);
  const locked = saving || adopting || recorded;
  const guard = useUnsavedGuard(dirty, () => onCancel?.(), saving || adopting);
  useEffect(() => { onDraftChange({ dirty, locked }); }, [dirty, locked, onDraftChange]);
  useEffect(() => () => onDraftChange({ dirty: false, locked: false }), [onDraftChange]);
  const heading = "新建定时任务";
  return <div className="flex min-h-0 flex-1 flex-col" data-task-new="">
    {backTo
      ? <div className="shrink-0 border-b border-border px-6 py-3">
        <Link to={backTo} className="-ml-1 mb-1 inline-flex items-center gap-0.5 text-caption text-text-3 hover:text-text"><ChevronLeft size={16} aria-hidden="true" />定时任务</Link>
        <PageHeader title={heading} documentTitle={false} />
        {intro && <p className="mt-1 text-caption text-text-3">{FIRST_RUN_SENTENCE}</p>}
      </div>
      : <header className="shrink-0 border-b border-border px-6 py-3">
        <h2 className="truncate text-section font-semibold text-text">{heading}</h2>
        {intro && <p className="mt-0.5 text-caption text-text-3">{FIRST_RUN_SENTENCE}</p>}
      </header>}
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="w-full max-w-measure space-y-6 px-6 py-6">
        {examples && <section aria-label="从示例开始" className="space-y-2">
          <h2 className="text-caption text-text-3">从示例开始</h2>
          <fieldset disabled={locked} className="min-w-0">
            <div className="flex flex-wrap gap-2">{RECOMMENDATIONS.map(item => <Button key={item.id} variant="secondary" size="sm" onClick={() => onChooseExample(item)}>{item.title}</Button>)}</div>
          </fieldset>
        </section>}
        <TaskForm projectId={projectId} recommendation={recommendation} showBudgets={false} schedulingAvailable={available} disabled={adopting}
          onRecorded={record => { guard.markSaved(); setRecorded(true); onRecorded(record); }} onBusyChange={setSaving} onDirtyChange={setDirty}
          onCancel={onCancel ? guard.requestClose : undefined} onSaved={record => { guard.markSaved(); onSaved(record); }} />
        <fieldset disabled={locked || !available} className="-mx-2 min-w-0">
          <EvolutionOpportunities projectId={projectId} onAdopted={onAdopted} onBusyChange={setAdopting} />
        </fieldset>
      </div>
    </div>
    {guard.confirming && <ConfirmDialog title="放弃未保存的修改？" subject={heading} consequences="未保存的修改将丢失。" recovery="返回编辑可继续保留修改。" confirmLabel="放弃修改"
      onConfirm={guard.discard} onCancel={guard.keepEditing} />}
  </div>;
}
