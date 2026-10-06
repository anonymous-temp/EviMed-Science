import {createHash} from 'node:crypto';
import {createEvolutionDevelopmentValidation} from './evolutionDevelopmentValidation.mjs';
/** Exact pinned parent is run twice on the same independently specified public reference cases before repair.
 * @param {{service:any,supply:any,controller:any}} deps */
export function createEvolutionRepairReproduction({service,supply,controller}){
 return async ({card,contract,signal})=>{
  const pin=card.repairOf,parent=pin?.toolId?await service.get(pin.toolId):null;
  if(!contract?.cases?.length||!parent||parent.payload.artifactDigest!==pin.artifactDigest||!card.parentToolIds?.includes(parent.id))return {ready:false,reason:'no-reproduced-public-failure'};
  const id=`evolution-repair-reproduction-${createHash('sha256').update(JSON.stringify([card.id,pin,parent.payload.revision,contract])).digest('hex')}`;
  const known=await service.get(id);if(known && known.payload.results?.every(result=>result.executions?.length===contract.cases.length))return known.payload;
  const frozen=await supply.candidateForEvaluation({id:parent.id,digest:pin.artifactDigest,revision:parent.payload.revision});
  const validator=createEvolutionDevelopmentValidation({controller}),results=[];
  for(let repeat=0;repeat<2;repeat++)results.push(await validator.validate(frozen.candidate??frozen,{contract,signal}));
  const failed=contract.cases.filter(item=>results.every(result=>result.executions?.some(execution=>execution.caseId===item.id&&execution.executed===true&&execution.passed===false))).map(item=>item.id);
  const receipt={ready:failed.length>0,reason:failed.length?'public-failure-reproduced':'no-reproduced-public-failure',toolId:parent.id,artifactDigest:pin.artifactDigest,revision:parent.payload.revision,failedCaseIds:failed,results,at:service.now().toISOString()};
  const receiptHash=createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
  await service.save('repair-reproduction',id,{...receipt,receiptHash});return {...receipt,receiptHash};
 };
}
