import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AgentRunStore} from '../src/agentRuns.mjs';
import {RuntimeManager} from '../src/runtimeManager.mjs';
test('egress verification binds real project-scoped folded run rather than nonexistent tenant fields',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'egress-run-binding-'));
 const project={id:'eval-paper-binding',userId:'operator',rootDir:root,workspaceDir:path.join(root,'workspace'),metaDir:path.join(root,'.openscience')};
 await mkdir(project.workspaceDir);await mkdir(project.metaDir);
 const session={sessionId:'s',mode:'open-domain',agentId:null,agentVersion:null,runtimeAgent:null};
 const store=new AgentRunStore({get:async()=>session},{model:'deepseek/deepseek-v4-flash',readSessionHistory:async()=>[]});store.scheduleMonitor=()=>{};
 try{
  const created=await store.dispatch(project,{sessionId:'s',dispatchId:'binding'},async(_session,run)=>{await store.recordRuntimeEgressDispatch(project,run.id,new Date().toISOString());return{accepted:true};});
  await store.finishInternal(project,created.id,{status:'succeeded',artifacts:[]});
  const run=(await store.list(project)).find(row=>row.id===created.id);
  assert.equal(run.userId,undefined);assert.equal(run.projectId,undefined);
  const manager=new RuntimeManager({evolutionEnabled:true,runtimeProvider:'docker'},{readRuntimeEgressRun:async(owned,id)=>owned.userId===project.userId&&owned.id===project.id?(await store.list(project)).find(row=>row.id===id):null});
  const calls=[];manager.runtimeController={captureRunEgressProof:async()=>({nativeCoverageVerified:true}),verifyRunEgressProof:async(owned,id,times)=>{calls.push({owned,id,times});return{nativeCoverageVerified:true};}};
  assert.equal((await manager.verifyRunEgressCoverage({project,run})).nativeCoverageVerified,true);
  assert.equal(calls[0].id,run.id);assert.equal(calls[0].times.completedAt,run.finishedAt);assert.equal(calls[0].times.promptDispatchStartedAt,run.promptDispatchStartedAt);
  assert.equal((await manager.verifyRunEgressCoverage({project:{...project,userId:'other'},run})).nativeCoverageVerified,false);
  assert.equal((await manager.verifyRunEgressCoverage({project,run:{...run,finishedAt:'2020-01-01T00:00:00Z'}})).nativeCoverageVerified,false);
  assert.equal(calls.length,1);
 }finally{await store.closeProject(project);await rm(root,{recursive:true,force:true});}
});
