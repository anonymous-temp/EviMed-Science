/**
 * The 灵豆 settlement ledger: one row per run this platform has charged, or
 * tried to (fusion plan §9.6).
 *
 * Hidden knowledge:
 *
 * - **`run_id` is the primary key, and that is the whole idempotency
 *   mechanism.** The row is inserted `pending` *before* the deduction leaves,
 *   with `ON CONFLICT DO NOTHING`, so a second settlement of one run — a retry,
 *   a duplicated completion callback, a process that crashed between charging
 *   and recording — finds a row instead of creating one, and the same run id is
 *   what EviMed dedupes the charge on. Without the row-first order a crash
 *   after the charge would leave no evidence that it happened, and the retry
 *   would be the only thing that could produce a second one.
 * - **Money outlives its project.** `project_id` carries no foreign key on
 *   purpose: deleting a project used to delete every model request charged
 *   under it (`usagePersistence.mjs`, 2026-09-20), and a settlement is the
 *   record of a charge, not a detail of a workspace. It follows the account,
 *   because an account's erasure must take its financial records with it, and
 *   `RETENTION_DAYS.creditLedger` is `null` — nothing else expires them.
 * - The table lives in its own schema so the module is switchable: with
 *   `OPEN_SCIENCE_EVIMED_CREDITS_ENABLED` off nothing here is created, and the
 *   usage ledger the platform bills from is untouched either way.
 *
 * @module evimedCreditsPersistence
 */

const migrations = new WeakMap();

/** The states a settlement can be in. `pending` is the only non-terminal one. */
export const EVIMED_CREDITS_STATUSES = Object.freeze(["pending", "settled", "refused", "abandoned"]);

const sql = `
CREATE SCHEMA IF NOT EXISTS evimed_credits;
CREATE TABLE IF NOT EXISTS evimed_credits.settlements (
  run_id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  project_id text,
  capability_id text NOT NULL DEFAULT '',
  memo text NOT NULL DEFAULT '',
  cost_cny numeric(20,8) NOT NULL CHECK (cost_cny >= 0),
  credits bigint NOT NULL CHECK (credits >= 0),
  credits_per_cny numeric(20,8) NOT NULL CHECK (credits_per_cny > 0),
  status text NOT NULL CHECK (status IN (${EVIMED_CREDITS_STATUSES.map((status) => `'${status}'`).join(",")})),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz(3),
  receipt_id text,
  error_code text,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz(3),
  CHECK ((status = 'pending') = (next_attempt_at IS NOT NULL))
);
-- The retry sweep asks for the due pending rows across every account, so it
-- leads with the due time and stops after its batch.
CREATE INDEX IF NOT EXISTS evimed_credits_due_idx
  ON evimed_credits.settlements(next_attempt_at, run_id) WHERE status = 'pending';
-- The estimate reads one capability's settled history, newest first.
CREATE INDEX IF NOT EXISTS evimed_credits_capability_idx
  ON evimed_credits.settlements(capability_id, created_at DESC) WHERE status = 'settled';
CREATE INDEX IF NOT EXISTS evimed_credits_account_idx
  ON evimed_credits.settlements(user_id, created_at DESC);
`;

/**
 * Create or bring up to date the 灵豆 settlement schema. Idempotent and
 * serialized by an advisory lock, cached per database like every schema this
 * control plane owns.
 * @param {any} database a `ControlPlaneDatabase`
 * @returns {Promise<void>}
 */
export async function migrateEvimedCredits(database) {
  const cached = migrations.get(database);
  if (cached) return cached;
  const attempt = database.transaction(async (/** @type {any} */ client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-credits-v1'))");
    await client.query(sql);
  });
  migrations.set(database, attempt);
  try {
    await attempt;
  } catch (error) {
    migrations.delete(database);
    throw error;
  }
}
