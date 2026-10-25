/**
 * What a reader of 「前沿动态」 did, as the closed vocabulary the browser sends and the control plane keeps (ct-track,
 * 2026-10-24). The owner: 「推荐系统和冷启动这块都在后台计算…前台顶多放一些用于埋点的功能，埋点这块做好吧」 — ranking is the
 * server's, and the page only reports what happened, in a shape good enough to evaluate a ranking later.
 *
 * Hidden knowledge:
 *
 * - **An impression means seen, not rendered.** A card counts once at least half of it was in view for one continuous
 *   second in a visible tab (the MRC/IAB display viewability floor, `FRONTIER_IMPRESSION`); a card scrolled past faster, or
 *   in a background tab, was not seen and is not a trial in any click-through rate.
 * - **Every open joins the list it came from.** A list answer carries a server-made `listId` and each entry a `slot`; an
 *   impression and an open carry them back with the position the entry was displayed at, so a click is attributable to
 *   one served list, one slot and one position (position bias is corrected later from these, never guessed).
 * - **Reader events join their open, not a list.** The open carries a client-made `view` id; dwell, read depth, reach-end
 *   and the reader's actions carry the same `view` and the surface `reader`. The list context lives once, on the open.
 * - **Dwell is visible, engaged time.** The page reports milliseconds the reader tab was visible and not idle
 *   (`FRONTIER_DWELL.idleMs`) since its last report, on hide, on page hide and on leaving; the server sums by view.
 * - **Nothing personal travels.** No URL, no query text, no free text, no IP or device string: closed words, public ids,
 *   numbers. The account is the server's session; the `session` id is a random token a tab rotates after 30 idle minutes;
 *   `device` is the layout class only (`narrow` under 1024 px, `wide` from it), because position bias and dwell differ by
 *   layout (Yi et al. 2014 normalise dwell per device).
 * - One validator (`frontierInteraction`) for both sides: the page drops what it would be refused for, and the server
 *   keeps what passes and counts each drop by its reason. An unknown type is dropped, never stored under a guess.
 *
 * Which model capability would make it deletable: none — these are facts about what happened, recorded.
 *
 * @module frontierInteractions
 */

/** @typedef {'impression' | 'open' | 'dwell' | 'read-depth' | 'reach-end' | 'star' | 'unstar' | 'hide' | 'unhide' | 'open-original' | 'toggle-translation' | 'expand-body' | 'share' | 'research' | 'ask' | 'save' | 'related-open' | 'filter-change' | 'onboarding-shown' | 'onboarding-done' | 'onboarding-skipped'} FrontierInteractionType */
/** @typedef {'feed' | 'for-you' | 'hot' | 'daily' | 'weekly' | 'monthly' | 'follows' | 'search' | 'safety' | 'event' | 'track' | 'congress' | 'reader' | 'push' | 'direct'} FrontierSurface */
/** @typedef {'editorial' | 'personal' | 'must-see' | 'explore'} FrontierSlot */

export const FRONTIER_INTERACTION_TYPES = /** @type {readonly FrontierInteractionType[]} */ (Object.freeze([
  'impression',
  'open',
  'dwell',
  'read-depth',
  'reach-end',
  'star',
  'unstar',
  'hide',
  'unhide',
  'open-original',
  'toggle-translation',
  'expand-body',
  'share',
  'research',
  'ask',
  'save',
  'related-open',
  'filter-change',
  'onboarding-shown',
  'onboarding-done',
  'onboarding-skipped',
]))

/**
 * Where it happened. The lists (`feed` 精选/全部, `for-you` 与我相关, `hot` 热榜, `daily`/`weekly`/`monthly` 简报, `follows`
 * 关注, `search`, `safety` 安全警示, `event` an event page), the item's reading page (`reader`), and how a reading page was
 * reached without a list: a notification (`push`) or an address (`direct`).
 */
export const FRONTIER_SURFACES = /** @type {readonly FrontierSurface[]} */ (Object.freeze([
  'feed', 'for-you', 'hot', 'daily', 'weekly', 'monthly', 'follows', 'search', 'safety', 'event', 'track', 'congress', 'reader', 'push', 'direct',
]))

/** The surfaces that are lists: an impression happens on one of these only. */
export const FRONTIER_LIST_SURFACES = /** @type {readonly FrontierSurface[]} */ (Object.freeze([
  'feed', 'for-you', 'hot', 'daily', 'weekly', 'monthly', 'follows', 'search', 'safety', 'event', 'track', 'congress',
]))

