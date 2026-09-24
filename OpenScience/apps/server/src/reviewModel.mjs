/**
 * The independent reviewer's model call: Qwen3.8-Max on DashScope, metered.
 *
 * Hidden knowledge: why this is not `callModelForControlPlane`. That function
 * is the DeepSeek boundary — its model allow-list, its upstream URL and its
 * usage fields (`prompt_cache_hit_tokens`) are DeepSeek's, and its body is
 * non-streaming. The reviewer is a different family on purpose (a reviewer of
 * the generator's own family false-rejects its correct answers and adds
 * nothing; a stronger cross-family one adds twelve points — plan §1), so it is
 * a different provider, and three things differ on the wire (recorded
 * 2026-09-23, `packages/contracts/dashscope/fixtures`):
 *
 * - cached prompt tokens are `usage.prompt_tokens_details.cached_tokens`, and
 *   reasoning tokens are already inside `completion_tokens`;
 * - thinking is on unless `enable_thinking: false`, and `thinking_budget`
 *   bounds it;
 * - an editor pass thinks for minutes, and a non-streaming request holds no
 *   byte on the connection for that long. So this streams, and treats a quiet
 *   connection — no chunk for `IDLE_MS` — as the failure it is.
 *
 * Same ledger discipline as every metered call: reserve before, settle on the
 * provider's own count, release one that never left or that the provider
 * refused outright (a 4xx before any output), mark uncertain one that was sent
 * and lost (`closeUnsettledReservation`). Purpose `review`, charged to the run
 * reviewed.
 * The key is the operator's DashScope key, the same file the reranker and the
 * embedder read; it never reaches a runtime.
 *
 * @module reviewModel
 */

import { createHash, randomUUID } from "node:crypto";
import { REFERENCE_PRICE_LIST, isPeak, priceUsage } from "@evimed/domain";
import { estimateModelReservation } from "./modelGateway.mjs";
import { closeUnsettledReservation } from "./usageLedger.mjs";

/** A stream that says nothing for this long has stalled. */
const IDLE_MS = 120_000;

/** Answer bytes one call may return; far above any honest review. */
const MAX_ANSWER_CHARS = 2_000_000;

