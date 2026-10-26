/** Short per-session exclusion for final prompt checks and acceptance RPCs.
 * Resource order is database client, local queue, advisory session lock. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {HttpError} from './security.mjs';
import pg from 'pg';
const admissions=new WeakMap(),held=new AsyncLocalStorage();
const busy=()=>new HttpError(409,'runtime_prompt_admission_busy','This conversation is admitting another input. Retry shortly.');
function stateFor(manager) {
 let state=admissions.get(manager);
 if(!state){state={pending:new Map(),clients:{held:0,waiters:[]},counters:{attempted:0,queued:0,admitted:0,failed:0,timedOut:0,active:0,waitingForClient:0}};admissions.set(manager,state);}
 return state;
}
/** An admission holds a pooled client until the kernel acknowledges. At most half the control plane's pool
 * may be held so: a stalled kernel delays prompts, never every other request on the same pool. */
const clientLimit=manager=>Math.max(1,Math.floor(Number(manager.config?.databasePoolMax??10)/2));
function acquireClient(state,limit,signal){
 if(signal.aborted)return Promise.reject(signal.reason);
 if(state.clients.held<limit){state.clients.held++;return Promise.resolve();}
 state.counters.waitingForClient++;
 return new Promise((resolve,reject)=>{
  const waiter={grant:()=>{signal.removeEventListener('abort',abort);state.counters.waitingForClient--;resolve(undefined);}};
  const abort=()=>{const at=state.clients.waiters.indexOf(waiter);if(at>=0)state.clients.waiters.splice(at,1);state.counters.waitingForClient--;reject(signal.reason);};
  signal.addEventListener('abort',abort,{once:true});
  state.clients.waiters.push(waiter);
 });
}
/** A released permit passes straight to the oldest waiter, so `held` counts only real holders. */
function releaseClient(state){const next=state.clients.waiters.shift();if(next)next.grant();else state.clients.held--;}
export function runtimePromptAdmissionStatus(manager){return{...stateFor(manager).counters};}
/** @template T @param {any} manager @param {any} project @param {string} sessionId
 * @param {(signal:AbortSignal)=>Promise<T>} operation @returns {Promise<T>} */
export function withSessionPromptAdmission(manager,project,sessionId,operation) {
 if(typeof sessionId!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(sessionId))throw new HttpError(400,'runtime_ui_prompt_invalid','A native prompt must name its session.');
 const key=JSON.stringify([project.userId,project.id,sessionId]),parent=held.getStore();
 if(parent?.manager===manager&&parent.key===key&&parent.open){parent.signal.throwIfAborted();return operation(parent.signal);}
 const state=stateFor(manager),timeout=Number(manager.config?.runtimePromptAdmissionTimeoutMs??30000);
 if(!Number.isSafeInteger(timeout)||timeout<1||timeout>60000)throw new HttpError(500,'runtime_prompt_admission_invalid','The prompt admission deadline is invalid.');
 const controller=new AbortController(),deadline=performance.now()+timeout;let entered=false;
 const timeoutError=()=>entered?new HttpError(504,'runtime_prompt_acceptance_unknown','Prompt acceptance could not be confirmed.'):busy();
 let rejectDeadline;const canceled=new Promise((_,reject)=>{rejectDeadline=reject;});
 const timer=setTimeout(()=>{controller.abort(timeoutError());rejectDeadline(timeoutError());},timeout);
 state.counters.attempted++;
 const operate=async()=>{
  controller.signal.throwIfAborted();entered=true;
  const scope={manager,key,signal:controller.signal,open:true};
  const work=held.run(scope,()=>Promise.resolve().then(()=>operation(controller.signal)));
  try{return await Promise.race([work,canceled]);}
  finally{scope.open=false;void work.catch(()=>{});}
 };
 const queued=client=>{
  const prior=state.pending.get(key)??Promise.resolve();if(state.pending.has(key))state.counters.queued++;
  const run=prior.catch(()=>{}).then(async()=>{
   controller.signal.throwIfAborted();state.counters.active++;
   try{
    if(!client)return operate();
    const database=manager.promptAdmissionDatabase,borrowed=Boolean(database.transactionScope());
    const previous=borrowed?(await client.query("SELECT current_setting('lock_timeout') AS lock_timeout,current_setting('statement_timeout') AS statement_timeout")).rows[0]:null;
    const remaining=Math.max(1,Math.ceil(deadline-performance.now()));
    await client.query("SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$1,true)",[`${remaining}ms`]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`session-prompt:${createHash('sha256').update(key).digest('hex')}`]);
    controller.signal.throwIfAborted();
    const restore=()=>previous?client.query("SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true)",[previous.lock_timeout,previous.statement_timeout]):Promise.resolve();
    let value;
    try{value=await database.withTransactionClient(client,operate);}
    catch(error){if(!(error instanceof pg.DatabaseError))await restore();throw error;}
    await restore();return value;
   }finally{state.counters.active--;}
  });
  state.pending.set(key,run);
  return run.finally(()=>{if(state.pending.get(key)===run)state.pending.delete(key);});
 };
 // A pool waiter owns no local fence: a prompt borrowing the sole plugin
 // client must be able to reach its wire and release that client first.
 const database=manager.promptAdmissionDatabase;
 const owned=database?acquireClient(state,clientLimit(manager),controller.signal).then(()=>database.transaction(async client=>{
  try{return{value:await queued(client)};}
  catch(error){
   // Stop intent/actor receipts describe an authenticated request, not a
   // successful kernel cancellation. Preserve them on transport/guard failure.
   // SQL failures must roll their savepoint back before the parent can continue.
   if(error instanceof pg.DatabaseError)throw error;
   return{error};
  }
 }).finally(()=>releaseClient(state))).then(outcome=>{if(outcome.error)throw outcome.error;return outcome.value;}):queued(null);
 // Public timeout never releases or reuses an active client. The owned task
 // drains/rolls back independently and checks abort before any late submission.
 void owned.catch(()=>{});
 return Promise.race([owned,canceled]).then(value=>{state.counters.admitted++;return value;},error=>{
  state.counters.failed++;
  if(controller.signal.aborted||['55P03','57014'].includes(error?.code)){state.counters.timedOut++;throw timeoutError();}
  throw error;
 }).finally(()=>clearTimeout(timer));
}
