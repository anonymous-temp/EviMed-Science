import { BALANCE_REFUSAL_CODES } from './errorCodes.mjs'

/**
 * Research allowance pricing is money, never a token denomination.
 *
 * Two rules exist, and each is a version with its own activation instant
 * (`evimed_credits.billing_policies`): activation is sticky by version, so a
 * run that started before a version's activation stays under the rule before
 * it, and nothing already settled is ever recomputed.
 *
 * - `RESEARCH_BILLING_VERSION_WHOLE_CREDIT` (2026-10-03): a finished run is
 *   charged in whole credits rounded down, so anything under 1 灵豆 is free.
 *   The only rule an integer-only external wallet can carry.
 * - `RESEARCH_BILLING_VERSION` (2026-10-05): the exact sum of a run's billable
 *   model calls, 8 decimals, no rounding and no minimum. It needs a wallet that
 *   holds decimals, lots and holds — the platform's own (`evimedCreditsWallet.mjs`).
 */
export const RESEARCH_BILLING_VERSION_WHOLE_CREDIT = 'research-allowance-v1-20261003';
export const RESEARCH_BILLING_VERSION = 'research-allowance-v2-20261005';
export const RESEARCH_BILLING_VERSIONS = Object.freeze([RESEARCH_BILLING_VERSION_WHOLE_CREDIT, RESEARCH_BILLING_VERSION]);
/** The two wallet contracts a charge records (`walletContract`). */
export const WALLET_CONTRACT_WHOLE_CREDIT = 'legacy-integer-floor';
export const WALLET_CONTRACT_EXACT = 'precision-v1';

/**
 * The simulated wallet's vocabulary (2026-10-04): what the control plane serves
 * and the page draws, written once so the two cannot disagree.
 *
 * A simulated wallet exists so the owner can look at the whole allowance
 * experience before a real wallet exists. Nothing here is money, so every
 * amount a surface draws from it carries `SIMULATED_WALLET_LABEL`, and its
 * commerce destinations are pages of this platform rather than anyone's checkout.
 * There are two, because there are two things a simulated wallet can do: take a
 * top-up and list the orders it made. A membership or a refund page would have
 * nothing behind it — no plan to open, no money to return — and a page that only
 * says it is a demonstration is a placeholder (2026-10-07 audit), so there is none.
 */
export const SIMULATED_WALLET_LABEL = '模拟'
/** What a first read of an account's simulated wallet grants, in whole credits (one credit is one CNY). */
export const SIMULATED_START_CREDITS = 200
/** At or below this many whole credits the allowance reads as low. */
export const SIMULATED_LOW_CREDITS = 20
/** The simulated recharge and order destinations — routes of the web app. */
export const SIMULATED_WALLET_PAGES = Object.freeze({
  recharge: '/app/account/simulated/recharge',
  orders: '/app/account/simulated/orders',
})
/** The only amounts a simulated top-up can be for, in whole credits. A closed list: the request names a package, never a number. */
export const SIMULATED_TOPUP_PACKAGES = Object.freeze([
  Object.freeze({ id: 'topup-50', credits: 50 }),
  Object.freeze({ id: 'topup-100', credits: 100 }),
  Object.freeze({ id: 'topup-200', credits: 200 }),
  Object.freeze({ id: 'topup-500', credits: 500 }),
])

/** An amount as the allowance page draws it (¥12.30), or '' when there is no amount to draw.
 *  @param {unknown} value @param {{ rounding?: 'nearest' | 'down' | 'up' }} [options] */
function yuan(value, options = {}) {
  const units = creditUnitsOrNull(value)
  return units === null || units < 0n ? '' : `¥${formatCredits(units, options)}`
}

/**
 * What a researcher reads when the allowance refuses a start: that it is too
 * low, by how much when that is known, and where it is topped up. For the
 * surfaces that show a refusal's text as it is — the kernel's own conversation
 * window above all, which cannot map a code to a sentence — so the one place
 * the words are written is here, and the dictionary's sentence for the same
 * code (`simulated_credits_exhausted`, `credits_exhausted`) says the same
 * thing without the amounts.
 *
 * A simulated allowance says so in its first words and names the amount as
 * simulated: nothing it holds is money.
 * @param {{ simulated?: boolean, balanceCny?: number | string | null, estimateCny?: number | string | null }} [refusal]
 *   amounts in CNY, as the allowance page shows them (a credit is one CNY); a number
 *   or an exact decimal string, drawn by `formatCredits`
 * @returns {string}
 */
