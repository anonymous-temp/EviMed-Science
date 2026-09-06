import { exportPluginPayload, projectPluginId } from "./pluginService.mjs";
import { HttpError } from "./security.mjs";
import { migrateProductStore } from "./productPersistence.mjs";
import { migrateNotifications } from "./notificationPersistence.mjs";
import { migrateUsageLedger } from "./usagePersistence.mjs";

const MAX_ROWS = 50000;
const MAX_BYTES = 64 * 1024 * 1024;
const customerKinds = ["capsule", "fact", "method", "source", "source-unit", "knowledge", "profile", "agenda", "episode", "digest", "notification", "preferences", "plugin"];
const queries = [
  ["projects", `SELECT id,name,created_at AS "createdAt",updated_at AS "updatedAt"
    FROM evimed_control.projects WHERE user_id=$1 ORDER BY id`],
  ["researchSessions", `SELECT project_id AS "projectId",session_id AS "sessionId",mode,agent_id AS "agentId",
    agent_version AS "agentVersion",runtime_agent AS "runtimeAgent",created_at AS "createdAt",updated_at AS "updatedAt"
    FROM evimed_control.research_sessions WHERE user_id=$1 ORDER BY project_id,session_id`],
  ["documents", `SELECT id,kind,project_id AS "projectId",payload,revision,created_at AS "createdAt",updated_at AS "updatedAt",deleted_at AS "deletedAt"
    FROM evimed_product.documents WHERE user_id=$1 AND kind=ANY($2::text[]) ORDER BY kind,id`],
  ["revisions", `SELECT r.id,r.kind,d.project_id AS "projectId",r.payload,r.revision,r.deleted_at AS "deletedAt",r.recorded_at AS "recordedAt"
    FROM evimed_product.revisions r JOIN evimed_product.documents d ON (d.user_id,d.kind,d.id)=(r.user_id,r.kind,r.id)
    WHERE r.user_id=$1 AND r.kind=ANY($2::text[]) ORDER BY r.kind,r.id,r.revision`],
  ["notifications", `SELECT id,project_id AS "projectId",notice_type AS "noticeType",priority,title,body,actions,source,
    group_key AS "groupKey",event_count AS count,due_at AS "dueAt",default_action AS "defaultAction",read_at AS "readAt",
    resolved_at AS "resolvedAt",resolution,revision,created_at AS "createdAt",updated_at AS "updatedAt"
    FROM evimed_inbox.notifications WHERE user_id=$1 ORDER BY created_at,id`],
  ["notificationPreferences", `SELECT quiet_start AS "quietStart",quiet_end AS "quietEnd",digest_time AS "digestTime",switches,channels,revision,updated_at AS "updatedAt"
    FROM evimed_inbox.preferences WHERE user_id=$1`],
  ["usage", `SELECT id,project_id AS "projectId",run_id AS "runId",model,price_version AS "priceVersion",currency,status,
    reserved_cost::text AS "reservedCost",actual_cost::text AS "actualCost",priced,cache_hit_tokens::text AS "cacheHitTokens",
    cache_miss_tokens::text AS "cacheMissTokens",output_tokens::text AS "outputTokens",error_code AS "errorCode",created_at AS "createdAt",settled_at AS "settledAt"
    FROM evimed_usage.model_requests WHERE user_id=$1 ORDER BY created_at,id`],
];

function tooLarge() { return new HttpError(413, "archive_too_large", "Account export exceeds its complete customer-state row or byte limit."); }

/** Keep the authenticated account generation and every PG table in one snapshot.
 * The callback collects and sends the existing filesystem archive while the
 * user row stays shared-locked: account deletion locks it before removing files.
 * @param {any} database @param {any} user @param {Record<string,any>} config
 * @param {(snapshot:any) => Promise<any>} operation
 * @param {{maxRows?:number,maxBytes?:number}} limits */
