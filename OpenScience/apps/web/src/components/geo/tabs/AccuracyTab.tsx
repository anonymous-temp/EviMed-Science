import { useState } from "react";
import { useSearchParams } from "react-router";
import {
  getGeoDiagnosis,
  getGeoMonitoring,
  readGeoCell,
  type GeoDiagnosis,
  type GeoErrorCounts,
  type GeoErrorRow,
  type GeoMonitoring,
  type GeoProject,
} from "@/lib/geoClient";
import { Button } from "@/components/ui/Button";
import { ChartCard } from "@/components/ui/ChartCard";
import { DataTable, InlineBar } from "@/components/ui/DataTable";
import { Delta } from "@/components/ui/Delta";
import { Disclosure } from "@/components/ui/Disclosure";
import { FilterChips, type FilterOption } from "@/components/ui/FilterChips";
import { StatBand, StatTile } from "@/components/ui/StatTile";
import { isSeverityLevel, SeverityBadge, type SeverityLevel } from "@/components/ui/SeverityBadge";
import { ShareBar, type ShareSegment } from "@/components/charts/ShareBar";
import { GeoErrorCard } from "../GeoErrorCard";
import { formatGeoValue, geoCellPhrase } from "../GeoCellText";
import { denominatorLine, readingChange, shownDelta, tileValue } from "../geoOverviewModel";
import { engineName, GEO_ERROR_TYPE_WORDS, zh } from "../geoText";
import { metricName, metricUnit } from "./geoTabText";
import { TabError, TabSkeleton, useGeoLoad } from "./geoTabKit";

/**
 * 准确与安全 — the part of this product no general AI-visibility tool has
 * (appendix E §0.6): not “are we mentioned” but “is what it says about the
 * medicine true, and would a wrong answer hurt someone”.
 *
 * The accuracy rate is the headline, drawn as what it is — how many statements
 * were right against how many were wrong — and the wrong ones are graded by
 * what they would cost a patient, grouped by where their handling stands. Red
 * belongs to the severity badge and the ✗; the sentences themselves are body
 * text, which is the difference between a page a reader works through and the
 * wall of red the old board was.
 */

/** How many findings the list shows before 「显示更多」. */
const PAGE = 20;
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
  const counts = errorTotals(diagnosis, errors);
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
      // The accuracy rate has no measured band: its change is stated as a change, by the one rule.
      delta: accuracy ? shownDelta(readingChange(accuracy.trend)) : null,
      note: accuracy?.target != null ? `目标 ${formatGeoValue(accuracy.target, "percent")}` : null,
      hint: accuracy ? geoCellPhrase(accuracy.cell, "percent") : undefined as string | undefined,
      polarity: "up" as const,
      tone: "default" as const,
      lead: true,
    },
    {
      key: "severe",
      label: "严重讲错",
      value: String(counts.severe),
      unit: "条" as string | undefined,
      placeholder: false,
      hint: undefined as string | undefined,
      delta: null,
      // No second number beneath it: every open error, of every grade, is a chip of the list below.
      note: null as string | null,
      polarity: "down" as const,
      tone: counts.severe > 0 ? "safety" as const : "default" as const,
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

      {/* The findings come straight after the numbers: they are what a reader came for, and the distributions are how to read them. */}
      <ErrorList geoId={geoId} project={project} errors={errors} counts={counts} denominator={denominator} />

      <Disclosure summary="按引擎和类型看分布">
        <div className="flex flex-col gap-6 pt-1">
          {/* Counted by answer, beside a rate counted by statement: the heading
              says which, so “讲错 44 次” is not read against “准确率 68%” as a
              share of the same thing (G17). */}
          <ChartCard
            title={correct.numerator != null && wrongOurs.numerator != null
              ? `按回答计，讲错我方 ${wrongOurs.numerator.toLocaleString("zh-CN")} 次、讲对 ${correct.numerator.toLocaleString("zh-CN")} 次`
              : "这一轮的回答里我方出现在哪些位置"}
            state={composition.every((segment) => segment.value === 0) ? "empty" : "content"}
            emptyText="这一轮还没有统计出回答的构成。"
            footnote={[denominator, "事实准确率按每条陈述计算，和这里按回答计的次数不能互相换算"].filter(Boolean).join(" · ")}
            height={120}
          >
            <ShareBar label="回答的构成" segments={composition} format={(value) => `${Math.round(value)} 次`} />
          </ChartCard>
          <BySeverity errors={errors} />
          <ByType errors={errors} />
        </div>
      </Disclosure>
    </div>
  );
}

/**
 * The project's errors by status, from the server's count over every row when it sent one (the list it carries is capped), else
 * from the rows in hand. `working` is everything being handled: acted on, or waiting for the remeasure that confirms it.
 */
