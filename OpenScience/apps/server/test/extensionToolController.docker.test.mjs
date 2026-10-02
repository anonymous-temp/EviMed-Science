import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {before,after,test} from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {canonicalJson} from '@evimed/domain';
import {ExtensionToolController,extensionToolArtifactDigest} from '../src/extensionToolController.mjs';
import {createFixtures} from '../../../scripts/runtime/extensions/cowork/fixtures.mjs';
const image=process.env.COWORK_TEST_IMAGE??'',options={skip:!image&&'Immutable owned Cowork image is required'};
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../../'),adapter=path.join(root,'OpenScience/scripts/runtime/extensions/cowork');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');let directory,controller,descriptor,resources,inputRoot,stateRoot;
const identity={jobId:'fixture-job',leaseToken:'private-fixture-lease',attempts:1,installationId:'fixture-installation',installationRevision:1,accountCreatedAt:'2026-10-02',projectTarget:null};
before(async()=>{if(!image)return;const parent=path.join(root,'.evimed-local/extensions/build/fixtures');directory=await fs.mkdtemp(path.join(parent,'controller-'));inputRoot=path.join(directory,'public');stateRoot=path.join(directory,'controller');resources=await createFixtures(inputRoot);
  const closure=await fs.readFile(path.join(root,'.evimed-local/extensions/build/cowork-final-mode-20261002/context/dependency-closure.json'));
  descriptor={id:'cowork-portable',coordinate:{kind:'github',repository:'Jesse-njx/dsh-cowork',commit:'2ae5cf755c4294a1e988eebf3b12dd062425d84c'},integrity:'sha256:f9bae51a0c0c5858aedfa17fb2ba71f7d4db4c84b27ba959061cdaefd77fa95b',imageId:image,closureExpectedSHA:sha(closure),runnerSHA:sha(await fs.readFile(path.join(adapter,'runner.mjs'))),policySHA:sha(await fs.readFile(path.join(adapter,'policy.mjs'))),inventorySHA:sha(await fs.readFile(path.join(adapter,'image-inventory.mjs')))};
  descriptor.adapterDigest='sha256:'+sha(canonicalJson({runnerSHA:descriptor.runnerSHA,policySHA:descriptor.policySHA,inventorySHA:descriptor.inventorySHA}));descriptor.artifactDigest=extensionToolArtifactDigest(descriptor);
  controller=new ExtensionToolController({admittedDescriptors:[descriptor],stateRoot,adapterRoot:adapter,inputRoot,resolveOperation:async id=>id==='owned-operation'?{descriptorId:descriptor.id,artifactDigest:descriptor.artifactDigest}:null,resolveInputSnapshot:async(_id,resourceId)=>resources[resourceId]?{...resources[resourceId],filePath:path.join(inputRoot,resources[resourceId].file)}:null});
});
after(async()=>{if(directory)await fs.rm(directory,{recursive:true,force:true});});
test('actual controller independently inventories artifact, then reads Chinese DOCX and roundtrips XLSX',options,async()=>{
  const prepared=await controller.prepare({descriptorId:descriptor.id,identity});assert.equal(prepared.artifactDigest,descriptor.artifactDigest);assert.equal(prepared.qualified,false);
  const run=request=>controller.execute({descriptorId:descriptor.id,operationId:'owned-operation',request});
  const doc=await run({operation:'doc_read',resourceId:'res_docx'});assert(JSON.stringify(doc).includes('公开文档'));
  const written=await run({operation:'doc_write',targetId:'owned_target',format:'xlsx',spec:{kind:'create',sheets:[{name:'Public',cells:[{ref:'A1',value:'公开表格'}]}]}});
  const bytes=Buffer.from(written.data.contentBase64,'base64');await fs.writeFile(path.join(inputRoot,'created.xlsx'),bytes);resources.res_created={file:'created.xlsx',format:'xlsx',bytes:bytes.length,sha256:sha(bytes),dataClass:'aggregate'};
  assert(JSON.stringify(await run({operation:'doc_read',resourceId:'res_created'})).includes('公开表格'));
  assert.equal((await fs.readdir(stateRoot)).filter(name=>name.endsWith('.json')).length,0);
});
test('stale inputs, symlinks, private snapshots and unowned operations never execute',options,async()=>{
  const body={descriptorId:descriptor.id,operationId:'owned-operation',request:{operation:'doc_read',resourceId:'res_docx'}};
  resources.res_bad={...resources.res_docx,sha256:'a'.repeat(64)};await assert.rejects(controller.execute({...body,request:{...body.request,resourceId:'res_bad'}}));
  resources.res_private={...resources.res_docx,dataClass:'patient'};await assert.rejects(controller.execute({...body,request:{...body.request,resourceId:'res_private'}}));
  await fs.symlink('public.docx',path.join(inputRoot,'linked.docx'));resources.res_link={...resources.res_docx,file:'linked.docx'};await assert.rejects(controller.execute({...body,request:{...body.request,resourceId:'res_link'}}));
  await assert.rejects(controller.execute({...body,operationId:'foreign-operation'}));
});
test('actual running preparation cancel joins its owned process and proves physical absence before capacity release',options,async()=>{
  let entered;const start=new Promise(resolve=>{entered=resolve;});const original=controller.startContainer.bind(controller);let name;
  controller.startContainer=async(scope,...args)=>{name=scope.name;entered();return original(scope,...args);};
  const pending=controller.prepare({descriptorId:descriptor.id,identity:{...identity,jobId:'cancel-fixture'}});const rejected=assert.rejects(pending);await start;
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
