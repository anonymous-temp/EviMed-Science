import { createHash } from 'node:crypto';
import { EVOLUTION_GAP_CODES, EVOLUTION_TRACKS } from '@evimed/domain';
const aliases = { method_missing: 'method-missing', implementation: 'method-implementation', skill_instruction: 'skill-instruction', model_capability: 'model-capability', outside_product: 'outside-product' };
const identity = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value) ? value : null;
/** Reduce actual scoring observations to public identities and closed operational codes. */
export function evaluationGapClusters(report) {
  const clusters = new Map();
  for (const unit of Array.isArray(report.units) ? report.units : []) {
    if (unit.benchmarkScope === 'missing-input-response' || unit.inputAvailable === false || unit.status === 'waiting' || unit.exposureTier === 'unknown') continue;
    const track = EVOLUTION_TRACKS.includes(unit.track) ? unit.track : null;
    if (!track) continue;
    const codes = new Set((Array.isArray(unit.gaps) ? unit.gaps : []).map(code => aliases[code] ?? code).filter(code => EVOLUTION_GAP_CODES.includes(code)));
    if (unit.unsupported === true) codes.add('method-missing');
    if (!codes.size && (unit.numericEvaluationPassed === false || unit.numericValid === false || (unit.stages?.calculation?.valid !== true && Object.values(unit.numeric ?? {}).some(value => value?.valid === false)))) codes.add('method-implementation');
    const stageCodes = { retrieval:'connector', extraction:'extraction', method:'method-missing', calculation:'method-implementation', writing:'writing' };
    for (const [stage, value] of Object.entries(unit.stages ?? {})) if (value?.observed === true && value.valid === false && stageCodes[stage]) codes.add(stageCodes[stage]);
    if (!codes.size && unit.allStagesValid === false && Object.values(unit.stages ?? {}).some(stage => stage?.observed === true && stage.valid === false)) codes.add('model-capability');
    for (const gapCode of codes) {
      const value = { track, gapCode, methodId: identity(unit.methodId ?? report.methodId ?? report.summary?.methodId), capabilityId: identity(unit.capabilityId), count: 0 };
      const key = JSON.stringify([track,gapCode,value.methodId,value.capabilityId]);
      const cluster = clusters.get(key) ?? value; cluster.count++; clusters.set(key,cluster);
    }
  }
  return [...clusters.values()];
}
/** Retry publication even when the evaluation document already exists. @param {any} service @param {any} evaluation */
export async function publishEvaluationGaps(service, evaluation) {
  for (const cluster of evaluationGapClusters(evaluation.payload)) {
    const digest = createHash('sha256').update(JSON.stringify([evaluation.id,cluster])).digest('hex');
    await service.ingestEvent({id:`evaluation-gap:${digest}`,type:'evaluation-gap',...cluster});
  }
  for (const [unitIndex,unit] of (evaluation.payload.units??[]).entries()) {
    const review=unit.disagreement;
    if (!['paper_error','reasonable_difference'].includes(review?.verdict) || review.codeVerified!==true || review.reviewerFamily!=='qwen' || !review.evidenceIds?.length || !/^[a-f0-9]{64}$/.test(review.verificationProof?.proofHash??'')) continue;
    await service.ingestEvent({id:`evaluation-adjudication:${evaluation.id}:${unitIndex}:${review.verificationProof.proofHash}`,type:'evaluation-adjudication',evaluationId:evaluation.id,unitIndex,proofHash:review.verificationProof.proofHash});
  }
  return evaluation;
}
/** @param {any} service @param {string} id @param {any} payload @param {any} [prior] */
export async function saveEvolutionEvaluation(service,id,payload,prior) {
  return publishEvaluationGaps(service, await service.save('evaluation',id,payload,prior));
}
