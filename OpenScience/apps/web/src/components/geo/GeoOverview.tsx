import { Link } from "react-router";
import { cn } from "@/lib/cn";
import {
  GEO_STEP_KEYS,
  type GeoOverviewMetric,
  type GeoOverviewMetricKey,
  type GeoProject,
  type GeoStep,
  type GeoStepKey,
  type GeoWeekItem,
} from "@/lib/geoClient";
import { List, ListRow } from "@/components/ui/ListRow";
import { AskAi } from "./AskAi";
import { formatGeoValue, GeoCellText, geoSampleText } from "./GeoCellText";
import { GeoSparkline } from "./GeoSparkline";
import { GEO_METRIC_NAMES, GEO_METRIC_UNITS, GEO_STEP_NAMES, monthDay, parseGeoDate, type GeoUnit } from "./geoText";

/** The four numbers, in the order the overview shows them. */
const METRIC_ORDER: readonly GeoOverviewMetricKey[] = ["gvi", "mention", "accuracy", "citation"];

/** 「本周」 kinds said in red: 讲错我方 and safety, the only red on the page. */
export const GEO_ALERT_KINDS: ReadonlySet<string> = new Set(["wrong_ours", "safety"]);

/**
 * 概览 (plan §5.3, mockup g03): the eight steps as one row of marks, the four
 * numbers — each with its sample, the chosen tier's target and its trend —
 * and 「本周」, four or five things that happened, each with a jump.
 */
export function GeoOverview({ geoId, project }: { geoId: string; project: GeoProject }) {
  const metrics = METRIC_ORDER.map((key) => project.overview.metrics.find((metric) => metric.key === key) ?? null);
  return (
    <div className="flex flex-col gap-8">
      <StepMarks geoId={geoId} steps={project.overview.steps ?? project.steps} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {METRIC_ORDER.map((key, index) => <MetricBlock key={key} metricKey={key} metric={metrics[index]} project={project} />)}
      </div>
      <Week geoId={geoId} items={project.overview.week} />
    </div>
  );
}

/* --------------------------------------------------------------------- steps */

type Mark = "done" | "current" | "none";

/** Which mark each step carries: done, the one being worked on, or not yet. */
export function stepMarks(steps: GeoProject["steps"]): Record<GeoStepKey, Mark> {
  const marks = {} as Record<GeoStepKey, Mark>;
  let current = false;
  for (const key of GEO_STEP_KEYS) {
    const step: GeoStep | undefined = steps[key];
    const status = step?.status ?? "none";
    if (status === "done" || status === "minimal") marks[key] = "done";
    else if (!current && (status === "running" || status === "queued" || status === "failed" || step?.requested)) {
      marks[key] = "current";
      current = true;
    } else marks[key] = "none";
  }
  return marks;
}

const MARK_WORDS: Record<Mark, string> = { done: "已完成", current: "进行中", none: "未开始" };

/** A step's progress note, only when it is a count or a week (「14/20」「第 3 周」). */
function progressNote(step: GeoStep | undefined): string | null {
  const note = step?.note?.trim();
  return note && note.length <= 10 && /^(\d+\s*\/\s*\d+|第\s*\d+\s*周)$/.test(note) ? note : null;
}

