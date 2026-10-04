import { reasoningFields } from "./modelReasoningPolicy.mjs";
// The production model is certified end to end, not merely configured: the
// release gate exercises the whole tool chain against it and signs a receipt
// naming it, readiness refuses to serve on any other, and the runtime refuses
// to launch with any other. Adding a model here is a commitment to certify it —
// the gate will run against whichever of these is configured, so a model that
// cannot drive the chain fails the release rather than reaching a reader.
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { isPeak, priceUsage, REFERENCE_PRICE_LIST } from "@evimed/domain";
import { verifyEngineModelToken } from "./modelGatewayEngineTokens.mjs";
import { recordProviderRefusal } from "./providerRefusals.mjs";
import { closeUnsettledReservation } from "./usageLedger.mjs";
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
/**
 * The kernel's own route since DSH 0.1.7.
 *
 * Its DeepSeek adapter speaks one protocol, Anthropic Messages, to DeepSeek's
 * `/anthropic` API ("Configuration accepts Messages only and has no `protocol`
 * field"). Given our `baseURL` — `/internal/model/v1`, whose final `/v1` it
 * reuses — it posts to `<base>/messages` with the workload token in
 * `x-api-key`. The chat-completions path above stays for the control plane's
 * own callers.
 */
const messagesGatewayPath = "/internal/model/v1/messages";
/**
 * Where the adapter uploads a request's images first. Refused: an uploaded
 * file lives under the deployment's one provider key, where every tenant's
 * requests could name it. The adapter treats any upload failure as a reason to
 * send the images inline, which is what the chat route has always carried.
 *
 * Not a failure, so not ledgered as one. The pinned kernel's DeepSeek adapter
 * (the `dsh` pin in deps-version.json, measured 2026-10-04) tries `POST <base>/files` before every model request whose
 * history holds an image, and has no setting that turns the attempt off — the
 * only keys near it are byte and count budgets, and a budget small enough to
 * skip the upload makes the image-offload plugin replace the image with
 * placeholder text, which would end vision. So the refusal is the protocol
 * working: 166 of them in the error ledger since 2026-09-28 read as a gateway
 * failing and were one image-bearing step each, with the image delivered
 * inline. They are counted on their own (`modelGatewayFilesRefusals`,
 * `open_science_model_gateway_files_refused_total`) so an operator can still
 * see how often images travel.
 */
const filesGatewayPrefix = "/internal/model/v1/files";
let filesRefusals = 0;

/** How many provider-side image uploads the gateway has refused since this process started. */
export function modelGatewayFilesRefusals() {
  return filesRefusals;
}
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

/**
 * The newest message the person wrote. In chat completions a tool result is
 * its own `tool` role, so it is the last `user` message; in Messages a tool
 * result rides in a `user` message too, and a turn's third step would read the
 * tool results as the person's words and the prompt as history.
 * @param {any[]} messages @returns {number}
 */
function currentUserMessageIndex(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    if (!Array.isArray(message.content) || message.content.some((part) => part?.type !== "tool_result")) return index;
  }
  return -1;
}

