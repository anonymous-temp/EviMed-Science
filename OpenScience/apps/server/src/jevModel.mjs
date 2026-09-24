/**
 * TypeSafe's Jev, called by the control plane: typed questions over a text
 * state, answered with probabilities, metered.
 *
 * Hidden knowledge: what the wire does that its documentation does not say,
 * recorded off the live endpoint (`packages/contracts/typesafe/fixtures`):
 *
 * - a request with no key is 403 and one with a key TypeSafe does not hold is
 *   401, both `authentication_error` (the documentation lists only the 401);
 *   a malformed request is 400 `api_usage_error` "Invalid request." naming no
 *   field, not the documented 422; an unknown model id is the same 400 naming
 *   the model — so a pinned version that is withdrawn fails closed, by name,
 *   instead of being served by whatever `jev-latest` is;
 * - no rate-limit headers and no request id: there is nothing to honour and
 *   nothing to log beside the status;
 * - `usage.input_tokens` is what is billed ($0.042 per million), output is
 *   free; one request holds at most 64k tokens, and the state plus its
 *   longest question at most 32k (docs.typesafe.ai/models, 2026-09-24);
 * - a choice's `confidence` is (k·p_max − 1)/(k − 1) over its own k options
 *   (docs.typesafe.ai/confidence), the number a caller's gate reads.
 *
 * The model is the pin (`typesafe.review.model` in deps-version.json), never
 * an alias: confidence thresholds are calibrated per version, and the answer
 * names the version that produced it — an answer from any other version is
 * discarded (`jev_model_mismatch`), after its tokens are booked.
 *
 * Same ledger discipline as every metered call (reviewModel.mjs): reserve
 * before, settle on the provider's own count, release a request that never
 * left or that was refused outright, mark uncertain one that was sent and
 * lost (`closeUnsettledReservation`). One retry, after a pause, for a failure
 * that is transient by its nature (429, 5xx, a dropped connection); a timeout
 * or a refusal would fail the same way again. The key never reaches a
 * runtime, a log line or an error message: every message here is written from
 * a status and a code, never from what the provider sent back.
 *
 * @module jevModel
 */

import { createHash, randomUUID } from "node:crypto";
import { REFERENCE_PRICE_LIST, isPeak, priceUsage } from "@evimed/domain";
import { estimatePromptTokens } from "./modelGateway.mjs";
import { recordProviderRefusal } from "./providerRefusals.mjs";
import { closeUnsettledReservation } from "./usageLedger.mjs";

/**
 * Input tokens a request costs before any state: Jev's own framing of the
 * question. Measured 2026-09-21: an empty state and one five-word question
 * billed 271.
 */
const REQUEST_OVERHEAD_TOKENS = 300;

/** The pause before the one retry of a transient failure. */
export const JEV_RETRY_DELAY_MS = 2_000;

/** Bytes one answer may take; a real one is a few kilobytes. */
const MAX_ANSWER_BYTES = 4 * 1024 * 1024;

/**
 * Network failures that happen before a request is on the wire: the name did
 * not resolve, nobody answered, the connection or its handshake never
 * completed. Such a request cannot have been billed. Anything else a fetch
 * throws — a reset, a closed socket, our own deadline — may have come after
 * the request was sent.
 */
const NEVER_SENT = /^(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ENETDOWN|EHOSTDOWN|UND_ERR_CONNECT_TIMEOUT|ERR_TLS_\w+|CERT_\w+|UNABLE_TO_\w+|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|ERR_SSL_\w+)$/;

