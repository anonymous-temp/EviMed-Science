import { migrateProductStore } from './productPersistence.mjs';

// Retained row identities are evidence, never runnable campaign inputs.
export const RETIRED_EVOLUTION_JOBS = Object.freeze(['evolution-scout', 'evolution-build', 'evolution-evaluate',
  'evolution-self-check', 'evolution-plan', 'evolution-mission', 'evolution-mission-heavy', 'evolution-meta',
  'evolution-research', 'evolution-audit', 'evolution-maintain', 'evolution-digest']);

/** Cutover quarantines queued/expired work only. A live old worker must first be drained.
 * No artifact, document, cost, payload or attempt identity is erased.
 * @param {any} database @param {string} owner */
export async function quarantineRetiredEvolutionJobs(database, owner) {
  await migrateProductStore(database);
  const result = await database.query(`UPDATE evimed_product.jobs SET status='canceled',
    result=coalesce(result,'{}'::jsonb)||jsonb_build_object('rsiCutover',jsonb_build_object(
      'priorStatus',status,'priorError',error,'reason','evolution_offline_only')),
    error=jsonb_build_object('code','evolution_offline_only','message','Retired experimental work retained for offline migration.'),
    lease_token=NULL,lease_expires_at=NULL,finished_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE user_id=$1 AND kind=ANY($2::text[])
    AND (status='queued' OR (status='running' AND lease_expires_at<clock_timestamp()))`, [owner, RETIRED_EVOLUTION_JOBS]);
  return result.rowCount ?? 0;
}
