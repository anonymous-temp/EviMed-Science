import { HttpError } from './security.mjs';

/** Normal native writes share this owner fence; source cleanup holds it exclusively and never waits on active owners. */
export async function withNativeMemoryWrite(database,userId,operation,{exclusive=false}={}) {
  if (!database) return operation();
  return database.transaction(async client=>{
    const mode=exclusive?'pg_try_advisory_xact_lock':'pg_try_advisory_xact_lock_shared';
    const lock=await client.query(`SELECT ${mode}(hashtextextended($1,0)) AS acquired`,[`native-memory-writer:${userId}`]);
    if(!lock.rows[0]?.acquired)throw new HttpError(409,'memory_source_cleanup_busy','Native memory is being updated. Retry shortly.');
    return database.withTransactionClient(client,operation);
  });
}
