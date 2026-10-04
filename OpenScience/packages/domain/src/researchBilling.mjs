import { BALANCE_REFUSAL_CODES } from './errorCodes.mjs'

/** Research allowance pricing is money, never a token denomination. */
export const RESEARCH_BILLING_VERSION = 'research-allowance-v1-20261003';

/**
 * The simulated wallet's vocabulary (2026-10-04): what the control plane serves
 * and the page draws, written once so the two cannot disagree.
 *
 * A simulated wallet exists so the owner can look at the whole allowance
 * experience before a real wallet exists. Nothing here is money, so every
 * amount a surface draws from it carries `SIMULATED_WALLET_LABEL`, and the four
 * commerce destinations are pages of this platform rather than anyone's checkout.
 */
export const SIMULATED_WALLET_LABEL = '模拟'
/** What a first read of an account's simulated wallet grants, in whole credits (one credit is one CNY). */
export const SIMULATED_START_CREDITS = 200
/** At or below this many whole credits the allowance reads as low. */
export const SIMULATED_LOW_CREDITS = 20
/** The simulated recharge, membership, order and refund destinations — routes of the web app. */
export const SIMULATED_WALLET_PAGES = Object.freeze({
  recharge: '/app/account/simulated/recharge',
  membership: '/app/account/simulated/membership',
  orders: '/app/account/simulated/orders',
  refunds: '/app/account/simulated/refunds',
})
/** The only amounts a simulated top-up can be for, in whole credits. A closed list: the request names a package, never a number. */
export const SIMULATED_TOPUP_PACKAGES = Object.freeze([
  Object.freeze({ id: 'topup-50', credits: 50 }),
  Object.freeze({ id: 'topup-100', credits: 100 }),
  Object.freeze({ id: 'topup-200', credits: 200 }),
  Object.freeze({ id: 'topup-500', credits: 500 }),
])

/** An amount as the allowance page draws it (¥12.30), or '' when there is no amount to draw. @param {unknown} value */
function yuan(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? `¥${value.toFixed(2)}` : ''
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
 * @param {{ simulated?: boolean, balanceCny?: number | null, estimateCny?: number | null }} [refusal]
 *   amounts in CNY, as the allowance page shows them (a credit is one CNY)
 * @returns {string}
 */
export function allowanceRefusalSentence({ simulated = false, balanceCny = null, estimateCny = null } = {}) {
  const have = yuan(balanceCny)
  const need = yuan(estimateCny)
  const lead = simulated ? `${SIMULATED_WALLET_LABEL}额度不足，这次没有开始` : '科研额度不足，这次没有开始'
  const held = simulated ? `可用${SIMULATED_WALLET_LABEL}额度 ${have}` : `可用 ${have}`
  const amounts = have ? `：${held}${need ? `，这件事预计至少需要 ${need}` : ''}` : ''
  return `${lead}${amounts}。到“设置 → 科研额度”${simulated ? '做一次模拟充值' : '充值'}后即可继续。`
}

/**
 * What a programme step of 循证 GEO or 虚拟临研 waits on when the allowance
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
export const RESEARCH_BILLABLE_PURPOSES = Object.freeze(['kernel', 'engine', 'review', 'web-search']);

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
/** Immutable financial evidence includes every request once; estimates never become actual money.
 * @param {Array<{id:string,status:string,priced?:boolean,currency?:string,purpose?:string,actual_cost?:string|number|null,price_version?:string,billing_eligible?:boolean,not_billable_reason?:string}>} rows
 * @param {{owned?:boolean, mode?:string}} [options] */
export function researchTaskCharge(rows, { owned = true, mode = 'legacy-integer-floor' } = {}) {
  if (!['legacy-integer-floor', 'precision-v1'].includes(mode)) throw new RangeError('Unsupported wallet contract.');
  const seen = new Set();
  let actual = 0n;
  let billable = 0n;
  let overhead = 0n;
  let eligible = 0n;
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
    if (chargeable) billable += amount;
    evidence.push({ id: row.id, status: row.status, purpose: row.purpose ?? 'other', priceVersion: row.price_version ?? '', actualCny: confirmed ? researchMoneyDecimal(amount) : null, billable: chargeable, notBillableReason: row.not_billable_reason ?? (chargeable ? null : !confirmed ? 'provider_unconfirmed' : !RESEARCH_BILLABLE_PURPOSES.includes(String(row.purpose)) ? 'platform_overhead' : !owned ? 'task_waived' : null) });
  }
  const charged = mode === 'precision-v1' ? billable : billable / RESEARCH_MONEY_SCALE * RESEARCH_MONEY_SCALE;
  return { pricingVersion: RESEARCH_BILLING_VERSION, walletContract: mode, creditsPerCny: 1,
    actualCny: researchMoneyDecimal(actual), platformCostCny: researchMoneyDecimal(overhead), eligibleCny: researchMoneyDecimal(eligible), billableCny: researchMoneyDecimal(billable),
    chargedCny: researchMoneyDecimal(charged), creditsAmount: researchMoneyDecimal(charged),
    waivedCny: researchMoneyDecimal(eligible - charged), evidence };
}
