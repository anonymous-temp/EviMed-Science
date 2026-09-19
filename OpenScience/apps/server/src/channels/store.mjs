/**
 * What the channels remember: who is bound to which messenger identity, which
 * project a chat talks to, the inbound messages still to be handled, the runs
 * a chat started, and the inbox items waiting to be pushed.
 *
 * Hidden knowledge: every table here exists because something outlives one
 * request, and each outlives it for its own reason.
 *
 *  - `inbound_events` is the dedupe store *and* the durable inbox. Feishu
 *    re-pushes an event it did not see acknowledged within 3 s (long
 *    connection mode, cluster delivery), so the handler acknowledges after one
 *    insert and works later. An insert that only recorded the key would lose
 *    the message to any crash between the acknowledgement and the work; the
 *    payload rides with it and the worker claims it under a lease.
 *  - `tasks` are the runs a chat started. A deep run takes 10–40 minutes, the
 *    process may restart in between, and the result still has to reach the
 *    chat it was asked in: dsh-im's "timeout resend", made durable.
 *  - `deliveries` is the push outbox for inbox items. The inbox commits its
 *    own row first and a push is a network call, so the two cannot share a
 *    transaction; a reconcile pass re-derives anything a crash dropped.
 *
 * Secrets are never here: an app secret or a push token lives in the
 * per-user credential store and a binding holds only its reference.
 *
 * Claims compare against the database's own clock, never the process's:
 * `timestamptz(3)` rounds an insert half-up to the millisecond, and a claim
 * reading the process clock in that same millisecond missed a row that was
 * already due — the same skew, across two hosts, would delay every task.
 *
 * @module channels/store
 */

import { randomUUID } from "node:crypto";
import { migrateNotifications } from "../notificationPersistence.mjs";
import { CHANNEL_IDS } from "./port.mjs";

const migrations = new WeakMap();

const quoted = (values) => values.map((value) => `'${value}'`).join(",");

