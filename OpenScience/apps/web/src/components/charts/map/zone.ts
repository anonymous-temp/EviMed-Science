/**
 * Days in the researcher's time zone, and the instants a chart's time axis works in. The server counts a day in the zone the page
 * sends (`timeZone`), so a day the reader chooses on a chart has to be the same day there.
 */

const formats = new Map<string, Intl.DateTimeFormat>();
function formatIn(timeZone: string): Intl.DateTimeFormat {
  let format = formats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    formats.set(timeZone, format);
  }
  return format;
}

function partsOf(ms: number, timeZone: string): Record<string, string> {
  return Object.fromEntries(formatIn(timeZone).formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
}

/** The calendar day of an instant in a zone, YYYY-MM-DD. */
export function dayIn(ms: number, timeZone: string): string {
  const parts = partsOf(ms, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** The instant a day begins in a zone. */
export function dayStartMs(day: string, timeZone: string): number {
  const guess = Date.parse(`${day}T00:00:00Z`);
  const parts = partsOf(guess, timeZone);
  const shown = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
  return guess - (shown - guess);
}

/** The instant a day ends in a zone (the last millisecond of it). */
export function dayEndMs(day: string, timeZone: string): number {
  const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return dayStartMs(next, timeZone) - 1;
}
