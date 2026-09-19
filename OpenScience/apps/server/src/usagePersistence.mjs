import { createHash } from "node:crypto";
import { USAGE_PURPOSES } from "@evimed/domain";

const migrations = new WeakMap();

// The purpose CHECK is spliced from the domain's closed vocabulary, so every
// member is checked for shape rather than trusted, and the constraint is named
// for the exact list it enforces: when the vocabulary grows, the old name no
// longer matches, and the migration replaces the constraint instead of leaving
// one that refuses the new purpose on insert.
for (const purpose of USAGE_PURPOSES) {
  if (!/^[a-z][a-z-]*$/.test(purpose)) throw new Error(`usage purpose ${JSON.stringify(purpose)} cannot be written into SQL`);
}
const purposeCheck = `usage_model_requests_purpose_${createHash("sha256").update(USAGE_PURPOSES.join(",")).digest("hex").slice(0, 12)}_check`;

const sql = `
CREATE SCHEMA IF NOT EXISTS evimed_usage;
CREATE TABLE IF NOT EXISTS evimed_usage.model_requests (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  run_id text,
  model text NOT NULL,
  price_version text NOT NULL,
  currency text NOT NULL CONSTRAINT usage_model_requests_currency_check CHECK (currency = 'CNY'),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('reserved','settled','released','uncertain')),
  revision integer NOT NULL DEFAULT 1,
  reserved_cost numeric(20,8) NOT NULL CHECK (reserved_cost >= 0),
  actual_cost numeric(20,8),
  priced boolean,
  cache_hit_tokens bigint,
  cache_miss_tokens bigint,
  output_tokens bigint,
  provider_request_id text,
  error_code text,
  reservation_expires_at timestamptz(3) NOT NULL,
  created_at timestamptz(3) NOT NULL,
  settled_at timestamptz(3),
  FOREIGN KEY (user_id,project_id) REFERENCES evimed_control.projects(user_id,id) ON DELETE CASCADE,
  CHECK (actual_cost IS NULL OR actual_cost >= 0),
  CHECK (cache_hit_tokens IS NULL OR cache_hit_tokens >= 0),
  CHECK (cache_miss_tokens IS NULL OR cache_miss_tokens >= 0),
  CHECK (output_tokens IS NULL OR output_tokens >= 0)
);
CREATE INDEX IF NOT EXISTS usage_model_requests_account_time_idx
  ON evimed_usage.model_requests(user_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS usage_model_requests_open_idx
  ON evimed_usage.model_requests(user_id,reservation_expires_at,id)
  WHERE status IN ('reserved','uncertain');
-- The reconciliation sweep asks for the oldest expired reservations across every
-- account. The account-leading partial index above can answer that, but only by
-- reading all of itself: its first column is unconstrained, so there is no range
-- to seek and no useful order to stop early in. Leading with
-- reservation_expires_at lets the sweep's ORDER BY ... LIMIT stop after its
-- batch. (The readiness count needs no such index: it is a full count of the
-- open rows and the partial index above already covers exactly that set.)
CREATE INDEX IF NOT EXISTS usage_model_requests_expiry_sweep_idx
  ON evimed_usage.model_requests(reservation_expires_at,id)
  WHERE status = 'reserved';
CREATE INDEX IF NOT EXISTS usage_model_requests_project_fk_idx
  ON evimed_usage.model_requests(user_id,project_id);
ALTER TABLE evimed_usage.model_requests ADD COLUMN IF NOT EXISTS run_id text;
CREATE INDEX IF NOT EXISTS usage_model_requests_run_idx
  ON evimed_usage.model_requests(user_id,run_id,created_at,id) WHERE run_id IS NOT NULL;
DO $foreign_keys$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='evimed_usage' AND t.relname='model_requests' AND c.contype='f'
      AND pg_get_constraintdef(c.oid) LIKE 'FOREIGN KEY (user_id) REFERENCES evimed_control.users(id)%'
  ) THEN
    ALTER TABLE evimed_usage.model_requests ADD CONSTRAINT usage_model_requests_user_fk
      FOREIGN KEY (user_id) REFERENCES evimed_control.users(id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='evimed_usage' AND t.relname='model_requests' AND c.contype='f'
      AND pg_get_constraintdef(c.oid) LIKE 'FOREIGN KEY (user_id, project_id) REFERENCES evimed_control.projects(user_id, id)%'
  ) THEN
    ALTER TABLE evimed_usage.model_requests ADD CONSTRAINT usage_model_requests_project_fk
      FOREIGN KEY (user_id,project_id) REFERENCES evimed_control.projects(user_id,id) ON DELETE CASCADE NOT VALID;
  END IF;
END $foreign_keys$;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='evimed_usage.model_requests'::regclass
      AND conname='usage_model_requests_currency_check'
  ) THEN
    ALTER TABLE evimed_usage.model_requests
      ADD CONSTRAINT usage_model_requests_currency_check CHECK (currency = 'CNY') NOT VALID;
    ALTER TABLE evimed_usage.model_requests VALIDATE CONSTRAINT usage_model_requests_currency_check;
  END IF;
END $$;
-- What each request was for (contract X1, 2026-09-20). A constant default makes
-- this a catalogue-only change on PostgreSQL 11+, not a table rewrite. There is
-- no backfill: nothing recorded a request's origin before this column existed,
-- so every older row stays 'other' — a guessed purpose would read in the report
-- exactly like a recorded one.
ALTER TABLE evimed_usage.model_requests ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'other';
DO $purpose$
DECLARE stale record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='evimed_usage.model_requests'::regclass AND conname='${purposeCheck}'
  ) THEN
    FOR stale IN SELECT conname FROM pg_constraint
      WHERE conrelid='evimed_usage.model_requests'::regclass
        AND conname ~ '^usage_model_requests_purpose_[0-9a-f]+_check$'
    LOOP
      EXECUTE format('ALTER TABLE evimed_usage.model_requests DROP CONSTRAINT %I', stale.conname);
    END LOOP;
    ALTER TABLE evimed_usage.model_requests ADD CONSTRAINT ${purposeCheck}
      CHECK (purpose IN (${USAGE_PURPOSES.map((purpose) => `'${purpose}'`).join(",")})) NOT VALID;
    ALTER TABLE evimed_usage.model_requests VALIDATE CONSTRAINT ${purposeCheck};
  END IF;
END $purpose$;
-- The cost report reads one window across every account. The account-leading
-- index above cannot seek on time alone, so without this the report reads the
-- whole ledger, which grows by every model request the platform makes.
CREATE INDEX IF NOT EXISTS usage_model_requests_time_purpose_idx
  ON evimed_usage.model_requests(created_at,purpose);
`;

/** The purpose CHECK's current name, for the tests that pin the migration. */
export const USAGE_PURPOSE_CHECK = purposeCheck;

/** @param {any} database */
export async function migrateUsageLedger(database) {
  if (migrations.has(database)) return migrations.get(database);
  const attempt = database.transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-usage-v1'))");
    await client.query(sql);
  });
  migrations.set(database, attempt);
  try { await attempt; }
  catch (error) { migrations.delete(database); throw error; }
}
