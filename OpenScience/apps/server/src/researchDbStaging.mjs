import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpError, openScopedDirectoryNoFollow, resolveScopedPath, withProjectStorageMutation } from './security.mjs';

// The name `researchTableFileName` writes: the table's letters, digits, `_` and `-`, then the capture time in UTC.
const shape = /^knowledge-base\/\.evimed-revisions\/[a-f0-9]{64}\/[\p{L}\p{N}_-]{1,48}-\d{8}-\d{6}\.csv$/u;
const invalid = () => new HttpError(503, 'research_db_staging_unavailable', 'The database snapshot staging record is unavailable.');

/** Crash-recoverable markers for files which have not yet committed to the source ledger. */
export class ResearchDbStaging {
  /** @param {{database:any,store:any,report?:(code:string)=>void}} input */
  constructor({ database, store, report = () => {} }) { this.database = database; this.store = store; this.report = report; }
  async migrate() {
    await this.database.query(`CREATE TABLE IF NOT EXISTS evimed_control.research_db_staging (
      user_id text NOT NULL, project_id text NOT NULL, id uuid NOT NULL, path text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), last_attempt_at timestamptz,
      PRIMARY KEY (user_id, project_id, id), FOREIGN KEY (user_id,project_id) REFERENCES evimed_control.projects(user_id,id) ON DELETE CASCADE);
      ALTER TABLE evimed_control.research_db_staging ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz`);
  }
  /** The marker commits before any file bytes are written. @param {string} user @param {string} project @param {string} relative */
  async reserve(user, project, relative) {
    if (!shape.test(relative)) throw invalid();
    const id = randomUUID();
    await this.database.query('INSERT INTO evimed_control.research_db_staging(user_id,project_id,id,path) VALUES($1,$2,$3,$4)', [user, project, id, relative]);
    return id;
  }
  /** Acquire after the project row lock, and before writing the file. @param {string} user @param {string} project @param {string} id @param {string} relative */
  async lock(user, project, id, relative) {
    if (!shape.test(relative)) throw invalid();
    const found = await this.database.query('SELECT path FROM evimed_control.research_db_staging WHERE user_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE', [user, project, id]);
    if (found.rows.length !== 1 || found.rows[0].path !== relative) throw invalid();
  }
  /** Remove the marker in the same transaction which commits source and request receipt. @param {string} user @param {string} project @param {string} id */
  async complete(user, project, id) {
    const result = await this.database.query('DELETE FROM evimed_control.research_db_staging WHERE user_id=$1 AND project_id=$2 AND id=$3', [user, project, id]);
    if (result.rowCount !== 1) throw invalid();
  }
  /** Remove only validated names protected by the marker and project scope. @param {any} project @param {string} relative */
  async removeFiles(project, relative) {
    if (!shape.test(relative)) throw invalid();
    const target = resolveScopedPath(project.baseDir, relative);
    await withProjectStorageMutation(project, async () => {
      let parent;
      try {
        parent = await openScopedDirectoryNoFollow(project.baseDir, path.dirname(target));
        const basename = path.basename(target);
        for (const name of await fs.readdir(parent.path)) {
          if (name !== basename && !name.startsWith(`.${basename}.`)) continue;
          await fs.unlink(path.join(parent.path, name)).catch(error => { if (error?.code !== 'ENOENT') throw error; });
        }
      } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      finally { await parent?.handle.close(); }
    });
  }
  /** The age fence prevents claiming a marker before its writer has acquired its transaction lock.
   * @param {number} [ageMs] */
  async recover(ageMs = 120000) {
    if (!Number.isSafeInteger(ageMs) || ageMs < 0) throw invalid();
    const candidates = await this.database.query("SELECT user_id,project_id,id FROM evimed_control.research_db_staging WHERE created_at < clock_timestamp()-($1::bigint * interval '1 millisecond') ORDER BY COALESCE(last_attempt_at,created_at),created_at LIMIT 100 FOR UPDATE SKIP LOCKED", [ageMs]);
    for (const candidate of candidates.rows) {
      try {
        const user = await this.store.userById(candidate.user_id); if (!user) continue;
        const project = await this.store.requireProject(user, candidate.project_id);
        await this.database.transaction(async client => {
          const scope = await client.query('SELECT id FROM evimed_control.projects WHERE user_id=$1 AND id=$2 FOR SHARE', [candidate.user_id, candidate.project_id]);
          if (!scope.rows.length) return;
          const found = await client.query("SELECT path FROM evimed_control.research_db_staging WHERE user_id=$1 AND project_id=$2 AND id=$3 AND created_at < clock_timestamp()-($4::bigint * interval '1 millisecond') FOR UPDATE SKIP LOCKED", [candidate.user_id, candidate.project_id, candidate.id, ageMs]);
          if (!found.rows.length) return;
          const relative = found.rows[0].path;
          if (!shape.test(relative)) throw invalid();
          const referenced = await client.query(`SELECT 1 FROM evimed_product.documents d
            WHERE d.user_id=$1 AND d.project_id=$2 AND d.kind='source' AND (d.payload->'paths' ? $3 OR EXISTS (
              SELECT 1 FROM evimed_product.revisions r WHERE r.user_id=d.user_id AND r.kind=d.kind AND r.id=d.id AND r.payload->'paths' ? $3)) LIMIT 1`, [candidate.user_id, candidate.project_id, relative]);
          if (referenced.rows.length) {
            // The source ledger now owns these bytes. Keep the file and retire
            // the obsolete marker so it cannot starve later cleanup work.
            await client.query('DELETE FROM evimed_control.research_db_staging WHERE user_id=$1 AND project_id=$2 AND id=$3', [candidate.user_id, candidate.project_id, candidate.id]);
            this.report('research_db_staging_referenced'); return;
          }
          await this.removeFiles(project, relative);
          await client.query('DELETE FROM evimed_control.research_db_staging WHERE user_id=$1 AND project_id=$2 AND id=$3', [candidate.user_id, candidate.project_id, candidate.id]);
        });
      } catch {
        await this.database.query(`UPDATE evimed_control.research_db_staging SET last_attempt_at=clock_timestamp()
          WHERE user_id=$1 AND project_id=$2 AND id=$3 AND id IN (SELECT id FROM evimed_control.research_db_staging
            WHERE user_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE SKIP LOCKED)`, [candidate.user_id, candidate.project_id, candidate.id]).catch(() => {});
        this.report('research_db_staging_cleanup_failed');
      }
    }
  }
}
