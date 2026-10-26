import { useState } from "react";
import type { AgendaRecord } from "@/lib/autopilotClient";
import { EvolutionOpportunities } from "@/components/evolution/EvolutionOpportunities";
import { FormDialog } from "@/components/ui/FormDialog";
import { List, ListRow } from "@/components/ui/ListRow";
import { TaskForm } from "./TaskForm";
import { RECOMMENDATIONS, type Recommendation } from "./taskPresentation";

/**
 * 「新建」 and 「编辑」: a short dialog — what to keep doing, and how often.
 *
 * Under a new task's form, 「从推荐开始」: the six templates and, where the evolution module is on, the platform's research
 * opportunities. They are starting points and not tasks: a template fills the form above it (nothing is created until the
 * researcher saves), an opportunity is adopted into a task of its own and the dialog closes on it. None of them is a row of the
 * task list, which holds the researcher's tasks and nothing else.
 */
export function TaskDialog({ projectId, available = true, agenda, recommendation: initialRecommendation, showBudgets, saving, onBusyChange, onClose, onRecorded, onSaved, onAdopted }: {
  projectId: string;
  available?: boolean;
  /** The task being edited; none for a new one. */
  agenda?: AgendaRecord;
  recommendation?: Recommendation;
  showBudgets: boolean;
  saving: boolean;
  onBusyChange: (busy: boolean) => void;
  onClose: () => void;
  onRecorded: (record: AgendaRecord) => void;
  onSaved: (record: AgendaRecord) => void;
  /** An opportunity was adopted: the id of the task it became. */
  onAdopted: (id: string) => void;
}) {
  const [recommendation, setRecommendation] = useState<Recommendation | undefined>(initialRecommendation);
  const [recorded, setRecorded] = useState(false);
  const [adopting, setAdopting] = useState(false);
  const busy = saving || adopting;
  const locked = busy || recorded || !available;
  return <FormDialog title={agenda ? "编辑任务" : "新建任务"} busy={busy} onClose={() => { if (!busy) onClose(); }}>
    {/* A template replaces the form's content, so the form is made again for it. */}
    <TaskForm key={recommendation?.title ?? "blank"} projectId={projectId} agenda={agenda} recommendation={recommendation} showBudgets={showBudgets} schedulingAvailable={available} disabled={adopting}
      onRecorded={record => { setRecorded(true); onRecorded(record); }} onBusyChange={onBusyChange} onCancel={onClose} onSaved={onSaved} />
    {!agenda && <fieldset disabled={locked} className="min-w-0"><section aria-label="从推荐开始" className="mt-6 space-y-3 border-t border-border pt-4">
      <h3 className="text-ui font-semibold text-text">从推荐开始</h3>
      <List divided>{RECOMMENDATIONS.map(item => <ListRow key={item.title} title={item.title} meta={<span className="line-clamp-1">{item.prompt}</span>} onOpen={() => { if (!locked) setRecommendation(item); }} />)}</List>
      <EvolutionOpportunities projectId={projectId} onAdopted={onAdopted} onBusyChange={value => { setAdopting(value); onBusyChange(value); }} />
    </section></fieldset>}
  </FormDialog>;
}
