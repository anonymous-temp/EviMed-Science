import type { VcrAssessments, VcrModelCard } from "@/lib/vcrClient";
import { Drawer } from "@/components/ui/Drawer";
import { Section } from "@/components/ui/Section";
import { VcrModelAssessments } from "../VcrModelAssessments";
import { VcrModelRecord } from "../VcrModelRecord";

/**
 * 「模型 ›」: the model behind a study's virtual patients, in a drawer over them (R19, plan §5.3; audit B §2.4 #11, §4.5).
 *
 * What used to be a chip row, a folded regulatory table and a line saying whose model the table described sat under the charts of
 * the patients tab. It is a record — to check, not to read first — so it is behind the one chip that names the model, and it holds
 * the model's card and, under it, the model's ICH M15 assessment: the assessment is about the model the study uses, and this is where
 * the model is. A study whose assessments name a model the patients tab has no card for (a trial simulation's reference simulator)
 * opens the same drawer with the assessments alone.
 */
export function ModelRecordDrawer({ studyId, model, assessments, canEdit, onSaved, onClose }: {
  studyId: string;
  model: VcrModelCard | null;
  assessments: VcrAssessments;
  canEdit: boolean;
  onSaved: () => void;
  onClose: () => void;
}) {
  return (
    <Drawer title={model?.name ?? "模型评估"} onClose={onClose} widthClassName="max-w-xl">
      <div className="flex flex-col gap-8">
        {model && <VcrModelRecord model={model} />}
        {assessments.records.length > 0 && (
          <Section title="模型评估" level="sub" count={assessments.records.length}>
            <VcrModelAssessments studyId={studyId} assessments={assessments} canEdit={canEdit} onSaved={onSaved} />
          </Section>
        )}
      </div>
    </Drawer>
  );
}
