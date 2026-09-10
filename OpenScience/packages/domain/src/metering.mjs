/**
 * Metering, credits and notifications: the vocabulary.
 *
 * Hidden knowledge: where a number becomes authoritative, and why it is not
 * where you would first look.
 *
 * The run reports its own usage — the kernel hands us a token count per step —
 * and that number is the wrong one to bill on. It is the run's account of
 * itself, it arrives only when a stream completes cleanly, and it cannot see a
 * request that failed after the provider had already charged for it. So the
 * gateways are the authority: every request that leaves through the model, ASR
 * or embedding boundary is metered there, and the run's own figure is used for
 * exactly two things a rough number is fine for — the in-run budget guard and
 * the progress readout.
 *
 * The second decision worth stating: the off-peak discount is passed through
 * rather than kept. "The AI works while you sleep" is only an honest pitch if
 * the bill is actually lower at night, and a margin taken there would turn the
 * one genuine cost advantage into a claim a customer can check and disprove.
 *
 * @module @evimed/domain/metering
 */

/** What a metered request consumed. */
export const RESOURCE_TYPES = Object.freeze(['model', 'asr', 'embedding', 'specialist-job', 'storage'])

/** Why a credit ledger row exists. */
export const CREDIT_REASONS = Object.freeze(['topup', 'run', 'episode', 'refund', 'adjust'])

/**
 * The three kinds of thing that reach a person, borrowed from the ambient-agent
 * literature because the distinction is the useful part: a notice needs no
 * reply, a question blocks work until answered, and a review is a decision only
 * a person may make. Sorting an inbox by time mixes all three; sorting by kind
 * puts the blocking ones first.
 */
export const NOTICE_TYPES = Object.freeze(['notify', 'question', 'review'])

/** Inbox ordering: the blocking kinds first, and time only within a kind. */
export const NOTICE_PRIORITY = Object.freeze({ review: 0, question: 1, notify: 2 })

/**
 * The peak window, in UTC.
 *
 * The provider charges full price 01:00–04:00 and 06:00–10:00 UTC on weekdays,
 * and half price otherwise. Expressed in UTC rather than in local time because
 * the provider's window is in UTC; converting it once here is better than every
 * caller converting it differently.
 */
export const PEAK_WINDOWS_UTC = Object.freeze([
  Object.freeze({ startHour: 1, endHour: 4 }),
  Object.freeze({ startHour: 6, endHour: 10 }),
])

/** The multiplier applied off-peak, passed through to the customer unchanged. */
export const OFF_PEAK_MULTIPLIER = 0.5

/**
 * Whether an instant falls in the provider's peak window.
 * @param {Date} at
 * @returns {boolean}
 */
export function isPeak(at) {
  const day = at.getUTCDay()
  // Saturday and Sunday are off-peak all day.
  if (day === 0 || day === 6) return false
  const hour = at.getUTCHours()
  return PEAK_WINDOWS_UTC.some((window) => hour >= window.startHour && hour < window.endHour)
}

/**
 * @typedef {object} UsageEvent
 * @property {string} userId      who the call is billed to
 * @property {string} projectId   which of their projects it belongs to
 * @property {string} [runId]     absent when the observer is below the run
 * @property {string} [sessionId] absent for the same reason
 * @property {number} [step]      absent for the same reason
 * @property {string} resourceType
 * @property {string} model
 * @property {number} cacheHit    prompt tokens served from the provider's cache
 * @property {number} cacheMiss   prompt tokens the provider had to read
 * @property {number} output
 * @property {boolean} peak
 * @property {number} cost
 * @property {string} currency
 * @property {boolean} priced     false when the price list did not know the model
 * @property {string} at
 */

// Why the run is optional. Model usage is observed at the gateway, which is
// the only place the provider's own token counts arrive, and the gateway
// authenticates a *runtime* rather than a run: one project can have several
// runs in flight, so a run id here would be a guess. An event without one is
// still billable, still attributable to a person, and still countable against
// a cap; a guessed run id would make a per-run invoice that looks precise and
// is not.

