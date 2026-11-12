/** Discovery composes source-specific retrieval, a separate vector generation and typed reranking into one saved order. */
import {fuseCandidates,validatePermutation} from '@evimed/patient-matching-worker';
import {profileIdentity,composeRanking,trialRecordText,RANKING_POLICY} from '@evimed/patient-matching-core';
import {maskOutboundIdentifiers} from '@evimed/domain';
import {createHash} from 'node:crypto';
import {patientMatchingRankingDocument,rankingViewId} from './patientMatchingRankingText.mjs';
import {patientRankingText,recordIsLong} from './patientMatchingProfile.mjs';
const PROFILE_CACHE_ENTRIES=64;
const result=(status,data)=>({status,summary:'Candidate discovery completed with recorded coverage and order.',data,artifacts:[]});
/**
 * TrialLink ranking (policy `triallink-3`, chosen on the development patients 2026-11-08): lexical registry recall over the condition and its ranked
 * terms, the plugin's dense index, fused; Qwen3.7 reranks the fused list and Jev reads each candidate's whole record twice in one request (a five-level fit and a five-level graded reading);
 * the saved order is the weighted reciprocal-rank fusion of the rerank, the fit and the graded reading's expected gain. `depth` bounds every stage (at most 500, the reranker's request bound).
 * A long record (over 6,000 characters with the query) stands for itself as a profile summary (`models.profile`, cached per record) or, without one, as its newest sentences; its age and sex filter the registry search unless the tool gave them.
 * @param {{vcr:any,models:any,index?:any,jevEnabled?:boolean,depth?:number,jevDepth?:number,rankView?:string,assertCurrent?:(envelope:any)=>Promise<any>}} dependencies
 */
