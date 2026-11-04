import { geoAutomationEnabled, geoCoverageDifference } from "@evimed/domain";
import { useLocation } from "react-router";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  readGeoCell,
  type GeoDiagnosis,
  type GeoEngine,
  type GeoMonitoring,
  type GeoPool,
  type GeoProject,
  type GeoSeriesPoint,
} from "@/lib/geoClient";
import { ChartCard, LegendMark, type ChartSelector } from "@/components/ui/ChartCard";
import { DataTable, InlineBar } from "@/components/ui/DataTable";
import { Disclosure } from "@/components/ui/Disclosure";
import type { FilterOption } from "@/components/ui/FilterChips";
import { TrendChart } from "@/components/charts/TrendChart";
import { OWN_COLOR, TARGET_COLOR } from "@/components/charts/trendModel";
import { GeoSparkline } from "../GeoSparkline";
import { GeoComparison } from "../GeoComparison";
import { GeoPairedRivalsView, useGeoPairedRivals } from "../GeoPairedRivals";
import { useGeoFrame, useGeoToolbar } from "../geoFrame";
import { nextMeasurement } from "../geoBand";
import { readFailure, useGeoDiagnosis, useGeoMonitoring, useGeoStrategy, type ReadFailure } from "../geoProjectData";
import { GeoOverviewMetrics } from "../GeoOverviewMetrics";
import { ClusterDrawerHost } from "../spine/ClusterDrawerHost";
import { clusterName } from "../spine/clusterModel";
import { GEO_CLUSTER_FILTER_PARAM, GEO_ENGINE_PARAM, GEO_POOL_PARAM, useGeoDrawerAddress, useGeoSearchChange, useGeoSearchParam } from "../spine/drawerParams";
import { useGeoClusters, useGeoQuestionCatalog } from "../spine/spineData";
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
  scheduledAfterObservations,
  statedValue,
  trendConclusion,
  withCoverageMarker,
} from "../geoOverviewModel";
import { absentWord, engineName, GEO_METRIC_NAMES, GEO_POOL_KINDS, monthDay, poolName, type GeoUnit } from "../geoText";
import { geoSectionId } from "../geoTabs";
import { metricName, metricUnit, roundKindWord } from "./geoTabText";
import { CellLink, TabError, TabSkeleton } from "./geoTabKit";
import { ClusterMatrixCard, EngineHeatCard, EngineMetricCard, isEngineBarMetric, orderedGroups, poolsOf } from "./VisibilityBlocks";

/**
 * 可见度 — where we stand in the answers, over time (R19, audit C §2.3).
 *
 * “监测” used to be a tab of its own, which meant the trend of a number was somewhere other than the number. It is the horizontal
 * axis here: pick a metric and the page shows its history, its target, what we did, and when it will be measured next — and the
 * same metric is the ringed column of the engine grid under it and the bars of the engines' card. Under those, the engines against
 * the rates, which question groups each engine names us in (counts), the pools, and the rivals.
 *
 * The metric and supported comparison stay with the trend; the shared toolbar carries the observation scope. Their URL state keeps
 * the reader's choice across navigation (`trendMetric`, `compareBy`, `engine`, `pool` and `cluster`).
 */
/**
 * Component: VisibilityTab; owner: GEO; rules: DS23.
 * Anatomy: Metric trend, engine and group readings, pools, rivals and monitoring.
 * Variants: Metric and eligible competitor comparison beside the trend; scoped engine, pool and group filters.
 * States: Independent diagnosis/monitoring loading, partial failure/retry and unmeasured baselines.
 * Hit area: Shared controls retain their standard targets.
 * Keyboard: Native controls preserve Tab and activation behavior.
 * Long content: Text wraps within the available reading width.
 * Theme: Shared surface, border and ink tokens.
 * Responsive: Content follows the parent workspace width.
 * Verification: Focused component behavior tests and fixture walkthrough.
 */
