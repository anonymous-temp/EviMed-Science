/**
 * Where the availability evidence lives: one row per subject and exact version
 * in `evimed_product.availability_operations`, in the product persistence the
 * rest of the product state already uses, written only by the collector.
 *
 * Hidden knowledge: nothing here keeps a list of runs. The run ledger stays
 * the authority for what a run did; this is a derived, rebuildable fold of what
 * finished runs said, so the loss of a row costs its history and nothing else,
 * and a row that does not read as a record is started again rather than
 * trusted. Exactly-once is not this file's job and is not attempted with a
 * "seen" set: it holds because the collector folds inside the lease-checked
 * transaction that completes the one job per run (`ProductJobs.finishWithLease`),
 * so a replayed job either finds its work done or rolls it back whole.
 *
 * @module availabilityStore
 */

import { foldOperation, normalizeOperationRecord } from "@evimed/domain";
import { migrateProductStore, productTime } from "./productPersistence.mjs";

/** The job kind the collector's work is queued under; also the prefix of its idempotency keys. */
export const AVAILABILITY_JOB_KIND = "availability-collect";

/** @param {string} projectId @param {string} runId @returns {string} the one key a run's job is ever enqueued under */
export function availabilityRunKey(projectId, runId) {
  return `availability:run:${projectId}:${runId}`;
}

/** An upper bound on rows listed: the subjects are the catalogue's tools and capabilities times their versions. */
const MAX_RECORDS = 5000;

export class AvailabilityStore {
  /** @param {any} database */
  constructor(database) {
    this.database = database;
  }

  /**
   * Fold observations into their records, inside the caller's transaction. The
   * advisory lock serializes the first insert of a new subject; an observation
   * list may name a subject several times and folds in order.
   *
   * @param {any} client the transaction the job is being completed in
   * @param {readonly import("@evimed/domain").OperationObservation[]} observations
   * @returns {Promise<number>} how many records were written
   */
  async foldMany(client, observations) {
    if (!observations.length) return 0;
    await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-availability-operations'))");
    /** @type {Map<string, import("@evimed/domain").OperationObservation[]>} */
    const grouped = new Map();
    for (const observation of observations) {
      const key = JSON.stringify([observation.kind, observation.id, observation.version ?? ""]);
      grouped.set(key, [...(grouped.get(key) ?? []), observation]);
    }
    for (const [key, group] of grouped) {
      const [kind, id, version] = JSON.parse(key);
      const stored = await client.query(
        "SELECT record FROM evimed_product.availability_operations WHERE kind=$1 AND id=$2 AND version=$3 FOR UPDATE",
        [kind, id, version],
      );
      /** @type {import("@evimed/domain").OperationRecord | null} */
      let record = normalizeOperationRecord(stored.rows[0]?.record);
      for (const observation of group) record = foldOperation(record, observation);
      if (!record) continue;
      await client.query(`INSERT INTO evimed_product.availability_operations(kind,id,version,record) VALUES ($1,$2,$3,$4::jsonb)
        ON CONFLICT (kind,id,version) DO UPDATE SET record=excluded.record, updated_at=clock_timestamp()`,
      [kind, id, version, JSON.stringify(record)]);
    }
    return grouped.size;
  }

  /**
   * Every record the deployment has, normalized. A row that does not read as a
   * record is left out and counted, so a damaged row is visible as a number
   * rather than as a subject that quietly looks never exercised.
   * @returns {Promise<{ records: import("@evimed/domain").OperationRecord[], unreadable: number, updatedAt: string | null }>}
   */
  async list() {
    await migrateProductStore(this.database);
    const result = await this.database.query(`SELECT record, updated_at FROM evimed_product.availability_operations
      ORDER BY kind,id,version LIMIT ${MAX_RECORDS}`);
    /** @type {import("@evimed/domain").OperationRecord[]} */
    const records = [];
    let unreadable = 0;
    /** @type {string | null} */
    let updatedAt = null;
    for (const row of result.rows) {
      const record = normalizeOperationRecord(row.record);
      if (record) records.push(record);
      else unreadable += 1;
      const at = productTime(row.updated_at);
      if (at && (!updatedAt || at > updatedAt)) updatedAt = at;
    }
    return { records, unreadable, updatedAt };
  }

  /**
   * The run jobs already enqueued for one account, by idempotency key, so a
   * sweep enqueues only what is missing instead of upserting every run again.
   * @param {string} userId @returns {Promise<Set<string>>}
   */
  async knownRunKeys(userId) {
    await migrateProductStore(this.database);
    const result = await this.database.query(
      `SELECT idempotency_key FROM evimed_product.jobs WHERE user_id=$1 AND kind=$2 AND idempotency_key LIKE 'availability:run:%'`,
      [userId, AVAILABILITY_JOB_KIND],
    );
    return new Set(result.rows.map((/** @type {any} */ row) => String(row.idempotency_key)));
  }

  /**
   * How far the collection has got: the jobs still waiting, the jobs that gave
   * up, and whether a sweep has ever completed — the evidence that the runs
   * which finished before the collector existed have been looked at.
   * @returns {Promise<{ backlog: number, failed: number, swept: boolean }>}
   */
  async collectorState() {
    await migrateProductStore(this.database);
    const result = await this.database.query(`SELECT
        count(*) FILTER (WHERE status IN ('queued','running'))::integer AS backlog,
        count(*) FILTER (WHERE status='failed')::integer AS failed,
        count(*) FILTER (WHERE status='succeeded' AND payload->>'sweep'='true')::integer AS swept
      FROM evimed_product.jobs WHERE kind=$1`, [AVAILABILITY_JOB_KIND]);
    const row = result.rows[0] ?? {};
    return { backlog: Number(row.backlog ?? 0), failed: Number(row.failed ?? 0), swept: Number(row.swept ?? 0) > 0 };
  }
}
