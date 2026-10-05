import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createEvolutionVerificationController,verificationRequest} from '../src/evolutionVerificationController.mjs';
import {EVOLUTION_STATIC_CHECK} from '../src/evolutionVerification.mjs';
import {createRuntimeController} from '../src/runtimeControllerServer.mjs';
import {RuntimeControllerClient,RUNTIME_CONTROLLER_PROTOCOL_VERSION} from '../src/runtimeControllerClient.mjs';
import {createEvolutionBuilder} from '../src/evolutionBuild.mjs';
import {createPlatformSkillSupply,verifyPlatformSkillGeneration,platformSkillGenerationRoot} from '../src/platformSkillSupply.mjs';

const image='docker.m.daocloud.io/library/python:3.12-slim-bookworm';
const dockerAvailable=spawnSync('docker',['image','inspect',image],{stdio:'ignore',timeout:5000}).status===0;
test('verification rejects caller paths and execution authority',()=>{
  for(const files of [{'../secret':'x'},{'/etc/passwd':'x'},{'scripts/../../x.py':'x'}])assert.throws(()=>verificationRequest({files,code:''}));
  for(const field of ['imageId','workspace','socket','env','command'])assert.throws(()=>verificationRequest({files:{},code:'', [field]:'untrusted'}));
});
test('immutable skill generations preserve exact old revisions and detect changed bytes',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'evolution-supply-'));
  try{
    const config={dataDir,evolutionEnabled:true},supply=createPlatformSkillSupply(config),candidate={id:'example',publicationKind:'skill',files:{'SKILL.md':'---\nname: example\ndescription: Sample workflow.\n---\n\nVersion one.'}},opts={card:{toolKind:'workflow'},evaluation:{ok:true,verificationLevel:'V0',smokePassed:true}};
    const first=await supply.publish(candidate,opts),pinned=await supply.prepareForRuntime({id:'project',capabilityId:'statistics'});
    candidate.files['SKILL.md']+='\nVersion two.';const second=await supply.publish(candidate,opts);
    assert.equal(first.revision,1);assert.equal(second.revision,2);assert.notEqual(first.generationHash,second.generationHash);
    assert.equal((await verifyPlatformSkillGeneration(config,pinned.reference)).pins[0].revision,1);
    const target=path.join(platformSkillGenerationRoot(config,pinned.reference),'skills',first.nativeName,'SKILL.md');await fs.chmod(target,0o644);await fs.writeFile(target,'changed');await fs.chmod(target,0o444);
    await assert.rejects(()=>verifyPlatformSkillGeneration(config,pinned.reference));
    await supply.retire('example');assert.equal(await supply.prepareForRuntime({id:'project',capabilityId:'statistics'}),null);
    candidate.files['SKILL.md']+='\nVersion three.';assert.equal((await supply.publish(candidate,opts)).revision,3);
    await assert.rejects(()=>supply.publish({...candidate,capabilityIds:['another-scope']},opts));
  }finally{await fs.rm(dataDir,{recursive:true,force:true});}
});
test('builder never promotes self tests and returns evaluator IDs without hidden answers',async()=>{
  let published=false,seen;
  const builder=createEvolutionBuilder({dispatch:async card=>{seen=card;return{id:'new-tool',publicationKind:'skill',files:{'SKILL.md':'candidate'}};},verification:{verify:async()=>({ok:true})},evaluator:{evaluate:async()=>({ok:false,failedCaseIds:['case-opaque'],expected:42,scoringRules:'hidden'})},publisher:{publish:async()=>{published=true;}}});
  const result=await builder.build({id:'card',hiddenCases:[42],holdoutCases:[{answer:42}],scoringRules:'secret',measurements:{reference:{expected:42}},sourcePapers:[{reportedResults:42}],arbitraryScoutingField:{answer:42}});
  assert.equal(published,false);assert.deepEqual(seen,{id:'card'});assert.equal(result.feedback.passed,false);assert.equal(result.feedback.failedCaseIds.length,1);assert.match(result.feedback.failedCaseIds[0],/^case-[a-f0-9]{16}$/);assert.notEqual(result.feedback.failedCaseIds[0],'case-opaque');assert.deepEqual(Object.keys(result.feedback),['passed','failedCaseIds']);assert.equal(JSON.stringify(result).includes('42'),false);
});
test('builder preserves faithful impossibility and stages engine review without publishing',async()=>{
  let failure,published=false;
  const dependencies={verification:{},evaluator:{},publisher:{publish:async()=>{published=true;}},recordFailure:async value=>{failure=value;}};
  const impossible=createEvolutionBuilder({...dependencies,dispatch:async()=>({status:'impossible',reason:'Specification is incomplete.'})});
  assert.equal((await impossible.build({id:'card'})).status,'impossible');assert.equal(failure.reason,'Specification is incomplete.');
  const review=createEvolutionBuilder({...dependencies,dispatch:async()=>({publicationKind:'engine-pr',files:{}}),writeEnginePrInput:async value=>({cardId:value.card.id})});assert.equal((await review.build({id:'card'})).status,'review');assert.equal(published,false);
});
test('disposable executor enforces no-network/read-only input and scans cheating AST', {skip:!dockerAvailable},async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'evolution-executor-'));
  const controller=createEvolutionVerificationController({dataDir,evolutionEnabled:true,runtimeContainerBin:'docker',runtimeContainerImage:image});
  try{
    const result=await controller.execute({files:{'scripts/example.py':'value=7\n'},code:"import pathlib,socket\np=pathlib.Path('/candidate/scripts/example.py')\nassert p.read_text()=='value=7\\n'\ntry:\n p.write_text('changed')\n raise AssertionError('input was writable')\nexcept OSError: pass\nassert not pathlib.Path('/var/run/docker.sock').exists()\nassert not pathlib.Path('/workspace/customer-data').exists()\ntry:\n socket.create_connection(('1.1.1.1',443),timeout=.2)\n raise AssertionError('network reached')\nexcept OSError: pass\nprint('isolated')"});
    assert.match(result.output,/isolated/);assert.equal(result.joined,true);
    const checked=await controller.execute({files:{'scripts/bad.py':'import socket\nassert True\nclass Always:\n def __eq__(self,x): return True\ntry:\n value=1/0\nexcept Exception:\n pass\n'},code:EVOLUTION_STATIC_CHECK});
    const aliases=await controller.execute({files:{'scripts/aliases.py':'import os as system\nsystem._exit(0)\nassert 1==1\nvalue=getattr(object,"__subclasses__")\n'},code:EVOLUTION_STATIC_CHECK});
    assert.ok(JSON.parse(aliases.output).issues.some(issue=>issue.code==='candidate_control_override'));
    const issues=JSON.parse(checked.output).issues.map(item=>item.code);for(const code of ['candidate_network_import_denied','candidate_constant_assert','candidate_constant_equality','candidate_exception_swallowed'])assert.ok(issues.includes(code));
    assert.equal((await fs.readdir(path.join(dataDir,'.openscience','extension-controller'))).filter(name=>name.endsWith('.json')).length,0);
  }finally{await controller.close();await fs.rm(dataDir,{recursive:true,force:true});}
});

