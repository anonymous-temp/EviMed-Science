import { DOCUMENT_EXPORT_FORMATS, priceListFor, projectAffected, projectCorrectionOutcome, projectResultInput, projectResultVersion } from "@evimed/domain";
import { PLUGIN_REGISTRY, exportPluginPayload, projectPluginId } from "./pluginService.mjs";
import { HttpError } from "./security.mjs";
import { assertNotPlatformAccount } from "./platformAccount.mjs";
import { migrateProductStore } from "./productPersistence.mjs";
import { migrateNotifications } from "./notificationPersistence.mjs";
import { migrateUsageLedger } from "./usagePersistence.mjs";
import { projectSourceDerivedRecord, projectSourceManifestRecord } from "./sourceService.mjs";
import { EXTENSION_CUSTOMER_KINDS, exportExtensionAccountRow, exportPersonalSkillResources } from "./extensionAccountExport.mjs";
import { migrateEvidenceZones } from "./evidenceZonePersistence.mjs";

const MAX_ROWS = 50000;
const MAX_BYTES = 64 * 1024 * 1024;
// The document kinds that are the customer's own data, carried as rows of
// `documents` and `revisions`. A kind whose stored payload holds more than
// that — a storage location, a queue id, another user's id — leaves through a
// projection; see `exportDocumentRow`.
const customerKinds = ["capsule", "fact", "method", "source", "source-unit", "knowledge", "profile", "agenda", "episode", "digest", "notification", "preferences", "plugin",
  "document-export", "result-version", "result-impact", "result-revision", "result-replay",
  // What a project's datasets were understood to mean: the researcher's own corrections and the model's readings with
  // their basis, the file hashes they were read from, no patient row (dataSemanticsService.mjs).
  "dataset-semantics", ...EXTENSION_CUSTOMER_KINDS];

/** The document kinds the archive deliberately leaves out, and why.
 *
 * Every kind `PRODUCT_KINDS` declares is either carried (`customerKinds`) or
 * named here with a reason, and `accountExportKinds.test.mjs` fails by name on
 * a kind that is neither. That test is the guard. Until 2026-10-03 the guard
 * was a refusal at run time: the export answered 503 for an account holding a
 * kind this file did not name. It did exactly what the paragraph on tables
 * below says such a refusal does. The four result kinds entered
 * `PRODUCT_KINDS` on 2026-10-02, result capture is on by default, and the
 * export was down for every account with one captured result. `method-trial`
 * (2026-09-10) and `document-export` (2026-10-01) were never named here
 * either, so an account holding one of those was refused the same way.
 *
 * So a kind added to `PRODUCT_KINDS` needs a decision here before it merges,
 * and a kind nothing here decided is no longer an outage: the export carries
 * what it has a contract for and states the rest in its own `omissions`. */
export const UNEXPORTED_DOCUMENT_KINDS = Object.freeze({
  "price-list": "declared in PRODUCT_KINDS but read and written by no product code, so nothing user-scoped is known to live under it; prices are platform data in the price-list registry, and the archive carries the lists its own usage rows name as priceLists",
  "method-trial": "an evaluation identity's time-limited instruction to mount named methods in one project's next launches, expired on read; it steers this deployment's runtime and means nothing outside it, and the methods it names are exported under method",
  "extension-generation": "which prepared package and skill generation a project's runtime was built from and which one is live; the platform derives it from the installations, defaults and skills that are themselves exported, and it is runtime authority an archive must never carry",
  "extension-proof": "qualification the platform measures for itself; an archive carrying one would offer a compatibility claim no import may accept, and no product code writes this kind today",
  "source-change": "what was published about a work after it was published (a retraction, a correction, a new version), one record per source identifier, owned by the platform publisher account and never by a customer; it holds only public bibliographic facts and which tenant asked is never written to it, so there is nothing of the account's in it to carry",
  "programme-decision": "the platform's own evidence programme's decision of one day (the counts it read, the zones it chose, what became of each episode), owned by the platform publisher account in its internal evidence project and never by a customer; it holds counts and entity keys only, no reader is named in it, and the publisher account cannot be exported at all, so there is nothing of an account's in it to carry",
  "extension-resource": "the platform's own operation records: public-document grants and accepted-actor bindings signed with a deployment secret, and the journals of skill copies and adoptions; the documents and skills they refer to are workspace files and skill records, which are exported",
});

