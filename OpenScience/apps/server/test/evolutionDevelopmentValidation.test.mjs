import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createEvolutionDevelopmentValidation } from '../src/evolutionDevelopmentValidation.mjs';
test('actual deterministic public runner distinguishes clear input refusal from silent arithmetic and unrelated exceptions',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'public-boundaries-'));
  const controller={execVerify:async request=>{
    await fs.mkdir(path.join(root,'scripts'),{recursive:true});await fs.writeFile(path.join(root,'scripts/tool.py'),request.files['scripts/tool.py']);
    return new Promise(resolve=>{const child=spawn('python3',['-c',request.code.replaceAll('/candidate/',root+'/')]);let output='';child.stdout.on('data',data=>{output+=data;});child.stderr.resume();child.stdin.end(JSON.stringify(request.input));child.on('close',code=>resolve({ok:code===0,joined:true,executionStarted:true,output}));});
  }};
  const validator=createEvolutionDevelopmentValidation({controller});
  const contract={cases:[{id:'normal',input:{value:1},expected:{estimate:2},absoluteTolerance:1e-8},{id:'negative',input:{value:-1},expectedRefusal:true}]};
  const candidate={entrypoint:'scripts/tool.py:calculate',files:{'scripts/tool.py':'def calculate(value):\n if value<0: return {"status":"refused","reason":"negative input"}\n return {"estimate":value*2}\n'}};
  try {
    assert.equal((await validator.validate(candidate,{contract})).ok,true);
    const relative={cases:[{id:'relative',input:{value:1},expected:{estimate:2.1},absoluteTolerance:0,relativeTolerance:.1}]};
    assert.equal((await validator.validate(candidate,{contract:relative})).ok,true);
    relative.cases[0].relativeTolerance=0;assert.equal((await validator.validate(candidate,{contract:relative})).ok,false);
    relative.cases[0].absoluteTolerance=-1;assert.equal((await validator.validate(candidate,{contract:relative})).status,'waiting_resource');
    candidate.files['scripts/tool.py']='def calculate(value):\n return {"estimate":value*2}\n';
    assert.equal((await validator.validate(candidate,{contract})).issues[0].caseId,'negative');
    candidate.files['scripts/tool.py']='def calculate(value):\n if value<0: raise RuntimeError("unrelated internal failure")\n return {"estimate":value*2}\n';
    assert.equal((await validator.validate(candidate,{contract})).ok,false);
    candidate.files['scripts/tool.py']='def calculate(value):\n if value<0: raise ValueError("negative input")\n return {"estimate":value*2}\n';
    assert.equal((await validator.validate(candidate,{contract})).ok,true);
    candidate.files['scripts/tool.py']='def calculate(value):\n if value<0: return {"status":"unsupported","soc":{"cost":-1}}\n return {"estimate":value*2}\n';
    assert.equal((await validator.validate(candidate,{contract})).ok,false);
    candidate.files['scripts/tool.py']='def calculate(value):\n if value<0: return {"status":"refused","reason":"invalid"}\n return {"estimate":value*2,"extra":1}\n';
    assert.equal((await validator.validate(candidate,{contract})).ok,false);
    candidate.files['scripts/tool.py']='invalid syntax !';
    assert.equal((await validator.validate(candidate,{contract})).status,'repair');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('resource unavailability or no execution cannot count as scientific rejection',async()=>{
  const candidate={entrypoint:'scripts/tool.py:calculate',files:{'scripts/tool.py':'pass'}},contract={cases:[{id:'negative',input:{},expectedRefusal:true}]};
  assert.equal((await createEvolutionDevelopmentValidation({controller:{execVerify:async()=>({ok:false,joined:true,executionStarted:false})}}).validate(candidate,{contract})).status,'waiting_resource');
  assert.equal((await createEvolutionDevelopmentValidation({controller:{execVerify:async()=>{throw new Error('unavailable');}}}).validate(candidate,{contract})).status,'waiting_resource');
});
