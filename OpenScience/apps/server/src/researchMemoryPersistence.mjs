/**
 * The research-memory schema: the authoritative home of structured memory
 * records and manual notes.
 *
 * These rows used to live in a separate service with its own database, reached
 * over REST. They are ordinary account-scoped product state — one row per
 * memory, owned by exactly one user, compare-and-swapped on a version — so they
 * belong in the control-plane database next to every other such table, where a
 * foreign key can guarantee what an HTTP call could only attempt: that deleting
 * an account deletes its memory.
 *
 * A schema of its own rather than `evimed_product.documents`, because a memory
 * record needs three things the documents ledger does not give: a unique
 * canonical key (scope, scope id, kind, key), hard deletion for "forget my
 * memory", and a bounded in-row history. The ledger's unbounded revision table
 * would copy up to 64 evidence quotes on every evidence append.
 */
const migrations = new WeakMap();

/** The closed vocabularies. They are defined here, next to the CHECK
 *  constraints generated from them, so the database and the code cannot end up
 *  holding two different lists — the same reason `PRODUCT_KINDS` lives in
 *  `productPersistence.mjs`. */
export const MEMORY_SCOPES = Object.freeze(["user", "project", "session", "organization"]);
export const MEMORY_KINDS = Object.freeze([
  "profile", "preference", "behavior", "project_fact", "analysis",
  "decision", "correction", "follow_up", "run_summary",
]);
/** What a person calls each kind — the memory page's own words. A record's
 *  `key` (`preference.response_length`) is an identifier, never a name on screen. */
export const MEMORY_KIND_LABELS_ZH = Object.freeze({
  profile: "用户画像", preference: "偏好", behavior: "行为习惯", project_fact: "项目事实", analysis: "分析要素",
  decision: "决定", correction: "纠正", follow_up: "待跟进", run_summary: "运行摘要",
});
export const MEMORY_ORIGINS = Object.freeze(["explicit", "inferred", "system", "manual"]);
export const MEMORY_STATUSES = Object.freeze(["active", "pending", "superseded", "archived"]);
export const MEMORY_NOTE_STATES = Object.freeze(["normal", "archived"]);

/** How much history one record carries. Both are enforced twice on purpose: in
 *  the store, which trims before writing, and here, so a second writer — the
 *  import script, a future one — cannot make a record unbounded. */
export const MEMORY_EVIDENCE_LIMIT = 64;
export const MEMORY_REVISION_LIMIT = 32;
/** How many projects one account may pause memory for. A project id list, so
 *  bounded like every other array this schema stores. */
export const MEMORY_PAUSED_PROJECT_LIMIT = 100;
/** How many items one conversation may set aside with 「本次不用」. A recall
 *  hands back at most a few dozen, so this bounds a list, not a choice. */
export const MEMORY_SESSION_EXCLUSION_LIMIT = 200;
/** What 「本次不用」 can set aside: a structured memory, a note, a capsule fact
 *  or a mounted method — the four things a conversation is handed. */
export const MEMORY_SESSION_EXCLUSION_TYPES = Object.freeze(["memory", "note", "capsule", "method"]);

/** @param {readonly string[]} values */
function vocabulary(values) {
  return values.map((value) => `'${value}'`).join(",");
}

/**
 * Text limits are counted in characters, the unit the routes and the model
 * candidates already validate in. The retired service counted bytes, so the
 * same Chinese sentence passed every caller-side check and was then refused at
 * the boundary — a 4000-character quote is about 12000 bytes. `char_length`,
 * never `octet_length`: a CHECK stricter than the caller's own check is the
 * same defect in a place nobody reads.
 */
