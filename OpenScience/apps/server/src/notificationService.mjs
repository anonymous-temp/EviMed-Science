import { createHash, randomUUID } from "node:crypto";
import { NOTICE_PRIORITY, NOTICE_TYPES } from "@evimed/domain";
import { HttpError } from "./security.mjs";
import { migrateNotifications } from "./notificationPersistence.mjs";
import { productId, productInteger } from "./productPersistence.mjs";

/** @param {unknown} value @param {string} name @param {number} max */
function text(value, name, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
    throw new HttpError(400, "notification_payload_invalid", `Invalid ${name}.`);
  }
  return value.trim();
}

/** @param {unknown} value @param {string} name */
function timestamp(value, name) {
  if (value == null) return null;
  const time = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(time.getTime())) throw new HttpError(400, "notification_payload_invalid", `Invalid ${name}.`);
  return time.toISOString();
}

/** @param {unknown} value */
function actions(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 8) throw new HttpError(400, "notification_payload_invalid", "Invalid actions.");
  const ids = new Set();
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some((key) => !["id", "label", "style"].includes(key))) {
      throw new HttpError(400, "notification_payload_invalid", "Invalid action.");
    }
    const id = productId(item.id, "action");
    if (ids.has(id)) throw new HttpError(400, "notification_payload_invalid", "Duplicate action.");
    ids.add(id);
    const style = item.style ?? "neutral";
    if (!["neutral", "primary", "danger"].includes(style)) throw new HttpError(400, "notification_payload_invalid", "Invalid action style.");
    return { id, label: text(item.label, "action label", 80), style };
  });
}

/** @param {unknown} value */
function source(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "notification_payload_invalid", "Invalid source.");
  }
  const item = /** @type {Record<string, any>} */ (value);
  if (Object.keys(item).sort().join(",") !== "id,type" || !["run", "thread", "share", "system", "digest"].includes(item.type)) {
    throw new HttpError(400, "notification_payload_invalid", "Invalid source.");
  }
  return { type: item.type, id: productId(item.id, "source") };
}

/** @param {any} row */
function record(row) {
  return row ? {
    id: row.id, userId: row.user_id, projectId: row.project_id, noticeType: row.notice_type,
    priority: Number(row.priority), title: row.title, body: row.body, actions: row.actions,
    source: row.source, groupKey: row.group_key, count: Number(row.event_count),
    dueAt: row.due_at == null ? null : new Date(row.due_at).toISOString(), defaultAction: row.default_action,
    readAt: row.read_at == null ? null : new Date(row.read_at).toISOString(),
    resolvedAt: row.resolved_at == null ? null : new Date(row.resolved_at).toISOString(),
    resolution: row.resolution, channelsSent: row.channels_sent, revision: Number(row.revision),
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
  } : null;
}

function validTime(value, name) {
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new HttpError(400, "notification_preferences_invalid", `Invalid ${name}.`);
  }
  return value;
}

function sameSemantics(item, values) {
  const dueAt = item.dueAt == null ? null : new Date(item.dueAt).toISOString();
  const expectedActions = JSON.parse(values.actions);
  const expectedSource = JSON.parse(values.source);
  const actionsMatch = item.actions.length === expectedActions.length && item.actions.every((action, index) => {
    const expected = expectedActions[index];
    return action.id === expected.id && action.label === expected.label && action.style === expected.style;
  });
  const sourceMatches = item.source == null ? expectedSource == null
    : expectedSource != null && item.source.id === expectedSource.id && item.source.type === expectedSource.type;
  return item.projectId === values.projectId && item.noticeType === values.noticeType
    && item.priority === values.priority && item.title === values.title && item.body === values.body
    && actionsMatch && sourceMatches
    && item.groupKey === values.groupKey && dueAt === values.dueAt && item.defaultAction === values.defaultAction;
}

/** Durable in-app notification, question and review inbox. */
export class NotificationService {
  /** @param {any} database */
  constructor(database) { this.database = database; }