test('protocol 12 exposes only bounded candidate execution and refuses command selectors',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'ev-protocol-')),socketPath=path.join(dataDir,'controller.sock');let observed;
  const tools={run:async(_descriptor,_identity,args)=>{observed=args;return 'verified';},admissionAvailable:async()=>true};
  const server=createRuntimeController({dataDir,runtimeControllerSocket:socketPath,runtimeContainerBin:'docker',runtimeContainerImage:image,evolutionEnabled:true},{evolutionVerification:{tools,imageId:async()=> 'sha256:'+'a'.repeat(64)}});
  try{
    await server.listen();const client=new RuntimeControllerClient({runtimeControllerSocket:socketPath});
    assert.equal((await client.health()).protocolVersion,RUNTIME_CONTROLLER_PROTOCOL_VERSION);assert.equal(RUNTIME_CONTROLLER_PROTOCOL_VERSION,12);
    const result=await client.execVerify({files:{'scripts/x.py':'value=1'},code:"print('verified')"});assert.equal(result.output,'verified');assert.equal(observed.candidateFiles['scripts/x.py'],'value=1');
    assert.ok(observed.mounts.includes('/workspace:ro,noexec,nosuid,nodev,size=1m'));
    await assert.rejects(()=>client.execVerify({files:{},code:'',imageId:'attacker-selected'}),error=>error.code==='extension_contract_invalid');
  }finally{await server.close();await fs.rm(dataDir,{recursive:true,force:true});}
});
test('isolated publication executes its exact retained revision after discovery retirement',{skip:!dockerAvailable},async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'ev-publication-')),config={dataDir,evolutionEnabled:true,runtimeContainerBin:'docker',runtimeContainerImage:image};
  const controller=createEvolutionVerificationController(config),supply=createPlatformSkillSupply(config);
  try{
    const candidate={id:'double',publicationKind:'isolated-tool',entrypoint:'scripts/double.py:calculate',files:{'SKILL.md':'---\nname: double\ndescription: Double a public numerical input.\n---\n\nUse the isolated calculation.','scripts/double.py':"def calculate(value):\n return {'result':value*2}\n"}};
    const published=await supply.publish(candidate,{card:{toolKind:'calculation'},evaluation:{ok:true,verificationLevel:'V2'}}),generation=await supply.prepareForRuntime({id:'project',capabilityId:'statistics'});
    await supply.retire('double');assert.equal(await supply.prepareForRuntime({id:'project',capabilityId:'statistics'}),null);
    const request={toolId:'double',digest:published.digest,args:{value:7}},execute=(body,options)=>controller.execute(body,options);
    assert.deepEqual(await supply.executeIsolated({id:'project'},request,execute,{pins:generation.pins}),{result:14});
    assert.deepEqual(await supply.executeIsolatedBatch({id:'project'},request,[{value:1},{value:2}],execute,{pins:generation.pins}),[{result:2},{result:4}]);
    await assert.rejects(()=>supply.executeIsolated({id:'project'},request,execute,{pins:[]}));
    await assert.rejects(()=>supply.executeIsolated({id:'project'},request,async()=>({ok:false,output:'{\"result\":14}'}),{pins:generation.pins}));
  }finally{await controller.close();await fs.rm(dataDir,{recursive:true,force:true});}
});