export function errorTotals(diagnosis: GeoDiagnosis, rows: readonly GeoErrorRow[]): { total: number; open: number; working: number; closed: number; severe: number } {
  const counted: GeoErrorCounts | undefined = diagnosis.errorCounts;
  if (counted && typeof counted.total === "number") {
    return { total: counted.total, open: counted.open, working: counted.acting + counted.awaiting_remeasure, closed: counted.closed, severe: counted.severe };
  }
  return {
    total: rows.length,
    open: rows.filter((error) => error.status === "open").length,
    working: rows.filter((error) => error.status === "acting" || error.status === "awaiting_remeasure").length,
    closed: rows.filter((error) => error.status === "closed").length,
    severe: rows.filter(isSevere).length,
  };
}

/** A live error that would reach a patient (S3 or S4). */
const isSevere = (error: GeoErrorRow) => error.status !== "closed" && (error.severity === "S3" || error.severity === "S4");

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
      title={worst ? zh`${engineName(worst.engine)}讲错最多，${worst.total} 条` : "没有测到讲错"}
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
            <span className="w-8 shrink-0 text-right text-ui tabular-nums text-text">{row.total}</span>
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
    <ChartCard title={`讲错最多的是“${rows[0].name}”`}>
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

type Show = "severe" | "open" | "acting" | "all";
const SHOWS: readonly Show[] = ["severe", "open", "acting", "all"];

const matches: Record<Show, (error: GeoErrorRow) => boolean> = {
  severe: isSevere,
  open: (error) => error.status === "open",
  acting: (error) => error.status === "acting" || error.status === "awaiting_remeasure",
  all: () => true,
};

function ErrorList({
  geoId,
  project,
  errors,
  counts,
  denominator,
}: {
  geoId: string;
  project: GeoProject;
  errors: GeoErrorRow[];
  counts: ReturnType<typeof errorTotals>;
  denominator: string | null;
}) {
  // The chip is in the address, so the answer page's way back returns to the list as it was left.
  const [params, setParams] = useSearchParams();
  const [shown, setShown] = useState(PAGE);
  const sizes: Record<Show, number> = { severe: counts.severe, open: counts.open, acting: counts.working, all: counts.total };
  const options: FilterOption<Show>[] = [
    ...(["severe", "open", "acting"] as const).filter((key) => sizes[key] > 0).map((key) => ({ value: key, label: SHOW_LABELS[key], count: sizes[key] })),
    { value: "all", label: "全部", count: sizes.all },
  ];
  const wanted = SHOWS.find((key) => key === params.get("show"));
  const show: Show = wanted && options.some((option) => option.value === wanted) ? wanted : counts.severe > 0 ? "severe" : "all";
  const rank = (error: GeoErrorRow) => (isSeverityLevel(error.severity) ? Number(error.severity.slice(1)) : -1);
  // Live findings before closed ones, the gravest first; a stable sort keeps the server's recency within a grade.
  const rows = errors.filter(matches[show]).slice().sort((left, right) => Number(left.status === "closed") - Number(right.status === "closed") || rank(right) - rank(left));
  const visible = rows.slice(0, shown);
  const unlisted = sizes[show] - rows.length;
  const choose = (next: Show) => {
    setShown(PAGE);
    setParams((previous) => {
      const copy = new URLSearchParams(previous);
      copy.set("show", next);
      return copy;
    }, { replace: true });
  };
  if (counts.total === 0 && errors.length === 0) return null;
  return (
    <ChartCard
      title="讲错清单，按严重度排序"
      state={rows.length === 0 ? "empty" : "content"}
      emptyText="这一类里没有讲错。"
      footnote={denominator}
      height={160}
    >
      <FilterChips label="处置状态" options={options} value={show} onChange={choose} className="mb-2" />
      <div data-geo-error-list="">
        {visible.map((error) => (
          <GeoErrorCard key={error.id} geoId={geoId} project={project} error={error} />
        ))}
      </div>
      {rows.length > visible.length && (
        <div className="pt-2">
          <Button variant="text" size="sm" onClick={() => setShown((count) => count + PAGE)}>
            {`显示更多 · 还有 ${rows.length - visible.length} 条`}
          </Button>
        </div>
      )}
      {unlisted > 0 && <p className="pt-2 text-caption text-text-3">{`这里列出了 ${rows.length} 条，还有 ${unlisted} 条没有列出。`}</p>}
    </ChartCard>
  );
}

const SHOW_LABELS: Record<Exclude<Show, "all">, string> = { severe: "严重", open: "待处理", acting: "处置中" };
