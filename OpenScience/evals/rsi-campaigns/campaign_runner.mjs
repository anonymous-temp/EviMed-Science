/** Offline orchestration. Configuration/attestations are supplied by the lab owner, never a model. */
import { createHash,createPublicKey,verify } from 'node:crypto';
import { rsiCampaignIssues, rsiCampaignMonth } from '../../packages/domain/src/rsiCampaign.mjs';
import { rsiLabConfigurationIssues } from '../../apps/server/src/rsiLabConfiguration.mjs';
import { ProductDocuments } from '../../apps/server/src/productStore.mjs';
import {canonicalRsiJson,rsiDigest} from '../../apps/server/src/rsiCampaignBundle.mjs';
import { chooseFrontierCandidate, evaluateFrontierDays, frontierCampaignConsumerIdentity, frontierDaysIssues, frontierObservations } from './frontier_campaign.mjs';
import { chooseSkillCandidate, skillArmsIssues, skillCampaignConsumerIdentity, skillObservations, SKILL_BASELINE_ARM } from './skill_campaign.mjs';
export const digest = rsiDigest;
const stop = reason => ({status:'not-qualified',reason});
/** Statistics answers that are a verdict on the evidence; anything else (authority, receipt, process failure) is retried. */
const VERDICTS = ['qualified','not-qualified','inconclusive'];
/** A quarter's error budget per surface (design spec §statistics): every confirmation opened in the quarter draws from it. */
export const RSI_QUARTER_ALPHA = 0.05;
export function campaignPlan(manifest) { return {campaignId:manifest.id,automated:true,stages:['development','confirmation','evaluation'],unsupported:!Object.hasOwn(consumers,manifest.surface)}; }
/** @param {string} instant @returns {string} the Asia/Shanghai calendar quarter, e.g. 2026-Q4 */
export function rsiCampaignQuarter(instant) { const [year,month]=rsiCampaignMonth(instant).split('-').map(Number); return `${year}-Q${Math.ceil(month/3)}`; }
export async function labPreflight(configuration, attestLab) {
 const issues = rsiLabConfigurationIssues(configuration);
 if (issues.length) return stop(issues.includes('campaign_host_unavailable')?'campaign_host_unavailable':issues[0]);
 if (!attestLab) return stop('campaign_isolation_unverified');
 let actual;try{actual=await attestLab();}catch{return stop('campaign_isolation_unverified');}
 if (actual.role !== configuration.authority.databaseRole || actual.database !== 'evimed_rsi_lab' || actual.hostInstanceId !== configuration.host.instanceId || actual.hostPurpose !== 'rsi-lab') return stop('campaign_isolation_unverified');
 return {status:'ready'};
}
/**
 * Holds a session advisory lock across stage execution; CAS revision protects checkpoints as well. The confirmation ledger
 * is shared by every campaign of the lab account: a corpus is opened by one campaign only, and a surface's confirmations in
 * one quarter draw at most RSI_QUARTER_ALPHA between them.
 */
