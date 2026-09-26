import { useState } from "react";
import {
  getGeoDiagnosis,
  getGeoMonitoring,
  readGeoCell,
  type GeoDiagnosis,
  type GeoErrorRow,
  type GeoErrorStatus,
  type GeoMonitoring,
  type GeoProject,
} from "@/lib/geoClient";
import { ChartCard } from "@/components/ui/ChartCard";
import { DataTable, InlineBar } from "@/components/ui/DataTable";
import { Delta } from "@/components/ui/Delta";
import { FilterChips, type FilterOption } from "@/components/ui/FilterChips";
import { StatBand, StatTile } from "@/components/ui/StatTile";
import { isSeverityLevel, SeverityBadge, type SeverityLevel } from "@/components/ui/SeverityBadge";
import { ShareBar, type ShareSegment } from "@/components/charts/ShareBar";
import { GeoErrorCard } from "../GeoErrorCard";
import { formatGeoValue, geoCellPhrase } from "../GeoCellText";
import { denominatorLine, readingDelta, tileValue } from "../geoOverviewModel";
import { engineName, GEO_ERROR_STATUS_WORDS, GEO_ERROR_TYPE_WORDS } from "../geoText";
import { metricName, metricUnit } from "./geoTabText";
import { TabError, TabSkeleton, useGeoLoad } from "./geoTabKit";

/**
 * 准确与安全 — the part of this product no general AI-visibility tool has
 * (appendix E §0.6): not 「are we mentioned」 but 「is what it says about the
 * medicine true, and would a wrong answer hurt someone」.
 *
 * The accuracy rate is the headline, drawn as what it is — how many statements
 * were right against how many were wrong — and the wrong ones are graded by
 * what they would cost a patient, grouped by where their handling stands. Red
 * belongs to the severity badge and the ✗; the sentences themselves are body
 * text, which is the difference between a page a reader works through and the
 * wall of red the old board was.
 */

const STATUS_ORDER: readonly GeoErrorStatus[] = ["open", "acting", "awaiting_remeasure", "closed"];
const SAFETY_METRICS: ReadonlyArray<{ ids: readonly string[]; polarity: "up" | "down" }> = [
  { ids: ["M-11"], polarity: "up" },
  { ids: ["M-12"], polarity: "up" },
  { ids: ["M-15"], polarity: "down" },
];

export function AccuracyTab({ geoId, project }: { geoId: string; project: GeoProject }) {
  const diagnosis = useGeoLoad<GeoDiagnosis>(`accuracy:diagnosis:${geoId}`, () => getGeoDiagnosis(geoId));
  const monitoring = useGeoLoad<GeoMonitoring>(`accuracy:monitoring:${geoId}`, () => getGeoMonitoring(geoId));
  if (diagnosis.state.kind === "loading") return <TabSkeleton />;
  if (diagnosis.state.kind === "error") return <TabError message={diagnosis.state.message} onRetry={diagnosis.reload} />;
  const diag = diagnosis.state.data;
  const fresh = monitoring.state.kind === "ready" ? monitoring.state.data.newErrors : [];
  return <Accuracy geoId={geoId} project={project} diagnosis={diag} fresh={Array.isArray(fresh) ? fresh : []} />;
}

