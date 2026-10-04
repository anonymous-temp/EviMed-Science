#!/usr/bin/env node
/** Reproducible public/synthetic acceptance input preparation. No qualification or serving installation. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { openSync, writeSync, closeSync } from 'node:fs';
import { assessmentDockerEnvironment } from './extension-saas-acceptance-docker.mjs';
import { canonicalJson } from '@evimed/domain';
import { extensionToolArtifactDigest } from '../../apps/server/src/extensionToolController.mjs';
const project = fileURLToPath(new URL('../../', import.meta.url));
const adapter = path.join(project, 'scripts/runtime/extensions/cowork');
const sourceManifestPath = path.join(adapter, 'source-manifest.json');
const HEX = /^[a-f0-9]{64}$/, DIGEST = /^sha256:[a-f0-9]{64}$/;
export const ACCEPTANCE_NODE_BASES = Object.freeze({
  'linux/amd64': 'node:22.23.2-bookworm-slim@sha256:43aeff40f4afc22e83f7589a2f37e111cff5ca84529571f1c8415bcc5fcc21b2',
  'linux/arm64': 'node:22.23.2-bookworm-slim@sha256:f71fb9ca71b1b47d4d1a009af78147ed6cdc74f9c7cfc36cbde78ff985169051',
});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error('extension_acceptance_prepare: ' + message); };
/** Closed operator build platform; images/argv/env are never preparation inputs. */
export function acceptancePlatform(value) { if (!Object.hasOwn(ACCEPTANCE_NODE_BASES, value)) fail('unsupported platform');return value; }
function closed(value, keys) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) fail('input fields'); }
/** This is an assessment descriptor, never an admission/qualification receipt. */
export function validatePreparedAcceptanceInputs(value) {
  closed(value, ['schemaVersion','platform','sourceCommit','dshVersion','images','artifact','fixtures','qualification']);
  acceptancePlatform(value.platform);
  if (value.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(value.sourceCommit) || value.qualification !== 'unverified' || typeof value.dshVersion !== 'string') fail('input identity');
  closed(value.images, ['coworkImageId','nativeSdkImageId','nativeKernelImageId']);
  if (!Object.values(value.images).every(id => DIGEST.test(id))) fail('image identity');
  closed(value.artifact, ['closureExpectedSHA','integrity','runnerSHA','policySHA','inventorySHA','adapterDigest','artifactDigest']);
  if (!['closureExpectedSHA','runnerSHA','policySHA','inventorySHA'].every(key => HEX.test(value.artifact[key]))
    || !['integrity','adapterDigest','artifactDigest'].every(key => DIGEST.test(value.artifact[key]))) fail('artifact identity');
  closed(value.fixtures, ['catalogueSnapshotPath','catalogueSnapshotSHA']);
  if (value.fixtures.catalogueSnapshotPath !== 'fixtures/catalogue-snapshot.json' || !HEX.test(value.fixtures.catalogueSnapshotSHA)) fail('snapshot identity');
  return value;
}
/** Child processes receive no inherited provider, registry or customer configuration. */
export function preparationEnvironment(environment = process.env) {
  return assessmentDockerEnvironment(environment);
}
/** Trusted fixed command runner. Logs stay on disk; timeout/output refusal joins the owned process group.
 * Docker build interruption additionally requires operator recovery: CLI exit alone cannot prove daemon build exit.
 */
