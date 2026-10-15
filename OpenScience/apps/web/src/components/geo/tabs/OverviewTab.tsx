import { useMemo } from "react";
import { Radar } from "lucide-react";
import type { GeoMonitoring, GeoProject } from "@/lib/geoClient";
import { ChartCard } from "@/components/ui/ChartCard";
import { DataTable, InlineBar } from "@/components/ui/DataTable";
import { Delta } from "@/components/ui/Delta";
import { BulletBar, StatBand, StatTile } from "@/components/ui/StatTile";
import { Section } from "@/components/ui/Section";
import { TrendChart } from "@/components/charts/TrendChart";
import { GeoSparkline } from "../GeoSparkline";
import { formatGeoValue } from "../GeoCellText";
import { NeedsYou } from "../NeedsYou";
import { useGeoDiagnosis, useGeoMonitoring, useGeoStrategy, type GeoLoadResult } from "../geoProjectData";
import { List, ListRow } from "@/components/ui/ListRow";
import { Tag } from "@/components/ui/Tag";
import {
  actionMarkers,
  dayWord,
  denominatorLine,
  chartDates,
  headlineSentence,
  overviewCoverageNotice,
  overviewTiles,
  readingChange,
  rivalRanking,
  statedValue,
  trendConclusion,
  weekTarget,
  withCoverageMarker,
  GEO_ALERT_KINDS,
  type MetricTriple,
} from "../geoOverviewModel";
import { GEO_METRIC_NAMES, monthDay } from "../geoText";
import { geoTabPath } from "../geoTabs";
import { roundKindWord } from "./geoTabText";

/**
 * 总览 — the first screen, and the only one most readers will look at (fusion plan §4.8, mockup m10; R19 audit C §2.3).
 *
 * It answers four questions, in this order: **where do we stand** (one sentence, then the numbers, each as where it began, where it
 * is and where it is meant to be, with the dates), **what is asked of me** (「需要你」: a to-do list, never a log of what is done),
 * **did it move** (the trend, with what we did marked on it) and **how do we compare** (the same-class ranking). Nothing here is a
 * page of its own: the eight steps are the band above every tab, the engine matrix and the value analysis are 可见度's and 依据's, and
 * every figure opens the tab that holds what it counts.
 *
 * Every number is still drillable to the answer it came from, every rate still carries its denominator — declared once under the
 * band, not in each cell — and 未测 is still a word with a reason rather than a zero.
 */
