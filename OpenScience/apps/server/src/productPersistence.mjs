import { HttpError } from "./security.mjs";

export const PRODUCT_KINDS = Object.freeze([
  "capsule", "fact", "method", "source", "source-unit", "knowledge", "profile",
  "agenda", "episode", "digest", "notification", "preferences", "plugin", "price-list",
]);
export const PRODUCT_JOB_KINDS = Object.freeze(["ingest", "distill", "consolidate", "episode", "verify", "digest", "notify", "memory-index", "plugin-apply"]);

/**
 * What the researcher did, as a closed vocabulary.
 *
 * These live here rather than in `feedbackEvents.mjs` for the same reason
 * `PRODUCT_KINDS` does: the CHECK constraint below is generated from the list,
 * so the database and the code cannot hold two different vocabularies, and the
 * module that writes the rows imports the list from the module that creates the
 * table rather than the other way round.
 */
export const FEEDBACK_EVENT_TRIGGERS = Object.freeze([
  "memory-inference-accepted",
  "memory-value-edited",
  "memory-rejected",
  "deliverable-adopted",
  "deliverable-edited",
]);

/** What a feedback event can be about. */
export const FEEDBACK_SUBJECT_TYPES = Object.freeze(["memory-record", "deliverable"]);

const migrations = new WeakMap();

