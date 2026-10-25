import assert from 'node:assert/strict';
import test from 'node:test';
import { observeNativeHttpInput, nativeInputCandidate, normalizeInputAttribution, mergeInputAttribution } from '../src/geoNativeInputs.mjs';

test('only a literal accepted result in the matching native envelope proves acceptance', () => {
  const response = value => ({status:200,contentType:'application/json',body:Buffer.from(JSON.stringify({type:'server-response',rpcId:'rpc',result:{ok:true,value}}))});
  assert.equal(observeNativeHttpInput('rpc',response({accepted:true})).state,'accepted');
  for(const value of [{accepted:1},{accepted:'true'},{accepted:false},{}]) assert.equal(observeNativeHttpInput('rpc',response(value)).state,'unknown');
  assert.equal(observeNativeHttpInput('other',response({accepted:true})).state,'unknown');
});
test('candidate preserves part boundaries and marks lossy transcript forms incomplete', () => {
  const a=nativeInputCandidate({requestId:'a',sessionId:'s',content:[{type:'text',text:'a'},{type:'text',text:'b'}]});
  const b=nativeInputCandidate({requestId:'a',sessionId:'s',content:[{type:'text',text:'a\nb'}]});
  assert.notEqual(a.transcriptContentDigest,b.transcriptContentDigest);
  assert.equal(a.reconcilable,true);
  assert.equal(nativeInputCandidate({requestId:'a',sessionId:'s',content:[{type:'image',url:'secret'}]}).reconcilable,false);
});
test('run projection rejects unauthenticated actor fields', () => {
  assert.equal(normalizeInputAttribution({complete:true,actorId:'forged'}),null);
});
test('projection preserves every canonical count and marks a bounded projection incomplete',()=>{
  const inputs=Array.from({length:65},(_,i)=>({referenceId:`gni_${i.toString(16).padStart(64,'0')}`,sourceRequestId:`r${i}`,inputSeq:i,
    originalParts:1,originalTextDigest:'a'.repeat(64),actor:{kind:'human',id:`actor-${i}`,createdAt:'2026-01-01'}}));
  const view=normalizeInputAttribution({version:1,namespaceId:'namespace',policyRef:'policy',count:65,throughSeq:100,digest:'b'.repeat(64),complete:true,inputs});
  assert.equal(view.complete,false);assert.equal(view.count,65);assert.equal(view.inputs.length,64);
});
test('question RPC acceptance is literal boolean true, matching the pinned continued-answer service',()=>{
  const response=value=>({status:200,contentType:'application/json',body:Buffer.from(JSON.stringify({type:'server-response',rpcId:'rpc',result:{ok:true,value}}))});
  assert.equal(observeNativeHttpInput('rpc',response(true),'question-answer').state,'accepted');
  for(const value of [false,undefined,{accepted:true},'true'])assert.equal(observeNativeHttpInput('rpc',response(value),'question-answer').state,'unknown');
});
test('request identity namespace differs with session even if content and request id are equal',()=>{
  const first=nativeInputCandidate({sessionId:'root-a',requestId:'same',content:[{type:'text',text:'same'}]});
  const second=nativeInputCandidate({sessionId:'root-b',requestId:'same',content:[{type:'text',text:'same'}]});
  assert.notEqual(first.forwardedRequestDigest,second.forwardedRequestDigest);assert.equal(first.transcriptContentDigest,second.transcriptContentDigest);
});
test('newer but partial attribution preserves known contributors and cannot become complete by advancing a sequence',()=>{
  const input=(id,seq)=>({referenceId:`gni_${id.repeat(64)}`,sourceRequestId:id,inputSeq:seq,originalParts:1,originalTextDigest:'a'.repeat(64),actor:{kind:'human',id,createdAt:'2026-01-01'}});
  const a=input('a',2),b=input('b',3),previous={version:1,namespaceId:'namespace',policyRef:'policy',throughSeq:3,count:2,digest:'c'.repeat(64),complete:true,inputs:[a,b]};
  const next={...previous,throughSeq:4,count:1,inputs:[a]};
  const merged=mergeInputAttribution(previous,next);
  assert.equal(merged.complete,false);assert.equal(merged.count,2);assert.equal(merged.throughSeq,4);
  assert.deepEqual(merged.inputs.map(item=>item.sourceRequestId),['a','b']);
  assert.equal(mergeInputAttribution(previous,{...next,throughSeq:2}).complete,true);
});
test('older snapshots cannot erase contributors or hide unresolved canonical question coverage',()=>{
  const input=id=>({referenceId:`gni_${id.repeat(64)}`,sourceRequestId:id,inputSeq:id==='a'?2:3,originalParts:1,originalTextDigest:'a'.repeat(64),actor:{kind:'human',id,createdAt:'2026-01-01'}});
  const current={version:1,namespaceId:'namespace',policyRef:'policy',throughSeq:3,count:2,digest:'c'.repeat(64),complete:true,inputs:[input('a'),input('b')]};
  const older={...current,count:1,throughSeq:2,inputs:[input('a')],unresolvedCount:1,unresolvedInputs:[{referenceId:`gni_${'d'.repeat(64)}`,operation:'question-answer'}]};
  const merged=mergeInputAttribution(current,older);
  assert.equal(merged.count,2);assert.equal(merged.throughSeq,3);assert.equal(merged.complete,false);assert.equal(merged.unresolvedCount,1);
  assert.deepEqual(merged.inputs.map(item=>item.sourceRequestId),['a','b']);
});