export function VisibilityTab({ geoId, project, analysisSelector }: { geoId: string; project: GeoProject; analysisSelector?: ReactNode }) {
  const frame = useGeoFrame();
  const { hash } = useLocation();
  const openedForProject = useRef<string | null>(null);
  useEffect(() => {
    if (hash !== "#geo-automation") {
      openedForProject.current = null;
    } else if (frame && openedForProject.current !== geoId) {
      openedForProject.current = geoId;
      frame.openPanel("settings");
    }
  }, [hash, geoId, frame]);
  const automationStatus = project.status === "paused" ? (geoAutomationEnabled(project) ? "项目已暂停 · 自动监测已配置" : "项目已暂停 · 自动监测未开启") : geoAutomationEnabled(project) ? "已开启自动监测" : project.steps.monitoring?.automation?.state === "confirmed" ? "监测范围已变更，自动监测未开启" : project.steps.monitoring?.automation?.state === "declined" ? "自动监测已关闭" : "自动监测未开启";
  const automation = <div className="flex flex-wrap items-center gap-3 text-ui"><span>{automationStatus}</span><a href="#geo-automation" className="text-link hover:underline" onClick={(event) => { if (frame) { event.preventDefault(); frame.openPanel("settings"); } }}>监测设置</a></div>;
  const monitoring = useGeoMonitoring(geoId);
  const diagnosis = useGeoDiagnosis(geoId);
  const strategy = useGeoStrategy(geoId);
  const clusters = useGeoClusters(geoId);
  const catalog = useGeoQuestionCatalog(geoId);
  const drawer = useGeoDrawerAddress();
  const [engineParam, setEngineParam] = useGeoSearchParam(GEO_ENGINE_PARAM);
  const [poolParam] = useGeoSearchParam(GEO_POOL_PARAM);
  const [clusterParam, setClusterParam] = useGeoSearchParam(GEO_CLUSTER_FILTER_PARAM);
  const change = useGeoSearchChange();
  const watch = monitoring.state.kind === "ready" ? monitoring.state.data : null;
  const diag = diagnosis.state.kind === "ready" ? diagnosis.state.data : null;
  const series = (Array.isArray(watch?.series) ? watch.series : []).filter((line) => line && metricName(line.key) && Array.isArray(line.points) && line.points.length > 0);
  const [key, setKey] = useGeoSearchParam("trendMetric");
  const [compareBy, setCompareBy] = useGeoSearchParam("compareBy");
  const line = series.find((item) => item.key === key) ?? series[0] ?? null;
  const options: FilterOption<string>[] = series.map((item) => ({ value: item.key, label: metricName(item.key) ?? "" }));

  const groups = useMemo(() => orderedGroups(clusters.state.kind === "ready" && Array.isArray(clusters.state.data?.groups) ? clusters.state.data.groups : []), [clusters.state]);
  const groupEngines = (clusters.state.kind === "ready" && Array.isArray(clusters.state.data?.engines) && clusters.state.data.engines.length > 0 ? clusters.state.data.engines : project.engines) as GeoEngine[];
  const engines = useMemo(() => {
    const seen = [...project.engines, ...(Array.isArray(diag?.byEngine) ? diag.byEngine.map((row) => row.engine) : []), ...groupEngines];
    return seen.filter((engine, at) => engine && seen.indexOf(engine) === at);
  }, [project.engines, diag, groupEngines]);
  const engine = engineParam && engines.includes(engineParam as GeoEngine) ? engineParam : null;
  const catalogGroups = useMemo(() => [...new Map([
    ...(catalog.state.kind === "ready" ? catalog.state.data.groups : []), ...groups,
  ].map(group => [group.id, group])).values()], [catalog.state, groups]);
  const pools = useMemo(() => poolsOf(catalogGroups), [catalogGroups]);
  const pool = poolParam && pools.some((entry) => entry.value === poolParam) ? (poolParam as GeoPool) : null;
  const inPool = useMemo(() => (pool ? groups.filter((row) => row.pool === pool) : groups), [groups, pool]);
  const groupOptions = useMemo(() => pool ? catalogGroups.filter(row => row.pool === pool) : catalogGroups, [catalogGroups, pool]);
  const cluster = clusterParam && groupOptions.some(row => row.id === clusterParam) ? clusterParam : null;
  const shownGroups = useMemo(() => (cluster ? inPool.filter((row) => row.id === cluster) : inPool), [inPool, cluster]);
  const narrowed = engine !== null || pool !== null || cluster !== null;
  const metric = line ? line.key : null;

  useGeoToolbar(engines.length > 1 || pools.length > 1 || groupOptions.length > 1 ? {
    filters: [
      ...(engines.length > 1 ? [{
        kind: "select" as const, folded: true,
        label: "引擎",
        allLabel: "全部引擎",
        options: engines.map((name) => ({ value: name, label: engineName(name) })),
        value: engine,
        onChange: setEngineParam,
      }] : []),
      ...(pools.length > 1 || pool ? [{
        kind: "select" as const, folded: true,
        label: "问句池",
        allLabel: "全部问句池",
        options: pools,
        value: pool,
        // a pool takes the group it holds with it, in one step
        onChange: (value: string | null) => change({ [GEO_POOL_PARAM]: value, [GEO_CLUSTER_FILTER_PARAM]: null }),
      }] : []),
      ...(groupOptions.length > 1 || cluster ? [{
        kind: "select" as const, folded: true,
        label: "问题群",
        allLabel: "全部问题群",
        options: groupOptions.map((row) => ({ value: row.id, label: clusterName(row) })),
        value: cluster,
        onChange: setClusterParam,
      }] : []),
    ],
    onClear: narrowed ? () => change({ [GEO_ENGINE_PARAM]: null, [GEO_POOL_PARAM]: null, [GEO_CLUSTER_FILTER_PARAM]: null }) : undefined,
  } : null);

  if (monitoring.state.kind === "loading" && diagnosis.state.kind === "loading") return <>{analysisSelector}{automation}<TabSkeleton /></>;
  if (monitoring.state.kind === "error" && diagnosis.state.kind === "error") {
    return <>{analysisSelector}{automation}<TabError message={monitoring.state.message} onRetry={() => { monitoring.reload(); diagnosis.reload(); }} /></>;
  }

  const denominator = denominatorLine(project, diag);
  const ranking = rivalRanking(project, diag);
  // One read failing leaves the others on the page; each block that reads it says so, with 重试, instead of its empty sentence.
  const monitoringFailed = readFailure(monitoring);
  const diagnosisFailed = readFailure(diagnosis);
  // Competitor measurements are on mention rate only. Do not imply a ranking belongs to another metric.
  const compareRivals = metric === "mention" && compareBy !== "none";
  const canCompareRivals = metric === "mention" && (ranking.length > 1 || Boolean(watch?.rivals?.length));
  const showComparison = metric !== "mention" || compareRivals;

  const trend = (
      <MetricTrend
        selectors={[
          ...(options.length > 1 ? [{ label: "分析指标", value: metric, options, onChange: setKey }] : []),
          ...(canCompareRivals ? [{ label: "比较", value: compareRivals ? "rivals" : "none", options: [{ value: "rivals", label: "同类药" }, { value: "none", label: "不比较" }], onChange: (value: string | null) => setCompareBy(value === "none" ? "none" : null) }] : []),
        ]}
        project={project}
        watch={watch}
        line={line}
        denominator={denominator}
        compareRivals={compareRivals}
        // The fluctuation band was measured on the mention rate and belongs to it alone.
        noise={line?.key === "mention" && typeof diag?.noise?.band === "number" ? diag.noise.band : null}
        loading={monitoring.state.kind === "loading"}
        error={monitoringFailed}
      />
  );

  return (
    <div data-geo-tab="visibility" className="flex flex-col gap-6">
      {analysisSelector}
      <GeoOverviewMetrics geoId={geoId} project={project} diagnosis={diagnosis} strategy={strategy} compact />
      {showComparison ? <TrendAndRivals geoId={geoId} trend={trend} /> : <div data-geo-trend-ranking="">{trend}</div>}
      {strategy.state.kind === "error" && <TabError message={`目标信息没有读到：${strategy.state.message}`} onRetry={strategy.reload} />}
      {strategy.state.kind === "ready" && strategy.state.refreshError && <TabError message={`目标信息更新失败，仍显示上次结果：${strategy.state.refreshError}`} onRetry={strategy.reload} />}
      <GeoComparison geoId={geoId} view={project} />
      <PoolRivalTrends project={project} rivals={watch?.rivals} />
      <EngineHeatCard project={project} diagnosis={diag} loading={diagnosis.state.kind === "loading"} metric={metric} engine={engine} error={diagnosisFailed} />
      {isEngineBarMetric(metric)
        ? <EngineMetricCard diagnosis={diag} metric={metric} selected={engine} onSelect={setEngineParam} />
        : <ByEngine rows={watch?.byEngine} diagnosis={diag} engine={engine} />}
      <ClusterMatrixCard
        groups={shownGroups}
        engines={groupEngines}
        engine={engine}
        onOpen={(groupId, on) => drawer.open({ group: groupId, engine: on })}
        error={readFailure(clusters)}
      />
      <ByPool geoId={geoId} diagnosis={diag} loading={diagnosis.state.kind === "loading"} pool={pool} error={diagnosisFailed} />
      <MoreMetrics geoId={geoId} diagnosis={diag} />
      {automation}
      <ClusterDrawerHost geoId={geoId} project={project} />
    </div>
  );
}

