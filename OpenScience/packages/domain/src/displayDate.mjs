/** The calendar day an instant falls on in a zone, and the zone a day is read in when nothing narrower names one. */
/** @param {string} timeZone */
function formatter(timeZone) { return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) }
/** @param {Intl.DateTimeFormat} format @param {number} instant */
function wall(format, instant) {
  const parts = Object.fromEntries(format.formatToParts(instant).map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
}
/**
 * The calendar day (`YYYY-MM-DD`) an instant falls on in a zone: the one helper
 * for a day a person reads or a boundary a person's schedule defines. `toISOString().slice(0, 10)`
 * is the UTC day, which is the day before for the first eight hours of a day in China
 * -- a 07:00 briefing dated yesterday. Not for machine keys, calendar arithmetic on a date
 * that is already a date, or a provider's own UTC field: those stay as they are.
 * @param {string} timeZone @param {string|Date} now
 */
export function agendaLocalDate(timeZone, now) { return wall(formatter(timeZone), new Date(now).getTime()).slice(0, 10) }
/**
 * The zone a day is read in when nothing narrower names one (the frontier feed's,
 * the GEO module's, the credits' months): the deployment's researchers are in China,
 * which has had one offset since 1991.
 */
export const DISPLAY_TIME_ZONE = 'Asia/Shanghai'
