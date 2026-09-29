/**
 * One delegated child's run, collected and then released.
 *
 * Hidden knowledge: a child the kernel hands back is not finished when its
 * result is. `ctx.subagents.start` resolves with a one-shot `SubagentRun`, and
 * the kernel's contract for it (dsh-subagent at the pinned kernel, `SubagentRun`) is
 * that the holder awaits `result` and must always `dispose()` it: dispose is
 * what stops the child's loop, unregisters the child agent, removes its
 * session from the live store and unwinds its scope. Nothing else does it. The
 * kernel's own `subagent` tool disposes every foreground run after collecting
 * it (`settleForegroundRun`), and every background one after settling it
 * (`settleRun`); this socket started children in two plugins and disposed none
 * of them, so every finished delegation and every screening batch stayed
 * resident in the kernel — agent, live session, scope — until its parent agent
 * was torn down, which for a conversation's root is as long as the runtime
 * keeps that conversation open. Measured on the pinned kernel, booted
 * (2026-09-29): a three-batch screening left three live children behind; with
 * the release it leaves none, and the child's transcript stays on disk.
 *
 * The order is the kernel's, and it is load-bearing: the result first, then
 * the release. `dispose()` on a run whose result has not settled cancels the
 * child (the in-process driver marks it cancelled and disposes its handle), so
 * releasing early would turn a working child into an aborted one. Cancelling a
 * child is what its start signal is for; whoever wants a child stopped aborts
 * that signal, the result settles as `aborted`, and it is released here like
 * any other.
 *
 * Two differences from the kernel's tool, both on purpose. A failed release
 * never replaces the outcome: the kernel's foreground tool throws a dispose
 * error when the result itself was fine, while here the child's work stands —
 * a verdict it returned, a deliverable it submitted — and the failure is handed
 * back beside it for the caller to record. And a run without `dispose` (a test
 * double, a kernel that predates it) is released by doing nothing, the way the
 * rest of this socket treats an optional kernel surface.
 *
 * @module @evimed/dsh-socket/src/subagentRun
 */

import { errorMessage } from './runPolicy.mjs'

/**
 * @typedef {object} SubagentCollection
 * @property {boolean} ok  whether `run.result` fulfilled
 * @property {any} [settled]  the fulfilled value, when it did
 * @property {unknown} [error]  the rejection, when it did not — an
 *   infrastructure fault; a child-level failure fulfils with a stop reason
 * @property {string} [releaseError]  why `dispose()` failed, when it did. A
 *   message, never the outcome: the child's result is above.
 */

/**
 * Await a child's result, then release the child. Never rejects, so a caller
 * collecting a wave of children can await them all and lose none.
 * @param {any} run  what `startSubagent` resolved with
 * @returns {Promise<SubagentCollection>}
 */
export async function collectSubagentRun(run) {
  /** @type {SubagentCollection} */
  let collection
  try {
    collection = { ok: true, settled: await run?.result }
  } catch (error) {
    collection = { ok: false, error }
  }
  const releaseError = await releaseSubagentRun(run)
  return releaseError === null ? collection : { ...collection, releaseError }
}

/**
 * `run.dispose()`, awaited — the kernel's release reaches the child's
 * quiescence before it resolves. Idempotent on the kernel's side.
 * @param {any} run
 * @returns {Promise<string|null>} the failure's message, or null when released
 */
async function releaseSubagentRun(run) {
  if (typeof run?.dispose !== 'function') return null
  try {
    await run.dispose()
    return null
  } catch (error) {
    return errorMessage(error)
  }
}
