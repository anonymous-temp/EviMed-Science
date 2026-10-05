/**
 * The vocabulary and the calendar of 灵豆 held as lots (2026-10-05).
 *
 * A balance is not one number. It is a set of lots, and there are exactly two
 * kinds: 充值 (purchased) — never expires, never reset, never taken back — and
 * 赠送 (gifted), each grant a lot of its own with a source and an expiry date
 * fixed, and shown, at the moment it is granted. A third kind would have to be
 * one of these two with a source; the wallet does not change for it.
 *
 * The wallet itself is `apps/server/src/evimedCreditsWallet.mjs`; what lives
 * here is what the server's sentences, the page and the wallet must agree on,
 * and the arithmetic of dates, which is pure and has to be exactly the same on
 * every side of it: a gifted lot expires at 24:00 Asia/Shanghai on its date.
 */

import { agendaLocalDate } from './agendaSchedule.mjs'

/** @type {readonly ['purchased', 'gifted']} */
export const CREDIT_LOT_KINDS = Object.freeze(['purchased', 'gifted'])
/** Why a gifted lot exists. `signup` and `monthly` are the platform's own; the other two are an operator's. */
export const CREDIT_GIFT_SOURCES = Object.freeze(['signup', 'monthly', 'compensation', 'campaign'])
/** The sources an operator may grant under: a compensation for something that went wrong, or a campaign. No daily check-in, no invitation. */
export const CREDIT_OPERATOR_GRANT_SOURCES = Object.freeze(['compensation', 'campaign'])
/** Every source a lot can carry: a purchased lot's is always `topup`. */
export const CREDIT_LOT_SOURCES = Object.freeze(['topup', ...CREDIT_GIFT_SOURCES])
/** An operator grant lasts this many days unless it names a date or another number. */
export const CREDIT_OPERATOR_GRANT_DEFAULT_DAYS = 90
/** The longest a gifted lot may be valid for: a typo in a date must not make a gift permanent. */
export const CREDIT_GIFT_MAX_DAYS = 3660
/** Days before its end that a lot with something left in it is reminded about, once each. */
export const CREDIT_EXPIRY_REMINDER_DAYS = Object.freeze([7, 1])
/** The lines a statement carries. A hold is not one: it shows on the balance. */
export const CREDIT_STATEMENT_KINDS = Object.freeze(['charge', 'topup', 'grant', 'expire', 'adjust'])
export const CREDIT_TIME_ZONE = 'Asia/Shanghai'

/** What a lot is called to the person who holds it. */
export const CREDIT_SOURCE_LABELS = Object.freeze({
  topup: '充值',
  signup: '注册赠送',
  monthly: '每月赠送',
  compensation: '补偿',
  campaign: '活动赠送',
})

/**
 * Why a finished run was not charged, in words a person reads on their own
 * statement. The codes are what the server writes; these are the sentences.
 */
export const CREDIT_NOT_CHARGED_REASONS = Object.freeze({
  not_delivered: '没有完成，不收费',
  platform_stop: '平台停止了这次运行，不收费',
  stop_unattributed: '无法确认是你主动停止的，不收费',
  platform_work: '平台自己的工作，不收费',
  earlier_rule_stop: '这次运行开始时，停止的部分还不收费',
  no_usage: '没有产生可计费的用量',
})

/** Asia/Shanghai keeps no daylight saving time, so its offset is a constant. */
const SHANGHAI_OFFSET_MS = 8 * 3_600_000
const DAY_MS = 86_400_000

/** @param {Date | string | number} value @returns {number} */
function epoch(value) {
  const time = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(String(value))
  if (!Number.isFinite(time)) throw new RangeError('Invalid instant.')
  return time
}

/**
 * The Asia/Shanghai calendar date, `YYYY-MM-DD`, of an instant. The domain's own
 * `agendaLocalDate` is the one place a zone's date is worked out, so a month
 * total, a statement window and a gift's expiry cannot disagree about which day
 * it is: at 2026-10-31T16:30Z it is already 1 November here.
 * @param {Date | string | number} instant
 */
function dateOf(instant) {
  return agendaLocalDate(CREDIT_TIME_ZONE, new Date(epoch(instant)))
}

/**
 * The first moment of the month `now` falls in, 00:00 on its first day in
 * Asia/Shanghai — where every month a person reads on the allowance and usage
 * pages begins. Machine keys and the provider's own UTC fields stay UTC; this is
 * for a boundary a person reads.
 * @param {Date | string | number} now
 * @returns {Date}
 */
export function accountMonthStart(now) {
  return new Date(`${dateOf(now).slice(0, 7)}-01T00:00:00+08:00`)
}

/**
 * The instant a gifted lot whose date is `date` expires: 24:00 Asia/Shanghai on
 * it, which is 00:00 of the day after. A date that is not a real calendar date
 * is refused rather than rolled over (`2026-02-30` is not 2026-03-02).
 * @param {string} date `YYYY-MM-DD`
 * @returns {Date}
 */
