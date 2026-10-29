import type { VcrMethodResult, VcrSeries, VcrProfileRow, VcrDesign, VcrValue, VcrValueSource } from "@/lib/vcrClient";
import type { LongitudinalRecord } from "@/lib/vcrLongitudinalClient";
import { VcrForecastComparisonResult } from "./VcrForecastComparisonResult";
import { VCR_VALUE_SOURCES, VCR_NOT_ESTIMABLE_RULE_LABELS_ZH, knownErrorCodeMessage } from "@evimed/domain";
import { Tag } from "@/components/ui/Tag";
import { FactList } from "@/components/ui/FactList";
import { DataTable } from "@/components/ui/DataTable";
import { VcrNumber } from "./VcrNumber";
import { Section } from "@/components/ui/Section";
import { HeatGrid } from "@/components/charts/HeatGrid";
import { BalancePlot } from "./comparator/BalancePlot";
import { VcrSeriesLegend, VcrTrajectoryChart, VcrSurvivalChart } from "./VcrCharts";
import { VcrTradeoffScatter, VcrMilestoneTimeline } from "./VcrDiagrams";
import { VcrForecastEvaluation } from "./VcrForecastEvaluation";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(object) : [];
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const text = (value: unknown): string | null => typeof value === "string" && value ? value : null;
const sourceOf = (value: unknown, fallback: VcrValueSource): VcrValueSource => (VCR_VALUE_SOURCES as readonly unknown[]).includes(value) ? value as VcrValueSource : fallback;
/** Raw vcr_series() band levels are probability fractions; chart legends take percentages. */
export function readMethodResultSeries(raw: unknown, source: VcrValueSource): VcrSeries[] {
  return list(raw).flatMap((row, index) => {
    const points = list(row.points).flatMap(point => number(point.x) == null ? [] : [{ x: number(point.x)!, y: number(point.y), low: number(point.low), high: number(point.high) }]);
    const rawLevel = number(row.bandLevel);
    const bandLevel = rawLevel !== null && rawLevel > 0 && rawLevel <= 1 ? rawLevel * 100 : null;
    const atRisk = list(row.atRisk).flatMap(entry => number(entry.x) !== null && number(entry.n) !== null ? [{ x: number(entry.x)!, n: number(entry.n)! }] : []);
    const individuals = Array.isArray(row.individuals) ? row.individuals.map(line => list(line).flatMap(point => number(point.x) !== null ? [{ x: number(point.x)!, y: number(point.y) }] : [])).filter(line => line.length > 1) : [];
    const unobserved = list(row.unobserved).flatMap(span => number(span.from) !== null && number(span.to) !== null ? [{ from: number(span.from)!, to: number(span.to)! }] : []);
    return text(row.label) && points.length ? [{ key: text(row.key) ?? `series_${index}`, label: String(row.label), points, source: sourceOf(row.source, source), ours: row.ours === true, pooled: row.pooled === true, atRisk, individuals, unobserved, endLabel: text(row.endLabel), endNote: text(row.endNote), bandKind: ["confidence", "credible", "prediction", "monte_carlo"].includes(String(row.bandKind)) ? row.bandKind as VcrSeries["bandKind"] : null, bandLevel, dashed: row.dashed === true }] : [];
  });
}
function gridCellState(cell: Record<string, unknown>): string {
  if (cell.status === "canceled") return "已取消";
  if (cell.status === "failed") return list(cell.measures).length ? "未完成，保留部分结果" : "未完成";
  if (cell.replicatesCapped === true) return "重复次数达到上限";
  if (cell.conclusion === "limited") return "有限制的结果";
  if (cell.conclusion === "not_estimable" || cell.refusal) return "不可估计";
  return cell.status === "succeeded" ? "计算完成" : "运行状态未声明";
}
function gridCellLimited(cell: Record<string, unknown>): boolean { return Boolean(cell.status && cell.status !== "succeeded" || cell.conclusion === "limited" || cell.conclusion === "not_estimable" || cell.replicatesCapped || cell.refusal); }
const asValue = (row: Record<string, unknown>, source: VcrValueSource): VcrValue => ({ value: number(row.value), unit: text(row.unit), source: sourceOf(row.source, source), mcse: number(row.mcse), ...(object(row.interval).kind ? { interval: row.interval as VcrValue["interval"] } : {}) });
/** Thin rendering adapters read this job's own diagnostics. They never ask for the current study tab. */
export function VcrMethodResultCharts({ result, method }: { result: NonNullable<VcrMethodResult["result"]>; method: string }) {
  const diagnostics = result.diagnostics ?? {};
  const source: VcrValueSource = method === "forecast.trajectories" ? "predicted" : method.startsWith("patients.") || method === "population.scenario" || method === "population.synthpop" ? "synthetic" : "calculated";
  const trajectories = object(diagnostics.trajectories);
  const trajectorySeries = readMethodResultSeries(trajectories.series, source);
  const power = object(diagnostics.powerCurve);
  const powerSeries = readMethodResultSeries(power.series, "calculated");
  const curves = readMethodResultSeries(object(diagnostics.survival).curves ?? diagnostics.curves, source);
  const balance: VcrProfileRow[] = list(diagnostics.balance).map((row, index) => ({ key: text(row.covariate) ?? String(index), label: text(row.covariate) ?? `特征 ${index + 1}`, ours: { value: null, source: "observed" }, theirs: { value: null, source: "observed" }, smd: number(row.smdAdjusted ?? row.smd), smdBefore: number(row.smdUnadjusted) }));
  const cells = list(diagnostics.cells).filter(cell => Number.isInteger(cell.designIndex) && Number.isInteger(cell.truthIndex) && Number(cell.designIndex) > 0 && Number(cell.truthIndex) > 0);
  const gridMeasure = cells.some(cell => list(cell.measures).some(measure => measure.name === "power")) ? "power" : cells.some(cell => list(cell.measures).some(measure => measure.name === "type_one_error")) ? "type_one_error" : null;
  const gridLabel = gridMeasure === "power" ? "把握度" : gridMeasure === "type_one_error" ? "I 类错误" : "估计值";
  const designIndices = [...new Set(cells.map(cell => Number(cell.designIndex)))].sort((a, b) => a - b);
  const truthIndices = [...new Set(cells.map(cell => Number(cell.truthIndex)))].sort((a, b) => a - b);
  const designs: VcrDesign[] = cells.map(cell => ({ id: `${cell.designIndex}:${cell.truthIndex}`, code: `${cell.designIndex}`, name: `设计 ${cell.designIndex} · 情景 ${cell.truthIndex}`, measures: Object.fromEntries(list(cell.measures).map(row => [String(row.name), asValue(row, "calculated")])) }));
  const durations = (result.measures ?? []).filter(row => ["last_patient_in_months", "target_events_months"].includes(row.name) || (row.name === "expected_completion_time" && ["months", "month", "月"].includes(row.unit ?? "")));
  const milestones = durations.map(row => ({ design: row.name, name: "招募预测", items: [{ key: row.name, label: ({ last_patient_in_months: "末例入组", target_events_months: "达到目标事件数", expected_completion_time: "预计完成" })[row.name] ?? row.name, value: asValue(row as unknown as Record<string, unknown>, "predicted") }] }));
  const record = object(diagnostics.longitudinal);
  const longitudinal = record.summary && record.kind ? record as unknown as LongitudinalRecord : null;
  const longitudinalSeries: VcrSeries[] = longitudinal?.summary.trajectories?.length ? [{ key: longitudinal.id, label: longitudinal.summary.endpoint?.code ?? "预测轨迹", source: "predicted", ours: true, bandKind: null, points: longitudinal.summary.trajectories.map(point => ({ x: point.day, y: point.mean, low: point.lower, high: point.upper })) }] : [];
  return <>
    {diagnostics.quality && <QualityResult raw={diagnostics.quality} />}
    {trajectorySeries.length > 0 && <Section title="结局轨迹" level="sub"><VcrSeriesLegend series={trajectorySeries} />{method === "patients.time_to_event" ? <VcrSurvivalChart curves={trajectorySeries} yLabel="生存概率" xLabel={text(trajectories.xLabel) ?? "时间（原方法单位）"} /> : <VcrTrajectoryChart series={trajectorySeries} xLabel={text(trajectories.xLabel)} yLabel={text(trajectories.yLabel)} />}</Section>}
    {curves.length > 0 && <Section title="生存曲线" level="sub"><VcrSeriesLegend series={curves} /><VcrSurvivalChart curves={curves} yLabel="生存概率" xLabel="时间（原方法单位）" /></Section>}
    {powerSeries.length > 0 && <Section title="设计性能曲线" level="sub"><VcrSeriesLegend series={powerSeries} /><VcrTrajectoryChart series={powerSeries} xLabel={text(power.xLabel)} yLabel={text(power.yLabel) ?? "概率"} /></Section>}
    {balance.length > 0 && <Section title="加权前后平衡性" level="sub"><BalancePlot rows={balance} /></Section>}
    {cells.length > 0 && <Section title={gridMeasure ? `设计与效应情景 · ${gridLabel}` : "设计单元状态"} level="sub">{gridMeasure && <HeatGrid label="设计与效应情景计算网格" columns={truthIndices.map(index => ({ key: String(index), header: `情景 ${index}` }))} rows={designIndices.map(design => ({ key: String(design), header: `设计 ${design}`, cells: truthIndices.map(truth => { const cell = cells.find(row => row.designIndex === design && row.truthIndex === truth); const measure = list(cell?.measures).find(row => row.name === gridMeasure); const value = number(measure?.value); return { value, text: value == null ? "未计算" : `${(value * 100).toFixed(1)}%${cell && gridCellLimited(cell) ? " · 部分" : ""}`, hint: `${gridLabel}${number(measure?.mcse) !== null ? ` · 蒙特卡洛标准误 ${number(measure?.mcse)}` : ""}${cell ? ` · ${gridCellState(cell)}` : ""}` }; }) }))} />}<FactList rows={[{ label: "返回单元", value: `${cells.length}${number(diagnostics.cellsPlanned) !== null ? ` / 计划 ${number(diagnostics.cellsPlanned)}` : ""}` }]} /><DataTable label="设计网格单元状态" rows={cells} rowKey={cell => `${cell.designIndex}:${cell.truthIndex}`} columns={[
      { key: "design", header: "设计 / 情景", rowHeader: true, cell: cell => `${cell.designIndex} / ${cell.truthIndex}` },
      ...(gridMeasure ? [{ key: "estimate", header: `${gridLabel}（比例）`, cell: (cell: Record<string, unknown>) => { const measure = list(cell.measures).find(row => row.name === gridMeasure); return <VcrNumber label={gridLabel} value={{ value: number(measure?.value), source: "calculated", mcse: number(measure?.mcse) }} />; } }] : []),
      { key: "state", header: "状态", cell: cell => <Tag tone={gridCellLimited(cell) ? "warn" : "neutral"}>{gridCellState(cell)}</Tag> },
      { key: "conclusion", header: "估计结论", cell: cell => ({ estimable: "可估计", limited: "有限制地估计", not_estimable: "不可估计" })[String(cell.conclusion)] ?? "未声明" },
      { key: "refusal", header: "计算条件", cell: cell => { const refusal = text(cell.refusal); return refusal ? (VCR_NOT_ESTIMABLE_RULE_LABELS_ZH as Record<string, string>)[refusal] ?? knownErrorCodeMessage(refusal) ?? "此单元未满足方法计算条件，请核对设计和输入后重试。" : cell.replicatesCapped === true ? "重复计算受本次上限限制，已保留完成部分。" : "—"; } },
    ]} />{designs.some(row => row.measures.sample_size && row.measures.power) && <VcrTradeoffScatter designs={designs} xKey="sample_size" yKey="power" xLabel="样本量" yLabel="把握度" />}</Section>}
    {milestones.length > 0 && <Section title="招募时间预测" level="sub"><VcrMilestoneTimeline milestones={milestones} axisLabel="月" /></Section>}
    {longitudinalSeries.length > 0 && <Section title="后续预测轨迹" level="sub"><VcrSeriesLegend series={longitudinalSeries} /><VcrTrajectoryChart series={longitudinalSeries} xLabel="距预测起点（天）" yLabel={longitudinal?.summary.endpoint?.unit} /></Section>}
    {longitudinal?.kind === "comparison" && <VcrForecastComparisonResult record={longitudinal} />}
    {longitudinal && ["evaluation", "trial_evaluation"].includes(longitudinal.kind) && <VcrForecastEvaluation record={longitudinal} />}
  </>;
}

