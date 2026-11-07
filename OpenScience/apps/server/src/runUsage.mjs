/** The ids a run's model calls may be booked under: its own, and the dispatch id a bounded runtime stamps on them.
 * @param {any} run @returns {string[]} */
export function runUsageKeys(run) {
  return [...new Set([run?.id, run?.dispatchId].filter(value => typeof value === "string" && value.length > 0))];
}

/** @param {any} run @param {string|null} scope */
export function runOwnsRuntimeScope(run, scope) {
  return Boolean(scope) && run?.dispatchId === scope;
}
