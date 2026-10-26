/** Offline orchestration. Configuration/attestations are supplied by the lab owner, never a model. */
import { createHash,createPublicKey,verify } from 'node:crypto';
import { rsiCampaignIssues, rsiCampaignMonth } from '../../packages/domain/src/rsiCampaign.mjs';
import { rsiLabConfigurationIssues } from '../../apps/server/src/rsiLabConfiguration.mjs';
import { ProductDocuments } from '../../apps/server/src/productStore.mjs';
import { sweepFrontierThresholds, metrics } from './frontier_selection.mjs';
import {canonicalRsiJson,rsiDigest} from '../../apps/server/src/rsiCampaignBundle.mjs';
export const digest = rsiDigest;
const stop = reason => ({status:'not-qualified',reason});
export function campaignPlan(manifest) { return {campaignId:manifest.id,automated:true,stages:['development','confirmation'],unsupported:manifest.surface !== 'frontier-selection'}; }
export async function labPreflight(configuration, attestLab) {
 const issues = rsiLabConfigurationIssues(configuration);
 if (issues.length) return stop(issues.includes('campaign_host_unavailable')?'campaign_host_unavailable':issues[0]);
 if (!attestLab) return stop('campaign_isolation_unverified');
 let actual;try{actual=await attestLab();}catch{return stop('campaign_isolation_unverified');}
 if (actual.role !== configuration.authority.databaseRole || actual.database !== 'evimed_rsi_lab' || actual.hostInstanceId !== configuration.host.instanceId || actual.hostPurpose !== 'rsi-lab') return stop('campaign_isolation_unverified');
 return {status:'ready'};
}
/** Holds a session advisory lock across stage execution; CAS revision protects checkpoints as well. */
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
   return await operation({read:()=>row?.payload ?? null,write:async payload=>{row=await documents.put(owner,'knowledge',recordId,payload,{expectedRevision:row?.revision ?? 0});}});
  } finally { await client.query('SELECT pg_advisory_unlock(hashtext($1))',[key]); client.release(); }
 }};
}
function validateInputs(manifest, inputs) {
 if (!inputs || typeof inputs !== 'object' || !inputs.registration || !inputs.sources) return 'campaign_inputs_missing';
 if (digest(inputs.registration) !== manifest.registration.digest) return 'campaign_registration_changed';
 for (const source of manifest.data.sources) if (!Object.hasOwn(inputs.sources ?? {},source.id) || digest(inputs.sources[source.id]) !== source.digest) return 'campaign_source_changed';
 if (digest(inputs.target) !== digest(manifest.target)) return 'campaign_target_changed';
 if (!Number.isFinite(inputs.registration?.baselineThreshold) || !Array.isArray(inputs.registration.thresholds) || !inputs.registration.thresholds.length || inputs.registration.thresholds.some(x=>!Number.isFinite(x))) return 'campaign_registration_invalid';
 if(inputs.registration.selection?.objective !== 'precision-desc' || inputs.registration.selection?.tieBreak !== 'threshold-asc') return 'campaign_selection_registration_missing';
 const dev=manifest.data.sources.find(row=>row.role==='development'), confirm=manifest.data.sources.find(row=>row.role==='confirmation');
 if(!dev || !confirm || dev.id===confirm.id) return 'campaign_independent_sources_missing';
 if(manifest.data.classification!=='synthetic') {
  const roots=inputs.registration.sourceRoots;
  if(!roots || !Array.isArray(roots[dev.id]) || !roots[dev.id].length || !Array.isArray(roots[confirm.id]) || !roots[confirm.id].length) return 'campaign_source_roots_missing';
  if([dev,confirm].some(source=>(inputs.sources[source.id].rows ?? []).some(row=>!roots[source.id].includes(row.primary_source_id))))return 'campaign_source_roots_incomplete';
  if(roots[dev.id].some(root=>roots[confirm.id].includes(root)) || dev.digest===confirm.digest || confirm.exposure!=='sealed') return 'campaign_confirmation_not_independent';
  const devIds=new Set((inputs.sources[dev.id].rows ?? []).map(row=>String(row.id)));
  if((inputs.sources[confirm.id].rows ?? []).some(row=>devIds.has(String(row.id))))return 'campaign_confirmation_not_independent';
 }
 return null;
}
/** Closed consumer registry: no executable paths, prompts, dynamic module imports or arbitrary callbacks in inputs. */
const consumers = Object.freeze({'frontier-selection':(pool, registration)=>sweepFrontierThresholds(pool,{baselineThreshold:registration.baselineThreshold,thresholds:registration.thresholds,labels:pool.labels ?? []})});
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
 let invalid;try{invalid=validateInputs(manifest,inputs);}catch{return stop('campaign_inputs_invalid');}if(invalid)return stop(invalid);
 if (!Object.hasOwn(consumers,manifest.surface)) return stop('campaign_consumer_not_qualified');
 let binding;try{binding=digest({manifest,inputs});}catch{return stop('campaign_inputs_invalid');}
 return store.withCampaign(manifest.id,async checkpoint=>{
  let state = await checkpoint.read();
  if(state && state.binding !== binding) return stop('campaign_checkpoint_input_changed');
  state ??= {recordType:'rsi-campaign-checkpoint',campaignId:manifest.id,binding,automated:true,stages:{},createdAt:now(),month:rsiCampaignMonth(now())};
  for(const stage of campaignPlan(manifest).stages) {
   if(!await incidentCurrent())return stop('campaign_incident_not_current');
   if(signal?.aborted) return stop('campaign_cancelled');
   if(Date.parse(now()) >= Date.parse(manifest.deadline)) return stop('campaign_deadline_expired');
   if(rsiCampaignMonth(now()) !== state.month) return stop('campaign_budget_month_expired');
   const previous = state.stages[stage];
   if(previous?.status==='completed') { if(digest(previous.result)!==previous.resultDigest) return stop('campaign_checkpoint_tampered'); continue; }
   if(previous?.paid || previous?.status==='running') return stop('campaign_stage_uncertain');
   const source = manifest.data.sources.find(row=>row.role===stage);
   if(!source) return stop('campaign_source_role_missing');
   if(stage==='confirmation' && source.exposure!=='sealed' && manifest.data.classification!=='synthetic') return stop('campaign_confirmation_exposed');
   if(stage==='confirmation')state.confirmationOpenedAt=now();
   state.stages[stage]={id:`${manifest.id}:${stage}`,status:'running',paid:false}; await checkpoint.write(state);
   try {
    const thresholds=stage==='confirmation' ? [state.frozenPolicy?.threshold] : inputs.registration.thresholds;
    if(stage==='confirmation' && (!state.frozenPolicy || digest(state.frozenPolicy)!==state.frozenPolicyDigest))return stop('campaign_frozen_policy_tampered');
    const result=consumers[manifest.surface](inputs.sources[source.id],{...inputs.registration,thresholds});
    if(!result.length || stage==='confirmation' && result.some(row=>!row.eligible || !row.protectionPassed) || stage==='development' && !result.some(row=>row.eligible && row.protectionPassed)) {state.stages[stage]={...state.stages[stage],status:'failed',result,resultDigest:digest(result)};await checkpoint.write(state);return stop('campaign_consumer_failed');}
    state.stages[stage]={...state.stages[stage],status:'completed',result,resultDigest:digest(result)};
    if(stage==='development') {
     const eligible=result.filter(row=>row.eligible && row.protectionPassed && Number.isFinite(row.overall.precision));
     eligible.sort((a,b)=>b.overall.precision-a.overall.precision || a.threshold-b.threshold);
     if(!eligible.length)return stop('campaign_no_eligible_candidate');
     state.frozenPolicy={surface:manifest.surface,threshold:eligible[0].threshold,baselineThreshold:inputs.registration.baselineThreshold,registrationDigest:manifest.registration.digest,developmentResultDigest:state.stages[stage].resultDigest};
     state.frozenPolicyDigest=digest(state.frozenPolicy);state.frozenAt=now();
    }
    await checkpoint.write(state);
   } catch(error) {state.stages[stage]={...state.stages[stage],status:'failed',reason:'campaign_consumer_error'};await checkpoint.write(state);return stop('campaign_consumer_error');}
  }
  if(state.evaluation && (digest(state.evaluation)!==state.evaluationDigest || digest(state.evaluatorReceipt)!==state.evaluatorReceiptDigest))return stop('campaign_evaluator_checkpoint_tampered');
  if(state.evaluation?.expiresAt && Date.parse(now())>=Date.parse(state.evaluation.expiresAt))return stop('campaign_evaluator_receipt_expired');
  if(!state.evaluation) {
   if(!await incidentCurrent())return stop('campaign_incident_not_current');
   state.evaluation=await evaluateCampaignEvidence({manifest,inputs,state,binding,attestEvaluation,now,statisticsPython,statisticsModulePath});
   state.evaluatorReceipt={campaignId:manifest.id,binding,frozenPolicyDigest:state.frozenPolicyDigest,registrationDigest:manifest.registration.digest,target:manifest.target,sourceDigests:manifest.data.sources,decision:state.evaluation.decision,evaluationDigest:digest(state.evaluation),scope:state.evaluation.evidenceScope??'undetermined',automated:true};
   state.evaluationDigest=digest(state.evaluation);state.evaluatorReceiptDigest=digest(state.evaluatorReceipt);
   await checkpoint.write(state);
  }
  return {status:'completed',purpose:state.evaluation.evidenceScope==='finite-corpus-diagnostic'?'lifecycle-diagnostic':'offline-evaluation',releaseEligible:false,qualification:state.evaluation.decision,reason:state.evaluation.reason ?? null,binding,checkpoint:state,reportDigest:digest(state)};
 });
}
/** Fixed evaluator bridge. A failed process/invalid result is unknown, never a zero measurement. */
export async function evaluateStatistics(input, {timeoutMs=30000,pythonExecutable='python3',modulePath=undefined}={}) {
 const {spawn} = await import('node:child_process');
 const raw=JSON.stringify(input);
 if(Buffer.byteLength(raw)>16*1024*1024) return {decision:'unknown',reason:'campaign_statistics_input_invalid'};
 return new Promise(resolve=>{
  const child=spawn(pythonExecutable,[new URL('./profiles/statistics_driver.py',import.meta.url).pathname],{shell:false,env:{PATH:'/usr/local/bin:/usr/bin:/bin',...(modulePath?{PYTHONPATH:modulePath}:{})},stdio:['pipe','pipe','pipe']});
  let output='',done=false;
  const finish=result=>{if(done)return;done=true;clearTimeout(timer);resolve(result);};
  const timer=setTimeout(()=>{child.kill('SIGKILL');finish({decision:'unknown',reason:'campaign_statistics_timeout'});},Math.min(120000,Math.max(1,timeoutMs)));
  child.stdout.on('data',chunk=>{output+=chunk;if(output.length>2*1024*1024){child.kill('SIGKILL');finish({decision:'unknown',reason:'campaign_statistics_output_invalid'});}});
  child.stderr.resume();child.on('error',()=>finish({decision:'unknown',reason:'campaign_statistics_unavailable'}));
  child.stdin.on('error',()=>{});child.stdin.end(raw);
  child.on('close',code=>{
   try {const value=JSON.parse(output);if(code!==0 || value.inputSha256!==createHash('sha256').update(raw).digest('hex') || !['qualified','not-qualified','inconclusive'].includes(value.result?.decision))throw new Error('invalid');finish({...value.result,inputDigest:digest(input),outputDigest:digest(value.result)});}
   catch {finish({decision:'unknown',reason:'campaign_statistics_failed'});}
  });
 });
}
/** Map actual confirmation selections to registered source-group accuracy, never caller-provided qualities. */
async function evaluateCampaignEvidence({manifest,inputs,state,binding,attestEvaluation,now,statisticsPython,statisticsModulePath}) {
 const registration=inputs.registration.statistics;
 const unavailable=reason=>({decision:'not-qualified',reason});
 if(!registration || !attestEvaluation)return unavailable('campaign_measured_cost_and_evaluator_receipt_required');
 const confirmation=manifest.data.sources.find(row=>row.role==='confirmation');
 const pool=inputs.sources[confirmation.id], result=state.stages.confirmation.result[0];
 if(registration.consumer_id!==result.receipt.consumer.implementationSha256 || registration.corpus_digest!==digest(pool))return unavailable('campaign_evaluation_consumer_or_corpus_changed');
 const request={binding,frozenPolicyDigest:state.frozenPolicyDigest,corpusDigest:digest(pool),registrationDigest:digest(registration)};
 let authority;try{authority=await attestEvaluation(request);}catch{return unavailable('campaign_evaluator_authority_unavailable');}
 if(!authority || Object.entries(request).some(([key,value])=>authority[key]!==value) || authority.costProvenance?.type!=='measured-normalized-cny' || !authority.costProvenance?.receiptId || authority.costProvenance?.complete!==true || !Array.isArray(authority.costs))return unavailable('campaign_cost_provenance_unverified');
 if(registration.mode!=='deterministic' && !(registration.mode==='paired-t' && registration.deterministicConsumer===true))return unavailable('campaign_statistical_consumer_not_qualified');
 const qualification=authority.receipt?.deterministic_qualification;
 const qualificationType=registration.mode==='deterministic'?'trusted-deterministic-finite-corpus':'trusted-deterministic-consumer';
 if(!qualification||qualification.type!==qualificationType||qualification.externally_verified!==true||!qualification.qualification_id||qualification.consumer_id!==registration.consumer_id||qualification.corpus_digest!==registration.corpus_digest)return unavailable('campaign_statistical_consumer_not_qualified');
 if(!Array.isArray(registration.groups) || !registration.groups.length || !registration.families)return unavailable('campaign_source_group_registration_missing');
 const labels=new Map((pool.labels ?? []).map(row=>[String(row.id),row.label?.worth]));
 const allIds=new Set((pool.rows ?? []).map(row=>String(row.id))), seen=new Set(), roots=new Set(), observations=[];
 for(const group of registration.groups) {
  const family=registration.families[group.family];
  if(!family || family.repeats!==1 || JSON.stringify(family.forms)!==JSON.stringify({original:1}) || !Array.isArray(group.rowIds) || !group.rowIds.length || typeof group.sourceRoot!=='string' || roots.has(group.sourceRoot))return unavailable('campaign_source_group_registration_invalid');
  roots.add(group.sourceRoot);
  for(const id of group.rowIds) {if(!allIds.has(String(id)) || seen.has(String(id)) || !['pick','ok','no'].includes(labels.get(String(id))) || pool.rows.find(row=>String(row.id)===String(id))?.primary_source_id!==group.sourceRoot)return unavailable('campaign_source_group_overlap_or_labels_missing');seen.add(String(id));}
  for(const arm of ['baseline','candidate']) {
   const selected=new Set(arm==='baseline'?result.receipt.baselineSelectedIds:result.selectedIds);
   const quality=group.rowIds.filter(id=>selected.has(String(id))===(labels.get(String(id))==='pick')).length/group.rowIds.length;
   const costRows=authority.costs.filter(row=>row.group===group.id && row.arm===arm && row.form==='original' && row.repeat===0);
   if(costRows.length!==1 || !Number.isFinite(costRows[0].cost) || costRows[0].cost<0)return unavailable('campaign_cost_measurement_missing');
   observations.push({group:group.id,arm,form:'original',repeat:0,quality,cost:costRows[0].cost,critical_violations:result.lostProtectedIds.length,status:'measured'});
  }
 }
 if(seen.size!==allIds.size || authority.costs.length!==observations.length)return unavailable('campaign_corpus_or_cost_coverage_incomplete');
 const receipt={...authority.receipt,registration_digest:'bound-by-runner',confirmation_exposed:false,look:1,complete_costs:true,cost_identity:registration.cost_identity,expired_budget:false,now:now().replace(/Z$/, '+00:00')};
 const statisticsInput={registration,observations,receipt};
 const evaluated=await evaluateStatistics(statisticsInput,{pythonExecutable:statisticsPython,modulePath:statisticsModulePath});
 return {...evaluated,statisticsInput,...(authority.expiresAt?{expiresAt:authority.expiresAt}:{}),observationDigest:digest(observations),costProvenance:authority.costProvenance,authorityReceiptDigest:digest(authority),scope:registration.mode==='paired-t'?'registered-population-task-family':manifest.data.classification==='synthetic'?'synthetic-finite-corpus-only':'registered-finite-confirmation-corpus'};
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
  if(Date.parse(now())>=Date.parse(payload.expiresAt) || Object.entries(request).some(([key,value])=>payload[key]!==value))throw new Error('campaign_evaluator_receipt_binding_changed');
  return {...payload,signatureDigest:createHash('sha256').update(raw).digest('hex')};
 };
}
