/**
 * What the daily's archive and the event's record say (c5-reader, 2026-10-26): the issues of the archive cut into months, the three
 * things an issue is read for first, the stamp of when an issue came out and the moments of an event's record. Pure functions, so each is tested once here and the components stay about layout.
 *
 * Every day and every clock is Beijing's (`FEED_TIME_ZONE`), whatever zone the browser is in; no source's own words are read here
 * and no score is made — the ranking an issue was composed with is the only one used.
 */
import type { FrontierDaily, FrontierDailySummary, FrontierItem } from "@/lib/frontierClient";
import { FEED_ZONE_NOTE, clock, dateClock, feedDayKey, shortDate } from "./frontierText";

/* ------------------------------------------------------------------ archive */

/** One month of the archive: its key (`2026-10`), its name and its issues, newest first. */
export interface ArchiveMonth<T extends { day: string } = FrontierDailySummary> {
  key: string;
  /** 「2026年10月」. */
  label: string;
  entries: T[];
}

/** `2026-10` of a day key, or null for one that is not a day. */
export function monthKey(day: string): string | null {
  return /^(\d{4})-(\d{2})-\d{2}$/.test(day) ? day.slice(0, 7) : null;
}

/** 「2026年10月」 from `2026-10`. */
export function monthLabel(key: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  return match ? `${match[1]}年${Number(match[2])}月` : key;
}

/** 「26日 周一」: a day inside its month's group, which already names the month. */
export function dayInMonth(day: string): string {
  return shortDate(day).replace(/^\d+月/, "");
}

/**
 * The archive's issues cut into months, newest month first, each month's issues in the order given (the server's: newest first). A
 * row whose day cannot be read is left out of every month — a month it could not be named by would be a wrong one.
 */
export function archiveMonths<T extends { day: string }>(entries: readonly T[]): Array<ArchiveMonth<T>> {
  const months: Array<ArchiveMonth<T>> = [];
  const byKey = new Map<string, ArchiveMonth<T>>();
  for (const entry of entries) {
    const key = monthKey(entry.day);
    if (!key) continue;
    let month = byKey.get(key);
    if (!month) {
      month = { key, label: monthLabel(key), entries: [] };
      byKey.set(key, month);
      months.push(month);
    }
    month.entries.push(entry);
  }
  return months.sort((a, b) => b.key.localeCompare(a.key));
}

/** The label an archive row has for a screen reader: the day in full and how many items the issue held. */
export function archiveEntryName(entry: Pick<FrontierDailySummary, "day" | "itemCount">): string {
  return entry.itemCount > 0 ? `${shortDate(entry.day)}，${entry.itemCount} 条` : shortDate(entry.day);
}

/* ------------------------------------------------------------------ top three */

/** One of 「先看三件事」: the item, the sentence that opens it and, for the lead, the event page it belongs to. */
export interface TopThing {
  item: FrontierItem;
  /** The 速读: the lead's own text where the issue wrote one, else the item's summary. */
  text: string | null;
  event: { id: string; title: string } | null;
}

/** How many things an issue is read for first. */
export const TOP_THINGS = 3;

/**
 * 「先看三件事」 of an issue, by the ranking the issue was made with and no other: its lead first, then the items of its lanes the
 * server scored highest (the weight each lane is ordered by), the issue's own order where two score alike or none does. The safety
 * alerts keep their own block directly below and are not among them. Null with fewer than three to show — two things are not a list of
 * three, and the lead then stands as it did.
 *
 * The server freezes each lane's order when it composes an issue but names no order across lanes, so lanes are compared by the item's
 * `score` as the read carries it: a re-score after the issue came out can reorder the three (never their lane's own order).
 */
export function topThings(issue: Pick<FrontierDaily, "lead" | "sections">): TopThing[] | null {
  const lead: TopThing | null = issue.lead ? { item: issue.lead.item, text: issue.lead.text ?? issue.lead.item.summary, event: issue.lead.event } : null;
  const taken = new Set(lead ? [lead.item.id] : []);
  const rest = issue.sections
    .flatMap((section, laneAt) => section.items.map((item, at) => ({ item, laneAt, at })))
    .filter((entry) => !taken.has(entry.item.id))
    .sort((a, b) => (b.item.score ?? -1) - (a.item.score ?? -1) || a.laneAt - b.laneAt || a.at - b.at);
  const things = [...(lead ? [lead] : []), ...rest.map((entry) => ({ item: entry.item, text: entry.item.summary, event: null }))].slice(0, TOP_THINGS);
  return things.length === TOP_THINGS ? things : null;
}

/**
 * The lanes of an issue as the rows below 「先看三件事」 draw them: without the items already shown above (the lead is in no lane), and
 * without a lane that had nothing else. With no three things the lanes are the issue's own.
 */
export function sectionsBelow(issue: Pick<FrontierDaily, "sections">, things: readonly TopThing[] | null): FrontierDaily["sections"] {
  if (!things) return issue.sections;
  const shown = new Set(things.map((thing) => thing.item.id));
  return issue.sections.map((section) => ({ ...section, items: section.items.filter((item) => !shown.has(item.id)) })).filter((section) => section.items.length > 0);
}

/* ------------------------------------------------------------------ freshness */

/**
 * 「07:30 发布（北京时间）」: when an issue came out, on its own day by the clock alone and with its date on any other. Null for an issue
 * that does not say.
 */
export function issuedStamp(generatedAt: string | null, day: string): string | null {
  if (!generatedAt) return null;
  const at = feedDayKey(generatedAt) === day ? clock(generatedAt) : dateClock(generatedAt);
  return at ? `${at} 发布${FEED_ZONE_NOTE}` : null;
}

/* ------------------------------------------------------------------ event record */

/**
 * A moment of an event's record in Beijing time: 「9月22日 18:01」, the year first before this one's, and the day alone for a moment
 * that stands for a day (a source that stated no hour has no clock to show).
 */
export function recordMoment(value: string | null, now = Date.now()): string {
  const text = dateClock(value);
  if (!text) return "";
  const year = feedDayKey(value)?.slice(0, 4);
  const current = feedDayKey(now)?.slice(0, 4);
  return year && year !== current ? `${year}年${text}` : text;
}
