/**
 * What 总览 says, decided before anything is drawn.
 *
 * The first screen answers three questions in order — **where do we stand,
 * did it move this week, what next** (appendix E §0) — and every one of them
 * is a judgement over numbers that may not exist yet. Keeping the judgement
 * here means the rules a reader relies on can be tested without a browser:
 *
 *  - a rate under thirty answers is “样本不足” and never a number;
 *  - a change is read by one rule (`readingChange`) wherever it is stated —
 *    headline, tile, chart title — and a change inside the measured fluctuation
 *    band of a rate is “持平”;
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
import { allowanceWaitingSentence, geoCoverageDifference, geoCoverageStatement } from "@evimed/domain";
import { stepAllowanceWait, type AllowanceWaiting } from "@/lib/allowanceWait";
import type { RailState, RailStep } from "@/components/ui/ProgressRail";
import type { DeltaPolarity } from "@/components/ui/Delta";
import { formatGeoValue, geoCellPhrase, geoCellWord, GEO_LINKLESS_WORD } from "./GeoCellText";
import { absentWord, engineName, GEO_METRIC_NAMES, GEO_METRIC_UNITS, GEO_STEP_NAMES, monthDay, parseGeoDate, zh, type GeoUnit } from "./geoText";
import { GEO_TAB_REDIRECTS, geoTabPath } from "./geoTabs";
import { MENTION_ONLY_WORD, mentionOnly, metricName, metricUnit } from "./tabs/geoTabText";

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
  /** The change against the previous reading, on the metric's own scale; 0 where it is “持平” (`readingChange`). */
  delta: number | null;
  polarity: DeltaPolarity;
  /** “较上次 · 目标 65”. */
  note: string | null;
  target: number | null;
  /** The readings behind it, for the sparkline. */
  trend: Array<number | null>;
  /** The sample, as a tooltip only. */
  hint?: string;
  lead: boolean;
  tone: "default" | "safety";
  /** “提及率第 2 / 3” — where we stand among the same-class drugs, on the lead tile. */
  rank: string | null;
  /** “司美格鲁肽 提及率 48%” — the leading rival, under the lead tile's bar. */
  rival: string | null;
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

/** One reading of a series: a point's value, the sample under it, and what its round measured. */
export interface ReadingPoint {
  date?: string;
  value: number | null;
  n?: number | null;
  /** The coverage key of the round (`geoCoverageKey`); absent from a server that does not send it, null where it could not be named. */
  coverage?: string | null;
}

/** What moved between two readings that were not measured over the same thing (`geoCoverageDifference`). */
export type CoverageChange = ReturnType<typeof geoCoverageDifference>;

/** How a series moved between its last two stated readings. */
export interface ReadingChange {
  /** The change on the metric's own scale, to a tenth; null before there are two readings, and where they are not comparable. */
  delta: number | null;
  /** Whether it is “持平”: it rounds to nothing, or lies inside the metric's measured band. */
  flat: boolean;
  /** The date of the reading the change is measured from, and of the latest one. */
  from: string | null;
  to: string | null;
  /**
   * Present when the last two readings were measured over different things (the engines that answered, the questions, the probe
   * surface): they are not compared, `delta` is null, and this says what moved. Absent when they were compared, or when there was
   * nothing to compare.
   */
  coverage?: CoverageChange;
}

/**
 * The one reading of a change, for every place a page says one. Only stated readings count (a point under thirty answers is
 * not one), the two compared are the last two of the **same series**, and a change that rounds to nothing, or lies inside the
 * metric's measured fluctuation band, is flat. The band belongs to a rate: it was measured on the mention rate and is passed
 * for that and for nothing else — the index has none, so a two-point change of it is a change.
 *
 * The two are compared only when they were measured over the same thing (R14 N-4): equal coverage keys. Otherwise there is no
 * change to read — `delta` is null, no arrow or colour can be drawn from it — and `coverage` says what moved, for the one sentence
 * every page prints (`changeWord`). Engines joining or leaving the sample moves a rate as much as the product does.
 * @param noise the metric's own band, or null where none was measured
 */
