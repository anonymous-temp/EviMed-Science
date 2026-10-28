import { HttpError } from './security.mjs';

/** Hold the admission locks only while the external connection is open. The
 * control-plane transaction ends before publishing, so a pool of one is safe.
 * PostgreSQL releases transaction locks on crash or disconnect.
 * @param {any} database @param {string} userId @param {()=>Promise<any>} operation */
export async function withResearchDbCapacity(database, userId, operation) {
  return database.transaction(async client => {
    const user = await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired', [`research-db-user:${userId}`]);
    if (!user.rows[0]?.acquired) throw new HttpError(429, 'research_db_busy', 'A database snapshot is already running.');
    let acquired = false;
    for (let slot = 0; slot < 4; slot += 1) {
      const result = await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired', [`research-db-slot:${slot}`]);
      if (result.rows[0]?.acquired) { acquired = true; break; }
    }
    if (!acquired) throw new HttpError(429, 'research_db_busy', 'Database snapshot capacity is currently in use.');
    return operation();
  });
}
