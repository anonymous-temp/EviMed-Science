import { HttpError } from "./security.mjs";
import { EXTENSION_PRODUCT_KINDS, EXTENSION_JOB_KINDS, EVOLUTION_JOB_KINDS } from "@evimed/domain";

export const PRODUCT_KINDS = Object.freeze([
  "capsule", "fact", "method", "source", "source-unit", "knowledge", "profile",
  "agenda", "episode", "digest", "notification", "preferences", "plugin", "price-list",
  // The candidates one project is mounting under trial. One row per project,
  // written only by an evaluation identity, read by every launch of that
  // project. Its own kind rather than a field on `method`, because it is a
  // property of the project's next run and not of any one method: a method can
  // be on trial in one project and absent from another at the same instant.
  "method-trial", "document-export", "result-version", "result-impact", "result-revision", "result-replay", ...EXTENSION_PRODUCT_KINDS,
  // What a project's datasets mean: one document per dataset, the recorded interpretation a repeat analysis starts from.
  "dataset-semantics",
  // What was published about a work after it was published (a retraction, a correction, an expression of concern, a new
  // version), one document per source identifier. Platform-level: owned by the platform publisher account, holding only
  // public bibliographic facts and never which tenant asked (`sourceChanges.mjs`, plan 2026-10-05 B5).
  "source-change",
  // What the platform's evidence programme decided on one day, and why: the counts it read, the zones it chose, what became of each
  // episode. One document per day, owned by the platform publisher in its internal evidence project (`evidenceProgramme.mjs`).
  "programme-decision",
]);
// Frontier issues, reader notifications and operator rebuilds use the shared
// durable ledger. Its per-entry queue — thousands of rows a day — lives in
// `evimed_frontier`'s own state and lease columns, where it cannot drown this.
export const PRODUCT_JOB_KINDS = Object.freeze(["ingest", "distill", "consolidate", "episode", "verify", "digest", "notify", "memory-index", "memory-record-index", "plugin-apply",
  "frontier-daily", "frontier-rebuild", "frontier-weekly", "frontier-notify", "document-export", "study-review", "result-replay",
  // One finished run joined to the capability, skill and tool versions it used and to the result versions it
  // produced (`availabilityCollector.mjs`), and the sweep that finds runs the finish hook missed.
  "availability-collect", ...EVOLUTION_JOB_KINDS, ...EXTENSION_JOB_KINDS,
  // The evidence programme's one decision a day (`evidenceProgramme.mjs`): the topic selector's run, leased like every other job.
  "evidence-programme"]);

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
  // A correction made through the anchored revision, with the immutable pair of result versions it produced (N12).
  "result-corrected",
]);

/** What a feedback event can be about. A `result-version` is an immutable result version, named by its version id. */
export const FEEDBACK_SUBJECT_TYPES = Object.freeze(["memory-record", "deliverable", "result-version"]);

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
ALTER TABLE evimed_product.maintenance_lease ADD COLUMN IF NOT EXISTS durable_hold boolean NOT NULL DEFAULT false;
INSERT INTO evimed_product.schema_migrations(name) VALUES ('2026-10-01-maintenance-durable-hold-v1') ON CONFLICT DO NOTHING;
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
DO $method_trial_kind$
BEGIN
  -- The same shape as the block above, and it needs its own: that one only
  -- re-adds the constraint when the existing one does not already mention the
  -- digest kind, so on a deployment that has already run it a newly added kind
  -- would be refused by a constraint nothing would rebuild -- and the symptom
  -- would be a 500 on the first write of the new kind, months later.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c WHERE c.conrelid='evimed_product.documents'::regclass
      AND c.conname='product_documents_kind_check' AND pg_get_constraintdef(c.oid) LIKE '%method-trial%'
  ) THEN
    ALTER TABLE evimed_product.documents DROP CONSTRAINT IF EXISTS product_documents_kind_check;
    ALTER TABLE evimed_product.documents ADD CONSTRAINT product_documents_kind_check
      CHECK (kind IN (${PRODUCT_KINDS.map((x) => `'${x}'`).join(",")}));
  END IF;