export function readingChange(points: ReadonlyArray<ReadingPoint> | null | undefined, { noise = null }: { noise?: number | null } = {}): ReadingChange {
  const stated = (Array.isArray(points) ? points : []).filter((point) => point && statedValue(point) !== null);
  const last = stated[stated.length - 1] ?? null;
  const before = stated[stated.length - 2] ?? null;
  if (!last || !before) return { delta: null, flat: false, from: null, to: last?.date ?? null };
  const coverage = geoCoverageDifference(before.coverage, last.coverage);
  if (!coverage.comparable) return { delta: null, flat: false, from: before.date ?? null, to: last.date ?? null, coverage };
  const delta = Math.round(((last.value as number) - (before.value as number)) * 10) / 10;
  const flat = Math.round(delta) === 0 || (typeof noise === "number" && Number.isFinite(noise) && Math.abs(delta) <= Math.abs(noise));
  return { delta, flat, from: before.date ?? null, to: last.date ?? null };
}

/**
 * The readings a series can honestly be drawn as one line from: the latest stated reading and the ones before it that were
 * measured over the same thing, back to the last change of coverage. A line that ran on through a change of the engine set would
 * say the two sides are one measurement.
 */
export function comparableRun<T extends ReadingPoint>(points: ReadonlyArray<T> | null | undefined): T[] {
  const all = Array.isArray(points) ? points.filter(Boolean) : [];
  const last = [...all].reverse().find((point) => statedValue(point) !== null);
  if (!last) return all;
  let start = all.indexOf(last);
  for (let index = start - 1; index >= 0; index -= 1) {
    if (statedValue(all[index]) === null) continue;
    if (!geoCoverageDifference(all[index].coverage, last.coverage).comparable) break;
    start = index;
  }
  return all.slice(start);
}

/**
 * Where a chart marks that the readings changed what they were measured over: the latest such point, with what moved in a few
 * words — beside the sentence that says the two sides are not compared.
 */
export function coverageMarker(points: ReadonlyArray<ReadingPoint> | null | undefined): { index: number; label: string } | null {
  const all = Array.isArray(points) ? points : [];
  const states = all.map((point, index) => ({ point, index })).filter(({ point }) => point && statedValue(point) !== null);
  for (let at = states.length - 1; at > 0; at -= 1) {
    const difference = geoCoverageDifference(states[at - 1].point.coverage, states[at].point.coverage);
    if (difference.comparable) continue;
    const statement = geoCoverageStatement(difference) ?? "";
    return { index: states[at].index, label: statement.replace(/，不与上一轮比较$/u, "") };
  }
  return null;
}

/**
 * A chart's markers with the coverage change among them. Two markers on one reading would write their labels over each other, so
 * where the change falls on a reading that already has one, the words join it.
 */
export function withCoverageMarker(
  markers: ReadonlyArray<{ index: number; label: string }>,
  points: ReadonlyArray<ReadingPoint> | null | undefined,
): Array<{ index: number; label: string }> {
  const change = coverageMarker(points);
  if (!change) return [...markers];
  const same = markers.find((marker) => marker.index === change.index);
  if (!same) return [...markers, change];
  return markers.map((marker) => (marker === same ? { ...marker, label: `${marker.label} · ${change.label}` } : marker));
}

/** The sentence that says two readings were not compared, or null where they were (or there was nothing to compare). */
export function coverageNotice(change: ReadingChange | null | undefined): string | null {
  return change?.coverage ? geoCoverageStatement(change.coverage) : null;
}

/** What a `Delta` is handed: a flat change as 0, so the arrow and the words never disagree. */
export function shownDelta(change: ReadingChange): number | null {
  return change.delta === null ? null : change.flat ? 0 : change.delta;
}

/**
 * “与上次持平” / “比上次低 2” (a rate's “个百分点”), and null before there are two readings. Where the two were measured over
 * different things it is the plain statement of that — 「引擎范围有变化，不与上一轮比较」 — in the place a change would stand.
 */
