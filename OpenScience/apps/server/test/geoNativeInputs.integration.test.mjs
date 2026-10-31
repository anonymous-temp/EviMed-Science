import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { normalizeTranscript } from '../src/dshRuntimeAdapter.mjs';
import { HttpError } from '../src/security.mjs';
import { createNativeInputFixture as fixture } from './helpers/geoNativeInputFixture.mjs';
const options = { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'Disposable PostgreSQL required', timeout:20000 };
function transcript(messages) {
  const events=[];for(const [turn,entries] of messages.entries()){
    events.push({type:'turn/start',seq:turn*100,time:1,data:{turn:turn+1}});
    entries.forEach((request,index)=>events.push({type:'user/message',seq:turn*100+index+1,time:2,data:{source:{kind:'user',rpcId:request.requestId},content:request.content}}));
    events.push({type:'turn/end',seq:turn*100+99,time:3,data:{reason:{kind:'completed'}}});
  }
  return normalizeTranscript('root',events);
}
const turnOf=(tx,index)=>({...tx.turns[index],inputs:tx.messages.filter(item=>item.turnStartSeq===tx.turns[index].startSeq)});

test('internal operation kind requires server-created object identity rather than a copied request',options,async t=>{
  const f=await fixture(t),claims=await f.claims(f.users.editor);
  const request=f.request('forged-stop');
  for(const operation of ['stop','question-answer']) await assert.rejects(f.journal.prepare({user:f.users.editor,project:f.project,claims,request,operation}),{code:'geo_native_input_conflict'});
  const internal=await f.journal.prepareOperation({user:f.users.editor,project:f.project,claims,method:'session/cancel',payload:{args:{sessionId:'root'}}});
  assert.equal(Object.hasOwn(internal,'nativeOperation'),false);
  assert.equal(Object.hasOwn(internal,'questionProof'),false);
  await assert.rejects(f.journal.prepare({user:f.users.editor,project:f.project,claims,request:structuredClone(internal),operation:'stop'}),{code:'geo_native_input_conflict'});
});

