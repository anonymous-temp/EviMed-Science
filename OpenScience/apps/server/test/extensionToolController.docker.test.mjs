import {containedExtensionDescriptor} from './helpers/containedExtensionFixture.mjs';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {before,after,test} from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {canonicalJson} from '@evimed/domain';
import {ExtensionToolController} from '../src/extensionToolController.mjs';
import {createFixtures} from '../../../scripts/runtime/extensions/cowork/fixtures.mjs';
let image=process.env.COWORK_TEST_IMAGE??'';
const options={skip:!image&&!process.env.EVIMED_EXTENSION_ACCEPTANCE_INPUTS&&'Immutable owned Cowork image is required'};
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../../'),adapter=path.join(root,'OpenScience/scripts/runtime/extensions/cowork');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');let directory,controller,descriptor,resources,inputRoot,stateRoot;
let operationSequence=0;
const executionIdentity=()=>({jobId:'operation-'+(++operationSequence),leaseToken:'fixture-execution-lease',attempts:1,operationId:'owned-operation',userId:'fixture-owner',ownerId:'fixture-owner',ownerAccountCreatedAt:'2026-10-02',membershipEpoch:null,projectId:'fixture-project',accountCreatedAt:'2026-10-02',projectCreatedAt:'2026-10-02',runtimeGeneration:'runtime-fixture',extensionGenerationHash:'a'.repeat(64),descriptorId:descriptor.id,artifactDigest:descriptor.artifactDigest,installationId:'fixture-installation',installationRevision:1});
const identity={jobId:'fixture-job',leaseToken:'private-fixture-lease',attempts:1,installationId:'fixture-installation',installationRevision:1,accountCreatedAt:'2026-10-02',projectTarget:null};
before(async()=>{if(options.skip)return;const parent=path.join(root,'.evimed-local/extensions/build/fixtures');await fs.mkdir(parent,{recursive:true});directory=await fs.realpath(await fs.mkdtemp(path.join(parent,'controller-')));inputRoot=path.join(directory,'public');stateRoot=path.join(directory,'controller');resources=await createFixtures(inputRoot);
  descriptor=await containedExtensionDescriptor();image=descriptor.imageId;
  controller=new ExtensionToolController({admittedDescriptors:[descriptor],stateRoot,adapterRoot:adapter,inputRoot,resolvePreparation:async(identity,descriptor)=>({identity,descriptorId:descriptor.id,artifactDigest:descriptor.artifactDigest}),resolveOperation:async id=>id==='owned-operation'?{descriptorId:descriptor.id,artifactDigest:descriptor.artifactDigest}:null,resolveInputSnapshot:async(_id,resourceId)=>resources[resourceId]?{...resources[resourceId],filePath:path.join(inputRoot,resources[resourceId].file)}:null});
});
after(async()=>{if(directory)await fs.rm(directory,{recursive:true,force:true});});
test('actual controller independently inventories artifact, then reads Chinese DOCX and roundtrips XLSX',options,async()=>{
  const prepared=await controller.prepare({descriptorId:descriptor.id,identity});assert.equal(prepared.artifactDigest,descriptor.artifactDigest);assert.equal(prepared.qualified,false);
  const run=request=>controller.execute({descriptorId:descriptor.id,operationId:'owned-operation',request,identity:executionIdentity()});
  const doc=await run({operation:'doc_read',resourceId:'res_docx'});assert(JSON.stringify(doc).includes('公开文档'));
  const written=await run({operation:'doc_write',targetId:'owned_target',format:'xlsx',spec:{kind:'create',sheets:[{name:'Public',cells:[{ref:'A1',value:'公开表格'}]}]}});
  const bytes=Buffer.from(written.data.contentBase64,'base64');await fs.writeFile(path.join(inputRoot,'created.xlsx'),bytes);resources.res_created={file:'created.xlsx',format:'xlsx',bytes:bytes.length,sha256:sha(bytes),dataClass:'aggregate'};
  assert(JSON.stringify(await run({operation:'doc_read',resourceId:'res_created'})).includes('公开表格'));
  assert.equal((await fs.readdir(stateRoot)).filter(name=>name.endsWith('.json')).length,0);
});
test('stale inputs, symlinks, private snapshots and unowned operations never execute',options,async()=>{
  const body={descriptorId:descriptor.id,operationId:'owned-operation',request:{operation:'doc_read',resourceId:'res_docx'},identity:executionIdentity()};
  resources.res_bad={...resources.res_docx,sha256:'a'.repeat(64)};await assert.rejects(controller.execute({...body,request:{...body.request,resourceId:'res_bad'}}));
  resources.res_private={...resources.res_docx,dataClass:'patient'};await assert.rejects(controller.execute({...body,request:{...body.request,resourceId:'res_private'}}));
  await fs.symlink('public.docx',path.join(inputRoot,'linked.docx'));resources.res_link={...resources.res_docx,file:'linked.docx'};await assert.rejects(controller.execute({...body,request:{...body.request,resourceId:'res_link'}}));
  await assert.rejects(controller.execute({...body,operationId:'foreign-operation'}));
});
test('actual running preparation cancel joins its owned process and proves physical absence before capacity release',options,async()=>{
  let entered;const start=new Promise(resolve=>{entered=resolve;});const original=controller.startContainer.bind(controller);let name;
  controller.startContainer=async(scope,...args)=>{name=scope.name;entered();return original(scope,...args);};
  const pending=controller.prepare({descriptorId:descriptor.id,identity:{...identity,jobId:'cancel-fixture'}});const rejected=assert.rejects(pending);await start;
  await assert.rejects(controller.prepare({descriptorId:descriptor.id,identity:{...identity,jobId:'cancel-fixture',leaseToken:'replacement-lease',attempts:2}}),{status:503});
  await assert.rejects(controller.cancelPreparation({...identity,jobId:'cancel-fixture',leaseToken:'replacement-lease',attempts:2}),{status:503});
  const ack=await controller.cancelPreparation({...identity,jobId:'cancel-fixture'});await rejected;assert.equal(ack.settled,true);
  assert.throws(()=>execFileSync('docker',['inspect',name],{stdio:'ignore'}));assert.equal(await controller.admissionAvailable(),true);controller.startContainer=original;
});
test('restart with an unknown capacity marker fails closed without killing an unrelated container',options,async()=>{
  await fs.writeFile(path.join(stateRoot,'unknown.json'),JSON.stringify({state:'unknown'}));assert.equal(await controller.admissionAvailable(),false);
  await assert.rejects(controller.prepare({descriptorId:descriptor.id,identity}),{status:503});await fs.unlink(path.join(stateRoot,'unknown.json'));
});

