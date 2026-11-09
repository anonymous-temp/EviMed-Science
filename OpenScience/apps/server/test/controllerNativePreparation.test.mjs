import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { RESEARCH_NATIVE_BUNDLES, researchNativeReceiptDigest, researchNativeArtifactDigest } from '@evimed/domain';
import { attachNativePreparation } from '../src/controllerNativePreparation.mjs';
const digest = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const identity = {jobId:'job1',leaseToken:'lease1',attempts:1,installationId:'install1',installationRevision:1,accountCreatedAt:'epoch',projectTarget:null};
const id='virtual-trial', spec=RESEARCH_NATIVE_BUNDLES[id];
const receipt={schemaVersion:1,id,coordinate:{kind:'npm',name:spec.name,version:'0.1.0'},integrity:digest('package'),closureDigest:digest('closure'),row:spec.row,tools:[...spec.tools]};
const descriptor={...receipt,receiptDigest:researchNativeReceiptDigest(receipt,digest),adapterRevision:digest('adapter')};
descriptor.artifactDigest=researchNativeArtifactDigest(descriptor,digest);
const image=digest('image');
test('native inspection uses fixed command, immutable image and rechecks lease',async()=>{
  let count=0,observed;
  const tools={prepare:async()=>({isolated:true}),run:async (...args)=>{observed=args;return JSON.stringify(receipt);}};
  attachNativePreparation(tools,{nativeBundles:[descriptor],imageId:async()=>image,resolvePreparation:async (identity,descriptor)=>{count++;return{identity,descriptorId:descriptor.id,artifactDigest:descriptor.artifactDigest};}});
  const result=await tools.prepare({descriptorId:id,identity});
  assert.equal(count,2);assert.equal(result.imageId,image);assert.equal(result.receiptDigest,descriptor.receiptDigest);
  assert.equal(observed[0].imageId,image);assert.deepEqual(observed[2].command,['/usr/local/bin/evimed-research-bundles.mjs','inspect',id]);
  assert.deepEqual(await tools.prepare({descriptorId:'isolated',identity}),{isolated:true});
});
test('native inspection rejects changed receipt, image and lease',async()=>{
  for(const fault of ['receipt','image','lease']){
    let calls=0;const tools={prepare:async()=>{},run:async()=>JSON.stringify(fault==='receipt'?{...receipt,row:'forged'}:receipt)};
    attachNativePreparation(tools,{nativeBundles:[descriptor],imageId:async()=>fault==='image'&&++calls>1?digest('other'):image,resolvePreparation:async (identity,descriptor)=>fault==='lease'&&++calls>1?null:{identity,descriptorId:descriptor.id,artifactDigest:descriptor.artifactDigest}});
    await assert.rejects(tools.prepare({descriptorId:id,identity}));
  }
});
