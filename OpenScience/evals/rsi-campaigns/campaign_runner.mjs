/** Offline orchestration. Configuration/attestations are supplied by the lab owner, never a model. */
import { createHash } from 'node:crypto';
import { rsiCampaignIssues, rsiCampaignMonth } from '../../packages/domain/src/rsiCampaign.mjs';
import { rsiLabConfigurationIssues } from '../../apps/server/src/rsiLabConfiguration.mjs';
import { ProductDocuments } from '../../apps/server/src/productStore.mjs';
import { sweepFrontierThresholds } from './frontier_selection.mjs';
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stop = reason => ({status:'not-qualified',reason});
export function campaignPlan(manifest) { return {campaignId:manifest.id,automated:true,stages:['development','confirmation'],unsupported:manifest.surface !== 'frontier-selection'}; }
export async function labPreflight(configuration, attestLab) {
 const issues = rsiLabConfigurationIssues(configuration);
 if (issues.length) return stop(issues.includes('campaign_host_unavailable')?'campaign_host_unavailable':issues[0]);
 if (!attestLab) return stop('campaign_isolation_unverified');
 const actual = await attestLab();
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
 if (digest(inputs.registration) !== manifest.registration.digest) return 'campaign_registration_changed';
 for (const source of manifest.data.sources) if (!Object.hasOwn(inputs.sources ?? {},source.id) || digest(inputs.sources[source.id]) !== source.digest) return 'campaign_source_changed';
 if (digest(inputs.target) !== digest(manifest.target)) return 'campaign_target_changed';
 if (!Number.isFinite(inputs.registration?.baselineThreshold) || !Array.isArray(inputs.registration.thresholds) || !inputs.registration.thresholds.length || inputs.registration.thresholds.some(x=>!Number.isFinite(x))) return 'campaign_registration_invalid';
 return null;
}
/** Closed consumer registry: no executable paths, prompts, dynamic module imports or arbitrary callbacks in inputs. */
const consumers = Object.freeze({'frontier-selection':(pool, registration)=>sweepFrontierThresholds(pool,{baselineThreshold:registration.baselineThreshold,thresholds:registration.thresholds,labels:pool.labels ?? []})});
export async function runCampaign({manifest,inputs,configuration,store,attestLab,now=()=>new Date().toISOString(),signal}) {
 const preflight = await labPreflight(configuration,attestLab);
 if (preflight.status !== 'ready') return preflight;
 const issues = rsiCampaignIssues(manifest);
 if (issues.length) return stop(issues[0]);
 const invalid = validateInputs(manifest,inputs); if(invalid) return stop(invalid);
 if (!Object.hasOwn(consumers,manifest.surface)) return stop('campaign_consumer_not_qualified');
 const binding = digest({manifest,inputs});
 return store.withCampaign(manifest.id,async checkpoint=>{
  let state = await checkpoint.read();
  if(state && state.binding !== binding) return stop('campaign_checkpoint_input_changed');
  state ??= {recordType:'rsi-campaign-checkpoint',campaignId:manifest.id,binding,automated:true,stages:{},createdAt:now(),month:rsiCampaignMonth(now())};
  for(const stage of campaignPlan(manifest).stages) {
   if(signal?.aborted) return stop('campaign_cancelled');
   if(Date.parse(now()) >= Date.parse(manifest.deadline)) return stop('campaign_deadline_expired');
   if(rsiCampaignMonth(now()) !== state.month) return stop('campaign_budget_month_expired');
   const previous = state.stages[stage];
   if(previous?.status==='completed') { if(digest(previous.result)!==previous.resultDigest) return stop('campaign_checkpoint_tampered'); continue; }
   if(previous?.paid || previous?.status==='running') return stop('campaign_stage_uncertain');
   const source = manifest.data.sources.find(row=>row.role===stage);
   if(!source) return stop('campaign_source_role_missing');
   if(stage==='confirmation' && source.exposure!=='sealed' && manifest.data.classification!=='synthetic') return stop('campaign_confirmation_exposed');
   state.stages[stage]={id:`${manifest.id}:${stage}`,status:'running',paid:false}; await checkpoint.write(state);
   try {
    const result=consumers[manifest.surface](inputs.sources[source.id],inputs.registration);
    if(result.some(row=>!row.eligible || !row.protectionPassed)) {state.stages[stage]={...state.stages[stage],status:'failed',result,resultDigest:digest(result)};await checkpoint.write(state);return stop('campaign_consumer_failed');}
    state.stages[stage]={...state.stages[stage],status:'completed',result,resultDigest:digest(result)};await checkpoint.write(state);
   } catch(error) {state.stages[stage]={...state.stages[stage],status:'failed',reason:'campaign_consumer_error'};await checkpoint.write(state);return stop('campaign_consumer_error');}
  }
  return {status:'completed',qualification:'not-qualified',reason:manifest.data.classification==='synthetic'?'synthetic-lifecycle-only':'statistical-qualification-required',binding,checkpoint:state,reportDigest:digest(state)};
 });
}
/** Fixed evaluator bridge. A failed process/invalid result is unknown, never a zero measurement. */
export async function evaluateStatistics(input, {timeoutMs=30000}={}) {
 const {spawn} = await import('node:child_process');
 const raw=JSON.stringify(input);
 if(Buffer.byteLength(raw)>16*1024*1024) return {decision:'unknown',reason:'campaign_statistics_input_invalid'};
 return new Promise(resolve=>{
  const child=spawn('python3',[new URL('./profiles/statistics_driver.py',import.meta.url).pathname],{shell:false,env:{PATH:'/usr/local/bin:/usr/bin:/bin',PYTHONNOUSERSITE:'1'},stdio:['pipe','pipe','pipe']});
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
