import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {validateExtensionGenerationReference} from '../src/extensionGenerationService.mjs';
const h=value=>createHash('sha256').update(value).digest('hex');
test('generation references resolve only opaque current owner/project coordinates',()=>{
  const project={userId:'owner',id:'project'},reference={ownerHash:h('owner'),projectHash:h('project'),generationHash:'a'.repeat(64)};
  assert.deepEqual(validateExtensionGenerationReference(project,reference),reference);
  for(const patch of [{ownerHash:h('other')},{projectHash:h('other')},{generationHash:'../outside'},{path:'/tmp/forged'}])assert.throws(()=>validateExtensionGenerationReference(project,{...reference,...patch}));
});

test('the generic worker handles only its explicit variant and never steals legacy citation jobs',async()=>{
  const {ExtensionGenerationWorker}=await import('../src/extensionGenerationWorker.mjs');
  const worker=new ExtensionGenerationWorker({service:{database:null,jobs:null},runtime:null,resolveProject:null,ledgerBusy:null});
  assert.equal(worker.canHandle({kind:'plugin-apply',payload:{revision:1}}),false);assert.equal(worker.canHandle({kind:'plugin-apply',payload:{variant:'extension-generation-v1'}}),true);
  await assert.rejects(worker.runClaimed({kind:'plugin-apply',payload:{revision:1}}),{code:'extension_contract_invalid'});
});