export async function withAccountExportSnapshot(database, user, config, operation, limits = {}) {
  if (!database) return operation(null);
  if (typeof user.accountCreatedAt !== "string" || !user.accountCreatedAt) {
    throw new HttpError(409, "account_export_account_changed", "The authenticated account generation is no longer available.");
  }
  const maxRows = Math.min(MAX_ROWS, limits.maxRows ?? MAX_ROWS);
  const maxBytes = Math.min(MAX_BYTES, limits.maxBytes ?? MAX_BYTES,
    Number.isFinite(config.maxArchiveBytes) && config.maxArchiveBytes > 0 ? config.maxArchiveBytes : MAX_BYTES);
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw tooLarge();
  await migrateProductStore(database);
  await migrateNotifications(database);
  await migrateUsageLedger(database);
  return database.transaction(async client => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const account = await client.query(`SELECT id,name,created_at::text AS "accountCreatedAt",created_at=$2::timestamptz AS "sameGeneration",
      transaction_timestamp() AS "snapshotAt" FROM evimed_control.users WHERE id=$1 FOR SHARE`, [user.id, user.accountCreatedAt]);
    const owner = account.rows[0];
    if (!owner?.sameGeneration) throw new HttpError(409, "account_export_account_changed", "The authenticated account generation changed before export.");
    // New persisted kinds require an explicit customer export contract.
    const unsupported = await client.query("SELECT 1 FROM evimed_product.documents WHERE user_id=$1 AND NOT(kind=ANY($2::text[])) LIMIT 1", [user.id, [...customerKinds, "price-list"]]);
    if (unsupported.rowCount) throw new HttpError(503, "account_export_unsupported_state", "Stored settings need a supported customer export shape.");
    const tables = {};
    let rows = 0;
    let bytes = 0;
    for (const [key, query] of queries) {
      const values = query.includes("$2") ? [user.id, customerKinds] : [user.id];
      // Preflight in the same snapshot before transferring potentially large
      // JSONB payloads. No LIMIT or list-API page can silently truncate content.
      const size = await client.query(`SELECT count(*)::text AS rows,coalesce(sum(octet_length(row_to_json(customer_row)::text)),0)::text AS bytes FROM (${query}) customer_row`, values);
      rows += Number(size.rows[0].rows);
      bytes += Number(size.rows[0].bytes);
      if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(bytes) || rows > maxRows || bytes > maxBytes) throw tooLarge();
      tables[key] = (await client.query(query, values)).rows;
      if (key === "documents" || key === "revisions") tables[key] = tables[key].map(row => {
        if (row.kind !== "plugin") return row;
        if (typeof row.projectId !== "string" || row.id !== projectPluginId(row.projectId)) {
          throw new HttpError(503, "account_export_unsupported_state", "Stored plugin identity is unsupported.");
        }
        return { ...row, payload: exportPluginPayload(row.payload) };
      });
    }
    const state = {
      version: 1, snapshotAt: owner.snapshotAt, account: { id: owner.id, name: owner.name, accountCreatedAt: owner.accountCreatedAt },
      projects: tables.projects, researchSessions: tables.researchSessions, documents: tables.documents, revisions: tables.revisions,
      inbox: { notifications: tables.notifications, preferences: tables.notificationPreferences[0] ?? null }, usage: tables.usage,
    };
    const data = Buffer.from(`${JSON.stringify(state)}\n`, "utf8");
    if (data.length > maxBytes) throw tooLarge();
    return operation({ projects: tables.projects, data });
  });
}

/** Add generated state without bypassing the existing archive budgets.
 * @param {any[]} entries @param {Buffer} data @param {Record<string,any>} config */
export function appendAccountStateArchiveEntry(entries, data, config) {
  const count = entries.length + 1;
  const bytes = entries.reduce((sum, entry) => sum + entry.size, data.length);
  if ((Number.isFinite(config.maxArchiveEntries) && config.maxArchiveEntries > 0 && count > config.maxArchiveEntries)
    || (Number.isFinite(config.maxArchiveBytes) && config.maxArchiveBytes > 0 && bytes > config.maxArchiveBytes)) throw tooLarge();
  return [...entries, { rel: "account/customer-state.json", type: "file", data, size: data.length, mode: 0o600, mtime: new Date() }];
}
