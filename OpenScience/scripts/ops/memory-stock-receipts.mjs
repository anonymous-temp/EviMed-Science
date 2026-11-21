// Counts for a pre-existing inventory of identified stock objects. No engine calls or migrations.
// The inventory contains metadata only. A missing object is not itself a cleanup receipt.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { ControlPlaneDatabase } from '../../apps/server/src/controlPlaneDatabase.mjs';

const hash = /^[0-9a-f]{64}$/;

export function validateInventory(items) {
  if (!Array.isArray(items)) throw Error('expected an array of stock metadata');
  const keys = new Set();
  for (const item of items) {
    const fields = item?.kind === 'native' ? 'fingerprint,hash,kind,owner,uri' : 'hash,kind,owner,uri';
    if (!item || Object.keys(item).sort().join() !== fields || !['native','chunk'].includes(item.kind) ||
      typeof item.owner !== 'string' || !item.owner || typeof item.uri !== 'string' || !item.uri.startsWith('viking://') ||
      !hash.test(item.hash) || item.kind === 'native' && !hash.test(item.fingerprint)) throw Error('invalid stock metadata');
    const key = JSON.stringify([item.owner, item.uri, item.hash, item.fingerprint]);
    if (keys.has(key)) throw Error('duplicate stock object');
    keys.add(key);
  }
}

// Use only hashes and the address in the original inventory. In particular a general
// completed forget scan (or the same fingerprint in another account) proves nothing.
const native = `SELECT
  EXISTS(SELECT 1 FROM evimed_memory.native_files WHERE user_id=$1 AND uri=$2 AND content_hash=$3) AS same_file,
  EXISTS(SELECT 1 FROM evimed_memory.native_line_origins o JOIN evimed_memory.native_files f USING(user_id,uri)
    WHERE o.user_id=$1 AND o.uri=$2 AND o.fingerprint=$4) AS live_line,
  EXISTS(SELECT 1 FROM evimed_memory.history_forget_scans s
    JOIN evimed_memory.native_rejections r ON (r.user_id,r.memory_type,r.fingerprint)=(s.owner_id,s.memory_type,s.fingerprint)
    CROSS JOIN LATERAL jsonb_array_elements(s.memory_sweep->'files') entry
    JOIN evimed_memory.native_files f ON f.user_id=$1 AND f.uri=$2
    WHERE s.owner_id=$1 AND s.fingerprint=$4 AND r.origin IS DISTINCT FROM 'edit'
      AND s.state='complete' AND s.memory_sweep->>'done'='true' AND entry->>'uri'=$2 AND entry->>'hash'=$3
      AND entry->>'afterExactHash'<>$3 AND entry->>'afterExactHash'=f.content_hash) AS exact_sweep,
  EXISTS(SELECT 1 FROM evimed_memory.native_rejections r
    JOIN evimed_memory.history_forget_scans s ON (s.owner_id,s.memory_type,s.fingerprint)=(r.user_id,r.memory_type,r.fingerprint)
    JOIN LATERAL (SELECT change,actor,changed_at,undone_at FROM evimed_memory.native_revisions
      WHERE user_id=r.user_id AND uri=r.uri ORDER BY id DESC LIMIT 1) v ON true
    WHERE r.user_id=$1 AND r.uri=$2 AND r.fingerprint=$4 AND r.origin IS DISTINCT FROM 'edit'
      AND s.memory_sweep->'files' @> jsonb_build_array(jsonb_build_object('uri',$2::text,'hash',$3::text))
      AND v.undone_at IS NULL AND v.change='deleted' AND v.actor IN ('user','conversation') AND v.changed_at>=r.rejected_at
      AND NOT EXISTS(SELECT 1 FROM evimed_memory.native_files WHERE user_id=$1 AND uri=$2)) AS removed_file`;
const chunk = `SELECT state, cleaned_at IS NOT NULL AS cleaned FROM evimed_memory.history_chunks
  WHERE owner_id=$1 AND uri=$2 AND digest=$3`;

export async function stockCounts(client, items) {
  validateInventory(items);
  const counts = { cleaned: 0, unverified: 0, present: 0 };
  for (const item of items) {
    const params = [item.owner, item.uri, item.hash];
    let status = 'unverified';
    if (item.kind === 'native') {
      const { rows: [row] } = await client.query(native, [...params, item.fingerprint]);
      if (row.same_file || row.live_line) status = 'present';
      else if (row.exact_sweep || row.removed_file) status = 'cleaned';
    } else {
      const { rows: [row] } = await client.query(chunk, params);
      if (row?.state === 'ready') status = 'present';
      else if (row?.state === 'withdrawn' && row.cleaned) status = 'cleaned';
    }
    counts[status]++;
  }
  return { status: counts.present ? 'present' : !items.length || counts.unverified ? 'unverified' : 'cleaned', ...counts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Bypass ControlPlaneDatabase.query/transaction, which ordinarily migrate on first use.
  try {
    const items = process.argv[2] ? JSON.parse(await readFile(process.argv[2], 'utf8')) : [];
    validateInventory(items);
    if (!items.length) console.log(JSON.stringify(await stockCounts(null, items)));
    else {
      const database = new ControlPlaneDatabase({ databaseUrl: process.env.OPEN_SCIENCE_DATABASE_URL, databasePoolMax: 1, databaseConnectionTimeoutMs: 5000 });
      try {
        const counts = await database.withClient(async client => {
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          try { return await stockCounts(client, items); }
          finally { await client.query('ROLLBACK'); }
        });
        console.log(JSON.stringify(counts));
      } finally { await database.close(); }
    }
  } catch { console.error('Stock receipt check unavailable. Check the metadata inventory and read-only database access.'); process.exitCode = 1; }
}
