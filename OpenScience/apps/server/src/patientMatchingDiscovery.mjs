/** Discovery composes source-specific retrieval, a separate vector generation and typed reranking into one saved order. */
import {fuseCandidates,validatePermutation} from '@evimed/patient-matching-worker';
import {profileIdentity,composeRanking,trialRecordText,RANKING_POLICY} from '@evimed/patient-matching-core';
import {maskIdentifiers} from '@evimed/domain';
import {patientMatchingRankingDocument,MATCHING_RANKING_VIEW} from './patientMatchingRankingText.mjs';
const result=(status,data)=>({status,summary:'Candidate discovery completed with recorded coverage and order.',data,artifacts:[]});
/**
 * TrialLink ranking (policy `triallink-2`, chosen on the development patients 2026-11-08): lexical registry recall over the condition and its ranked
 * terms, the plugin's dense index, fused; Qwen3.7 reranks the fused list and Jev reads each candidate's whole record twice in one request (a five-level fit and a five-level graded reading);
 * the saved order is the weighted reciprocal-rank fusion of the rerank, the fit and the graded reading's expected gain. `depth` bounds every stage (at most 500, the reranker's request bound).
 * @param {{vcr:any,models:any,index?:any,jevEnabled?:boolean,depth?:number,jevDepth?:number,assertCurrent?:(envelope:any)=>Promise<any>}} dependencies
 */
