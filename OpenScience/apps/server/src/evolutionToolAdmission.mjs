import { HttpError } from "./security.mjs";

/**
 * Admission of one tenant's call to a published isolated tool (`evolutionGateway.mjs`).
 *
 * Two questions, answered before the container exists, and neither is held while it runs.
 *
 * Host capacity and the module's own budget are decided in a short transaction: the heavy-work
 * lock is taken, looked at and released with it. It used to be held for the whole execution —
 * `work()` ran inside `database.transaction` — so while one tenant's call ran (up to the 75 s
 * client timeout) every document export, result replay, VCR compute and extension claim on the
 * host waited on `pg_advisory_xact_lock`, each holding one of ten pooled connections, and a run
 * that fanned out eight calls queued eight transactions behind it: the pool was exhausted for
 * every route, session lookups included. The physical serialization of the work is the
 * executor's own slot (`evolutionExecutionMaxConcurrency`), not this lock.
 *
 * What one tenant project may ask is bounded by two keys, so one run's loop cannot queue every
 * other tenant behind it: calls in flight at once (`evolutionToolMaxConcurrentPerProject`) and
 * calls in a minute (`evolutionToolCallsPerMinute`). A refusal is a 429 with a named code; the
 * counters say how often each question refused.
 *
 * @param {{ config: any, database: any, canRun: () => Promise<boolean>, heavyWorkAdmission: (client: any, kind: string) => Promise<boolean>,
 *   isInternalProject: (projectId: string) => boolean, dailyCost: (client: any) => Promise<number>, now?: () => number }} dependencies
 */
export function createEvolutionToolAdmission({ config, database, canRun, heavyWorkAdmission, isInternalProject, dailyCost, now = Date.now }) {
  const counters = { admitted: 0, refusedHostCapacity: 0, refusedBudget: 0, refusedProjectConcurrency: 0, refusedProjectRate: 0, refusedBusy: 0 };
  /** @type {Map<string, number>} */
  const inFlight = new Map();
  /** @type {Map<string, { until: number, count: number }>} */
  const windows = new Map();
  const WINDOW_MS = 60_000;
  /** More projects than this in one window is the table itself being abused; it answers busy rather than growing. */
  const MAX_TRACKED_PROJECTS = 10_000;
  return {
    counters,
    /** @param {{ project: { id: string, userId: string } }} scope @param {() => Promise<any>} work */
    async admit(scope, work) {
      const key = JSON.stringify([scope.project.userId, scope.project.id]);
      const at = now();
      for (const [id, window] of windows) if (window.until <= at) windows.delete(id);
      if (windows.size >= MAX_TRACKED_PROJECTS && !windows.has(key)) {
        counters.refusedBusy += 1;
        throw new HttpError(429, "evolution_tool_rate_limited", "Too many platform tool requests.");
      }
      const window = windows.get(key) ?? { until: at + WINDOW_MS, count: 0 };
      windows.set(key, window);
      if (window.count >= config.evolutionToolCallsPerMinute) {
        counters.refusedProjectRate += 1;
        throw new HttpError(429, "evolution_tool_rate_limited", "Too many platform tool requests from this project.");
      }
      const running = inFlight.get(key) ?? 0;
      if (running >= config.evolutionToolMaxConcurrentPerProject) {
        counters.refusedProjectConcurrency += 1;
        throw new HttpError(429, "evolution_tool_rate_limited", "This project already has platform tool calls running.");
      }
      window.count += 1;
      inFlight.set(key, running + 1);
      try {
        await database.transaction(async (/** @type {any} */ client) => {
          if (!await canRun() || !await heavyWorkAdmission(client, "compute")) {
            counters.refusedHostCapacity += 1;
            throw new HttpError(503, "evolution_temporarily_unavailable", "Execution waits for host capacity.");
          }
          if (isInternalProject(scope.project.id) && await dailyCost(client) >= config.evolutionDailyBudgetCny) {
            counters.refusedBudget += 1;
            throw new HttpError(402, "usage_budget_exceeded", "Evolution reached its own daily budget.");
          }
        });
        counters.admitted += 1;
        return await work();
      } finally {
        const left = (inFlight.get(key) ?? 1) - 1;
        if (left > 0) inFlight.set(key, left); else inFlight.delete(key);
      }
    },
  };
}
