import { useState } from "react";
import { getGeoMonitoring, readGeoCell, type GeoCell, type GeoMonitoring, type GeoProject, type GeoSeriesPoint } from "@/lib/geoClient";
import { FilterChips, type FilterOption } from "@/components/ui/FilterChips";
import { List, ListRow } from "@/components/ui/ListRow";
import { Tag } from "@/components/ui/Tag";
import { AskAi } from "../AskAi";
import { formatGeoValue, GeoCellText } from "../GeoCellText";
import { engineName, GEO_METRIC_NAMES, monthDay, type GeoUnit } from "../geoText";
import { GeoLineChart } from "./GeoCharts";
import { answerPath, errorLine, metricName, metricUnit, roundKindWord, signed } from "./geoTabText";
import { FilterRow, StepPending, TabError, TabSection, TabSkeleton, useGeoLoad } from "./geoTabKit";

/** A point on fewer answers than this is 「样本不足」: not drawn, not stated. */
const MIN_SAMPLE = 30;

/**
 * 监测 (plan §3.8, mockup g11): the four numbers' trends against the chosen
 * tier's target; the articles' semantic groups against the control groups and
 * the net effect between them, flat when it is inside the noise band; each
 * engine's line; the articles an engine has cited; the new wrong sentences.
 */
export function MonitoringTab({ geoId, project }: { geoId: string; project: GeoProject }) {
  const { state, reload } = useGeoLoad(`monitoring:${geoId}`, () => getGeoMonitoring(geoId));
  if (state.kind === "loading") return <TabSkeleton />;
  if (state.kind === "error") return <TabError message={state.message} onRetry={reload} />;
  const data = state.data;
  const series = (Array.isArray(data?.series) ? data.series : []).filter((line) => line && metricName(line.key) && Array.isArray(line.points) && line.points.length > 0);
  if (series.length === 0) return <StepPending geoId={geoId} project={project} step="monitoring" />;
  return <Monitoring geoId={geoId} project={project} data={data} series={series} />;
}

/** A point's value, or null when it rests on too few answers to be stated. */
function readable(point: GeoSeriesPoint): number | null {
  if (typeof point.value !== "number" || !Number.isFinite(point.value)) return null;
  if (typeof point.n === "number" && point.n < MIN_SAMPLE) return null;
  return point.value;
}

/** The latest point as a cell, so it reads 「38，310 次回答」 or 「样本不足」 like every other number. */
function pointCell(point: GeoSeriesPoint | undefined): GeoCell {
  if (!point) return readGeoCell(null);
  const insufficient = typeof point.n === "number" && point.n < MIN_SAMPLE;
  return readGeoCell({
    value: point.value,
    numerator: point.k,
    denominator: point.n,
    status: typeof point.value !== "number" ? "not_measurable" : insufficient ? "insufficient" : "ok",
  });
}

