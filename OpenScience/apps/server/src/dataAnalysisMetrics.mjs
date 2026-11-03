// The operator's counters for the data-analysis API's own limits.
//
// Principle 15: every limit has a counter, and a limit nobody can see biting is a limit nobody can tune. Three
// limits protect the resources of the API's input handling and its storage: the inputs a single account may have
// in flight, the inputs the whole server may have in flight (each holds a request body, a decoded copy and the
// bytes being preserved in memory), and the analyses one account may keep. A refusal is a label on a request the
// caller was told about and may repeat; nothing here can fail one that was admitted.
//
// Module-level like `geneExpressionMetrics.mjs`: one process, one table, read by `/api/ops/metrics`. Every series
// exists from the start at zero, so the first refusal is an increase that `increase()` can see.

/** The limits, by the label a refusal is counted under. */
export const DATA_ANALYSIS_REFUSAL_REASONS = Object.freeze(["input_account", "input_server", "analysis_limit"]);

/** @type {Map<string, number>} */
const refusals = new Map(DATA_ANALYSIS_REFUSAL_REASONS.map((reason) => [reason, 0]));

/**
 * One refusal. An unknown reason is ignored, never counted under a made-up label.
 * @param {string} reason @returns {boolean} whether it was counted
 */
export function recordDataAnalysisRefusal(reason) {
  if (!refusals.has(reason)) return false;
  refusals.set(reason, (refusals.get(reason) ?? 0) + 1);
  return true;
}

/** The test hook: counters are process state. */
export function resetDataAnalysisMetrics() {
  for (const reason of refusals.keys()) refusals.set(reason, 0);
}

/**
 * @returns {Array<{ name: string, help: string, type: "counter", series: Array<{ value: number, labels: Record<string, string> }> }>}
 */
export function dataAnalysisMetricFamilies() {
  return [
    {
      name: "open_science_data_analysis_refusals_total",
      help: "Data-analysis API requests refused at one of its own limits, by limit: input_account (one account's inputs in flight), input_server (all inputs in flight on this server), analysis_limit (analyses one account keeps).",
      type: "counter",
      series: [...refusals].map(([reason, value]) => ({ value, labels: { reason } })),
    },
  ];
}
