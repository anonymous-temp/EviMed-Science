import {createHash} from 'node:crypto';
import {canonicalJson} from '@evimed/domain';
/** Explicit trusted-evaluator fixture; production publishers always receive the real sealed receipt. */
export function publishConfirmed(supply,candidate,options){
 const artifactDigest=`sha256:${createHash('sha256').update(canonicalJson(candidate.files??{})).digest('hex')}`;
 return supply.publish(candidate,{...options,evaluation:{...options.evaluation,evaluationReceiptHash:'a'.repeat(64),confirmatory:true,candidateFreeze:{artifactDigest,frozenAt:'2026-10-01T00:00:00Z'}}});
}
