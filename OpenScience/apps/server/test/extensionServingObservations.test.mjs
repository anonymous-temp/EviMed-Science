import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { assertConcealed, observationReport, runExtensionServingObservations } from '../../../scripts/ops/extension-serving-observations.mjs';
const revision='a'.repeat(40);
const manifest={source:{revision},app:{releaseId:'candidate'},runtime:{image:'runtime:exact',imageId:'sha256:'+'b'.repeat(64)},services:[{name:'result-replay',image:'replay:exact',imageId:'sha256:'+'c'.repeat(64)}]};
test('component report never promotes its ordinary actors or cases into serving qualification',()=>{
 const report=observationReport({sourceRevision:revision},[],[{id:'owned',headers:{cookie:'private'}}],[{caseId:'SAAS-01',actual:{measured:true}}]);
 assert.equal(report.qualified,false);assert.equal(report.complete22,false);assert.equal(JSON.stringify(report).includes('private'),false);
});
test('concealed foreign response cannot carry data or turn another refusal into hidden-read evidence',()=>{
 assertConcealed({status:404,body:{code:'not_found'}});
 assert.throws(()=>assertConcealed({status:403,body:{}}));assert.throws(()=>assertConcealed({status:404,body:{data:{owner:'foreign'}}}));
});
test('candidate mismatch is refused before registering new accounts',async t=>{
 const out=await fs.mkdtemp(path.join(os.tmpdir(),'extension-serving-test-'));t.after(()=>fs.rm(out,{recursive:true,force:true}));let calls=0;
 await assert.rejects(runExtensionServingObservations({base:'https://candidate.example',manifest,expectedRevision:revision,out,
  fetchImpl:async()=>{calls++;return new Response(JSON.stringify({data:{releaseId:'old'}}),{status:200,headers:{'content-type':'application/json'}});}}));
 assert.equal(calls,2);
});
test('synthetic auth canary leak aborts actual response observation without persisting the credential',async t=>{
 const out=await fs.mkdtemp(path.join(os.tmpdir(),'extension-serving-test-'));t.after(()=>fs.rm(out,{recursive:true,force:true}));let secret;
 const json=(data,extra={})=>new Response(JSON.stringify({data}),{status:200,headers:{'content-type':'application/json',...extra}});
 await assert.rejects(runExtensionServingObservations({base:'https://candidate.example',manifest,expectedRevision:revision,out,
  fetchImpl:async(url,options)=>{
   if(url.endsWith('/health'))return json({releaseId:'candidate'});
   if(url.endsWith('/ready'))return json({ok:true,checks:{release:{ok:true,releaseId:'candidate',revision:revision.slice(0,12)}}});
   if(url.endsWith('/register')){secret=JSON.parse(options.body).password;return new Response(JSON.stringify({data:{user:{id:'ordinary'},csrfToken:'csrf-synthetic-private'}}),{status:201,headers:{'set-cookie':'test=private; HttpOnly'}});}
   return json({operator:false,project:{id:'own'},unexpected:secret});
  }}),/credential leaked/);
 const evidence=await fs.readFile(path.join(out,'observations.json'),'utf8');assert.ok(secret);assert.equal(evidence.includes(secret),false);
});
