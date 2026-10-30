import test from 'node:test';
import assert from 'node:assert/strict';
import {preservedRunEvidence,redactRunEvidence} from '../src/runEvidenceRead.mjs';
const run={id:'run-a',sessionId:'session-a',kernelRequestIds:['request-a'],transcript:{sha256:'a'.repeat(64)}};
const message=(seq,start,request,parts,sessionId='session-a')=>({seq,turnStartSeq:start,sourceRequestId:request,parts,sessionId,role:request?'user':'assistant',source:'user'});
const saved={header:{capturedAt:'2026-10-29',completeness:'complete',sessions:[]},messages:[
 message(1,1,'request-old',[{type:'text',text:'Old question'}]),
 message(3,3,'request-a',[{type:'text',text:'Current case'}]),
 message(4,3,null,[{type:'tool',tool:'vcr_read',input:{what:'matching'},output:{n:78}}]),
 message(5,3,null,[{type:'text',text:'Result'},{type:'reasoning',text:'Not public evidence'}]),
 message(7,7,'request-later',[{type:'text',text:'Another question'}]),
]};
test('exact owned run preserves tools after shutdown and excludes other turns',async()=>{
 let reads=0;const result=await preservedRunEvidence({},'session-a','run-a',[run],{read:async(_p,r,d)=>{reads++;assert.equal(r,run);assert.equal(d,run.transcript.sha256);return saved;}});
 assert.equal(reads,1);assert.equal(result.available,true);assert.equal(result.partial,false);
 assert.deepEqual(result.messages.map(x=>x.seq),[3,4,5]);assert.equal(result.messages[1].parts[0].output.n,78);
 assert.equal(result.messages[2].parts.length,1);
});
test('scope failure cannot touch a transcript; missing or unverifiable data stays explicit',async()=>{
 const read=async()=>{throw new Error('must not read');};
 await assert.rejects(preservedRunEvidence({},'foreign','run-a',[run],{read}),{status:404});
 await assert.rejects(preservedRunEvidence({},'session-a','../bad',[run],{read}));
 const missing=await preservedRunEvidence({},'session-a','run-a',[{...run,transcript:null}],{read});assert.equal(missing.reason,'not_captured');
 await assert.rejects(preservedRunEvidence({},'session-a','run-a',[run],{read:async()=>{throw Object.assign(new Error('changed'),{code:'run_transcript_changed'});}}),{code:'run_transcript_changed'});
 const noProof=await preservedRunEvidence({},'session-a','run-a',[run],{read:async()=>({...saved,messages:[]})});assert.equal(noProof.reason,'turn_identity_unavailable');
});
test('children require durable ownership and credentials are removed from projection',async()=>{
 const record={...saved,header:{...saved.header,runChildSessionIds:['child-a'],sessions:[{sessionId:'child-a',parentSessionId:'session-a'},{sessionId:'other-child',parentSessionId:'elsewhere'}]},messages:[...saved.messages,message(1,1,null,[{type:'tool',input:{authorization:'Bearer private',apiKey:'secret-value'},output:'Bearer another-private'}],'child-a'),message(1,1,null,[{type:'text',text:'unrelated'}],'other-child')]};
 const result=await preservedRunEvidence({},'session-a','run-a',[run],{read:async()=>record});
 assert.equal(result.partial,true);assert.ok(!JSON.stringify(result).includes('unrelated'));assert.ok(!JSON.stringify(result).includes('secret-value'));assert.ok(!JSON.stringify(result).includes('another-private'));
 assert.deepEqual(redactRunEvidence({token:'value',events:5}),{token:'[redacted]',events:5});
});

test('signed runtime payloads and serialized credentials never reach the evidence projection',()=>{
 const value=redactRunEvidence({text:'Case <evimed-budget-scope>e30.signature</evimed-budget-scope>',output:'{"apiKey":"private-key"}',header:'password=secret-value'});
 assert.ok(!JSON.stringify(value).includes('e30.signature'));assert.ok(!JSON.stringify(value).includes('private-key'));assert.ok(!JSON.stringify(value).includes('secret-value'));
});
test('injected user roles cannot masquerade as researcher text and immutable child ancestry survives later turns',async()=>{
 const record={header:{...saved.header,runChildSessionIds:['child-a'],sessions:[{sessionId:'child-a',parentSessionId:'session-a'}]},messages:[...saved.messages,
  {...message(6,3,null,[{type:'text',text:'injected'}]),role:'user',source:'system'},message(1,1,null,[{type:'text',text:'child result'}],'child-a')]};
 const result=await preservedRunEvidence({},'session-a','run-a',[{...run,automated:true}],{read:async()=>record});
 assert.equal(result.automated,true);assert.equal(result.partial,false);assert.ok(!JSON.stringify(result).includes('injected'));
 assert.equal(result.messages[0].source,'user');assert.equal(result.messages[0].sourceRequestId,'request-a');assert.ok(result.messages.some(m=>m.sessionId==='child-a'));
});

test('a ledger turn missing from the archive is unavailable rather than complete-empty',async()=>{
 const result=await preservedRunEvidence({},'session-a','run-a',[{...run,kernelRequestIds:[],nativeTurn:{startSeq:99}}],{read:async()=>saved});
 assert.equal(result.available,false);assert.equal(result.partial,true);assert.equal(result.reason,'turn_identity_unavailable');
});

test('a captured earlier child of the same root is not attributed to this run',async()=>{
 const record={header:{...saved.header,runChildSessionIds:[],sessions:[{sessionId:'old-child',parentSessionId:'session-a'}]},messages:[...saved.messages,message(1,1,null,[{type:'text',text:'Previous child work'}],'old-child')]};
 const result=await preservedRunEvidence({},'session-a','run-a',[run],{read:async()=>record});
 assert.equal(result.partial,true);assert.ok(!JSON.stringify(result).includes('Previous child work'));
});

test('socket-rendered JSON credentials are redacted as well as bare JSON',()=>{
 assert.ok(!redactRunEvidence('ok\n{"apiKey":"private-key"}').includes('private-key'));
});

test('wrapped cookie and authorization use the same recursive credential policy',()=>{
 for(const key of ['cookie','authorization','apiKey','password','workload_token']) {
   for(const prefix of ['ok\n','success\n','error\n']) assert.ok(!redactRunEvidence(prefix+JSON.stringify({[key]:'private value'})).includes('private value'));
 }
});
