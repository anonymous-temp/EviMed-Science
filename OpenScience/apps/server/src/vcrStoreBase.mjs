/**
 * The store base every 「虚拟临研」 package shares: one connection discipline,
 * one id shape, one audit write, one version counter.
 *
 * Hidden knowledge:
 *
 * - **One statement timeout for the module** (the frontier's rule, kept by
 *   GEO): a read is one statement inside its own short transaction, so a page
 *   that cannot answer is refused rather than held. The engine's own work does
 *   not run here — it runs in `vcr-engine` — so nothing legitimate in this
 *   schema takes seconds.
 * - **Ids carry their kind** (`std_`, `asm_`, `job_` …). A study id in a job
 *   row is then a mistake anyone can see in a log, and the lineage node
 *   `assumption:asm_x@3` reads without a lookup.
 * - **Every write that changes what a reader would see writes an audit row**,
 *   in the same transaction. An audit that can be skipped is one that is, and
 *   this is the record a sponsor's computerized-system validation reads
 *   (plan §11.3).
 * - **Versions are allocated inside the transaction that writes the row**, by
 *   `MAX(version) + 1` under the row lock, not by a counter a caller keeps:
 *   two dispatches racing to save 「假设卡 v4」 would otherwise both write v4
 *   and the unique index would fail the slower one after its work.
 *
 * @module vcrStoreBase
 */

import { randomUUID } from "node:crypto";

import { VCR_SCHEMA, migrateVcr } from "./vcrPersistence.mjs";

/** The module's statement timeout: a page read never holds a connection. */
export const VCR_STATEMENT_TIMEOUT_MS = 5_000;

/** Id prefixes by object kind. */
export const VCR_ID_PREFIXES = Object.freeze({
  study: "std", definition: "def", protocol: "prt", criterion: "crt", soa: "soa",
  precedent: "pre", evidence: "evd", assumption: "asm",
  source: "src", grant: "grt", snapshot: "snp", fieldMap: "fmp", analysisTable: "atb",
  population: "pop", patientSet: "pts", comparator: "cmp", scenario: "scn", grid: "grd",
  model: "mdl", method: "mth",
  job: "job", execution: "exe", result: "res", forecast: "fct",
  assessment: "mas", judgment: "jdg", referral: "ref", event: "rev", site: "ste", episode: "fup",
  review: "rvw", decision: "dec", contact: "reg", export: "exp",
});

/**
 * A new id: `<prefix>_<22 chars of a uuid>`. Short enough to read in a log,
 * wide enough that two processes never collide.
 * @param {keyof typeof VCR_ID_PREFIXES} kind
 */
export function vcrId(kind) {
  const prefix = VCR_ID_PREFIXES[kind];
  if (!prefix) throw new TypeError(`vcrId: unknown object kind ${JSON.stringify(kind)}`);
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 22)}`;
}

/** Table names this module may address, checked before any splice. */
const TABLE = /^[a-z_]+$/;

/**
 * The shared store. Each package extends it with its own queries rather than
 * adding to one god object: they merge without touching each other's file.
 */
export class VcrStoreBase {
  /** @param {{ database: any, statementTimeoutMs?: number }} options */
  constructor({ database, statementTimeoutMs = VCR_STATEMENT_TIMEOUT_MS }) {
    if (!database) throw new TypeError("A VCR store needs the product database.");
    if (!Number.isSafeInteger(statementTimeoutMs) || statementTimeoutMs < 1) {
      throw new TypeError("The statement timeout is a positive whole number of ms.");
    }
    this.database = database;
    this.statementTimeoutMs = statementTimeoutMs;
    this.schema = VCR_SCHEMA;
  }

  ready() { return migrateVcr(this.database); }

  /**
   * One transaction with the module's own statement timeout.
   * @template T @param {(client: any) => Promise<T>} operation @returns {Promise<T>}
   */
  async transaction(operation) {
    await this.ready();
    return this.database.transaction(async (/** @type {any} */ client) => {
      await client.query(`SET LOCAL statement_timeout = ${this.statementTimeoutMs}`);
      return operation(client);
    });
  }

  /**
   * One statement under the module's statement timeout.
   * @param {string} sql @param {unknown[]} [values]
   */
  async query(sql, values = []) {
    return this.transaction((client) => client.query(sql, values));
  }

  /** @param {string} sql @param {unknown[]} [values] @returns {Promise<any[]>} */
  async rows(sql, values = []) {
    const result = await this.query(sql, values);
    return result?.rows ?? [];
  }

  /** @param {string} sql @param {unknown[]} [values] @returns {Promise<any | null>} */
  async one(sql, values = []) {
    const rows = await this.rows(sql, values);
    return rows[0] ?? null;
  }

  /**
   * The next version of a versioned row, allocated inside the caller's
   * transaction.
   * @param {any} client @param {string} table @param {string} whereSql @param {unknown[]} values
   */
  async nextVersion(client, table, whereSql, values) {
    if (!TABLE.test(table)) throw new TypeError(`nextVersion: bad table ${JSON.stringify(table)}`);
    const result = await client.query(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM ${VCR_SCHEMA}.${table} WHERE ${whereSql}`, values);
    return Number(result.rows[0]?.next ?? 1);
  }

  /**
   * Record what happened, in the caller's transaction when there is one.
   * @param {{ client?: any, studyId?: string | null, userId?: string | null, actor?: string,
   *   action: string, object?: string, outcome?: string, reason?: string, detail?: Record<string, unknown> }} entry
   */
  async audit(entry) {
    const sql = `INSERT INTO ${VCR_SCHEMA}.audit (study_id, user_id, actor, action, object, outcome, reason, detail)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`;
    const values = [
      entry.studyId ?? null, entry.userId ?? null, entry.actor ?? "", entry.action,
      entry.object ?? "", entry.outcome ?? "ok", entry.reason ?? "", JSON.stringify(entry.detail ?? {}),
    ];
    if (entry.client) return entry.client.query(sql, values);
    return this.query(sql, values);
  }
}

