import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRestoredIdentity, lifecycleEligibility, requiredNativeApis } from '../native_lifecycle.mjs';
test('restore requires exact original bytes/path/identity and a new restoration generation',()=>{
 const before={id:'src_same',payload:{logicalPath:'knowledge-base/notes/a.md',generation:2,fingerprint:{sha256:'abc'}}};
 assert.equal(assertRestoredIdentity(before,{id:'src_same',payload:{logicalPath:'knowledge-base/notes/a.md',generation:3,fingerprint:{sha256:'abc'}}}),true);
 for(const after of [{id:'src_new',payload:before.payload},{id:'src_same',payload:{...before.payload,generation:3,fingerprint:{sha256:'different'}}},{id:'src_same',payload:before.payload}])assert.throws(()=>assertRestoredIdentity(before,after),/restor/);
});
test('only real native proofs can qualify complete lifecycle results; mock HTTP remains ineligible',()=>{
 const rows=Array.from({length:30},(_,i)=>({caseId:String(i),status:'pass',nativeProof:i<7?{engine:true,runtime:true}:undefined}));
 assert.equal(lifecycleEligibility(rows,{runtimeMode:'mock',requiredNativeIds:rows.slice(0,7).map(r=>r.caseId)}),false);
 assert.equal(lifecycleEligibility(rows,{runtimeMode:'kernel',requiredNativeIds:rows.slice(0,7).map(r=>r.caseId)}),true);
 assert.equal(lifecycleEligibility(rows.map((r,i)=>i===0?{...r,status:'blocked'}:r),{runtimeMode:'kernel',requiredNativeIds:rows.slice(0,7).map(r=>r.caseId)}),false);
 assert.ok(requiredNativeApis.includes('/api/knowledge-pages/compile'));
 assert.ok(requiredNativeApis.includes('/api/agent-memory/v1/recall'));
});
test('native transcripts resolve from the project directory rather than workspace',async()=>{
 const {transcriptFile}=await import('../native_probe.mjs');
 assert.equal(transcriptFile({workspace:'/tmp/owned/project/workspace'},'run1'),'/tmp/owned/project/.openscience/transcripts/run1.jsonl');
});
