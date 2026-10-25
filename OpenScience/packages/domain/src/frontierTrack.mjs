/**
 * 追踪 (「前沿动态」, c3-track 2026-10-25): the three things a clinician comes back to the feed for and wants complete — what was
 * approved, which guidelines changed and what they now recommend, what came out of the congress this week. The feed has all three
 * as items in a stream; medical apps make them views of their own, and that needs a few structured facts the feed did not keep.
 *
 * This module is the vocabulary and the pure decisions of it: the approval kinds and the regulators code knows by their owner, the
 * limits of what is extracted, the version of the extraction (a change of the instructions is a new version, which writes the
 * record again), and the congress calendar's clock — whether a congress is on, coming or just over, in the feed's own zone — and the
 * window its items are found in. The model calls, the quotation checks and the queries are `apps/server/src/frontierTrack.mjs`.
 *
 * @module frontierTrack
 */

import { FRONTIER_CONGRESSES } from './frontierLeadWatch.mjs'

/** @typedef {'new-drug' | 'new-indication' | 'new-formulation' | 'generic-biosimilar' | 'withdrawal' | 'other'} FrontierApprovalKind */
/** @typedef {import('./frontierLeadWatch.mjs').FrontierCongress} FrontierCongress */

/**
 * The version of the tracker extraction (instructions, shapes and checks). A record written under another version is written again
 * by the pipeline, newest first.
 */
export const FRONTIER_TRACK_VERSION = 'track-1'

/** What an approval is, as a clinician sorts it (the closed list the model answers from). */
export const FRONTIER_APPROVAL_KINDS = /** @type {readonly FrontierApprovalKind[]} */ (Object.freeze([
  'new-drug', 'new-indication', 'new-formulation', 'generic-biosimilar', 'withdrawal', 'other',
]))

export const FRONTIER_APPROVAL_KIND_LABELS_ZH = /** @type {Readonly<Record<FrontierApprovalKind, string>>} */ (Object.freeze({
  'new-drug': '首次获批',
  'new-indication': '新增适应症',
  'new-formulation': '新剂型 / 新规格',
  'generic-biosimilar': '仿制药 / 生物类似药',
  withdrawal: '撤市 / 停用',
  other: '其他审批动态',
}))

/**
 * The regulators and payers an approval is attributed to, by the owner entity of the source that reports it: when the source IS the
 * agency (the FDA's own feed, the EMA's) code knows the agency and the model is not asked. A news item or a press release names its
 * agency in its text, and the model answers one of these keys (or `other`) with the words that say it.
 * `region` groups the agency for the filter: 国内, 美国, 欧洲, 其他.
 */
export const FRONTIER_AGENCIES = Object.freeze([
  { key: 'nmpa', label: 'NMPA', name: '国家药监局', region: 'cn', owners: ['国家药品监督管理局'] },
  { key: 'fda', label: 'FDA', name: '美国 FDA', region: 'us', owners: ['U.S. Food and Drug Administration'] },
  { key: 'ec', label: '欧盟委员会', name: '欧盟委员会', region: 'eu', owners: ['European Commission'] },
  { key: 'ema', label: 'EMA', name: '欧洲药品管理局', region: 'eu', owners: ['European Medicines Agency'] },
  { key: 'mhra', label: 'MHRA', name: '英国 MHRA', region: 'eu', owners: ['Medicines and Healthcare products Regulatory Agency'] },
  { key: 'pmda', label: 'PMDA', name: '日本 PMDA', region: 'other', owners: ['Pharmaceuticals and Medical Devices Agency (PMDA), Japan'] },
  { key: 'health-canada', label: 'Health Canada', name: '加拿大卫生部', region: 'other', owners: ['Health Canada'] },
  { key: 'tga', label: 'TGA', name: '澳大利亚 TGA', region: 'other', owners: ['Therapeutic Goods Administration'] },
  { key: 'cms', label: 'CMS', name: '美国 CMS', region: 'us', owners: ['U.S. Centers for Medicare & Medicaid Services'] },
  { key: 'nhsa', label: '国家医保局', name: '国家医保局', region: 'cn', owners: ['国家医疗保障局'] },
  { key: 'smc', label: 'SMC', name: '苏格兰药品联盟', region: 'eu', owners: ['Scottish Medicines Consortium'] },
  { key: 'nice', label: 'NICE', name: '英国 NICE', region: 'eu', owners: ['National Institute for Health and Care Excellence'] },
])

