import assert from 'node:assert/strict';
import test from 'node:test';
import { VcrConversationCompletions } from '../src/vcrConversationCompletions.mjs';

function fixture() {
  let inbox = { running: true, queued: 0 }, session = {}, count = 0;
  const row = { id: 'completion', job_id: 'job', study_id: 'study', user_id: 'user', project_id: 'p', root_session_id: 'root',
    dispatch_id: 'vcr-completion-abc', fingerprint: 'a'.repeat(64), state: 'pending', payload: { state: 'failed', resultId: null, partial: false, runId: 'run', error: { code: 'engine_crashed' } } };
  const store = { rows: async () => [row], query: async (_sql, values) => { row.state = values[1];row.last_error=values[2]; } };
  const service = new VcrConversationCompletions({ store, resolve: async () => ({ project: { id: 'p' }, user: { id: 'user' }, session }),
    inbox: async () => inbox, dispatch: async (_u, _p, sid, _id, _text, options) => { assert.equal(sid,'root'); assert.equal(options.nativeContinuation,true); count++; return { run: { id: 'continued' } }; }, notify: async () => {} });
  return { service, row, setInbox: value => { inbox = value; }, deleteSession: () => { session = null; }, count: () => count };
}
test('a completion waits for its original busy session and dispatches it once', async () => {
  const f = fixture(); await f.service.deliver(); assert.equal(f.count(),0);
  f.setInbox({ running:false, queued:0 }); await f.service.deliver(); assert.equal(f.count(),1); assert.equal(f.row.state,'delivered');
});
test('a job that stopped short says so in the turn it starts, and a finished one says it finished', async () => {
  /** @param {Record<string, any>} payload */
  const sent = async (payload) => {
    const f = fixture();
    const texts = [];
    const dispatch = f.service.dispatch;
    f.service.dispatch = (...args) => { texts.push({ text: args[4], supplement: args[5].systemSupplement }); return dispatch(...args); };
    f.row.payload = { resultId: 'r1', runId: 'run', error: null, ...payload };
    f.setInbox({ running: false, queued: 0 });
    await f.service.deliver();
    return texts[0];
  };
  const stopped = await sent({ state: 'succeeded', partial: true, stopped: '3 对里判完 1 对，预算用完' });
  assert.match(stopped.text, /^计算没有做完，保留了部分结果：3 对里判完 1 对，预算用完。/);
  assert.doesNotMatch(stopped.text, /计算已完成/);
  assert.match(stopped.text, /没做完什么/);
  assert.match(stopped.supplement, /partial=true/);
  const whole = await sent({ state: 'succeeded', partial: false });
  assert.match(whole.text, /^计算已完成。/);
  assert.match((await sent({ state: 'failed', partial: true })).text, /^计算未完成，保留了部分结果。/);
});
test('reconcile: a batch job that ended limited is partial with its reason, and an engine estimate that is limited is not', async () => {
  /** @type {any[]} */
  const inserted = [];
  const job = (id, kind, extra) => ({ id, study_id: 's', user_id: 'u', project_id: 'p', kind, state: 'succeeded', finished_at: '2026-11-04T00:00:00Z', checkpoint: { conversationOrigin: { userId: 'u', projectId: 'p', rootSessionId: 'root', runId: 'run', callId: 'call' } }, result_id: `r_${id}`, result_version: 1, ...extra });
  const rows = [job('a', 'match_judge', { conclusion: 'limited', stop_message: '3 对里判完 1 对' }), job('b', 'match_judge', { conclusion: 'estimable' }), job('c', 'weight_comparator', { conclusion: 'limited' }), job('d', 'records_import', { conclusion: 'limited', stop_message: '导入了一部分' })];
  const store = { one: async () => null, rows: async (sql) => (sql.includes('FROM evimed_vcr.jobs') ? rows : []), query: async (sql, values) => { if (sql.includes('INSERT INTO evimed_vcr.conversation_completions')) inserted.push(JSON.parse(values[9])); return { rowCount: 1 }; } };
  await new VcrConversationCompletions({ store }).reconcile();
  assert.deepEqual(inserted.map((row) => [row.partial, row.stopped ?? null]), [[true, '3 对里判完 1 对'], [false, null], [false, null], [true, '导入了一部分']]);
});
test('a deleted original session is unavailable and never falls back to another', async () => {
  const f = fixture(); f.deleteSession(); await f.service.deliver(); assert.equal(f.count(),0); assert.equal(f.row.state,'unavailable');
});
test('only a ledger-confirmed rejected dispatch advances a retry generation',async()=>{
 const row={id:'completion',dispatch_id:'stable-dispatch',dispatch_generation:0,root_session_id:'root',payload:{state:'failed',runId:'original'},fingerprint:'a'.repeat(64)};
 const ids=[];const service=new VcrConversationCompletions({store:{rows:async()=>[row],query:async(sql,values)=>{if(sql.includes('dispatch_generation=dispatch_generation+1'))row.dispatch_generation++;else row.state=values[1];}},
  resolve:async()=>({user:{},project:{},session:{}}),inbox:async()=>({running:false,queued:0}),notify:async()=>{},
  dispatch:async(_u,_p,_sid,id)=>{ids.push(id);return{dispatchStatus:ids.length===1 ? 'rejected':'accepted'};}});
 await service.deliver();assert.equal(row.dispatch_generation,1);assert.notEqual(row.state,'delivered');
 await service.deliver();assert.deepEqual(ids,['stable-dispatch','stable-dispatch-retry-1']);assert.equal(row.state,'delivered');
});
test('generated completion dispatch IDs fit the actual ledger validator through the maximum retry suffix',async()=>{
 const {vcrCompletionDispatchId}=await import('../src/vcrConversationCompletions.mjs');
 const {safeId}=await import('../src/security.mjs');
 const fingerprint='3bb0fa30cb9fcdb4a6c54b7e76603b9e609a399a16287b3ddb791e821e5c1242';
 for(const generation of [0,1,2147483647]){
  const id=vcrCompletionDispatchId(fingerprint,generation);assert.equal(safeId(id,'agent run dispatch id'),id);assert.ok(id.length<=64);
 }
 assert.equal(vcrCompletionDispatchId(fingerprint,2147483647).length,64);
});
test('malformed dispatch identity is terminal before any runtime can start',async()=>{
 let resolved=0,state;
 const service=new VcrConversationCompletions({store:{rows:async()=>[{id:'bad',dispatch_id:'x'.repeat(65),fingerprint:'a'.repeat(64),payload:{}}],query:async(_sql,values)=>{state=values[1];}},
 resolve:async()=>{resolved++;return{user:{},project:{},session:{}};},inbox:async()=>{throw new Error('Must not start a runtime');},dispatch:async()=>{},notify:async()=>{}});
 await service.deliver();assert.equal(resolved,0);assert.equal(state,'unavailable');
});

