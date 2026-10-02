import assert from 'node:assert/strict';
import test from 'node:test';
import {ExtensionToolController} from '../src/extensionToolController.mjs';

test('controller accepts no caller-selected execution authority and unsupported descriptors stay unsupported',async()=>{
  const controller=new ExtensionToolController({admittedDescriptors:[],stateRoot:'/tmp/unused-extension-controller',adapterRoot:'/tmp/unused-adapter',inputRoot:'/tmp/unused-input'});
  await assert.rejects(controller.prepare({descriptorId:'unknown',identity:{},imageId:'forged'}),{code:'extension_contract_invalid'});
  await assert.rejects(controller.prepare({descriptorId:'unknown',identity:{}}),{code:'extension_contract_invalid'});
  await assert.rejects(controller.execute({descriptorId:'unknown',operationId:'owned',request:{operation:'doc_read',resourceId:'opaque'},env:{}}),{code:'extension_contract_invalid'});
});