END $method_trial_kind$;
INSERT INTO evimed_product.schema_migrations(name) VALUES ('2026-09-10-product-method-trial-kind-v1') ON CONFLICT DO NOTHING;
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
DO $migration$
BEGIN
  -- The research-memory outbox. A kind the CHECK does not list is refused by
  -- the database, so this has to reach an existing deployment before the first
  -- memory is written there, not when somebody next recreates the table.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='evimed_product' AND t.relname='jobs' AND c.conname='product_jobs_kind_check'
      AND pg_get_constraintdef(c.oid) LIKE '%memory-record-index%'
  ) THEN
    ALTER TABLE evimed_product.jobs DROP CONSTRAINT IF EXISTS product_jobs_kind_check;
    ALTER TABLE evimed_product.jobs ADD CONSTRAINT product_jobs_kind_check
      CHECK (kind IN (${PRODUCT_JOB_KINDS.map((x) => `'${x}'`).join(",")}));
  END IF;
END $migration$;
INSERT INTO evimed_product.schema_migrations(name) VALUES ('2026-09-13-memory-record-index-v1') ON CONFLICT DO NOTHING;
DO $migration$
BEGIN
  -- The frontier feed's two kinds (2026-09-22). Its own block, for the reason
  -- the method-trial block above gives: the blocks before this one rebuild the
  -- constraint only when it lacks *their* kind, so on a deployment that has
  -- run them all, nothing else would ever let these two in.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='evimed_product' AND t.relname='jobs' AND c.conname='product_jobs_kind_check'
      AND pg_get_constraintdef(c.oid) LIKE '%frontier-notify%'
  ) THEN
    ALTER TABLE evimed_product.jobs DROP CONSTRAINT IF EXISTS product_jobs_kind_check;
    ALTER TABLE evimed_product.jobs ADD CONSTRAINT product_jobs_kind_check
      CHECK (kind IN (${PRODUCT_JOB_KINDS.map((x) => `'${x}'`).join(",")}));
  END IF;
END $migration$;
INSERT INTO evimed_product.schema_migrations(name) VALUES ('2026-09-22-frontier-job-kinds-v1') ON CONFLICT DO NOTHING;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='evimed_product' AND t.relname='documents' AND c.conname='product_documents_kind_check'
      AND pg_get_constraintdef(c.oid) LIKE '%document-export%') THEN
    ALTER TABLE evimed_product.documents DROP CONSTRAINT IF EXISTS product_documents_kind_check;
    ALTER TABLE evimed_product.documents ADD CONSTRAINT product_documents_kind_check
      CHECK (kind IN (${PRODUCT_KINDS.map((x) => `'${x}'`).join(",")}));
  END IF;
END $migration$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='evimed_product' AND t.relname='jobs' AND c.conname='product_jobs_kind_check'
      AND pg_get_constraintdef(c.oid) LIKE '%document-export%') THEN
    ALTER TABLE evimed_product.jobs DROP CONSTRAINT IF EXISTS product_jobs_kind_check;
    ALTER TABLE evimed_product.jobs ADD CONSTRAINT product_jobs_kind_check
      CHECK (kind IN (${PRODUCT_JOB_KINDS.map((x) => `'${x}'`).join(",")}));
  END IF;
END $migration$;
INSERT INTO evimed_product.schema_migrations(name) VALUES ('2026-09-30-document-export-v1') ON CONFLICT DO NOTHING;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='evimed_product' AND t.relname='jobs' AND c.conname='product_jobs_kind_check'
      AND pg_get_constraintdef(c.oid) LIKE '%study-review%') THEN
    ALTER TABLE evimed_product.jobs DROP CONSTRAINT IF EXISTS product_jobs_kind_check;
    ALTER TABLE evimed_product.jobs ADD CONSTRAINT product_jobs_kind_check
      CHECK (kind IN (${PRODUCT_JOB_KINDS.map((x) => `'${x}'`).join(",")}));
  END IF;
