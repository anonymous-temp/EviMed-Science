import assert from 'node:assert/strict';
import test from 'node:test';
import { createVcrLanguageUnitExecutor } from '../src/vcrLanguageExecutor.mjs';

const unit={userId:'u1',model:'deepseek-flash',thinking:'disabled',outputLimit:1000,criterionKey:'k',axis:'requirement',documents:[{id:'d1'}]};
const input={unit,jobId:'j1',leaseOwner:'w1',leaseAttempt:1,projectId:'p1',runLimit:2};
const config={deepseekBaseUrl:'https://api.deepseek.com',deepseekApiKey:'fixture',production:true};
function fixture(finish='stop',state='unknown') {
  const writes=[];
  const candidateStore={dispatchLanguageUnit:async ({onAuthorized})=>onAuthorized({unit,criteria:[{kind:'inclusion',sourceText:'full',requirement:{op:'language',text:'full'}}],documents:[{documentId:'d1',text:'synthetic',visibleAt:null}]}),
    commitLanguageUnit:async payload=>{writes.push(payload);return{id:'judgment1'};}};
  const ledger={reserveModel:async()=>({id:'reservation'}),settleModel:async()=>{}};
  const transport=()=>({handoff:Promise.resolve(),response:Promise.resolve({status:200,body:Buffer.from(JSON.stringify({choices:[{finish_reason:finish,message:{content:JSON.stringify({state,evidence:[]})}}],usage:{prompt_tokens:3,completion_tokens:2}}))})});
  return {writes,execute:createVcrLanguageUnitExecutor({candidateStore,loadSources:async()=>[],verifySources:async()=>true,config,usageLedger:ledger,transport})};
}
test('completed unknown is committed through the fenced writer',async()=>{
  const f=fixture();assert.deepEqual(await f.execute(input),{id:'judgment1',reevaluation:'pending'});assert.equal(f.writes[0].state,'unknown');
});
test('truncation or unsupported evidence never writes a clinical unknown',async()=>{
  for(const [finish,state] of [['length','unknown'],['stop','satisfied']]){
    const f=fixture(finish,state);await assert.rejects(f.execute(input));assert.equal(f.writes.length,0);
  }
});
