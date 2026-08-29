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

/** The MCP envelope's payload, or the value itself when it is not one.
 *  @param {unknown} value @returns {unknown} */
function unwrapStructured(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const envelope = /** @type {Record<string, any>} */ (value)
  // `content` plus `structuredContent` is the envelope's signature; a native
  // value carrying both is answering in the MCP vocabulary anyway.
  if (Array.isArray(envelope.content) && 'structuredContent' in envelope) return envelope.structuredContent
  return value
}

/**
 * @param {unknown} result  a DSH `ToolExecutionResult`
 * @returns {import('./types.mjs').ToolOutcome}
 */
export function toToolOutcome(result) {
  const source = record(result)
  // `ToolFailure` is `{ message, info?: { name, code } }` — the routable pair is
  // one level below where the obvious reading puts it, and `isError` (not the
  // presence of `error`) is the declared discriminator. Reading `error.name`
  // and `error.code` directly yielded two empty strings for every failed call:
  // a tool that failed for a reason and a tool that failed for none produced
  // the same record.
  const failure = source.isError === true || source.error != null ? record(source.error) : null
  const info = failure ? record(failure.info) : null
  const error = failure
    ? { name: str(info?.name), code: str(info?.code), message: str(failure.message) }
    : null
  const content = Array.isArray(source.content) ? source.content : []
  const text = content
    .map((block) => (record(block).type === 'text' ? str(record(block).text) : ''))
    .filter(Boolean)
    .join('\n')
  return {
    status: error ? 'error' : 'completed',
    text,
    // One shape, one level deeper than it looks.
    //
    // A tool returns the canonical value its `output.schema` declares, and for
    // an MCP-bridged tool that value IS the MCP result:
    // `{ content, structuredContent }`. So `value` was never missing — the
    // payload is inside it, and reading `value` handed consumers the envelope.
    // `sourcesOf` looked for its keys at the top level, found an envelope, and
    // returned nothing. All twenty-six research tools are MCP tools, so the
    // evidence ledger recorded nothing for any retrieval any run ever made:
    // eleven preserved full texts in the workspace beside a table with zero
    // rows, silent because an empty ledger reads exactly like a run that
    // retrieved nothing.
    //
    // An earlier attempt read `value ?? structuredContent`, which changes
    // nothing at all — `value` is always present. Unwrapping is the fix.
    structured: unwrapStructured(source.value),
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
  // `cacheReadTokens` / `cacheWriteTokens` are what DSH's `TokenUsage`
  // declares. The three spellings behind them are DeepSeek's own API vocabulary
  // and older harness builds, kept because usage also reaches us straight from
  // a provider response in the model gateway's path. Without the first name the
  // cache counters were simply always zero — `inputTokens` and `outputTokens`
  // matched, so the totals looked right and only the cache split was missing,
  // which is the kind of wrong that never announces itself.
  const cacheHit = num(source.cacheReadTokens ?? source.promptCacheHitTokens ?? source.prompt_cache_hit_tokens ?? source.cachedInputTokens)
  const cacheMiss = num(source.cacheWriteTokens ?? source.promptCacheMissTokens ?? source.prompt_cache_miss_tokens)
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
/** @param {unknown} value @returns {boolean} */
function isThenable(value) {
  return Boolean(value) && typeof (/** @type {any} */ (value)?.then) === 'function'
}

/** @param {any} run @param {any} [settled] the awaited `run.result`, when the
 *   caller has it. Optional on purpose: `settled ?? …` below is the whole point
 *   of the parameter, and a caller handing over only the run must get
 *   `stopReason: 'unknown'` rather than a shape read off an unresolved Promise. */
export function toSubagentOutcome(run, settled) {
  const source = record(run)
  // `SubagentRun.result` is a Promise. Reading fields off it yields an empty
  // object, so every delegated child came back `stopReason: 'unknown'` with no
  // output and no structured result — the seam reported nothing about any
  // child, in a shape that looks exactly like a child that produced nothing.
  // The settled value is passed in by the caller, which is the only place that
  // can await it.
  const result = record(settled ?? (isThenable(source.result) ? null : source.result))
  const stopReason = str(result.stopReason)
  // DSH's own vocabulary, from `SubagentStopReasonMap`. `cancelled` and
  // `max-turns` were this package's guesses and match nothing DSH emits, so an
  // aborted or token-capped child read as `unknown` — indistinguishable from a
  // stop reason we had never seen.
  const known = ['completed', 'aborted', 'error', 'max-tokens', 'refusal']
  const output = Array.isArray(result.output)
    ? result.output.map((block) => (record(block).type === 'text' ? str(record(block).text) : '')).filter(Boolean).join('\n')
    : str(result.output)
  return {
    // `SubagentRun` declares `id` directly; there is no `info` on it.
    childSessionId: str(source.id),
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
