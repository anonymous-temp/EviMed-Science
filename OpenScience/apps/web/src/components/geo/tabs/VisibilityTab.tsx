import { ValueSection } from "./ValueSection";
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
  comparableRun,
  chartDates,
  engineTrendConclusion,
  denominatorLine,
  pointCell,
  readingChange,
  rivalRanking,
  statedValue,
  trendConclusion,
  withCoverageMarker,
} from "../geoOverviewModel";
import { absentWord, engineName, GEO_METRIC_NAMES, GEO_POOL_KINDS, monthDay, type GeoUnit } from "../geoText";
import { metricName, metricUnit, roundKindWord } from "./geoTabText";
import { CellLink, TabError, TabSkeleton, useGeoLoad } from "./geoTabKit";

/**
 * 可见度 — where we stand in the answers, over time.
 *
 * “监测” used to be a tab of its own, which meant the trend of a number was
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
      <ValueSection geoId={geoId} project={project} mode="coverage" />
      {options.length > 1 && (
        <FilterChips label="指标" options={options} value={line ? line.key : options[0].value} onChange={setKey} />
      )}
      <MetricTrend
        project={project}
        watch={watch}
        line={line}
        denominator={denominator}
        // The fluctuation band was measured on the mention rate and belongs to it alone.
        noise={line?.key === "mention" && typeof diag?.noise?.band === "number" ? diag.noise.band : null}
        loading={monitoring.state.kind === "loading"}
      />
      <ByEngine rows={watch?.byEngine} diagnosis={diag} />
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
  noise,
  loading,
}: {
  project: GeoProject;
  watch: GeoMonitoring | null;
  line: { key: string; points: GeoSeriesPoint[] } | null;
  denominator: string | null;
  noise: number | null;
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
    // Rivals are measured on our mention rate's own questions (M-16 beside
    // M-01S), so they are drawn on that chart and on no other.
    rivals: line?.key === "mention" ? rivalLines(watch?.rivals, points.map((point) => point.date)) : [],
    target,
    targetLabel: target === null ? null : `目标 ${format(target)}`,
    markers: withCoverageMarker(actionMarkers(points.map((point) => point.date), watch), points),
    nextLabel: watch?.next?.date ? `${monthDay(watch.next.date)} ${roundKindWord(watch.next.kind) ?? "复测"}` : null,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [line, watch, target, project.name]);
  const latest = pointCell(points[points.length - 1]);
  // The same rule as 总览 states the same change by.
  const change = readingChange(points, { noise });

  return (
    <ChartCard
      title={trendConclusion(name, points.length ? latest : null, change, unit)}
      legend={(
        <>
          <LegendMark series="own" color={OWN_COLOR}>{project.product?.brandName || project.name}</LegendMark>
          {target !== null && <LegendMark series="target" shape="dash" color={TARGET_COLOR}>目标</LegendMark>}
        </>
      )}
      meta={chartDates(change, watch?.next?.date)}
      state={loading ? "loading" : points.length === 0 ? "empty" : "content"}
      emptyText="还没有开始持续监测，第一次复测后这里会画出趋势。"
      footnote={denominator}
      height={260}
    >
      <TrendChart input={input} format={format} label={`${name}趋势`} height={260} integer bounds={[0, 100]} />
    </ChartCard>
  );
}

/**
 * Each rival's readings placed on our series' dates, a missing one a gap, the
 * highest latest reading first — so the darkest grey is the strongest rival.
 */
export function rivalLines(
  rivals: GeoMonitoring["rivals"] | null | undefined,
  dates: readonly string[],
): Array<{ name: string; values: Array<number | null> }> {
  return (Array.isArray(rivals) ? rivals : [])
    .filter((rival) => rival && rival.name && Array.isArray(rival.points))
    .map((rival) => ({
      name: rival.name,
      values: dates.map((date) => {
        const point = rival.points.find((entry) => entry && entry.date === date);
        return point ? statedValue(point) : null;
      }),
    }))
    .filter((rival) => rival.values.some((value) => value !== null))
    .sort((left, right) => (latest(right.values) ?? -1) - (latest(left.values) ?? -1));
}

function latest(values: ReadonlyArray<number | null>): number | null {
  for (let index = values.length - 1; index >= 0; index -= 1) if (values[index] !== null) return values[index];
  return null;
}

/* ----------------------------------------------------------- per engine */

/**
 * Each engine's latest reading and, beside it, how it has gone. An engine whose latest round has no stated reading draws no line:
 * the earlier points of a series are history, and a lone dot of them under a 「—」 reads as today's. It says why instead — the
 * round's own reason when the engine did not answer, else the last reading it has and when.
 */
