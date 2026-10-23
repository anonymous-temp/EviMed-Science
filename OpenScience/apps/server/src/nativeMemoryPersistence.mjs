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
 *  - `native_rejections` — the lines a person removed, as a fingerprint (a line the engine writes back verbatim is removed
 *    again) and, since 2026-10-23, as the line's normalised words: a reworded repeat is recognised by containing them or by a
 *    model judging it to say the same (`nativeMemoryRejections.mjs`). The words are the account's own, read by nothing else, and
 *    go when the rejection does (the person's restatement, a reset, the account); the revisions' text of a hard delete is still
 *    scrubbed from the history.
 *
 * What this does not hold, and the legacy path did (owner-accepted, README §5.4 of the course correction): a line of
 * `profile.md` has no origin, no validity interval, no confidence and no conflict record of its own — those were
 * columns of one row per fact, and the engine's profile is one file. They exist here at file granularity only.
 *
 * Every table belongs to one account and goes with it (the cascade).
 *
 * @module nativeMemoryPersistence
 */
import { refreshVocabularyChecks } from "./vocabularyChecks.mjs";

const migrations = new WeakMap();

export const NATIVE_COMMIT_ORIGINS = Object.freeze(["gateway", "tool", "scan", "page", "replay", "migration"]);
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
export const NATIVE_TEXT_LIMIT = 100_000;

const quoted = (/** @type {readonly string[]} */ values) => values.map((value) => `'${value}'`).join(", ");

const sql = `
CREATE TABLE IF NOT EXISTS evimed_memory.native_accounts (
  user_id text PRIMARY KEY REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  registered_at timestamptz(3),
  scanned_at timestamptz(3),
  migrated_at timestamptz(3),
  updated_at timestamptz(3) NOT NULL DEFAULT date_trunc('second', clock_timestamp())
);
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
  state text NOT NULL DEFAULT 'current' CHECK (state IN ('current', 'changed', 'retracted', 'expired', 'removed', 'unknown')),
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
