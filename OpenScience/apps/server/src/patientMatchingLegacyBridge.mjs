/** Route the selected native generation from existing controls into one task ledger.
 * Historical VCR jobs keep their own readers; a deployment without the plugin refuses a start. */
import { PATIENT_MATCHING_TASK_KIND } from './patientMatchingRepository.mjs';
import { HttpError } from './security.mjs';

export function installPatientMatchingLegacyBridge({ vcr, adapter, documents, resolveOrigin }) {
  vcr.patientMatching = adapter;
  vcr.service.attach({ patientMatching: adapter });
  // The one start of a judging job: from the page, the conversation's `vcr_simulate` and a programme run. It is the plugin's, or it is refused.
  vcr.matchJudge = {
    start: async (/** @type {any} */ study, /** @type {any} */ selection) => {
      const origin = await resolveOrigin(study);
      if (!origin) throw new HttpError(409, 'patient_matching_generation_unavailable', 'Patient matching needs the matching plugin and this study\'s conversation; neither is available in this deployment right now.');
      return adapter.startSelection(origin, selection);
    },
  };
  vcr.service.attach({ matchJudge: vcr.matchJudge });
  async function context(studyId, taskId) {
    const study = await vcr.store.studyById(studyId);
    if (!study) return null;
    const row = await documents.get(study.userId, PATIENT_MATCHING_TASK_KIND, taskId);
    if (!row || row.payload.studyId !== studyId || row.projectId !== study.projectId) return null;
    return { study, row, origin: { ...row.payload.origin, pluginGeneration: row.payload.pluginGeneration } };
  }
  const oldGet = vcr.jobs.get.bind(vcr.jobs), oldResult = vcr.jobs.resultOf.bind(vcr.jobs), oldCancel = vcr.jobs.cancel.bind(vcr.jobs);
  vcr.jobs.get = async (studyId, jobId) => {
    if (!jobId.startsWith('matchTask_')) return oldGet(studyId,jobId);
    const found = await context(studyId,jobId); if (!found) return null;
    const pending = await adapter.pending(found.origin,jobId);
    return { id:jobId,jobId,studyId,kind:'match_judge',state:pending.state === 'complete' ? 'succeeded' : pending.state === 'cancelled' ? 'canceled' : 'running', progress:{completed:pending.cursor,total:pending.cursor+pending.remaining},checkpoint:{}, native:true };
  };
  vcr.jobs.resultOf = async (studyId,jobId,options = /** @type {{actorId?:string}} */ ({})) => {
    if (!jobId.startsWith('matchTask_')) return oldResult(studyId,jobId);
    const found = await context(studyId,jobId); if (!found) return null;
    if(!options.actorId)throw new HttpError(403,'vcr_forbidden','A patient-level matching result requires the acting account.');
    return adapter.pageResult(found.study,options.actorId,jobId);
  };
  vcr.jobs.cancel = async (studyId,jobId,options = {}) => {
    if (!jobId.startsWith('matchTask_')) return oldCancel(studyId,jobId,options);
    const found = await context(studyId,jobId); if (!found || options.actor && options.actor !== found.study.userId) throw new HttpError(404,'vcr_job_not_found','Matching task was not found.');
    await adapter.dispatch({port:'JobPort',operation:'cancel',input:{taskId:jobId,jobId},origin:found.origin});
    return {job:await vcr.jobs.get(studyId,jobId),canceled:true};
  };
  // Existing page progress and its continue action read the same reference-only native task metadata.
  const oldJobsOf = vcr.matchJudgments.jobsOf.bind(vcr.matchJudgments);
  vcr.matchJudgments.jobsOf = async request => {
    const old = await oldJobsOf(request), study = await vcr.dataStore.studyForAccess(request.studyId);
    if (!study) return old;
    const page = await documents.list(study.userId,PATIENT_MATCHING_TASK_KIND,{projectId:study.projectId,filter:{studyId:study.id},limit:100});
    const native = [];
    for (const row of page.items) {
      const meta=(await adapter.repository.get(row.payload.scope,row.id)).payload;
      const pairs=meta.selectedPairs.filter(pair=>request.direction==='patient_to_trial' ? pair.subjectKey===request.subjectKey && !meta.protocolVersionId : meta.protocolVersionId===request.protocolVersionId);
      if (!pairs.length) continue;
      const pending = await adapter.pending({...meta.origin,pluginGeneration:meta.pluginGeneration},row.id);
      native.push({id:row.id,state:pending.state==='complete'?'succeeded':pending.state==='cancelled'?'canceled':'queued',created_at:row.createdAt,updated_at:row.updatedAt,
        scenario:{direction:request.direction,subjects:[...new Set(pairs.map(pair=>pair.subjectKey))],...(meta.protocolVersionId?{protocolVersionId:meta.protocolVersionId}:{trials:pairs.map(pair=>({registryId:pair.trialId}))}),fit:false,topK:'all'}});
    }
    return [...native,...old].sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))).slice(0,request.limit??30);
  };
}