function Accuracy({
  geoId,
  project,
  diagnosis,
  fresh,
}: {
  geoId: string;
  project: GeoProject;
  diagnosis: GeoDiagnosis;
  fresh: GeoErrorRow[];
}) {
  const denominator = denominatorLine(project, diagnosis);
  const known = new Set((Array.isArray(diagnosis.errors) ? diagnosis.errors : []).map((error) => error?.id));
  const errors = [
    ...(Array.isArray(diagnosis.errors) ? diagnosis.errors : []),
    ...fresh.filter((error) => error && error.id && !known.has(error.id)),
  ].filter((error) => error && error.id);
  const accuracy = project.overview.metrics.find((metric) => metric.key === "accuracy") ?? null;
  const modes = diagnosis.failureModes ?? null;
  const correct = readGeoCell(modes?.correct);
  const wrongOurs = readGeoCell(modes?.wrongOurs);
  const omitted = readGeoCell(modes?.omitted);
  const wrongRival = readGeoCell(modes?.wrongCompetitor);

  const tiles = [
    {
      key: "accuracy",
      label: "事实准确率",
      ...tileValue(accuracy?.cell, "percent"),
      delta: accuracy ? readingDelta(accuracy.trend.map((point) => point.value)) : null,
      note: accuracy?.target != null ? `目标 ${formatGeoValue(accuracy.target, "percent")}` : null,
      hint: accuracy ? geoCellPhrase(accuracy.cell, "percent") : undefined as string | undefined,
      polarity: "up" as const,
      tone: "default" as const,
      lead: true,
    },
    {
      key: "severe",
      label: "严重讲错",
      value: String(errors.filter((error) => error.status !== "closed" && (error.severity === "S3" || error.severity === "S4")).length),
      unit: "条" as string | undefined,
      placeholder: false,
      hint: undefined as string | undefined,
      delta: null,
      note: `待处理 ${errors.filter((error) => error.status === "open").length} 条` as string | null,
      polarity: "down" as const,
      tone: errors.some((error) => error.status !== "closed" && (error.severity === "S3" || error.severity === "S4")) ? "safety" as const : "default" as const,
      lead: false,
    },
    ...SAFETY_METRICS.flatMap(({ ids, polarity }) => {
      const row = (Array.isArray(diagnosis.more) ? diagnosis.more : []).find((item) => item && ids.includes(item.metricId));
      if (!row) return [];
      const cell = readGeoCell(row.cell);
      const unit = metricUnit(row.metricId);
      return [{
        key: row.metricId,
        label: metricName(row.metricId) ?? row.name,
        ...tileValue(cell, unit),
        delta: null,
        note: polarity === "down" ? "越低越好" : null,
        hint: geoCellPhrase(cell, unit) as string | undefined,
        polarity,
        tone: "default" as const,
        lead: false,
      }];
    }),
  ];

  const composition: ShareSegment[] = [
    { key: "correct", label: "讲对我方", value: correct.numerator ?? 0, tone: "own" },
    { key: "omitted", label: "漏提我方", value: omitted.numerator ?? 0, tone: "quiet" },
    { key: "wrongOurs", label: "讲错我方", value: wrongOurs.numerator ?? 0, tone: "s3" },
    { key: "wrongRival", label: "讲错竞品", value: wrongRival.numerator ?? 0, tone: "s1" },
  ];

  return (
    <div data-geo-tab="accuracy" className="flex flex-col gap-6">
      <StatBand label="准确与安全" footnote={denominator} columns={tiles.length >= 5 ? 5 : 4}>
        {tiles.map((tile) => (
          <StatTile
            key={tile.key}
            label={tile.label}
            value={tile.value}
            unit={tile.unit}
            hint={tile.hint}
            lead={tile.lead}
            tone={tile.tone}
            placeholder={tile.placeholder}
            delta={<Delta value={tile.delta} unit="point" polarity={tile.polarity} tone={tile.tone === "safety" ? "safety" : "default"} />}
            note={tile.note}
          />
        ))}
      </StatBand>

      <ChartCard
        title={correct.numerator != null && wrongOurs.numerator != null
          ? `讲到我方的 ${(correct.numerator + wrongOurs.numerator).toLocaleString("zh-CN")} 次里，讲错 ${wrongOurs.numerator} 次`
          : "这一轮的回答里我方出现在哪些位置"}
        state={composition.every((segment) => segment.value === 0) ? "empty" : "content"}
        emptyText="这一轮还没有统计出回答的构成。"
        footnote={denominator}
        height={120}
      >
        <ShareBar label="回答的构成" segments={composition} format={(value) => `${Math.round(value)} 次`} />
      </ChartCard>

      <BySeverity errors={errors} />
      <ByType errors={errors} />
      <ErrorList geoId={geoId} project={project} errors={errors} denominator={denominator} />
    </div>
  );
}

/* ------------------------------------------------------- severity × engine */

const SEVERITY_TONES: Record<SeverityLevel, ShareSegment["tone"]> = { S4: "s3", S3: "s3", S2: "s2", S1: "s1", S0: "s1" };