  async health() {
    await migrateNotifications(this.database);
    const result = await this.database.query("SELECT count(*)::integer AS unresolved FROM evimed_inbox.notifications WHERE resolved_at IS NULL");
    return { connected: true, unresolved: Number(result.rows[0]?.unresolved ?? 0), channel: "in-app" };
  }

  /** @param {string} userId @param {Record<string,any>} input @param {{now?:Date}} options */
  async create(userId, input, { now = new Date() } = {}) {
    const user = productId(userId, "user");
    const noticeType = String(input.noticeType ?? "");
    if (!NOTICE_TYPES.includes(noticeType)) throw new HttpError(400, "notification_payload_invalid", "Invalid notice type.");
    const createdAt = timestamp(now, "creation time");
    const actionList = actions(input.actions);
    if (noticeType !== "notify" && actionList.length === 0) throw new HttpError(400, "notification_payload_invalid", "Blocking inbox items require actions.");
    const defaultAction = input.defaultAction == null ? null : productId(input.defaultAction, "default action");
    if (defaultAction && !actionList.some((item) => item.id === defaultAction)) throw new HttpError(400, "notification_action_invalid", "Default action is unavailable.");
    if (defaultAction && input.dueAt == null) throw new HttpError(400, "notification_payload_invalid", "A default action requires a due time.");
    const values = {
      id: input.idempotencyKey == null ? randomUUID() : `notification:${createHash("sha256")
        .update(JSON.stringify([user, text(input.idempotencyKey, "idempotency key", 200)])).digest("hex")}`,
      user, projectId: input.projectId == null ? null : productId(input.projectId, "project"),
      noticeType, priority: NOTICE_PRIORITY[noticeType], title: text(input.title, "title", 150), body: text(input.body, "body", 8000),
      actions: JSON.stringify(actionList), source: JSON.stringify(source(input.source)),
      groupKey: input.groupKey == null ? null : text(input.groupKey, "group key", 200),
      dueAt: timestamp(input.dueAt, "due time"), defaultAction, createdAt,
    };
    await migrateNotifications(this.database);
    return this.database.transaction(async (client) => {
      if (input.idempotencyKey != null) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`evimed-inbox-key:${values.id}`]);
        const prior = await client.query("SELECT * FROM evimed_inbox.notifications WHERE id=$1 FOR UPDATE", [values.id]);
        if (prior.rowCount) {
          const item = record(prior.rows[0]);
          if (item.userId === values.user && sameSemantics(item, values)) return item;
          throw new HttpError(409, "notification_idempotency_conflict", "The notification key already names different content.");
        }
      }
      if (values.noticeType === "notify" && values.groupKey) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `evimed-inbox:${JSON.stringify([values.user, values.projectId, values.groupKey])}`,
        ]);
        const existing = await client.query(`SELECT * FROM evimed_inbox.notifications
          WHERE user_id=$1 AND notice_type='notify' AND group_key=$2 AND project_id IS NOT DISTINCT FROM $4::text AND resolved_at IS NULL
          AND created_at BETWEEN $3::timestamptz - interval '5 minutes' AND $3::timestamptz
          ORDER BY created_at DESC,id DESC FOR UPDATE LIMIT 1`, [values.user, values.groupKey, values.createdAt, values.projectId]);
        if (existing.rowCount) {
          const merged = await client.query(`UPDATE evimed_inbox.notifications SET title=$2,body=$3,
            event_count=event_count+1,revision=revision+1,updated_at=$4 WHERE id=$1 RETURNING *`,
          [existing.rows[0].id, values.title, values.body, values.createdAt]);
          return record(merged.rows[0]);
        }
      }
      const inserted = await client.query(`INSERT INTO evimed_inbox.notifications
        (id,user_id,project_id,notice_type,priority,title,body,actions,source,group_key,due_at,default_action,channels_sent,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,jsonb_build_object('in-app',$13::text),$13::timestamptz,$13::timestamptz)
        ON CONFLICT(id) DO NOTHING RETURNING *`,
      [values.id, values.user, values.projectId, values.noticeType, values.priority, values.title, values.body,
        values.actions, values.source, values.groupKey, values.dueAt, values.defaultAction, values.createdAt]);
      if (inserted.rowCount) return record(inserted.rows[0]);
      const existing = await client.query("SELECT * FROM evimed_inbox.notifications WHERE user_id=$1 AND id=$2", [values.user, values.id]);
      const item = record(existing.rows[0]);
      if (item && item.userId === values.user && sameSemantics(item, values)) return item;
      throw new HttpError(409, "notification_idempotency_conflict", "The notification key already names different content.");
    });
  }

  /** @param {string} userId @param {{limit?:number,cursor?:string|null,noticeType?:string|null,unreadOnly?:boolean,unresolvedOnly?:boolean}} options */
  async list(userId, { limit = 50, cursor = null, noticeType = null, unreadOnly = false, unresolvedOnly = false } = {}) {
    productInteger(limit, 1, 100);
    if (noticeType != null && !NOTICE_TYPES.includes(noticeType)) throw new HttpError(400, "notification_filter_invalid", "Invalid notice type.");
    if (typeof unreadOnly !== "boolean" || typeof unresolvedOnly !== "boolean") throw new HttpError(400, "notification_filter_invalid", "Invalid inbox filter.");
    let after = null;
    if (cursor) {
      try {
        after = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (!Array.isArray(after) || after.length !== 3 || !Number.isInteger(after[0]) || !Number.isFinite(Date.parse(after[1]))) throw new Error();
        productId(after[2]);
      } catch { throw new HttpError(400, "notification_cursor_invalid", "Invalid inbox cursor."); }
    }
    await migrateNotifications(this.database);
    const result = await this.database.query(`SELECT * FROM evimed_inbox.notifications WHERE user_id=$1
      AND ($2::text IS NULL OR notice_type=$2) AND (NOT $3::boolean OR read_at IS NULL)
      AND (NOT $4::boolean OR resolved_at IS NULL)
      AND ($5::smallint IS NULL OR priority>$5 OR (priority=$5 AND (created_at,id)<($6::timestamptz,$7::text)))
      ORDER BY priority,created_at DESC,id DESC LIMIT $8`,
    [productId(userId, "user"), noticeType, unreadOnly, unresolvedOnly, after?.[0] ?? null, after?.[1] ?? null, after?.[2] ?? null, limit + 1]);
    const items = result.rows.slice(0, limit).map(record);
    const last = items.at(-1);
    return { items, nextCursor: result.rows.length > limit && last
      ? Buffer.from(JSON.stringify([last.priority, last.createdAt, last.id])).toString("base64url") : null };
  }

  async get(userId, id, client = this.database) {
    await migrateNotifications(this.database);
    const result = await client.query("SELECT * FROM evimed_inbox.notifications WHERE user_id=$1 AND id=$2", [productId(userId, "user"), productId(id)]);
    if (result.rowCount !== 1) throw new HttpError(404, "notification_not_found", "Inbox item not found.");
    return record(result.rows[0]);
  }

  async markRead(userId, id, expectedRevision) {
    return this.#update(userId, id, expectedRevision, `read_at=coalesce(read_at,clock_timestamp())`);
  }

  async resolve(userId, id, { actionId, expectedRevision }) {
    const item = await this.get(userId, id);
    const action = productId(actionId, "action");
    if (!item.actions.some((candidate) => candidate.id === action)) throw new HttpError(400, "notification_action_invalid", "Inbox action is unavailable.");
    return this.#update(userId, id, expectedRevision,
      `read_at=coalesce(read_at,clock_timestamp()),resolved_at=clock_timestamp(),resolution=jsonb_build_object('actionId',$4::text,'source','user')`, action, true);
  }

  async #update(userId, id, expectedRevision, assignment, extra = null, requireUnresolved = false) {
    productInteger(expectedRevision, 1, 2_147_483_646);
    await migrateNotifications(this.database);
    const parameters = [productId(userId, "user"), productId(id), expectedRevision];
    if (extra != null) parameters.push(extra);
    const result = await this.database.query(`UPDATE evimed_inbox.notifications SET ${assignment},revision=revision+1,updated_at=clock_timestamp()
      WHERE user_id=$1 AND id=$2 AND revision=$3 ${requireUnresolved ? "AND resolved_at IS NULL" : ""} RETURNING *`, parameters);
    if (result.rowCount) return record(result.rows[0]);
    const exists = await this.database.query("SELECT 1 FROM evimed_inbox.notifications WHERE user_id=$1 AND id=$2", [userId, id]);
    if (!exists.rowCount) throw new HttpError(404, "notification_not_found", "Inbox item not found.");
    if (requireUnresolved) {
      const terminal = await this.database.query("SELECT resolved_at FROM evimed_inbox.notifications WHERE user_id=$1 AND id=$2", [userId, id]);
      if (terminal.rows[0]?.resolved_at) throw new HttpError(409, "notification_already_resolved", "Inbox item is already resolved.");
    }
    throw new HttpError(409, "notification_revision_conflict", "Inbox item changed; reload before saving.");
  }

  async applyDueDefaults(now = new Date(), limit = 100) {
    productInteger(limit, 1, 500);
    const at = timestamp(now, "default time");
    await migrateNotifications(this.database);
    const result = await this.database.query(`WITH due AS (
      SELECT id FROM evimed_inbox.notifications WHERE resolved_at IS NULL AND default_action IS NOT NULL AND due_at <= $1
      ORDER BY due_at,id FOR UPDATE SKIP LOCKED LIMIT $2
    ) UPDATE evimed_inbox.notifications n SET read_at=coalesce(n.read_at,$1),resolved_at=$1,
      resolution=jsonb_build_object('actionId',n.default_action,'source','default'),revision=n.revision+1,updated_at=$1
      FROM due WHERE n.id=due.id RETURNING n.*`, [at, limit]);
    return result.rows.map(record);
  }

  async preferences(userId) {
    await migrateNotifications(this.database);
    const result = await this.database.query(`INSERT INTO evimed_inbox.preferences(user_id) VALUES($1)
      ON CONFLICT(user_id) DO UPDATE SET user_id=excluded.user_id
      RETURNING *`, [productId(userId, "user")]);
    return this.#preferences(result.rows[0]);
  }

  async updatePreferences(userId, input, expectedRevision) {
    productInteger(expectedRevision, 1, 2_147_483_646);
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join(",") !== "channels,digestTime,quietHours,switches") {
      throw new HttpError(400, "notification_preferences_invalid", "Invalid inbox preferences.");
    }
    if (!input.quietHours || Object.keys(input.quietHours).sort().join(",") !== "end,start") throw new HttpError(400, "notification_preferences_invalid", "Invalid quiet hours.");
    if (!input.switches || Object.keys(input.switches).sort().join(",") !== "notify,question,review"
      || Object.values(input.switches).some((value) => typeof value !== "boolean")) throw new HttpError(400, "notification_preferences_invalid", "Invalid switches.");
    if (!Array.isArray(input.channels) || input.channels.length !== 1 || input.channels[0] !== "in-app") {
      throw new HttpError(400, "notification_preferences_invalid", "This release supports in-app delivery.");
    }
    await migrateNotifications(this.database);
    const result = await this.database.query(`UPDATE evimed_inbox.preferences SET quiet_start=$3,quiet_end=$4,digest_time=$5,
      switches=$6::jsonb,channels=$7::jsonb,revision=revision+1,updated_at=clock_timestamp()
      WHERE user_id=$1 AND revision=$2 RETURNING *`, [productId(userId, "user"), expectedRevision,
      validTime(input.quietHours.start, "quiet start"), validTime(input.quietHours.end, "quiet end"),
      validTime(input.digestTime, "digest time"), JSON.stringify(input.switches), JSON.stringify(input.channels)]);
    if (!result.rowCount) throw new HttpError(409, "notification_revision_conflict", "Inbox preferences changed; reload before saving.");
    return this.#preferences(result.rows[0]);
  }

  #preferences(row) {
    return { quietHours: { start: row.quiet_start, end: row.quiet_end }, digestTime: row.digest_time,
      switches: row.switches, channels: row.channels, revision: Number(row.revision), updatedAt: new Date(row.updated_at).toISOString() };
  }
}
