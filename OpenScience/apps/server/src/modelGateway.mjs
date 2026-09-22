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
  "deepseek-flash",
  "deepseek-v4-flash-vision-exp",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
]));
export const defaultDeepSeekModel = "deepseek-flash";

/** The model's name as a reader should see it, derived from the id that is
 *  actually running. Written out by hand, this label kept naming the model the
 *  code was first written for rather than the one the deployment certified. */
export function deepSeekModelDisplayName(model) {
  const id = String(model ?? "").trim();
  if (["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"].includes(id)) return "DeepSeek V4.1 Flash";
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

/**
 * The conversation a runtime's model request belongs to.
 *
 * The kernel's LLM provider stamps `x-deepseek-harness-session-id` on every
 * request it makes, from the session its agent loop is running (a subagent
 * carries its own). We read it as a hint and nothing more: the header comes
 * from the container, so it is only ever resolved against the runs of the
 * project the request's own token names — a forged value maps to nothing and
 * falls back to the project rule.
 *
 * Bounded like every other caller-supplied string; a session id is an opaque
 * identifier, never a path or a query.
 * @param {any} req @returns {string | null}
 */
function kernelSessionId(req) {
  const raw = req?.headers?.["x-deepseek-harness-session-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200) return null;
  // Printable only: a session id is an opaque identifier, and a control
  // character in one is not a session id, it is somebody probing a log.
  return [...trimmed].every((character) => character.codePointAt(0) >= 0x20 && character.codePointAt(0) !== 0x7f) ? trimmed : null;
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

const cjkCharacter = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/u;

/**
 * Prompt tokens a text will cost, estimated from above. A CJK character is
 * at most about one token in DeepSeek's tokenizer and anything else runs
 * three to four characters to a token, so one per CJK character and one per
 * three of the rest never estimates low. It used to count UTF-8 *bytes* as
 * tokens — three per Chinese character plus the JSON around them — which
 * reserved several times what a Chinese run ever spends and brought the
 * account caps forward by as much.
 * @param {string} text @returns {number}
 */
export function estimatePromptTokens(text) {
  let cjk = 0;
  let other = 0;
  for (const char of String(text ?? "")) {
    if (cjkCharacter.test(char)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 3);
}

/**
 * Content parts that carry an image rather than text: the OpenAI-shaped
 * `image_url` the DeepSeek adapter sends inline, and the file-id block it sends
 * when the provider's Files API holds the bytes.
 */
const IMAGE_PART_TYPES = new Set(["image_url", "input_image", "image", "file"]);

/**
 * One image's prompt tokens, from above: DeepSeek's v4 vision accounting caps a
 * normalized image at 384 tokens, and the adapter's descriptor text naming the
 * attachment rides beside it.
 */
const IMAGE_PART_TOKENS = 1_024;

/** @param {any} body @returns {number} */
function requestPromptTokens(body) {
  let tokens = 0;
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    // A few tokens of framing per message, whatever it carries.
    tokens += 4;
    const content = message?.content;
    if (typeof content === "string") tokens += estimatePromptTokens(content);
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part?.text === "string") tokens += estimatePromptTokens(part.text);
        // An attached image is priced by its pixels, not by the length of its
        // base64: read as text, one normalized image was ~450,000 "tokens"
        // and reserved a whole conversation's worth for a picture.
        else if (IMAGE_PART_TYPES.has(String(part?.type ?? ""))) tokens += IMAGE_PART_TOKENS;
        else tokens += estimatePromptTokens(JSON.stringify(part ?? ""));
      }
    }
    if (typeof message?.reasoning_content === "string") tokens += estimatePromptTokens(message.reasoning_content);
    if (message?.tool_calls != null) tokens += estimatePromptTokens(JSON.stringify(message.tool_calls));
  }
  // The tool schemas are prompt too, and on a first request the largest part.
  if (body.tools != null) tokens += estimatePromptTokens(JSON.stringify(body.tools));
  return Math.min(1_000_000, tokens);
}