export function expiryInstantOfDate(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date))
  if (!match) throw new RangeError('A lot expires on a date, YYYY-MM-DD.')
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new RangeError('A lot expires on a real calendar date.')
  }
  return new Date(Date.UTC(year, month - 1, day + 1) - SHANGHAI_OFFSET_MS)
}

/**
 * The expiry of a lot that lasts `days` days from `now`: the date `days` days
 * after today's date in Shanghai, to its 24:00. A grant on 10 月 5 日 for 30 days
 * is valid through 11 月 4 日.
 * @param {Date | string | number} now @param {number} days a whole number of at least 1
 * @returns {Date}
 */
export function expiryInstantAfterDays(now, days) {
  if (!Number.isSafeInteger(days) || days < 1 || days > CREDIT_GIFT_MAX_DAYS) throw new RangeError('A lot lasts a whole number of days.')
  return expiryInstantOfDate(dateOf(epoch(now) + days * DAY_MS))
}

/**
 * The date a lot is valid through, as it is shown: the date of the last moment
 * it can be spent. The instant `2026-10-31T16:00:00Z` is the end of 10 月 31 日.
 * @param {Date | string | number} expiresAt @returns {string} `YYYY-MM-DD`
 */
export function expiryDateOf(expiresAt) {
  return dateOf(epoch(expiresAt) - 1)
}

/**
 * An expiry in the words the page uses: 「10 月 31 日」.
 * @param {Date | string | number} expiresAt
 */
export function expiryWords(expiresAt) {
  const [, month, day] = expiryDateOf(expiresAt).split('-')
  return `${Number(month)} 月 ${Number(day)} 日`
}

/** @param {number} year @param {number} monthIndex 0-based, may overflow into later years */
function daysInMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
}

/**
 * The instant, 00:00 Asia/Shanghai, of cycle number `index` of an account whose
 * wallet was created at `createdAt`: the same day of the month as the creation,
 * clamped to the month's length (an account made on the 31st is on the 28th in
 * February and the 30th in April).
 * @param {Date | string | number} createdAt @param {number} index 0 is the creation's own date
 * @returns {Date}
 */
export function monthlyDateOf(createdAt, index) {
  const [createdYear, createdMonth, anchorDay] = dateOf(createdAt).split('-').map(Number)
  const monthIndex = createdMonth - 1 + index
  const year = createdYear + Math.floor(monthIndex / 12)
  const month = ((monthIndex % 12) + 12) % 12
  const day = Math.min(anchorDay, daysInMonth(year, month))
  return new Date(Date.UTC(year, month, day) - SHANGHAI_OFFSET_MS)
}

/**
 * The monthly cycle `now` falls in, or null before the first monthly date.
 *
 * Cycle 0 is the month the wallet was created in, which the sign-up gift
 * covers; the first monthly gift is on the first monthly date after it. Only the
 * current cycle is ever returned — a gift missed while nothing was running is
 * not granted late for a month that is over.
 * @param {Date | string | number} createdAt @param {Date | string | number} now
 * @returns {{ index: number, startsAt: Date, endsAt: Date } | null}
 */
export function monthlyCycleAt(createdAt, now) {
  const at = epoch(now)
  const created = epoch(createdAt)
  if (at < created) return null
  // Months between the two dates, then step back while the cycle date is still ahead.
  const [fromYear, fromMonth] = dateOf(created).split('-').map(Number)
  const [toYear, toMonth] = dateOf(at).split('-').map(Number)
  let index = (toYear - fromYear) * 12 + (toMonth - fromMonth)
  while (index > 0 && monthlyDateOf(created, index).getTime() > at) index -= 1
  if (index < 1) return null
  return { index, startsAt: monthlyDateOf(created, index), endsAt: monthlyDateOf(created, index + 1) }
}

/**
 * Which reminder, if any, a lot is due now: the 7-day one or the 1-day one.
 *
 * Due when the lot is within that many days of its end and was already that
 * old when the day arrived — a lot granted with three days to run never had a
 * 7-day mark. Of the reminders due at once only the nearest is returned, so a
 * gap in the worker's sweep sends one reminder and not a stack. A lot with
 * nothing left, or one already over, is not reminded.
 * @param {{ createdAt: Date | string | number, expiresAt: Date | string | number, remaining: bigint | string }} lot
 * @param {Date | string | number} now
 * @returns {7 | 1 | null}
 */
export function expiryReminderDue(lot, now) {
  const at = epoch(now)
  const created = epoch(lot.createdAt)
  const ends = epoch(lot.expiresAt)
  const hasRemaining = typeof lot.remaining === 'bigint' ? lot.remaining > 0n : /[1-9]/.test(String(lot.remaining))
  if (!hasRemaining) return null
  if (at >= ends) return null
  /** @type {7 | 1 | null} */
  let due = null
  for (const days of [...CREDIT_EXPIRY_REMINDER_DAYS].sort((a, b) => b - a)) {
    const mark = ends - days * DAY_MS
    if (at >= mark && created < mark) due = /** @type {7 | 1} */ (days)
  }
  return due
}
