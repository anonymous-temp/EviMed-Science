/**
 * The request-size guard of the compaction group.
 *
 * Hidden knowledge: compaction itself is the kernel's. The `compaction-basic`
 * row mounted beside this one summarises a region of the conversation when the
 * token pressure passes its threshold, and nothing of ours replaces, wraps or
 * extends it. A summariser of ours that carried the run's handles through a
 * compaction was built, measured against it on the pinned kernel on 2026-10-25
 * (survival 100% against 100%, the next answer 3 of 3 against 3 of 3, one more
 * summary call per compaction) and deleted. What this row still does is the one
 * thing the kernel's engine cannot know.
 *
 * Pressure compaction counts tokens against the declared context window; every
 * model request leaves the container through the control plane's model
 * gateway, which counts bytes against its body limit and answers a request over
 * it with a 413 the run does not survive. A run whose history grows faster in
 * bytes than in tokens (pasted tables, attached images) therefore dies at the
 * gateway before pressure compaction would ever fire. At each step boundary
 * this row estimates the request the step is about to send and, when it would
 * pass `maxRequestBytes`, asks the kernel's engine for one compaction through
 * its context-overflow path, so the request this step sends is already smaller.
 * It registers no engine and no tool: with the row off, or the limit 0, the
 * kernel's compaction group is exactly as the preset composed it.
 *
 * @module @evimed/dsh-socket/plugins/compaction
 */

import { configSchema, forceCompaction, nextRequestBytes, onPreStep } from '@evimed/harness-port'

const Schema = await configSchema()

export const name = 'evimed-compaction'

/** @type {string[]} The guard reaches the kernel's compaction service by name at step time, so it needs nothing at mount. */
export const inject = []

/**
 * @typedef {object} Config
 * @property {boolean} [enabled]
 * @property {number} maxRequestBytes
 */

export const Config = Schema.object({
  enabled: Schema.boolean().default(true)
    .description('Off registers nothing: no request-size guard; the kernel\'s own compaction group is left as composed (EVIMED_COMPACTION_ENABLED=0).'),
  maxRequestBytes: Schema.number().default(0)
    .description('Estimated request size, in bytes, at which one compaction is forced before the model gateway would refuse the request. 0 turns the guard off.'),
})

/**
 * @param {any} ctx
 * @param {Config} config
 * @returns {void}
 */
export function apply(ctx, config) {
  if (config.enabled === false) return
  const limit = Number(config.maxRequestBytes ?? 0)
  if (Number.isSafeInteger(limit) && limit > 0) ctx.effect(() => guardRequestBytes(ctx, limit))
}

/**
 * Force one compaction when the next request would pass the byte limit.
 *
 * Measured at the step boundary, where the kernel's own pressure check runs, so
 * a compaction here changes the request this step sends. A history that could
 * not be compacted is not tried again until it has grown.
 * @param {any} ctx @param {number} limit
 * @returns {() => void}
 */
export function guardRequestBytes(ctx, limit) {
  /** @type {WeakMap<object, number>} */
  const sizes = new WeakMap()
  /** @type {WeakMap<object, number>} the size at the last attempt that compacted nothing */
  const stuckAt = new WeakMap()
  return onPreStep(ctx, async (_step, payload) => {
    const agent = payload?.agent
    const signal = payload?.signal
    if (!agent || signal?.aborted) return { allow: true }
    const claimed = Array.isArray(payload?.messages) ? payload.messages : []
    const bytes = nextRequestBytes(agent, claimed, sizes)
    if (bytes < limit || bytes <= (stuckAt.get(agent) ?? 0)) return { allow: true }
    const diagnostics = ctx.get('evimedDiagnostics')?.forSession?.(sessionKey(agent)) ?? ctx.get('evimedDiagnostics')
    try {
      const result = await forceCompaction(ctx, agent, signal)
      const after = nextRequestBytes(agent, claimed, sizes)
      if (result === null || after >= bytes) stuckAt.set(agent, after)
      else stuckAt.delete(agent)
      diagnostics?.degrade?.(result === null
        ? `request size ${bytes} bytes passed the compaction byte limit ${limit} and nothing could be compacted`
        : `request size ${bytes} bytes passed the compaction byte limit ${limit}; compacted to ${after} bytes before the model gateway could refuse it`)
    } catch (error) {
      stuckAt.set(agent, bytes)
      diagnostics?.degrade?.(`request size ${bytes} bytes passed the compaction byte limit ${limit}; the forced compaction failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { allow: true }
  }, () => ({ first: false, root: false }))
}

/** The session an agent belongs to, as a diagnostics key.
 *  @param {any} source @returns {string} */
export function sessionKey(source) {
  const session = source?.session ?? source?.agent?.session ?? source
  const id = session?.id ?? session?.sessionId
  return typeof id === 'string' && id ? id : ''
}
