import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {RuntimeManager,buildRuntimeLaunchPlan} from '../src/runtimeManager.mjs';
import {createPlatformSkillSupply} from '../src/platformSkillSupply.mjs';

test('idle run boundary adopts exact desired mount, preserves active pins and stops before starting',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'platform-refresh-'));
  const project={id:'project',userId:'owner',rootDir:root,baseDir:root,workspaceDir:path.join(root,'workspace'),runtimeDir:path.join(root,'runtime'),metaDir:path.join(root,'.openscience')};
  await Promise.all([project.workspaceDir,project.runtimeDir,project.metaDir].map(dir=>fs.mkdir(dir)));
  const config={dataDir:root,evolutionEnabled:true,runtimeMode:'kernel',runtimeSandboxMode:'docker',runtimeContainerImage:'fixture',runtimeContainerBin:'docker',runtimeMaxRunning:1,modelGatewayInternalUrl:'http://gateway:8787/internal/model/v1'};
  const supply=createPlatformSkillSupply(config),manager=new RuntimeManager(config);manager.platformSkillSupply=supply;
  manager.enforceProjectQuota=async()=>{};manager.makeRoomFor=async()=>{};
  let busy=false;manager.idleVerdict=async()=>busy?'busy':'idle';
  const events=[],plans=[];
  manager.startKernel=async()=>{
    assert.equal(manager.runtimes.size,0);
    const key=manager.key(project),generation=manager.platformSkillOverrides.has(key)?manager.platformSkillOverrides.get(key):await supply.prepareForRuntime({...project,capabilityId:manager.platformSkillScopes.get(key)});
    plans.push(buildRuntimeLaunchPlan(config,project,12345,{platformSkillGeneration:generation?.reference??null}));events.push('start');
    return{kind:'dsh',url:'http://localhost:12345',workspaceDir:project.workspaceDir,project,platformSkillGeneration:generation,startedAt:new Date().toISOString(),close:async()=>{events.push('stop');}};
  };
  t.after(async()=>{await manager.closeAll();await fs.rm(root,{recursive:true,force:true});});
  const publish=async(id,capability)=>supply.publish({id,publicationKind:'skill',capabilityIds:[capability],files:{'SKILL.md':`---\nname: ${id}\ndescription: Workflow ${id}.\n---\n\nUse the method.`}},{card:{toolKind:'workflow'},evaluation:{ok:true,verificationLevel:'V0',smokePassed:true}});
  await publish('one','statistics');await manager.setPlatformSkillScope(project,'statistics');await manager.startAdmitted(project);
  const old=manager.runtimes.get(manager.key(project)),oldPins=structuredClone(old.platformSkillGeneration.pins);
  await publish('two','statistics');busy=true;
  assert.equal((await manager.setPlatformSkillScope(project,'statistics')).pending,true);assert.equal(manager.runtimes.get(manager.key(project)),old);assert.deepEqual(old.platformSkillGeneration.pins,oldPins);assert.deepEqual(events,['start']);
  busy=false;manager.notifyRuntimeStopping=async()=>{busy=true;};
  assert.equal((await manager.setPlatformSkillScope(project,'statistics')).pending,true);assert.equal(manager.runtimes.get(manager.key(project)),old);assert.deepEqual(events,['start']);
  manager.notifyRuntimeStopping=async()=>{};
  busy=false;assert.equal((await manager.setPlatformSkillScope(project,'statistics')).adopted,true);assert.deepEqual(events,['start','stop','start']);
  const current=manager.runtimes.get(manager.key(project));assert.equal(current.platformSkillGeneration.pins.length,2);assert.notEqual(current.platformSkillGeneration.reference.generationHash,old.platformSkillGeneration.reference.generationHash);assert.notDeepEqual(plans[0],plans[1]);
  assert.equal((await manager.setPlatformSkillScope(project,'statistics')).adopted,false);assert.equal(events.length,3);
  await publish('other','evidence');assert.equal((await manager.setPlatformSkillScope(project,'evidence')).adopted,true);assert.deepEqual(manager.runtimePlatformSkills(project).map(pin=>pin.id),['other']);
});

test('trusted release replay reads staged and retained exact revisions without activating them',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'platform-replay-'));try{
    const supply=createPlatformSkillSupply({dataDir,evolutionEnabled:true});
    const candidate={id:'replay',track:'M',capabilityIds:['statistics'],publicationKind:'skill',files:{'SKILL.md':'---\nname: replay\ndescription: Replay workflow.\n---\n\nFirst.'}};
    const options={activate:false,card:{toolKind:'workflow'},evaluation:{ok:true,verificationLevel:'V0',smokePassed:true}};
    const first=await supply.publish(candidate,options),snapshot=await supply.candidateForEvaluation(first);
    assert.deepEqual(snapshot.files,candidate.files);assert.equal(snapshot.track,'M');assert.equal(await supply.prepareForRuntime({capabilityId:'statistics'}),null);
    candidate.files['SKILL.md']+='\nSecond.';await supply.publish(candidate,options);assert.deepEqual((await supply.candidateForEvaluation(first)).files,snapshot.files);
    await assert.rejects(()=>supply.candidateForEvaluation({...first,revision:2}));
    snapshot.files['SKILL.md']='caller mutation';assert.notEqual((await supply.candidateForEvaluation(first)).files['SKILL.md'],'caller mutation');
  }finally{await fs.rm(dataDir,{recursive:true,force:true});}
});