export function createPatientMatchingDiscovery({vcr,models,index=null,jevEnabled=true,depth=300,jevDepth=depth,rankView='trial-record',assertCurrent=async()=>{}}){
  const viewId=rankingViewId(rankView);
  /** @type {Map<string,{text:string,age:number|null,sex:string|null}>} */ const profiles=new Map();
  const stageDepth=Math.min(500,Math.max(20,Math.trunc(Number(depth)||300))),scoredDepth=Math.min(stageDepth,Math.max(0,Math.trunc(Number(jevDepth)||0)));
  return async({scope,origin,study,meta,input,patient})=>{
    const limit=Math.min(100,Math.max(1,input.limit??20));
    // Where a discovery's time went, kept with its search (production 2026-11-11: 63–115 s on a loaded host, stage unknown).
    const stageMs={},clock={at:Date.now()};const lap=name=>{const now=Date.now();stageMs[name]=now-clock.at;clock.at=now;};
    if(meta.protocolVersionId){const roster=[...new Map((await vcr.documents.roster(study)).map(row=>[row.subjectKey,row])).values()];const rows=roster.slice(0,limit).map(row=>({subjectKey:row.subjectKey,label:row.subjectLabel??row.subjectKey}));return result('complete',{protocolVersionId:meta.protocolVersionId,people:rows,available:roster.length,returned:rows.length,more:roster.length>rows.length});}
    const query=String(input.query??'').trim();
    if(!query||[...query].length>200)return {status:'unsupported',summary:'Use a focused condition query of1to200characters. The preserved patient context is read separately from this task.',data:{code:'patient_matching_discovery_query_limit',maxQueryCharacters:200},artifacts:[]};
    const subjectKey=meta.contextSubjectKey??meta.selectedPairs[0]?.subjectKey??null;
    const terms=[...new Set((Array.isArray(input.terms)?input.terms:[]).map(term=>String(term??'').trim()).filter(term=>term&&[...term].length<=200))].slice(0,32);
    const passages=patient?.passages??[],patientSources=patient?.sources??[];
    /** @type {{text:string,age:number|null,sex:string|null}|null} */ let profile=null;let patientMode='full';
    if(recordIsLong({query,passages})){
      patientMode='newest-window';
      if(typeof models.profile==='function'){
        const key=`${subjectKey??''}:${patient?.note?.hash??createHash('sha256').update(passages.map(passage=>passage.text).join('\n')).digest('hex')}`;
        profile=profiles.get(key)??null;
        if(profile){profiles.delete(key);profiles.set(key,profile);}
        else{
          const asked=await models.profile({scope,origin,signal:origin.signal,input:{taskId:meta.taskId,passages:passages.map(passage=>passage.text),patientSources}}).catch(()=>null);
          if(asked?.status==='complete'&&typeof asked.data?.text==='string'&&asked.data.text.trim()){
            profile={text:asked.data.text,age:Number.isFinite(asked.data.age)?asked.data.age:null,sex:asked.data.sex??null};
            profiles.set(key,profile);
            if(profiles.size>PROFILE_CACHE_ENTRIES)profiles.delete(profiles.keys().next().value);
          }
        }
      }
      if(profile)patientMode='profile';
    }
    lap('profile');
    const objective=patientRankingText({query,passages,profile});
    const age=input.age??profile?.age??null,sex=input.sex??profile?.sex??null,region=typeof input.region==='string'&&input.region.trim()?input.region.trim():null;
    const filter={condition:query,...(terms.length?{terms}:{}),...(subjectKey?{subjectKey}:{}),...(age!==null?{age}:{}),...(sex?{sex}:{}),...(region?{region}:{}),limit:stageDepth,...(meta.collection?{collection:meta.collection}:{} )};
    const incoming=await vcr.service.runtimeRead(study,'candidates',filter,{ownerView:true,listMax:stageDepth});
    const candidates=new Map((incoming.candidates??[]).map(row=>[row.registryId,row]));
    lap('search');
    const envelope={scope,origin,signal:origin.signal,input:{taskId:meta.taskId,query:objective,limit:stageDepth,patientSources}};
    await assertCurrent(envelope);
    const dense=index?await index.query(envelope).catch(()=>({status:'unsupported',data:{code:'patient_matching_index_query_failed'}})):null;
    const denseIds=(dense?.data?.candidates??[]).map(row=>row.registryId);
    lap('dense');
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
    lap('records');
    const channels=[{ids:[...new Set((incoming.candidates??[]).map(row=>row.registryId))],weight:1},...(denseIds.length?[{ids:denseIds.filter(id=>candidates.has(id)),weight:1}]:[]),...(exact.length?[{ids:exact.filter(id=>candidates.has(id)),weight:2}]:[])];
    const fused=fuseCandidates(channels,{limit:stageDepth}).map(row=>candidates.get(row.id));
    const views=fused.map(row=>patientMatchingRankingDocument(row,viewId));
    const rankInput={...envelope,input:{...envelope.input,candidates:fused.map((row,at)=>({registryId:row.registryId,text:views[at].text}))}};
    const ranked=fused.length>1?await models.rerank(rankInput):null;
    lap('rerank');
    const rerankOrder=ranked?.status==='complete'?validatePermutation(ranked.data.order,fused.map(row=>row.registryId)):fused.map(row=>row.registryId);
    const scoredIds=jevEnabled&&scoredDepth>0&&typeof models.jevFit==='function'?rerankOrder.slice(0,scoredDepth):[];
    const fit=scoredIds.length>1?await models.jevFit({...envelope,input:{...envelope.input,candidates:scoredIds.map(id=>({registryId:id,text:trialRecordText(candidates.get(id))}))}}):null;
    lap('jev');
    const scored=(fit?.data?.scores??[]).filter(row=>row.score!==null);
    const composed=composeRanking({rerankOrder,jevScores:scored,gradedGains:scored.filter(row=>Number.isFinite(row.gradedGain)).map(row=>({registryId:row.registryId,gain:row.gradedGain}))});
    const order=composed.finalOrder;
    const ordered=order.map((id,at)=>({...candidates.get(id),rank:at+1}));
    const rerank={state:ranked?.status??'skipped',applied:ranked?.status==='complete',model:ranked?.data?.model??null,profileDigest:profileIdentity({embedding:models.embeddingProfileDigest,ranking:ranked?.data?.model??null}),
      patientText:patientMode,view:{profile:viewId,truncated:views.filter(view=>view.truncated).length,fullRecordsUnavailable:sourceFailures},incomingOrder:fused.map(row=>row.registryId),rerankOrder,finalOrder:order,policy:RANKING_POLICY.id,
      jev:fit?{state:fit.status,model:fit.data?.model??null,rubric:fit.data?.rubric??null,scored:scoredIds.length,answered:fit.data?.answered??0,order:composed.jevOrder,gradedOrder:composed.gradedOrder,code:fit.data?.code??null}:{state:'skipped',scored:0,answered:0},
      indexGeneration:dense?.data?.generation??null,indexStatus:dense?.status??'unconfigured',clinicalEligibility:'not-assessed',stageMs};
    await assertCurrent(envelope);
    const searchId=await vcr.candidateSearches.save(study,{subjectKey,request:{condition:maskOutboundIdentifiers(query),summary:{digest:profileIdentity(objective)},limit},registries:incoming.registries??[],rerank,collection:incoming.collection??null,found:ordered.length,items:ordered});
    return result(ordered.length?'complete':incoming.available===false?'unsupported':'complete',{...incoming,searchId,rerank,retrieved:ordered.length,returned:Math.min(limit,ordered.length),candidates:ordered.slice(0,limit),more:ordered.length>limit,
      coverage:{registry:incoming.registries??[],dense:dense?{status:dense.status,generation:dense.data?.generation??null,code:dense.data?.code??null}:{status:'unconfigured'},requestedExact:exact.length,recoveredExact:exact.filter(id=>candidates.has(id)).length}});
  };
}

