// Grading an answer against its key points. The judge only judges; the score is computed here, in code.
import { JUDGE_SYSTEM, judgeUserMessage } from './prompts.mjs'
import { stripMarkers } from './citations.mjs'

const VERDICT_VALUE = Object.freeze({ covered: 1, partial: 0.5, missing: 0 })

/**
 * The judge's reply as one verdict per key point. A point the reply does not mention counts as missing and the reply is flagged.
 * @param {string} content @param {Array<{ id: string }>} keyPoints
 * @returns {{ ok: boolean, malformed: boolean, points: Array<{ id: string, verdict: 'covered' | 'partial' | 'missing', contradicted: boolean }> }}
 */
export function parseJudgement(content, keyPoints) {
  let value
  try { value = JSON.parse(String(content ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '')) } catch { return { ok: false, malformed: true, points: [] } }
  const entries = Array.isArray(value?.points) ? value.points : null
  if (!entries) return { ok: false, malformed: true, points: [] }
  let malformed = false
  const points = keyPoints.map((point, position) => {
    const entry = entries.find((candidate) => candidate?.id === point.id) ?? (entries.length === keyPoints.length ? entries[position] : null)
    const verdict = typeof entry?.verdict === 'string' && entry.verdict in VERDICT_VALUE ? entry.verdict : null
    if (!verdict) malformed = true
    return { id: point.id, verdict: verdict ?? 'missing', contradicted: entry?.contradicted === true }
  })
  return { ok: true, malformed, points }
}

/** Score in [0, 1]: (covered + 0.5 partial) / points, a contradicted point counting as 0. @param {Array<{ verdict: string, contradicted: boolean }>} points */
export function scoreJudgement(points) {
  if (!points.length) return null
  return points.reduce((sum, point) => sum + (point.contradicted ? 0 : (VERDICT_VALUE[point.verdict] ?? 0)), 0) / points.length
}

/**
 * @param {{ llm: { chat: Function }, model: string, question: { question: string, reference: { keyPoints: any[] } }, answer: string, label: string, meta?: Record<string, unknown> }} options
 */
export async function judgeAnswer({ llm, model, question, answer, label, meta = {} }) {
  const keyPoints = question.reference.keyPoints
  const messages = [
    { role: 'system', content: JUDGE_SYSTEM },
    { role: 'user', content: judgeUserMessage({ question: question.question, keyPoints, answer: stripMarkers(answer) }) },
  ]
  let cost = 0
  const tokens = { prompt: 0, completion: 0, calls: 0 }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await llm.chat({ label, model, messages, temperature: 0, thinking: 'disabled', json: true, maxTokens: 700, meta })
    cost += result.cost
    tokens.prompt += result.usage.promptTokens
    tokens.completion += result.usage.completionTokens
    tokens.calls += 1
    const parsed = parseJudgement(result.message.content, keyPoints)
    if (parsed.ok) return { ok: true, malformed: parsed.malformed, points: parsed.points, score: scoreJudgement(parsed.points), cost, tokens }
  }
  return { ok: false, malformed: true, points: [], score: null, cost, tokens }
}
