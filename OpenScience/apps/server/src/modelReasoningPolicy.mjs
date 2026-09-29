import { HttpError } from "./security.mjs";

export const MODEL_REASONING_EFFORTS = Object.freeze(["off", "low", "high", "max"]);
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CALL_ID = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,199}$/;
const CONTEXT_FIELDS = new Set(["v", "sessionId", "callId", "rootCallId", "provider", "model", "reasoningEffort"]);

/** @param {unknown} value @returns {string} */
export function reasoningEffort(value) {
  if (typeof value !== "string" || !MODEL_REASONING_EFFORTS.includes(value)) {
    throw new HttpError(400, "model_gateway_reasoning_invalid", "Reasoning effort must be off, low, high, or max.");
  }
  return value;
}

/** Validate metadata, never owner identity, credentials, or spending authority.
 * @param {any} value @param {string} model @returns {Record<string, any>} */
export function executionContext(value, model) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.v !== 1
    || Object.keys(value).some(key => !CONTEXT_FIELDS.has(key))
    || typeof value.sessionId !== "string" || !SESSION_ID.test(value.sessionId)
    || typeof value.callId !== "string" || !CALL_ID.test(value.callId)
    || typeof value.rootCallId !== "string" || !CALL_ID.test(value.rootCallId)
    || value.provider !== "deepseek-official" || value.model !== model) {
    throw new HttpError(400, "engine_model_context_invalid", "The engine execution context is invalid.");
  }
  if (value.reasoningEffort !== undefined) reasoningEffort(value.reasoningEffort);
  return { ...value };
}

/** Native choices are request-scoped; engine choices come only from signed claims.
 * @param {Record<string, any>} body @param {'chat'|'messages'} protocol
 * @param {Record<string, any>} config @returns {Record<string, any>} */
export function reasoningFields(body, protocol, config) {
  if (body.thinking !== undefined && (!body.thinking || typeof body.thinking !== "object" || Array.isArray(body.thinking)
    || Object.keys(body.thinking).some(key => key !== "type") || !["enabled", "disabled"].includes(body.thinking.type))) {
    throw new HttpError(400, "model_gateway_reasoning_invalid", "The thinking mode is invalid.");
  }
  if (protocol === "messages" && body.output_config !== undefined && (!body.output_config || typeof body.output_config !== "object"
    || Array.isArray(body.output_config) || Object.keys(body.output_config).some(key => key !== "effort"))) {
    throw new HttpError(400, "model_gateway_reasoning_invalid", "The reasoning configuration is invalid.");
  }
  const requested = protocol === "chat" ? body.reasoning_effort : body.output_config?.effort;
  if (requested !== undefined) reasoningEffort(requested);
  const selected = reasoningEffort(config.modelGatewayTrustedEffort
    ?? (body.thinking?.type === "disabled" ? "off" : requested)
    ?? config.deepseekReasoningEffort ?? "high");
  return { thinking: { type: selected === "off" ? "disabled" : "enabled" },
    ...(protocol === "chat" ? { reasoning_effort: selected === "off" ? undefined : selected }
      : { output_config: selected === "off" ? undefined : { effort: selected } }) };
}
