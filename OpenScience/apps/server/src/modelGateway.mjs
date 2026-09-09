// The production model is certified end to end, not merely configured: the
// release gate exercises the whole tool chain against it and signs a receipt
// naming it, readiness refuses to serve on any other, and the runtime refuses
// to launch with any other. Adding a model here is a commitment to certify it —
// the gate will run against whichever of these is configured, so a model that
// cannot drive the chain fails the release rather than reaching a reader.
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { isPeak, priceUsage, REFERENCE_PRICE_LIST } from "@evimed/domain";
import { createUsageTail, recordModelUsage } from "./usageMetering.mjs";

export const supportedDeepSeekModels = Object.freeze(new Set([
  "deepseek-v4-pro",
  "deepseek-v4-flash",
]));
export const defaultDeepSeekModel = "deepseek-v4-pro";

/** The model's name as a reader should see it, derived from the id that is
 *  actually running. Written out by hand, this label kept naming the model the
 *  code was first written for rather than the one the deployment certified. */
export function deepSeekModelDisplayName(model) {
  const id = String(model ?? "").trim();
  const match = /^deepseek-v(\d+)-(\w+)$/.exec(id);
  if (!match) return id || defaultDeepSeekModel;
  const tier = match[2];
  return `DeepSeek V${match[1]} ${tier.charAt(0).toUpperCase()}${tier.slice(1)}`;
}

/** The model this deployment certifies and runs, or null if it names another.
 *  @param {Record<string, string | undefined>} [env] */
export function certifiedDeepSeekModel(env = process.env) {
  const model = String(env.OPEN_SCIENCE_DEEPSEEK_MODEL ?? "").trim() || defaultDeepSeekModel;
  return supportedDeepSeekModels.has(model) ? model : null;
}

const gatewayPath = "/internal/model/v1/chat/completions";
const budgetMarkerPattern = /<evimed-budget-scope>([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)<\/evimed-budget-scope>/g;
const autopilotIntentPattern = /<evimed-autopilot-episode>[a-zA-Z0-9_-]{1,160}<\/evimed-autopilot-episode>/g;
const allowedRequestFields = new Set([
  "model",
  "messages",
  "tools",
  "tool_choice",
  "stream",
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "stop",
  "response_format",
  "frequency_penalty",
  "presence_penalty",
  "seed",
  "parallel_tool_calls",
  "stream_options",
  "thinking",
  "reasoning_effort",
]);

/** Issue a per-run budget claim that rides only in that session's context. */
export function issueModelGatewayBudgetMarker({ secret, userId, projectId, runId, dailyLimit, weeklyLimit, runLimit,
  expiresAt = Math.floor(Date.now() / 1000) + 5 * 60 * 60 }) {
  if (typeof secret !== "string" || secret.length < 32) throw new TypeError("Model gateway budget marker secret is invalid.");
  const payload = { v: 1, userId: String(userId), projectId: String(projectId), runId: String(runId),
    dailyLimit: Number(dailyLimit), weeklyLimit: Number(weeklyLimit), runLimit: Number(runLimit), exp: Number(expiresAt) };
  if ([payload.userId, payload.projectId, payload.runId].some((value) => !value || value.length > 200 || /[\0\r\n]/.test(value))
    || [payload.dailyLimit, payload.weeklyLimit, payload.runLimit].some((value) => !Number.isFinite(value) || value <= 0)
    || !Number.isSafeInteger(payload.exp)) throw new TypeError("Model gateway budget marker payload is invalid.");
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `<evimed-budget-scope>${encoded}.${signature}</evimed-budget-scope>`;
}

function verifiedBudgetScope(encoded, signature, caller, config) {
  const secret = String(config.modelGatewaySigningSecret ?? "");
  if (secret.length < 32) throw gatewayError(401, "model_gateway_budget_scope_invalid", "Model budget scope authentication failed.");
  const expected = createHmac("sha256", secret).update(encoded).digest();
  let supplied;
  try { supplied = Buffer.from(signature, "base64url"); } catch { supplied = Buffer.alloc(0); }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw gatewayError(401, "model_gateway_budget_scope_invalid", "Model budget scope authentication failed.");
  }
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); } catch { payload = null; }
  if (!payload || payload.v !== 1 || payload.userId !== caller.userId || payload.projectId !== caller.projectId
    || (caller.runId != null && payload.runId !== caller.runId)
    || typeof payload.runId !== "string" || !payload.runId || payload.runId.length > 200
    || !Number.isSafeInteger(payload.exp) || payload.exp < Math.floor(Date.now() / 1000)
    || [payload.dailyLimit, payload.weeklyLimit, payload.runLimit].some((value) => !Number.isFinite(value) || value <= 0)) {
    throw gatewayError(401, "model_gateway_budget_scope_invalid", "Model budget scope authentication failed.");
  }
  return { runId: payload.runId, dailyLimit: payload.dailyLimit, weeklyLimit: payload.weeklyLimit, runLimit: payload.runLimit };
}

