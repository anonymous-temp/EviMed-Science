import { createHash } from 'node:crypto';
import { canonicalScenarioJson } from '@evimed/domain';

const ID = /^[A-Za-z0-9_-]{1,160}$/;
const HASH = /^[a-f0-9]{64}$/;
const VERSION = /^[A-Za-z0-9_.:-]{1,120}$/;

/** A content-free work identity. No patient text belongs in this structure.
 * A null expectedJudgmentId explicitly freezes the absence of a prior answer.
 * @param {any} input */
export function freezeVcrLanguageUnit(input) {
  const { studyId, userId, subjectKey, candidateTrialId, criterionKey, axis, recordHash, criterionHash,
    expectedJudgmentId, evaluatorVersion, promptVersion, model, thinking, outputLimit, documents } = input ?? {};
  if (![studyId, subjectKey, candidateTrialId].every(value => typeof value === 'string' && ID.test(value))
    || typeof userId !== 'string' || !userId || userId.length > 1024 || /[\0\r\n]/.test(userId)
    || typeof criterionKey !== 'string' || !VERSION.test(criterionKey) || !['requirement', 'applicability'].includes(axis)
    || typeof recordHash !== 'string' || !HASH.test(recordHash)
    || typeof criterionHash !== 'string' || !HASH.test(criterionHash)
    || !(expectedJudgmentId === null || typeof expectedJudgmentId === 'string' && ID.test(expectedJudgmentId))
    || ![evaluatorVersion, promptVersion, model].every(value => typeof value === 'string' && VERSION.test(value))
    || !['enabled', 'disabled'].includes(thinking) || !Number.isSafeInteger(outputLimit) || outputLimit < 1 || outputLimit > 65536
    || !Array.isArray(documents) || documents.length < 1 || documents.length > 200) throw new TypeError('Invalid frozen language unit.');
  const seen = new Set();
  const sources = documents.map(doc => {
    if (!doc || typeof doc.id !== 'string' || !ID.test(doc.id) || seen.has(doc.id) || typeof doc.sourceId !== 'string' || !ID.test(doc.sourceId)
      || typeof doc.sourceHash !== 'string' || !HASH.test(doc.sourceHash)
      || !(doc.projectionHash === null && doc.projectionId === null || typeof doc.projectionHash === 'string' && HASH.test(doc.projectionHash) && typeof doc.projectionId === 'string' && ID.test(doc.projectionId))) throw new TypeError('Invalid frozen source.');
    seen.add(doc.id);
    return { id: doc.id, sourceId: doc.sourceId, sourceHash: doc.sourceHash, projectionHash: doc.projectionHash, projectionId: doc.projectionId };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const payload = { schema: 1, studyId, userId, subjectKey, candidateTrialId, criterionKey, axis, recordHash, criterionHash,
    expectedJudgmentId, evaluatorVersion, promptVersion, model, thinking, outputLimit, documents: sources };
  return { payload, unitHash: createHash('sha256').update(canonicalScenarioJson(payload)).digest('hex') };
}
