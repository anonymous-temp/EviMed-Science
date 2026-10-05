import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readdir,rm} from 'node:fs/promises';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {canonicalJson} from '@evimed/domain';
import path from 'node:path';
import {ExtensionToolController} from '../src/extensionToolController.mjs';
test('evolution restart distinguishes reused live PID and clears proven absent pre-create lease',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'evolution-orphan-'));
 try{
 const controller=new ExtensionToolController({stateRoot:root,adapterRoot:root,inputRoot:root,admittedDescriptors:[]});
 const name='evimed-extension-tool-11111111-1111-1111-1111-111111111111';await mkdir(path.join(root,name));
 const marker={name,identity:{evolution:true,jobId:'job'},state:'reserved',ownerProcessId:process.pid,ownerProcessStart:'0',ownerBootInstance:'previous-boot'};
 await writeFile(path.join(root,name+'.json'),JSON.stringify(marker));
 let inspections=0;controller.command=async args=>{assert.equal(args[0],'inspect');assert.equal(args.at(-1),name);inspections++;throw Object.assign(new Error('Absent'),{missing:true});};
 await writeFile(path.join(root,'admission.lock'),JSON.stringify({ownerProcessId:process.pid,ownerProcessStart:'0',ownerBootInstance:'previous-boot'}));
 await controller.reconcileEvolutionAttempts();assert.equal(inspections,1);assert.deepEqual(await readdir(root),[]);
 await mkdir(path.join(root,name));const owned={...marker,artifactDigest:'sha256:'+'b'.repeat(64)};await writeFile(path.join(root,name+'.json'),JSON.stringify(owned));
 const labels={'com.evimed.extension-tool':'owned','com.evimed.extension-scope':name,'com.evimed.extension-artifact':owned.artifactDigest,'com.evimed.extension-attempt':createHash('sha256').update(canonicalJson(marker.identity)).digest('hex')};let removed=false;
 controller.command=async args=>{if(args[0]==='rm'){removed=true;return{stdout:''};}if(args.at(-1)===name)return{stdout:JSON.stringify({Id:'a'.repeat(64),Name:'/'+name,Config:{Labels:labels}})};if(args[2]==='{{json .Config.Labels}}')return{stdout:JSON.stringify(labels)};throw Object.assign(new Error('Absent'),{missing:true});};
 await controller.reconcileEvolutionAttempts();assert.equal(removed,true);assert.deepEqual(await readdir(root),[]);
 await mkdir(path.join(root,name));await writeFile(path.join(root,name+'.json'),JSON.stringify(marker));
 controller.command=async()=>({stdout:JSON.stringify({Id:'a'.repeat(64),Name:'/'+name,Config:{Labels:{'com.evimed.extension-tool':'other'}}})});
 await assert.rejects(controller.reconcileEvolutionAttempts());assert.ok((await readdir(root)).includes(name+'.json'));
 await rm(path.join(root,'admission.lock'),{force:true});await writeFile(path.join(root,'admission.lock'),'');await assert.rejects(controller.acquireAdmissionLock());assert.ok((await readdir(root)).includes('admission.lock'));
 }finally{await rm(root,{recursive:true,force:true});}
});
