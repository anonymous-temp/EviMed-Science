/** Research allowance pricing is money, never a token denomination. */
export const RESEARCH_BILLING_VERSION = 'research-allowance-v1-20261003';
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
