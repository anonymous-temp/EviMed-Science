import {createHash} from 'node:crypto';
import {canonicalJson} from '@evimed/domain';
import {validateEvolutionMeasurements} from './evolutionMissions.mjs';
import {evolutionKey} from './evolutionService.mjs';
import {EVOLUTION_PROJECT_ID} from './internalProjects.mjs';
const digest=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');
/** Equal weight per preserved independent source group, including its equivalent variant. @param {any} measurement */
function score(measurement){
  if(!measurement?.units?.length)return null;
  const groups=new Map();
  for(const unit of measurement.units){if(!Number.isFinite(unit.score))return null;const id=unit.groupId??unit.id;groups.set(id,[...(groups.get(id)??[]),unit.score]);}
  return [...groups.values()].reduce((sum,values)=>sum+values.reduce((a,b)=>a+b,0)/values.length,0)/groups.size;
}
/** Pair the immutable original baseline with its candidate; missing proof remains unmeasured.
 * @param {{service:any,taskPool:any,adapters:any}} dependencies */
export function createEvolutionPairedAudit({service,taskPool,adapters}){
  return async function audit({month,quarter,epoch,tasks,missionId,moduleId}){
    const records=[];
    for(const verdict of await service.list('candidate-verdict')){
      const p=verdict.payload;
      if(moduleId&&p.moduleId!==moduleId)continue;
      if(p.at?.slice(0,7)!==month)continue;
      if(p.auditOnly||p.epoch!==epoch||!p.receiptValid||!p.confirmatory)continue;
      const mission=await service.get(p.missionId),archive=await service.get(p.archiveId??p.candidateId),adapter=adapters[p.moduleId];
      const id=`evolution-paired-audit-${evolutionKey([quarter,verdict.id,epoch])}`,existing=await service.get(id);
      if(existing?.payload.status==='measured'){records.push({id,...existing.payload});continue;}
      const batch=tasks.filter(row=>row.payload.moduleId===p.moduleId).map(row=>({...row.payload,id:row.id}));
      const candidate=archive?.payload.candidate??mission?.payload.candidate,baseline=mission?.payload.baseline;
      const unavailable=reason=>records.push({verdictId:verdict.id,moduleId:p.moduleId,missionId:p.missionId,status:'unmeasured',reason,developmentGain:null,auditGain:null,overfitGap:null});
      if(!adapter?.enabled||!candidate||!baseline||digest(candidate)!==p.candidateHash){unavailable('immutable-pair-unavailable');continue;}
      if(new Set(batch.map(item=>item.studyFamilyId??item.sourceRoot)).size<({frontier:30,geo:30,autopilot:20,runtime:10}[p.moduleId]??2)||batch.some(item=>item.pool!=='audit'||item.feedbackCount||!['public','generated'].includes(item.scope))){unavailable('independent-heldout-groups-unavailable');continue;}
      const receipt={id};
      const input={moduleId:p.moduleId,missionId,pool:'audit',epoch,batch,userId:await service.owner(),projectId:EVOLUTION_PROJECT_ID};
      const measurements={};
      for(const arm of ['baseline','candidate']){
        measurements[arm]=await adapter.evaluate({...input,arm,role:arm,repeat:0,candidate:arm==='baseline'?baseline:candidate,baseline,
          checkpointUnit:(key,operation)=>taskPool.executeUnit(receipt,`${arm}:${key}`,operation)});
      }
      if(Object.values(measurements).some(value=>validateEvolutionMeasurements(batch,value).length||!['exact','published','checklist','model'].includes(value.evidenceTier)||value.evidenceTier==='model'&&!value.anchorCalibration?.anchorCalibrated)){unavailable('paired-measurement-integrity');continue;}
      const auditGain=score(measurements.candidate)-score(measurements.baseline);
      const smoke=mission.payload.smoke,developmentBaseline=score(smoke?.baseline),developmentCandidate=score(smoke?.candidate);
      const developmentGain=developmentBaseline===null||developmentCandidate===null?null:developmentCandidate-developmentBaseline;
      const payload={status:'measured',month,quarter,epoch,moduleId:p.moduleId,missionId:p.missionId,verdictId:verdict.id,candidateHash:p.candidateHash,taskIds:batch.map(item=>item.id),developmentGain,auditGain,
        overfitGap:developmentGain===null?null:developmentGain-auditGain,developmentBasis:developmentGain===null?null:'paired-development-smoke',evaluationReceiptHash:digest({epoch,candidateHash:p.candidateHash,batch,measurements}),measurements,at:service.now().toISOString()};
      const saved=await service.save('paired-audit',id,payload,existing);
      await service.withLock(`paired-audit:${p.missionId}`,async()=>{
        const current=await service.get(p.missionId),currentVerdict=await service.get(verdict.id);
        await service.save('candidate-verdict',verdict.id,{...currentVerdict.payload,developmentGain,auditGain,overfitGap:payload.overfitGap,auditReceiptId:id,auditEpoch:epoch},currentVerdict);
        await service.save('mission',current.id,{...current.payload,developmentGain,auditGain,overfitGap:payload.overfitGap,auditReceiptId:id,auditEpoch:epoch},current);
      });
      records.push({id,...saved.payload});
    }
    return records;
  };
}
