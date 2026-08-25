/**
 * Shape conversion: DSH's objects in, the port's types out.
 *
 * Hidden knowledge: every field name DSH owns. These functions are the exact
 * assertion targets of the contract tests (§12.2) and of the golden-frame
 * fixtures — the wire protocol carries no version field, so matching method
 * names prove nothing about frame shapes and only a recorded frame replayed
 * through these functions can.
 *
 * They take `unknown` and are defensive on purpose: a malformed frame must land
 * on an explicit unknown, never throw inside an event listener where the throw
 * would be swallowed.
 *
 * @module @evimed/harness-port/convert
 */

import SEAMS from '../seam-manifest.json' with { type: 'json' }

const KNOWN_TURN_END = new Set(SEAMS.turnEndKinds)

/** @param {unknown} value @returns {Record<string, any>} */
function record(value) {
  return value && typeof value === 'object' ? /** @type {Record<string, any>} */ (value) : {}
}

/** @param {unknown} value @returns {string} */
function str(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

/** @param {unknown} value @returns {number} */
function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * Parses the model's raw argument JSON without ever throwing: a model can and
 * does emit malformed JSON, and a policy listener that throws on it takes the
 * whole tool pipeline down.
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
export function toArgs(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return /** @type {Record<string, unknown>} */ (value)
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * @param {unknown} exec  a DSH `ToolExecution` / `ToolDispatchExecution`
 * @returns {import('./types.mjs').ToolCall}
 */
export function toToolCall(exec) {
  const source = record(exec)
  const agent = record(source.agent)
  const session = record(agent.session)
  const header = record(session.header)
  return {
    callId: str(source.callId),
    rootCallId: str(source.rootCallId ?? source.callId),
    name: str(source.name),
    args: toArgs(source.arguments),
    sessionId: str(session.id ?? agent.id),
    agentId: str(agent.id),
    cwd: str(header.cwd),
    signal: source.signal instanceof AbortSignal ? source.signal : AbortSignal.abort(),
    nested: source.parent != null,
  }
}

/**
 * @param {unknown} result  a DSH `ToolExecutionResult`
 * @returns {import('./types.mjs').ToolOutcome}
 */
export function toToolOutcome(result) {
  const source = record(result)
  const error = source.error ? { name: str(record(source.error).name), code: str(record(source.error).code) } : null
  const content = Array.isArray(source.content) ? source.content : []
  const text = content
    .map((block) => (record(block).type === 'text' ? str(record(block).text) : ''))
    .filter(Boolean)
    .join('\n')
  return {
    status: error ? 'error' : 'completed',
    text,
    // Two shapes reach this converter, and it knew one of them. A native DSH
    // tool answers with `value`; an MCP tool proxied by `dsh-mcp-client`
    // answers in the MCP shape, `{ content, structuredContent }`, with no
    // `value` at all. Reading only `value` meant every MCP result arrived here
    // structurally empty — and since all twenty-six research tools are MCP
    // tools, the evidence ledger recorded nothing for any retrieval a run ever
    // made. Eleven preserved full texts sat in the workspace beside a table
    // with zero rows, and the failure was silent by construction: an empty
    // ledger reads exactly like a run that retrieved nothing.
    structured: source.value ?? source.structuredContent,
    error,
    meta: source.meta,
  }
}

/**
 * @param {unknown} event a DSH `turn/end` session event, or its `reason`
 * @returns {import('./types.mjs').TurnEnd}
 */
export function toTurnEnd(event) {
  const source = record(event)
  const reason = record(source.reason ?? record(source.data).reason)
  const kind = str(reason.kind)
  if (!KNOWN_TURN_END.has(kind)) return { kind: 'unknown', rawKind: kind }
  const error = record(reason.error)
  const code = str(error.code)
  return code ? { kind: /** @type {any} */ (kind), code } : { kind: /** @type {any} */ (kind) }
}

/**
 * @param {unknown} session a DSH `Session`
 * @returns {import('./types.mjs').SessionRef}
 */
export function toSessionRef(session) {
  const source = record(session)
  const header = record(source.header)
  return {
    sessionId: str(source.id),
    cwd: str(header.cwd),
    parentSessionId: header.parentSession ? str(header.parentSession) : null,
    subagent: header.origin === 'subagent',
  }
}

/**
 * @param {unknown} payload a DSH `agent/pre-step` payload
 * @param {{ first: boolean, root: boolean, usageSoFar?: { input: number, output: number, cacheHit: number, cacheMiss: number } }} context
 * @returns {import('./types.mjs').StepInfo}
 */
export function toStepInfo(payload, context) {
  const source = record(payload)
  const agent = record(source.agent)
  const session = record(agent.session)
  const header = record(session.header)
  return {
    sessionId: str(session.id ?? agent.id),
    agentId: str(agent.id),
    turn: num(source.turn),
    step: num(source.step),
    first: Boolean(context?.first),
    root: Boolean(context?.root),
    cwd: str(header.cwd),
    signal: source.signal instanceof AbortSignal ? source.signal : AbortSignal.abort(),
    usageSoFar: context?.usageSoFar ?? { input: 0, output: 0, cacheHit: 0, cacheMiss: 0 },
  }
}

/**
 * DeepSeek reports cache hits and misses separately, and the totals matter for
 * both the budget guard and the bill. A provider that reports neither lands on
 * zeros rather than on a guessed split.
 * @param {unknown} usage a DSH `TokenUsage`
 * @returns {{ input: number, output: number, cacheHit: number, cacheMiss: number }}
 */
export function toUsage(usage) {
  const source = record(usage)
  const cacheHit = num(source.promptCacheHitTokens ?? source.prompt_cache_hit_tokens ?? source.cachedInputTokens)
  const cacheMiss = num(source.promptCacheMissTokens ?? source.prompt_cache_miss_tokens)
  const input = num(source.inputTokens ?? source.promptTokens ?? source.prompt_tokens) || cacheHit + cacheMiss
  return {
    input,
    output: num(source.outputTokens ?? source.completionTokens ?? source.completion_tokens),
    cacheHit,
    cacheMiss,
  }
}

/**
 * @param {unknown} run a DSH `SubagentRun` settled result plus its info
 * @returns {import('./types.mjs').SubagentOutcome}
 */
export function toSubagentOutcome(run) {
  const source = record(run)
  const info = record(source.info)
  const result = record(source.result)
  const stopReason = str(result.stopReason)
  const known = ['completed', 'error', 'cancelled', 'max-turns']
  const output = Array.isArray(result.output)
    ? result.output.map((block) => (record(block).type === 'text' ? str(record(block).text) : '')).filter(Boolean).join('\n')
    : str(result.output)
  return {
    childSessionId: str(info.id ?? source.id),
    stopReason: /** @type {any} */ (known.includes(stopReason) ? stopReason : 'unknown'),
    output,
    structured: result.structured,
    diagnostic: str(result.diagnostic),
  }
}

/**
 * @param {unknown} event a DSH `SessionEvent`
 * @returns {import('./types.mjs').NormalizedSessionEvent}
 */
export function toSessionEvent(event) {
  const source = record(event)
  return {
    type: str(source.type),
    seq: num(source.seq),
    time: num(source.time),
    data: record(source.data),
    raw: event,
  }
}

/** Turn-end kinds this build understands, for the startup probe and the tests. */
export const KNOWN_TURN_END_KINDS = Object.freeze([...KNOWN_TURN_END])