export function OverviewTab({ geoId, project }: { geoId: string; project: GeoProject }) {
  const diagnosis = useGeoDiagnosis(geoId);
  const monitoring = useGeoMonitoring(geoId);
  // The plan gives each target the day it falls due; without it the band still reads, just without that date.
  const strategy = useGeoStrategy(geoId);
  const diag = diagnosis.state.kind === "ready" ? diagnosis.state.data : null;
  const watch = monitoring.state.kind === "ready" ? monitoring.state.data : null;
  const plan = strategy.state.kind === "ready" ? strategy.state.data : null;

  const tiles = useMemo(() => overviewTiles(project, diag, plan), [project, diag, plan]);
  const denominator = denominatorLine(project, diag);
  const ranking = useMemo(() => rivalRanking(project, diag), [project, diag]);
  const gvi = project.overview.metrics.find((metric) => metric.key === "gvi") ?? null;
  // The index has no measured band of its own: its change is stated as a change.
  const gviChange = readingChange(gvi?.trend);
  // The index takes two cells (fusion plan §4.8), so the band is one column
  // wider than it has tiles; past six the widest layout gets a seventh.
  const cells = tiles.length + 1;
  const ranked = ranking.length > 0;

  return (
    <div data-geo-tab="overview" className="flex flex-col gap-6">
      {/* The sentence names the open errors, so it is written once they are counted: a 「没有待办」 that turns into
          「还有 11 条严重讲错」 a moment later is worse than a held line. */}
      {diagnosis.state.kind === "loading" ? (
        <div role="status" aria-label="正在读取" className="flex h-7 items-center"><div className="h-7 w-2/3 animate-pulse rounded bg-surface-1" /></div>
      ) : (
        <p data-headline="" className="flex items-start gap-2 text-section font-semibold text-text">
          <Radar size={20} aria-hidden="true" className="mt-0.5 shrink-0 text-accent" />
          <span className="min-w-0">{headlineSentence(project, diag)}</span>
        </p>
      )}

      <StatBand
        label="本轮指标"
        // The denominator, and — when the engines, the questions or the surface changed since the last round — the plain statement that
        // the tiles' changes are not compared (R14 N-4); the same sentence the headline and the chart say.
        footnote={[denominator, overviewCoverageNotice(project)].filter(Boolean).join(" · ") || null}
        columns={cells >= 6 ? 6 : cells === 5 ? 5 : 4}
        className={cells > 6 ? "xl:[&>div]:grid-cols-7" : undefined}
      >
        {tiles.map((tile) => (
          <StatTile
            key={tile.key}
            label={tile.label}
            value={tile.value}
            unit={tile.unit}
            hint={tile.hint}
            lead={tile.lead}
            rank={tile.rank ?? undefined}
            tone={tile.tone}
            placeholder={tile.placeholder}
            to={tile.tab ? geoTabPath(geoId, tile.tab) : undefined}
            loading={diagnosis.state.kind === "loading" && tile.key === "safety"}
            delta={<Delta value={tile.delta} unit={tile.key === "gvi" ? "index" : "point"} polarity={tile.polarity} />}
            note={tile.triple ? undefined : tile.note}
            className={tile.lead ? "sm:col-span-2" : undefined}
            chart={(
              <>
                {tile.lead
                  ? (
                    <BulletBar
                      label={tile.label}
                      value={Number(tile.value) || null}
                      target={tile.target}
                      targetLabel={tile.target === null ? undefined : `目标 ${formatGeoValue(tile.target, "index")}`}
                      // The rival's reading is a mention rate, not an index: it is
                      // named under the bar, never placed on its scale.
                      rivalLabel={tile.rival ?? undefined}
                    />
                  )
                  // A tile that reads 「样本不足」 draws no line: the words and a falling line would say two things.
                  : !tile.placeholder && tile.trend.some((value) => value !== null)
                    ? <GeoSparkline values={tile.trend} target={tile.target} width={140} height={28} className="w-full" />
                    : null}
                {tile.triple && !tile.placeholder && <TripleLine triple={tile.triple} unit={tile.key === "gvi" ? "index" : "percent"} />}
              </>
            )}
          />
        ))}
      </StatBand>

      <NeedsYou geoId={geoId} project={project} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <TrendCard
          project={project}
          monitoring={monitoring}
          watch={watch}
          // The conclusion is read from the same series, by the same rule, as the sentence at the top and the tile's arrow.
          title={trendConclusion(GEO_METRIC_NAMES.gvi, gvi?.cell ?? null, gviChange, "index")}
          change={gviChange}
          // Nothing is drawn for a ranking nobody measured: no empty card beside the trend.
          className={ranked || diagnosis.state.kind === "loading" ? "lg:col-span-2" : "lg:col-span-3"}
        />
        {(ranked || diagnosis.state.kind === "loading") && <RankCard ranking={ranking} loading={diagnosis.state.kind === "loading"} />}
      </div>

      <Week geoId={geoId} project={project} />
    </div>
  );
}

/* ----------------------------------------------------------------- triple */

/**
 * 「基线 31 · 9月29日 → 目标 55 · 12月29日前」: where it began and where it is meant to be, under the figure that says where it is.
 * A target the reading has passed reads 「已达到目标 12」 — a number beside a figure above it was read as the page contradicting
 * itself (R19 audit C class 4.3).
 */
function TripleLine({ triple, unit }: { triple: MetricTriple; unit: "index" | "percent" }) {
  const base = triple.baseline ? `基线 ${formatGeoValue(triple.baseline.value, unit)}${triple.baseline.date ? ` · ${monthDay(triple.baseline.date)}` : ""}` : null;
  const target = triple.target === null ? null
    : triple.reached ? `已达到目标 ${formatGeoValue(triple.target, unit)}`
      : `目标 ${formatGeoValue(triple.target, unit)}${triple.dueAt ? ` · ${monthDay(triple.dueAt)}前` : ""}`;
  if (!base && !target) return null;
  return (
    <p data-geo-triple="" className="mt-2 flex flex-wrap items-baseline gap-x-1.5 text-caption tabular-nums text-text-3">
      {base && <span>{base}</span>}
      {base && target && <span aria-hidden="true">→</span>}
      {target && <span className={triple.reached ? "text-accent-strong" : undefined}>{target}</span>}
    </p>
  );
}

/* ------------------------------------------------------------------- week */

