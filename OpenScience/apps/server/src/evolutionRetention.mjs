import { maintenanceAllowsClaims } from './maintenanceService.mjs';

/**
 * The bound on what serving writes at a rate. What it writes per researcher action and nothing reads for ever carries `retainUntil` from the day it is written, and a daily pass
 * deletes it past that date, with its revisions (the foreign key) and, for an event, its finished job. Three record types:
 *  - a processed event of a type no later step reads: its one reader was the worker, once. A repeat of the event after that would consume it again, and consuming is idempotent;
 *  - a signal and a lead occurrence: read by the offline lab's export (`scripts/ops/rsi-signals-export.mjs`) over a window of the retention period. A versioned signal (a GEO
 *    misconception, which `geoLearningSignals.mjs` withdraws by identity) carries no date: it is one row per assessed statement, not per action.
 * A row with no `retainUntil` is never touched: every row written before this existed stays as it was, and so does a `dataset-ready` event until a newer revision of its dataset
 * dates it (`EvolutionIntegration.datasetChanged`).
 */
const DAY_MS = 86_400_000;

/** @param {any} config @param {Date} now */
export function evolutionRetainUntil(config, now) { return new Date(now.getTime() + Number(config.evolutionSignalRetentionDays ?? 180) * DAY_MS).toISOString(); }

/** The rows a pass takes, oldest date first, from `product_documents_retain_until_idx`: only rows that carry a date are in it, so the scan costs what is dated. */
export const EVOLUTION_RETENTION_DUE_SELECT = `SELECT user_id,kind,id FROM evimed_product.documents WHERE kind='knowledge' AND deleted_at IS NULL AND payload->>'retainUntil' < $1
          AND (payload->>'recordType' IN ('evolution-signal','evolution-lead-occurrence') OR (payload->>'recordType'='evolution-event' AND payload->>'status'='processed'))
        ORDER BY payload->>'retainUntil' LIMIT $2 FOR UPDATE SKIP LOCKED`;

/**
 * One pass, at most `evolutionRetentionBatchRows` rows, admitted as a claim is (refused during maintenance); the next day comes back to the rest.
 * @param {any} database @param {string} owner the account the module's jobs belong to @param {{config?:any, now?:Date, admission?:((client:any)=>Promise<boolean>|boolean)|null}} [options]
 * @returns {Promise<number>} the documents deleted
 */
export async function compactEvolutionRecords(database, owner, { config = {}, now = new Date(), admission = null } = {}) {
  return database.transaction(async (/** @type {any} */ client) => {
    if (!(await maintenanceAllowsClaims(client))) return 0;
    if (admission && !(await admission(client))) return 0;
    const removed = await client.query(`WITH due AS (${EVOLUTION_RETENTION_DUE_SELECT}) DELETE FROM evimed_product.documents d USING due WHERE d.user_id=due.user_id AND d.kind=due.kind AND d.id=due.id RETURNING d.id,d.payload->>'recordType' AS record_type`,
    [now.toISOString(), Number(config.evolutionRetentionBatchRows ?? 5000)]);
    const keys = removed.rows.filter((/** @type {any} */ row) => row.record_type === 'evolution-event').map((/** @type {any} */ row) => `evolution:${row.id}`);
    if (keys.length) await client.query("DELETE FROM evimed_product.jobs WHERE user_id=$1 AND idempotency_key=ANY($2::text[]) AND status NOT IN ('queued','running')", [owner, keys]);
    return removed.rowCount ?? 0;
  });
}
