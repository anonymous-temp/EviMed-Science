/**
 * Evidence ingestion.
 *
 * Hidden knowledge: how far each source actually got. The citation ledger says
 * what the report cited; this table says what the run could actually read. A
 * claim that cites a paper the run only ever saw the abstract of is exactly the
 * gap between the two, and it is invisible in the report alone.
 *
 * It listens on `tools/result`, the read-only observation seam. That choice is
 * the point: a ledger that could change the run it is recording is not a
 * ledger. Failures here are isolated and counted — an ingestion bug must never
 * be able to fail a delivery.
 *
 * @module @evimed/dsh-socket/plugins/evidence
 */

import { mcpToolBaseName } from '@evimed/domain'
import { configSchema, onToolObserved } from '@evimed/harness-port'
import { EVIDENCE_TOOL_BASE_NAMES, evidenceFromOutcome, mergeEvidence } from '../src/evidenceIngest.mjs'
import { advanceEvidence } from '../src/runMirror.mjs'
import { staleEvidence } from '../src/runMirror.mjs'

const Schema = await configSchema()

export const name = 'evimed-evidence'

export const inject = ['tools']

/**
 * @typedef {object} Config
 * @property {number} evidenceStaleMinutes
 */

export const Config = Schema.object({
  // How long a source may sit "asked for but never readable" before it counts
  // against the unresolved metric. A deployment whose upstreams are slower
  // raises it; the control plane owns the value.
  evidenceStaleMinutes: Schema.number().default(10)
    .description('Minutes before a queued source is counted as unresolved. Set by the control plane.'),
})

/**
 * @param {any} ctx
 * @param {Config} config
 * @returns {Promise<void>}
 */
export async function apply(ctx, config) {
  let failures = 0
  /** @type {Map<string, any[]>} */
  const bySession = new Map()

  const digest = (value) => {
    // A stable non-cryptographic id is all a table key needs; the receipt's
    // digests are the ones that must be verifiable, and they are sha256.
    let hash = 2166136261
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
    return (hash >>> 0).toString(16).padStart(8, '0')
  }

  ctx.effect(() => onToolObserved(ctx, (call, outcome) => {
    // isolated: evimed_evidence_ingest_failures_total
    try {
      const store = ctx.get('evimedRun')
      const runId = String(ctx.get('evimedRunId')?.(call.sessionId) ?? call.sessionId)
      const records = evidenceFromOutcome(call, outcome, { runId, now: new Date().toISOString(), digest })
      if (!records.length) {
        // A retrieval tool that produced no evidence row is the one case worth
        // saying out loud. The ledger is what every downstream check reads —
        // quote resolution, provenance, the stale sweep — and an empty one is
        // indistinguishable from a run that retrieved nothing. On the first
        // real end-to-end run eleven full texts sat preserved on disk while
        // this table held zero rows, and nothing anywhere said so.
        //
        // Named parts only, never the payload: this is a diagnostic, and tool
        // results carry source text.
        const base = mcpToolBaseName(call?.name ?? '')
        if (base && EVIDENCE_TOOL_BASE_NAMES.includes(base) && outcome?.status === 'completed') {
          ctx.get('evimedDiagnostics')?.degrade?.(
            `evidence ingest found no source in a completed ${base} result (structured=${outcome?.structured === undefined ? 'absent' : typeof outcome.structured})`,
          )
        }
        return
      }
      const previous = bySession.get(call.sessionId) ?? []
      const merged = mergeEvidence(previous, records)
      bySession.set(call.sessionId, merged)
      if (!store) return
      for (const record of records) void store.evidence.put(record.evidenceId, record)
    } catch (error) {
      failures += 1
      ctx.get('evimedDiagnostics')?.degrade?.(`evidence ingest failed (${failures}): ${error?.message ?? error}`)
    }
  }))

  // A source that was asked for and never became readable is the quietest
  // failure in the system. Sweeping for it turns it into a counted unresolved
  // item instead of an absence nobody looks at.
  const timer = setInterval(() => {
    const store = ctx.get('evimedRun')
    if (!store) return
    for (const [sessionId, records] of bySession.entries()) {
      const stale = staleEvidence(records, config.evidenceStaleMinutes, Date.now())
      if (!stale.length) continue
      const updated = records.map((record) => (stale.includes(record) ? advanceEvidence(record, 'stale') : record))
      bySession.set(sessionId, updated)
      for (const record of updated) void store.evidence.put(record.evidenceId, record)
    }
  }, 60_000)
  if (typeof timer.unref === 'function') timer.unref()
  ctx.effect(() => () => clearInterval(timer))

  ctx.provide('evimedEvidence', {
    /** @param {string} sessionId @returns {any[]} */
    forSession(sessionId) {
      return bySession.get(sessionId) ?? []
    },
    /** @param {string} sessionId @param {number} staleMinutes @returns {number} */
    unresolvedCount(sessionId, staleMinutes = config.evidenceStaleMinutes) {
      const records = bySession.get(sessionId) ?? []
      return staleEvidence(records, staleMinutes, Date.now()).length
    },
  }, true)
}