const sql = `
CREATE SCHEMA IF NOT EXISTS evimed_product;
CREATE TABLE IF NOT EXISTS evimed_product.schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS evimed_product.maintenance_lease (
  singleton boolean PRIMARY KEY CHECK (singleton),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
  requested_at timestamptz(3) NOT NULL,
  expires_at timestamptz(3) NOT NULL CHECK (expires_at > requested_at)
);
INSERT INTO evimed_product.schema_migrations(name) VALUES ('2026-09-07-maintenance-lease-v1') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS evimed_product.documents (
  user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  kind text NOT NULL CONSTRAINT product_documents_kind_check CHECK (kind IN (${PRODUCT_KINDS.map((x) => `'${x}'`).join(",")})),
  id text NOT NULL,
  project_id text,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz(3),
  PRIMARY KEY (user_id, kind, id),
  FOREIGN KEY (user_id, project_id) REFERENCES evimed_control.projects(user_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS product_documents_list_idx ON evimed_product.documents
  (user_id,kind,created_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS product_documents_project_idx ON evimed_product.documents
  (user_id,project_id,kind) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS product_documents_project_fk_idx ON evimed_product.documents(user_id,project_id);
CREATE INDEX IF NOT EXISTS product_documents_payload_idx ON evimed_product.documents USING gin(payload jsonb_path_ops) WHERE deleted_at IS NULL;
DO $document_kinds$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT c.conname FROM pg_constraint c
    WHERE c.conrelid='evimed_product.documents'::regclass AND c.contype='c'
      AND pg_get_constraintdef(c.oid) LIKE 'CHECK ((kind = ANY%'
      AND c.conname <> 'product_documents_kind_check'
  LOOP
    EXECUTE format('ALTER TABLE evimed_product.documents DROP CONSTRAINT %I', constraint_name);
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c WHERE c.conrelid='evimed_product.documents'::regclass
      AND c.conname='product_documents_kind_check' AND pg_get_constraintdef(c.oid) LIKE '%digest%'
  ) THEN
    ALTER TABLE evimed_product.documents DROP CONSTRAINT IF EXISTS product_documents_kind_check;
    ALTER TABLE evimed_product.documents ADD CONSTRAINT product_documents_kind_check
      CHECK (kind IN (${PRODUCT_KINDS.map((x) => `'${x}'`).join(",")}));
  END IF;
END $document_kinds$;
INSERT INTO evimed_product.schema_migrations(name) VALUES ('2026-09-06-product-digest-kind-v1') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS evimed_product.revisions (
  user_id text NOT NULL,
  kind text NOT NULL,
  id text NOT NULL,
  revision integer NOT NULL,
  payload jsonb NOT NULL,
  deleted_at timestamptz(3),
  recorded_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id,kind,id,revision),
  FOREIGN KEY (user_id,kind,id) REFERENCES evimed_product.documents(user_id,kind,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS evimed_product.jobs (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  project_id text,
  kind text NOT NULL CONSTRAINT product_jobs_kind_check CHECK (kind IN (${PRODUCT_JOB_KINDS.map((x) => `'${x}'`).join(",")})),
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','canceled')),
  result jsonb,
  error jsonb,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  run_after timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  worker_id text,
  lease_token text,
  lease_expires_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz(3),
  UNIQUE(user_id,idempotency_key),
  FOREIGN KEY (user_id,project_id) REFERENCES evimed_control.projects(user_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS product_jobs_claim_idx ON evimed_product.jobs(kind,run_after,id)
  WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS product_jobs_owner_idx ON evimed_product.jobs(user_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS product_jobs_project_fk_idx ON evimed_product.jobs(user_id,project_id);
CREATE INDEX IF NOT EXISTS product_jobs_queued_time_idx ON evimed_product.jobs(kind,run_after,id) WHERE status='queued';
CREATE INDEX IF NOT EXISTS product_jobs_running_lease_idx ON evimed_product.jobs(kind,lease_expires_at,id) WHERE status='running';
DO $migration$
DECLARE constraint_name text;
BEGIN
  -- CREATE TABLE IF NOT EXISTS retains the legacy unnamed CHECK. Replace every
  -- single-column kind CHECK before installing the named, current vocabulary.
  FOR constraint_name IN
    SELECT c.conname FROM pg_constraint c
    JOIN pg_class t ON t.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='evimed_product' AND t.relname='jobs' AND c.contype='c'
      AND pg_get_constraintdef(c.oid) LIKE 'CHECK ((kind = ANY%'
      AND c.conname <> 'product_jobs_kind_check'
  LOOP
    EXECUTE format('ALTER TABLE evimed_product.jobs DROP CONSTRAINT %I', constraint_name);
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='evimed_product' AND t.relname='jobs' AND c.conname='product_jobs_kind_check'
      AND pg_get_constraintdef(c.oid) LIKE '%plugin-apply%'
  ) THEN
    ALTER TABLE evimed_product.jobs DROP CONSTRAINT IF EXISTS product_jobs_kind_check;
    ALTER TABLE evimed_product.jobs ADD CONSTRAINT product_jobs_kind_check
      CHECK (kind IN (${PRODUCT_JOB_KINDS.map((x) => `'${x}'`).join(",")}));
  END IF;
END $migration$;
INSERT INTO evimed_product.schema_migrations(name) VALUES ('2026-09-06-plugin-apply-v1') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS evimed_product.plugin_prompt_admissions (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  project_id text NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (user_id,project_id) REFERENCES evimed_control.projects(user_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS plugin_prompt_admissions_project_idx ON evimed_product.plugin_prompt_admissions(user_id,project_id);
CREATE TABLE IF NOT EXISTS evimed_product.plugin_application_state (
  user_id text NOT NULL,
  kind text NOT NULL DEFAULT 'plugin' CHECK (kind='plugin'),
  id text NOT NULL,
  desired_revision integer NOT NULL,
  phase text NOT NULL CHECK (phase IN ('saved','pending','applying','effective','rolled_back','unavailable','failed')),
  effective jsonb,
  last_good jsonb,
  runtime_generation text,
  error text,
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id,id),
  FOREIGN KEY (user_id,kind,id) REFERENCES evimed_product.documents(user_id,kind,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS evimed_product.memory_index_state (
  user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  capsule_id text NOT NULL,
  account_created_at text NOT NULL,
  fingerprint text NOT NULL,
  entry_count integer NOT NULL CHECK (entry_count >= 0),
  status text NOT NULL CONSTRAINT memory_index_state_status_check CHECK (status IN ('published','retired')),
  engine_memory_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(engine_memory_ids)='array'),
  last_job_id text NOT NULL,
  published_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  verified_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id,capsule_id)
);
DO $foreign_keys$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='evimed_product' AND t.relname='documents' AND c.contype='f'
      AND pg_get_constraintdef(c.oid) LIKE 'FOREIGN KEY (user_id) REFERENCES evimed_control.users(id)%'
  ) THEN
    ALTER TABLE evimed_product.documents ADD CONSTRAINT product_documents_user_fk
      FOREIGN KEY (user_id) REFERENCES evimed_control.users(id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='evimed_product' AND t.relname='documents' AND c.contype='f'
      AND pg_get_constraintdef(c.oid) LIKE 'FOREIGN KEY (user_id, project_id) REFERENCES evimed_control.projects(user_id, id)%'
  ) THEN
    ALTER TABLE evimed_product.documents ADD CONSTRAINT product_documents_project_fk
      FOREIGN KEY (user_id,project_id) REFERENCES evimed_control.projects(user_id,id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='evimed_product' AND t.relname='revisions' AND c.contype='f'
      AND pg_get_constraintdef(c.oid) LIKE 'FOREIGN KEY (user_id, kind, id) REFERENCES evimed_product.documents(user_id, kind, id)%'
  ) THEN
    ALTER TABLE evimed_product.revisions ADD CONSTRAINT product_revisions_document_fk
      FOREIGN KEY (user_id,kind,id) REFERENCES evimed_product.documents(user_id,kind,id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='evimed_product' AND t.relname='jobs' AND c.contype='f'
      AND pg_get_constraintdef(c.oid) LIKE 'FOREIGN KEY (user_id) REFERENCES evimed_control.users(id)%'
  ) THEN
    ALTER TABLE evimed_product.jobs ADD CONSTRAINT product_jobs_user_fk
      FOREIGN KEY (user_id) REFERENCES evimed_control.users(id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='evimed_product' AND t.relname='jobs' AND c.contype='f'
      AND pg_get_constraintdef(c.oid) LIKE 'FOREIGN KEY (user_id, project_id) REFERENCES evimed_control.projects(user_id, id)%'
  ) THEN
    ALTER TABLE evimed_product.jobs ADD CONSTRAINT product_jobs_project_fk
      FOREIGN KEY (user_id,project_id) REFERENCES evimed_control.projects(user_id,id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='evimed_product' AND t.relname='memory_index_state' AND c.contype='f'
      AND pg_get_constraintdef(c.oid) LIKE 'FOREIGN KEY (user_id) REFERENCES evimed_control.users(id)%'
  ) THEN
    ALTER TABLE evimed_product.memory_index_state ADD CONSTRAINT memory_index_state_user_fk
      FOREIGN KEY (user_id) REFERENCES evimed_control.users(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $foreign_keys$;
CREATE TABLE IF NOT EXISTS evimed_product.feedback_events (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  project_id text,
  run_id text,
  trigger_kind text NOT NULL CONSTRAINT feedback_events_trigger_check CHECK (trigger_kind IN (${FEEDBACK_EVENT_TRIGGERS.map((x) => `'${x}'`).join(",")})),
  subject_type text NOT NULL CONSTRAINT feedback_events_subject_check CHECK (subject_type IN (${FEEDBACK_SUBJECT_TYPES.map((x) => `'${x}'`).join(",")})),
  subject_id text NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 400),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  occurred_at timestamptz(3) NOT NULL,
  recorded_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (user_id,project_id) REFERENCES evimed_control.projects(user_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS feedback_events_subject_idx ON evimed_product.feedback_events(user_id,subject_type,subject_id,occurred_at DESC,id);
CREATE INDEX IF NOT EXISTS feedback_events_owner_idx ON evimed_product.feedback_events(user_id,occurred_at DESC,id);
CREATE INDEX IF NOT EXISTS feedback_events_project_fk_idx ON evimed_product.feedback_events(user_id,project_id);
INSERT INTO evimed_product.schema_migrations(name) VALUES ('2026-09-07-feedback-events-v1') ON CONFLICT DO NOTHING;
ALTER TABLE evimed_product.memory_index_state ADD COLUMN IF NOT EXISTS verified_at timestamptz(3) NOT NULL DEFAULT clock_timestamp();
CREATE OR REPLACE FUNCTION evimed_product.enqueue_memory_index_job() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE capsule text;
DECLARE generation text;
DECLARE key text;
BEGIN
  capsule := CASE WHEN NEW.kind='capsule' THEN NEW.id ELSE NEW.payload->>'capsuleId' END;
  IF capsule IS NULL OR capsule='' THEN RETURN NEW; END IF;
  SELECT created_at::text INTO generation FROM evimed_control.users WHERE id=NEW.user_id;
  IF generation IS NULL THEN RETURN NEW; END IF;
  key := 'memory-index:v1:' || md5(NEW.user_id || chr(31) || generation || chr(31) || NEW.kind || chr(31) || NEW.id || chr(31) || NEW.revision::text);
  INSERT INTO evimed_product.jobs(id,user_id,kind,payload,idempotency_key,project_id,max_attempts)
  VALUES ('memory-index-job:' || md5(key),NEW.user_id,'memory-index',jsonb_build_object(
    'capsuleId',capsule,'documentKind',NEW.kind,'documentId',NEW.id,'revision',NEW.revision,'accountCreatedAt',generation
  ),key,NULL,10)
  ON CONFLICT(user_id,idempotency_key) DO NOTHING;
  RETURN NEW;
END $function$;
DROP TRIGGER IF EXISTS product_documents_memory_index_outbox ON evimed_product.documents;
CREATE TRIGGER product_documents_memory_index_outbox
AFTER INSERT OR UPDATE OF payload,revision,deleted_at ON evimed_product.documents
FOR EACH ROW WHEN (NEW.kind IN ('capsule','fact')) EXECUTE FUNCTION evimed_product.enqueue_memory_index_job();
INSERT INTO evimed_product.schema_migrations(name) VALUES ('2026-09-05-memory-index-outbox-v1') ON CONFLICT DO NOTHING;
`;