END $migration$;
INSERT INTO evimed_product.schema_migrations(name) VALUES ('2026-10-01-study-review-v1') ON CONFLICT DO NOTHING;
DO $extension_center_kinds$
BEGIN
  -- Every new kind must be present: old installations already have all of
  -- the earlier markers, which cannot cause their constraints to rebuild.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid='evimed_product.documents'::regclass
      AND c.conname='product_documents_kind_check'
      AND ${EXTENSION_PRODUCT_KINDS.map(kind => `position('''${kind}''' in pg_get_constraintdef(c.oid)) > 0`).join(" AND ")}) THEN
    ALTER TABLE evimed_product.documents DROP CONSTRAINT IF EXISTS product_documents_kind_check;
    ALTER TABLE evimed_product.documents ADD CONSTRAINT product_documents_kind_check
      CHECK (kind IN (${PRODUCT_KINDS.map(kind => `'${kind}'`).join(",")}));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid='evimed_product.jobs'::regclass
      AND c.conname='product_jobs_kind_check'
      AND ${EXTENSION_JOB_KINDS.map(kind => `position('''${kind}''' in pg_get_constraintdef(c.oid)) > 0`).join(" AND ")}) THEN
    ALTER TABLE evimed_product.jobs DROP CONSTRAINT IF EXISTS product_jobs_kind_check;
    ALTER TABLE evimed_product.jobs ADD CONSTRAINT product_jobs_kind_check
      CHECK (kind IN (${PRODUCT_JOB_KINDS.map(kind => `'${kind}'`).join(",")}));
  END IF;
END $extension_center_kinds$;
INSERT INTO evimed_product.schema_migrations(name) VALUES ('2026-10-02-extension-center-kinds-v1') ON CONFLICT DO NOTHING;
DO $result_workbench_kinds$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid='evimed_product.documents'::regclass
      AND c.conname='product_documents_kind_check'
      AND ${["result-version", "result-impact", "result-revision", "result-replay"].map(kind => `position('''${kind}''' in pg_get_constraintdef(c.oid)) > 0`).join(" AND ")}) THEN
    ALTER TABLE evimed_product.documents DROP CONSTRAINT IF EXISTS product_documents_kind_check;
    ALTER TABLE evimed_product.documents ADD CONSTRAINT product_documents_kind_check
      CHECK (kind IN (${PRODUCT_KINDS.map(kind => `'${kind}'`).join(",")}));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid='evimed_product.jobs'::regclass
      AND c.conname='product_jobs_kind_check' AND position('''result-replay''' in pg_get_constraintdef(c.oid)) > 0) THEN
    ALTER TABLE evimed_product.jobs DROP CONSTRAINT IF EXISTS product_jobs_kind_check;
    ALTER TABLE evimed_product.jobs ADD CONSTRAINT product_jobs_kind_check
      CHECK (kind IN (${PRODUCT_JOB_KINDS.map(kind => `'${kind}'`).join(",")}));
  END IF;
END $result_workbench_kinds$;
INSERT INTO evimed_product.schema_migrations(name) VALUES ('2026-10-02-result-workbench-v1') ON CONFLICT DO NOTHING;
DO $dataset_semantics_kind$
BEGIN
  -- Its own block, for the reason the method-trial block gives: the blocks before this one rebuild the
  -- constraint only when it lacks *their* kind.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid='evimed_product.documents'::regclass
      AND c.conname='product_documents_kind_check' AND position('''dataset-semantics''' in pg_get_constraintdef(c.oid)) > 0) THEN
    ALTER TABLE evimed_product.documents DROP CONSTRAINT IF EXISTS product_documents_kind_check;
    ALTER TABLE evimed_product.documents ADD CONSTRAINT product_documents_kind_check
      CHECK (kind IN (${PRODUCT_KINDS.map(kind => `'${kind}'`).join(",")}));
  END IF;
END $dataset_semantics_kind$;
INSERT INTO evimed_product.schema_migrations(name) VALUES ('2026-10-04-dataset-semantics-kind-v1') ON CONFLICT DO NOTHING;
DO $source_change_kind$
BEGIN
  -- Its own block, for the reason the method-trial block gives: the blocks before this one rebuild the
  -- constraint only when it lacks *their* kind.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid='evimed_product.documents'::regclass
      AND c.conname='product_documents_kind_check' AND position('''source-change''' in pg_get_constraintdef(c.oid)) > 0) THEN
    ALTER TABLE evimed_product.documents DROP CONSTRAINT IF EXISTS product_documents_kind_check;
    ALTER TABLE evimed_product.documents ADD CONSTRAINT product_documents_kind_check
      CHECK (kind IN (${PRODUCT_KINDS.map(kind => `'${kind}'`).join(",")}));
  END IF;
