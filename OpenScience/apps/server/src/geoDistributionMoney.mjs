import { projectMoney } from './geoMarketStore.mjs';

/**
 * Read-only statement balances use the market's existing calculation. The caller supplies
 * chronological rows and the complete per-order sums preceding the page. A historical
 * budget must come from a budget-setting entry, never today's configuration.
 * @param {Array<{id:string,kind:string,amountCny:number,orderId:string|null,createdAt:string|null}>} entries
 * @param {{openingSums?:Array<{orderId:string|null,kind:string,amountCny:number}>,openingBudgetCny?:number|null}} [options]
 */
export function geoLedgerBalances(entries, { openingSums = [], openingBudgetCny = null } = {}) {
  /** @type {Map<string,{orderId:string|null,kind:string,amountCny:number}>} */
  const sums = new Map();
  /** @param {{orderId:string|null,kind:string,amountCny:number}} row */
  const append = row => {
    if (!['reserve', 'release', 'settle', 'refund'].includes(row.kind)) return;
    const key = JSON.stringify([row.orderId, row.kind]), previous = sums.get(key);
    sums.set(key, { orderId: row.orderId, kind: row.kind, amountCny: (previous?.amountCny ?? 0) + row.amountCny });
  };
  openingSums.forEach(append);
  let budget = openingBudgetCny;
  const balance = () => projectMoney({ budget: budget === null ? null : { totalCny: budget } }, [...sums.values()]);
  const opening = balance();
  return { opening, entries: entries.map(row => {
    if (row.kind === 'budget_set') budget = row.amountCny;
    append(row);
    return { ...row, balance: balance() };
  }) };
}
