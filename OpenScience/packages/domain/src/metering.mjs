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
 * @typedef {object} PriceList
 * @property {string} currency
 * @property {Record<string, { cacheHit: number, cacheMiss: number, output: number }>} model  price per 1M tokens
 * @property {number} asrPerMinute
 * @property {number} embeddingPerMillion
 * @property {Record<string, number>} specialistJob
 * @property {number} storagePerGigabyteDay
 */

/**
 * The reference price list. A deployment overrides it; the shape is fixed here
 * so a price list is one thing rather than a scattering of constants.
 * @type {PriceList}
 */
export const REFERENCE_PRICE_LIST = Object.freeze({
  currency: 'CNY',
  model: Object.freeze({
    'deepseek-v4-pro': Object.freeze({ cacheHit: 0.5, cacheMiss: 4, output: 12 }),
    'deepseek-v4-flash': Object.freeze({ cacheHit: 0.1, cacheMiss: 1, output: 2 }),
  }),
  asrPerMinute: 0.05,
  embeddingPerMillion: 0.5,
  specialistJob: Object.freeze({
    'meta-analysis': 6,
    'mendelian-randomization': 8,
    'bibliometric-analysis': 4,
    'research-topic-selection': 4,
    'peer-review': 3,
    'drug-safety-analysis': 3,
  }),
  storagePerGigabyteDay: 0.01,
})

/**
 * What one metered request costs.
 *
 * An unknown model costs zero and says so through the returned `priced` flag,
 * rather than guessing a rate: a guessed price on an invoice is worse than a
 * visible gap, because a gap gets fixed and a guess gets believed.
 *
 * @param {{ resourceType: string, model?: string, cacheHit?: number, cacheMiss?: number, output?: number, minutes?: number, tokens?: number, jobType?: string, gigabyteDays?: number, peak: boolean }} usage
 * @param {PriceList} [prices]
 * @returns {{ cost: number, priced: boolean, currency: string }}
 */
export function priceUsage(usage, prices = REFERENCE_PRICE_LIST) {
  const multiplier = usage.peak ? 1 : OFF_PEAK_MULTIPLIER
  const currency = prices.currency
  switch (usage.resourceType) {
    case 'model': {
      const rate = prices.model[String(usage.model ?? '')]
      if (!rate) return { cost: 0, priced: false, currency }
      const millions = (/** @type {unknown} */ value) => (Number(value) || 0) / 1_000_000
      const cost = millions(usage.cacheHit) * rate.cacheHit
        + millions(usage.cacheMiss) * rate.cacheMiss
        + millions(usage.output) * rate.output
      return { cost: round(cost * multiplier), priced: true, currency }
    }
    case 'asr':
      return { cost: round((Number(usage.minutes) || 0) * prices.asrPerMinute * multiplier), priced: true, currency }
    case 'embedding':
      return { cost: round(((Number(usage.tokens) || 0) / 1_000_000) * prices.embeddingPerMillion * multiplier), priced: true, currency }
    case 'specialist-job': {
      const rate = prices.specialistJob[String(usage.jobType ?? '')]
      if (rate == null) return { cost: 0, priced: false, currency }
      return { cost: round(rate * multiplier), priced: true, currency }
    }
    case 'storage':
      // Storage is not a request and has no peak window; applying one would
      // charge a user less for the same disk at night, which is nonsense.
      return { cost: round((Number(usage.gigabyteDays) || 0) * prices.storagePerGigabyteDay), priced: true, currency }
    default:
      return { cost: 0, priced: false, currency }
  }
}

/** @param {number} value @returns {number} */
function round(value) {
  return Math.round(value * 10_000) / 10_000
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
