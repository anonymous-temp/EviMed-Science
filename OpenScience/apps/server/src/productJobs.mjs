import { randomUUID } from "node:crypto";
import { HttpError } from "./security.mjs";
import { migrateProductStore, productId, productInteger, productKind, productPayload, productTime, PRODUCT_JOB_KINDS } from "./productPersistence.mjs";

/** @param {any} row */
function job(row) {
  return row ? {
    id: row.id, userId: row.user_id, projectId: row.project_id, kind: row.kind,
    payload: row.payload, status: row.status, attempts: row.attempts, maxAttempts: row.max_attempts,
    result: row.result, error: row.error, leaseToken: row.lease_token,
    leaseExpiresAt: productTime(row.lease_expires_at), runAfter: productTime(row.run_after),
    createdAt: productTime(row.created_at), finishedAt: productTime(row.finished_at),
  } : null;
}

/** PostgreSQL work leases survive API restarts and exclude stale workers. */
export class ProductJobs {
  /** @param {any} database */
  constructor(database) { this.database = database; }

  /** @param {string} userId @param {string} kind @param {Record<string,any>} payload
   * @param {{ idempotencyKey: string, projectId?: string|null, maxAttempts?: number, runAfter?: Date, rearmFailed?:boolean, transactionClient?:any }} options */
  async enqueue(userId, kind, payload, { idempotencyKey, projectId = null, maxAttempts = 3, runAfter = new Date(), rearmFailed = false, transactionClient = null }) {
    productInteger(maxAttempts, 1, 10);
    const values = [randomUUID(), productId(userId, "user"), productKind(kind, PRODUCT_JOB_KINDS), productPayload(payload),
      productId(idempotencyKey, "idempotency key"), projectId == null ? null : productId(projectId, "project"), maxAttempts, productTime(runAfter), rearmFailed];
    if (!transactionClient) await migrateProductStore(this.database);
    const result = await (transactionClient ?? this.database).query(`INSERT INTO evimed_product.jobs(id,user_id,kind,payload,idempotency_key,project_id,max_attempts,run_after)
      VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8)
      ON CONFLICT(user_id,idempotency_key) DO UPDATE SET id=jobs.id,
        status=CASE WHEN $9::boolean AND jobs.status='failed' THEN 'queued' ELSE jobs.status END,
        attempts=CASE WHEN $9::boolean AND jobs.status='failed' THEN 0 ELSE jobs.attempts END,
        error=CASE WHEN $9::boolean AND jobs.status='failed' THEN NULL ELSE jobs.error END,
        finished_at=CASE WHEN $9::boolean AND jobs.status='failed' THEN NULL ELSE jobs.finished_at END,
        run_after=CASE WHEN $9::boolean AND jobs.status='failed' THEN excluded.run_after ELSE jobs.run_after END,
        updated_at=CASE WHEN $9::boolean AND jobs.status='failed' THEN clock_timestamp() ELSE jobs.updated_at END
      WHERE jobs.kind=excluded.kind AND jobs.payload=excluded.payload AND jobs.project_id IS NOT DISTINCT FROM excluded.project_id
      RETURNING *`, values);
    if (!result.rows[0]) throw new HttpError(409, "product_job_idempotency_conflict", "This request key already names a different job.");
    return job(result.rows[0]);
  }

  /** @param {string} userId @param {string} id */
  async get(userId, id) {
    await migrateProductStore(this.database);
    const result = await this.database.query("SELECT * FROM evimed_product.jobs WHERE user_id=$1 AND id=$2", [productId(userId, "user"), productId(id)]);
    return job(result.rows[0]);
  }

  /** Worker-only operation. Never expose cross-account claiming as a customer API.
   * @param {string[]} kinds @param {string} workerId @param {{ leaseMs?: number }} options */
  async claim(kinds, workerId, { leaseMs = 60_000 } = {}) {
    if (!Array.isArray(kinds) || !kinds.length || kinds.length > PRODUCT_JOB_KINDS.length) throw new HttpError(400, "product_kind_invalid", "A worker must declare supported job kinds.");
    const allowed = kinds.map((kind) => productKind(kind, PRODUCT_JOB_KINDS));
    productInteger(leaseMs, 1000, 3_600_000);
    productId(workerId, "worker");
    await migrateProductStore(this.database);
    return this.database.transaction(async (client) => {
      await client.query(`WITH exhausted AS (
        SELECT id FROM evimed_product.jobs WHERE kind=ANY($1::text[]) AND status='running'
        AND lease_expires_at<=statement_timestamp() AND attempts>=max_attempts
        ORDER BY lease_expires_at,id FOR UPDATE SKIP LOCKED LIMIT 100
      ) UPDATE evimed_product.jobs j SET status='failed',finished_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL,
        error='{"code":"product_job_attempts_exhausted","message":"The job exhausted its retry limit."}'::jsonb
        FROM exhausted e WHERE j.id=e.id`, [allowed]);
      // Separate ranges prevent a mixed OR plus ORDER BY from walking every future job.
      const result = await client.query(`WITH queued AS MATERIALIZED (
        SELECT id,run_after AS due FROM evimed_product.jobs WHERE kind=ANY($1::text[]) AND attempts<max_attempts
        AND status='queued' AND run_after<=statement_timestamp()
        ORDER BY run_after,id FOR UPDATE SKIP LOCKED LIMIT 1
      ), expired AS MATERIALIZED (
        SELECT id,lease_expires_at AS due FROM evimed_product.jobs WHERE kind=ANY($1::text[]) AND attempts<max_attempts
        AND status='running' AND lease_expires_at<=statement_timestamp()
        ORDER BY lease_expires_at,id FOR UPDATE SKIP LOCKED LIMIT 1
      ), candidate AS (
        SELECT id FROM (SELECT * FROM queued UNION ALL SELECT * FROM expired) available ORDER BY due,id LIMIT 1
      ) UPDATE evimed_product.jobs j SET status='running',worker_id=$2,lease_token=$3,
        lease_expires_at=clock_timestamp()+($4::integer*interval '1 millisecond'),attempts=attempts+1,updated_at=clock_timestamp()
        FROM candidate c WHERE j.id=c.id RETURNING j.*`, [allowed, workerId, randomUUID(), leaseMs]);
      return job(result.rows[0]);
    });
  }

