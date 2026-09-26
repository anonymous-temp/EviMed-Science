/**
 * What 总览 says, decided before anything is drawn.
 *
 * The first screen answers three questions in order — **where do we stand,
 * did it move this week, what next** (appendix E §0) — and every one of them
 * is a judgement over numbers that may not exist yet. Keeping the judgement
 * here means the rules a reader relies on can be tested without a browser:
 *
 *  - a rate under thirty answers is 「样本不足」 and never a number;
 *  - a change inside the measured fluctuation band is 「持平」;
 *  - a denominator is stated once for the band, not in every tile;
 *  - an engine that dropped out is named, and never counted as zero;
 *  - nothing is said that was not measured. Where the platform has no rival
 *    reading, the page says so in a sentence rather than drawing an empty
 *    ranking.
 */
import {
  GEO_STEP_KEYS,
  readGeoCell,
  type GeoCell,
  type GeoDiagnosis,
  type GeoMonitoring,
  type GeoOverviewMetricKey,
  type GeoProject,
  type GeoSeriesPoint,
  type GeoStepKey,
  type GeoWeekItem,
} from "@/lib/geoClient";
import type { RailState, RailStep } from "@/components/ui/ProgressRail";
import type { DeltaPolarity } from "@/components/ui/Delta";
import { formatGeoValue, geoCellPhrase, geoCellWord } from "./GeoCellText";
import { engineName, GEO_METRIC_NAMES, GEO_METRIC_UNITS, GEO_STEP_NAMES, monthDay, parseGeoDate, type GeoUnit } from "./geoText";
import { GEO_TAB_REDIRECTS, geoTabPath } from "./geoTabs";
import { metricName, metricUnit } from "./tabs/geoTabText";

/* ------------------------------------------------------------------- tiles */

export interface OverviewTile {
  key: string;
  label: string;
  /** The bare number, or the word standing in for it. */
  value: string;
  /** Set only beside a number: the tile prints the unit, so the value does not. */
  unit?: string;
  /** Whether `value` is a word rather than a number. */
  placeholder: boolean;
  /** The change against the previous reading, on the metric's own scale. */
  delta: number | null;
  /** The metric's measured fluctuation band, where one applies to it. */
  noise: number | null;
  polarity: DeltaPolarity;
  /** 「较上次 · 目标 65」. */
  note: string | null;
  target: number | null;
  /** The readings behind it, for the sparkline. */
  trend: Array<number | null>;
  /** The sample, as a tooltip only. */
  hint?: string;
  lead: boolean;
  tone: "default" | "safety";
}

const TILE_ORDER: readonly GeoOverviewMetricKey[] = ["gvi", "mention", "accuracy", "citation"];
const UNIT_TEXT: Record<GeoUnit, string | undefined> = { index: "/ 100", percent: "%", count: undefined };

/** The number without its unit — the tile sets the unit beside it, once. */
export function tileValue(cell: GeoCell | null | undefined, unit: GeoUnit): { value: string; unit?: string; placeholder: boolean } {
  const word = geoCellWord(cell, unit);
  return cell?.status === "ok" && cell.value !== null
    ? { value: unit === "percent" ? word.replace(/%$/, "") : word, unit: UNIT_TEXT[unit], placeholder: false }
    : { value: word, placeholder: true };
}

/** 「+5」 between the last two stated readings, or null when there is only one. */
export function readingDelta(trend: ReadonlyArray<number | null>): number | null {
  const stated = trend.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (stated.length < 2) return null;
  return Math.round((stated[stated.length - 1] - stated[stated.length - 2]) * 10) / 10;
}

/** The metric a catalogue id names, when the diagnosis measured one this page wants. */
function extraMetric(diagnosis: GeoDiagnosis | null, ids: readonly string[]): { cell: GeoCell; unit: GeoUnit; name: string } | null {
  for (const row of Array.isArray(diagnosis?.more) ? diagnosis.more : []) {
    if (!row || !ids.includes(row.metricId)) continue;
    const cell = readGeoCell(row.cell);
    if (cell.status !== "ok") continue;
    return { cell, unit: metricUnit(row.metricId), name: metricName(row.metricId) ?? row.name };
  }
  return null;
}