function Monitoring({ geoId, project, data, series }: { geoId: string; project: GeoProject; data: GeoMonitoring; series: GeoMonitoring["series"] }) {
  const [key, setKey] = useState(series[0].key);
  const line = series.find((item) => item.key === key) ?? series[0];
  const unit = metricUnit(line.key);
  const name = metricName(line.key) ?? "";
  const target = project.overview.metrics.find((metric) => metric.key === line.key || GEO_METRIC_NAMES[metric.key] === name)?.target ?? null;
  const last = line.points[line.points.length - 1];
  const product = project.product?.brandName || project.product?.genericName || project.name;
  const conversation = { projectId: project.projectId, sessionId: project.sessionId };
  const options: FilterOption<string>[] = series.map((item) => ({ value: item.key, label: metricName(item.key) ?? "" }));
  const next = data.next && data.next.date ? [roundKindWord(data.next.kind) ?? "下次测量", monthDay(data.next.date)].filter(Boolean).join(" · ") : null;
  const tick = (value: number) => (unit === "percent" ? `${Math.round(value)}%` : String(Math.round(value)));

  return (
    <div data-geo-tab="monitoring">
      <FilterRow summary={next ? `下次 ${next}` : undefined}>
        <FilterChips label="指标" options={options} value={line.key} onChange={setKey} />
      </FilterRow>
      <section aria-label={name} className="mt-6">
        <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <GeoCellText cell={pointCell(last)} unit={unit} size="display" />
          {typeof target === "number" && <span className="text-caption tabular-nums text-text-3">{`目标 ${formatGeoValue(target, unit)}`}</span>}
          {last?.date && <span className="text-caption text-text-3">{`${monthDay(last.date)}测量`}</span>}
          <AskAi project={conversation} product={product} name={name} cell={pointCell(last)} unit={unit} date={monthDay(last?.date)} />
        </div>
        <GeoLineChart
          series={[{ key: line.key, values: line.points.map(readable) }]}
          labels={line.points.map((point) => monthDay(point.date) ?? "")}
          target={typeof target === "number" ? target : null}
          formatTick={tick}
        />
      </section>
      <Arms project={project} arms={data.arms} product={product} />
      <ByEngine rows={data.byEngine} />
      <NewErrors geoId={geoId} rows={data.newErrors} />
      <Cited rows={data.cited} />
    </div>
  );
}

/**
 * The pilot groups (where articles were placed) against the control groups
 * (only measured), on the index; the net effect is the pilot's change minus
 * the control's, and a net effect inside the noise band is 持平 — no arrow.
 */
function Arms({ project, arms, product }: { project: GeoProject; arms: GeoMonitoring["arms"] | null | undefined; product: string }) {
  const pilot = Array.isArray(arms?.pilot) ? arms.pilot : [];
  const control = Array.isArray(arms?.control) ? arms.control : [];
  if (pilot.length === 0 && control.length === 0) return null;
  const cell = readGeoCell(arms?.netEffect);
  const band = typeof arms?.netEffect?.noiseBand === "number" ? arms.netEffect.noiseBand : null;
  const dates = [...new Set([...pilot, ...control].map((point) => point.date))].sort();
  const valueAt = (points: typeof pilot) => dates.map((date) => {
    const found = points.find((point) => point.date === date);
    return found && typeof found.value === "number" ? found.value : null;
  });
  const change = (points: typeof pilot): number | null => {
    const read = points.filter((point) => typeof point.value === "number");
    return read.length >= 2 ? (read[read.length - 1].value as number) - (read[0].value as number) : null;
  };
  const pilotChange = change(pilot);
  const controlChange = change(control);
  const flat = cell.status === "ok" && cell.value !== null && band !== null && Math.abs(cell.value) <= band;
  const net = cell.status !== "ok" || cell.value === null ? null : flat ? "持平" : signed(cell.value);
  const conversation = { projectId: project.projectId, sessionId: project.sessionId };
  const draft = `${product} · 净效应（投放的语义群减去对照组）：${net ?? (cell.status === "insufficient" ? "样本不足" : "—")}${band !== null ? `，波动范围 ±${Math.round(band * 10) / 10}` : ""}。这说明投放有没有用，接下来该做什么？`;

  return (
    <TabSection title="投放与对照" className="mt-10">
      <GeoLineChart
        series={[{ key: "pilot", values: valueAt(pilot) }, { key: "control", values: valueAt(control), tone: "muted" }]}
        labels={dates.map((date) => monthDay(date) ?? "")}
        height={144}
      />
      <div data-geo-arms="" className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-ui text-text-2">
        <span className="inline-flex items-center gap-2">
          <span aria-hidden="true" className="h-0.5 w-4 bg-accent" />
          投放的语义群
          {pilotChange !== null && <span className="font-medium tabular-nums text-text">{signed(pilotChange)}</span>}
        </span>
        <span className="inline-flex items-center gap-2">
          <span aria-hidden="true" className="h-0.5 w-4 bg-text-3" />
          对照组
          {controlChange !== null && <span className="font-medium tabular-nums text-text">{signed(controlChange)}</span>}
        </span>
        <span data-geo-net-effect={flat ? "flat" : cell.status} className="inline-flex items-center gap-2">
          净效应
          {net !== null
            ? <span className="font-medium tabular-nums text-text">{net}</span>
            : <GeoCellText cell={cell} unit="index" />}
          {band !== null && <span className="text-caption tabular-nums text-text-3">{`波动范围 ±${Math.round(band * 10) / 10}`}</span>}
        </span>
        <AskAi project={conversation} draft={draft} className="ml-auto" />
      </div>
    </TabSection>
  );
}

