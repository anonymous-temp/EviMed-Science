import type { VcrTrialTab } from "@/lib/vcrClient";
import { ChartCard } from "@/components/ui/ChartCard";
import { DataTable } from "@/components/ui/DataTable";
import { VcrNumber } from "./VcrNumber";
import { VcrSeriesLegend, VcrTrajectoryChart } from "./VcrCharts";

/** Accrual forecasts never stand in for full-study duration. */
export function VcrAccrualForecasts({ forecasts }: { forecasts: NonNullable<VcrTrialTab["accrualForecasts"]> }) {
  if (!forecasts.length) return null;
  const series = forecasts.filter(row => row.probabilityByMonth.length).map(row => ({ key: row.id, label: `${row.design ?? row.name} · 入组预测版本 ${row.version}`, source: "predicted" as const, points: row.probabilityByMonth.map(point => ({ x: point.month, y: point.probability * 100 })) }));
  return <ChartCard title="入组假设模拟" legend={series.length ? <VcrSeriesLegend series={series} /> : undefined}>
    <DataTable label="保留的入组时间预测" rows={forecasts} rowKey={row => row.id} columns={[
      { key: "name", header: "方案与预测版本", rowHeader: true, cell: row => `${row.name} · 入组预测版本 ${row.version}` },
      { key: "lastPatientIn", header: "末例入组时间（月）", cell: row => row.lastPatientIn ? <VcrNumber label="末例入组时间" value={row.lastPatientIn} /> : "未提供" },
      { key: "targetEvents", header: "目标事件时间（月）", cell: row => row.targetEvents ? <VcrNumber label="目标事件时间" value={row.targetEvents} /> : "未提供" },
    ]} />
    {series.length > 0 && <div className="mt-4"><VcrTrajectoryChart series={series} xLabel="月份" yLabel="截至该月完成入组的概率" domain={[0, 100]} formatY={value => `${Math.round(value)}%`} /></div>}
  </ChartCard>;
}
