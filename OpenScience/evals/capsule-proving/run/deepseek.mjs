import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

/** First-line diagnostics only; never serialize an error object or HTTP headers. */
export function firstLine(value, secrets = []) {
  let text = String(value?.message ?? value ?? "Unknown error");
  for (const secret of secrets) if (secret) text = text.split(secret).join("[redacted]");
  return text.split(/[\r\n]/, 1)[0]
    .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=].*/gi, "[redacted header]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[\w-]+/g, "[redacted]").slice(0, 1000);
}

/** @param {string} code @param {string} message */
function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

/** @param {any} usage */
export function normalizeUsage(usage = {}) {
  return {
    promptTokens: Number(usage.promptTokens ?? usage.prompt_tokens) || 0,
    completionTokens: Number(usage.completionTokens ?? usage.completion_tokens) || 0,
    cachedTokens: Number(usage.cachedTokens ?? usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens) || 0,
  };
}

/**
 * Minimal non-streaming chat client. A retry count of five means at most six attempts.
 * @param {{keyFile: string, baseURL?: string, model?: string, thinking?: 'disabled'|'enabled',
 * protocol?: 'deepseek'|'openai', fetch?: typeof globalThis.fetch, timeoutMs?: number, maxRetries?: number,
 * backoffMs?: number, sleep?: (ms: number) => Promise<any>}} options
 * @returns {{model: string, thinking: string, redact: (value: any) => string, complete: (request: any) => Promise<any>}}
 */
export function createDeepSeekClient(options) {
  const { keyFile, baseURL = "https://api.deepseek.com", model = "deepseek-flash",
    thinking = "disabled", fetch: fetchImpl = globalThis.fetch, timeoutMs = 120000,
    maxRetries = 5, backoffMs = 500, sleep = delay } = options;
  let key = "";
  const redact = (value) => firstLine(value, [key]);
  return {
    model, thinking, redact,
    async complete({ messages, tools = [], toolChoice, tool_choice }) {
      if (!["enabled", "disabled"].includes(thinking)) throw failure("invalid_thinking", "Unsupported thinking mode");
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw failure("invalid_timeout", "Timeout must be positive");
      if (!key) {
        try { key = (await readFile(keyFile, "utf8")).trim(); }
        catch { throw failure("key_file", "Unable to read API key file"); }
        if (!key) throw failure("key_file", "API key file is empty");
      }
      const body = { model, messages, stream: false, ...(options.protocol === "openai"
        ? { enable_thinking: thinking === "enabled", max_tokens: 8192 } : { thinking: { type: thinking } }) };
      if (tools.length) body.tools = tools;
      const choice = toolChoice ?? tool_choice;
      if (choice !== undefined) body.tool_choice = choice;
      const retryLimit = Math.min(5, Math.max(0, Math.floor(maxRetries) || 0));
      for (let attempt = 0; ; attempt++) {
        const controller = new AbortController();
        let timer;
        let retryable = true;
        try {
          const operation = (async () => {
            const response = await fetchImpl(`${baseURL.replace(/\/+$/, "")}/chat/completions`, {
              method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
              body: JSON.stringify(body), signal: controller.signal,
            });
            retryable = response.status === 429 || response.status >= 500;
            if (!response.ok) {
              let message = `Chat request failed (HTTP ${response.status})`;
              // Read only the API message; do not include the raw response or its headers.
              try { const data = await response.json(); if (typeof data?.error?.message === "string") message = redact(data.error.message); } catch { /* retain status */ }
              throw failure(`http_${response.status}`, message);
            }
            retryable = false;
            let data;
            try { data = await response.json(); }
            catch (error) {
              if (error instanceof SyntaxError) throw failure("invalid_response", "Chat response is not valid JSON");
              retryable = true;
              throw error;
            }
            if (!data?.choices?.[0]?.message) throw failure("invalid_response", "Chat response has no assistant message");
            return { message: data.choices[0].message, usage: normalizeUsage(data.usage), model: data.model ?? model };
          })();
          const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => { reject(failure("timeout", "Chat request timed out")); controller.abort(); }, timeoutMs);
          });
          return await Promise.race([operation, timeout]);
        } catch (error) {
          const code = error?.code === "timeout" ? "timeout" : /^http_\d+$|^invalid_response$/.test(error?.code ?? "") ? error.code : "network";
          if ((!retryable && code !== "timeout") || attempt >= retryLimit) throw failure(code, redact(error));
        } finally { clearTimeout(timer); }
        await sleep(Math.min(30000, backoffMs * 2 ** attempt));
      }
    },
  };
}

/** DashScope's OpenAI format, sharing retry, redaction and tool-call handling with DeepSeek. */
export function createOpenAICompatibleClient(options) {
  return createDeepSeekClient({ ...options, protocol: "openai" });
}
