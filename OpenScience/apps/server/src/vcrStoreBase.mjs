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
import { promises as fs } from "node:fs";
import path from "node:path";

import { removeStudyDirectory } from "./vcrDataPlane.mjs";
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
  modelAssessment: "mia", modelPlan: "mpv",
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
/** An account id as the control plane mints and accepts one (`security.mjs`): what `personNames` may ask for. */
const ACCOUNT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

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
   * The names of some accounts, from the control plane's own users table — the
   * join `reviews()` has always made, as one question for any number of people:
   * a person is shown by name and never by account id. An account that no longer
   * exists is simply absent from the answer (deleting an account removes its
   * row; what it did stays on the study), and the caller says so with
   * `personName`'s neutral label rather than with the id. Ids that are not
   * account-id shaped (a role grantee, the platform's own actor) are not asked.
   * @param {Iterable<unknown>} ids @returns {Promise<Map<string, string>>}
   */
  async personNames(ids) {
    const wanted = [...new Set([...ids].map((id) => String(id ?? "")).filter((id) => ACCOUNT_ID.test(id)))];
    if (!wanted.length) return new Map();
    const rows = await this.rows("SELECT id, name FROM evimed_control.users WHERE id = ANY($1::text[])", [wanted]);
    return new Map(rows.filter((row) => String(row.name ?? "").trim()).map((row) => [String(row.id), String(row.name).trim()]));
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
 * What a deletion leaves outside the database, collected before the rows go:
 * the data plane's files the study's snapshots and analysis tables name
 * (relative to the plane's root), and the engine's job directories.
 * @typedef {{ locations: string[], engineJobIds: string[], studyIds: string[] }} VcrArtifacts
 */

/** @returns {VcrArtifacts} */
const noArtifacts = () => ({ locations: [], engineJobIds: [], studyIds: [] });

/**
 * The files and engine jobs that belong to some studies (and, for an account,
 * the account's own sources), read in the deleting transaction so that what is
 * removed afterwards is exactly what the rows named — nothing is guessed from
 * a directory listing.
 * @param {any} client @param {readonly string[]} studyIds @param {string | null} [userId] the account, when its study-less sources go too
 * @returns {Promise<VcrArtifacts>}
 */
async function collectArtifacts(client, studyIds, userId = null) {
  if (!studyIds.length && !userId) return noArtifacts();
  const snapshots = await client.query(
    `SELECT location FROM ${VCR_SCHEMA}.snapshots
      WHERE study_id = ANY($1::text[]) OR ($2::text IS NOT NULL AND source_id IN (SELECT id FROM ${VCR_SCHEMA}.sources WHERE user_id = $2))`,
    [[...studyIds], userId]);
  const tables = await client.query(`SELECT location FROM ${VCR_SCHEMA}.analysis_tables WHERE study_id = ANY($1::text[])`, [[...studyIds]]);
  const jobs = await client.query(
    `SELECT COALESCE(NULLIF(checkpoint ->> 'engineJobId', ''), id) AS engine_job_id FROM ${VCR_SCHEMA}.jobs WHERE study_id = ANY($1::text[])`,
    [[...studyIds]]);
  const locations = [...snapshots.rows, ...tables.rows]
    // A snapshot of several files keeps one path per line.
    .flatMap((row) => String(row.location ?? "").split("\n"))
    .map((location) => location.trim())
    .filter(Boolean);
  return {
    locations: [...new Set(locations)],
    engineJobIds: [...new Set(jobs.rows.map((row) => String(row.engine_job_id)).filter(Boolean))],
    // A study's own directory holds what no row names: the pseudonym key, the
    // identity maps, unfrozen uploads, the resolved views and the patient
    // documents. It goes whole, or a deletion would leave patient-level files.
    studyIds: [...new Set(studyIds.map((id) => String(id)))],
  };
}

/**
 * Remove every row of a study, in the caller's transaction. Audit rows stay:
 * they outlive the object they describe, like the GEO ledger does. Answers
 * what the study left outside the database (`artifacts`); the caller removes
 * it with `removeVcrArtifacts` once the transaction has committed.
 * @param {any} client @param {string} studyId
 */
export async function deleteVcrStudyRows(client, studyId) {
  const exists = await client.query(
    "SELECT 1 FROM information_schema.schemata WHERE schema_name = $1", [VCR_SCHEMA]);
  if (!exists.rowCount) return { deleted: false, artifacts: noArtifacts() };
  const artifacts = await collectArtifacts(client, [studyId]);
  await client.query(`UPDATE ${VCR_SCHEMA}.audit SET study_id = study_id WHERE study_id = $1`, [studyId]);
  await client.query(`DELETE FROM ${VCR_SCHEMA}.studies WHERE id = $1`, [studyId]);
  return { deleted: true, artifacts };
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
  if (!exists.rowCount) return { deleted: false, studyId: null, artifacts: noArtifacts() };
  const found = await client.query(
    `SELECT id FROM ${VCR_SCHEMA}.studies WHERE user_id = $1 AND project_id = $2`, [userId, projectId]);
  const studyId = found.rows[0]?.id ?? null;
  if (!studyId) return { deleted: false, studyId: null, artifacts: noArtifacts() };
  const artifacts = await collectArtifacts(client, [studyId]);
  await client.query(`DELETE FROM ${VCR_SCHEMA}.studies WHERE id = $1`, [studyId]);
  return { deleted: true, studyId, artifacts };
}

/**
 * Remove every row of an account's studies, in the caller's transaction — and
 * every row that names the account in a study that is not its own: its
 * memberships and the grants made out to it. Those used to outlive the account
 * (review 2026-09-29, CS-43): a deleted account's roles stayed in every study
 * it had been invited to, and a grant naming it stayed live for whoever next
 * held the id. Audit rows stay.
 * @param {any} client @param {string} userId
 */
export async function deleteVcrUserRows(client, userId) {
  const exists = await client.query(
    "SELECT 1 FROM information_schema.schemata WHERE schema_name = $1", [VCR_SCHEMA]);
  if (!exists.rowCount) return { deleted: false, artifacts: noArtifacts() };
  const owned = await client.query(`SELECT id FROM ${VCR_SCHEMA}.studies WHERE user_id = $1`, [userId]);
  const artifacts = await collectArtifacts(client, owned.rows.map((row) => String(row.id)), userId);
  await client.query(`DELETE FROM ${VCR_SCHEMA}.studies WHERE user_id = $1`, [userId]);
  await client.query(`DELETE FROM ${VCR_SCHEMA}.members WHERE user_id = $1`, [userId]);
  await client.query(`DELETE FROM ${VCR_SCHEMA}.grants WHERE grantee = $1`, [userId]);
  await client.query(`DELETE FROM ${VCR_SCHEMA}.sources WHERE user_id = $1`, [userId]);
  await client.query(`DELETE FROM ${VCR_SCHEMA}.precedents WHERE user_id = $1`, [userId]);
  await client.query(`DELETE FROM ${VCR_SCHEMA}.models WHERE user_id = $1`, [userId]);
  return { deleted: true, artifacts };
}

/**
 * Remove `derived/<studyId>` — the same guards as the study directory: an id
 * that is an id, a real directory that is not a symlink, and one that resolves
 * to a direct child of `derived/`. Answers whether it removed anything.
 * @param {string} root @param {string} studyId
 */
async function removeDerivedDirectory(root, studyId) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(studyId ?? ""))) return false;
  const directory = path.join(root, "derived", studyId);
  const stat = await fs.lstat(directory).catch(() => null);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return false;
  const real = await fs.realpath(directory).catch(() => null);
  const realParent = await fs.realpath(path.join(root, "derived")).catch(() => null);
  if (!real || !realParent || path.dirname(real) !== realParent) return false;
  await fs.rm(directory, { recursive: true, force: true });
  return true;
}

