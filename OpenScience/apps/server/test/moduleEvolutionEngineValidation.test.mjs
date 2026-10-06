import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createModuleEvolutionEngineValidation} from '../src/moduleEvolutionEngineValidation.mjs';
import {createEvolutionRepairReproduction} from '../src/evolutionRepairReproduction.mjs';

// Executes the very trusted verification program locally; production uses the disposable controller container.
const controller={execVerify:async body=>{
 const root=await mkdtemp(path.join(tmpdir(),'evolution-validator-'));
 try{
  for(const [name,text] of Object.entries(body.files)){const target=path.join(root,name);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,text);}
  const output=spawnSync('python3',['-c',body.code.replaceAll('/candidate',root)],{input:JSON.stringify(body.input??null),encoding:'utf8',timeout:60000,env:{...process.env,NODE_TEST_CONTEXT:undefined}});
  return {ok:output.status===0,joined:true,executionStarted:output.pid>0,output:output.stdout,stderr:output.stderr};
 }finally{await rm(root,{recursive:true,force:true});}
}};
test('engine validation actually parses Node source and runs direct module regression assertions',async()=>{
 const file='apps/server/src/memoryValidity.mjs',source=await readFile(new URL('../src/memoryValidity.mjs',import.meta.url),'utf8');
 const candidate={files:{[file]:source,'tests/validity.test.mjs':`import test from 'node:test';import assert from 'node:assert/strict';import {versionsInForce} from '../apps/server/src/memoryValidity.mjs';test('project isolation',()=>assert.deepEqual(versionsInForce([{id:'other',scope:'project',scopeId:'other',status:'active'}],{projectId:'public'}),[]));`}};
 const validator=createModuleEvolutionEngineValidation({controller,allowedPaths:[file]});
 assert.equal((await validator.verify(candidate)).ok,true);const measured=await validator.validate(candidate);assert.equal(measured.ok,true,JSON.stringify(measured));assert.equal(measured.independent,false);assert.equal(measured.executions.length,2);
 assert.equal((await validator.validate({files:{...candidate.files,'tests/validity.test.mjs':candidate.files['tests/validity.test.mjs'].replace("assert.deepEqual(versionsInForce", "assert.deepEqual([1,...versionsInForce") .replace("projectId:'public'}),[])","projectId:'public'})],[])" )}})).ok,false);
 assert.equal((await validator.verify({files:{[file]:'export function broken('}})).ok,false);
});
test('repair reproduction executes the exact pinned parent twice and refuses a passing baseline',async()=>{
 const records=new Map(),parent={id:'parent',payload:{artifactDigest:'sha256:pinned',revision:3}};records.set(parent.id,parent);
 const service={get:async id=>records.get(id),now:()=>new Date('2026-10-06'),save:async(type,id,payload)=>{records.set(id,{id,payload});return records.get(id);}};
 const candidate={files:{'scripts/compute.py':'def compute(specification):\n return {"result": specification["value"] + 1}\n'},entrypoint:'scripts/compute.py:compute',dependencies:[]};
 const pins=[],supply={candidateForEvaluation:async pin=>{pins.push(pin);return candidate;}};
 const reproduce=createEvolutionRepairReproduction({service,supply,controller});
 const card={id:'repair',repairOf:{toolId:'parent',artifactDigest:'sha256:pinned'},parentToolIds:['parent']};
 const failed=await reproduce({card,contract:{cases:[{id:'independent-public-example',input:{specification:{value:2}},expected:{result:4}}]}});
 assert.equal(failed.ready,true);assert.equal(failed.results.length,2);assert.ok(failed.results.every(result=>result.executions[0].executed===true&&result.executions[0].passed===false));assert.deepEqual(pins[0],{id:'parent',digest:'sha256:pinned',revision:3});assert.equal(failed.receiptHash.length,64);
 const passed=await reproduce({card:{...card,id:'passing-repair'},contract:{cases:[{id:'correct-example',input:{specification:{value:2}},expected:{result:3}}]}});
 assert.equal(passed.ready,false);assert.equal(passed.reason,'no-reproduced-public-failure');
});