export function allowanceRefusalSentence({ simulated = false, balanceCny = null, estimateCny = null } = {}) {
  // What is held is rounded down and what is needed is rounded up: a refusal
  // must never show a balance that would have covered the amount it says it was
  // short of.
  const have = yuan(balanceCny, { rounding: 'down' })
  const need = yuan(estimateCny, { rounding: 'up' })
  const lead = simulated ? `${SIMULATED_WALLET_LABEL}额度不足，这次没有开始` : '科研额度不足，这次没有开始'
  const held = simulated ? `可用${SIMULATED_WALLET_LABEL}额度 ${have}` : `可用 ${have}`
  const amounts = have ? `：${held}${need ? `，这件事预计至少需要 ${need}` : ''}` : ''
  return `${lead}${amounts}。到“设置 → 科研额度”${simulated ? '做一次模拟充值' : '充值'}后即可继续。`
}

/**
 * What a programme step of 循证 GEO or 虚拟临床研究 waits on when the allowance
 * refused its start (2026-10-04): the step stays queued, its run is asked for
 * again every tick, and the page says why. A closed pair, because the step
 * record is read by two stores and two pages: `simulated_allowance` is the
 * refusal of a simulated wallet, which every surface marks 模拟.
 */
export const STEP_WAITING_ALLOWANCE = Object.freeze(['allowance', 'simulated_allowance'])

/**
 * The step reason a dispatch refusal code means, or null for any other code.
 * @param {unknown} code
 * @returns {'allowance' | 'simulated_allowance' | null}
 */
export function stepWaitingFor(code) {
  const text = String(code ?? '')
  if (!BALANCE_REFUSAL_CODES.includes(text)) return null
  return text === 'simulated_credits_exhausted' ? 'simulated_allowance' : 'allowance'
}

/** The short word under a waiting step in a rail. @param {unknown} waiting */
export function allowanceWaitingNote(waiting) {
  return waiting === 'simulated_allowance' ? `等${SIMULATED_WALLET_LABEL}额度` : '等科研额度'
}

/**
 * Why a step has not started, in one sentence, and what makes it start. Said by
 * the server where it writes the page's attention lines and by the pages where
 * they draw a step's state, so the two cannot word it differently.
 * @param {string} stepName the step as its page names it (「定义」)
 * @param {unknown} waiting `STEP_WAITING_ALLOWANCE`
 */
export function allowanceWaitingSentence(stepName, waiting) {
  const simulated = waiting === 'simulated_allowance'
  return `「${stepName}」这一步在等${simulated ? SIMULATED_WALLET_LABEL : '科研'}额度，${simulated ? '模拟充值' : '充值'}后会自动开始。`
}

export const RESEARCH_MONEY_SCALE = 100_000_000n;
// `evidence-upkeep` (2026-10-05): what an account's own evidence zone costs to keep current is the
// account's, so its model calls are billed like a run's. The platform's own `evidence` and `frontier`
// are not in the list: they are overhead the platform carries.
export const RESEARCH_BILLABLE_PURPOSES = Object.freeze(['kernel', 'engine', 'review', 'web-search', 'evidence-upkeep']);

/** Parse exact nonnegative decimal money; never silently round input.
 * @param {string | number} value @returns {bigint} */
export function researchMoneyUnits(value) {
  const text = String(value);
  if (!/^\d+(?:\.\d{1,8})?$/.test(text)) throw new RangeError('Invalid research money amount.');
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * RESEARCH_MONEY_SCALE + BigInt(fraction.padEnd(8, '0'));
}
/** @param {bigint} units @returns {string} */
export function researchMoneyDecimal(units) {
  if (units < 0n) throw new RangeError('Negative research money amount.');
  return `${units / RESEARCH_MONEY_SCALE}.${String(units % RESEARCH_MONEY_SCALE).padStart(8, '0')}`;
}
/**
 * An amount as exact integer units of 1e-8, or null when it is not an amount.
 *
 * An exact decimal string (what the server sends and the database holds) or a
 * bigint is taken as it is. A JS number is accepted for the one use a number has
 * here — drawing — and is read to 8 decimals; money is never summed or compared
 * through one (the money path stays in strings and bigint).
 * @param {unknown} value @returns {bigint | null}
 */
