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

import { createHash } from "node:crypto";

import { LEARNING_EVIDENCE_KINDS, LEARNING_EVIDENCE_VERDICTS, METHOD_RELATION_TYPES } from "@evimed/domain";

import { LEARNING_EVIDENCE_FAILURES } from "./learningEvidence.mjs";
import { LEARNING_REFUSAL_REASONS } from "./learningTriggers.mjs";
import { DISTILLATION_TRIGGERS } from "./methodDistillationRuns.mjs";
import { HANDBOOK_CANDIDATE_RECORD_TYPE, LEARNED_METHOD_RECORD_TYPE } from "./learningService.mjs";
import { OPEN_COST_VALUE } from "./usageLedger.mjs";

const METHOD_STATUSES = Object.freeze(["candidate", "approved", "retired"]);
const JOB_STATUSES = Object.freeze(["queued", "running", "succeeded", "failed", "canceled"]);
const RESULT_OPERATIONS = Object.freeze(["create", "amend", "merge", "no_change", "handbook"]);
const USE_KINDS = Object.freeze(["loaded", "invoked", "succeeded", "read", "carried"]);
/** The branches of `retirementProposal` that stop a method on their own, as the counter of stops labels them. */
const RETIREMENT_CODES = Object.freeze(["incident", "harm", "scientific_regression", "never_opened", "superseded", "unproven_merge_expired", "library_cap"]);
/**
 * Why a stage of the consolidation pass did nothing (`MethodConsolidation`): the pass used to succeed with `groups: 1, builds: 0, relations: 0`
 * for eleven days and say nothing else. `skipped_unchanged` is a group read before and not changed since; `blocked_unproven` a group whose build
 * waits for a merge nobody has proven; `decide_failed` a DECIDE that produced no answer; `decided_nothing` one that found nothing related;
 * `merge_refused` a build that dropped something a source stored; `build_limit` a build left for the next pass; the rest are the library's size.
 */
