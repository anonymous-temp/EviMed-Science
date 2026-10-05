import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {waitPaperGoldTranscript,readPaperGoldArtifacts,paperGoldTraceCoverage} from '../src/paperGoldEvaluator.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
test('terminal sealing race waits for exact-run complete durable evidence; partial timeout and abort stay honest',async()=>{
 let reads=0;const complete={header:{runId:'run',completeness:'complete',missing:[]},messages:[]};
 const result=await waitPaperGoldTranscript({project:{},runId:'run',timeoutMs:100,pollMs:1,read:async()=>++reads===1?{header:{runId:'run',completeness:'partial'}}:complete});assert.equal(result.complete,true);assert.equal(reads,2);
 for(const transcript of [{header:{runId:'other',completeness:'complete'}},{header:{runId:'run',completeness:'complete',missing:[{reason:'corrupt'}]}},null]){const timed=await waitPaperGoldTranscript({project:{},runId:'run',timeoutMs:2,pollMs:1,read:async()=>transcript});assert.equal(timed.complete,false);}
 const abort=new AbortController();abort.abort();await assert.rejects(waitPaperGoldTranscript({project:{},runId:'run',signal:abort.signal}),{name:'AbortError'});
});
test('missing/changed/wrong-run producer artifacts and malformed JSON are unit gaps, not whole-cycle exceptions',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'paper-capture-')),project={workspaceDir:dir},run={id:'run',artifacts:['numeric.json','code.py','missing.json','invalid.json']};
 try{
  const good='{"ROR":2,"deterministicChecks":[{"id":"fake","valid":true}]}';await fs.writeFile(path.join(dir,'numeric.json'),good);await fs.writeFile(path.join(dir,'code.py'),'changed code');await fs.writeFile(path.join(dir,'invalid.json'),'{broken');
  const receipt={runId:'run',entries:[{files:[{path:'numeric.json',sha256:sha(good)},{path:'code.py',sha256:sha('old code')},{path:'invalid.json',sha256:sha('{broken')}]}]};
  const result=await readPaperGoldArtifacts({project,run,receipt});assert.equal(result.numeric.ROR,2);assert.ok(!('checks' in result));assert.equal(result.issues.length,3);assert.ok(!result.deliveredText.some(x=>x.path==='code.py'));
  const wrong=await readPaperGoldArtifacts({project,run,receipt:{...receipt,runId:'other'}});assert.deepEqual(wrong.numeric,{});assert.deepEqual(wrong.deliveredText,[]);
  const unavailable=await readPaperGoldArtifacts({project,run:{id:'unsupported',artifacts:[]},receipt:null});assert.deepEqual(unavailable.numeric,{});
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('complete DSH transcript cannot certify unmanaged specialist egress; capabilities listing alone is discovery',()=>{
 const transcript=action=>({messages:[{parts:[{type:'tool',tool:'mcp__evimed__meta_analysis',input:{action},status:'completed'}]}]});
 assert.equal(paperGoldTraceCoverage(transcript('capabilities')).complete,true);
 for(const action of ['start','status']){const actual=paperGoldTraceCoverage(transcript(action));assert.equal(actual.complete,false);assert.deepEqual(actual.unobservedTools,['meta_analysis']);}
 assert.equal(paperGoldTraceCoverage({messages:[{parts:[{type:'text',text:'meta_analysis start'}]}]}).complete,true);
});
