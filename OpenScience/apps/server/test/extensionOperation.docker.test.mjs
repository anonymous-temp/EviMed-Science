import {containedExtensionDescriptor} from './helpers/containedExtensionFixture.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import {createExtensionGatewayHandler} from '../src/extensionGateway.mjs';
import {callCoworkGateway} from '../../../packages/socket/extensions/cowork/bridge.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {ControlPlaneDatabase} from '../src/controlPlaneDatabase.mjs';
import {createGeoTestDatabase} from './helpers/geoTestDatabase.mjs';
import {ExtensionOperationService} from '../src/extensionOperationService.mjs';
import {ExtensionOperationWorker} from '../src/extensionOperationWorker.mjs';
import {ExtensionResourceResolver} from '../src/extensionResourceResolver.mjs';
import {ExtensionToolController} from '../src/extensionToolController.mjs';
import {createFixtures} from '../../../scripts/runtime/extensions/cowork/fixtures.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const image=process.env.COWORK_TEST_IMAGE;
test('one actual isolated PostgreSQL and admitted-image controller journey reads Chinese public DOCX and exports XLSX without vendor code on host',{skip:(!image&&!process.env.EVIMED_EXTENSION_ACCEPTANCE_INPUTS)||!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL,timeout:60000},async()=>{
 const repo=new URL('../../../../',import.meta.url).pathname;
 const base=path.join(repo,'.evimed-local/extensions/build/fixtures');await fs.mkdir(base,{recursive:true});const directory=await fs.realpath(await fs.mkdtemp(path.join(base,'hosted-operation-')));
 const isolated=await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL,'od');const db=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:1,databaseConnectionTimeoutMs:1000});let controller,service,httpServer,httpWorker;
 try{
  await db.migrate();await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('alice','Actual controller fixture','development')");await db.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES('alice','p','Portable operation',1048576)");
  const account=(await db.query("SELECT created_at::text AS epoch FROM evimed_control.users WHERE id='alice'")).rows[0].epoch,projectEpoch=(await db.query("SELECT created_at::text AS epoch FROM evimed_control.projects WHERE user_id='alice' AND id='p'")).rows[0].epoch;
  const publicRoot=path.join(directory,'public');const resources=await createFixtures(publicRoot),adapter=path.join(repo,'OpenScience/scripts/runtime/extensions/cowork');
  const descriptor=await containedExtensionDescriptor();
  const resolver=new ExtensionResourceResolver({lookupResource:async(_scope,id)=>resources[id]?{ownerId:'alice',projectId:'p',revision:1,relativePath:resources[id].file,format:resources[id].format,sha256:resources[id].sha256}:null,verifyProvenance:async()=>({revision:1,dataClass:'public'}),rootFor:async()=>publicRoot,lookupTarget:async(_scope,id)=>id==='owned_target'?{ownerId:'alice',projectId:'p',revision:1,relativePath:'exports/public.xlsx'}:null,maxProjectBytes:1048576});
  const scope={userId:'alice',projectId:'p',accountCreatedAt:account,projectCreatedAt:projectEpoch,runtimeGeneration:'fixture-runtime',extensionGenerationHash:'a'.repeat(64),descriptorId:descriptor.id,artifactDigest:descriptor.artifactDigest,installationId:'fixture-installation',installationRevision:1};
  const preparationIdentity={jobId:'preparation-fixture',leaseToken:'fixture-private-lease',attempts:1,installationId:'fixture-installation',installationRevision:1,accountCreatedAt:account,projectTarget:null};
  controller=new ExtensionToolController({admittedDescriptors:[descriptor],stateRoot:path.join(directory,'controller'),adapterRoot:adapter,inputRoot:path.join(directory,'.openscience/extension-operations'),
    resolvePreparation:async(identity,selected)=>{assert.deepEqual(identity,preparationIdentity);assert.equal(selected.id,descriptor.id);return{identity,descriptorId:selected.id,artifactDigest:selected.artifactDigest};},
    resolveOperation:(...args)=>service.resolveOperation(...args),resolveInputSnapshot:(...args)=>service.resolveInputSnapshot(...args)});
  service=new ExtensionOperationService({database:db,dataDir:directory,signingSecret:'test-only-purpose-bound-signing-secret-not-adoption',generations:{operationIdentity:async()=>scope},resolveInvocation:async(auth,_invocation,request)=>({userId:auth.userId,projectId:auth.projectId,runtimeGeneration:auth.runtimeGeneration,invocationId:typeof auth.invocation==='string'?JSON.parse(auth.invocation).callId:'fixture-'+request.operation,allowedOperations:[request.operation]}),resources:resolver,controller});
  // Authority above is an explicit fixture only. Image inventory and the leased execution are real; no SaaS qualification is asserted.
  await assert.rejects(controller.prepare({descriptorId:descriptor.id,identity:{...preparationIdentity,leaseToken:'foreign-attempt'}}));
  await controller.prepare({descriptorId:descriptor.id,identity:preparationIdentity});
  const auth={userId:'alice',projectId:'p',runtimeGeneration:'fixture-runtime',invocation:{fixture:true}},worker=new ExtensionOperationWorker({service});
  const read=await service.submit(auth,{descriptorId:descriptor.id,idempotencyKey:'read',request:{operation:'doc_read',resourceId:'res_docx'}});await worker.tick();const readResult=await service.status(auth,read.jobId);assert.equal(readResult.status,'succeeded');assert(JSON.stringify(readResult.result).includes('公开文档'));
  const written=await service.submit(auth,{descriptorId:descriptor.id,idempotencyKey:'write',request:{operation:'doc_write',targetId:'owned_target',format:'xlsx',spec:{kind:'create',sheets:[{name:'Public',cells:[{ref:'A1',value:'公开表格'}]}]}}});await worker.tick();const result=await service.status(auth,written.jobId);assert.equal(result.status,'succeeded');const output=await fs.readFile(path.join(publicRoot,'exports/public.xlsx'));assert.equal(sha(output),result.result.sha256);assert.equal(await service.hasUnjoined(),false);assert.equal(await controller.admissionAvailable(),true);

  const tokenFile=path.join(directory,'workload-fixture.token');await fs.writeFile(tokenFile,'fixture-workload-token',{mode:0o400});
  const handler=createExtensionGatewayHandler({runtimeManager:{assertActiveEviMedWorkloadToken:async token=>{assert.equal(token,'fixture-workload-token');return{userId:'alice',projectId:'p',runtimeGeneration:'fixture-runtime'};}},service});
  httpServer=http.createServer((req,res)=>void handler(req,res));await new Promise(resolve=>httpServer.listen(0,'127.0.0.1',resolve));httpWorker=new ExtensionOperationWorker({service,pollMs:100});httpWorker.start();
  const invocation={sessionId:'fixture-session',agentId:'fixture-session',callId:'fixture-bridge-call',rootCallId:'fixture-bridge-call',toolName:'doc_read',runtimeGeneration:'fixture-runtime'};
  const bridgeResult=await callCoworkGateway({gatewayUrl:`http://127.0.0.1:${httpServer.address().port}/internal/extensions/v1`,tokenFile,descriptorId:descriptor.id},invocation,{operation:'doc_read',resourceId:'res_docx'},new AbortController().signal);
  assert(JSON.stringify(bridgeResult).includes('公开文档'));
  const observed=(await db.query("SELECT payload FROM evimed_product.jobs WHERE kind='extension-execute' AND payload->'invocation'->>'invocationId'='fixture-bridge-call'")).rows;assert.equal(observed.length,1);assert.equal(observed[0].payload.scope.descriptorId,descriptor.id);assert.equal(observed[0].payload.request.resourceId,'res_docx');
 }finally{if(httpWorker)await httpWorker.close();if(httpServer){httpServer.closeAllConnections();await new Promise(resolve=>httpServer.close(resolve));}if(controller)await controller.close();await db.close();await isolated.drop();await fs.rm(directory,{recursive:true,force:true});}
});