/** Idempotent across processes; only the control-plane connection performs DDL.
 * @param {any} database */
export async function migrateProductStore(database) {
  if (migrations.has(database)) return migrations.get(database);
  const attempt = database.transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-product-v1'))");
    await client.query(sql);
  });
  migrations.set(database, attempt);
  try { await attempt; }
  catch (error) { migrations.delete(database); throw error; }
}

/** @param {unknown} value @param {string} field @returns {string} */
export function productId(value, field = "id") {
  if (typeof value !== "string" || !value.trim() || value.length > 200 || [...value].some((char) => char.charCodeAt(0) < 32)) {
    throw new HttpError(400, "product_identifier_invalid", `Invalid ${field}.`);
  }
  return value;
}

/** @param {unknown} value @param {readonly string[]} allowed @returns {string} */
export function productKind(value, allowed = PRODUCT_KINDS) {
  if (!allowed.includes(String(value))) throw new HttpError(400, "product_kind_invalid", "Unknown product record kind.");
  return String(value);
}

/** @param {unknown} value @returns {string} */
export function productPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "product_document_invalid", "A product record must be an object.");
  }
  let text;
  try { text = JSON.stringify(value); }
  catch { throw new HttpError(400, "product_document_invalid", "A product record must contain serializable JSON."); }
  if (Buffer.byteLength(text) > 262_144) throw new HttpError(413, "product_document_too_large", "A product record exceeds 256 KiB.");
  return text;
}

/** @param {unknown} value @param {number} min @param {number} max @returns {number} */
export function productInteger(value, min, max) {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new HttpError(400, "product_parameter_invalid", `Expected an integer between ${min} and ${max}.`);
  }
  return Number(value);
}

/** @param {any} value @returns {string | null} */
export function productTime(value) { return value == null ? null : new Date(value).toISOString(); }