export function changeWord(change: ReadingChange, unit: GeoUnit): string | null {
  if (change.coverage) return coverageNotice(change);
  if (change.delta === null) return null;
  if (change.flat) return "与上次持平";
  const size = Math.abs(change.delta) >= 1 ? Math.round(Math.abs(change.delta)) : Math.round(Math.abs(change.delta) * 10) / 10;
  return `比上次${change.delta > 0 ? "高" : "低"} ${size}${unit === "percent" ? " 个百分点" : ""}`;
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

/**
 * Live wrong statements about us that would reach a patient (S3/S4): the safety tile's number. The server's count is over every
 * error of the project; a list is only what it carried.
 */
export function severeOpenErrors(diagnosis: GeoDiagnosis | null): number {
  const counted = diagnosis?.errorCounts?.severe;
  if (typeof counted === "number" && Number.isFinite(counted)) return counted;
  return (Array.isArray(diagnosis?.errors) ? diagnosis.errors : [])
    .filter((error) => error && error.status !== "closed" && (error.severity === "S3" || error.severity === "S4"))
    .length;
}

/**
 * Our place in the same-class ranking, and the rival ahead of the field: the
 * two things that answer “61 算好还是不好” beside the index (fusion plan
 * §4.8). The ranking is by mention rate — the one reading every rival has —
 * and says so.
 */
export function standing(project: GeoProject, diagnosis: GeoDiagnosis | null): { rank: string | null; rival: string | null; place: number | null; count: number } {
  const ranking = rivalRanking(project, diagnosis);
  const ours = ranking.find((row) => row.ours && row.value !== null) ?? null;
  const place = ours ? ranking.indexOf(ours) + 1 : null;
  const leader = ranking.find((row) => !row.ours && row.value !== null) ?? null;
  return {
    rank: place === null ? null : `提及率第 ${place} / ${ranking.length}`,
    rival: leader ? `${leader.name} 提及率 ${formatGeoValue(leader.value ?? 0, "percent")}` : null,
    place,
    count: ranking.length,
  };
}

export function overviewTiles(project: GeoProject, diagnosis: GeoDiagnosis | null): OverviewTile[] {
  const noise = typeof diagnosis?.noise?.band === "number" ? diagnosis.noise.band : null;
  const where = standing(project, diagnosis);
  const tiles: OverviewTile[] = [];
  for (const key of TILE_ORDER) {
    const metric = project.overview.metrics.find((item) => item.key === key) ?? null;
    const unit = GEO_METRIC_UNITS[key];
    const cell = metric?.cell ?? null;
    // A point under the sample floor is not a reading: it is neither drawn nor compared. Nor is a reading measured over something
    // else than the latest: the line starts where the coverage last changed, so it never runs across the change.
    const trend = comparableRun(metric?.trend).map(statedValue);
    // The band was measured on the mention rate and belongs to it alone.
    const change = readingChange(metric?.trend, { noise: key === "mention" ? noise : null });
    tiles.push({
      key,
      label: GEO_METRIC_NAMES[key],
      ...tileValue(cell, unit),
      delta: cell?.status === "ok" ? shownDelta(change) : null,
      polarity: "up",
      note: metric?.target != null ? `目标 ${formatGeoValue(metric.target, unit)}` : null,
      target: metric?.target ?? null,
      trend,
      hint: cell ? `${GEO_METRIC_NAMES[key]}：${geoCellPhrase(cell, unit)}` : undefined,
      lead: key === "gvi",
      tone: "default",
      rank: key === "gvi" ? where.rank : null,
      rival: key === "gvi" ? where.rival : null,
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
      polarity: "up",
      note: null,
      target: null,
      trend: [],
      hint: `${share.name}：${geoCellPhrase(share.cell, share.unit)}`,
      lead: false,
      tone: "default",
      rank: null,
      rival: null,
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
    polarity: "down",
    note: risk ? `${risk.name} ${formatGeoValue(risk.cell.value ?? 0, risk.unit)}` : null,
    target: null,
    trend: [],
    lead: false,
    tone: severe > 0 ? "safety" : "default",
    rank: null,
    rival: null,
  });
  return tiles;
}

/**
 * The one sentence a band of tiles says when its changes were not compared: read from the same readings, by the same rule, as the
 * arrows beside the numbers — the first of the four metrics that has one (they are one round's, so they agree). Null when every
 * change was compared or there was none to compare.
 */
export function overviewCoverageNotice(project: GeoProject): string | null {
  for (const key of TILE_ORDER) {
    const metric = project.overview.metrics.find((item) => item.key === key);
    const notice = coverageNotice(readingChange(metric?.trend));
    if (notice) return notice;
  }
  return null;
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
    const move = changeWord(readingChange(gvi.trend), "index") ?? "这是第一次测量";
    const target = gvi.target != null ? `，目标 ${formatGeoValue(gvi.target, "index")}` : "";
    const where = standing(project, diagnosis);
    const rank = where.place !== null && where.count > 1 ? `，提及率在 ${where.count} 个同类药里排第 ${where.place}` : "";
    parts.push(`综合可见度 ${formatGeoValue(gvi.cell.value, "index")}，${move}${target}${rank}`);
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
 * The engines a round actually has answers from, and why each other engine of
 * the project has none. A round that names its measured engines is read by
 * them (G13: “按 5 个引擎” of a baseline 豆包 never answered); an older one
 * by the engines it planned.
 */
export function roundCoverage(project: GeoProject, diagnosis: GeoDiagnosis | null): {
  measured: string[];
  absent: Array<{ engine: string; reason: string | null }>;
} {
  const round = diagnosis?.round ?? null;
  if (!round) return { measured: [], absent: [] };
  const planned = Array.isArray(round.engines) ? round.engines : [];
  const measured = Array.isArray(round.measuredEngines) ? round.measuredEngines : planned;
  const reasons = new Map((Array.isArray(round.absent) ? round.absent : []).filter((row) => row && row.engine).map((row) => [row.engine, absentWord(row.reason)]));
  const absent = [...new Set([...planned, ...(project.engines ?? [])])]
    .filter((engine) => !measured.includes(engine))
    .map((engine) => ({ engine, reason: reasons.get(engine) ?? null }));
  return { measured, absent };
}

/**
 * The band's one denominator, and the engines it does not cover, each with
 * its reason: “按 4 个引擎、264 次有效回答计算 · 豆包本轮未测：探测账号需要重新
 * 登录”. Null when nothing was measured — there is no denominator to declare.
 */
export function denominatorLine(project: GeoProject, diagnosis: GeoDiagnosis | null): string | null {
  const round = diagnosis?.round ?? null;
  if (!round) return null;
  const { measured, absent } = roundCoverage(project, diagnosis);
  const parts: string[] = [];
  if (measured.length) parts.push(`按 ${measured.length} 个引擎`);
  if (typeof round.done === "number" && round.done > 0) {
    parts.push(`${round.done.toLocaleString("zh-CN")} 次有效回答计算`);
  } else if (parts.length) {
    parts[0] = `${parts[0]}计算`;
  }
  // Engines that share a reason are named together, once.
  const byReason = new Map<string, string[]>();
  for (const { engine, reason } of absent) byReason.set(reason ?? "", [...(byReason.get(reason ?? "") ?? []), engineName(engine)]);
  const missing = [...byReason].map(([reason, names]) => (reason ? zh`${names.join("、")}本轮未测：${reason}` : zh`${names.join("、")}本轮未测`));
  return [parts.join("、") || null, ...missing].filter(Boolean).join(" · ") || null;
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

/** Whether this deployment can place orders; a project from a server that does not say can. */
export function marketConnected(project: GeoProject): boolean {
  return project.market?.configured !== false;
}

/** What the rail and 下一步 say about placing while no media market is connected (G20). */
export const GEO_MARKET_OFF_NOTE = "等媒介集市接通";

/**
 * The eight steps as the header rail. One of them may be `waiting`: the
 * program's single money stop — a placement budget only a person may set —
 * and it is drawn as the thing the reader owes. Without a market there is
 * nothing to owe: the step says it waits for the market, and nothing on the
 * page asks for a budget.
 */
export function railSteps(project: GeoProject, geoTabPathOf: (step: GeoStepKey) => string): RailStep[] {
  const steps = projectSteps(project);
  const needsBudget = project.budget === null || !(project.budget.totalCny > 0);
  const market = marketConnected(project);
  return GEO_STEP_KEYS.map((key) => {
    const step = steps[key];
    const status = step?.status ?? "none";
    const done = status === "done" || status === "minimal";
    const working = status === "running" || status === "queued" || status === "failed";
    const asked = key === "distribution" && !done && (step?.requested === true || working);
    const held = asked && !market;
    const waiting = asked && market && needsBudget;
    // A step the allowance would not start needs the reader as much as the budget does.
    const allowanceWait = stepAllowanceWait(step);
    const state: RailState = waiting || allowanceWait ? "waiting" : done ? "done" : held ? "todo" : working ? "active" : "todo";
    return {
      key,
      name: GEO_STEP_NAMES[key],
      note: waiting ? "待你确认预算" : held ? GEO_MARKET_OFF_NOTE : railNote(step?.note),
      state,
      to: geoTabPathOf(key),
    };
  });
}

/**
 * The rail on a phone, in one line: how many steps are done and what the first one that cannot go on is waiting for —
 * 「已完成 7 / 8 步 · 投放等媒介集市接通」.
 */
export function railSummary(steps: readonly RailStep[]): string {
  const done = steps.filter((step) => step.state === "done").length;
  const stopped = steps.find((step) => step.state === "waiting" || step.note === GEO_MARKET_OFF_NOTE) ?? null;
  const head = `已完成 ${done} / ${steps.length} 步`;
  return stopped ? `${head} · ${stopped.name}${stopped.note ?? "等你处理"}` : head;
}

/* --------------------------------------------------------------- next step */

export interface NextStep {
  key: string;
  text: string;
  /** `held`: it cannot start until something outside the project is in place (the media market). */
  state: "waiting" | "active" | "done" | "held";
  when: string | null;
  /** Set on the row of a step the allowance would not start: which wallet refused, so the row can offer the right top-up. */
  allowance?: AllowanceWaiting;
}

/** “下一步”: what is waiting on the reader first, then what is under way, then what is finished. */
export function nextSteps(project: GeoProject): NextStep[] {
  const steps = projectSteps(project);
  const needsBudget = project.budget === null || !(project.budget.totalCny > 0);
  const market = marketConnected(project);
  const rows: NextStep[] = [];
  const placing = steps.distribution && steps.distribution.status !== "done";
  if (placing && !market) {
    rows.push({ key: "market", text: "投放要等媒介集市接通", state: "held", when: null });
  } else if (placing && needsBudget) {
    rows.push({ key: "budget", text: "确认投放预算", state: "waiting", when: null });
  }
  for (const key of GEO_STEP_KEYS) {
    const step = steps[key];
    if (!step) continue;
    // Without a market, placing is not under way whatever its status says.
    if (key === "distribution" && !market) continue;
    const note = railNote(step.note);
    const name = GEO_STEP_NAMES[key];
    const allowance = stepAllowanceWait(step);
    if (allowance) {
      // Queued, but not under way: the allowance would not start it, and the reader is who puts that right.
      rows.push({ key, text: allowanceWaitingSentence(name, allowance), state: "waiting", when: null, allowance });
    } else if (step.status === "running" || step.status === "queued") {
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
  /** What a column left out is, when one was: a whole column of “—” says nothing a sentence cannot. */
  note: string | null;
}

const ENGINE_COLUMNS: ReadonlyArray<{ key: "mention" | "accuracy" | "citation" | "retrieval"; header: string; deep: boolean }> = [
  { key: "mention", header: "品牌提及率", deep: false },
  { key: "accuracy", header: "事实准确率", deep: true },
  { key: "citation", header: "引用命中率", deep: true },
  { key: "retrieval", header: "检索触发率", deep: true },
];

/**
 * Each engine against each measured rate, as a heat grid. An engine listed on
 * the project but without answers this round is a hatched row with its reason
 * (“本轮未测：探测账号需要重新登录”) — a zero would be a lie and a silent
 * omission would be worse. An engine whose citations had no links reads
 * “引用不可测” in the citation column. A rate no engine has a reading for is
 * left out, and the note under the grid says which and why (F-G10: a whole
 * column of “—”).
 */
export function engineMatrix(project: GeoProject, diagnosis: GeoDiagnosis | null): EngineMatrix {
  // An engine the round says had no answers is a hatched row whatever else
  // was computed for it; one it says nothing about is read by its metrics.
  const gone = new Map((Array.isArray(diagnosis?.round?.absent) ? diagnosis.round.absent : [])
    .filter((row) => row && row.engine).map((row) => [row.engine, absentWord(row.reason)]));
  const linkless = new Set(Array.isArray(diagnosis?.round?.linklessEngines) ? diagnosis.round.linklessEngines : []);
  const measured = (Array.isArray(diagnosis?.byEngine) ? diagnosis.byEngine : []).filter((row) => row && row.engine && !gone.has(row.engine));
  const listed = [
    ...measured.map((row) => row.engine),
    ...[...gone.keys(), ...(project.engines ?? [])].filter((engine, index, all) => all.indexOf(engine) === index && !measured.some((row) => row.engine === engine)),
  ];
  const rows = listed.map((engine) => {
    const row = measured.find((item) => item.engine === engine) ?? null;
    if (!row) {
      const reason = gone.get(engine) ?? null;
      return { key: engine, header: engineName(engine), cells: [] as EngineMatrix["rows"][number]["cells"], unmeasured: reason ? `本轮未测：${reason}` : "本轮未测" };
    }
    return {
      key: engine,
      header: engineName(engine),
      unmeasured: null,
      cells: ENGINE_COLUMNS.map((column) => {
        if (column.deep && mentionOnly(engine)) return { value: null, text: MENTION_ONLY_WORD };
        const cell = readGeoCell(row[column.key]);
        if (column.key === "citation" && linkless.has(engine) && cell.status !== "ok") return { value: null, text: GEO_LINKLESS_WORD };
        return {
          value: cell.status === "ok" ? cell.value : null,
          text: geoCellWord(cell, "percent"),
          hint: geoCellPhrase(cell, "percent"),
        };
      }),
    };
  });
  // A deep column with no reading on any engine that could have one is left out.
  const readable = rows.filter((row) => row.unmeasured === null && !mentionOnly(row.key));
  const empty = ENGINE_COLUMNS.map((column, index) => column.deep && readable.length > 0
    && readable.every((row) => row.cells[index]?.value === null));
  const kept = ENGINE_COLUMNS.filter((_, index) => !empty[index]);
  const dropped = ENGINE_COLUMNS.filter((_, index) => empty[index]);
  const allLinkless = readable.length > 0 && readable.every((row) => linkless.has(row.key));
  const note = dropped.length === 0 ? null
    : dropped.length === 1 && dropped[0].key === "citation" && allLinkless
      ? zh`${readable.map((row) => engineName(row.key)).join("、")}的引用只有标题、没有链接，引用命中率测不出`
      : `${dropped.map((column) => column.header).join("、")}这一轮没有读数`;
  return {
    columns: kept.map((column) => ({ key: column.key, header: column.header })),
    rows: rows.map((row) => (row.unmeasured === null ? { ...row, cells: row.cells.filter((_, index) => !empty[index]) } : row)),
    note,
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

/** “司美格鲁肽 48%” — the one shape the strategy run writes a rival reading in. */
const RIVAL_READING = /^(.+?)\s+(\d+(?:\.\d+)?)\s*%$/;
/** A rival's mention rate, over the same questions as our headline rate (G15). */
const RIVAL_METRIC = "M-16";
/** What M-16 and M-01S are both over: the generic-name and symptom questions (P2 + P3). */
export const SHARED_SCOPE = "品类与泛症状问题";

/**
 * The same-class ranking: our brand against the rivals the round actually
 * measured — each registered rival's mention rate (M-16) beside ours over the
 * same questions (M-01S). A round from before the rivals were measured falls
 * back to the leading rival each question pool named. Nothing is invented — a
 * registered competitor with no reading is simply not in the table, and where
 * there is no reading the caller says so in a sentence instead of drawing an
 * empty chart.
 */
export function rivalRanking(project: GeoProject, diagnosis: GeoDiagnosis | null): RankingRow[] {
  const ours = project.product?.brandName || project.product?.genericName || project.name;
  const rows: RankingRow[] = [];
  for (const row of Array.isArray(diagnosis?.more) ? diagnosis.more : []) {
    if (!row || row.metricId !== RIVAL_METRIC || !row.rival || row.variant) continue;
    const cell = readGeoCell(row.cell);
    if (cell.status !== "ok" || cell.value === null || rows.some((entry) => entry.name === row.rival)) continue;
    rows.push({ key: `rival:${row.rival}`, name: row.rival, value: cell.value, ours: false, scope: SHARED_SCOPE });
  }
  // Measured over the same questions as ours, a rival's rate is comparable
  // as it stands; a pool's leading rival is not, and the column says so.
  const shared = rows.length > 0;
  for (const pool of rows.length ? [] : Array.isArray(diagnosis?.byPool) ? diagnosis.byPool : []) {
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
    // it is ours, in the accent ground and in its own label. Saying “本品” in
    // both places put the word on one row twice and told the reader nothing
    // about where the number came from — which is the column's only job, and
    // the reason a rival's number is not comparable to ours without it.
    scope: shared ? SHARED_SCOPE : "本品问句池",
  });
  return rows.sort((left, right) => (right.value ?? -1) - (left.value ?? -1));
}

/* ------------------------------------------------------------------ trend */

/** A reading worth stating: under thirty answers a rate is “样本不足”, not a point. */
export const MIN_SAMPLE = 30;

export function statedValue<T extends Pick<ReadingPoint, "value" | "n">>(point: T): number | null {
  if (typeof point.value !== "number" || !Number.isFinite(point.value)) return null;
  if (typeof point.n === "number" && point.n < MIN_SAMPLE) return null;
  return point.value;
}

/** The latest point as a cell, so it reads “38，310 次回答” like every other number. */
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
 * A chart's heading is the sentence it proves (fusion plan §5.9). Never “图
 * 1” and never a bare metric name: a reader who only reads headings should
 * still learn what happened.
 */
export function trendConclusion(name: string, cell: GeoCell | null, change: ReadingChange | null, unit: GeoUnit): string {
  if (!cell || cell.status === "absent" || cell.status === "not_measurable") return `${name}这一轮还没有测到`;
  if (cell.status === "insufficient") return `${name}的有效回答还不够，先不下结论`;
  const value = formatGeoValue(cell.value ?? 0, unit);
  const move = change ? changeWord(change, unit) : null;
  return move ? `${name} ${value}，${move}` : `${name}基线 ${value}`;
}

/** “上次 9月25日 · 下次 10月12日”: the date a change is measured from, and the next measurement's. */
export function chartDates(change: ReadingChange | null, next: string | null | undefined): string | undefined {
  const parts = [change?.from ? `上次 ${monthDay(change.from)}` : null, next ? `下次 ${monthDay(next)}` : null].filter((part): part is string => !!part);
  return parts.length ? parts.join(" · ") : undefined;
}

/** “元宝对信尔美提及最多” — the matrix's own conclusion, or why there is none. */
export function engineConclusion(project: GeoProject, diagnosis: GeoDiagnosis | null): string {
  const product = project.product?.brandName || project.product?.genericName || project.name;
  const measured = (Array.isArray(diagnosis?.byEngine) ? diagnosis.byEngine : [])
    .map((row) => ({ engine: row?.engine, cell: readGeoCell(row?.mention) }))
    .filter((row): row is { engine: string; cell: GeoCell } => !!row.engine && row.cell.status === "ok" && row.cell.value !== null);
  if (measured.length === 0) return "这一轮还没有可以比较的引擎读数";
  const best = measured.reduce((top, row) => ((row.cell.value ?? 0) > (top.cell.value ?? 0) ? row : top));
  return zh`${engineName(best.engine)}提到${product}最多`;
}

/**
 * The per-engine trend card's own conclusion: which engine mentions us most and
 * which least, from the latest stated reading of each.
 *
 * Its heading used to be “各引擎的走势”, which is the chart's name — something
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
  if (stated.length === 1) return zh`本轮只有${engineName(best.engine)}测到读数`;
  const worst = stated.reduce((low, row) => ((row.cell.value ?? 0) < (low.cell.value ?? 0) ? row : low));
  if (best.engine === worst.engine) return `各引擎读数相同，都是 ${best.cell.value}`;
  return zh`${engineName(best.engine)}提及最多，${engineName(worst.engine)}最少`;
}

/* ------------------------------------------------------------------- week */

/** The two kinds of “本周” line said in red: a wrong statement, and a safety finding. */
export const GEO_ALERT_KINDS: ReadonlySet<string> = new Set(["wrong_ours", "safety"]);

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** “今天”“昨天”“周一”“上周五”, else “9月12日”. */
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
 * Where a “本周” line jumps. The old tabs are gone, so a line that named a
 * step resolves to the tab that now holds it — the same map an address uses.
 */
export function weekTarget(geoId: string, item: GeoWeekItem): string | null {
  const base = `/app/geo/${encodeURIComponent(geoId)}`;
  if (item.tab === "answers") return item.ref?.snapshotId ? `${base}/answers/${encodeURIComponent(item.ref.snapshotId)}` : null;
  const tab = GEO_TAB_REDIRECTS[item.tab];
  return tab ? geoTabPath(geoId, tab) : null;
}
