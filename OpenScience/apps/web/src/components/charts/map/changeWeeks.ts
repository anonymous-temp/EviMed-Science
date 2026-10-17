import type { MapEvent } from "@/lib/memoryMapClient";
import { dayIn } from "./zone";

/**
 * What the time view counts, week by week: the three things that happen to what EviMed remembers (R19, audit D C6 and §3.5).
 *
 * It replaces the 「成长」 line, which drew the stock — 42 memories, up to 75 and back down — under a heading that began on a
 * different day from its own first point. A stock cannot say what happened; a count of what happened each week can, and it
 * comes from the same events the map lists, so the picture, the headline over it and the list under it cannot disagree.
 *
 *  - 记下 — a memory written, a method learned, a forgotten memory brought back;
 *  - 合并 — a statement replaced by a later one (`superseded`): the old words stay in the lineage, the new ones carry on;
 *  - 忘记 — a memory archived, a method retired.
 *
 * An update, a confirmation and a status change are real events and are listed under the chart, but none of them makes the
 * account hold more or less, so none is a bar. Plain functions of the document: nothing here touches a canvas.
 */

export type ChangeKind = "noted" | "merged" | "forgotten";

/** The stacking order, bottom to top, and the order of the legend. */
export const CHANGE_KINDS: readonly ChangeKind[] = ["noted", "merged", "forgotten"];

export const CHANGE_NAMES: Readonly<Record<ChangeKind, string>> = { noted: "记下", merged: "合并", forgotten: "忘记" };

/** `MapEvent.change` → the bar it adds to. Any other change is not counted. */
const KIND_OF: Readonly<Record<string, ChangeKind>> = {
  created: "noted", learned: "noted", restored: "noted",
  superseded: "merged",
  archived: "forgotten", retired: "forgotten",
};

/** The server lists at most this many events, newest first (`MAP_EVENT_LIMIT`): older weeks may be cut. */
export const MAP_EVENT_CAP = 500;

/** Which bar an event adds to, or null when it is not one of the three. A conversation or a correction is not a memory's change. */
export function changeKindOf(event: Pick<MapEvent, "type" | "change">): ChangeKind | null {
  if (event.type !== "memory" && event.type !== "method") return null;
  return KIND_OF[event.change] ?? null;
}

export interface WeekCounts {
  /** The Monday the week begins on, YYYY-MM-DD. */
  start: string;
  /** The Sunday it ends on, YYYY-MM-DD. */
  end: string;
  noted: number;
  merged: number;
  forgotten: number;
}

const DAY = 86_400_000;

const add = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

/** The Monday on or before a calendar day (a week begins on Monday). */
export function weekStart(day: string): string {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return add(day, -((weekday + 6) % 7));
}

/**
 * The weeks from the one holding `from` to the one holding `to`, each with what happened in it — every week in between, so a
 * quiet week is a gap in the bars and not a bar that is missing. Events are counted on the day they fall in the researcher's zone.
 */
export function weeklyChanges(events: readonly Pick<MapEvent, "type" | "change" | "at">[], { from, to, timeZone }: { from: string; to: string; timeZone: string }): WeekCounts[] {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(from) || !/^\d{4}-\d{2}-\d{2}$/u.test(to) || to < from) return [];
  const weeks = new Map<string, WeekCounts>();
  for (let start = weekStart(from); start <= to; start = add(start, 7)) {
    weeks.set(start, { start, end: add(start, 6), noted: 0, merged: 0, forgotten: 0 });
  }
  for (const event of events) {
    const kind = changeKindOf(event);
    if (!kind) continue;
    const at = Date.parse(event.at);
    if (!Number.isFinite(at)) continue;
    const week = weeks.get(weekStart(dayIn(at, timeZone)));
    if (week) week[kind] += 1;
  }
  return [...weeks.values()];
}

