/**
 * What the operator can see of 「循证进化」's limits (`/api/ops/metrics`).
 *
 * A limit without an observable counter does not exist for the operator (principle 15). Four of them are
 * counted where they act, and this is where they are scraped:
 *  - the tenant tool gateway's admission: calls admitted and refused, by which question refused (host capacity,
 *    the module's budget, a project's calls in flight, a project's calls per minute);
 *  - the platform-skill supply: selections that failed and were allowed to cost nothing, the last verified
 *    generation used instead, and generations found altered and rebuilt;
 *  - the evaluation exclusion layer: run lookups that failed and were ignored, lookups of the module's own
 *    projects that failed, and evaluation requests refused for an unreadable policy; and, beside them, the
 *    development runs whose model named the reference paper from memory (`recalled`: a label, not a limit);
 *  - the candidate executor's slots and timeout, counted in the runtime controller where they act (it exposes no
 *    metrics of its own) and read through its admission endpoint.
 * `open_science_evolution_enabled` is exported with the module off, and `open_science_evolution_refused` says why a
 * module that was switched on is not running.
 */

/** @typedef {{ name: string, help: string, type: string, series: { value: number, labels?: Record<string, string> }[] }} MetricFamily */

/**
 * @param {{ evolution: any, evaluationIsolation?: any, config?: any }} sources
 * @returns {Promise<{ toolAdmission: any, supply: any, isolation: any, executor: any, integration: any } | null>} null when the module is not composed
 */
export async function evolutionOpsSnapshot({ evolution, evaluationIsolation = null }) {
  if (!evolution) return null;
  // The controller is another process; a scrape is never held up by it.
  const executor = typeof evolution.executorCounters === "function"
    ? await Promise.race([evolution.executorCounters().catch(() => null), new Promise((resolve) => { setTimeout(() => resolve(null), 2000).unref(); })])
    : null;
  return {
    toolAdmission: evolution.toolAdmission?.counters ?? null,
    supply: evolution.supply?.status?.() ?? null,
    isolation: evaluationIsolation?.counters ?? null,
    integration: evolution.integration?.counters ?? null,
    executor,
  };
}

/**
 * @param {boolean} composed whether the module is running @param {any} snapshot @param {{ code: string, key: string } | null} [refusal]
 * @returns {MetricFamily[]}
 */
export function evolutionOpsMetricFamilies(composed, snapshot, refusal = null) {
  /** @type {MetricFamily[]} */
  const families = [{
    name: "open_science_evolution_enabled", type: "gauge", series: [{ value: composed ? 1 : 0 }],
    help: "Whether the 循证进化 module is running (0 when it is off, or switched on but refused to start).",
  }];
  if (refusal) families.push({
    name: "open_science_evolution_refused", type: "gauge", series: [{ value: 1, labels: { code: refusal.code, key: refusal.key } }],
    help: "The module was switched on and refused to start because a setting is wrong: the code and the setting's key, never its value.",
  });
  if (!composed || !snapshot) return families;
  const rows = (/** @type {any} */ counters, /** @type {Record<string, string>} */ names) => counters
    ? Object.entries(names).map(([key, outcome]) => ({ value: Number(counters[key]) || 0, labels: { outcome } })) : [];
  if (snapshot.toolAdmission) families.push({
    name: "open_science_evolution_tool_admission_total", type: "counter",
    help: "Calls of a published platform tool by tenants, by whether they were admitted or which question refused them: host capacity, the module's own daily budget, a project's calls in flight, a project's calls in a minute, or too many projects tracked.",
    series: rows(snapshot.toolAdmission, { admitted: "admitted", refusedHostCapacity: "refused_host_capacity", refusedBudget: "refused_budget",
      refusedProjectConcurrency: "refused_project_concurrency", refusedProjectRate: "refused_project_rate", refusedBusy: "refused_busy" }),
  });
  if (snapshot.supply) families.push({
    name: "open_science_evolution_platform_skill_events_total", type: "counter",
    help: "Platform-skill generation problems that were not allowed to stop a runtime start or a dispatch, since process start: failed selections, starts that used the last verified generation instead, and altered generations rebuilt.",
    series: [
      { value: Number(snapshot.supply.failures) || 0, labels: { event: "failed" } },
      { value: Number(snapshot.supply.fallbacks) || 0, labels: { event: "fallback_used" } },
      { value: Number(snapshot.supply.rebuilt) || 0, labels: { event: "generation_rebuilt" } },
    ],
  });
  if (snapshot.isolation) families.push({
    name: "open_science_evolution_isolation_lookup_total", type: "counter",
    help: "Evaluation exclusion layer lookups that went wrong, by outcome: a run lookup that failed and was ignored, a lookup in the module's own other projects that failed and was ignored, and an evaluation request refused for an unreadable policy.",
    series: rows(snapshot.isolation, { runLookupFailed: "run_lookup_failed", platformLookupFailed: "platform_lookup_failed", refused: "refused" }),
  });
  if (snapshot.isolation) families.push({
    name: "open_science_evolution_reference_recalled_total", type: "counter",
    help: "Development runs whose model named the protected reference paper from its own memory, with nothing served to it and no source event that matched it. Recorded and reported with the result; not an exposure, and it does not make a candidate wait.",
    series: [{ value: Number(snapshot.isolation.recalled) || 0 }],
  });
  if (snapshot.integration) families.push({
    name: "open_science_evolution_events_total", type: "counter",
    help: "Observations the other modules published to the evolution queue, by outcome since process start.",
    series: rows(snapshot.integration, { published: "published", failed: "failed" }),
  });
  families.push({
    name: "open_science_evolution_executor_reachable", type: "gauge", series: [{ value: snapshot.executor ? 1 : 0 }],
    help: "Whether the runtime controller answered for the candidate executor's counters on this scrape (0: the executor series below are absent).",
  });
  if (snapshot.executor) families.push({
    name: "open_science_evolution_executor_total", type: "counter",
    help: "Candidate executions and dependency preparations since the runtime controller started, by outcome: ok, candidate_failed (the candidate's own failure), unavailable (no slot or admission lock, an executor blocked by an unconfirmed attempt, or the container daemon failing), timed_out (killed at the execution timeout), canceled (the caller left), errored, and dependencies_prepared / dependency_preparation_failed.",
    series: rows(snapshot.executor, { ok: "ok", candidateFailed: "candidate_failed", unavailable: "unavailable", timedOut: "timed_out", canceled: "canceled",
      errored: "errored", dependenciesPrepared: "dependencies_prepared", dependencyPreparationFailed: "dependency_preparation_failed" }),
  });
  return families;
}