/** A failure with a code the caller can report and count. */
export class ReviewModelError extends Error {
  /** @param {string} code @param {string} message @param {{ status?: number, retryable?: boolean }} [extra] */
  constructor(code, message, { status = 0, retryable = false } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * What the network said when a request never got an answer — `ECONNRESET`,
 * `ENOTFOUND`, `UND_ERR_CONNECT_TIMEOUT` — for the operator's log; an error
 * code, never a URL or a header.
 * @param {any} error
 */
function networkCause(error) {
  const code = String(error?.cause?.code ?? error?.code ?? error?.cause?.name ?? error?.name ?? "unknown");
  return /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : "unknown";
}

/** @param {number} status @param {string} providerCode */
function failureFor(status, providerCode) {
  if (status === 401 || status === 403) return new ReviewModelError("review_model_auth_failed", "The reviewer's key was refused.", { status });
  if (status === 404 || providerCode === "model_not_found") return new ReviewModelError("review_model_unavailable", "The reviewer model is not available to this account.", { status });
  if (status === 429) return new ReviewModelError("review_model_rate_limited", "The reviewer model is rate limited.", { status, retryable: true });
  if (status === 400) return new ReviewModelError("review_model_request_invalid", `The reviewer refused the request (${providerCode || "bad request"}).`, { status });
  return new ReviewModelError("review_model_upstream_error", `The reviewer's provider returned HTTP ${status}.`, { status, retryable: status >= 500 });
}

/**
 * One review call.
 *
 * @param {{ config: Record<string, any>, usageLedger?: any, fetchImpl?: typeof fetch }} deps
 * @param {{
 *   userId: string, projectId: string, runId?: string | null,
 *   messages: { role: 'system'|'user'|'assistant', content: string }[],
 *   schema: Record<string, any>, schemaName: string,
 *   thinking?: { enabled: boolean, budget?: number },
 *   maxTokens?: number, timeoutMs?: number, signal?: AbortSignal, at?: Date,
 * }} call
 * @returns {Promise<{ value: any, model: string, usage: { cacheHitTokens: number, cacheMissTokens: number, completionTokens: number, reasoningTokens: number }, cost: number, requestId: string | null, reasoningChars: number }>}
 */
export async function callReviewModel({ config, usageLedger = null, fetchImpl = fetch }, call) {
  const apiKey = String(config.dashscopeApiKey ?? "");
  if (!apiKey) throw new ReviewModelError("review_model_unconfigured", "No DashScope key is configured for the reviewer.");
  const at = call.at ?? new Date();
  const thinking = call.thinking ?? { enabled: false };
  const body = {
    model: String(config.reviewModel),
    messages: call.messages,
    stream: true,
    stream_options: { include_usage: true },
    enable_thinking: Boolean(thinking.enabled),
    ...(thinking.enabled && Number(thinking.budget) > 0 ? { thinking_budget: Math.floor(Number(thinking.budget)) } : {}),
    max_tokens: Math.floor(Number(call.maxTokens ?? config.reviewMaxOutputTokens ?? 16_000)),
    response_format: { type: "json_schema", json_schema: { name: call.schemaName, strict: true, schema: call.schema } },
  };
  if (config.requireDurableUsageLedger === true && !usageLedger) {
    throw new ReviewModelError("usage_ledger_unavailable", "Durable usage accounting is unavailable.");
  }
  let reservation = null;
  if (usageLedger) {
    // The estimate counts the thinking budget as output: reasoning bills as
    // completion tokens, and a reservation below the ceiling is not a ceiling.
    const estimate = estimateModelReservation({ ...body, max_tokens: body.max_tokens + (body.thinking_budget ?? 0) }, config, at);
    reservation = await usageLedger.reserveModel({
      id: randomUUID(), userId: call.userId, projectId: call.projectId, model: body.model,
      runId: call.runId ?? null, purpose: "review",
      priceVersion: REFERENCE_PRICE_LIST.version, currency: estimate.currency || "CNY",
      requestFingerprint: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
      estimatedCost: estimate.cost,
      dailyLimit: Number(config.userDailySpendLimit) || 0,
      weeklyLimit: Number(config.userWeeklySpendLimit) || 0,
      runLimit: 0,
      now: at,
    });
  }

  const controller = new AbortController();
  const timeoutMs = Math.max(1_000, Number(call.timeoutMs ?? config.reviewEditorTimeoutMs ?? 900_000));
  const deadline = setTimeout(() => controller.abort(new ReviewModelError("review_model_timeout", `The reviewer did not finish within ${Math.round(timeoutMs / 1000)} s.`)), timeoutMs);
  /** @type {ReturnType<typeof setTimeout> | null} */
  let idle = null;
  const quiet = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => controller.abort(new ReviewModelError("review_model_stalled", `The reviewer's stream was silent for ${IDLE_MS / 1000} s.`)), IDLE_MS);
  };
  const onOuterAbort = () => controller.abort(call.signal?.reason ?? new ReviewModelError("review_cancelled", "The review was cancelled."));
  call.signal?.addEventListener?.("abort", onOuterAbort, { once: true });
  let dispatched = false;
  /** The status of an answer that came back without output, 0 while none has. */
  let refusedStatus = 0;
  try {
    let response;
    try {
      quiet();
      response = await fetchImpl(`${String(config.reviewApiBase).replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { accept: "text/event-stream", authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw controller.signal.aborted && controller.signal.reason instanceof ReviewModelError
        ? controller.signal.reason
        : new ReviewModelError("review_model_unreachable", `The reviewer's provider could not be reached (${networkCause(error)}).`, { retryable: true });
    }
    dispatched = true;
    if (!response.ok) {
      refusedStatus = response.status;
      let providerCode = "";
      try {
        const payload = JSON.parse(await response.text());
        providerCode = String(payload?.error?.code ?? payload?.code ?? "");
      } catch {
        providerCode = "";
      }
      throw failureFor(response.status, providerCode);
    }
    let content = "";
    let reasoningChars = 0;
    /** Why the provider stopped: `stop`, or `length` at the output ceiling. @type {string | null} */
    let finish = null;
    /** @type {any} */
    let usage = null;
    let model = body.model;
    /** @type {string | null} */
    let requestId = null;
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of /** @type {any} */ (response.body)) {
        quiet();
        buffer += decoder.decode(chunk, { stream: true });
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let event;
          try { event = JSON.parse(data); } catch { continue; }
          if (event?.error) throw failureFor(Number(event.error?.status ?? 500), String(event.error?.code ?? ""));
          if (event?.id && !requestId) requestId = String(event.id).slice(0, 200);
          if (event?.model) model = String(event.model);
          if (event?.usage) usage = event.usage;
          if (event?.choices?.[0]?.finish_reason) finish = String(event.choices[0].finish_reason);
          const delta = event?.choices?.[0]?.delta ?? {};
          if (typeof delta.content === "string") content += delta.content;
          if (typeof delta.reasoning_content === "string") reasoningChars += delta.reasoning_content.length;
          if (content.length > MAX_ANSWER_CHARS) throw new ReviewModelError("review_model_response_invalid", "The reviewer's answer was too long.");
        }
      }
    } catch (error) {
      if (error instanceof ReviewModelError) throw error;
      throw controller.signal.aborted && controller.signal.reason instanceof ReviewModelError
        ? controller.signal.reason
        : new ReviewModelError("review_model_stream_broken", "The reviewer's stream broke off.", { retryable: true });
    }
    const counted = {
      cacheHitTokens: Number(usage?.prompt_tokens_details?.cached_tokens) || 0,
      cacheMissTokens: Math.max(0, (Number(usage?.prompt_tokens) || 0) - (Number(usage?.prompt_tokens_details?.cached_tokens) || 0)),
      completionTokens: Number(usage?.completion_tokens) || 0,
      reasoningTokens: Number(usage?.completion_tokens_details?.reasoning_tokens) || 0,
    };
    const price = priceUsage({
      resourceType: "model", model, cacheHit: counted.cacheHitTokens, cacheMiss: counted.cacheMissTokens,
      output: counted.completionTokens, peak: isPeak(at),
    });
    if (usageLedger && reservation) {
      if (Number.isFinite(Number(usage?.completion_tokens))) {
        await usageLedger.settleModel(call.userId, reservation.id, {
          usage: { cacheHitTokens: counted.cacheHitTokens, cacheMissTokens: counted.cacheMissTokens, completionTokens: counted.completionTokens },
          actualCost: price.cost, priced: price.priced, providerRequestId: requestId,
        });
      } else {
        await usageLedger.markUncertain(call.userId, reservation.id, "response_usage_missing", { providerRequestId: requestId });
      }
      reservation = null;
    }
    let value;
    try {
      value = JSON.parse(content);
    } catch {
      // Cut off at the ceiling is not malformed: it says the ceiling is where
      // to look, and the provider billed every token of it.
      if (finish === "length") throw new ReviewModelError("review_model_truncated", `The reviewer's answer reached its ${body.max_tokens}-token ceiling before it closed.`);
      throw new ReviewModelError("review_model_response_invalid", "The reviewer's answer was not the JSON its schema requires.");
    }
    return { value, model, usage: counted, cost: price.cost, requestId, reasoningChars };
  } finally {
    clearTimeout(deadline);
    if (idle) clearTimeout(idle);
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