function consumeBudgetScope(request, caller, config) {
  const scopes = [];
  let requiresScope = false;
  const scrub = (value) => {
    if (typeof value !== "string") return value;
    if (autopilotIntentPattern.test(value)) requiresScope = true;
    autopilotIntentPattern.lastIndex = 0;
    return value.replace(autopilotIntentPattern, "").replace(budgetMarkerPattern, (_match, encoded, signature) => {
      scopes.push(verifiedBudgetScope(encoded, signature, caller, config));
      return "";
    });
  };
  const messages = request.messages.map((message) => ({ ...message, content: typeof message.content === "string"
    ? scrub(message.content)
    : Array.isArray(message.content) ? message.content.map((part) => ({ ...part, ...(typeof part.text === "string" ? { text: scrub(part.text) } : {}) })) : message.content }));
  if (scopes.length > 1 && scopes.some((scope) => JSON.stringify(scope) !== JSON.stringify(scopes[0]))) {
    throw gatewayError(400, "model_gateway_budget_scope_conflict", "Model request contains conflicting budget scopes.");
  }
  if (requiresScope && scopes.length === 0) {
    throw gatewayError(401, "model_gateway_budget_scope_required", "Autopilot model requests require a signed budget scope.");
  }
  if (scopes[0]) {
    if (caller.runId == null || ["runId", "dailyLimit", "weeklyLimit", "runLimit"].some((field) => caller[field] !== scopes[0][field])) {
      throw gatewayError(401, "model_gateway_budget_scope_invalid", "Model budget marker does not match the bounded runtime token.");
    }
  }
  return { request: { ...request, messages }, scope: scopes[0] ?? null };
}

function minimumPositive(...values) {
  const positive = values.map(Number).filter((value) => Number.isFinite(value) && value > 0);
  return positive.length ? Math.min(...positive) : 0;
}
const allowedMessageFields = new Set([
  "role",
  "content",
  "name",
  "tool_call_id",
  "tool_calls",
  "reasoning_content",
  "refusal",
]);
const allowedRoles = new Set(["system", "developer", "user", "assistant", "tool"]);

class GatewayError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function gatewayError(status, code, message) {
  return new GatewayError(status, code, message);
}

function sendError(res, error, onFailure) {
  const status = Number.isSafeInteger(error?.status) ? error.status : 502;
  const code = typeof error?.code === "string" ? error.code : "model_gateway_unavailable";
  // Report before answering. A gateway failure used to end at this function:
  // the code went back to the container and nowhere else, so a 401 storm from
  // the provider and a quiet afternoon looked the same from outside. The
  // truncated case matters most — headers are already out, the only answer
  // left is a destroyed socket, and that is the one failure a caller cannot
  // tell from success.
  if (typeof onFailure === "function") {
    onFailure({ code, status, truncated: res.headersSent && !res.writableEnded });
  }
  if (res.headersSent || res.destroyed) {
    if (!res.destroyed) res.destroy();
    return;
  }
  const message = error instanceof GatewayError
    ? error.message
    : "The model gateway is temporarily unavailable.";
  const body = Buffer.from(JSON.stringify({ error: { code, message } }));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
  });
  res.end(body);
}

