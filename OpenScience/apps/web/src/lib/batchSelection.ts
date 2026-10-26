/** Stable IDs belong to a frozen explicit scope; sorting never changes it. */
export interface BatchSelection { scope: string; ids: readonly string[] }
export function toggleBatch(selection: BatchSelection, scope: string, id: string): BatchSelection {
 const ids = selection.scope === scope ? selection.ids : [];
 return { scope, ids: ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id] };
}
export function batchPageState(ids: readonly string[], page: readonly string[]): { checked: boolean; mixed: boolean } {
 const count = page.filter(id => ids.includes(id)).length;
 return { checked: page.length > 0 && count === page.length, mixed: count > 0 && count < page.length };
}
/** How many of a batch's requests are in flight at once: a page's worth fired together invites rate limits and half-done batches. */
export const BATCH_CONCURRENCY = 4;

/**
 * Run `operation` once for each distinct id, at most `BATCH_CONCURRENCY` at a time, in the order given. One failure never stops the
 * rest; the outcome keeps each id's value or error in that order, so a retry is the failed ids alone.
 */
export async function runBatch<T>(ids: readonly string[], operation: (id: string) => Promise<T>, concurrency = BATCH_CONCURRENCY): Promise<{ succeeded: { id: string; value: T }[]; failed: { id: string; error: unknown }[] }> {
 const stable = [...new Set(ids)];
 const outcomes: PromiseSettledResult<T>[] = new Array(stable.length);
 let next = 0;
 const lane = async () => {
  for (let index = next++; index < stable.length; index = next++) {
   outcomes[index] = await Promise.resolve().then(() => operation(stable[index])).then(
    (value): PromiseFulfilledResult<T> => ({ status: "fulfilled", value }),
    (reason): PromiseRejectedResult => ({ status: "rejected", reason }),
   );
  }
 };
 await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, stable.length)) }, lane));
 const succeeded: { id: string; value: T }[] = []; const failed: { id: string; error: unknown }[] = [];
 outcomes.forEach((outcome, index) => { if (outcome.status === "fulfilled") succeeded.push({ id: stable[index], value: outcome.value }); else failed.push({ id: stable[index], error: outcome.reason }); });
 return { succeeded, failed };
}
