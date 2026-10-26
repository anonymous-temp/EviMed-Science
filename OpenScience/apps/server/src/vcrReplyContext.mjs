import { VCR_CAPABILITIES } from '@evimed/domain';
/** Read-only research scope for a completed, control-plane-owned reply.
 * Never mint a context or infer a study from another conversation in the project. */
export async function resolveVcrReplyStudy({store,userId,projectId,run,sessionId=run?.sessionId,studyId=null}) {
  if(!store || !run?.id || run.status!=='succeeded' || typeof sessionId!=='string' || !sessionId || run.sessionId!==sessionId) return null;
  let study=null;
  if(String(run.effectiveRouteReason ?? '').startsWith('vcr:')) {
    if(!run.dispatchId) return null;
    study=await store.studyByRuntimeDispatch(String(userId),String(projectId),String(run.dispatchId));
  } else {
    const projectStudy=await store.studyByControlProject(String(userId),String(projectId));
    if(projectStudy?.conversationSessionId===sessionId) study=projectStudy;
    else {
      const row=await store.one(`SELECT id FROM evimed_vcr.studies WHERE user_id=$1 AND project_id=$2
        AND scope='conversation' AND conversation_session_id=$3 AND deleted_at IS NULL`,[String(userId),String(projectId),sessionId]);
      if(row) study=await store.getStudy(String(userId),String(row.id));
    }
  }
  return study && study.projectId===String(projectId) && (studyId==null || study.id===studyId) ? study : null;
}

/** The conversation can contain ordinary work after research. Only the current
 * turn's VCR work is checked against study numbers; mixed sources remain ungraded. */
export async function vcrReplyUsesStudy({store,userId,projectId,run,studyId,transcript,children=[],replySeq=undefined,selectRunHistory=null}) {
  if(!run?.id || run.status!=='succeeded' || !studyId || transcript?.header?.completeness!=='complete' || !Array.isArray(transcript.messages)) return false;
  if(transcript.header.runId!==run.id) return false;
  const root=transcript.messages.filter(message=>message.sessionId===run.sessionId);
  const requestIds=run.kernelRequestIds ?? [];
  const requestProof=root.some(message=>message.role==='user' && requestIds.includes(message.sourceRequestId) && Number.isSafeInteger(message.turnStartSeq));
  const nativeProof=!requestIds.length && Number.isSafeInteger(run.nativeTurn?.startSeq);
  // A per-run transcript file contains the whole session history. The saved
  // native turn/request identities, never time or matching prose, select this run.
  if(!requestProof && !nativeProof) return false;
  if(typeof selectRunHistory!=='function') return false;
  const ownRoot=selectRunHistory(run,root.map(message=>({info:message,parts:message.parts ?? []}))).map(message=>message.info);
  if(!ownRoot.length) return false;
  if(replySeq!==undefined && (!Number.isSafeInteger(replySeq) || !ownRoot.some(message=>message.role==='assistant' && message.seq===replySeq))) return false;
  const admitted=new Set(children.map(child=>String(child.sessionId ?? '')));
  const currentChildren=(transcript.header.sessions ?? []).filter(session=>admitted.has(session.sessionId) && session.parentSessionId===run.sessionId);
  if(currentChildren.length!==admitted.size) return false;
  const delegates=ownRoot.some(message=>(message.parts ?? []).some(part=>part.type==='tool' && ['subagent','evimed_delegate','evimed_await'].includes(part.tool)));
  if(delegates && !admitted.size) return false;
  const ownMessages=[...ownRoot,...transcript.messages.filter(message=>currentChildren.some(child=>child.sessionId===message.sessionId))];
  const names=new Set(ownMessages.flatMap(message=>(message.parts ?? []).filter(part=>part.type==='tool')
    .map(part=>String(part.tool ?? '').replace(/^mcp__evimed__/,''))));
  // General calculation values live in their own receipt-bound result ledger.
  // Until claims carry per-source bindings, a mixed turn earns no VCR-only verdict.
  if(names.has('research_calculate')) return false;
  if(run.effectiveRouteReason==='vcr-job-completion') {
    if(!run.dispatchId || !run.dispatchFingerprint || !run.sessionId) return false;
    const dispatchId=String(run.dispatchId).replace(/-retry-[1-9][0-9]*$/,'');
    const completion=await store.one(`SELECT study_id,job_id,payload FROM evimed_vcr.conversation_completions
      WHERE user_id=$1 AND project_id=$2 AND root_session_id=$3 AND dispatch_id=$4 AND fingerprint=$5`,
    [String(userId),String(projectId),run.sessionId,dispatchId,run.dispatchFingerprint]);
    return Boolean(completion?.study_id===studyId && completion.job_id && !completion.payload?.replayId);
  }
  if([...names].some(name=>['vcr_read','vcr_write','vcr_simulate','trial_registry_record','curve_digitize','evidence_pool'].includes(name))) return true;
  return String(run.effectiveRouteReason ?? '').startsWith('vcr:') || VCR_CAPABILITIES.includes(run.effectiveAgentId ?? run.agentId);
}
