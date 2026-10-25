/**
 * Compaction settings and the request-size guard.
 *
 * Compaction itself is the kernel's: the `compaction-basic` row of the preset
 * summarises a region of the conversation when pressure passes a threshold, and
 * nothing of ours replaces or extends it. A summariser of ours that carried the
 * run's durable handles through a compaction (a `structured` policy) was built
 * and measured on the pinned kernel against `basic` on 2026-10-25 - same
 * scripted conversation, three samples an arm - and kept nothing more: survival
 * 100% against 100%, the next answer 3 of 3 against 3 of 3, at one more summary
 * call per compaction (CNY 0.146 against 0.135 a sample, 76 s against 66 s). The
 * rule written before the run said delete, and it was deleted.
 *
 * What this module keeps is the two things the kernel's engine does not know:
 *
 *   1. One derivation of the settings both sides of the container boundary
 *      read - the control plane decides in `OPEN_SCIENCE_RUNTIME_COMPACTION_*`
 *      and forwards `EVIMED_COMPACTION_*`, which the preset rows read - so the
 *      two cannot disagree about what `0.16` means.
 *   2. The request-size guard's measurement and its trigger. Pressure
 *      compaction counts tokens against the declared context window; every
 *      model request leaves the container through the control plane's model
 *      gateway, which counts bytes against its body limit. {@link nextRequestBytes}
 *      estimates what the next step would send and {@link forceCompaction}
 *      asks the kernel's own engine, through its context-overflow path, for one
 *      reduction before the gateway would refuse the request.
 *
 * @module @evimed/harness-port/compaction
 */

import SEAMS from '../seam-manifest.json' with { type: 'json' }

/** Config defaults, recorded from the pinned backend so a change upstream reads
 *  as a diff here rather than as a silently different threshold. Read from
 *  `@deepseek-ai/dsh-compaction-basic@0.1.5-rc.1`. */
export const COMPACTION_DEFAULTS = Object.freeze({
  thresholdRatio: 0.8,
  retainRatio: 0.16,
  maxTokens: 8192,
})

/**
 * Env names per setting, most specific first.
 *
 * Two namespaces because there are two sides of one container boundary: the
 * control plane decides in `OPEN_SCIENCE_RUNTIME_COMPACTION_*` and forwards
 * `EVIMED_COMPACTION_*`, which is what the preset rows read. One derivation
 * function reads both, and {@link compactionRuntimeEnv} produces the forwarded
 * pairs - a knob that is not on the compose env list does nothing and says
 * nothing.
 */
export const COMPACTION_ENV_KEYS = Object.freeze({
  thresholdRatio: Object.freeze(['EVIMED_COMPACTION_THRESHOLD_RATIO', 'OPEN_SCIENCE_RUNTIME_COMPACTION_THRESHOLD_RATIO']),
  retainRatio: Object.freeze(['EVIMED_COMPACTION_RETAIN_RATIO', 'OPEN_SCIENCE_RUNTIME_COMPACTION_RETAIN_RATIO']),
  maxTokens: Object.freeze(['EVIMED_COMPACTION_MAX_TOKENS', 'OPEN_SCIENCE_RUNTIME_COMPACTION_MAX_TOKENS']),
  maxRequestBytes: Object.freeze(['EVIMED_COMPACTION_MAX_REQUEST_BYTES', 'OPEN_SCIENCE_RUNTIME_COMPACTION_MAX_REQUEST_BYTES']),
})

/**
 * The request-size guard's defaults.
 *
 * The token threshold is not the only wall. Every model request leaves the
 * container through the control plane's model gateway, which refuses a body
 * over `OPEN_SCIENCE_MODEL_GATEWAY_MAX_BODY_BYTES` (12 MiB by default, 2 MiB
 * until attached images began travelling inline) with a 413 and no retry — so a run whose context grows faster in bytes than in
 * tokens, or a deployment that declares a larger context window, dies at the
 * gateway before pressure compaction would ever fire (review appendix E §3.1).
 * The guard forces one compaction when the next request would pass a share of
 * that limit; the share leaves room for what the estimate does not count — the
 * system prompt and the provider envelope.
 */
export const REQUEST_BYTES_GUARD = Object.freeze({
  gatewayMaxBodyBytes: 12 * 1024 * 1024,
  ratio: 0.75,
})

/**
 * The compaction settings the control plane derives from its environment and a
 * launched runtime's preset rows read.
 *
 * Invalid values do not throw: each falls back to its default and is named in
 * `invalid`, so a mistyped lever is a notice out here and not a plugin-load
 * failure inside the container.
 *
 * `maxRequestBytes` is ours, not the backend's, and stays out of `config`, the
 * part the kernel's engine reads. Unset, it is {@link REQUEST_BYTES_GUARD}'s
 * share of the gateway's body limit; `0` turns the guard off.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ config: { thresholdRatio: number, retainRatio: number, maxTokens: number }, maxRequestBytes: number, invalid: string[] }}
 */