export async function runPreparationCommand(bin, args, { env, logFile, timeout = 120000, maxBytes = 32*1024*1024, capture = true, interrupted } = {}) {
  const fd = openSync(logFile,'wx',0o600);
  let bytes=0, stdoutBytes=0, reason=null, timer, force, child;const stdout=[];
  try {
    return await new Promise((resolve,reject)=>{
      child=spawn(bin,args,{env,detached:true,stdio:['ignore','pipe','pipe']});
      const stop=why=>{if(reason)return;reason=new Error('extension_acceptance_prepare: '+why);try{process.kill(-child.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')reason=error;}force=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')reason=error;}},3000);force.unref();};
      const signalStop=()=>stop('command interrupted');process.once('SIGINT',signalStop);process.once('SIGTERM',signalStop);
      timer=setTimeout(()=>stop('command deadline'),timeout);
      for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxBytes){stop('command log bound');return;}try{writeSync(fd,chunk);}catch{stop('command log write failed');}if(stream===child.stdout&&capture){stdoutBytes+=chunk.length;if(stdoutBytes>2*1024*1024)stop('command response bound');else stdout.push(chunk);}});
      child.once('error',error=>{reason=error;});
      child.once('close',async code=>{
        clearTimeout(timer);clearTimeout(force);process.removeListener('SIGINT',signalStop);process.removeListener('SIGTERM',signalStop);
        try{
          if(reason){if(interrupted)await interrupted(reason);throw reason;}
          if(code!==0)throw new Error('extension_acceptance_prepare: command failed; bounded log '+path.basename(logFile));
          if(!capture)return resolve('');
          resolve(Buffer.concat(stdout).toString('utf8'));
        }catch(error){reject(error);}
      });
    });
  } finally { closeSync(fd); }
}
/** The exact tracked source inventory is the only input to the vendor compiler. */
export async function verifyAcquiredSource(root, manifest) {
  const expected = new Map(manifest.files.map(file => [file.path,file])), seen = new Set();
  async function walk(directory) {
    for (const name of await fs.readdir(directory)) {
      const file = path.join(directory,name), stat = await fs.lstat(file), relative = path.relative(root,file).split(path.sep).join('/');
      if (stat.isSymbolicLink()) fail('source link');
      if (stat.isDirectory()) await walk(file);
      else {
        const record = expected.get(relative);if (!stat.isFile() || !record || seen.has(relative) || stat.size !== record.bytes) fail('source inventory');
        if (sha(await fs.readFile(file)) !== record.sha256) fail('source bytes');seen.add(relative);
      }
    }
  }
  await walk(root);if (seen.size !== expected.size) fail('source incomplete');return seen.size;
}
export async function acquireAcceptanceSource(output, { fetchImpl = fetch } = {}) {
  const manifest = JSON.parse(await fs.readFile(sourceManifestPath,'utf8'));
  if (manifest.repository !== 'Jesse-njx/dsh-cowork' || manifest.files.length !== 32 || !/^[a-f0-9]{40}$/.test(manifest.commit)) fail('tracked source pin');
  const response = await fetchImpl(`https://codeload.github.com/${manifest.repository}/tar.gz/${manifest.commit}`, { redirect:'error',signal:AbortSignal.timeout(30000) });
  if (!response.ok) fail('source acquisition');
  const chunks = [];let size = 0;
  for await (const chunk of response.body) { size += chunk.length;if (size > 1024*1024) fail('source archive bound');chunks.push(Buffer.from(chunk)); }
  const bytes = Buffer.concat(chunks);if (bytes.length !== manifest.archiveBytes || sha(bytes) !== manifest.archiveSha256) fail('source archive identity');
  const archive = path.join(output,'source.tgz'), root = path.join(output,'source');await fs.writeFile(archive,bytes,{flag:'wx',mode:0o400});
  const decoder = `import gzip,io,json,pathlib,tarfile,sys
archive,manifest_file,root=sys.argv[1:];expected=json.loads(pathlib.Path(manifest_file).read_text());root=pathlib.Path(root)
with gzip.open(archive,'rb') as f: data=f.read(8*1024*1024+1)
if len(data)>8*1024*1024: raise ValueError('source expanded bound')
selected={e['path']:e for e in expected['files']};seen=set();prefix='dsh-cowork-'+expected['commit'];root.mkdir()
with tarfile.open(fileobj=io.BytesIO(data)) as tar:
 entries=tar.getmembers()
 if len(entries)>256: raise ValueError('source entry bound')
 for entry in entries:
  parts=entry.name.rstrip('/').split('/')
  if parts[0]!=prefix or any(p in ('','..','.') or '\\\\' in p for p in parts) or not(entry.isfile() or entry.isdir()): raise ValueError('source path/link/type')
  relative='/'.join(parts[1:])
  if not entry.isfile() or relative not in selected: continue
  if relative in seen or entry.size!=selected[relative]['bytes']: raise ValueError('source identity')
  seen.add(relative);target=root.joinpath(*parts[1:]);target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(tar.extractfile(entry).read());target.chmod(0o444)
 if seen!=set(selected): raise ValueError('source missing')
`;
  execFileSync('python3',['-c',decoder,archive,sourceManifestPath,root],{timeout:5000,maxBuffer:65536});
  await verifyAcquiredSource(root,manifest);return { root, manifest, archiveSHA:sha(bytes) };
}
/** Prepared image metadata must match the explicitly requested architecture, not host defaults. */
export function verifyAcceptanceImage(image, platform) {
  acceptancePlatform(platform);if (!DIGEST.test(image?.Id) || `${image.Os}/${image.Architecture}` !== platform) fail('image platform');return image.Id;
}
async function copyDirectory(source, target) { await fs.mkdir(target,{recursive:true});await fs.cp(source,target,{recursive:true,filter:file=>!file.split(path.sep).includes('node_modules')}); }