/** Open wrong statements about us that would reach a patient: the safety tile's number. */
export function severeOpenErrors(diagnosis: GeoDiagnosis | null): number {
  return (Array.isArray(diagnosis?.errors) ? diagnosis.errors : [])
    .filter((error) => error && error.status !== "closed" && (error.severity === "S3" || error.severity === "S4"))
    .length;
}

export function overviewTiles(project: GeoProject, diagnosis: GeoDiagnosis | null): OverviewTile[] {
  const noise = typeof diagnosis?.noise?.band === "number" ? diagnosis.noise.band : null;
  const tiles: OverviewTile[] = [];
  for (const key of TILE_ORDER) {
    const metric = project.overview.metrics.find((item) => item.key === key) ?? null;
    const unit = GEO_METRIC_UNITS[key];
    const cell = metric?.cell ?? null;
    const trend = metric?.trend.map((point) => point.value) ?? [];
    tiles.push({
      key,
      label: GEO_METRIC_NAMES[key],
      ...tileValue(cell, unit),
      delta: cell?.status === "ok" ? readingDelta(trend) : null,
      // The band was measured on the index; it does not transfer to a rate.
      noise: key === "gvi" ? noise : null,
      polarity: "up",
      note: metric?.target != null ? `目标 ${formatGeoValue(metric.target, unit)}` : null,
      target: metric?.target ?? null,
      trend,
      hint: cell ? `${GEO_METRIC_NAMES[key]}：${geoCellPhrase(cell, unit)}` : undefined,
      lead: key === "gvi",
      tone: "default",
    });
  }
  // 声量份额 sits between 提及率 and 准确率 when the round measured it.
  const share = extraMetric(diagnosis, ["M-04"]);
  if (share) {
    tiles.splice(2, 0, {
      key: "share",
      label: share.name,
      ...tileValue(share.cell, share.unit),
      delta: null,
      noise: null,
      polarity: "up",
      note: null,
      target: null,
      trend: [],
      hint: `${share.name}：${geoCellPhrase(share.cell, share.unit)}`,
      lead: false,
      tone: "default",
    });
  }
  // 用药安全 is the last cell and the only red one on the band.
  const severe = severeOpenErrors(diagnosis);
  const risk = extraMetric(diagnosis, ["M-15"]);
  tiles.push({
    key: "safety",
    label: "用药安全",
    value: diagnosis ? String(severe) : "—",
    unit: diagnosis ? "条严重讲错" : undefined,
    placeholder: !diagnosis,
    delta: null,
    noise: null,
    polarity: "down",
    note: risk ? `${risk.name} ${formatGeoValue(risk.cell.value ?? 0, risk.unit)}` : null,
    target: null,
    trend: [],
    lead: false,
    tone: severe > 0 ? "safety" : "default",
  });
  return tiles;
}

/* --------------------------------------------------------------- headline */

/**
 * The one sentence at the top: where we stand, whether it moved, and what is
 * still open. Only clauses the platform actually measured are written.
 */
