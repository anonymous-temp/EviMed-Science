/** Legacy pages retain their vocabulary while new judgments keep the core's independent
 * clinical label and recommendation. No threshold or clause aggregation re-judges them. */
import { projectMatchingResult } from '@evimed/patient-matching-core';
export const legacyMatchingVerdict = eligibility => eligibility === 'uncertain' || eligibility === 'not-assessed' ? 'insufficient' : eligibility;
export function nativeDecisionProjection(decision, taskId = 'saved-native-pair') {
  const pair = { subjectKey: decision.subjectKey, trialId: decision.trialId, ...(decision.armId ? { armId: decision.armId } : {}) };
  return projectMatchingResult({ task: { schemaVersion: '1', taskId, scope: decision.scope, direction: 'specified-pair', objective: 'Read the saved native matching decision.', pluginGeneration: 'saved-native', sources: decision.sourceRefs, selectedPairs: [pair], budgets: { maxPairs: 1, maxEvidenceReads: 0, maxModelCalls: 0 } },
    resultId: decision.decisionId, revision: decision.revision, decisions: [decision], profileDigest: decision.profileDigest, affectedPairs: undefined });
}