/**
 * A price list.
 *
 * Cache hits are priced separately because the provider prices them separately,
 * by roughly an order of magnitude. Folding them into one input rate would
 * charge a user for a stable prompt prefix as if it were new — and a stable
 * prefix is exactly the behaviour the composition is designed to produce.
 *
 * A list is identified and dated, not anonymous: every ledger row stamps the
 * version it was priced under, and a list that carried neither a version nor a
 * start instant could be stamped on a row and then never found again.
 *
 * @typedef {object} PriceList
 * @property {string} currency
 * @property {string} version
 * @property {string} effectiveFrom  ISO instant this list started billing
 * @property {string} [modelSource]
 * @property {Record<string, { cacheHit: number, cacheMiss: number, output: number }>} model  price per 1M tokens
 * @property {number} asrPerMinute
 * @property {number} embeddingPerMillion
 * @property {Record<string, number>} specialistJob
 * @property {number} storagePerGigabyteDay
 */

/**
 * Freeze a price list — or a registry of them — through every nested table.
 *
 * `Object.freeze` is one level deep and every rate in a list is at least two:
 * a list frozen only at the top still lets one line of code change the rate a
 * settled ledger row was billed at, and nothing on the invoice would show it.
 * A price list is a plain tree of data — no cycles, no class instances — so
 * walking it terminates.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (!value || typeof value !== 'object') return value
  Object.freeze(value)
  for (const inner of Object.values(value)) deepFreeze(inner)
  return value
}

/**
 * Historical reference rates, retained for rows billed under this version.
 * @type {PriceList}
 */
const referencePrices20260905 = deepFreeze({
  currency: 'CNY',
  version: 'evimed-reference-2026-09-05',
  effectiveFrom: '2026-09-05T00:00:00.000Z',
  modelSource: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
  model: {
    'deepseek-v4-pro': { cacheHit: 0.3, cacheMiss: 9, output: 27 },
    'deepseek-v4-flash': { cacheHit: 0.1, cacheMiss: 3, output: 9 },
  },
  asrPerMinute: 0.05,
  embeddingPerMillion: 0.5,
  specialistJob: {
    'meta-analysis': 6,
    'mendelian-randomization': 8,
    'bibliometric-analysis': 4,
    'research-topic-selection': 4,
    'peer-review': 3,
    'drug-safety-analysis': 3,
  },
  storagePerGigabyteDay: 0.01,
})

/** Current CNY rates verified against the official DeepSeek table on 2026-09-10.
 * Legacy Flash aliases are served and billed as V4.1 Flash by the provider.
 * @type {PriceList}
 */
