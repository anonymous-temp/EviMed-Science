import {evolutionKey} from './evolutionService.mjs';
import {evolutionTaskFamily} from './evolutionCapabilityMap.mjs';
import {EVOLUTION_MODULE_IDS} from './evolutionUsage.mjs';

/** Signal vocabularies identify growth and contradiction opportunities as well as repairs. @param {string} kind */
export function evolutionOpportunitySource(kind){
 if(kind==='unmet-demand')return 'demand';
 if(kind==='availability')return 'data';
 if(['semantics-contested','semantics-correction'].includes(kind))return 'contradiction';
 if(['workflow-success','review-accepted','memory-accepted'].includes(kind))return 'success';
 return 'repair';
}
/** @param {{service:any,opportunity:any,database:any}} deps */
export function createEvolutionGrowth({service,opportunity,database}){
 async function resource(id,kinds,payload){const prior=await service.get(id);return service.save('resource-asset',id,{...prior?.payload,...payload,kinds:[...new Set([...(prior?.payload.kinds??[]),...kinds])],scope:'public',at:service.now().toISOString()},prior);}
 async function collect(){
  for(const row of await service.list('signal-summary')){
   const p=row.payload;if(p.distinctAccounts<5)continue;
   const source=evolutionOpportunitySource(p.kind);
   await resource(`evolution-demand-resource-${evolutionKey(row.id)}`,['demand'],{sourceRoot:row.id,use:'opportunity-prioritisation',closedCodes:p.codes,occurrences:p.occurrences,distinctAccounts:p.distinctAccounts});
   await opportunity({moduleId:p.moduleId,sources:[source],taskFamily:p.codes,mechanismFamily:p.kind,evidenceRoots:[row.id],features:{distinctAccounts:p.distinctAccounts,coverageGap:source==='demand',runtimeFailures:source==='repair'?p.occurrences:0},cheapestNextStep:source==='data'?'test-public-shape-analogue':'reproduce-on-public-analogue',failureHypotheses:['private-shape-may-not-transfer']});
  }
  for(const row of await service.list('module-observation')){
   const p=row.payload;if(!EVOLUTION_MODULE_IDS.includes(p.moduleId))continue;
   const failures=Number(p.counts?.failed??p.counts?.rejected??p.counts?.unsupported??0)+Number(p.counts?.numberFailures??0)+Number(p.counts?.unitMismatches??0);
   if(failures<=0)continue;
   await opportunity({moduleId:p.moduleId,sources:['repair'],mechanismFamily:`observed-${p.kind}`,evidenceRoots:[row.id],features:{runtimeFailures:failures},cheapestNextStep:'reproduce-recorded-public-failure',failureHypotheses:['observed-module-defect']});
  }
  const archives=await service.list('archive');
  const verdicts=(await service.list('candidate-verdict')).filter(row=>row.payload.promote&&row.payload.confirmatory&&row.payload.receiptValid&&!row.payload.auditOnly&&archives.some(archive=>archive.id===(row.payload.archiveId??row.payload.candidateId)&&archive.payload.verdictId===row.id&&archive.payload.status==='promoted'));
  const tools=(await service.tools()).filter(row=>row.payload.status==='active');
  for(const row of verdicts){
   const p=row.payload;
   await resource(`evolution-evaluation-resource-${evolutionKey(row.id)}`,['evaluation'],{sourceRoot:row.id,use:'confirmed-regression-anchor',moduleId:p.moduleId,sourceHash:p.candidateHash,confirmed:true});
   await opportunity({moduleId:p.moduleId,sources:['success'],taskFamily:p.taskFamily,mechanismFamily:'confirmed-success-neighbour',evidenceRoots:[row.id],features:{developmentGain:Math.max(0,p.score-p.baseline)},cheapestNextStep:'test-adjacent-public-family',failureHypotheses:['success-may-be-family-specific']});
   const family=evolutionTaskFamily(p.taskFamily??{});
   const compatible=tools.filter(tool=>tool.payload.taskFamily&&family.inputShape!=='unknown'&&evolutionTaskFamily(tool.payload.taskFamily).inputShape===family.inputShape);
   if(compatible.length>=2)await opportunity({moduleId:'tools',sources:['combination'],taskFamily:family,mechanismFamily:'existing-compatible-tools',evidenceRoots:[row.id,...compatible.slice(0,3).map(tool=>tool.id)],features:{coverageGap:true},cheapestNextStep:'paired-public-composition-test',failureHypotheses:['compatible-shape-does-not-prove-composition']});
  }
  for(const row of await service.list('mechanism-card'))await resource(`evolution-method-resource-${evolutionKey(row.id)}`,['knowledge','method'],{sourceRoot:row.payload.source?.entryId??row.id,use:'mechanism-hypothesis',sourceHash:row.payload.source?.digest??null,methodCardId:row.id});
 }
 async function recordConfirmedFamilies({mission,candidate,verdict}){
  const p=verdict.payload;if(!p.promote||!p.confirmatory||!p.receiptValid||p.auditOnly)return 0;
  const batch=await service.get(p.batchId),tasks=await Promise.all((batch?.payload.taskIds??[]).map(id=>service.get(id)));
  const units=p.measured?.units ?? [];
  const individuallySupported=tasks.filter(row=>row && units.some(unit=>unit.id===row.id) && units.filter(unit=>unit.id===row.id||unit.id===`${row.id}:equivalent`).every(unit=>unit.score===1));
  const families=[...(p.score===1?[mission.payload.taskFamily]:[]),...individuallySupported.map(row=>row.payload.taskFamily)].filter(Boolean);
  let added=0;const seen=new Set();
  for(const raw of families){const family=evolutionTaskFamily(raw);if(family.operation==='unknown'||family.inputShape==='unknown')continue;
   const id=`evolution-supported-family-${evolutionKey([mission.payload.moduleId,family])}`;
   if(seen.has(id))continue;seen.add(id);
   await service.withLock(id,async()=>{const existing=await service.get(id);if(existing){if(existing.payload.missionId===mission.id)added++;return;}await service.save('supported-family',id,{moduleId:mission.payload.moduleId,taskFamily:family,capabilityIds:candidate.capabilityIds ?? (raw.capability?[raw.capability]:undefined),candidateId:candidate.id,missionId:mission.id,verdictId:verdict.id,confirmedAt:service.now().toISOString()});added++;});
  }return added;
 }
 async function recordResumedResearchCompleted({userId,projectId,agendaId,runId,status}){
  if(!userId||!projectId||!agendaId||!runId||!['delivered','succeeded'].includes(status))return 0;
  let recorded=0;
  for(const row of await service.list('waiter',userId)){
   if(row.payload.projectId!==projectId||row.payload.agendaId!==agendaId||row.payload.status!=='resolved'||row.payload.completedResearchAt)continue;
   await service.save('waiter',row.id,{...row.payload,completedResearchAt:service.now().toISOString(),completionRunId:runId},row,userId);recorded++;
  }return recorded;
 }
 async function completedAggregate(from,to){
  const result=await database.query(`SELECT count(*)::integer AS completed,count(DISTINCT user_id)::integer AS accounts FROM evimed_product.documents WHERE kind='knowledge' AND deleted_at IS NULL AND payload->>'recordType'='evolution-waiter' AND payload->>'status'='resolved' AND payload->>'completedResearchAt'>=$1 AND payload->>'completedResearchAt'<$2 HAVING count(DISTINCT user_id)>=5`,[from,to]);
  return result.rows[0]?Number(result.rows[0].completed):null;
 }
 return {collect,recordConfirmedFamilies,recordResumedResearchCompleted,completedAggregate};
}