END $source_change_kind$;
-- The feed of source changes is read by position ('changedSince'): the last position of the one owner, and the
-- records after a position, both from this index. A record that holds no change yet has no position and is not in it.
CREATE INDEX IF NOT EXISTS product_source_change_seq_idx ON evimed_product.documents (user_id, ((payload->>'seq')::bigint))
  WHERE kind='source-change' AND deleted_at IS NULL;
INSERT INTO evimed_product.schema_migrations(name) VALUES ('2026-10-05-source-change-kind-v1') ON CONFLICT DO NOTHING;
DO $programme_decision_kind$
BEGIN
  -- Its own block, for the reason the method-trial block gives: the blocks before this one rebuild the
  -- constraint only when it lacks *their* kind.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid='evimed_product.documents'::regclass
      AND c.conname='product_documents_kind_check' AND position('''programme-decision''' in pg_get_constraintdef(c.oid)) > 0) THEN
    ALTER TABLE evimed_product.documents DROP CONSTRAINT IF EXISTS product_documents_kind_check;
    ALTER TABLE evimed_product.documents ADD CONSTRAINT product_documents_kind_check
      CHECK (kind IN (${PRODUCT_KINDS.map(kind => `'${kind}'`).join(",")}));
  END IF;
END $programme_decision_kind$;
INSERT INTO evimed_product.schema_migrations(name) VALUES ('2026-10-05-programme-decision-kind-v1') ON CONFLICT DO NOTHING;
DO $availability_kind$
BEGIN
  -- Its own block, for the reason the method-trial block gives: the blocks before
  -- this one rebuild the constraint only when it lacks *their* kind.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid='evimed_product.jobs'::regclass
      AND c.conname='product_jobs_kind_check' AND position('''availability-collect''' in pg_get_constraintdef(c.oid)) > 0) THEN
    ALTER TABLE evimed_product.jobs DROP CONSTRAINT IF EXISTS product_jobs_kind_check;
    ALTER TABLE evimed_product.jobs ADD CONSTRAINT product_jobs_kind_check
      CHECK (kind IN (${PRODUCT_JOB_KINDS.map(kind => `'${kind}'`).join(",")}));
  END IF;
END $availability_kind$;
DO $evolution_job_kinds$
BEGIN
  -- 「循证进化」's eight job kinds. Its own block, for the reason the method-trial block gives: every
  -- block before this one rebuilds the constraint only when it lacks *its* kind, so on a deployment
  -- that has run them all (every one that exists) nothing else would ever let these in, and the
  -- first enqueue would be refused by the database. A fresh database builds the constraint from
  -- the list above and never shows it.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid='evimed_product.jobs'::regclass
      AND c.conname='product_jobs_kind_check'
      AND ${EVOLUTION_JOB_KINDS.map(kind => `position('''${kind}''' in pg_get_constraintdef(c.oid)) > 0`).join(" AND ")}) THEN
    ALTER TABLE evimed_product.jobs DROP CONSTRAINT IF EXISTS product_jobs_kind_check;
    ALTER TABLE evimed_product.jobs ADD CONSTRAINT product_jobs_kind_check
      CHECK (kind IN (${PRODUCT_JOB_KINDS.map(kind => `'${kind}'`).join(",")}));
  END IF;
END $evolution_job_kinds$;
DO $programme_job_kind$
BEGIN
  -- The evidence programme's job kind, in its own block for the same reason: the evolution block above rebuilds
  -- the constraint only when it lacks *its* kinds.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid='evimed_product.jobs'::regclass
      AND c.conname='product_jobs_kind_check' AND position('''evidence-programme''' in pg_get_constraintdef(c.oid)) > 0) THEN
    ALTER TABLE evimed_product.jobs DROP CONSTRAINT IF EXISTS product_jobs_kind_check;
    ALTER TABLE evimed_product.jobs ADD CONSTRAINT product_jobs_kind_check
      CHECK (kind IN (${PRODUCT_JOB_KINDS.map(kind => `'${kind}'`).join(",")}));
  END IF;
