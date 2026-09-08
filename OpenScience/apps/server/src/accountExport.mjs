import { priceListFor } from "@evimed/domain";
import { PLUGIN_REGISTRY, exportPluginPayload, projectPluginId } from "./pluginService.mjs";
import { HttpError } from "./security.mjs";
import { migrateProductStore } from "./productPersistence.mjs";
import { migrateNotifications } from "./notificationPersistence.mjs";
import { migrateUsageLedger } from "./usagePersistence.mjs";
import { projectSourceDerivedRecord, projectSourceManifestRecord } from "./sourceService.mjs";

const MAX_ROWS = 50000;
const MAX_BYTES = 64 * 1024 * 1024;
// The document kinds that are the customer's own data. "price-list" is absent
// on the evidence: it is a declared PRODUCT_KIND that no product code reads or
// writes (the only writer is the export integration test's fixture, which is
// there to prove such a row never leaves), so nothing user-scoped is known to
// live under it and there is no shape to export. Prices are not per-user at
// all — they live in `@evimed/domain`'s price-list registry — and the export
// carries the lists its own usage rows name, from there. See
// `exportedPriceLists`.
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
  // What the researcher decided about their own memories and deliverables. The
  // ledger is append-only and has no delete path, so the customer's copy of it
  // is the only place they can read back what the platform kept about them.
  ["feedbackEvents", `SELECT id,project_id AS "projectId",run_id AS "runId",trigger_kind AS "trigger",
    subject_type AS "subjectType",subject_id AS "subjectId",detail,occurred_at AS "occurredAt",recorded_at AS "recordedAt"
    FROM evimed_product.feedback_events WHERE user_id=$1 ORDER BY occurred_at,id`],
];

/** Every table the exported state is read from, as `schema.table`.
 *
 * Derived from the queries themselves rather than written down beside them: a
 * second list would be one more thing to forget, and forgetting is exactly the
 * failure this exists to catch. `evimed_control.users` is not here because the
 * account row is read by the snapshot's own locking SELECT, not by a query in
 * this list.
 *
 * @param {readonly (readonly string[])[]} source
 * @returns {string[]} */
export function accountExportTables(source = queries) {
  const names = new Set();
  for (const [, query] of source) {
    for (const [, name] of query.matchAll(/\b(?:FROM|JOIN)\s+(evimed_\w+\.\w+)/g)) names.add(name);
  }
  return [...names].sort();
}

/** The user-scoped tables the archive deliberately leaves out, and why.
 *
 * The kind guard below refuses the export when it meets a `documents` kind
 * nobody declared. Nothing did the same for tables, so a new user-scoped table
 * — `evimed_product.feedback_events` was one — could be added and simply not
 * exported, with no test and no runtime check noticing. This list is the
 * counterpart: `accountExport.test.mjs` walks the migration SQL and requires
 * every table with a `user_id` column to be either exported or named here with
 * a reason. It is a test-time guard on purpose. A production refusal would turn
 * the next migration into an outage for every export until someone edited this
 * file, and the export is not where that should be discovered. */
export const UNEXPORTED_ACCOUNT_TABLES = Object.freeze({
  "evimed_control.auth_sessions": "browser sessions: an exported session hash and CSRF token are credentials, not content, and the rows expire on their own",
  "evimed_product.jobs": "queue bookkeeping for work whose result is the exported documents; a queued or failed job is the platform's state, not the researcher's",
  "evimed_product.plugin_prompt_admissions": "one row recording that a project was offered a plugin prompt; it holds nothing the customer wrote",
  "evimed_product.plugin_application_state": "the runtime's view of a plugin document that is itself exported, and stale the moment it leaves this deployment",
  "evimed_product.memory_index_state": "publication bookkeeping for the ranking index over capsules that are themselves exported; derived from them and from nothing else",
});

function tooLarge() { return new HttpError(413, "archive_too_large", "Account export exceeds its complete customer-state row or byte limit."); }

/** Every plugin-document id this control plane can name for one project.
 *
 * The archive used to compare a stored plugin document against
 * `projectPluginId(projectId)` -- dsh-cite's id and nothing else -- so a second
 * registered bundle's configuration would have been read as an unsupported
 * identity and taken the whole export down with it, 503 for a document the
 * product itself wrote. The customer's own copy of their data has to carry
 * every plugin they can configure, so this asks the same registry the routes
 * and the apply path address.
 *
 * @param {string} projectId @param {Map<string,any>} registry
 * @returns {string[]} */
