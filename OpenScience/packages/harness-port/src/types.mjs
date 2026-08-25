/**
 * The port's own type vocabulary.
 *
 * Hidden knowledge: what a harness seam looks like once it has been stripped of
 * the harness. D3 promises that a DSH rename costs one file, and that promise
 * is only true if this package owns the *shapes* as well as the names — a
 * rename table would forward `exec.arguments` straight through, and the day
 * that field becomes `exec.args` every plugin changes. So each conversion
 * function below produces one of these types, and the plugins read nothing else.
 *
 * These are JSDoc typedefs with no runtime cost; the conversion functions in
 * `convert.mjs` are what the contract tests assert against.
 *
 * @module @evimed/harness-port/types
 */

/**
 * One tool invocation, as a plugin sees it.
 * @typedef {object} ToolCall
 * @property {string} callId
 * @property {string} rootCallId
 * @property {string} name
 * @property {Record<string, unknown>} args
 * @property {string} sessionId
 * @property {string} agentId
 * @property {string} cwd
 * @property {AbortSignal} signal
 * @property {boolean} nested            true when a composite tool dispatched it
 */

/**
 * The outcome of a tool call, as an observer sees it.
 * @typedef {object} ToolOutcome
 * @property {'completed'|'error'} status
 * @property {string} text               model-facing result text, flattened
 * @property {unknown} structured        the tool's canonical value when it had one
 * @property {{ name: string, code: string, message: string } | null} error
 * @property {unknown} meta
 */

/**
 * A policy decision on a tool call. `allow` is the default; `deny` is reserved
 * for policy (budget, attempt ceilings, path guard) and never for a business
 * verdict — a rejected deliverable is a return value (§14 rule 14).
 * @typedef {{ allow: true } | { allow: false, code: string, reason: string }} PolicyDecision
 */

/**
 * A decision on entering one step.
 * @typedef {{ allow: true, messages?: readonly InjectedMessage[] } | { allow: false, code: string, reason: string }} StepDecision
 */

/**
 * @typedef {object} StepInfo
 * @property {string} sessionId
 * @property {string} agentId
 * @property {number} turn
 * @property {number} step
 * @property {boolean} first             true for the first pre-step of the session
 * @property {boolean} root              false when the log carries a subagent descriptor
 * @property {string} cwd
 * @property {AbortSignal} signal
 * @property {{ input: number, output: number, cacheHit: number, cacheMiss: number }} usageSoFar
 */

/**
 * Why a turn ended. `unknown` carries the raw kind so a DSH release that adds a
 * variant is a counted unknown, not a silent success.
 * @typedef {{ kind: 'completed'|'aborted'|'blocked'|'error'|'max-tokens'|'interrupted'|'unknown', code?: string, rawKind?: string }} TurnEnd
 */

/**
 * @typedef {object} SessionRef
 * @property {string} sessionId
 * @property {string} cwd
 * @property {string | null} parentSessionId
 * @property {boolean} subagent
 */

/**
 * @typedef {object} SubagentRequest
 * @property {string} capability
 * @property {string} label
 * @property {string} prompt
 * @property {readonly string[]} tools
 * @property {string} persona
 * @property {Record<string, unknown>} outputSchema
 * @property {number} [maxDepth]
 */

/**
 * @typedef {object} SubagentOutcome
 * @property {string} childSessionId
 * @property {'completed'|'error'|'cancelled'|'max-turns'|'unknown'} stopReason
 * @property {string} output
 * @property {unknown} structured
 * @property {string} diagnostic
 */

/**
 * A message injected into the model-visible surface. It becomes a first-class
 * `user/message` with a plugin source, which is what keeps "model-visible" and
 * "logged" the same set (§7.4).
 * @typedef {object} InjectedMessage
 * @property {string} text
 * @property {string} plugin
 */

/**
 * @typedef {object} PromptSection
 * @property {string} name
 * @property {number} order
 * @property {string | (() => string)} text
 */

/**
 * One durable session event, normalized. `raw` is preserved for the trajectory
 * inspector only; nothing else may read it (§18.4).
 * @typedef {object} NormalizedSessionEvent
 * @property {string} type
 * @property {number} seq
 * @property {number} time
 * @property {Record<string, any>} data
 * @property {unknown} raw
 */

export {}