test('staged immutable publication stays invisible until catalogue validation activates its exact revision',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'ev-staging-')),supply=createPlatformSkillSupply({dataDir,evolutionEnabled:true});
  try{
    const candidate={id:'staged',publicationKind:'skill',files:{'SKILL.md':'---\nname: staged\ndescription: A staged workflow.\n---\n\nInstructions.'}},publication=await supply.publish(candidate,{card:{toolKind:'workflow'},evaluation:{ok:true,verificationLevel:'V0',smokePassed:true},activate:false});
    assert.equal(await supply.prepareForRuntime({id:'project'}),null);
    await assert.rejects(()=>supply.activate({...publication,digest:'sha256:'+'f'.repeat(64)}));
    const restarted=createPlatformSkillSupply({dataDir,evolutionEnabled:true});
    assert.equal(await restarted.prepareForRuntime({id:'project'}),null);
    const replay=await restarted.publish(candidate,{card:{toolKind:'workflow'},evaluation:{ok:true,verificationLevel:'V0',smokePassed:true},activate:false});assert.equal(replay.revision,publication.revision);
    await restarted.activate(publication);assert.equal((await restarted.prepareForRuntime({id:'project',capabilityId:'statistics'})).pins[0].digest,publication.digest);
  }finally{await fs.rm(dataDir,{recursive:true,force:true});}
});

test('isolated tool instructions invoke the immutable gateway client outside the workspace',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'isolated-instruction-'));try{
    const supply=createPlatformSkillSupply({dataDir,evolutionEnabled:true});
    const publication=await supply.publish({id:'callable',publicationKind:'isolated-tool',entrypoint:'scripts/callable.py:callable',capabilityIds:['statistical-analysis'],files:{'SKILL.md':'---\nname: callable\ndescription: A validated callable.\n---\n\nUse JSON input.','scripts/callable.py':'def callable(specification):\n return specification\n','scripts/callable.tool.json':'{}','tests/test_callable.py':'def test_callable():\n assert 1 == 2\n'}},{evaluation:{ok:true,verificationLevel:'V1'}});
    const generation=await supply.prepareForRuntime({capabilityId:'statistical-analysis'});
    const mounted=path.join(platformSkillGenerationRoot({dataDir},generation.reference),'skills',publication.nativeName);
    assert.ok((await fs.readFile(path.join(mounted,'SKILL.md'),'utf8')).includes(`python3 "$EVIMED_PLATFORM_SKILLS_DIR/${publication.nativeName}/scripts/invoke_isolated.py"`));
    assert.deepEqual(generation.pins[0].files.map(file=>file.path).sort(),['SKILL.md','scripts/invoke_isolated.py']);
    const replay=await supply.candidateForEvaluation(publication);
    assert.equal(replay.files['scripts/callable.py'],'def callable(specification):\n return specification\n');
    assert.ok(replay.files['tests/test_callable.py']);assert.ok(replay.files['scripts/callable.tool.json']);
    let sent;
    await supply.executeIsolated({capabilityId:'statistical-analysis'},{toolId:'callable',digest:publication.digest,args:{specification:{n:1}}},async body=>{sent=body.files;return{ok:true,output:'{}'};},{pins:generation.pins});
    assert.deepEqual(sent,replay.files);
  }finally{await fs.rm(dataDir,{recursive:true,force:true});}
});

