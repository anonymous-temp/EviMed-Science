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

const image='docker.m.daocloud.io/library/python:3.12-slim-bookworm';
const dockerAvailable=spawnSync('docker',['image','inspect',image],{stdio:'ignore',timeout:5000}).status===0;
test('verification rejects caller paths and execution authority',()=>{
  for(const files of [{'../secret':'x'},{'/etc/passwd':'x'},{'scripts/../../x.py':'x'}])assert.throws(()=>verificationRequest({files,code:''}));
  for(const field of ['imageId','workspace','socket','env','command'])assert.throws(()=>verificationRequest({files:{},code:'', [field]:'untrusted'}));
});
test('disposable executor enforces no-network/read-only input and scans cheating AST', {skip:!dockerAvailable},async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'evolution-executor-'));
  const controller=createEvolutionVerificationController({dataDir,runtimeContainerBin:'docker',runtimeContainerImage:image});
  try{
    const result=await controller.execute({files:{'scripts/example.py':'value=7\n'},code:"import pathlib,socket\np=pathlib.Path('/candidate/scripts/example.py')\nassert p.read_text()=='value=7\\n'\ntry:\n p.write_text('changed')\n raise AssertionError('input was writable')\nexcept OSError: pass\nassert not pathlib.Path('/var/run/docker.sock').exists()\nassert not pathlib.Path('/workspace/customer-data').exists()\ntry:\n socket.create_connection(('1.1.1.1',443),timeout=.2)\n raise AssertionError('network reached')\nexcept OSError: pass\nprint('isolated')"});
    assert.match(result.output,/isolated/);assert.equal(result.joined,true);
    const checked=await controller.execute({files:{'scripts/bad.py':'import socket\nassert True\nclass Always:\n def __eq__(self,x): return True\ntry:\n value=1/0\nexcept Exception:\n pass\n'},code:EVOLUTION_STATIC_CHECK});
    const aliases=await controller.execute({files:{'scripts/aliases.py':'import os as system\nsystem._exit(0)\nassert 1==1\nvalue=getattr(object,"__subclasses__")\n'},code:EVOLUTION_STATIC_CHECK});
    assert.ok(JSON.parse(aliases.output).issues.some(issue=>issue.code==='candidate_control_override'));
    const issues=JSON.parse(checked.output).issues.map(item=>item.code);for(const code of ['candidate_network_import_denied','candidate_constant_assert','candidate_constant_equality','candidate_exception_swallowed'])assert.ok(issues.includes(code));
    assert.equal((await fs.readdir(path.join(dataDir,'.openscience','evolution-controller'))).filter(name=>name.endsWith('.json')).length,0);
  }finally{await controller.close();await fs.rm(dataDir,{recursive:true,force:true});}
});

test('protocol 12 exposes only bounded candidate execution and refuses command selectors',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'ev-protocol-')),socketPath=path.join(dataDir,'controller.sock');let observed;
  const dockerBin=path.join(dataDir,'docker-info.mjs');
  // Execution is injected below; health must use the same isolated test boundary.
  await fs.writeFile(dockerBin,`#!/usr/bin/env node\nif(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['info','--format','{{.ServerVersion}}']))process.exit(1);\nconsole.log('27.0.0');\n`,{mode:0o755});
  const tools={run:async(_descriptor,_identity,args)=>{observed=args;return 'verified';},admissionAvailable:async()=>true};
  const server=createRuntimeController({dataDir,runtimeControllerSocket:socketPath,runtimeContainerBin:dockerBin,runtimeContainerImage:image},{evolutionVerification:{tools,imageId:async()=> 'sha256:'+'a'.repeat(64)}});
  try{
    await server.listen();const client=new RuntimeControllerClient({runtimeControllerSocket:socketPath});
    assert.equal((await client.health()).protocolVersion,RUNTIME_CONTROLLER_PROTOCOL_VERSION);assert.ok(RUNTIME_CONTROLLER_PROTOCOL_VERSION>=12);
    const result=await client.execVerify({files:{'scripts/x.py':'value=1'},code:"print('verified')"});assert.equal(result.output,'verified');assert.equal(observed.candidateFiles['scripts/x.py'],'value=1');
    assert.ok(observed.mounts.includes('/workspace:ro,noexec,nosuid,nodev,size=1m'));
    await assert.rejects(()=>client.execVerify({files:{},code:'',imageId:'attacker-selected'}),error=>error.code==='extension_contract_invalid');
  }finally{await server.close();await fs.rm(dataDir,{recursive:true,force:true});}
});