/**
 * Why an entry is where it is in a served list (contract C): the editor's pick (`editorial`), the reader's profile
 * (`personal`), a broad safety alert or a major guideline or approval in their specialties (`must-see`), or the one
 * exploration entry drawn at random from good items outside the profile, its propensity logged (`explore`). A
 * chronological list's entries have none (`null`).
 */
export const FRONTIER_SLOTS = /** @type {readonly FrontierSlot[]} */ (Object.freeze(['editorial', 'personal', 'must-see', 'explore']))

/** Why a reader hid an item, when they say (「不感兴趣」). Closed: a reason is a word the ranking can count, never free text. */
export const FRONTIER_HIDE_REASONS = Object.freeze(['not-relevant', 'already-seen', 'low-quality', 'promotional', 'not-my-specialty', 'source'])

export const FRONTIER_HIDE_REASON_LABELS_ZH = /** @type {Readonly<Record<string, string>>} */ (Object.freeze({
  'not-relevant': '与我无关',
  'already-seen': '看过了',
  'low-quality': '内容质量不高',
  promotional: '像广告或软文',
  'not-my-specialty': '不是我的专科',
  source: '不想看这个来源',
}))

/** The controls a `filter-change` names: which one moved, never what it was set to (a search's words never leave the page). */
export const FRONTIER_FILTER_CONTROLS = Object.freeze(['view', 'channel', 'lane', 'specialty', 'tag', 'evidence', 'window', 'starred', 'unread', 'sort', 'search', 'follow', 'agency'])

/** The onboarding steps, in order; `onboarding-skipped` names the one it was skipped at. */
export const FRONTIER_ONBOARDING_STEPS = Object.freeze(['role', 'specialties', 'interests'])

/** A reader's role, as onboarding asks it (「你的角色」); it sets the genre priors of the ranking. */
export const FRONTIER_READER_ROLES = Object.freeze(['clinician', 'pharmacist', 'researcher', 'industry', 'student', 'other'])

export const FRONTIER_READER_ROLE_LABELS_ZH = /** @type {Readonly<Record<string, string>>} */ (Object.freeze({
  clinician: '临床医生',
  pharmacist: '药师',
  researcher: '科研人员',
  industry: '医药企业',
  student: '医学生',
  other: '其他',
}))

/** What onboarding takes: one role, one to three specialties, up to ten interests (tag slugs or entity keys). */
export const FRONTIER_ONBOARDING_LIMITS = Object.freeze({ specialtiesMin: 1, specialtiesMax: 3, interestsMax: 10 })

/** The layout an event happened in: the reader page's two columns start at 1024 px (`useWide`). */
export const FRONTIER_DEVICE_CLASSES = Object.freeze(['narrow', 'wide'])

/** The read-depth milestones of a reading page's body, in percent. */
export const FRONTIER_READ_DEPTHS = Object.freeze([25, 50, 75, 100])

/**
 * Seen: at least this share of the card in view, for at least this long, continuously, in a visible tab — the MRC/IAB
 * display viewability floor (50% of pixels for one continuous second).
 */
export const FRONTIER_IMPRESSION = Object.freeze({ minRatio: 0.5, minMs: 1_000 })

/**
 * Dwell: a visible tab with no scroll, key, pointer or touch for `idleMs` stops counting (a reading page left open over
 * lunch is not three hours of reading); one report holds at most `maxReportMs`; a view with `satisfiedMs` of dwell, or
 * that reached the end, is a satisfied read (the 30-second "satisfied click" of web search logs).
 */
export const FRONTIER_DWELL = Object.freeze({ idleMs: 180_000, maxReportMs: 1_800_000, satisfiedMs: 30_000 })

/** A tab's `session` id rotates after this long with nothing reported (the common 30-minute analytics session). */
export const FRONTIER_SESSION_IDLE_MS = 30 * 60_000

/** One request carries at most this many events, in at most this many bytes (what `navigator.sendBeacon` may send). */
export const FRONTIER_INTERACTION_BATCH = Object.freeze({ maxEvents: 50, maxBytes: 65_536 })

/** How far an event's own clock may be from the server's: older is a stale queue, later is a wrong clock. */
export const FRONTIER_INTERACTION_CLOCK = Object.freeze({ pastMs: 24 * 3_600_000, futureMs: 5 * 60_000 })

