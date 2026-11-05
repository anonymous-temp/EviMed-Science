/**
 * What the operator can see of 「循证进化」's limits (`/api/ops/metrics`).
 *
 * A limit without an observable counter does not exist for the operator (principle 15). Each is counted where it acts and scraped here:
 *  - the tenant tool gateway's admission: calls admitted and refused, by which question refused (host capacity, a project's calls in flight, a project's calls per minute);
 *  - the platform-skill supply: selections that failed and were allowed to cost nothing, the last verified generation used instead, and generations found altered and rebuilt;
 *  - the serving worker: what it continued, closed, failed, quarantined and deleted;
 *  - GEO's outbox's aggregate: the signal groups written as a summary or held back below their class's floor;
 *  - the tool executor's slots and timeout, counted in the runtime controller where they act (it exposes no metrics of its own) and read through its admission endpoint.
 * `open_science_evolution_enabled` is exported with the module off, and `open_science_evolution_refused` says why a module that was switched on is not running.
 */

/** @typedef {{ name: string, help: string, type: string, series: { value: number, labels?: Record<string, string> }[] }} MetricFamily */

/**
 * @param {{ evolution: any }} sources
 * @returns {Promise<{ toolAdmission: any, supply: any, executor: any, integration: any, serving: any, signals: any } | null>} null when the module is not composed
 */
export async function evolutionOpsSnapshot({ evolution }) {
  if (!evolution) return null;
  // The controller is another process; a scrape is never held up by it.
  const executor = typeof evolution.executorCounters === "function"
    ? await Promise.race([evolution.executorCounters().catch(() => null), new Promise((resolve) => { setTimeout(() => resolve(null), 2000).unref(); })])
    : null;
  return {
    toolAdmission: evolution.toolAdmission?.counters ?? null,
    supply: evolution.supply?.status?.() ?? null,
    integration: evolution.integration?.counters ?? null,
    serving: evolution.worker?.counters ?? null,
    signals: evolution.signals?.counters ?? null,
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
    help: "Calls of a published platform tool by tenants, by whether they were admitted or which question refused them: host capacity, a project's calls in flight, a project's calls in a minute, or too many projects tracked.",
    series: rows(snapshot.toolAdmission, { admitted: "admitted", refusedHostCapacity: "refused_host_capacity",
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
  if (snapshot.integration) families.push({
    name: "open_science_evolution_events_total", type: "counter",
    help: "Observations the other modules published to the evolution queue, by outcome since process start.",
    series: rows(snapshot.integration, { published: "published", failed: "failed" }),
  });
  if (snapshot.signals) families.push({
    name: "open_science_evolution_signal_groups", type: "gauge",
    help: "User-originated signal groups at the last aggregation, by account class (researcher or operator) and outcome: written as a summary because enough different accounts of the class showed it, or held back below the class's floor.",
    series: ["user", "operator"].flatMap((accountClass) => [
      { value: Number(snapshot.signals.aggregated?.[accountClass]) || 0, labels: { class: accountClass, outcome: "aggregated" } },
      { value: Number(snapshot.signals.heldBack?.[accountClass]) || 0, labels: { class: accountClass, outcome: "held_back" } },
    ]),
  });
  if (snapshot.serving) families.push({
    name: "open_science_evolution_serving_total", type: "counter",
    help: "What the serving worker did since process start: events processed, retired events closed, jobs that failed and of those the terminal ones, retired experimental jobs quarantined, housekeeping passes that failed, and records past their date deleted (OPEN_SCIENCE_EVOLUTION_SIGNAL_RETENTION_DAYS).",
    series: rows(snapshot.serving, { processed: "processed", closed: "closed", failed: "failed", terminal: "terminal", quarantined: "quarantined", housekeepingFailed: "housekeeping_failed", recordsDeleted: "records_deleted" }),
  });
  families.push({
    name: "open_science_evolution_executor_reachable", type: "gauge", series: [{ value: snapshot.executor ? 1 : 0 }],
    help: "Whether the runtime controller answered for the tool executor's counters on this scrape (0: the executor series below are absent).",
  });
  if (snapshot.executor) families.push({
    name: "open_science_evolution_executor_total", type: "counter",
    help: "Candidate executions and dependency preparations since the runtime controller started, by outcome: ok, candidate_failed (the candidate's own failure), unavailable (no slot or admission lock, an executor blocked by an unconfirmed attempt, or the container daemon failing), timed_out (killed at the execution timeout), canceled (the caller left), errored, and dependencies_prepared / dependency_preparation_failed.",
    series: rows(snapshot.executor, { ok: "ok", candidateFailed: "candidate_failed", unavailable: "unavailable", timedOut: "timed_out", canceled: "canceled",
      errored: "errored", dependenciesPrepared: "dependencies_prepared", dependencyPreparationFailed: "dependency_preparation_failed" }),
  });
  return families;
}