test('pool1 candidate commits before plugin lock; accepted survives browser failure and unknown 403 retains fence',options,async t=>{
  const f=await fixture(t);
  for(const [id,accepted] of [['accepted',true],['unknown',false]]){
    const request=f.request(id),frame=await f.prepare(request);
    assert.equal(f.db.pool.idleCount,1);
    assert.equal((await f.documents.list('owner','geo-plan-context',{projectId:f.project.id,filter:{recordType:'geo-native-input'}})).items.length,accepted?1:2);
    await assert.rejects(f.execute(request,frame,async()=>{await f.journal.beforeForward(request);if(accepted)f.journal.observe(request,{state:'accepted',authority:'native-mux'});throw new HttpError(403,'browser_projection','fixture');}),{code:'browser_projection'});
    const row=await f.journal.receipt(f.project,f.policy.namespace.id,'root',id);
    assert.equal(row.payload.state,accepted?'accepted':'unknown');
    const count=(await f.db.query('SELECT count(*)::int AS n FROM evimed_product.plugin_prompt_admissions')).rows[0].n;
    assert.equal(count,accepted?0:1);
    assert.equal(f.db.pool.idleCount,1);
  }
});
test('pre-send business writes roll back and receipt refusal commits on same pool1 client',options,async t=>{
  const f=await fixture(t),request=f.request('refuse'),frame=await f.prepare(request);
  await assert.rejects(f.execute(request,frame,async()=>{await f.documents.put('owner','geo-plan-context','partial',{recordType:'fixture'},{projectId:f.project.id,expectedRevision:0});throw new HttpError(409,'changed','fixture');}),{code:'changed'});
  assert.equal(await f.documents.get('owner','geo-plan-context','partial'),null);
  assert.equal((await f.journal.receipt(f.project,f.policy.namespace.id,'root','refuse')).payload.state,'refused');
});
test('same id never resends and collisions include actor incarnation, frame and exact original parts',options,async t=>{
  const f=await fixture(t),request=f.request('same');await f.prepare(request);
  const retry=structuredClone(request),frame=await f.prepare(retry);
  await assert.rejects(f.execute(retry,frame,async()=>assert.fail('must not send')),{code:'geo_native_input_already_submitted'});
  await assert.rejects(f.prepare({...request,content:[{type:'text',text:'other'}]}),{code:'geo_native_input_conflict'});
  await assert.rejects(f.prepare(structuredClone(request),f.users.editor2),{code:'geo_native_input_conflict'});
});
test('pending crash candidate recovers only full normalized content and exact proved generation, never equal prefix',options,async t=>{
  const f=await fixture(t),request=f.request('crash');await f.prepare(request);
  const tx=transcript([[request]]),turn=turnOf(tx,0),run={id:'run-crash',sessionId:'root',nativeTurn:{startSeq:0},kernelRequestIds:['crash']};
  const wrong=structuredClone(tx);wrong.messages[0].parts.push({type:'text',text:'extra platform suffix'});
  assert.equal((await f.journal.reconcileTurn(f.project,wrong,turnOf(wrong,0),run)).complete,false);
  const recovered=await f.journal.reconcileTurn(f.project,tx,turn,run);assert.equal(recovered.complete,true);
  assert.equal(recovered.inputs[0].actor.id,'editor');
  assert.equal((await f.journal.receipt(f.project,f.policy.namespace.id,'root','crash')).payload.state,'accepted');
  f.journal.proveSession=async()=>null;assert.equal((await f.journal.reconcileTurn(f.project,tx,turn,run)).complete,false);
});
test('queue and requested steer belong to actual later turn; all editors survive distinct consumed messages',options,async t=>{
  const f=await fixture(t),a=f.request('a'),b=f.request('b'),c={...f.request('c'),mode:'steer'};
  await f.prepare(a);await f.prepare(b,f.users.editor2);await f.prepare(c);
  const tx=transcript([[a],[b,c]]);
  const first=await f.journal.reconcileTurn(f.project,tx,turnOf(tx,0),{id:'first',sessionId:'root',kernelRequestIds:['a']});
  const second=await f.journal.reconcileTurn(f.project,tx,turnOf(tx,1),{id:'second',sessionId:'root',kernelRequestIds:['b','c']});
  assert.equal(first.count,1);assert.deepEqual(second.inputs.map(item=>item.actor.id),['editor2','editor']);
  assert.equal((await f.journal.receipt(f.project,f.policy.namespace.id,'root','b')).payload.consumption.runId,'second');
});
test('N admitted operations at pool max N do not request a second checkout',options,async t=>{
  const f=await fixture(t,3),requests=[f.request('n1'),f.request('n2'),f.request('n3')],frames=[];
  for(const request of requests)frames.push(await f.prepare(request));
  let entered=0,release;const barrier=new Promise(resolve=>{release=resolve;});
  await Promise.all(requests.map((request,index)=>f.execute(request,frames[index],async()=>{
    entered++;if(entered===3)release();await barrier;await f.journal.beforeForward(request);f.journal.observe(request,{state:'accepted',authority:'native-mux'});
  })));
  assert.equal(f.db.pool.idleCount,3);
});
test('prepare rejects ambient or stale ALS transaction instead of acquiring a new connection',options,async t=>{
  const f=await fixture(t),request=f.request('ambient'),claims=await f.claims(f.users.editor);
  await f.db.transaction(client=>f.db.withTransactionClient(client,()=>assert.rejects(f.journal.prepare({user:f.users.editor,project:f.project,claims,request}),{code:'geo_native_prepare_in_transaction'})));
  f.setLaunch(null);await assert.rejects(f.prepare(f.request('unsafe')),{code:'geo_native_context_unavailable'});
});
test('question replies and stops keep real authenticated operation actors without inventing consumed wrapper proof',options,async t=>{
  const f=await fixture(t),claims=await f.claims(f.users.editor2),payload={args:{agentId:'root',callId:'ask-call',answers:[{id:'q',text:'my answer'}]}};
  const request=await f.journal.prepareOperation({user:f.users.editor2,project:f.project,claims,method:'userQuestions/answer',payload,interaction:{agentId:'root',callId:'ask-call'}});
  await f.execute(request,claims,async()=>{await f.journal.beforeForward(request);f.journal.observe(request,{state:'accepted',authority:'native-question-rpc'});});
  const row=await f.journal.receipt(f.project,f.policy.namespace.id,'root','reply:ask-call');
  assert.equal(row.payload.actor.id,'editor2');assert.equal(row.payload.operation,'question-answer');assert.equal(row.payload.state,'accepted');
  assert.equal(JSON.stringify(row).includes('my answer'),false);assert.equal(row.payload.candidate.reconcilable,false);
  const stop=await f.journal.prepareOperation({user:f.users.editor2,project:f.project,claims,method:'session/cancel',payload:{args:{request:{sessionId:'root'}}}});
  const stopRow=await f.journal.receipt(f.project,f.policy.namespace.id,'root',stop.requestId);
  assert.equal(stopRow.payload.operation,'stop');assert.equal(stopRow.payload.native.originalTextChars,0);
});
test('exact pinned continued question wrapper proves consumed human answer and changed questions or answers do not',options,async t=>{
  const f=await fixture(t),recorded=JSON.parse(await readFile(new URL('./fixtures/dsh/native-question-reply.json',import.meta.url),'utf8'));
  const claims=await f.claims(f.users.editor2),payload={args:{agentId:'root',callId:recorded.callId,answer:{answers:recorded.answers}}};
  await f.journal.prepareOperation({user:f.users.editor2,project:f.project,claims,method:'userQuestions/answer',payload,interaction:{agentId:'root',callId:recorded.callId,questions:recorded.questions}});
  const events=[{type:'turn/start',seq:100,data:{turn:2}},{type:'user/message',seq:101,data:{source:recorded.source,content:recorded.content}}];
  const tx=normalizeTranscript('root',events),run={id:'answer-run',sessionId:'root',kernelRequestIds:[`reply:${recorded.callId}`]};
  const wrong=structuredClone(tx);wrong.messages[0].parts[0].text=wrong.messages[0].parts[0].text.replace('Which?','Different original question');
  assert.equal((await f.journal.reconcileTurn(f.project,wrong,turnOf(wrong,0),run)).complete,false);
  const attributed=await f.journal.reconcileTurn(f.project,tx,turnOf(tx,0),run);
  assert.equal(attributed.complete,true);assert.equal(attributed.inputs[0].actor.id,'editor2');
  const row=await f.journal.receipt(f.project,f.policy.namespace.id,'root',`reply:${recorded.callId}`);
  assert.equal(row.payload.consumption.runId,'answer-run');assert.equal(row.payload.candidate.question.answerDigest.length,64);
  assert.equal(JSON.stringify(row).includes('actual human custom answer'),false);
});
test('unassociated attended answers force incomplete coverage across canonical pagination without guessing a turn',options,async t=>{
  const f=await fixture(t),request=f.request('question-coverage');await f.prepare(request);
  const claims=await f.claims(f.users.editor2);
  for(let index=0;index<101;index++)await f.journal.prepareOperation({user:f.users.editor2,project:f.project,claims,
    method:'$events/result',payload:{args:{clientId:'carrier',eventId:`event-${index}`,outcome:{kind:'result',value:{answers:[]}}}},interaction:{agentId:'root'}});
  const tx=transcript([[request]]),projection=await f.journal.reconcileTurn(f.project,tx,turnOf(tx,0),{id:'question-coverage-run',sessionId:'root',kernelRequestIds:[request.requestId]});
  assert.equal(projection.complete,false);assert.equal(projection.unresolvedCount,101);assert.equal(projection.unresolvedInputs.length,64);
  assert.equal(projection.inputs.length,1);assert.equal(projection.inputs[0].actor.id,'editor');
});
test('precommitted GPC candidate recovers historical selection after bind rollback without overwriting conflicting current binding',options,async t=>{
  const f=await fixture(t),{GeoPlanContext}=await import('../src/geoPlanContext.mjs');
  const contexts=new GeoPlanContext({documents:f.documents,store:f.store,service:f.service,runs:async()=>[],
    authorizeSession:(user,geo,id)=>f.authority.resolve(user,{kind:'geo',geoProjectId:geo.id,sessionId:id}),
    consumedContexts:(...args)=>f.journal.consumedContexts(...args)});f.journal.contexts=contexts;
  const staged=await contexts.stage(f.users.editor,f.geo.id,{requestKey:'crash-plan',sessionId:'root',mode:'strategy'});
  const request={...f.request('crash-plan'),geoPlanContext:{referenceId:staged.referenceId}};
  await contexts.prepare(f.users.editor,f.project,request);const preview=await contexts.preview(f.users.editor,f.project,request);
  await f.prepare(request);
  await f.db.transaction(client=>f.db.withTransactionClient(client,()=>contexts.bind(f.users.editor,f.project,request)),{rollbackOnly:true});
  assert.deepEqual(request.content.at(-1),preview.part);
  const original=await f.documents.get('owner','geo-plan-context',staged.referenceId);
  assert.equal(original.payload.state,'staged');
  const current=await f.documents.put('owner','geo-plan-context',staged.referenceId,{...original.payload,state:'bound',requestId:'new-conflicting-request',requestDigest:'f'.repeat(64)},
    {projectId:f.project.id,expectedRevision:original.revision});
  const tx=transcript([[request]]);
  const run={id:'crash-plan-run',sessionId:'root',kernelRequestIds:['crash-plan']};
  const attribution=await f.journal.reconcileTurn(f.project,tx,turnOf(tx,0),run);assert.equal(attribution.complete,true);
  const recovered=await contexts.forRun(f.geo,run);assert.equal(recovered.referenceId,staged.referenceId);assert.equal(recovered.requestId,'crash-plan');assert.equal(recovered.historicalConsumed,true);
  assert.deepEqual(await f.documents.get('owner','geo-plan-context',staged.referenceId),current);
  const {geoPlanDigest}=await import('../src/geoPlanContext.mjs');
  assert.equal(await f.documents.get('owner','geo-plan-context',`gpcbind_${geoPlanDigest(['editor',f.project.id,'crash-plan'])}`),null);
});
test('changed GPC basis after candidate commit refuses before send instead of rewriting the durable candidate',options,async t=>{
  const f=await fixture(t),{GeoPlanContext,geoPlanDigest}=await import('../src/geoPlanContext.mjs');
  const contexts=new GeoPlanContext({documents:f.documents,store:f.store,service:f.service,runs:async()=>[],authorizeSession:async()=>{}});f.journal.contexts=contexts;
  const staged=await contexts.stage(f.users.editor,f.geo.id,{requestKey:'changed-plan',sessionId:'root',mode:'strategy'});
  const request={...f.request('changed-plan'),geoPlanContext:{referenceId:staged.referenceId}};await contexts.prepare(f.users.editor,f.project,request);const frame=await f.prepare(request);
  const row=await f.documents.get('owner','geo-plan-context',staged.referenceId),basis={...row.payload.basis,changed:'different frozen input'};
  await f.documents.put('owner','geo-plan-context',staged.referenceId,{...row.payload,basis,basisDigest:geoPlanDigest(basis)},{projectId:f.project.id,expectedRevision:row.revision});
  await assert.rejects(f.execute(request,frame,async()=>assert.fail('changed basis must not send')),{code:'geo_plan_context_mismatch'});
  assert.equal((await f.journal.receipt(f.project,f.policy.namespace.id,'root',request.requestId)).payload.state,'refused');
});
async function revisionFixture(t){
  const f=await fixture(t),{ResultProvenanceService}=await import('../src/resultProvenanceService.mjs'),{ResultRevisionService}=await import('../src/resultRevision.mjs'),{ResultLineageService}=await import('../src/resultLineage.mjs');
  const {mkdir,writeFile}=await import('node:fs/promises'),{createHash}=await import('node:crypto');
  await mkdir(f.project.workspaceDir,{recursive:true});await mkdir(f.project.metaDir,{recursive:true});
  const results=new ResultProvenanceService({documents:f.documents,config:f.config,authorizeProject:async(actor,id)=>{
    assert.equal(id,f.project.id);await f.authority.resolve(f.users[actor],{kind:'geo',geoProjectId:f.geo.id,sessionId:'root'});return f.project;
  }}),lineage=new ResultLineageService({results});
  const revisions=new ResultRevisionService({documents:f.documents,results,lineage,config:f.config});f.journal.revisions=revisions;
  const capture=async(name,text,extra={})=>{await writeFile(`${f.project.workspaceDir}/${name}`,text);return results.captureFile({userId:'owner',project:f.project,relativePath:name,
    expectedDigest:createHash('sha256').update(text).digest('hex'),producer:{kind:'tool',runId:'producing',sessionId:'root',callId:name,eventId:name},...extra});};
  const calc=await capture('calculation.json','{"values":{"effect":0.7134}}',{machineValues:[{key:'values.effect',value:0.7134,unit:null}]});
  const version=await capture('report.md','# Result\nEffect 0.71.\n');
  const staged=await revisions.stage('editor',version.versionId,{requestId:'selected-result',sessionId:'root',projectId:f.project.id,digest:version.digest,anchor:{kind:'file',elementId:'file',selectedText:''}});
  const request={...f.request('revision-input'),evimedResultRevision:{referenceId:staged.referenceId}};
  return{...f,revisions,results,calc,version,staged,request,capture};
}
test('actual result-revision bind rollback recovers exact consumed candidate with retained source history',options,async t=>{
  const f=await revisionFixture(t);await f.prepare(f.request);
  const actual=structuredClone(f.request);
  await f.db.transaction(client=>f.db.withTransactionClient(client,()=>f.revisions.bind('editor',f.project,actual)),{rollbackOnly:true});
  assert.equal((await f.documents.get('owner','result-revision',f.staged.referenceId)).payload.state,'staged');
  const tx=transcript([[actual]]),run={id:'revision-run',sessionId:'root',kernelRequestIds:['revision-input']};
  const wrong=structuredClone(tx);wrong.messages[0].parts.at(-1).text=wrong.messages[0].parts.at(-1).text.replace('numericalChain','differentChain');
  assert.equal((await f.journal.reconcileTurn(f.project,wrong,turnOf(wrong,0),run)).complete,false);
  assert.equal((await f.journal.reconcileTurn(f.project,tx,turnOf(tx,0),run)).complete,true);
  const stored=await f.journal.receipt(f.project,f.policy.namespace.id,'root','revision-input');
  assert.equal(stored.payload.candidate.bindings[0].sourceDigest,f.version.digest);assert.equal(stored.payload.consumption.runId,'revision-run');
});
test('a changed actual numerical-chain snapshot after candidate commit refuses before outbound send',options,async t=>{
  const f=await revisionFixture(t),frame=await f.prepare(f.request);
  const before=(await f.journal.receipt(f.project,f.policy.namespace.id,'root','revision-input')).payload.candidate;
  const additional=await f.capture('new-dependent.md','# Another result\nEffect 0.71.\n');
  assert.ok(additional.bindings.items.some(item=>item.calculation.versionId===f.calc.versionId));
  await assert.rejects(f.execute(f.request,frame,async()=>assert.fail('changed chain must not send')),{code:'geo_native_input_conflict'});
  assert.deepEqual((await f.journal.receipt(f.project,f.policy.namespace.id,'root','revision-input')).payload.candidate,before);
});
test('membership rejection before the authority callback records refusal inside plugin admission and clears its fence',options,async t=>{
  const f=await fixture(t),request=f.request('membership-refused'),frame=await f.prepare(request);
  await f.store.removeMember({geoId:f.geo.id,userId:'editor',role:'editor'});
  await assert.rejects(f.execute(request,frame,async()=>assert.fail('revoked actor must not send')),error=>[403,404].includes(error.status));
  assert.equal((await f.journal.receipt(f.project,f.policy.namespace.id,'root',request.requestId)).payload.state,'refused');
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM evimed_product.plugin_prompt_admissions')).rows[0].n,0);
});
test('runtime replacement and actual actor incarnation reuse cannot reuse a prepared native identity',options,async t=>{
  const f=await fixture(t),request=f.request('generation-change'),frame=await f.prepare(request);
  f.setLaunch({generation:'replacement',referenceId:'launch-replacement',digest:'2'.repeat(64)});
  await assert.rejects(f.execute(request,frame,async()=>assert.fail('stale generation must not send')),{code:'geo_native_input_conflict'});
  assert.equal((await f.journal.receipt(f.project,f.policy.namespace.id,'root',request.requestId)).payload.state,'refused');
  const second=f.request('reused-actor');await f.prepare(second);
  await f.db.query("UPDATE evimed_control.users SET created_at=created_at+interval '1 second' WHERE id='editor'");
  await assert.rejects(f.prepare(structuredClone(second)),{code:'geo_native_input_conflict'});
});
test('consumption rejects wrong transcript session, repeated sequence and request-only evidence',options,async t=>{
  const f=await fixture(t),request=f.request('proof-boundary');await f.prepare(request);
  const tx=transcript([[request]]),run={id:'proof-boundary-run',sessionId:'root',kernelRequestIds:[request.requestId]};
  assert.equal((await f.journal.reconcileTurn(f.project,{...tx,sessionId:'foreign'},turnOf(tx,0),run)).complete,false);
  assert.equal((await f.journal.reconcileTurn(f.project,{...tx,exhausted:false},turnOf(tx,0),run)).complete,false);
  const wrong=structuredClone(tx);wrong.messages[0].parts=[];
  assert.equal((await f.journal.reconcileTurn(f.project,wrong,turnOf(wrong,0),run)).complete,false);
  const duplicate=turnOf(tx,0);duplicate.inputs.push(duplicate.inputs[0]);
  assert.equal((await f.journal.reconcileTurn(f.project,tx,duplicate,run)).complete,false);
});
test('detached stale ALS cannot prepare a native receipt or silently request a new pool checkout',options,async t=>{
  const f=await fixture(t),request=f.request('stale-als'),claims=await f.claims(f.users.editor);let pending;
  await f.db.transaction(client=>f.db.withTransactionClient(client,async()=>{
    pending=new Promise(resolve=>setTimeout(async()=>{
      try{await f.journal.prepare({user:f.users.editor,project:f.project,claims,request});resolve(null);}catch(error){resolve(error);}
    },20));
  }));
  assert.equal((await pending).code,'product_revision_conflict');
  assert.equal(await f.journal.receipt(f.project,f.policy.namespace.id,'root','stale-als'),null);assert.equal(f.db.pool.idleCount,1);
});