export function headlineSentence(project: GeoProject, diagnosis: GeoDiagnosis | null): string {
  const gvi = project.overview.metrics.find((metric) => metric.key === "gvi") ?? null;
  const parts: string[] = [];
  if (gvi && gvi.cell.status === "ok" && gvi.cell.value !== null) {
    const delta = readingDelta(gvi.trend.map((point) => point.value));
    const band = typeof diagnosis?.noise?.band === "number" ? diagnosis.noise.band : null;
    const flat = delta !== null && band !== null && Math.abs(delta) <= band;
    const move = delta === null ? "这是第一次测量"
      : flat || Math.round(delta) === 0 ? "与上次持平"
        : `比上次${delta > 0 ? "高" : "低"} ${Math.abs(Math.round(delta))}`;
    const target = gvi.target != null ? `，目标 ${formatGeoValue(gvi.target, "index")}` : "";
    parts.push(`综合可见度 ${formatGeoValue(gvi.cell.value, "index")}，${move}${target}`);
  } else if (gvi?.cell.status === "insufficient") {
    parts.push("这一轮的有效回答还不够，综合可见度先不下结论");
  } else {
    parts.push("还没有测过各家 AI 怎么回答这个产品");
  }
  const severe = severeOpenErrors(diagnosis);
  if (severe > 0) parts.push(`还有 ${severe} 条严重讲错待处理`);
  return `${parts.join("；")}。`;
}

/* ------------------------------------------------------------ denominator */

/**
 * The band's one denominator, and the engines it does not cover: 「按 4 个
 * 引擎、264 次有效回答计算 · 豆包本周未测」. Null when nothing was measured —
 * there is no denominator to declare.
 */
export function denominatorLine(project: GeoProject, diagnosis: GeoDiagnosis | null): string | null {
  const round = diagnosis?.round ?? null;
  if (!round) return null;
  const engines = Array.isArray(round.engines) ? round.engines : [];
  const parts: string[] = [];
  if (engines.length) parts.push(`按 ${engines.length} 个引擎`);
  if (typeof round.done === "number" && round.done > 0) {
    parts.push(`${round.done.toLocaleString("zh-CN")} 次有效回答计算`);
  } else if (parts.length) {
    parts[0] = `${parts[0]}计算`;
  }
  const missing = (project.engines ?? []).filter((engine) => !engines.includes(engine));
  const line = parts.join("、");
  const absent = missing.length ? `${missing.map(engineName).join("、")}本轮未测` : null;
  return [line || null, absent].filter(Boolean).join(" · ") || null;
}

/* ------------------------------------------------------------------- rail */

/**
 * The programme's steps. The overview carries its own copy and it is the one
 * to read — except when it is empty, which says nothing rather than saying
 * that nothing has been done.
 */
function projectSteps(project: GeoProject): GeoProject["steps"] {
  const overview = project.overview?.steps ?? {};
  return Object.keys(overview).length > 0 ? overview : project.steps;
}

/** A step's note, when the server wrote a short one worth printing. */
function railNote(note: string | null | undefined): string | null {
  const text = (note ?? "").trim();
  return text && text.length <= 12 ? text : null;
}

/**
 * The eight steps as the header rail. One of them may be `waiting`: the
 * program's single money stop — a placement budget only a person may set —
 * and it is drawn as the thing the reader owes.
 */
export function railSteps(project: GeoProject, geoTabPathOf: (step: GeoStepKey) => string): RailStep[] {
  const steps = projectSteps(project);
  const needsBudget = project.budget === null || !(project.budget.totalCny > 0);
  return GEO_STEP_KEYS.map((key) => {
    const step = steps[key];
    const status = step?.status ?? "none";
    const done = status === "done" || status === "minimal";
    const working = status === "running" || status === "queued" || status === "failed";
    const waiting = key === "distribution" && needsBudget && !done && (step?.requested === true || working);
    const state: RailState = waiting ? "waiting" : done ? "done" : working ? "active" : "todo";
    return {
      key,
      name: GEO_STEP_NAMES[key],
      note: waiting ? "待你确认预算" : railNote(step?.note),
      state,
      to: geoTabPathOf(key),
    };
  });
}

/* --------------------------------------------------------------- next step */

export interface NextStep {
  key: string;
  text: string;
  state: "waiting" | "active" | "done";
  when: string | null;
}

