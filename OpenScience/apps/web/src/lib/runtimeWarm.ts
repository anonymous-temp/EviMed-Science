/**
 * Start a project's research runtime before anyone opens a task in it.
 *
 * Each project runs in its own runtime container, and opening a task in a
 * project whose container is stopped waits for that container to start — the
 * slow first open the owner named on 2026-09-19 (「启动速度也太慢了」). The
 * sidebar calls this when a pointer or the keyboard reaches another project's
 * group, and the project store calls it right after an in-place switch.
 *
 * A no-op here, on purpose: the implementation is the API client's
 * `warmWebRuntime`, and this module becomes a re-export of it when the two
 * branches meet. That implementation also owns the rate — at most one start
 * per project a minute — so callers call it on every hover and never keep a
 * throttle of their own; two throttles would disagree the day one changes.
 * Whatever sits behind this name keeps the contract the callers rely on: fire
 * and forget, never throws, safe to repeat (a running runtime is left alone),
 * quiet on failure — warming is a head start, never a precondition.
 */
export function warmWebRuntime(projectId?: string): void {
  void projectId;
}