function bearerToken(req) {
  const value = req.headers.authorization;
  if (typeof value !== "string" || !value.startsWith("Bearer ")) {
    throw gatewayError(401, "model_gateway_token_invalid", "Model gateway authentication failed.");
  }
  const token = value.slice(7);
  if (!token || token.length > 8 * 1024 || /[\r\n\0]/.test(token)) {
    throw gatewayError(401, "model_gateway_token_invalid", "Model gateway authentication failed.");
  }
  return token;
}

async function readJsonBody(req, limit) {
  const contentType = String(req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw gatewayError(415, "model_gateway_content_type_invalid", "Content-Type must be application/json.");
  }
  const declared = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > limit) {
    throw gatewayError(413, "model_gateway_body_too_large", "The model request body is too large.");
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) {
      throw gatewayError(413, "model_gateway_body_too_large", "The model request body is too large.");
    }
    chunks.push(chunk);
  }
  if (total === 0) throw gatewayError(400, "model_gateway_body_invalid", "A JSON request body is required.");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw gatewayError(400, "model_gateway_body_invalid", "The model request body is not valid JSON.");
  }
}

function assertPlainObject(value, code, message) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw gatewayError(400, code, message);
  }
  return value;
}

function validateMessage(message) {
  assertPlainObject(message, "model_gateway_messages_invalid", "Each message must be an object.");
  if (Object.keys(message).some((key) => !allowedMessageFields.has(key))) {
    throw gatewayError(400, "model_gateway_messages_invalid", "A message contains an unsupported field.");
  }
  if (!allowedRoles.has(message.role)) {
    throw gatewayError(400, "model_gateway_messages_invalid", "A message contains an unsupported role.");
  }
  if (!(typeof message.content === "string" || message.content === null || Array.isArray(message.content))) {
    throw gatewayError(400, "model_gateway_messages_invalid", "A message contains invalid content.");
  }
  if (Array.isArray(message.content)) {
    if (message.content.length > 128) {
      throw gatewayError(400, "model_gateway_messages_invalid", "A message contains too many content parts.");
    }
    for (const part of message.content) {
      assertPlainObject(part, "model_gateway_messages_invalid", "Message content parts must be objects.");
      if (typeof part.type !== "string" || !part.type || part.type.length > 64) {
        throw gatewayError(400, "model_gateway_messages_invalid", "A message content part has an invalid type.");
      }
    }
  }
  if (message.name != null && (typeof message.name !== "string" || message.name.length > 128)) {
    throw gatewayError(400, "model_gateway_messages_invalid", "A message name is invalid.");
  }
  for (const field of ["reasoning_content", "refusal"]) {
    if (message[field] != null && typeof message[field] !== "string") {
      throw gatewayError(400, "model_gateway_messages_invalid", `A message ${field} field is invalid.`);
    }
  }
  if (message.tool_call_id != null && (typeof message.tool_call_id !== "string" || message.tool_call_id.length > 256)) {
    throw gatewayError(400, "model_gateway_messages_invalid", "A message tool call id is invalid.");
  }
  if (message.tool_calls != null && (!Array.isArray(message.tool_calls) || message.tool_calls.length > 128)) {
    throw gatewayError(400, "model_gateway_messages_invalid", "A message contains invalid tool calls.");
  }
}