export function creditUnitsOrNull(value) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) > 1e9) return null
    return BigInt(Math.round(value * 1e8))
  }
  if (typeof value !== 'string') return null
  const match = /^(-)?(\d{1,15})(?:\.(\d{1,8}))?$/.exec(value.trim())
  if (!match) return null
  const units = BigInt(match[2]) * RESEARCH_MONEY_SCALE + BigInt((match[3] ?? '').padEnd(8, '0'))
  return match[1] ? -units : units
}

/**
 * The one way an amount of 灵豆 is drawn — in a server sentence, in a statement
 * line, on the allowance page — so no two surfaces disagree about it.
 *
 * Two decimals. A non-zero amount below 0.01 shows its first two significant
 * digits (0.0043) and is never drawn as 0.00, because a run that cost something
 * must not read as free. That form is cut, so it can never read as more than it is
 * — except for an amount that must be reached, which is carried up to the next step
 * of those two digits (and to 0.01, if that is where it reaches). A balance is drawn
 * with `rounding: 'down'`, so a page never shows more than is held; an amount that
 * must be reached (what a start needs) with `'up'`; a charge with the default
 * `'nearest'`.
 * @param {unknown} value an exact decimal string, a bigint of 1e-8 units, or a number
 * @param {{ rounding?: 'nearest' | 'down' | 'up' }} [options]
 * @returns {string} '' when the value is not an amount
 */
export function formatCredits(value, { rounding = 'nearest' } = {}) {
  const units = creditUnitsOrNull(value)
  if (units === null) return ''
  const negative = units < 0n
  const magnitude = negative ? -units : units
  const sign = negative ? '-' : ''
  const cent = RESEARCH_MONEY_SCALE / 100n
  if (magnitude === 0n) return '0.00'
  if (magnitude < cent) {
    const digits = String(magnitude).padStart(8, '0')
    const first = digits.search(/[1-9]/)
    const end = Math.min(first + 2, 8)
    // Cut to the first two significant digits — or, for an amount that must be reached, carried up to the next
    // step of them, so a need of 0.00999999 is never drawn as the 0.0099 a balance of 0.0099 would also be drawn as.
    const step = 10n ** BigInt(8 - end)
    const cut = rounding === 'up' ? (magnitude + step - 1n) / step * step : magnitude / step * step
    if (cut >= cent) return `${sign}0.01`
    return `${sign}0.${String(cut).padStart(8, '0').slice(0, end).replace(/0+$/, '')}`
  }
  const hundredths = rounding === 'down' ? magnitude / cent
    : rounding === 'up' ? (magnitude + cent - 1n) / cent
      : (magnitude + cent / 2n) / cent
  const whole = hundredths / 100n
  return `${sign}${whole}.${String(hundredths % 100n).padStart(2, '0')}`
}

/**
 * A run's cost estimate as exact units, P50 and P90 of the capability's own
 * settled history (or the manifest's minutes at a reference rate before there
 * is any). The unit-exact twin of `estimateCost` in `metering.mjs`: the start
 * check and the hold compare these with a balance, so they never pass through a
 * JS float on the way (`creditsForCost` used to round an estimate of 0.40 to 0).
 * @param {{ samples?: readonly bigint[], estimatedMinutes?: readonly number[], perMinuteUnits?: bigint }} input
 * @returns {{ p50: bigint, p90: bigint, basis: 'history' | 'manifest' | 'none' }}
 */
export function estimateRunCostUnits({ samples = [], estimatedMinutes = [], perMinuteUnits = 20_000_000n } = {}) {
  const sorted = samples.filter((value) => typeof value === 'bigint' && value >= 0n).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  if (sorted.length >= 5) return { p50: quantileUnits(sorted, 50n), p90: quantileUnits(sorted, 90n), basis: 'history' }
  if (estimatedMinutes.length === 2 && estimatedMinutes.every((minutes) => Number.isFinite(minutes) && minutes >= 0)) {
    return { p50: BigInt(Math.round(estimatedMinutes[0])) * perMinuteUnits, p90: BigInt(Math.round(estimatedMinutes[1])) * perMinuteUnits, basis: 'manifest' }
  }
  return { p50: 0n, p90: 0n, basis: 'none' }
}

/** Linear-interpolated percentile over sorted units, in integer arithmetic. @param {readonly bigint[]} sorted @param {bigint} percent */
function quantileUnits(sorted, percent) {
  const position = BigInt(sorted.length - 1) * percent
  const lower = Number(position / 100n)
  const remainder = position % 100n
  if (remainder === 0n) return sorted[lower]
  return sorted[lower] + (sorted[lower + 1] - sorted[lower]) * remainder / 100n
}