test('older and concurrent adopted snapshots never erase a canonical consumed contributor',options,async t=>{
  const f=await fixture(t),{AgentRunStore}=await import('../src/agentRuns.mjs'),{transcriptToLedgerMessages}=await import('../src/dshRuntimeAdapter.mjs');
  const a=f.request('snapshot-a'),b=f.request('snapshot-b');await f.prepare(a);await f.prepare(b,f.users.editor2);
  const full=transcript([[a,b]]),older=transcript([[a]]);
  const store=new AgentRunStore({get:async()=>null},{model:'deepseek/deepseek-v4-pro',nativeInputs:f.journal,readSessionHistory:async()=>transcriptToLedgerMessages(full),readSessionStatus:async()=> 'idle'});
  store.scheduleMonitor=()=>{};
  await store.adoptRuntimeTurns(f.project,'root',older);
  await Promise.all([store.adoptRuntimeTurns(f.project,'root',full),store.adoptRuntimeTurns(f.project,'root',older)]);
  const original=(await store.list(f.project))[0];assert.equal(original.inputAttribution.count,2);assert.equal(original.inputAttribution.complete,true);
  await store.adoptRuntimeTurns(f.project,'root',older);
  const delayed=(await store.list(f.project))[0];
  assert.deepEqual(delayed.inputAttribution,original.inputAttribution,'late old snapshot must preserve the newer proof inside the ledger mutation');
  const canonical=await f.journal.forRun(f.project,delayed,older);
  assert.equal(canonical.complete,false,'a partial snapshot cannot independently claim canonical completeness');
  assert.equal(canonical.count,2);assert.deepEqual(canonical.inputs.map(item=>item.actor.id),['editor','editor2']);
  await Promise.all([store.adoptRuntimeTurns(f.project,'root',full),store.adoptRuntimeTurns(f.project,'root',older)]);
  assert.deepEqual((await store.list(f.project))[0].inputAttribution,original.inputAttribution);
});

