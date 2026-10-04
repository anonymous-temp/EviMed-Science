// The operator's counters for the NCBI Gene Expression Omnibus workflow (`gene_expression_series` /
// `gene_expression_differential`; not 「循证 GEO」, which has `geo*.mjs` of its own).
//
// Principle 15: every limit has a counter, and a limit nobody can see biting is a limit nobody can tune. Six limits
// protect the resources of one computation (matrix and annotation bytes, samples, probes, memory, time). Two are
// enforced here, in the public-source gateway, as the bytes arrive; four only the runtime can see, and its tool
// offers each refusal to the gateway best-effort (`{ geneExpressionLimit: { limit, action } }`), so they land on the
// same counter. A counter is a label: a refusal the runtime could not report is still a refusal the researcher was
// told about, and nothing here may fail a computation or a download.
//
// Module-level like `providerRefusals.mjs` and the credential-missing counts of the gateway: one process, one table,
// read by `/api/ops/metrics`. Every series exists from the start at zero, so the first refusal is an increase that
// `increase()` can see.

import { GENE_EXPRESSION_LIMIT_ACTIONS, GENE_EXPRESSION_LIMIT_NAMES } from "@evimed/domain";

/** The three named downloads, by the kind the runtime asks for. */
export const GENE_EXPRESSION_DOWNLOAD_KINDS = Object.freeze([
  "ncbi-gene-expression-series-matrix",
  "ncbi-gene-expression-series-record",
  "ncbi-gene-expression-platform-record",
]);

/** @type {Map<string, Map<string, number>>} limit -> action -> count */
const limitCounts = new Map(GENE_EXPRESSION_LIMIT_NAMES.map((limit) => [limit, new Map(GENE_EXPRESSION_LIMIT_ACTIONS.map((action) => [action, 0]))]));
/** @type {Map<string, Map<string, number>>} kind -> outcome -> count */
const downloadCounts = new Map(GENE_EXPRESSION_DOWNLOAD_KINDS.map((kind) => [kind, new Map([["served", 0], ["over_limit", 0]])]));

/**
 * One limit observation. An unknown limit or action is ignored, never counted under a made-up label.
 * @param {string} limit @param {string} [action]
 * @returns {boolean} whether it was counted
 */
export function recordGeneExpressionLimit(limit, action = "refused") {
  const byAction = limitCounts.get(limit);
  if (!byAction || !byAction.has(action)) return false;
  byAction.set(action, (byAction.get(action) ?? 0) + 1);
  return true;
}

/** @param {string} kind @param {"served" | "over_limit"} outcome */
export function recordGeneExpressionDownload(kind, outcome) {
  const byOutcome = downloadCounts.get(kind);
  if (byOutcome?.has(outcome)) byOutcome.set(outcome, (byOutcome.get(outcome) ?? 0) + 1);
}

/** The test hook: counters are process state. */
export function resetGeneExpressionMetrics() {
  for (const byAction of limitCounts.values()) for (const action of byAction.keys()) byAction.set(action, 0);
  for (const byOutcome of downloadCounts.values()) for (const outcome of byOutcome.keys()) byOutcome.set(outcome, 0);
}

/**
 * @returns {Array<{ name: string, help: string, type: "counter", series: Array<{ value: number, labels: Record<string, string> }> }>}
 */
export function geneExpressionMetricFamilies() {
  return [
    {
      name: "open_science_gene_expression_limits_total",
      help: "Gene Expression Omnibus inputs refused for passing a resource limit, by limit (matrix_bytes, annotation_bytes, samples, probes, memory, wall_clock) and action.",
      type: "counter",
      series: [...limitCounts].flatMap(([limit, byAction]) => [...byAction].map(([action, value]) => ({ value, labels: { limit, action } }))),
    },
    {
      name: "open_science_gene_expression_downloads_total",
      help: "Gene Expression Omnibus named downloads through the public-source gateway, by kind and outcome (served, or cut at its byte limit).",
      type: "counter",
      series: [...downloadCounts].flatMap(([kind, byOutcome]) => [...byOutcome].map(([outcome, value]) => ({ value, labels: { kind, outcome } }))),
    },
  ];
}
