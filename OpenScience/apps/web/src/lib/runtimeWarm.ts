/**
 * Start a project's research runtime before anyone opens a task in it.
 *
 * Each project runs in its own runtime container, and opening a task in a
 * project whose container is stopped waits for that container to start — the
 * slow first open the owner named on 2026-09-19 (「启动速度也太慢了」). The
 * sidebar calls this when a pointer or the keyboard reaches another project's
 * group, and the project store calls it right after an in-place switch.
 *
 * The API client's implementation, under the name the sidebar and the store
 * import. It owns the rate — at most one start per project a minute — so
 * callers call it on every hover and keep no throttle of their own: fire and
 * forget, never throws, safe to repeat, quiet on failure — warming is a head
 * start, never a precondition.
 */
export { warmWebRuntime } from "@/lib/apiClient";
