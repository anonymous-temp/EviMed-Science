/**
 * `RunTranscript` and `RunEvent` — the control plane's own vocabulary for what
 * a run did.
 *
 * Hidden knowledge: the ledger no longer knows which kernel produced a run.
 * It used to read OpenCode's shapes directly (`message.info.role`,
 * `parts[].state.status`), which meant every kernel change reached into the
 * delivery decision. The adapter now normalizes into these types, and the
 * ledger, the gate and the browser read only these (§14 rule 5, rule 12).
 *
 * The two types answer different questions and are deliberately not one type:
 * a `RunTranscript` is the whole conversation as the gate must read it, a
 * `RunEvent` is one thing that just happened as the browser must render it.
 */

import { TURN_END_KINDS } from './states.mjs'
import { isEviMedToolName } from './toolNames.mjs'

/**
 * @typedef {object} TranscriptToolCall
 * @property {'tool'} type
 * @property {string} tool                 model-visible tool name
 * @property {string} callId
 * @property {'pending'|'completed'|'error'} status
 * @property {Record<string, unknown>} input
 * @property {string} output               model-facing result text
 * @property {{ name: string, code: string } | null} error
 * @property {unknown} [meta]
 */

/**
 * @typedef {object} TranscriptTextPart
 * @property {'text'|'reasoning'} type
 * @property {string} text
 */

/** @typedef {TranscriptToolCall | TranscriptTextPart} TranscriptPart */

/**
 * @typedef {object} TranscriptMessage
 * @property {'user'|'assistant'|'tool'} role
 * @property {'user'|'plugin'|'system'|'subagent'} source
 * @property {number} seq
 * @property {number} time      epoch milliseconds the log recorded it
 * @property {number} turn
 * @property {number} step
 * @property {readonly TranscriptPart[]} parts
 * @property {{ input: number, output: number, cacheHit: number, cacheMiss: number } | null} usage
 * @property {boolean} interrupted
 */

/**
 * @typedef {object} RunTranscript
 * @property {string} sessionId
 * @property {readonly TranscriptMessage[]} messages
 * @property {{ kind: string, code?: string, subCode?: string } | null} turnEnd
 * @property {readonly { sessionId: string, parentSessionId: string, label: string, capability: string }[]} subagents
 * @property {number} lastSeq
 */

/** An empty transcript, so a caller never has to invent one. */
export const EMPTY_TRANSCRIPT = Object.freeze({
  sessionId: '',
  messages: Object.freeze([]),
  turnEnd: null,
  subagents: Object.freeze([]),
  lastSeq: -1,
})

/** @param {unknown} value @returns {value is RunTranscript} */
export function isRunTranscript(value) {
  if (!value || typeof value !== 'object') return false
  const record = /** @type {Record<string, unknown>} */ (value)
  return Array.isArray(record.messages) && typeof record.sessionId === 'string'
}

/**
 * Every tool call in the transcript, flattened. The ledger's progress signal
 * and the gate's "did this run call our tools at all" check both need it.
 * @param {RunTranscript} transcript @returns {TranscriptToolCall[]}
 */
export function toolCalls(transcript) {
  /** @type {TranscriptToolCall[]} */
  const calls = []
  for (const message of transcript.messages) {
    for (const part of message.parts) {
      if (part.type === 'tool') calls.push(part)
    }
  }
  return calls
}

/** @param {RunTranscript} transcript @returns {TranscriptToolCall[]} */
export function eviMedToolCalls(transcript) {
  return toolCalls(transcript).filter((call) => isEviMedToolName(call.tool))
}

/**
 * The progress signal (§7.5). A run that only produced messages is still
 * working; a run that produced neither for the stall window is stuck. Subagent
 * activity counts, because a root agent that delegated and is waiting looks
 * identical to a stuck one from the root transcript alone — that mistake used
 * to kill delegating runs after twenty idle minutes.
 * @param {RunTranscript} transcript
 * @param {{ subagentSteps?: number }} [extra]
 * @returns {{ messages: number, toolCalls: number, subagentSteps: number, signature: string }}
 */
export function progressSignal(transcript, extra = {}) {
  const messages = transcript.messages.length
  const calls = toolCalls(transcript).length
  const subagentSteps = Number(extra.subagentSteps ?? 0) || 0
  return { messages, toolCalls: calls, subagentSteps, signature: `${messages}:${calls}:${subagentSteps}` }
}

/** @param {RunTranscript} transcript @returns {string} */
export function finalAssistantText(transcript) {
  for (let index = transcript.messages.length - 1; index >= 0; index -= 1) {
    const message = transcript.messages[index]
    if (message.role !== 'assistant') continue
    const text = message.parts.filter((part) => part.type === 'text').map((part) => /** @type {TranscriptTextPart} */ (part).text).join('\n').trim()
    if (text) return text
  }
  return ''
}

/** @param {RunTranscript} transcript @returns {number} */
export function totalOutputTokens(transcript) {
  return transcript.messages.reduce((total, message) => total + (message.usage?.output ?? 0), 0)
}

/**
 * The RunEvent union the control plane forwards to the browser (§18.4). The
 * browser exhausts this switch; an unknown variant is counted and shown rather
 * than dropped.
 *
 * @typedef {(
 *   | { type: 'turn/start', seq: number, turn: number }
 *   | { type: 'turn/end', seq: number, turn: number, endKind: string, errorCode?: string, subCode?: string }
 *   | { type: 'step/start', seq: number, turn: number, step: number }
 *   | { type: 'step/end', seq: number, turn: number, step: number }
 *   | { type: 'message/user', seq: number, text: string, source: 'user'|'plugin'|'system'|'subagent' }
 *   | { type: 'message/assistant', seq: number, text: string, reasoning: string, usage: { input: number, output: number, cacheHit: number, cacheMiss: number } | null, interrupted: boolean }
 *   | { type: 'assistant/delta', seq: number, kind: 'text'|'reasoning', text: string }
 *   | { type: 'tool/call', seq: number, callId: string, tool: string, input: Record<string, unknown>, narration: string }
 *   | { type: 'tool/result', seq: number, callId: string, tool: string, status: 'completed'|'error', output: string, errorCode?: string, narration: string, durationMs?: number }
 *   | { type: 'subagent/started', seq: number, childSessionId: string, capability: string, label: string }
 *   | { type: 'workflow/stage', seq: number, runId: string, stage: string, state: string }
 *   | { type: 'compaction', seq: number, replaced: number, estimatedTokens: number }
 *   | { type: 'plan/updated', seq: number, revision: number, deliverableCount: number }
 *   | { type: 'unknown', seq: number, rawType: string }
 * )} RunEvent
 */

/** Every RunEvent discriminator, so the browser's exhaustiveness test can walk them. */
export const RUN_EVENT_TYPES = Object.freeze([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'message/user',
  'message/assistant',
  'assistant/delta',
  'tool/call',
  'tool/result',
  'subagent/started',
  'workflow/stage',
  'compaction',
  'plan/updated',
  'unknown',
])

/** @param {string} kind @returns {string} */
export function normalizeTurnEndKind(kind) {
  const text = String(kind ?? '')
  return TURN_END_KINDS.includes(/** @type {any} */ (text)) ? text : 'unknown'
}
