/**
 * Whether a campaign is directional (2026-11-02): its confirmation has fewer independent groups than the registered procedure's
 * minimum, in the whole family or, for a claim that has one (targeted-repair), in its failure slice, so the procedure refuses to give
 * a verdict (`sparse population`) whatever the arms scored. Decided from the registered counts alone, never from the refusal's wording.
 * Such a campaign cannot be qualified: it draws no error budget and opens its corpus as a directional one (`confirmationDecision`,
 * campaign_runner.mjs), and its report says 方向性参考. A frontier-selection campaign (superiority, no slice; 2026-11-03) is directional
 * with fewer measured confirmation days than the minimum, none at all included (a month whose confirmation days all lack enough labels
 * registers zero groups: it reserves no alpha either, and its report reads 确认期可测 0 天).
 *
 * @param {any} statistics the registration's `statistics` block (groups with `failure_slice`, `claims`, `procedure.minimum_slice_groups`)
 * @returns {{ groups: number, sliceGroups: number | null, minimum: number } | null} the counts when directional (`sliceGroups` null for a claim without a slice), null otherwise
 */
export function directionalCounts(statistics) {
  const minimum = statistics?.procedure?.minimum_slice_groups;
  if (!Number.isFinite(minimum) || !Array.isArray(statistics?.groups)) return null;
  const sliced = Object.hasOwn(statistics.claims ?? {}, 'targeted-repair');
  const groups = statistics.groups.length, sliceGroups = sliced ? statistics.groups.filter((group) => group?.failure_slice === true).length : null;
  return groups < minimum || (sliced && sliceGroups < minimum) ? { groups, sliceGroups, minimum } : null;
}
