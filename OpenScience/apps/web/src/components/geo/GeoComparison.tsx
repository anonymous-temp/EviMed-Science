import type { GeoScopedView } from "@/lib/geoReadScope";
import { ChartCard } from "@/components/ui/ChartCard";
import { DataTable } from "@/components/ui/DataTable";
import { metricName, metricUnit } from "./tabs/geoTabText";
import { CellLink } from "./tabs/geoTabKit";

/** The API chooses the comparable cohort and computes differences. The view never subtracts unrelated readings. */
export function GeoComparison({ geoId, view }: { geoId: string; view: GeoScopedView }) {
  const comparison = view.comparison;
  if (!comparison) return null;
  const rows = comparison.cells.filter(cell => cell.scope === "project" && !cell.pool && !cell.engine && !cell.variant && !cell.rival
    && ["M-19", "M-01S", "M-06", "M-08"].includes(cell.metricId));
  return <ChartCard title={comparison.mode === "separate" ? "两个区间分别呈现" : `同口径比较覆盖 ${comparison.commonQuestionEngineModes} 组问题与平台`}
    footnote={`${view.scope?.compareFrom ?? ""} 至 ${view.scope?.compareTo ?? ""} → ${view.scope?.from ?? "所选起点"} 至 ${view.scope?.to ?? "当前"}。观察变化不代表因果效果。`}>
    <DataTable label="区间指标比较" rows={rows} rowKey={row => row.metricId} columns={[
      { key: "metric", header: "指标", rowHeader: true, cell: row => metricName(row.metricId) ?? "指标" },
      { key: "previous", header: "对比区间", align: "right", cell: row => <CellLink geoId={geoId} cell={row.previous} unit={metricUnit(row.metricId)} label={`${metricName(row.metricId)}对比区间`} /> },
      { key: "current", header: "当前区间", align: "right", cell: row => <CellLink geoId={geoId} cell={row.current} unit={metricUnit(row.metricId)} label={`${metricName(row.metricId)}当前区间`} /> },
      { key: "change", header: "变化", align: "right", cell: row => row.delta === null ? (comparison.mode === "separate" ? "分别呈现" : row.reason === "comparison_basis_changed" ? "组成变化" : "不可比")
        : `${row.delta > 0 ? "+" : ""}${row.delta}${metricUnit(row.metricId) === "percent" ? " 个百分点" : " 分"}` },
    ]} />
  </ChartCard>;
}
