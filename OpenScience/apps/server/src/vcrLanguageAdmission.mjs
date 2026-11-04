// Internal candidate-only admission prototype. Not wired to the product.
import { createHash } from 'node:crypto';
import { canonicalScenarioJson, priceUsage } from '@evimed/domain';
import { estimateModelReservation } from './modelGateway.mjs';
import { freezeVcrLanguageUnit } from './vcrLanguageUnit.mjs';
import { buildVcrLanguageBody } from './vcrLanguageModel.mjs';
import { languageCriteriaByKey, languageCriterionHash } from './vcrMatchingSnapshot.mjs';
import { languageKeysOf, VCR_MATCHING_EVALUATOR_VERSION } from './vcrMatching.mjs';
import { locateSourceText } from './vcrPatientTrials.mjs';

/** @param {{candidateStore:any,matchStore:any,dataPlane:any,jobs:any,config:any}} deps */
export function createVcrLanguageAdmission({candidateStore,matchStore,dataPlane,jobs,config}) {
  return {
    /** @param {any} study @param {{subjectKey:string,candidateTrialId:string}[]} pairs */
    async start(study,pairs) {
      if(config.vcrLanguageExperimentalEnabled!==true)throw Object.assign(new Error('Candidate language jobs are unavailable.'),{code:'vcr_language_unavailable'});
      const runLimit=Number(config.vcrLanguageRunLimitCny);
      if(!Number.isFinite(runLimit)||runLimit<=0||!Array.isArray(pairs)||!pairs.length||pairs.length>20||!study?.id||!study?.userId||!study?.projectId)throw new TypeError('A study, bounded pairs and positive job budget are required.');
      if(config.deepseekModel!=='deepseek-flash'||!jobs?.enqueue)throw new TypeError('A metered Flash job queue is required.');
      const unique=new Set(), units=[], unavailable=[];let estimateCny=0,inputTokens=0,outputTokens=0;
      for(const pair of pairs){
        const subjectKey=String(pair?.subjectKey??''),candidateTrialId=String(pair?.candidateTrialId??''), key=`${subjectKey}\u0000${candidateTrialId}`;
        if(!subjectKey||!candidateTrialId||unique.has(key))throw new TypeError('Each pair must be named once.');unique.add(key);
        const roster=await dataPlane.listDocuments({studyId:study.id,principal:study.userId,subjectKey});
        const withdrawn=await matchStore.withdrawnSubjects(study.id);
        if(withdrawn.has(subjectKey)||(!roster.length&&!await matchStore.holdsSubject(study.id,subjectKey))){unavailable.push({subjectKey,candidateTrialId,code:'vcr_subject_not_found'});continue;}
        const trial=await candidateStore.getCandidateTrial({studyId:study.id,id:candidateTrialId});
        if(!trial){unavailable.push({subjectKey,candidateTrialId,code:'vcr_candidate_trial_not_found'});continue;}
        if(typeof trial.recordHash!=='string'||!/^[a-f0-9]{64}$/.test(trial.recordHash)){unavailable.push({subjectKey,candidateTrialId,code:'vcr_candidate_revision_unavailable'});continue;}
        const criteria=await candidateStore.listCriteria(candidateTrialId), bindings=languageCriteriaByKey(criteria);
        const existing=await candidateStore.latestLanguageJudgments({studyId:study.id,candidateTrialId,subjectKey});
        if(!roster.length){unavailable.push({subjectKey,candidateTrialId,code:'vcr_source_unavailable'});continue;}
        const documents=[], loaded=[];let readable=true;
        for(const entry of roster){
          try {
            const actual=await dataPlane.projectionText({studyId:study.id,documentId:entry.id,principal:study.userId,purpose:'vcr'},true);
            if(!actual||actual.subjectKey!==subjectKey||!actual.sourceHash){readable=false;break;}
            documents.push({id:entry.id,sourceId:entry.sourceId,sourceHash:actual.sourceHash,projectionHash:actual.projectionHash??null,projectionId:actual.projectionHash?actual.id:null});
            loaded.push({documentId:actual.id,text:actual.text,visibleAt:actual.visibleAt??null});
          } catch {readable=false;break;}
        }
        if(!readable){unavailable.push({subjectKey,candidateTrialId,code:'vcr_source_unavailable'});continue;}
        for(const [criterionKey,bound] of bindings){
          if(existing[criterionKey])continue;
          if(!trial.eligibilityText||bound.some(c=>!locateSourceText(c.sourceText,trial.eligibilityText))){unavailable.push({subjectKey,candidateTrialId,criterionKey,code:'vcr_criterion_source_unavailable'});continue;}
          const axes=['requirement','applicability'].filter(axis=>bound.some(c=>languageKeysOf(c[axis],c.id).includes(criterionKey)));
          if(axes.length!==1){unavailable.push({subjectKey,candidateTrialId,criterionKey,code:'vcr_criterion_ambiguous'});continue;}
          const frozen=freezeVcrLanguageUnit({studyId:study.id,userId:study.userId,subjectKey,candidateTrialId,criterionKey,axis:axes[0],recordHash:trial.recordHash??null,
            criterionHash:languageCriterionHash(bound,criterionKey),expectedJudgmentId:await candidateStore.currentLanguageHead({studyId:study.id,subjectKey,candidateTrialId,criterionKey}),evaluatorVersion:VCR_MATCHING_EVALUATOR_VERSION,
            promptVersion:'candidate-language-1',model:'deepseek-flash',thinking:'disabled',outputLimit:2000,documents});
          const body=buildVcrLanguageBody({unit:frozen.payload,criteria:bound,documents:loaded});
          const measured=estimateModelReservation(body,config);
          const price=priceUsage({resourceType:'model',model:body.model,cacheHit:0,cacheMiss:measured.promptTokens,output:measured.outputTokens,peak:true});
          if(!price.priced||!Number.isFinite(price.cost))throw new Error('Language unit pricing is unavailable.');
          estimateCny+=price.cost;inputTokens+=measured.promptTokens;outputTokens+=measured.outputTokens;
          units.push(frozen.payload);
          if(units.length>20)throw new Error('At most twenty language units may be admitted.');
        }
      }
      const estimate={basis:'uncached_peak_estimate',currency:'CNY',cost:estimateCny,inputTokens,outputTokens,units:units.length};
      if(estimateCny>runLimit)throw Object.assign(new Error('The estimated model cost exceeds the job budget.'),{code:'usage_budget_exceeded'});
      if(!units.length)return {job:null,estimate,unavailable};
      const unitHashes=units.map(unit=>freezeVcrLanguageUnit(unit).unitHash);
      const chain=createHash('sha256').update(canonicalScenarioJson({studyId:study.id,unitHashes,runLimit})).digest('hex');
      const held=await jobs.store?.rows?.(`SELECT id,state FROM evimed_vcr.jobs WHERE study_id=$1 AND kind='match_language' AND scenario->>'chain'=$2 ORDER BY created_at`,[study.id,chain])??[];
      const active=held.find(row=>['queued','running','awaiting_budget'].includes(row.state));
      if(active)return {job:{id:active.id,state:active.state},alreadyRunning:true,estimate,unavailable};
      const {job}=await jobs.enqueue({studyId:study.id,userId:study.userId,kind:'match_language',internal:true,scenario:{units,unitHashes,runLimit,chain},inputs:[],cpuSecondsLimit:60,maxAttempts:3,idempotencyKey:`vcr:${study.id}:language:${chain}:g${held.length}`});
      return {job,estimate,unavailable};
    },
  };
}