const STILL_RUNNING=Symbol('discovery still running');
/**
 * One discovery per task, patient record and request, whoever asks, answered within a call's bound. On the production host a discovery
 * took 63–115 s and the plugin's host call ends at 110 s (2026-11-11): two of four calls were cut off, each started the whole search
 * again, and the model waited for neither. Here the search runs detached from the request that started it (bounded by `runMs`); a call
 * waits at most `waitMs` and otherwise answers `pending` with the same call to make again, and that call joins the running search or
 * reads its result (kept `keepMs`). A failed search is not kept, so the next call starts it again.
 * @param {(args:any)=>Promise<any>} run
 * @param {{waitMs:number,runMs:number,keepMs?:number,maxEntries?:number,report?:(outcome:string)=>void}} options
 */
export function joinableDiscovery(run,{waitMs,runMs,keepMs=10*60_000,maxEntries=64,report=()=>{}}){
  /** @type {Map<string,{promise:Promise<any>,settled:number|null}>} */ const runs=new Map();
  return async args=>{
    const {origin,meta,input,scope,patient}=args;
    const key=profileIdentity({userId:origin.userId,projectId:origin.projectId,rootSessionId:origin.rootSessionId,pluginGeneration:origin.pluginGeneration??null,
      taskId:meta.taskId,contextSubjectKey:meta.contextSubjectKey??null,record:patient?.note?.hash??null,scope,input});
    const now=Date.now();
    for(const [held,entry] of runs)if(entry.settled!==null&&now-entry.settled>keepMs)runs.delete(held);
    let entry=runs.get(key);const joined=Boolean(entry);
    if(!entry){
      const controller=new AbortController(),limit=setTimeout(()=>controller.abort(),runMs);limit.unref?.();
      // The caller's signal ends with its request; the search keeps its own. Every other field of the origin is the caller's.
      const detached=Object.defineProperty({...origin},'signal',{value:controller.signal,enumerable:false});
      const started={settled:/** @type {number|null} */(null),promise:Promise.resolve().then(()=>run({...args,origin:detached}))};
      started.promise.then(()=>{clearTimeout(limit);started.settled=Date.now();},()=>{clearTimeout(limit);runs.delete(key);});
      runs.set(key,started);entry=started;
      for(const [held,other] of runs){if(runs.size<=maxEntries)break;if(other.settled!==null)runs.delete(held);}
    }
    /** @type {ReturnType<typeof setTimeout>|undefined} */ let timer;
    const waited=new Promise(resolve=>{timer=setTimeout(resolve,waitMs,STILL_RUNNING);origin.signal?.addEventListener?.('abort',()=>resolve(STILL_RUNNING),{once:true});});
    try{
      const outcome=await Promise.race([entry.promise,waited]);
      if(outcome!==STILL_RUNNING){if(joined)report('joined');return outcome;}
    }finally{clearTimeout(timer);}
    report('pending');
    return {status:'pending',summary:'Candidate discovery is still running. Call match_discover again with exactly the same arguments: that call continues this search (nothing is searched twice) and returns its result when it is ready.',
      data:{state:'running',next:{tool:'match_discover',arguments:structuredClone(input)}},artifacts:[]};
  };
}
