import type { MapEvent } from "@/lib/memoryMapClient";

/**
 * What the dashboard's change chart counts as a gain or a loss, and the Monday a week begins on: the three things that happen to
 * what EviMed remembers (R19, audit D C6 and §3.5). The chart is drawn from the same events the map lists, so the picture, the
 * headline over it and the list under it cannot disagree.
 *
 *  - 记下 — a memory written, a method learned, a forgotten memory brought back;
 *  - 合并 — a statement replaced by a later one (`superseded`): the old words stay in the lineage, the new ones carry on;
 *  - 忘记 — a memory archived, a method retired.
 *
 * An update, a confirmation and a status change are real events and none of them makes the account hold more or less, so none is
 * counted. Plain functions: nothing here touches a canvas.
 */

export type ChangeKind = "noted" | "merged" | "forgotten";

/** `MapEvent.change` → the kind it adds to. Any other change is not counted. */
const KIND_OF: Readonly<Record<string, ChangeKind>> = {
  created: "noted", learned: "noted", restored: "noted",
  superseded: "merged",
  archived: "forgotten", retired: "forgotten",
};

/** Which kind an event adds to, or null when it is not one of the three. */
export function changeKindOf(event: Pick<MapEvent, "type" | "change">): ChangeKind | null {
  return KIND_OF[event.change] ?? null;
}

const DAY = 86_400_000;

const add = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

/** The Monday on or before a calendar day (a week begins on Monday). */
export function weekStart(day: string): string {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return add(day, -((weekday + 6) % 7));
}

/**
 * The axis: 「9月15日」 for each week's Monday, and the year too on the first label and on the first week of a new year, so a
 * line that crosses New Year says so once and a short one carries no year at all.
 */
export function weekLabels(weeks: readonly { start: string }[]): string[] {
  const years = new Set(weeks.map((week) => week.start.slice(0, 4)));
  return weeks.map((week, index) => {
    const [year, month, day] = week.start.split("-").map(Number);
    const landmark = years.size > 1 && (index === 0 || weeks[index - 1]!.start.slice(0, 4) !== week.start.slice(0, 4));
    return `${landmark ? `${year}年` : ""}${month}月${day}日`;
  });
}