export function createPatientMatchingDiscovery({vcr,models,index=null,jevEnabled=true,depth=300,jevDepth=depth,assertCurrent=async()=>{}}){
  const stageDepth=Math.min(500,Math.max(20,Math.trunc(Number(depth)||300))),scoredDepth=Math.min(stageDepth,Math.max(0,Math.trunc(Number(jevDepth)||0)));
  return async({scope,origin,study,meta,input,patient})=>{
    const limit=Math.min(100,Math.max(1,input.limit??20));
    if(meta.protocolVersionId){const roster=[...new Map((await vcr.documents.roster(study)).map(row=>[row.subjectKey,row])).values()];const rows=roster.slice(0,limit).map(row=>({subjectKey:row.subjectKey,label:row.subjectLabel??row.subjectKey}));return result('complete',{protocolVersionId:meta.protocolVersionId,people:rows,available:roster.length,returned:rows.length,more:roster.length>rows.length});}
    const query=String(input.query??'').trim();
    if(!query||[...query].length>200)return {status:'unsupported',summary:'Use a focused condition query of1to200characters. The preserved patient context is read separately from this task.',data:{code:'patient_matching_discovery_query_limit',maxQueryCharacters:200},artifacts:[]};
    const subjectKey=meta.contextSubjectKey??meta.selectedPairs[0]?.subjectKey??null;
    const terms=[...new Set((Array.isArray(input.terms)?input.terms:[]).map(term=>String(term??'').trim()).filter(term=>term&&[...term].length<=200))].slice(0,32);
    const filter={condition:query,...(terms.length?{terms}:{}),...(subjectKey?{subjectKey}:{}),limit:stageDepth,...(meta.collection?{collection:meta.collection}:{} )};
    const incoming=await vcr.service.runtimeRead(study,'candidates',filter,{ownerView:true,listMax:stageDepth});
    const candidates=new Map((incoming.candidates??[]).map(row=>[row.registryId,row]));
    const objective=(query+'\n'+(patient?.passages??[]).map(passage=>passage.text).join('\n')).slice(0,8000);
    const envelope={scope,origin,signal:origin.signal,input:{taskId:meta.taskId,query:objective,limit:stageDepth,patientSources:patient?.sources??[]}};
    await assertCurrent(envelope);
    const dense=index?await index.query(envelope).catch(()=>({status:'unsupported',data:{code:'patient_matching_index_query_failed'}})):null;
    const denseIds=(dense?.data?.candidates??[]).map(row=>row.registryId);
    const exact=[...new Set(input.trialIds??[])];
    const collection=meta.collection??incoming.collection?.id,collectionRevision=meta.collectionRevision??incoming.collection?.revision;
    const registryIds=[...new Set([...candidates.keys(),...exact,...denseIds])].slice(0,stageDepth*2),sourceFailures=[];
    if(!collection&&typeof vcr.service.prefetchRegistryRecords==='function')await vcr.service.prefetchRegistryRecords(registryIds.filter(id=>/^NCT\d{8}$/.test(id))).catch(()=>null);
    let nextRecord=0;
    await Promise.all(Array.from({length:Math.min(4,registryIds.length)},async()=>{
      for(;;){const at=nextRecord++;if(at>=registryIds.length)break;const registryId=registryIds[at];
        const registry=/^ChiCTR/i.test(registryId)?'chictr':/^NCT\d{8}$/.test(registryId)?'clinicaltrials.gov':'ctis';
        const found=await vcr.service.runtimeRead(study,'trial_registry_record',{registry,registryId,...(collection?{collection,collectionRevision}:{})},{ownerView:true}).catch(()=>null);
        if(found?.available!==false&&found?.record)candidates.set(registryId,{...candidates.get(registryId),...found.record,registryId,registry,eligibility:found.record.eligibilityText??''});
        else sourceFailures.push(registryId);
      }
    }));
    const channels=[{ids:[...new Set((incoming.candidates??[]).map(row=>row.registryId))],weight:1},...(denseIds.length?[{ids:denseIds.filter(id=>candidates.has(id)),weight:1}]:[]),...(exact.length?[{ids:exact.filter(id=>candidates.has(id)),weight:2}]:[])];
    const fused=fuseCandidates(channels,{limit:stageDepth}).map(row=>candidates.get(row.id));
    const views=fused.map(row=>patientMatchingRankingDocument(row));
    const rankInput={...envelope,input:{...envelope.input,candidates:fused.map((row,at)=>({registryId:row.registryId,text:views[at].text}))}};
    const ranked=fused.length>1?await models.rerank(rankInput):null;
    const rerankOrder=ranked?.status==='complete'?validatePermutation(ranked.data.order,fused.map(row=>row.registryId)):fused.map(row=>row.registryId);
    const scoredIds=jevEnabled&&scoredDepth>0&&typeof models.jevFit==='function'?rerankOrder.slice(0,scoredDepth):[];
    const fit=scoredIds.length>1?await models.jevFit({...envelope,input:{...envelope.input,candidates:scoredIds.map(id=>({registryId:id,text:trialRecordText(candidates.get(id))}))}}):null;
    const scored=(fit?.data?.scores??[]).filter(row=>row.score!==null);
    const composed=composeRanking({rerankOrder,jevScores:scored,gradedGains:scored.filter(row=>Number.isFinite(row.gradedGain)).map(row=>({registryId:row.registryId,gain:row.gradedGain}))});
    const order=composed.finalOrder;
    const ordered=order.map((id,at)=>({...candidates.get(id),rank:at+1}));
    const rerank={state:ranked?.status??'skipped',applied:ranked?.status==='complete',model:ranked?.data?.model??null,profileDigest:profileIdentity({embedding:models.embeddingProfileDigest,ranking:ranked?.data?.model??null}),
      view:{profile:MATCHING_RANKING_VIEW,truncated:views.filter(view=>view.truncated).length,fullRecordsUnavailable:sourceFailures},incomingOrder:fused.map(row=>row.registryId),rerankOrder,finalOrder:order,policy:RANKING_POLICY.id,
      jev:fit?{state:fit.status,model:fit.data?.model??null,rubric:fit.data?.rubric??null,scored:scoredIds.length,answered:fit.data?.answered??0,order:composed.jevOrder,gradedOrder:composed.gradedOrder,code:fit.data?.code??null}:{state:'skipped',scored:0,answered:0},
      indexGeneration:dense?.data?.generation??null,indexStatus:dense?.status??'unconfigured',clinicalEligibility:'not-assessed'};
    await assertCurrent(envelope);
    const searchId=await vcr.candidateSearches.save(study,{subjectKey,request:{condition:maskIdentifiers(query),summary:{digest:profileIdentity(objective)},limit},registries:incoming.registries??[],rerank,collection:incoming.collection??null,found:ordered.length,items:ordered});
    return result(ordered.length?'complete':incoming.available===false?'unsupported':'complete',{...incoming,searchId,rerank,retrieved:ordered.length,returned:Math.min(limit,ordered.length),candidates:ordered.slice(0,limit),more:ordered.length>limit,
      coverage:{registry:incoming.registries??[],dense:dense?{status:dense.status,generation:dense.data?.generation??null,code:dense.data?.code??null}:{status:'unconfigured'},requestedExact:exact.length,recoveredExact:exact.filter(id=>candidates.has(id)).length}});
  };
}
