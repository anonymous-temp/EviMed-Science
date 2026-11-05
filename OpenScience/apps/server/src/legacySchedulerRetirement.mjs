import { migrateProductStore, PRODUCT_JOB_KINDS, PRODUCT_KINDS } from "./productPersistence.mjs";
import { recordSchedulerRetirement } from "./schedulerRetirementMetrics.mjs";

/**
 * What is left of the platform's own scheduler in the product ledger, taken away once at start.
 *
 * Until 2026-11-05 the control plane ran its own scheduled research ("autopilot"): an agenda per task, an episode per run of it, a digest
 * per morning, and the `episode`, `verify` and `digest` jobs that executed them. The kernel's automation tasks replace it and the service,
 * the worker and the page are deleted; this is the step that makes the data match the code. It touches only the product ledger, and writes
 * nothing to a conversation or a run:
 *
 *  - **The documents of the three retired kinds are deleted** (`agenda`, `episode`, `digest`), their revisions with them (the foreign key
 *    cascades), and **the jobs of the four retired kinds** (`episode`, `verify`, `digest`, and the evolution `evolution-self-check` its waiters queued): nothing claims them any more.
 *  - **Only then are the two kind CHECKs narrowed** to the current lists. Rebuilding a CHECK over a row of a kind it refuses stops the
 *    migration and with it the start, so the rows go first, in the same transaction, under an advisory lock.
 *  - A database that never held the constraint in its old form finds nothing to delete and nothing to narrow.
 *
 * Idempotent: a second start deletes nothing and finds the CHECKs already narrow. Never throws into the start: a failure is reported and
 * counted (`failed`) and the next start asks again. Counted as `open_science_scheduler_retirement_total{outcome}`.
 *
 * Not touched, on purpose: the research-memory agenda file, the research-topic-selection agenda deliverable, the evolution digest store, the
 * frontier daily digest and the virtual-clinical-research schedule.
 *
 * Build to delete: when every deployment has started once on this release, this module and its counter can go.
 *
 * @module legacySchedulerRetirement
 */

/** The document kinds only the retired scheduler wrote. */
export const RETIRED_SCHEDULER_DOCUMENT_KINDS = Object.freeze(["agenda", "episode", "digest"]);

/** The job kinds only the retired scheduler queued, and the evolution self-check its waiters queued. */
export const RETIRED_SCHEDULER_JOB_KINDS = Object.freeze(["episode", "verify", "digest", "evolution-self-check"]);

const list = (/** @type {readonly string[]} */ values) => values.map((value) => `'${value}'`).join(",");

/**
 * @param {{ database: any, report?: (line: string) => void }} dependencies
 * @returns {Promise<{ documents: number, revisions: number, jobs: number, narrowed: boolean, failed?: string }>}
 */
export async function retireLegacyScheduler({ database, report = () => {} }) {
  /** @type {Awaited<ReturnType<typeof retireLegacyScheduler>>} */
  const result = { documents: 0, revisions: 0, jobs: 0, narrowed: false };
  try {
    await migrateProductStore(database);
    await database.transaction(async (/** @type {any} */ client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-scheduler-retirement-v1'))");
      result.revisions = Number((await client.query(
        `SELECT count(*)::int AS n FROM evimed_product.revisions WHERE kind IN (${list(RETIRED_SCHEDULER_DOCUMENT_KINDS)})`)).rows[0].n);
      result.documents = Number((await client.query(
        `DELETE FROM evimed_product.documents WHERE kind IN (${list(RETIRED_SCHEDULER_DOCUMENT_KINDS)})`)).rowCount ?? 0);
      result.jobs = Number((await client.query(
        `DELETE FROM evimed_product.jobs WHERE kind IN (${list(RETIRED_SCHEDULER_JOB_KINDS)})`)).rowCount ?? 0);
      for (const [table, constraint, kinds, retired] of /** @type {const} */ ([
        ["documents", "product_documents_kind_check", PRODUCT_KINDS, RETIRED_SCHEDULER_DOCUMENT_KINDS],
        ["jobs", "product_jobs_kind_check", PRODUCT_JOB_KINDS, RETIRED_SCHEDULER_JOB_KINDS],
      ])) {
        const definition = String((await client.query(
          `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = $1::regclass AND conname = $2`,
          [`evimed_product.${table}`, constraint])).rows[0]?.def ?? "");
        if (!retired.some((kind) => definition.includes(`'${kind}'`))) continue;
        await client.query(`ALTER TABLE evimed_product.${table} DROP CONSTRAINT IF EXISTS ${constraint}`);
        await client.query(`ALTER TABLE evimed_product.${table} ADD CONSTRAINT ${constraint} CHECK (kind IN (${list(kinds)}))`);
        result.narrowed = true;
      }
    });
    if (result.documents > 0) recordSchedulerRetirement("documents_deleted", result.documents);
    if (result.jobs > 0) recordSchedulerRetirement("jobs_deleted", result.jobs);
    if (result.narrowed) recordSchedulerRetirement("checks_narrowed");
    if (result.documents === 0 && result.jobs === 0 && !result.narrowed) recordSchedulerRetirement("nothing_left");
    if (result.documents > 0 || result.jobs > 0 || result.narrowed) {
      report(`legacy scheduler: ${result.documents} document(s) (${result.revisions} revision(s)) and ${result.jobs} job(s) of the retired scheduler deleted${result.narrowed ? "; the kind CHECKs narrowed" : ""}`);
    }
  } catch (error) {
    result.failed = String(/** @type {any} */ (error)?.code ?? /** @type {any} */ (error)?.message ?? error).slice(0, 200);
    recordSchedulerRetirement("failed");
    report(`legacy scheduler: the retirement could not run (${result.failed}); the next start asks again`);
  }
  return result;
}
