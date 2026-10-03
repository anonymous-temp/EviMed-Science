import assert from 'node:assert/strict';
import test from 'node:test';
import {ExtensionToolController,extensionExecutionIdentity} from '../src/extensionToolController.mjs';
import {containedExtensionExecutionIdentity} from './helpers/containedExtensionFixture.mjs';

test('the actual Docker execution fixture carries current owner and membership identity before any image is required',()=>{
  const identity=containedExtensionExecutionIdentity({id:'fixture-descriptor',artifactDigest:'sha256:'+'b'.repeat(64)},1);
  assert.deepEqual(extensionExecutionIdentity(identity),identity);
  assert.equal(identity.ownerId,identity.userId);assert.equal(identity.ownerAccountCreatedAt,identity.accountCreatedAt);assert.equal(identity.membershipEpoch,null);
  const member={...identity,userId:'fixture-member',accountCreatedAt:'member-epoch',membershipEpoch:'current-membership-epoch'};
  assert.deepEqual(extensionExecutionIdentity(member),member);
  for(const key of ['ownerId','ownerAccountCreatedAt','membershipEpoch']){
    const missing={...identity};delete missing[key];assert.throws(()=>extensionExecutionIdentity(missing),{code:'extension_contract_invalid'});
  }
  assert.throws(()=>extensionExecutionIdentity({...identity,ownerId:''}),{code:'product_identifier_invalid'});
  for(const changed of [{ownerAccountCreatedAt:''},{membershipEpoch:undefined},{membershipEpoch:[]},{hostPath:'/private'}]){
    assert.throws(()=>extensionExecutionIdentity({...identity,...changed}),{code:'extension_contract_invalid'});
  }
});

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

test('volume-backed preparation projects verified bytes and refuses widened or mismatched mounts before executing',async()=>{
  const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path'),{createHash}=await import('node:crypto');
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'extension-volume-'))),inventory=Buffer.from('console.log("trusted inventory");');
  const descriptor={id:'fixture',imageId:'sha256:'+'b'.repeat(64),artifactDigest:'sha256:'+'c'.repeat(64),inventorySHA:createHash('sha256').update(inventory).digest('hex')};
  let createdArgs,scopeDirectory,executions=0,removed=0,widen=false;
  const controller=new ExtensionToolController({admittedDescriptors:[],stateRoot:path.join(root,'state'),dataDir:root,runtimeDataVolume:'owned-volume',adapterRoot:root,inputRoot:root});
  controller.command=async args=>{
    if(args[0]==='info')return{stdout:'29.2.0\n'};
    if(args[0]==='create'){
      createdArgs=args;scopeDirectory=path.join(root,'state',args[args.indexOf('--name')+1]);
      assert.deepEqual(await fs.readFile(path.join(scopeDirectory,'inventory.mjs')),inventory);
      assert.equal((await fs.stat(path.join(scopeDirectory,'inventory.mjs'))).mode&0o777,0o444);
      assert.equal(args.some(value=>value.startsWith('type=bind')),false);
      return{stdout:'a'.repeat(64)};
    }
    if(args[0]==='inspect')return{stdout:JSON.stringify({Id:'a'.repeat(64),Image:descriptor.imageId,HostConfig:{Mounts:[{Type:'volume',Source:'owned-volume',Target:'/proof',ReadOnly:true,VolumeOptions:{Subpath:widen?'state':path.relative(root,scopeDirectory)}}]}})};
    throw new Error('Unexpected Docker command');
  };
  controller.startContainer=async()=>{executions++;return'actual controlled child response';};
  controller.provePhysicalAbsence=async()=>{removed++;};
  try{
    assert.equal(await controller.run(descriptor,{jobId:'one'},{inventory,mounts:[],entrypoint:[],command:[]},null),'actual controlled child response');
    assert(createdArgs.includes(`type=volume,src=owned-volume,dst=/proof,volume-subpath=${path.relative(root,scopeDirectory)},readonly`));
    assert.equal(executions,1);assert.equal(removed,1);await assert.rejects(fs.stat(scopeDirectory),{code:'ENOENT'});
    widen=true;await assert.rejects(controller.run(descriptor,{jobId:'two'},{inventory,mounts:[],entrypoint:[],command:[]},null),{code:'product_state_unavailable',joined:true});
    assert.equal(executions,1);assert.equal(removed,2);
    assert.throws(()=>new ExtensionToolController({admittedDescriptors:[],stateRoot:'/outside',dataDir:root,runtimeDataVolume:'owned-volume',adapterRoot:root,inputRoot:root}),{code:'runtime_data_path_outside_volume'});
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
