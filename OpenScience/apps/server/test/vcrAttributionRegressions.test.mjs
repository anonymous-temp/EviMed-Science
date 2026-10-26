import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyVcrInvocation } from '../src/vcrExecutionContext.mjs';
import { createVcrPatientContext } from '../src/vcrPatientContext.mjs';
import { VcrJobs } from '../src/vcrJobs.mjs';

const project={id:'p',userId:'u'};
async function proof(tool,input,operation,body){
 let options;
 const result=await verifyVcrInvocation({header:JSON.stringify({v:1,sessionId:'root',callId:'call'}),project,
  runtimeManager:{sessionTranscript:async(_p,_s,o)=>{options=o;return{sessionId:'root',truncated:false,turns:[{startSeq:9001,end:null}],messages:[{turnStartSeq:9001,parts:[{type:'tool',callId:'call',status:'pending',tool,input}]}]};}},
  resolveSession:()=>null,runs:[{id:'run',sessionId:'root'}],operation,body});
 return {result,options};
}
test('native proof follows wrapper null presence and Unicode code point rules',async()=>{
 await proof('curve_digitize',{imageArtifactId:'image',calibration:{},arms:[],plotArea:null},'digitize',{imageArtifactId:'image',calibration:{},arms:[]});
 await proof('vcr_write',{what:'definition',data:null},'write',{what:'definition',data:null});
 const parameter='𝛽'.repeat(70);
 await proof('evidence_pool',{parameter,endpointKey:'survival'},'simulate',{action:'start',kind:'pool_evidence',subjectId:parameter,scenario:{parameter,endpointKey:'survival'}});
});
test('native proof asks only for the current open turn',async()=>{
 const {options}=await proof('vcr_read',{what:'study'},'read',{what:'study'});assert.equal(options.currentTurn,true);
});
test('patient intake rejects platform generated library uploads before capture',async()=>{
 for(const path of ['knowledge-base/wiki/compiled.md','knowledge-base/kg/graph.md','knowledge-base/chat/answer.md','knowledge-base/frontier/news.md','knowledge-base/links/page.md']){
  let capture=false;
  const intake=createVcrPatientContext({dataPlane:{},sources:{get:async()=>({id:'source',userId:'u',projectId:'p',payload:{connector:{type:'upload'},paths:[path]}}),loadCapture:async()=>{capture=true;return{input:{text:'Model prose'}};}},store:{},dataStore:{},documents:{},transcript:async()=>null,isHumanMessage:async()=>true});
  await assert.rejects(intake({}, {sourceId:'source'}, {userId:'u',projectId:'p'}),{code:'vcr_patient_context_invalid'});assert.equal(capture,false);
 }
});
test('finish recovery applies all independent hooks even without a conversation origin',async()=>{
 const row={id:'j',study_id:'s',user_id:'u',state:'failed',checkpoint:{},error:{code:'engine_failed'}};
 const store={one:async sql=>sql.startsWith('UPDATE') && !sql.includes('RETURNING id`') && !sql.includes('RETURNING id')?row:null,query:async()=>({rowCount:1}),rows:async()=>[]};
 const jobs=new VcrJobs({store});jobs.resultOf=async()=>null;
 let second=0;jobs.addFinishHook(async()=>{throw Object.assign(new Error('first consumer failed'),{code:'consumer_failed'});});jobs.addFinishHook(async done=>{assert.equal(done.job.state,'failed');second++;});
 await jobs.deliverFinishHooks('j');assert.equal(second,1);
});

test('earlier authenticated cases are discoverable by bounded immutable message references',async()=>{
 const messages=[{role:'user',source:'user',seq:8,parts:[{type:'text',text:'Synthetic original case, age 62.'}]},{role:'assistant',source:'system',seq:9,parts:[{type:'text',text:'Invented case'}]},{role:'user',source:'user',seq:10,parts:[{type:'text',text:'Match the earlier case.'}]}];
 const calls=[];const intake=createVcrPatientContext({store:{},dataStore:{},dataPlane:{},documents:{},transcript:async(_origin,opts)=>{calls.push(opts);return{sessionId:'root',messages,exhausted:true};},isHumanMessage:async()=>true});
 const result=await intake.candidates({rootSessionId:'root'},{limit:2});
 assert.deepEqual(result.candidates.map(row=>row.messageSeq),[10,8]);assert.match(result.candidates[1].sha256,/^[a-f0-9]{64}$/);assert.equal(result.nextBeforeSeq,8);assert.equal(calls[0].maxPages,4);
 await assert.rejects(intake.candidates({rootSessionId:'root'},{limit:1000}),{code:'vcr_patient_context_invalid'});
});

test('candidate pagination reaches every authenticated case when one fetched page exceeds the result limit',async()=>{
 const messages=Array.from({length:25},(_,index)=>({role:'user',source:'user',seq:index+1,parts:[{type:'text',text:`Synthetic case ${index+1}`}]}));
 const intake=createVcrPatientContext({store:{},dataStore:{},dataPlane:{},documents:{},isHumanMessage:async()=>true,transcript:async(_o,{beforeSeq})=>({sessionId:'root',messages:messages.filter(message=>beforeSeq==null||message.seq<beforeSeq),exhausted:true})});
 const seen=[];let cursor;
 do {const page=await intake.candidates({rootSessionId:'root'},{limit:20,...(cursor==null?{}:{beforeSeq:cursor})});seen.push(...page.candidates.map(row=>row.messageSeq));cursor=page.nextBeforeSeq;}while(cursor!=null);
 assert.equal(new Set(seen).size,25);assert.deepEqual(seen,Array.from({length:25},(_,index)=>25-index));
});
