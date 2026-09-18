/**
 * Why a run went where it went, and roughly how long it will take — both in
 * the reader's words (C3, 2026-09-18).
 *
 * The ledger records a route as a machine reason (`llm:0.87`,
 * `matched:named:meta-analysis`, `unrouted:open-domain:classifier:timeout`),
 * which is what operations and the batch evaluations read and must keep
 * reading. A researcher was shown nothing at all: the answer line and the
 * report line look the same from the composer, and a question that went to a
 * forty-minute pipeline gave no sign it would (2026-09-18 review, E §5.3).
 * This translates the closed vocabulary the router itself mints — a format,
 * not language (principle 1) — and returns nothing for a reason it does not
 * know rather than a guess.
 *
 * @module runRoute
 */

import { capabilityTitle } from "@evimed/domain";

const answerAgentId = "open-domain-answer";

/** @param {string | null | undefined} id */
function named(id) {
  const title = capabilityTitle(id);
  return title ? `「${title}」` : "对应的能力";
}

/**
 * The route, as one Chinese sentence, or null when the reason is not one the
 * router mints.
 * @param {string | null | undefined} reason the ledger's `effectiveRouteReason`
 * @param {string | null | undefined} agentId the ledger's `effectiveAgentId`
 * @returns {string | null}
 */
export function routeReasonText(reason, agentId) {
  let rest = typeof reason === "string" ? reason : "";
  if (!rest) return null;
  // Said last, because it qualifies whatever the route was: the model that
  // decides routes gave no answer, so the rules decided.
  let fallback = "";
  const classifier = /:classifier:[a-z0-9_.-]+$/.exec(rest);
  if (classifier) {
    rest = rest.slice(0, classifier.index);
    fallback = "（路由判断没有给出结论，按规则处理）";
  }
  let adopted = "";
  if (rest.startsWith("adopted:runtime-ui")) {
    adopted = "来自对话窗口";
    rest = rest.slice("adopted:runtime-ui".length).replace(/^:/, "");
    if (!rest) return `${adopted}${fallback}`;
  }
  let sentence = null;
  if (rest === "session-binding") sentence = `按这个对话选定的能力${named(agentId)}运行`;
  else if (rest === "unrouted:open-domain") sentence = "直接回答：这个问题不需要交付报告";
  else if (/^llm:(?:0|1)(?:\.\d+)?$/.test(rest)) sentence = `按问题内容交给${named(agentId)}`;
  else if (rest.startsWith("matched:named:")) sentence = `你在问题里点名了${named(agentId)}`;
  else if (rest === "matched:clinical-evidence-synthesis:safety-medicine") sentence = `问题提到了需要核对用药安全的药品，交给${named(agentId)}`;
  else if (rest.startsWith("matched:")) sentence = `按问题里的交付要求交给${named(agentId)}`;
  else if (rest.startsWith("autopilot:")) sentence = "主动科研任务";
  if (!sentence) return adopted ? `${adopted}${fallback}` : null;
  return `${adopted ? `${adopted}，` : ""}${sentence}${fallback}`;
}

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
