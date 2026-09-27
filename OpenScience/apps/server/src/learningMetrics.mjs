/**
 * Whether the learning loop is turning, as numbers (build spec §13, M5).
 *
 * Hidden knowledge: until 2026-09-27 the loop's counters existed only as names
 * in comments (`evimed_learning_*`), so "is it learning" could be answered
 * only by reading SQL on the production host — and the M5 acceptance line,
 * 「学习看板四个计数都不为零」, could not be checked at all (audit 2026-09-26,
 * L-G5).
 *
 * Two kinds of number, kept apart on purpose:
 *
 *  - **Durable** ones are read from the product ledger at scrape time — the
 *    method library by status, the lessons queued by trigger and how they
 *    ended, what the library's methods have been used for, the day's learning
 *    spend. They survive a restart because the ledger does, and a restart is
 *    every release.
 *  - **Process** ones are counted as they happen, because nothing durable
 *    records them: how many learned methods and bytes each launch put in the
 *    room, and how many each finished run carried and used. They start from
 *    zero at every restart, which `rate()` reads as a counter reset.
 *
 * Labels are closed sets only: the distillation triggers, the job statuses,
 * the method statuses and the result operations, with anything else as
 * `other`. The same reads, scoped to one account, are the read-only summary
 * `GET /api/methods` carries (`learningSummary`).
 *
 * @module learningMetrics
 */

import { DISTILLATION_TRIGGERS } from "./methodDistillationRuns.mjs";
import { HANDBOOK_CANDIDATE_RECORD_TYPE, LEARNED_METHOD_RECORD_TYPE } from "./learningService.mjs";
import { OPEN_COST_VALUE } from "./usageLedger.mjs";

const METHOD_STATUSES = Object.freeze(["candidate", "approved", "retired"]);
const JOB_STATUSES = Object.freeze(["queued", "running", "succeeded", "failed", "canceled"]);
const RESULT_OPERATIONS = Object.freeze(["create", "amend", "merge", "no_change", "handbook"]);
const USE_KINDS = Object.freeze(["loaded", "invoked", "succeeded", "read"]);

/** @param {unknown} value @param {readonly string[]} allowed @returns {string} */
const closed = (value, allowed) => (allowed.includes(String(value ?? "")) ? String(value) : "other");

/** @param {unknown} value @returns {number} */
const count = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
};

/** The launch- and run-time counters nothing durable records. */
export class LearningMetrics {
  constructor() {
    this.mounts = { withMethods: 0, without: 0 };
    this.mountedMethods = 0;
    this.mountedBytes = 0;
    this.runs = { withMethods: 0 };
    this.runMethodsLoaded = 0;
    this.runMethodsInvoked = 0;
  }

  /** One runtime launch: how many learned methods it mounted, and their bytes.
   *  @param {{methods: number, bytes: number}} mount */
  observeMount({ methods, bytes }) {
    const mounted = count(methods);
    if (mounted > 0) this.mounts.withMethods += 1;
    else this.mounts.without += 1;
    this.mountedMethods += mounted;
    this.mountedBytes += count(bytes);
  }

  /** One finished run that carried learned methods: how many, and how many it used.
   *  @param {{loaded: number, invoked: number}} run */
  observeRun({ loaded, invoked }) {
    if (count(loaded) <= 0 && count(invoked) <= 0) return;
    this.runs.withMethods += 1;
    this.runMethodsLoaded += count(loaded);
    this.runMethodsInvoked += count(invoked);
  }

  /** @returns {{name: string, help: string, type: "counter", series: {value: number, labels?: Record<string, string>}[]}[]} */
  families() {
    return [
      { name: "open_science_learning_mounts_total", help: "Runtime launches, by whether they mounted any learned method.", type: "counter", series: [
        { value: this.mounts.withMethods, labels: { mounted: "true" } },
        { value: this.mounts.without, labels: { mounted: "false" } },
      ] },
      { name: "open_science_learning_mounted_methods_total", help: "Learned methods mounted, summed over launches.", type: "counter",
        series: [{ value: this.mountedMethods }] },
      { name: "open_science_learning_mounted_bytes_total", help: "Bytes of learned methods mounted, summed over launches.", type: "counter",
        series: [{ value: this.mountedBytes }] },
      { name: "open_science_learning_runs_with_methods_total", help: "Finished runs that carried at least one learned method.", type: "counter",
        series: [{ value: this.runs.withMethods }] },
      { name: "open_science_learning_run_methods_total", help: "Learned methods finished runs carried, and the ones they used.", type: "counter", series: [
        { value: this.runMethodsLoaded, labels: { kind: "loaded" } },
        { value: this.runMethodsInvoked, labels: { kind: "invoked" } },
      ] },
    ];
  }
}