/** 「下一步」: what is waiting on the reader first, then what is under way, then what is finished. */
export function nextSteps(project: GeoProject): NextStep[] {
  const steps = projectSteps(project);
  const needsBudget = project.budget === null || !(project.budget.totalCny > 0);
  const rows: NextStep[] = [];
  if (needsBudget && steps.distribution && steps.distribution.status !== "done") {
    rows.push({ key: "budget", text: "确认投放预算", state: "waiting", when: null });
  }
  for (const key of GEO_STEP_KEYS) {
    const step = steps[key];
    if (!step) continue;
    const note = railNote(step.note);
    const name = GEO_STEP_NAMES[key];
    if (step.status === "running" || step.status === "queued") {
      rows.push({ key, text: note ? `${name} ${note}` : `${name}进行中`, state: "active", when: null });
    }
  }
  for (const key of [...GEO_STEP_KEYS].reverse()) {
    const step = steps[key];
    if (!step || (step.status !== "done" && step.status !== "minimal")) continue;
    const note = railNote(step.note);
    rows.push({ key: `done:${key}`, text: note ? `${GEO_STEP_NAMES[key]} ${note}` : `${GEO_STEP_NAMES[key]}已完成`, state: "done", when: monthDay(step.updatedAt) });
    if (rows.length >= 5) break;
  }
  return rows.slice(0, 5);
}

/* ----------------------------------------------------------- engine matrix */

export interface EngineMatrix {
  columns: Array<{ key: string; header: string }>;
  rows: Array<{
    key: string;
    header: string;
    cells: Array<{ value: number | null; text: string; hint?: string }>;
    unmeasured: string | null;
  }>;
}

const ENGINE_COLUMNS: ReadonlyArray<{ key: "mention" | "accuracy" | "citation" | "retrieval"; header: string; deep: boolean }> = [
  { key: "mention", header: "品牌提及率", deep: false },
  { key: "accuracy", header: "事实准确率", deep: true },
  { key: "citation", header: "引用命中率", deep: true },
  { key: "retrieval", header: "检索触发率", deep: true },
];

/** Engines whose channel only sees whether we were mentioned at all. */
const MENTION_ONLY: ReadonlySet<string> = new Set(["baidu", "wenxin"]);

/**
 * Each engine against each measured rate, as a heat grid. An engine listed on
 * the project but missing from the round is a hatched row with its reason —
 * a zero would be a lie and a silent omission would be worse.
 */
export function engineMatrix(project: GeoProject, diagnosis: GeoDiagnosis | null): EngineMatrix {
  const measured = (Array.isArray(diagnosis?.byEngine) ? diagnosis.byEngine : []).filter((row) => row && row.engine);
  const listed = [
    ...measured.map((row) => row.engine),
    ...(project.engines ?? []).filter((engine) => !measured.some((row) => row.engine === engine)),
  ];
  return {
    columns: ENGINE_COLUMNS.map((column) => ({ key: column.key, header: column.header })),
    rows: listed.map((engine) => {
      const row = measured.find((item) => item.engine === engine) ?? null;
      if (!row) {
        return { key: engine, header: engineName(engine), cells: [], unmeasured: "本轮未测" };
      }
      return {
        key: engine,
        header: engineName(engine),
        unmeasured: null,
        cells: ENGINE_COLUMNS.map((column) => {
          if (column.deep && MENTION_ONLY.has(engine)) return { value: null, text: "只测提及" };
          const cell = readGeoCell(row[column.key]);
          return {
            value: cell.status === "ok" ? cell.value : null,
            text: geoCellWord(cell, "percent"),
            hint: geoCellPhrase(cell, "percent"),
          };
        }),
      };
    }),
  };
}

/* ---------------------------------------------------------------- ranking */

export interface RankingRow {
  key: string;
  name: string;
  value: number | null;
  ours: boolean;
  /** Where the reading came from, said in the reader's words. */
  scope: string;
}

/** 「司美格鲁肽 48%」 — the one shape the strategy run writes a rival reading in. */
const RIVAL_READING = /^(.+?)\s+(\d+(?:\.\d+)?)\s*%$/;