/** Why an event is dropped: the server counts each (`open_science_frontier_events_total{outcome}`). */
export const FRONTIER_INTERACTION_DROP_REASONS = Object.freeze(['not-an-object', 'unknown-type', 'bad-id', 'bad-surface', 'bad-target',
  'bad-list', 'bad-slot', 'bad-position', 'bad-value', 'bad-detail', 'bad-session', 'bad-view', 'bad-device', 'stale', 'unexpected-field'])

const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/
const ITEM_ID = /^[a-z0-9]{12,32}$/
const EVENT_ID = /^[a-z0-9][a-z0-9-]{2,63}$/
const LIST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const FIELDS = new Set(['id', 'type', 'at', 'surface', 'item', 'event', 'list', 'slot', 'position', 'value', 'detail', 'session', 'view', 'device'])
/** The most entries a list position can name: a feed of twenty pages of fifty. */
const MAX_POSITION = 999

/**
 * Per type: what it is about (`target`: an item, an item or an event, or nothing), whether it carries a list context,
 * whether a reading view is required, its value (a closed set, or a whole-number range) and its detail words.
 * @type {Readonly<Record<FrontierInteractionType, { target: 'item' | 'item-or-event' | 'none', list?: boolean, view?: true,
 *   value?: { min: number, max: number } | readonly number[], valueRequired?: boolean, detail?: readonly string[], surfaces?: readonly string[] }>>}
 */
export const FRONTIER_INTERACTION_RULES = Object.freeze({
  impression: { target: 'item-or-event', list: true, value: { min: FRONTIER_IMPRESSION.minMs, max: 600_000 }, surfaces: FRONTIER_LIST_SURFACES },
  open: { target: 'item-or-event', list: true },
  dwell: { target: 'item', view: true, value: { min: 1, max: FRONTIER_DWELL.maxReportMs }, valueRequired: true },
  'read-depth': { target: 'item', view: true, value: FRONTIER_READ_DEPTHS, valueRequired: true },
  'reach-end': { target: 'item', view: true },
  star: { target: 'item', list: true },
  unstar: { target: 'item', list: true },
  hide: { target: 'item', list: true, detail: FRONTIER_HIDE_REASONS },
  unhide: { target: 'item', list: true },
  'open-original': { target: 'item', list: true },
  'toggle-translation': { target: 'item', detail: ['zh', 'original'] },
  'expand-body': { target: 'item' },
  share: { target: 'item', list: true, detail: ['markdown', 'link'] },
  research: { target: 'item', list: true },
  // c3-base: a reader asked about the item from its 「就此提问」 — one of its suggested questions, or their own.
  ask: { target: 'item', list: true, detail: ['suggested', 'own'] },
  save: { target: 'item', list: true },
  'related-open': { target: 'item', detail: ['item', 'event'] },
  'filter-change': { target: 'none', detail: FRONTIER_FILTER_CONTROLS },
  'onboarding-shown': { target: 'none', surfaces: ['for-you'] },
  'onboarding-done': { target: 'none', surfaces: ['for-you'] },
  'onboarding-skipped': { target: 'none', surfaces: ['for-you'], detail: FRONTIER_ONBOARDING_STEPS },
})

/**
 * @typedef {{ id: string, type: FrontierInteractionType, at: number, surface: FrontierSurface, item: string | null, event: string | null,
 *   list: string | null, slot: FrontierSlot | null, position: number | null, value: number | null, detail: string | null, session: string,
 *   view: string | null, device: 'narrow' | 'wide' | null }} FrontierInteraction
 */

/** @param {unknown} value @returns {value is FrontierInteractionType} */
export function isFrontierInteractionType(value) {
  return typeof value === 'string' && Object.hasOwn(FRONTIER_INTERACTION_RULES, value)
}

/**
 * One event as the browser sent it, checked and normalized: every field in its closed shape, absent optional fields as
 * `null`, or the reason it is dropped. Pure; `now` is the receiver's clock in epoch milliseconds.
 * @param {unknown} raw @param {{ now: number }} clock
 * @returns {{ ok: true, event: FrontierInteraction } | { ok: false, reason: string }}
 */
