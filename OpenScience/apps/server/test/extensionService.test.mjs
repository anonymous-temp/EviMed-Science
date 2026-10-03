import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {ExtensionService} from '../src/extensionService.mjs';
import {EXTENSION_SAAS_CASE_IDS,extensionProofDigest} from '@evimed/domain';

const hash=value=>createHash('sha256').update(value).digest('hex'),digest=value=>`sha256:${hash(value)}`;
const entry={id:'csv',title:'CSV',coordinate:{kind:'npm',name:'example-csv',version:'1.0.0'},executionClass:'isolated-tool',integrity:digest('package'),settingsSchema:{}};
test('catalogue flags and package health are not trusted qualification',async()=>{
  const service=new ExtensionService({}, {catalogue:[{...entry,qualified:true,evidenceState:'saas-qualified',health:{ok:true}}]});
  assert.equal((await service.catalogue()).items[0].evidenceState,'source-assessed');
  assert.throws(()=>new ExtensionService({}, {catalogue:[{...entry,settingsSchema:{apiKey:{type:'string'}}}]}),{status:400});
  assert.throws(()=>service.settings(entry,{url:'http://127.0.0.1'}),{status:400});
});
test('qualification requires current external identity and exact artifact rather than stale catalogue pins',async()=>{
  const identity={packageIntegrity:entry.integrity,sourceCommit:null,adapterRevision:digest('adapter'),dshVersion:'0.1.7-rc.2',
    runtimeImageDigest:digest('image'),executionClass:'isolated-tool',permissionProfileRevision:digest('permission'),suiteRevision:digest('suite')};
  const receipt={schemaVersion:1,identity,cases:EXTENSION_SAAS_CASE_IDS.map(caseId=>({caseId,status:'pass',observationDigests:[digest(caseId)],artifactDigests:[]})),receiptDigest:''};
  receipt.receiptDigest=extensionProofDigest(receipt,hash);
  const authority={trustedReceiptDigests:new Set([receipt.receiptDigest]),trustedSurfaces:{client:false,browser:false,externalActions:false,descriptorDigest:digest('descriptor')}};
  let currentIdentity={...identity};
  const service=new ExtensionService({}, {catalogue:[entry],proofAuthority:async()=>({receipt,authority,currentIdentity})});
  assert.equal((await service.catalogue()).items[0].evidenceState,'saas-qualified');
  currentIdentity={...identity,runtimeImageDigest:digest('changed-image')};
  assert.equal((await service.catalogue()).items[0].evidenceState,'source-assessed');
  currentIdentity={...identity,packageIntegrity:digest('foreign-package')};
  assert.equal((await service.catalogue()).items[0].evidenceState,'source-assessed');
});