function BySeverity({ errors }: { errors: GeoErrorRow[] }) {
  const engines = [...new Set(errors.map((error) => error.engine))];
  const rows = engines
    .map((engine) => {
      const mine = errors.filter((error) => error.engine === engine);
      const levels: SeverityLevel[] = ["S4", "S3", "S2", "S1", "S0"];
      return {
        engine,
        total: mine.length,
        segments: levels.flatMap((level) => {
          const count = mine.filter((error) => error.severity === level).length;
          return count > 0 ? [{ key: `${engine}:${level}`, label: level, value: count, tone: SEVERITY_TONES[level] }] : [];
        }) as ShareSegment[],
      };
    })
    .sort((left, right) => right.total - left.total);
  const worst = rows[0] ?? null;
  return (
    <ChartCard
      title={worst ? `${engineName(worst.engine)}讲错最多，${worst.total} 条` : "没有测到讲错"}
      legend={(
        <>
          <SeverityBadge level="S3" label />
          <SeverityBadge level="S2" label />
          <SeverityBadge level="S1" label />
        </>
      )}
      state={rows.length === 0 ? "empty" : "content"}
      emptyText="这一轮没有测到讲错我方的说法。"
      height={180}
    >
      <ul className="flex flex-col gap-3">
        {rows.map((row) => (
          <li key={row.engine} data-severity-engine={row.engine} className="flex items-center gap-4">
            <span className="w-20 shrink-0 truncate text-compact text-text-2">{engineName(row.engine)}</span>
            <span className="min-w-0 flex-1"><ShareBar label={`${engineName(row.engine)} 的讲错`} segments={row.segments} legend={false} /></span>
            <span className="w-8 shrink-0 text-right text-ui font-medium tabular-nums text-text">{row.total}</span>
          </li>
        ))}
      </ul>
    </ChartCard>
  );
}

/* ---------------------------------------------------------------- by type */

function ByType({ errors }: { errors: GeoErrorRow[] }) {
  const counts = new Map<string, number>();
  for (const error of errors) counts.set(error.errorType, (counts.get(error.errorType) ?? 0) + 1);
  const rows = [...counts.entries()]
    .flatMap(([type, count]) => {
      const name = GEO_ERROR_TYPE_WORDS[type as keyof typeof GEO_ERROR_TYPE_WORDS];
      return name ? [{ type, count, name }] : [];
    })
    .sort((left, right) => right.count - left.count);
  const top = rows.reduce((max, row) => Math.max(max, row.count), 0);
  if (rows.length === 0) return null;
  return (
    <ChartCard title={`讲错最多的是「${rows[0].name}」`}>
      <DataTable
        label="讲错的类型"
        rows={rows}
        rowKey={(row) => row.type}
        columns={[
          { key: "name", header: "类型", rowHeader: true, cell: (row) => row.name },
          { key: "bar", header: "", width: "w-40", cell: (row) => <InlineBar value={row.count} max={top} tone="quiet" label={`${row.name} 的条数`} /> },
          { key: "count", header: "条数", align: "right", width: "w-16", cell: (row) => row.count },
        ]}
      />
    </ChartCard>
  );
}

/* -------------------------------------------------------------- the list */

function ErrorList({
  geoId,
  project,
  errors,
  denominator,
}: {
  geoId: string;
  project: GeoProject;
  errors: GeoErrorRow[];
  denominator: string | null;
}) {
  const [status, setStatus] = useState<GeoErrorStatus | "all">("all");
  const present = STATUS_ORDER.filter((key) => errors.some((error) => error.status === key));
  const options: FilterOption<GeoErrorStatus | "all">[] = [
    { value: "all", label: "全部", count: errors.length },
    ...present.map((key) => ({
      value: key,
      label: GEO_ERROR_STATUS_WORDS[key],
      count: errors.filter((error) => error.status === key).length,
    })),
  ];
  const shown = (status === "all" ? errors : errors.filter((error) => error.status === status))
    .slice()
    .sort((left, right) => {
      const rank = (error: GeoErrorRow) => (isSeverityLevel(error.severity) ? Number(error.severity.slice(1)) : -1);
      return rank(right) - rank(left);
    });
  if (errors.length === 0) return null;
  return (
    <ChartCard
      title="讲错清单，按严重度排序"
      meta={`${errors.length} 条`}
      state={shown.length === 0 ? "empty" : "content"}
      emptyText="这一类里没有讲错。"
      footnote={denominator}
      height={160}
    >
      <FilterChips label="处置状态" options={options} value={status} onChange={setStatus} className="mb-2" />
      <div>
        {shown.map((error) => (
          <GeoErrorCard key={error.id} geoId={geoId} project={project} error={error} />
        ))}
      </div>
    </ChartCard>
  );
}
