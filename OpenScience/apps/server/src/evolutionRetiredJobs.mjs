import { migrateProductStore } from './productPersistence.mjs';
import { maintenanceAllowsClaims } from './maintenanceService.mjs';

// Retained row identities are evidence, never runnable campaign inputs. Only experimental kinds: a self-check (a published tool on a
// researcher's dataset), a maintain job (a retirement's completion, the metrics-only month) and a digest are serving, run by the serving
// worker, and a cancelled row would keep the idempotency key a serving path enqueues again (`productJobs.enqueue` returns the existing row).
export const RETIRED_EVOLUTION_JOBS = Object.freeze(['evolution-scout', 'evolution-build', 'evolution-evaluate',
  'evolution-plan', 'evolution-mission', 'evolution-mission-heavy', 'evolution-meta', 'evolution-research', 'evolution-audit']);

/** Cutover quarantines queued/expired work only. A live old worker must first be drained.
 * No artifact, document, cost, payload or attempt identity is erased. The update is admitted as a claim is: refused during maintenance
 * (`maintenanceAllowsClaims`) and by the caller's own admission, in the same transaction.
 * @param {any} database @param {string} owner @param {{admission?: ((client: any) => Promise<boolean> | boolean) | null}} [options] */
export async function quarantineRetiredEvolutionJobs(database, owner, { admission = null } = {}) {
  await migrateProductStore(database);
  return database.transaction(async (/** @type {any} */ client) => {
    if (!(await maintenanceAllowsClaims(client))) return 0;
    if (admission && !(await admission(client))) return 0;
    const result = await client.query(`UPDATE evimed_product.jobs SET status='canceled',
      result=coalesce(result,'{}'::jsonb)||jsonb_build_object('rsiCutover',jsonb_build_object(
        'priorStatus',status,'priorError',error,'reason','evolution_offline_only')),
      error=jsonb_build_object('code','evolution_offline_only','message','Retired experimental work retained for offline migration.'),
      lease_token=NULL,lease_expires_at=NULL,finished_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE user_id=$1 AND kind=ANY($2::text[])
      AND (status='queued' OR (status='running' AND lease_expires_at<clock_timestamp()))`, [owner, RETIRED_EVOLUTION_JOBS]);
    return result.rowCount ?? 0;
  });
}