/** A token count from the database (a bigint arrives as a digit string), or 0. @param {unknown} value */
function tokenCount(value) {
  return typeof value === 'bigint' ? value : typeof value === 'string' && /^\d{1,18}$/.test(value) ? BigInt(value)
    : Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0 ? BigInt(/** @type {number} */ (value)) : 0n
}

/** Immutable financial evidence includes every request once; estimates never become actual money.
 *
 * `usage` is what the charge is made of, for a reader who wants to check it by
 * multiplication: the confirmed model calls that were billed, their tokens by
 * kind, and the price lists they were priced under. Tokens are summed as
 * bigint and returned as digit strings.
 * @param {Array<{id:string,status:string,priced?:boolean,currency?:string,purpose?:string,actual_cost?:string|number|null,price_version?:string,billing_eligible?:boolean,not_billable_reason?:string,cache_hit_tokens?:string|number|bigint|null,cache_miss_tokens?:string|number|bigint|null,output_tokens?:string|number|bigint|null}>} rows
 * @param {{owned?:boolean, mode?:string}} [options] */
export function researchTaskCharge(rows, { owned = true, mode = WALLET_CONTRACT_WHOLE_CREDIT } = {}) {
  if (![WALLET_CONTRACT_WHOLE_CREDIT, WALLET_CONTRACT_EXACT].includes(mode)) throw new RangeError('Unsupported wallet contract.');
  const seen = new Set();
  let actual = 0n;
  let billable = 0n;
  let overhead = 0n;
  let eligible = 0n;
  let calls = 0;
  let cacheHit = 0n;
  let cacheMiss = 0n;
  let output = 0n;
  const priceVersions = new Set();
  const evidence = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const confirmed = row.status === 'settled' && row.priced === true && row.currency === 'CNY' && row.actual_cost != null;
    const amount = confirmed ? researchMoneyUnits(/** @type {string|number} */ (row.actual_cost)) : 0n;
    const chargeable = confirmed && owned && row.billing_eligible !== false && RESEARCH_BILLABLE_PURPOSES.includes(String(row.purpose));
    actual += amount;
    if (row.billing_eligible !== false && RESEARCH_BILLABLE_PURPOSES.includes(String(row.purpose))) eligible += amount;
    if (!RESEARCH_BILLABLE_PURPOSES.includes(String(row.purpose)) || row.not_billable_reason === 'platform_task') overhead += amount;
    if (chargeable) {
      billable += amount;
      calls += 1;
      cacheHit += tokenCount(row.cache_hit_tokens);
      cacheMiss += tokenCount(row.cache_miss_tokens);
      output += tokenCount(row.output_tokens);
      if (row.price_version) priceVersions.add(String(row.price_version));
    }
    evidence.push({ id: row.id, status: row.status, purpose: row.purpose ?? 'other', priceVersion: row.price_version ?? '', actualCny: confirmed ? researchMoneyDecimal(amount) : null, billable: chargeable, notBillableReason: row.not_billable_reason ?? (chargeable ? null : !confirmed ? 'provider_unconfirmed' : !RESEARCH_BILLABLE_PURPOSES.includes(String(row.purpose)) ? 'platform_overhead' : !owned ? 'task_waived' : null) });
  }
  const exact = mode === WALLET_CONTRACT_EXACT;
  const charged = exact ? billable : billable / RESEARCH_MONEY_SCALE * RESEARCH_MONEY_SCALE;
  return { pricingVersion: exact ? RESEARCH_BILLING_VERSION : RESEARCH_BILLING_VERSION_WHOLE_CREDIT, walletContract: mode, creditsPerCny: 1,
    actualCny: researchMoneyDecimal(actual), platformCostCny: researchMoneyDecimal(overhead), eligibleCny: researchMoneyDecimal(eligible), billableCny: researchMoneyDecimal(billable),
    chargedCny: researchMoneyDecimal(charged), creditsAmount: researchMoneyDecimal(charged),
    waivedCny: researchMoneyDecimal(eligible - charged),
    usage: { calls, cacheHitTokens: String(cacheHit), cacheMissTokens: String(cacheMiss), outputTokens: String(output), priceVersions: [...priceVersions].sort() },
    evidence };
}
