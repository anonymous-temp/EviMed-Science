import { createHash } from 'node:crypto';
import { canonicalJson } from '@evimed/domain';
import { evolutionKey } from './evolutionService.mjs';
import { validateEvolutionExercise, evolutionCurriculumDestination } from './evolutionTaskPool.mjs';
export const EVOLUTION_TRUSTED_TASK_TEMPLATES=Object.freeze({
 'source-delimited-cells':{version:1,medicalFacts:false,
  generate:({value=2,label='fixture'}={})=>{const correct=[{address:'2:1',text:String(value)},{address:'2:2',text:label}];return{input:{value,label},correct,wrong:[[{address:'2:1',text:String(value+1)}],[{address:'1:1',text:String(value)}]],sourceText:`value,label\n${value},${label}`,format:'csv',expectedCells:correct,taskFamily:{operation:'extract',inputShape:'table',estimator:'exact-cells',evidenceType:'exact',deliverable:'table'}};},
  verify:(input,answer)=>Array.isArray(answer)&&JSON.stringify(answer)===JSON.stringify([{address:'2:1',text:String(input.value)},{address:'2:2',text:input.label}])},
 'unit-conversion':{version:1,medicalFacts:false,
  generate:({value=2,from='g',to='mg'}={})=>{const factors={kg:1000,g:1,mg:0.001};const valid=Number.isFinite(value)&&factors[from]!=null&&factors[to]!=null;const correct=valid?value*factors[from]/factors[to]:null;return{input:{value,from,to},correct,wrong:valid?[correct+1,correct-1]:[0,1],abstentionExpected:!valid,equivalentVariant:{input:{to,from,value},expected:correct}};},
  verify:(input,answer)=>{const factors={kg:1000,g:1,mg:0.001};return Number.isFinite(input.value)&&factors[input.from]!=null&&factors[input.to]!=null?Number.isFinite(answer)&&Math.abs(answer-input.value*factors[input.from]/factors[input.to])<1e-9:answer===null;}},
 'known-truth-sum':{version:1,medicalFacts:false,
  generate:({values=[1,2,3]}={})=>{const valid=Array.isArray(values)&&values.length>0&&values.every(Number.isFinite);const correct=valid?values.reduce((sum,value)=>sum+value,0):null;return{input:{values},correct,wrong:valid?[correct+1,correct-1]:[0,1],abstentionExpected:!valid,equivalentVariant:{input:{values:valid?[...values].reverse():values},expected:correct}};},
  verify:(input,answer)=>Array.isArray(input.values)&&input.values.length>0&&input.values.every(Number.isFinite)?Number.isFinite(answer)&&Math.abs(answer-input.values.reduce((sum,value)=>sum+value,0))<1e-9:answer===null},
});
const hash=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');
/** Plans experiments on public/generated tasks through the ordinary budgeted mission queue.
 * Shared mechanisms are labels backed by three module verdicts, never permission to activate a candidate.
 * @param {{service:any,missions:any,taskPool:any,adapters?:Record<string,any>,templates?:Record<string,any>}} dependencies */
