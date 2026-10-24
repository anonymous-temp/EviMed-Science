import type { GeoAnalysisView, GeoAnalysisChartCell } from '@/lib/geoAnalysisClient';
import { ChartCard } from '@/components/ui/ChartCard';
import { BarList } from '@/components/charts/BarList';
import { HeatGrid } from '@/components/charts/HeatGrid';
import { GeoLineChart, chartScale } from './tabs/GeoCharts';
import { engineName } from './geoText';
/** Geometry only: every value and exact member key comes from the full server aggregate. */
export function GeoAnalysisVisual({ data, onSelect }: {
  data: GeoAnalysisView;
  onSelect(cell: GeoAnalysisChartCell): void;
}) {
  const chart = data.chart;
  if (!chart)
    return null;
  if (chart.kind === 'bars') {
    const cells = chart.cells ?? [], known = cells.filter(cell => cell.state === 'known' && cell.value !== null);
    return <ChartCard title="各平台所选实测" state={cells.length ? 'content' : 'empty'} emptyText="这个范围尚无平台读数。"><BarList label="各平台所选实测" tone="own" rows={known.map(cell => ({ key: cell.rowKey, label: cell.label.replace(cell.engine, engineName(cell.engine)), value: cell.value!, note: data.view.entityKind === 'generic' ? '回答' : undefined }))} onSelect={key => { const cell = cells.find(item => item.rowKey === key); if (cell)
      onSelect(cell); }}/></ChartCard>;
  }
  if (chart.kind === 'matrix') {
    const cells = chart.cells ?? [], engines = [...new Set(cells.map(cell => cell.engine))];
    const groups = new Map<string, GeoAnalysisChartCell[]>();
    for (const cell of cells) {
      const key = JSON.stringify([cell.setVersion, cell.groupId, cell.pool]);
      if (!groups.has(key))
        groups.set(key, []);
      groups.get(key)!.push(cell);
    }
    return <ChartCard title="问题群与平台交叉实测"><HeatGrid label="问题群与平台交叉实测" columns={engines.map(engine => ({ key: engine, header: engineName(engine) }))} rows={[...groups].map(([key, items], index) => ({ key, header: `${items[0].label.split(' · ').slice(1, -1).join(' · ')}（组 ${index + 1}）`, cells: engines.map(engine => { const cell = items.find(item => item.engine === engine); return { value: cell?.state === 'known' ? cell.value : null, text: cell?.state === 'known' && cell.value !== null ? String(cell.value) : '未测', hint: cell ? `${cell.label}；可在下表查看精确明细` : '未测' }; }) }))}/></ChartCard>;
  }
  const lines = chart.series.map(line => ({ ...line, label: line.engine ? line.label.replace(line.engine, engineName(line.engine)) : line.label, tone: 'accent' as const }));
  const range = chartScale(lines.flatMap(line => line.values)), counts = new Map<string, number>();
  for (const line of lines)
    counts.set(line.label, (counts.get(line.label) ?? 0) + 1);
  return <>{chart.labels.length > 1 && lines.map((line, index) => <ChartCard key={line.key} title={(counts.get(line.label) ?? 0) > 1 ? `${line.label}（同名组 ${index + 1}）` : line.label}><GeoLineChart series={[line]} labels={chart.labels} domain={range ? [range.low, range.high] : null}/></ChartCard>)}</>;
}
