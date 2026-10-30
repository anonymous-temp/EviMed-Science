import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@evimed/domain';
const digest=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');
/** Repository calibration inputs are preserved as fixtures, never relabelled as public papers. */
export async function readGeoCalibrationCases() {
 const data=JSON.parse(await readFile(new URL('../../../evals/geo-judge-cards/cases.json',import.meta.url),'utf8'));
 return data.cases.map(item=>({...item,competitors:[],careFlags:[],sourceQuotes:item.claims.map(claim=>claim.quote)}));
}
/** Only a trusted execution receipt can establish a repair's observed baseline failure. @param {any} payload */
export function evolutionFailureReproductionHash(payload){
  return digest(Object.fromEntries(Object.entries(payload).filter(([key])=>!['recordType','receiptHash'].includes(key))));
}
/** The kinds of module observation whose verdict is a deterministic check of the production pipeline on a public input (a frontier edit's numbers, units, links and
 * language, decided by code, never by a model), and so a failure the platform itself observed and could decide again: the basis of a receipt written by code from the
 * observation (`basis: 'platform-observation'`) when no public development case fails on the baseline. A model-judged observation is not among them. */
export const EVOLUTION_OBSERVED_FAILURE_KINDS = Object.freeze(['edit-verification']);
/** @param {any} payload @param {any} identity */
export function validEvolutionFailureReproduction(payload,identity){
  if(payload?.basis!==undefined&&!(payload.basis==='executed-baseline'||payload.basis==='platform-observation'&&EVOLUTION_OBSERVED_FAILURE_KINDS.includes(payload.observationKind)&&Array.isArray(payload.observationIds)&&payload.observationIds.length>0))return false;
  return payload?.recordType==='evolution-failure-reproduction'&&payload.missionId===identity.missionId&&payload.moduleId===identity.moduleId&&payload.baselineHash===digest(identity.baseline??{})&&['public','generated'].includes(payload.scope)&&payload.independent===true&&payload.executed===true&&payload.baselineFailed===true&&payload.referenceVerified===true&&typeof payload.taskId==='string'&&typeof payload.sourceRoot==='string'&&/^[a-f0-9]{64}$/.test(payload.sourceHash??'')&&/^[a-f0-9]{64}$/.test(payload.executionReceiptHash??'')&&payload.receiptHash===evolutionFailureReproductionHash(payload);
}
