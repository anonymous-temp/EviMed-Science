import type { TrendInput, TrendMarker } from "@/components/charts/trendModel";
import { formatApproxCount } from "@/lib/format";
import type { MemoryGrowth, MemoryGrowthMoment } from "@/lib/memoryClient";

/**
 * What the capsule page's growth line says, decided before a chart is drawn.
 *
 * The line is the owner's timeline of change and growth (2026-08-23), and it
 * is the page's only chart, so what it may say is narrow on purpose (research
 * 2026-09-28: no peer's memory page carries a chart, and every harm found —
 * streaks, count tiles, a graph, a two-point line that reads as broken — is
 * one of the things this does not do):
 *
 *  - **One sentence, which is the heading.** When it began, how much it holds
 *    now, how many ways of working it learned — the chart proves that sentence
 *    (spec §32.1) and says nothing else. No tile, no percentage, nothing about
 *    how a memory is written or used.
 *  - **Only once there is a line.** A capsule whose whole history fits in one
 *    week or one month is a list, not a trend: the chart stays away until its
 *    history spans two, so it never opens as a stub.
 *  - **At most three moments, named.** A method learned, a capsule received —
 *    the two things on the page a researcher did not type — kept apart so their
 *    labels never meet; the rest are rows below.
 */

/** How many moments the line names at most. */
export const GROWTH_MARKERS = 3;
/** A moment's name on the line is cut to this width: eight Chinese characters, sixteen Latin. */
const MARKER_NAME_WIDTH = 16;

export interface GrowthView {
  /** The conclusion: the card's heading and the chart's accessible name. */
  title: string;
  input: TrendInput;
}

function ymd(day: string) {
  return { year: Number(day.slice(0, 4)), month: Number(day.slice(5, 7)), date: Number(day.slice(8, 10)) };
}

/** “9月12日”, or “2025年9月12日” in another year. No space inside a formatted date (spec §5.5). */
export function growthDay(day: string, withYear = false): string {
  const { year, month, date } = ymd(day);
  return `${withYear ? `${year}年` : ""}${month}月${date}日`;
}

/**
 * The axis: “9月15日” per week, “9月” per month. When the line crosses a year,
 * its first label and the first point of each new year carry the year — the
 * landmark tick of spec §32.5 rule 6.
 */
export function growthLabels(unit: "week" | "month", starts: readonly string[]): string[] {
  const years = new Set(starts.map((start) => ymd(start).year));
  return starts.map((start, index) => {
    const { year, month } = ymd(start);
    const landmark = years.size > 1 && (index === 0 || ymd(starts[index - 1]).year !== year);
    return unit === "week" ? growthDay(start, landmark) : `${landmark ? `${year}年` : ""}${month}月`;
  });
}

const WIDE = /[⺀-鿿豈-﫿＀-￯]/;
const WORD = /[A-Za-z0-9]/;

/**
 * A name cut to fit beside its marker, by the width it takes rather than its
 * length — a Chinese character is two Latin ones wide — and never inside a
 * Latin word: “Meta 分析先报 GRADE…” is cut to “Meta 分析先报…”, not “…GR…”.
 */
export function cutName(title: string): string {
  const chars = [...title.trim()];
  let width = 0;
  let end = 0;
  for (; end < chars.length; end += 1) {
    const next = WIDE.test(chars[end]) ? 2 : 1;
    if (width + next > MARKER_NAME_WIDTH) break;
    width += next;
  }
  if (end >= chars.length) return chars.join("");
  let head = chars.slice(0, end);
  if (WORD.test(chars[end]) && WORD.test(head[head.length - 1] ?? "")) {
    const space = Math.max(head.lastIndexOf(" "), head.lastIndexOf("-"));
    if (space > 0) head = head.slice(0, space);
  }
  return `${head.join("").trimEnd()}…`;
}

/** What one point's moments are called on the line. */
function momentLabel(moments: readonly MemoryGrowthMoment[]): string {
  const methods = moments.filter((moment) => moment.kind === "method");
  const capsules = moments.filter((moment) => moment.kind === "capsule");
  if (capsules.length === 0) return methods.length === 1 ? `学会“${cutName(methods[0].title)}”` : `学会 ${methods.length} 种做法`;
  if (methods.length === 0) return capsules.length === 1 ? `收到“${cutName(capsules[0].title)}”` : `收到 ${capsules.length} 个胶囊`;
  return "学会做法 · 收到胶囊";
}

/**
 * The moments the line marks: grouped by the point they fall in, the newest
 * first, each kept only if it is far enough from those already kept for two
 * labels not to meet, and at most `GROWTH_MARKERS`.
 */
export function growthMarkers(starts: readonly string[], moments: readonly MemoryGrowthMoment[]): TrendMarker[] {
  const byIndex = new Map<number, MemoryGrowthMoment[]>();
  for (const moment of moments) {
    let index = -1;
    starts.forEach((start, at) => { if (start <= moment.day) index = at; });
    if (index < 0) continue;
    byIndex.set(index, [...(byIndex.get(index) ?? []), moment]);
  }
  const gap = Math.max(1, Math.ceil(starts.length / 6));
  const kept: TrendMarker[] = [];
  for (const index of [...byIndex.keys()].sort((left, right) => right - left)) {
    if (kept.length >= GROWTH_MARKERS) break;
    if (kept.some((marker) => Math.abs(marker.index - index) < gap)) continue;
    kept.push({ index, label: momentLabel(byIndex.get(index) ?? []) });
  }
  return kept.sort((left, right) => left.index - right.index);
}

/** The count as a reader says it: “1,284”, “1.2万”. */
export function growthCount(value: number): string {
  return formatApproxCount(Math.round(value));
}

/** The sentence the chart proves; null when there is no line to draw yet. */
export function growthView(growth: MemoryGrowth | null | undefined): GrowthView | null {
  if (!growth || !growth.unit || !Array.isArray(growth.points)) return null;
  const points = growth.points;
  const held = points.findIndex((point) => point.known > 0);
  if (held < 0 || points.length - held < 2) return null;
  const starts = points.map((point) => point.start);
  const last = points[points.length - 1].known;
  const learned = (growth.moments ?? []).filter((moment) => moment.kind === "method").length;
  const tail = learned > 0 ? `，学会 ${learned} 种做法` : "";
  let title: string;
  if (growth.fromStart && growth.first) {
    const lastYear = ymd(starts[starts.length - 1]).year;
    title = `${growthDay(growth.first, ymd(growth.first).year !== lastYear)}开始记住你，现在有 ${growthCount(last)} 条记忆${tail}`;
  } else {
    const span = growth.unit === "week" ? `近 ${points.length - 1} 周` : `近 ${points.length - 1} 个月`;
    const from = points[0].known;
    title = last === from
      ? `${span}记忆保持在 ${growthCount(last)} 条${tail}`
      : `${span}记忆从 ${growthCount(from)} 条${last > from ? "增加" : "减少"}到 ${growthCount(last)} 条${tail}`;
  }
  return {
    title,
    input: {
      labels: growthLabels(growth.unit, starts),
      own: { name: "记忆", values: points.map((point) => point.known) },
      markers: growthMarkers(starts, growth.moments ?? []),
    },
  };
}
