/** @typedef {{kind: 'stop' | 'continue', scope: 'run' | 'session', targetId: string}} RunAction */

/** Only operations implemented by the control plane are offered; no generic retry or step resume is implied.
 * @param {{id: string, sessionId?: string, status: string, connectorNeeds?: unknown[]}} run
 * @param {boolean} [continuationAvailable]
 * @returns {RunAction[]}
 */
export function availableRunActions(run, continuationAvailable = false) {
  if (run.status === 'running') return [{ kind: 'stop', scope: 'run', targetId: run.id }]
  if (continuationAvailable && run.status === 'succeeded' && run.sessionId && run.connectorNeeds?.length) {
    return [{ kind: 'continue', scope: 'session', targetId: run.sessionId }]
  }
  return []
}

/** No step-scoped operation is implemented yet; each known step explicitly advertises no actions.
 * @param {Array<{id: string}>} steps @returns {Record<string, RunAction[]>}
 */
export function availableRunStepActions(steps) {
  return Object.fromEntries(steps.map(step => [step.id, []]));
}

/** A resumed run no longer carries a present-tense stall warning.
 * @param {{status?: string, lastStallAt?: string | null, lastTrustedProgressAt?: string | null}} run
 */
export function runIsStalled(run) {
  return run.status === 'running' && Boolean(run.lastStallAt)
    && (!run.lastTrustedProgressAt || Date.parse(run.lastStallAt ?? '') >= Date.parse(run.lastTrustedProgressAt))
}
