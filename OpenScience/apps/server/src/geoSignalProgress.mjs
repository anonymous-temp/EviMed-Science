import { AsyncLocalStorage } from 'node:async_hooks';
import { HttpError } from './security.mjs';

const leaseScope = new AsyncLocalStorage();
// Spreads retain the exact read receipt; serialization never turns it into product data.
const progressReceipt = Symbol('geoSignalProgress');
const superseded = () => new HttpError(409, 'geo_signal_progress_superseded', 'A newer signal discovery attempt owns this progress.');
export const geoSignalProgressSuperseded = error => error?.code === 'geo_signal_progress_superseded';
const copy = value => JSON.parse(JSON.stringify(value));

/** Only the actual acquiring loop can supply its authority; a later database owner is never adopted by an old callback. */
export async function withGeoSignalLease(database, lease, work) {
  const held = { ...lease, database, active: true };
  try { return await leaseScope.run(held, work); }
  finally { held.active = false; }
}
function withReceipt(store, project, key, row) {
  const detail = row?.detail ?? {};
  return { ...detail, [progressReceipt]: { database: store.database, geoId: project.id, userId: project.userId, key,
    exists: Boolean(row), attempts: row?.attempts ?? null, state: row?.state ?? null, detail: copy(detail) } };
}
export async function readGeoSignalProgress(store, project, key) {
  const row = (await store.query(`SELECT attempts,state,detail FROM evimed_geo.schedule_marks
    WHERE geo_project_id=$1 AND user_id=$2 AND key=$3`, [project.id,project.userId,key])).rows[0];
  return withReceipt(store,project,key,row);
}

/** A short owner-fenced CAS, not a transaction around round reads, immutable receipts or the worker's entire turn. */
export async function writeGeoSignalProgress(store, project, key, detail, state, now) {
  const expected = detail[progressReceipt], lease = leaseScope.getStore();
  if (!expected || expected.database !== store.database || expected.geoId !== project.id || expected.userId !== project.userId || expected.key !== key
    || lease && (!lease.active || lease.database !== store.database)) throw superseded();
  const active=()=>{if(lease&&(!lease.active||lease.database!==store.database))throw superseded();};
  const persisted = copy(detail);
  return store.transaction(async client => {
    active();
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '5s'");
    active();
    if (lease) {
      const held = await client.query(`SELECT key FROM evimed_geo.schedule_marks WHERE geo_project_id='_platform' AND user_id='_platform'
        AND key=$1 AND state='running' AND detail->>'owner'=$2 AND detail->>'token'=$3
        AND updated_at + make_interval(secs => $4) > clock_timestamp() FOR UPDATE`, [lease.key,lease.owner,lease.token,lease.seconds]);
      if (!held.rows.length) throw superseded();
      active();
    }
    const values = [project.id,key,project.userId,state,JSON.stringify(persisted),now.toISOString()];
    // The locked lease cannot be taken over between validation and this write. Its clock is checked again at the mutation.
    const fence = () => {
      const start = values.length;
      values.push(lease?.key ?? null,lease?.owner ?? null,lease?.token ?? null,lease?.seconds ?? 0);
      return `($${start+1}::text IS NULL OR EXISTS(SELECT 1 FROM evimed_geo.schedule_marks lease
        WHERE lease.geo_project_id='_platform' AND lease.user_id='_platform' AND lease.key=$${start+1}
          AND lease.state='running' AND lease.detail->>'owner'=$${start+2} AND lease.detail->>'token'=$${start+3}
          AND lease.updated_at + make_interval(secs => $${start+4}) > clock_timestamp()))`;
    };
    let result;
    if (!expected.exists) {
      const authority = fence();
      active();
      result = await client.query(`INSERT INTO evimed_geo.schedule_marks(geo_project_id,key,user_id,kind,state,detail,updated_at,attempts)
        SELECT $1,$2,$3,'notice',$4,$5::jsonb,$6::timestamptz,1 WHERE ${authority}
        ON CONFLICT(geo_project_id,key) DO NOTHING RETURNING attempts,state,detail`,values);
    } else {
      values.push(expected.attempts,expected.state,JSON.stringify(expected.detail));
      const authority = fence();
      active();
      result = await client.query(`UPDATE evimed_geo.schedule_marks SET state=$4,detail=$5::jsonb,updated_at=$6::timestamptz,attempts=attempts+1
        WHERE geo_project_id=$1 AND key=$2 AND user_id=$3 AND attempts=$7 AND state=$8 AND detail=$9::jsonb AND ${authority}
        RETURNING attempts,state,detail`,values);
    }
    active();
    if (!result.rows.length) throw superseded();
    return withReceipt(store,project,key,result.rows[0]);
  });
}