for(const accepted of [true,false])test(`exact original GPC retry reuses ${accepted?'accepted':'unknown'} disposition after actual bind without re-render`,options,async t=>{
  const f=await fixture(t),{GeoPlanContext}=await import('../src/geoPlanContext.mjs');
  const contexts=new GeoPlanContext({documents:f.documents,store:f.store,service:f.service,runs:async()=>[],authorizeSession:async()=>{}});f.journal.contexts=contexts;
  const staged=await contexts.stage(f.users.editor,f.geo.id,{requestKey:'retry-plan',sessionId:'root',mode:'strategy'});
  const request={...f.request('retry-plan'),geoPlanContext:{referenceId:staged.referenceId}},retry=structuredClone(request);
  await contexts.prepare(f.users.editor,f.project,request);const frame=await f.prepare(request);
  const send=()=>f.execute(request,frame,async()=>{await contexts.bind(f.users.editor,f.project,request);await f.journal.beforeForward(request);
    if(accepted)f.journal.observe(request,{state:'accepted',authority:'native-mux'});else throw new HttpError(502,'response-lost','fixture');});
  if(accepted)await send();else await assert.rejects(send(),{code:'response-lost'});
  const before=await f.journal.receipt(f.project,f.policy.namespace.id,'root','retry-plan');
  const bound=await f.documents.get('owner','geo-plan-context',staged.referenceId);
  const conflicting=await f.documents.put('owner','geo-plan-context',staged.referenceId,{...bound.payload,requestId:'different-current-request',requestDigest:'b'.repeat(64)},{projectId:f.project.id,expectedRevision:bound.revision});
  await contexts.prepare(f.users.editor,f.project,retry);contexts.preview=async()=>assert.fail('an exact retry must reuse its immutable recorded candidate');
  const replay=await f.journal.prepare({user:f.users.editor,project:f.project,claims:frame,request:retry});
  assert.equal(replay.replay,true);assert.equal(replay.state,accepted?'accepted':'unknown');
  await assert.rejects(f.execute(retry,frame,async()=>assert.fail('retry must never resend')),{code:'geo_native_input_already_submitted'});
  assert.deepEqual(await f.journal.receipt(f.project,f.policy.namespace.id,'root','retry-plan'),before);
  assert.deepEqual(await f.documents.get('owner','geo-plan-context',staged.referenceId),conflicting);
  await assert.rejects(f.journal.prepare({user:f.users.editor,project:f.project,claims:frame,request:{...retry,geoPlanContext:{referenceId:`gpc_${'a'.repeat(64)}`}}}),{code:'geo_native_input_conflict'});
});