test('finite actual preparation timeout joins the process and retains no reusable unknown scope',options,async()=>{
  controller.timeoutMs=100;
  try{await assert.rejects(controller.prepare({descriptorId:descriptor.id,identity:{...identity,jobId:'timeout-fixture'}}));
    assert.equal((await fs.readdir(stateRoot)).filter(name=>name.endsWith('.json')).length,0);assert.equal(await controller.admissionAvailable(),true);
  }finally{controller.timeoutMs=15000;}
});

test('a replacement reusing an owned container name is never removed or canceled',options,async()=>{
  const original=controller.startContainer.bind(controller);let replacement;
  controller.startContainer=async(scope,...args)=>{
    execFileSync('docker',['rm','-f',scope.containerId],{stdio:'ignore'});
    replacement=execFileSync('docker',['create','--name',scope.name,'--label','com.evimed.extension-tool=replacement','--network','none','--read-only','--entrypoint','node',image,'-e','process.exit(0)'],{encoding:'utf8'}).trim();
    return original(scope,...args);
  };
  try{await assert.rejects(controller.prepare({descriptorId:descriptor.id,identity:{...identity,jobId:'replacement-fixture'}}));
    assert.equal(execFileSync('docker',['inspect','--format','{{.Id}}',replacement],{encoding:'utf8'}).trim(),replacement);assert.equal(await controller.admissionAvailable(),true);
  }finally{controller.startContainer=original;if(replacement)execFileSync('docker',['rm','-f',replacement],{stdio:'ignore'});}
});

