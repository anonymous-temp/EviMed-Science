/**
 * The overlay of the native memory engine: the few facts about an account's memory files that OpenViking has no place for.
 *
 * Since 2026-10-13 an account on the native engine keeps its memories as files in OpenViking, written by the engine's own
 * extraction. PostgreSQL holds none of their text as the record of them. What it holds, keyed by `(user, uri)`:
 *
 *  - `native_accounts` — that the engine's admin routes know the account (settings and deletion answer 404 until they
 *    do), and when its session archives were last scanned.
 *  - `native_commits` — the ledger of every commit: which archive, which task, what became of it, and what its extraction
 *    said about itself (`extraction`: skipped operations with the engine's reason codes). Fed by the memory
 *    gateway (a commit it forwarded) and by the scan of `sessions/*\/history/archive_*` (an idle auto-commit never
 *    passes the gateway). A failed commit is never retried upstream, so its replay is counted and scheduled here.
 *  - `native_revisions` — what each commit and each edit changed, before and after, read from the archive's
 *    `memory_diff.json`: the timeline, 「刚记住了」, and the undo. A memory the person deleted keeps no text here.
 *  - `native_files` — per file: the project it belongs to (the `project=<id>` tag, kept here because a pack restore
 *    loses every tag), whether recall leaves it out, the hash of the body last seen (the page's compare-and-swap; the
 *    engine has none), the body as last ingested, and the source labels currently written into it.
 *  - `native_sources` — the sources a file names (a DOI, a knowledge-base document id), found in its text.
 *  - `native_line_origins` — for each line of a memory file, the first revision that brought it (2026-10-25): its engine session and archive. A
 *    file keeps 32 revisions, so a line brought by an older one named no conversation; this index is small (one row per line) and is
 *    pruned when the line leaves its file. `native_files.last_recalled_at` and `recall_count` say when a memory search or read through
 *    the gateway last returned the file, and how often — recorded for a later decision, acted on by nothing.
 *  - `native_reset_tombstones` — what a reset found still being extracted: the archives (and their tasks) of commits the engine had
 *    accepted. An extraction accepted before a reset can still write files after it; the worker takes them out whenever they land.
 *  - `native_imports` — the statements the page's import split out of a pasted text, offered to the person until they save or the hour is
 *    out (`nativeMemoryImport.mjs`).
 *  - `native_rejections` — the lines a person removed, as a fingerprint (a line the engine writes back verbatim is removed
 *    again) and, since 2026-10-23, as the line's normalised words: a reworded repeat is recognised by containing them or by a
 *    model judging it to say the same (`nativeMemoryRejections.mjs`). The words are the account's own, read by nothing else, and
 *    go when the rejection does (the person's restatement, a reset, the account); the revisions' text of a hard delete is still
 *    scrubbed from the history.
 *
 * What this does not hold, and the legacy engine's records did (owner-accepted, README §5.4 of the course correction): a line of
 * `profile.md` has no origin, no validity interval, no confidence and no conflict record of its own — those were
 * columns of one row per fact, and the engine's profile is one file. They exist here at file granularity only.
 *
 * Every table belongs to one account and goes with it (the cascade).
 *
 * @module nativeMemoryPersistence
 */
import { refreshVocabularyChecks } from "./vocabularyChecks.mjs";

const migrations = new WeakMap();

/**
 * Where a commit came from: the gateway (the plugin's own, or the control plane's after a turn), a tool call, the archive scan, the
 * page's 「记住这一条」, a replay of a failed extraction, the page's import of what another assistant remembered (`import`, 2026-10-25) and
 * the control plane's promotion of a repeated choice (`promotion`, `nativeMemoryObservations.mjs`).
 */
export const NATIVE_COMMIT_ORIGINS = Object.freeze(["gateway", "tool", "scan", "page", "replay", "import", "promotion"]);
/**
 * `pending`: accepted by the engine, its diff not read yet. `completed`: its diff is in the revisions. `failed`: the
 * extraction failed and a replay is owed. `replayed`: its messages were committed again as another archive.
 * `abandoned`: the replay cap is spent, or the archive holds nothing to replay.
 */
export const NATIVE_COMMIT_STATES = Object.freeze(["pending", "completed", "failed", "replayed", "abandoned"]);
export const NATIVE_REVISION_CHANGES = Object.freeze(["added", "updated", "deleted", "restored"]);
/** Who changed a memory: the engine's extraction, the person on the memory page, the conversation's `forget` tool, or a
 *  deterministic step of the platform (a check, a source label, a migration). */
