/**
 * Which turns of a conversation the platform started, and which requests it sent into one.
 *
 * Hidden knowledge: a scheduled task is one conversation that every execution reuses, and the control plane sends each
 * execution's instruction into it as an ordinary user message. The kernel's transcript therefore holds, from the second
 * execution on, the first execution's instruction (and the second's, and so on) as user-role text — the person's own words, as
 * far as the message itself can tell (2026-10-14: the 「每日文献简报」 template became a work habit that way).
 *
 * The control plane knows exactly what it sent: every run it started is recorded with its route, and a message is the platform's
 * when the run it belongs to is one the platform started — by structure, never by any word in it. A message the person types
 * into the same conversation arrives in a run nobody dispatched, and stays theirs. The memory gateway asks which run a captured
 * message belongs to (`memoryAdmission.mjs`) and this is the one decision it applies. (Until 2026-10-25 a second reader, the
 * legacy extraction, asked for the request ids of every dispatched run; it went with that engine.)
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