export function projectPluginDocumentIds(projectId, registry = PLUGIN_REGISTRY) {
  return [...registry.keys()].map((pluginId) => projectPluginId(projectId, pluginId, registry));
}

/** One stored plugin document, as the customer's own archive carries it.
 *
 * Takes the registry so the rule can be exercised against a deployment with
 * more than one approved bundle without a database: with one registered
 * plugin the identity check below is exactly the id comparison this function
 * replaced, and with two it is the only thing keeping a document stored under
 * one bundle's id from being exported as another's.
 *
 * @param {any} row @param {Map<string,any>} registry */
export function exportPluginDocumentRow(row, registry = PLUGIN_REGISTRY) {
  const unsupported = () => new HttpError(503, "account_export_unsupported_state", "Stored plugin identity is unsupported.");
  if (typeof row.projectId !== "string" || !projectPluginDocumentIds(row.projectId, registry).includes(row.id)) throw unsupported();
  const plugin = exportPluginPayload(row.payload, registry);
  // The id and the payload have to name the same bundle. With one registered
  // plugin the check above already implied it; with two it does not, and a
  // document stored under one bundle's id whose payload claims another would
  // hand the customer a configuration the platform never applied to the plugin
  // the file says it belongs to.
  if (row.id !== projectPluginId(row.projectId, plugin.pluginId, registry)) throw unsupported();
  return { ...row, payload: plugin };
}

/** The price lists the exported usage rows name — every one this deployment
 * can still resolve, and a null for every one it cannot.
 * A usage row records a version, not a rate; an export that carried only the
 * version would leave the customer's own copy of their spending resolvable
 * nowhere but in this repository. So the archive is self-contained exactly as
 * far as the registry reaches: a version `priceListFor` no longer knows is
 * exported as null rather than dropped, because an absent key reads as "no
 * price list" while null states the true thing — the row names one this
 * platform no longer holds, and its rate is not recoverable from this file.
 * Nothing user-scoped is invented here; the lists come from `@evimed/domain`,
 * which is where platform prices live.
 * The map has a null prototype and is probed with `Object.hasOwn`, because
 * `priceVersion` arrives from a database column: on a plain object literal a
 * row naming "toString" would test as already collected and be dropped, and one
 * naming "__proto__" would not become a key at all.
 * @param {{priceVersion?:unknown}[]} usageRows
 * @returns {Record<string, any>} */
export function exportedPriceLists(usageRows) {
  /** @type {Record<string, any>} */
  const lists = Object.create(null);
  for (const row of usageRows) {
    const version = typeof row.priceVersion === "string" ? row.priceVersion : "";
    if (!version || Object.hasOwn(lists, version)) continue;
    lists[version] = priceListFor(version);
  }
  return lists;
}

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
    // "price-list" is tolerated here and exported nowhere: the kind is declared
    // in PRODUCT_KINDS but no product code reads or writes it, so a row under it
    // has no known customer meaning, and refusing the whole export over one
    // would be a 503 for something nothing in the product put there.
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
        if (row.kind === "source") return { ...row, payload: projectSourceManifestRecord(row).payload };
        const sourceDerived = projectSourceDerivedRecord(row);
        if (sourceDerived) return { ...row, payload: sourceDerived };
        if (row.kind !== "plugin") return row;
        return exportPluginDocumentRow(row);
      });
    }
    // `version` stays 1 with `priceLists` and `feedbackEvents` added: v1 is an
    // additive contract, so a new top-level key is not a break for a reader
    // that keeps parsing the keys it knows, and a bump would tell every archive
    // holder their parser needs revisiting when it does not. It moves when an
    // existing key changes shape or leaves. `feedbackEvents` is a query like
    // any other, so the row and byte pre-flight above already bounds it.
    // What bounds `priceLists`: the pre-flight count above never sees it —
    // `maxRows` counts database rows — but it holds at most one entry per
    // distinct price version among usage rows already counted there, and the
    // assembled buffer is measured against `maxBytes` below, which refuses the
    // export rather than shipping an over-budget archive.
    const state = {
      version: 1, snapshotAt: owner.snapshotAt, account: { id: owner.id, name: owner.name, accountCreatedAt: owner.accountCreatedAt },
      projects: tables.projects, researchSessions: tables.researchSessions, documents: tables.documents, revisions: tables.revisions,
      inbox: { notifications: tables.notifications, preferences: tables.notificationPreferences[0] ?? null }, usage: tables.usage,
      priceLists: exportedPriceLists(tables.usage), feedbackEvents: tables.feedbackEvents,
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
