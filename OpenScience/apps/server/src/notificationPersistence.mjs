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
      FOREIGN KEY (user_id) REFERENCES evimed_control.users(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='evimed_inbox' AND t.relname='notifications' AND c.contype='f'
      AND pg_get_constraintdef(c.oid) LIKE 'FOREIGN KEY (user_id, project_id) REFERENCES evimed_control.projects(user_id, id)%'
  ) THEN
    ALTER TABLE evimed_inbox.notifications ADD CONSTRAINT inbox_notifications_project_fk
      FOREIGN KEY (user_id,project_id) REFERENCES evimed_control.projects(user_id,id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='evimed_inbox' AND t.relname='preferences' AND c.contype='f'
      AND pg_get_constraintdef(c.oid) LIKE 'FOREIGN KEY (user_id) REFERENCES evimed_control.users(id)%'
  ) THEN
    ALTER TABLE evimed_inbox.preferences ADD CONSTRAINT inbox_preferences_user_fk
      FOREIGN KEY (user_id) REFERENCES evimed_control.users(id) ON DELETE CASCADE;
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
