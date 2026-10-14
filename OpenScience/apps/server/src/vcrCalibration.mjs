/**
 * The virtual patients set beside what the study said they should be: for each number the scenario declared (the control arm's
 * median, the hazard ratio, the rates), the number the generated table actually has, and the interval the evidence gives for it —
 * with the ones that fall outside the interval marked (R3, 2026-10-14).
 *
 * Hidden knowledge:
 *
 * - **Code computes, the model does not.** The generated numbers are read off the table (`outcomeStatistics`: Kaplan–Meier medians,
 *   Cox's hazard ratio, rates, means); the declared ones are what the job was told (`jobs.scenario`, the frozen scenario the
 *   engine ran); the interval is the card's own — the prediction interval of a pooled estimate first, the declared range after it.
 * - **Outside the interval is a mark, not a verdict.** A generated number outside the evidence is something to look at (the
 *   scenario is not what the literature says, or the sample was small); the page marks it and the person decides. A row with no
 *   interval has nothing to be outside of: its status is `unknown`, never `within`.
 * - **A row exists only for what is both declared and generated.** A scenario that stated no control median has no such row; the
 *   event rate, which no scenario states, is generated-only.
 *
 * @module vcrCalibration
 */

import { VCR_ASSUMPTION_BINDINGS } from "./vcrOrchestrator.mjs";

/** @param {unknown} value @returns {Record<string, any>} */
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
/** @param {unknown} value @returns {number | null} */
const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
/** @param {number | null} value */
const sig4 = (value) => (value === null ? null : value === 0 ? 0 : Number(value.toPrecision(4)));

/** The words of each calibrated number, by endpoint. */
const ROW_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({
  control_median: "对照组中位时间", hazard_ratio: "风险比", event_rate: "事件发生率",
  control_rate: "对照组发生率", treatment_rate: "试验组发生率", effect: "组间均值差", sd: "结局标准差",
}));

/**
 * The card a declared parameter was taken from, by the same rules the scenario was bound with (`VCR_ASSUMPTION_BINDINGS`): the last
 * card of the study whose key matches the rule for this endpoint and path wins, as it does when the scenario is bound.
 * @param {readonly Record<string, any>[]} cards @param {string} endpoint @param {string} path
 */
function cardFor(cards, endpoint, path) {
  const rule = VCR_ASSUMPTION_BINDINGS.find((entry) => entry.endpoint === endpoint && entry.path.join(".") === path);
  if (!rule) return null;
  return [...cards].reverse().find((card) => rule.match.test(String(card?.key))) ?? null;
}

/**
 * The interval the evidence gives for a card's value: the prediction interval of the pooled estimate (the design is the next study,
 * not the average of the past ones), else the range its distribution declared.
 * @param {Record<string, any> | null} card
 * @returns {{ low: number, high: number, kind: "prediction" | "range" } | null}
 */
function evidenceIntervalOf(card) {
  if (!card) return null;
  const prediction = object(object(card.pooling).predictionInterval);
  const range = object(object(card.distribution).range);
  /** @param {Record<string, any>} bounds @param {"prediction" | "range"} kind */
  const of = (bounds, kind) => ({ low: /** @type {number} */ (sig4(Number(bounds.low))), high: /** @type {number} */ (sig4(Number(bounds.high))), kind });
  if (finite(prediction.low) !== null && finite(prediction.high) !== null) return of(prediction, "prediction");
  if (finite(range.low) !== null && finite(range.high) !== null) return of(range, "range");
  return null;
}

/**
 * @param {{ statistics: Record<string, any> | null, scenario?: Record<string, any> | null, cards?: readonly Record<string, any>[],
 *   unitWord?: ((card: Record<string, any> | null) => string | null) | null }} input
 *   `statistics`: `outcomeStatistics` of the table; `scenario`: the frozen scenario of the job that made it; `cards`: the study's
 *   assumption cards, newest version of each; `unitWord`: how a card's unit is said to a person
 * @returns {{ endpoint: string, rows: Array<{ key: string, label: string, unit: string | null, declared: number | null, generated: number | null,
 *   difference: number | null, interval: { low: number, high: number, kind: string } | null, status: "within" | "outside" | "unknown" }>,
 *   arms: Array<{ value: string, label: string, n: number, events?: number | null }> } | null}
 */
export function vcrCalibration({ statistics, scenario = null, cards = [], unitWord = null }) {
  if (!statistics) return null;
  const truth = object(object(scenario).truth);
  const endpoint = String(statistics.endpoint);
  const unitOf = (/** @type {Record<string, any> | null} */ card) => (unitWord ? unitWord(card) : null);
  /** @type {Array<{ key: string, label: string, unit: string | null, declared: number | null, generated: number | null,
   *   difference: number | null, interval: { low: number, high: number, kind: string } | null, status: "within" | "outside" | "unknown" }>} */
  const rows = [];
  /** @param {string} key @param {string} path @param {number | null} generated @param {boolean} [timed] */
  const row = (key, path, generated, timed = false) => {
    const card = cardFor(cards, endpoint, path);
    const declared = finite(truth[path.split(".")[1]]) ?? finite(card?.pointValue);
    // A number nobody declared has nothing to be calibrated against.
    if (declared === null) return;
    const interval = evidenceIntervalOf(card);
    const value = sig4(generated);
    const status = value === null || !interval ? "unknown" : value < interval.low || value > interval.high ? "outside" : "within";
    rows.push({
      key, label: ROW_WORDS[key] ?? key, unit: timed ? unitOf(card) : null, declared: sig4(declared), generated: value,
      difference: value !== null && declared !== null ? sig4(value - declared) : null, interval, status,
    });
  };
  /** @type {Array<{ value: string, label: string, n: number, events?: number | null }>} */
  const arms = [];
  const treated = object(statistics.treated);
  const control = object(statistics.control);
  if (endpoint === "time_to_event") {
    row("control_median", "truth.controlMedian", finite(control.median), true);
    row("hazard_ratio", "truth.hazardRatio", finite(object(statistics.hazardRatio).value));
    const n = (finite(control.n) ?? 0) + (finite(treated.n) ?? 0);
    const events = (finite(control.events) ?? 0) + (finite(treated.events) ?? 0);
    if (n > 0) rows.push({ key: "event_rate", label: ROW_WORDS.event_rate, unit: null, declared: null, generated: sig4(events / n), difference: null, interval: null, status: "unknown" });
    arms.push({ value: "1", label: "试验", n: finite(treated.n) ?? 0, events: finite(treated.events) }, { value: "0", label: "对照", n: finite(control.n) ?? 0, events: finite(control.events) });
  } else if (endpoint === "binary") {
    row("control_rate", "truth.controlRate", finite(control.rate));
    row("treatment_rate", "truth.treatmentRate", finite(treated.rate));
    arms.push({ value: "1", label: "试验", n: finite(treated.n) ?? 0 }, { value: "0", label: "对照", n: finite(control.n) ?? 0 });
  } else if (endpoint === "continuous") {
    row("effect", "truth.effect", finite(statistics.difference));
    row("sd", "truth.sd", finite(statistics.pooledSd));
    arms.push({ value: "1", label: "试验", n: finite(treated.n) ?? 0 }, { value: "0", label: "对照", n: finite(control.n) ?? 0 });
  }
  return { endpoint, rows, arms };
}
