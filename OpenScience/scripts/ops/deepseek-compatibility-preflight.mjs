#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OFFICIAL_BASE = "https://api.deepseek.com";
const REQUIRED_MODEL = "deepseek-v4-pro";
const MAX_KEY_BYTES = 8 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOOL_ITERATIONS = 4;

class CompatibilityError extends Error {
  constructor(code) {
    super(`DeepSeek compatibility preflight failed: ${code}`);
    this.code = code;
  }
}

function failure(code) {
  return new CompatibilityError(code);
}

function assertNoSymlinkComponents(file) {
  const full = path.resolve(file);
  let stat;
  try {
    stat = fs.lstatSync(full);
  } catch (error) {
    if (error?.code === "ENOENT") throw failure("deepseek_key_file_missing");
    throw failure("deepseek_key_file_unavailable");
  }
  if (stat.isSymbolicLink()) throw failure("deepseek_key_file_symlink");
  return full;
}

export function readDeepSeekKeyFile(file) {
  if (typeof file !== "string" || !file.trim()) throw failure("deepseek_key_file_missing");
  const target = assertNoSymlinkComponents(file);
  let handle;
  try {
    handle = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(handle);
    if (!stat.isFile()) throw failure("deepseek_key_file_not_regular");
    if (stat.size <= 0 || stat.size > MAX_KEY_BYTES) throw failure("deepseek_key_file_size");
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      throw failure("deepseek_key_file_permissions");
    }
    const value = fs.readFileSync(handle, "utf8").replace(/\r?\n$/, "");
    if (!value || value !== value.trim() || /[\r\n\0]/.test(value)) throw failure("deepseek_key_file_invalid");
    return value;
  } catch (error) {
    if (error instanceof CompatibilityError) throw error;
    if (error?.code === "ELOOP") throw failure("deepseek_key_file_symlink");
    if (error?.code === "ENOENT") throw failure("deepseek_key_file_missing");
    throw failure("deepseek_key_file_unavailable");
  } finally {
    if (handle != null) fs.closeSync(handle);
  }
}

function providerUrl(baseUrl, allowNonOfficialBaseForTests) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw failure("deepseek_base_url_invalid");
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (!allowNonOfficialBaseForTests && url.origin !== OFFICIAL_BASE)
  ) throw failure("deepseek_base_url_invalid");
  url.pathname = "/chat/completions";
  return url;
}