/** What changed since the last look, each line landing on the thing it is about. */
function Week({ geoId, project }: { geoId: string; project: GeoProject }) {
  const items = project.overview.week ?? [];
  if (items.length === 0) return null;
  return (
    <Section title="本周">
      <List divided label="本周">
        {items.slice(0, 5).map((item, index) => {
          const to = weekTarget(geoId, item);
          return (
            <ListRow
              key={`${index}:${item.text}`}
              to={to ?? undefined}
              leading={<span className="w-16 text-caption text-text-3">{dayWord(item.at) ?? ""}</span>}
              title={item.text}
              trailing={GEO_ALERT_KINDS.has(item.kind) ? <Tag tone="safety">需处理</Tag> : undefined}
            />
          );
        })}
      </List>
    </Section>
  );
}

/* ------------------------------------------------------------------ trend */

function TrendCard({
  project,
  monitoring,
  watch,
  title,
  change,
  className,
}: {
  project: GeoProject;
  monitoring: GeoLoadResult<GeoMonitoring>;
  watch: GeoMonitoring | null;
  /** The conclusion, written from the same reading the band states. */
  title: string;
  /** The change it states, for the date it is measured from. */
  change: ReturnType<typeof readingChange>;
  className?: string;
}) {
  const series = (Array.isArray(watch?.series) ? watch.series : []).find((line) => line?.key === "gvi")
    ?? (Array.isArray(watch?.series) ? watch.series : [])[0]
    ?? null;
  const points = Array.isArray(series?.points) ? series.points : [];
  const dates = points.map((point) => point.date);
  const metric = project.overview.metrics.find((item) => item.key === "gvi") ?? null;
  const input = useMemo(() => ({
    labels: points.map((point) => monthDay(point.date) ?? ""),
    own: { name: project.product?.brandName || project.name, values: points.map(statedValue) },
    target: metric?.target ?? null,
    targetLabel: metric?.target == null ? null : `目标 ${formatGeoValue(metric.target, "index")}`,
    band: null,
    markers: withCoverageMarker(actionMarkers(dates, watch), points),
    nextLabel: watch?.next?.date ? `${monthDay(watch.next.date)} ${roundKindWord(watch.next.kind) ?? "复测"}` : null,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [watch, metric?.target, project.name]);

  return (
    <ChartCard
      title={title}
      meta={chartDates(change, watch?.next?.date)}
      state={monitoring.state.kind === "loading" ? "loading"
        : monitoring.state.kind === "error" ? "error"
          : points.length === 0 ? "empty" : "content"}
      emptyText="还没有开始持续监测，第一次复测后这里会画出趋势。"
      errorMessage={monitoring.state.kind === "error" ? monitoring.state.message : undefined}
      onRetry={monitoring.reload}
      height={240}
      className={className}
    >
      <TrendChart input={input} label={`${GEO_METRIC_NAMES.gvi}趋势`} integer bounds={[0, 100]} />
    </ChartCard>
  );
}

/* ---------------------------------------------------------------- ranking */

function RankCard({ ranking, loading }: { ranking: ReturnType<typeof rivalRanking>; loading: boolean }) {
  const top = ranking.reduce((max, row) => Math.max(max, row.value ?? 0), 0);
  const ours = ranking.find((row) => row.ours) ?? null;
  const place = ours ? ranking.indexOf(ours) + 1 : 0;
  return (
    <ChartCard
      title={ours && place > 0 ? `提及率在 ${ranking.length} 个同类药里排第 ${place}` : "同类药提及率"}
      state={loading ? "loading" : ranking.length === 0 ? "empty" : "content"}
      emptyText="这一轮还没有测到同类药的提及率。"
      height={200}
    >
      <DataTable
        label="同类药提及率"
        minWidth="min-w-0"
        rows={ranking}
        rowKey={(row) => row.key}
        highlight={(row) => row.ours}
        rowAttrs={(row) => ({ "data-rank-row": row.key })}
        columns={[
          { key: "name", header: "同类药", rowHeader: true, cell: (row) => <span className="truncate">{row.name}{row.ours && <span className="ml-1 text-caption font-normal text-accent-strong">本品</span>}</span> },
          { key: "bar", header: "", width: "w-24", cell: (row) => <InlineBar value={row.value} max={top} tone={row.ours ? "own" : "rival"} label={`${row.name} 提及率`} /> },
          {
            key: "value",
            header: "提及率",
            align: "right",
            width: "w-16",
            cell: (row) => (row.value === null ? "—" : `${Math.round(row.value)}%`),
          },
        ]}
      />
    </ChartCard>
  );
}
