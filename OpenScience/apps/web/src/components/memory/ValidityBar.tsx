import type { WebStructuredMemory } from "@/lib/apiClient";
import { formatDay } from "@/lib/format";

/**
 * How long a memory has held, drawn in its drawer: a thin bar from the day it began to hold to the day it stopped — or to today
 * while it still does — and a tick for each time it was changed in between (the versions listed under 「以前的版本」). It answers
 * the question a reader has of an old memory, 「这还算数吗」, before they read its history (2026-10-12; Zep's validity interval is
 * the same idea).
 *
 * The bar says only what is recorded, and is drawn only for a memory that has a real term: an interval a source stated
 * (`relations.validity`), or an end — the day a later memory replaced it or a source ended it. The start is the stated start or
 * else the day the memory was made. A memory with no term, however many times it was reworded, gets no bar: a line from its first
 * day to today would draw an age as if it were a lifetime, and the date it was made is already under its title (2026-10-13,
 * owner: no progress drawn from an assumed lifetime).
 */

export interface ValiditySpan {
  from: number;
  /** The end of the interval; `now` while the memory still holds. */
  to: number;
  /** Whether the interval has ended (a later memory replaced it, or its source did). */
  ended: boolean;
  /** When each version was made, strictly inside the interval. */
  ticks: number[];
}

function instant(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/** The interval a record holds over, or null when there is nothing to draw. @param now the clock, for a test */
export function validitySpan(record: Pick<WebStructuredMemory, "createdAt" | "invalidSince" | "revisions" | "relations">, now: number = Date.now()): ValiditySpan | null {
  const from = instant(record.relations?.validity?.from) ?? instant(record.createdAt);
  if (from === null) return null;
  const end = instant(record.invalidSince) ?? instant(record.relations?.validity?.until);
  // An end still to come is not an end yet: the memory holds today.
  const to = end !== null ? Math.min(end, now) : now;
  if (to <= from) return null;
  const ticks = [...new Set(record.revisions.map((revision) => instant(revision.changedAt)).filter((time): time is number => time !== null && time > from && time < to))].sort((a, b) => a - b);
  const stated = Boolean(record.relations?.validity?.from || record.relations?.validity?.until);
  if (end === null && !stated) return null;
  return { from, to, ended: end !== null && end <= now, ticks };
}

export function ValidityBar({ span }: { span: ValiditySpan | null }) {
  if (!span) return null;
  const length = span.to - span.from;
  const start = formatDay(new Date(span.from).toISOString());
  const stop = span.ended ? formatDay(new Date(span.to).toISOString()) : "至今";
  const label = `有效期：${start}起，${span.ended ? `${stop}止` : "至今"}${span.ticks.length > 0 ? `，中间改过 ${span.ticks.length} 次` : ""}`;
  return (
    <div className="space-y-1">
      <div role="img" aria-label={label} data-forced-colors="preserve" className="relative h-2 rounded-full bg-surface-2">
        <span className="absolute inset-y-0 left-0 right-0 rounded-full bg-border-control" />
        {span.ticks.map((time) => (
          <span key={time} className="absolute -top-0.5 h-3 w-px bg-text-graphic" style={{ left: `${((time - span.from) / length) * 100}%` }} />
        ))}
      </div>
      <p aria-hidden="true" className="flex justify-between text-caption text-text-3">
        <span>{start}</span>
        <span>{stop}</span>
      </p>
    </div>
  );
}