function consumeBudgetScope(request, caller, config) {
  const scopes = [];
  let requiresScope = false;
  // An interactive runtime's token names no run. A marker or an autopilot
  // intent in an earlier message is history: the user continuing, in the
  // chat, a conversation a bounded run started (a GEO step, an autopilot
  // episode, a verification). On 2026-09-25 every such follow-up failed with
  // budget_scope_invalid. History is stripped and neither honoured nor
  // refused: the turn is the user's, under the user's own caps. In the newest
  // user message they belong to this turn and are held to the rules below.
  const current = caller.runId == null ? currentUserMessageIndex(request.messages) : -1;
  const scrub = (value, index) => {
    if (typeof value !== "string") return value;
    if (caller.runId == null && index !== current) return value.replace(autopilotIntentPattern, "").replace(budgetMarkerPattern, "");
    if (autopilotIntentPattern.test(value)) requiresScope = true;
    autopilotIntentPattern.lastIndex = 0;
    return value.replace(autopilotIntentPattern, "").replace(budgetMarkerPattern, (_match, encoded, signature) => {
      scopes.push(verifiedBudgetScope(encoded, signature, caller, config));
      return "";
    });
  };
  const messages = request.messages.map((message, index) => ({ ...message, content: typeof message.content === "string"
    ? scrub(message.content, index)
    : Array.isArray(message.content)
      ? message.content.map((part) => ({ ...part, ...(typeof part.text === "string" ? { text: scrub(part.text, index) } : {}) }))
      : message.content }));
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

/**
 * The caller an engine job's credential stands for (modelGatewayEngineTokens.mjs).
 *
 * Asked only after the token is not a live runtime's. Accepted only while the
 * lever is on — switched off, every engine credential already handed out stops
 * at its next call — and only on the chat route, the one protocol the engines
 * speak. Its scope is the token's own: a budget marker in an engine's prompt is
 * text, never authority, so the marker rules below do not apply to it.
 * @param {string} token @param {{ protocol: string }} route @param {Record<string, any>} config
 */
function engineCaller(token, route, config) {
  if (config.engineModelGatewayEnabled !== true || route.protocol !== "chat") {
    throw gatewayError(401, "model_gateway_token_invalid", "Model gateway authentication failed.");
  }
  try {
    return verifyEngineModelToken(token, { secret: config.modelGatewaySigningSecret });
  } catch {
    throw gatewayError(401, "model_gateway_token_invalid", "Model gateway authentication failed.");
  }
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

/**
 * The sentence for the one refusal the gateway answers that it did not raise:
 * the usage ledger's 402. Answered with the generic sentence below, a call its
 * budget refused was recorded by the kernel — and shown in the kernel's own
 * conversation window — as "The model gateway is temporarily unavailable.",
 * which tells the reader to wait for something that is not coming back
 * (2026-10-05: an autopilot episode with a CNY 1.11 budget, refused on its
 * second call). The ledger knows which limit it was; the body says so.
 * @param {any} error
 * @returns {string | null}
 */
function spendLimitRefusalMessage(error) {
  if (error?.status !== 402 || error?.code !== "usage_budget_exceeded") return null;
  return error?.details?.window === "run"
    ? "The spending limit of this run refused the model call; nothing was sent to the provider."
    : "The spending limit of this account refused the model call; nothing was sent to the provider.";
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
    : spendLimitRefusalMessage(error) ?? "The model gateway is temporarily unavailable.";
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
    ...reasoningFields(body, "chat", config),
    stream,
    ...(body.max_tokens == null && body.max_completion_tokens == null
      ? { max_completion_tokens: configuredOutputLimit } : {}),
    ...(stream ? { stream_options: { ...(body.stream_options ?? {}), include_usage: true } } : {}),
  };
}

/** The kernel's credential on the Messages route: the workload token, in
 *  `x-api-key` rather than a bearer header. @param {any} req @returns {string} */
function apiKeyToken(req) {
  const raw = req.headers["x-api-key"];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (typeof token !== "string" || !token || token.length > 8 * 1024 || /[\r\n\0]/.test(token)) {
    throw gatewayError(401, "model_gateway_token_invalid", "Model gateway authentication failed.");
  }
  return token;
}

/**
 * Top-level fields a Messages request may carry, as DSH 0.1.7's adapter writes
 * them (`serialize` in `@deepseek-ai/dsh-llm-deepseek`). Anything else is
 * refused, not stripped: the adapter adds provider-side extension fields to
 * this same body \u2014 `dsh_session_log`, a copy of the whole session log, and
 * `dsh_plugin_packages`, the composition \u2014 and a gateway that dropped them
 * quietly would hide the day one was switched back on.
 */
const allowedMessagesRequestFields = new Set([
  "model",
  "messages",
  "system",
  "max_tokens",
  "stream",
  "thinking",
  "output_config",
  "temperature",
  "top_p",
  "stop_sequences",
  "tools",
]);

/** Content blocks the adapter sends: text and images from the person and from
 *  tool results, the model's own text, thinking and tool calls replayed. */
const allowedMessagesBlockTypes = new Set(["text", "image", "thinking", "redacted_thinking", "tool_use", "tool_result"]);

/** @param {any} block @param {number} depth */
function validateMessagesBlock(block, depth) {
  assertPlainObject(block, "model_gateway_messages_invalid", "Message content blocks must be objects.");
  if (!allowedMessagesBlockTypes.has(block.type)) {
    throw gatewayError(400, "model_gateway_messages_invalid", "A message content block has an unsupported type.");
  }
  if (block.type === "image") {
    // Inline only. A `file` source names a provider-side upload, and every
    // tenant's uploads would live under the deployment's one key.
    const source = assertPlainObject(block.source, "model_gateway_messages_invalid", "An image needs a source.");
    if (source.type !== "base64") {
      throw gatewayError(400, "model_gateway_messages_invalid", "Images must be sent inline.");
    }
  }
  if (block.type === "tool_result" && Array.isArray(block.content)) {
    if (depth > 0 || block.content.length > 128) {
      throw gatewayError(400, "model_gateway_messages_invalid", "A tool result contains invalid content.");
    }
    for (const inner of block.content) validateMessagesBlock(inner, depth + 1);
  }
}

/** @param {any} message */
function validateMessagesMessage(message) {
  assertPlainObject(message, "model_gateway_messages_invalid", "Each message must be an object.");
  if (Object.keys(message).some((key) => key !== "role" && key !== "content")) {
    throw gatewayError(400, "model_gateway_messages_invalid", "A message contains an unsupported field.");
  }
  if (message.role !== "user" && message.role !== "assistant") {
    throw gatewayError(400, "model_gateway_messages_invalid", "A message contains an unsupported role.");
  }
  if (typeof message.content === "string") return;
  if (!Array.isArray(message.content) || message.content.length > 256) {
    throw gatewayError(400, "model_gateway_messages_invalid", "A message contains invalid content.");
  }
  for (const block of message.content) validateMessagesBlock(block, 0);
}

/** @param {any} tool */
function validateMessagesTool(tool) {
  assertPlainObject(tool, "model_gateway_tools_invalid", "Each tool must be an object.");
  if (Object.keys(tool).some((key) => !["name", "description", "input_schema", "defer_loading"].includes(key))) {
    throw gatewayError(400, "model_gateway_tools_invalid", "A tool contains an unsupported field.");
  }
  if (typeof tool.name !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(tool.name)) {
    throw gatewayError(400, "model_gateway_tools_invalid", "A tool name is invalid.");
  }
  if (tool.description != null && (typeof tool.description !== "string" || tool.description.length > 8 * 1024)) {
    throw gatewayError(400, "model_gateway_tools_invalid", "A tool description is invalid.");
  }
  assertPlainObject(tool.input_schema, "model_gateway_tools_invalid", "A tool needs an input schema.");
  if (tool.defer_loading != null && typeof tool.defer_loading !== "boolean") {
    throw gatewayError(400, "model_gateway_tools_invalid", "A tool's defer_loading must be a boolean.");
  }
}

/**
 * A kernel request on the Messages route, checked and held to the model and
 * reasoning the deployment certifies \u2014 the same holds `normalizedRequest`
 * places on the chat route, in this protocol's field names.
 * @param {any} body @param {Record<string, any>} config
 */
function normalizedMessagesRequest(body, config) {
  assertPlainObject(body, "model_gateway_body_invalid", "The model request body must be an object.");
  if (Object.keys(body).some((key) => !allowedMessagesRequestFields.has(key))) {
    throw gatewayError(400, "model_gateway_field_invalid", "The model request contains an unsupported field.");
  }
  const maxMessages = Math.max(1, Number(config.modelGatewayMaxMessages) || 1024);
  if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > maxMessages) {
    throw gatewayError(400, "model_gateway_messages_invalid", `The model request must contain 1 to ${maxMessages} messages.`);
  }
  body.messages.forEach(validateMessagesMessage);
  if (body.system != null && typeof body.system !== "string") {
    throw gatewayError(400, "model_gateway_field_invalid", "system must be a string.");
  }
  if (body.tools != null) {
    if (!Array.isArray(body.tools) || body.tools.length > 128) {
      throw gatewayError(400, "model_gateway_tools_invalid", "The model request contains too many tools.");
    }
    body.tools.forEach(validateMessagesTool);
  }
  if (body.stream != null && typeof body.stream !== "boolean") {
    throw gatewayError(400, "model_gateway_stream_invalid", "stream must be a boolean.");
  }
  if (body.max_tokens != null && (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 384_000)) {
    throw gatewayError(400, "model_gateway_field_invalid", "max_tokens must be an integer between 1 and 384000.");
  }
  if (body.stop_sequences != null && (!Array.isArray(body.stop_sequences) || body.stop_sequences.length > 16
    || body.stop_sequences.some((/** @type {unknown} */ stop) => typeof stop !== "string" || stop.length > 256))) {
    throw gatewayError(400, "model_gateway_field_invalid", "stop_sequences is invalid.");
  }
  const configuredOutputLimit = Number(config.modelGatewayReservationMaxOutputTokens ?? 65_536);
  if (!Number.isSafeInteger(configuredOutputLimit) || configuredOutputLimit < 1 || configuredOutputLimit > 384_000) {
    throw gatewayError(500, "model_gateway_configuration_invalid", "The model output limit is invalid.");
  }
  return {
    ...body,
    model: config.deepseekModel,
    ...reasoningFields(body, "messages", config),
    stream: body.stream === true,
    max_tokens: body.max_tokens ?? configuredOutputLimit,
  };
}