const sql = `
CREATE SCHEMA IF NOT EXISTS evimed_channels;
CREATE TABLE IF NOT EXISTS evimed_channels.bindings (
  id text PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 80),
  user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN (${quoted(CHANNEL_IDS)})),
  external_id text NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 200),
  credential_ref text CHECK (credential_ref IS NULL OR char_length(credential_ref) BETWEEN 1 AND 200),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (user_id, channel, external_id)
);
-- One Feishu bot per account, and one account per bot: an event names its app,
-- and the app has to name exactly one owner.
CREATE UNIQUE INDEX IF NOT EXISTS channel_bindings_feishu_owner_idx ON evimed_channels.bindings(user_id) WHERE channel='feishu';
CREATE UNIQUE INDEX IF NOT EXISTS channel_bindings_feishu_app_idx ON evimed_channels.bindings((metadata->>'appId')) WHERE channel='feishu';
CREATE TABLE IF NOT EXISTS evimed_channels.chats (
  binding_id text NOT NULL REFERENCES evimed_channels.bindings(id) ON DELETE CASCADE,
  chat_id text NOT NULL CHECK (char_length(chat_id) BETWEEN 1 AND 200),
  user_id text NOT NULL,
  chat_type text NOT NULL CHECK (chat_type IN ('p2p','group')),
  project_id text,
  project_selected_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (binding_id, chat_id),
  -- A deleted project leaves the chat without a selection, not without a row:
  -- the next message goes to the most recently used project again.
  FOREIGN KEY (user_id, project_id) REFERENCES evimed_control.projects(user_id, id) ON DELETE SET NULL (project_id)
);
CREATE TABLE IF NOT EXISTS evimed_channels.chat_sessions (
  binding_id text NOT NULL,
  chat_id text NOT NULL,
  user_id text NOT NULL,
  project_id text NOT NULL,
  session_id text NOT NULL CHECK (char_length(session_id) BETWEEN 1 AND 64),
  last_message_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (binding_id, chat_id, project_id),
  FOREIGN KEY (binding_id, chat_id) REFERENCES evimed_channels.chats(binding_id, chat_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, project_id) REFERENCES evimed_control.projects(user_id, id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS evimed_channels.inbound_events (
  id text PRIMARY KEY,
  channel text NOT NULL,
  event_key text NOT NULL CHECK (char_length(event_key) BETWEEN 1 AND 200),
  binding_id text NOT NULL REFERENCES evimed_channels.bindings(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','done','failed','ignored')),
  attempts integer NOT NULL DEFAULT 0,
  lease_owner text,
  lease_expires_at timestamptz(3),
  outcome jsonb,
  received_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  processed_at timestamptz(3),
  UNIQUE (channel, event_key)
);
CREATE INDEX IF NOT EXISTS channel_inbound_pending_idx ON evimed_channels.inbound_events(received_at) WHERE status='received';
CREATE INDEX IF NOT EXISTS channel_inbound_received_idx ON evimed_channels.inbound_events(received_at);
CREATE TABLE IF NOT EXISTS evimed_channels.tasks (
  id text PRIMARY KEY,
  binding_id text NOT NULL REFERENCES evimed_channels.bindings(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  project_id text NOT NULL,
  chat_id text NOT NULL,
  reply_to text,
  session_id text NOT NULL,
  run_id text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','delivering','done','failed')),
  card jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(card)='object'),
  result jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result)='object'),
  attempts integer NOT NULL DEFAULT 0,
  next_check_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  lease_owner text,
  lease_expires_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz(3),
  UNIQUE (user_id, project_id, run_id),
  FOREIGN KEY (user_id, project_id) REFERENCES evimed_control.projects(user_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS channel_tasks_due_idx ON evimed_channels.tasks(next_check_at) WHERE status IN ('running','delivering');
CREATE INDEX IF NOT EXISTS channel_tasks_chat_idx ON evimed_channels.tasks(binding_id, chat_id, created_at DESC);
CREATE TABLE IF NOT EXISTS evimed_channels.deliveries (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  channel text NOT NULL,
  binding_id text NOT NULL REFERENCES evimed_channels.bindings(id) ON DELETE CASCADE,
  notification_id text NOT NULL REFERENCES evimed_inbox.notifications(id) ON DELETE CASCADE,
  event_count integer NOT NULL CHECK (event_count >= 1),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','skipped')),
  not_before timestamptz(3) NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  message_id text,
  reason text,
  lease_owner text,
  lease_expires_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (binding_id, notification_id, event_count)
);
CREATE INDEX IF NOT EXISTS channel_deliveries_due_idx ON evimed_channels.deliveries(not_before) WHERE status='pending';
CREATE INDEX IF NOT EXISTS channel_deliveries_notification_idx ON evimed_channels.deliveries(notification_id);
CREATE TABLE IF NOT EXISTS evimed_channels.device_tokens (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES evimed_control.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  token_prefix text NOT NULL CHECK (char_length(token_prefix) BETWEEN 8 AND 32),
  token_digest text NOT NULL UNIQUE CHECK (char_length(token_digest) = 64),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  last_used_at timestamptz(3),
  expires_at timestamptz(3) NOT NULL,
  revoked_at timestamptz(3)
);
CREATE INDEX IF NOT EXISTS channel_device_tokens_account_idx ON evimed_channels.device_tokens(user_id, created_at DESC);
`;

/** @param {any} database */
export async function migrateChannels(database) {
  if (migrations.has(database)) return migrations.get(database);
  const attempt = (async () => {
    // The outbox references inbox rows, so the inbox schema comes first.
    await migrateNotifications(database);
    await database.transaction(async (/** @type {any} */ client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-channels-v1'))");
      await client.query(sql);
    });
  })();
  migrations.set(database, attempt);
  try { await attempt; }
  catch (error) { migrations.delete(database); throw error; }
  return attempt;
}

/** @param {unknown} value */
function iso(value) {
  if (value == null) return null;
  const time = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(time.getTime()) ? time.toISOString() : null;
}