/**
 * Reserve a conservative request ceiling before a provider call starts.
 *
 * Priced with the price list's cache tiers: `cachedTokens` — the part of this
 * prompt a previous request of the same conversation already sent, which the
 * provider serves from its prefix cache — at the cache-hit rate, the rest at
 * the miss rate, and the whole requested output budget. Still a ceiling: the
 * settlement uses the provider's own counts.
 * @param {any} body @param {Record<string, any>} config @param {Date} [at]
 * @param {{ cachedTokens?: number }} [options]
 */
export function estimateModelReservation(body, config, at = new Date(), { cachedTokens = 0 } = {}) {
  const promptTokens = requestPromptTokens(body);
  const cacheHit = Math.max(0, Math.min(promptTokens, Number(cachedTokens) || 0));
  const configured = Number(config.modelGatewayReservationMaxOutputTokens ?? 65_536);
  const fallback = Number.isSafeInteger(configured) ? configured : 65_536;
  const requested = Number(body.max_completion_tokens ?? body.max_tokens ?? fallback);
  const outputTokens = Math.max(1, Math.min(384_000, requested));
  const price = priceUsage({
    resourceType: "model", model: body.model, cacheHit, cacheMiss: promptTokens - cacheHit, output: outputTokens, peak: isPeak(at),
  });
  return { promptTokens, cacheHitTokens: cacheHit, outputTokens, ...price };
}

/**
 * The prompt a conversation last sent, so the next request's reservation can
 * price the repeated prefix as cached. Keyed by the caller's token and the
 * conversation's opening messages — an agent loop resends its whole history
 * each step, so what it sent last time is the prefix this time. Bounded, and
 * only an estimate: a miss prices the request as uncached, which is the old,
 * higher ceiling.
 */
class PromptPrefixMemo {
  constructor(limit = 2_000) {
    this.limit = limit;
    /** @type {Map<string, number>} */
    this.tokens = new Map();
  }

  /** @param {string} token @param {any} body */
  key(token, body) {
    const opening = (Array.isArray(body.messages) ? body.messages : []).slice(0, 2);
    return createHash("sha256").update(JSON.stringify([token, body.model, opening])).digest("hex");
  }

  /** @param {string} key */
  cached(key) {
    return this.tokens.get(key) ?? 0;
  }

