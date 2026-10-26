/** Optional Poisson-Gamma accrual simulation result readers. */
export const VCR_RISK_APPETITE_QUANTILES = Object.freeze({ aggressive: 0.2, balanced: 0.5, conservative: 0.8 });

/** The measure names the engine writes and this module reads — exactly these. */
export const VCR_ACCRUAL_MEASURES = Object.freeze({ lastPatientIn: "last_patient_in_months", targetEvents: "target_events_months" });

/**
 * Read the engine's answer back: `last_patient_in_months` and, when an event
 * target was given, `target_events_months`, each with its own interval and, for
 * a simulated one, its Monte-Carlo error. `probability_by_month` is a table
 * (`probabilityByMonth` — rows of `{ month, probability }`, given by the caller
 * that has read the stored file).
 *
 * Every interval must name its kind: a forecast's spread is a **prediction**
 * interval, not a confidence interval, and writing 「区间」 alone is how a
 * vendor's 「80% 以上置信度」 gets born. An unnamed interval is dropped and
 * reported as such rather than relabelled.
 * @param {any} result an engine result (`validateEngineResult` shape)
 * @param {{ probabilityByMonth?: readonly { month: number, probability: number }[] | null }} [tables]
 */
export function readAccrualForecast(result, { probabilityByMonth = null } = {}) {
  const measures = Array.isArray(result?.measures) ? result.measures : [];
  /** @type {string[]} */
  const dropped = [];
  const named = measures.filter((measure) => {
    const kind = measure?.interval?.kind;
    if (kind === "prediction") return true;
    dropped.push(String(measure?.name ?? ""));
    return false;
  });
  const by = (/** @type {string} */ name) => named.find((measure) => String(measure?.name ?? "") === name) ?? null;
  return {
    status: String(result?.status ?? ""),
    lastPatientIn: by(VCR_ACCRUAL_MEASURES.lastPatientIn),
    targetEventsReached: by(VCR_ACCRUAL_MEASURES.targetEvents),
    probabilityByMonth: probabilityByMonth ? [...probabilityByMonth] : null,
    quantiles: result?.diagnostics?.quantiles ?? null,
    droppedUnnamedIntervals: dropped,
    // The commitment is a choice of quantile, stated as such wherever it is shown.
    commitments: Object.fromEntries(Object.entries(VCR_RISK_APPETITE_QUANTILES).map(([appetite, quantile]) => [
      appetite, { quantile, note: "承诺的是这一分位数，不是预测更准" },
    ])),
  };
}

/**
 * The stored `probability_by_month` file (`month,probability,mcse`), as rows.
 * @param {string} csv
 */
export function parseProbabilityByMonth(csv) {
  const lines = String(csv ?? "").trim().split(/\r?\n/);
  const header = (lines.shift() ?? "").split(",").map((cell) => cell.replaceAll('"', "").trim());
  const month = header.indexOf("month");
  const probability = header.indexOf("probability");
  if (month < 0 || probability < 0) return [];
  return lines.map((line) => line.split(",")).map((cells) => ({ month: Number(cells[month]), probability: Number(cells[probability]) }))
    .filter((row) => Number.isFinite(row.month) && Number.isFinite(row.probability));
}
