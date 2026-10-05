import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createEvolutionCandidateEvaluator} from '../src/evolutionCandidateEvaluator.mjs';
import {createEvolutionEngineReviewWriter} from '../src/evolutionEngineReview.mjs';
import {createEvolutionWorkflowSmoke} from '../src/evolutionWorkflowSmoke.mjs';
test('script-free workflows require real independent tool receipts and frozen output checks',async()=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'workflow-smoke-'));
 try{
 await mkdir(path.join(dataDir,'paper-gold/candidate-cases'),{recursive:true});
 await writeFile(path.join(dataDir,'paper-gold/candidate-cases/workflow.json'),JSON.stringify({methodId:'workflow',frozen:true,cases:[{id:'smoke',kind:'workflow-smoke',hidden:true,independentQa:{passed:true},sourceHash:'a'.repeat(64),input:{x:1},numeric:{value:{value:3,absoluteTolerance:0}}}]}));
 const candidate={id:'workflow',toolKind:'workflow',files:{'SKILL.md':'Use existing tool.'},executionTools:['research_calculate']};
 const deps={config:{dataDir,evaluationDataDir:dataDir},controller:{execVerify:async()=>{throw new Error('Python must not execute');}}};
 assert.equal((await createEvolutionCandidateEvaluator(deps).evaluate(candidate)).status,'waiting_resource');
 let calls=0;
 let receipt={independent:true,executed:true,runId:'actual-run',toolsCalled:['research_calculate'],output:{value:3}};
 const evaluator=createEvolutionCandidateEvaluator({...deps,evaluateWorkflowSmoke:async input=>{calls++;assert.equal(input.replicate,0);assert.equal(input.caseId,'smoke');assert.equal(input.numeric,undefined);return receipt;}});
 assert.equal((await evaluator.evaluate(candidate)).smokePassed,true);assert.equal(calls,1);
 receipt={...receipt,output:{value:4}};assert.equal((await evaluator.evaluate(candidate)).ok,false);
 receipt={...receipt,runId:null};assert.equal((await evaluator.evaluate(candidate)).status,'waiting_resource');
 receipt={...receipt,runId:'actual-run',output:{value:3},toolsCalled:[]};assert.equal((await evaluator.evaluate(candidate)).ok,false);
 }finally{await rm(dataDir,{recursive:true,force:true});}
});
test('new capability PR input checks required artifacts and returns a durable discoverable descriptor',async()=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'capability-review-'));
 try{
 const write=createEvolutionEngineReviewWriter({dataDir}),card={id:'card',form:'new-capability'},candidate={id:'new',files:{'capability.yaml':(await readFile(new URL('../../../capabilities/tool-builder/capability.yaml',import.meta.url),'utf8')).replace('id: tool-builder','id: new')+'\ndisplay:\n  listed: false\n  title: New\n  category: Research\n  description: New research workflow\n  starterPrompts: [Run the workflow]\n  outputs: [Result]\n  estimatedMinutes: {min: 1, max: 30}\n','SKILL.md':'Do the research.','contracts/output.json':'{}','task-briefs/a.md':'Task A','task-briefs/b.md':'Task B','task-briefs/c.md':'Task C'}};
 const result=await write({card,candidate,digest:'sha256:abc'});assert.equal(result.capabilityId,'new');assert.equal(result.form,'new-capability');assert.match(result.relativeDirectory,/evolution-engine-review/);
 for(const missing of ['SKILL.md','contracts/output.json','task-briefs/c.md']){const changed=structuredClone(candidate);delete changed.files[missing];await assert.rejects(write({card,candidate:changed,digest:'sha256:abc'}));}
 const pending=structuredClone(candidate);pending.files['capability.yaml']=pending.files['capability.yaml'].replace('contractKind: evolution-tool-candidate','contractKind: future-research-package');pending.files['contracts/future-research-package.json']='{}';assert.equal((await write({card,candidate:pending,digest:'sha256:abc'})).diagnostics[0].code,'pending-domain-registration');delete pending.files['contracts/future-research-package.json'];await assert.rejects(write({card,candidate:pending,digest:'sha256:abc'}));
 const listed=structuredClone(candidate);listed.files['capability.yaml']='id: new\ndisplay:\n  listed: true\n';await assert.rejects(write({card,candidate:listed,digest:'sha256:abc'}));
 }finally{await rm(dataDir,{recursive:true,force:true});}
});

test('workflow execution receipt uses actual completed tools rather than candidate-declared success',async()=>{
 let messages=[];
 const candidate={track:'M',files:{'SKILL.md':'Use the existing calculator.'},executionTools:['research_calculate']};
 const run=createEvolutionWorkflowSmoke({service:{owner:async()=> 'operator'},store:{userById:async()=>({id:'operator'}),requireProject:async()=>({id:'project'})},
  runs:{execute:async request=>{assert.ok(!request.brief.includes('goldAnswers'));return{run:{id:'run',status:'succeeded'},output:{workflowOutput:{value:3},executed:true}};}},
  readTranscript:async()=>({header:{completeness:'complete'},messages})});
 const input={candidate,input:{x:1},caseId:'smoke',methodId:'workflow'};
 assert.equal((await run(input)).executed,false);
 messages=[{parts:[{type:'tool',tool:'mcp__evimed__research_calculate',status:'completed',output:JSON.stringify({ok:true,data:{value:3}})}]}];
 const passed=await run(input);assert.equal(passed.executed,true);assert.deepEqual(passed.toolsCalled,['research_calculate']);
 for(const output of [JSON.stringify({status:'error',data:null,artifacts:[]}),JSON.stringify({ok:false,error:{code:'unsupported'}}),'failed: unsupported']){
 messages=[{parts:[{type:'tool',tool:'mcp__evimed__research_calculate',status:'completed',output}]}];
 assert.equal((await run(input)).executed,false);
 }
 for(const output of [JSON.stringify({status:'ok',data:{value:3},artifacts:[]}),'ok\n'+JSON.stringify({value:3})]){
 messages=[{parts:[{type:'tool',tool:'mcp__evimed__research_calculate',status:'completed',output}]}];
 assert.equal((await run(input)).executed,true);
 }
});
