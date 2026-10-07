import { useMemo } from "react";
import { Radar } from "lucide-react";
import { Link } from "react-router";
import { getGeoDiagnosis, getGeoMonitoring, type GeoDiagnosis, type GeoMonitoring, type GeoProject } from "@/lib/geoClient";
import { AllowanceTopUp } from "@/components/runs/AllowanceTopUp";
import { ChartCard } from "@/components/ui/ChartCard";
import { DataTable, InlineBar } from "@/components/ui/DataTable";
import { Delta } from "@/components/ui/Delta";
import { BulletBar, StatBand, StatTile } from "@/components/ui/StatTile";
import { HeatGrid } from "@/components/charts/HeatGrid";
import { TrendChart } from "@/components/charts/TrendChart";
import { GeoErrorCard } from "../GeoErrorCard";
import { GeoSparkline } from "../GeoSparkline";
import { formatGeoValue } from "../GeoCellText";
import { List, ListRow } from "@/components/ui/ListRow";
import { Tag } from "@/components/ui/Tag";
import {
  actionMarkers,
  dayWord,
  denominatorLine,
  engineConclusion,
  engineMatrix,
  chartDates,
  headlineSentence,
  nextSteps,
  overviewTiles,
  readingChange,
  rivalRanking,
  statedValue,
  trendConclusion,
  weekTarget,
  GEO_ALERT_KINDS,
  type NextStep,
} from "../geoOverviewModel";
import { GEO_METRIC_NAMES, monthDay } from "../geoText";
import { roundKindWord, tabPath } from "./geoTabText";
import { useGeoLoad, type GeoLoadResult } from "./geoTabKit";

/**
 * 总览 — the first screen, and the only one most readers will look at
 * (fusion plan §4.8, mockup m10).
 *
 * It answers three questions, in this order: **where do we stand** (one
 * sentence, then six numbers each with its target and a noise-aware change),
 * **did it move** (the trend, with what we did marked on it), and **what next**
 * (the wrong statements that need handling, and the step waiting on the
 * reader). Nothing on it is a process page: the eight steps are the rail in
 * the header, and 监测 is the horizontal axis of the chart.
 *
 * Every number is still drillable to the answer it came from, every rate still
 * carries its denominator — declared once under the band, not in each cell —
 * and 未测 is still a hatched row with a reason rather than a zero.
 */