function ByEngine({ rows, diagnosis }: { rows: GeoMonitoring["byEngine"] | null | undefined; diagnosis: GeoDiagnosis | null }) {
  const lines = (Array.isArray(rows) ? rows : []).filter((row) => row && row.engine && Array.isArray(row.points) && row.points.length > 0);
  if (lines.length === 0) return null;
  // The latest round any engine was read in: a line that stops before it has no reading now.
  const currentDate = lines.reduce((top, row) => {
    const date = row.points[row.points.length - 1]?.date ?? "";
    return date > top ? date : top;
  }, "");
  const absent = new Map((Array.isArray(diagnosis?.round?.absent) ? diagnosis.round.absent : [])
    .filter((entry) => entry && entry.engine).map((entry) => [entry.engine, absentWord(entry.reason)]));
  return (
    <ChartCard title={engineTrendConclusion(lines)}>
      <ul className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
        {lines.map((row) => {
          const unit: GeoUnit = row.points.some((point) => typeof point.k === "number") ? "percent" : "index";
          const last = row.points[row.points.length - 1];
          const current = last.date === currentDate;
          const reading = current && statedValue(last) !== null;
          const earlier = [...row.points].reverse().find((point) => statedValue(point) !== null) ?? null;
          const why = absent.has(row.engine)
            ? (absent.get(row.engine) ? `本轮未测：${absent.get(row.engine)}` : "本轮未测")
            : earlier && !reading ? `上次 ${formatGeoValue(statedValue(earlier) as number, unit)} · ${monthDay(earlier.date)}` : null;
          return (
            <li key={row.engine} data-geo-engine-trend={row.engine} className="flex min-w-0 flex-col gap-1">
              <span className="truncate text-compact text-text-2">{engineName(row.engine)}</span>
              <GeoCellText cell={current ? pointCell(last) : pointCell(undefined)} unit={unit} layout="stack" />
              {reading
                ? <GeoSparkline values={comparableRun(row.points).map(statedValue)} width={140} height={28} className="mt-1 w-full" />
                : why && <span data-geo-engine-why="" className="text-caption text-text-3">{why}</span>}
            </li>
          );
        })}
      </ul>
    </ChartCard>
  );
}

/* -------------------------------------------------------------- per pool */

/**
 * Mention by question pool. The risk-monitoring pool is not a row: being named
 * there is not the aim (G19), so its line is the rate at which a risk question
 * is answered with a recommendation of us (M-15), under the table. A 主要问题
 * that is the same on every row is said once, under it, rather than repeated
 * in a column.
 */
function ByPool({ geoId, diagnosis, loading }: { geoId: string; diagnosis: GeoDiagnosis | null; loading: boolean }) {
  const rows = (Array.isArray(diagnosis?.byPool) ? diagnosis.byPool : []).filter((row) => row && row.pool && row.pool !== "P4");
  const top = rows.reduce((max, row) => Math.max(max, readGeoCell(row.mention).value ?? 0), 0);
  const issues = rows.map((row) => row.mainIssue || null);
  const sameIssue = rows.length > 1 && issues[0] !== null && issues.every((issue) => issue === issues[0]) ? issues[0] : null;
  const risk = (Array.isArray(diagnosis?.more) ? diagnosis.more : []).find((row) => row && row.metricId === "M-15" && !row.rival && !row.variant) ?? null;
  const footnote = risk || sameIssue ? (
    <span className="flex flex-col gap-1">
      {risk && (
        <span data-geo-risk-line="" className="inline-flex flex-wrap items-baseline gap-x-1.5">
          {`${GEO_POOL_KINDS.P4}问题里，${metricName("M-15") ?? risk.name}`}
          <CellLink geoId={geoId} cell={readGeoCell(risk.cell)} layout="inline" label={metricName("M-15") ?? risk.name} />
          （越低越好）
        </span>
      )}
      {sameIssue && <span>{`各类问题的主要问题都是“${sameIssue}”`}</span>}
    </span>
  ) : null;
  return (
    <ChartCard
      title="哪一类问题里最容易被提到"
      state={loading ? "loading" : rows.length === 0 ? "empty" : "content"}
      emptyText="还没有按问句池测过提及率。"
      footnote={footnote}
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
            header: <span className="sr-only">品牌提及率图示</span>,
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
            isEmpty: (row) => !row.mainIssue || sameIssue !== null,
          },
        ]}
      />
    </ChartCard>
  );
}

/* --------------------------------------------------------------- ranking */

function Ranking({ ranking, loading }: { ranking: ReturnType<typeof rivalRanking>; loading: boolean }) {
  // Nobody measured a rival: no empty card to say so.
  if (ranking.length === 0 && !loading) return null;
  const top = ranking.reduce((max, row) => Math.max(max, row.value ?? 0), 0);
  const ours = ranking.find((row) => row.ours) ?? null;
  const place = ours ? ranking.indexOf(ours) + 1 : 0;
  // Every rate over the same questions: the range is said once, not per row.
  const scope = ranking.length > 0 && ranking.every((row) => row.scope === ranking[0].scope) ? ranking[0].scope : null;
  return (
    <ChartCard
      title={ours && place > 0 ? `提及率在 ${ranking.length} 个同类药里排第 ${place}` : "同类药提及率"}
      state={loading ? "loading" : ranking.length === 0 ? "empty" : "content"}
      emptyText="这一轮还没有测到同类药的提及率。"
      footnote={scope ? `都按${scope}计算` : undefined}
      height={180}
    >
      <DataTable
        label="同类药提及率"
        rows={ranking}
        rowKey={(row) => row.key}
        highlight={(row) => row.ours}
        rowAttrs={(row) => ({ "data-rank-row": row.key })}
        columns={[
          { key: "name", header: "同类药", rowHeader: true, cell: (row) => <>{row.name}{row.ours && <span className="ml-1.5 text-caption font-normal text-accent-strong">本品</span>}</> },
          { key: "scope", header: "读数范围", cell: (row) => <span className="text-text-3">{row.scope}</span>, isEmpty: () => scope !== null },
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
  // A rival's row is in the ranking and a variant's is its metric again: one
  // name, one line.
  const rows = (Array.isArray(diagnosis?.more) ? diagnosis.more : []).filter((row) => row && row.name && !row.rival && !row.variant);
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
