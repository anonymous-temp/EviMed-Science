import type { GeoErrorRow, GeoErrorType } from "@/lib/geoClient";
import { cn } from "@/lib/cn";
import { BarList } from "@/components/charts/BarList";
import { ErrorSourceBar, type ErrorSourceCounts } from "@/components/charts/ErrorSourceBar";
import { ShareBar, type ShareSegment } from "@/components/charts/ShareBar";
import { ChartCard } from "@/components/ui/ChartCard";
import { ChartGrid, type ChartGridCell } from "@/components/ui/ChartGrid";
import { SeverityBadge, type SeverityLevel } from "@/components/ui/SeverityBadge";
import { engineName, GEO_ERROR_TYPE_WORDS, zh } from "../geoText";
import { errorSourceCounts, type ErrorTrace } from "../spine/errorModel";

/** What the charts of 准确与安全 share with the list beside them: one narrowing, set from either (rule 7). */
export interface ErrorChartSelection {
  engine: string | null;
  type: GeoErrorType | null;
  trace: ErrorTrace | null;
  onEngine: (engine: string | null) => void;
  onType: (type: GeoErrorType | null) => void;
  onTrace: (trace: ErrorTrace | null) => void;
}

const SEVERITY_TONES: Record<SeverityLevel, ShareSegment["tone"]> = { S4: "s3", S3: "s3", S2: "s2", S1: "s1", S0: "s1" };

/** The four charts in a grid that is full: two to a row, the odd one out takes the whole row. */
export function ErrorCharts({
  errors,
  composition,
  compositionTitle,
  denominator,
  selection,
}: {
  errors: readonly GeoErrorRow[];
  /** How the round's answers divide: right about us, left us out, wrong about us, wrong about a rival. */
  composition: readonly ShareSegment[];
  compositionTitle: string;
  denominator: string | null;
  selection: ErrorChartSelection;
}) {
  const cells: Array<Pick<ChartGridCell, "key" | "node">> = [
    {
      key: "composition",
      node: (
        <ChartCard
          title={compositionTitle}
          state={composition.every((segment) => segment.value === 0) ? "empty" : "content"}
          emptyText="这一轮还没有统计出回答的构成。"
          // Counted by answer, beside a rate counted by statement: the footnote says which, so “讲错 44 次” is not read against
          // “准确率 68%” as a share of the same thing (G17).
          footnote={[denominator, "事实准确率按每条陈述计算，和这里按回答计的次数不能互相换算"].filter(Boolean).join(" · ")}
          height={120}
        >
          <ShareBar label="回答的构成" segments={composition} format={(value) => `${Math.round(value)} 次`} />
        </ChartCard>
      ),
    },
    { key: "severity", node: <BySeverity errors={errors} selection={selection} /> },
    ...(errors.length > 0 ? [
      { key: "type", node: <ByType errors={errors} selection={selection} /> },
      { key: "source", node: <BySource errors={errors} selection={selection} /> },
    ] : []),
  ];
  const rows: ChartGridCell[][] = [];
  for (let at = 0; at < cells.length; at += 2) {
    const pair = cells.slice(at, at + 2);
    rows.push(pair.map((cell) => ({ ...cell, span: pair.length === 1 ? 2 : 1 })));
  }
  return <ChartGrid rows={rows} columns={2} />;
}

/* ------------------------------------------------------- severity × engine */

function BySeverity({ errors, selection }: { errors: readonly GeoErrorRow[]; selection: ErrorChartSelection }) {
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
      <ul aria-label="各引擎讲错的条数，按严重度" className="flex flex-col gap-1">
        {rows.map((row) => {
          const chosen = selection.engine === row.engine;
          return (
            <li key={row.engine} data-severity-engine={row.engine}>
              <button
                type="button"
                aria-pressed={chosen}
                aria-label={`${engineName(row.engine)}，讲错 ${row.total} 条`}
                onClick={() => selection.onEngine(chosen ? null : row.engine)}
                className={cn("flex h-sm w-full items-center gap-4 rounded px-2 hover:bg-surface-2", chosen && "bg-accent-soft")}
              >
                <span className="w-20 shrink-0 truncate text-left text-compact text-text-2">{engineName(row.engine)}</span>
                <span className="min-w-0 flex-1"><ShareBar label={`${engineName(row.engine)} 的讲错`} segments={row.segments} legend={false} /></span>
                <span className="w-8 shrink-0 text-right text-ui tabular-nums text-text">{row.total}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </ChartCard>
  );
}

/* ---------------------------------------------------------------- by type */

function ByType({ errors, selection }: { errors: readonly GeoErrorRow[]; selection: ErrorChartSelection }) {
  const counts = new Map<string, number>();
  for (const error of errors) counts.set(error.errorType, (counts.get(error.errorType) ?? 0) + 1);
  const rows = [...counts.entries()]
    .flatMap(([type, value]) => {
      const label = GEO_ERROR_TYPE_WORDS[type as GeoErrorType];
      return label ? [{ key: type, label, value, unit: "条" }] : [];
    })
    .sort((left, right) => right.value - left.value);
  if (rows.length === 0) return null;
  return (
    <ChartCard title={`讲错最多的是“${rows[0].label}”`}>
      <BarList
        label="讲错的类型"
        rows={rows}
        selected={selection.type}
        onSelect={(key) => selection.onType(key as GeoErrorType | null)}
        tone="quiet"
      />
    </ChartCard>
  );
}

/* --------------------------------------------------------------- by source */

function BySource({ errors, selection }: { errors: readonly GeoErrorRow[]; selection: ErrorChartSelection }) {
  const counts: ErrorSourceCounts = errorSourceCounts(errors);
  const total = counts.traced + counts.unattributable + counts.noRetrieval;
  return (
    <ChartCard
      title={counts.traced > 0 ? `${total} 条讲错里，${counts.traced} 条能追到被引用的页面` : `${total} 条讲错里，没有一条能追到被引用的页面`}
    >
      <ErrorSourceBar counts={counts} selected={selection.trace} onSelect={selection.onTrace} />
    </ChartCard>
  );
}
