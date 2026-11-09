/** Durable completion outbox. Terminal job rows are the producer's authoritative
 * log, so a crash between commit and a finish callback is repaired by reconcile. */
import { createHash } from 'node:crypto';
import {RuntimePromptStops} from './runtimePromptStops.mjs';
import { ProductDocuments } from './productStore.mjs';
import { HttpError,safeId } from './security.mjs';
import { experimentOutcome, presentCampaign, VCR_CAMPAIGN_STOP_TEXT_ZH } from './vcrExperiments.mjs';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Agent-run resource IDs are at most 64 characters. Keep the full digest as
 * the dispatch fingerprint while reserving room for the PostgreSQL int retry. */
export function vcrCompletionDispatchId(fingerprint,generation=0) {
  if(typeof fingerprint!=='string' || !/^[a-f0-9]{64}$/.test(fingerprint) || !Number.isInteger(generation) || generation<0 || generation>2147483647) throw new HttpError(400,'invalid_id','Invalid completion dispatch identity.');
  return safeId(`vcr-completion-${fingerprint.slice(0,32)}${generation ? `-retry-${generation}` : ''}`,'agent run dispatch id');
}
/** Revalidate the exact original conversation and research scope at each send boundary. */
/** `adoptSession` answers for a conversation the session store never saw: one typed in the kernel's own composer has runs and no row,
 * and without this every job that outlived its turn was reported as an unavailable conversation (found live, 2026-11-01). */
