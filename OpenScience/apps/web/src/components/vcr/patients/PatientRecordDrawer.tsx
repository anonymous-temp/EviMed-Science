import { getVcrPatientRecord, type VcrPatientRecord, type VcrRecordFact, type VcrRecordPosition } from "@/lib/vcrRowsClient";
import { Drawer } from "@/components/ui/Drawer";
import { FactList, type Fact } from "@/components/ui/FactList";
import { Note, type NotePart, type NoteResult } from "@/components/ui/Note";
import { Section } from "@/components/ui/Section";
import { Tag } from "@/components/ui/Tag";
import { LoadError } from "@/components/cards/LoadError";
import { VcrTabSkeleton } from "../VcrStates";
import { useVcrLoad } from "../vcrTabKit";
import { numberText } from "../vcrText";

/**
 * One virtual patient's record, in the drawer a row opens (R19, plan §5.3; audit B §4.5). `?patient=<id>` on the study's address
 * opens it, so a record is a link: baseline, arm, outcome, where the patient stands in their arm, and — only when the table holds an
 * outcome for each assumption — the patient under both.
 *
 * Hidden knowledge:
 *  - **The patient is the table's.** Every number in it is a cell of the table or a count of it (`vcrRows.recordOf`); the page
 *    words them and works nothing out.
 *  - **Both assumptions are drawn only if the table holds both.** The engine writes one outcome per patient today, so the section
 *    is absent; a table that carries `y0 / y1` (or `time0 / time1`) gets it, as two rows, never as a made-up second trajectory.
 *  - **Individual outcomes of the same person under two assumptions are never both observed**, which is why they sit under the
 *    word 假设 and not under 结局: the section's name says it, and no sentence on the page repeats it.
 */
export function PatientRecordDrawer({ studyId, patientId, result, labels, onClose }: {
  studyId: string;
  patientId: string;
  result: string | null;
  /** The study's own words for its variables, by column key. */
  labels: Readonly<Record<string, string>>;
  onClose: () => void;
}) {
  const { state, reload } = useVcrLoad(`${studyId}:patient:${result ?? ""}:${patientId}`, () => getVcrPatientRecord(studyId, patientId, result));
  return (
    <Drawer title={`虚拟患者 ${patientId}`} onClose={onClose} widthClassName="max-w-md">
      <div data-vcr-patient-record={patientId}>
        {state.kind === "loading" ? <VcrTabSkeleton rows={4} />
          : state.kind === "error" ? <LoadError message={state.message} onRetry={reload} />
            : <Record record={state.data} labels={labels} />}
      </div>
    </Drawer>
  );
}

const factLabel = (fact: VcrRecordFact, labels: Readonly<Record<string, string>>) => fact.label ?? labels[fact.key] ?? fact.key;
const factValue = (fact: VcrRecordFact) => fact.text ?? (typeof fact.value === "number" ? numberText(fact.value) : fact.value ?? "—");

function Record({ record, labels }: { record: VcrPatientRecord; labels: Readonly<Record<string, string>> }) {
  const baseline: Fact[] = record.baseline.map((fact) => ({ label: factLabel(fact, labels), value: factValue(fact) }));
  const outcome: Fact[] = record.outcome.map((fact) => ({ label: factLabel(fact, labels), value: factValue(fact) }));
  const position = positionResult(record.position);
  return (
    <div className="flex flex-col gap-6">
      {record.arm && <p><Tag tone="accent">{record.arm.label}</Tag></p>}
      {baseline.length > 0 && (
        <Section title="基线" level="sub"><FactList rows={baseline} /></Section>
      )}
      {outcome.length > 0 && (
        <Section title="结局" level="sub"><FactList rows={outcome} /></Section>
      )}
      {position && (
        <Section title="在本组中的位置" level="sub"><Note result={position} /></Section>
      )}
      {record.trajectories && record.trajectories.length > 0 && (
        <Section title="两种假设下" level="sub">
          <FactList
            rows={record.trajectories.map((entry) => ({
              label: entry.label,
              value: Object.entries(entry.values).map(([key, value]) => `${labels[key] ?? key} ${value === null ? "—" : numberText(value)}`).join(" · "),
            }))}
          />
        </Section>
      )}
    </div>
  );
}

/** Where the patient stands, as a sentence whose figures are the table's own; null when the table gives it no figure to say. */
function positionResult(position: VcrRecordPosition | null): NoteResult | null {
  if (!position) return null;
  const tail = (parts: NotePart[]): NotePart[] => [...parts, "。"];
  if (position.kind === "time_to_event") {
    const parts: NotePart[] = [];
    if (position.stillFollowed !== null && position.armSize !== null) {
      parts.push("；此时本组 ", { n: numberText(position.armSize, 0) }, " 人中还有 ", { n: numberText(position.stillFollowed, 0) }, " 人未发生事件");
      if (position.survival !== null) parts.push("（累计不发生事件的概率 ", { n: `${numberText(position.survival * 100, 1)}%` }, "）");
    }
    if (position.armMedian !== null) parts.push("，本组中位时间 ", { n: numberText(position.armMedian) }, " 个月");
    return [position.event ? "第 " : "随访到第 ", { n: numberText(position.time) }, position.event ? " 个月发生事件" : " 个月仍未发生事件", ...tail(parts)];
  }
  if (position.kind === "continuous") {
    const parts: NotePart[] = [];
    if (position.percentile !== null) parts.push("，在本组中处于第 ", { n: numberText(position.percentile * 100, 0) }, " 百分位");
    if (position.armMean !== null) parts.push("；本组均值 ", { n: numberText(position.armMean) });
    return ["结局值 ", { n: numberText(position.value) }, ...tail(parts)];
  }
  if (position.armRate === null) return null;
  return [`${position.value === 1 ? "发生了结局" : "没有发生结局"}；本组发生率 `, { n: `${numberText(position.armRate * 100, 1)}%` }, "。"];
}
