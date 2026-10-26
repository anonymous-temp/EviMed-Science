/** Optional Poisson-Gamma design calculations. No recruitment ledger or operational side effects. */
/** @typedef {{ enqueue: (job: any) => Promise<{ jobId: string, state?: string }> }} VcrJobsPort */
export const VCR_RISK_APPETITE_QUANTILES = Object.freeze({ aggressive: 0.2, balanced: 0.5, conservative: 0.8 });

/** A weakly informative Gamma prior on a site's monthly accrual rate, used when there is no history. */
export const VCR_ACCRUAL_PRIOR_DEFAULT = Object.freeze({ alpha: 1, beta: 1 });

/**
 * The conjugate Poisson–Gamma update, done here because it is arithmetic.
 *
 * A site that enrolled 7 patients over 9 open months updates `Gamma(α₀, β₀)` to
 * `Gamma(α₀ + 7, β₀ + 9)`; the posterior mean is the rate the forecast draws
 * from. Months **open**, not months elapsed since the study began — a site
 * activated late has a short denominator, and using the study clock would make
 * every late site look slow (Anisimov & Fedorov 2007).
 *
 * @param {{ enrolled?: number, monthsOpen?: number }} history
 * @param {{ alpha?: number, beta?: number }} [prior]
 */
export function accrualPosterior(history, prior = VCR_ACCRUAL_PRIOR_DEFAULT) {
  const alpha0 = Number(prior?.alpha ?? VCR_ACCRUAL_PRIOR_DEFAULT.alpha);
  const beta0 = Number(prior?.beta ?? VCR_ACCRUAL_PRIOR_DEFAULT.beta);
  const enrolled = Number(history?.enrolled ?? 0);
  const monthsOpen = Number(history?.monthsOpen ?? 0);
  const alpha = alpha0 + (Number.isFinite(enrolled) && enrolled > 0 ? enrolled : 0);
  const beta = beta0 + (Number.isFinite(monthsOpen) && monthsOpen > 0 ? monthsOpen : 0);
  return { alpha, beta, meanRatePerMonth: alpha / beta, source: monthsOpen > 0 ? "site_history" : "prior_only" };
}

/**
 * Hand an explicit statistical scenario to the deterministic engine through the job queue.
 *
 * Dependency-injected on purpose: this module never imports the orchestrator,
 * and a test runs the whole path against a stub. The table the forecast's
 * probabilities are in is asked to be kept (`keepTables`), because it is what a
 * page draws the 「某日前完成的概率」 curve from.
 * @param {{ jobs: VcrJobsPort, studyId: string, userId: string, scenario: any, requestedBy?: string, seed?: number | null,
 *   cpuSecondsLimit?: number, inputs?: readonly any[], idempotencyKey?: string | null }} input
 */
export async function requestAccrualForecast({ jobs, studyId, userId, scenario, requestedBy = "", seed = null, cpuSecondsLimit = 120, inputs = [], idempotencyKey = null }) {
  if (!jobs || typeof jobs.enqueue !== "function") throw new TypeError("requestAccrualForecast needs the jobs port.");
  if (!scenario || !Array.isArray(scenario.sites)) throw new TypeError("requestAccrualForecast needs an accrual scenario (a `sites` list).");
  return jobs.enqueue({
    studyId, userId, kind: "accrual_forecast", scenario, seed, cpuSecondsLimit, inputs: [...inputs], idempotencyKey,
    detail: { origin: requestedBy || "platform", keepTables: ["probability_by_month"] },
  });
}

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