/** A failure with a code the caller can report and count. */
export class JevError extends Error {
  /** @param {string} code @param {string} message @param {{ status?: number, retryable?: boolean }} [extra] */
  constructor(code, message, { status = 0, retryable = false } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * What a request will be billed, from above: the state and every question at
 * the gateway's conservative token estimate, plus Jev's own framing. Two
 * numbers, because the provider holds two ceilings.
 * @param {unknown} state @param {Record<string, unknown>} questions
 * @returns {{ total: number, stateAndLongestQuestion: number }}
 */
export function estimateJevTokens(state, questions) {
  const stateTokens = estimatePromptTokens(typeof state === "string" ? state : JSON.stringify(state ?? ""));
  const questionTokens = Object.values(questions ?? {}).map((question) => estimatePromptTokens(JSON.stringify(question)));
  const all = questionTokens.reduce((sum, tokens) => sum + tokens, 0);
  return {
    total: REQUEST_OVERHEAD_TOKENS + stateTokens + all,
    stateAndLongestQuestion: REQUEST_OVERHEAD_TOKENS + stateTokens + Math.max(0, ...questionTokens),
  };
}

/** The provider's error type, when it is a plain identifier. @param {string} text */
function errorType(text) {
  try {
    const type = String(JSON.parse(text)?.detail?.error_type ?? "");
    return /^[a-z_]{1,40}$/.test(type) ? type : "";
  } catch {
    return "";
  }
}

/**
 * The failure an error status stands for. The unknown-model 400 is told from
 * any other 400 by the provider's own words, and only that is read of them.
 * @param {number} status @param {string} text the answer's body
 * @param {string} model the pinned id
 */
function refusal(status, text, model) {
  const type = errorType(text);
  if (status === 401 || status === 403) return new JevError("jev_auth_failed", `Jev refused the key (HTTP ${status}${type ? ` ${type}` : ""}).`, { status });
  if (status === 400 && /unknown model/i.test(text)) return new JevError("jev_model_unknown", `Jev does not know the pinned model ${model} (HTTP 400).`, { status });
  if (status === 400 || status === 422) return new JevError("jev_request_invalid", `Jev refused the request (HTTP ${status}${type ? ` ${type}` : ""}).`, { status });
  if (status === 402) return new JevError("jev_payment_required", "Jev refused the request for payment (HTTP 402).", { status });
  if (status === 413) return new JevError("jev_request_too_large", "Jev refused the request as too large (HTTP 413).", { status });
  if (status === 429) return new JevError("jev_rate_limited", "Jev is rate limited (HTTP 429).", { status, retryable: true });
  if (status >= 500) return new JevError("jev_upstream_error", `Jev's provider returned HTTP ${status}.`, { status, retryable: true });
  return new JevError("jev_request_refused", `Jev refused the request (HTTP ${status}).`, { status });
}

/** The network's own code for a failed request, for the operator: a code, never a URL. @param {any} error */
function networkCause(error) {
  const code = String(error?.cause?.code ?? error?.code ?? error?.cause?.name ?? error?.name ?? "unknown");
  return /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : "unknown";
}

/**
 * An answer's body, up to a bound.
 * @param {Response} response @returns {Promise<string>}
 */
async function boundedText(response) {
  if (!response.body) return "";
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for await (const chunk of /** @type {any} */ (response.body)) {
    bytes += chunk.byteLength;
    if (bytes > MAX_ANSWER_BYTES) throw new JevError("jev_response_invalid", "Jev's answer was too long.");
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * Ask Jev once, with one retry for a transient failure.
 *
 * @param {{ config: Record<string, any>, usageLedger?: any, fetchImpl?: typeof fetch, retryDelayMs?: number }} deps
 * @param {{
 *   userId: string, projectId: string, runId?: string | null, purpose?: string,
 *   state: unknown, questions: Record<string, unknown>,
 *   timeoutMs?: number, signal?: AbortSignal, at?: Date,
 * }} call
 * @returns {Promise<{ answers: Record<string, any>, model: string, usage: { inputTokens: number, outputTokens: number }, cost: number, priced: boolean, ms: number, attempts: number }>}
 */
export async function callJev({ config, usageLedger = null, fetchImpl = fetch, retryDelayMs = JEV_RETRY_DELAY_MS }, call) {
  const apiKey = String(config.typesafeApiKey ?? "");
  if (!apiKey) throw new JevError("jev_unconfigured", "No TypeSafe key is configured.");
  const model = String(config.reviewJevModel ?? "");
  const apiBase = String(config.reviewJevApiBase ?? "").replace(/\/+$/, "");
  if (!model || !apiBase) throw new JevError("jev_unconfigured", "No Jev model or endpoint is pinned.");
  const size = estimateJevTokens(call.state, call.questions);
  const maxRequest = Number(config.reviewJevMaxRequestTokens) || 64_000;
  const maxState = Number(config.reviewJevMaxStateTokens) || 32_000;
  if (size.total > maxRequest || size.stateAndLongestQuestion > maxState) {
    throw new JevError("jev_request_too_large", `The request is estimated at ${size.total} tokens (state and longest question ${size.stateAndLongestQuestion}); Jev takes ${maxRequest} (${maxState}).`);
  }
  const once = () => askOnce({ config, usageLedger, fetchImpl }, { ...call, apiKey, model, apiBase, estimatedTokens: size.total });
  try {
    return { ...(await once()), attempts: 1 };
  } catch (error) {
    if (!(error instanceof JevError) || !error.retryable || call.signal?.aborted) throw error;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(retryDelayMs) || 0)));
    return { ...(await once()), attempts: 2 };
  }
}

/**
 * One metered request.
 * @param {{ config: Record<string, any>, usageLedger: any, fetchImpl: typeof fetch }} deps
 * @param {Record<string, any>} call
 */
async function askOnce({ config, usageLedger, fetchImpl }, call) {
  const at = call.at ?? new Date();
  const payload = JSON.stringify({ model: call.model, state: call.state, questions: call.questions });
  if (config.requireDurableUsageLedger === true && !usageLedger) {
    throw new JevError("usage_ledger_unavailable", "Durable usage accounting is unavailable.");
  }
  let reservation = null;
  if (usageLedger) {
    // Output is free, so the ceiling is the input estimate at the input rate.
    const estimate = priceUsage({ resourceType: "model", model: call.model, cacheMiss: call.estimatedTokens, output: 0, peak: isPeak(at) });
    reservation = await usageLedger.reserveModel({
      id: randomUUID(), userId: call.userId, projectId: call.projectId, model: call.model,
      runId: call.runId ?? null, purpose: call.purpose ?? "review",
      priceVersion: REFERENCE_PRICE_LIST.version, currency: estimate.currency || "CNY",
      requestFingerprint: createHash("sha256").update(payload).digest("hex"),
      estimatedCost: estimate.cost,
      dailyLimit: Number(config.userDailySpendLimit) || 0,
      weeklyLimit: Number(config.userWeeklySpendLimit) || 0,
      runLimit: 0,
      now: at,
    });
  }
  const controller = new AbortController();
  const timeoutMs = Math.max(1_000, Number(call.timeoutMs ?? config.reviewJevTimeoutMs ?? 15_000));
  const deadline = setTimeout(() => controller.abort(new JevError("jev_timeout", `Jev did not answer within ${Math.round(timeoutMs / 1000)} s.`)), timeoutMs);
  const onOuterAbort = () => controller.abort(call.signal?.reason ?? new JevError("jev_cancelled", "The Jev request was cancelled."));
  call.signal?.addEventListener?.("abort", onOuterAbort, { once: true });
  const started = Date.now();
  // Sent unless the network says it never left (NEVER_SENT): a deadline that
  // fires while the answer is awaited has a request on the wire.
  let dispatched = true;
  let refusedStatus = 0;
  try {
    let response;
    let text;
    try {
      response = await fetchImpl(`${call.apiBase}/systemone`, {
        method: "POST",
        headers: { accept: "application/json", authorization: `Bearer ${call.apiKey}`, "content-type": "application/json" },
        body: payload,
        signal: controller.signal,
      });
      // The status line is the refusal: a body lost after it changes nothing.
      if (!response.ok) {
        refusedStatus = response.status;
        recordProviderRefusal("typesafe", response.status);
      }
      text = await boundedText(response);
    } catch (error) {
      if (error instanceof JevError) throw error;
      if (controller.signal.aborted && controller.signal.reason instanceof JevError) throw controller.signal.reason;
      const cause = networkCause(error);
      if (!response && NEVER_SENT.test(cause)) dispatched = false;
      throw new JevError("jev_unreachable", `Jev could not be reached (${cause}).`, { retryable: !refusedStatus });
    }
    if (!response.ok) throw refusal(response.status, text, call.model);
    /** @type {any} */
    let body = null;
    try { body = JSON.parse(text); } catch { body = null; }
    const inputTokens = Number(body?.usage?.input_tokens);
    const outputTokens = Number(body?.usage?.output_tokens) || 0;
    const price = priceUsage({ resourceType: "model", model: call.model, cacheMiss: Number.isFinite(inputTokens) ? inputTokens : 0, output: outputTokens, peak: isPeak(at) });
    // Booked before the answer is judged: whatever it says, it was billed.
    if (usageLedger && reservation) {
      if (Number.isFinite(inputTokens) && inputTokens >= 0) {
        await usageLedger.settleModel(call.userId, reservation.id, {
          usage: { cacheHitTokens: 0, cacheMissTokens: inputTokens, completionTokens: outputTokens },
          actualCost: price.cost, priced: price.priced, providerRequestId: null,
        });
      } else {
        await usageLedger.markUncertain(call.userId, reservation.id, "response_usage_missing", {});
      }
      reservation = null;
    }
    if (!body || typeof body.answers !== "object" || body.answers === null || Array.isArray(body.answers)) {
      throw new JevError("jev_response_invalid", "Jev's answer was not the shape the API documents.");
    }
    // Thresholds are a version's: an answer from another one is not used.
    if (String(body.model ?? "") !== call.model) {
      throw new JevError("jev_model_mismatch", `Jev answered as another model than the pinned ${call.model}.`);
    }
    return {
      answers: body.answers, model: call.model,
      usage: { inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0, outputTokens },
      cost: price.cost, priced: price.priced, ms: Date.now() - started,
    };
  } finally {
    clearTimeout(deadline);
    call.signal?.removeEventListener?.("abort", onOuterAbort);
    if (usageLedger && reservation) {
      try {
        await closeUnsettledReservation(usageLedger, call.userId, reservation.id, { dispatched, status: refusedStatus });
      } catch {
        process.stderr.write("usage ledger terminal transition failed; reservation requires reconciliation\n");
      }
    }
  }
}
