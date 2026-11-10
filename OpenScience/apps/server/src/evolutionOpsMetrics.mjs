/**
 * What the operator can see of 「循证进化」's limits (`/api/ops/metrics`): a limit without an observable counter does not exist for the operator (principle 15).
 *  - GEO's outbox's aggregate: the signal groups written as a summary or held back below their class's floor;
 *  - the retention pass: how many passes ran, how many failed and how many records past their date it deleted.
 */

/** @typedef {{ name: string, help: string, type: string, series: { value: number, labels?: Record<string, string> }[] }} MetricFamily */

/**
 * @param {{ signals: any, retention: any }} sources the signal store and the retention runner, null where the product ledger is absent
 * @returns {MetricFamily[]}
 */
export function evolutionOpsMetricFamilies({ signals, retention }) {
  /** @type {MetricFamily[]} */
  const families = [];
  if (signals?.counters) families.push({
    name: "open_science_evolution_signal_groups", type: "gauge",
    help: "User-originated signal groups at the last aggregation, by account class (researcher or operator) and outcome: written as a summary because enough different accounts of the class showed it, or held back below the class's floor.",
    series: ["user", "operator"].flatMap((accountClass) => [
      { value: Number(signals.counters.aggregated?.[accountClass]) || 0, labels: { class: accountClass, outcome: "aggregated" } },
      { value: Number(signals.counters.heldBack?.[accountClass]) || 0, labels: { class: accountClass, outcome: "held_back" } },
    ]),
  });
  if (retention?.counters) families.push({
    name: "open_science_evolution_retention_total", type: "counter",
    help: "The daily retention pass since process start: passes that ran, passes that failed, and records past their date deleted (OPEN_SCIENCE_EVOLUTION_SIGNAL_RETENTION_DAYS).",
    series: [{ value: Number(retention.counters.passes) || 0, labels: { outcome: "passes" } }, { value: Number(retention.counters.failed) || 0, labels: { outcome: "failed" } },
      { value: Number(retention.counters.recordsDeleted) || 0, labels: { outcome: "records_deleted" } }],
  });
  return families;
}