const sql = `
CREATE SCHEMA IF NOT EXISTS evimed_memory;
CREATE TABLE IF NOT EXISTS evimed_memory.records (
  user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  id text NOT NULL CHECK (id ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$'),
  scope text NOT NULL CHECK (scope IN (${vocabulary(MEMORY_SCOPES)})),
  scope_id text NOT NULL DEFAULT '' CHECK (char_length(scope_id) <= 255 AND ((scope = 'user') = (scope_id = ''))),
  kind text NOT NULL CHECK (kind IN (${vocabulary(MEMORY_KINDS)})),
  key text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9._/-]{0,254}$'),
  value text NOT NULL CHECK (char_length(value) BETWEEN 1 AND 100000),
  summary text NOT NULL DEFAULT '' CHECK (char_length(summary) <= 2000),
  origin text NOT NULL CHECK (origin IN (${vocabulary(MEMORY_ORIGINS)})),
  status text NOT NULL CHECK (status IN (${vocabulary(MEMORY_STATUSES)})),
  confidence double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  importance double precision NOT NULL CHECK (importance >= 0 AND importance <= 1),
  sensitive boolean NOT NULL DEFAULT false,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) <= ${MEMORY_EVIDENCE_LIMIT}),
  revisions jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(revisions) = 'array' AND jsonb_array_length(revisions) <= ${MEMORY_REVISION_LIMIT}),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz(3) NOT NULL DEFAULT date_trunc('second', clock_timestamp()),
  updated_at timestamptz(3) NOT NULL DEFAULT date_trunc('second', clock_timestamp()),
  last_confirmed_at timestamptz(3),
  expires_at timestamptz(3),
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, scope, scope_id, kind, key)
);
-- What a fact was replaced by, and from when it stopped holding (2026-09-20).
-- A dose, a drug, a population or a decision changes; the old fact is not
-- deleted and not left in force beside the new one — it is kept, pointing at
-- what replaced it, and the timeline shows it as 「曾经如此」. Added in place,
-- so an existing deployment gains them on its next start.
ALTER TABLE evimed_memory.records ADD COLUMN IF NOT EXISTS superseded_by text
  CHECK (superseded_by IS NULL OR superseded_by ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$');
ALTER TABLE evimed_memory.records ADD COLUMN IF NOT EXISTS invalid_since timestamptz(3);
CREATE INDEX IF NOT EXISTS memory_records_rank_idx ON evimed_memory.records
  (user_id, status, importance DESC, confidence DESC, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS memory_records_scope_idx ON evimed_memory.records (user_id, scope, scope_id, kind);
CREATE TABLE IF NOT EXISTS evimed_memory.notes (
  user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  id text NOT NULL CHECK (id ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$'),
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 100000),
  state text NOT NULL DEFAULT 'normal' CHECK (state IN (${vocabulary(MEMORY_NOTE_STATES)})),
  pinned boolean NOT NULL DEFAULT false,
  tags text[] NOT NULL DEFAULT '{}',
  created_at timestamptz(3) NOT NULL DEFAULT date_trunc('second', clock_timestamp()),
  updated_at timestamptz(3) NOT NULL DEFAULT date_trunc('second', clock_timestamp()),
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS memory_notes_order_idx ON evimed_memory.notes
  (user_id, state, pinned DESC, updated_at DESC, id DESC);
-- Every note searchable, not the newest hundred (plan §3.4 #8): the note's
-- tokens by the recall tokenizer (CJK bigrams included), written by
-- researchMemory on every write; NULL on a row written before this column,
-- filled lazily the first time that account's notes are searched.
ALTER TABLE evimed_memory.notes ADD COLUMN IF NOT EXISTS search_vector tsvector;
CREATE INDEX IF NOT EXISTS memory_notes_search_idx ON evimed_memory.notes USING GIN (search_vector);
-- The researcher's own switches over their memory. No row means every switch
-- is off, which is how the platform behaved before the switches existed.
CREATE TABLE IF NOT EXISTS evimed_memory.settings (
  user_id text PRIMARY KEY REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  learning_paused boolean NOT NULL DEFAULT false,
  recall_paused boolean NOT NULL DEFAULT false,
  paused_projects text[] NOT NULL DEFAULT '{}' CHECK (cardinality(paused_projects) <= ${MEMORY_PAUSED_PROJECT_LIMIT}),
  updated_at timestamptz(3) NOT NULL DEFAULT date_trunc('second', clock_timestamp())
);
-- One conversation's own memory state (2026-09-20): whether it is incognito —
-- nothing extracted from it, nothing recalled into it — and what the
-- researcher said 「本次不用」 to in its 「本次用到的背景」 panel. Keyed by the
-- kernel's session id inside a project; deleted with the account, and with the
-- project by deleteProjectMemory.
CREATE TABLE IF NOT EXISTS evimed_memory.sessions (
  user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  project_id text NOT NULL CHECK (project_id ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$'),
  session_id text NOT NULL CHECK (session_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  incognito boolean NOT NULL DEFAULT false,
  excluded jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(excluded) = 'array' AND jsonb_array_length(excluded) <= ${MEMORY_SESSION_EXCLUSION_LIMIT}),
  updated_at timestamptz(3) NOT NULL DEFAULT date_trunc('second', clock_timestamp()),
  PRIMARY KEY (user_id, project_id, session_id)
);
-- A conversation that tries a capsule someone shared (「试用一次」): the pack
-- it is handed as context. It writes nothing into the researcher's own
-- memory (memoryPausedFor), whatever its incognito switch says.
ALTER TABLE evimed_memory.sessions ADD COLUMN IF NOT EXISTS trial_capsule_id text
  CHECK (trial_capsule_id IS NULL OR trial_capsule_id ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$');
DO $foreign_keys$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='evimed_memory' AND t.relname='records' AND c.contype='f'
      AND pg_get_constraintdef(c.oid) LIKE 'FOREIGN KEY (user_id) REFERENCES evimed_control.users(id)%'
  ) THEN
    ALTER TABLE evimed_memory.records ADD CONSTRAINT memory_records_user_fk
      FOREIGN KEY (user_id) REFERENCES evimed_control.users(id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='evimed_memory' AND t.relname='notes' AND c.contype='f'
      AND pg_get_constraintdef(c.oid) LIKE 'FOREIGN KEY (user_id) REFERENCES evimed_control.users(id)%'
  ) THEN
    ALTER TABLE evimed_memory.notes ADD CONSTRAINT memory_notes_user_fk
      FOREIGN KEY (user_id) REFERENCES evimed_control.users(id) ON DELETE CASCADE NOT VALID;
  END IF;
  -- Validate what was just added. The audit that readiness runs refuses an
  -- unvalidated constraint, and both tables are either empty or already
  -- consistent by construction, so the scan is free and cannot fail. Without
  -- this, the first deployment to take the NOT VALID path would answer 503
  -- until somebody ran an ops command nothing tells them about.
  IF EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='evimed_memory' AND t.relname='records' AND c.conname='memory_records_user_fk' AND NOT c.convalidated
  ) THEN
    ALTER TABLE evimed_memory.records VALIDATE CONSTRAINT memory_records_user_fk;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='evimed_memory' AND t.relname='notes' AND c.conname='memory_notes_user_fk' AND NOT c.convalidated
  ) THEN
    ALTER TABLE evimed_memory.notes VALIDATE CONSTRAINT memory_notes_user_fk;
  END IF;
END $foreign_keys$;
`;

/** @param {any} database */
export async function migrateResearchMemory(database) {
  if (migrations.has(database)) return migrations.get(database);
  const attempt = database.transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-memory-v1'))");
    await client.query(sql);
  });
  migrations.set(database, attempt);
  try { await attempt; }
  catch (error) { migrations.delete(database); throw error; }
}
