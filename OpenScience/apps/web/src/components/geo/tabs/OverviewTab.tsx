import { Note } from "@/components/ui/Note";
import { useGeoFrame } from "../geoFrame";
import { GeoAnalysisEntry } from "../GeoAnalysisEntry";
import { Link } from "react-router";
import { geoOverviewNeedsMeasurement } from "../geoFirstUse";
import { buttonClasses } from "@/components/ui/Button";
import { useMemo } from "react";
import { Radar } from "lucide-react";
import type { GeoMonitoring, GeoProject } from "@/lib/geoClient";
import { ChartCard } from "@/components/ui/ChartCard";
import { Section } from "@/components/ui/Section";
import { TrendChart } from "@/components/charts/TrendChart";
import { formatGeoValue } from "../GeoCellText";
import { NeedsYou } from "../NeedsYou";
import { LoadError } from "@/components/cards/LoadError";
import { nextMeasurement } from "../geoBand";
import { readFailure, useGeoDiagnosis, useGeoMonitoring, useGeoStrategy, type GeoLoadResult } from "../geoProjectData";
import {
  actionMarkers,
  chartDates,
  headlineSentence,
  readingChange,
  rivalRanking,
  statedValue,
  trendConclusion,
  withCoverageMarker,
} from "../geoOverviewModel";
import { GEO_METRIC_NAMES, monthDay } from "../geoText";
import { geoTabPath } from "../geoTabs";
import { roundKindWord } from "./geoTabText";
import { Ranking } from "./VisibilityTab";
import { GeoComparison } from "../GeoComparison";
import { useGeoPath } from "../useGeoPath";
import { GeoOverviewMetrics } from "../GeoOverviewMetrics";
import { GeoWeekActivity } from "../GeoWeekActivity";

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
  const path = useGeoPath();
  const frame = useGeoFrame();
  const diagnosis = useGeoDiagnosis(geoId);
  const monitoring = useGeoMonitoring(geoId);
  // The plan gives each target the day it falls due; without it the band still reads, just without that date.
  const strategy = useGeoStrategy(geoId);
  const diag = diagnosis.state.kind === "ready" ? diagnosis.state.data : null;
  const watch = monitoring.state.kind === "ready" ? monitoring.state.data : null;
  // The open errors and the rivals are the diagnosis's: when it did not come, the band says so instead of reading as none.
  const diagnosisFailed = readFailure(diagnosis);

  const ranking = useMemo(() => rivalRanking(project, diag), [project, diag]);
  const gvi = project.overview.metrics.find((metric) => metric.key === "gvi") ?? null;
  // The index has no measured band of its own: its change is stated as a change.
  const gviChange = readingChange(gvi?.trend);
  const ranked = ranking.length > 0;

  if (geoOverviewNeedsMeasurement(project, diagnosis.state, monitoring.state)) return <div data-geo-tab="overview" data-geo-first-use="" className="flex flex-col gap-6">
    <Section title="已有资料与结果">
      <Note action={<div className="flex flex-wrap gap-2"><Link className={buttonClasses({variant:"secondary"})} to={path(geoTabPath(geoId,"evidence"))}>查看产品依据</Link><Link className={buttonClasses({variant:"secondary"})} to={path(geoTabPath(geoId,"questions"))}>整理问题</Link></div>}>还没有采样记录。产品依据、问题和方案的已有结果都可继续查看。</Note>
    </Section>
    {strategy.state.kind === "error" && <LoadError message={strategy.state.message} onRetry={strategy.reload} />}
    {strategy.state.kind === "ready" && strategy.state.refreshError && <LoadError message={strategy.state.refreshError} onRetry={strategy.reload} />}
    <NeedsYou geoId={geoId} project={project} showMeasurement={!frame} />
    <GeoAnalysisEntry geoId={geoId} project={project} />
  </div>;

  return (
    <div data-geo-tab="overview" className="flex flex-col gap-6">
      <GeoComparison geoId={geoId} view={project} />
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

      <GeoOverviewMetrics geoId={geoId} project={project} diagnosis={diagnosis} strategy={strategy} />

      {diagnosisFailed && <LoadError message={`用药安全和同类药排名没有读到：${diagnosisFailed.message}`} onRetry={diagnosisFailed.retry} />}

      <NeedsYou geoId={geoId} project={project} showMeasurement={!frame} />

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
        {/* The same card 可见度 draws (one implementation: the two pages cannot disagree about who is ahead, or over what). */}
        <Ranking compact ranking={ranking} loading={diagnosis.state.kind === "loading"} />
      </div>

      <GeoWeekActivity geoId={geoId} project={project} />
      <GeoAnalysisEntry geoId={geoId} project={project} />
    </div>
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
  const next = nextMeasurement(project, watch);
  const input = useMemo(() => ({
    labels: points.map((point) => monthDay(point.date) ?? ""),
    own: { name: project.product?.brandName || project.name, values: points.map(statedValue) },
    target: metric?.target ?? null,
    targetLabel: metric?.target == null ? null : `目标 ${formatGeoValue(metric.target, "index")}`,
    band: null,
    markers: withCoverageMarker(actionMarkers(dates, watch), points),
    nextLabel: next ? `${monthDay(next.date)} ${roundKindWord(next.kind) ?? "复测"}` : null,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [watch, next, metric?.target, project.name]);

  if (monitoring.state.kind === "ready" && points.length === 0) return <section aria-label="监测趋势" className={className}>
    <Note action={<Link className="rounded text-ui text-link hover:underline" to={geoTabPath(project.id,"visibility")}>查看测量与监测</Link>}>还没有持续监测趋势。已有测量和其他结果仍可查看。</Note>
  </section>;

  return (
    <ChartCard
      title={title}
      meta={chartDates(change, next?.date)}
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