  /** @param {string} key @param {number} tokens */
  remember(key, tokens) {
    this.tokens.delete(key);
    this.tokens.set(key, tokens);
    if (this.tokens.size > this.limit) this.tokens.delete(this.tokens.keys().next().value);
  }
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
 *  chunk, before it is written on
 *  @param {(() => boolean) | null} finished whether what was delivered is the
 *  whole answer (a stream's `[DONE]`), asked after each chunk is written */
export async function pipeModelGatewayBody(body, res, signal, maxBytes, onChunk = null, finished = null) {
  const reader = body.getReader();
  let total = 0;
  try {
    for (;;) {
      // Once the whole answer is out, nothing that happens to the rest of the
      // provider's body — the idle deadline, a reset — makes it less delivered.
      if (signal.aborted) {
        if (res.writableEnded) break;
        throw signal.reason;
      }
      let step;
      try {
        step = await reader.read();
      } catch (error) {
        if (res.writableEnded) break;
        throw error;
      }
      const { done, value } = step;
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
      // What follows the whole answer is the provider closing its body; it is
      // read, so the connection can serve the next call, and not forwarded.
      if (res.writableEnded) continue;
      const drained = res.write(Buffer.from(value));
      // The answer ends at `[DONE]`, not when the provider gets round to
      // closing its body, and the kernel knows it: it reads up to the
      // sentinel and drops the connection at once. Waiting for the provider's
      // close before ending lost that race whenever the close came in a later
      // packet — about 3% of calls on 2026-09-21, more at peak hours, each an
      // answer delivered whole and booked as `uncertain` at its reserved cost,
      // and each able to fail the release receipt. The response now ends in
      // the same tick as its last byte.
      if (finished?.()) {
        res.end();
        continue;
      }
      if (!drained) await waitForDrain(res, signal);
    }
    if (!res.writableEnded) res.end();
    return total;
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/**
 * @param {Record<string, any>} config @param {any} runtimeManager
 * @param {{ fetchImpl?: typeof fetch, usageLedger?: any,
 *           attributeRun?: (caller: { userId: string, projectId: string, sessionId?: string | null }) => Promise<string | null>,
 *           runPurpose?: (request: { userId: string, projectId: string, runId: string | null }) => Promise<string> }} [options]
 *   `attributeRun` names the ledger run an interactive runtime's request
 *   belongs to (see below); a bounded runtime's token already carries one.
 *   `runPurpose` says what that run's requests are for in the usage ledger:
 *   `kernel`, unless the run is source understanding (`usagePurposeOfRun`).
 */
export function createModelGatewayHandler(config, runtimeManager, {
  fetchImpl = fetch, usageLedger = null, attributeRun = null, runPurpose = null,
} = {}) {
  const prefixes = new PromptPrefixMemo();
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
    /** @type {ReturnType<typeof createUsageTail> | null} */
    let usageTail = null;
    let deliveredBytes = 0;
    let modelName = null;
    const requestStartedAt = new Date();
    /** Book the provider's own count against the reservation. */
    const settleExact = async (exactUsage) => {
      const actual = priceUsage({
        resourceType: "model", model: modelName, cacheHit: exactUsage.cacheHitTokens,
        cacheMiss: exactUsage.cacheMissTokens, output: exactUsage.completionTokens, peak: isPeak(requestStartedAt),
      });
      await usageLedger.settleModel(reservationUserId, reservation.id, {
        usage: {
          cacheHitTokens: exactUsage.cacheHitTokens,
          cacheMissTokens: exactUsage.cacheMissTokens,
          completionTokens: exactUsage.completionTokens,
        },
        actualCost: actual.cost, priced: actual.priced, providerRequestId,
      });
    };
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
      // Platform tokens also authorize public-source retrieval. A live token
      // and a loaded provider key must not override an explicit provider stop.
      if (config.deepseekProviderEnabled === false || !config.deepseekApiKey) {
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
      modelName = normalized.model;
      if (config.requireDurableUsageLedger === true && !usageLedger) {
        throw gatewayError(503, "usage_ledger_unavailable", "Durable usage accounting is unavailable.");
      }
      if (usageLedger) {
        const prefixKey = prefixes.key(token, normalized);
        const estimate = estimateModelReservation(normalized, config, requestStartedAt, { cachedTokens: prefixes.cached(prefixKey) });
        prefixes.remember(prefixKey, estimate.promptTokens);
        const fingerprint = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
        reservationUserId = caller.userId;
        // Which run this request is part of. A bounded runtime (autopilot,
        // verification, learning, source understanding) is minted per run and
        // its token says so. An interactive runtime's token is per project,
        // so every one of its requests reached the ledger with no run at all:
        // per-run cost read zero and the per-run cap could never fire (E §9.4,
        // memory "per-run usage is never attributed").
        //
        // The conversation is on the request: the kernel's own agent loop
        // stamps its session id on every model call. With it, two runs in one
        // project each get their own spend; without it — an older kernel, an
        // auxiliary call that carries none — the control plane falls back to
        // asking which run is running in the project, and two at once stay
        // unattributed rather than guessed (they still count toward the
        // account's caps). Measured on 2026-09-20: two conversations in the
        // default project overlapped, and both read 「约 ¥0.00」.
        const attributed = caller.runId == null && attributeRun
          ? await attributeRun({ userId: caller.userId, projectId: caller.projectId, sessionId: kernelSessionId(req) }).catch(() => null)
          : null;
        const runId = caller.runId ?? attributed ?? null;
        // A runtime's request is the kernel's unless its run says otherwise.
        // Asking can fail (the run ledger is a file); the answer is a report
        // column, so a failure records `kernel` rather than costing the call.
        const purpose = runPurpose
          ? await runPurpose({ userId: caller.userId, projectId: caller.projectId, runId }).catch(() => "kernel")
          : "kernel";
        reservation = await usageLedger.reserveModel({
          id: randomUUID(), userId: caller.userId, projectId: caller.projectId, model: normalized.model,
          runId, purpose,
          priceVersion: REFERENCE_PRICE_LIST.version, currency: estimate.currency, requestFingerprint: fingerprint,
          estimatedCost: estimate.cost,
          dailyLimit: minimumPositive(caller.dailyLimit, config.userDailySpendLimit),
          weeklyLimit: minimumPositive(caller.weeklyLimit, config.userWeeklySpendLimit),
          runLimit: caller.runId != null ? Number(caller.runLimit) || 0 : (attributed ? Number(config.userRunSpendLimit) || 0 : 0),
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
      const tail = createUsageTail(16 * 1024, { stream: normalized.stream });
      usageTail = tail;
      await pipeModelGatewayBody(upstream.body, res, abortController.signal, responseLimit, (chunk) => {
        armIdleDeadline();
        deliveredBytes += chunk.byteLength;
        tail.observe(chunk);
      }, normalized.stream ? () => tail.finished() : null);
      providerRequestId = tail.providerRequestId();
      const exactUsage = tail.usage();
      // After the body, never before: a call that failed halfway is not a call
      // to bill, and awaiting a ledger write before the last byte would put
      // the accounting in the answer's way.
      if (usageLedger && reservation) {
        if (exactUsage) {
          await settleExact(exactUsage);
        } else {
          await usageLedger.markUncertain(caller.userId, reservation.id, "response_usage_missing", { providerRequestId });
        }
        usageTerminal = true;
      } else {
        await recordModelUsage({ config, userId: caller.userId, projectId: caller.projectId,
          model: normalized.model, usage: exactUsage, at: requestStartedAt });
      }
    } catch (error) {
      // The provider's own count is the last thing it sends. Once it has
      // arrived the call is known exactly, whoever hung up after it: booking it
      // `uncertain` at its reserved cost would bill an estimate for a call
      // whose price is on the wire.
      const seenUsage = usageTail?.usage() ?? null;
      if (usageLedger && reservation && reservationUserId && !usageTerminal) {
        try {
          providerRequestId = usageTail?.providerRequestId() ?? providerRequestId;
          if (seenUsage) await settleExact(seenUsage);
          else if (["dispatched", "accepted"].includes(providerDisposition)) {
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
      // indistinguishable from a model that simply stopped talking. What had
      // been delivered, and for how long, tells a cancelled turn (seconds, no
      // usage) from a stalled provider (the idle deadline) from a slow close.
      if (res.headersSent && !res.writableEnded) {
        const seconds = ((Date.now() - requestStartedAt.getTime()) / 1000).toFixed(1);
        process.stderr.write(
          `model gateway stream truncated after ${res.getHeader?.("content-type") ?? "stream"}: ${abortReason?.name ?? (error instanceof Error ? error.message : String(error))}`
          + ` (${deliveredBytes} bytes in ${seconds}s, usage ${seenUsage ? "received" : "not received"}, [DONE] ${usageTail?.finished() ? "received" : "not received"})\n`,
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

/**
 * A model call the control plane makes on its own behalf, through the same
 * boundary as every other one.
 *
 * Hidden knowledge: this exists because the control plane had a second way out.
 * Memory extraction ran after every finished run and called `api.deepseek.com`
 * directly with the deployment's key: it did not reserve, it did not settle, it
 * did not appear in `evimed_usage.model_requests`, and the account's rolling
 * caps did not apply to it. An operator reading the ledger saw every token the
 * *runtime* spent and none of what the platform spent thinking about the run
 * afterwards — the one egress this file exists to make impossible to have twice
 * (principle 15: every budget has a key, a reason and an observable counter).
 *
 * It is a function rather than a loopback HTTP request to `MODEL_GATEWAY_PATH`
 * on purpose. That path authenticates a *runtime* workload token and pipes a
 * stream to a downstream response; an in-process caller has neither, and
 * minting itself a runtime token to talk to itself would be a worse thing to
 * own than this. What has to be shared is the part that matters and is now
 * shared exactly once: the upstream URL rule, the model allowlist, and the
 * reserve-then-settle accounting.
 *
 * Non-streaming only. Every control-plane use is a single JSON answer, and a
 * streaming variant with no reader is a way to lose the usage tail.
 *
 * `call.purpose` is what the call is for, one of `@evimed/domain`'s
 * `USAGE_PURPOSES`; the ledger records one it does not know, or none, as
 * `other`, because a missing label must never cost the call it labels.
 *
 * @param {{ config: any, usageLedger: any, fetchImpl?: typeof fetch }} deps
 * @param {{ userId: string, projectId: string, runId?: string | null, purpose?: string, body: any,
 *           signal?: AbortSignal, at?: Date }} call
 * @returns {Promise<any>} the provider's parsed JSON response
 */
export async function callModelForControlPlane({ config, usageLedger, fetchImpl = fetch }, call) {
  const at = call.at ?? new Date();
  const body = { ...call.body, stream: false };
  if (!supportedDeepSeekModels.has(String(body.model ?? ""))) {
    throw gatewayError(400, "model_not_supported", "The requested model is not supported.");
  }
  if (config.requireDurableUsageLedger === true && !usageLedger) {
    throw gatewayError(503, "usage_ledger_unavailable", "Durable usage accounting is unavailable.");
  }
  let reservation = null;
  if (usageLedger) {
    const estimate = estimateModelReservation(body, config, at);
    reservation = await usageLedger.reserveModel({
      id: randomUUID(), userId: call.userId, projectId: call.projectId, model: body.model,
      runId: call.runId ?? null, purpose: call.purpose,
      priceVersion: REFERENCE_PRICE_LIST.version, currency: estimate.currency,
      requestFingerprint: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
      estimatedCost: estimate.cost,
      dailyLimit: Number(config.userDailySpendLimit) || 0,
      weeklyLimit: Number(config.userWeeklySpendLimit) || 0,
      runLimit: 0,
      now: at,
    });
  }

  let dispatched = false;
  try {
    const response = await fetchImpl(upstreamUrl(config.deepseekBaseUrl, config.production), {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${config.deepseekApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: call.signal,
    });
    dispatched = true;
    if (!response.ok) {
      // The provider's own status rides along: the mapped one folds every
      // server error into 502, and a caller that reports why it got no answer
      // (the routing classifier's `http_<status>`) needs the one that happened.
      throw Object.assign(gatewayError(mappedUpstreamStatus(response.status), "model_gateway_upstream_error",
        `The model provider returned HTTP ${response.status}.`), { upstreamStatus: response.status });
    }
    const payload = /** @type {any} */ (JSON.parse(await response.text()));
    if (usageLedger && reservation) {
      // The provider's own count, or nothing. A reservation settled against an
      // estimate would read in the ledger exactly like one settled against a
      // measurement, which is the distinction `markUncertain` exists to keep.
      const usage = payload?.usage;
      const completionTokens = Number(usage?.completion_tokens);
      if (Number.isFinite(completionTokens)) {
        const cacheHitTokens = Number(usage?.prompt_cache_hit_tokens) || 0;
        const cacheMissTokens = Number.isFinite(Number(usage?.prompt_cache_miss_tokens))
          ? Number(usage.prompt_cache_miss_tokens)
          : Math.max(0, (Number(usage?.prompt_tokens) || 0) - cacheHitTokens);
        const actual = priceUsage({
          resourceType: "model", model: body.model, cacheHit: cacheHitTokens,
          cacheMiss: cacheMissTokens, output: completionTokens, peak: isPeak(at),
        });
        await usageLedger.settleModel(call.userId, reservation.id, {
          usage: { cacheHitTokens, cacheMissTokens, completionTokens },
          actualCost: actual.cost, priced: actual.priced,
          providerRequestId: payload?.id == null ? null : String(payload.id).slice(0, 512),
        });
      } else {
        await usageLedger.markUncertain(call.userId, reservation.id, "response_usage_missing", {});
      }
      reservation = null;
    }
    return payload;
  } finally {
    // Still held means the call did not reach a settled end. Dispatched and
    // then lost is uncertain — the provider may have billed it; never
    // dispatched is a release, and quietly dropping either would leave a
    // reservation counting against the account's cap until the sweep expires it.
    if (usageLedger && reservation) {
      try {
        if (dispatched) await usageLedger.markUncertain(call.userId, reservation.id, "provider_response_incomplete", {});
        else await usageLedger.release(call.userId, reservation.id, "provider_not_accepted");
      } catch {
        process.stderr.write("usage ledger terminal transition failed; reservation requires reconciliation\n");
      }
    }
  }
}

export const MODEL_GATEWAY_PATH = gatewayPath;
