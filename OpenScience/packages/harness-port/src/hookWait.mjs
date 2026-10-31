/**
 * How long a step waits on a plugin's hook before the model is asked.
 *
 * Hidden knowledge: the kernel awaits a turn's first-step hooks (`system-prompt/assemble`,
 * `agent/pre-step`) as plain promises and looks at the turn's abort signal only between
 * them. A hook that never settles holds the step, and the abort with it: on 2026-10-30 an
 * AutoResearchBench turn wrote `turn/start`, spliced its inbox, made no model request for
 * thirty-one minutes, and after the driver's cancel at the twentieth the kernel ended it
 * eleven minutes later - when whatever it waited on gave up by itself. The control plane
 * had marked the run cancelled at once; the kernel's turn had not heard.
 *
 * So the port's two hook wrappers wait on a hook through here:
 *
 * - the turn's abort signal ends the wait (after a second's grace, for a hook that was about to
 *   return), so a cancel is heard whatever a plugin is waiting for;
 * - a wait longer than `softMs` leaves one line naming what is awaited, so the next hang
 *   is visible while it happens and not reconstructed afterwards;
 * - a caller that names a `hardMs` gets its step released at that deadline, to go on
 *   without what the hook would have added (context, a method, a receipt) - a degradation
 *   that is said, never a refusal. Not every hook may be cut: the compaction row waits
 *   for a summary the request cannot be sent without.
 *
 * The abandoned hook is left to settle on its own (a rejection nobody reads is swallowed);
 * what it adds after the step has entered reaches the step after it.
 *
 * @module hookWait
 */

/** After this long a wait is worth a line. */
export const HOOK_SOFT_WAIT_MS = 10_000

/** After a cancel, how long a hook that was about to return is given to do so: its answer is still the step's (tools it narrowed stay narrowed). */
export const HOOK_ABORT_GRACE_MS = 1_000

/**
 * @typedef {'done' | 'deadline' | 'aborted'} HookWaitOutcome
 * @typedef {{ kind: 'slow' | 'deadline' | 'aborted', name: string, ms: number }} HookWaitEvent
 */

/**
 * @template T
 * @param {{
 *   name: string,
 *   work: () => Promise<T> | T,
 *   fallback: T,
 *   signal?: AbortSignal,
 *   softMs?: number,
 *   hardMs?: number,
 *   abortGraceMs?: number,
 *   report?: (event: HookWaitEvent) => void,
 *   now?: () => number,
 * }} options
 * @returns {Promise<{ value: T, outcome: HookWaitOutcome, ms: number }>}
 */
export async function waitOnHook({ name, work, fallback, signal, softMs = HOOK_SOFT_WAIT_MS, hardMs = 0, abortGraceMs = HOOK_ABORT_GRACE_MS, report = () => {}, now = Date.now }) {
  const started = now()
  const elapsed = () => Math.max(0, now() - started)
  if (signal?.aborted) return { value: fallback, outcome: 'aborted', ms: 0 }
  /** @type {ReturnType<typeof setTimeout>[]} */
  const timers = []
  /** @type {() => void} */
  let release = () => {}
  /** @type {Promise<{ value: T, outcome: HookWaitOutcome }>} */
  const released = new Promise((resolve) => {
    release = () => resolve({ value: fallback, outcome: signal?.aborted ? 'aborted' : 'deadline' })
  })
  /** @type {(() => void) | undefined} */
  let onAbort
  try {
    const running = Promise.resolve().then(work).then((value) => ({ value, outcome: /** @type {HookWaitOutcome} */ ('done') }))
    // Whoever abandons the wait does not read what the hook later does.
    running.catch(() => {})
    if (Number.isFinite(softMs) && softMs > 0) timers.push(setTimeout(() => report({ kind: 'slow', name, ms: elapsed() }), softMs))
    if (Number.isFinite(hardMs) && hardMs > 0) timers.push(setTimeout(release, hardMs))
    if (signal) {
      onAbort = () => { if (abortGraceMs > 0) timers.push(setTimeout(release, abortGraceMs)); else release() }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    const settled = await Promise.race([running, released])
    const ms = elapsed()
    if (settled.outcome !== 'done') report({ kind: settled.outcome, name, ms })
    return { ...settled, ms }
  } finally {
    for (const timer of timers) clearTimeout(timer)
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
  }
}