test('uncertain cleanup retains a durable capacity tombstone and cannot acknowledge a joined cancellation',options,async()=>{
  const original=controller.command.bind(controller);controller.command=async(args,...rest)=>{if(args[0]==='rm')throw Object.assign(new Error('Fixture transport interruption'),{status:503});return original(args,...rest);};
  try{await assert.rejects(controller.prepare({descriptorId:descriptor.id,identity:{...identity,jobId:'unknown-cleanup-fixture'}}),{joined:false});assert.equal(await controller.admissionAvailable(),false);
    const markers=(await fs.readdir(stateRoot)).filter(name=>name.endsWith('.json'));assert.equal(markers.length,1);const stored=JSON.parse(await fs.readFile(path.join(stateRoot,markers[0]),'utf8'));assert.equal(stored.state,'unknown');assert.match(stored.containerId,/^[a-f0-9]{64}$/);
    await assert.rejects(controller.cancelPreparation({...identity,jobId:'unknown-cleanup-fixture'}),{status:503});
  }finally{controller.command=original;for(const name of (await fs.readdir(stateRoot)).filter(name=>name.endsWith('.json'))){const record=JSON.parse(await fs.readFile(path.join(stateRoot,name),'utf8'));await controller.remove({...record,marker:path.join(stateRoot,name),directory:path.join(stateRoot,record.name)});}controller.blocked=false;}
});

test('cold controller inventories the exact artifact before execution and persists joined status across restart',options,async()=>{
  const create=()=>new ExtensionToolController({admittedDescriptors:[descriptor],stateRoot,adapterRoot:adapter,inputRoot,resolveOperation:controller.resolveOperation,resolveInputSnapshot:controller.resolveInputSnapshot});
  const cold=create(),identity=executionIdentity();const result=await cold.execute({descriptorId:descriptor.id,operationId:identity.operationId,request:{operation:'doc_read',resourceId:'res_docx'},identity});
  assert.equal(result.joined,true);assert.equal(result.physicallyAbsent,true);assert.deepEqual(result.identity,identity);
  const restarted=create();const status=await restarted.executionStatus(identity);assert.equal(status.state,'absent');assert.equal(status.joined,true);
  assert.equal((await restarted.cancelExecution(identity)).physicallyAbsent,true);
});
test('an acknowledged early cancellation tombstone refuses later execution of that exact attempt',options,async()=>{
  const identity=executionIdentity();assert.equal((await controller.cancelExecution(identity)).joined,true);
  await assert.rejects(controller.execute({descriptorId:descriptor.id,operationId:identity.operationId,request:{operation:'doc_read',resourceId:'res_docx'},identity}));
  assert.equal((await controller.executionStatus({...identity,leaseToken:'other-lease'})).state,'unknown');
});
test('actual execution cancellation joins its process and preserves exact attempt status',options,async()=>{
  let entered;const entry=new Promise(resolve=>{entered=resolve;});const original=controller.startContainer.bind(controller);const identity=executionIdentity();let id;
  controller.startContainer=async(scope,...args)=>{id=scope.containerId;entered();return original(scope,...args);};
  try{const pending=controller.execute({descriptorId:descriptor.id,operationId:identity.operationId,request:{operation:'doc_read',resourceId:'res_docx'},identity});const rejection=assert.rejects(pending);await entry;
    const ack=await controller.cancelExecution(identity);await rejection;assert.equal(ack.joined,true);assert.deepEqual(ack.identity,identity);assert.throws(()=>execFileSync('docker',['inspect',id],{stdio:'ignore'}));
  }finally{controller.startContainer=original;}
});

test('real Unix protocol carries execute/status/cancel bound to the actual Docker attempt',options,async()=>{
  const {createRuntimeController}=await import('../src/runtimeControllerServer.mjs');const {RuntimeControllerClient}=await import('../src/runtimeControllerClient.mjs');
  const socketRoot=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'xt-')));const tools=new ExtensionToolController({admittedDescriptors:[descriptor],stateRoot,adapterRoot:adapter,inputRoot,resolveOperation:controller.resolveOperation,resolveInputSnapshot:controller.resolveInputSnapshot});
  const config={dataDir:directory,runtimeControllerSocket:socketRoot+'/controller.sock',runtimeContainerImage:image};const server=createRuntimeController(config,{extensionTools:tools});
  try{await server.listen();const client=new RuntimeControllerClient(config),identity=executionIdentity();
    const result=await client.execute({descriptorId:descriptor.id,operationId:identity.operationId,request:{operation:'doc_read',resourceId:'res_docx'},identity});
    assert.equal(result.ok,true);assert.equal(result.joined,true);assert(JSON.stringify(result.data).includes('公开文档'));
    assert.equal((await client.executionStatus(identity)).state,'absent');assert.deepEqual((await client.cancelExecution(identity)).identity,identity);
    assert.equal((await client.extensionToolAdmission()).available,true);assert.equal(await client.admissionAvailable(),true);
    await assert.rejects(client.execute({...{descriptorId:descriptor.id,operationId:identity.operationId,request:{operation:'doc_read',resourceId:'res_docx'},identity},path:'/private-input'}),{code:'extension_contract_invalid',joined:true});
  }finally{await server.close();await fs.rm(socketRoot,{recursive:true,force:true});}
});