export const NATIVE_REVISION_ACTORS = Object.freeze(["engine", "user", "conversation", "platform"]);
/** The states a memory file's link to a source can be in (what a check of the source gives it). */
export const NATIVE_SOURCE_STATES = Object.freeze(["current", "changed", "retracted", "expired", "removed", "unknown"]);
/** `open`: an extraction may still land. `swept`: it finished and what it wrote was taken out. `unknown`: its record is gone (the engine keeps a task a day) and nothing could be said. */
export const NATIVE_TOMBSTONE_STATES = Object.freeze(["open", "swept", "unknown"]);
/** `offered`: the statements wait for the person. `saved`: they were handed to the engine. */
export const NATIVE_IMPORT_STATES = Object.freeze(["offered", "saved"]);
export const NATIVE_TEXT_LIMIT = 100_000;

const quoted = (/** @type {readonly string[]} */ values) => values.map((value) => `'${value}'`).join(", ");

const sql = `
CREATE TABLE IF NOT EXISTS evimed_memory.native_accounts (
  user_id text PRIMARY KEY REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  registered_at timestamptz(3),
  scanned_at timestamptz(3),
  updated_at timestamptz(3) NOT NULL DEFAULT date_trunc('second', clock_timestamp())
);
-- The replay of the legacy engine's records into the engine left a mark here; the replay is deleted (2026-10-25).
ALTER TABLE evimed_memory.native_accounts DROP COLUMN IF EXISTS migrated_at;
CREATE TABLE IF NOT EXISTS evimed_memory.native_admissions (
  user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  candidate_id text NOT NULL CHECK (char_length(candidate_id) BETWEEN 1 AND 200),
  candidate_revision integer NOT NULL CHECK (candidate_revision > 0),
  engine_session text NOT NULL CHECK (engine_session ~ '^[A-Za-z0-9_.@-]{1,200}$'),
  project_id text,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','submitting','pending','completed','failed','uncertain','suspended','cancelled')),
  phase text NOT NULL DEFAULT 'queued',
  pending_text text CHECK (pending_text IS NULL OR char_length(pending_text) <= 262144),
  archive_uri text,
  task_id text,
  record_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text NOT NULL DEFAULT '',
  lease_until timestamptz,
  account_created_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, candidate_id, candidate_revision),
  UNIQUE (user_id, engine_session)
);
CREATE INDEX IF NOT EXISTS native_admissions_open_idx ON evimed_memory.native_admissions (user_id,state)
  WHERE state <> 'completed';
-- The consolidation of an account's memories (nativeMemoryConsolidation.mjs), kept on its account row: when the last one ended and
-- the shape of the files it left (a consolidation is asked for again only after they changed), when the files were last looked at, the
-- engine task in flight, and the lease that keeps two workers from submitting one account twice.
ALTER TABLE evimed_memory.native_accounts ADD COLUMN IF NOT EXISTS consolidated_at timestamptz(3);
ALTER TABLE evimed_memory.native_accounts ADD COLUMN IF NOT EXISTS consolidation_checked_at timestamptz(3);
ALTER TABLE evimed_memory.native_accounts ADD COLUMN IF NOT EXISTS consolidation_fingerprint text CHECK (consolidation_fingerprint IS NULL OR consolidation_fingerprint ~ '^[a-f0-9]{64}$');
ALTER TABLE evimed_memory.native_accounts ADD COLUMN IF NOT EXISTS consolidation_task text CHECK (consolidation_task IS NULL OR consolidation_task ~ '^[A-Za-z0-9_-]{8,128}$');
ALTER TABLE evimed_memory.native_accounts ADD COLUMN IF NOT EXISTS consolidation_started_at timestamptz(3);
ALTER TABLE evimed_memory.native_accounts ADD COLUMN IF NOT EXISTS consolidation_lease_until timestamptz(3);
CREATE TABLE IF NOT EXISTS evimed_memory.native_commits (
  user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  archive_uri text NOT NULL CHECK (char_length(archive_uri) BETWEEN 1 AND 600),
  engine_session text NOT NULL CHECK (engine_session ~ '^[A-Za-z0-9_.@-]{1,200}$'),
  project_id text CHECK (project_id IS NULL OR project_id ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$'),
  origin text NOT NULL CHECK (origin IN (${quoted(NATIVE_COMMIT_ORIGINS)})),
  task_id text CHECK (task_id IS NULL OR task_id ~ '^[A-Za-z0-9-]{8,64}$'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN (${quoted(NATIVE_COMMIT_STATES)})),
  operations integer NOT NULL DEFAULT 0 CHECK (operations >= 0),
  error text NOT NULL DEFAULT '' CHECK (char_length(error) <= 400),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz(3),
  replayed_as text CHECK (replayed_as IS NULL OR char_length(replayed_as) <= 600),
  -- What the person asked the page to remember, shown as pending until the engine has written it, then cleared.
  pending_text text CHECK (pending_text IS NULL OR char_length(pending_text) <= 2000),
  -- What the extraction did, read from the engine when the commit settled: skipped operations and why (the engine's own reason
  -- codes), what it extracted per category, the memory types it was allowed. Counts and codes, never a memory's text.
  extraction jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(extraction) = 'object'),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  ingested_at timestamptz(3),
  PRIMARY KEY (user_id, archive_uri)
);
-- A ledger made before the page's 「记住这一条」 existed gains the column without being rebuilt.
ALTER TABLE evimed_memory.native_commits ADD COLUMN IF NOT EXISTS pending_text text CHECK (pending_text IS NULL OR char_length(pending_text) <= 2000);
-- A ledger made before 2026-10-23 gains what the extraction said about itself (a commit that wrote nothing is told apart: the
-- model proposed nothing, or the engine refused what it proposed).
ALTER TABLE evimed_memory.native_commits ADD COLUMN IF NOT EXISTS extraction jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(extraction) = 'object');
CREATE INDEX IF NOT EXISTS native_commits_open_idx ON evimed_memory.native_commits (state, next_attempt_at)
  WHERE state IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS native_commits_session_idx ON evimed_memory.native_commits (user_id, engine_session);
-- Which project an engine session (a conversation) was held in, noted when the gateway forwards its first message: the
-- engine's own idle commits never pass the gateway, and their project is read from here.
CREATE TABLE IF NOT EXISTS evimed_memory.native_sessions (
  user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  engine_session text NOT NULL CHECK (engine_session ~ '^[A-Za-z0-9_.@-]{1,200}$'),
  project_id text CHECK (project_id IS NULL OR project_id ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$'),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, engine_session)
);
CREATE INDEX IF NOT EXISTS native_sessions_project_idx ON evimed_memory.native_sessions (user_id, project_id) WHERE project_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS evimed_memory.native_revisions (
  id bigserial PRIMARY KEY,
  user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  uri text NOT NULL CHECK (char_length(uri) BETWEEN 1 AND 600),
  memory_type text NOT NULL CHECK (char_length(memory_type) <= 64),
  change text NOT NULL CHECK (change IN (${quoted(NATIVE_REVISION_CHANGES)})),
  actor text NOT NULL CHECK (actor IN (${quoted(NATIVE_REVISION_ACTORS)})),
  reason text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 200),
  before text CHECK (before IS NULL OR char_length(before) <= ${NATIVE_TEXT_LIMIT}),
  after text CHECK (after IS NULL OR char_length(after) <= ${NATIVE_TEXT_LIMIT}),
  archive_uri text CHECK (archive_uri IS NULL OR char_length(archive_uri) <= 600),
  engine_session text,
  project_id text,
  undone_at timestamptz(3),
  changed_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS native_revisions_file_idx ON evimed_memory.native_revisions (user_id, uri, id DESC);
CREATE INDEX IF NOT EXISTS native_revisions_recent_idx ON evimed_memory.native_revisions (user_id, changed_at DESC);
-- The newest revision of an account, which 「与你相关」 reads as the mark of the account's memory (frontierProfiles.mjs, memoryMarkOf).
CREATE INDEX IF NOT EXISTS native_revisions_user_id_idx ON evimed_memory.native_revisions (user_id, id DESC);
-- One diff is ingested once: the same archive never writes the same change of the same file twice.
CREATE UNIQUE INDEX IF NOT EXISTS native_revisions_once_idx ON evimed_memory.native_revisions (user_id, archive_uri, uri, change)
  WHERE archive_uri IS NOT NULL;
CREATE TABLE IF NOT EXISTS evimed_memory.native_files (
  user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  uri text NOT NULL CHECK (char_length(uri) BETWEEN 1 AND 600),
  memory_type text NOT NULL CHECK (char_length(memory_type) <= 64),
  project_id text CHECK (project_id IS NULL OR project_id ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$'),
  sensitive boolean NOT NULL DEFAULT false,
  content_hash text CHECK (content_hash IS NULL OR content_hash ~ '^[a-f0-9]{64}$'),
  body text CHECK (body IS NULL OR char_length(body) <= ${NATIVE_TEXT_LIMIT}),
  labels jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(labels) = 'array' AND jsonb_array_length(labels) <= 16),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, uri)
);
CREATE INDEX IF NOT EXISTS native_files_project_idx ON evimed_memory.native_files (user_id, project_id) WHERE project_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS evimed_memory.native_sources (
  user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  uri text NOT NULL CHECK (char_length(uri) BETWEEN 1 AND 600),
  source_type text NOT NULL CHECK (source_type IN ('knowledge_source', 'doi')),
  source_id text NOT NULL CHECK (char_length(source_id) BETWEEN 1 AND 300),
  state text NOT NULL DEFAULT 'current' CHECK (state IN (${quoted(NATIVE_SOURCE_STATES)})),
  state_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, uri, source_type, source_id)
);
CREATE INDEX IF NOT EXISTS native_sources_source_idx ON evimed_memory.native_sources (user_id, source_type, source_id);
CREATE TABLE IF NOT EXISTS evimed_memory.native_rejections (
  user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  memory_type text NOT NULL CHECK (char_length(memory_type) <= 64),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  uri text NOT NULL CHECK (char_length(uri) <= 600),
  -- The line's normalised words, so that a reworded repeat can be recognised (a line that contains it, or that a model judges to say
  -- the same). Null for a rejection made before 2026-10-23, which only an exact repeat meets.
  text text CHECK (text IS NULL OR char_length(text) <= 400),
  rejected_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, memory_type, fingerprint)
);
ALTER TABLE evimed_memory.native_rejections ADD COLUMN IF NOT EXISTS text text CHECK (text IS NULL OR char_length(text) <= 400);
-- When a memory search or read through the gateway last returned a file, and how many times (2026-10-25). No behaviour reads it.
ALTER TABLE evimed_memory.native_files ADD COLUMN IF NOT EXISTS last_recalled_at timestamptz(3);
ALTER TABLE evimed_memory.native_files ADD COLUMN IF NOT EXISTS recall_count integer NOT NULL DEFAULT 0 CHECK (recall_count >= 0);
-- Where each line of a memory file came from, kept beyond the 32 revisions a file holds. One row per line, gone with the line.
CREATE TABLE IF NOT EXISTS evimed_memory.native_line_origins (
  user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  uri text NOT NULL CHECK (char_length(uri) BETWEEN 1 AND 600),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  revision_id bigint,
  engine_session text CHECK (engine_session IS NULL OR char_length(engine_session) <= 200),
  archive_uri text CHECK (archive_uri IS NULL OR char_length(archive_uri) <= 600),
  project_id text,
  added_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, uri, fingerprint)
);
-- The line origins of an account's older revisions are read in once, by the worker (nativeMemoryWorker.mjs), and this says when.
ALTER TABLE evimed_memory.native_accounts ADD COLUMN IF NOT EXISTS origins_indexed_at timestamptz(3);
-- The commits a reset found still being extracted: whatever the engine writes from them after the reset is taken out again.
CREATE TABLE IF NOT EXISTS evimed_memory.native_reset_tombstones (
  user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  archive_uri text NOT NULL CHECK (char_length(archive_uri) BETWEEN 1 AND 600),
  engine_session text NOT NULL CHECK (engine_session ~ '^[A-Za-z0-9_.@-]{1,200}$'),
  task_id text CHECK (task_id IS NULL OR task_id ~ '^[A-Za-z0-9-]{8,64}$'),
  reset_at timestamptz(3) NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK (state IN (${quoted(NATIVE_TOMBSTONE_STATES)})),
  removed integer NOT NULL DEFAULT 0 CHECK (removed >= 0),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, archive_uri)
);
CREATE INDEX IF NOT EXISTS native_reset_tombstones_open_idx ON evimed_memory.native_reset_tombstones (user_id) WHERE state = 'open';
-- What the page's import offered the person, held until they save it or it expires.
CREATE TABLE IF NOT EXISTS evimed_memory.native_imports (
  id text PRIMARY KEY CHECK (id ~ '^imp_[a-f0-9]{24}$'),
  user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  statements jsonb NOT NULL CHECK (jsonb_typeof(statements) = 'array'),
  left_out integer NOT NULL DEFAULT 0 CHECK (left_out >= 0),
  state text NOT NULL DEFAULT 'offered' CHECK (state IN (${quoted(NATIVE_IMPORT_STATES)})),
  saved integer NOT NULL DEFAULT 0 CHECK (saved >= 0),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz(3) NOT NULL
);
CREATE INDEX IF NOT EXISTS native_imports_user_idx ON evimed_memory.native_imports (user_id, created_at DESC);
`;

/** @param {any} database */
export async function migrateNativeMemory(database) {
  if (migrations.has(database)) return migrations.get(database);
  const attempt = database.transaction(async (/** @type {any} */ client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-memory-native-v1'))");
    await client.query(sql);
    // A word a list above gained after the table was created is otherwise refused by every existing database (vocabularyChecks.mjs).
    await refreshVocabularyChecks(client, sql, "evimed_memory");
  });
  migrations.set(database, attempt);
  try { await attempt; }
  catch (error) { migrations.delete(database); throw error; }
}
