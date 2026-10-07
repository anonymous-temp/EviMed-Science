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

import { RESEARCH_BILLING_VERSION, RESEARCH_BILLING_VERSION_WHOLE_CREDIT, WALLET_CONTRACT_EXACT, WALLET_CONTRACT_WHOLE_CREDIT } from "@evimed/domain";
import { eraseSimulatedWallets } from "./evimedCreditsWallet.mjs";

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

-- The exact charge (2026-10-05). A charge is now an exact amount, so the column
-- that held whole credits holds numeric(20,8); a live wallet's rows stay whole
-- numbers in it. 'requested' is what the run cost to the last 1e-8, 'credits' is
-- what was actually taken, 'absorbed' is the part the platform carried because
-- the balance could not cover it (requested = credits + absorbed on the platform
-- wallet), 'wallet_contract' says which rule priced it and 'charge_basis' why it
-- was charged at all.
DO $exactcredits$
BEGIN
  IF (SELECT data_type FROM information_schema.columns WHERE table_schema = 'evimed_credits'
      AND table_name = 'settlements' AND column_name = 'credits') = 'bigint' THEN
    ALTER TABLE evimed_credits.settlements ALTER COLUMN credits TYPE numeric(20,8);
  END IF;
END $exactcredits$;
ALTER TABLE evimed_credits.settlements ADD COLUMN IF NOT EXISTS requested numeric(20,8) CHECK (requested IS NULL OR requested >= 0);
ALTER TABLE evimed_credits.settlements ADD COLUMN IF NOT EXISTS absorbed numeric(20,8) NOT NULL DEFAULT 0 CHECK (absorbed >= 0);
ALTER TABLE evimed_credits.settlements ADD COLUMN IF NOT EXISTS wallet_contract text NOT NULL DEFAULT '${WALLET_CONTRACT_WHOLE_CREDIT}'
  CHECK (wallet_contract IN ('${WALLET_CONTRACT_WHOLE_CREDIT}','${WALLET_CONTRACT_EXACT}'));
ALTER TABLE evimed_credits.settlements ADD COLUMN IF NOT EXISTS charge_basis text
  CHECK (charge_basis IS NULL OR charge_basis IN ('completed','user_stop','not_charged'));
-- Which rule a version of the charging policy is, and when it began. A version's
-- activation is sticky: a run that started before it stays under the rule before
-- it, and no later flag change reopens that. The whole-credit rule's own
-- activation stays in research_policy, where it was first written.
CREATE TABLE IF NOT EXISTS evimed_credits.billing_policies (
  pricing_version text PRIMARY KEY,
  activated_at timestamptz(3) NOT NULL
);
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

/**
 * The whole-credit rule's activation. Sticky: a later flag rollback cannot reopen
 * old charging rules.
 * @param {any} database @param {{activate?:boolean,now?:Date}} [options] */
export async function researchBillingPolicy(database, { activate = false, now = new Date() } = {}) {
  await migrateEvimedCredits(database);
  if (activate) await database.query(`INSERT INTO evimed_credits.research_policy(singleton,pricing_version,activated_at)
    VALUES(true,$1,$2) ON CONFLICT(singleton) DO NOTHING`, [RESEARCH_BILLING_VERSION_WHOLE_CREDIT,now.toISOString()]);
  const result = await database.query('SELECT pricing_version,activated_at FROM evimed_credits.research_policy WHERE singleton=true');
  return result.rows[0] ?? null;
}

/**
 * The exact-charge rule's activation, with its own instant (2026-10-05). A run
 * that started before it stays under the whole-credit rule; nothing already
 * settled is recomputed. Written once, the first time a platform wallet runs with
 * research billing on, and never moved by a later flag change.
 * @param {any} database @param {{activate?:boolean,now?:Date}} [options]
 * @returns {Promise<{ pricing_version: string, activated_at: Date } | null>} */
export async function exactBillingPolicy(database, { activate = false, now = new Date() } = {}) {
  await migrateEvimedCredits(database);
  if (activate) await database.query(`INSERT INTO evimed_credits.billing_policies(pricing_version,activated_at)
    VALUES($1,$2) ON CONFLICT(pricing_version) DO NOTHING`, [RESEARCH_BILLING_VERSION, now.toISOString()]);
  const result = await database.query('SELECT pricing_version,activated_at FROM evimed_credits.billing_policies WHERE pricing_version=$1', [RESEARCH_BILLING_VERSION]);
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