/** @param {string} base @param {boolean} production */
function messagesUpstreamUrl(base, production = false) {
  const parsed = new URL(base);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw gatewayError(500, "model_gateway_configuration_invalid", "The model gateway is not configured correctly.");
  }
  if (production && (parsed.origin !== "https://api.deepseek.com" || parsed.pathname !== "/")) {
    throw gatewayError(500, "model_gateway_configuration_invalid", "The model gateway is not configured correctly.");
  }
  // DeepSeek's Messages API lives under `/anthropic` on the same origin.
  parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}/anthropic/v1/messages`;
  return parsed;
}

/**
 * The two routes the kernel can reach, by path.
 * @type {Record<string, { protocol: "chat" | "messages", token: (req: any) => string,
 *   normalize: (body: any, config: Record<string, any>) => any, upstream: (base: string, production: boolean) => URL,
 *   headers: (apiKey: string) => Record<string, string> }>}
 */
const GATEWAY_ROUTES = {
  [gatewayPath]: {
    protocol: "chat",
    token: bearerToken,
    normalize: normalizedRequest,
    upstream: (base, production) => upstreamUrl(base, production),
    headers: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
  },
  [messagesGatewayPath]: {
    protocol: "messages",
    token: apiKeyToken,
    normalize: normalizedMessagesRequest,
    upstream: messagesUpstreamUrl,
    headers: (apiKey) => ({ "x-api-key": apiKey, "anthropic-version": "2023-06-01" }),
  },
};

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

/** @param {any} part @returns {number} */
function contentPartTokens(part) {
  if (typeof part?.text === "string") return estimatePromptTokens(part.text);
  // An attached image is priced by its pixels, not by the length of its
  // base64: read as text, one normalized image was ~450,000 "tokens"
  // and reserved a whole conversation's worth for a picture.
  if (IMAGE_PART_TYPES.has(String(part?.type ?? ""))) return IMAGE_PART_TOKENS;
  // A Messages tool result holds its own blocks — an image among them —
  // so it is priced block by block, the way a top-level one is.
  if (part?.type === "tool_result" && Array.isArray(part.content)) {
    return part.content.reduce((/** @type {number} */ sum, /** @type {any} */ inner) => sum + contentPartTokens(inner), 4);
  }
  return estimatePromptTokens(JSON.stringify(part ?? ""));
}

/** @param {any} body @returns {number} */
function requestPromptTokens(body) {
  // The Messages route carries the system prompt beside the messages.
  let tokens = typeof body.system === "string" ? estimatePromptTokens(body.system) : 0;
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    // A few tokens of framing per message, whatever it carries.
    tokens += 4;
    const content = message?.content;
    if (typeof content === "string") tokens += estimatePromptTokens(content);
    else if (Array.isArray(content)) {
      for (const part of content) tokens += contentPartTokens(part);
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
 * What a call booked `uncertain` is counted at in the spend windows
 * (usageLedger.mjs `OPEN_COST_VALUE`): its prompt as the reservation priced it
 * — every token uncached that the caller did not know to be cached — plus the
 * output the caller saw arrive, and never more than the reservation.
 *
 * Null when the caller cannot say how much output there was: a JSON answer
 * arrives only whole, so one lost before it arrived may have been generated in
 * full and billed. The ledger then holds the reservation, which is the bound.
 * @param {ReturnType<typeof estimateModelReservation> | null} estimate the reservation's own estimate
 * @param {string} model @param {Date} at when the call was made (the peak rate is the call's)
 * @param {number | null} outputTokens output tokens seen; 0 when the provider answered an error before any output
 * @returns {number | null}
 */
export function uncertainCallCost(estimate, model, at, outputTokens) {
  if (!estimate || outputTokens == null || !Number.isFinite(outputTokens) || outputTokens < 0) return null;
  const { cost } = priceUsage({
    resourceType: "model", model, cacheHit: estimate.cacheHitTokens, cacheMiss: estimate.promptTokens - estimate.cacheHitTokens,
    output: Math.min(Math.floor(outputTokens), estimate.outputTokens), peak: isPeak(at),
  });
  return Math.min(cost, estimate.cost);
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

// Streaming control-plane callers share the gateway's provider URL policy.
export { upstreamUrl as deepSeekChatUrl };

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
    const requestPath = new URL(req.url ?? "/", "http://localhost").pathname;
    if (requestPath === filesGatewayPrefix || requestPath.startsWith(`${filesGatewayPrefix}/`)) {
      // Before authentication, and without reading the body: nothing on this
      // path is ever served, and the adapter falls back to inline images on
      // any failure here. Answered without `onFailure`: this is the adapter's
      // upload probe getting the answer it is built to handle, not a gateway
      // fault (see `filesGatewayPrefix`).
      filesRefusals += 1;
      sendError(res, gatewayError(404, "model_gateway_files_unsupported", "Uploaded files are not supported; send images inline."), null);
      return;
    }
    const route = Object.hasOwn(GATEWAY_ROUTES, requestPath) ? GATEWAY_ROUTES[requestPath] : null;
    if (req.method !== "POST" || !route) {
      sendError(res, gatewayError(404, "not_found", "Not found."), onFailure);
      return;
    }
    const abortController = new AbortController();
    let reservation = null;
    let reservationUserId = null;
    /** @type {ReturnType<typeof estimateModelReservation> | null} */
    let reservationEstimate = null;
    let streamRequested = false;
    let providerDisposition = "not-dispatched";
    /** The provider's status when it answered with an error before any output. */
    let upstreamStatus = 0;
    let usageTerminal = false;
    let providerRequestId = null;
    /** @type {ReturnType<typeof createUsageTail> | null} */
    let usageTail = null;
    let deliveredBytes = 0;
    let modelName = null;
    const requestStartedAt = new Date();
    /** What an uncertain call is bounded at (`uncertainCallCost`): an error
     *  answered before any output produced none; a stream shows its events as
     *  they pass; a JSON body shows nothing until it is whole, so null. */
    const uncertainEstimate = () => {
      const output = providerDisposition === "rejected" ? 0
        : providerDisposition === "accepted" && streamRequested && usageTail ? usageTail.streamedEvents() : null;
      return uncertainCallCost(reservationEstimate, modelName, requestStartedAt, output);
    };
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
      const token = route.token(req);
      /** @type {any} */
      let caller;
      try {
        caller = runtimeManager.assertActiveModelGatewayToken(token);
      } catch {
        caller = engineCaller(token, route, config);
      }
      const body = await readJsonBody(req, Math.max(1024, Number(config.modelGatewayMaxBodyBytes) || 1024 * 1024));
      const requestConfig = caller.engine
        ? { ...config, modelGatewayTrustedEffort: caller.reasoningEffort ?? config.deepseekReasoningEffort ?? "high" } : config;
      let normalized = route.normalize(body, requestConfig);
      const scoped = caller.engine ? { request: normalized, scope: null } : consumeBudgetScope(normalized, caller, config);
      normalized = scoped.request;
      modelName = normalized.model;
      streamRequested = normalized.stream === true;
      if (config.requireDurableUsageLedger === true && !usageLedger) {
        throw gatewayError(503, "usage_ledger_unavailable", "Durable usage accounting is unavailable.");
      }
      if (usageLedger) {
        const prefixKey = prefixes.key(token, normalized);
        const estimate = estimateModelReservation(normalized, config, requestStartedAt, { cachedTokens: prefixes.cached(prefixKey) });
        reservationEstimate = estimate;
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
        //
        // An engine job's run was decided when the job was admitted and rides
        // in its credential; asking again now could name a run that started
        // after the job did.
        const attributed = caller.runId == null && attributeRun && !caller.engine
          ? await attributeRun({ userId: caller.userId, projectId: caller.projectId, sessionId: kernelSessionId(req) }).catch(() => null)
          : null;
        const runId = caller.runId ?? attributed ?? null;
        // A call with no run yet keeps its session, so the run can be named once
        // it is known (`UsageLedger.attributeSession`): the first calls of a
        // conversation typed into the kernel's own window, a subagent's first
        // calls. An engine job's calls never need it.
        const sessionId = runId == null && !caller.engine ? kernelSessionId(req) : null;
        // A runtime's request is the kernel's unless its run says otherwise.
        // Asking can fail (the run ledger is a file); the answer is a report
        // column, so a failure records `kernel` rather than costing the call.
        const purpose = caller.engine ? "engine" : runPurpose
          ? await runPurpose({ userId: caller.userId, projectId: caller.projectId, runId }).catch(() => "kernel")
          : "kernel";
        reservation = await usageLedger.reserveModel({
          id: randomUUID(), userId: caller.userId, projectId: caller.projectId, model: normalized.model,
          runId, sessionId, purpose,
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
        const providerUrl = route.upstream(config.deepseekBaseUrl, config.production);
        providerDisposition = "dispatched";
        upstream = await fetchImpl(providerUrl, {
          method: "POST",
          headers: {
            ...route.headers(config.deepseekApiKey),
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
        upstreamStatus = upstream.status;
        recordProviderRefusal("deepseek", upstream.status);
        await upstream.body?.cancel().catch(() => {});
        throw gatewayError(
          mappedUpstreamStatus(upstream.status),
          upstream.status === 429 ? "model_gateway_rate_limited"
            : upstream.status === 402 ? "model_gateway_payment_required" : "model_gateway_upstream_error",
          upstream.status === 429 ? "The model provider rate limit was reached."
            : upstream.status === 402 ? "The model provider refused the call: its balance is exhausted."
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
      const tail = createUsageTail(16 * 1024, { stream: normalized.stream, protocol: route.protocol });
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
          await usageLedger.markUncertain(caller.userId, reservation.id, "response_usage_missing", {
            providerRequestId, estimatedCost: uncertainEstimate(),
          });
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
          // A refusal before any output (402, 429, 400…) is released; a 5xx,
          // or a stream lost after dispatch, is uncertain — the rule every
          // metered client shares (closeUnsettledReservation).
          if (seenUsage) await settleExact(seenUsage);
          else {
            await closeUnsettledReservation(usageLedger, reservationUserId, reservation.id, {
              dispatched: providerDisposition !== "not-dispatched", status: upstreamStatus, providerRequestId,
              estimatedCost: uncertainEstimate(),
            });
          }
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
      } else if (clientDisconnected) {
        // Before or after the 200: the caller hung up, the provider did not
        // fail. Reported as unavailable, a runtime that dropped its own stream
        // (a session ended by a refused sibling request, a stopped container)
        // read on the error ledger as a provider outage (2026-09-27).
        sendError(res, gatewayError(499, "model_gateway_client_closed", "The model gateway client disconnected."), onFailure);
      } else if (res.headersSent && !res.writableEnded && !(error instanceof GatewayError)) {
        // The provider's stream broke off after its 200 had been forwarded —
        // a reset or a read that failed mid-answer. It fell to sendError's
        // default and was booked `model_gateway_unavailable`, the code for a
        // gateway that is not configured: every one of the ~500 such rows on
        // the error ledger from 2026-09-04 to 09-27 was this, truncated, never
        // a configuration fault. The call itself is closed as `uncertain`
        // above, which is right: the provider may have billed it.
        sendError(res, gatewayError(502, "model_gateway_upstream_interrupted", "The model provider's stream broke off mid-answer."), onFailure);
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

// Match the review client's never-sent boundary: ambiguous resets or deadlines
// before response headers do not prove that the provider received no request.
const CONTROL_PLANE_NEVER_SENT = /^(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ENETDOWN|EHOSTDOWN|UND_ERR_CONNECT_TIMEOUT|ERR_TLS_\w+|CERT_\w+|UNABLE_TO_\w+|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|ERR_SSL_\w+)$/;

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
 * `call.limits` replaces the account's daily and weekly caps for this one call
 * (0 = none). Absent, the deployment's per-user caps apply as they always
 * have. It exists for background work that carries a budget of its own and is
 * charged to an operator's internal project — the frontier feed, whose daily
 * budget the pipeline reads from this same ledger by purpose: an operator's
 * personal cap must not stop the feed for everyone, and the feed's spend must
 * not be refused by a limit that was set for a person.
 *
 * `call.limits.run` (0 or absent = none) is a cap on what `call.runId` has
 * committed, this call included: the envelope of the unit of work the call is
 * made for, counted over that unit's own rows. A scheduled agenda's next-action
 * decision carries its episode's envelope there; the agenda's own daily and
 * weekly caps are never passed as `daily` and `weekly`, which sum everything
 * the account spent (`autopilotNextAction.mjs`).
 *
 * @param {{ config: any, usageLedger: any, fetchImpl?: typeof fetch }} deps
 * @param {{ userId: string, projectId: string, runId?: string | null, purpose?: string, body: any,
 *           signal?: AbortSignal, at?: Date, limits?: { daily?: number, weekly?: number, run?: number } }} call
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
  // Validate and serialize before any dispatch or reservation. Check again
  // after reservation in case its database await outlived the caller.
  const endpoint = upstreamUrl(config.deepseekBaseUrl, config.production);
  const encodedBody = JSON.stringify(body);
  call.signal?.throwIfAborted();
  let reservation = null;
  /** @type {ReturnType<typeof estimateModelReservation> | null} */
  let estimate = null;
  if (usageLedger) {
    estimate = estimateModelReservation(body, config, at);
    reservation = await usageLedger.reserveModel({
      id: randomUUID(), userId: call.userId, projectId: call.projectId, model: body.model,
      runId: call.runId ?? null, purpose: call.purpose,
      priceVersion: REFERENCE_PRICE_LIST.version, currency: estimate.currency,
      requestFingerprint: createHash("sha256").update(encodedBody).digest("hex"),
      estimatedCost: estimate.cost,
      dailyLimit: call.limits?.daily !== undefined ? Number(call.limits.daily) : Number(config.userDailySpendLimit) || 0,
      weeklyLimit: call.limits?.weekly !== undefined ? Number(call.limits.weekly) : Number(config.userWeeklySpendLimit) || 0,
      runLimit: Number(call.limits?.run) || 0,
      now: at,
    });
  }

  let dispatched = false;
  /** The status of an answer that came back without output, 0 while none has. */
  let refusedStatus = 0;
  try {
    let response;
    try {
      call.signal?.throwIfAborted();
      dispatched = true;
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${config.deepseekApiKey}`,
          "content-type": "application/json",
        },
        body: encodedBody,
        signal: call.signal,
      });
    } catch (error) {
      const networkCode = /** @type {any} */ (error)?.cause?.code ?? /** @type {any} */ (error)?.code;
      if (!call.signal?.aborted && typeof networkCode === "string" && CONTROL_PLANE_NEVER_SENT.test(networkCode)) dispatched = false;
      throw error;
    }
    if (!response.ok) {
      refusedStatus = response.status;
      recordProviderRefusal("deepseek", response.status);
      // The provider's own status rides along: the mapped one folds every
      // server error into 502, and a caller that reports why it got no answer
      // (the routing classifier's `http_<status>`) needs the one that happened.
      // An exhausted balance is named: every call fails until it is topped up.
      throw Object.assign(response.status === 402
        ? gatewayError(mappedUpstreamStatus(402), "model_gateway_payment_required", "The model provider refused the call: its balance is exhausted (HTTP 402).")
        : gatewayError(mappedUpstreamStatus(response.status), "model_gateway_upstream_error", `The model provider returned HTTP ${response.status}.`),
      { upstreamStatus: response.status });
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
    // Still held means the call did not reach a settled end. Refused outright
    // (a 402 from a spent balance, a 429, a 400) or never dispatched is a
    // release; dispatched and then lost is uncertain — the provider may have
    // billed it. Quietly dropping either would leave a reservation counting
    // against the account's cap until the sweep expires it. An error answered
    // before any output (a 5xx) produced none, so it is bounded by its prompt;
    // an answer lost on the way in may have been generated whole, so it keeps
    // its reservation (`uncertainCallCost`).
    if (usageLedger && reservation) {
      try {
        await closeUnsettledReservation(usageLedger, call.userId, reservation.id, {
          dispatched, status: refusedStatus,
          estimatedCost: refusedStatus ? uncertainCallCost(estimate, body.model, at, 0) : null,
        });
      } catch {
        process.stderr.write("usage ledger terminal transition failed; reservation requires reconciliation\n");
      }
    }
  }
}

export const MODEL_GATEWAY_PATH = gatewayPath;
/** The kernel's Messages route (DSH 0.1.7 and later). */
export const MODEL_GATEWAY_MESSAGES_PATH = messagesGatewayPath;
/** The Files API prefix the kernel tries before sending images inline; always refused. */
export const MODEL_GATEWAY_FILES_PREFIX = filesGatewayPrefix;

/**
 * Whether a request path is the model gateway's: either route, or the refused
 * Files prefix — which must reach the gateway to be refused by name rather
 * than fall through to the page server.
 * @param {string} pathname @returns {boolean}
 */
export function isModelGatewayPath(pathname) {
  return pathname === gatewayPath || pathname === messagesGatewayPath
    || pathname === filesGatewayPrefix || pathname.startsWith(`${filesGatewayPrefix}/`);
}
