import test from 'node:test';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@evimed/domain';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareWeekly } from '../src/evolutionTimeHoldout.mjs';

test('weekly temporal evaluation never spends on missing gold or reclassifies calibration as new holdout',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'evolution-time-'));
  const id=`evolution-temporal-${'a'.repeat(64)}`,record={kind:'temporal-evaluation-candidate',status:'awaiting-gold',paperId:'new-paper',toolId:'tool',artifactDigest:'pin',firstPublicAt:'2026-10-05',firstPublicEvidenceId:'public-archive'};
  const rows=new Map([[id,{id,payload:record}],['tool',{id:'tool',payload:{status:'active',track:'E',artifactDigest:'pin',modelReleasedAt:'2026-01-01',modelReleaseEvidenceId:'release',frozenAt:'2026-10-04'}}]]);
  let actualUse=false;
  const service={list:async type=>type==='use'?(actualUse?[{payload:{projectId:'eval-project',runId:'eval-run',toolId:'tool',digest:'pin',result:{ok:true}}}]:[]):[rows.get(id)],get:async key=>rows.get(key),owner:async()=> 'operator',now:()=>new Date('2026-10-12'),save:async(_type,key,payload)=>{const row={id:key,payload};rows.set(key,row);return row;}};
  let runs=0, preparations=0;
  const paperGold={run:async({definition})=>{runs++;assert.equal(definition.group,'time-holdout');assert.equal(definition.cases[0].group,'time-holdout');assert.equal(definition.cases[0].sourceHash,'b'.repeat(64));assert.match(definition.cases[0].rewrite.variants[0],/exact toolId/);return{at:'2026-10-12',units:[{producerProjectId:'eval-project',producerRunId:'eval-run',group:'time-holdout',track:'E',allStagesValid:false}]};}};
  const dependencies={prepareGold:async({observation,tool})=>{preparations++;assert.equal(observation.id,id);assert.equal(tool.id,'tool');return{ok:false,status:'waiting'};},service,config:{evaluationDataDir:root},paperGold,day:'2026-10-12',canonicalize:async()=>({verified:true,canonicalId:'doi:10.1234/verified'})};
  try {
    const missing=await prepareWeekly(dependencies);assert.equal(missing.status,'waiting');assert.equal(missing.observed,0);assert.equal(runs,0);assert.equal(preparations,1);
    await fs.mkdir(path.join(root,'paper-gold','time-holdout'),{recursive:true});
    const gold={observationId:id,paperId:'new-paper',toolId:'tool',artifactDigest:'pin',sourceHash:'b'.repeat(64),firstPublicAt:record.firstPublicAt,firstPublicEvidenceId:record.firstPublicEvidenceId,independent:true,retracted:false,definition:{group:'calibration',cases:[{id:'new-case',type:'question',capabilityId:'clinical-evidence-synthesis',gold:{numeric:{}},policy:{aliases:['doi:new'],titles:['New independent paper']},rewrite:{question:'The frozen question?',variants:['A rewritten question?']}}]}};
    await fs.writeFile(path.join(root,'paper-gold','time-holdout',`${id}.json`),JSON.stringify(gold));
    assert.equal((await prepareWeekly({...dependencies,canonicalize:async()=>null})).observed,0);assert.equal(runs,0);
    const sealed={...gold,hash:createHash('sha256').update(canonicalJson(gold)).digest('hex')};
    await fs.writeFile(path.join(root,'paper-gold','time-holdout',`${id}.json`),JSON.stringify({...sealed,sourceHash:'c'.repeat(64)}));
    await assert.rejects(()=>prepareWeekly(dependencies),/Frozen temporal gold bytes changed/);assert.equal(runs,0);
    await fs.writeFile(path.join(root,'paper-gold','time-holdout',`${id}.json`),JSON.stringify(sealed));
    const unattributed=await prepareWeekly(dependencies);assert.equal(unattributed.observed,0);assert.equal(rows.get(id).payload.status,'awaiting-gold');
    const evaluations=[...rows.values()].filter(row=>row.payload.units);assert.equal(evaluations[0].payload.units[0].eligibleForMainMetric,false);assert.equal(evaluations[0].payload.units[0].exposureTier,'unknown');
    assert.equal(preparations,1);actualUse=true;
    const observed=await prepareWeekly(dependencies);assert.equal(observed.observed,1);assert.equal(runs,2);assert.equal(rows.get(id).payload.status,'scored');
    assert.equal((await prepareWeekly({...dependencies,day:'2026-10-19'})).observed,0);assert.equal(runs,2);
    rows.get(id).payload.status='awaiting-gold';rows.get('tool').payload.artifactDigest='changed';assert.equal((await prepareWeekly({...dependencies,day:'2026-10-26'})).observed,0);assert.equal(runs,2);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