test('restart cancellation cannot acknowledge a new lease while the original immutable attempt remains physically live',options,async()=>{
  const originalIdentity={...identity,jobId:'restart-same-job'},replacementIdentity={...originalIdentity,leaseToken:'new-private-lease',attempts:2};
  const name='evimed-extension-tool-'+randomUUID(),directory=path.join(stateRoot,name),marker=directory+'.json';let containerId;
  try{await fs.mkdir(directory,{mode:0o755});containerId=execFileSync('docker',['run','-d','--pull','never','--name',name,'--label','com.evimed.extension-tool=owned','--label','com.evimed.extension-scope='+name,'--label','com.evimed.extension-artifact='+descriptor.artifactDigest,'--label','com.evimed.extension-attempt='+sha(canonicalJson(originalIdentity)),'--network','none','--read-only','--user','10001:10001','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','128m','--pids-limit','32','--entrypoint','node',image,'-e','setInterval(()=>{},1000)'],{encoding:'utf8'}).trim();
    await fs.writeFile(marker,JSON.stringify({name,identity:originalIdentity,containerId,artifactDigest:descriptor.artifactDigest,state:'unknown'}),{mode:0o600});
    const restarted=new ExtensionToolController({admittedDescriptors:[descriptor],stateRoot,adapterRoot:adapter,inputRoot});
    // A cache written by the old false-ACK implementation must not hide the live original marker.
    await restarted.recordSettled(replacementIdentity);
    await assert.rejects(restarted.cancelPreparation(replacementIdentity),{status:503});assert.equal(execFileSync('docker',['inspect','--format','{{.Id}}',containerId],{encoding:'utf8'}).trim(),containerId);
    assert.equal((await restarted.cancelPreparation(originalIdentity)).joined,true);assert.throws(()=>execFileSync('docker',['inspect',containerId],{stdio:'ignore'}));assert.equal(await restarted.admissionAvailable(),true);
    assert.equal((await restarted.cancelPreparation(replacementIdentity)).physicallyAbsent,true);
  }finally{if(containerId)execFileSync('docker',['rm','-f',containerId],{stdio:'ignore'});await fs.rm(marker,{force:true});await fs.rm(directory,{recursive:true,force:true});}
});

test('preparation refuses missing/current-lease authority and protected GC independently requires immutable physical absence',options,async()=>{
  const guarded=new ExtensionToolController({admittedDescriptors:[descriptor],stateRoot,adapterRoot:adapter,inputRoot});
  await assert.rejects(guarded.prepare({descriptorId:descriptor.id,identity:{...identity,jobId:'unbound-prep'}}),{status:503});
  guarded.resolvePreparation=async(input,selected)=>({identity:{...input,leaseToken:'different-current-lease'},descriptorId:selected.id,artifactDigest:selected.artifactDigest});
  await assert.rejects(guarded.prepare({descriptorId:descriptor.id,identity:{...identity,jobId:'stale-prep'}}),{code:'extension_contract_invalid'});
  const attempt=executionIdentity();let id;
  try{id=execFileSync('docker',['run','-d','--pull','never','--network','none','--read-only','--user','10001:10001','--cap-drop','ALL','--memory','128m','--pids-limit','32','--entrypoint','node',image,'-e','setInterval(()=>{},1000)'],{encoding:'utf8'}).trim();
    await guarded.recordSettled(attempt,id);guarded.canRetireAttempt=async captured=>canonicalJson(captured)===canonicalJson(attempt);
    for(let i=0;i<4;i++)await guarded.gcSettled();assert(await guarded.receipt(attempt),'a terminal callback cannot retire a physically live ID');
    execFileSync('docker',['rm','-f',id],{stdio:'ignore'});for(let i=0;i<4;i++)await guarded.gcSettled();assert.equal(await guarded.receipt(attempt),null);
  }finally{if(id)execFileSync('docker',['rm','-f',id],{stdio:'ignore'});}
});
