/**
 * Which turns of a conversation the platform started, and which requests it sent into one.
 *
 * Hidden knowledge: a scheduled task is one conversation that every execution reuses, and the control plane sends each
 * execution's instruction into it as an ordinary user message. The kernel's transcript therefore holds, from the second
 * execution on, the first execution's instruction (and the second's, and so on) as user-role text — the person's own words, as
 * far as the message itself can tell. Extraction refused only the current run's dispatch, so on production the first
 * instruction of a daily literature task was read as the person's again at every execution until it had been "observed" often
 * enough to become an active work habit (2026-10-14: the 「每日文献简报」 template as 工作与写作习惯).
 *
 * The control plane knows exactly what it sent: every run it started records the kernel requests that carried its prompt
 * (`kernelRequestIds`), and every message the kernel keeps names the request it came in (`sourceRequestId`). A message is the
 * platform's when its request belongs to a run the platform started — by structure, never by any word in it. A message the
 * person types into the same conversation arrives in a request of its own, in a run nobody dispatched, and stays theirs.
 *
 * The decision is made once, here, for both memory engines: the legacy extraction asks for the request ids
 * (`dispatchedRequestIdsOf`), and the native engine's gateway asks which run a captured message belongs to
 * (`memoryAdmission.mjs`).
 *
 * @module memoryDispatch
 */

/**
 * A run the platform started rather than a person: marked automated at dispatch (a module's step, an evaluation or acceptance
 * harness, a platform job), a scheduled execution or a programme episode and its verification (`autopilot:…`,
 * `autopilot-verify…`), a module's run (`geo:`, `vcr:`), the platform's own work (`platform-…`), or a LoopX continuation.
 * The route reasons are minted by the control plane's dispatchers and never taken from a caller.
 * @param {any} run
 */
export function isPlatformStartedRun(run) {
  if (!run) return false;
  const reason = String(run.effectiveRouteReason ?? run.routeReason ?? "");
  return run.automated === true
    || reason.startsWith("autopilot:") || reason.startsWith("autopilot-verify")
    || reason.startsWith("geo:") || reason.startsWith("vcr:") || reason.startsWith("platform-")
    || reason === "loopx-continuation" || reason.endsWith(":loopx-continuation");
}

/**
 * The kernel requests the platform itself sent into one conversation, across every execution of it.
 * @param {readonly any[] | null | undefined} runs the runs of one conversation, as the ledger folds them
 * @returns {Set<string>}
 */
export function dispatchedRequestIdsOf(runs) {
  /** @type {Set<string>} */
  const ids = new Set();
  for (const run of runs ?? []) {
    if (!isPlatformStartedRun(run)) continue;
    for (const id of Array.isArray(run.kernelRequestIds) ? run.kernelRequestIds : []) if (typeof id === "string" && id) ids.add(id);
  }
  return ids;
}