function QualityResult({ raw }: { raw: unknown }) {
  const quality = object(raw), fidelity = object(quality.fidelity), global = object(fidelity.global), disclosure = object(quality.disclosure);
  const candidates = [
    { label: "标准化 pMSE", value: global.sPMSE }, { label: "区分真假记录的 AUC", value: global.propensityAuc },
    ...list(fidelity.univariate).flatMap(row => [{ label: `${text(row.variable) ?? "变量"} · ${row.statistic === "ks_d" ? "KS 距离" : row.statistic === "tvd" ? "总变异距离" : "分布差异"}`, value: row.value }, { label: `${text(row.variable) ?? "变量"} · 缺失率差`, value: row.missingRateDifference }]),
    ...(disclosure.available === false ? [] : [{ label: "复制率（相对留出集）", value: disclosure.replicationRatio }, { label: "最近邻落在训练集的比例", value: disclosure.nearestNeighbourInTrainShare }, { label: "成员推断 AUC", value: disclosure.membershipAuc }, { label: "到最近训练记录的距离（中位）", value: disclosure.dcrMedian ?? disclosure.medianDcr }]),
    { label: "入排通过率的相对差", value: object(object(quality.utility).feasibility).jointPassRateRelativeDifference },
  ].flatMap((row, index) => number(row.value) === null ? [] : [{ key: String(index), label: row.label, value: number(row.value)! }]);
  return candidates.length ? <Section title="人群质量指标" level="sub"><DataTable label="本次人群质量指标" columns={[{ key: "label", header: "指标", rowHeader: true, cell: row => row.label }, { key: "value", header: "结果", cell: row => <VcrNumber label={row.label} value={{ value: row.value, source: "calculated" }} /> }]} rows={candidates} rowKey={row => row.key} /></Section> : null;
}
