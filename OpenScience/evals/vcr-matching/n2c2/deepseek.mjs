/**
 * A plain `fetch` client for DeepSeek's chat completions, for this evaluation only.
 *
 * - The key is read from the file the caller names, held in a closure, put in the `authorization` header and nowhere else. A
 *   vendor SDK would echo it in its errors; this client builds its own error text and strips the key (and anything shaped like
 *   one) before it is thrown. The request carries no identity header of any kind.
 * - Every call is priced with the platform's reference price list (`priceUsage`, `@evimed/domain`) at the daytime rate, and a
 *   ledger line is appended per attempt that returned usage. The ledger is read back at start, so the budget holds across
 *   runs; a call that the remaining budget could not cover is refused before it is made.
 * - Retries are bounded: a network error, a 429 or 5xx, an answer that is not a JSON object, or one cut off by the token limit
 *   is tried again up to `retries` more times, with a pause, and then the patient is reported failed. Nothing is fabricated.
 *
 * @module n2c2/deepseek
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { priceUsage } from '@evimed/domain';

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const MODEL = 'deepseek-v4-flash';
/** The most this evaluation may spend over all its runs, in CNY. */
export const HARD_BUDGET_CNY = 200;
/** Held back from the budget while a call is in flight: a patient file of 15 000 tokens plus the prompt, at the cache-miss price. */
const RESERVE_CNY = 0.06;

export class BudgetExceeded extends Error {
  constructor(message) { super(message); this.name = 'BudgetExceeded'; }
}

/** @param {string} text @param {string} key */
export function redact(text, key) {
  let clean = String(text ?? '');
  if (key) clean = clean.split(key).join('[redacted]');
  return clean.replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
}

/** @param {string} file */
export function readKey(file) {
  const key = readFileSync(file, 'utf8').trim();
  if (!key) throw new Error('The DeepSeek key file is empty.');
  return key;
}

/** @param {any} raw the response's `usage` */
export function readUsage(raw) {
  const promptTokens = Number(raw?.prompt_tokens) || 0;
  const completionTokens = Number(raw?.completion_tokens) || 0;
  const hit = Number(raw?.prompt_cache_hit_tokens);
  const miss = Number(raw?.prompt_cache_miss_tokens);
  const known = Number.isFinite(hit) && Number.isFinite(miss) && hit + miss > 0;
  return { promptTokens, completionTokens, cacheHit: known ? hit : 0, cacheMiss: known ? miss : promptTokens };
}

/** The reference price of one call, at the daytime rate. @param {{ cacheHit: number, cacheMiss: number, completionTokens: number }} usage */
export function priceOf(usage, model = MODEL) {
  return priceUsage({ resourceType: 'model', model, cacheHit: usage.cacheHit, cacheMiss: usage.cacheMiss, output: usage.completionTokens, peak: true });
}

