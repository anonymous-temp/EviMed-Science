import { maintenanceAllowsClaims } from './maintenanceService.mjs';

/**
 * Serialized admission on this host, shared by leased render and compute jobs.
 * Build/restore use the existing maintenance lease. Physical work with unknown
 * termination holds capacity even after its logical lease expires.
 * @param {any} client @param {'render'|'compute'} kind @param {string | null} [resumingComputeId]
 */
export async function heavyWorkAdmission(client, kind, resumingComputeId = null) {
  const product = await client.query("SELECT to_regclass('evimed_product.jobs') AS relation");
  const hasProduct = Boolean(product.rows[0]?.relation);
  if (hasProduct && !(await maintenanceAllowsClaims(client))) return false;
  await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-host-heavy-work'))");
  if (hasProduct) {
    const extension = await client.query(`SELECT 1 FROM evimed_product.jobs WHERE kind IN ('extension-prepare','extension-execute')
      AND (status='running' OR payload->>'recoveryRequired'='true') LIMIT 1`);
    if (extension.rows.length) return false;
    const uncertain = await client.query(`SELECT 1 FROM evimed_product.documents d JOIN evimed_product.jobs j ON j.id=d.payload->>'jobId'
      WHERE d.kind='document-export' AND d.deleted_at IS NULL AND d.payload->'attempt' IS NOT NULL AND d.payload->'attempt' <> 'null'::jsonb
        AND (j.status IN ('failed','canceled') OR ($1::boolean AND j.status='queued')) LIMIT 1`, [kind === 'compute']);
    if (uncertain.rows.length) return false;
    const render = await client.query(`SELECT 1 FROM evimed_product.jobs WHERE kind='document-export' AND status='running'
      AND ($1::boolean OR lease_expires_at>clock_timestamp()) LIMIT 1`, [kind === 'compute']);
    if (render.rows.length) return false;
  }
  const exists = await client.query("SELECT to_regclass('evimed_vcr.jobs') AS relation");
  if (!exists.rows[0]?.relation) return true;
  const active = await client.query(`SELECT 1 FROM evimed_vcr.jobs WHERE ($1::boolean AND state='running')
    OR (state IN ('canceled','failed','queued') AND (checkpoint ? 'engineJobId' OR checkpoint ? 'submissionIntent' OR checkpoint ? 'requestedEngineJobId')
      AND COALESCE(checkpoint->>'engineStopped','false') <> 'true'
      AND NOT ($1::boolean=false AND state='queued' AND id=COALESCE($2::text,''))) LIMIT 1`, [kind === 'render', resumingComputeId]);
  return !active.rows.length;
}

/** Additional jobs not counted by maintenance's live ProductJobs lease query. @param {any} database */
export async function heavyWorkBlockerCount(database) {
  const render = await database.query(`SELECT count(*)::integer AS n FROM evimed_product.documents d
    JOIN evimed_product.jobs j ON j.id=d.payload->>'jobId' WHERE d.kind='document-export' AND d.deleted_at IS NULL
      AND ((j.status='running' AND (j.lease_expires_at IS NULL OR j.lease_expires_at<=clock_timestamp()))
        OR (j.status<>'running' AND d.payload->'attempt' IS NOT NULL AND d.payload->'attempt' <> 'null'::jsonb))`);
  let count = Number(render.rows[0]?.n ?? 0);
  const extension = await database.query(`SELECT count(*)::integer AS n FROM evimed_product.jobs
    WHERE kind IN ('extension-prepare','extension-execute') AND ((status='running'
      AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp())) OR payload->>'recoveryRequired'='true')`);
  count += Number(extension.rows[0]?.n ?? 0);
  const exists = await database.query("SELECT to_regclass('evimed_vcr.jobs') AS relation");
  if (exists.rows[0]?.relation) {
    const compute = await database.query(`SELECT count(*)::integer AS n FROM evimed_vcr.jobs WHERE state='running'
      OR (state IN ('canceled','failed','queued') AND (checkpoint ? 'engineJobId' OR checkpoint ? 'submissionIntent' OR checkpoint ? 'requestedEngineJobId') AND COALESCE(checkpoint->>'engineStopped','false') <> 'true')`);
    count += Number(compute.rows[0]?.n ?? 0);
  }
  return count;
}
