// Answering one question with `kb_search` over an index, in one of the arms.
import { ARMS, ANSWER_SYSTEM, KB_SEARCH_TOOL } from './prompts.mjs'

export const MAX_TOOL_CALLS = 6
export const TOP_K = 5

/** A search result as the model reads it. @param {string} query @param {Array<{ docId: string, kind: string, title: string, text: string }>} hits */
export function renderHits(query, hits, used, max = MAX_TOOL_CALLS) {
  const header = `Search ${used} of ${max}: "${query}"`
  if (!hits.length) return `${header}\nNo passage matched.`
  const body = hits.map((hit, position) => {
    const label = hit.kind === 'page' ? `Knowledge page: ${hit.title} — page id: ${hit.docId}` : `${hit.title} — document id: ${hit.docId}`
    return `[${position + 1}] ${label}\n${hit.text}`
  })
  return `${header}\n\n${body.join('\n\n')}`
}

/**
 * @param {{ llm: { chat: Function }, model: string, arm: keyof typeof ARMS, question: string, index: { search: Function }, label: string,
 *   temperature?: number, thinking?: 'enabled' | 'disabled', seed?: number, meta?: Record<string, unknown> }} options
 */
export async function answerQuestion({ llm, model, arm, question, index, label, temperature = 0.7, thinking = 'disabled', seed, meta = {} }) {
  const system = `${ANSWER_SYSTEM}${ARMS[arm].systemSuffix}`
  const messages = [{ role: 'system', content: system }, { role: 'user', content: question }]
  const searches = []
  const tokens = { prompt: 0, completion: 0, total: 0, calls: 0 }
  let cost = 0
  let used = 0
  let nudged = false
  let answer = ''
  let finished = false
  for (let turn = 0; turn < MAX_TOOL_CALLS + 4; turn += 1) {
    const exhausted = used >= MAX_TOOL_CALLS
    const result = await llm.chat({
      label, model, messages, temperature, thinking, seed, maxTokens: 3000, meta,
      tools: [KB_SEARCH_TOOL], toolChoice: exhausted ? 'none' : 'auto',
    })
    tokens.prompt += result.usage.promptTokens
    tokens.completion += result.usage.completionTokens
    tokens.total += result.usage.totalTokens
    tokens.calls += 1
    cost += result.cost
    const message = result.message
    const calls = message.tool_calls ?? []
    if (!calls.length) {
      if (!String(message.content ?? '').trim() && !nudged) {
        nudged = true
        messages.push({ role: 'assistant', content: message.content ?? '' }, { role: 'user', content: 'Give your final answer now.' })
        continue
      }
      answer = String(message.content ?? '')
      finished = true
      break
    }
    messages.push({ role: 'assistant', content: message.content ?? '', tool_calls: message.tool_calls, ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}) })
    for (const call of calls) {
      let content
      if (used >= MAX_TOOL_CALLS) {
        content = `The limit of ${MAX_TOOL_CALLS} searches is used up. Answer now from the passages you already have.`
      } else {
        used += 1
        let query = ''
        try { query = String(JSON.parse(call.function?.arguments || '{}').query ?? '').trim() } catch { /* an unreadable call is answered below */ }
        if (!query) content = `Search ${used} of ${MAX_TOOL_CALLS}: kb_search needs a "query" string.`
        else {
          const hits = index.search(query, TOP_K)
          searches.push({ query, hits: hits.map((hit) => ({ id: hit.docId, kind: hit.kind, start: hit.start })) })
          content = renderHits(query, hits, used)
        }
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content })
    }
  }
  return { answer, finished, toolCalls: used, searches, tokens, cost }
}
