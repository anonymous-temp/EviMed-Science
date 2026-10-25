/**
 * The account-level memory schema: a person's own switches over their memory, the state of a conversation's memory, and the topic
 * grouping the memory map draws.
 *
 * What an account's memories are is OpenViking's (the native engine keeps them as files; `nativeMemoryPersistence.mjs` is the thin
 * overlay of PostgreSQL facts about those files). This schema holds what is not a memory and has no place in the engine: whether
 * the person paused learning or recall, when they last reset, which shared capsule a conversation is trying, what profile a
 * conversation was last handed. Every table belongs to one account and goes with it (the cascade).
 *
 * The structured-record tables of the retired legacy engine (`records`, `record_sources`, `record_conflicts`, `record_usage`,
 * `record_reviews`) are not created here any more; `legacyMemoryRetirement.mjs` drops them from a database that still has them,
 * and only when they hold nothing.
 */
import { refreshVocabularyChecks } from "./vocabularyChecks.mjs";

const migrations = new WeakMap();

/** How many projects one account may pause memory for. A project id list, so bounded like every other array this schema stores. */
export const MEMORY_PAUSED_PROJECT_LIMIT = 100;

const sql = `
CREATE SCHEMA IF NOT EXISTS evimed_memory;
-- The topics a model grouped an account's memories into (\`memoryTopics.mjs\`, 2026-10-12): derived and rebuildable, one row per
-- account. \`topics\` is the last grouping — open-vocabulary labels with the ids of the memories each holds — and \`overrides\` is
-- what the researcher said about it (a rename, a merge, a topic they dismissed, a memory they took out), which is the stronger
-- basis and is applied over every regrouping. \`memory_mark\` is the digest of the memories the grouping was made from, so a
-- changed set is how a grouping is known to be stale; \`attempts\` counts the model calls of \`attempts_day\`, the account's own
-- daily bound. The row goes with the account (the cascade) and with a reset (\`purgeUserMemory\`).
CREATE TABLE IF NOT EXISTS evimed_memory.topic_sets (
  user_id text PRIMARY KEY REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  topics jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(topics) = 'array' AND jsonb_array_length(topics) <= 60),
  overrides jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(overrides) = 'object'),
  memory_mark text NOT NULL DEFAULT '' CHECK (char_length(memory_mark) <= 128),
  computed_at timestamptz(3),
  attempts_day text NOT NULL DEFAULT '' CHECK (char_length(attempts_day) <= 10),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);
-- The researcher's own switches over their memory. No row means every switch
-- is off, which is how the platform behaved before the switches existed.
CREATE TABLE IF NOT EXISTS evimed_memory.settings (
  user_id text PRIMARY KEY REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  learning_paused boolean NOT NULL DEFAULT false,
  recall_paused boolean NOT NULL DEFAULT false,
  paused_projects text[] NOT NULL DEFAULT '{}' CHECK (cardinality(paused_projects) <= ${MEMORY_PAUSED_PROJECT_LIMIT}),
  updated_at timestamptz(3) NOT NULL DEFAULT date_trunc('second', clock_timestamp())
);
-- The accounts erased since the retired usememos store was left behind (2026-10-10, review M-11), by the two digests that
-- store knew them by. No foreign key to the account, on purpose: this outlives it. It is what the retirement's archive (an
-- encrypted dump, which cannot have a row cut out of it in place) is re-sealed against by \`scripts/ops/retire-usememos-tables.py
-- --forget-erased\`. A digest of an account id names no one to a reader who does not already hold the id.
CREATE TABLE IF NOT EXISTS evimed_memory.retired_erasures (
  namespace text PRIMARY KEY CHECK (namespace ~ '^evimed-science-[a-f0-9]{24}$'),
  tag text NOT NULL CHECK (tag ~ '^[a-f0-9]{24}$'),
  erased_at timestamptz(3) NOT NULL DEFAULT date_trunc('second', clock_timestamp())
);
-- The instant of the account's last 「重置记忆」 (2026-10-10, review M-11). A reset
-- deletes what the account holds; this is what keeps the platform from learning
-- it again out of the conversations that were already over when the researcher
-- asked to start from nothing (the native turn commit, the memory gateway and the learning loop skip a run that
-- ended before it). Millisecond precision, unlike the other times of this
-- schema: a run that ends in the same second as the reset must still be placed
-- on one side of it. Null: never reset.
ALTER TABLE evimed_memory.settings ADD COLUMN IF NOT EXISTS reset_at timestamptz(3);
-- One conversation's own memory state. Keyed by the kernel's session id inside
-- a project; deleted with the account, and with the project by
-- deleteProjectMemory. All that is left of it is the capsule a conversation is
-- trying: 无痕 and 「本次不用」 were deleted on 2026-09-20 together with the bar
-- that was their only control. Incognito in particular cost ten server call
-- sites for a switch that duplicated the account-level recall pause, and the
-- columns are dropped here rather than left unread — an unread column is a
-- reader somebody adds back by accident.
CREATE TABLE IF NOT EXISTS evimed_memory.sessions (
  user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  project_id text NOT NULL CHECK (project_id ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$'),
  session_id text NOT NULL CHECK (session_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  updated_at timestamptz(3) NOT NULL DEFAULT date_trunc('second', clock_timestamp()),
  PRIMARY KEY (user_id, project_id, session_id)
);
ALTER TABLE evimed_memory.sessions DROP COLUMN IF EXISTS incognito;
ALTER TABLE evimed_memory.sessions DROP COLUMN IF EXISTS excluded;
-- What a conversation was last handed of the resident profile (2026-10-10, review M6): the digest of the block and when it
-- was handed over, and when the kernel last compacted the conversation. The profile is given to a conversation at its first
-- dispatch and again only when it changed or the conversation was compacted since; this is how a dispatch knows which.
ALTER TABLE evimed_memory.sessions ADD COLUMN IF NOT EXISTS resident_digest text
  CHECK (resident_digest IS NULL OR resident_digest ~ '^[a-f0-9]{64}$');
ALTER TABLE evimed_memory.sessions ADD COLUMN IF NOT EXISTS resident_delivered_at timestamptz(3);
ALTER TABLE evimed_memory.sessions ADD COLUMN IF NOT EXISTS compacted_at timestamptz(3);
-- A conversation that tries a capsule someone shared (「试用一次」): the pack
-- it is handed as context. It writes nothing into the researcher's own
-- memory (memoryPausedFor) while the trial lasts.
ALTER TABLE evimed_memory.sessions ADD COLUMN IF NOT EXISTS trial_capsule_id text
  CHECK (trial_capsule_id IS NULL OR trial_capsule_id ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$');
DO $foreign_keys$
DECLARE
  owned text;
BEGIN
  -- Every table of this schema is one account's, and the cascade is what makes
  -- "delete my account" true rather than a promise. The inline REFERENCES in
  -- each CREATE TABLE only applies to a table that statement actually creates,
  -- so a deployment that got a table before evimed_control.users existed has
  -- kept the rows of every deleted account ever since — found on a test
  -- database on 2026-09-20, where deleting an account left its conversation
  -- state and its switches behind. One loop, because hand-written copies of
  -- this block were places for one of them to be forgotten, which is
  -- exactly what happened to sessions and settings.
  FOREACH owned IN ARRAY ARRAY['settings', 'sessions'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='evimed_memory' AND t.relname=owned AND c.contype='f'
        AND pg_get_constraintdef(c.oid) LIKE 'FOREIGN KEY (user_id) REFERENCES evimed_control.users(id)%'
    ) THEN
      -- What the missing cascade already left behind, before the constraint
      -- that would have refused it: a row belonging to an account that is gone
      -- is a copy of deleted data, and it is the reason the constraint could
      -- not simply be added.
      EXECUTE format(
        'DELETE FROM evimed_memory.%I s WHERE NOT EXISTS (SELECT 1 FROM evimed_control.users u WHERE u.id = s.user_id)', owned);
      EXECUTE format(
        'ALTER TABLE evimed_memory.%I ADD CONSTRAINT %I FOREIGN KEY (user_id) REFERENCES evimed_control.users(id) ON DELETE CASCADE',
        owned, 'memory_' || owned || '_user_fk');
    END IF;
  END LOOP;
END $foreign_keys$;
`;

/** @param {any} database */
export async function migrateMemorySettings(database) {
  if (migrations.has(database)) return migrations.get(database);
  const attempt = database.transaction(async (/** @type {any} */ client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-memory-v1'))");
    await client.query(sql);
    await refreshVocabularyChecks(client, sql, "evimed_memory");
  });
  migrations.set(database, attempt);
  try { await attempt; }
  catch (error) { migrations.delete(database); throw error; }
}
