#!/usr/bin/env node
/**
 * Move research memory out of the retired usememos database and into the
 * control-plane schema `evimed_memory`.
 *
 *   node scripts/ops/migrate-research-memory.mjs --source same [--source-schema public]
 *   node scripts/ops/migrate-research-memory.mjs --source postgres://... [--source-schema public]
 *   node scripts/ops/migrate-research-memory.mjs --source sqlite:/path/to/memos_prod.db
 *   ... [--target postgres://...] [--dry-run] [--purge-source]
 *
 * In production the source and the target are the same PostgreSQL database:
 * memos ran with `MEMOS_DRIVER: postgres` against a DSN identical to the
 * control plane's, so its tables sit in the `public` schema of the same
 * database. `--source same` is therefore the production form — it reads the
 * memos tables through the target connection, so the operator never types a
 * credentialed DSN into a command line, where it would sit in `ps`, in
 * `/proc/<pid>/cmdline` and in shell history for the length of the run. An
 * explicit `postgres://` source stays for the cross-host case. Local
 * development ran memos on SQLite, hence the third driver.
 *
 * Ownership is the whole of the work. The retired service gave every EviMed
 * user one namespace (`evimed-science-<24 hex>`) for records, a digest of the
 * user id. This inverts it against the account list, and anything it cannot
 * attribute is counted and left where it is — a memory handed to the wrong
 * account is worse than a memory not carried over.
 *
 * The free-text notes half is gone (2026-09-20). `evimed_memory.notes` was
 * dropped with the composer that was its only writer, so there is nowhere left
 * to carry a memo to; `--purge-source` therefore leaves the retired `memo`
 * table alone rather than deleting rows nothing read.
 *
 * Output is counts. It never prints memory content, a note, a quote, a key or a
 * connection string.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { ControlPlaneDatabase } from "../../apps/server/src/controlPlaneDatabase.mjs";
import {
  MEMORY_EVIDENCE_LIMIT,
  MEMORY_KINDS,
  MEMORY_ORIGINS,
  MEMORY_REVISION_LIMIT,
  MEMORY_SCOPES,
  MEMORY_STATUSES,
  boundedScore,
  evidenceFingerprint,
  memoryInstant,
  validateRecordInput,
} from "../../apps/server/src/researchMemory.mjs";
import { migrateResearchMemory } from "../../apps/server/src/researchMemoryPersistence.mjs";

// `pg` belongs to the server package, not to the workspace root, so it is
// resolved from there rather than from this script's own directory — the same
// dependency the control plane connects with, not a second copy.
const serverRequire = createRequire(new URL("../../apps/server/src/", import.meta.url));
const pg = serverRequire("pg");

const identifierPattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const memoryIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
/** The fields a record's validation can name. A refusal is reported by field,
 *  never by the text that was refused. */
const recordFields = Object.freeze(["memory", "scope", "scopeId", "kind", "key", "value", "summary",
  "origin", "status", "lastConfirmedAt", "expiresAt"]);

/** @param {string[]} argv */
function parseArguments(argv) {
  const options = { source: "", sourceSchema: "public", target: "", dryRun: false, purgeSource: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--purge-source") options.purgeSource = true;
    else if (["--source", "--source-schema", "--target"].includes(argument)) {
      if (!value || value.startsWith("--")) throw new Error(`${argument} needs a value`);
      if (argument === "--source") options.source = value;
      if (argument === "--source-schema") options.sourceSchema = value;
      if (argument === "--target") options.target = value;
      index += 1;
    } else throw new Error(`unknown argument ${argument}`);
  }
  if (!options.source) throw new Error("give --source same, --source postgres://... or --source sqlite:<path>");
  if (!identifierPattern.test(options.sourceSchema)) throw new Error("--source-schema must be a plain identifier");
  if (options.purgeSource && options.dryRun) throw new Error("--purge-source and --dry-run ask for opposite things");
  if (options.purgeSource && options.source !== "same") {
    throw new Error("--purge-source empties tables in the target database, so it needs --source same");
  }
  return options;
}