test('a terminal result already available during the successful origin turn creates no paid continuation',async()=>{
 const f=fixture();f.setInbox({running:false,queued:0});f.row.payload.completedAt='2026-10-26T00:00:00Z';
 f.service.readAcknowledgment=async()=>({observed:true});
 f.service.readOrigin=async()=>({status:'succeeded',finishedAt:'2026-10-26T00:01:00Z'});
 await f.service.deliver();assert.equal(f.count(),0);assert.equal(f.row.state,'delivered');
});
test('a user cancellation never prompts another automated turn, including recovered partials',async()=>{
 const f=fixture();f.setInbox({running:false,queued:0});f.row.payload.state='canceled';f.row.payload.partial=true;
 await f.service.deliver();assert.equal(f.count(),0);assert.equal(f.row.state,'delivered');
});
test('a deterministic failure is stopped at its configured attempt budget',async()=>{
 const f=fixture();f.setInbox({running:true,queued:0});f.row.attempts=3;f.service.config={vcrCompletionMaxAttempts:3};
 await f.service.deliver();assert.equal(f.row.state,'unavailable');assert.equal(f.count(),0);
});

test('unobserved terminal results are disclosed without mistaking a successful timestamp for consumption',async()=>{
 const f=fixture();f.setInbox({running:false,queued:0});f.row.payload.completedAt=new Date().toISOString();let notices=0;
 f.service.readOrigin=async()=>({status:'succeeded',finishedAt:new Date(Date.now()+1000).toISOString()});f.service.notify=async()=>{notices++;};
 await f.service.deliver();assert.equal(f.count(),0);assert.equal(notices,1);assert.equal(f.row.last_error,'vcr_completion_disclosed');assert.equal(f.row.state,'delivered');
});
test('fresh terminal acknowledgement at the reservation boundary suppresses a reconciled stale row',async()=>{
 const f=fixture();f.setInbox({running:false,queued:0});let observed=false,charged=0;
 f.service.readAcknowledgment=async()=>({observed});f.service.dispatch=async(_u,_p,_sid,_id,_text,options)=>{observed=true;await options.beforeReserve({runs:[]});charged++;};
 await f.service.deliver();assert.equal(charged,0);assert.equal(f.row.state,'delivered');assert.equal(f.service.counters.observed,1);
});
test('an intervening human turn at atomic reservation receives a saved-result notice without a paid turn',async()=>{
 const f=fixture();f.setInbox({running:false,queued:0});f.row.payload.completedAt=new Date(Date.now()-1000).toISOString();let charged=0,notices=0;
 f.service.notify=async()=>{notices++;};f.service.dispatch=async(_u,_p,_sid,_id,_text,options)=>{await options.beforeReserve({runs:[{id:'run',sessionId:'root',status:'succeeded',startedAt:new Date(Date.now()-10000).toISOString(),finishedAt:new Date(Date.now()-5000).toISOString()},{id:'next-human',sessionId:'root',automated:false,status:'succeeded',startedAt:new Date().toISOString()}]});charged++;};
 await f.service.deliver();assert.equal(charged,0);assert.equal(notices,1);assert.equal(f.row.state,'delivered');
});