function validateTool(tool) {
  assertPlainObject(tool, "model_gateway_tools_invalid", "Each tool must be an object.");
  if (Object.keys(tool).some((key) => !["type", "function"].includes(key)) || tool.type !== "function") {
    throw gatewayError(400, "model_gateway_tools_invalid", "Only function tools are supported.");
  }
  const fn = assertPlainObject(tool.function, "model_gateway_tools_invalid", "Each function tool needs a definition.");
  if (Object.keys(fn).some((key) => !["name", "description", "parameters", "strict"].includes(key))) {
    throw gatewayError(400, "model_gateway_tools_invalid", "A function tool contains an unsupported field.");
  }
  if (typeof fn.name !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(fn.name)) {
    throw gatewayError(400, "model_gateway_tools_invalid", "A function tool name is invalid.");
  }
  if (fn.description != null && (typeof fn.description !== "string" || fn.description.length > 8 * 1024)) {
    throw gatewayError(400, "model_gateway_tools_invalid", "A function tool description is invalid.");
  }
  if (fn.parameters != null) assertPlainObject(fn.parameters, "model_gateway_tools_invalid", "Tool parameters must be an object.");
}

function normalizedRequest(body, config) {
  assertPlainObject(body, "model_gateway_body_invalid", "The model request body must be an object.");
  if (Object.keys(body).some((key) => !allowedRequestFields.has(key))) {
    throw gatewayError(400, "model_gateway_field_invalid", "The model request contains an unsupported field.");
  }
  const maxMessages = Math.max(1, Number(config.modelGatewayMaxMessages) || 1024);
  if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > maxMessages) {
    throw gatewayError(
      400,
      "model_gateway_messages_invalid",
      `The model request must contain 1 to ${maxMessages} messages.`,
    );
  }
  body.messages.forEach(validateMessage);
  if (body.tools != null) {
    if (!Array.isArray(body.tools) || body.tools.length > 128) {
      throw gatewayError(400, "model_gateway_tools_invalid", "The model request contains too many tools.");
    }
    body.tools.forEach(validateTool);
  }
  if (body.stream != null && typeof body.stream !== "boolean") {
    throw gatewayError(400, "model_gateway_stream_invalid", "stream must be a boolean.");
  }
  if (body.parallel_tool_calls != null && typeof body.parallel_tool_calls !== "boolean") {
    throw gatewayError(400, "model_gateway_field_invalid", "parallel_tool_calls must be a boolean.");
  }
  if (body.max_tokens != null && (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 384_000)) {
    throw gatewayError(400, "model_gateway_field_invalid", "max_tokens must be an integer between 1 and 384000.");
  }
  if (body.max_completion_tokens != null && (!Number.isSafeInteger(body.max_completion_tokens) || body.max_completion_tokens < 1 || body.max_completion_tokens > 384_000)) {
    throw gatewayError(400, "model_gateway_field_invalid", "max_completion_tokens must be an integer between 1 and 384000.");
  }
  if (body.max_tokens != null && body.max_completion_tokens != null) {
    throw gatewayError(400, "model_gateway_field_invalid", "Use one output token limit.");
  }
  if (body.stream_options != null) {
    const options = assertPlainObject(body.stream_options, "model_gateway_field_invalid", "stream_options must be an object.");
    if (Object.keys(options).some((key) => key !== "include_usage") || (options.include_usage != null && typeof options.include_usage !== "boolean")) {
      throw gatewayError(400, "model_gateway_field_invalid", "stream_options contains an unsupported field.");
    }
  }
  const stream = body.stream === true;
  const configuredOutputLimit = Number(config.modelGatewayReservationMaxOutputTokens ?? 65_536);
  if (!Number.isSafeInteger(configuredOutputLimit) || configuredOutputLimit < 1 || configuredOutputLimit > 384_000) {
    throw gatewayError(500, "model_gateway_configuration_invalid", "The model output limit is invalid.");
  }
  return {
    ...body,
    model: config.deepseekModel,
    thinking: { type: "enabled" },
    reasoning_effort: config.deepseekReasoningEffort ?? "high",
    stream,
    ...(body.max_tokens == null && body.max_completion_tokens == null
      ? { max_completion_tokens: configuredOutputLimit } : {}),
    ...(stream ? { stream_options: { ...(body.stream_options ?? {}), include_usage: true } } : {}),
  };
}