/** Every document kind the archive carries.
 * @returns {string[]} */
export function accountExportDocumentKinds() { return [...customerKinds]; }

const queries = [
  ["evidenceZones", "SELECT * FROM evimed_frontier.evidence_zones WHERE user_id=$1 ORDER BY id"],
  ["evidenceCards", "SELECT * FROM evimed_frontier.evidence_cards WHERE user_id=$1 ORDER BY id"],
  ["evidenceCardRevisions", "SELECT r.* FROM evimed_frontier.evidence_card_revisions r JOIN evimed_frontier.evidence_cards c ON c.id=r.card_id WHERE c.user_id=$1 ORDER BY r.card_id,r.revision"],
  ["evidenceAutomation", "SELECT a.* FROM evimed_frontier.evidence_automation a JOIN evimed_frontier.evidence_zones z ON z.id=a.zone_id WHERE z.user_id=$1 ORDER BY a.zone_id"],
  ["evidenceZoneFollows", "SELECT * FROM evimed_frontier.evidence_zone_follows WHERE user_id=$1 ORDER BY zone_id"],
  ["evidenceComments", "SELECT * FROM evimed_frontier.evidence_comments WHERE user_id=$1 ORDER BY id"],
  ["evidenceReviews", "SELECT * FROM evimed_frontier.evidence_reviews WHERE user_id=$1 ORDER BY card_id"],
  ["evidenceZoneFeedback", "SELECT * FROM evimed_frontier.evidence_zone_feedback WHERE user_id=$1 ORDER BY id"],
  ["evidenceChallenges", "SELECT * FROM evimed_frontier.evidence_challenges WHERE user_id=$1 ORDER BY id"],
  // The public topic requests the account filed or seconded (flywheel F08): the title it asked for and when. The request itself belongs to no one.
  ["evidenceTopicRequestVotes", "SELECT v.request_id,r.title,v.created_at FROM evimed_frontier.evidence_topic_request_votes v JOIN evimed_frontier.evidence_topic_requests r ON r.id=v.request_id WHERE v.user_id=$1 ORDER BY v.created_at,v.request_id"],
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
  // `purpose` says what each call was for; an `engine` row is a specialist
  // job's own model spend, which no cap counts and the job's price covers.
  ["usage", `SELECT id,project_id AS "projectId",run_id AS "runId",purpose,model,price_version AS "priceVersion",currency,status,
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
 * `documents` kinds have had a guard since the first export. Nothing did the
 * same for tables, so a new user-scoped table —
 * `evimed_product.feedback_events` was one — could be added and simply not
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
  "evimed_memory.records": "carried by the archive as memory/memory.json, written from the store's own exportUserMemory so that the evidence and revision history travel in the shape the product reads them in",
  "evimed_memory.settings": "carried by the archive as memory/memory.json, beside the records: the researcher's own pause switches, read through the same store",
  "evimed_memory.sessions": "the capsule a conversation is trying, for conversations that live in this deployment's runtime; it means nothing outside it, and the capsule itself is exported",
  "evimed_memory.record_conflicts": "carried by the archive as memory/memory.json under `links`, beside the records they relate: which statements disagree, and whether it was settled",
  "evimed_memory.record_sources": "carried by the archive as memory/memory.json under `links`, beside the records: the sources each memory rests on, by recorded identifier, with what a later check found",
  "evimed_memory.record_usage": "how often each memory was recalled: derived from the records that are themselves exported, rebuilt by use, and meaningless in another deployment",
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

/** The named keys a stored object holds, and nothing else it holds.
 * @param {any} value @param {readonly string[]} keys @returns {Record<string, any>} */
function pick(value, keys) {
  /** @type {Record<string, any>} */
  const picked = {};
  if (value && typeof value === "object") for (const key of keys) if (Object.hasOwn(value, key)) picked[key] = value[key];
  return picked;
}

/** @param {any} payload @param {string} recordType */
function recorded(payload, recordType) {
  if (payload?.recordType !== recordType) throw new Error(`Not a ${recordType} record.`);
}

/** Which conversation, run and call produced a result: the customer's own
 * identifiers, the same ones `researchSessions` and `usage` carry. */
const producerKeys = ["kind", "sessionId", "runId", "callId", "eventId", "parentSessionId", "branchId"];

/** What the archive carries of a result and of a document conversion.
 *
 * Where the bytes are. A result version records a file the way a source record
 * does: by its path in the project's workspace and its SHA-256 (`path`,
 * `digest`, `size`, beside a source's `paths` and `fingerprint`), and this
 * archive's copy of the project's workspace is where bytes travel. The record
 * therefore says what the file was and lets a reader check the file at that
 * path against it. It does not name `storagePath`, the platform's own
 * content-addressed copy under `.openscience/result-snapshots/`: the archive
 * does not carry that directory, so a version the workspace has since
 * overwritten leaves as a record whose bytes this archive does not hold. A
 * conversion's rendered files are in the same position — each format leaves
 * with its SHA-256 and size and without the store path the archive does not
 * carry — as are a calculation's outputs, which are workspace files named by
 * `path` and `sha256`. The export embeds no file of its own accord: the base64
 * route `personalSkillResources` takes exists for bytes outside the account's
 * data root and is bounded at 32 MiB, and one result snapshot may be 64 MiB.
 * What a record itself holds leaves with it, which for a delivered report
 * includes the text of the evidence matrix it was checked against
 * (`review.matrixText`), exactly as the result routes serve it.
 *
 * What stays behind. Another user's id (`requestedBy`, on a shared project a
 * collaborator's), queue and process bookkeeping (`jobId`, `execution`,
 * `attempt`, the retry and quota counters), and the digests that exist to make
 * a write idempotent (`fingerprint`, `changeKey`, `instructionDigest`,
 * `inputDigest`). Each projection names what it carries rather than what it
 * drops, so a field a result module adds later stays behind until someone
 * decides it is the customer's. One id is not hidden by this and is not meant
 * to be: a calculation's job id is the `result-replays/<job>/` directory its
 * files are written to in the workspace and the call its output version names
 * as producer, so it leaves in those two places and not as a queue pointer.
 *
 * What is as recorded rather than as served. A reference's `availability` is
 * the one captured with the result, not re-derived against today's sources:
 * the archive is the owner's across all their projects, and the per-project
 * re-authorization the result routes do answers a question it does not ask. A
 * calculation's or a conversion's `state` is the record's own: a failure the
 * worker recorded only on its queue job is not on the record, and the queue is
 * not exported.
 *
 * @type {Record<string, (payload: any) => any>} */
const payloadProjections = {
  // The shape the result routes serve, from the same domain projection.
  "result-version": payload => {
    recorded(payload, "result-version");
    const version = projectResultVersion(payload);
    return { recordType: "result-version", ...version, findings: version.findings.map((/** @type {any} */ finding) => ({ ...finding,
      sourceRefs: (Array.isArray(finding.sourceRefs) ? finding.sourceRefs : []).map((/** @type {any} */ reference) => projectResultInput({ kind: "source", ...reference })) })) };
  },
  // What was selected on which version, and what the researcher asked for.
  // `draft` stays behind: it is the composer text the platform built around
  // the selection, and `anchor` already carries the selection itself.
  "result-revision": payload => {
    recorded(payload, "result-revision");
    return { ...pick(payload, ["recordType", "id", "projectId", "versionId", "digest", "sessionId", "state", "stagedAt", "boundAt", "instruction", "inputPath"]),
      anchor: pick(payload.anchor, ["kind", "elementId", "elementKind", "selectedText", "matchMode", "page", "row", "column"]),
      // What the run left, from the domain's own closed projection; absent until the run ends.
      ...(payload.outcome ? { outcome: projectCorrectionOutcome(payload.outcome) } : {}) };
  },
  // Which source changed under which result, and whether research continued.
  "result-impact": payload => {
    recorded(payload, "result-impact");
    return { ...pick(payload, ["schemaVersion", "recordType", "versionId", "effect", "claimIds", "coverage", "historicalResultPreserved", "recomputed", "observedAt"]),
      source: pick(payload.source, ["id", "digest", "versionId", "doi", "contentDigest", "replacedBy"]),
      // What was found to rest on the source (N15): the calculations, memories and learned methods, as the closed record.
      ...(projectAffected(payload.affected) ? { affected: projectAffected(payload.affected) } : {}),
      sourceStatus: pick(payload.sourceStatus, ["state", "checkedAt", "reason", "updates"]),
      continuation: pick(payload.continuation, ["status", "reason", "agendaId", "episodeId", "requestedAt", "scheduledAt"]) };
  },
  // Two record types share this kind: the frozen recipe of an engine result,
  // and one request to calculate or recalculate.
  "result-replay": payload => {
    if (payload?.recordType === "result-replay-recipe") {
      return pick(payload, ["recordType", "projectId", "versionId", "inputVersionId", "recipe", "recipeDigest", "machineValues", "receipt", "capturedAt"]);
    }
    recorded(payload, "result-replay");
    return { ...pick(payload, ["recordType", "id", "projectId", "versionId", "state", "cleanup", "createdAt", "outputVersionId", "partial", "comparison"]),
      ...(payload.stopError ? { error: { code: String(payload.stopError) } } : {}),
      ...(Array.isArray(payload.artifacts) ? { artifacts: payload.artifacts.map((/** @type {any} */ file) => pick(file, ["path", "sha256", "bytes"])) } : {}),
      ...(payload.initial ? { initial: { ...pick(payload.initial, ["recipe", "inputVersionId"]), producer: pick(payload.initial.producer, producerKeys) } } : {}) };
  },
  // What was converted, from which revision of it, and what came out.
  "document-export": payload => ({
    ...pick(payload, ["projectId", "title", "sourceRevision", "rendererVersion", "state"]),
    source: pick(payload?.source, ["artifactId", "root", "workspace", "studyId", "exportId", "versionId", "digest"]),
    formats: Object.fromEntries(DOCUMENT_EXPORT_FORMATS.filter(format => Object.hasOwn(payload?.formats ?? {}, format))
      .map(format => [format, pick(payload.formats[format], ["state", "mime", "sha256", "bytes", "code"])])),
    findings: Array.isArray(payload?.findings) ? payload.findings.filter((/** @type {unknown} */ finding) => typeof finding === "string") : [],
  }),
};

/** One stored document or revision row, as the customer's own archive carries it.
 *
 * Null for a row of a projected kind that does not read as one: a result
 * record the product's own routes would not serve either. The caller leaves
 * it out and says so in `omissions`, because one unreadable record is not a
 * reason to withhold everything else the account holds.
 *
 * The refusals that remain are the ones made on purpose and held by tests: a
 * plugin document the registry cannot name, an extension row that fails its
 * own contract. Those are stored states nothing in the product wrote, where
 * carrying on would hand the customer a configuration the platform never
 * applied.
 *
 * @param {any} row @returns {any} */
export function exportDocumentRow(row) {
  if (Object.hasOwn(payloadProjections, row.kind)) {
    try { return { ...row, payload: payloadProjections[row.kind](row.payload) }; }
    catch { return null; }
  }
  if (EXTENSION_CUSTOMER_KINDS.includes(row.kind)) return exportExtensionAccountRow(row);
  if (row.kind === "source") return { ...row, payload: projectSourceManifestRecord(row).payload };
  const sourceDerived = projectSourceDerivedRecord(row);
  if (sourceDerived) return { ...row, payload: sourceDerived };
  if (row.kind !== "plugin") return row;
  return exportPluginDocumentRow(row);
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
 * @param {{maxRows?:number,maxBytes?:number,skillArtifacts?:any,report?:(line:string)=>void}} limits */
export async function withAccountExportSnapshot(database, user, config, operation, limits = {}) {
  // The platform's publishing account is nobody's to take a copy of (evidence-flywheel B2).
  assertNotPlatformAccount(user);
  if (!database) return operation(null);
  const report = limits.report ?? ((/** @type {string} */ line) => { process.stderr.write(line); });
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
  await migrateEvidenceZones(database);
  return database.transaction(async client => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const account = await client.query(`SELECT id,name,created_at::text AS "accountCreatedAt",created_at=$2::timestamptz AS "sameGeneration",
      transaction_timestamp() AS "snapshotAt" FROM evimed_control.users WHERE id=$1 FOR SHARE`, [user.id, user.accountCreatedAt]);
    const owner = account.rows[0];
    if (!owner?.sameGeneration) throw new HttpError(409, "account_export_account_changed", "The authenticated account generation changed before export.");
    // A persisted kind still needs an explicit export contract, and a kind
    // without one still never leaves as stored. What changed is what happens
    // to everything else the account holds: it is exported, and the kind that
    // was left out is named in the archive's own `omissions` with how many
    // documents it has. Which kinds exist is settled at test time
    // (`UNEXPORTED_DOCUMENT_KINDS`); what can still reach this query is a
    // database written by a release newer than the code reading it, and the
    // answer to that is the customer's data with the gap stated, not a 503
    // for all of it.
    const undecided = await client.query(`SELECT kind,count(*)::int AS documents FROM evimed_product.documents
      WHERE user_id=$1 AND NOT(kind=ANY($2::text[])) GROUP BY kind ORDER BY kind`, [user.id, [...customerKinds, ...Object.keys(UNEXPORTED_DOCUMENT_KINDS)]]);
    /** @type {{kind:string,reason:string,documents:number,revisions?:number}[]} */
    const omissions = undecided.rows.map((/** @type {any} */ row) => ({ kind: String(row.kind), reason: "no_export_contract", documents: Number(row.documents) }));
    /** @type {Map<string, {kind:string,reason:string,documents:number,revisions:number}>} */
    const unreadable = new Map();
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
      if (key === "documents" || key === "revisions") tables[key] = tables[key].flatMap((/** @type {any} */ row) => {
        const exported = exportDocumentRow(row);
        if (exported) return [exported];
        const entry = unreadable.get(row.kind) ?? { kind: String(row.kind), reason: "unreadable_record", documents: 0, revisions: 0 };
        if (key === "documents") entry.documents += 1; else entry.revisions += 1;
        unreadable.set(row.kind, entry);
        return [];
      });
    }
    omissions.push(...unreadable.values());
    // The archive says it; this line is so whoever runs the deployment hears
    // it too. Kinds and counts only: neither is the customer's data.
    for (const entry of omissions) {
      report(`account export left out ${entry.kind}: ${entry.reason}, ${entry.documents} documents${entry.revisions === undefined ? "" : `, ${entry.revisions} revisions`}\n`);
    }
    // `version` stays 1 with `priceLists`, `feedbackEvents` and `omissions`
    // added, and with new kinds among `documents`: v1 is an additive contract,
    // so a new top-level key, or a kind a reader does not know, is not a break
    // for a reader that keeps parsing what it knows, and a bump would tell
    // every archive holder their parser needs revisiting when it does not. It
    // moves when an existing key changes shape or leaves. `omissions` is
    // always present and empty when nothing was left out: a missing key would
    // read as nobody having looked. `feedbackEvents` is a query like any
    // other, so the row and byte pre-flight above already bounds it.
    // What bounds `priceLists`: the pre-flight count above never sees it —
    // `maxRows` counts database rows — but it holds at most one entry per
    // distinct price version among usage rows already counted there, and the
    // assembled buffer is measured against `maxBytes` below, which refuses the
    // export rather than shipping an over-budget archive.
    const state = {
      version: 1, snapshotAt: owner.snapshotAt, account: { id: owner.id, name: owner.name, accountCreatedAt: owner.accountCreatedAt },
      projects: tables.projects, researchSessions: tables.researchSessions, documents: tables.documents, revisions: tables.revisions,
      inbox: { notifications: tables.notifications, preferences: tables.notificationPreferences[0] ?? null }, usage: tables.usage,
      priceLists: exportedPriceLists(tables.usage), feedbackEvents: tables.feedbackEvents, omissions,
      evidenceCardRevisions:tables.evidenceCardRevisions,evidenceAutomation:tables.evidenceAutomation,evidenceZones:tables.evidenceZones,evidenceCards:tables.evidenceCards,evidenceZoneFollows:tables.evidenceZoneFollows,
      evidenceComments:tables.evidenceComments,evidenceReviews:tables.evidenceReviews,evidenceZoneFeedback:tables.evidenceZoneFeedback,evidenceChallenges:tables.evidenceChallenges,evidenceTopicRequestVotes:tables.evidenceTopicRequestVotes,
    };
    const skillResources = await exportPersonalSkillResources({ artifacts: limits.skillArtifacts, user,
      rows: [...tables.documents, ...tables.revisions], maxBytes: Math.min(32 * 1024 * 1024, maxBytes) });
    if (skillResources.resources.length) state.personalSkillResources = skillResources.resources;
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
