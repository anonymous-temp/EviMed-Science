#!/usr/bin/env node
/**
 * Move research memory out of the retired usememos database and into the
 * control-plane schema `evimed_memory`.
 *
 *   node scripts/ops/migrate-research-memory.mjs --source postgres://... [--source-schema public]
 *   node scripts/ops/migrate-research-memory.mjs --source sqlite:/path/to/memos_prod.db
 *   ... [--target postgres://...] [--dry-run]
 *
 * In production the source and the target are the same PostgreSQL database:
 * memos ran with `MEMOS_DRIVER: postgres` against a DSN identical to the
 * control plane's, so its tables sit in the `public` schema of the same
 * database. Local development ran memos on SQLite, hence the second driver.
 *
 * Ownership is the whole of the work. The retired service gave every EviMed
 * user one namespace (`evimed-science-<24 hex>`) for records and one hidden tag
 * (`#evimed-user-<24 hex>`) inside note text; both are digests of the user id,
 * with different salts. This inverts them against the account list, and
 * anything it cannot attribute is counted and left where it is — a memory
 * handed to the wrong account is worse than a memory not carried over.
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
  MEMORY_NOTE_CONTENT_LIMIT,
  MEMORY_ORIGINS,
  MEMORY_REVISION_LIMIT,
  MEMORY_SCOPES,
  MEMORY_STATUSES,
  boundedScore,
  evidenceFingerprint,
  extractTags,
  memoryInstant,
  normalizeNoteContent,
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
const internalTag = /#evimed-user-([a-f0-9]{24})/g;
const internalTagLine = /^#evimed-user-[a-f0-9]{24}$/;
/** The fields a record's validation can name. A refusal is reported by field,
 *  never by the text that was refused. */
const recordFields = Object.freeze(["memory", "scope", "scopeId", "kind", "key", "value", "summary",
  "origin", "status", "lastConfirmedAt", "expiresAt"]);

/** @param {string[]} argv */
function parseArguments(argv) {
  const options = { source: "", sourceSchema: "public", target: "", dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--dry-run") options.dryRun = true;
    else if (["--source", "--source-schema", "--target"].includes(argument)) {
      if (!value || value.startsWith("--")) throw new Error(`${argument} needs a value`);
      if (argument === "--source") options.source = value;
      if (argument === "--source-schema") options.sourceSchema = value;
      if (argument === "--target") options.target = value;
      index += 1;
    } else throw new Error(`unknown argument ${argument}`);
  }
  if (!options.source) throw new Error("give --source postgres://... or --source sqlite:<path>");
  if (!identifierPattern.test(options.sourceSchema)) throw new Error("--source-schema must be a plain identifier");
  return options;
}

/** The two digests the retired service derived a user's identity from.
 *  @param {string} userId */