/** Reserve a conservative request ceiling before a provider call starts. */
export function estimateModelReservation(body, config, at = new Date()) {
  const promptTokens = Math.min(1_000_000, Buffer.byteLength(JSON.stringify(body.messages ?? []), "utf8"));
  const configured = Number(config.modelGatewayReservationMaxOutputTokens ?? 65_536);
  const fallback = Number.isSafeInteger(configured) ? configured : 65_536;
  const requested = Number(body.max_completion_tokens ?? body.max_tokens ?? fallback);
  const outputTokens = Math.max(1, Math.min(384_000, requested));
  const price = priceUsage({ resourceType: "model", model: body.model, cacheMiss: promptTokens, output: outputTokens, peak: isPeak(at) });
  return { promptTokens, outputTokens, ...price };
}

function upstreamUrl(base, production = false) {
  const parsed = new URL(base);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw gatewayError(500, "model_gateway_configuration_invalid", "The model gateway is not configured correctly.");
  }
  if (production && (parsed.origin !== "https://api.deepseek.com" || parsed.pathname !== "/")) {
    throw gatewayError(500, "model_gateway_configuration_invalid", "The model gateway is not configured correctly.");
  }
  parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}/chat/completions`;
  return parsed;
}

function mappedUpstreamStatus(status) {
  if (status === 429) return 429;
  if ([400, 408, 413, 422].includes(status)) return status;
  return 502;
}

function waitForDrain(res, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      res.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(gatewayError(499, "model_gateway_downstream_closed", "The model gateway downstream closed.")); };
    const onError = () => { cleanup(); reject(gatewayError(502, "model_gateway_downstream_error", "The model gateway downstream failed.")); };
    const onAbort = () => { cleanup(); reject(signal.reason ?? gatewayError(499, "model_gateway_downstream_closed", "The model gateway downstream closed.")); };
    res.once("drain", onDrain);
    res.once("close", onClose);
    res.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (res.destroyed || res.writableEnded) onClose();
    else if (signal?.aborted) onAbort();
  });
}

/** @param {any} body @param {any} res @param {any} signal @param {number} maxBytes
 *  @param {((chunk: Uint8Array) => void) | null} onChunk called per delivered
 *  chunk, before it is written on */
export async function pipeModelGatewayBody(body, res, signal, maxBytes, onChunk = null) {
  const reader = body.getReader();
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      // A stream that is still delivering is not a stalled request. Without
      // this the deadline set before the call kept running through the
      // response, so a reasoning turn that streamed steadily for longer than
      // the limit was aborted mid-answer.
      onChunk?.(value);
      total += value.byteLength;
      if (total > maxBytes) {
        throw gatewayError(502, "model_gateway_response_too_large", "The model provider response exceeded the gateway limit.");
      }
      if (!res.write(Buffer.from(value))) await waitForDrain(res, signal);
    }
    res.end();
    return total;
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function createModelGatewayHandler(config, runtimeManager, { fetchImpl = fetch, usageLedger = null } = {}) {
  return async function modelGatewayHandler(req, res, onFailure) {
    if (req.method !== "POST" || new URL(req.url ?? "/", "http://localhost").pathname !== gatewayPath) {
      sendError(res, gatewayError(404, "not_found", "Not found."), onFailure);
      return;
    }
    const abortController = new AbortController();
    let reservation = null;
    let reservationUserId = null;
    let providerDisposition = "not-dispatched";
    let usageTerminal = false;
    let providerRequestId = null;
    const requestStartedAt = new Date();
    const timeoutMs = Math.max(1, Number(config.modelGatewayTimeoutMs) || 300_000);
    // The limit is now idle time, not total time. It was total, and set before
    // the request: a reasoning model that streamed an answer for longer than
    // the limit had the connection cut from underneath it. Measured on one
    // production run, a single turn took fifteen minutes against a five-minute
    // deadline, and the run spent 68 of its 87 minutes re-issuing calls that
    // were killed while they were working. Nothing said so — the abort lands
    // after writeHead(200), so the truncated stream carried no status and no
    // log line.
    let timeout = null;
    const armIdleDeadline = () => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(
        () => abortController.abort(new DOMException("Model gateway timed out.", "TimeoutError")),
        timeoutMs,
      );
      timeout.unref?.();
    };
    armIdleDeadline();
    const onAborted = () => abortController.abort(new DOMException("Model gateway client disconnected.", "AbortError"));
    const onResponseClose = () => {
      if (!res.writableEnded) onAborted();
    };
    req.once("aborted", onAborted);
    res.once("close", onResponseClose);
    try {
      if (!config.deepseekApiKey) {
        throw gatewayError(503, "model_gateway_unavailable", "The model gateway is not configured.");
      }
      const token = bearerToken(req);
      let caller;
      try {
        caller = runtimeManager.assertActiveModelGatewayToken(token);
      } catch {
        throw gatewayError(401, "model_gateway_token_invalid", "Model gateway authentication failed.");
      }
      const body = await readJsonBody(req, Math.max(1024, Number(config.modelGatewayMaxBodyBytes) || 1024 * 1024));
      let normalized = normalizedRequest(body, config);
      const scoped = consumeBudgetScope(normalized, caller, config);
      normalized = scoped.request;
      if (config.requireDurableUsageLedger === true && !usageLedger) {
        throw gatewayError(503, "usage_ledger_unavailable", "Durable usage accounting is unavailable.");
      }
      if (usageLedger) {
        const estimate = estimateModelReservation(normalized, config, requestStartedAt);
        const fingerprint = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
        reservationUserId = caller.userId;
        reservation = await usageLedger.reserveModel({
          id: randomUUID(), userId: caller.userId, projectId: caller.projectId, model: normalized.model,
          runId: caller.runId ?? null,
          priceVersion: REFERENCE_PRICE_LIST.version, currency: estimate.currency, requestFingerprint: fingerprint,
          estimatedCost: estimate.cost,
          dailyLimit: minimumPositive(caller.dailyLimit, config.userDailySpendLimit),
          weeklyLimit: minimumPositive(caller.weeklyLimit, config.userWeeklySpendLimit),
          runLimit: Number(caller.runLimit) || 0,
          now: requestStartedAt,
        });
      }
      let upstream;
      try {
        const providerUrl = upstreamUrl(config.deepseekBaseUrl, config.production);
        providerDisposition = "dispatched";
        upstream = await fetchImpl(providerUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.deepseekApiKey}`,
            "content-type": "application/json",
            accept: normalized.stream ? "text/event-stream" : "application/json",
          },
          body: JSON.stringify(normalized),
          redirect: "error",
          signal: abortController.signal,
        });
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        if (abortController.signal.reason?.name === "TimeoutError") {
          throw gatewayError(504, "model_gateway_timeout", "The model gateway request timed out.");
        }
        if (abortController.signal.aborted) throw error;
        throw gatewayError(502, "model_gateway_upstream_unavailable", "The model provider is temporarily unavailable.");
      }
      if (!upstream.ok) {
        providerDisposition = "rejected";
        await upstream.body?.cancel().catch(() => {});
        throw gatewayError(
          mappedUpstreamStatus(upstream.status),
          upstream.status === 429 ? "model_gateway_rate_limited" : "model_gateway_upstream_error",
          upstream.status === 429
            ? "The model provider rate limit was reached."
            : "The model provider rejected the request.",
        );
      }
      providerDisposition = "accepted";
      const contentType = String(upstream.headers.get("content-type") ?? "").toLowerCase();
      const expectedType = normalized.stream ? "text/event-stream" : "application/json";
      if (!contentType.startsWith(expectedType) || !upstream.body) {
        await upstream.body?.cancel().catch(() => {});
        throw gatewayError(502, "model_gateway_upstream_invalid", "The model provider returned an invalid response.");
      }
      const responseLimit = Math.max(1024, Number(config.modelGatewayMaxResponseBytes) || 32 * 1024 * 1024);
      const declaredLength = Number(upstream.headers.get("content-length") ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > responseLimit) {
        await upstream.body.cancel().catch(() => {});
        throw gatewayError(502, "model_gateway_response_too_large", "The model provider response exceeded the gateway limit.");
      }
      res.writeHead(200, {
        "content-type": contentType,
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      });
      // The provider's own token counts are the only trustworthy ones, and
      // this is the one place they pass through. The tail is kept rather than
      // the body: `usage` is last in both shapes, and holding a whole response
      // would undo the reason this is a stream.
      const usageTail = createUsageTail(16 * 1024, { stream: normalized.stream });
      await pipeModelGatewayBody(upstream.body, res, abortController.signal, responseLimit, (chunk) => {
        armIdleDeadline();
        usageTail.observe(chunk);
      });
      providerRequestId = usageTail.providerRequestId();
      const exactUsage = usageTail.usage();
      // After the body, never before: a call that failed halfway is not a call
      // to bill, and awaiting a ledger write before the last byte would put
      // the accounting in the answer's way.
      if (usageLedger && reservation) {
        if (exactUsage) {
          const actual = priceUsage({
            resourceType: "model", model: normalized.model, cacheHit: exactUsage.cacheHitTokens,
            cacheMiss: exactUsage.cacheMissTokens, output: exactUsage.completionTokens, peak: isPeak(requestStartedAt),
          });
          const settledUsage = {
            cacheHitTokens: exactUsage.cacheHitTokens,
            cacheMissTokens: exactUsage.cacheMissTokens,
            completionTokens: exactUsage.completionTokens,
          };
          await usageLedger.settleModel(caller.userId, reservation.id, {
            usage: settledUsage, actualCost: actual.cost, priced: actual.priced, providerRequestId,
          });
        } else {
          await usageLedger.markUncertain(caller.userId, reservation.id, "response_usage_missing", { providerRequestId });
        }
        usageTerminal = true;
      } else {
        await recordModelUsage({ config, userId: caller.userId, projectId: caller.projectId,
          model: normalized.model, usage: exactUsage, at: requestStartedAt });
      }
    } catch (error) {
      if (usageLedger && reservation && reservationUserId && !usageTerminal) {
        try {
          if (["dispatched", "accepted"].includes(providerDisposition)) {
            await usageLedger.markUncertain(reservationUserId, reservation.id, "provider_response_incomplete", { providerRequestId });
          }
          else await usageLedger.release(reservationUserId, reservation.id, "provider_not_accepted");
          usageTerminal = true;
        } catch {
          process.stderr.write("usage ledger terminal transition failed; reservation requires reconciliation\n");
        }
      }
      const abortReason = abortController.signal.reason;
      const clientDisconnected = abortController.signal.aborted && abortReason?.name === "AbortError";
      // Once the stream has started, sendError can no longer set a status: the
      // response is truncated and the caller sees an incomplete answer with no
      // reason anywhere. Say so on the way out, because a silent truncation is
      // indistinguishable from a model that simply stopped talking.
      if (res.headersSent && !res.writableEnded) {
        process.stderr.write(
          `model gateway stream truncated after ${res.getHeader?.("content-type") ?? "stream"}: ${abortReason?.name ?? (error instanceof Error ? error.message : String(error))}\n`,
        );
      }
      if (abortReason?.name === "TimeoutError") {
        sendError(res, gatewayError(504, "model_gateway_timeout", "The model gateway request timed out."), onFailure);
      } else if (clientDisconnected && !res.headersSent) {
        sendError(res, gatewayError(499, "model_gateway_client_closed", "The model gateway client disconnected."), onFailure);
      } else {
        sendError(res, error, onFailure);
      }
      if (!abortController.signal.aborted) {
        abortController.abort(error instanceof Error ? error : new Error("Model gateway failed."));
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      req.off("aborted", onAborted);
      res.off("close", onResponseClose);
    }
  };
}

export const MODEL_GATEWAY_PATH = gatewayPath;