/** Reserve the comparison column while loading; an established empty result becomes a full-width note. */
function TrendAndRivals({ geoId, trend }: { geoId: string; trend: ReactNode }) {
  const comparison = useGeoPairedRivals(geoId);
  const paired = comparison.state.kind !== "ready" || comparison.state.data.pairs.length > 0;
  return <div data-geo-trend-ranking="" className={paired ? "grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]" : "grid grid-cols-1 gap-4"}>
    {trend}<GeoPairedRivalsView comparison={comparison} />
  </div>;
}

/* ------------------------------------------------------------------ trend */

function MetricTrend({
  selectors,
  project,
  watch,
  line,
  denominator,
  compareRivals,
  noise,
  loading,
  error,
}: {
  selectors: readonly ChartSelector[];
  project: GeoProject;
  watch: GeoMonitoring | null;
  line: { key: string; points: GeoSeriesPoint[] } | null;
  denominator: string | null;
  compareRivals: boolean;
  noise: number | null;
  loading: boolean;
  /** The monitoring did not come: the card says so, never 「还没有开始持续监测」. */
  error: ReadFailure | null;
}) {
  const points = line?.points ?? [];
  const comparablePoints = points.every((point,index) => index === 0 || statedValue(point) === null || statedValue(points[index-1]) === null || geoCoverageDifference(points[index-1].coverage,point.coverage).comparable);
  const unit: GeoUnit = metricUnit(line?.key);
  const name = metricName(line?.key) ?? GEO_METRIC_NAMES.gvi;
  const target = project.overview.metrics.find((metric) => metric.key === line?.key || GEO_METRIC_NAMES[metric.key] === name)?.target ?? null;
  const format = (value: number) => formatGeoValue(value, unit);
  const next = nextMeasurement(project, watch);
  const input = useMemo(() => ({
    labels: points.map((point) => monthDay(point.date) ?? ""),
    own: { name: project.product?.brandName || project.name, values: points.map(statedValue) },
    // Rivals are measured on our mention rate's own questions (M-16 beside
    // M-01S), so they are drawn on that chart and on no other.
    rivals: compareRivals ? rivalLines(watch?.rivals?.filter(rival => !rival.pool), points.map((point) => point.date)) : [],
    target,
    targetLabel: target === null ? null : `目标 ${format(target)}`,
    markers: withCoverageMarker(actionMarkers(points.map((point) => point.date), watch), points),
    nextLabel: next && scheduledAfterObservations(next.date, points.map(point => point.date)) ? `${monthDay(next.date)} 计划${roundKindWord(next.kind) ?? "复测"}` : null,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [line, watch, next, target, project.name, compareRivals]);
  const latest = pointCell(points[points.length - 1]);
  // The same rule as 总览 states the same change by.
  const change = readingChange(points, { noise });

  return (
    // The block the rail's 「监测」 scrolls to (`GEO_TAB_SECTIONS`).
    <div id={geoSectionId("trend")}>
      <ChartCard
        title={loading && points.length === 0 ? "正在读取趋势" : error && points.length === 0 ? `${name}趋势暂时无法读取` : points.length === 0 ? `${name}暂无趋势记录` : trendConclusion(name, latest, change, unit)}
        legend={points.length > 0 ? (
          <>
            <LegendMark series="own" color={OWN_COLOR}>{project.product?.brandName || project.name}</LegendMark>
            {target !== null && <LegendMark series="target" shape="dash" color={TARGET_COLOR}>目标</LegendMark>}
          </>
        ) : undefined}
        selectors={selectors}
        meta={chartDates(change, next?.date)}
        state={loading ? "loading" : error && points.length === 0 ? "error" : points.length === 0 ? "empty" : "content"}
        errorMessage={error ? `测量趋势没有读到：${error.message}` : undefined}
        onRetry={error?.retry}
        emptyText="所选范围还没有可用的趋势记录。"
        footnote={denominator}
        height={260}
      >
        <TrendChart input={input} format={format} label={`${name}趋势`} height={260} integer bounds={[0, 100]} connectLines={comparablePoints} />
        {!comparablePoints && <div><p>判定版本或测量范围未知或不一致，各期读数不连线比较。</p><details><summary>查看各期读数</summary><ol aria-label={`${name}历史读数`}>{points.map((point,index) => <li key={`${point.date}-${index}`}>{point.date}：{statedValue(point) === null ? "未知" : format(statedValue(point) as number)}</li>)}</ol></details></div>}
      </ChartCard>
    </div>
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
function ByEngine({ rows, diagnosis, engine }: { rows: GeoMonitoring["byEngine"] | null | undefined; diagnosis: GeoDiagnosis | null; engine: string | null }) {
  const lines = (Array.isArray(rows) ? rows : []).filter((row) => row && row.engine && Array.isArray(row.points) && row.points.length > 0 && (!engine || row.engine === engine));
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
              <span className="truncate text-ui text-text-2">{engineName(row.engine)}</span>
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
function ByPool({ geoId, diagnosis, loading, pool, error }: { geoId: string; diagnosis: GeoDiagnosis | null; loading: boolean; pool: GeoPool | null; error: ReadFailure | null }) {
  const rows = (Array.isArray(diagnosis?.byPool) ? diagnosis.byPool : []).filter((row) => row && row.pool && row.pool !== "P4" && (!pool || row.pool === pool));
  const top = rows.reduce((max, row) => Math.max(max, readGeoCell(row.mention).value ?? 0), 0);
  const issues = rows.map((row) => row.mainIssue || null);
  const sameIssue = rows.length > 1 && issues[0] !== null && issues.every((issue) => issue === issues[0]) ? issues[0] : null;
  const risk = (Array.isArray(diagnosis?.more) ? diagnosis.more : []).find((row) => row && row.metricId === "M-15" && !row.rival && !row.variant) ?? null;
  const footnote = risk || sameIssue ? (
    <span className="flex flex-col gap-1">
      {risk && (
        <span data-geo-risk-line="">
          {`${GEO_POOL_KINDS.P4}问题里，${metricName("M-15") ?? risk.name} `}
          <CellLink geoId={geoId} cell={readGeoCell(risk.cell)} layout="inline" label={metricName("M-15") ?? risk.name} />
          {" （越低越好）"}
        </span>
      )}
      {sameIssue && <span>{`各类问题的主要问题都是“${sameIssue}”`}</span>}
    </span>
  ) : null;
  return (
    <ChartCard
      title="哪一类问题里最容易被提到"
      state={loading ? "loading" : error && !diagnosis ? "error" : rows.length === 0 ? "empty" : "content"}
      errorMessage={error ? `按问句池的提及率没有读到：${error.message}` : undefined}
      onRetry={error?.retry}
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

/**
 * Legacy summary readings do not retain a paired cohort. They remain readable with their source scope but are not ranked.
 * The current visibility page uses the cohort-paired V08 analysis instead.
 */
export function Ranking({ ranking, loading, compact = false, error = null }: {
  ranking: ReturnType<typeof rivalRanking>;
  loading: boolean;
  compact?: boolean;
  /** The diagnosis did not come: a ranking nobody could read is said as such, not left out as if nobody measured a rival. */
  error?: ReadFailure | null;
}) {
  if (error && ranking.length === 0) {
    return <ChartCard title="同类药提及率" state="error" errorMessage={`同类药的提及率没有读到：${error.message}`} onRetry={error.retry} height={180} />;
  }
  // Nobody measured a rival: no empty card to say so.
  if (ranking.length === 0 && !loading) return null;
  const displayed = [...ranking].sort((a, b) => Number(b.ours) - Number(a.ours) || a.name.localeCompare(b.name, "zh-CN"));
  const scope = ranking.length > 0 && ranking.every((row) => row.scope === ranking[0].scope) ? ranking[0].scope : null;
  return (
    <ChartCard
      title="已记录的同类药提及率"
      state={loading ? "loading" : ranking.length === 0 ? "empty" : "content"}
      emptyText="这一轮还没有测到同类药的提及率。"
      footnote={`${scope ? `记录范围：${scope}。` : ""}历史读数的可比范围尚未核实，不作排名。`}
      height={180}
    >
      <DataTable
        label="同类药提及率"
        minWidth={compact ? "min-w-0" : undefined}
        rows={displayed}
        rowKey={(row) => row.key}
        highlight={(row) => row.ours}
        rowAttrs={(row) => ({ "data-rank-row": row.key })}
        columns={[
          {
            key: "name",
            header: "同类药",
            rowHeader: true,
            cell: (row) => (
              <>
                {row.name}
                {row.ours && <span className="ml-1.5 text-caption font-normal text-accent">本品</span>}
                {compact && scope === null && <span className="block text-caption font-normal text-text-3">{row.scope}</span>}
              </>
            ),
          },
          { key: "scope", header: "读数范围", cell: (row) => <span className="text-text-3">{row.scope}</span>, isEmpty: () => compact || scope !== null },
          { key: "value", header: "提及率", align: "right", width: compact ? "w-16" : "w-20", cell: (row) => (row.value === null ? geoCellWord(null) : `${Math.round(row.value)}%`) },
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

/** A pool-qualified competitor's name with its pool in words: the read names it "name · P2", and a pool id is not a word. */
function rivalTitle(rival: NonNullable<GeoMonitoring["rivals"]>[number]): string {
  const suffix = ` · ${rival.pool}`;
  const base = rival.label ? (rival.label.endsWith(suffix) ? rival.label.slice(0, -suffix.length) : rival.label) : rival.name;
  return `${base} · ${poolName(rival.pool)}`;
}

/** Pool-qualified competitors use their own paired denominator, never the global mention curve. */
function PoolRivalTrends({project,rivals}:{project:GeoProject;rivals:GeoMonitoring["rivals"]}) {
 return <>{(rivals??[]).filter(rival=>rival.pool&&rival.ownPoints).map(rival=>{
  const points=rival.points,own=rival.ownPoints??[],labels=points.map(point=>monthDay(point.date)??point.date),known=points.some(point=>point.value!==null)||own.some(point=>point.value!==null);
  const comparable = [points,own].every(series => series.every((point,index) => index === 0 || point.value == null || series[index-1].value == null || geoCoverageDifference(series[index-1].coverage,point.coverage).comparable));
  return <ChartCard key={`${rival.entityKey}-${rival.pool}`} title={rivalTitle(rival)} state={known?"content":"empty"} emptyText="这个问句池尚无足够的可测回答；历史缺席保留未知。" footnote={!comparable ? "判定版本或测量范围未知或不一致，各期读数不连线比较。" : undefined}>
   <TrendChart label={`${rivalTitle(rival)} 同口径趋势`} connectLines={comparable} input={{labels,own:{name:project.product?.brandName??project.name,values:points.map(point=>own.find(item=>item.date===point.date)?.value??null)},rivals:[{name:rival.name,values:points.map(point=>point.value)}]}}/>
   <DataTable label={`${rivalTitle(rival)} 同口径读数`} rows={points.map((point,index)=>({...point, rowId:`${point.date}-${index}`}))} rowKey={point=>point.rowId} columns={[
    {key:"date",header:"实测日期",rowHeader:true,cell:point=>point.date},
    {key:"own",header:"本品提及率",cell:point=>{const ownPoint=own.find(item=>item.date===point.date);return ownPoint?.value==null?"未知或样本不足":`${ownPoint.value}%`; }},
    {key:"rival",header:"竞品提及率",cell:point=>point.value==null?"未知或样本不足":`${point.value}%`},
    {key:"n",header:"共同合资格回答",cell:point=>point.n??"未知"},
   ]}/>
  </ChartCard>;
 })}</>;
}
