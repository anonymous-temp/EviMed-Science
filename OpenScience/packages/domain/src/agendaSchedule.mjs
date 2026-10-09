/** Calendar schedules shared by the server and browser. ISO weekdays are Monday=1.
 * Gaps advance to the first valid wall minute; overlaps use the earlier instant.
 * Catch-up returns just the latest due occurrence, never an accumulated backlog.
 */
/** @typedef {{kind:'once'|'daily'|'weekly',timeZone:string,time:string,date?:string,weekdays?:number[]}} AgendaSchedule */
/** @typedef {{key:string,scheduledAt:string,localDate:string}} AgendaOccurrence */
const MINUTE = 60_000
const DAY = 86_400_000
/** @param {unknown} date */
export function validAgendaDate(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
    && Number(date.slice(0, 4)) >= 1970 && Number(date.slice(0, 4)) <= 9998
    && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date
}
/** @param {any} input @returns {AgendaSchedule} */
export function validateAgendaSchedule(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['kind', 'timeZone', 'time', 'date', 'weekdays'].includes(key))
    || !['once', 'daily', 'weekly'].includes(input.kind) || typeof input.timeZone !== 'string'
    || !/^[A-Za-z]/.test(input.timeZone) || input.timeZone.length > 80 || typeof input.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.time)
    || (input.kind === 'once' ? !validAgendaDate(input.date) : input.date !== undefined)
    || (input.kind === 'weekly' ? !Array.isArray(input.weekdays) || !input.weekdays.length || input.weekdays.length > 7
      || input.weekdays.some((/** @type {number} */ day) => !Number.isInteger(day) || day < 1 || day > 7) : input.weekdays !== undefined)) {
    throw new TypeError('Invalid agenda schedule.')
  }
  try { new Intl.DateTimeFormat('en-US', { timeZone: input.timeZone }).format(0) }
  catch { throw new TypeError('Invalid agenda time zone.') }
  return { kind: input.kind, timeZone: input.timeZone, time: input.time,
    ...(input.kind === 'once' ? { date: input.date } : {}),
    ...(input.kind === 'weekly' ? { weekdays: [...new Set(/** @type {number[]} */ (input.weekdays))].sort((a, b) => a - b) } : {}) }
}
/** Legacy normalization never writes to or activates a record. @param {any} payload */
export function normalizeAgendaSchedule(payload) {
  if (payload.schedule) return validateAgendaSchedule(payload.schedule)
  if (!Number.isInteger(payload.scheduleHour) || payload.scheduleHour < 0 || payload.scheduleHour > 23) throw new TypeError('Invalid legacy agenda hour.')
  return validateAgendaSchedule({ kind: 'daily', timeZone: payload.timeZone, time: `${String(payload.scheduleHour).padStart(2, '0')}:00` })
}
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
 * The zone a day is read in when nothing narrower names one (the agenda's own,
 * the frontier feed's, the GEO module's): the deployment's researchers are in China,
 * which has had one offset since 1991.
 */
