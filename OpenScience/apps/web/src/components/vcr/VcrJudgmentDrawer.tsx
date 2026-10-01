import { useId, useRef, useState } from "react";
import { VCR_CRITERION_STATES } from "@evimed/domain";
import { overrideVcrJudgment, type VcrCriterionJudgement, type VcrCriterionState } from "@/lib/vcrClient";
import { webErrorMessage } from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { inputClasses, Textarea } from "@/components/ui/Input";
import { criterionStateLabel } from "./vcrText";

/**
 * 改判: a person re-judges one rule for one candidate.
 *
 * Hidden knowledge:
 *  - **The platform's answer is kept, not overwritten.** What a coordinator says
 *    is stored beside what the platform said; the pair is the evaluation case
 *    the matching is measured against (plan §7.5). The drawer says which state
 *    the platform gave, so a reader sees what is being changed.
 *  - **A person's hand only.** The route takes the session's account as the
 *    author; there is no way to say the judgment was somebody else's, and a run
 *    has no such call.
 *  - One request at a time.
 */
export function VcrJudgmentDrawer({ studyId, assessmentId, criterion, onClose, onSaved }: {
  studyId: string;
  assessmentId: string;
  criterion: VcrCriterionJudgement & { criterionId: string };
  onClose: () => void;
  /** After the judgment is stored: the tab re-reads the person. */
  onSaved: () => void;
}) {
  const [state, setState] = useState<VcrCriterionState>(criterion.state);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const holding = useRef(false);
  const stateId = useId();

  const save = () => {
    if (holding.current) return;
    holding.current = true;
    setBusy(true);
    void overrideVcrJudgment(studyId, assessmentId, criterion.criterionId, { state, note })
      .then(() => { toast.success("已记录改判。"); onSaved(); onClose(); })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "改判暂时无法记录，请稍后重试。" })))
      .finally(() => { holding.current = false; setBusy(false); });
  };

  return (
    <Drawer title={`改判 ${criterion.code}`} onClose={onClose} widthClassName="max-w-md">
      <form data-vcr-judgment="" className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); save(); }}>
        <p className="text-ui text-text">{criterion.text}</p>
        <p className="text-caption text-text-3">{`平台判为：${criterionStateLabel(criterion.state)}`}</p>
        <div>
          <label htmlFor={stateId} className="mb-2 block text-ui font-medium text-text">你的判定</label>
          <select id={stateId} value={state} onChange={(event) => setState(event.target.value as VcrCriterionState)} className={inputClasses()}>
            {VCR_CRITERION_STATES.map((each) => <option key={each} value={each}>{criterionStateLabel(each as VcrCriterionState)}</option>)}
          </select>
        </div>
        <Textarea label="依据" rows={3} maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>取消</Button>
          <Button type="submit" loading={busy} disabled={busy}>保存</Button>
        </div>
      </form>
    </Drawer>
  );
}
