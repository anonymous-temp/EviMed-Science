import assert from 'node:assert/strict';
import test from 'node:test';
import { VcrConversationCompletions } from '../src/vcrConversationCompletions.mjs';

function fixture() {
  let inbox = { running: true, queued: 0 }, session = {}, count = 0;
  const row = { id: 'completion', job_id: 'job', study_id: 'study', user_id: 'user', project_id: 'p', root_session_id: 'root',
    dispatch_id: 'vcr-completion-abc', fingerprint: 'a'.repeat(64), state: 'pending', payload: { state: 'failed', resultId: null, partial: false, runId: 'run', error: { code: 'engine_crashed' } } };
  const store = { rows: async () => [row], query: async (_sql, values) => { row.state = values[1]; } };
  const service = new VcrConversationCompletions({ store, resolve: async () => ({ project: { id: 'p' }, user: { id: 'user' }, session }),
    inbox: async () => inbox, dispatch: async (_u, _p, sid, _id, _text, options) => { assert.equal(sid,'root'); assert.equal(options.nativeContinuation,true); count++; return { run: { id: 'continued' } }; }, notify: async () => {} });
  return { service, row, setInbox: value => { inbox = value; }, deleteSession: () => { session = null; }, count: () => count };
}
test('a completion waits for its original busy session and dispatches it once', async () => {
  const f = fixture(); await f.service.deliver(); assert.equal(f.count(),0);
  f.setInbox({ running:false, queued:0 }); await f.service.deliver(); assert.equal(f.count(),1); assert.equal(f.row.state,'delivered');
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