export function OverviewTab({ geoId, project }: { geoId: string; project: GeoProject }) {
  const diagnosis = useGeoLoad<GeoDiagnosis>(`overview:diagnosis:${geoId}`, () => getGeoDiagnosis(geoId));
  const monitoring = useGeoLoad<GeoMonitoring>(`overview:monitoring:${geoId}`, () => getGeoMonitoring(geoId));
  const diag = diagnosis.state.kind === "ready" ? diagnosis.state.data : null;
  const watch = monitoring.state.kind === "ready" ? monitoring.state.data : null;

  const tiles = useMemo(() => overviewTiles(project, diag), [project, diag]);
  const denominator = denominatorLine(project, diag);
  const ranking = useMemo(() => rivalRanking(project, diag), [project, diag]);
  const matrix = useMemo(() => engineMatrix(project, diag), [project, diag]);
  const errors = (Array.isArray(diag?.errors) ? diag.errors : [])
    .filter((error) => error && error.id && error.status !== "closed")
    .sort((left, right) => (right.severity ?? "").localeCompare(left.severity ?? ""));
  const steps = nextSteps(project);
  const gvi = project.overview.metrics.find((metric) => metric.key === "gvi") ?? null;
  // What is still wrong is counted over every error of the project; the cards are the worst few.
  const live = diag?.errorCounts ? diag.errorCounts.total - diag.errorCounts.closed : errors.length;
  // The index has no measured band of its own: its change is stated as a change.
  const gviChange = readingChange(gvi?.trend);
  // The index takes two cells (fusion plan §4.8), so the band is one column
  // wider than it has tiles; past six the widest layout gets a seventh.
  const cells = tiles.length + 1;
  const ranked = ranking.length > 0;

  return (
    <div data-geo-tab="overview" className="flex flex-col gap-4">
      {/* The sentence names the open errors, so it is written once they are counted: a 「没有待办」 that turns into
          「还有 11 条严重讲错」 a moment later is worse than a held line. */}
      {diagnosis.state.kind === "loading" ? (
        <div role="status" aria-label="正在读取" className="flex h-7 items-center"><div className="h-7 w-2/3 animate-pulse rounded bg-surface-1" /></div>
      ) : (
        <p className="flex items-start gap-2 text-section font-semibold text-text">
          <Radar size={20} aria-hidden="true" className="mt-0.5 shrink-0 text-accent" />
          <span className="min-w-0">{headlineSentence(project, diag)}</span>
        </p>
      )}

      <StatBand
        label="本轮指标"
        footnote={denominator}
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
            loading={diagnosis.state.kind === "loading" && tile.key === "safety"}
            delta={<Delta value={tile.delta} unit={tile.key === "gvi" ? "index" : "point"} polarity={tile.polarity} />}
            note={tile.note}
            className={tile.lead ? "sm:col-span-2" : undefined}
            chart={tile.lead
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
                : undefined}
          />
        ))}
      </StatBand>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <ChartCard
          title={live > 0 ? `${live} 条讲错还没处理` : "没有待处理的讲错"}
          meta={live > 3 ? <Link to={tabPath(geoId, "accuracy")} className="text-link hover:underline">{`查看全部 ${live} 条`}</Link> : undefined}
          state={diagnosis.state.kind === "loading" ? "loading"
            : diagnosis.state.kind === "error" ? "error"
              : live === 0 ? "empty" : "content"}
          emptyText="这一轮没有测到讲错我方的说法。"
          errorMessage={diagnosis.state.kind === "error" ? diagnosis.state.message : undefined}
          onRetry={diagnosis.reload}
          height={200}
          className="lg:col-span-2"
        >
          <div>
            {errors.slice(0, 3).map((error) => (
              <GeoErrorCard key={error.id} geoId={geoId} project={project} error={error} />
            ))}
          </div>
        </ChartCard>
        <ChartCard title="下一步" state={steps.length === 0 ? "empty" : "content"} emptyText="还没有排上的下一步。" height={200}>
          <ol className="flex flex-col">
            {steps.map((step) => <NextRow key={step.key} step={step} />)}
          </ol>
        </ChartCard>
      </div>

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

      <ChartCard
        title={engineConclusion(project, diag)}
        state={diagnosis.state.kind === "loading" ? "loading"
          : diagnosis.state.kind === "error" ? "error"
            : matrix.rows.length === 0 ? "empty" : "content"}
        emptyText="还没有问过各家 AI。"
        errorMessage={diagnosis.state.kind === "error" ? diagnosis.state.message : undefined}
        onRetry={diagnosis.reload}
        footnote={matrix.note}
        height={220}
      >
        <HeatGrid label="各引擎的提及、准确与引用" columns={matrix.columns} rows={matrix.rows} legend={{ low: "低", high: "高" }} />
      </ChartCard>

      <Week geoId={geoId} project={project} />
    </div>
  );
}

/* ------------------------------------------------------------------- week */

/** What changed since the last look, each line landing on the thing it is about. */
function Week({ geoId, project }: { geoId: string; project: GeoProject }) {
  const items = project.overview.week ?? [];
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="geo-week">
      <h2 id="geo-week" className="mb-1 text-section font-semibold text-text">本周</h2>
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
    </section>
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
    markers: actionMarkers(dates, watch),
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

/* -------------------------------------------------------------- next step */

const NEXT_WORDS: Record<NextStep["state"], string> = { waiting: "等你", active: "进行中", done: "已完成", held: "未接通" };

function NextRow({ step }: { step: NextStep }) {
  return (
    <li
      data-next-step={step.key}
      data-next-state={step.state}
      className={step.state === "waiting"
        ? "-mx-2 flex items-center gap-2.5 rounded bg-accent-soft px-2 py-2.5 text-ui text-text"
        : "flex items-center gap-2.5 border-b border-faint py-2.5 text-ui text-text last:border-b-0"}
    >
      <span
        aria-hidden="true"
        data-status-mark=""
        className={step.state === "done" ? "h-2 w-2 shrink-0 rounded-full bg-accent"
          : step.state === "active" ? "h-2 w-2 shrink-0 animate-pulse rounded-full bg-dot-running"
            : step.state === "held" ? "h-2.5 w-2.5 shrink-0 rounded-full border-2 border-border-control"
              : "h-2.5 w-2.5 shrink-0 rounded-full border-2 border-accent"}
      />
      <span className="min-w-0 flex-1 truncate">{step.text}</span>
      {step.allowance && <AllowanceTopUp waiting={step.allowance} className="shrink-0 text-caption text-link hover:underline" />}
      <span className={step.state === "waiting" ? "shrink-0 text-caption text-accent-strong" : "shrink-0 text-caption text-text-3"}>
        {step.when ?? NEXT_WORDS[step.state]}
      </span>
    </li>
  );
}