function userDigests(userId) {
  return {
    namespace: `evimed-science-${createHash("sha256").update(`evimed/memory-record/user/v1:${userId}`).digest("hex").slice(0, 24)}`,
    tag: createHash("sha256").update(`evimed/memos/user/v1:${userId}`).digest("hex").slice(0, 24),
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

/** @param {unknown} payload */
function parsePayload(payload) {
  if (payload == null) return {};
  if (typeof payload === "object") return payload;
  try { return JSON.parse(String(payload)); } catch { return {}; }
}

/**
 * The evidence and revision history, from protojson to the shape the store
 * keeps. Order and fingerprints are preserved: a quote imported today and the
 * same quote re-observed tomorrow must dedupe against each other, which they do
 * only if the digest travels unchanged.
 * @param {unknown} payload
 */
function convertPayload(payload) {
  const parsed = parsePayload(payload);
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

/** @param {string} source @param {string} schema */
async function readSource(source, schema) {
  const recordColumns = "uid, namespace, scope_type, scope_id, kind, memory_key, value, summary, origin, status,"
    + " confidence, importance, sensitive, version, created_ts, updated_ts, last_confirmed_ts, expires_ts, payload";
  const memoColumns = "uid, created_ts, updated_ts, row_status, content, pinned";
  if (source.startsWith("sqlite:")) {
    // Loaded only on the path that needs it: `node:sqlite` is newer than this
    // package's engine floor, and the production import is the PostgreSQL one.
    const { DatabaseSync } = await import("node:sqlite");
    const file = path.resolve(source.slice("sqlite:".length));
    const database = new DatabaseSync(file, { readOnly: true });
    try {
      return {
        driver: "sqlite",
        records: database.prepare(`SELECT ${recordColumns} FROM memory_record ORDER BY id`).all(),
        memos: database.prepare(`SELECT ${memoColumns} FROM memo ORDER BY id`).all(),
      };
    } finally { database.close(); }
  }
  const pool = new pg.Pool({ connectionString: source, max: 2, application_name: "evimed-research-memory-import" });
  try {
    return {
      driver: "postgres",
      records: (await pool.query(`SELECT ${recordColumns} FROM "${schema}".memory_record ORDER BY id`)).rows,
      memos: (await pool.query(`SELECT ${memoColumns} FROM "${schema}".memo ORDER BY id`)).rows,
    };
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
      const existing = await database.query(`SELECT 1 FROM evimed_memory.records
        WHERE user_id=$1 AND (id=$2 OR (scope=$3 AND scope_id=$4 AND kind=$5 AND key=$6)) LIMIT 1`,
      [userId, id, next.scope, next.scopeId, next.kind, next.key]);
      count(counts, existing.rowCount ? "alreadyPresent" : "imported");
      continue;
    }
    // Anything already there wins: a rerun after an interrupted import must add
    // what is missing and touch nothing else.
    const inserted = await database.query(`INSERT INTO evimed_memory.records
      (user_id,id,scope,scope_id,kind,key,value,summary,origin,status,confidence,importance,sensitive,
       evidence,revisions,version,created_at,updated_at,last_confirmed_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17,$18,$19,$20)
      ON CONFLICT DO NOTHING`,
    [userId, id, next.scope, next.scopeId, next.kind, next.key, next.value, next.summary, next.origin, next.status,
      next.confidence, next.importance, next.sensitive, JSON.stringify(evidence), JSON.stringify(revisions),
      version, createdAt, updatedAt, next.lastConfirmedAt, next.expiresAt]);
    count(counts, inserted.rowCount ? "imported" : "alreadyPresent");
  }
  return counts;
}

/** @param {any} database @param {boolean} dryRun @param {Map<string,string>} owners @param {any[]} rows */
async function importNotes(database, dryRun, owners, rows) {
  const counts = tally();
  for (const row of rows) {
    counts.total += 1;
    const raw = String(row.content ?? "");
    // The owner comes only from the tag line the retired client appended. A tag
    // sitting inline is a tag anybody could have typed: user ids are usernames
    // and OIDC ids, so any account could compute another's digest, and a note
    // carrying it appeared in that account's list, export and recall. Two
    // distinct digests means exactly that, and such a note is not imported.
    const digests = new Set([...raw.matchAll(internalTag)].map((match) => match[1]));
    if (digests.size === 0) { count(counts, "unmapped", "no_owner_tag"); continue; }
    if (digests.size > 1) { count(counts, "quarantined", "multiple_owner_tags"); continue; }
    const trailing = raw.split("\n").map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
    if (!internalTagLine.test(trailing)) { count(counts, "quarantined", "owner_tag_not_trailing"); continue; }
    const userId = owners.get(trailing.slice("#evimed-user-".length));
    if (!userId) { count(counts, "unmapped", "unknown_owner"); continue; }
    const id = String(row.uid ?? "");
    if (!memoryIdPattern.test(id)) { count(counts, "quarantined", "invalid_id"); continue; }
    const content = normalizeNoteContent(raw);
    if (!content || content.length > MEMORY_NOTE_CONTENT_LIMIT) {
      count(counts, "quarantined", "unstorable_content");
      continue;
    }
    const createdAt = unixInstant(row.created_ts);
    const updatedAt = unixInstant(row.updated_ts);
    if (!createdAt || !updatedAt) { count(counts, "quarantined", "invalid_timestamps"); continue; }
    const state = String(row.row_status ?? "") === "ARCHIVED" ? "archived" : "normal";
    const values = [userId, id, content, state, Boolean(row.pinned), extractTags(content), createdAt, updatedAt];
    if (dryRun) {
      const existing = await database.query("SELECT 1 FROM evimed_memory.notes WHERE user_id=$1 AND id=$2", [userId, id]);
      count(counts, existing.rowCount ? "alreadyPresent" : "imported");
      continue;
    }
    const inserted = await database.query(`INSERT INTO evimed_memory.notes
      (user_id,id,content,state,pinned,tags,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6::text[],$7,$8) ON CONFLICT DO NOTHING`, values);
    count(counts, inserted.rowCount ? "imported" : "alreadyPresent");
  }
  return counts;
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
    /** namespace -> user id, and tag digest -> user id. */
    const namespaceOwners = new Map();
    const tagOwners = new Map();
    for (const userId of users) {
      const digests = userDigests(userId);
      namespaceOwners.set(digests.namespace, userId);
      tagOwners.set(digests.tag, userId);
    }
    const source = await readSource(options.source, options.sourceSchema);
    const records = await importRecords(database, options.dryRun, namespaceOwners, source.records);
    const notes = await importNotes(database, options.dryRun, tagOwners, source.memos);
    process.stdout.write(`${JSON.stringify({
      ok: true, dryRun: options.dryRun, driver: source.driver, accounts: users.length, records, notes,
    })}\n`);
  } finally { await database.close(); }
}

main().catch((error) => {
  process.stderr.write(`research_memory_import_failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