export function createVcrCompletionResolver({ accounts,studies,sessions,allows,adoptSession=null }) {
  return async row => {
    const user=await accounts.userById(row.user_id);if(!user)return null;
    if(row.study_id && !allows(user)) throw new HttpError(503,'vcr_disabled','Research tools are disabled for this account.');
    const project=await accounts.requireProject(user,row.project_id);
    // A member's conversation (the job is the study owner's, the completion belongs to the member who granted it) reads the study as the owner
    // did and needs the member's own live grant: the grant is what makes the conversation a valid place to answer.
    const memberOf=row.payload?.studyOwnerId ? String(row.payload.studyOwnerId) : null;
    const study=row.study_id ? await studies.getStudy(memberOf ?? row.user_id,row.study_id) : null;
    // A study handed to this conversation (R11) answers there while the grant stands, and a revoked grant has no conversation to wake;
    // without a grant, a conversation-scoped study answers only in the conversation it belongs to.
    const handoff=study && study.conversationSessionId!==row.root_session_id ? await studies.studyConversationHandoff?.(study.id,row.root_session_id,String(row.user_id)) : null;
    if(row.study_id && (!study || (memberOf ? !handoff : study.projectId!==row.project_id) || !['active','draft'].includes(study.status)
      || (handoff ? handoff.revokedAt!==null : study.scope==='conversation' && study.conversationSessionId!==row.root_session_id))) return {user,project,session:null};
    return {user,project,session:await sessions.get(project,row.root_session_id) ?? await adoptSession?.(project,row.root_session_id) ?? null};
  };
}
export class VcrConversationCompletions {
  constructor({ store, resolve, inbox, dispatch, notify, jobs = null, readOrigin = null, readRuns = null, readCurrentInput = null, readAcknowledgment = null, replayDocuments = null, config = {}, now = () => new Date(), report = (_code) => {} }) {
    this.jobs = jobs; this.readOrigin=readOrigin;this.readRuns=readRuns;this.readCurrentInput=readCurrentInput;this.readAcknowledgment=readAcknowledgment;this.replayDocuments=replayDocuments ?? (store.database ? new ProductDocuments(store.database) : null); this.config=/** @type {Record<string,any>} */ (config); this.now=now;
    this.counters={reconciled:0,attempted:0,delivered:0,observed:0,canceled:0,retried:0,exhausted:0,unavailable:0,notificationFailed:0,pruned:0};
    this.promptStops=new RuntimePromptStops({database:store.database ?? null});
    this.store = store; this.resolve = resolve; this.inbox = inbox; this.dispatch = dispatch; this.notify = notify; this.report = report;
  }
  /**
   * Whose conversation a job's, campaign's or comparison's completion wakes. The work is saved under the study's owner, but a conversation a study
   * was handed to by a member (R11) is the member's: the completion belongs to the member and the member's project, with the owner named in the
   * payload so the study is read as before, and only while the member's grant for that very conversation stands. Anything else that does not
   * match the row's owner and project is an invalid origin, as it was.
   * @param {Record<string, any>} row the job, campaign or comparison row (`user_id`, `study_id`) @param {Record<string, any> | null | undefined} origin
   * @param {string} projectId the study's project @param {boolean} strict whether the owner's own origin must also name the study's project (a job's does)
   * @returns {Promise<{ userId: string, projectId: string, studyOwnerId: string | null, invalid: boolean }>}
   */
  async conversationOf(row,origin,projectId,strict) {
    const owner={userId:String(row.user_id),projectId:String(projectId),studyOwnerId:null};
    if(origin?.userId && origin.userId!==row.user_id) {
      const grant=row.study_id && origin.rootSessionId && origin.projectId && this.store.one
        ? await this.store.one(`SELECT 1 AS held FROM evimed_vcr.study_conversations WHERE study_id=$1 AND session_id=$2 AND granted_by=$3 AND revoked_at IS NULL LIMIT 1`,
          [row.study_id,String(origin.rootSessionId),String(origin.userId)]) : null;
      if(grant) return {userId:String(origin.userId),projectId:String(origin.projectId),studyOwnerId:String(row.user_id),invalid:!origin.runId || !origin.callId};
      return {...owner,invalid:true};
    }
    return {...owner,invalid:strict ? origin?.userId !== row.user_id || origin?.projectId !== projectId || !origin?.rootSessionId || !origin?.runId || !origin?.callId : !origin?.callId};
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
  /**
   * A design-search campaign that stopped (any stop reason) is one completion, whatever its units were: the units carry no conversation
   * origin, so the campaign's own origin (the run that started it) is the only thing that can wake the conversation, once. The row's id
   * is the hash of the conversation and the campaign, so a restart, a second tick or a retention prune followed by a reconcile never
   * records a second one while the campaign's marker stands. A cancelled campaign is settled like a cancelled job: no turn, no notice.
   */
  async reconcileCampaigns() {
    if (!(await this.store.one("SELECT to_regclass('evimed_vcr.experiments') AS relation"))?.relation) return 0;
    const rows=await this.store.rows(`SELECT e.*,s.project_id FROM evimed_vcr.experiments e
      JOIN evimed_vcr.studies s ON s.id=e.study_id AND s.deleted_at IS NULL
      WHERE e.kind='campaign' AND e.status='stopped' AND e.origin->>'runId' IS NOT NULL AND e.origin->>'rootSessionId' IS NOT NULL
      AND COALESCE(e.state->>'completionRecorded','false')<>'true' ORDER BY e.updated_at,e.id LIMIT $1`,[this.config.vcrCompletionReconcileBatch ?? 50]);
    for(const row of rows){
      const origin=row.origin,reason=String(row.state?.stop?.reason ?? 'unknown');
      const who=await this.conversationOf(row,origin,row.project_id,false);
      const invalid=who.invalid;
      if(invalid) this.report('vcr_completion_origin_invalid');
      const view=presentCampaign(row);
      const shown=view.candidates.find(c=>c.key===view.best) ?? view.candidates.find(c=>c.key===view.undecided?.closest?.key) ?? null;
      const state=reason==='user_cancellation'?'canceled':reason==='persistent_model_failure'?'failed':'succeeded';
      const fingerprint=hash([who.userId,who.projectId,origin.rootSessionId,row.id,'campaign']);
      await this.store.query(`INSERT INTO evimed_vcr.conversation_completions
        (id,study_id,job_id,user_id,project_id,root_session_id,result_key,dispatch_id,fingerprint,payload,state,last_error)
        VALUES ($1,$2,NULL,$3,$4,$5,'campaign',$6,$7,$8::jsonb,$9,$10) ON CONFLICT DO NOTHING`,
      [`vcc_${fingerprint}`,row.study_id,who.userId,who.projectId,origin.rootSessionId,vcrCompletionDispatchId(fingerprint),fingerprint,
        JSON.stringify({...(who.studyOwnerId ? {studyOwnerId:who.studyOwnerId} : {}),completedAt:row.state?.stop?.at ?? row.updated_at,state,campaignId:row.id,stopReason:reason,resultId:null,resultVersion:null,partial:false,error:null,
          objective:view.objective?.pick?{phrase:view.objective.pick.phrase,sentence:view.objective.pick.sentence}:null,
          best:shown?{index:shown.index+1,set:shown.set,objective:(v=>v?{value:v.value,mcse:v.mcse ?? null,unit:v.unit ?? null}:null)(shown.objective.final ?? shown.objective.screening),source:view.best?'feasible':'undecided'}:null,
          robust:view.robust?{scenarios:view.robust.scenarios.map(x=>x.name),cheapestAcceptable:view.robust.cheapestAcceptable?{index:view.robust.cheapestAcceptable.index+1}:null,cheapestUnderBase:view.robust.cheapestUnderBase?{index:view.robust.cheapestUnderBase.index+1}:null,sameDesign:view.robust.sameDesign,statement:view.robust.statement}:null,
          runId:origin.runId,callId:origin.callId ?? null}),invalid?'unavailable':'pending',invalid?'vcr_completion_origin_invalid':null]);
      await this.store.query(`UPDATE evimed_vcr.experiments SET state=state || '{"completionRecorded":true}'::jsonb WHERE id=$1`,[row.id]);
    }
    return rows.length;
  }
  /**
   * A design comparison whose arms have all ended is one completion, whatever its arms were (R04). Its arm jobs carry no conversation
   * origin, so the job path never sees them: the comparison's own origin wakes the conversation, once, with the aggregate (succeeded,
   * partial, failed or canceled). The row is the hash of the conversation and the comparison, so a restart, a second tick or a lost
   * marker never records a second one. A comparison the originating run read after it ended is observed, like a campaign's stop.
   */
  async reconcileExperiments() {
    if (!(await this.store.one("SELECT to_regclass('evimed_vcr.experiments') AS relation"))?.relation) return 0;
    const rows=await this.store.rows(`SELECT e.*,s.project_id FROM evimed_vcr.experiments e
      JOIN evimed_vcr.studies s ON s.id=e.study_id AND s.deleted_at IS NULL
      WHERE e.kind='experiment' AND e.origin->>'runId' IS NOT NULL AND e.origin->>'rootSessionId' IS NOT NULL
      AND COALESCE(e.state->>'completionRecorded','false')<>'true' AND e.created_at>now()-make_interval(secs=>$2)
      AND NOT EXISTS (SELECT 1 FROM evimed_vcr.jobs j WHERE j.study_id=e.study_id AND j.checkpoint->'experiment'->>'id'=e.id AND j.state IN ('queued','running','awaiting_budget'))
      ORDER BY e.updated_at,e.id LIMIT $1`,[this.config.vcrCompletionReconcileBatch ?? 50,this.ageSeconds()]);
    let recorded=0;
    for(const row of rows){
      const outcome=await experimentOutcome(this.store,row);
      if(!outcome.terminal) continue;
      const origin=row.origin;
      const who=await this.conversationOf(row,origin,row.project_id,false);
      const invalid=who.invalid;
      if(invalid) this.report('vcr_completion_origin_invalid');
      const fingerprint=hash([who.userId,who.projectId,origin.rootSessionId,row.id,'experiment']);
      await this.store.query(`INSERT INTO evimed_vcr.conversation_completions
        (id,study_id,job_id,user_id,project_id,root_session_id,result_key,dispatch_id,fingerprint,payload,state,last_error)
        VALUES ($1,$2,NULL,$3,$4,$5,'experiment',$6,$7,$8::jsonb,$9,$10) ON CONFLICT DO NOTHING`,
      [`vcc_${fingerprint}`,row.study_id,who.userId,who.projectId,origin.rootSessionId,vcrCompletionDispatchId(fingerprint),fingerprint,
        JSON.stringify({...(who.studyOwnerId ? {studyOwnerId:who.studyOwnerId} : {}),completedAt:outcome.finishedAt ?? row.updated_at,state:outcome.state,experimentId:row.id,outcome:outcome.outcome,arms:outcome.arms,resultId:null,resultVersion:null,
          partial:outcome.partial,error:null,runId:origin.runId,callId:origin.callId ?? null}),invalid?'unavailable':'pending',invalid?'vcr_completion_origin_invalid':null]);
      await this.store.query(`UPDATE evimed_vcr.experiments SET state=state || '{"completionRecorded":true}'::jsonb WHERE id=$1`,[row.id]);
      recorded++;
    }
    return recorded;
  }
  async reconcile() {
    await this.jobs?.reconcileFinishHooks();
    const replayCount=await this.reconcileReplays()+await this.reconcileCampaigns()+await this.reconcileExperiments();
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
      const who=await this.conversationOf(row,origin,row.project_id,true);
      const invalid=who.invalid;
      if(invalid) this.report('vcr_completion_origin_invalid');
      const key = row.result_id ? `${row.result_id}:${row.result_version}` : 'none';
      const fingerprint = hash([who.userId,who.projectId,origin?.rootSessionId ?? 'invalid',row.id,key]);
      await this.store.query(`INSERT INTO evimed_vcr.conversation_completions
        (id,study_id,job_id,user_id,project_id,root_session_id,result_key,dispatch_id,fingerprint,payload,state,last_error)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12) ON CONFLICT (job_id,result_key) DO NOTHING`,
      [`vcc_${fingerprint}`,row.study_id,row.id,who.userId,who.projectId,origin?.rootSessionId ?? 'invalid',key,vcrCompletionDispatchId(fingerprint),fingerprint,
        JSON.stringify({...(who.studyOwnerId ? {studyOwnerId:who.studyOwnerId} : {}),completedAt:row.finished_at,state: row.state, resultId: row.result_id ?? null, resultVersion: row.result_version ?? null,
          partial: row.partial === 'true', error: row.error ? { code: row.error.code ?? 'vcr_job_failed' } : null,
          runId: origin?.runId, callId: origin?.callId }),invalid ? 'unavailable' : 'pending',invalid ? 'vcr_completion_origin_invalid' : null]);
      await this.store.query(`UPDATE evimed_vcr.jobs SET checkpoint=checkpoint || '{"completionOutboxRecorded":true}'::jsonb WHERE id=$1`,[row.id]);

    }
    return rows.length+replayCount;
  }
  async observation(row) {
    if(this.readAcknowledgment) return this.readAcknowledgment(row);
    if(!this.store.one) return null;
    const source=row.payload.campaignId ?? row.payload.experimentId
      ? await this.store.one(`SELECT state->'originTerminalObservation' AS observation,CASE WHEN $2='canceled' THEN 'canceled' ELSE 'stopped' END AS state
          FROM evimed_vcr.experiments WHERE id=$1 AND user_id=$3`,[row.payload.campaignId ?? row.payload.experimentId,row.payload.state,row.payload.studyOwnerId ?? row.user_id])
      : row.payload.replayId
      ? await this.store.one(`SELECT d.payload->'terminalObservation' AS observation,COALESCE(j.status,d.payload->>'state') AS state
          FROM evimed_product.documents d LEFT JOIN evimed_product.jobs j ON j.id=d.payload->>'jobId' AND j.user_id=d.user_id
          WHERE d.id=$1 AND d.project_id=$2 AND COALESCE(d.payload->>'requestedBy',d.user_id)=$3 AND d.kind='result-replay' AND d.deleted_at IS NULL`,[row.payload.replayId,row.project_id,row.user_id])
      : await this.store.one(`SELECT checkpoint->'originTerminalObservation' AS observation,state FROM evimed_vcr.jobs WHERE id=$1 AND user_id=$2`,[row.job_id,row.payload.studyOwnerId ?? row.user_id]);
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
    // The newest kernel input is the turn this continuation answers when it is the original turn's input or the prompt of an earlier
    // platform continuation of the same conversation (a dispatch id of ours): that is the platform's own wake, never a person typing.
    // Without it the second job of a run, finishing after the first one's continuation, was disclosed in the inbox and never woken (live D5).
    const turns=original ? [original,...(runs ?? []).filter(run=>run.sessionId===row.root_session_id && run.automated && String(run.dispatchId ?? '').startsWith('vcr-completion-'))] : [];
    if(final && this.readCurrentInput && (!input || !original || !turns.some(turn=>
      input.requestId && turn.kernelRequestIds?.includes(input.requestId)
      || Number.isSafeInteger(input.turnStartSeq) && input.turnStartSeq===turn.nativeTurn?.startSeq
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
    const covered=new Set();
    for (const row of rows) {
      if(covered.has(row.id)) continue;
      const siblings=[];
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
        // Jobs of one conversation that finished together are one continuation: it reads every unobserved result, never one turn per job.
        for(const other of rows) {
          if(other===row || covered.has(other.id) || other.user_id!==row.user_id || other.root_session_id!==row.root_session_id) continue;
          if(await this.disposition(other,owned.project)===null) siblings.push(other);
        }
        const label={succeeded:'计算已完成',failed:'计算未完成',canceled:'计算已取消'}[outcome.state] ?? '计算状态有更新';
        const campaignText=outcome.campaignId ? `设计搜索已结束：${VCR_CAMPAIGN_STOP_TEXT_ZH[outcome.stopReason] ?? '已停止。'}${outcome.robust?.statement ? outcome.robust.statement : outcome.best ? `${outcome.best.source==='feasible'?(outcome.objective?.sentence ? `在这些假设下，${outcome.objective.sentence}` : '在这些假设下，满足全部约束的方案'):'最接近'}是第 ${outcome.best.index} 个。` : ''}` : null;
        const experimentText=outcome.experimentId ? `方案对比已结束：${{succeeded:'每一组都有结果',partial:`${outcome.arms?.complete ?? 0} 组有结果，${(outcome.arms?.total ?? 0)-(outcome.arms?.complete ?? 0)} 组没有结果`,failed:'没有一组算出结果',canceled:'已按要求停止'}[outcome.outcome] ?? '已结束'}。` : null;
        const text = experimentText ? `${experimentText}请继续原来的任务，读取实际结果再解释。` : campaignText ? `${campaignText}请继续原来的任务，读取实际结果再解释。` : `${label}${outcome.partial ? '，保留了部分结果' : ''}。请继续原来的任务，读取实际结果再解释。`;
        const systemSupplement = outcome.experimentId
          ? `Platform comparison notice. Experiment=${outcome.experimentId}; tool=vcr_simulate action=compare_status; outcome=${outcome.outcome}; arms=${JSON.stringify(outcome.arms)}. This is an automated continuation of the original user request. Read the comparison with compare_status before you explain it and use only its numbers; an arm without a result is not compared and is never estimated. Do not start another comparison without a new user request. Nobody is attending this turn.`
          : outcome.campaignId
          ? `Platform design-search notice. Campaign=${outcome.campaignId}; tool=vcr_simulate action=search_status; stop=${outcome.stopReason}; best=${JSON.stringify(outcome.best)}. This is an automated continuation of the original user request. Read the campaign with search_status before you explain it and use only its numbers; the frozen constraints never change, and a design undecided on a constraint is neither passed nor failed.${outcome.robust ? ' The search compared several effect scenarios: report each design in every scenario, the worst case and the largest regret from the search status, say "under these assumptions" and never call one design the best or the optimum.' : ''} Do not start another campaign without a new user request. Nobody is attending this turn.`
          : `Platform computation notice. Original job=${outcome.replayId ?? row.job_id}; tool=${outcome.replayId ? "research_calculate" : "vcr_simulate"}; state=${outcome.state}; result=${outcome.resultId ?? 'none'}; version=${outcome.resultVersion ?? 'none'}; partial=${outcome.partial === true}; error=${outcome.error?.code ?? 'none'}. This is an automated continuation of the original user request. Use the recorded result; do not treat a failure, cancellation or partial result as success. Nobody is attending this turn.${outcome.state === "canceled" ? " The computation was canceled. Do not restart it or queue replacement calculations without a new user request." : ""}`;
        const alsoText=siblings.map(other=>other.payload.experimentId
          ? ` Also finished in this conversation: experiment=${other.payload.experimentId}; tool=vcr_simulate action=compare_status; outcome=${other.payload.outcome}.`
          : other.payload.campaignId
          ? ` Also finished in this conversation: campaign=${other.payload.campaignId}; tool=vcr_simulate action=search_status; stop=${other.payload.stopReason}.`
          : ` Also finished in this conversation: job=${other.payload.replayId ?? other.job_id}; state=${other.payload.state}; result=${other.payload.resultId ?? 'none'}; version=${other.payload.resultVersion ?? 'none'}; error=${other.payload.error?.code ?? 'none'}.`).join('');
        const assertCurrent=async ({runs=null,final=false,signal=null}={}) => {
          const current=await this.resolve(row);signal?.throwIfAborted();
          if(!current?.session) throw Object.assign(new Error('Original conversation unavailable'),{code:'research_session_not_found',definitivelyRejected:true});
          const inbox=await this.inbox(current.project,row.root_session_id);signal?.throwIfAborted();
          if(!inbox || inbox.running!==false || inbox.queued!==0) throw Object.assign(new Error('Conversation busy'),{code:'vcr_conversation_busy',definitivelyRejected:true});
          const code=await this.disposition(row,current.project,runs,{final,dispatchId,signal});
          if(code) throw Object.assign(new Error(code),{code,definitivelyRejected:true});
        };
        const dispatched = await this.dispatch(owned.user,owned.project,row.root_session_id,dispatchId,text,{ nativeContinuation:true,
          dispatchFingerprint:row.fingerprint,systemSupplement:systemSupplement+alsoText,originRunId:outcome.runId,
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
        for(const other of siblings) {covered.add(other.id);await this.mark(other,'delivered','vcr_completion_covered');}
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
    const pruned=await this.store.query(`DELETE FROM evimed_vcr.conversation_completions WHERE id IN (SELECT id FROM evimed_vcr.conversation_completions WHERE state<>'pending' AND COALESCE(last_error,'') NOT LIKE 'vcr_completion_notice_failed:%' AND updated_at<now()-make_interval(secs=>$1) ORDER BY updated_at LIMIT $2)`,[retention/1000,this.config.vcrCompletionReconcileBatch ?? 50]);
    this.counters.pruned+=Number(pruned?.rowCount ?? 0);
    return {reconciled,...await this.deliver()};
  }
  status() { return {...this.counters}; }
}
