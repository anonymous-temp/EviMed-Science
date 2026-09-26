import { useMemo, useState } from "react";
import {
  getGeoDiagnosis,
  getGeoMonitoring,
  readGeoCell,
  type GeoDiagnosis,
  type GeoMonitoring,
  type GeoProject,
  type GeoSeriesPoint,
} from "@/lib/geoClient";
import { ChartCard, LegendMark } from "@/components/ui/ChartCard";
import { DataTable, InlineBar } from "@/components/ui/DataTable";
import { Disclosure } from "@/components/ui/Disclosure";
import { FilterChips, type FilterOption } from "@/components/ui/FilterChips";
import { TrendChart } from "@/components/charts/TrendChart";
import { OWN_COLOR, TARGET_COLOR } from "@/components/charts/trendModel";
import { GeoSparkline } from "../GeoSparkline";
import { formatGeoValue, GeoCellText, geoCellWord } from "../GeoCellText";
import {
  actionMarkers,
  denominatorLine,
  pointCell,
  readingDelta,
  rivalRanking,
  statedValue,
  trendConclusion,
} from "../geoOverviewModel";
import { engineName, GEO_METRIC_NAMES, GEO_POOL_KINDS, monthDay, type GeoUnit } from "../geoText";
import { metricName, metricUnit, roundKindWord } from "./geoTabText";
import { CellLink, TabError, TabSkeleton, useGeoLoad } from "./geoTabKit";

/**
 * 可见度 — where we stand in the answers, over time.
 *
 * 「监测」 used to be a tab of its own, which meant the trend of a number was
 * somewhere other than the number. It is the horizontal axis here: pick a
 * metric and the same card shows its history, its target, what we did, and
 * when it will be measured next. Under it, the same question asked of each
 * engine and each question pool.
 */
export function VisibilityTab({ geoId, project }: { geoId: string; project: GeoProject }) {
  const monitoring = useGeoLoad<GeoMonitoring>(`visibility:monitoring:${geoId}`, () => getGeoMonitoring(geoId));
  const diagnosis = useGeoLoad<GeoDiagnosis>(`visibility:diagnosis:${geoId}`, () => getGeoDiagnosis(geoId));
  const watch = monitoring.state.kind === "ready" ? monitoring.state.data : null;
  const diag = diagnosis.state.kind === "ready" ? diagnosis.state.data : null;
  const series = (Array.isArray(watch?.series) ? watch.series : []).filter((line) => line && metricName(line.key) && Array.isArray(line.points) && line.points.length > 0);
  const [key, setKey] = useState<string | null>(null);
  const line = series.find((item) => item.key === key) ?? series[0] ?? null;

  if (monitoring.state.kind === "loading" && diagnosis.state.kind === "loading") return <TabSkeleton />;
  if (monitoring.state.kind === "error" && diagnosis.state.kind === "error") {
    return <TabError message={monitoring.state.message} onRetry={() => { monitoring.reload(); diagnosis.reload(); }} />;
  }

  const denominator = denominatorLine(project, diag);
  const options: FilterOption<string>[] = series.map((item) => ({ value: item.key, label: metricName(item.key) ?? "" }));
  const ranking = rivalRanking(project, diag);

  return (
    <div data-geo-tab="visibility" className="flex flex-col gap-6">
      {options.length > 1 && (
        <FilterChips label="指标" options={options} value={line ? line.key : options[0].value} onChange={setKey} />
      )}
      <MetricTrend project={project} watch={watch} line={line} denominator={denominator} loading={monitoring.state.kind === "loading"} />
      <ByEngine rows={watch?.byEngine} />
      <ByPool geoId={geoId} diagnosis={diag} loading={diagnosis.state.kind === "loading"} />
      <Ranking ranking={ranking} loading={diagnosis.state.kind === "loading"} />
      <MoreMetrics geoId={geoId} diagnosis={diag} />
    </div>
  );
}

/* ------------------------------------------------------------------ trend */

