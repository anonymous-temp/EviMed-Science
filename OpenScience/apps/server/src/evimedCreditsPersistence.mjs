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
 *   because an account's erasure must not destroy its financial evidence, and
 *   `RETENTION_DAYS.creditLedger` is `null` — nothing else expires them.
 * - The table lives in its own schema so the module is switchable: with
 *   `OPEN_SCIENCE_EVIMED_CREDITS_ENABLED` off nothing here is created, and the
 *   usage ledger the platform bills from is untouched either way.
 *
 * @module evimedCreditsPersistence
 */

import { RESEARCH_BILLING_VERSION } from "@evimed/domain";
import { eraseSimulatedWallets } from "./evimedCreditsSimulator.mjs";

const migrations = new WeakMap();

/** The states a settlement can be in. `pending` is the only non-terminal one. */
export const EVIMED_CREDITS_STATUSES = Object.freeze(["pending", "settled", "refused", "abandoned"]);

const sql = `
CREATE SCHEMA IF NOT EXISTS evimed_credits;
CREATE TABLE IF NOT EXISTS evimed_credits.settlements (
  run_id text PRIMARY KEY,
  user_id text NOT NULL,
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
-- The outbox and its receipts are financial evidence, not account children.
-- Snapshot the upstream payer before a later account erasure removes its link.
ALTER TABLE evimed_credits.settlements ADD COLUMN IF NOT EXISTS upstream_user_id text;
DO $retention$
DECLARE stale record;
BEGIN
  FOR stale IN SELECT conname FROM pg_constraint
    WHERE conrelid='evimed_credits.settlements'::regclass AND contype='f'
      AND confrelid='evimed_control.users'::regclass
  LOOP
    EXECUTE format('ALTER TABLE evimed_credits.settlements DROP CONSTRAINT %I', stale.conname);
  END LOOP;
END $retention$;
CREATE TABLE IF NOT EXISTS evimed_credits.research_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  pricing_version text NOT NULL,
  activated_at timestamptz(3) NOT NULL
);
-- Task evidence is append-only and survives project/account erasure. It is
-- settlement evidence, not an authoritative wallet balance.
CREATE TABLE IF NOT EXISTS evimed_credits.research_tasks (
  run_id text PRIMARY KEY,
  user_id text NOT NULL,
  title text NOT NULL,
  status text NOT NULL CHECK(status IN ('pending','settled','refused','abandoned')),
  receipt_id text,
  error_code text,
  settled_at timestamptz(3),
  evidence jsonb NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE evimed_credits.settlements ADD COLUMN IF NOT EXISTS owner_created_at timestamptz NOT NULL DEFAULT '-infinity';
ALTER TABLE evimed_credits.research_tasks ADD COLUMN IF NOT EXISTS owner_created_at timestamptz NOT NULL DEFAULT '-infinity';
-- Which wallet a row was charged to, for ever. A settlement made against the
-- simulated wallet (evimedCreditsSimulator.mjs) is never money, and a retry
-- sweep, a statement or a month's total reads only the wallet this deployment
-- runs on, so simulated and real rows can share a table without sharing a total.
ALTER TABLE evimed_credits.settlements ADD COLUMN IF NOT EXISTS wallet text NOT NULL DEFAULT 'live' CHECK (wallet IN ('live','simulated'));
ALTER TABLE evimed_credits.research_tasks ADD COLUMN IF NOT EXISTS wallet text NOT NULL DEFAULT 'live' CHECK (wallet IN ('live','simulated'));
CREATE TABLE IF NOT EXISTS evimed_credits.schema_migrations (
  version text PRIMARY KEY
);
DO $incarnation$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM evimed_credits.schema_migrations WHERE version='owner-incarnation-v1') THEN
    UPDATE evimed_credits.settlements s SET owner_created_at=u.created_at FROM evimed_control.users u WHERE s.user_id=u.id AND s.created_at>=u.created_at;
    UPDATE evimed_credits.research_tasks t SET owner_created_at=s.owner_created_at FROM evimed_credits.settlements s WHERE t.run_id=s.run_id;
    INSERT INTO evimed_credits.schema_migrations(version) VALUES('owner-incarnation-v1');
  END IF;
END $incarnation$;
UPDATE evimed_credits.settlements s SET upstream_user_id=u.evimed_user_id
  FROM evimed_control.users u WHERE s.user_id=u.id AND s.upstream_user_id IS NULL
  AND s.owner_created_at=u.created_at AND u.auth_type='evimed' AND u.evimed_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS evimed_credits.research_task_requests (
  request_id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES evimed_credits.research_tasks(run_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS evimed_research_tasks_user_time_idx
  ON evimed_credits.research_tasks(user_id,created_at DESC,run_id DESC);
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

/** An activation is sticky; a later flag rollback cannot reopen old charging rules.
 * @param {any} database @param {{activate?:boolean,now?:Date}} [options] */
export async function researchBillingPolicy(database, { activate = false, now = new Date() } = {}) {
  await migrateEvimedCredits(database);
  if (activate) await database.query(`INSERT INTO evimed_credits.research_policy(singleton,pricing_version,activated_at)
    VALUES(true,$1,$2) ON CONFLICT(singleton) DO NOTHING`, [RESEARCH_BILLING_VERSION,now.toISOString()]);
  const result = await database.query('SELECT pricing_version,activated_at FROM evimed_credits.research_policy WHERE singleton=true');
  return result.rows[0] ?? null;
}

/** Redact research subject prose while keeping the financial receipt and retry payer.
 * The caller holds the account identity lock and runs this before account deletion.
 * @param {any} client @param {string} userId */
export async function prepareResearchBillingAccountDeletion(client, userId) {
  // A simulated wallet holds no money and no subject, so it goes with the account.
  await eraseSimulatedWallets(client, userId);
  const exists = await client.query(`SELECT to_regclass('evimed_credits.settlements') AS table_name,
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('evimed_credits.settlements')
      AND attname='owner_created_at' AND NOT attisdropped) AS incarnation_ready`);
  if (!exists.rows[0]?.table_name) return;
  // An installation with billing currently off may still have the old schema.
  // Bring its retention up to date before the account FK can erase its outbox.
  if (!exists.rows[0].incarnation_ready) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-credits-v1'))");
    await client.query(sql);
  }
  await client.query(`UPDATE evimed_credits.settlements s SET memo='Research task'
    FROM evimed_control.users u WHERE s.user_id=$1 AND u.id=s.user_id AND s.owner_created_at=u.created_at`, [userId]);
  await client.query(`UPDATE evimed_credits.research_tasks t SET title='Research task'
    FROM evimed_control.users u WHERE t.user_id=$1 AND u.id=t.user_id AND t.owner_created_at=u.created_at`, [userId]);
}
