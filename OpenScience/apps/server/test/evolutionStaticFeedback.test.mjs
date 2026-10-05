import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {EVOLUTION_STATIC_CHECK} from '../src/evolutionVerification.mjs';
import {verifyCodeSkill} from '../src/codeSkillVerification.mjs';
import {createEvolutionBuilder} from '../src/evolutionBuild.mjs';
test('static Python checks accept standard UTF-8 BOM without weakening forbidden constructs',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'candidate-bom-'));
 try{
 await writeFile(path.join(root,'valid.py'),'\ufeffdef calculate(x):\n return x+1\n');await writeFile(path.join(root,'forbidden.py'),'\ufeffimport sys, subprocess\ndef unsafe(x):\n getattr(x,"value")\n sys.exit(0)\n');
 const program=EVOLUTION_STATIC_CHECK.replaceAll("'/candidate'",JSON.stringify(root)),result=spawnSync('python3',['-c',program],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 const issues=JSON.parse(result.stdout).issues;assert.equal(issues.some(issue=>issue.path==='valid.py'),false);assert.equal(issues.some(issue=>issue.code==='candidate_syntax_invalid'),false);assert.ok(issues.some(issue=>issue.code==='candidate_control_override'));assert.ok(issues.some(issue=>issue.code==='candidate_network_import_denied'));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('builder returns its own static diagnostics but does not evaluate or return hidden material',async()=>{
 const builder=createEvolutionBuilder({dispatch:async()=>({publicationKind:'skill',files:{'script.py':'bad'}}),verification:{verify:async()=>({ok:false,issues:[{code:'candidate_control_override',path:'script.py',message:'Dynamic getattr is forbidden',hiddenExpected:42}]})},evaluator:{evaluate:async()=>{throw new Error('Static failure must stop evaluation');}},publisher:{},recordFailure:async()=>{}});
 const result=await builder.build({id:'card'});assert.deepEqual(result.feedback.issues,[{code:'candidate_control_override',path:'script.py',message:'Dynamic getattr is forbidden'}]);assert.equal(JSON.stringify(result).includes('42'),false);
});

test('BOM at the first Python function passes the schema and self-test stage without changing frozen bytes',async()=>{
 const source='\ufeffdef method(specification):\n return specification\nif __name__ == "__main__":\n assert method({}) == {}\n';
 const files={'scripts/method.py':source,'tests/test_method.py':'from scripts.method import method\nassert method({}) == {}','scripts/method.tool.json':JSON.stringify({name:'method',description:'Echo',parameters:{type:'object',properties:{specification:{type:'object',description:'Input specification'}},required:['specification']}})};
 const result=await verifyCodeSkill({files,project:{},runKernel:async()=>({ok:true}),runFiles:async()=>({ok:true,output:'code-skill-verified:method'})});assert.equal(result.ok,true,JSON.stringify(result.issues));assert.equal(files['scripts/method.py'],source);
});

test('trusted self-test discovery accepts asserted negative-input helpers and fails actual assertions despite a custom runner',async()=>{
 const {createEvolutionVerification}=await import('../src/evolutionVerification.mjs');
 const root=await mkdtemp(path.join(os.tmpdir(),'negative-helper-'));
 try{
 const execute=async body=>{
  const {mkdir}=await import('node:fs/promises');
  for(const [name,text] of Object.entries(body.files)){await mkdir(path.dirname(path.join(root,name)),{recursive:true});await writeFile(path.join(root,name),text);}
  const result=spawnSync('python3',['-c',body.code.replaceAll('/candidate',root)],{encoding:'utf8',cwd:root,env:{...process.env,PYTHONPATH:root}});
  return{ok:result.status===0,output:result.stdout,stderr:result.stderr};
 };
 const script='def method(value):\n if value < 0: raise ValueError("negative")\n return value\nif __name__ == "__main__":\n assert method(1) == 1\n';
 const helper='from scripts.method import method\ndef refused(value):\n \"Expected refusal only.\"\n try:\n  method(value)\n except ValueError:\n  return True\n return False\ndef test_negative():\n assert refused(-1)\n';
 const schema=JSON.stringify({name:'method',description:'Identity for nonnegative values',parameters:{type:'object',properties:{value:{type:'number',description:'Nonnegative value'}},required:['value']}});
 const files={'scripts/method.py':script,'scripts/method.tool.json':schema,'tests/test_method.py':helper};
 const verifier=createEvolutionVerification({execute});assert.equal((await verifier.verify({files})).ok,true);
 const failed=await verifier.verify({files:{...files,'tests/test_method.py':helper+'def test_wrong():\n assert method(1) == 2\ndef custom_runner():\n return 0\nif __name__ == "__main__":\n custom_runner()\n'}});assert.equal(failed.ok,false);assert.ok(failed.executions.some(row=>row.status==='failed'));
 for(const handler of ['except AssertionError:\n  print("passed")','except Exception:\n  return True','except ValueError:\n  return True']){
  const text='def test_bad():\n try:\n  assert 1 == 2\n '+handler+'\n';
  const bad=await verifier.verify({files:{...files,'tests/test_method.py':text}});assert.equal(bad.ok,false);assert.ok(bad.issues.some(issue=>issue.code==='candidate_exception_swallowed'));
 }
 }finally{await rm(root,{recursive:true,force:true});}
});