export function frontierInteraction(raw, { now }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not-an-object' }
  const input = /** @type {Record<string, unknown>} */ (raw)
  if (Object.keys(input).some((key) => !FIELDS.has(key))) return { ok: false, reason: 'unexpected-field' }
  if (!isFrontierInteractionType(input.type)) return { ok: false, reason: 'unknown-type' }
  const type = input.type
  const rule = FRONTIER_INTERACTION_RULES[type]
  if (typeof input.id !== 'string' || !CLIENT_ID.test(input.id)) return { ok: false, reason: 'bad-id' }
  if (typeof input.session !== 'string' || !CLIENT_ID.test(input.session)) return { ok: false, reason: 'bad-session' }
  const surface = input.surface
  if (typeof surface !== 'string' || !(/** @type {readonly string[]} */ (FRONTIER_SURFACES)).includes(surface)
    || (rule.surfaces && !rule.surfaces.includes(surface))) return { ok: false, reason: 'bad-surface' }
  const at = input.at
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < now - FRONTIER_INTERACTION_CLOCK.pastMs || at > now + FRONTIER_INTERACTION_CLOCK.futureMs) {
    return { ok: false, reason: 'stale' }
  }
  const present = (/** @type {string} */ key) => input[key] !== undefined && input[key] !== null
  const item = present('item') ? input.item : null
  const event = present('event') ? input.event : null
  if (item !== null && (typeof item !== 'string' || !ITEM_ID.test(item))) return { ok: false, reason: 'bad-target' }
  if (event !== null && (typeof event !== 'string' || !EVENT_ID.test(event))) return { ok: false, reason: 'bad-target' }
  if (rule.target === 'none' && (item !== null || event !== null)) return { ok: false, reason: 'bad-target' }
  if (rule.target === 'item' && (item === null || event !== null)) return { ok: false, reason: 'bad-target' }
  if (rule.target === 'item-or-event' && (item === null) === (event === null)) return { ok: false, reason: 'bad-target' }
  const list = present('list') ? input.list : null
  const slot = present('slot') ? input.slot : null
  const position = present('position') ? input.position : null
  if (!rule.list && (list !== null || slot !== null || position !== null)) return { ok: false, reason: 'bad-list' }
  if (list !== null && (typeof list !== 'string' || !LIST_ID.test(list))) return { ok: false, reason: 'bad-list' }
  if (slot !== null && (typeof slot !== 'string' || !(/** @type {readonly string[]} */ (FRONTIER_SLOTS)).includes(slot))) return { ok: false, reason: 'bad-slot' }
  if (position !== null && (typeof position !== 'number' || !Number.isSafeInteger(position) || position < 0 || position > MAX_POSITION)) {
    return { ok: false, reason: 'bad-position' }
  }
  const value = present('value') ? input.value : null
  if (value === null ? rule.valueRequired === true : !validValue(rule.value, value)) return { ok: false, reason: 'bad-value' }
  const detail = present('detail') ? input.detail : null
  if (detail !== null && (typeof detail !== 'string' || !rule.detail?.includes(detail))) return { ok: false, reason: 'bad-detail' }
  // A view joins reader events to their open: required where the rule says so, allowed on anything about an item (an open,
  // an action taken on a reading page), refused on what never happens on one (an onboarding step, a filter).
  const view = present('view') ? input.view : null
  if (view === null ? rule.view === true : rule.target === 'none' || typeof view !== 'string' || !CLIENT_ID.test(view)) {
    return { ok: false, reason: 'bad-view' }
  }
  const device = present('device') ? input.device : null
  if (device !== null && (typeof device !== 'string' || !FRONTIER_DEVICE_CLASSES.includes(device))) return { ok: false, reason: 'bad-device' }
  return {
    ok: true,
    event: {
      id: input.id, type, at, surface: /** @type {FrontierSurface} */ (surface),
      item: /** @type {string | null} */ (item), event: /** @type {string | null} */ (event),
      list: /** @type {string | null} */ (list), slot: /** @type {FrontierSlot | null} */ (slot), position: /** @type {number | null} */ (position),
      value: /** @type {number | null} */ (value), detail: /** @type {string | null} */ (detail), session: input.session,
      view: /** @type {string | null} */ (view), device: /** @type {'narrow' | 'wide' | null} */ (device),
    },
  }
}

/** @param {{ min: number, max: number } | readonly number[] | undefined} rule @param {unknown} value */
function validValue(rule, value) {
  if (!rule || typeof value !== 'number' || !Number.isSafeInteger(value)) return false
  return Array.isArray(rule) ? rule.includes(value) : value >= /** @type {{ min: number }} */ (rule).min && value <= /** @type {{ max: number }} */ (rule).max
}