/** Trusted operator orchestration only. The emitted protected file contains immutable observations, not permission flags. */
export async function prepareExtensionAcceptance({ platform = 'linux/amd64', outputParent = path.resolve(project,'../.evimed-local/extensions/acceptance-preparation'), resumeCowork = null, runtimeFixtureBase = null } = {}) {
  acceptancePlatform(platform);if(runtimeFixtureBase){closed(runtimeFixtureBase,['imageId','sourceRevision']);if(!DIGEST.test(runtimeFixtureBase.imageId)||!/^[a-f0-9]{40}$/.test(runtimeFixtureBase.sourceRevision))fail('runtime fixture base identity');}
  await fs.mkdir(outputParent,{recursive:true,mode:0o700});
  const parent=await fs.realpath(outputParent),output=resumeCowork?await fs.realpath(resumeCowork):await fs.realpath(await fs.mkdtemp(path.join(parent,'run-')));
  if(path.dirname(output)!==parent||!/^run-[A-Za-z0-9]{6}$/.test(path.basename(output)))fail('owned preparation directory');
  const info=await fs.lstat(output);if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077))fail('private preparation root');
  let previous=null;if(resumeCowork){try{previous=JSON.parse(await fs.readFile(path.join(output,'recovery-required.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;try{previous=JSON.parse(await fs.readFile(path.join(output,'preparation-record.json'),'utf8'));validatePreparedAcceptanceInputs(previous.inputs);}catch(recordError){if(recordError.code!=='ENOENT')throw recordError;previous=JSON.parse(await fs.readFile(path.join(output,'cowork-stage.json'),'utf8'));if(previous.schemaVersion!==1||previous.qualification!=='unverified')fail('resumed stage receipt');}}}
  const runId=previous?.runId??randomUUID();if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(runId))fail('owned preparation identity');
  const attemptId=randomUUID(),env=preparationEnvironment();await fs.mkdir(path.join(output,'logs'),{recursive:true});let commandSequence=(await fs.readdir(path.join(output,'logs'))).filter(name=>/^\d+\.log$/.test(name)).length;
  const command=(bin,args,timeout=120000,options={})=>runPreparationCommand(bin,args,{env,timeout,logFile:path.join(output,'logs',String(++commandSequence).padStart(3,'0')+'.log'),...options});
  const recovery=async reason=>fs.writeFile(path.join(output,'recovery-required.json'),canonicalJson({runId,attemptId,reason:String(reason.message),driverJoinedBeforeMarker:true,qualification:'unverified'})+'\n',{mode:0o600});
  const source=resumeCowork?{root:path.join(output,'source'),manifest:JSON.parse(await fs.readFile(sourceManifestPath,'utf8')),archiveSHA:sha(await fs.readFile(path.join(output,'source.tgz')))}:await acquireAcceptanceSource(output);
  if(resumeCowork){await verifyAcquiredSource(source.root,source.manifest);if(source.archiveSHA!==source.manifest.archiveSha256)fail('resumed source archive changed');}
  // Copy only fixed public build inputs. Dedicated assessment daemons may mount this private output root alone.
  const publicAdapter=path.join(output,'public-adapter');
  for(const file of ['Dockerfile','assemble.py','image-inventory.mjs','inventory.mjs','policy.mjs','prepare-artifact.mjs','runner.mjs','source-manifest.json','verify-source.mjs','overlay/Dockerfile','overlay/apply.mjs','overlay/attest.mjs','overlay/build.sh','overlay/closure.mjs','overlay/pins.json','overlay/pnpm-lock.yaml']){
    const target=path.join(publicAdapter,file);await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(path.join(adapter,file),target);
  }
  if(!resumeCowork)await command('bash',[path.join(publicAdapter,'overlay/build.sh'),source.root,path.join(output,'cowork'),platform,runId],900000,{capture:false,interrupted:recovery});
  if ((await fs.readFile(path.join(output,'cowork/cleanup.txt'),'utf8')).trim()!=='joined') fail('vendor build cleanup unconfirmed');
  const cowork=JSON.parse(await fs.readFile(path.join(output,'cowork/image-identity.json'),'utf8'));const coworkImageId=verifyAcceptanceImage(cowork,platform);
  const stage={schemaVersion:1,runId,platform,coworkImageId,sourceCommit:source.manifest.commit,sourceArchiveSHA:source.archiveSHA,qualification:'unverified'};const stagePath=path.join(output,'cowork-stage.json');try{await fs.writeFile(stagePath,canonicalJson(stage)+'\n',{mode:0o400,flag:'wx'});}catch(error){if(error.code!=='EEXIST'||(await fs.readFile(stagePath,'utf8')).trim()!==canonicalJson(stage))throw error;}
  if(resumeCowork){
    const actual=JSON.parse(await command('docker',['image','inspect',coworkImageId]))[0];verifyAcceptanceImage(actual,platform);
    if(!actual.RepoTags?.includes('evimed-cowork-acceptance:'+runId))fail('resumed artifact image identity');
    const closureBytes=await fs.readFile(path.join(output,'cowork/context/dependency-closure.json')),attestation=JSON.parse(await fs.readFile(path.join(output,'cowork/context/overlay-attestation.json'),'utf8'));
    if(attestation.dependencyClosureSha256!==sha(closureBytes)||attestation.sourceCommit!==source.manifest.commit||attestation.overlayPinsSha256!==sha(await fs.readFile(path.join(adapter,'overlay/pins.json')))||attestation.admittedLockSha256!==sha(await fs.readFile(path.join(adapter,'overlay/pnpm-lock.yaml'))))fail('resumed closure identity');
    const files=(await fs.readdir(path.join(output,'logs'))).filter(name=>/^\d+\.log$/.test(name));if(files.length>128)fail('recovery log bound');const prefixes=[];
    for(const name of files){const bytes=await fs.readFile(path.join(output,'logs',name));if(bytes.length>32*1024*1024)fail('recovery log byte bound');for(const match of bytes.toString().matchAll(/Running in ([a-f0-9]{12,64})/g))if(!prefixes.includes(match[1]))prefixes.push(match[1]);}
    if(!prefixes.length||prefixes.length>256)fail('old build ownership unavailable');
    for(const prefix of prefixes)if((await command('docker',['container','ls','-aq','--no-trunc','--filter','id='+prefix])).trim())fail('old build container not joined');
    const stateFile=path.join(output,'snapshot-state.json');
    try{
      const state=JSON.parse(await fs.readFile(stateFile,'utf8'));
      if(state.state!=='joined'){
        const candidates=[];for(const name of files){for(const line of (await fs.readFile(path.join(output,'logs',name),'utf8')).split('\n'))if(/^[a-f0-9]{64}$/.test(line)&&!candidates.includes(line))candidates.push(line);}
        const id=state.id??(candidates.length===1?candidates[0]:null);if(!id)fail('original snapshot identity unconfirmed');
        const present=(await command('docker',['container','ls','-aq','--no-trunc','--filter','id='+id])).trim();
        if(present){const snapshotOwner=JSON.parse(await command('docker',['inspect',id]))[0];if(snapshotOwner.Id!==id||snapshotOwner.Name!=='/'+state.name||snapshotOwner.Config.Labels?.['evimed.preparation']!==runId)fail('original snapshot ownership');await command('docker',['rm','-f','-v',id]);if((await command('docker',['container','ls','-aq','--no-trunc','--filter','id='+id])).trim())fail('original snapshot unjoined');}
        await fs.writeFile(stateFile,canonicalJson({runId,id,state:'joined',recoveredFromOwnedCreateJournal:true})+'\n',{mode:0o600});
      }
    }catch(error){if(error.code!=='ENOENT')throw error;}
    await fs.mkdir(path.join(output,'recovery-history'),{recursive:true,mode:0o700});try{const original=await fs.readFile(path.join(output,'recovery-required.json')),recordId=sha(original);
    await fs.writeFile(path.join(output,'recovery-history/'+recordId+'.json'),original,{mode:0o600,flag:'wx'});
    await fs.writeFile(path.join(output,'recovery-history/'+recordId+'.proof.json'),canonicalJson({runId,coworkImageId,prefixes,observedAbsent:true,driverJoinedBeforeMarker:true,qualification:'unverified'})+'\n',{mode:0o600,flag:'wx'});await fs.unlink(path.join(output,'recovery-required.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  const context=path.join(output,resumeCowork?'sdk-context-retry-'+randomUUID():'sdk-context');await fs.mkdir(context,{mode:0o700});
  for (const name of ['domain','harness-port','design-tokens']) await copyDirectory(path.join(project,'packages',name),path.join(context,'platform/node_modules/@evimed',name));
  await fs.mkdir(path.join(context,'platform/scripts/ops'),{recursive:true});await fs.mkdir(path.join(context,'platform/deploy/runtime-dsh'),{recursive:true});
  for(const name of ['kernel-install.mjs'])await fs.copyFile(path.join(project,'scripts/ops',name),path.join(context,'platform/scripts/ops',name));
  for(const name of ['runtime-yaml-security.mjs','profile-seed.mjs','profile-kernel-pins.mjs'])await fs.copyFile(path.join(project,'deploy/runtime-dsh',name),path.join(context,'platform/deploy/runtime-dsh',name));
  await fs.copyFile(path.join(project,'deps-version.json'),path.join(context,'platform/deps-version.json'));
  await fs.copyFile(path.join(project,'scripts/runtime/validate-personal-skill.mjs'),path.join(context,'validate-personal-skill.mjs'));
  for(const[name,target]of [['plugins/skill-catalogue.mjs','catalogue.mjs'],['plugins/plugin-probe.mjs','probe.mjs'],['plugins/citation-bridge.mjs','citation.mjs']])await fs.copyFile(path.join(project,'packages/socket',name),path.join(context,'platform',target));
  // The cowork bridge keeps the socket's own layout: it imports a shared module by relative path
  // (`../../src/workloadRequest.mjs`), and a flat copy of the bridge alone could not start.
  for(const name of ['extensions/cowork/bridge.mjs','src/workloadRequest.mjs']){await fs.mkdir(path.dirname(path.join(context,'platform/socket',name)),{recursive:true});await fs.copyFile(path.join(project,'packages/socket',name),path.join(context,'platform/socket',name));}
  await fs.mkdir(path.join(context,'platform/server'));for(const name of ['dshBrowserAuth.mjs','dshRuntimeAdapter.mjs','security.mjs'])await fs.copyFile(path.join(project,'apps/server/src',name),path.join(context,'platform/server',name));
  for(const[name,target]of [['nativeSkillCatalogueKernel.mjs','catalogue-fixture.mjs'],['extensionNativeKernel.mjs','fixture.mjs']])await fs.copyFile(path.join(project,'apps/server/test/fixtures',name),path.join(context,target));
  for(const name of ['Dockerfile.sdk','Dockerfile.runtime','install-sdk.mjs','reuse-runtime-sdk.mjs','make-fixtures.mjs'])await fs.copyFile(path.join(project,'scripts/ops/fixtures/extension-acceptance',name),path.join(context,name==='Dockerfile.sdk'&&!runtimeFixtureBase||name==='Dockerfile.runtime'&&runtimeFixtureBase?'Dockerfile':name));
  const sdkTag='evimed-extension-sdk-acceptance:'+runId+'-'+randomUUID();
  if(runtimeFixtureBase){const base=JSON.parse(await command('docker',['image','inspect',runtimeFixtureBase.imageId]))[0];verifyAcceptanceImage(base,platform);if(base.Config.Labels?.['org.opencontainers.image.revision']!==runtimeFixtureBase.sourceRevision)fail('runtime fixture base source');}
  const proxyArgs=env.DOCKER_CONTEXT==='colima-evimed-extension-acceptance'?['--build-arg','HTTP_PROXY=http://192.168.5.2:7890','--build-arg','HTTPS_PROXY=http://192.168.5.2:7890','--build-arg','NO_PROXY=localhost,127.0.0.1']:[];
  await command('docker',['build',...proxyArgs,'--memory','1g','--memory-swap','1g','--cpu-period','100000','--cpu-quota','100000','--platform',platform,'--build-arg',runtimeFixtureBase?'RUNTIME_IMAGE='+runtimeFixtureBase.imageId:'NODE_IMAGE='+ACCEPTANCE_NODE_BASES[platform],'-t',sdkTag,context],900000,{env:{...env,DOCKER_BUILDKIT:'0'},capture:false,interrupted:recovery});
  const sdk=JSON.parse(await command('docker',['image','inspect',sdkTag]))[0], nativeSdkImageId=verifyAcceptanceImage(sdk,platform);
  // Snapshot execution is bounded/joined by its fixed container identity.
  let id;let parsed;let snapshotError;let createRequested=false;const snapshotName='evimed-acceptance-snapshot-'+runId;
  await fs.writeFile(path.join(output,'snapshot-state.json'),canonicalJson({runId,name:snapshotName,state:'create-requested'})+'\n',{mode:0o600});createRequested=true;
  try{
    id=(await command('docker',['create','--name',snapshotName,'--label','evimed.preparation='+runId,'--pull','never','--network','none','--read-only','--user','10001:10001','--cap-drop','ALL','--security-opt','no-new-privileges','--cpus','1','--memory','1g','--memory-swap','1g','--pids-limit','128','--tmpfs','/tmp:rw,nosuid,nodev,size=128m,mode=1777','--tmpfs','/runtime:ro,noexec,nosuid,nodev,size=1m,mode=0555','--tmpfs','/workspace:ro,noexec,nosuid,nodev,size=1m,mode=0555','--entrypoint','node',nativeSdkImageId,'/fixture/catalogue-fixture.mjs'])).trim();if(!/^[a-f0-9]{64}$/.test(id))fail('snapshot creation identity');
    await fs.writeFile(path.join(output,'snapshot-state.json'),canonicalJson({runId,name:snapshotName,id,state:'created'})+'\n',{mode:0o600});
    const actual=JSON.parse(await command('docker',['inspect',id]))[0];if(actual.Id!==id||actual.Image!==nativeSdkImageId||actual.Config.Labels?.['evimed.preparation']!==runId)fail('snapshot ownership');if(actual.Mounts.length!==0||actual.HostConfig.Tmpfs['/runtime']!=='ro,noexec,nosuid,nodev,size=1m,mode=0555'||actual.HostConfig.Tmpfs['/workspace']!=='ro,noexec,nosuid,nodev,size=1m,mode=0555')fail('snapshot inherited mounts');
    const data=await command('docker',['start','-a',id],60000);parsed=JSON.parse(data.trim());
  }catch(error){snapshotError=error;}
  {
    if(id&&/^[a-f0-9]{64}$/.test(id)){
      try{const actual=JSON.parse(await command('docker',['inspect',id]))[0];if(actual.Id!==id||actual.Config.Labels?.['evimed.preparation']!==runId)fail('snapshot cleanup ownership');await command('docker',['rm','-f','-v',id]);if((await command('docker',['container','ls','-aq','--no-trunc','--filter','id='+id])).trim())fail('snapshot process unjoined');await fs.writeFile(path.join(output,'snapshot-state.json'),canonicalJson({runId,id,state:'joined'})+'\n',{mode:0o600});}
      catch(error){await recovery(error);throw error;}
    }else if(createRequested){const error=new Error('snapshot creation identity unknown');await recovery(error);throw error;}
  }
  if(snapshotError)throw snapshotError;
  const publication=path.join(output,'publication-'+randomUUID());await fs.mkdir(publication,{mode:0o700});
  const snapshot=Buffer.from(canonicalJson({list:parsed.list,body:parsed.body,snapshot:parsed.snapshot})+'\n');await fs.mkdir(path.join(publication,'fixtures'));await fs.writeFile(path.join(publication,'fixtures/catalogue-snapshot.json'),snapshot,{mode:0o400,flag:'wx'});
  const closureBytes=await fs.readFile(path.join(output,'cowork/context/dependency-closure.json')),closure=JSON.parse(closureBytes);const runnerSHA=sha(await fs.readFile(path.join(adapter,'runner.mjs'))),policySHA=sha(await fs.readFile(path.join(adapter,'policy.mjs'))),inventorySHA=sha(await fs.readFile(path.join(adapter,'image-inventory.mjs')));
  const artifact={closureExpectedSHA:sha(closureBytes),integrity:closure.contentDigest,runnerSHA,policySHA,inventorySHA,adapterDigest:'sha256:'+sha(canonicalJson({runnerSHA,policySHA,inventorySHA}))};
  artifact.artifactDigest=extensionToolArtifactDigest({...artifact,id:'cowork-portable',coordinate:{kind:'github',repository:source.manifest.repository,commit:source.manifest.commit},imageId:coworkImageId});
  const pins=JSON.parse(await fs.readFile(path.join(project,'deps-version.json'),'utf8'));
  const inputs=validatePreparedAcceptanceInputs({schemaVersion:1,platform,sourceCommit:source.manifest.commit,dshVersion:pins.dsh.version,images:{coworkImageId,nativeSdkImageId,nativeKernelImageId:nativeSdkImageId},artifact,fixtures:{catalogueSnapshotPath:'fixtures/catalogue-snapshot.json',catalogueSnapshotSHA:sha(snapshot)},qualification:'unverified'});
  await fs.writeFile(path.join(publication,'acceptance-inputs.json'),canonicalJson(inputs)+'\n',{mode:0o400});
  await fs.writeFile(path.join(publication,'preparation-record.json'),canonicalJson({schemaVersion:1,runId,platform,runtimeFixtureBase,sourceManifestSHA:sha(await fs.readFile(sourceManifestPath)),sourceArchiveSHA:source.archiveSHA,lockSHA:sha(await fs.readFile(path.join(output,'cowork/context/pnpm-lock.yaml'))),fixtureSourceSHA:sha(await fs.readFile(path.join(context,'fixture.mjs'))),catalogueSourceSHA:sha(await fs.readFile(path.join(context,'catalogue-fixture.mjs'))),depsVersionSHA:sha(await fs.readFile(path.join(context,'platform/deps-version.json'))),inputs,qualification:'unverified'})+'\n',{mode:0o400});
  return {inputsFile:path.join(publication,'acceptance-inputs.json'),output,qualification:'unverified'};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);if(args.length>1||(args[0]&&!/^--platform=linux\/(amd64|arm64)$/.test(args[0])))fail('only fixed platform flag accepted');
 console.log(JSON.stringify(await prepareExtensionAcceptance({platform:args[0]?.slice('--platform='.length)??'linux/amd64'})));
}