for(const accepted of [true,false])test(`exact original result-selection retry reuses ${accepted?'accepted':'unknown'} disposition after actual bind`,options,async t=>{
  const f=await revisionFixture(t),retry=structuredClone(f.request),frame=await f.prepare(f.request);
  const send=()=>f.execute(f.request,frame,async()=>{await f.revisions.bind('editor',f.project,f.request);await f.journal.beforeForward(f.request);
    if(accepted)f.journal.observe(f.request,{state:'accepted',authority:'native-mux'});else throw new HttpError(502,'response-lost','fixture');});
  if(accepted)await send();else await assert.rejects(send(),{code:'response-lost'});
  const before=await f.journal.receipt(f.project,f.policy.namespace.id,'root','revision-input');
  const bound=await f.documents.get('owner','result-revision',f.staged.referenceId);
  const conflicting=await f.documents.put('owner','result-revision',f.staged.referenceId,{...bound.payload,promptRequestId:'different-current-request',instructionDigest:'b'.repeat(64)},{projectId:f.project.id,expectedRevision:bound.revision});
  f.revisions.preview=async()=>assert.fail('bound result retry must not re-render a new candidate');
  const replay=await f.journal.prepare({user:f.users.editor,project:f.project,claims:frame,request:retry});
  assert.equal(replay.replay,true);assert.equal(replay.state,accepted?'accepted':'unknown');
  await assert.rejects(f.execute(retry,frame,async()=>assert.fail('retry must never resend')),{code:'geo_native_input_already_submitted'});
  assert.deepEqual(await f.journal.receipt(f.project,f.policy.namespace.id,'root','revision-input'),before);
  assert.deepEqual(await f.documents.get('owner','result-revision',f.staged.referenceId),conflicting);
});
test('canonical consumed-input pagination retains contributors omitted by an older 101-input snapshot',options,async t=>{
  const f=await fixture(t),requests=Array.from({length:101},(_,i)=>f.request(`canonical-${i}`));
  for(const [index,request] of requests.entries())await f.prepare(request,index%2?f.users.editor2:f.users.editor);
  const full=transcript([requests]),run={id:'paginated-run',sessionId:'root',nativeTurn:{startSeq:0},kernelRequestIds:requests.map(request=>request.requestId)};
  const current=await f.journal.reconcileTurn(f.project,full,turnOf(full,0),run);assert.equal(current.count,101);
  const older=transcript([[requests[0]]]),recovered=await f.journal.forRun(f.project,run,older);
  assert.equal(recovered.count,101);assert.equal(recovered.inputs.length,64);assert.equal(recovered.complete,false);
  assert.equal(recovered.throughSeq,101);assert.equal(recovered.observedThroughSeq,1);
});

test('module routing scope requires the original verified primary request and current membership', options, async t => {
  const f = await fixture(t), request = f.request('module-scope');
  assert.equal(await f.journal.routingScopeForRequest(f.project, { ...request, geoModuleScope: { version: 1, geoProjectId: f.geo.id, rootSessionId: 'root' } }), null);
  await f.prepare(request);
  assert.deepEqual((await f.journal.routingScopeForRequest(f.project, request)).scope,
    { version: 1, geoProjectId: f.geo.id, rootSessionId: 'root' });
  assert.equal(await f.journal.routingScopeForRequest(f.project, structuredClone(request)), null);
  await assert.rejects(f.journal.routingScopeForRequest({ ...f.project, id: 'foreign' }, request), { code: 'geo_native_input_conflict' });
  await f.store.removeMember({ geoId: f.geo.id, userId: 'editor', role: 'editor' });
  await assert.rejects(f.journal.routingScopeForRequest(f.project, request));
});
