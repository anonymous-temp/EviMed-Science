import { getVcrMethodResult, type VcrJob } from "@/lib/vcrClient";
import { Button } from "@/components/ui/Button";
import { DataTable } from "@/components/ui/DataTable";
import { Disclosure } from "@/components/ui/Disclosure";
import { Note } from "@/components/ui/Note";
import { PatientTable } from "./patients/PatientTable";
import { DistributionGrid } from "./patients/DistributionGrid";
import { CalibrationStrip } from "./patients/CalibrationStrip";
import { VcrBoundSourceRecord } from "./VcrBoundSourceRecord";
import { VcrMethodResultCharts } from "./VcrMethodResultCharts";
import { webApiBase } from "@/lib/apiClient";
import { ConclusionChip, SourceTag } from "./VcrMarks";
import { VcrNumber } from "./VcrNumber";
import { intervalText } from "./vcrText";
import { PartialResultNote, VcrTabSkeleton } from "./VcrStates";
import { useVcrLoad, VcrTabError } from "./vcrTabKit";

const measureNames: Record<string, string> = { power: "把握度", type_one_error: "I 类错误", bias: "偏倚", coverage: "区间覆盖率", expected_sample_size: "期望样本量", sample_size: "样本量", generated_records: "生成记录", required_events: "所需事件数", hazard_ratio: "风险比", risk_ratio: "风险比值", odds_ratio: "优势比", evalue: "E-value", evalue_estimate: "E-value", evalue_limit: "置信限 E-value", duration_months: "周期（月）", effective_sample_size: "有效样本量", cost: "成本" };
export function VcrMethodResult({ studyId, job }: { studyId: string; job: VcrJob }) {
  const { state, reload } = useVcrLoad(`method-result:${studyId}:${job.id}:${job.state}`, () => getVcrMethodResult(studyId, job.id));
  if (state.kind === "loading") return <VcrTabSkeleton rows={2} />;
  if (state.kind === "error") return <VcrTabError message={state.message} onRetry={reload} />;
  const { result, records, execution } = state.data;
  if (!result) return <Note action={<Button size="sm" variant="text" onClick={reload}>刷新结果</Button>}>{state.data.records.state === "pending" ? "计算完成后，结果会显示在这里。" : "这次运行尚无可读取结果；配置和计算历史已保留。"}</Note>;
  const source = execution?.method === "forecast.trajectories" ? "predicted" : execution?.method?.startsWith("patients.") || ["population.scenario", "population.literature", "population.synthpop"].includes(execution?.method ?? "") ? "synthetic" : "calculated";
  const measures = result.measures ?? [];
  return <div className="flex min-w-0 flex-col gap-4" data-vcr-method-result={job.id}>
    <div className="flex flex-wrap items-center gap-2"><ConclusionChip state={result.conclusion} /><span className="text-caption text-text-3">本次运行的保留结果</span></div>
    {(job.error?.partial || ["failed", "canceled"].includes(job.state)) && <PartialResultNote sentence="这次运行没有完整结束，下面保留已经得到的结果。修改配置后可重新运行。" />}
    {measures.length > 0 && <DataTable label="本次计算指标" columns={[
      { key: "name", header: "指标", rowHeader: true, cell: row => row.label ?? measureNames[row.name] ?? row.name },
      { key: "value", header: "结果", cell: row => <VcrNumber label={row.label ?? measureNames[row.name] ?? row.name} value={{ value: row.value, unit: row.unit, mcse: row.mcse, interval: row.interval, source: row.source ?? source }} /> },
      { key: "source", header: "数值来源", cell: row => <SourceTag source={row.source ?? source} /> },
      { key: "interval", header: "区间", cell: row => row.interval ? intervalText(row.interval) : row.lower != null && row.upper != null ? `${row.lower}–${row.upper}` : "未提供" },
    ]} rows={measures} rowKey={row => row.name} />}
    {result.counts && <DataTable label="本次结果计数" columns={[{ key: "label", header: "类别", rowHeader: true, cell: row => row.label }, { key: "value", header: "数量", cell: row => row.value ?? "未提供" }]} rows={[
      { label: "真实患者", value: result.counts.realPatients }, { label: "事件", value: result.counts.events }, { label: "有效样本量", value: result.counts.effectiveSampleSize }, { label: "生成记录", value: result.counts.generatedRecords },
    ].filter(row => row.value != null)} rowKey={row => row.label} />}
    <VcrMethodResultCharts result={result} method={execution?.method ?? ""} />
    {records.available && <>
      {records.profile && <DistributionGrid rows={records.profile} />}
      {records.calibration && <CalibrationStrip calibration={records.calibration} />}
      <PatientTable studyId={studyId} source={result.kind === "population" ? "population" : "patients"} result={result.id} title="本次生成记录" labels={records.labels ?? {}} />
      {records.csvUrl && <a className="text-link text-ui hover:underline" href={`${webApiBase.replace(/\/api\/?$/, "")}${records.csvUrl}`}>下载本次记录</a>}
    </>}
    {!records.available && records.state === "error" && <Note action={<Button size="sm" variant="text" onClick={reload}>重试读取记录</Button>}>记录暂时无法读取，已保留汇总结果。</Note>}
    {!measures.length && !records.available && !Object.keys(result.diagnostics ?? {}).length && <Note action={<Button size="sm" variant="text" onClick={reload}>重新读取结果</Button>}>本次结果未提供可展示的指标或记录。</Note>}
    {execution?.sourceModel && <VcrBoundSourceRecord modelId={execution.sourceModel.id} version={execution.sourceModel.version} />}
    <Disclosure summary="运行依据"><dl className="space-y-2 text-caption text-text-2"><div><dt>方法版本</dt><dd>{execution?.methodVersion ?? "未记录"}</dd></div><div><dt>随机种子</dt><dd>{execution?.seed ?? "未记录"}</dd></div>{execution?.sourceModel && <div><dt>文献参数版本</dt><dd>{execution.sourceModel.version}</dd></div>}</dl></Disclosure>
  </div>;
}
