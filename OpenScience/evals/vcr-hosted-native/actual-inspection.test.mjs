import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { researchNativeReceiptDigest, researchNativeArtifactDigest } from '@evimed/domain';
import { ExtensionToolController } from '../../apps/server/src/extensionToolController.mjs';
import { attachNativePreparation } from '../../apps/server/src/controllerNativePreparation.mjs';
const enabled=process.env.VCR_NATIVE_REAL_IMAGE, options={skip:!enabled&&'Explicit isolated Docker test image required'};
const hash=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
test('real image inspector runs inside the leased controller sandbox', options, async()=>{
  const receipt=JSON.parse(await readFile(process.env.VCR_NATIVE_RECEIPT,'utf8'));
  const descriptor={...receipt,receiptDigest:researchNativeReceiptDigest(receipt,hash),adapterRevision:hash('test-adapter')};
  delete descriptor.schemaVersion; descriptor.artifactDigest=researchNativeArtifactDigest(descriptor,hash);
  const image=execFileSync('docker',['image','inspect','--format','{{.Id}}',enabled],{encoding:'utf8'}).trim();
  const root=await mkdtemp(path.join(tmpdir(),'native-inspect-'));
  const tools=new ExtensionToolController({admittedDescriptors:[],stateRoot:root,adapterRoot:root,inputRoot:root});
  let checks=0;attachNativePreparation(tools,{nativeBundles:[descriptor],imageId:async()=>image,resolvePreparation:async(identity,descriptor)=>{checks++;return{identity,descriptorId:descriptor.id,artifactDigest:descriptor.artifactDigest};}});
  const identity={jobId:'actualtest',leaseToken:'lease1',attempts:1,installationId:'install1',installationRevision:1,accountCreatedAt:'test',projectTarget:null};
  try {const result=await tools.prepare({descriptorId:receipt.id,identity});assert.equal(result.imageId,image);assert.equal(result.receiptDigest,descriptor.receiptDigest);assert.equal(checks,2);}
  finally {await tools.close();await rm(root,{recursive:true,force:true});}
});