/**
 * The same-class ranking: our brand against the rivals the round actually saw,
 * per question pool. Nothing is invented — a registered competitor with no
 * reading is simply not in the table, and where no reading parses the caller
 * says so in a sentence instead of drawing an empty chart.
 */
export function rivalRanking(project: GeoProject, diagnosis: GeoDiagnosis | null): RankingRow[] {
  const ours = project.product?.brandName || project.product?.genericName || project.name;
  const rows: RankingRow[] = [];
  for (const pool of Array.isArray(diagnosis?.byPool) ? diagnosis.byPool : []) {
    const match = RIVAL_READING.exec((pool?.topCompetitor ?? "").trim());
    if (!match) continue;
    const value = Number(match[2]);
    if (!Number.isFinite(value)) continue;
    const name = match[1].trim();
    if (rows.some((row) => row.name === name)) continue;
    rows.push({ key: `rival:${name}`, name, value, ours: false, scope: "同类问题" });
  }
  if (rows.length === 0) return [];
  const mention = project.overview.metrics.find((metric) => metric.key === "mention") ?? null;
  rows.push({
    key: "ours",
    name: ours,
    value: mention?.cell.status === "ok" ? mention.cell.value : null,
    ours: true,
    // What the reading is OVER, not who it belongs to: the row already says
    // it is ours, in the accent ground and in its own label. Saying 「本品」 in
    // both places put the word on one row twice and told the reader nothing
    // about where the number came from — which is the column's only job, and
    // the reason a rival's number is not comparable to ours without it.
    scope: "本品问句池",
  });
  return rows.sort((left, right) => (right.value ?? -1) - (left.value ?? -1));
}

/* ------------------------------------------------------------------ trend */

/** A reading worth stating: under thirty answers a rate is 「样本不足」, not a point. */
export const MIN_SAMPLE = 30;

export function statedValue(point: GeoSeriesPoint): number | null {
  if (typeof point.value !== "number" || !Number.isFinite(point.value)) return null;
  if (typeof point.n === "number" && point.n < MIN_SAMPLE) return null;
  return point.value;
}

/** The latest point as a cell, so it reads 「38，310 次回答」 like every other number. */
export function pointCell(point: GeoSeriesPoint | undefined): GeoCell {
  if (!point) return readGeoCell(null);
  const thin = typeof point.n === "number" && point.n < MIN_SAMPLE;
  return readGeoCell({
    value: point.value,
    numerator: point.k,
    denominator: point.n,
    status: typeof point.value !== "number" ? "not_measurable" : thin ? "insufficient" : "ok",
  });
}

/**
 * What happened between the readings, placed on the series' own dates: the
 * first time an engine cited something we published is the one event on this
 * board that explains a rise, so it is the one marker drawn.
 */
export function actionMarkers(
  dates: readonly string[],
  monitoring: GeoMonitoring | null,
): Array<{ index: number; label: string }> {
  const cited = (Array.isArray(monitoring?.cited) ? monitoring.cited : [])
    .map((row) => row?.firstSeen)
    .filter((date): date is string => typeof date === "string" && date.length > 0)
    .sort();
  if (cited.length === 0 || dates.length === 0) return [];
  const at = dates.findIndex((date) => date >= cited[0]);
  const index = at === -1 ? dates.length - 1 : at;
  return [{ index, label: "首次被 AI 引用" }];
}

/* ------------------------------------------------------------ conclusions */

/**
 * A chart's heading is the sentence it proves (fusion plan §5.9). Never 「图
 * 1」 and never a bare metric name: a reader who only reads headings should
 * still learn what happened.
 */