export function createEvolutionTransfer({service,missions,taskPool,adapters={},templates={}}){
 const plan=async(kind,moduleId,parents,cycle,extra={})=>{
  const id=`evolution-mission-${kind}-${evolutionKey([moduleId,parents.map(row=>row.id),cycle])}`;
  const opportunity=await missions.opportunity({id:`${id}-opportunity`,moduleId,sources:[kind==='combination'?'combination':'method'],taskFamily:extra.taskFamily??'mechanism-transfer',mechanismFamily:kind,evidenceRoots:parents.map(row=>row.id),features:{reuseValue:parents.length},cheapestNextStep:'evaluate-public-unseen-tasks',...extra});
  const mission=await missions.create({id,opportunityId:opportunity.id,moduleId,kind,category:kind==='prune'?'maintenance':'research',cycle,borrowUnused:true,
   sourceCandidateIds:parents.map(row=>row.id),transferSource:parents.map(row=>row.payload.candidate),requiresFreshConfirmation:true,
   successConditions:{selectionVersion:'evolution-selection-2',isolatable:true},...extra});
  if(mission.id)await missions.queue(mission);
  return mission;
 };
 async function assess({candidateId}){
  const archive=await service.get(candidateId);if(!archive)throw new Error('Missing preserved transfer candidate.');
  const verdicts=await service.list('candidate-verdict'),allMissions=await service.list('mission');
  const attempts=verdicts.filter(row=>(row.payload.archiveId??row.payload.candidateId)===candidateId||allMissions.some(mission=>mission.id===row.payload.missionId&&mission.payload.sourceCandidateIds?.includes(candidateId)));
  const archives=await service.list('archive');
  const promoted=[...new Set(attempts.filter(row=>row.payload.promote&&row.payload.auditOnly!==true&&row.payload.confirmatory&&row.payload.receiptValid&&archives.some(saved=>saved.id===(row.payload.archiveId??row.payload.candidateId)&&saved.payload.status==='promoted'&&saved.payload.verdictId===row.id)).map(row=>row.payload.moduleId))];
  const third=attempts.find(row=>!promoted.includes(row.payload.moduleId)&&row.payload.auditOnly===true&&row.payload.outcome!=='invalid-evidence'&&(['exact','published','checklist'].includes(row.payload.evidenceTier)||row.payload.evidenceTier==='model'&&row.payload.measured?.anchorCalibrated===true&&row.payload.measured?.deterministicChecksPassed===true)&&row.payload.confirmatory===true&&row.payload.receiptValid===true&&Number.isFinite(row.payload.score)&&Number.isFinite(row.payload.baseline)&&Number.isFinite(row.payload.delta)&&row.payload.score>=row.payload.baseline-row.payload.delta);
  const shared=promoted.includes(archive.payload.moduleId)&&promoted.length>=2&&Boolean(third);
  const rejectedTargets=attempts.filter(row=>!row.payload.promote&&row.payload.moduleId!==archive.payload.moduleId).map(row=>row.payload.moduleId);
  const id=`evolution-transfer-assessment-${evolutionKey([candidateId,attempts.map(row=>row.id),promoted,third?.id??null])}`;
  const previous=await service.get(id);
  return previous??service.save('transfer-assessment',id,{candidateId,shared,sourceModuleId:archive.payload.moduleId,promotedModules:promoted,auditModuleId:third?.payload.moduleId??null,
   verdictIds:attempts.map(row=>row.id),moduleSpecific:!shared,rejectedTargets:[...new Set(rejectedTargets)],status:shared?'shared':'module-specific',at:service.now().toISOString()});
 }
 async function proposeCombination({parentIds,moduleId,cycle=service.now().toISOString().slice(0,10)}){
  if(!Array.isArray(parentIds)||new Set(parentIds).size<2)throw new Error('A combination requires two distinct preserved parents.');
  const parents=await Promise.all(parentIds.map(id=>service.get(id)));
  if(parents.some(row=>!row?.payload.candidate))throw new Error('Missing combination parent.');
  return plan('combination',moduleId,parents,cycle,{hypothesis:'The mechanisms may complement each other; their combination must be evaluated anew.',combinationRequiresReevaluation:true});
 }
 async function weeklyProbe({week}){
  const archive=await service.list('archive'),planned=[];
  if(adapters.sources?.enabled){const curriculum=await missions.create({id:`evolution-curriculum-${evolutionKey(week)}`,moduleId:'sources',kind:'curriculum',category:'maintenance',cycle:week,borrowUnused:true});if(curriculum.id){await missions.queue(curriculum);planned.push(curriculum.id);}}
  const enabled=Object.entries(adapters).filter(([,adapter])=>adapter.enabled).map(([id])=>id);
  for(const row of archive.filter(item=>item.payload.status==='promoted')){
   const assessment=await assess({candidateId:row.id});if(assessment.payload.shared)continue;
   const attempts=await service.list('mission');
   const targets=enabled.filter(id=>id!==row.payload.moduleId&&!attempts.some(mission=>mission.payload.sourceCandidateIds?.includes(row.id)&&mission.payload.moduleId===id));
   // One target per source per weekly probe; third-module audit is never a promotion experiment.
   const target=targets[0];if(!target)continue;
   const auditOnly=assessment.payload.promotedModules.length>=2;
   const mission=await plan(auditOnly?'transfer-audit':'transfer',target,[row],week,{auditOnly,sourceModuleId:row.payload.moduleId,isolatable:true});
   if(mission.id)planned.push(mission.id);
  }
  return{week,planned};
 }
 async function monthlyPrune({month}){
  const archive=await service.list('archive'),verdicts=await service.list('candidate-verdict'),supported=await service.list('supported-family'),planned=[];
  const independentlySupported=supported.filter(family=>verdicts.some(verdict=>verdict.id===family.payload.verdictId&&verdict.payload.promote&&verdict.payload.confirmatory&&verdict.payload.receiptValid&&!verdict.payload.auditOnly));
  const uniquelyCovers=id=>independentlySupported.some(family=>family.payload.candidateId===id&&new Set(independentlySupported.filter(other=>other.payload.moduleId===family.payload.moduleId&&hash(other.payload.taskFamily??null)===hash(family.payload.taskFamily??null)).map(other=>other.payload.candidateId)).size===1);
  for(const row of archive){
   const candidate=row.payload.candidate,mechanisms=candidate?.proposal?.mechanisms??[];
   if(!mechanisms.length||row.payload.uniqueCoverage===true||uniquelyCovers(candidate?.id??row.id)||candidate?.toolKind==='handbook'||candidate?.personalMethod===true)continue;
   const relevant=verdicts.filter(verdict=>(verdict.payload.archiveId??verdict.payload.candidateId)===row.id||verdict.payload.parentId===row.id).sort((a,b)=>String(a.payload.at).localeCompare(String(b.payload.at)));
   for(const mechanism of mechanisms){
    const observations=relevant.filter(verdict=>verdict.payload.mechanismContributions?.[mechanism]!=null);
    const recent=observations.filter(verdict=>service.now().getTime()-Date.parse(verdict.payload.at)<=30*86400000);
    const four=observations.slice(-4),gains=(candidate.platformLevel?recent:four).map(verdict=>verdict.payload.mechanismContributions[mechanism]);
    const enough=candidate.platformLevel?Date.parse(row.createdAt??row.payload.createdAt)<=service.now().getTime()-30*86400000:four.length===4;
    if(!enough||!gains.length||gains.some(gain=>!Number.isFinite(gain)||gain>0))continue;
    const mission=await plan('prune',row.payload.moduleId,[row],`${month}:${mechanism}`,{removedMechanism:mechanism,removedMechanisms:1,requiresUniqueCoverageCheck:true});
    if(mission.id)planned.push(mission.id);
   }
  }
  return{month,planned};
 }
 /** Only trusted code registers templates. Model-created exercises cannot supply the verifier. */
 async function generateTasks({templateId,moduleId,parameters,pool='development',parameterRangeUnseen=false}){
  const template={...EVOLUTION_TRUSTED_TASK_TEMPLATES,...templates}[templateId];if(!template||template.medicalFacts===true)throw new Error('No trusted deterministic task template.');
  const exercise=await template.generate(parameters);
  if(!validateEvolutionExercise({...exercise,verify:template.verify}))throw new Error('Exercise failed correct/wrong-answer separation.');
  const sourceHash=hash({templateId,version:template.version,input:exercise.input,correct:exercise.correct,wrong:exercise.wrong});
  const id=`generated-${sourceHash.slice(0,32)}`;
  return taskPool.add({id,moduleId,sourceRoot:`generated:${templateId}:${sourceHash}`,sourceHash,pool,scope:'generated',truthVerified:true,parameterRangeUnseen,
   generatedAt:service.now().toISOString(),taskFamily:exercise.taskFamily??{operation:'transform',inputShape:'table',estimator:templateId,evidenceType:'exact',deliverable:'value'},format:exercise.format,sourceText:exercise.sourceText,expectedCells:exercise.expectedCells,templateFamilyId:`generated:${templateId}:${template.version}`,equivalentVariant:exercise.equivalentVariant,abstentionExpected:exercise.abstentionExpected===true,
   input:exercise.input,correct:exercise.correct,templateId,templateVersion:template.version,truthProof:{correctAccepted:true,wrongRejected:exercise.wrong.length}});
 }
 async function classifyCurriculum({taskId,results}){
  const task=await service.get(taskId);if(!task)throw new Error('Missing curriculum task.');
  const destination=evolutionCurriculumDestination(results);
  return service.save('task',taskId,{...task.payload,curriculum:{results,destination,at:service.now().toISOString()}},task);
 }
 return{assess,proposeCombination,weeklyProbe,monthlyPrune,generateTasks,classifyCurriculum};
}
