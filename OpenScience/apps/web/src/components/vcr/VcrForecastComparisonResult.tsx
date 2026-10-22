import type { LongitudinalRecord } from "@/lib/vcrLongitudinalClient";
import { DataTable } from "@/components/ui/DataTable";
import { FactList } from "@/components/ui/FactList";
import { Section } from "@/components/ui/Section";

const number = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("zh-CN", { maximumFractionDigits: 3 }) : "未估计";
const date = (value?: string) => value && Number.isFinite(Date.parse(value)) ? value.slice(0, 10) : "未记录";
const modes: Record<string, string> = { scenario: "治疗情景", input_sensitivity: "输入敏感性", model_version: "模型版本", update: "新增观测后的更新" };
/** A preserved paired comparison, never a newly drawn forecast or an inferred treatment effect. */
export function VcrForecastComparisonResult({ record, records = [] }: { record: LongitudinalRecord; records?: LongitudinalRecord[] }) {
  const summary = record.summary;
  const groups = summary.groups ?? [];
  const samplingIntervals = groups.length > 0 && groups.every(group => group.intervalMeaning === "between_subject_sampling");
  const modelNotEstimated = groups.length > 0 && groups.every(group => group.modelUncertainty === "not_estimated");
  const version = (index: number) => { const model = summary.models?.[index] ?? records.find(row => row.id === summary.predictionIds?.[index])?.summary.model; return `${model?.name ?? "外部模型"} · ${model?.version ?? "版本未记录"} · 起点 ${date(summary.origins?.[index])}`; };
  return <Section title={`${modes[summary.mode ?? ""] ?? "预测"}比较`} level="sub">
    <FactList rows={[
      { label: "第一版本", value: version(0) }, { label: "第二版本", value: version(1) },
      { label: "配对范围", value: "只比较两边都有预测的受试者和共同目标日期，不插补缺失时间点。" },
      { label: "差值方向", value: "第一版本减第二版本。" },
      { label: "终点", value: [summary.endpoint?.code, summary.endpoint?.unit].filter(Boolean).join(" · ") || "未记录" },
      { label: "区间含义", value: samplingIntervals ? `95% 受试者配对抽样区间${modelNotEstimated ? "；模型预测不确定性未估计。" : "。"}` : "部分区间含义未声明，不将其当作模型预测区间。" },
      ...(summary.available === false ? [{ label: "比较状态", value: "尚无可配对的目标日期和受试者，请核对终点、单位及起算日期。" }] : []),
      ...(summary.changedFactors && summary.changedFactors.length > 1 ? [{ label: "变化范围", value: "两个版本有多项输入或模型变化，差异不能归因于单一因素。" }] : []),
      ...(summary.notes?.includes("equal_target_date_different_conditional_risk_windows") ? [{ label: "风险窗口", value: "目标日期相同，但条件风险起算日期不同，风险差异不能全部解释为新信息的作用。" }] : []),
      ...(summary.causalEffectIdentified === false ? [{ label: "解释范围", value: "配对预测差异本身不确立因果治疗效果。" }] : []),
    ]} max={12} />
    {groups.length > 0 && <DataTable label="同一日期、相同受试者的预测差异" rows={groups.map((group, index) => ({ ...group, key: String(index) }))} rowKey={group => group.key} columns={[
      { key: "target", header: "目标日期", rowHeader: true, cell: group => group.targetAt ? date(group.targetAt) : `${group.horizonDays} 天` },
      { key: "subjects", header: "配对人数", cell: group => group.displayReason ? "小样本未展示" : number(group.subjects) },
      { key: "firstOnly", header: "仅第一版本", cell: group => group.displayReason ? "未展示" : number(group.firstOnly) },
      { key: "secondOnly", header: "仅第二版本", cell: group => group.displayReason ? "未展示" : number(group.secondOnly) },
      { key: "first", header: "第一版本均值", cell: group => group.displayReason ? "未展示" : number(group.firstMean) },
      { key: "second", header: "第二版本均值", cell: group => group.displayReason ? "未展示" : number(group.secondMean) },
      { key: "difference", header: "均值差", cell: group => group.displayReason ? "未展示" : number(group.meanDifference) },
      { key: "interval", header: samplingIntervals ? "95% 抽样区间" : "差值区间", cell: group => group.displayReason ? "未展示" : group.lower != null && group.upper != null ? `${number(group.lower)}–${number(group.upper)}` : "未估计" },
    ]} />}
  </Section>;
}
