/**
 * Whether a campaign is directional (2026-11-02): its confirmation has fewer independent groups than the registered procedure's
 * minimum, in the whole family or in its failure slice, so the procedure refuses to give a verdict (`sparse population`) whatever
 * the arms scored. Decided from the registered counts alone, never from the refusal's wording. Such a campaign cannot be qualified:
 * it draws no error budget and opens its corpus as a directional one (`confirmationDecision`, campaign_runner.mjs), and its report
 * says 方向性参考.
 *
 * @param {any} statistics the registration's `statistics` block (groups with `failure_slice`, `procedure.minimum_slice_groups`)
 * @returns {{ groups: number, sliceGroups: number, minimum: number } | null} the counts when directional, null otherwise
 */
export function directionalCounts(statistics) {
  const minimum = statistics?.procedure?.minimum_slice_groups;
  if (!Number.isFinite(minimum) || !Array.isArray(statistics?.groups) || !statistics.groups.length) return null;
  const groups = statistics.groups.length, sliceGroups = statistics.groups.filter((group) => group?.failure_slice === true).length;
  return groups < minimum || sliceGroups < minimum ? { groups, sliceGroups, minimum } : null;
}