export function compactionConfigFromEnv(env = {}) {
  /** @type {string[]} */
  const invalid = []
  /** @param {readonly string[]} names @returns {{ name: string, value: string } | null} */
  const read = (names) => {
    for (const name of names) {
      const value = env[name]
      if (typeof value === 'string' && value.trim()) return { name, value: value.trim() }
    }
    return null
  }

  const thresholdRatio = ratio(read(COMPACTION_ENV_KEYS.thresholdRatio), invalid) ?? COMPACTION_DEFAULTS.thresholdRatio
  const retainRatio = ratio(read(COMPACTION_ENV_KEYS.retainRatio), invalid) ?? COMPACTION_DEFAULTS.retainRatio
  const maxTokens = positiveInteger(read(COMPACTION_ENV_KEYS.maxTokens), invalid) ?? COMPACTION_DEFAULTS.maxTokens
  const gatewayMaxBodyBytes = positiveInteger(read(['OPEN_SCIENCE_MODEL_GATEWAY_MAX_BODY_BYTES']), invalid)
    ?? REQUEST_BYTES_GUARD.gatewayMaxBodyBytes
  const maxRequestBytes = nonNegativeInteger(read(COMPACTION_ENV_KEYS.maxRequestBytes), invalid)
    ?? Math.floor(gatewayMaxBodyBytes * REQUEST_BYTES_GUARD.ratio)

  return { config: { thresholdRatio, retainRatio, maxTokens }, maxRequestBytes, invalid }
}

/**
 * The env pairs the control plane must forward into the runtime container,
 * derived from the same function that reads them so a setting cannot exist on
 * one side of the boundary only.
 * @param {{ config: { thresholdRatio: number, retainRatio: number, maxTokens: number }, maxRequestBytes?: number }} derived
 * @returns {Record<string, string>}
 */
export function compactionRuntimeEnv(derived) {
  return {
    EVIMED_COMPACTION_THRESHOLD_RATIO: String(derived.config.thresholdRatio),
    EVIMED_COMPACTION_RETAIN_RATIO: String(derived.config.retainRatio),
    EVIMED_COMPACTION_MAX_TOKENS: String(derived.config.maxTokens),
    EVIMED_COMPACTION_MAX_REQUEST_BYTES: String(derived.maxRequestBytes ?? 0),
  }
}

/** @param {{ name: string, value: string } | null} raw @param {string[]} invalid @returns {number | null} */
function ratio(raw, invalid) {
  if (!raw) return null
  const value = Number(raw.value)
  // The interval the backend's own `assertRatio` enforces. Validating it here
  // turns a plugin-load throw inside the container into a notice out here.
  if (Number.isFinite(value) && value > 0 && value <= 1) return value
  invalid.push(`${raw.name}=${raw.value} (must be a number in (0, 1])`)
  return null
}

/** @param {{ name: string, value: string } | null} raw @param {string[]} invalid @returns {number | null} */
function nonNegativeInteger(raw, invalid) {
  if (!raw) return null
  const value = Number(raw.value)
  if (Number.isSafeInteger(value) && value >= 0) return value
  invalid.push(`${raw.name}=${raw.value} (must be a non-negative integer)`)
  return null
}

/** @param {{ name: string, value: string } | null} raw @param {string[]} invalid @returns {number | null} */
function positiveInteger(raw, invalid) {
  if (!raw) return null
  const value = Number(raw.value)
  if (Number.isSafeInteger(value) && value > 0) return value
  invalid.push(`${raw.name}=${raw.value} (must be a positive integer)`)
  return null
}

/* ------------------------------------------------- the request-size guard */

const utf8 = new TextEncoder()

/**
 * The UTF-8 size of the request an agent's next step would send, estimated
 * from what the kernel holds: its derived message history, the inbox batch
 * the step claims, and the tool schemas of its current request header. The
 * system prompt and the provider envelope are not counted; the guard's share
 * of the gateway limit ({@link REQUEST_BYTES_GUARD}) is the room left for them.
 *
 * The kernel's derived messages are shared, frozen objects it reuses from one
 * step to the next, so each is measured once and remembered by identity: a
 * step pays for the messages it added, not for the whole history again.
 *
 * @param {any} agent
 * @param {readonly any[]} [claimed] the messages this step took from the inbox
 * @param {WeakMap<object, number>} [sizes] sizes already measured, by object
 * @returns {number}
 */
export function nextRequestBytes(agent, claimed = [], sizes = new WeakMap()) {
  const session = agent?.session
  if (typeof session?.deriveMessages !== 'function') return 0
  /** @param {any} value @returns {number} */
  const measure = (value) => {
    if (!value || typeof value !== 'object') return utf8.encode(JSON.stringify(value) ?? '').byteLength
    const known = sizes.get(value)
    if (known !== undefined) return known
    const size = utf8.encode(JSON.stringify(value) ?? '').byteLength
    sizes.set(value, size)
    return size
  }
  let bytes = 0
  for (const message of session.deriveMessages()) bytes += measure(message)
  for (const message of claimed ?? []) bytes += measure(message)
  const tools = session.requestHeader?.()?.tools
  if (Array.isArray(tools)) bytes += measure(tools)
  return bytes
}

/**
 * Force one compaction below the token threshold, through the backend's own
 * context-overflow path: the call the kernel makes when a provider refuses a
 * request as too long, which bypasses the pressure threshold and the retained
 * tail to make one useful reduction. Null when the composition has no
 * compaction service or nothing could be compacted.
 * @param {any} ctx @param {any} agent @param {AbortSignal} signal
 * @returns {Promise<any>}
 */
export async function forceCompaction(ctx, agent, signal) {
  const compaction = ctx?.get?.('compaction') ?? ctx?.compaction
  if (typeof compaction?.compactIfNeeded !== 'function') return null
  return compaction.compactIfNeeded(agent, SEAMS.providers.compaction.triggers[1], signal)
}
