import { Link } from "react-router";
import { FactList, type Fact } from "@/components/ui/FactList";
import { Section } from "@/components/ui/Section";
import type { VcrResearchProgress as Progress } from "@/lib/vcrClient";
import { vcrChatPath } from "@/lib/studyLocation";
import { vcrTabPath } from "./vcrTabs";

const computation: Record<Progress["calculation"], string> = {
  none: "尚无计算结果", queued: "排队中", running: "计算中", awaiting_budget: "等待计算预算", failed: "计算未完成", canceled: "计算已取消",
  available: "结果已生成", limited: "结果有局限", not_estimable: "不可估计", stale: "结果已过期，需重新计算",
};
const availability: Record<Progress["input"], string> = { available: "可用于队列计算", missing: "尚无可用输入", unknown: "待检查", not_required: "本结果使用设定或文献，无需队列输入" };

/**
 * Component: VcrResearchProgress; owner: VCR; rules: evidence-bound progress.
 * Anatomy: Study facts and a link to population details.
 * Variants: Counts and statistics are shown only when present.
 * States: Definition, input and computation are independent.
 * Hit area: The population link uses native link behavior.
 * Keyboard: Link is reachable with the keyboard.
 * Long content: Column names wrap with the fact value.
 * Theme: Existing section and fact-list tokens.
 * Responsive: FactList adapts to narrow widths.
 * Verification: VcrResearchProgress tests and presenter fixtures.
 */
export function VcrResearchProgress({ progress, studyId, showPopulationLink = true }: { progress: Progress | null | undefined; studyId: string; showPopulationLink?: boolean }) {
  if (!progress) return null;
  const counts = progress.counts;
  const facts: Fact[] = [
    { label: "人群定义", value: progress.definition === "saved" ? "已保存" : "尚未保存" },
    { label: "队列输入", value: availability[progress.input] ?? "待检查" },
    { label: "计算", value: computation[progress.calculation] ?? "待检查" },
    // A result that exists for another snapshot is neither this population's nor a zero: said once, with how to go on.
    ...(progress.resultNotCounted ? [{ label: "另一份快照的结果", value: "未计入：它不是在这个人群的数据快照上算的。要在新快照上算，保存一个新的人群版本再计算。" }] : []),
    ...(progress.resultStale && progress.calculation !== "stale" ? [{ label: "已有结果", value: "已过期" }] : []),
    ...(counts.sourcePatients != null ? [{ label: "来源表患者", value: `${counts.sourcePatients.toLocaleString()} 人` }] : []),
    ...(counts.realPatients != null ? [{ label: "结果真实患者", value: `${counts.realPatients.toLocaleString()} 人` }] : []),
    ...(counts.observations != null ? [{ label: "来源表观测", value: `${counts.observations.toLocaleString()} 条` }] : []),
    ...(counts.generatedRecords != null ? [{ label: "生成记录", value: `${counts.generatedRecords.toLocaleString()} 条` }] : []),
    ...(counts.reconstructedPseudoPatients != null ? [{ label: "重建记录", value: `${counts.reconstructedPseudoPatients.toLocaleString()} 条` }] : []),
    ...(progress.profileStatistics ?? []).filter(row => row.mean != null && row.median != null).map(row => ({ label: `来源表：${row.column}`, value: `均值 ${row.mean?.toLocaleString()}，中位数 ${row.median?.toLocaleString()}` })),
  ];
  return <Section title="研究进展" toolbar={showPopulationLink ? <Link className="text-link hover:underline" to={vcrTabPath(studyId, "population")}>查看人群</Link> : undefined}><FactList rows={facts} />{progress.calculation === "failed" && <Link className="text-link hover:underline" to={vcrChatPath(studyId)}>返回研究对话</Link>}</Section>;
}
