const migrations = new WeakMap();

const sql = `
CREATE SCHEMA IF NOT EXISTS evimed_usage;
CREATE TABLE IF NOT EXISTS evimed_usage.model_requests (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  project_id text NOT NULL,
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
CREATE INDEX IF NOT EXISTS usage_model_requests_project_fk_idx
  ON evimed_usage.model_requests(user_id,project_id);
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
`;

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
