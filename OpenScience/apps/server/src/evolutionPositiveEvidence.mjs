import { scientificOutcomes } from '@evimed/domain';
/** Reads owner-scoped persisted N14 method feedback and the result receipt it names.
 * Callbacks must read authoritative stores, never request bodies or run-written assertions.
 * @param {{loadMethod:(run:any,use:any)=>Promise<any>,loadResult:(run:any,id:string)=>Promise<any>,hasCorrection:(run:any,id:string)=>Promise<boolean>}} dependencies */
export function createEvolutionPositiveEvidence({loadMethod,loadResult,hasCorrection}) {
 return async function resolvePositiveEvidence(run,use) {
  if(!run?.id||!use?.toolId||use.invoked!==true)return null;
  const method=await loadMethod(run,use);const payload=method?.payload??method;
  if(!payload?.contentDigest||use.contentDigest!==payload.contentDigest)return null;
  for(const outcome of scientificOutcomes(payload.scientific,payload.contentDigest)){
   if(outcome.polarity!=='supports')continue;
   const entry=payload.scientific.entries.find(item=>item.id===outcome.entryId);
   if(entry?.signal!=='replay_agreed'||!entry.replay?.id)continue;
   const result=await loadResult(run,outcome.versionId);
   if(result?.producer?.runId!==run.id||result.digest!==entry.result.digest||result.coverage?.producer!=='bound'||!result.method||!result.machineValues?.length)continue;
   if(await hasCorrection(run,outcome.versionId))continue;
   return {kind:'verified-uncorrected-result',verified:true,resultId:outcome.versionId,evidenceId:entry.id,replayId:entry.replay.id,contentDigest:payload.contentDigest,at:outcome.at};
  }
  return null;
 };
}
