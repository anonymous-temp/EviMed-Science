// A small DeepSeek client (OpenAI-compatible chat completions) that counts what each call costs and refuses to start a call
// the budget cannot cover. The key is read once from the file the caller names and is only ever placed in the request
// header: no log line, ledger entry, thrown message or result carries it.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

/** CNY per million tokens, the platform's reference price list (`packages/domain/src/metering.mjs`, 2026-09-10 rates), at the daytime rate. */
export const PRICES = Object.freeze({
  'deepseek-v4-flash': Object.freeze({ hit: 0.04, miss: 2, output: 8 }),
  'deepseek-v4-pro': Object.freeze({ hit: 0.3, miss: 9, output: 27 }),
})

/** What a call of each kind is assumed to cost at most, to hold back from the budget while it is in flight. */
export const RESERVE_CNY = Object.freeze({ answer: 0.04, judge: 0.03, compile: 0.4, repair: 0.4, sanity: 0.03 })

export class BudgetExceeded extends Error {
  constructor(message) {
    super(message)
    this.name = 'BudgetExceeded'
  }
}

/** @param {string} model @param {{ promptTokens: number, completionTokens: number, hit: number, miss: number }} usage @returns {number} */
export function priceCall(model, usage) {
  const rate = PRICES[model]
  if (!rate) throw new Error(`no price for model ${model}`)
  return (usage.hit * rate.hit + usage.miss * rate.miss + usage.completionTokens * rate.output) / 1_000_000
}

/** @param {any} raw the response's `usage` @returns {{ promptTokens: number, completionTokens: number, hit: number, miss: number, totalTokens: number }} */
export function readUsage(raw) {
  const promptTokens = Number(raw?.prompt_tokens) || 0
  const completionTokens = Number(raw?.completion_tokens) || 0
  const hit = Number(raw?.prompt_cache_hit_tokens)
  const miss = Number(raw?.prompt_cache_miss_tokens)
  const known = Number.isFinite(hit) && Number.isFinite(miss) && hit + miss > 0
  return { promptTokens, completionTokens, hit: known ? hit : 0, miss: known ? miss : promptTokens, totalTokens: promptTokens + completionTokens }
}

/** The key file named by the environment, read into memory. @param {string | undefined} path */
export function readKeyFile(path) {
  if (!path) throw new Error('OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE is not set')
  const key = readFileSync(path, 'utf8').trim()
  if (!key) throw new Error('the DeepSeek key file is empty')
  return key
}

/** @param {string} text @param {string} key */
function redact(text, key) {
  let clean = String(text ?? '')
  if (key) clean = clean.split(key).join('[redacted]')
  return clean.replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
}

/** Spend so far recorded in a ledger file. @param {string | null} path */
export function ledgerTotal(path) {
  if (!path || !existsSync(path)) return 0
  let total = 0
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { total += Number(JSON.parse(line).cost) || 0 } catch { /* a torn last line is not a cost */ }
  }
  return total
}

/**
 * @param {{ apiKey: string, ledgerPath?: string | null, budget: number, baseUrl?: string, fetchImpl?: typeof fetch, retries?: number, sleep?: (ms: number) => Promise<void> }} options
 */
export function createLlm({ apiKey, ledgerPath = null, budget, baseUrl = DEEPSEEK_BASE_URL, fetchImpl = fetch, retries = 4, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  let spent = ledgerTotal(ledgerPath)
  let inflight = 0
  let calls = 0

  /**
   * One chat completion.
   * @param {{ label: string, model: string, messages: any[], temperature?: number, maxTokens?: number, tools?: any[], toolChoice?: string,
   *   json?: boolean, thinking?: 'enabled' | 'disabled', seed?: number, timeoutMs?: number, meta?: Record<string, unknown> }} request
   */
  async function chat(request) {
    const kind = request.label.split(':')[0]
    const reserve = RESERVE_CNY[kind] ?? 0.05
    if (spent + inflight + reserve > budget) throw new BudgetExceeded(`budget of CNY ${budget.toFixed(2)} reached (spent ${spent.toFixed(4)})`)
    inflight += reserve
    try {
      const body = {
        model: request.model,
        messages: request.messages,
        max_tokens: request.maxTokens ?? 2000,
        thinking: { type: request.thinking ?? 'disabled' },
        ...(request.temperature != null ? { temperature: request.temperature } : {}),
        ...(request.tools ? { tools: request.tools, tool_choice: request.toolChoice ?? 'auto' } : {}),
        ...(request.json ? { response_format: { type: 'json_object' } } : {}),
        ...(request.seed != null ? { seed: request.seed } : {}),
      }
      let lastError = null
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        if (attempt > 0) await sleep(Math.min(30_000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 400))
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 180_000)
        try {
          const response = await fetchImpl(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
            body: JSON.stringify(body),
            signal: controller.signal,
          })
          const text = await response.text()
          if (!response.ok) {
            lastError = new Error(`DeepSeek HTTP ${response.status}: ${redact(text, apiKey).slice(0, 300)}`)
            if (response.status === 429 || response.status >= 500) continue
            throw lastError
          }
          const parsed = JSON.parse(text)
          const choice = parsed.choices?.[0]
          if (!choice?.message) { lastError = new Error('DeepSeek answered without a message'); continue }
          const usage = readUsage(parsed.usage)
          const cost = priceCall(request.model, usage)
          spent += cost
          calls += 1
          const entry = { ts: new Date().toISOString(), label: request.label, model: request.model, ...usage, cost: Number(cost.toFixed(6)), cumulative: Number(spent.toFixed(6)), finish: choice.finish_reason, ...request.meta }
          if (ledgerPath) appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`)
          return { message: choice.message, finishReason: choice.finish_reason, usage, cost, model: request.model }
        } catch (error) {
          if (error === lastError) throw error
          lastError = new Error(`DeepSeek request failed: ${redact(error?.name === 'AbortError' ? 'timeout' : error?.message, apiKey)}`)
        } finally {
          clearTimeout(timer)
        }
      }
      throw lastError ?? new Error('DeepSeek request failed')
    } finally {
      inflight -= reserve
    }
  }

  return { chat, get spent() { return spent }, get calls() { return calls }, budget }
}