/** The two digests the retired service derived a user's identity from.
 *  @param {string} userId */
function userDigests(userId) {
  return {
    namespace: `evimed-science-${createHash("sha256").update(`evimed/memory-record/user/v1:${userId}`).digest("hex").slice(0, 24)}`,
  };
}

/** @param {string} prefix @param {unknown} value @param {readonly string[]} allowed */
function enumName(prefix, value, allowed) {
  const raw = String(value ?? "");
  const name = (raw.startsWith(prefix) ? raw.slice(prefix.length) : raw).toLowerCase();
  return allowed.includes(name) ? name : null;
}

/** Unix seconds, which protojson hands back as a string because they are int64.
 *  @param {unknown} value */
function unixInstant(value) {
  if (value == null || value === "") return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return null;
  return memoryInstant(new Date(seconds * 1_000));
}

/** The protojson object a payload column holds, or null when the row has none
 *  and nothing can be read from it. PostgreSQL hands back a parsed jsonb;
 *  SQLite hands back the text.
 *  @param {unknown} payload @returns {Record<string, any>|null} */
function parsePayload(payload) {
  if (payload == null) return null;
  if (typeof payload === "object") return Array.isArray(payload) ? null : /** @type {any} */ (payload);
  try {
    const parsed = JSON.parse(String(payload));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

/**
 * The evidence and revision history, from protojson to the shape the store
 * keeps. Order and fingerprints are preserved: a quote imported today and the
 * same quote re-observed tomorrow must dedupe against each other, which they do
 * only if the digest travels unchanged.
 * @param {unknown} payload
 */
function convertPayload(payload) {
  const parsed = parsePayload(payload) ?? {};
  const evidence = (Array.isArray(parsed.evidence) ? parsed.evidence : []).map((item) => {
    const sourceType = String(item?.sourceType ?? "").trim();
    const sourceRef = String(item?.sourceRef ?? "").trim();
    const quote = String(item?.quote ?? "").trim();
    return {
      sourceType,
      sourceRef,
      quote,
      observedAt: unixInstant(item?.observedTs),
      weight: boundedScore(item?.weight ?? 0),
      fingerprint: String(item?.fingerprint ?? "") || evidenceFingerprint({ sourceType, sourceRef, quote }),
    };
  }).slice(-MEMORY_EVIDENCE_LIMIT);
  const revisions = (Array.isArray(parsed.revisions) ? parsed.revisions : []).map((item) => ({
    version: Number(item?.version ?? 0) || 0,
    value: String(item?.value ?? ""),
    summary: String(item?.summary ?? ""),
    status: enumName("MEMORY_STATUS_", item?.status, MEMORY_STATUSES) ?? "archived",
    changedAt: unixInstant(item?.changedTs),
    reason: String(item?.reason ?? ""),
  })).slice(-MEMORY_REVISION_LIMIT);
  return { evidence, revisions };
}

/** A counter that reports what happened without reporting what it happened to. */
function tally() {
  return { total: 0, imported: 0, alreadyPresent: 0, unmapped: 0, quarantined: 0, reasons: {} };
}

/** @param {ReturnType<typeof tally>} counts @param {string} outcome @param {string} reason */
function count(counts, outcome, reason = "") {
  counts[outcome] += 1;
  if (reason) counts.reasons[reason] = (counts.reasons[reason] ?? 0) + 1;
}

/** @param {{source: string, sourceSchema: string}} options @param {any} database */
async function readSource({ source, sourceSchema: schema }, database) {
  const recordColumns = "uid, namespace, scope_type, scope_id, kind, memory_key, value, summary, origin, status,"
    + " confidence, importance, sensitive, version, created_ts, updated_ts, last_confirmed_ts, expires_ts, payload";
  const recordQuery = `SELECT ${recordColumns} FROM "${schema}".memory_record ORDER BY id`;
  if (source === "same") {
    // The production form: the memos tables sit in another schema of the target
    // database, so they are read through the connection already open.
    return { driver: "postgres", records: (await database.query(recordQuery)).rows };
  }
  if (source.startsWith("sqlite:")) {
    // Loaded only on the path that needs it: `node:sqlite` is newer than this
    // package's engine floor, and the production import is the PostgreSQL one.
    const { DatabaseSync } = await import("node:sqlite");
    const file = path.resolve(source.slice("sqlite:".length));
    const sqlite = new DatabaseSync(file, { readOnly: true });
    try {
      return { driver: "sqlite", records: sqlite.prepare(`SELECT ${recordColumns} FROM memory_record ORDER BY id`).all() };
    } finally { sqlite.close(); }
  }
  const pool = new pg.Pool({ connectionString: source, max: 2, application_name: "evimed-research-memory-import" });
  try {
    return { driver: "postgres", records: (await pool.query(recordQuery)).rows };
  } finally { await pool.end(); }
}

/** @param {any} database @param {boolean} dryRun @param {Map<string,string>} owners @param {any[]} rows */
async function importRecords(database, dryRun, owners, rows) {
  const counts = tally();
  for (const row of rows) {
    counts.total += 1;
    const userId = owners.get(String(row.namespace ?? ""));
    if (!userId) { count(counts, "unmapped", "unknown_namespace"); continue; }
    const id = String(row.uid ?? "");
    if (!memoryIdPattern.test(id)) { count(counts, "quarantined", "invalid_id"); continue; }
    let next;
    try {
      next = validateRecordInput({
        scope: enumName("MEMORY_SCOPE_", row.scope_type, MEMORY_SCOPES),
        scopeId: row.scope_id,
        kind: enumName("MEMORY_KIND_", row.kind, MEMORY_KINDS),
        key: row.memory_key,
        value: row.value,
        summary: row.summary,
        origin: enumName("MEMORY_ORIGIN_", row.origin, MEMORY_ORIGINS),
        status: enumName("MEMORY_STATUS_", row.status, MEMORY_STATUSES),
        confidence: row.confidence,
        importance: row.importance,
        sensitive: Boolean(row.sensitive),
        lastConfirmedAt: unixInstant(row.last_confirmed_ts),
        expiresAt: unixInstant(row.expires_ts),
      });
    } catch (error) {
      const field = String(error?.message ?? "").split(" ")[0];
      count(counts, "quarantined", recordFields.includes(field) ? `invalid_${field}` : "invalid_record");
      continue;
    }
    const { evidence, revisions } = convertPayload(row.payload);
    const createdAt = unixInstant(row.created_ts);
    const updatedAt = unixInstant(row.updated_ts);
    if (!createdAt || !updatedAt) { count(counts, "quarantined", "invalid_timestamps"); continue; }
    const version = Math.max(1, Number(row.version) || 1);
    if (dryRun) {
      // The two ways a row can already be there are not the same news. The same
      // id is this memory, carried over by an earlier run. The same canonical
      // key under a different id is a *different* memory holding the place,
      // and this one would not be carried over at all.
      const same = await database.query("SELECT 1 FROM evimed_memory.records WHERE user_id=$1 AND id=$2",
        [userId, id]);
      if (same.rowCount) { count(counts, "alreadyPresent"); continue; }
      const taken = await database.query(`SELECT 1 FROM evimed_memory.records
        WHERE user_id=$1 AND scope=$2 AND scope_id=$3 AND kind=$4 AND key=$5 LIMIT 1`,
      [userId, next.scope, next.scopeId, next.kind, next.key]);
      if (taken.rowCount) count(counts, "quarantined", "canonical_key_taken");
      else count(counts, "imported");
      continue;
    }
    // Anything already there wins: a rerun after an interrupted import must add
    // what is missing and touch nothing else. The conflict target is the id,
    // not "any constraint": a row whose canonical key is held by a *different*
    // memory has not been carried over, and counting that as already present
    // would report the migration complete while one memory stayed behind. It
    // raises 23505 instead and is quarantined with a reason, which is the only
    // way anyone finds out.
    const inserted = await database.query(`INSERT INTO evimed_memory.records
      (user_id,id,scope,scope_id,kind,key,value,summary,origin,status,confidence,importance,sensitive,
       evidence,revisions,version,created_at,updated_at,last_confirmed_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17,$18,$19,$20)
      ON CONFLICT (user_id,id) DO NOTHING`,
    [userId, id, next.scope, next.scopeId, next.kind, next.key, next.value, next.summary, next.origin, next.status,
      next.confidence, next.importance, next.sensitive, JSON.stringify(evidence), JSON.stringify(revisions),
      version, createdAt, updatedAt, next.lastConfirmedAt, next.expiresAt])
      .catch((/** @type {any} */ error) => {
        if (error?.code === "23505") return null;
        throw error;
      });
    if (!inserted) { count(counts, "quarantined", "canonical_key_taken"); continue; }
    count(counts, inserted.rowCount ? "imported" : "alreadyPresent");
  }
  return counts;
}

/** @param {any} database @param {boolean} dryRun @param {Map<string,string>} owners @param {any[]} rows */
/**
 * Empty the retired service's tables, once their contents are demonstrably carried over.
 *
 * Until this runs, every note and every record exists twice in one database and
 * only one of the two copies can be forgotten. The retired tables key ownership
 * by that service's own user ids and reference nothing in `evimed_control`, so
 * neither "forget this memory" nor the cascade that deletes an account reaches
 * them. A cutover that stops at the import leaves memory behind that a deleted
 * account cannot take with it.
 *
 * The guard is the import's own tally: a row that could not be attributed to an
 * account, or that the new schema refused, was not carried over, and emptying
 * the table would destroy it rather than de-duplicate it.
 *
 * Rows, not tables. `memo_share` holds the only foreign key into `memo`, with
 * ON DELETE CASCADE, so a delete takes its dependants with it where a DROP
 * would be refused by that same constraint. What is left is an empty retired
 * schema, which the deployment's own database tooling can remove whenever the
 * release is accepted.
 *
 * @param {any} database @param {string} schema
 * @param {ReturnType<typeof tally>} records
 */
async function purgeSource(database, schema, records) {
  const stranded = records.unmapped + records.quarantined;
  if (stranded > 0) {
    throw new Error(`refusing to empty the retired table: ${stranded} rows were not carried over`);
  }
  /** @type {Record<string, number>} */
  const purged = {};
  // `memo` is deliberately not emptied: its destination table is gone, so
  // nothing carried those rows over and deleting them would be a deletion with
  // no import behind it.
  for (const table of ["memory_record"]) {
    const result = await database.query(`DELETE FROM "${schema}"."${table}"`);
    purged[table] = Number(result.rowCount ?? 0);
  }
  return purged;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  let targetUrl = options.target;
  if (!targetUrl) {
    // The same place the server reads it from, so the default target of an
    // import is the database the deployment actually runs on.
    const { loadConfig } = await import("../../apps/server/src/config.mjs");
    const config = loadConfig();
    if (config.databaseUrlError) throw new Error(`the control-plane database secret is unavailable: ${config.databaseUrlError}`);
    targetUrl = config.databaseUrl;
    if (!targetUrl) throw new Error("no target database is configured; pass --target postgres://...");
  }
  const database = new ControlPlaneDatabase({
    databaseUrl: targetUrl, databasePoolMax: 4, databaseConnectionTimeoutMs: 10_000,
  });
  try {
    await migrateResearchMemory(database);
    const users = (await database.query("SELECT id FROM evimed_control.users")).rows.map((row) => String(row.id));
    /** namespace -> user id. */
    const namespaceOwners = new Map();
    for (const userId of users) namespaceOwners.set(userDigests(userId).namespace, userId);
    const source = await readSource(options, database);
    const records = await importRecords(database, options.dryRun, namespaceOwners, source.records);
    const purged = options.purgeSource ? await purgeSource(database, options.sourceSchema, records) : null;
    process.stdout.write(`${JSON.stringify({
      ok: true, dryRun: options.dryRun, driver: source.driver, accounts: users.length, records,
      ...(purged ? { purged } : {}),
    })}\n`);
  } finally { await database.close(); }
}

main().catch((error) => {
  process.stderr.write(`research_memory_import_failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
