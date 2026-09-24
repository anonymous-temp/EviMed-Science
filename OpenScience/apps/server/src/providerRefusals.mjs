/**
 * The refusals model providers answer before producing anything, counted by
 * provider and status for the operator — above all the one that says the
 * account can no longer pay.
 *
 * Hidden knowledge: from 11:49 to about 13:5x UTC on 2026-09-23 the DeepSeek
 * balance stood at −¥0.04 and DeepSeek answered every call 402. Every run, the
 * frontier feed, routing, titles and memory extraction failed; readiness
 * stayed green, because a provider's refusal is not the control plane's own
 * fault; and nothing alerted until the owner topped the account up. The
 * refusal was on the wire the whole time and nothing counted it by provider.
 *
 * Module-level on purpose: four clients in three modules reach three
 * providers — the model gateway and the control plane's own DeepSeek calls
 * (`modelGateway.mjs`), the reviewer on DashScope (`reviewModel.mjs`) and
 * Jev on TypeSafe (`jevModel.mjs`) — and they share no collaborator a count
 * could hang off. One process, one table, read by `/api/ops/metrics`.
 *
 * DashScope never answers 402: an account in arrears is 400 `Arrearage`
 * ("Access denied, please make sure your account is in good standing.",
 * help.aliyun.com/zh/model-studio/error-code, read 2026-09-24). It is counted
 * as the 402 it means, so one alert covers every provider; the metric's help
 * line says so.
 *
 * @module providerRefusals
 */

import { PROVIDER_REFUSAL_STATUSES } from "./usageLedger.mjs";

/** The providers the control plane calls a model at. */
export const MODEL_PROVIDERS = Object.freeze(["deepseek", "dashscope", "typesafe"]);

/** An exhausted balance, whatever the provider's own spelling of it. */
export const PAYMENT_REQUIRED = 402;

/**
 * provider → status → count. The 402 series exist from the start at zero: a
 * counter that springs into being at 1 shows no increase to `increase()`, and
 * the first refusal is the one the alert is for.
 * @type {Map<string, Map<number, number>>}
 */
const counts = new Map(MODEL_PROVIDERS.map((provider) => [provider, new Map([[PAYMENT_REQUIRED, 0]])]));

/**
 * Count one refusal. A status that is not a refusal before output (a 5xx, a
 * 408) is not counted here — the provider may have worked on it — and an
 * unknown provider is not counted at all, so the label set stays closed.
 * @param {string} provider one of `MODEL_PROVIDERS`
 * @param {number} status the HTTP status it answered
 * @returns {boolean} whether it was counted
 */
export function recordProviderRefusal(provider, status) {
  const byStatus = counts.get(String(provider));
  const code = Number(status);
  if (!byStatus || !PROVIDER_REFUSAL_STATUSES.includes(code)) return false;
  byStatus.set(code, (byStatus.get(code) ?? 0) + 1);
  return true;
}

/** @param {string} provider @param {number} status */
export function providerRefusalCount(provider, status) {
  return counts.get(String(provider))?.get(Number(status)) ?? 0;
}

/**
 * The counts as the operator's metric family.
 * @returns {{ name: string, help: string, type: "counter", series: Array<{ value: number, labels: Record<string, string> }> }}
 */
export function providerRefusalMetricFamily() {
  return {
    name: "open_science_model_provider_refusals_total",
    help: "Refusals a model provider answered before any output, by provider and HTTP status. 402 is an exhausted balance: every call to that provider fails until it is topped up. DashScope's own answer for an account in arrears, 400 Arrearage, is counted as 402.",
    type: "counter",
    series: [...counts].flatMap(([provider, byStatus]) => [...byStatus]
      .sort(([left], [right]) => left - right)
      .map(([status, value]) => ({ value, labels: { provider, status: String(status) } }))),
  };
}