export const REFERENCE_PRICE_LIST = deepFreeze({
  ...referencePrices20260905,
  version: 'evimed-reference-2026-09-10',
  effectiveFrom: '2026-09-10T00:00:00.000Z',
  model: {
    'deepseek-flash': { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    'deepseek-v4-flash': { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    'deepseek-v4-flash-vision-exp': { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    'deepseek-v4-pro': { cacheHit: 0.3, cacheMiss: 9, output: 27 },
  },
})

/**
 * Every price list this platform has billed against, keyed by version.
 *
 * Each ledger row stamps the version it was priced under, and a stamp is only
 * worth writing down if the list it names can still be found: without this
 * registry, the first price change turns every historical row into a reference
 * to a list that exists nowhere, and reconciling or re-pricing a past month
 * becomes guesswork. Adding the next list is a data edit here — append the new
 * entry with its own `effectiveFrom`, point `REFERENCE_PRICE_LIST` at it, and
 * never touch a list that has already priced a row.
 *
 * The usage ledger was created after `evimed-reference-2026-09-05`, so no
 * persisted row can name an earlier one. The rates that preceded it are
 * deliberately not resurrected here — they were billed by an off-peak rule this function no longer applies,
 * so a reconstruction would be a price list that never charged anyone.
 *
 * Not exported, on purpose. A map handed out is a map indexed, and indexing it
 * with a version it does not hold answers `undefined` — the one value a price
 * list must never be, because `undefined` is also what an omitted argument
 * looks like. `priceListFor` is the only lookup and it answers `null`.
 *
 * @type {Readonly<Record<string, PriceList>>}
 */
const priceLists = deepFreeze({
  'evimed-reference-2026-09-05': referencePrices20260905,
  'evimed-reference-2026-09-10': REFERENCE_PRICE_LIST,
})

/**
 * The registered price versions, oldest first by `effectiveFrom`.
 *
 * This is how a caller — or a test holding the registry to its invariants —
 * enumerates what exists without being handed the registry itself. Resolving
 * each one goes through `priceListFor`, which cannot answer `undefined`.
 *
 * @type {readonly string[]}
 */
export const PRICE_LIST_VERSIONS = Object.freeze(
  Object.keys(priceLists).sort((left, right) => Date.parse(priceLists[left].effectiveFrom) - Date.parse(priceLists[right].effectiveFrom)),
)

/**
 * The exact list a version names, or null.
 *
 * Null rather than the current list, always: a historical row re-priced at
 * today's rates is a wrong invoice that looks right, and the caller can only
 * treat it correctly — as unpriced — if it is told the truth here. Null rather
 * than `undefined` for the next reason along: `priceUsage` prices at the
 * current list when it is handed no list at all, so a failed lookup has to be
 * a value that is visibly not "no argument".
 *
 * @param {string | undefined | null} version
 * @returns {PriceList | null}
 */
export function priceListFor(version) {
  if (typeof version !== 'string' || !version) return null
  return Object.hasOwn(priceLists, version) ? priceLists[version] : null
}

/**
 * The list in force at an instant: the newest one that had already taken
 * effect. Null before the first list — no list was in force, and saying so is
 * better than dating a charge to prices that did not exist yet.
 *
 * The set to select from is a parameter because the selection is a rule over a
 * set. Tests can exercise a boundary between lists without changing the live
 * registry. It defaults to the registry, and no caller in the platform passes it.
 *
 * @param {Date | string | number} instant  a Date, an ISO instant, or epoch milliseconds
 * @param {Readonly<Record<string, PriceList>>} [registry]
 * @returns {PriceList | null}
 */
export function priceListAt(instant, registry = priceLists) {
  const at = instant instanceof Date ? instant.getTime()
    : typeof instant === 'number' ? instant
      : Date.parse(String(instant ?? ''))
  if (!Number.isFinite(at)) return null
  /** @type {PriceList | null} */
  let effective = null
  let effectiveAt = -Infinity
  for (const list of Object.values(registry)) {
    const from = Date.parse(String(list.effectiveFrom ?? ''))
    // A list with no parseable start cannot be dated, so it cannot be selected
    // by date; `priceListFor` still resolves it by name.
    if (!Number.isFinite(from) || from > at || from <= effectiveAt) continue
    effective = list
    effectiveAt = from
  }
  return effective
}

/**
 * What one metered request costs.
 *
 * An unknown model costs zero and says so through the returned `priced` flag,
 * rather than guessing a rate: a guessed price on an invoice is worse than a
 * visible gap, because a gap gets fixed and a guess gets believed.
 *
 * The price list is a rest parameter, and that is load-bearing rather than
 * stylish: a default parameter fires on an explicitly passed `undefined`
 * exactly as it fires on an omitted argument, so `priceUsage(usage, lookup())`
 * would bill a historical row at today's rates whenever `lookup()` missed.
 * Here the two are different. Omit the argument and the current list prices
 * the request, deliberately — that is how the gateway prices a live call it
 * stamps `REFERENCE_PRICE_LIST.version` on. Pass anything falsy — the `null`
 * from `priceListFor`, or an `undefined` from a lookup that missed — and
 * nothing is priced.
 *
 * @param {{ resourceType: string, model?: string, cacheHit?: number, cacheMiss?: number, output?: number, minutes?: number, tokens?: number, jobType?: string, gigabyteDays?: number, peak: boolean }} usage
 * @param {...(PriceList | null | undefined)} prices  omit to price at the current list; otherwise the resolved list to price against
 * @returns {{ cost: number, priced: boolean, currency: string }}
 */
export function priceUsage(usage, ...prices) {
  const list = prices.length === 0 ? REFERENCE_PRICE_LIST : prices[0]
  if (!list) return { cost: 0, priced: false, currency: '' }
  const multiplier = usage.peak ? 1 : OFF_PEAK_MULTIPLIER
  const currency = list.currency
  switch (usage.resourceType) {
    case 'model': {
      const rate = list.model[String(usage.model ?? '')]
      if (!rate) return { cost: 0, priced: false, currency }
      const millions = (/** @type {unknown} */ value) => (Number(value) || 0) / 1_000_000
      const cost = millions(usage.cacheHit) * rate.cacheHit
        + millions(usage.cacheMiss) * rate.cacheMiss
        + millions(usage.output) * rate.output
      return { cost: round(cost * multiplier), priced: true, currency }
    }
    case 'asr':
      return { cost: round((Number(usage.minutes) || 0) * list.asrPerMinute), priced: true, currency }
    case 'embedding':
      return { cost: round(((Number(usage.tokens) || 0) / 1_000_000) * list.embeddingPerMillion), priced: true, currency }
    case 'specialist-job': {
      const rate = list.specialistJob[String(usage.jobType ?? '')]
      if (rate == null) return { cost: 0, priced: false, currency }
      return { cost: round(rate), priced: true, currency }
    }
    case 'storage':
      // Storage is not a request and has no peak window; applying one would
      // charge a user less for the same disk at night, which is nonsense.
      return { cost: round((Number(usage.gigabyteDays) || 0) * list.storagePerGigabyteDay), priced: true, currency }
    default:
      return { cost: 0, priced: false, currency }
  }
}

/** @param {number} value @returns {number} */
function round(value) {
  return Math.round(value * 100_000_000) / 100_000_000
}

/**
 * A run's estimate, as a range.
 *
 * A single number is a promise, and this cannot promise. A P50–P90 range from
 * the capability's own history says what it is: most runs land here, some cost
 * more. The reference implementation the estimate falls back to when there is
 * no history uses the manifest's own minutes, which is a worse estimate but an
 * honest one — and it is marked as such so the UI can say "first run of this
 * kind".
 *
 * @param {{ samples: readonly number[], estimatedMinutes?: readonly number[], perMinute?: number }} input
 * @returns {{ p50: number, p90: number, basis: 'history' | 'manifest' | 'none' }}
 */
export function estimateCost(input) {
  const samples = [...(input.samples ?? [])].filter((value) => Number.isFinite(value) && value >= 0).sort((left, right) => left - right)
  if (samples.length >= 5) {
    return { p50: round(quantile(samples, 0.5)), p90: round(quantile(samples, 0.9)), basis: 'history' }
  }
  const minutes = input.estimatedMinutes ?? []
  if (minutes.length === 2) {
    const perMinute = Number(input.perMinute ?? 0.2)
    return { p50: round(minutes[0] * perMinute), p90: round(minutes[1] * perMinute), basis: 'manifest' }
  }
  return { p50: 0, p90: 0, basis: 'none' }
}

/** @param {readonly number[]} sorted @param {number} fraction @returns {number} */
function quantile(sorted, fraction) {
  if (!sorted.length) return 0
  const position = (sorted.length - 1) * fraction
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

/**
 * What a balance permits.
 *
 * Two thresholds, and they are different on purpose. Autopilot pauses while
 * there is still money left, because unattended work that drains an account
 * overnight is the failure users never forgive; interactive work continues to
 * zero, because a person who is sitting there watching can decide for
 * themselves.
 *
 * @param {{ balance: number, dailyLimit: number, spentToday: number, weeklyLimit?: number, spentThisWeek?: number }} account
 * @returns {{ interactive: boolean, autopilot: boolean, reason: string | null, code: string | null }}
 */
export function spendingPermission(account) {
  if (account.balance <= 0) {
    return { interactive: false, autopilot: false, reason: '余额已用尽。', code: 'credits_exhausted' }
  }
  if (account.dailyLimit > 0 && account.spentToday >= account.dailyLimit) {
    return { interactive: true, autopilot: false, reason: '今日额度上限已到。', code: 'credits_daily_limit_reached' }
  }
  const weeklyLimit = Number(account.weeklyLimit ?? account.dailyLimit * 7)
  if (weeklyLimit > 0 && Number(account.spentThisWeek ?? 0) >= weeklyLimit) {
    return { interactive: true, autopilot: false, reason: '本周额度上限已到。', code: 'credits_weekly_limit_reached' }
  }
  if (account.dailyLimit > 0 && account.balance < account.dailyLimit) {
    return { interactive: true, autopilot: false, reason: '余额不足一天的用量，主动科研已暂停。', code: null }
  }
  return { interactive: true, autopilot: true, reason: null, code: null }
}

/** Thresholds that produce an alert rather than a stop. */
export const SPEND_ALERTS = Object.freeze({
  dailyLimitFraction: 0.8,
  daysOfBalanceRemaining: 3,
  overEstimateQuantile: 'p90',
})

/**
 * Retention, in days, by object kind.
 *
 * Financial records outlive their project deliberately: a project deleted in
 * March cannot take March's invoice with it. Everything else expires, because
 * data kept without a reason is data kept until it leaks.
 */
export const RETENTION_DAYS = Object.freeze({
  autopilotEpisodeArtifacts: 90,
  notifications: 180,
  usageEvents: null,
  creditLedger: null,
})