async function readBoundedBody(response, limit) {
  if (!response.body) throw failure("deepseek_provider_response_invalid");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw failure("deepseek_provider_response_too_large");
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function modelBody(model, fields) {
  return {
    model,
    thinking: { type: "enabled" },
    reasoning_effort: "high",
    ...fields,
  };
}

async function providerRequest(context, capability, body, expectedType) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), context.timeoutMs);
  timer.unref?.();
  let response;
  try {
    response = await context.fetchImpl(context.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${context.key}`,
        "content-type": "application/json",
        accept: expectedType,
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: controller.signal,
    });
  } catch {
    if (controller.signal.reason?.name === "TimeoutError") throw failure(`deepseek_${capability}_timeout`);
    throw failure(`deepseek_${capability}_unavailable`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw failure(`deepseek_${capability}_upstream_error`);
  }
  const contentType = String(response.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith(expectedType)) {
    await response.body?.cancel().catch(() => {});
    throw failure(`deepseek_${capability}_response_type`);
  }
  return readBoundedBody(response, context.maxResponseBytes);
}

function parsedAssistant(text, capability) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw failure(`deepseek_${capability}_response_invalid`);
  }
  const message = payload?.choices?.[0]?.message;
  if (message == null || typeof message !== "object" || Array.isArray(message)) {
    throw failure(`deepseek_${capability}_response_invalid`);
  }
  return message;
}

async function baseline(context) {
  const text = await providerRequest(context, "baseline", modelBody(context.model, {
    messages: [{ role: "user", content: "Reply with the single word compatible." }],
    stream: false,
  }), "application/json");
  const message = parsedAssistant(text, "baseline");
  if (typeof message.content !== "string" || !message.content.trim()) throw failure("deepseek_baseline_response_invalid");
}

async function streaming(context) {
  const text = await providerRequest(context, "streaming", modelBody(context.model, {
    messages: [{ role: "user", content: "Reply with the single word compatible." }],
    stream: true,
  }), "text/event-stream");
  let dataFrames = 0;
  let done = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      done = true;
      continue;
    }
    try {
      JSON.parse(data);
      dataFrames += 1;
    } catch {
      throw failure("deepseek_streaming_sse_invalid");
    }
  }
  if (!done || dataFrames < 1) throw failure("deepseek_streaming_sse_invalid");
}

async function toolLoop(context) {
  const messages = [{ role: "user", content: "Call compatibility_probe until two results are available, then finish." }];
  const tools = [{
    type: "function",
    function: {
      name: "compatibility_probe",
      description: "Return one deterministic compatibility result.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  }];
  let completed = 0;
  for (let iteration = 0; iteration < context.maxToolIterations; iteration += 1) {
    const text = await providerRequest(context, "tool_loop", modelBody(context.model, {
      messages,
      tools,
      tool_choice: "auto",
      stream: false,
    }), "application/json");
    const message = parsedAssistant(text, "tool_loop");
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (calls.length > 0) {
      if (completed + calls.length > context.maxToolIterations) {
        throw failure("deepseek_tool_loop_iteration_limit");
      }
      const ids = new Set();
      for (const call of calls) {
        if (
          call?.type !== "function" ||
          call.function?.name !== "compatibility_probe" ||
          typeof call.id !== "string" ||
          !call.id ||
          ids.has(call.id) ||
          typeof call.function.arguments !== "string"
        ) throw failure("deepseek_tool_loop_call_invalid");
        ids.add(call.id);
        try {
          JSON.parse(call.function.arguments);
        } catch {
          throw failure("deepseek_tool_loop_call_invalid");
        }
      }
      messages.push(message);
      for (const call of calls) {
        completed += 1;
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ iteration: completed }) });
      }
      continue;
    }
    if (completed >= 2 && typeof message.content === "string" && message.content.trim()) return;
    throw failure("deepseek_tool_loop_too_short");
  }
  throw failure("deepseek_tool_loop_iteration_limit");
}

async function structuredOutput(context) {
  const text = await providerRequest(context, "structured_output", modelBody(context.model, {
    messages: [{ role: "user", content: "Return a JSON object with compatible set to true." }],
    response_format: { type: "json_object" },
    stream: false,
  }), "application/json");
  const message = parsedAssistant(text, "structured_output");
  if (typeof message.content !== "string") throw failure("deepseek_structured_output_invalid");
  try {
    const value = JSON.parse(message.content);
    if (value == null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
  } catch {
    throw failure("deepseek_structured_output_invalid");
  }
}

/** @param {Record<string, any>} options */
export async function runDeepSeekCompatibility({
  keyFile,
  baseUrl = OFFICIAL_BASE,
  model = REQUIRED_MODEL,
  allowNonOfficialBaseForTests = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  maxToolIterations = DEFAULT_MAX_TOOL_ITERATIONS,
  fetchImpl = fetch,
} = {}) {
  if (model !== REQUIRED_MODEL) throw failure("deepseek_model_invalid");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10 * 60_000) throw failure("deepseek_timeout_invalid");
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 16 * 1024 * 1024) {
    throw failure("deepseek_response_limit_invalid");
  }
  if (!Number.isSafeInteger(maxToolIterations) || maxToolIterations < 3 || maxToolIterations > 8) {
    throw failure("deepseek_tool_iteration_limit_invalid");
  }
  const context = {
    key: readDeepSeekKeyFile(keyFile),
    url: providerUrl(baseUrl, allowNonOfficialBaseForTests),
    model,
    timeoutMs,
    maxResponseBytes,
    maxToolIterations,
    fetchImpl,
  };
  await baseline(context);
  await streaming(context);
  await toolLoop(context);
  await structuredOutput(context);
  return { ok: true, capabilities: ["baseline", "streaming", "tool_loop", "structured_output"] };
}

async function main() {
  try {
    await runDeepSeekCompatibility({
      keyFile: process.env.OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE,
      baseUrl: process.env.OPEN_SCIENCE_DEEPSEEK_BASE_URL || OFFICIAL_BASE,
      model: process.env.OPEN_SCIENCE_DEEPSEEK_MODEL || REQUIRED_MODEL,
      timeoutMs: Number(process.env.OPEN_SCIENCE_DEEPSEEK_COMPATIBILITY_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
      maxResponseBytes: Number(
        process.env.OPEN_SCIENCE_DEEPSEEK_COMPATIBILITY_MAX_RESPONSE_BYTES || DEFAULT_MAX_RESPONSE_BYTES,
      ),
      maxToolIterations: Number(
        process.env.OPEN_SCIENCE_DEEPSEEK_COMPATIBILITY_MAX_TOOL_ITERATIONS || DEFAULT_MAX_TOOL_ITERATIONS,
      ),
    });
    process.stdout.write("DeepSeek compatibility preflight passed.\n");
  } catch (error) {
    const code = error instanceof CompatibilityError ? error.code : "deepseek_preflight_internal_error";
    process.stderr.write(`DeepSeek compatibility preflight failed: ${code}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