/** The keys the model may answer for an agency named in a text: those above that approve medicines, and `other`. */
export const FRONTIER_APPROVAL_AGENCY_KEYS = Object.freeze(['nmpa', 'fda', 'ec', 'ema', 'mhra', 'pmda', 'health-canada', 'tga', 'other'])

/**
 * The names a regulator is written by in a text (lower case): a quotation that is to say "this agency decided" holds one of them. A
 * closed list of proper names, not a reading of language.
 */
export const FRONTIER_AGENCY_ALIASES = Object.freeze({
  nmpa: Object.freeze(["nmpa", "国家药品监督管理局", "国家药监局", "药监局", "china national medical products administration", "national medical products administration"]),
  fda: Object.freeze(["fda", "food and drug administration", "食品药品监督管理局", "美国食药监"]),
  ec: Object.freeze(["european commission", "欧盟委员会", "欧委会"]),
  ema: Object.freeze(["ema", "european medicines agency", "欧洲药品管理局", "欧洲药监局", "chmp"]),
  mhra: Object.freeze(["mhra", "medicines and healthcare products regulatory agency"]),
  pmda: Object.freeze(["pmda", "pharmaceuticals and medical devices agency", "日本医药品医疗器械综合机构", "mhlw", "ministry of health, labour and welfare", "厚生劳动省"]),
  'health-canada': Object.freeze(["health canada", "加拿大卫生部"]),
  tga: Object.freeze(["tga", "therapeutic goods administration"]),
})

/**
 * Whether a quotation names an agency: one of its names, a Latin name standing alone as a word (so `ema` is not found in `edema`).
 * @param {unknown} quote @param {string} key
 */
export function frontierQuoteNamesAgency(quote, key) {
  const aliases = /** @type {Record<string, readonly string[]>} */ (FRONTIER_AGENCY_ALIASES)[key]
  if (!aliases) return false
  const text = String(quote ?? '').normalize('NFKC').toLowerCase()
  return aliases.some((alias) => (/^[a-z0-9 ,.\-]+$/.test(alias) ? new RegExp(`(?<![a-z0-9])${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`).test(text) : text.includes(alias)))
}

export const FRONTIER_AGENCY_REGIONS = Object.freeze([
  { key: 'cn', label: '国内' },
  { key: 'us', label: '美国' },
  { key: 'eu', label: '欧洲' },
  { key: 'other', label: '其他' },
])

/** The agency an owner entity is, or null for a publisher that is not one (a news site, a press-release wire). @param {unknown} ownerEntity */
export function frontierAgencyOfOwner(ownerEntity) {
  const owner = String(ownerEntity ?? '').trim()
  if (!owner) return null
  return FRONTIER_AGENCIES.find((agency) => agency.owners.includes(owner)) ?? null
}

/** An agency by its key, or null. @param {unknown} key */
export function frontierAgencyByKey(key) {
  return FRONTIER_AGENCIES.find((agency) => agency.key === key) ?? null
}

/** What is asked of a text, and what is kept of it. */
export const FRONTIER_TRACK_LIMITS = Object.freeze({
  /** The reader text shown to the model, in characters (the head). */
  input: 9_000,
  /** Recommendations kept for a guideline. */
  recommendations: 5,
  /** A field's text and its quotation, in code points. */
  text: 160,
  quoteMin: 3,
  quoteMax: 400,
  /** The shortest quotation of a recommendation (a heading is no recommendation). */
  recommendationQuoteMin: 12,
  /** A decision dated longer before its item than this is not news of the item's window. */
  decisionMaxAgeDays: 120,
  /** How far back the first run reaches, and how many items one pipeline round extracts. */
  backfillDays: 30,
  batch: 6,
})

/** The 审批 list reaches back this far, and a page of it holds this many rows. */
export const FRONTIER_TRACK_APPROVAL_DAYS = 90
export const FRONTIER_TRACK_PAGE = 30

// ───────────────────────── congress clock ─────────────────────────

/** Days: a congress counts as upcoming this far ahead and as recent this far back (owner brief: next 60 days, last 30 days). */
export const FRONTIER_CONGRESS_UPCOMING_DAYS = 60
export const FRONTIER_CONGRESS_RECENT_DAYS = 30
/** Its items are those of the days from this many before its start to as many after its end. */
export const FRONTIER_CONGRESS_ITEM_DAYS = 3

/** @param {string} day */
function dayNumber(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day))
  if (!match) return null
  const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isFinite(at) ? Math.round(at / 86_400_000) : null
}