/**
 * Remove what a committed deletion left outside the database: the data plane's
 * files, and the engine's job directories through its own `DELETE /jobs/:id`.
 * Best effort and never throwing — the rows are already gone, so a file that
 * cannot be removed is reported (`report(code)`) for an operator to sweep, not
 * raised as a failed deletion the researcher would retry into nothing. A
 * location that resolves outside the plane's root, or through a symlinked
 * directory, is refused by the same check the plane applies to a read.
 *
 * @param {{ dataPlaneDir?: string, artifacts?: VcrArtifacts | null, engineRemove?: ((jobId: string) => Promise<void>) | null,
 *   report?: (code: string) => void }} input
 * @returns {Promise<{ files: number, engineJobs: number, studyDirectories: number }>}
 */
export async function removeVcrArtifacts({ dataPlaneDir = "", artifacts = null, engineRemove = null, report = () => {} }) {
  let files = 0;
  let engineJobs = 0;
  const root = String(dataPlaneDir ?? "").trim() ? path.resolve(String(dataPlaneDir)) : "";
  if (root && artifacts?.locations.length) {
    const realRoot = await fs.realpath(root).catch(() => null);
    for (const location of artifacts.locations) {
      try {
        const target = path.resolve(root, location);
        if (!realRoot || path.isAbsolute(location) || (target !== root && !target.startsWith(`${root}${path.sep}`))) {
          report("vcr_artifact_outside_plane");
          continue;
        }
        const parent = await fs.realpath(path.dirname(target)).catch(() => null);
        if (!parent) continue;
        if (parent !== realRoot && !parent.startsWith(`${realRoot}${path.sep}`)) {
          report("vcr_artifact_outside_plane");
          continue;
        }
        await fs.rm(target, { force: true });
        files += 1;
        // Directories a study made are left empty: take the empty ones, up to the root.
        for (let directory = path.dirname(target); directory !== root && directory.startsWith(`${root}${path.sep}`); directory = path.dirname(directory)) {
          try { await fs.rmdir(directory); } catch { break; }
        }
      } catch {
        report("vcr_artifact_remove_failed");
      }
    }
  }
  let studyDirectories = 0;
  if (root) {
    for (const studyId of artifacts?.studyIds ?? []) {
      try {
        if ((await removeStudyDirectory(root, studyId)).removed) studyDirectories += 1;
        // The tables one job handed the next (a generated population, a
        // reconstruction's pseudo-patients) live under `derived/<study>/`.
        if (await removeDerivedDirectory(root, studyId)) studyDirectories += 1;
      } catch {
        report("vcr_artifact_remove_failed");
      }
    }
  }
  if (engineRemove) {
    for (const jobId of artifacts?.engineJobIds ?? []) {
      try { await engineRemove(jobId); engineJobs += 1; } catch { report("vcr_engine_job_remove_failed"); }
    }
  }
  return { files, engineJobs, studyDirectories };
}
