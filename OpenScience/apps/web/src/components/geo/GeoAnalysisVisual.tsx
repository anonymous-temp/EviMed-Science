import { useId } from "react";
import type { GeoAnalysisView, GeoAnalysisChartCell } from "@/lib/geoAnalysisClient";
import { ChartCard } from "@/components/ui/ChartCard";
import { Button } from "@/components/ui/Button";
import { BarList } from "@/components/charts/BarList";
import { HeatGrid } from "@/components/charts/HeatGrid";
import { GeoLineChart, chartScale } from "./tabs/GeoCharts";
import { engineName } from "./geoText";

const reasonWords: Readonly<Record<string, string>> = {
  engine_absent: "这个范围没有该平台的回答。",
  no_snapshots: "这个范围没有回答记录。",
  no_valid_answers: "这个范围尚未取得有效回答。",
  insufficient_sample: "尚未达到该指标的样本要求。",
  not_adjudicated: "回答中的陈述尚未完成判定。",
  judgement_incomplete: "回答的判定尚未完整。",
  not_extracted: "尚未取得该指标所需的提取结果。",
  entity_extraction_incomplete: "品牌与实体识别尚未完成。",
  citations_without_links: "引用缺少可核对的链接。",
  owned_not_registered: "尚未登记可识别的自有信源。",
  no_inline_citation_engine: "该平台没有可识别的正文引用。",
  no_citations: "这个范围没有可核对的引用。",
  no_retrieval: "这个范围没有可核对的检索结果。",
  not_mentioned: "这个范围没有可确定位置的品牌提及。",
  no_drug_entities: "尚未识别出可用于该指标的药品实体。",
  coverage_below_min: "品牌登记信息不足，尚不能计算该指标。",
  uneven_denominators: "回答覆盖不均，不能直接比较该指标。",
  no_brand_mentions: "这个范围没有可识别的品牌提及。",
  conversion_not_derivable: "缺少可用于该指标的上下游读数。",
  no_measurable_dimension: "这个范围尚无可计算的指标维度。",
  no_measurable_pool: "这个范围尚无可计算的问句池读数。",
  not_applicable: "该指标不适用于这类问题。",
  inclusion_surface: "该采样方式不适用于这个指标。",
};
function unavailableWord(cell: GeoAnalysisChartCell): string {
  if (cell.reason === "citations_without_links") return "引用不可测";
  return ({ no_data: "未测", insufficient: "样本不足", unjudged: "尚无法判定", not_applicable: "不适用" } as Record<string, string>)[cell.state] ?? "暂无可用读数";
}
function unavailableReason(cell: GeoAnalysisChartCell): string {
  return reasonWords[cell.reason ?? ""] ?? (cell.state === "insufficient"
    ? "尚未达到该指标的样本要求。"
    : "尚无可用读数，可在下表查看明细。");
}
function platformLabel(cell: GeoAnalysisChartCell): string {
  return [engineName(cell.engine), cell.pool].filter(Boolean).join(" · ");
}

/** Geometry only: every value, display dimension and exact member comes from the full server aggregate. */
export function GeoAnalysisVisual({ data, onSelect }: {
  data: GeoAnalysisView;
  onSelect(cell: GeoAnalysisChartCell): void;
}) {
  const statusId = useId();
  const chart = data.chart;
  if (!chart) return null;
  if (chart.kind === "bars") {
    const cells = chart.cells ?? [];
    const known = cells.filter(cell => cell.state === "known" && cell.value !== null);
    const unavailable = cells.filter(cell => cell.state !== "known" || cell.value === null);
    return (
      <ChartCard
        title="各平台所选实测"
        state={known.length ? "content" : "empty"}
        emptyText={cells.length ? "这个范围尚无可绘制读数；未测与样本不足均未计为零。" : "这个范围尚无平台读数。"}
        legend={unavailable.length ? (
          <ul aria-label="未绘制的平台状态" className="flex w-full flex-col gap-2">
            {unavailable.map(cell => (
              <li key={cell.rowKey}>
                <Button size="sm" variant="text" aria-describedby={`${statusId}-${cell.rowKey}`} onClick={() => onSelect(cell)}>
                  {platformLabel(cell)} · {unavailableWord(cell)}
                </Button>
                <p id={`${statusId}-${cell.rowKey}`} className="text-caption text-text-3">{unavailableReason(cell)}</p>
              </li>
            ))}
          </ul>
        ) : undefined}
      >
        <BarList
          label="各平台所选实测"
          tone="own"
          rows={known.map(cell => ({
            key: cell.rowKey,
            label: platformLabel(cell),
            value: cell.value!,
            unit: cell.unit === "percent" ? "%" : cell.unit === "answers" ? "回答" : undefined,
          }))}
          onSelect={key => {
            const cell = cells.find(item => item.rowKey === key);
            if (cell) onSelect(cell);
          }}
        />
      </ChartCard>
    );
  }
  if (chart.kind === "matrix") {
    const cells = chart.cells ?? [];
    const engines = [...new Set(cells.map(cell => cell.engine))];
    const groups = new Map<string, GeoAnalysisChartCell[]>();
    for (const cell of cells) {
      const key = JSON.stringify([cell.setVersion, cell.groupId, cell.pool]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(cell);
    }
    return (
      <ChartCard title="问题群与平台交叉实测">
        <HeatGrid
          label="问题群与平台交叉实测"
          columns={engines.map(engine => ({ key: engine, header: engineName(engine) }))}
          rows={[...groups].map(([key, items], index) => ({
            key,
            header: `${[items[0].groupName ?? "未命名问题群", items[0].setVersion != null ? `问题版本 ${items[0].setVersion}` : null, items[0].pool].filter(Boolean).join(" · ")}（组 ${index + 1}）`,
            cells: engines.map(engine => {
              const cell = items.find(item => item.engine === engine);
              const known = cell?.state === "known" && cell.value !== null;
              return {
                value: known ? cell.value : null,
                text: known ? String(cell.value) : cell ? unavailableWord(cell) : "未测",
                hint: cell ? `${cell.label}；${known ? "可在下表查看精确明细" : unavailableReason(cell)}` : "这个范围没有该平台的读数。",
              };
            }),
          }))}
        />
      </ChartCard>
    );
  }
  const lines = chart.series.map(line => ({ ...line, label: line.engine ? line.label.replace(line.engine, engineName(line.engine)) : line.label, tone: "accent" as const }));
  const range = chartScale(lines.flatMap(line => line.values)), counts = new Map<string, number>();
  for (const line of lines) counts.set(line.label, (counts.get(line.label) ?? 0) + 1);
  return <>{chart.labels.length > 1 && lines.map((line, index) => <ChartCard key={line.key} title={(counts.get(line.label) ?? 0) > 1 ? `${line.label}（同名组 ${index + 1}）` : line.label}><GeoLineChart series={[line]} labels={chart.labels} domain={range ? [range.low, range.high] : null}/></ChartCard>)}</>;
}