function MetricTrend({
  project,
  watch,
  line,
  denominator,
  loading,
}: {
  project: GeoProject;
  watch: GeoMonitoring | null;
  line: { key: string; points: GeoSeriesPoint[] } | null;
  denominator: string | null;
  loading: boolean;
}) {
  const points = line?.points ?? [];
  const unit: GeoUnit = metricUnit(line?.key);
  const name = metricName(line?.key) ?? GEO_METRIC_NAMES.gvi;
  const target = project.overview.metrics.find((metric) => metric.key === line?.key || GEO_METRIC_NAMES[metric.key] === name)?.target ?? null;
  const format = (value: number) => formatGeoValue(value, unit);
  const input = useMemo(() => ({
    labels: points.map((point) => monthDay(point.date) ?? ""),
    own: { name: project.product?.brandName || project.name, values: points.map(statedValue) },
    target,
    targetLabel: target === null ? null : `目标 ${format(target)}`,
    markers: actionMarkers(points.map((point) => point.date), watch),
    nextLabel: watch?.next?.date ? `${monthDay(watch.next.date)} ${roundKindWord(watch.next.kind) ?? "复测"}` : null,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [line, watch, target, project.name]);
  const latest = pointCell(points[points.length - 1]);
  const delta = readingDelta(points.map(statedValue));

  return (
    <ChartCard
      title={trendConclusion(name, points.length ? latest : null, delta, null, unit)}
      legend={(
        <>
          <LegendMark series="own" color={OWN_COLOR}>{project.product?.brandName || project.name}</LegendMark>
          {target !== null && <LegendMark series="target" shape="dash" color={TARGET_COLOR}>目标</LegendMark>}
        </>
      )}
      meta={watch?.next?.date ? `下次 ${monthDay(watch.next.date)}` : undefined}
      state={loading ? "loading" : points.length === 0 ? "empty" : "content"}
      emptyText="还没有开始持续监测，第一次复测后这里会画出趋势。"
      footnote={denominator}
      height={260}
    >
      <TrendChart input={input} format={format} label={`${name}趋势`} height={260} />
    </ChartCard>
  );
}

/* ----------------------------------------------------------- per engine */

function ByEngine({ rows }: { rows: GeoMonitoring["byEngine"] | null | undefined }) {
  const lines = (Array.isArray(rows) ? rows : []).filter((row) => row && row.engine && Array.isArray(row.points) && row.points.length > 0);
  if (lines.length === 0) return null;
  return (
    <ChartCard title="各引擎的走势">
      <ul className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
        {lines.map((row) => {
          const unit: GeoUnit = row.points.some((point) => typeof point.k === "number") ? "percent" : "index";
          const last = row.points[row.points.length - 1];
          return (
            <li key={row.engine} data-geo-engine-trend={row.engine} className="flex min-w-0 flex-col gap-1">
              <span className="truncate text-compact text-text-2">{engineName(row.engine)}</span>
              <GeoCellText cell={pointCell(last)} unit={unit} layout="stack" />
              <GeoSparkline values={row.points.map(statedValue)} width={140} height={28} className="mt-1 w-full" />
            </li>
          );
        })}
      </ul>
    </ChartCard>
  );
}

/* -------------------------------------------------------------- per pool */

function ByPool({ geoId, diagnosis, loading }: { geoId: string; diagnosis: GeoDiagnosis | null; loading: boolean }) {
  const rows = (Array.isArray(diagnosis?.byPool) ? diagnosis.byPool : []).filter((row) => row && row.pool);
  const top = rows.reduce((max, row) => Math.max(max, readGeoCell(row.mention).value ?? 0), 0);
  return (
    <ChartCard
      title="哪一类问题里最容易被提到"
      state={loading ? "loading" : rows.length === 0 ? "empty" : "content"}
      emptyText="还没有按问句池测过提及率。"
      height={200}
    >
      <DataTable
        label="按问句池的品牌提及率"
        rows={rows}
        rowKey={(row) => row.pool}
        rowAttrs={(row) => ({ "data-geo-pool": row.pool })}
        columns={[
          { key: "pool", header: "问句池", rowHeader: true, cell: (row) => GEO_POOL_KINDS[row.pool] ?? "—" },
          {
            key: "bar",
            header: "",
            width: "w-32",
            cell: (row) => <InlineBar value={readGeoCell(row.mention).value} max={top} tone="own" label={`${GEO_POOL_KINDS[row.pool] ?? row.pool} 的品牌提及率`} />,
          },
          {
            key: "mention",
            header: "品牌提及率",
            align: "right",
            width: "w-24",
            cell: (row) => <CellLink geoId={geoId} cell={readGeoCell(row.mention)} className="inline-flex justify-end" label={`${GEO_POOL_KINDS[row.pool] ?? row.pool}的品牌提及率`} />,
          },
          {
            key: "rival",
            header: "头部竞品",
            cell: (row) => row.topCompetitor || "—",
            isEmpty: (row) => !row.topCompetitor,
          },
          {
            key: "issue",
            header: "主要问题",
            cell: (row) => <span className="block max-w-measure">{row.mainIssue || "—"}</span>,
            isEmpty: (row) => !row.mainIssue,
          },
        ]}
      />
    </ChartCard>
  );
}

/* --------------------------------------------------------------- ranking */

function Ranking({ ranking, loading }: { ranking: ReturnType<typeof rivalRanking>; loading: boolean }) {
  const top = ranking.reduce((max, row) => Math.max(max, row.value ?? 0), 0);
  const ours = ranking.find((row) => row.ours) ?? null;
  const place = ours ? ranking.indexOf(ours) + 1 : 0;
  return (
    <ChartCard
      title={ours && place > 0 ? `在 ${ranking.length} 个同类药里排第 ${place}` : "同类药提及率"}
      state={loading ? "loading" : ranking.length === 0 ? "empty" : "content"}
      emptyText="这一轮还没有测到同类药的提及率。"
      height={180}
    >
      <DataTable
        label="同类药提及率"
        rows={ranking}
        rowKey={(row) => row.key}
        highlight={(row) => row.ours}
        rowAttrs={(row) => ({ "data-rank-row": row.key })}
        columns={[
          { key: "name", header: "同类药", rowHeader: true, cell: (row) => <>{row.name}{row.ours && <span className="ml-1.5 text-caption text-accent-strong">本品</span>}</> },
          { key: "scope", header: "读数范围", cell: (row) => row.scope },
          { key: "bar", header: "", width: "w-40", cell: (row) => <InlineBar value={row.value} max={top} tone={row.ours ? "own" : "rival"} label={`${row.name} 提及率`} /> },
          { key: "value", header: "提及率", align: "right", width: "w-20", cell: (row) => (row.value === null ? geoCellWord(null) : `${Math.round(row.value)}%`) },
        ]}
      />
    </ChartCard>
  );
}

/* ----------------------------------------------------------- more metrics */

/**
 * Everything else the round measured, folded: the index's other dimensions and
 * the fluctuation band the page judges every change against. It is folded
 * because a reader needs it to check a judgement, not to make one.
 */
function MoreMetrics({ geoId, diagnosis }: { geoId: string; diagnosis: GeoDiagnosis | null }) {
  const rows = (Array.isArray(diagnosis?.more) ? diagnosis.more : []).filter((row) => row && row.name);
  const noise = diagnosis?.noise && typeof diagnosis.noise.band === "number" ? diagnosis.noise : null;
  if (rows.length === 0 && !noise) return null;
  return (
    <Disclosure summary="更多指标">
      <ul className="flex flex-col divide-y divide-faint">
        {rows.map((row) => {
          const cell = readGeoCell(row.cell);
          return (
            <li key={row.metricId || row.name} data-geo-metric={row.metricId} className="flex items-center gap-3 py-2">
              <span className="min-w-0 flex-1 text-ui text-text">{metricName(row.metricId) ?? row.name}</span>
              <CellLink geoId={geoId} cell={cell} unit={metricUnit(row.metricId)} label={row.name} />
            </li>
          );
        })}
        {noise && (
          <li className="flex items-center gap-3 py-2">
            <span className="min-w-0 flex-1 text-ui text-text">波动范围</span>
            <span className="text-ui tabular-nums text-text">{`±${Math.round(noise.band * 10) / 10}`}</span>
            {noise.measuredAt && <span className="text-caption text-text-3">{`${monthDay(noise.measuredAt)}测`}</span>}
          </li>
        )}
      </ul>
    </Disclosure>
  );
}
