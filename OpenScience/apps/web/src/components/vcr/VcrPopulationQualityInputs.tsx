import type { VcrDataTab, VcrPopulationTab, VcrQualityBasis } from "@/lib/vcrClient";
import { Select } from "@/components/ui/Input";
import { Note } from "@/components/ui/Note";
import { Link } from "react-router";
import { ScenarioField, schemas } from "./VcrScenarioEditor";

interface Props {
  studyId: string; data: VcrDataTab; population: VcrPopulationTab; scenario: Record<string, unknown>; change: (scenario: Record<string, unknown>) => void;
  basis: VcrQualityBasis | null; basisAvailable?: boolean | null; setBasis: (basis: VcrQualityBasis | null) => void; setSubjectId: (id: string | null) => void; setSnapshots: (ids: string[]) => void; disabled: boolean;
}
const sameBasis = (left: VcrQualityBasis | null | undefined, right: VcrQualityBasis | null) => Boolean(left && right && (["populationId", "populationVersion", "resultId", "table", "inputId", "sha256"] as const).every(key => left[key] === right[key]));
export function qualityInputProblem(data: VcrDataTab, population: VcrPopulationTab, scenario: Record<string, unknown>, basis: VcrQualityBasis | null, basisAvailable?: boolean | null): string | null {
  if (basisAvailable === false) return "历史生成依据已不可复用，请明确重新选择可用的人群生成版本。";
  if (!basis) return "请选择要检查的已生成人群版本。";
  if (!population.versions.some(version => sameBasis(version.generationInput, basis))) return "历史运行的人群生成依据已变更或无法复用。原结果仍可查看，请明确重新选择人群版本。";
  const ids = new Set((data.intake?.snapshots ?? []).flatMap(snapshot => snapshot.qualityInputs ?? []).map(input => input.inputId));
  if (!ids.has(String(scenario.trainingInputId ?? ""))) return "请选择本研究可读取的训练或参考数据。";
  if (scenario.holdoutInputId && !ids.has(String(scenario.holdoutInputId))) return "原留出数据已无法读取，请重新选择或移除留出数据。";
  return scenario.syntheticInputId === basis.inputId ? null : "请选择与当前人群生成结果一致的评估依据。";
}
export function VcrPopulationQualityInputs({ studyId, data, population, scenario, change, basis, basisAvailable, setBasis, setSubjectId, setSnapshots, disabled }: Props) {
  const options = (data.intake?.snapshots ?? []).flatMap(snapshot => (snapshot.qualityInputs ?? []).map(input => ({ ...input, snapshotId: snapshot.id, text: `${snapshot.label} · ${input.label}` })));
  const changeRole = (field: "trainingInputId" | "holdoutInputId", id: string) => {
    const next = { ...scenario }; if (id) next[field] = id; else delete next[field];
    change(next); setSnapshots([...new Set([next.trainingInputId, next.holdoutInputId].flatMap(value => { const input = options.find(option => option.inputId === value); return input ? [input.snapshotId] : []; }))]);
  };
  const training = options.find(option => option.inputId === scenario.trainingInputId);
  const columns = (training?.columns ?? []).map(value => ({ value, label: training?.columnLabels?.[value] ?? value }));
  const availableBasis = population.versions.some(version => sameBasis(version.generationInput, basis));
  return <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-3">
    <Select label="要检查的人群生成版本" value={basisAvailable === false ? "historical-unavailable" : basis?.inputId ?? ""} onChange={event => { const selected = population.versions.find(version => version.generationInput?.inputId === event.target.value)?.generationInput ?? null; setBasis(selected); setSubjectId(selected?.populationId ?? null); const next = { ...scenario }; if (selected) next.syntheticInputId = selected.inputId; else delete next.syntheticInputId; change(next); }}><option value="">选择已生成人群版本</option>{basis && (basisAvailable === false || !availableBasis) && <option value={basisAvailable === false ? "historical-unavailable" : basis.inputId}>历史生成依据已变更，请重新选择</option>}{population.versions.filter(version => version.generationInput).map(version => <option key={version.id} value={version.generationInput!.inputId}>{version.label} · 已保存生成结果</option>)}</Select>
    <Select label="训练或参考数据" value={String(scenario.trainingInputId ?? "")} onChange={event => changeRole("trainingInputId", event.target.value)}><option value="">选择可读取数据</option>{Boolean(scenario.trainingInputId) && !training && <option value={String(scenario.trainingInputId)}>原参考数据已不可用</option>}{options.map(option => <option key={option.inputId} value={option.inputId}>{option.text}</option>)}</Select>
    <Select label="独立留出数据（可选）" value={String(scenario.holdoutInputId ?? "")} onChange={event => changeRole("holdoutInputId", event.target.value)}><option value="">不使用留出数据</option>{Boolean(scenario.holdoutInputId) && !options.some(option => option.inputId === scenario.holdoutInputId) && <option value={String(scenario.holdoutInputId)}>原留出数据已不可用</option>}{options.map(option => <option key={option.inputId} value={option.inputId}>{option.text}</option>)}</Select>
    {!options.length && <Note action={<Link className="text-link hover:underline" to={`/app/virtual-research/${encodeURIComponent(studyId)}/data`}>导入并映射研究数据</Link>}>尚无可读取的质量检查数据。请选择已完成字段映射且有读取权限的数据快照。</Note>}
    <ScenarioField title="质量检查参数" method="population.quality" schema={schemas["population.quality"]} root={scenario} value={scenario} change={value => change(value as Record<string, unknown>)} hiddenFields={["trainingInputId", "syntheticInputId", "holdoutInputId"]} columnOptions={columns} />
  </fieldset>;
}
