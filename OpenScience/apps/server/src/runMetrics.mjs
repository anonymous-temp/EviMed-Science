// Run outcomes as Prometheus series, counted by the control plane as each run
// ends.
//
// Until now the metrics endpoint knew HTTP, readiness, the process and the
// memory index — nothing about whether runs succeed, how long they take, what
// they cost or how many of their claims check out. The run ledger is a JSONL
// file in each project directory and can be wiped (the acceptance account's
// was, 2026-09-19 06:28 UTC), so nothing here is read back from it: every
// series is counted in memory at the moment a run reaches a terminal state and
// exported from this process. They start from zero at every restart, which
// Prometheus's rate() and increase() already read as a counter reset.
//
// Labels are closed sets only, so the series count is bounded whatever runs:
// a capability id this deployment has installed (anything else is `other`, a
// run with none is `none`), the three terminal statuses, and error codes from
// the domain registry (anything else is `other`).
import { ALL_ERROR_CODES } from "@evimed/domain";

/** Seconds. A plain answer ends in a minute; a deep report or a meta-analysis
 *  runs for tens of minutes, and the run monitor gives up at four hours, so
 *  the last finite bucket is two. */
export const RUN_DURATION_BUCKETS_SECONDS = Object.freeze([30, 60, 120, 300, 600, 900, 1200, 1800, 2700, 3600, 5400, 7200]);

/** CNY. Measured on production (2026-09-19): p50 ¥0.018 per run, a deep report
 *  ¥3.5–3.8. */
export const RUN_COST_BUCKETS_CNY = Object.freeze([0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8]);

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "canceled"]);
const ERROR_CODES = new Set(ALL_ERROR_CODES);

// Two of the counts come from a run's own files (its claim matrix, its evidence
// table), so one run is capped where no real run reaches: a single workspace
// cannot flood a counter that reads across every account.
const MAX_PER_RUN = 10_000;

/** The capability label for a run: its id when installed, `none` when it has
 *  none, `other` for anything else.
 *  @param {unknown} id @param {(id: string) => boolean} isInstalled */
export function runCapabilityLabel(id, isInstalled) {
  if (typeof id !== "string" || !id) return "none";
  return isInstalled(id) ? id : "other";
}

/** @param {unknown} value */
function bounded(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(MAX_PER_RUN, Math.floor(number)) : 0;
}

/** @param {unknown} value */
function labelValue(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, "\\\"");
}

/** @param {string} name @param {number} value @param {Record<string, string>} labels */
function sample(name, value, labels) {
  const text = Object.entries(labels).map(([key, item]) => `${key}="${labelValue(item)}"`).join(",");
  return `${name}${text ? `{${text}}` : ""} ${Math.round(value * 1e8) / 1e8}`;
}

class Histogram {
  /** @param {readonly number[]} bounds */
  constructor(bounds) {
    this.bounds = bounds;
    /** Cumulative, as the exposition format wants them. */
    this.buckets = bounds.map(() => 0);
    this.sum = 0;
    this.count = 0;
  }

  /** @param {number} value */
  observe(value) {
    this.bounds.forEach((bound, index) => {
      if (value <= bound) this.buckets[index] += 1;
    });
    this.sum += value;
    this.count += 1;
  }
}

export class RunMetrics {
  constructor() {
    /** @type {Map<string, { labels: Record<string, string>, value: number }>} */
    this.finished = new Map();
    /** @type {Map<string, { labels: Record<string, string>, histogram: Histogram }>} */
    this.durations = new Map();
    /** @type {Map<string, { labels: Record<string, string>, value: number }>} */
    this.costTotals = new Map();
    /** @type {Map<string, { labels: Record<string, string>, histogram: Histogram }>} */
    this.costs = new Map();
    /** @type {Map<string, { labels: Record<string, string>, value: number }>} */
    this.claims = new Map();
    /** @type {Map<string, { labels: Record<string, string>, value: number }>} */
    this.sources = new Map();
    this.failures = 0;
  }