function engineUnit(points: GeoSeriesPoint[]): GeoUnit {
  // A rate carries its numerator; the index does not.
  return points.some((point) => typeof point.k === "number") ? "percent" : "index";
}

function ByEngine({ rows }: { rows: GeoMonitoring["byEngine"] | null | undefined }) {
  const lines = (Array.isArray(rows) ? rows : []).filter((row) => row && row.engine && Array.isArray(row.points) && row.points.length > 0);
  if (lines.length === 0) return null;
  return (
    <TabSection title="各引擎">
      <ul className="grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-3 lg:grid-cols-5">
        {lines.map((row) => {
          const unit = engineUnit(row.points);
          const last = row.points[row.points.length - 1];
          return (
            <li key={row.engine} data-geo-engine-trend={row.engine} className="flex min-w-0 flex-col gap-1">
              <span className="text-ui text-text-2">{engineName(row.engine)}</span>
              <GeoCellText cell={pointCell(last)} unit={unit} layout="stack" />
              <GeoLineChart series={[{ key: row.engine, values: row.points.map(readable) }]} axes={false} height={32} className="mt-1" />
            </li>
          );
        })}
      </ul>
    </TabSection>
  );
}

function NewErrors({ geoId, rows }: { geoId: string; rows: GeoMonitoring["newErrors"] | null | undefined }) {
  const errors = (Array.isArray(rows) ? rows : []).filter((row) => row && row.id && row.status !== "closed");
  if (errors.length === 0) return null;
  return (
    <TabSection title="需要处理">
      <List divided>
        {errors.map((error) => (
          <ListRow
            key={error.id}
            leading={<span className="w-16"><Tag tone="safety">讲错我方</Tag></span>}
            title={errorLine(error)}
            to={error.snapshotId ? answerPath(geoId, error.snapshotId) : undefined}
            trailing={error.snapshotId ? <span className="text-accent">看回答</span> : undefined}
          />
        ))}
      </List>
    </TabSection>
  );
}

function Cited({ rows }: { rows: GeoMonitoring["cited"] | null | undefined }) {
  const byArticle = new Map<string, { title: string; engines: string[]; firstSeen: string }>();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !row.articleId) continue;
    const entry = byArticle.get(row.articleId) ?? { title: row.title, engines: [], firstSeen: row.firstSeen };
    if (!entry.engines.includes(row.engine)) entry.engines.push(row.engine);
    if (row.firstSeen && (!entry.firstSeen || row.firstSeen < entry.firstSeen)) entry.firstSeen = row.firstSeen;
    byArticle.set(row.articleId, entry);
  }
  if (byArticle.size === 0) return null;
  return (
    <TabSection title="被 AI 引用的稿件">
      <List divided>
        {[...byArticle.entries()].map(([id, article]) => (
          <ListRow
            key={id}
            title={article.title || "未命名稿件"}
            trailing={(
              <>
                <span>{article.engines.map((engine) => engineName(engine)).join("、")}</span>
                <span className="tabular-nums">{monthDay(article.firstSeen) ?? ""}</span>
              </>
            )}
          />
        ))}
      </List>
    </TabSection>
  );
}