/** @param {string | null} ledger the spend so far, summed from the ledger file */
export function ledgerTotal(ledger) {
  if (!ledger || !existsSync(ledger)) return 0;
  let total = 0;
  for (const line of readFileSync(ledger, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { total += Number(JSON.parse(line).cost) || 0; } catch { /* a torn last line is not a cost */ }
  }
  return total;
}

/**
 * @param {{ keyFile?: string, key?: string, ledgerPath?: string | null, budget?: number, baseUrl?: string, model?: string,
 *   fetchImpl?: typeof fetch, retries?: number, sleep?: (ms: number) => Promise<void>, timeoutMs?: number, maxTokens?: number }} options
 */
export function createDeepSeek({ keyFile, key: given, ledgerPath = null, budget = HARD_BUDGET_CNY, baseUrl = DEEPSEEK_BASE_URL, model = MODEL,
  fetchImpl = fetch, retries = 2, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), timeoutMs = 240_000, maxTokens = 4000 }) {
  const key = given ?? readKey(String(keyFile));
  let spent = ledgerTotal(ledgerPath);
  let inflight = 0;
  let calls = 0;

  /**
   * One answer for one patient: a parsed JSON object, with what it cost.
   * @param {{ system: string, user: string, label: string }} request
   * @returns {Promise<{ content: string, answer: Record<string, any> | null, unreadable: boolean, usage: ReturnType<typeof readUsage>, cost: number, attempts: number, served: string | null, finishReason: string | null }>}
   */
  async function ask({ system, user, label }) {
    if (spent + inflight + RESERVE_CNY > budget) throw new BudgetExceeded(`The budget of CNY ${budget.toFixed(2)} would be passed (spent ${spent.toFixed(4)}).`);
    inflight += RESERVE_CNY;
    try {
      const body = {
        model, temperature: 0, max_tokens: maxTokens, stream: false,
        thinking: { type: 'disabled' }, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      };
      let lastError = new Error('The request failed.');
      let cost = 0;
      let unreadable = 0;
      /** @type {ReturnType<typeof readUsage>} */
      let total = { promptTokens: 0, completionTokens: 0, cacheHit: 0, cacheMiss: 0 };
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        if (attempt > 0) await sleep(Math.min(20_000, 2000 * 4 ** (attempt - 1)) + Math.floor(Math.random() * 500));
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetchImpl(`${baseUrl}/chat/completions`, {
            method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body), signal: controller.signal,
          });
          const text = await response.text();
          if (!response.ok) {
            lastError = new Error(`DeepSeek HTTP ${response.status}: ${redact(text, key).slice(0, 200)}`);
            if (response.status === 429 || response.status >= 500) continue;
            throw Object.assign(lastError, { final: true });
          }
          const parsed = JSON.parse(text);
          const choice = parsed.choices?.[0];
          const usage = readUsage(parsed.usage);
          const price = priceOf(usage, model).cost;
          spent += price; cost += price; calls += 1;
          total = { promptTokens: total.promptTokens + usage.promptTokens, completionTokens: total.completionTokens + usage.completionTokens,
            cacheHit: total.cacheHit + usage.cacheHit, cacheMiss: total.cacheMiss + usage.cacheMiss };
          if (ledgerPath) appendFileSync(ledgerPath, `${JSON.stringify({ at: new Date().toISOString(), label, model, ...usage, cost: Number(price.toFixed(6)), cumulative: Number(spent.toFixed(6)), finish: choice?.finish_reason ?? null })}\n`);
          if (!choice?.message) { lastError = new Error('DeepSeek answered without a message.'); continue; }
          const content = String(choice.message.content ?? '');
          /** @type {any} */
          let answer = null;
          let readable = choice.finish_reason !== 'length';
          if (readable) {
            try { answer = JSON.parse(content); } catch { readable = false; }
            if (readable && (!answer || typeof answer !== 'object' || Array.isArray(answer))) readable = false;
          }
          if (!readable) {
            // An answer that cannot be read is tried once more, as the model is not exactly repeatable at temperature 0; if it is
            // still unreadable it is the patient's result: a record the reading could not use, whose criteria stay unknown.
            unreadable += 1;
            if (unreadable <= 1 && attempt < retries) { lastError = new Error('The answer could not be read as JSON.'); continue; }
            return { content, answer: null, unreadable: true, usage: total, cost, attempts: attempt + 1, served: typeof parsed.model === 'string' ? parsed.model : null, finishReason: choice.finish_reason ?? null };
          }
          return { content, answer, unreadable: false, usage: total, cost, attempts: attempt + 1, served: typeof parsed.model === 'string' ? parsed.model : null, finishReason: choice.finish_reason ?? null };
        } catch (error) {
          if (/** @type {any} */ (error)?.final) throw error;
          lastError = new Error(`DeepSeek request failed: ${redact(/** @type {any} */ (error)?.name === 'AbortError' ? 'timeout' : /** @type {any} */ (error)?.message, key)}`);
        } finally {
          clearTimeout(timer);
        }
      }
      throw Object.assign(lastError, { cost, usage: total });
    } finally {
      inflight -= RESERVE_CNY;
    }
  }

  return { ask, model, get spent() { return spent; }, get calls() { return calls; }, budget };
}
