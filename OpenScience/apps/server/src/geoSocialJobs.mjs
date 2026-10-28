/**
 * The social collector's jobs that a person's project started and that a later call may read on.
 *
 * One row per accepted job (`evimed_geo.social_jobs`), written the moment the collector accepts it and before the first poll, keyed by
 * (user, control-plane project, job id). The collector's job id is the only handle on a paid-for result; this is what lets the model be
 * handed one when the deadline passes first, and what makes the id worthless to anyone else: a read looks the id up under the asking
 * user and project and finds nothing under another's, so `socialCrawlClient.job()` never asks the collector about it.
 *
 * Kept a day, then dropped by the next write. The row holds the request (query, platforms, sort, limit) because the collector echoes
 * the query and platform set and the client holds it to the same ones on every read; it holds no post.
 *
 * @module geoSocialJobs
 */

/** How long a job id stays readable. The collector's own retention of a finished job is not documented; a day is far past any wait. */
export const SOCIAL_JOB_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * @param {{ store: { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> }, now?: () => Date }} options
 *   `store` is the GEO store (every statement runs under its timeout, after the schema is migrated)
 * @returns {import("./socialCrawlClient.mjs").SocialJobLedger}
 */
export function createSocialJobLedger({ store, now = () => new Date() }) {
  if (!store || typeof store.query !== "function") throw new TypeError("The social job ledger needs the GEO store.");
  return {
    async record({ scope, jobId, query, platforms, sort, limit }) {
      const at = now();
      await store.query(
        `INSERT INTO evimed_geo.social_jobs (user_id, project_id, job_id, query, platforms, sort, result_limit, created_at)
         VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8) ON CONFLICT (user_id, project_id, job_id) DO NOTHING`,
        [scope.userId, scope.projectId, jobId, query, platforms, sort, limit, at],
      );
      // A repeat of the same search is the same job, so a record that exists is kept as it is; what has aged out goes here, by the index.
      await store.query(`DELETE FROM evimed_geo.social_jobs WHERE created_at < $1`, [new Date(at.getTime() - SOCIAL_JOB_RETENTION_MS)]);
    },
    async find(scope, jobId) {
      const found = await store.query(
        `SELECT job_id, query, platforms, sort, result_limit FROM evimed_geo.social_jobs
          WHERE user_id = $1 AND project_id = $2 AND job_id = $3 AND created_at > $4`,
        [scope.userId, scope.projectId, jobId, new Date(now().getTime() - SOCIAL_JOB_RETENTION_MS)],
      );
      const row = found.rows[0];
      return row ? { jobId: String(row.job_id), query: String(row.query), platforms: [...row.platforms].map(String), sort: String(row.sort), limit: Number(row.result_limit) } : null;
    },
  };
}
