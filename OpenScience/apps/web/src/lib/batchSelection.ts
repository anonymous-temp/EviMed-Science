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
export async function runBatch<T>(ids: readonly string[], operation: (id: string) => Promise<T>): Promise<{ succeeded: { id: string; value: T }[]; failed: { id: string; error: unknown }[] }> {
 const stable = [...new Set(ids)];
 const outcomes = await Promise.allSettled(stable.map(id => Promise.resolve().then(() => operation(id))));
 const succeeded: { id: string; value: T }[] = []; const failed: { id: string; error: unknown }[] = [];
 outcomes.forEach((outcome, index) => { if (outcome.status === "fulfilled") succeeded.push({ id: stable[index], value: outcome.value }); else failed.push({ id: stable[index], error: outcome.reason }); });
 return { succeeded, failed };
}
