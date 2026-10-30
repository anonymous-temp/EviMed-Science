import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ResultVcrReplay } from '../src/resultVcrReplay.mjs';
import { replayDigest } from '../src/resultReplayClient.mjs';
import { RESULT_R_REPLAY_METHOD_KINDS } from '@evimed/domain';
const scenarios = {
 'design.simulate':{design:{kind:'two_arm_fixed',nTreat:100,nControl:100},endpoint:{type:'binary'},truth:{controlRate:0.3,treatmentRate:0.5},analysis:{method:'logistic'}},
 'design.assurance':{design:{allocation:0.5,events:300},endpoint:{type:'time_to_event'},designPrior:{mean:-0.3,sd:0.15},analysis:{alpha:0.025,sided:1}},
 'accrual.poisson_gamma':{sites:[{id:'a',alpha:2,beta:4,startTime:0}],target:120,byTimes:[6,12,18]},
 'comparator.map_prior':{historical:{events:[12,15,9],n:[60,70,50]},tauPrior:{kind:'half_normal',scale:0.5},components:2,robustWeight:0.2},
};
for (const [method,scenario] of Object.entries(scenarios)) test(`global aggregate replay freezes ${method} without a study or patient table`,async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'vcr-aggregate-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const project={id:'project',userId:'owner',rootDir:root,workspaceDir:path.join(root,'workspace'),metaDir:path.join(root,'meta')};
 await mkdir(path.join(project.workspaceDir,'result-replays/job'),{recursive:true});await mkdir(project.metaDir,{recursive:true});
 const bytes=Buffer.from(JSON.stringify({scenario,seed:73,replicates:500}));await writeFile(path.join(project.workspaceDir,'result-replays/job/input.json'),bytes);
 const health={ok:true,engineVersion:'test',rVersion:'test',packageLockHash:'a'.repeat(64),numericalSourceDigest:'b'.repeat(64),methods:[method]};
 const recipe={method,version:'1',input:{path:'result-replays/job/input.json',sha256:createHash('sha256').update(bytes).digest('hex')},parameters:{},codeDigest:health.numericalSourceDigest,
  environmentDigest:replayDigest({engineVersion:health.engineVersion,rVersion:health.rVersion,packageLockHash:health.packageLockHash})};
 let submitted;
 const engine={configured:()=>true,health:async()=>health,submit:async job=>{submitted=job;},status:async jobId=>({jobId,state:'running'})};
 const replay=new ResultVcrReplay({engine,authorizeProject:async()=>project});
 await replay.start({userId:'user',projectId:'project',jobId:'job',method,recipeDigest:replayDigest(recipe)},recipe);
 assert.equal(submitted.kind,RESULT_R_REPLAY_METHOD_KINDS[method]);assert.equal(submitted.seed,73);assert.ok(submitted.replicates>=500);assert.ok(submitted.replicates<=100000);
 assert.equal(submitted.inputs[0].kind,'assumption');assert.equal(submitted.cores,1);
});
