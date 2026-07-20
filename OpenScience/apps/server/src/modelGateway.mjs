const gatewayPath = "/internal/model/v1/chat/completions";
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

function sendError(res, error) {
  if (res.headersSent || res.destroyed) {
    if (!res.destroyed) res.destroy();
    return;
  }
  const status = Number.isSafeInteger(error?.status) ? error.status : 502;
  const code = typeof error?.code === "string" ? error.code : "model_gateway_unavailable";
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
  if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 256) {
    throw gatewayError(400, "model_gateway_messages_invalid", "The model request must contain 1 to 256 messages.");
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
  if (body.stream_options != null) {
    const options = assertPlainObject(body.stream_options, "model_gateway_field_invalid", "stream_options must be an object.");
    if (Object.keys(options).some((key) => key !== "include_usage") || (options.include_usage != null && typeof options.include_usage !== "boolean")) {
      throw gatewayError(400, "model_gateway_field_invalid", "stream_options contains an unsupported field.");
    }
  }
  return {
    ...body,
    model: config.deepseekModel,
    thinking: { type: "enabled" },
    reasoning_effort: "high",
    stream: body.stream === true,
  };
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

export async function pipeModelGatewayBody(body, res, signal, maxBytes) {
  const reader = body.getReader();
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
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

export function createModelGatewayHandler(config, runtimeManager, { fetchImpl = fetch } = {}) {
  return async function modelGatewayHandler(req, res) {
    if (req.method !== "POST" || new URL(req.url ?? "/", "http://localhost").pathname !== gatewayPath) {
      sendError(res, gatewayError(404, "not_found", "Not found."));
      return;
    }
    const abortController = new AbortController();
    const timeoutMs = Math.max(1, Number(config.modelGatewayTimeoutMs) || 300_000);
    const timeout = setTimeout(() => abortController.abort(new DOMException("Model gateway timed out.", "TimeoutError")), timeoutMs);
    timeout.unref?.();
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
      try {
        runtimeManager.assertActiveModelGatewayToken(token);
      } catch {
        throw gatewayError(401, "model_gateway_token_invalid", "Model gateway authentication failed.");
      }
      const body = await readJsonBody(req, Math.max(1024, Number(config.modelGatewayMaxBodyBytes) || 1024 * 1024));
      const normalized = normalizedRequest(body, config);
      let upstream;
      try {
        upstream = await fetchImpl(upstreamUrl(config.deepseekBaseUrl, config.production), {
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
        await upstream.body?.cancel().catch(() => {});
        throw gatewayError(
          mappedUpstreamStatus(upstream.status),
          upstream.status === 429 ? "model_gateway_rate_limited" : "model_gateway_upstream_error",
          upstream.status === 429
            ? "The model provider rate limit was reached."
            : "The model provider rejected the request.",
        );
      }
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
      await pipeModelGatewayBody(upstream.body, res, abortController.signal, responseLimit);
    } catch (error) {
      const abortReason = abortController.signal.reason;
      const clientDisconnected = abortController.signal.aborted && abortReason?.name === "AbortError";
      if (abortReason?.name === "TimeoutError") {
        sendError(res, gatewayError(504, "model_gateway_timeout", "The model gateway request timed out."));
      } else if (clientDisconnected && !res.headersSent) {
        sendError(res, gatewayError(499, "model_gateway_client_closed", "The model gateway client disconnected."));
      } else {
        sendError(res, error);
      }
      if (!abortController.signal.aborted) {
        abortController.abort(error instanceof Error ? error : new Error("Model gateway failed."));
      }
    } finally {
      clearTimeout(timeout);
      req.off("aborted", onAborted);
      res.off("close", onResponseClose);
    }
  };
}

export const MODEL_GATEWAY_PATH = gatewayPath;
