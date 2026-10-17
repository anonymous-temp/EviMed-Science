import { useMemo } from "react";
import { readGeoCell, type GeoClusterRow, type GeoDiagnosis, type GeoEngine, type GeoProject } from "@/lib/geoClient";
import { BarList } from "@/components/charts/BarList";
import { ClusterEngineGrid } from "@/components/charts/ClusterEngineGrid";
import { HeatGrid } from "@/components/charts/HeatGrid";
import { ChartCard } from "@/components/ui/ChartCard";
import { ShowMore, useShowMore } from "@/components/ui/ShowMore";
import { engineConclusion, engineMatrix } from "../geoOverviewModel";
import { engineName, GEO_POOL_KINDS, GEO_POOLS, zh } from "../geoText";
import { ClusterLink } from "../spine/ClusterLink";
import { clusterName, groupTally } from "../spine/clusterModel";
import { metricName } from "./geoTabText";

/**
 * The metric chips of 可见度 name five series; four of them are also a column of the engine × metric grid. The index (GVI) is
 * composed from them and has no column of its own.
 */
export const HEAT_COLUMN_OF_METRIC: Readonly<Record<string, "mention" | "accuracy" | "citation" | "retrieval">> = Object.freeze({
  mention: "mention",
  accuracy: "accuracy",
  citation: "citation",
  retrieval: "retrieval",
});

/** The metrics whose per-engine reading is in the diagnosis (the latest round's), not in a series. */
export const ENGINE_BAR_METRICS = ["accuracy", "citation", "retrieval"] as const;
export type EngineBarMetric = (typeof ENGINE_BAR_METRICS)[number];
export const isEngineBarMetric = (key: string | null | undefined): key is EngineBarMetric => ENGINE_BAR_METRICS.includes(key as EngineBarMetric);

/* ----------------------------------------------------- engine × metric heat */

/**
 * Each engine against each measured rate (moved here from 总览, R19: the overview keeps the sentence, the triples and the trend;
 * what the engines do is this page's). The metric in view is the ringed column and the engine in view the bold row; the rest of the
 * grid stays, because a reader picks one number out of a picture and the picture is the point.
 */
export function EngineHeatCard({
  project,
  diagnosis,
  loading,
  metric,
  engine,
}: {
  project: GeoProject;
  diagnosis: GeoDiagnosis | null;
  loading: boolean;
  metric: string | null;
  engine: string | null;
}) {
  const matrix = useMemo(() => engineMatrix(project, diagnosis), [project, diagnosis]);
  if (loading && !diagnosis) return <ChartCard title="各引擎的提及、准确与引用" state="loading" height={160} />;
  if (matrix.rows.length === 0 || matrix.columns.length === 0) return null;
  return (
    <ChartCard title={engineConclusion(project, diagnosis)} footnote={matrix.note ?? undefined}>
      <HeatGrid
        label="各引擎的提及、准确与引用"
        columns={matrix.columns}
        rows={matrix.rows}
        legend={{ low: "低", high: "高" }}
        emphasis={{ column: metric ? HEAT_COLUMN_OF_METRIC[metric] ?? null : null, row: engine }}
      />
    </ChartCard>
  );
}

/* ------------------------------------------------- one metric, each engine */

/**
 * The latest reading of one rate on each engine, as bars: the engines' side of an accuracy, citation or retrieval chip. (A rate's
 * history per engine is kept only for the mention rate; its card is the sparkline one.) A bar is the engine's filter on the page.
 */
export function EngineMetricCard({
  diagnosis,
  metric,
  selected,
  onSelect,
}: {
  diagnosis: GeoDiagnosis | null;
  metric: EngineBarMetric;
  selected: string | null;
  onSelect: (engine: string | null) => void;
}) {
  const name = metricName(metric) ?? metric;
  const rows = (Array.isArray(diagnosis?.byEngine) ? diagnosis.byEngine : []).flatMap((row) => {
    const cell = readGeoCell(row?.[metric]);
    return row?.engine && cell.status === "ok" && cell.value !== null ? [{ key: row.engine as string, label: engineName(row.engine), value: Math.round(cell.value), unit: "%" }] : [];
  }).sort((left, right) => right.value - left.value);
  if (rows.length === 0) return null;
  return (
    <ChartCard title={zh`${rows[0].label}的${name}最高，${rows[0].value}%`}>
      <BarList label={`各引擎的${name}`} rows={rows} selected={selected} onSelect={onSelect} tone="own" />
    </ChartCard>
  );
}

/* ------------------------------------------------------- group × engine */

/** Groups listed before 「显示更多」. */
const GROUPS_SHOWN = 12;

/** The groups in the order the question set lists them: by pool, the heavier first. */
export function orderedGroups(groups: readonly GeoClusterRow[]): GeoClusterRow[] {
  const pool = (row: GeoClusterRow) => (row.pool ? GEO_POOLS.indexOf(row.pool) : GEO_POOLS.length);
  return [...groups].sort((left, right) => (pool(left) - pool(right)) || ((right.weight ?? 0) - (left.weight ?? 0)));
}

/**
 * Which groups do which engines name us in — counts, never rates (a group has a dozen answers a round, under the platform's floor
 * for a percentage). The conclusion is the number of groups no engine named us in, the one thing a reader would count by hand.
 * A cell opens the group's drawer resting on that engine; the group's name opens it too.
 */
export function ClusterMatrixCard({
  groups,
  engines,
  engine,
  onOpen,
}: {
  groups: readonly GeoClusterRow[];
  engines: readonly GeoEngine[];
  engine: string | null;
  onOpen: (groupId: string, engine: string) => void;
}) {
  const shownEngines = engine ? engines.filter((entry) => entry === engine) : engines;
  const measured = groups.filter((row) => groupTally(row, shownEngines).answered > 0);
  const silent = measured.filter((row) => groupTally(row, shownEngines).mentioned === 0).length;
  const { visible, remaining, more } = useShowMore(groups, { first: GROUPS_SHOWN, step: GROUPS_SHOWN, resetKey: `${engine}|${groups.map((row) => row.id).join(",")}` });
  const rows = useMemo(() => visible.map((row) => ({
    key: row.id,
    name: clusterName(row),
    header: <ClusterLink groupId={row.id}>{clusterName(row)}</ClusterLink>,
    note: row.isControl ? <span className="shrink-0 text-meta text-text-3">对照</span> : undefined,
    tallies: row.byEngine,
  })), [visible]);
  if (groups.length === 0) return null;
  return (
    <ChartCard
      title={measured.length === 0
        ? "这一轮还没有测到问题群的回答"
        : silent === 0 ? `${measured.length} 个问题群，每个至少在一个引擎里被提到` : `${measured.length} 个问题群里，${silent} 个${engine ? `在${engineName(engine)}里` : "在所有引擎里"}都没有被提到`}
      footnote="每格是提到我们的回答数 / 回答数"
    >
      <ClusterEngineGrid
        label="各问题群在各引擎里被提到的回答数"
        engines={shownEngines}
        engineName={engineName}
        rows={rows}
        onOpen={onOpen}
      />
      <ShowMore remaining={remaining} unit="个问题群" onMore={more} />
    </ChartCard>
  );
}

/** The pools that have a group, in their order: what the pool choice offers. */
export function poolsOf(groups: readonly GeoClusterRow[]) {
  return GEO_POOLS.filter((pool) => groups.some((row) => row.pool === pool)).map((pool) => ({ value: pool, label: GEO_POOL_KINDS[pool] }));
}
