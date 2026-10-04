/**
 * Naming the run of the model calls a native conversation made before its run
 * was known.
 *
 * Hidden knowledge: a turn typed into the kernel's own window has no run until
 * the control plane adopts it, and a subagent's session is unknown until the
 * progress tracker hears of it, so the gateway booked their first calls with no
 * run — a native run's cost read below the ledger's sum for the same session
 * and window (2026-10-04). Each such call kept its kernel session
 * (`UsageLedger.reserveModel`); this fills the run on exactly those rows, for
 * the conversation's own session and every subagent's, since the run began.
 *
 * It runs when the run is adopted and again when it ends — the second catches a
 * call that was reserved while the first sweep ran. A call that belongs to no
 * run (memory extraction, any control-plane call) carries no session and stays
 * where it was, in the account's unattributed group.
 *
 * Isolated by construction: a sweep that did not land costs the run's cost
 * report some calls, never the run, its adoption or its delivery.
 *
 * @module lateUsageAttribution
 */

/** How far before a run's recorded start a call still belongs to it: the kernel
 *  stamps the turn's start a moment after the first request leaves. */
export const LATE_ATTRIBUTION_LEAD_MS = 2_000;

/**
 * `dependencies` is read at call time, not copied: the run store is assigned
 * after the composition root builds this.
 * @param {{ usageLedger: { attributeSession?: (input: any) => Promise<number> } | null,
 *           agentRuns: { childSessionsOf: (project: any, run: any) => Promise<{ sessionId: string }[]> } }} dependencies
 * @returns {(project: any, run: any) => Promise<number>} the sweep: how many calls it named a run for
 */
export function createLateUsageAttribution(dependencies) {
  return async function attributeLateCalls(project, run) {
    const { usageLedger, agentRuns } = dependencies;
    if (!usageLedger || typeof usageLedger.attributeSession !== "function" || !run?.id || !run.sessionId) return 0;
    try {
      const startedAt = Date.parse(String(run.startedAt ?? ""));
      if (!Number.isFinite(startedAt)) return 0;
      const since = new Date(startedAt - LATE_ATTRIBUTION_LEAD_MS);
      const children = await agentRuns.childSessionsOf(project, run).catch(() => []);
      let attributed = 0;
      for (const sessionId of new Set([run.sessionId, ...children.map((child) => child.sessionId)])) {
        attributed += await usageLedger.attributeSession({ userId: project.userId, projectId: project.id, sessionId, runId: run.id, since });
      }
      return attributed;
    } catch {
      // isolated: evimed_usage_late_attribution_failures_total
      return 0;
    }
  };
}
