import { formatClock, formatDay } from "@/lib/format";

/**
 * A moment as an evidence page prints it where the clock matters (a folded record): the day the app's way — 「10月1日」 within this
 * year, the full date before it — and the time. A value that is not a date is shown as written.
 */
export const evidenceDate = (value: string) => {
  const day = formatDay(value);
  return day ? `${day} ${formatClock(value)}` : value;
};

/**
 * The same moment as a day alone: what a reader's line says (「更新于 10月7日」). It was Intl's zh-CN default, 「2026/10/7」, which no other
 * page writes (spec §14.3; review L-7); the clock is for the folded record. A value that is not a date is shown as written.
 */
export const evidenceDay = (value: string) => formatDay(value) || value;