/**
 * The durable half, read from the product ledger: across every account, or
 * one account's when `userId` is given. Each read stands alone — a usage
 * schema this deployment never created costs the spend, not the rest.
 * @param {any} database @param {{userId?: string | null, now?: Date}} [options]
 */
export async function learningLedgerCounts(database, { userId = null, now = new Date() } = {}) {
  const owner = userId == null ? null : String(userId);
  /** @param {string} sql @param {unknown[]} values */
  const rows = async (sql, values) => (await database.query(sql, values)).rows;
  const methods = await rows(`SELECT payload->>'recordType' AS record_type, payload->>'status' AS status, count(*)::integer AS n,
      coalesce(sum(CASE WHEN payload->>'status'='approved' THEN (payload #>> '{learning,counts,loaded}')::numeric END),0) AS loaded,
      coalesce(sum(CASE WHEN payload->>'status'='approved' THEN (payload #>> '{learning,counts,invoked}')::numeric END),0) AS invoked,
      coalesce(sum(CASE WHEN payload->>'status'='approved' THEN (payload #>> '{learning,counts,succeeded}')::numeric END),0) AS succeeded,
      coalesce(sum(CASE WHEN payload->>'status'='approved' THEN (payload #>> '{learning,counts,read}')::numeric END),0) AS read
    FROM evimed_product.documents
    WHERE kind='method' AND deleted_at IS NULL AND payload->>'recordType' = ANY($1::text[]) AND ($2::text IS NULL OR user_id=$2)
    GROUP BY 1,2`, [[LEARNED_METHOD_RECORD_TYPE, HANDBOOK_CANDIDATE_RECORD_TYPE], owner]);
  const jobs = await rows(`SELECT coalesce(payload->>'trigger','') AS trigger, status, count(*)::integer AS n,
      coalesce(result->>'operation','') AS operation
    FROM evimed_product.jobs WHERE kind='distill' AND ($1::text IS NULL OR user_id=$1)
    GROUP BY 1,2,4`, [owner]);
  /** @type {{settled: number, open: number} | null} */
  let spend = null;
  try {
    const [row] = await rows(`SELECT coalesce(sum(actual_cost) FILTER (WHERE status='settled'),0) AS settled,
        coalesce(sum(${OPEN_COST_VALUE}) FILTER (WHERE status IN ('reserved','uncertain')),0) AS open
      FROM evimed_usage.model_requests
      WHERE purpose='learning' AND created_at >= $1::timestamptz - interval '24 hours' AND ($2::text IS NULL OR user_id=$2)`,
    [now.toISOString(), owner]);
    spend = { settled: Number(row?.settled ?? 0), open: Number(row?.open ?? 0) };
  } catch {
    spend = null;
  }

  /** @type {Record<string, number>} */
  const byStatus = Object.fromEntries(METHOD_STATUSES.map((status) => [status, 0]));
  /** @type {Record<string, number>} */
  const uses = Object.fromEntries(USE_KINDS.map((kind) => [kind, 0]));
  let handbookCandidates = 0;
  for (const row of methods) {
    if (row.record_type === HANDBOOK_CANDIDATE_RECORD_TYPE) { handbookCandidates += count(row.n); continue; }
    const status = closed(row.status, METHOD_STATUSES);
    byStatus[status] = (byStatus[status] ?? 0) + count(row.n);
    for (const kind of USE_KINDS) uses[kind] += count(row[kind]);
  }
  /** @type {Record<string, Record<string, number>>} */
  const lessons = {};
  /** @type {Record<string, number>} */
  const results = Object.fromEntries(RESULT_OPERATIONS.map((operation) => [operation, 0]));
  for (const row of jobs) {
    const trigger = closed(row.trigger, DISTILLATION_TRIGGERS);
    const status = closed(row.status, JOB_STATUSES);
    lessons[trigger] ??= Object.fromEntries(JOB_STATUSES.map((name) => [name, 0]));
    lessons[trigger][status] = (lessons[trigger][status] ?? 0) + count(row.n);
    if (row.status === "succeeded") {
      const operation = closed(row.operation, RESULT_OPERATIONS);
      results[operation] = (results[operation] ?? 0) + count(row.n);
    }
  }
  return { methods: byStatus, uses, handbookCandidates, lessons, results, spend };
}

