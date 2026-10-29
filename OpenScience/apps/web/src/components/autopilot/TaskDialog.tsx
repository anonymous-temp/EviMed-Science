import { useState } from "react";
import type { AgendaRecord } from "@/lib/autopilotClient";
import { FormDialog } from "@/components/ui/FormDialog";
import { TaskForm } from "./TaskForm";

/**
 * 「编辑任务」: a short dialog over the page — what to keep doing, and how often — for a task that is already there. Making a task is
 * the page's own main area (`NewTaskPane`, `/app/autopilot/new`), not a dialog: the dialog it began as kept its templates and the
 * platform's research opportunities under the form, and they went with the creation.
 */
export function TaskDialog({ projectId, available = true, agenda, showBudgets, saving, onBusyChange, onClose, onRecorded, onSaved }: {
  projectId: string;
  available?: boolean;
  /** The task being edited. */
  agenda: AgendaRecord;
  showBudgets: boolean;
  saving: boolean;
  onBusyChange: (busy: boolean) => void;
  onClose: () => void;
  onRecorded: (record: AgendaRecord) => void;
  onSaved: (record: AgendaRecord) => void;
}) {
  const [dirty, setDirty] = useState(false);
  return <FormDialog title="编辑任务" busy={saving} dirty={dirty} onClose={() => { if (!saving) onClose(); }}>
    {(requestClose, markSaved) => <TaskForm projectId={projectId} agenda={agenda} showBudgets={showBudgets} schedulingAvailable={available}
      onRecorded={record => { markSaved(); onRecorded(record); }} onBusyChange={onBusyChange} onDirtyChange={setDirty} onCancel={requestClose} onSaved={record => { markSaved(); onSaved(record); }} />}
  </FormDialog>;
}