  /**
   * One run that reached a terminal state.
   *
   * @param {{ capability: string, status: string, errorCode?: string | null, durationMs?: number | null,
   *   costCny?: number | null, claims?: { verified?: number, unverified?: number } | null,
   *   sources?: { resolved?: number } | null }} run
   *   `capability` is already a label (`runCapabilityLabel`). `costCny` is the
   *   run's settled spend when it ended, absent without a usage ledger.
   *   `claims` is the delivery's own claim summary. `sources.resolved` is how
   *   many sources the run preserved as readable text.
   */
  observe(run) {
    const capability = String(run.capability || "none");
    const status = TERMINAL_STATUSES.has(run.status) ? run.status : "other";
    const errorCode = run.errorCode == null || run.errorCode === ""
      ? "none" : ERROR_CODES.has(run.errorCode) ? run.errorCode : "other";
    this.#add(this.finished, { capability, status, error_code: errorCode }, 1);
    const seconds = Number(run.durationMs) / 1000;
    if (run.durationMs != null && Number.isFinite(seconds) && seconds >= 0) {
      this.#histogram(this.durations, { capability, status }, RUN_DURATION_BUCKETS_SECONDS).observe(seconds);
    }
    const cost = Number(run.costCny);
    if (run.costCny != null && Number.isFinite(cost) && cost >= 0) {
      this.#add(this.costTotals, { capability }, cost);
      this.#histogram(this.costs, { capability }, RUN_COST_BUCKETS_CNY).observe(cost);
    }
    if (run.claims) {
      this.#add(this.claims, { capability, verification: "verified" }, bounded(run.claims.verified));
      this.#add(this.claims, { capability, verification: "unverified" }, bounded(run.claims.unverified));
    }
    const resolved = bounded(run.sources?.resolved);
    if (resolved > 0) this.#add(this.sources, { capability, resolvable: "yes" }, resolved);
  }

  /** A finished run that could not be counted, so a gap in the series is
   *  visible as a number rather than as runs that seem never to have ended. */
  failed() {
    this.failures += 1;
  }

  /** The exposition lines, HELP and TYPE included, for `/api/ops/metrics`. */
  lines() {
    return [
      ...family("evimed_runs_finished_total", "counter",
        "Runs that reached a terminal state since this process started, by capability, status and error code.",
        [...this.finished.values()].map(({ labels, value }) => sample("evimed_runs_finished_total", value, labels))),
      ...family("evimed_run_duration_seconds", "histogram",
        "Wall-clock time from dispatch to terminal state of runs that ended since this process started.",
        histogramSamples("evimed_run_duration_seconds", this.durations)),
      ...family("evimed_run_cost_cny_total", "counter",
        "Settled model spend of runs that ended since this process started, in CNY at the reference price list.",
        [...this.costTotals.values()].map(({ labels, value }) => sample("evimed_run_cost_cny_total", value, labels))),
      ...family("evimed_run_cost_cny", "histogram",
        "Settled model spend per run at the moment it ended, in CNY.",
        histogramSamples("evimed_run_cost_cny", this.costs)),
      ...family("evimed_run_claims_total", "counter",
        "Claims in delivered evidence packages, by whether every quotation was found verbatim in its preserved source.",
        [...this.claims.values()].map(({ labels, value }) => sample("evimed_run_claims_total", value, labels))),
      // What "resolvable" can mean today. A source is counted when the run
      // preserved it as readable text: the platform fetched it and holds the
      // bytes, so its link resolved by construction. A search result the run
      // never read is a lead, not a source, and is not counted; a fetch that
      // failed leaves a tool error, not an evidence record. So nothing is known
      // to be unresolvable yet, and `resolvable="no"` appears only once a link
      // check exists to say so.
      ...family("evimed_run_sources_total", "counter",
        "Sources runs preserved as readable text, by capability; a preserved source is resolvable by construction.",
        [...this.sources.values()].map(({ labels, value }) => sample("evimed_run_sources_total", value, labels))),
      ...family("evimed_run_metric_failures_total", "counter",
        "Finished runs whose outcome could not be counted in the series above.",
        [sample("evimed_run_metric_failures_total", this.failures, {})]),
    ];
  }

  /** @param {Map<string, any>} map @param {Record<string, string>} labels @param {number} amount */
  #add(map, labels, amount) {
    const key = JSON.stringify(labels);
    const entry = map.get(key) ?? { labels, value: 0 };
    entry.value += amount;
    map.set(key, entry);
  }

  /** @param {Map<string, any>} map @param {Record<string, string>} labels @param {readonly number[]} bounds */
  #histogram(map, labels, bounds) {
    const key = JSON.stringify(labels);
    const entry = map.get(key) ?? { labels, histogram: new Histogram(bounds) };
    map.set(key, entry);
    return entry.histogram;
  }
}

/** @param {string} name @param {string} type @param {string} help @param {string[]} samples */
function family(name, type, help, samples) {
  return [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...samples];
}

/** @param {string} name @param {Map<string, { labels: Record<string, string>, histogram: Histogram }>} map */
function histogramSamples(name, map) {
  return [...map.values()].flatMap(({ labels, histogram }) => [
    ...histogram.bounds.map((bound, index) => sample(`${name}_bucket`, histogram.buckets[index], { ...labels, le: String(bound) })),
    sample(`${name}_bucket`, histogram.count, { ...labels, le: "+Inf" }),
    sample(`${name}_sum`, histogram.sum, labels),
    sample(`${name}_count`, histogram.count, labels),
  ]);
}
