import { autopilotLogicalDispatchId, isUnsentAutopilotLeaseLoss, verificationEpisodeId } from "./autopilotService.mjs";

/** A reserved verifier or a control-plane episode may own a logical budget.
 * Ordinary caller-chosen dispatch IDs never establish that ownership.
 * @param {any} run @returns {string|null} */
export function autopilotUsageScope(run) {
  const logical = autopilotLogicalDispatchId(run?.dispatchId);
  return logical && (String(run?.effectiveRouteReason ?? "").startsWith("autopilot:")
    || verificationEpisodeId(logical)) ? logical : null;
}

/** A rejected pre-prompt attempt keeps its physical work, never a sibling's spend.
 * Learning/source attempts retain literal IDs; only autopilot shares a budget.
 * @param {any} run @returns {string[]} */
export function runUsageKeys(run) {
  const logical = autopilotUsageScope(run);
  const keys = logical && isUnsentAutopilotLeaseLoss(run)
    ? [run?.id] : [run?.id, run?.dispatchId, logical];
  return [...new Set(keys.filter(value => typeof value === "string" && value.length > 0))];
}

/** @param {any} run @param {string|null} scope */
export function runOwnsRuntimeScope(run, scope) {
  return Boolean(scope) && !(autopilotUsageScope(run) && isUnsentAutopilotLeaseLoss(run))
    && (run?.dispatchId === scope || autopilotUsageScope(run) === scope);
}
