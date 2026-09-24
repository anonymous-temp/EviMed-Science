const migrations = new WeakMap();

const sql = `
CREATE SCHEMA IF NOT EXISTS evimed_inbox;
CREATE TABLE IF NOT EXISTS evimed_inbox.notifications (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  project_id text,
  notice_type text NOT NULL CHECK (notice_type IN ('notify','question','review')),
  priority smallint NOT NULL CHECK (priority BETWEEN 0 AND 2),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 150),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 8000),
  actions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(actions)='array'),
  source jsonb,
  group_key text,
  event_count integer NOT NULL DEFAULT 1 CHECK (event_count BETWEEN 1 AND 10000),
  due_at timestamptz(3),
  default_action text,
  read_at timestamptz(3),
  resolved_at timestamptz(3),
  resolution jsonb,
  channels_sent jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(channels_sent)='object'),
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (user_id,project_id) REFERENCES evimed_control.projects(user_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS inbox_account_order_idx ON evimed_inbox.notifications
  (user_id,priority,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS inbox_due_idx ON evimed_inbox.notifications(due_at,id)
  WHERE resolved_at IS NULL AND default_action IS NOT NULL;
CREATE INDEX IF NOT EXISTS inbox_group_idx ON evimed_inbox.notifications(user_id,group_key,created_at DESC)
  WHERE resolved_at IS NULL AND notice_type='notify' AND group_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS inbox_project_fk_idx ON evimed_inbox.notifications(user_id,project_id);
-- 2026-09-18 (contract C1). How much an item may interrupt, and whether it was
-- recorded without notifying anyone. Added columns, not a new table: every
-- existing row reads as the quiet default, which is what it was.
ALTER TABLE evimed_inbox.notifications ADD COLUMN IF NOT EXISTS severity text NOT NULL DEFAULT 'info';
ALTER TABLE evimed_inbox.notifications ADD COLUMN IF NOT EXISTS silent boolean NOT NULL DEFAULT false;
-- 2026-09-24 (plan 2026-09-23 §5.8): nothing is recorded quietly any more.
-- Evaluations, the platform's own background work and the method library's
-- housekeeping leave no inbox item at all, and the quiet records already
-- stored — read on arrival, shown only under the 「自动运行 N 条」 fold the
-- page no longer has — go too. The column stays, unwritten, while the release
-- before this one can still be switched back to: that release inserts it.
DELETE FROM evimed_inbox.notifications WHERE silent;
-- The bell's count, and the retention sweep's scan. Both are partial on
-- read_at, which is the only column either of them filters on first.
CREATE INDEX IF NOT EXISTS inbox_unread_idx ON evimed_inbox.notifications(user_id,severity) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS inbox_read_retention_idx ON evimed_inbox.notifications(read_at) WHERE read_at IS NOT NULL;
-- A grouped item stands for several events, and each of them keeps its own
-- idempotency key here. Without this a replay of the third run's completion
-- would find no row under its own key and fold into the group a second time.
CREATE TABLE IF NOT EXISTS evimed_inbox.merged_events (
  id text PRIMARY KEY,
  notification_id text NOT NULL REFERENCES evimed_inbox.notifications(id) ON DELETE CASCADE,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS inbox_merged_events_notification_idx ON evimed_inbox.merged_events(notification_id);
CREATE INDEX IF NOT EXISTS inbox_group_key_idx ON evimed_inbox.notifications(user_id,group_key,created_at DESC)
  WHERE notice_type='notify' AND group_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS evimed_inbox.preferences (
  user_id text PRIMARY KEY REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  quiet_start text NOT NULL DEFAULT '22:00',
  quiet_end text NOT NULL DEFAULT '08:00',
  digest_time text NOT NULL DEFAULT '08:00',
  switches jsonb NOT NULL DEFAULT '{"notify":true,"question":true,"review":true}'::jsonb,
  channels jsonb NOT NULL DEFAULT '["in-app"]'::jsonb,
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
DO $foreign_keys$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='evimed_inbox' AND t.relname='notifications' AND c.contype='f'
      AND pg_get_constraintdef(c.oid) LIKE 'FOREIGN KEY (user_id) REFERENCES evimed_control.users(id)%'
  ) THEN
    ALTER TABLE evimed_inbox.notifications ADD CONSTRAINT inbox_notifications_user_fk
      FOREIGN KEY (user_id) REFERENCES evimed_control.users(id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='evimed_inbox' AND t.relname='notifications' AND c.contype='f'
      AND pg_get_constraintdef(c.oid) LIKE 'FOREIGN KEY (user_id, project_id) REFERENCES evimed_control.projects(user_id, id)%'
  ) THEN
    ALTER TABLE evimed_inbox.notifications ADD CONSTRAINT inbox_notifications_project_fk
      FOREIGN KEY (user_id,project_id) REFERENCES evimed_control.projects(user_id,id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='evimed_inbox' AND t.relname='preferences' AND c.contype='f'
      AND pg_get_constraintdef(c.oid) LIKE 'FOREIGN KEY (user_id) REFERENCES evimed_control.users(id)%'
  ) THEN
    ALTER TABLE evimed_inbox.preferences ADD CONSTRAINT inbox_preferences_user_fk
      FOREIGN KEY (user_id) REFERENCES evimed_control.users(id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='evimed_inbox' AND t.relname='notifications' AND c.conname='inbox_notifications_severity_check'
  ) THEN
    ALTER TABLE evimed_inbox.notifications ADD CONSTRAINT inbox_notifications_severity_check
      CHECK (severity IN ('safety','attention','info'));
  END IF;
END $foreign_keys$;
`;

/** @param {any} database */
export async function migrateNotifications(database) {
  if (migrations.has(database)) return migrations.get(database);
  const attempt = database.transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-inbox-v1'))");
    await client.query(sql);
  });
  migrations.set(database, attempt);
  try { await attempt; }
  catch (error) { migrations.delete(database); throw error; }
}