/** A calendar day moved by whole days (`YYYY-MM-DD`). @param {string} day @param {number} days */
export function frontierShiftDay(day, days) {
  const number = dayNumber(day)
  if (number === null) throw new TypeError(`Not a day: ${day}`)
  return new Date((number + days) * 86_400_000).toISOString().slice(0, 10)
}

/** Whole days from one day to another (`to` − `from`). @param {string} from @param {string} to */
export function frontierDaysBetween(from, to) {
  const a = dayNumber(from)
  const b = dayNumber(to)
  if (a === null || b === null) throw new TypeError('Not a day.')
  return b - a
}

/** A moment as its calendar day in a zone (`Asia/Shanghai` for the feed). @param {Date | string | number} moment @param {string} timeZone */
export function frontierDayIn(moment, timeZone = 'Asia/Shanghai') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(moment)).map((part) => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

/**
 * Where a congress stands on a day (the feed's day, `YYYY-MM-DD`): `ongoing` from its first to its last day, `upcoming` within the
 * next `FRONTIER_CONGRESS_UPCOMING_DAYS`, `recent` within the last `FRONTIER_CONGRESS_RECENT_DAYS` after it ended; otherwise `later`
 * (further ahead) or `past` (longer ago). Dates are the organiser's local calendar dates, read as the feed's day.
 * @param {{ start: string, end: string }} congress @param {string} day
 * @returns {'ongoing' | 'upcoming' | 'recent' | 'later' | 'past'}
 */
export function frontierCongressStatus(congress, day) {
  if (day >= congress.start && day <= congress.end) return 'ongoing'
  if (day < congress.start) return frontierDaysBetween(day, congress.start) <= FRONTIER_CONGRESS_UPCOMING_DAYS ? 'upcoming' : 'later'
  return frontierDaysBetween(congress.end, day) <= FRONTIER_CONGRESS_RECENT_DAYS ? 'recent' : 'past'
}

/** The days a congress's items are found in: from three days before its start to three days after its end. @param {{ start: string, end: string }} congress */
export function frontierCongressItemWindow(congress) {
  return { from: frontierShiftDay(congress.start, -FRONTIER_CONGRESS_ITEM_DAYS), to: frontierShiftDay(congress.end, FRONTIER_CONGRESS_ITEM_DAYS) }
}

/**
 * The congress days a recap is written for: each day of the meeting up to the day itself (a recap of a day that has not started
 * is nothing), as `YYYY-MM-DD`. The day after the last one still gets the last day's recap written (items keep arriving), which
 * `frontierCongressRecapDays` leaves to the caller by passing `grace` days.
 * @param {{ start: string, end: string }} congress @param {string} today @param {number} [grace] days after the end that are still recapped
 */
export function frontierCongressRecapDays(congress, today, grace = 1) {
  const days = []
  const last = frontierShiftDay(congress.end, grace)
  if (today < congress.start || today > last) return days
  for (let day = congress.start; day <= congress.end && day <= today; day = frontierShiftDay(day, 1)) days.push(day)
  return days
}

/** A congress of the calendar by id, or null. @param {unknown} id @param {readonly FrontierCongress[]} [calendar] */
export function frontierCongressById(id, calendar = FRONTIER_CONGRESSES) {
  return calendar.find((congress) => congress.id === id) ?? null
}

/**
 * The short code a congress is called by (「ESMO 2026」): the first keyword of the calendar that is a Latin name and a year; its
 * Chinese name when it has none.
 * @param {FrontierCongress} congress
 */
export function frontierCongressCode(congress) {
  const code = [...(congress.keywords_zh ?? []), ...(congress.keywords_en ?? [])].find((word) => /^[A-Za-z][A-Za-z0-9 .&/-]{1,22}\d{4}$/.test(String(word).trim()))
  return code ? String(code).trim() : String(congress.name_zh || congress.name_en)
}

/**
 * The congress as the track view lists it: its dates, place and specialty with its status on a day. `name` is the Chinese name
 * and `nameEn` the English one, each without the organiser's parenthesis; `code` the short name.
 * @param {FrontierCongress} congress @param {string} day
 */
export function frontierCongressSummary(congress, day) {
  const short = (/** @type {string} */ name) => String(name).replace(/\s*[（(][^)）]*[)）]\s*$/u, '').trim()
  return {
    id: congress.id,
    code: frontierCongressCode(congress),
    name: short(congress.name_zh || congress.name_en),
    nameEn: short(congress.name_en),
    start: congress.start,
    end: congress.end,
    city: congress.city ?? null,
    specialty: congress.specialty ?? null,
    status: frontierCongressStatus(congress, day),
  }
}