export function productCampaignStore(database, owner) {
 const documents = new ProductDocuments(database);
 return {withCampaign: async (id, operation) => {
  const client = await database.pool.connect();
  const key = `rsi-campaign:${owner}:${id}`;
  try {
   const locked = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked',[key]);
   if (!locked.rows[0]?.locked) return stop('campaign_claim_busy');
   const recordId = `rsi-campaign:${id}`;
   let row = await documents.get(owner,'knowledge',recordId);
   return await operation({read:()=>row?.payload ?? null,write:async payload=>{row=await documents.put(owner,'knowledge',recordId,payload,{expectedRevision:row?.revision ?? 0});},
    reserveConfirmation:async request=>database.transaction(async tx=>{
     await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`rsi-confirmation:${owner}`]);
     const ledgerId=`rsi-alpha:${request.surface}:${request.quarter}`, corpusId=`rsi-corpus:${request.corpusDigest}`;
     const [ledger,corpus]=await Promise.all([documents.get(owner,'knowledge',ledgerId),documents.get(owner,'knowledge',corpusId)]);
     const decision=confirmationDecision(ledger?.payload,corpus?.payload,request);
     if(decision.write){
      await documents.put(owner,'knowledge',ledgerId,decision.ledger,{expectedRevision:ledger?.revision ?? 0,transactionClient:tx});
      await documents.put(owner,'knowledge',corpusId,decision.corpus,{expectedRevision:corpus?.revision ?? 0,transactionClient:tx});
     }
     return decision.result;
    })});
  } finally { await client.query('SELECT pg_advisory_unlock(hashtext($1))',[key]); client.release(); }
 }};
}
/** Pure ledger rule shared by the PostgreSQL store and test stores. */
export function confirmationDecision(ledger, corpus, {surface,quarter,campaignId,alpha,corpusDigest,at}) {
 const reservations=Array.isArray(ledger?.reservations)?ledger.reservations:[];
 const own=reservations.find(row=>row.campaignId===campaignId);
 if(corpus && corpus.campaignId!==campaignId) return {write:false,result:{authorized:false,reason:'campaign_confirmation_corpus_already_opened'}};
 if(own) return own.corpusDigest===corpusDigest&&own.alpha===alpha?{write:false,result:{authorized:true,look:own.looks ?? 1,reused:true}}:{write:false,result:{authorized:false,reason:'campaign_confirmation_reservation_changed'}};
 const used=reservations.reduce((sum,row)=>sum+row.alpha,0);
 if(!(alpha>0) || used+alpha>RSI_QUARTER_ALPHA+1e-12) return {write:false,result:{authorized:false,reason:'campaign_alpha_budget_exhausted',used}};
 return {write:true,result:{authorized:true,look:1,reused:false},
  ledger:{recordType:'rsi-alpha-ledger',surface,quarter,reservations:[...reservations,{campaignId,alpha,corpusDigest,at,looks:1}]},
  corpus:{recordType:'rsi-opened-corpus',corpusDigest,campaignId,surface,openedAt:at}};
}
/** Closed consumer registry: no executable paths, prompts, dynamic module imports or arbitrary callbacks in inputs. */
const consumers = Object.freeze({
 'frontier-selection': {
  deterministic:true,
  identity:frontierCampaignConsumerIdentity,
  /** Days of development strictly precede confirmation days; no row and no day is in both; labels belong to their source. */
  validate(manifest, inputs, dev, confirm) {
   for(const source of [dev,confirm]) if(frontierDaysIssues(inputs.sources[source.id]).length) return 'campaign_source_invalid';
   const registration=inputs.registration;
   if(!Number.isFinite(registration.baselineThreshold) || !Array.isArray(registration.thresholds) || !registration.thresholds.length || registration.thresholds.some(x=>!Number.isFinite(x))) return 'campaign_registration_invalid';
   if(registration.selection?.objective!=='weighted-accuracy-difference' || registration.selection?.tieBreak!=='nearest-baseline') return 'campaign_selection_registration_missing';
   const devDays=inputs.sources[dev.id].days.map(day=>day.day), confirmDays=inputs.sources[confirm.id].days.map(day=>day.day);
   if(manifest.data.classification!=='synthetic') {
    if(devDays.some(day=>confirmDays.includes(day)) || [...devDays].sort().at(-1)>=[...confirmDays].sort()[0]) return 'campaign_confirmation_not_independent';
    const devIds=new Set(inputs.sources[dev.id].days.flatMap(day=>day.rows.map(row=>String(row.id))));
    if(inputs.sources[confirm.id].days.some(day=>day.rows.some(row=>devIds.has(String(row.id))))) return 'campaign_confirmation_not_independent';
   }
   for(const source of [dev,confirm]) {
    const ids=new Set(inputs.sources[source.id].days.flatMap(day=>day.rows.map(row=>String(row.id))));
    if(inputs.sources[source.id].labels.some(label=>!ids.has(label.id))) return 'campaign_labels_outside_source';
   }
   return null;
  },
  develop(source, registration) {
   const evaluation=evaluateFrontierDays(source,registration);
   const choice=chooseFrontierCandidate(evaluation,registration);
   return {result:{evaluation,candidates:choice.candidates},frozen:choice.frozen,reason:choice.reason};
  },
  freeze:(frozen,registration)=>({threshold:frozen.threshold,baselineThreshold:registration.baselineThreshold}),
  confirm(source, registration, frozen) {
   const evaluation=evaluateFrontierDays(source,{...registration,thresholds:[frozen.threshold],labelThresholds:registration.thresholds});
   if(!evaluation.eligible) return {result:{evaluation},reason:'campaign_consumer_failed'};
   const measured=frontierObservations(evaluation,registration,frozen.threshold);
   return {result:{evaluation,observations:measured.observations,volumeRatio:measured.volumeRatio},reason:measured.reason};
  },
 },
 /**
  * A personal skill measured on recorded production runs (skill_campaign.mjs). The lab computation is deterministic over
  * the records (a stage re-runs to the same bytes); the measurement was paid for and is stochastic, so the statistics are
  * a paid paired-t family with repeats, and the evaluator attests the runs' settled costs instead of zero.
  */
 'capability-skill': {
  deterministic:true,
  paidMeasurement:true,
  identity:skillCampaignConsumerIdentity,
  validate(manifest, inputs, dev, confirm) {
   const development=inputs.sources[dev.id], confirmation=inputs.sources[confirm.id], registration=inputs.registration;
   for(const source of [development,confirmation]) if(skillArmsIssues(source).length) return 'campaign_source_invalid';
   if(!Array.isArray(registration.failureCalculators) || !registration.failureCalculators.length || registration.failureCalculators.some(id=>!Number.isInteger(id)) || !(registration.margin>0 && registration.margin<1)) return 'campaign_registration_invalid';
   if(registration.selection?.objective!=='failure-slice-gain' || registration.selection?.tieBreak!=='shorter-skill') return 'campaign_selection_registration_missing';
   if(manifest.data.classification!=='synthetic') {
    const devRows=new Set(development.rows.map(row=>String(row.id)));
    if(confirmation.rows.some(row=>devRows.has(String(row.id)))) return 'campaign_confirmation_not_independent';
   }
   const candidates=Object.keys(confirmation.arms).filter(arm=>arm!==SKILL_BASELINE_ARM);
   if(candidates.length!==1 || !Object.hasOwn(development.arms,candidates[0]) || development.arms[candidates[0]].skill.digest!==confirmation.arms[candidates[0]].skill.digest) return 'campaign_confirmation_candidate_mismatch';
   const statistics=registration.statistics, family=statistics?.families?.[statistics?.groups?.[0]?.family];
   if(!family || family.repeats!==confirmation.repeats || statistics.deterministicConsumer!==false || statistics.mode!=='paired-t') return 'campaign_statistics_registration_invalid';
   const slice=new Set(registration.failureCalculators);
   const expected=confirmation.rows.map(row=>`row-${row.id}:${slice.has(Number(row.calculatorId))}`).sort();
   if(digest(expected)!==digest(statistics.groups.map(group=>`${group.id}:${group.failure_slice}`).sort())) return 'campaign_source_group_registration_invalid';
   return null;
  },
  develop(source, registration) {
   const choice=chooseSkillCandidate(source,registration);
   return {result:{scores:choice.scores,candidates:choice.candidates},frozen:choice.frozen,reason:choice.reason};
  },
  freeze:(frozen)=>({arm:frozen.arm,skillDigest:frozen.skillDigest}),
  confirm(source, registration, frozen) {
   const measured=skillObservations(source,registration,frozen);
   return {result:{observations:measured.observations,scores:measured.scores ?? null},reason:measured.reason};
  },
 },
});
function validateInputs(manifest, inputs) {
 if (!inputs || typeof inputs !== 'object' || !inputs.registration || !inputs.sources) return 'campaign_inputs_missing';
 if (digest(inputs.registration) !== manifest.registration.digest) return 'campaign_registration_changed';
 for (const source of manifest.data.sources) if (!Object.hasOwn(inputs.sources ?? {},source.id) || digest(inputs.sources[source.id]) !== source.digest) return 'campaign_source_changed';
 if (digest(inputs.target) !== digest(manifest.target)) return 'campaign_target_changed';
 const dev=manifest.data.sources.find(row=>row.role==='development'), confirm=manifest.data.sources.find(row=>row.role==='confirmation');
 if(!dev || !confirm || dev.id===confirm.id || dev.digest===confirm.digest) return 'campaign_independent_sources_missing';
 if(manifest.data.classification!=='synthetic' && confirm.exposure!=='sealed') return 'campaign_confirmation_not_independent';
 return consumers[manifest.surface]?.validate(manifest,inputs,dev,confirm) ?? null;
}
export async function runCampaign({manifest,inputs,configuration,store,attestLab,now=()=>new Date().toISOString(),signal,attestEvaluation,statisticsPython,statisticsModulePath,incidentTransport}) {
 const preflight = await labPreflight(configuration,attestLab);
 if (preflight.status !== 'ready') return preflight;
 const issues = rsiCampaignIssues(manifest);
 if (issues.length) return stop(issues[0]);
 const incidentCurrent=async()=>{
  if(manifest.data.classification!=='authorized-incident')return true;
  if(!incidentTransport?.assertIncidentCurrent)return false;
  try{await incidentTransport.assertIncidentCurrent(manifest.data.authorization);return true;}catch{return false;}
 };
 if(!await incidentCurrent())return stop('campaign_incident_not_current');
 if (!Object.hasOwn(consumers,manifest.surface)) return stop('campaign_consumer_not_qualified');
 let invalid;try{invalid=validateInputs(manifest,inputs);}catch{return stop('campaign_inputs_invalid');}if(invalid)return stop(invalid);
 const consumer=consumers[manifest.surface];
 let binding;try{binding=digest({manifest,inputs});}catch{return stop('campaign_inputs_invalid');}
 return store.withCampaign(manifest.id,async checkpoint=>{
  let state = await checkpoint.read();
  if(state && state.binding !== binding) return stop('campaign_checkpoint_input_changed');
  state ??= {recordType:'rsi-campaign-checkpoint',campaignId:manifest.id,binding,automated:true,stages:{},createdAt:now(),month:rsiCampaignMonth(now())};
  if(state.outcome) return state.outcome;
  const finish=async outcome=>{state.outcome=outcome;await checkpoint.write(state);return outcome;};
  const guard=async()=>{
   if(!await incidentCurrent())return stop('campaign_incident_not_current');
   if(signal?.aborted) return stop('campaign_cancelled');
   if(Date.parse(now()) >= Date.parse(manifest.deadline)) return stop('campaign_deadline_expired');
   if(rsiCampaignMonth(now()) !== state.month) return stop('campaign_budget_month_expired');
   return null;
  };
  for(const stage of ['development','confirmation']) {
   const blocked=await guard(); if(blocked) return blocked;
   const previous = state.stages[stage];
   if(previous?.status==='completed') { if(digest(previous.result)!==previous.resultDigest) return stop('campaign_checkpoint_tampered'); continue; }
   // A deterministic consumer makes no paid call and gives the same answer twice, so a crash mid-stage is re-run; a paid stage parks.
   if(previous?.paid || (previous?.status==='running' && !consumer.deterministic)) return stop('campaign_stage_uncertain');
   const source = manifest.data.sources.find(row=>row.role===stage);
   if(!source) return stop('campaign_source_role_missing');
   if(stage==='confirmation') {
    if(!state.frozenPolicy || digest(state.frozenPolicy)!==state.frozenPolicyDigest) return stop('campaign_frozen_policy_tampered');
    if(!inputs.registration.statistics) return finish(stop('campaign_statistics_registration_missing'));
    const alpha=Object.values(inputs.registration.statistics?.claims ?? {}).reduce((a,b)=>a+(Number(b)||0),0);
    if(!checkpoint.reserveConfirmation) return stop('campaign_confirmation_ledger_unavailable');
    // Synthetic campaigns and rehearsals keep ledgers of their own: they must never spend a real quarter's alpha.
    const ledgerSurface=manifest.data.classification==='synthetic'?`synthetic:${manifest.surface}`:manifest.id.startsWith('rehearsal-')?`rehearsal:${manifest.surface}`:manifest.surface;
    const reservation=await checkpoint.reserveConfirmation({surface:ledgerSurface,quarter:rsiCampaignQuarter(now()),campaignId:manifest.id,alpha,corpusDigest:source.digest,at:now()});
    if(!reservation?.authorized) return finish(stop(reservation?.reason ?? 'campaign_confirmation_ledger_unavailable'));
    state.confirmationOpenedAt ??= now();
    state.confirmationLooks=1;
   }
   state.stages[stage]={id:`${manifest.id}:${stage}`,status:'running',paid:false}; await checkpoint.write(state);
   try {
    const run = stage==='development' ? consumer.develop(inputs.sources[source.id],inputs.registration) : consumer.confirm(inputs.sources[source.id],inputs.registration,state.frozenPolicy);
    state.stages[stage]={...state.stages[stage],status:'completed',result:run.result,resultDigest:digest(run.result),reason:run.reason ?? null};
    if(run.reason) return finish(stop(run.reason));
    if(stage==='development') {
     state.frozenPolicy={surface:manifest.surface,...consumer.freeze(run.frozen,inputs.registration),registrationDigest:manifest.registration.digest,developmentResultDigest:state.stages[stage].resultDigest};
     state.frozenPolicyDigest=digest(state.frozenPolicy);state.frozenAt=now();
    }
    await checkpoint.write(state);
   } catch {state.stages[stage]={...state.stages[stage],status:'failed',reason:'campaign_consumer_error'};return finish(stop('campaign_consumer_error'));}
  }
  if(state.evaluation && (digest(state.evaluation)!==state.evaluationDigest || digest(state.evaluatorReceipt)!==state.evaluatorReceiptDigest))return stop('campaign_evaluator_checkpoint_tampered');
  if(!state.evaluation) {
   const blocked=await guard(); if(blocked) return blocked;
   const request=evaluationRequest(manifest,inputs,state,binding);
   if(!attestEvaluation) { if(digest(state.evaluationRequest??null)!==digest(request)){state.evaluationRequest=request;await checkpoint.write(state);} return {status:'awaiting-evaluation',request,binding}; }
   const evaluation=await evaluateCampaignEvidence({manifest,inputs,state,request,attestEvaluation,now,statisticsPython,statisticsModulePath});
   // Only a verdict on the evidence is final. A missing or unbound receipt, or a statistics process that failed, is retried later.
   if(!evaluation.final) return {status:'awaiting-evaluation',request,binding,reason:evaluation.reason};
   delete evaluation.final;
   state.evaluation=evaluation;
   state.evaluatorReceipt={campaignId:manifest.id,binding,frozenPolicyDigest:state.frozenPolicyDigest,registrationDigest:manifest.registration.digest,target:manifest.target,sourceDigests:manifest.data.sources,decision:evaluation.decision,evaluationDigest:digest(evaluation),scope:evaluation.scope,automated:true};
   state.evaluationDigest=digest(evaluation);state.evaluatorReceiptDigest=digest(state.evaluatorReceipt);
   await checkpoint.write(state);
  }
  if(state.evaluation.expiresAt && Date.parse(now())>=Date.parse(state.evaluation.expiresAt))return stop('campaign_evaluator_receipt_expired');
  return {status:'completed',purpose:state.evaluation.scope==='registered-population-task-family'?'offline-evaluation':'lifecycle-diagnostic',releaseEligible:false,qualification:state.evaluation.decision,reason:state.evaluation.reason ?? null,binding,checkpoint:state,reportDigest:digest(state)};
 });
}
/** What the evaluator is asked to bind: the campaign, the frozen policy, the sealed corpus and the statistics registration. */
export function evaluationRequest(manifest, inputs, state, binding) {
 const confirmation=manifest.data.sources.find(row=>row.role==='confirmation');
 return {binding,frozenPolicyDigest:state.frozenPolicyDigest,corpusDigest:confirmation.digest,registrationDigest:digest(inputs.registration.statistics ?? null),
  confirmationResultDigest:state.stages.confirmation.resultDigest,confirmationOpenedAt:state.confirmationOpenedAt,look:state.confirmationLooks};
}
/** Fixed evaluator bridge. A failed process/invalid result is unknown, never a zero measurement. */
export async function evaluateStatistics(input, {timeoutMs=30000,pythonExecutable='python3',modulePath=undefined}={}) {
 const {spawn} = await import('node:child_process');
 let raw;try{raw=JSON.stringify(input);}catch{return {decision:'unknown',reason:'campaign_statistics_input_invalid'};}
 if(raw===undefined || Buffer.byteLength(raw)>16*1024*1024) return {decision:'unknown',reason:'campaign_statistics_input_invalid'};
 return new Promise(resolve=>{
  const child=spawn(pythonExecutable,[new URL('./profiles/statistics_driver.py',import.meta.url).pathname],{shell:false,env:{PATH:'/usr/local/bin:/usr/bin:/bin',...(modulePath?{PYTHONPATH:modulePath}:{})},stdio:['pipe','pipe','pipe']});
  let output='',done=false;
  const finish=result=>{if(done)return;done=true;clearTimeout(timer);resolve(result);};
  const timer=setTimeout(()=>{child.kill('SIGKILL');finish({decision:'unknown',reason:'campaign_statistics_timeout'});},Math.min(120000,Math.max(1,timeoutMs)));
  child.stdout.on('data',chunk=>{output+=chunk;if(output.length>2*1024*1024){child.kill('SIGKILL');finish({decision:'unknown',reason:'campaign_statistics_output_invalid'});}});
  child.stderr.resume();child.on('error',()=>finish({decision:'unknown',reason:'campaign_statistics_unavailable'}));
  child.stdin.on('error',()=>{});child.stdin.end(raw);
  child.on('close',code=>{
   try {const value=JSON.parse(output);if(code!==0 || value.inputSha256!==createHash('sha256').update(raw).digest('hex') || !VERDICTS.includes(value.result?.decision))throw new Error('invalid');finish({...value.result,inputDigest:digest(input),outputDigest:digest(value.result)});}
   catch {finish({decision:'unknown',reason:'campaign_statistics_failed'});}
  });
 });
}
/** The integrity facts the evaluator attests and the runner observed itself; the statistics see them only when both agree. */
const ATTESTED=['registration_digest','confirmation_exposed','look','complete_costs','cost_identity','expired_budget'];
/** Map the consumer's own confirmation measurements to the registered statistics; never caller-provided qualities. */
async function evaluateCampaignEvidence({manifest,inputs,state,request,attestEvaluation,now,statisticsPython,statisticsModulePath}) {
 const registration=inputs.registration.statistics;
 const retry=reason=>({final:false,reason});
 const verdict=(decision,reason,extra={})=>({final:true,decision,reason,scope:'undetermined',...extra});
 if(!registration) return verdict('not-qualified','campaign_statistics_registration_missing');
 // A deterministic consumer registers deterministicConsumer: true; a consumer of paid recorded runs registers false and repeats.
 const paid=consumers[manifest.surface].paidMeasurement===true;
 if(manifest.data.classification!=='synthetic' && (registration.mode!=='paired-t' || registration.deterministicConsumer!==!paid)) return verdict('not-qualified','campaign_statistical_consumer_not_qualified');
 const confirmation=state.stages.confirmation.result;
 const identity=await consumers[manifest.surface].identity();
 if(registration.consumer_id!==identity.implementationSha256 || registration.corpus_digest!==request.corpusDigest) return verdict('not-qualified','campaign_evaluation_consumer_or_corpus_changed');
 if(!Array.isArray(confirmation.observations)) return verdict('not-qualified','campaign_source_group_registration_invalid');
 let authority;try{authority=await attestEvaluation(request);}catch{return retry('campaign_evaluator_authority_unavailable');}
 if(!authority || Object.entries(request).some(([key,value])=>digest(authority[key] ?? null)!==digest(value ?? null))) return retry('campaign_evaluator_receipt_binding_changed');
 if(authority.costProvenance?.type!=='measured-normalized-cny' || !authority.costProvenance?.receiptId || authority.costProvenance?.complete!==true || !Array.isArray(authority.costs)) return retry('campaign_cost_provenance_unverified');
 const qualification=authority.receipt?.deterministic_qualification ?? null;
 const qualificationType=registration.mode==='deterministic'?'trusted-deterministic-finite-corpus':'trusted-deterministic-consumer';
 if((registration.mode==='deterministic' || registration.deterministicConsumer===true) && (!qualification||qualification.type!==qualificationType||qualification.externally_verified!==true||!qualification.qualification_id||qualification.consumer_id!==registration.consumer_id||qualification.corpus_digest!==registration.corpus_digest)) return retry('campaign_statistical_consumer_not_qualified');
 if(authority.observationDigest!==digest(confirmation.observations)) return verdict('not-qualified','campaign_evaluator_recomputation_differs');
 const attestations=authority.receipt?.attestations;
 const observed={registration_digest:digest(registration),confirmation_exposed:false,look:state.confirmationLooks,complete_costs:true,cost_identity:registration.cost_identity,expired_budget:Date.parse(now())>=Date.parse(registration.expires_at)};
 if(!attestations || ATTESTED.some(key=>digest(attestations[key] ?? null)!==digest(observed[key] ?? null))) return verdict('not-qualified','campaign_integrity_attestation_differs');
 if(Number.isFinite(inputs.registration.maxVolumeRatio) && !(confirmation.volumeRatio<=inputs.registration.maxVolumeRatio)) return verdict('not-qualified','campaign_volume_guard',{volumeRatio:confirmation.volumeRatio});
 const costs=new Map(authority.costs.map(row=>[`${row.group}\0${row.arm}\0${row.form}\0${row.repeat}`,row.cost]));
 if(costs.size!==confirmation.observations.length) return retry('campaign_cost_measurement_missing');
 const observations=[];
 for(const row of confirmation.observations) {
  const cost=costs.get(`${row.group}\0${row.arm}\0${row.form}\0${row.repeat}`);
  if(!Number.isFinite(cost) || cost<0) return retry('campaign_cost_measurement_missing');
  observations.push({...row,cost});
 }
 const receipt={...ATTESTED.reduce((all,key)=>({...all,[key]:attestations[key]}),{}),deterministic_qualification:qualification,now:now().replace(/Z$/, '+00:00')};
 const statisticsInput={registration,observations,receipt};
 const evaluated=await evaluateStatistics(statisticsInput,{pythonExecutable:statisticsPython,modulePath:statisticsModulePath});
 if(!VERDICTS.includes(evaluated.decision)) return retry(evaluated.reason ?? 'campaign_statistics_failed');
 const scope=manifest.data.classification==='synthetic'?'synthetic-finite-corpus-only':registration.mode==='paired-t'?'registered-population-task-family':'registered-finite-confirmation-corpus';
 return {final:true,...evaluated,statisticsInput,...(authority.expiresAt?{expiresAt:authority.expiresAt}:{}),observationDigest:digest(observations),costProvenance:authority.costProvenance,authorityReceiptDigest:digest(authority),...(confirmation.volumeRatio===undefined?{}:{volumeRatio:confirmation.volumeRatio}),scope};
}
/** The launcher reads this owner-controlled public trust profile. Signing keys are never accepted. */
export async function signedEvaluatorReceipt(profile, now=()=>new Date().toISOString()) {
 const {readFile}=await import('node:fs/promises');
 if(!profile || Object.keys(profile).some(key=>!['publicKeyPath','publicKeySha256','receiptPath'].includes(key)) || !/^[a-f0-9]{64}$/.test(profile.publicKeySha256 ?? ''))throw new Error('campaign_evaluator_profile_invalid');
 const key=createPublicKey(await readFile(profile.publicKeyPath));
 if(key.asymmetricKeyType!=='ed25519' || createHash('sha256').update(key.export({format:'der',type:'spki'})).digest('hex')!==profile.publicKeySha256)throw new Error('campaign_evaluator_key_untrusted');
 const raw=await readFile(profile.receiptPath);
 if(raw.length>2*1024*1024)throw new Error('campaign_evaluator_receipt_oversized');
 const envelope=JSON.parse(raw.toString());
 if(!envelope.payload || typeof envelope.signature!=='string' || !verify(null,Buffer.from(canonicalRsiJson(envelope.payload)),key,Buffer.from(envelope.signature,'base64')))throw new Error('campaign_evaluator_signature_invalid');
 const payload=envelope.payload;
 if(payload.type!=='rsi-evaluator-receipt-v1' || !Number.isFinite(Date.parse(payload.expiresAt)) || Date.parse(now())>=Date.parse(payload.expiresAt))throw new Error('campaign_evaluator_receipt_expired');
 return async request=>{
  if(Date.parse(now())>=Date.parse(payload.expiresAt))throw new Error('campaign_evaluator_receipt_expired');
  if(Object.entries(request).some(([key,value])=>digest(payload[key] ?? null)!==digest(value ?? null)))throw new Error('campaign_evaluator_receipt_binding_changed');
  return {...payload,signatureDigest:createHash('sha256').update(raw).digest('hex')};
 };
}