/**
 * Remove every row of a study, in the caller's transaction. Audit rows stay:
 * they outlive the object they describe, like the GEO ledger does.
 * @param {any} client @param {string} studyId
 */
export async function deleteVcrStudyRows(client, studyId) {
  const exists = await client.query(
    "SELECT 1 FROM information_schema.schemata WHERE schema_name = $1", [VCR_SCHEMA]);
  if (!exists.rowCount) return { deleted: false };
  await client.query(`UPDATE ${VCR_SCHEMA}.audit SET study_id = study_id WHERE study_id = $1`, [studyId]);
  await client.query(`DELETE FROM ${VCR_SCHEMA}.studies WHERE id = $1`, [studyId]);
  return { deleted: true };
}

/**
 * Remove the study that sits on one control-plane project, in the caller's
 * transaction. A project is deleted by its own page, and the study on it goes
 * with it: a study whose project is gone has no conversations, no files and no
 * memory, and would read as a study nobody can open.
 * @param {any} client @param {string} userId @param {string} projectId
 */
export async function deleteVcrProjectRows(client, userId, projectId) {
  const exists = await client.query(
    "SELECT 1 FROM information_schema.schemata WHERE schema_name = $1", [VCR_SCHEMA]);
  if (!exists.rowCount) return { deleted: false, studyId: null };
  const found = await client.query(
    `SELECT id FROM ${VCR_SCHEMA}.studies WHERE user_id = $1 AND project_id = $2`, [userId, projectId]);
  const studyId = found.rows[0]?.id ?? null;
  if (!studyId) return { deleted: false, studyId: null };
  await client.query(`DELETE FROM ${VCR_SCHEMA}.studies WHERE id = $1`, [studyId]);
  return { deleted: true, studyId };
}

/**
 * Remove every row of an account's studies, in the caller's transaction.
 * @param {any} client @param {string} userId
 */
export async function deleteVcrUserRows(client, userId) {
  const exists = await client.query(
    "SELECT 1 FROM information_schema.schemata WHERE schema_name = $1", [VCR_SCHEMA]);
  if (!exists.rowCount) return { deleted: false };
  await client.query(`DELETE FROM ${VCR_SCHEMA}.studies WHERE user_id = $1`, [userId]);
  await client.query(`DELETE FROM ${VCR_SCHEMA}.sources WHERE user_id = $1`, [userId]);
  await client.query(`DELETE FROM ${VCR_SCHEMA}.precedents WHERE user_id = $1`, [userId]);
  await client.query(`DELETE FROM ${VCR_SCHEMA}.models WHERE user_id = $1`, [userId]);
  return { deleted: true };
}
