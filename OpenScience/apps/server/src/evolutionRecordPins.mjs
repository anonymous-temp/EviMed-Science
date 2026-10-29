import { createHash } from 'node:crypto';
import { canonicalJson } from '@evimed/domain';

const TASK_OPERATIONAL_FIELDS = new Set(['recordType', 'addedAt', 'taskHash', 'definitionHash', 'feedbackCount', 'uses', 'pool',
  'reservedFor', 'exposedToDevelopment', 'retiredAuditQuarter', 'baselineKnownCorrect', 'evaluatorVersion', 'sourceAssetRef', 'sourceKind']);
/** Outcomes and owned evidence pointers can acquire bookkeeping; the task's scientific definition cannot change. */
export function evolutionTaskDefinitionHash(task) {
  return createHash('sha256').update(canonicalJson(Object.fromEntries(Object.entries(task).filter(([key]) => !TASK_OPERATIONAL_FIELDS.has(key))))).digest('hex');
}

/** A pin names the product revision actually observed, before later accounting writes. */
export function evolutionRecordPin(row) {
  if (typeof row?.id !== 'string' || !row.id || !Number.isSafeInteger(row.revision) || row.revision < 1 || !row.payload) {
    throw new Error('An evolution evidence pin needs an existing product revision.');
  }
  return { id: row.id, revision: row.revision, payloadHash: createHash('sha256').update(canonicalJson(row.payload)).digest('hex') };
}