test('a failed saved-result disclosure retries before consumption and terminal exhaustion retains its cause',async()=>{
 const f=fixture();f.row.payload.completedAt=new Date().toISOString();f.row.attempts=1;let calls=0;
 f.service.readOrigin=async()=>({id:'run',status:'succeeded',finishedAt:new Date(Date.now()+1000).toISOString()});
 f.service.notify=async()=>{calls++;if(calls===1)throw Object.assign(new Error('Transient notifier failure'),{code:'database_unavailable'});};
 await f.service.deliver();assert.equal(f.row.state,'pending');assert.equal(f.row.last_error,'vcr_completion_notice_failed:database_unavailable');
 f.row.attempts=2;await f.service.deliver();assert.equal(calls,2);assert.equal(f.row.state,'delivered');assert.equal(f.count(),0);
 f.row.state='pending';f.row.attempts=3;f.service.config={vcrCompletionMaxAttempts:3};f.service.notify=async()=>{throw Object.assign(new Error('Persistent notifier failure'),{code:'database_unavailable'});};
 await f.service.deliver();assert.equal(f.row.state,'unavailable');assert.equal(f.row.last_error,'vcr_completion_notice_failed:database_unavailable');assert.equal(f.count(),0);
});
test('the final prompt guard freshly reads all session runs after a later human turn has completed',async()=>{
 const f=fixture();f.setInbox({running:false,queued:0});const now=Date.now();let paid=0,notices=0,reads=0;
 const original={id:'run',sessionId:'root',status:'succeeded',automated:false,startedAt:new Date(now-20000).toISOString(),finishedAt:new Date(now-10000).toISOString()};const runs=[original];f.row.payload.completedAt=new Date(now-5000).toISOString();
 f.service.readRuns=async()=>{reads++;return[...runs];};f.service.notify=async()=>{notices++;};
 f.service.dispatch=async(_u,_p,_sid,_id,_text,options)=>{
  await options.beforeReserve({runs:[...runs]});
  runs.push({id:'later_human',sessionId:'root',status:'succeeded',automated:false,startedAt:new Date(now-2000).toISOString(),finishedAt:new Date(now-1000).toISOString()});
  await options.beforePrompt();paid++;return{dispatchStatus:'accepted'};
 };
 await f.service.deliver();assert.equal(paid,0);assert.equal(notices,1);assert.ok(reads>=2);assert.equal(f.row.state,'delivered');
});

test('the final ledger read follows a producer proof await that admitted a newer human turn',async()=>{
 const f=fixture();f.setInbox({running:false,queued:0});const now=Date.now();let final=false,paid=0,notices=0;
 const runs=[{id:'run',sessionId:'root',status:'succeeded',automated:false,startedAt:new Date(now-20000).toISOString(),finishedAt:new Date(now-10000).toISOString()}];f.row.payload.completedAt=new Date(now-5000).toISOString();
 f.service.readRuns=async()=>[...runs];f.service.readAcknowledgment=async()=>{if(final)runs.push({id:'during-proof',sessionId:'root',status:'succeeded',automated:false,startedAt:new Date(now-2000).toISOString(),finishedAt:new Date(now-1000).toISOString()});return{observed:false};};f.service.notify=async()=>{notices++;};
 f.service.dispatch=async(_u,_p,_sid,_id,_text,options)=>{await options.beforeReserve({runs:[...runs]});final=true;await options.beforePrompt();paid++;return{dispatchStatus:'accepted'};};
 await f.service.deliver();assert.equal(paid,0);assert.equal(notices,1);assert.equal(f.row.state,'delivered');
});
test('a kernel human input not yet adopted in the run ledger prevents an outdated continuation',async()=>{
 const f=fixture();f.setInbox({running:false,queued:0});const now=Date.now();let paid=0,notices=0;
 const original={id:'run',sessionId:'root',status:'succeeded',automated:false,kernelRequestIds:['original_input'],startedAt:new Date(now-20000).toISOString(),finishedAt:new Date(now-10000).toISOString()};f.row.payload.completedAt=new Date(now-5000).toISOString();
 f.service.readRuns=async()=>[original];f.service.readCurrentInput=async()=>({requestId:'unadopted_human',turnStartSeq:200});f.service.notify=async()=>{notices++;};
 f.service.dispatch=async(_u,_p,_sid,_id,_text,options)=>{await options.beforeReserve({runs:[original]});await options.beforePrompt();paid++;return{dispatchStatus:'accepted'};};
 await f.service.deliver();assert.equal(paid,0);assert.equal(notices,1);
});

test('a result completed in a busy turn is disclosed once after the unread turn ends',async()=>{
 const f=fixture();let notices=0;const now=Date.now();f.row.payload.completedAt=new Date(now-2000).toISOString();
 let status='running';f.service.readOrigin=async()=>({id:'run',status,finishedAt:status==='running'?null:new Date(now-1000).toISOString()});
 f.service.readAcknowledgment=async()=>({observed:false});f.service.notify=async()=>{notices++;};
 await f.service.deliver();assert.equal(f.row.state,'pending');assert.equal(notices,0);assert.equal(f.count(),0);
 status='succeeded';f.setInbox({running:false,queued:0});await f.service.deliver();
 assert.equal(f.row.state,'delivered');assert.equal(notices,1);assert.equal(f.count(),0);
});