END $programme_job_kind$;
INSERT INTO evimed_product.schema_migrations(name) VALUES ('2026-10-05-evolution-job-kinds-v1') ON CONFLICT DO NOTHING;
-- What finished operations say about a capability version, a tool, a skill or an extension on THIS
-- deployment (the availability projection's evidence). One row per subject and exact version, folded
-- by the collector in the same transaction that completes the job for one run. Deployment-wide by
-- design, so it carries no user_id: counts and times, and the opaque references of the last success
-- and the last failure for the operator's export.
CREATE TABLE IF NOT EXISTS evimed_product.availability_operations (
  kind text NOT NULL CHECK (kind IN ('capability','tool','skill','extension')),
  id text NOT NULL CHECK (length(id) BETWEEN 1 AND 200),
  version text NOT NULL DEFAULT '' CHECK (length(version) <= 200),
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (kind, id, version)
);
INSERT INTO evimed_product.schema_migrations(name) VALUES ('2026-10-04-availability-operations-v1') ON CONFLICT DO NOTHING;
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
-- Why an apply ended where it did: the failure of each step that failed (the
-- candidate, the rollback or the restore to defaults, the probe of what was
-- running before), as {code,message}. The error column stays the one outcome code the
-- browser reads; this is for whoever has to find out what happened, which the
-- first production apply (2026-09-27) left nobody able to do.
ALTER TABLE evimed_product.plugin_application_state ADD COLUMN IF NOT EXISTS error_detail jsonb;
CREATE TABLE IF NOT EXISTS evimed_product.memory_index_state (
  user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  capsule_id text NOT NULL,
  account_created_at text NOT NULL,
  fingerprint text NOT NULL,
  entry_count integer NOT NULL CHECK (entry_count >= 0),
  status text NOT NULL CONSTRAINT memory_index_state_status_check CHECK (status IN ('published','retired')),
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
DO $feedback_vocabulary$
BEGIN
  -- CREATE TABLE IF NOT EXISTS leaves an existing table's constraints as they were, so a trigger or a subject type added
  -- to the vocabulary above is refused by the database of every deployment that already has the table, on the first
  -- write of it, until the constraint is rebuilt. One block per constraint, each guarded by the word it must now hold.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c WHERE c.conrelid='evimed_product.feedback_events'::regclass
      AND c.conname='feedback_events_trigger_check' AND pg_get_constraintdef(c.oid) LIKE '%result-corrected%'
  ) THEN
    ALTER TABLE evimed_product.feedback_events DROP CONSTRAINT IF EXISTS feedback_events_trigger_check;
    ALTER TABLE evimed_product.feedback_events ADD CONSTRAINT feedback_events_trigger_check
      CHECK (trigger_kind IN (${FEEDBACK_EVENT_TRIGGERS.map((x) => `'${x}'`).join(",")}));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c WHERE c.conrelid='evimed_product.feedback_events'::regclass
      AND c.conname='feedback_events_subject_check' AND pg_get_constraintdef(c.oid) LIKE '%result-version%'
  ) THEN
    ALTER TABLE evimed_product.feedback_events DROP CONSTRAINT IF EXISTS feedback_events_subject_check;
    ALTER TABLE evimed_product.feedback_events ADD CONSTRAINT feedback_events_subject_check
      CHECK (subject_type IN (${FEEDBACK_SUBJECT_TYPES.map((x) => `'${x}'`).join(",")}));
  END IF;