const CONSOLIDATE_NOOP_REASONS = Object.freeze(["no_methods", "too_few_methods", "no_groups", "skipped_unchanged", "blocked_unproven", "decide_failed", "decided_nothing", "merge_refused", "build_limit"]);

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
    this.repairs = { distilled: 0, sampledOut: 0 };
    /** @type {Record<string, number>} */
    this.triggerRefused = Object.fromEntries([...LEARNING_REFUSAL_REASONS, "other"].map((reason) => [reason, 0]));
    /** @type {Record<string, number>} */
    this.evidenceFailed = Object.fromEntries([...LEARNING_EVIDENCE_FAILURES, "other"].map((reason) => [reason, 0]));
    this.evidenceQuotes = { kept: 0, dropped: 0 };
    /** @type {Record<string, number>} */
    this.retirements = Object.fromEntries([...RETIREMENT_CODES, "other"].map((code) => [code, 0]));
    /** @type {Record<string, number>} */
    this.consolidateNoop = Object.fromEntries([...CONSOLIDATE_NOOP_REASONS, "other"].map((reason) => [reason, 0]));
    /** @type {Record<string, number>} */
    this.relations = Object.fromEntries([...METHOD_RELATION_TYPES, "other"].map((type) => [type, 0]));
  }

  /** A stage of the consolidation pass that did nothing, and why (`CONSOLIDATE_NOOP_REASONS`).
   *  @param {string} reason @param {number} [times] */
  observeConsolidateNoop(reason, times = 1) {
    const label = closed(reason, CONSOLIDATE_NOOP_REASONS);
    const n = Math.trunc(count(times));
    if (n > 0) this.consolidateNoop[label] = (this.consolidateNoop[label] ?? 0) + n;
  }

  /** Relations the consolidation pass newly recorded, by type (a relation a method already held is not counted again).
   *  @param {string} type @param {number} [times] */
  observeRelation(type, times = 1) {
    const label = closed(type, METHOD_RELATION_TYPES);
    const n = Math.trunc(count(times));
    if (n > 0) this.relations[label] = (this.relations[label] ?? 0) + n;
  }

  /** One repaired delivery that would have queued a lesson: whether the repair sample took it (`OPEN_SCIENCE_LEARNING_REPAIR_DISTILL_SAMPLE_SHARE`).
   *  @param {boolean} distilled */
  observeRepairSample(distilled) {
    if (distilled) this.repairs.distilled += 1;
    else this.repairs.sampledOut += 1;
  }

  /** One method the consolidation pass stopped on its own, by the branch that decided.
   *  @param {string} code */
  observeRetirement(code) {
    const label = closed(code, RETIREMENT_CODES);
    this.retirements[label] = (this.retirements[label] ?? 0) + 1;
  }

  /** One run or correction a gate turned away from teaching, by the reason (`LEARNING_REFUSAL_REASONS`): the loop stopped for eleven days
   *  without a sign, and a refusal nobody counts looks like a loop with nothing to learn. @param {string} reason */
  observeTriggerRefused(reason) {
    const label = closed(reason, LEARNING_REFUSAL_REASONS);
    this.triggerRefused[label] = (this.triggerRefused[label] ?? 0) + 1;
  }

  /** One piece of evidence that was not written, by why (`LEARNING_EVIDENCE_FAILURES`): a judge that failed, a quotation that was not in
   *  the message, a message that could not be kept. @param {string} reason */
  observeEvidenceFailure(reason) {
    const label = closed(reason, LEARNING_EVIDENCE_FAILURES);
    this.evidenceFailed[label] = (this.evidenceFailed[label] ?? 0) + 1;
  }

  /** The quotations a distilled method names as what it rests on: how many were in what the distillation was shown, and how many were not.
   *  @param {number} kept @param {number} dropped */
  observeEvidenceQuotes(kept, dropped) {
    this.evidenceQuotes.kept += Math.trunc(count(kept));
    this.evidenceQuotes.dropped += Math.trunc(count(dropped));
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
      { name: "open_science_learning_repair_lessons_total", type: "counter",
        help: "Repaired deliveries that would have queued a distillation (OPEN_SCIENCE_LEARNING_REPAIR_DISTILL_SAMPLE_SHARE, none by default), by whether the sample took them.",
        series: [
          { value: this.repairs.distilled, labels: { outcome: "distilled" } },
          { value: this.repairs.sampledOut, labels: { outcome: "sampled_out" } },
        ] },
      { name: "open_science_learning_trigger_refused_total", type: "counter",
        help: "Finished runs and corrections the learning gates turned away, by reason: not_researcher_work, internal_project, internal_agent, clinical_context, paused, before_reset, trial, transcript_incomplete, not_finished, run_unavailable, not_eligible, enqueue_failed.",
        series: Object.entries(this.triggerRefused).map(([reason, value]) => ({ value, labels: { reason } })) },
      { name: "open_science_learning_evidence_failed_total", type: "counter",
        help: "Pieces of learning evidence that were not written, by reason: judge_unavailable, judge_failed, judge_unreadable, quote_not_found, rule_unsafe, sensitive, previous_unavailable, busy, record_failed, settle_failed.",
        series: Object.entries(this.evidenceFailed).map(([reason, value]) => ({ value, labels: { reason } })) },
      { name: "open_science_learning_evidence_quotes_total", type: "counter",
        help: "Quotations a distilled method named as what it rests on, by whether they were in what the distillation was shown (kept) or not (dropped).",
        series: [{ value: this.evidenceQuotes.kept, labels: { outcome: "kept" } }, { value: this.evidenceQuotes.dropped, labels: { outcome: "dropped" } }] },
      { name: "open_science_learning_method_retirements_total", type: "counter",
        help: "Methods the consolidation pass stopped on its own, by the branch that decided; never_opened is the card that rode in OPEN_SCIENCE_LEARNING_UNUSED_RETIRE_LOADS answered runs and was never opened, unproven_merge_expired a merge nobody opened, library_cap the least used of a library over its cap.",
        series: Object.entries(this.retirements).map(([code, value]) => ({ value, labels: { code } })) },
      { name: "open_science_learning_consolidate_noop_total", type: "counter",
        help: "Stages of the consolidation pass that did nothing, by reason: skipped_unchanged, blocked_unproven, decide_failed, decided_nothing, merge_refused, build_limit, no_groups, too_few_methods, no_methods.",
        series: Object.entries(this.consolidateNoop).map(([reason, value]) => ({ value, labels: { reason } })) },
      { name: "open_science_learning_relations_total", type: "counter",
        help: "Relations between methods the consolidation pass newly recorded, by type (shared_part, subset, merge, abstract_pattern, conflicts_with, supersedes).",
        series: Object.entries(this.relations).map(([type, value]) => ({ value, labels: { type } })) },
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
      coalesce(sum(CASE WHEN payload->>'status'='approved' THEN (payload #>> '{learning,counts,read}')::numeric END),0) AS read,
      coalesce(sum(CASE WHEN payload->>'status'='approved' THEN (payload #>> '{learning,counts,carried}')::numeric END),0) AS carried
    FROM evimed_product.documents
    WHERE kind='method' AND deleted_at IS NULL AND payload->>'recordType' = ANY($1::text[]) AND ($2::text IS NULL OR user_id=$2)
    GROUP BY 1,2`, [[LEARNED_METHOD_RECORD_TYPE, HANDBOOK_CANDIDATE_RECORD_TYPE], owner]);
  const jobs = await rows(`SELECT coalesce(payload->>'trigger','') AS trigger, status, count(*)::integer AS n,
      coalesce(result->>'operation','') AS operation
    FROM evimed_product.jobs WHERE kind='distill' AND ($1::text IS NULL OR user_id=$1)
    GROUP BY 1,2,4`, [owner]);
  // What the researchers did to runs (`learningEvidence.mjs`): by kind and verdict, and when each account last left any.
  /** @type {any[]} */
  let evidenceRows = [];
  /** @type {any[]} */
  let evidenceLast = [];
  try {
    evidenceRows = await rows(`SELECT coalesce(detail->>'evidence','') AS evidence, coalesce(detail->>'verdict','') AS verdict, count(*)::integer AS n
      FROM evimed_product.feedback_events WHERE trigger_kind='learning-evidence' AND ($1::text IS NULL OR user_id=$1) GROUP BY 1,2`, [owner]);
    evidenceLast = await rows(`SELECT user_id, max(occurred_at) AS last_at FROM evimed_product.feedback_events
      WHERE trigger_kind='learning-evidence' AND ($1::text IS NULL OR user_id=$1) GROUP BY user_id`, [owner]);
  } catch {
    evidenceRows = [];
    evidenceLast = [];
  }
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
  /** @type {Record<string, Record<string, number>>} */
  const evidence = {};
  for (const row of evidenceRows) {
    const kind = closed(row.evidence, LEARNING_EVIDENCE_KINDS);
    const verdict = closed(row.verdict, LEARNING_EVIDENCE_VERDICTS);
    evidence[kind] ??= {};
    evidence[kind][verdict] = (evidence[kind][verdict] ?? 0) + count(row.n);
  }
  // By a hash of the account, never its id: a series per account is the point (an account that has left no evidence for days is the signal),
  // and a metric label is the wrong place for an identifier.
  const evidenceLastAt = evidenceLast.map((row) => ({
    account: createHash("sha256").update(`learning-evidence:${row.user_id}`).digest("hex").slice(0, 12),
    at: Math.floor(new Date(row.last_at).getTime() / 1000),
  })).filter((entry) => Number.isFinite(entry.at));
  return { methods: byStatus, uses, handbookCandidates, lessons, results, evidence, evidenceLastAt, spend };
}

/**
 * One account's summary for `GET /api/methods`: the same reads, the same
 * vocabulary, no rendering. Read-only.
 * @param {any} database @param {string} userId @param {{now?: Date}} [options]
 */
export async function learningSummary(database, userId, { now = new Date() } = {}) {
  const handbooks = await handbookSummary(database, userId);
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
    handbooks,
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
      { name: "open_science_learning_handbook_candidates", help: "Lessons taught by the platform reviewer alone, awaiting or consumed by the capability handbook loop.", type: "gauge",
        series: [{ value: ledger.handbookCandidates }] },
      { name: "open_science_learning_method_uses", help: "What effective methods' current bodies have been used for: mounted with a verdict, used, in a succeeded delivery, read without one, carried as a card by an answered run.", type: "gauge",
        series: USE_KINDS.map((kind) => ({ value: ledger.uses[kind] ?? 0, labels: { kind } })) },
      { name: "open_science_learning_distill_jobs", help: "Distillation lessons queued, by trigger and job status.", type: "gauge",
        series: Object.entries(ledger.lessons).flatMap(([trigger, statuses]) => JOB_STATUSES.map((status) => ({ value: statuses[status] ?? 0, labels: { trigger, status } }))) },
      { name: "open_science_learning_lessons_total", type: "counter",
        help: "Distillation lessons queued, by trigger (correction, routine, repair_accepted, edit_diff; delivered only for jobs queued before 2026-10-23).",
        series: Object.entries(ledger.lessons).map(([trigger, statuses]) => ({ value: Object.values(statuses).reduce((total, value) => total + value, 0), labels: { trigger } })) },
      { name: "open_science_learning_evidence_total", type: "counter",
        help: "What researchers did to runs, as the learning loop counts it, by evidence (steer, follow_up, result_corrected, silent) and verdict (correction, preference, rejection, accept, none).",
        series: Object.entries(ledger.evidence).flatMap(([evidence, verdicts]) => Object.entries(verdicts).map(([verdict, value]) => ({ value, labels: { evidence: evidence.replaceAll("-", "_"), verdict } }))) },
      { name: "open_science_learning_evidence_last_at", type: "gauge",
        help: "When each account (by a hash of it) last left learning evidence, in seconds since the epoch: an account that works and leaves none is a loop that cannot learn from it.",
        series: ledger.evidenceLastAt.map((entry) => ({ value: entry.at, labels: { account: entry.account } })) },
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

/** Actual current-version use records, separate from causal quality evidence. No first-page totals.
 * @param {any} database @param {string} userId */
export async function handbookSummary(database, userId) {
  const result = await database.query(`WITH owned AS MATERIALIZED (
    SELECT id,payload,updated_at FROM evimed_product.documents
    WHERE user_id=$1 AND kind='method' AND deleted_at IS NULL
      AND payload->>'recordType' IN ('handbook-candidate','capability-handbook')
  ), active AS MATERIALIZED (
    SELECT * FROM owned WHERE payload->>'recordType'='capability-handbook' AND payload->>'status'='active'
  ), dispositions AS (
    SELECT coalesce(payload->'dispositions'->(payload->>'contentDigest')->>'disposition',
      payload->'dispositions'->(payload->>'contentDigest')->>'state','queued') AS state,count(*)::integer AS n
    FROM owned WHERE payload->>'recordType'='handbook-candidate' GROUP BY 1
  ), observations AS (
    SELECT observation FROM active CROSS JOIN LATERAL jsonb_array_elements(coalesce(payload->'observations','[]'::jsonb)) observation
    WHERE observation->>'contentDigest'=payload->>'contentDigest'
  ) SELECT jsonb_build_object(
    'dispositions',coalesce((SELECT jsonb_object_agg(state,n) FROM dispositions),'{}'::jsonb),
    'applied',(SELECT count(*) FROM active),
    'unmeasured',(SELECT count(*) FROM active WHERE payload->>'verification'='unmeasured'),
    'evaluated',(SELECT count(*) FROM active WHERE payload->>'verification'='evaluated'),
    'verifiedImprovement',(SELECT count(*) FROM active WHERE payload->>'verification'='evaluated' AND payload #>> '{evaluation,verdict}'='better'),
    'attached',(SELECT count(*) FROM observations WHERE observation->>'attached'='true'),
    'used',(SELECT count(*) FROM observations WHERE observation->>'used'='true'),
    'outcomes',coalesce((SELECT sum(jsonb_array_length(coalesce(observation->'outcomes','[]'::jsonb))) FROM observations),0),
    'recent',coalesce((SELECT jsonb_agg(item) FROM (SELECT jsonb_build_object(
      'id',id,'title',coalesce(payload #>> '{display,title}',payload #>> '{frontmatter,name}'),
      'capabilityId',payload->>'capabilityId','version',payload->'version','verification',payload->>'verification',
      'appliedAt',payload->>'appliedAt','source',payload->'source','evaluationVerdict',payload #>> '{evaluation,verdict}'
      ) AS item FROM active ORDER BY payload->>'appliedAt' DESC,id LIMIT 6) recent),'[]'::jsonb)
  ) AS handbook_summary`, [userId]);
  return result.rows[0]?.handbook_summary ?? null;
}