export const DISPLAY_TIME_ZONE = 'Asia/Shanghai'
/** @param {AgendaSchedule} schedule @param {string} date @returns {AgendaOccurrence} */
function occurrenceOn(schedule, date) {
  const target = `${date}T${schedule.time}`
  const naive = Date.parse(`${target}:00Z`)
  const format = formatter(schedule.timeZone)
  // Sample both sides of an offset transition, then resolve candidates exactly.
  const offsets = new Set([-2, -1, 0, 1, 2].map(days => {
    const instant = naive + days * DAY
    return Date.parse(`${wall(format, instant)}:00Z`) - instant
  }))
  const matches = [...offsets].map(offset => naive - offset).filter(instant => wall(format, instant) === target)
  let instant = matches.length ? Math.min(...matches) : Infinity
  if (!matches.length) {
    // Rare nonexistent local times (including an entire skipped date). This is
    // bounded to 72 hours, and used only when the offset candidates fail.
    let bestWall = ''
    for (let candidate = naive - DAY; candidate <= naive + 2 * DAY; candidate += MINUTE) {
      const value = wall(format, candidate)
      if (value >= target && (!bestWall || value < bestWall)) { bestWall = value; instant = candidate }
    }
  }
  return { key: `${date}T${schedule.time}@${schedule.timeZone}`, scheduledAt: new Date(instant).toISOString(), localDate: date }
}
/** @param {AgendaSchedule} schedule @param {string} date */
function accepts(schedule, date) { return schedule.kind !== 'weekly' || schedule.weekdays?.includes(new Date(`${date}T12:00:00Z`).getUTCDay() || 7) }
/** @param {string} date @param {number} days */
function shiftDate(date, days) { return new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10) }
/** @param {AgendaSchedule} input @param {AgendaOccurrence|null|undefined} last @param {string|Date} now @param {string|null} notBefore @returns {AgendaOccurrence|null} */
export function agendaDueOccurrence(input, last, now, notBefore = null) {
  const schedule = validateAgendaSchedule(input)
  const instant = new Date(now).getTime()
  const today = agendaLocalDate(schedule.timeZone, now)
  for (let days = 0; days < (schedule.kind === 'once' ? 1 : 8); days += 1) {
    const date = schedule.kind === 'once' ? /** @type {string} */ (schedule.date) : shiftDate(today, -days)
    if (!accepts(schedule, date)) continue
    const occurrence = occurrenceOn(schedule, date)
    const time = Date.parse(occurrence.scheduledAt)
    if (time > instant) continue
    if ((last && (last.key === occurrence.key || Date.parse(last.scheduledAt) >= time)) || (schedule.kind !== 'once' && notBefore && time < Date.parse(notBefore))) return null
    return occurrence
  }
  return null
}
/** @param {AgendaSchedule} input @param {AgendaOccurrence|null|undefined} last @param {string|Date} after @returns {AgendaOccurrence|null} */
export function agendaNextOccurrence(input, last, after) {
  const schedule = validateAgendaSchedule(input)
  const today = agendaLocalDate(schedule.timeZone, after)
  for (let days = 0; days < (schedule.kind === 'once' ? 1 : 9); days += 1) {
    const date = schedule.kind === 'once' ? /** @type {string} */ (schedule.date) : shiftDate(today, days)
    if (!accepts(schedule, date)) continue
    const occurrence = occurrenceOn(schedule, date)
    if (Date.parse(occurrence.scheduledAt) <= new Date(after).getTime() || (last && Date.parse(occurrence.scheduledAt) <= Date.parse(last.scheduledAt))) continue
    return occurrence
  }
  return null
}

/** The weekday words, Monday first: the index is the ISO weekday minus one. */
export const AGENDA_WEEKDAY_WORDS = Object.freeze(['周一', '周二', '周三', '周四', '周五', '周六', '周日'])
/**
 * A schedule in the reader's words: 「每天 07:00」, 「每周一、周五 07:30」, 「10月12日 · 仅一次 07:30」 (with the year when it is not the
 * year the zone is in). The clock is the schedule's own; the zone is said beside it by whoever prints the line
 * (`agendaZoneName`), since a time without one is ambiguous. A weekly schedule that names all seven days is every day.
 * One place, so the conversation's task card, the tool's answer and the page say the same thing.
 * @param {any} input @param {string|Date} [now] when 「this year」 is read
 * @returns {string}
 */
export function describeAgendaSchedule(input, now = new Date()) {
  const schedule = validateAgendaSchedule(input)
  if (schedule.kind === 'once') {
    const [year, month, day] = /** @type {string} */ (schedule.date).split('-').map(Number)
    const thisYear = Number(agendaLocalDate(schedule.timeZone, now).slice(0, 4))
    return `${year === thisYear ? '' : `${year}年`}${month}月${day}日 · 仅一次 ${schedule.time}`
  }
  const days = schedule.weekdays ?? []
  if (schedule.kind === 'weekly' && days.length < 7) return `每${days.map(day => AGENDA_WEEKDAY_WORDS[day - 1]).join('、')} ${schedule.time}`
  return `每天 ${schedule.time}`
}
/**
 * The zone as a reader names it (「中国标准时间」), or '' for an identifier the runtime does not know.
 * @param {string} timeZone @returns {string}
 */
export function agendaZoneName(timeZone) {
  try {
    return new Intl.DateTimeFormat('zh-CN', { timeZone, timeZoneName: 'long' }).formatToParts(new Date()).find(part => part.type === 'timeZoneName')?.value ?? ''
  } catch { return '' }
}
/**
 * A moment as a person in `timeZone` reads it: 「10月9日 07:00」. '' for a value that is not a moment.
 * @param {string|null|undefined} value @param {string} timeZone @returns {string}
 */
export function agendaInstantText(value, timeZone) {
  if (!value || !Number.isFinite(Date.parse(value))) return ''
  return new Intl.DateTimeFormat('zh-CN', { timeZone, month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))
}