export function trendConclusion(name: string, cell: GeoCell | null, delta: number | null, noise: number | null, unit: GeoUnit): string {
  if (!cell || cell.status === "absent" || cell.status === "not_measurable") return `${name}这一轮还没有测到`;
  if (cell.status === "insufficient") return `${name}的有效回答还不够，先不下结论`;
  const value = formatGeoValue(cell.value ?? 0, unit);
  if (delta === null) return `${name}基线 ${value}`;
  const flat = (noise !== null && Math.abs(delta) <= noise) || Math.round(delta) === 0;
  if (flat) return `${name} ${value}，与上次持平`;
  const size = Math.abs(delta) >= 1 ? Math.round(Math.abs(delta)) : Math.round(Math.abs(delta) * 10) / 10;
  return `${name} ${value}，比上次${delta > 0 ? "高" : "低"} ${size}${unit === "percent" ? " 个百分点" : ""}`;
}

/** 「元宝对信尔美提及最多」 — the matrix's own conclusion, or why there is none. */
export function engineConclusion(project: GeoProject, diagnosis: GeoDiagnosis | null): string {
  const product = project.product?.brandName || project.product?.genericName || project.name;
  const measured = (Array.isArray(diagnosis?.byEngine) ? diagnosis.byEngine : [])
    .map((row) => ({ engine: row?.engine, cell: readGeoCell(row?.mention) }))
    .filter((row): row is { engine: string; cell: GeoCell } => !!row.engine && row.cell.status === "ok" && row.cell.value !== null);
  if (measured.length === 0) return "这一轮还没有可以比较的引擎读数";
  const best = measured.reduce((top, row) => ((row.cell.value ?? 0) > (top.cell.value ?? 0) ? row : top));
  return `${engineName(best.engine)}提到${product}最多`;
}

/**
 * The per-engine trend card's own conclusion: which engine mentions us most and
 * which least, from the latest stated reading of each.
 *
 * Its heading used to be 「各引擎的走势」, which is the chart's name — something
 * the reader can already see. Every chart states what it shows in a sentence
 * (§5.9), and the best and worst engine are what a reader would work out by
 * reading this one.
 *
 */
export function engineTrendConclusion(
  rows: ReadonlyArray<{ engine?: string | null; points?: readonly GeoSeriesPoint[] | null } | null | undefined> | null | undefined,
): string {
  const stated = (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const points = Array.isArray(row?.points) ? row.points : [];
      return { engine: row?.engine, cell: readGeoCell(points[points.length - 1]?.cell) };
    })
    .filter((row): row is { engine: string; cell: GeoCell } =>
      !!row.engine && row.cell.status === "ok" && row.cell.value !== null);
  if (stated.length === 0) return "各引擎的最新读数";
  const best = stated.reduce((top, row) => ((row.cell.value ?? 0) > (top.cell.value ?? 0) ? row : top));
  if (stated.length === 1) return `本轮只有${engineName(best.engine)}测到读数`;
  const worst = stated.reduce((low, row) => ((row.cell.value ?? 0) < (low.cell.value ?? 0) ? row : low));
  if (best.engine === worst.engine) return `各引擎读数相同，都是 ${best.cell.value}`;
  return `${engineName(best.engine)}提及最多，${engineName(worst.engine)}最少`;
}

/* ------------------------------------------------------------------- week */

/** The two kinds of 「本周」 line said in red: a wrong statement, and a safety finding. */
export const GEO_ALERT_KINDS: ReadonlySet<string> = new Set(["wrong_ours", "safety"]);

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

/**
 * Where a 「本周」 line jumps. The old tabs are gone, so a line that named a
 * step resolves to the tab that now holds it — the same map an address uses.
 */
export function weekTarget(geoId: string, item: GeoWeekItem): string | null {
  const base = `/app/geo/${encodeURIComponent(geoId)}`;
  if (item.tab === "answers") return item.ref?.snapshotId ? `${base}/answers/${encodeURIComponent(item.ref.snapshotId)}` : null;
  const tab = GEO_TAB_REDIRECTS[item.tab];
  return tab ? geoTabPath(geoId, tab) : null;
}
