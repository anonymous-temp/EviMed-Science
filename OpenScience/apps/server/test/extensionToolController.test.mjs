import assert from 'node:assert/strict';
import test from 'node:test';
import {ExtensionToolController} from '../src/extensionToolController.mjs';

test('controller accepts no caller-selected execution authority and unsupported descriptors stay unsupported',async()=>{
  const controller=new ExtensionToolController({admittedDescriptors:[],stateRoot:'/tmp/unused-extension-controller',adapterRoot:'/tmp/unused-adapter',inputRoot:'/tmp/unused-input'});
  await assert.rejects(controller.prepare({descriptorId:'unknown',identity:{},imageId:'forged'}),{code:'extension_contract_invalid'});
  await assert.rejects(controller.prepare({descriptorId:'unknown',identity:{}}),{code:'extension_contract_invalid'});
  await assert.rejects(controller.execute({descriptorId:'unknown',operationId:'owned',request:{operation:'doc_read',resourceId:'opaque'},env:{}}),{code:'extension_contract_invalid'});
});

test('operation authority must bind the selected admitted descriptor and artifact at dispatch and hydration',async()=>{
  const selected={id:'fixture-b',artifactDigest:`sha256:${'b'.repeat(64)}`};
  let scope={descriptorId:'fixture-a',artifactDigest:`sha256:${'a'.repeat(64)}`};
  const controller=new ExtensionToolController({admittedDescriptors:[],stateRoot:'/tmp/unused-extension-controller',adapterRoot:'/tmp/unused-adapter',inputRoot:'/tmp/unused-input',
    resolveOperation:async(_id,_request,expected)=>{assert.deepEqual(expected,{descriptorId:selected.id,artifactDigest:selected.artifactDigest});return scope;}});
  await assert.rejects(controller.authorizeOperation(selected,'owned',{operation:'doc_write'}),{code:'extension_contract_invalid'});
  scope={descriptorId:selected.id,artifactDigest:`sha256:${'a'.repeat(64)}`};
  await assert.rejects(controller.authorizeOperation(selected,'owned',{operation:'doc_write'}),{code:'extension_contract_invalid'});
  scope={descriptorId:selected.id,artifactDigest:selected.artifactDigest};
  await controller.authorizeOperation(selected,'owned',{operation:'doc_write'});
  controller.resolveOperation=async()=>true;
  await assert.rejects(controller.authorizeOperation(selected,'owned',{operation:'doc_write'}),{code:'extension_contract_invalid'});
});
