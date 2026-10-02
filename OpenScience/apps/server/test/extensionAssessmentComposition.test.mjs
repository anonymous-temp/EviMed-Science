import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWebApiApp } from '../src/server.mjs';
import { RuntimeManager } from '../src/runtimeManager.mjs';
import { createRuntimeController } from '../src/runtimeControllerServer.mjs';
test('private JS factories are synchronous constructor dependencies, never config switches',async t=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'assessment-composition-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
 assert.throws(()=>createWebApiApp({}, {runtimeManagerFactory:true}),TypeError);
 assert.throws(()=>createWebApiApp({}, {extensionIntegrationFactory:{}}),TypeError);
 let received;
 const app=createWebApiApp({dataDir,port:0,runtimeMode:'mock',devAuth:true},{runtimeManagerFactory:(config,hooks)=>{received={config,hooks};return new RuntimeManager(config,hooks);}});
 await app.listen(0,"127.0.0.1");t.after(()=>app.close());assert.ok(received);assert.equal(received.config.runtimeMode,'mock');assert.equal(typeof received.hooks.onRuntimeStop,'function');assert.equal(typeof received.hooks.onSessionAbort,'function');assert.equal(received.config.runtimeManagerFactory,undefined);
 const ordinary=createWebApiApp({dataDir:path.join(dataDir,'ordinary'),port:0,runtimeMode:'mock',devAuth:true,runtimeManagerFactory:()=>{throw new Error('serialized switch');},extensionIntegrationFactory:()=>{throw new Error('serialized switch');}});await ordinary.listen(0,"127.0.0.1");t.after(()=>ordinary.close());
});
test('RuntimeManager and controller reject serialized or callback-only assessment authority',()=>{
 assert.throws(()=>new RuntimeManager({}, {assessmentAuthority:{verifyManifest:()=>true}}),{code:'extension_access_denied'});
 assert.throws(()=>createRuntimeController({}, {extensionGenerationAssessmentAuthority:{verifyManifest:()=>true}}),{code:'extension_access_denied'});
});
