import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {selectedArms,openExecution,beginArm,sealArm,verifySealedArms,assertActiveRuntime} from '../arm_execution.mjs';
const identity={benchmarkSha256:'frozen-question-corpus',sharedBudgetId:'one-cap-50',arms:{baseline:{base:'http://127.0.0.1:1001',revision:'baseline-revision',runtimeImageId:'sha256:baseline'},candidate:{base:'http://127.0.0.1:1002',revision:'candidate-revision',runtimeImageId:'sha256:candidate'}}};
async function fixture(t){const out=await fs.mkdtemp(path.join(os.tmpdir(),'eval-arms-'));t.after(()=>fs.rm(out,{recursive:true,force:true}));return out;}
test('explicit per-arm execution never selects the inactive runtime, and invalid phases are refused',()=>{
 assert.deepEqual(selectedArms(['--execute','--arm','baseline']),['baseline']);assert.deepEqual(selectedArms(['--execute','--arm','candidate']),['candidate']);assert.deepEqual(selectedArms(['--execute']),['baseline','candidate']);assert.throws(()=>selectedArms(['--arm','other']));
});
test('candidate waits for a sealed real baseline and baseline seal survives append-only candidate execution',async t=>{
 const out=await fixture(t);let state=await openExecution(out,identity,{expectedCells:540});
 await assert.rejects(()=>beginArm(out,state,'candidate'),/baseline|seal/);await beginArm(out,state,'baseline');
 await fs.writeFile(path.join(out,'baseline-real-1.json'),'{"runId":"real-baseline-id"}');
 await sealArm(out,state,'baseline',{imageId:'sha256:baseline',revision:'baseline-revision'},{inconclusiveCells:0});
 const seal=JSON.stringify(state.arms.baseline.seal);state=await openExecution(out,identity,{expectedCells:540});await beginArm(out,state,'candidate');
 await fs.writeFile(path.join(out,'candidate-real-1.json'),'{"runId":"real-candidate-id"}');await sealArm(out,state,'candidate',{imageId:'sha256:candidate',revision:'candidate-revision'},{inconclusiveCells:1});
 assert.equal(JSON.stringify(state.arms.baseline.seal),seal);assert.equal(state.arms.candidate.inconclusiveCells,1);await verifySealedArms(out,state);
});
test('changed corpus, budget, revision/image or baseline output cannot resume as the same benchmark',async t=>{
 const out=await fixture(t);const state=await openExecution(out,identity,{});await beginArm(out,state,'baseline');await fs.writeFile(path.join(out,'baseline-real-1.json'),'actual evidence');await sealArm(out,state,'baseline',{imageId:'sha256:baseline',revision:'baseline-revision'},{});
 for(const changed of [{...identity,sharedBudgetId:'other-budget'},{...identity,benchmarkSha256:'changed'},{...identity,arms:{...identity.arms,candidate:{...identity.arms.candidate,runtimeImageId:'sha256:old-baseline'}}}])await assert.rejects(()=>openExecution(out,changed,{}),/identity|configuration/);
 await fs.writeFile(path.join(out,'baseline-real-1.json'),'replaced evidence');await assert.rejects(()=>beginArm(out,state,'candidate'),/seal|changed/);
});
test('sealed duplicate arms and interrupted unsafe resume fail before another fixture/model dispatch',async t=>{
 const out=await fixture(t);const state=await openExecution(out,identity,{});await beginArm(out,state,'baseline');await assert.rejects(()=>beginArm(out,state,'baseline'),/resume|started|collecting/);
 await fs.writeFile(path.join(out,'baseline-failure.failure.json'),'{"status":"inconclusive"}');await sealArm(out,state,'baseline',{imageId:'sha256:baseline',revision:'baseline-revision'},{inconclusiveCells:1});await assert.rejects(()=>beginArm(out,state,'baseline'),/seal|duplicate/);
 assert.ok(state.arms.baseline.seal.files.some(f=>f.path.endsWith('.failure.json')));
});
test('parallel collectors cannot begin the same arm, and shared review rows cannot replace its sealed scores',async t=>{
 const out=await fixture(t);const first=await openExecution(out,identity,{}),second=await openExecution(out,identity,{});await beginArm(out,first,'baseline');await assert.rejects(()=>beginArm(out,second,'baseline'),/collector|resume/);
 const row={arm:'baseline',caseId:'one',score:0.5};await fs.writeFile(path.join(out,'baseline-reviewed-observations.jsonl'),JSON.stringify(row)+'\n');await fs.writeFile(path.join(out,'reviewed-observations.jsonl'),JSON.stringify(row)+'\n');
 await sealArm(out,first,'baseline',{imageId:'sha256:baseline',revision:'baseline-revision'},{});
 await fs.writeFile(path.join(out,'reviewed-observations.jsonl'),JSON.stringify({...row,score:1})+'\n');await assert.rejects(()=>beginArm(out,first,'candidate'),/sealed observations/);
});
test('active runtime proof requires the exact real Docker image/revision and live collector configuration',()=>{
 const binding={dataDir:'/owned/baseline',runtimeEvidence:{revision:'baseline-revision',runtimeImageId:'sha256:baseline'}};
 const actual={Id:'sha256:baseline',Config:{Labels:{'org.opencontainers.image.revision':'baseline-revision'}}};
 const live=()=>({runtimeImage:'baseline:tag',dataDir:'/owned/baseline',processId:123});
 assert.equal(assertActiveRuntime(binding,()=>actual,live).imageId,actual.Id);
 assert.throws(()=>assertActiveRuntime(binding,()=>({...actual,Id:'sha256:candidate'}),live),/image/);
 assert.throws(()=>assertActiveRuntime(binding,()=>({...actual,Config:{Labels:{'org.opencontainers.image.revision':'other'}}}),live),/revision/);
 assert.throws(()=>assertActiveRuntime(binding,ref=>ref==='other:tag'?{...actual,Id:'sha256:other'}:actual,()=>({...live(),runtimeImage:'other:tag'})),/image/);
 assert.throws(()=>assertActiveRuntime(binding,()=>actual,()=>({...live(),dataDir:'/other-arm'})),/data|identity/);
});