  /** Lock before checking wall-clock authority: waiting for a row lock may outlive a lease.
   * @param {string} userId @param {string} id @param {string} leaseToken
   * @param {(client: any) => Promise<any>} operation */
  async withLease(userId, id, leaseToken, operation) {
    const values = [productId(userId, "user"), productId(id), productId(leaseToken, "lease")];
    await migrateProductStore(this.database);
    return this.database.transaction(async (client) => {
      await client.query("SELECT id FROM evimed_product.jobs WHERE user_id=$1 AND id=$2 FOR UPDATE", values.slice(0, 2));
      const current = await client.query(`SELECT id FROM evimed_product.jobs
        WHERE user_id=$1 AND id=$2 AND lease_token=$3 AND status='running' AND lease_expires_at>clock_timestamp()`, values);
      if (!current.rows[0]) return null;
      return operation(client);
    });
  }

  /** @param {string} userId @param {string} id @param {string} leaseToken @param {number} leaseMs */
  async renew(userId, id, leaseToken, leaseMs = 60_000) {
    productInteger(leaseMs, 1000, 3_600_000);
    await migrateProductStore(this.database);
    const result = await this.withLease(userId, id, leaseToken, (client) => client.query(`UPDATE evimed_product.jobs SET lease_expires_at=clock_timestamp()+($4::integer*interval '1 millisecond')
      WHERE user_id=$1 AND id=$2 AND lease_token=$3 AND status='running' AND lease_expires_at>clock_timestamp() RETURNING id`,
    [userId, id, leaseToken, leaseMs]));
    return result?.rows.length === 1;
  }

  /** @param {string} userId @param {string} id @param {string} leaseToken @param {Record<string,any>} result */
  async finish(userId, id, leaseToken, result) {
    return this.finishWithLease(userId, id, leaseToken, result, async () => {});
  }

  /** Complete a job and its canonical side effect in the same lease-checked transaction.
   * @param {string} userId @param {string} id @param {string} leaseToken @param {Record<string,any>} result
   * @param {(client:any) => Promise<void>} operation */
  async finishWithLease(userId, id, leaseToken, result, operation) {
    if (typeof operation !== "function") throw new HttpError(400, "product_job_operation_invalid", "A job completion operation is required.");
    await migrateProductStore(this.database);
    const payload = productPayload(result);
    const updated = await this.withLease(userId, id, leaseToken, async (client) => {
      await operation(client);
      const completed = await client.query(`UPDATE evimed_product.jobs SET status='succeeded',result=$4::jsonb,error=NULL,
        finished_at=clock_timestamp(),updated_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL
        WHERE user_id=$1 AND id=$2 AND lease_token=$3 AND status='running' AND lease_expires_at>clock_timestamp() RETURNING *`,
      [userId, id, leaseToken, payload]);
      // Reject inside the transaction so a lease lost while the operation
      // waited on another row also rolls back that operation's side effects.
      if (!completed.rows[0]) throw new HttpError(409, "product_job_lease_lost", "This worker no longer owns the job.");
      return completed;
    });
    if (!updated?.rows[0]) throw new HttpError(409, "product_job_lease_lost", "This worker no longer owns the job.");
    return job(updated.rows[0]);
  }

  /** @param {string} userId @param {string} id @param {string} leaseToken
   * @param {{ code: string, message: string }} error @param {{ retry?: boolean, delayMs?: number }} options */
  async fail(userId, id, leaseToken, error, { retry = false, delayMs = 5000 } = {}) {
    productInteger(delayMs, 0, 86_400_000);
    const detail = productPayload({ code: productId(error.code, "error code"), message: String(error.message ?? "Job failed.").slice(0, 500) });
    await migrateProductStore(this.database);
    const result = await this.withLease(userId, id, leaseToken, (client) => client.query(`UPDATE evimed_product.jobs SET
      status=CASE WHEN $5::boolean AND attempts<max_attempts THEN 'queued' ELSE 'failed' END,
      finished_at=CASE WHEN $5::boolean AND attempts<max_attempts THEN NULL ELSE clock_timestamp() END,
      run_after=clock_timestamp()+($6::integer*interval '1 millisecond'),error=$4::jsonb,updated_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL
      WHERE user_id=$1 AND id=$2 AND lease_token=$3 AND status='running' AND lease_expires_at>clock_timestamp() RETURNING *`,
    [userId, id, leaseToken, detail, retry, delayMs]));
    if (!result?.rows[0]) throw new HttpError(409, "product_job_lease_lost", "This worker no longer owns the job.");
    return job(result.rows[0]);
  }

  /** @param {string} userId @param {string} id */
  async cancel(userId, id) {
    await migrateProductStore(this.database);
    const result = await this.database.query(`UPDATE evimed_product.jobs SET
      status=CASE WHEN status IN ('queued','running') THEN 'canceled' ELSE status END,
      finished_at=coalesce(finished_at,clock_timestamp()),updated_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL
      WHERE user_id=$1 AND id=$2 RETURNING *`, [productId(userId, "user"), productId(id)]);
    if (!result.rows[0]) throw new HttpError(404, "product_job_not_found", "The job is unavailable.");
    return job(result.rows[0]);
  }
}