/**
 * One account's summary for `GET /api/methods`: the same reads, the same
 * vocabulary, no rendering. Read-only.
 * @param {any} database @param {string} userId @param {{now?: Date}} [options]
 */
export async function learningSummary(database, userId, { now = new Date() } = {}) {
  const counts = await learningLedgerCounts(database, { userId, now });
  /** @type {Record<string, number>} */
  const queued = {};
  /** @type {Record<string, number>} */
  const ended = { succeeded: 0, failed: 0 };
  for (const [trigger, statuses] of Object.entries(counts.lessons)) {
    queued[trigger] = Object.values(statuses).reduce((total, value) => total + value, 0);
    ended.succeeded += statuses.succeeded ?? 0;
    ended.failed += (statuses.failed ?? 0) + (statuses.canceled ?? 0);
  }
  return {
    methods: counts.methods,
    uses: counts.uses,
    lessons: { byTrigger: queued, ...ended },
    results: counts.results,
    handbookCandidates: counts.handbookCandidates,
    spend24hCny: counts.spend ? Math.round((counts.spend.settled) * 1e6) / 1e6 : null,
  };
}

/**
 * The Prometheus families: whether the loop is composed, the durable counts
 * (absent when the ledger could not be read, which `open_science_learning_ledger_up`
 * says), and the process counters.
 * @param {boolean} enabled
 * @param {Awaited<ReturnType<typeof learningLedgerCounts>> | null} ledger
 * @param {LearningMetrics | null} counters
 * @returns {{name: string, help: string, type: string, series: {value: number, labels?: Record<string, string>}[]}[]}
 */
export function learningMetricFamilies(enabled, ledger, counters) {
  const families = [
    { name: "open_science_learning_enabled", help: "Whether the method-learning loop is composed in this process.", type: "gauge", series: [{ value: enabled ? 1 : 0 }] },
  ];
  if (!enabled) return families;
  families.push({ name: "open_science_learning_ledger_up", help: "Whether the learning counts could be read from the product ledger at this scrape.", type: "gauge",
    series: [{ value: ledger ? 1 : 0 }] });
  if (ledger) {
    families.push(
      { name: "open_science_learning_methods", help: "Learned methods in the account libraries, by status.", type: "gauge",
        series: METHOD_STATUSES.map((status) => ({ value: ledger.methods[status] ?? 0, labels: { status } })) },
      { name: "open_science_learning_handbook_candidates", help: "Lessons taught by the platform reviewer alone, kept for the capability handbook and never mounted.", type: "gauge",
        series: [{ value: ledger.handbookCandidates }] },
      { name: "open_science_learning_method_uses", help: "What effective methods' current bodies have been used for: mounted with a verdict, used, in a succeeded delivery, read without one.", type: "gauge",
        series: USE_KINDS.map((kind) => ({ value: ledger.uses[kind] ?? 0, labels: { kind } })) },
      { name: "open_science_learning_distill_jobs", help: "Distillation lessons queued, by trigger and job status.", type: "gauge",
        series: Object.entries(ledger.lessons).flatMap(([trigger, statuses]) => JOB_STATUSES.map((status) => ({ value: statuses[status] ?? 0, labels: { trigger, status } }))) },
      { name: "open_science_learning_distill_results", help: "Finished distillation lessons, by what they wrote.", type: "gauge",
        series: RESULT_OPERATIONS.map((operation) => ({ value: ledger.results[operation] ?? 0, labels: { operation } })) },
    );
    if (ledger.spend) {
      families.push({ name: "open_science_learning_spend_cny", help: "Learning model spend over the last 24 hours: settled, and still open (reserved or uncertain).", type: "gauge", series: [
        { value: ledger.spend.settled, labels: { window: "24h", state: "settled" } },
        { value: ledger.spend.open, labels: { window: "24h", state: "open" } },
      ] });
    }
  }
  if (counters) families.push(...counters.families());
  return families;
}
