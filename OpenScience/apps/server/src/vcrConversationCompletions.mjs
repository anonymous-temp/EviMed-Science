/** Durable completion outbox. Terminal job rows are the producer's authoritative
 * log, so a crash between commit and a finish callback is repaired by reconcile. */
import { createHash } from 'node:crypto';
import {RuntimePromptStops} from './runtimePromptStops.mjs';
import { ProductDocuments } from './productStore.mjs';
import { HttpError,safeId } from './security.mjs';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Agent-run resource IDs are at most 64 characters. Keep the full digest as
 * the dispatch fingerprint while reserving room for the PostgreSQL int retry. */
export function vcrCompletionDispatchId(fingerprint,generation=0) {
  if(typeof fingerprint!=='string' || !/^[a-f0-9]{64}$/.test(fingerprint) || !Number.isInteger(generation) || generation<0 || generation>2147483647) throw new HttpError(400,'invalid_id','Invalid completion dispatch identity.');
  return safeId(`vcr-completion-${fingerprint.slice(0,32)}${generation ? `-retry-${generation}` : ''}`,'agent run dispatch id');
}
/** Revalidate the exact original conversation and research scope at each send boundary. */
export function createVcrCompletionResolver({ accounts,studies,sessions,allows }) {
  return async row => {
    const user=await accounts.userById(row.user_id);if(!user)return null;
    if(row.study_id && !allows(user)) throw new HttpError(503,'vcr_disabled','Research tools are disabled for this account.');
    const project=await accounts.requireProject(user,row.project_id);
    const study=row.study_id ? await studies.getStudy(row.user_id,row.study_id) : null;
    if(row.study_id && (!study || study.projectId!==row.project_id || !['active','draft'].includes(study.status)
      || study.scope==='conversation' && study.conversationSessionId!==row.root_session_id)) return {user,project,session:null};
    return {user,project,session:await sessions.get(project,row.root_session_id)};
  };
}
export class VcrConversationCompletions {
  constructor({ store, resolve, inbox, dispatch, notify, jobs = null, readOrigin = null, readRuns = null, readCurrentInput = null, readAcknowledgment = null, replayDocuments = null, config = {}, now = () => new Date(), report = (_code) => {} }) {
    this.jobs = jobs; this.readOrigin=readOrigin;this.readRuns=readRuns;this.readCurrentInput=readCurrentInput;this.readAcknowledgment=readAcknowledgment;this.replayDocuments=replayDocuments ?? (store.database ? new ProductDocuments(store.database) : null); this.config=/** @type {Record<string,any>} */ (config); this.now=now;
    this.counters={reconciled:0,attempted:0,delivered:0,observed:0,canceled:0,retried:0,exhausted:0,unavailable:0,notificationFailed:0,pruned:0};
    this.promptStops=new RuntimePromptStops({database:store.database ?? null});
    this.store = store; this.resolve = resolve; this.inbox = inbox; this.dispatch = dispatch; this.notify = notify; this.report = report;
  }
  async reconcileReplays() {
    if (!this.store.one || !(await this.store.one("SELECT to_regclass('evimed_product.documents') AS relation"))?.relation) return 0;
    const rows=await this.store.rows(`WITH candidates AS (SELECT d.*,j.status AS job_state,j.error AS job_error,COALESCE(j.finished_at,d.updated_at) AS completed_at,
      row_number() OVER (PARTITION BY d.user_id ORDER BY d.updated_at,d.id) AS account_order FROM evimed_product.documents d
      LEFT JOIN evimed_product.jobs j ON j.user_id=d.user_id AND j.id=d.payload->>'jobId' AND j.kind='result-replay'
      WHERE d.kind='result-replay' AND d.deleted_at IS NULL
      AND d.payload->>'recordType'='result-replay' AND COALESCE(j.status,d.payload->>'state') IN ('succeeded','failed','canceled')
      AND COALESCE(d.payload->>'cleanup','confirmed')='confirmed'
      AND d.payload->'initial'->'continuation'->>'schema'='1' AND d.payload->'initial'->'continuation'->>'kind'='native-calculation'
      AND d.payload->'initial'->'producer'->>'sessionId' IS NOT NULL
      AND d.payload->>'completionOutboxResultKey' IS DISTINCT FROM COALESCE(d.payload->>'outputVersionId','none')) SELECT * FROM candidates ORDER BY account_order,updated_at,id LIMIT $1`,
      [this.config.vcrCompletionReconcileBatch ?? 50]);
    for(const row of rows){
      const value=row.payload,producer=value.initial.producer;
      const invalid=!producer.runId || !producer.callId;
      const rootSessionId=producer.parentSessionId ?? producer.sessionId;
      const userId=value.requestedBy ?? row.user_id;
      const resultId=value.outputVersionId ?? 'none';
      const fingerprint=hash([userId,row.project_id,rootSessionId,row.id,resultId]);
      await this.store.query(`INSERT INTO evimed_vcr.conversation_completions
        (id,study_id,job_id,user_id,project_id,root_session_id,result_key,dispatch_id,fingerprint,payload,state,last_error)
        VALUES ($1,NULL,NULL,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) ON CONFLICT DO NOTHING`,
      [`vcc_${fingerprint}`,userId,row.project_id,rootSessionId,resultId,vcrCompletionDispatchId(fingerprint),fingerprint,
        JSON.stringify({completedAt:row.completed_at,replayId:row.id,state:row.job_state ?? value.state,resultId,resultVersion:null,partial:value.partial===true,
          error:row.job_error || value.stopError || value.error ? {code:value.stopError ?? row.job_error?.code ?? value.error?.code ?? 'result_replay_failed'} : null,runId:producer.runId,callId:producer.callId}),invalid ? 'unavailable' : 'pending',invalid ? 'vcr_completion_origin_invalid' : null]);
      if(this.replayDocuments) try {
        await this.replayDocuments.put(row.user_id,'result-replay',row.id,{...value,completionOutboxResultKey:resultId},{projectId:row.project_id,expectedRevision:row.revision,telemetry:true});
      } catch(error) {if(error?.code!=='product_revision_conflict') throw error;}

    }
    return rows.length;
  }
  async reconcile() {
    await this.jobs?.reconcileFinishHooks();
    const replayCount=await this.reconcileReplays();
    const rows = await this.store.rows(`WITH candidates AS (SELECT j.*, s.project_id, e.id AS execution_id, r.id AS result_id, r.version AS result_version,
      r.diagnostics->>'partial' AS partial,row_number() OVER (PARTITION BY j.user_id ORDER BY j.finished_at,j.id) AS account_order FROM evimed_vcr.jobs j
      JOIN evimed_vcr.studies s ON s.id=j.study_id AND s.deleted_at IS NULL
      LEFT JOIN evimed_vcr.executions e ON e.job_id=j.id
      LEFT JOIN evimed_vcr.results r ON r.execution_id=e.id
      WHERE j.state IN ('succeeded','failed','canceled') AND j.checkpoint ? 'conversationOrigin'
      AND COALESCE(j.checkpoint->>'completionOutboxRecorded','false')<>'true'
      AND ($2::boolean=false OR COALESCE(j.checkpoint->>'completionHooksApplied','false')='true' OR COALESCE(j.checkpoint->>'completionHooksExhausted','false')='true')
) SELECT * FROM candidates ORDER BY account_order,finished_at,id LIMIT $1`,
      [this.config.vcrCompletionReconcileBatch ?? 50,Boolean(this.jobs)]);
    for (const row of rows) {
      const origin = row.checkpoint.conversationOrigin;
      const invalid=origin?.userId !== row.user_id || origin?.projectId !== row.project_id || !origin?.rootSessionId || !origin?.runId || !origin?.callId;
      if(invalid) this.report('vcr_completion_origin_invalid');
      const key = row.result_id ? `${row.result_id}:${row.result_version}` : 'none';
      const fingerprint = hash([row.user_id,row.project_id,origin?.rootSessionId ?? 'invalid',row.id,key]);
      await this.store.query(`INSERT INTO evimed_vcr.conversation_completions
        (id,study_id,job_id,user_id,project_id,root_session_id,result_key,dispatch_id,fingerprint,payload,state,last_error)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12) ON CONFLICT (job_id,result_key) DO NOTHING`,
      [`vcc_${fingerprint}`,row.study_id,row.id,row.user_id,row.project_id,origin?.rootSessionId ?? 'invalid',key,vcrCompletionDispatchId(fingerprint),fingerprint,
        JSON.stringify({completedAt:row.finished_at,state: row.state, resultId: row.result_id ?? null, resultVersion: row.result_version ?? null,
          partial: row.partial === 'true', error: row.error ? { code: row.error.code ?? 'vcr_job_failed' } : null,
          runId: origin?.runId, callId: origin?.callId }),invalid ? 'unavailable' : 'pending',invalid ? 'vcr_completion_origin_invalid' : null]);
      await this.store.query(`UPDATE evimed_vcr.jobs SET checkpoint=checkpoint || '{"completionOutboxRecorded":true}'::jsonb WHERE id=$1`,[row.id]);

    }
    return rows.length+replayCount;
  }
  async observation(row) {
    if(this.readAcknowledgment) return this.readAcknowledgment(row);
    if(!this.store.one) return null;
    const source=row.payload.replayId
      ? await this.store.one(`SELECT d.payload->'terminalObservation' AS observation,COALESCE(j.status,d.payload->>'state') AS state
          FROM evimed_product.documents d LEFT JOIN evimed_product.jobs j ON j.id=d.payload->>'jobId' AND j.user_id=d.user_id
          WHERE d.id=$1 AND d.project_id=$2 AND COALESCE(d.payload->>'requestedBy',d.user_id)=$3 AND d.kind='result-replay' AND d.deleted_at IS NULL`,[row.payload.replayId,row.project_id,row.user_id])
      : await this.store.one(`SELECT checkpoint->'originTerminalObservation' AS observation,state FROM evimed_vcr.jobs WHERE id=$1 AND user_id=$2`,[row.job_id,row.user_id]);
    const proof=source?.observation;
    return {canceled:source?.state==='canceled',observed:Boolean(proof && proof.runId===row.payload.runId && proof.rootSessionId===row.root_session_id
      && proof.state===row.payload.state && proof.resultKey===row.result_key)};
  }
  async disposition(row,project,runs=null,{final=false,dispatchId=null,signal=null}={}) {
    const proof=await this.observation(row);signal?.throwIfAborted();
    const stopped=await this.promptStops.has(project,row.root_session_id,row.payload.runId);signal?.throwIfAborted();
    const input=final && this.readCurrentInput ? await this.readCurrentInput(project,row.root_session_id) : null;
    signal?.throwIfAborted();
    // No state read follows this ledger snapshot. The final caller holds the
    // same-session prompt fence through the kernel's acceptance acknowledgement.
    if((final || !runs) && this.readRuns) runs=await this.readRuns(project);
    signal?.throwIfAborted();
    if(stopped || row.payload.state==='canceled' || proof?.canceled) return 'vcr_completion_canceled';
    if(proof?.observed) return 'vcr_completion_observed';
    if(final && (!Array.isArray(runs) || !runs.some(run=>run.id===row.payload.runId))) return 'vcr_completion_disclosed';
    if(this.now().getTime()-Date.parse(row.payload.completedAt ?? row.created_at)>=this.ageSeconds()*1000) return 'vcr_completion_exhausted';
    const original=runs ? runs.find(run=>run.id===row.payload.runId) : this.readOrigin ? await this.readOrigin(project,row.payload.runId) : null;
    if(original?.status==='running') return 'vcr_conversation_busy';
    if(original?.status==='canceled') return 'vcr_completion_canceled';
    const reserved=final && dispatchId ? runs?.find(run=>run.dispatchId===dispatchId) : null;
    if(reserved && reserved.status!=='running') return 'vcr_completion_canceled';
    if(final && this.readCurrentInput && (!input || !original || !(
      input.requestId && original.kernelRequestIds?.includes(input.requestId)
      || Number.isSafeInteger(input.turnStartSeq) && input.turnStartSeq===original.nativeTurn?.startSeq
    ))) return 'vcr_completion_disclosed';
    // A result unobserved at the end of a turn is disclosed without charging
    // for a second answer. A timestamp chooses disclosure, never consumption.
    if(original?.finishedAt && Date.parse(original.finishedAt)>=Date.parse(row.payload.completedAt)
      || runs?.some(run=>run.sessionId===row.root_session_id && run.id!==row.payload.runId && !run.automated
        && Date.parse(run.startedAt)>Date.parse(original?.startedAt ?? row.payload.completedAt))) return 'vcr_completion_disclosed';
    return null;
  }
  async settleDisposition(row,code) {
    if(code==='vcr_conversation_busy') return this.mark(row,'pending',code);
    if(code==='vcr_completion_observed') this.counters.observed++;
    if(code==='vcr_completion_canceled') this.counters.canceled++;
    if(code==='vcr_completion_disclosed' || code==='vcr_completion_exhausted') {
      return this.notifyAndMark(row,code==='vcr_completion_exhausted'?'exhausted':'saved',code==='vcr_completion_exhausted'?'unavailable':'delivered',code);
    }
    await this.mark(row,'delivered',code);
  }
  async notifyOutcome(row,reason) {
    try {await this.notify(row,reason);}
    catch(error) {
      this.counters.notificationFailed++;
      const cause=String(error?.code ?? 'notification_unavailable');this.report(cause);
      throw Object.assign(new Error('The completion notice was not durably acknowledged.'),{code:'vcr_completion_notice_failed',disclosureCause:cause});
    }
  }
  noticeFailureCode(error) {return `vcr_completion_notice_failed:${String(error?.disclosureCause ?? error?.code ?? 'notification_unavailable')}`;}
  async notifyAndMark(row,reason,state,code) {
    try {await this.notifyOutcome(row,reason);}
    catch(error) {await this.mark(row,'pending',this.noticeFailureCode(error));return;}
    if(code==='vcr_completion_exhausted') this.counters.exhausted++;
    await this.mark(row,state,code);
  }
  ageSeconds() { return Math.max(1,Number(this.config.vcrCompletionMaxAgeMs ?? 86400000)/1000); }
  async mark(row, state, code = null) {
    const attempts=Number(row.attempts ?? 1);
    const expired=attempts>=Number(this.config.vcrCompletionMaxAttempts ?? 12)
      || this.now().getTime()-Date.parse(row.created_at ?? this.now().toISOString())>=this.ageSeconds()*1000;
    if(state==='pending' && expired) {
      state='unavailable';this.counters.exhausted++;
      if(!String(code).startsWith('vcr_completion_notice_failed:')) {
        code='vcr_completion_exhausted';
        try {await this.notifyOutcome(row,'exhausted');} catch(error) {code=this.noticeFailureCode(error);}
      }
    }
    const delay=Math.min(Number(this.config.vcrCompletionRetryMaxMs ?? 900000),Number(this.config.vcrCompletionRetryMs ?? 15000)*2**Math.min(20,Math.max(0,attempts-1)));
    await this.store.query(`UPDATE evimed_vcr.conversation_completions SET state=$2,last_error=$3,
      lease_until=NULL,run_after=now()+make_interval(secs=>$4),updated_at=now() WHERE id=$1`,[row.id,state,code,delay/1000]);
    if(state==='pending') this.counters.retried++;
    else if(state==='delivered') this.counters.delivered++;
    else this.counters.unavailable++;
  }
  async deliver() {
    const rows = await this.store.rows(`WITH ranked AS (SELECT id,created_at,
      row_number() OVER (PARTITION BY user_id ORDER BY created_at,id) AS account_order
      FROM evimed_vcr.conversation_completions WHERE state='pending' AND run_after<=now()
        AND (lease_until IS NULL OR lease_until<now())), selected AS (
      SELECT c.id FROM evimed_vcr.conversation_completions c JOIN ranked r ON r.id=c.id
      ORDER BY r.account_order,r.created_at,c.id LIMIT $1 FOR UPDATE OF c SKIP LOCKED)
      UPDATE evimed_vcr.conversation_completions c
      SET lease_until=now()+make_interval(secs=>$2),attempts=attempts+1,updated_at=now()
      FROM selected WHERE c.id=selected.id RETURNING c.*`,
    [this.config.vcrCompletionBatch ?? 5,Number(this.config.vcrCompletionLeaseMs ?? 300000)/1000]);
    this.counters.attempted+=rows.length;
    for (const row of rows) {
      try {
        const generation=Number(row.dispatch_generation ?? 0);
        // This former 79-character producer format could never pass the ledger
        // validator. Repair only our own fingerprint-bound pending identity.
        const legacy=row.dispatch_id===`vcr-completion-${row.fingerprint}`;
        const base=legacy ? vcrCompletionDispatchId(row.fingerprint) : String(row.dispatch_id ?? '');
        vcrCompletionDispatchId(row.fingerprint,generation);
        const dispatchId=safeId(generation ? `${base}-retry-${generation}` : base,'agent run dispatch id');
        if(legacy){
          const repaired=await this.store.query(`UPDATE evimed_vcr.conversation_completions SET dispatch_id=$2,updated_at=now()
            WHERE id=$1 AND dispatch_id=$3 AND state='pending' RETURNING id`,[row.id,base,row.dispatch_id]);
          if(repaired?.rowCount===0) continue;
          row.dispatch_id=base;
        }
        const owned = await this.resolve(row);
        if (!owned?.session) {
          await this.notifyAndMark(row,'unavailable','unavailable','research_session_not_found'); continue;
        }
        const outcome = row.payload;
        const disposition=await this.disposition(row,owned.project);
        if(disposition) {await this.settleDisposition(row,disposition);continue;}
        const state = await this.inbox(owned.project,row.root_session_id);
        if (!state || state.running !== false || state.queued !== 0) { await this.mark(row,'pending','vcr_conversation_busy'); continue; }
        const label={succeeded:'计算已完成',failed:'计算未完成',canceled:'计算已取消'}[outcome.state] ?? '计算状态有更新';
        const text = `${label}${outcome.partial ? '，保留了部分结果' : ''}。请继续原来的任务，读取实际结果再解释。`;
        const systemSupplement = `Platform computation notice. Original job=${outcome.replayId ?? row.job_id}; tool=${outcome.replayId ? "research_calculate" : "vcr_simulate"}; state=${outcome.state}; result=${outcome.resultId ?? 'none'}; version=${outcome.resultVersion ?? 'none'}; partial=${outcome.partial === true}; error=${outcome.error?.code ?? 'none'}. This is an automated continuation of the original user request. Use the recorded result; do not treat a failure, cancellation or partial result as success. Nobody is attending this turn.${outcome.state === "canceled" ? " The computation was canceled. Do not restart it or queue replacement calculations without a new user request." : ""}`;
        const assertCurrent=async ({runs=null,final=false,signal=null}={}) => {
          const current=await this.resolve(row);signal?.throwIfAborted();
          if(!current?.session) throw Object.assign(new Error('Original conversation unavailable'),{code:'research_session_not_found',definitivelyRejected:true});
          const inbox=await this.inbox(current.project,row.root_session_id);signal?.throwIfAborted();
          if(!inbox || inbox.running!==false || inbox.queued!==0) throw Object.assign(new Error('Conversation busy'),{code:'vcr_conversation_busy',definitivelyRejected:true});
          const code=await this.disposition(row,current.project,runs,{final,dispatchId,signal});
          if(code) throw Object.assign(new Error(code),{code,definitivelyRejected:true});
        };
        const dispatched = await this.dispatch(owned.user,owned.project,row.root_session_id,dispatchId,text,{ nativeContinuation:true,
          dispatchFingerprint:row.fingerprint,systemSupplement,originRunId:outcome.runId,
          beforePrompt:({signal=null}={})=>assertCurrent({final:true,signal}),beforeReserve:assertCurrent });
        const run = dispatched?.run ?? dispatched;
        if (run?.dispatchStatus === 'rejected') {
          // Only a ledger-confirmed pre-prompt rejection can advance an attempt.
          // Unknown/lost acceptance always retries the existing immutable identity.
          await this.store.query(`UPDATE evimed_vcr.conversation_completions SET dispatch_generation=dispatch_generation+1,
            lease_until=NULL,last_error='runtime_prompt_rejected',updated_at=now()
            WHERE id=$1 AND dispatch_generation=$2`,[row.id,generation]);
          await this.mark(row,'pending','runtime_prompt_rejected');continue;
        }
        await this.mark(row,'delivered');
      } catch (error) {
        // Dispatch identity is stable across a lost response or process restart.
        // An unknown acceptance stays pending and uses AgentRuns' existing identity.
        const code = String(error?.code ?? 'vcr_completion_unavailable');
        if(['vcr_completion_observed','vcr_completion_canceled','vcr_completion_disclosed','vcr_completion_exhausted'].includes(code)) {await this.settleDisposition(row,code);continue;}
        if (['research_session_not_found','project_not_found','vcr_completion_origin_unavailable','invalid_id'].includes(code)) {
          await this.notifyAndMark(row,'unavailable','unavailable',code);
        } else { this.report(code); await this.mark(row,'pending',code); }
      }
    }
    return { attempted:rows.length };
  }
  async tick() {
    const now=this.now().getTime();
    if(this.lastTickAt!=null && now-this.lastTickAt<Number(this.config.vcrCompletionIntervalMs ?? 0)) return {reconciled:0,attempted:0};
    this.lastTickAt=now;
    const reconciled=await this.reconcile();this.counters.reconciled+=reconciled;
    const retention=Math.max(this.ageSeconds()*1000,Number(this.config.vcrCompletionRetentionMs ?? 604800000));
    const pruned=await this.store.query(`DELETE FROM evimed_vcr.conversation_completions WHERE id IN (SELECT id FROM evimed_vcr.conversation_completions WHERE state<>'pending' AND updated_at<now()-make_interval(secs=>$1) ORDER BY updated_at LIMIT $2)`,[retention/1000,this.config.vcrCompletionReconcileBatch ?? 50]);
    this.counters.pruned+=Number(pruned?.rowCount ?? 0);
    return {reconciled,...await this.deliver()};
  }
  status() { return {...this.counters}; }
}