/** What a set of weeks adds up to. */
export function totalsOf(weeks: readonly WeekCounts[]): Record<ChangeKind, number> {
  return weeks.reduce((sum, week) => ({ noted: sum.noted + week.noted, merged: sum.merged + week.merged, forgotten: sum.forgotten + week.forgotten }), { noted: 0, merged: 0, forgotten: 0 });
}

/**
 * The first day the bars may claim to know about. Where the server cut the list (it lists the newest 500), the oldest weeks are
 * not all there and are not drawn as quiet: the axis begins at the oldest event that did arrive.
 */
export function chartsFrom(extentFrom: string, events: readonly Pick<MapEvent, "at">[], timeZone: string): string {
  if (events.length < MAP_EVENT_CAP) return extentFrom;
  const oldest = events.map((event) => Date.parse(event.at)).filter(Number.isFinite).sort((left, right) => left - right)[0];
  if (oldest === undefined) return extentFrom;
  const day = dayIn(oldest, timeZone);
  return day > extentFrom ? day : extentFrom;
}

/** The weeks a window covers, as indices into `weeks` (inclusive); null when no week is in it. */
export function weekIndexRange(weeks: readonly WeekCounts[], window: { from: string; to: string } | null): { first: number; last: number } | null {
  if (weeks.length === 0) return null;
  if (!window) return { first: 0, last: weeks.length - 1 };
  const first = weeks.findIndex((week) => week.end >= window.from);
  let last = -1;
  weeks.forEach((week, index) => { if (week.start <= window.to) last = index; });
  return first < 0 || last < first ? null : { first, last };
}

/**
 * What a zoom on the weekly axis chose, as days — or null for the whole of it. `start` and `end` are percentages of the axis, as
 * the chart library reports them; the window runs from the first chosen week's Monday to the last one's Sunday (never past `to`).
 */
export function windowOfWeeks(weeks: readonly WeekCounts[], zoom: { start?: number; end?: number; batch?: Array<{ start?: number; end?: number }> } | null | undefined, to: string): { from: string; to: string } | null {
  const chosen = zoom?.batch?.[0] ?? zoom;
  if (!chosen || typeof chosen.start !== "number" || typeof chosen.end !== "number" || weeks.length === 0) return null;
  const last = weeks.length - 1;
  const at = (percent: number) => Math.max(0, Math.min(last, Math.round((percent / 100) * last)));
  const first = at(chosen.start);
  const finish = at(chosen.end);
  if (first === 0 && finish === last) return null;
  const end = weeks[finish]!.end;
  return { from: weeks[first]!.start, to: end > to ? to : end };
}

/**
 * The axis: 「9月15日」 for each week's Monday, and the year too on the first label and on the first week of a new year, so a
 * line that crosses New Year says so once and a short one carries no year at all.
 */
export function weekLabels(weeks: readonly Pick<WeekCounts, "start">[]): string[] {
  const years = new Set(weeks.map((week) => week.start.slice(0, 4)));
  return weeks.map((week, index) => {
    const [year, month, day] = week.start.split("-").map(Number);
    const landmark = years.size > 1 && (index === 0 || weeks[index - 1]!.start.slice(0, 4) !== week.start.slice(0, 4));
    return `${landmark ? `${year}年` : ""}${month}月${day}日`;
  });
}

/**
 * The sentence the weekly bars prove, from the same counts the bars are drawn from: 「自9月22日起，记下 18 件、合并 3 件、忘记 2 件」, or
 * the window's own days when one is chosen. A kind that did not happen is left out; null where nothing did, and the card says that.
 */
export function weeksSentence(weeks: readonly WeekCounts[], { from, window, formatDay }: { from: string; window: { from: string; to: string } | null; formatDay: (day: string) => string }): string | null {
  const totals = totalsOf(weeks);
  const parts = CHANGE_KINDS.filter((kind) => totals[kind] > 0).map((kind) => `${CHANGE_NAMES[kind]} ${totals[kind]} 件`);
  if (parts.length === 0) return null;
  return `${window ? `${formatDay(window.from)}到${formatDay(window.to)}` : `自${formatDay(from)}起`}，${parts.join("、")}`;
}
