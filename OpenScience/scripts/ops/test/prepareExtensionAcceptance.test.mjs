import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { acceptancePlatform, validatePreparedAcceptanceInputs, verifyAcquiredSource, preparationEnvironment, verifyAcceptanceImage, ACCEPTANCE_NODE_BASES, runPreparationCommand } from '../prepare-extension-acceptance.mjs';
const dshVersion=JSON.parse(await fs.readFile(new URL('../../../deps-version.json',import.meta.url),'utf8')).dsh.version;
const hex='a'.repeat(64),digest='sha256:'+hex;
const input=()=>({schemaVersion:1,platform:'linux/amd64',sourceCommit:'b'.repeat(40),dshVersion,images:{coworkImageId:digest,nativeSdkImageId:digest,nativeKernelImageId:digest},artifact:{closureExpectedSHA:hex,integrity:digest,runnerSHA:hex,policySHA:hex,inventorySHA:hex,adapterDigest:digest,artifactDigest:digest},fixtures:{catalogueSnapshotPath:'fixtures/catalogue-snapshot.json',catalogueSnapshotSHA:hex},qualification:'unverified'});
test('protected prepared tuple has no caller paths, commands, credentials or qualification authority',()=>{
 assert.deepEqual(validatePreparedAcceptanceInputs(input()),input());
 for(const mutate of [x=>x.qualified=true,x=>x.argv=['sh'],x=>x.env={key:'secret'},x=>x.images.customerImage=digest,x=>x.fixtures.catalogueSnapshotPath='/private/customer-plane',x=>x.qualification='qualified',x=>x.platform='darwin/arm64',x=>x.images.nativeSdkImageId='node:latest']){
  const x=input();mutate(x);assert.throws(()=>validatePreparedAcceptanceInputs(x));
 }
});
test('platform is explicit and checked against immutable actual image inspection',()=>{
 assert.equal(acceptancePlatform('linux/amd64'),'linux/amd64');assert.equal(verifyAcceptanceImage({Id:digest,Os:'linux',Architecture:'amd64'},'linux/amd64'),digest);
 assert.throws(()=>verifyAcceptanceImage({Id:digest,Os:'linux',Architecture:'arm64'},'linux/amd64'));
 assert.throws(()=>verifyAcceptanceImage({Id:'node:latest',Os:'linux',Architecture:'amd64'},'linux/amd64'));
 assert(ACCEPTANCE_NODE_BASES['linux/amd64'].includes('43aeff40'));assert(ACCEPTANCE_NODE_BASES['linux/arm64'].includes('f71fb9ca'));
});
test('build child allowlist drops provider and database/credential state',()=>{
 const env=preparationEnvironment({PATH:'/bin',HOME:'/safe',DOCKER_CONTEXT:'colima-evimed-extension-acceptance',DOCKER_HOST:'tcp://private',DOCKER_CONFIG:'/private',DEEPSEEK_API_KEY:'secret',OPEN_SCIENCE_TEST_POSTGRES_URL:'private',NPM_TOKEN:'private'});
 assert.deepEqual(env,{PATH:'/bin',DOCKER_CONTEXT:'colima-evimed-extension-acceptance'});assert.throws(()=>preparationEnvironment({DOCKER_CONTEXT:'foreign'}));
});
test('strict acquired source rejects omitted, altered, extra and linked files',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'acceptance-source-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const bytes=Buffer.from('trusted public pinned source'),record={path:'src/main.ts',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},manifest={files:[record]};await fs.mkdir(path.join(root,'src'));await fs.writeFile(path.join(root,record.path),bytes);
 assert.equal(await verifyAcquiredSource(root,manifest),1);await fs.writeFile(path.join(root,'extra'),bytes);await assert.rejects(verifyAcquiredSource(root,manifest));await fs.unlink(path.join(root,'extra'));
 await fs.writeFile(path.join(root,record.path),'changed');await assert.rejects(verifyAcquiredSource(root,manifest));await fs.unlink(path.join(root,record.path));await assert.rejects(verifyAcquiredSource(root,manifest));
 await fs.symlink('/etc/passwd',path.join(root,record.path));await assert.rejects(verifyAcquiredSource(root,manifest));
});
test('tracked prep uses actual fixture sources and keeps SDK/vendor closure separation',async()=>{
 const source=await fs.readFile(new URL('../prepare-extension-acceptance.mjs',import.meta.url),'utf8'),sdk=await fs.readFile(new URL('../fixtures/extension-acceptance/Dockerfile.sdk',import.meta.url),'utf8'),build=await fs.readFile(new URL('../../runtime/extensions/cowork/overlay/build.sh',import.meta.url),'utf8');
 assert(!source.includes('20261002/context'));assert(source.includes('source-manifest.json'));assert(source.includes('nativeSkillCatalogueKernel.mjs'));assert(source.includes('extensionNativeKernel.mjs'));assert(source.includes("qualification:'unverified'"));
 assert(sdk.includes('NARB_DISABLE_NATIVE_CACHE=1'));assert(build.includes('--platform "$PLATFORM"'));assert(build.includes('evimed-cowork-acceptance:'+'$'+'{RUN_ID}'));assert(build.includes('docker rm -f "$owned"'));assert(build.includes('overlay/attest.mjs'));assert(build.includes('--frozen-lockfile'));
});

test('streamed build log can exceed response framing without maxBuffer abandonment',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'acceptance-log-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));const logFile=path.join(root,'build.log');
 assert.equal(await runPreparationCommand(process.execPath,['-e',"process.stdout.write('x'.repeat(3*1024*1024))"],{env:{PATH:process.env.PATH},logFile,capture:false}), '');assert.equal((await fs.stat(logFile)).size,3*1024*1024);
});
test('timeout joins the owned child and persists interruption before refusal',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'acceptance-timeout-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));const logFile=path.join(root,'timeout.log');let interrupted=false;
 await assert.rejects(runPreparationCommand(process.execPath,['-e',"console.log(process.pid);setInterval(()=>{},1000)"],{env:{PATH:process.env.PATH},logFile,timeout:250,interrupted:async()=>{interrupted=true;}}),/deadline/);
 assert.equal(interrupted,true);const pid=Number((await fs.readFile(logFile,'utf8')).trim());assert(pid>0);assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH');
});
test('log bomb refuses after bounded bytes and joins child',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'acceptance-output-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));const logFile=path.join(root,'bomb.log');
 await assert.rejects(runPreparationCommand(process.execPath,['-e',"setInterval(()=>process.stdout.write('x'.repeat(65536)),1)"],{env:{PATH:process.env.PATH},logFile,maxBytes:128*1024}),/log bound/);assert((await fs.stat(logFile)).size<=128*1024);
});

test('Docker stderr diagnostics do not corrupt captured immutable identity or JSON',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'acceptance-framing-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));const logFile=path.join(root,'create.log');
 const response=await runPreparationCommand(process.execPath,['-e',"process.stderr.write('platform warning\\n');process.stdout.write('a'.repeat(64)+'\\n')"],{env:{PATH:process.env.PATH},logFile});assert.equal(response.trim(),'a'.repeat(64));assert((await fs.readFile(logFile,'utf8')).includes('platform warning'));
});