/** @param {string} prefix */
function newId(prefix) {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

/** @param {any} row */
export function bindingRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    channel: row.channel,
    externalId: row.external_id,
    credentialRef: row.credential_ref ?? null,
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/** @param {any} row */
function chatRecord(row) {
  if (!row) return null;
  return {
    bindingId: row.binding_id,
    chatId: row.chat_id,
    userId: row.user_id,
    chatType: row.chat_type,
    projectId: row.project_id ?? null,
    projectSelectedAt: iso(row.project_selected_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/** @param {any} row */
function inboundRecord(row) {
  if (!row) return null;
  return {
    id: row.id, channel: row.channel, eventKey: row.event_key, bindingId: row.binding_id, userId: row.user_id,
    payload: row.payload ?? {}, status: row.status, attempts: Number(row.attempts ?? 0),
    outcome: row.outcome ?? null, receivedAt: iso(row.received_at), processedAt: iso(row.processed_at),
  };
}

/** @param {any} row */
function taskRecord(row) {
  if (!row) return null;
  return {
    id: row.id, bindingId: row.binding_id, userId: row.user_id, projectId: row.project_id, chatId: row.chat_id,
    replyTo: row.reply_to ?? null, sessionId: row.session_id, runId: row.run_id, status: row.status,
    card: row.card ?? {}, result: row.result ?? {}, attempts: Number(row.attempts ?? 0),
    nextCheckAt: iso(row.next_check_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    finishedAt: iso(row.finished_at),
  };
}

/** @param {any} row */
function deliveryRecord(row) {
  if (!row) return null;
  return {
    id: row.id, userId: row.user_id, channel: row.channel, bindingId: row.binding_id,
    notificationId: row.notification_id, eventCount: Number(row.event_count), status: row.status,
    notBefore: iso(row.not_before), attempts: Number(row.attempts ?? 0), messageId: row.message_id ?? null,
    reason: row.reason ?? null, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

export class ChannelStore {
  /** @param {any} database */
  constructor(database, { now = () => new Date() } = {}) {
    this.database = database;
    this.now = now;
  }

  async migrate() { await migrateChannels(this.database); }

  /** @param {string} text @param {unknown[]} [values] */
  async query(text, values = []) {
    await migrateChannels(this.database);
    return this.database.query(text, values);
  }

  // --- bindings -----------------------------------------------------------

  /** @param {string} userId @param {string | null} [channel] */
  async bindingsFor(userId, channel = null) {
    const { rows } = await this.query(`SELECT * FROM evimed_channels.bindings
      WHERE user_id=$1 AND ($2::text IS NULL OR channel=$2) ORDER BY created_at, id`, [userId, channel]);
    return rows.map(bindingRecord);
  }

  /** @param {string} id */
  async bindingById(id) {
    const { rows } = await this.query("SELECT * FROM evimed_channels.bindings WHERE id=$1", [id]);
    return bindingRecord(rows[0]);
  }

  /** Every active binding of one channel: what the connection manager keeps
   *  connected. @param {string} channel */
  async activeBindings(channel) {
    const { rows } = await this.query(`SELECT * FROM evimed_channels.bindings
      WHERE channel=$1 AND status='active' ORDER BY created_at, id`, [channel]);
    return rows.map(bindingRecord);
  }

  /**
   * One binding per account for this channel: the previous one, if any, is
   * removed in the same transaction and returned so its connection and its
   * secret can be let go.
   * @param {string} userId @param {string} channel
   * @param {{ externalId: string, credentialRef?: string | null, metadata?: Record<string, any> }} input
   */
  async replaceBinding(userId, channel, { externalId, credentialRef = null, metadata = {} }) {
    await migrateChannels(this.database);
    return this.database.transaction(async (/** @type {any} */ client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`evimed-channel-binding:${userId}:${channel}`]);
      const previous = await client.query("DELETE FROM evimed_channels.bindings WHERE user_id=$1 AND channel=$2 RETURNING *",
        [userId, channel]);
      const inserted = await client.query(`INSERT INTO evimed_channels.bindings
        (id,user_id,channel,external_id,credential_ref,metadata) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,
      [newId("chb"), userId, channel, externalId, credentialRef, JSON.stringify(metadata)]);
      return { binding: bindingRecord(inserted.rows[0]), replaced: previous.rows.map(bindingRecord) };
    });
  }

  /**
   * A binding among several for one channel (a device of the own app).
   * Idempotent on the external id.
   * @param {string} userId @param {string} channel
   * @param {{ externalId: string, credentialRef?: string | null, metadata?: Record<string, any> }} input
   */
  async upsertBinding(userId, channel, { externalId, credentialRef = null, metadata = {} }) {
    const { rows } = await this.query(`INSERT INTO evimed_channels.bindings
      (id,user_id,channel,external_id,credential_ref,metadata) VALUES($1,$2,$3,$4,$5,$6::jsonb)
      ON CONFLICT (user_id,channel,external_id) DO UPDATE SET credential_ref=EXCLUDED.credential_ref,
        metadata=EXCLUDED.metadata, status='active', updated_at=clock_timestamp()
      RETURNING *`, [newId("chb"), userId, channel, externalId, credentialRef, JSON.stringify(metadata)]);
    return bindingRecord(rows[0]);
  }

  /**
   * A binding one external identity may hold for one account only: a phone
   * signed into a second account must stop receiving the first account's
   * pushes. The rows it takes over are returned so their secrets can go too.
   * @param {string} userId @param {string} channel
   * @param {{ externalId: string, credentialRef?: string | null, metadata?: Record<string, any> }} input
   */
  async claimBinding(userId, channel, input) {
    await migrateChannels(this.database);
    return this.database.transaction(async (/** @type {any} */ client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`evimed-channel-external:${channel}:${input.externalId}`]);
      const taken = await client.query(`DELETE FROM evimed_channels.bindings
        WHERE channel=$1 AND external_id=$2 AND user_id<>$3 RETURNING *`, [channel, input.externalId, userId]);
      const { rows } = await client.query(`INSERT INTO evimed_channels.bindings
        (id,user_id,channel,external_id,credential_ref,metadata) VALUES($1,$2,$3,$4,$5,$6::jsonb)
        ON CONFLICT (user_id,channel,external_id) DO UPDATE SET credential_ref=EXCLUDED.credential_ref,
          metadata=EXCLUDED.metadata, status='active', updated_at=clock_timestamp()
        RETURNING *`, [newId("chb"), userId, channel, input.externalId, input.credentialRef ?? null,
        JSON.stringify(input.metadata ?? {})]);
      return { binding: bindingRecord(rows[0]), taken: taken.rows.map(bindingRecord) };
    });
  }

  /** @param {string} userId @param {string} id */
  async deleteBinding(userId, id) {
    const { rows } = await this.query("DELETE FROM evimed_channels.bindings WHERE user_id=$1 AND id=$2 RETURNING *", [userId, id]);
    return bindingRecord(rows[0]);
  }

  /** Merge fields into a binding's metadata. @param {string} id @param {Record<string, any>} patch */
  async patchBindingMetadata(id, patch) {
    const { rows } = await this.query(`UPDATE evimed_channels.bindings SET metadata=metadata || $2::jsonb,
      updated_at=clock_timestamp() WHERE id=$1 RETURNING *`, [id, JSON.stringify(patch)]);
    return bindingRecord(rows[0]);
  }

  /** @param {string} appId */
  async feishuBindingByAppId(appId) {
    const { rows } = await this.query(`SELECT * FROM evimed_channels.bindings
      WHERE channel='feishu' AND metadata->>'appId'=$1`, [appId]);
    return bindingRecord(rows[0]);
  }

  // --- chats --------------------------------------------------------------

  /** @param {string} bindingId @param {string} chatId */
  async chat(bindingId, chatId) {
    const { rows } = await this.query("SELECT * FROM evimed_channels.chats WHERE binding_id=$1 AND chat_id=$2", [bindingId, chatId]);
    return chatRecord(rows[0]);
  }

  /** @param {{ bindingId: string, chatId: string, userId: string, chatType: 'p2p' | 'group' }} input */
  async ensureChat({ bindingId, chatId, userId, chatType }) {
    const { rows } = await this.query(`INSERT INTO evimed_channels.chats(binding_id,chat_id,user_id,chat_type)
      VALUES($1,$2,$3,$4) ON CONFLICT (binding_id,chat_id) DO UPDATE SET updated_at=evimed_channels.chats.updated_at
      RETURNING *`, [bindingId, chatId, userId, chatType]);
    return chatRecord(rows[0]);
  }

  /** @param {string} bindingId @param {string} chatId @param {string} projectId @param {Date} [at] */
  async selectChatProject(bindingId, chatId, projectId, at = this.now()) {
    const { rows } = await this.query(`UPDATE evimed_channels.chats SET project_id=$3, project_selected_at=$4,
      updated_at=clock_timestamp() WHERE binding_id=$1 AND chat_id=$2 RETURNING *`, [bindingId, chatId, projectId, at.toISOString()]);
    return chatRecord(rows[0]);
  }

  /** @param {string} bindingId */
  async chatsFor(bindingId) {
    const { rows } = await this.query(`SELECT * FROM evimed_channels.chats WHERE binding_id=$1
      ORDER BY updated_at DESC, chat_id LIMIT 200`, [bindingId]);
    return rows.map(chatRecord);
  }

  /** @param {string} bindingId @param {string} chatId @param {string} projectId */
  async chatSession(bindingId, chatId, projectId) {
    const { rows } = await this.query(`SELECT session_id,last_message_at FROM evimed_channels.chat_sessions
      WHERE binding_id=$1 AND chat_id=$2 AND project_id=$3`, [bindingId, chatId, projectId]);
    return rows[0] ? { sessionId: rows[0].session_id, lastMessageAt: iso(rows[0].last_message_at) } : null;
  }

  /** @param {{ bindingId: string, chatId: string, userId: string, projectId: string, sessionId: string, at?: Date }} input */
  async touchChatSession({ bindingId, chatId, userId, projectId, sessionId, at = this.now() }) {
    await this.query(`INSERT INTO evimed_channels.chat_sessions(binding_id,chat_id,user_id,project_id,session_id,last_message_at)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (binding_id,chat_id,project_id)
      DO UPDATE SET session_id=EXCLUDED.session_id, last_message_at=EXCLUDED.last_message_at`,
    [bindingId, chatId, userId, projectId, sessionId, at.toISOString()]);
  }

  // --- inbound events -------------------------------------------------------

  /**
   * Record one inbound message, once. `inserted: false` is a re-push of an
   * event already held, which is acknowledged and otherwise ignored.
   * @param {{ channel: string, eventKey: string, bindingId: string, userId: string, payload: Record<string, any> }} input
   */
  async recordInbound({ channel, eventKey, bindingId, userId, payload }) {
    const { rows } = await this.query(`INSERT INTO evimed_channels.inbound_events(id,channel,event_key,binding_id,user_id,payload)
      VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (channel,event_key) DO NOTHING RETURNING *`,
    [newId("chi"), channel, eventKey, bindingId, userId, JSON.stringify(payload)]);
    return { inserted: rows.length === 1, event: inboundRecord(rows[0]) };
  }

  /** @param {{ owner: string, leaseMs: number, limit?: number, maxAttempts?: number }} input */
  async claimInbound({ owner, leaseMs, limit = 10, maxAttempts = 3 }) {
    const { rows } = await this.query(`WITH due AS (
        SELECT id FROM evimed_channels.inbound_events
        WHERE status='received' AND attempts < $3 AND (lease_expires_at IS NULL OR lease_expires_at < clock_timestamp())
        ORDER BY received_at, id FOR UPDATE SKIP LOCKED LIMIT $1
      ) UPDATE evimed_channels.inbound_events e SET lease_owner=$2,
        lease_expires_at=clock_timestamp() + ($4::integer * interval '1 millisecond'), attempts=e.attempts+1
      FROM due WHERE e.id=due.id RETURNING e.*`, [limit, owner, maxAttempts, leaseMs]);
    return rows.map(inboundRecord);
  }

  /**
   * The message is handled: its text is dropped, the key stays for dedupe.
   * @param {string} id @param {string} owner @param {{ status: 'done'|'failed'|'ignored', outcome?: Record<string, any> }} result
   */
  async finishInbound(id, owner, { status, outcome = {} }) {
    const { rowCount } = await this.query(`UPDATE evimed_channels.inbound_events SET status=$3, outcome=$4::jsonb,
      payload='{}'::jsonb, processed_at=clock_timestamp(), lease_owner=NULL, lease_expires_at=NULL
      WHERE id=$1 AND lease_owner=$2`, [id, owner, status, JSON.stringify(outcome)]);
    return (rowCount ?? 0) > 0;
  }

  /**
   * Remember how far handling got, without letting go of the event: a card
   * already created, a session already chosen. A retry after a crash reuses
   * them instead of showing the researcher a second card.
   * @param {string} id @param {string} owner @param {Record<string, any>} patch
   */
  async checkpointInbound(id, owner, patch) {
    const { rowCount } = await this.query(`UPDATE evimed_channels.inbound_events SET outcome=COALESCE(outcome,'{}'::jsonb) || $3::jsonb
      WHERE id=$1 AND lease_owner=$2`, [id, owner, JSON.stringify(patch)]);
    return (rowCount ?? 0) > 0;
  }

  /** Give the event back for another attempt. @param {string} id @param {string} owner */
  async releaseInbound(id, owner) {
    await this.query(`UPDATE evimed_channels.inbound_events SET lease_owner=NULL, lease_expires_at=NULL
      WHERE id=$1 AND lease_owner=$2 AND status='received'`, [id, owner]);
  }

  /** Events whose attempts ran out, closed as failed so they stop being
   *  claimable. @param {number} maxAttempts */
  async closeExhaustedInbound(maxAttempts) {
    const { rows } = await this.query(`UPDATE evimed_channels.inbound_events SET status='failed',
      outcome=jsonb_build_object('code','inbound_attempts_exhausted'), payload='{}'::jsonb, processed_at=clock_timestamp()
      WHERE status='received' AND attempts >= $1 AND (lease_expires_at IS NULL OR lease_expires_at < clock_timestamp())
      RETURNING *`, [maxAttempts]);
    return rows.map(inboundRecord);
  }

  /** @param {Date} before @param {number} [limit] */
  async pruneInbound(before, limit = 1000) {
    const { rowCount } = await this.query(`WITH doomed AS (
        SELECT id FROM evimed_channels.inbound_events WHERE received_at < $1 AND status<>'received'
        ORDER BY received_at LIMIT $2 FOR UPDATE SKIP LOCKED
      ) DELETE FROM evimed_channels.inbound_events e USING doomed WHERE e.id=doomed.id`, [before.toISOString(), limit]);
    return rowCount ?? 0;
  }

  // --- tasks ----------------------------------------------------------------

  /**
   * @param {{ bindingId: string, userId: string, projectId: string, chatId: string, replyTo?: string | null,
   *   sessionId: string, runId: string, card?: Record<string, any> }} input
   */
  async createTask(input) {
    const { rows } = await this.query(`INSERT INTO evimed_channels.tasks
      (id,binding_id,user_id,project_id,chat_id,reply_to,session_id,run_id,card)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
      ON CONFLICT (user_id,project_id,run_id) DO UPDATE SET updated_at=evimed_channels.tasks.updated_at
      RETURNING *`, [newId("cht"), input.bindingId, input.userId, input.projectId, input.chatId, input.replyTo ?? null,
      input.sessionId, input.runId, JSON.stringify(input.card ?? {})]);
    return taskRecord(rows[0]);
  }

  /** @param {{ owner: string, leaseMs: number, limit?: number }} input */
  async claimTasks({ owner, leaseMs, limit = 10 }) {
    const { rows } = await this.query(`WITH due AS (
        SELECT id FROM evimed_channels.tasks
        WHERE status IN ('running','delivering') AND next_check_at <= clock_timestamp()
          AND (lease_expires_at IS NULL OR lease_expires_at < clock_timestamp())
        ORDER BY next_check_at, id FOR UPDATE SKIP LOCKED LIMIT $1
      ) UPDATE evimed_channels.tasks t SET lease_owner=$2,
        lease_expires_at=clock_timestamp() + ($3::integer * interval '1 millisecond')
      FROM due WHERE t.id=due.id RETURNING t.*`, [limit, owner, leaseMs]);
    return rows.map(taskRecord);
  }

  /**
   * Write what the worker learned and hand the lease back. Refused (false)
   * when another worker holds the task now: a stale writer must not undo it.
   * @param {string} id @param {string} owner
   * @param {{ status?: string, card?: Record<string, any>, result?: Record<string, any>, attempts?: number,
   *   nextCheckAt?: Date, finished?: boolean }} patch
   */
  async settleTask(id, owner, patch) {
    const { rowCount } = await this.query(`UPDATE evimed_channels.tasks SET
        status=COALESCE($3,status), card=COALESCE($4::jsonb,card), result=COALESCE($5::jsonb,result),
        attempts=COALESCE($6,attempts), next_check_at=COALESCE($7::timestamptz,next_check_at),
        finished_at=CASE WHEN $8::boolean THEN clock_timestamp() ELSE finished_at END,
        lease_owner=NULL, lease_expires_at=NULL, updated_at=clock_timestamp()
      WHERE id=$1 AND lease_owner=$2`, [id, owner, patch.status ?? null,
      patch.card ? JSON.stringify(patch.card) : null, patch.result ? JSON.stringify(patch.result) : null,
      patch.attempts ?? null, patch.nextCheckAt ? patch.nextCheckAt.toISOString() : null, patch.finished === true]);
    return (rowCount ?? 0) > 0;
  }

  /**
   * Record a finished step of a task's delivery while still holding it, so a
   * crash between the answer and the files does not send the answer twice.
   * @param {string} id @param {string} owner
   * @param {{ card?: Record<string, any>, result?: Record<string, any>, status?: string }} patch
   */
  async checkpointTask(id, owner, patch) {
    const { rowCount } = await this.query(`UPDATE evimed_channels.tasks SET card=COALESCE($3::jsonb,card),
      result=COALESCE($4::jsonb,result), status=COALESCE($5,status), updated_at=clock_timestamp()
      WHERE id=$1 AND lease_owner=$2`,
    [id, owner, patch.card ? JSON.stringify(patch.card) : null, patch.result ? JSON.stringify(patch.result) : null,
      patch.status ?? null]);
    return (rowCount ?? 0) > 0;
  }

  /** @param {string} userId @param {string} projectId @param {string} runId */
  async taskForRun(userId, projectId, runId) {
    const { rows } = await this.query("SELECT * FROM evimed_channels.tasks WHERE user_id=$1 AND project_id=$2 AND run_id=$3",
      [userId, projectId, runId]);
    return taskRecord(rows[0]);
  }

  /** The newest unfinished task a chat started. @param {string} bindingId @param {string} chatId */
  async openTaskForChat(bindingId, chatId) {
    const { rows } = await this.query(`SELECT * FROM evimed_channels.tasks WHERE binding_id=$1 AND chat_id=$2
      AND status IN ('running','delivering') ORDER BY created_at DESC, id DESC LIMIT 1`, [bindingId, chatId]);
    return taskRecord(rows[0]);
  }

  /** Bring a task's next check forward, when something says it changed.
   *  @param {string} userId @param {string} projectId @param {string} runId */
  async wakeTask(userId, projectId, runId) {
    await this.query(`UPDATE evimed_channels.tasks SET next_check_at=LEAST(next_check_at, clock_timestamp())
      WHERE user_id=$1 AND project_id=$2 AND run_id=$3 AND status IN ('running','delivering')`, [userId, projectId, runId]);
  }

  // --- deliveries -----------------------------------------------------------

  /**
   * @param {{ userId: string, channel: string, bindingId: string, notificationId: string, eventCount: number, notBefore: Date,
   *   status?: 'pending' | 'skipped', reason?: string | null }} input
   */
  async enqueueDelivery(input) {
    const { rows } = await this.query(`INSERT INTO evimed_channels.deliveries
      (id,user_id,channel,binding_id,notification_id,event_count,not_before,status,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (binding_id,notification_id,event_count) DO NOTHING RETURNING *`,
    [newId("chd"), input.userId, input.channel, input.bindingId, input.notificationId, input.eventCount,
      input.notBefore.toISOString(), input.status ?? "pending", input.reason ?? null]);
    return deliveryRecord(rows[0]);
  }

  /** @param {{ owner: string, leaseMs: number, limit?: number }} input */
  async claimDeliveries({ owner, leaseMs, limit = 20 }) {
    const { rows } = await this.query(`WITH due AS (
        SELECT id FROM evimed_channels.deliveries
        WHERE status='pending' AND not_before <= clock_timestamp()
          AND (lease_expires_at IS NULL OR lease_expires_at < clock_timestamp())
        ORDER BY not_before, id FOR UPDATE SKIP LOCKED LIMIT $1
      ) UPDATE evimed_channels.deliveries d SET lease_owner=$2,
        lease_expires_at=clock_timestamp() + ($3::integer * interval '1 millisecond'), attempts=d.attempts+1
      FROM due WHERE d.id=due.id RETURNING d.*`, [limit, owner, leaseMs]);
    return rows.map(deliveryRecord);
  }

  /**
   * @param {string} id @param {string} owner
   * @param {{ status: 'pending' | 'sent' | 'failed' | 'skipped', messageId?: string | null, reason?: string | null, retryAt?: Date | null }} result
   */
  async settleDelivery(id, owner, { status, messageId = null, reason = null, retryAt = null }) {
    const { rowCount } = await this.query(`UPDATE evimed_channels.deliveries SET status=$3, message_id=COALESCE($4,message_id),
      reason=$5, not_before=COALESCE($6::timestamptz,not_before), lease_owner=NULL, lease_expires_at=NULL,
      updated_at=clock_timestamp() WHERE id=$1 AND lease_owner=$2`,
    [id, owner, status, messageId, reason, retryAt ? retryAt.toISOString() : null]);
    return (rowCount ?? 0) > 0;
  }

  /** What was pushed for one inbox item, for the reconcile pass.
   *  @param {string} notificationId @param {string} bindingId @param {number} eventCount */
  async hasDelivery(notificationId, bindingId, eventCount) {
    const { rowCount } = await this.query(`SELECT 1 FROM evimed_channels.deliveries
      WHERE notification_id=$1 AND binding_id=$2 AND event_count=$3`, [notificationId, bindingId, eventCount]);
    return (rowCount ?? 0) > 0;
  }

  /** @param {Date} before @param {number} [limit] */
  async pruneDeliveries(before, limit = 1000) {
    const { rowCount } = await this.query(`WITH doomed AS (
        SELECT id FROM evimed_channels.deliveries WHERE updated_at < $1 AND status<>'pending'
        ORDER BY updated_at LIMIT $2 FOR UPDATE SKIP LOCKED
      ) DELETE FROM evimed_channels.deliveries d USING doomed WHERE d.id=doomed.id`, [before.toISOString(), limit]);
    return rowCount ?? 0;
  }
}
