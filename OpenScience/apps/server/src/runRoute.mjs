/**
 * How long a run is expected to take, in minutes (C3, 2026-09-18).
 *
 * The ledger records the route as a machine reason (`llm:0.87`, or `jev:0.87`
 * when the Jev routing site decided, `matched:named:meta-analysis`,
 * `unrouted:open-domain:classifier:timeout`), which is what operations and the
 * batch evaluations read and must keep reading. It used to be translated into a
 * Chinese sentence for the reader (「按问题内容交给…」, 「直接回答：…」); no screen
 * drew it, and why the platform routed a request as it did is the back office's
 * (owner ruling 2026-10-10), so the translation is gone. What stays here is the
 * estimate a researcher is told: how long the work they asked for usually takes.
 *
 * @module runRoute
 */

const answerAgentId = "open-domain-answer";

/**
 * The fallback table for a capability that declares no estimate (C3): an
 * answer, one deliverable, or a plan of several. Every registered capability
 * declares its own today; these exist so a new one without a number is shown
 * a plausible range rather than none.
 */
export const RUN_ESTIMATE_FALLBACKS = Object.freeze({
  answer: Object.freeze({ min: 1, max: 3 }),
  single: Object.freeze({ min: 10, max: 20 }),
  deep: Object.freeze({ min: 15, max: 40 }),
});

/** @param {unknown} value @returns {{ min: number, max: number } | null} */
export function normalizeRunEstimate(value) {
  const pair = Array.isArray(value) ? { min: value[0], max: value[1] }
    : value && typeof value === "object" ? /** @type {Record<string, any>} */ (value) : null;
  if (!pair) return null;
  const min = Number(pair.min);
  const max = Number(pair.max);
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 1 || max > 480 || min > max) return null;
  return { min, max };
}

/**
 * How long a run routed to `agent` should take, in minutes: the capability's
 * own display estimate, else its manifest's, else the fallback table.
 * @param {Record<string, any> | null | undefined} agent a registry entry
 * @returns {{ min: number, max: number } | null}
 */
export function runEstimate(agent) {
  if (!agent) return null;
  const declared = normalizeRunEstimate(agent.display?.estimatedMinutes) ?? normalizeRunEstimate(agent.estimatedMinutes);
  if (declared) return declared;
  if (agent.id === answerAgentId) return { ...RUN_ESTIMATE_FALLBACKS.answer };
  // Several contracts in one capability is a plan of several deliverables.
  return { ...(Array.isArray(agent.produces) && agent.produces.length > 1 ? RUN_ESTIMATE_FALLBACKS.deep : RUN_ESTIMATE_FALLBACKS.single) };
}