test('script-bearing candidates cannot select native skill execution and frozen metadata drift refuses execution',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'isolated-boundary-'));try{
    const supply=createPlatformSkillSupply({dataDir,evolutionEnabled:true});
    const candidate={id:'frozen',publicationKind:'skill',toolKind:'workflow',entrypoint:'scripts/frozen.py:frozen',files:{'SKILL.md':'---\nname: frozen\ndescription: Frozen callable.\n---\n','scripts/frozen.py':'def frozen(specification):\n return specification\n'}};
    const options={card:{toolKind:'workflow'},evaluation:{ok:true,verificationLevel:'V1'}};
    await assert.rejects(()=>supply.publish(candidate,options));
    for(const suffix of ['R','sh','js','PY']){
      const unsupported={...candidate,files:{'SKILL.md':candidate.files['SKILL.md'],['scripts/implementation.'+suffix]:'executable candidate'}};
      await assert.rejects(()=>supply.publish(unsupported,options));
    }
    candidate.publicationKind='isolated-tool';const publication=await supply.publish(candidate,options),generation=await supply.prepareForRuntime({capabilityId:'statistics'});
    let calls=0;const execute=async()=>{calls++;return{ok:true,output:'{}'};},request={toolId:candidate.id,digest:publication.digest,args:{specification:{}}};
    await supply.executeIsolated({},request,execute,{pins:generation.pins});assert.equal(calls,1);
    const mismatched=structuredClone(generation.pins);mismatched[0].entrypoint='scripts/frozen.py:other';
    await assert.rejects(()=>supply.executeIsolated({},request,execute,{pins:mismatched}));assert.equal(calls,1);
    const idHash=(await import('node:crypto')).createHash('sha256').update(candidate.id).digest('hex');
    const saved=path.join(dataDir,'.openscience/platform-skills/revisions',idHash,publication.digest.slice(7)+'.json');
    const record=JSON.parse(await fs.readFile(saved,'utf8'));record.dependencies=['changed-dependency'];await fs.chmod(saved,0o644);await fs.writeFile(saved,JSON.stringify(record));
    await assert.rejects(()=>supply.executeIsolated({},request,execute,{pins:generation.pins}));assert.equal(calls,1);
  }finally{await fs.rm(dataDir,{recursive:true,force:true});}
});

test('verified plain Markdown publication preserves source bytes and exposes only the isolated proxy', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evolution-plain-skill-'));
  try {
    const config = { dataDir, evolutionEnabled: true }, supply = createPlatformSkillSupply(config);
    const candidate = { id: 'verified-cohort', title: 'Cohort calculation', publicationKind: 'isolated-tool', entrypoint: 'scripts/cohort.py:calculate', files: { 'SKILL.md': '# Cohort calculation\n\nUse the published method.', 'scripts/cohort.py': 'def calculate(specification):\n return {"cost": 1}\n', 'tests/test_cohort.py': 'from scripts.cohort import calculate\nassert calculate({})["cost"] == 1\n' } };
    const publication = await supply.publish(candidate, { card: { toolKind: 'calculation' }, evaluation: { ok: true, verificationLevel: 'V2' }, activate: false });
    assert.deepEqual((await supply.candidateForEvaluation(publication)).files, candidate.files);
    assert.equal(await supply.prepareForRuntime({ id: 'project' }), null);
    await supply.activate(publication);
    const generation = await supply.prepareForRuntime({ id: 'project', capabilityId: 'statistics' });
    const pin = generation.pins[0], root = platformSkillGenerationRoot(config, generation.reference);
    assert.deepEqual(pin.files.map(file => file.path).sort(), ['SKILL.md', 'scripts/invoke_isolated.py'].sort());
    const skill = await fs.readFile(path.join(root, 'skills', pin.nativeName, 'SKILL.md'), 'utf8');
    assert.ok(skill.startsWith(`---\nname: ${pin.nativeName}\n`));
    assert.ok(skill.includes(candidate.files['SKILL.md']));
    await assert.rejects(supply.publish({ ...candidate, id: 'malformed', files: { ...candidate.files, 'SKILL.md': '---\nname: broken\n---\nBody' } }, { card: { toolKind: 'calculation' }, evaluation: { ok: true, verificationLevel: 'V2' } }), error => error.code === 'extension_contract_invalid');
  } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
});
