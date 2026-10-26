/** Durable completion outbox. Terminal job rows are the producer's authoritative
 * log, so a crash between commit and a finish callback is repaired by reconcile. */
import { createHash } from 'node:crypto';
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
  constructor({ store, resolve, inbox, dispatch, notify, jobs = null, report = (_code) => {} }) {
    this.jobs = jobs;
    this.store = store; this.resolve = resolve; this.inbox = inbox; this.dispatch = dispatch; this.notify = notify; this.report = report;
  }
  async reconcileReplays() {
    if (!this.store.one || !(await this.store.one("SELECT to_regclass('evimed_product.documents') AS relation"))?.relation) return 0;
    const rows=await this.store.rows(`SELECT d.*,j.status AS job_state,j.error AS job_error FROM evimed_product.documents d
      LEFT JOIN evimed_product.jobs j ON j.user_id=d.user_id AND j.id=d.payload->>'jobId' AND j.kind='result-replay'
      WHERE d.kind='result-replay' AND d.deleted_at IS NULL
      AND d.payload->>'recordType'='result-replay' AND COALESCE(j.status,d.payload->>'state') IN ('succeeded','failed','canceled')
      AND COALESCE(d.payload->>'cleanup','confirmed')='confirmed'
      AND d.payload->'initial'->'continuation'->>'schema'='1' AND d.payload->'initial'->'continuation'->>'kind'='native-calculation'
      AND d.payload->'initial'->'producer'->>'sessionId' IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM evimed_vcr.conversation_completions c WHERE c.payload->>'replayId'=d.id
        AND c.payload->>'resultId'=COALESCE(d.payload->>'outputVersionId','none')) ORDER BY d.updated_at LIMIT 50`);
    for(const row of rows){
      const value=row.payload,producer=value.initial.producer;
      if(!producer.runId || !producer.callId) continue;
      const rootSessionId=producer.parentSessionId ?? producer.sessionId;
      const userId=value.requestedBy ?? row.user_id;
      const resultId=value.outputVersionId ?? 'none';
      const fingerprint=hash([userId,row.project_id,rootSessionId,row.id,resultId]);
      await this.store.query(`INSERT INTO evimed_vcr.conversation_completions
        (id,study_id,job_id,user_id,project_id,root_session_id,result_key,dispatch_id,fingerprint,payload)
        VALUES ($1,NULL,NULL,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT DO NOTHING`,
      [`vcc_${fingerprint}`,userId,row.project_id,rootSessionId,resultId,vcrCompletionDispatchId(fingerprint),fingerprint,
        JSON.stringify({replayId:row.id,state:row.job_state ?? value.state,resultId,resultVersion:null,partial:value.partial===true,
          error:row.job_error || value.stopError || value.error ? {code:value.stopError ?? row.job_error?.code ?? value.error?.code ?? 'result_replay_failed'} : null,runId:producer.runId,callId:producer.callId})]);
    }
    return rows.length;
  }
  async reconcile() {
    await this.jobs?.reconcileFinishHooks();
    const replayCount=await this.reconcileReplays();
    const rows = await this.store.rows(`SELECT j.*, s.project_id, e.id AS execution_id, r.id AS result_id, r.version AS result_version,
      r.diagnostics->>'partial' AS partial FROM evimed_vcr.jobs j
      JOIN evimed_vcr.studies s ON s.id=j.study_id AND s.deleted_at IS NULL
      LEFT JOIN evimed_vcr.executions e ON e.job_id=j.id
      LEFT JOIN evimed_vcr.results r ON r.execution_id=e.id
      WHERE j.state IN ('succeeded','failed','canceled') AND j.checkpoint ? 'conversationOrigin'
      AND NOT EXISTS (SELECT 1 FROM evimed_vcr.conversation_completions c WHERE c.job_id=j.id
        AND c.result_key=COALESCE(r.id || ':' || r.version::text,'none')) ORDER BY j.finished_at LIMIT 50`);
    for (const row of rows) {
      if (this.jobs && row.checkpoint.completionHooksApplied !== true) continue;
      const origin = row.checkpoint.conversationOrigin;
      if (origin?.userId !== row.user_id || origin?.projectId !== row.project_id || !origin.rootSessionId || !origin.runId || !origin.callId) {
        this.report('vcr_completion_origin_invalid'); continue;
      }
      const key = row.result_id ? `${row.result_id}:${row.result_version}` : 'none';
      const fingerprint = hash([row.user_id,row.project_id,origin.rootSessionId,row.id,key]);
      await this.store.query(`INSERT INTO evimed_vcr.conversation_completions
        (id,study_id,job_id,user_id,project_id,root_session_id,result_key,dispatch_id,fingerprint,payload)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT (job_id,result_key) DO NOTHING`,
      [`vcc_${fingerprint}`,row.study_id,row.id,row.user_id,row.project_id,origin.rootSessionId,key,vcrCompletionDispatchId(fingerprint),fingerprint,
        JSON.stringify({ state: row.state, resultId: row.result_id ?? null, resultVersion: row.result_version ?? null,
          partial: row.partial === 'true', error: row.error ? { code: row.error.code ?? 'vcr_job_failed' } : null,
          runId: origin.runId, callId: origin.callId })]);
    }
    return rows.length+replayCount;
  }
  async mark(row, state, code = null) {
    await this.store.query(`UPDATE evimed_vcr.conversation_completions SET state=$2,last_error=$3,
      lease_until=NULL,run_after=now()+interval '15 seconds',updated_at=now() WHERE id=$1`,[row.id,state,code]);
  }
  async deliver() {
    const rows = await this.store.rows(`UPDATE evimed_vcr.conversation_completions c
      SET lease_until=now()+interval '5 minutes',attempts=attempts+1,updated_at=now()
      WHERE id IN (SELECT id FROM evimed_vcr.conversation_completions WHERE state='pending' AND run_after<=now()
        AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at LIMIT 5 FOR UPDATE SKIP LOCKED) RETURNING *`);
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
          await this.notify(row, 'unavailable'); await this.mark(row,'unavailable','research_session_not_found'); continue;
        }
        const state = await this.inbox(owned.project,row.root_session_id);
        if (!state || state.running !== false || state.queued !== 0) { await this.mark(row,'pending','vcr_conversation_busy'); continue; }
        const outcome = row.payload;
        const label={succeeded:'计算已完成',failed:'计算未完成',canceled:'计算已取消'}[outcome.state] ?? '计算状态有更新';
        const text = `${label}${outcome.partial ? '，保留了部分结果' : ''}。请继续原来的任务，读取实际结果再解释。`;
        const systemSupplement = `Platform computation notice. Original job=${outcome.replayId ?? row.job_id}; tool=${outcome.replayId ? "research_calculate" : "vcr_simulate"}; state=${outcome.state}; result=${outcome.resultId ?? 'none'}; version=${outcome.resultVersion ?? 'none'}; partial=${outcome.partial === true}; error=${outcome.error?.code ?? 'none'}. This is an automated continuation of the original user request. Use the recorded result; do not treat a failure, cancellation or partial result as success. Nobody is attending this turn.${outcome.state === "canceled" ? " The computation was canceled. Do not restart it or queue replacement calculations without a new user request." : ""}`;
        const dispatched = await this.dispatch(owned.user,owned.project,row.root_session_id,dispatchId,text,{ nativeContinuation:true,
          dispatchFingerprint:row.fingerprint,systemSupplement,originRunId:outcome.runId,
          beforePrompt: async () => { if (!(await this.resolve(row))?.session) throw Object.assign(new Error('Original research unavailable'),{code:'research_session_not_found'}); },
          beforeReserve: async () => {
            const current = await this.resolve(row);
            if (!current?.session) throw Object.assign(new Error('Original conversation unavailable'),{code:'research_session_not_found'});
            const inbox = await this.inbox(current.project,row.root_session_id);
            if (!inbox || inbox.running !== false || inbox.queued !== 0) throw Object.assign(new Error('Conversation busy'),{code:'vcr_conversation_busy'});
          } });
        const run = dispatched?.run ?? dispatched;
        if (run?.dispatchStatus === 'rejected') {
          // Only a ledger-confirmed pre-prompt rejection can advance an attempt.
          // Unknown/lost acceptance always retries the existing immutable identity.
          await this.store.query(`UPDATE evimed_vcr.conversation_completions SET dispatch_generation=dispatch_generation+1,
            lease_until=NULL,run_after=now()+interval '15 seconds',last_error='runtime_prompt_rejected',updated_at=now()
            WHERE id=$1 AND dispatch_generation=$2`,[row.id,generation]);
          continue;
        }
        await this.mark(row,'delivered');
      } catch (error) {
        // Dispatch identity is stable across a lost response or process restart.
        // An unknown acceptance stays pending and uses AgentRuns' existing identity.
        const code = String(error?.code ?? 'vcr_completion_unavailable');
        if (['research_session_not_found','project_not_found','vcr_completion_origin_unavailable','invalid_id'].includes(code)) {
          await this.notify(row,'unavailable'); await this.mark(row,'unavailable',code);
        } else { this.report(code); await this.mark(row,'pending',code); }
      }
    }
    return { attempted:rows.length };
  }
  async tick() { const reconciled = await this.reconcile(); return { reconciled,...await this.deliver() }; }
}
