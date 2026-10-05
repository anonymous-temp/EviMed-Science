import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createEvolutionSelfCheck} from '../src/evolutionSelfCheck.mjs';

test('plasmode sends only required covariates and stores a private diagnostic, never shared rows',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'evolution-self-check-'));
  try{
    const csv='patient_id,age\n'+Array.from({length:30},(_,index)=>`secret-${index},${40+index}\n`).join('');await fs.writeFile(path.join(root,'data.csv'),csv);
    const project={id:'project',userId:'owner',workspaceDir:root},digest=createHash('sha256').update(csv).digest('hex');
    const binding={path:'data.csv',sha256:digest,bytes:Buffer.byteLength(csv),rows:30,columns:[{name:'patient_id',type:'text'},{name:'age',type:'number'}]};
    const pin={id:'tool',revision:2,digest:'sha256:'+'a'.repeat(64),publicationKind:'isolated-tool'};
    let persisted;const inputs=[];
    const service={get:async id=>id==='tool'?{revision:2,payload:{selfCheck:{kind:'linear-effect',covariates:['age'],knownEffect:2,negativeControl:true,tolerance:.01}}}:null,save:async(type,id,result,_prior,userId)=>{persisted={type,id,result,userId};return persisted;}};
    const selfCheck=createEvolutionSelfCheck({service,dataSemantics:{get:async()=>({revision:1,asset:{bindings:[binding]}})},store:{userById:async id=>({id}),requireProject:async()=>project},controller:{},supply:{prepareForRuntime:async()=>({pins:[pin]}),executeIsolated:async(_project,request)=>{inputs.push(request.args);const values=request.args.rows.map(row=>row.__evolution_outcome-row.age/100);return{estimate:values[1]-values[0]};}}});
    const result=await selfCheck.run({userId:'owner',projectId:'project',datasetId:'dataset',toolId:'tool'});
    assert.equal(result.userId,'owner');assert.equal(result.result.status,'passed');assert.equal(result.result.dataLevel,'D3');assert.equal(result.result.empiricalEvidence,false);
    assert.equal(inputs.length,2);assert.equal(inputs[0].rows[0].age,40);assert.equal(JSON.stringify(inputs).includes('secret-'),false);assert.equal(JSON.stringify(persisted).includes('secret-'),false);
    await fs.writeFile(path.join(root,'data.csv'),csv.replace('40','41'));await assert.rejects(()=>selfCheck.run({userId:'owner',projectId:'project',datasetId:'dataset',toolId:'tool'}),/changed/);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('unknown self-check method is unsupported, and missing data is never a passed label',async()=>{
  const saved=[];const selfCheck=createEvolutionSelfCheck({service:{get:async()=>null,save:async(_type,_id,payload,_prior,userId)=>{saved.push({payload,userId});return payload;}},dataSemantics:{get:async()=>null},store:{userById:async()=>({id:'owner'}),requireProject:async()=>({id:'project',userId:'owner'})},controller:{},supply:{}});
  const result=await selfCheck.run({userId:'owner',projectId:'project',datasetId:'dataset',toolId:'tool'});assert.equal(result.status,'unsupported');assert.equal(result.dataLevel,'D0');assert.equal(saved[0].userId,'owner');
});

test('decision plasmode keeps real covariates private and batches only aggregate specifications',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'evolution-decision-data-'));
  try{
    const csv='patient_id,age\n'+Array.from({length:64},(_,index)=>`secret-${index},${20+index}\n`).join('');await fs.writeFile(path.join(root,'data.csv'),csv);
    const project={id:'project',userId:'owner',workspaceDir:root},binding={path:'data.csv',sha256:createHash('sha256').update(csv).digest('hex'),bytes:Buffer.byteLength(csv),rows:64,columns:[{name:'age',type:'number'}]},pin={id:'tool',revision:2,digest:'sha256:'+'a'.repeat(64),publicationKind:'isolated-tool'};
    const batches=[];
    const service={get:async id=>id==='tool'?{revision:2,payload:{selfCheck:{kind:'decision-net-benefit',covariates:['age'],replicates:200,seed:'reproducible-fixture',negativeControl:true}}}:null,save:async(type,id,result,_prior,userId)=>({type,id,result,userId})};
    const selfCheck=createEvolutionSelfCheck({service,dataSemantics:{get:async()=>({revision:1,asset:{bindings:[binding]}})},store:{userById:async id=>({id}),requireProject:async()=>project},controller:{},supply:{prepareForRuntime:async()=>({pins:[pin]}),executeIsolatedBatch:async(_project,_request,inputs)=>{batches.push(inputs);return inputs.map(({specification:s})=>({netBenefit:s.truePositive/s.n-s.falsePositive/s.n*s.threshold/(1-s.threshold)}));}}});
    const output=await selfCheck.run({userId:'owner',projectId:'project',datasetId:'dataset',toolId:'tool'});
    assert.equal(output.result.status,'passed');assert.equal(output.result.dataLevel,'D3');assert.equal(output.result.empiricalEvidence,false);assert.ok(output.result.monteCarloError>=0);assert.equal(batches.length,2);
    assert.equal(JSON.stringify(batches).includes('secret-'),false);assert.equal(JSON.stringify(batches).includes('age'),false);assert.equal(JSON.stringify(output).includes('secret-'),false);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('self-check identity follows immutable artifact, protocol and dataset rather than tool telemetry',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'self-check-identity-'));try{
    const csv='age\n'+Array.from({length:30},(_,i)=>`${40+i}\n`).join('');await fs.writeFile(path.join(root,'data.csv'),csv);
    const semantics={revision:1,asset:{bindings:[{path:'data.csv',sha256:createHash('sha256').update(csv).digest('hex'),bytes:Buffer.byteLength(csv),rows:30,columns:[{name:'age'}]}]}};
    const pin={id:'tool',revision:1,digest:'sha256:'+'a'.repeat(64),publicationKind:'isolated-tool'};
    const tool={revision:1,payload:{selfCheck:{kind:'linear-effect',covariates:['age'],knownEffect:2,protocolVersion:1}}};
    const saved=new Map();let calls=0;
    const check=createEvolutionSelfCheck({service:{get:async id=>id==='tool'?tool:saved.get(id),save:async(_type,id,result)=>{saved.set(id,result);return result;}},dataSemantics:{get:async()=>semantics},store:{userById:async()=>({id:'owner'}),requireProject:async()=>({id:'project',userId:'owner',workspaceDir:root})},controller:{},supply:{prepareForRuntime:async()=>({pins:[pin]}),executeIsolated:async()=>{calls++;return{estimate:2};}}});
    const args={userId:'owner',projectId:'project',datasetId:'dataset',toolId:'tool'};
    await check.run(args);assert.equal(calls,1);
    tool.revision++;tool.payload.usage={count:10};await check.run(args);assert.equal(calls,1);
    pin.digest='sha256:'+'b'.repeat(64);pin.revision++;await check.run(args);assert.equal(calls,2);
    tool.payload.selfCheck.protocolVersion++;await check.run(args);assert.equal(calls,3);
    semantics.revision++;await check.run(args);assert.equal(calls,4);
    tool.payload.selfCheck.knownEffect=3;const failed=await check.run(args);assert.equal(calls,5);assert.equal(failed.status,'failed');assert.equal(failed.dataLevel,'D2');assert.equal(tool.payload.dataLevel,undefined);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
