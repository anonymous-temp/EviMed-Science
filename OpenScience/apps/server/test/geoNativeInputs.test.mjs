import assert from 'node:assert/strict';
import test from 'node:test';
import { GeoNativeInputs, observeNativeHttpInput, nativeInputCandidate, normalizeInputAttribution, mergeInputAttribution } from '../src/geoNativeInputs.mjs';

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

test('an owned project\'s input passes through its frame unjournaled, for its owner and its frame\'s session only, and settles its admission', async () => {
  const owner = { id: 'owner' }, project = { userId: 'owner', id: 'control' }, claims = { frameId: 'frame', delegation: { rootSessionId: 'root' } };
  const journal = new GeoNativeInputs({ database: {}, documents: { get: async () => assert.fail('an owned input writes no receipt') },
    authority: {}, policies: { forProject: async () => ({ kind: 'owned', ownerId: 'owner', controlProjectId: 'control' }) } });
  const request = () => ({ requestId: 'r', sessionId: 'root', content: [{ type: 'text', text: 'Hi' }] });
  const authority = operation => operation();
  const accepted = request();
  assert.deepEqual(await journal.prepare({ user: owner, project, claims, request: accepted }), { referenceId: null, state: 'owned', replay: false });
  assert.equal(journal.journals(accepted), false);
  assert.equal(journal.disposition(accepted), 'pending');
  await journal.beforeForward(accepted);
  assert.deepEqual(await journal.execute(accepted, authority, async () => 'sent'), { value: 'sent', error: null, disposition: 'accepted' });
  // A definitive refusal releases the admission; a failure whose outcome is unknown keeps its fence, as the plugin admission's own rule does.
  for (const [error, disposition] of [[Object.assign(new Error('refused'), { status: 503, definitivelyRejected: true }), 'refused'],
    [Object.assign(new Error('bad'), { status: 400 }), 'refused'], [new Error('socket lost'), 'unknown']]) {
    const failing = request();
    await journal.prepare({ user: owner, project, claims, request: failing });
    const result = await journal.execute(failing, authority, async () => { throw error; });
    assert.equal(result.error, error); assert.equal(result.disposition, disposition); assert.equal(journal.disposition(failing), disposition);
  }
  const unadmitted = request();
  await journal.prepare({ user: owner, project, claims, request: unadmitted });
  await journal.afterAdmission(unadmitted, Object.assign(new Error('locked'), { status: 423 }));
  assert.equal(journal.disposition(unadmitted), 'refused');
  // Nobody but the owner, and no session but the frame's own, passes through.
  await assert.rejects(journal.prepare({ user: { id: 'someone' }, project, claims, request: request() }), { code: 'geo_native_input_conflict' });
  await assert.rejects(journal.prepare({ user: owner, project, claims, request: { ...request(), sessionId: 'elsewhere' } }), { code: 'geo_native_input_conflict' });
  await assert.rejects(journal.prepare({ user: owner, project, claims, request: null }), { code: 'geo_native_input_conflict' });
  // Another input is journaled as before: it is not one of these.
  assert.equal(journal.journals(request()), true);
});