END $feedback_vocabulary$;
INSERT INTO evimed_product.schema_migrations(name) VALUES ('2026-10-04-feedback-result-corrected-v1') ON CONFLICT DO NOTHING;
-- Which conversations used a document (N-16): a search hit or a direct read of its parsed text, read off a finished run's
-- transcript (sourceUses.mjs). One row per document, run and kind; recording a run again changes nothing. Owned by the
-- account and, through the run's project, by that project; a document's deletion removes its rows (SourceService.remove).
CREATE TABLE IF NOT EXISTS evimed_product.source_uses (
  user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  source_id text NOT NULL CHECK (char_length(source_id) BETWEEN 1 AND 160),
  run_id text NOT NULL CHECK (char_length(run_id) BETWEEN 1 AND 200),
  session_id text NOT NULL CHECK (char_length(session_id) BETWEEN 1 AND 200),
  kind text NOT NULL CONSTRAINT source_uses_kind_check CHECK (kind IN ('search','read')),
  uses integer NOT NULL CHECK (uses > 0),
  first_used_at timestamptz(3) NOT NULL,
  last_used_at timestamptz(3) NOT NULL,
  PRIMARY KEY (user_id, source_id, run_id, kind),
  CONSTRAINT source_uses_span_check CHECK (last_used_at >= first_used_at),
  FOREIGN KEY (user_id, project_id) REFERENCES evimed_control.projects(user_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS source_uses_source_idx ON evimed_product.source_uses(user_id, source_id, last_used_at DESC);
CREATE INDEX IF NOT EXISTS source_uses_project_fk_idx ON evimed_product.source_uses(user_id, project_id);
INSERT INTO evimed_product.schema_migrations(name) VALUES ('2026-10-09-source-uses-v1') ON CONFLICT DO NOTHING;
ALTER TABLE evimed_product.memory_index_state ADD COLUMN IF NOT EXISTS verified_at timestamptz(3) NOT NULL DEFAULT clock_timestamp();
-- The engine's own record ids were a MemOS-era receipt; the index is addressed
-- by path now, and a readback reads those paths. CREATE TABLE IF NOT EXISTS
-- leaves an existing table alone, so removing the column from the definition
-- above is only half the migration — this is the other half.
ALTER TABLE evimed_product.memory_index_state DROP COLUMN IF EXISTS engine_memory_ids;
INSERT INTO evimed_product.schema_migrations(name) VALUES ('2026-09-11-memory-index-openviking-v1') ON CONFLICT DO NOTHING;
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
-- A learned method is the account's, not a project's (2026-09-27, audit L-G1).
-- Filed under the project it was learnt in, it went with that project through
-- documents(user_id,project_id) -> projects ON DELETE CASCADE, revisions and
-- all: pre-submission-freeze-check on 2026-09-23. The project stays a fact of
-- its provenance. Neither the revision nor updated_at moves: this is where the
-- row is filed, not a change of the method. Unguarded and idempotent, so a
-- method written with a project by an older process is moved at the next start.
UPDATE evimed_product.documents
   SET payload = payload || jsonb_build_object('provenance',
         coalesce(payload->'provenance','{}'::jsonb) || jsonb_build_object('sourceProjectId',
           coalesce(payload #>> '{provenance,sourceProjectId}', project_id))),
       project_id = NULL
 WHERE kind='method' AND project_id IS NOT NULL
   AND payload->>'recordType' IN ('learned-method','handbook-candidate');
-- Which body a method is on, counted from its saved revisions: a new text is a
-- new version, a counter write or a status change of the same text is not
-- (audit L-G4). Once, for the methods written before the count existed.
DO $method_body_versions$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM evimed_product.schema_migrations WHERE name='2026-09-27-account-level-methods-v1') THEN
    UPDATE evimed_product.documents d
       SET payload = d.payload || jsonb_build_object(
             'bodyVersion', v.versions,
             'bodyUpdatedAt', to_char(v.changed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      FROM (
        SELECT user_id, kind, id,
               count(*) FILTER (WHERE digest IS DISTINCT FROM previous)::integer AS versions,
               max(recorded_at) FILTER (WHERE digest IS DISTINCT FROM previous) AS changed_at
          FROM (SELECT user_id, kind, id, recorded_at, payload->>'contentDigest' AS digest,
                       lag(payload->>'contentDigest') OVER (PARTITION BY user_id, kind, id ORDER BY revision) AS previous
                  FROM evimed_product.revisions WHERE kind='method') r
         GROUP BY user_id, kind, id
      ) v
     WHERE d.user_id=v.user_id AND d.kind=v.kind AND d.id=v.id AND d.kind='method'
       AND d.payload->>'recordType'='learned-method' AND NOT (d.payload ? 'bodyVersion') AND v.versions >= 1;
  END IF;
END $method_body_versions$;
INSERT INTO evimed_product.schema_migrations(name) VALUES ('2026-09-27-account-level-methods-v1') ON CONFLICT DO NOTHING;
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