function StepMarks({ geoId, steps }: { geoId: string; steps: GeoProject["steps"] }) {
  const marks = stepMarks(steps);
  return (
    <ol aria-label="进度" className="flex flex-wrap items-center gap-y-2">
      {GEO_STEP_KEYS.map((key, index) => {
        const mark = marks[key];
        const note = progressNote(steps[key]);
        return (
          <li key={key} className="flex min-w-0 flex-1 items-center" data-geo-step={key} data-mark={mark}>
            <Link
              to={`/app/geo/${encodeURIComponent(geoId)}/${key}`}
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-1 text-ui hover:bg-surface-2",
                mark === "none" ? "text-text-3" : mark === "current" ? "font-medium text-text" : "text-text-2",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "grid h-4 w-4 shrink-0 place-items-center rounded-full",
                  mark === "done" ? "bg-accent text-accent-fg" : mark === "current" ? "border-2 border-accent" : "border border-strong",
                )}
              >
                {mark === "done" && (
                  // A drawn tick rather than an icon: it sits inside a 16 px
                  // dot, where no icon size fits.
                  <svg viewBox="0 0 16 16" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4.8 8.3l2.2 2.2 4.2-4.6" />
                  </svg>
                )}
              </span>
              {GEO_STEP_NAMES[key]}
              <span className="sr-only">，{MARK_WORDS[mark]}</span>
              {note && <span className="text-caption tabular-nums text-text-3">{note}</span>}
            </Link>
            {index < GEO_STEP_KEYS.length - 1 && <span aria-hidden="true" className="mx-2 h-px min-w-3 flex-1 bg-border" />}
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------- metrics */

/** 「+5」「−2」 between the last two readings, on the metric's own scale. */
function weekDelta(metric: GeoOverviewMetric): number | null {
  const read = metric.trend.filter((point) => point.value !== null);
  if (read.length < 2 || metric.cell.status !== "ok") return null;
  const delta = (read[read.length - 1].value as number) - (read[read.length - 2].value as number);
  return Math.round(delta);
}

function MetricBlock({ metricKey, metric, project }: { metricKey: GeoOverviewMetricKey; metric: GeoOverviewMetric | null; project: GeoProject }) {
  const name = GEO_METRIC_NAMES[metricKey];
  const unit = GEO_METRIC_UNITS[metricKey];
  const delta = metric ? weekDelta(metric) : null;
  const lastDate = metric?.trend.at(-1)?.date ?? null;
  return (
    <section aria-label={name} data-geo-metric={metricKey} className="flex min-w-0 flex-col gap-1 rounded-card bg-surface-1 px-4 pb-3 pt-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="truncate text-ui text-text-2">{name}</h3>
        <AskAi
          project={project}
          product={project.name}
          name={name}
          cell={metric?.cell ?? null}
          unit={unit}
          date={monthDay(lastDate)}
        />
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <GeoCellText cell={metric?.cell ?? null} unit={unit} size="display" hideSample />
        {metric?.target != null && <span className="text-ui tabular-nums text-text-3">目标 {formatGeoValue(metric.target, unit)}</span>}
      </div>
      <SampleLine metric={metric} unit={unit} />
      <GeoSparkline values={metric?.trend.map((point) => point.value) ?? []} target={metric?.target ?? null} width={200} height={36} className="my-1 w-full" />
      {delta !== null && delta !== 0 && (
        <p className={cn("text-caption tabular-nums", delta > 0 ? "text-accent" : "text-text-2")}>
          比上周 {delta > 0 ? `+${delta}` : `−${Math.abs(delta)}`}
        </p>
      )}
    </section>
  );
}

/** The sample under the number: 「310 次里 56 次」, or how few answers a 「样本不足」 rests on. */
function SampleLine({ metric, unit }: { metric: GeoOverviewMetric | null; unit: GeoUnit }) {
  const sample = metric ? geoSampleText(metric.cell, unit) : null;
  return sample ? <p className="text-caption tabular-nums text-text-3">{sample}</p> : null;
}

/* ---------------------------------------------------------------------- week */

const JUMP_WORDS: Record<string, string> = {
  answers: "看回答",
  evidence: "看证据",
  journey: "看旅程",
  questions: "看问题",
  diagnosis: "看诊断",
  sources: "看信源",
  content: "看稿件",
  distribution: "看投放",
  monitoring: "看监测",
};

/** Where a 「本周」 line jumps: an answer, or a tab. */
export function weekTarget(geoId: string, item: GeoWeekItem): string | null {
  const base = `/app/geo/${encodeURIComponent(geoId)}`;
  if (item.tab === "answers") return item.ref?.snapshotId ? `${base}/answers/${encodeURIComponent(item.ref.snapshotId)}` : null;
  if (item.tab === "overview") return null;
  return item.tab in GEO_STEP_NAMES ? `${base}/${item.tab}` : null;
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 「今天」「昨天」「周一」「上周五」, else 「9月12日」. */
export function dayWord(value: string | null | undefined, now: Date = new Date()): string | null {
  const date = parseGeoDate(value);
  if (!date) return null;
  const startOf = (moment: Date) => new Date(moment.getFullYear(), moment.getMonth(), moment.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(date)) / 86_400_000);
  if (days === 0) return "今天";
  if (days === 1) return "昨天";
  // Weeks start on Monday, as a Chinese calendar reads them.
  const weekday = (now.getDay() + 6) % 7;
  if (days > 0 && days <= weekday) return WEEKDAYS[date.getDay()];
  if (days > weekday && days <= weekday + 7) return `上${WEEKDAYS[date.getDay()]}`;
  return monthDay(date);
}

function Week({ geoId, items }: { geoId: string; items: GeoWeekItem[] }) {
  return (
    <section aria-labelledby="geo-week" className="flex flex-col gap-2">
      <h2 id="geo-week" className="text-ui font-semibold text-text">本周</h2>
      {items.length === 0 ? (
        <p className="py-2 text-ui text-text-3">这周还没有新的变化。</p>
      ) : (
        <List divided label="本周">
          {items.slice(0, 5).map((item, index) => {
            const to = weekTarget(geoId, item);
            const red = GEO_ALERT_KINDS.has(item.kind);
            return (
              <ListRow
                key={`${index}:${item.text}`}
                to={to ?? undefined}
                leading={<span className="w-16 text-caption text-text-3">{dayWord(item.at) ?? ""}</span>}
                title={<span className={red ? "text-danger" : undefined}>{item.text}</span>}
                trailing={to ? <span className="text-ui text-accent">{JUMP_WORDS[item.tab] ?? "查看"}</span> : undefined}
              />
            );
          })}
        </List>
      )}
    </section>
  );
}
