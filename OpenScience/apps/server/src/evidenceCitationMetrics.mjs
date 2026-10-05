// The guardrail of flywheel plan §11 that rule 2 owns: how often a delivered run cites one of EviMed's own evidence
// cards as a source (2026-10-05).
//
// "Platform content cited as evidence" must stay near zero: a card is the platform's reading of sources, and a
// report that cites it has cited the platform to itself. The gate says so to the run and to the reader
// (`platform-card-citation`, an advice-tier finding in no blocking tier); this counter is how an operator sees
// whether the run-side instruction (`frontier_search` returns the primary sources and asks for those) is working.
// A count never changes what a run is told or delivered, and a count that cannot be read costs the scrape one
// series.
//
// Module-level like `evidenceCardMetrics.mjs`: one process, one table, read by `/api/ops/metrics`. A run is counted
// once, the first time the delivery verdict sees its citation: the verdict is rebuilt when a run is evaluated again,
// and a run cited the same card on every evaluation of it.

/** Runs counted, so a second evaluation of the same run adds nothing; bounded, oldest forgotten first. */
const RUNS_REMEMBERED = 5000;
/** @type {Set<string>} */
const counted = new Set();
let total = 0;
let runs = 0;

/**
 * A delivery verdict that carries card citations.
 * @param {string} runId @param {number} citations how many distinct card addresses the verdict named
 */
export function recordPlatformContentCited(runId, citations) {
  if (!(citations > 0) || counted.has(runId)) return;
  if (counted.size >= RUNS_REMEMBERED) counted.delete(/** @type {string} */ (counted.values().next().value));
  counted.add(runId);
  total += citations;
  runs += 1;
}

/** The test hook: counters are process state. */
export function resetPlatformContentCited() {
  counted.clear();
  total = 0;
  runs = 0;
}

/**
 * @returns {Array<{ name: string, help: string, type: "counter", series: Array<{ value: number }> }>}
 */
export function platformContentCitedMetricFamilies() {
  return [
    {
      name: "open_science_evidence_platform_content_cited_total",
      help: "Citations of EviMed's own evidence cards as a source in delivered reports (plan §11, rule 2): the card is an index, and the run was asked to cite its primary sources instead. Watched, not zero-gated.",
      type: "counter",
      series: [{ value: total }],
    },
    {
      name: "open_science_evidence_platform_content_cited_runs_total",
      help: "Runs whose delivery verdict named at least one citation of an EviMed evidence card.",
      type: "counter",
      series: [{ value: runs }],
    },
  ];
}
