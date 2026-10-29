// What the replay judge is measured on: of the runs it was shown, how many of the contradictions it found (recall), and — the number that matters, because a
// verdict takes the newer version of a method out — how many of the runs that did NOT contradict it were reported as contradictions (the false-positive rate).
// A contradiction counts only as the module counts it: both quotations found in what was shown (`replayVerdictFrom`).

export const LABELS = Object.freeze(["contradiction", "none"]);

/**
 * Problems with the case file, as sentences; none when it is sound.
 * @param {readonly any[]} cases @returns {string[]}
 */
export function caseIssues(cases) {
  /** @type {string[]} */
  const issues = [];
  const ids = new Set();
  for (const item of cases) {
    if (!item?.id || ids.has(item.id)) issues.push(`${item?.id ?? "?"}: id missing or repeated`);
    ids.add(item?.id);
    if (!LABELS.includes(item?.label)) issues.push(`${item?.id}: label is one of ${LABELS.join(", ")}`);
    if (!["zh", "en"].includes(item?.lang)) issues.push(`${item?.id}: lang is zh or en`);
    if (!item?.method?.name || !item?.method?.body || !String(item.method.body).includes("## Workflow")) issues.push(`${item?.id}: the method needs a name and a body with a workflow`);
    if (!Array.isArray(item?.run?.requests) || !item.run.requests.length) issues.push(`${item?.id}: the accepted run needs at least one request`);
    if (!item?.why || String(item.why).length < 20) issues.push(`${item?.id}: say why`);
  }
  return issues;
}

/**
 * @param {readonly { id: string, gold: string, predicted: string, verdict: string, tag?: string, reason?: string | null }[]} results
 * `predicted` is `contradiction` only for a grounded contradiction; `verdict` is the module's own word (`agreed`, `contradiction`, `unverified`, `failed`).
 */
export function summarize(results) {
  const of = (/** @type {string} */ gold) => results.filter((entry) => entry.gold === gold);
  const contradictions = of("contradiction");
  const clean = of("none");
  const found = contradictions.filter((entry) => entry.predicted === "contradiction");
  const wrong = clean.filter((entry) => entry.predicted === "contradiction");
  const rate = (/** @type {number} */ top, /** @type {number} */ bottom) => (bottom ? Math.round((top / bottom) * 1e4) / 1e4 : null);
  return {
    cases: results.length,
    recall: { found: found.length, of: contradictions.length, rate: rate(found.length, contradictions.length) },
    falsePositive: { wrong: wrong.length, of: clean.length, rate: rate(wrong.length, clean.length), ids: wrong.map((entry) => entry.id) },
    precision: rate(found.length, found.length + wrong.length),
    unverified: results.filter((entry) => entry.verdict === "unverified").length,
    failed: results.filter((entry) => entry.verdict === "failed").length,
    missed: contradictions.filter((entry) => entry.predicted !== "contradiction").map((entry) => ({ id: entry.id, verdict: entry.verdict })),
  };
}

/** @param {ReturnType<typeof summarize>} summary */
export function render(summary) {
  const pct = (/** @type {number | null} */ value) => (value === null ? "n/a" : `${Math.round(value * 100)}%`);
  return [
    `Replay judge on ${summary.cases} case runs`,
    `  contradictions found ${summary.recall.found}/${summary.recall.of} (${pct(summary.recall.rate)})   precision ${pct(summary.precision)}`,
    `  false positives ${summary.falsePositive.wrong}/${summary.falsePositive.of} (${pct(summary.falsePositive.rate)})${summary.falsePositive.ids.length ? `: ${summary.falsePositive.ids.join(", ")}` : ""}`,
    `  answers dropped by code: ${summary.unverified} ungrounded, ${summary.failed} unreadable or failed`,
    ...(summary.missed.length ? [`  missed: ${summary.missed.map((entry) => `${entry.id} (${entry.verdict})`).join(", ")}`] : []),
  ].join("\n");
}
