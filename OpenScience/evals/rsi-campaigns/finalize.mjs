/** Offline trusted CI boundary. No model flags confer evaluation authority. */
import {createHash,createPublicKey,KeyObject,verify} from 'node:crypto';
import {readFile,open,constants,writeFile} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {canonicalRsiJson,rsiDigest,signRsiCampaignBundle} from '../../apps/server/src/rsiCampaignBundle.mjs';
import {readRsiDeploymentRecord} from '../../apps/server/src/rsiDeploymentAuthority.mjs';
import {rsiCampaignIssues,rsiCompatibilityIssues} from '../../packages/domain/src/rsiCampaign.mjs';
import {evaluateStatistics} from './campaign_runner.mjs';
import {computeRsiDependencyClosure} from '../../apps/server/src/rsiDependencyClosure.mjs';
import {createCampaignSigner} from './signing.mjs';
const fail=reason=>{throw new Error(reason);};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function consumerClosure(root, paths) {
 if(!Array.isArray(paths)||!paths.length||new Set(paths).size!==paths.length)fail('campaign_consumer_closure_invalid');
 const rows=[];
 for(const path of [...paths].sort()) {
  const full=resolve(root,path), rel=relative(resolve(root),full);
  if(isAbsolute(path)||rel.startsWith('..')||!rel||path!==rel)fail('campaign_consumer_closure_invalid');
  const handle=await open(full,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {const st=await handle.stat();if(!st.isFile()||st.size>4*1024*1024)fail('campaign_consumer_closure_invalid');rows.push({path,sha256:sha(await handle.readFile())});}finally{await handle.close();}
 }
 return rsiDigest(rows);
}
/** Authority must be pinned by owner configuration, outside the candidate input. */
export function authenticateEvaluation(envelope, profile, now) {
 try {
  const key=createPublicKey(profile.publicKey);
  if(key.asymmetricKeyType!=='ed25519'||sha(key.export({type:'spki',format:'der'}))!==profile.publicKeySha256 || !verify(null,Buffer.from(`evimed-rsi-evaluation-input-v1\n${canonicalRsiJson(envelope.payload)}`),key,Buffer.from(envelope.signature,'base64')))fail('bad');
  const p=envelope.payload;
  if(p.type!=='rsi-finalizer-evidence-v1'||Date.parse(p.expiresAt)<=Date.parse(now)||!Number.isFinite(Date.parse(p.expiresAt)))fail('bad');
  return p;
 }catch{fail('campaign_evaluator_authority_untrusted');}
}
export async function finalizeCampaign({completed,manifest,inputs,files,evidenceEnvelope,profile,currentTarget,root,closurePaths,bundleId,expiresAt,now=new Date().toISOString(),publisher,evaluator,incidentTransport,purpose='production',statisticsPython='python3',closureSettings={},closurePins={},closureRegistry,statisticsModulePath,loadSigners}) {
 const incident=async()=>{if(manifest.data.classification==='authorized-incident'){if(!incidentTransport)fail('campaign_incident_authority_unavailable');await incidentTransport.assertIncidentCurrent(manifest.data.authorization);}};
 await incident();
 if(rsiCampaignIssues(manifest).length||completed.status!=='completed'||rsiCompatibilityIssues(manifest.target,currentTarget).length)fail('campaign_finalization_input_invalid');
 const state=completed.checkpoint,binding=rsiDigest({manifest,inputs});
 if(completed.binding!==binding||state.binding!==binding||completed.reportDigest!==rsiDigest(state)||state.campaignId!==manifest.id||rsiDigest(inputs.registration)!==manifest.registration.digest)fail('campaign_checkpoint_changed');
 if(Date.parse(now)>=Date.parse(manifest.deadline)||!Number.isFinite(Date.parse(now))||!Number.isFinite(Date.parse(expiresAt))||Date.parse(expiresAt)<=Date.parse(now)||Date.parse(expiresAt)>Date.parse(manifest.deadline))fail('campaign_bundle_expired');
 for(const stage of ['development','confirmation'])if(state.stages[stage]?.status!=='completed'||rsiDigest(state.stages[stage].result)!==state.stages[stage].resultDigest)fail('campaign_stage_uncertain');
 if(!state.frozenPolicy||rsiDigest(state.frozenPolicy)!==state.frozenPolicyDigest||!Number.isFinite(Date.parse(state.frozenAt))||Date.parse(state.frozenAt)<Date.parse(manifest.createdAt)||Date.parse(state.frozenAt)>Date.parse(now)||state.frozenPolicy.registrationDigest!==manifest.registration.digest||state.frozenPolicy.developmentResultDigest!==state.stages.development.resultDigest)fail('campaign_frozen_policy_changed');
 const sourceRows=manifest.data.sources;
 for(const s of sourceRows)if(rsiDigest(inputs.sources[s.id])!==s.digest)fail('campaign_source_changed');
 const dev=sourceRows.find(s=>s.role==='development'),confirmation=sourceRows.find(s=>s.role==='confirmation');
 if(!dev||!confirmation||dev.id===confirmation.id||confirmation.exposure!=='sealed'||dev.digest===confirmation.digest)fail('campaign_confirmation_not_independent');
 const evidence=authenticateEvaluation(evidenceEnvelope,profile,now);
 if(evidence.confirmationOpenedAt!==state.confirmationOpenedAt)fail('campaign_confirmation_time_changed');
 const candidateDigest=rsiDigest([...files].sort((a,b)=>a.path.localeCompare(b.path,'en')));
 const closure=await computeRsiDependencyClosure({rootDir:root,surface:manifest.surface,settings:closureSettings,pins:closurePins,...(closureRegistry?{registry:closureRegistry}:{})});
 const consumerDigest=closure.dependencyDigest;
 if(!closure.qualified||consumerDigest!==currentTarget.dependencyDigest)fail('campaign_consumer_changed');
 if(manifest.surface!=='frontier-selection'||files.length!==1||files[0].path!=='policy.json'||files[0].content!==canonicalRsiJson({selectionThreshold:state.frozenPolicy.threshold}))fail('campaign_frozen_candidate_changed');
 const expected={binding,candidateDigest,frozenPolicyDigest:state.frozenPolicyDigest,registrationDigest:manifest.registration.digest,datasetDigest:rsiDigest(inputs.sources),consumerDigest,corpusDigest:confirmation.digest};
 if(Object.entries(expected).some(([k,v])=>evidence[k]!==v)||Date.parse(evidence.confirmationOpenedAt)<=Date.parse(state.frozenAt)||!Number.isFinite(Date.parse(evidence.confirmationOpenedAt))||Date.parse(evidence.confirmationOpenedAt)>Date.parse(now))fail('campaign_evidence_binding_changed');
 // A production bundle never comes from synthetic data, and its confirmation days follow development's with no shared row.
 if(manifest.data.classification==='synthetic')fail('campaign_evidence_scope_not_release_eligible');
 const devSource=inputs.sources[dev.id],confirmSource=inputs.sources[confirmation.id];
 const devDays=(devSource?.days??[]).map(d=>d.day),confirmDays=(confirmSource?.days??[]).map(d=>d.day);
 if(!devDays.length||!confirmDays.length||devDays.some(d=>confirmDays.includes(d))||[...devDays].sort().at(-1)>=[...confirmDays].sort()[0])fail('campaign_confirmation_not_independent');
 const devIds=new Set(devSource.days.flatMap(d=>d.rows.map(r=>String(r.id))));
 if(confirmSource.days.some(d=>d.rows.some(r=>devIds.has(String(r.id)))))fail('campaign_confirmation_not_independent');
 const consumerProof=evidence.consumerProof;
 if(!consumerProof||consumerProof.executed!==true||consumerProof.consumerDigest!==consumerDigest||consumerProof.candidateDigest!==candidateDigest||consumerProof.baselineRevision!==currentTarget.baselineRevision||consumerProof.corpusDigest!==confirmation.digest||consumerProof.resultDigest!==state.stages.confirmation.resultDigest)fail('campaign_consumer_proof_untrusted');
 const q=evidence.qualification, statistics=evidence.statistics;
 if(!state.evaluation?.statisticsInput || rsiDigest(statistics)!==rsiDigest(state.evaluation.statisticsInput) || rsiDigest(statistics.observations)!==state.evaluation.observationDigest)fail('campaign_measured_evidence_changed');
 const groupProof=evidence.sourceGroupProof;
 if(!Array.isArray(groupProof)||groupProof.length!==statistics?.registration?.groups?.length||new Set(groupProof.map(g=>g.day)).size!==groupProof.length||new Set(groupProof.map(g=>g.id)).size!==groupProof.length||groupProof.some(g=>g.exposure!=='sealed'||!confirmDays.includes(g.day)||!statistics.registration.groups.some(row=>row.id===g.id&&row.day===g.day)))fail('campaign_source_group_proof_invalid');
 if(!q||q.status!=='qualified'||!profile.qualificationDigests?.includes(rsiDigest(q))||!q.claims?.includes(manifest.claim)||q.consumerDigest!==consumerDigest||q.procedureDigest!==rsiDigest(statistics.registration.procedure)||!profile.procedureDigests?.includes(q.procedureDigest)||(!Number.isFinite(Date.parse(q.expiresAt))||Date.parse(q.expiresAt)<=Date.parse(now)))fail('campaign_procedure_not_qualified');
 if(purpose!=='production'||q.testOnly===true||q.evidenceScope!=='population-task-family')fail('campaign_evidence_scope_not_release_eligible');
 if(rsiDigest(statistics.registration)!==rsiDigest(inputs.registration.statistics)||statistics.receipt.confirmation_exposed!==false||statistics.receipt.look!==1||!Object.hasOwn(statistics.registration.claims,manifest.claim)||manifest.registration.procedure!==statistics.registration.procedure.id)fail('campaign_statistics_binding_changed');
 // The evaluator's own attested digest is re-checked by the statistics; it is never filled in here.
 const evaluated=await evaluateStatistics({...statistics,receipt:{...statistics.receipt,now:now.replace(/Z$/,'+00:00')}},{pythonExecutable:statisticsPython,modulePath:statisticsModulePath});
 if(evaluated.registration_digest!==rsiDigest(statistics.registration))fail('campaign_statistics_digest_mismatch');
 if(evaluated.decision!=='qualified'||evaluated.evidenceScope!=='population-task-family')fail('campaign_statistics_not_qualified');
 if(loadSigners)({publisher,evaluator}=await loadSigners());
 if(!publisher||!evaluator||publisher.keyId===evaluator.keyId||(publisher.publicKey instanceof KeyObject?publisher.publicKey:createPublicKey(publisher.publicKey)).export({type:'spki',format:'der'}).equals((evaluator.publicKey instanceof KeyObject?evaluator.publicKey:createPublicKey(evaluator.publicKey)).export({type:'spki',format:'der'})))fail('campaign_evaluator_not_independent');
 const verdict={status:'qualified',scope:manifest.surface,...Object.fromEntries(Object.entries(expected).filter(([k])=>!['binding','frozenPolicyDigest'].includes(k))),measurementDigest:rsiDigest(statistics),evaluatorDigest:rsiDigest(profile),procedureDigest:q.procedureDigest,qualificationDigest:rsiDigest(q)};
 const published={id:bundleId,campaignId:manifest.id,surface:manifest.surface,kind:manifest.candidateKind,target:currentTarget,createdAt:now,expiresAt,verdict};
 await incident();
 const finalClosure=await computeRsiDependencyClosure({rootDir:root,surface:manifest.surface,settings:closureSettings,pins:closurePins,...(closureRegistry?{registry:closureRegistry}:{})});
 if(!finalClosure.qualified||finalClosure.dependencyDigest!==consumerDigest)fail('campaign_consumer_changed');
 const receiptPayload=canonicalRsiJson({schemaVersion:1,bundleId,campaignId:manifest.id,...verdict});
 const evaluatorReceipt={keyId:evaluator.keyId,payload:receiptPayload,signature:Buffer.from(await evaluator.sign(Buffer.from(`evimed-rsi-evaluator-v1\n${evaluator.keyId}\n${receiptPayload}`))).toString('base64')};
 await incident();
 return {...await signRsiCampaignBundle({manifest:published,files,keyId:publisher.keyId,signer:publisher.sign}),evaluatorReceipt};
}
export async function finalizeCli(configPath) {
 const c=await readRsiDeploymentRecord(configPath);
 if(!configPath?.startsWith('/run/rsi-lab/')||c.profileRef&&!c.profileRef.startsWith('/run/rsi-lab/'))fail('campaign_owner_mount_required');
 // Explicit owner configuration only; no environment-selected credential chain or executable adapters.
 if(c.purpose!=='production'||[c.publisher,c.evaluator].some(signer=>signer?.provider!=='file'&&!signer?.credentialRef))fail('campaign_signer_unavailable');
 const input=JSON.parse(await readFile(c.inputPath,'utf8'));
 const profile=await readRsiDeploymentRecord(c.profileRef);
 if(profile.testOnly===true)fail('campaign_evidence_scope_not_release_eligible');
 const loadSigners=async()=>({publisher:await createCampaignSigner(c.publisher),evaluator:await createCampaignSigner(c.evaluator)});
 let incidentTransport;
 if(input.manifest.data.classification==='authorized-incident') {const {createRsiOssTransport}=await import('../../apps/server/src/rsiOssTransport.mjs');incidentTransport=await createRsiOssTransport(c.transport);}
 // A lab without a production channel declares `currentTarget: "manifest"`: the bundle carries the campaign's target and the
 // production importer makes the compare-and-swap against what it serves at import time.
 const currentTarget=c.currentTarget==='manifest'?input.manifest?.target:c.currentTarget;
 const envelope=await finalizeCampaign({...input,profile,currentTarget,root:c.consumerRoot,closurePaths:c.closurePaths,loadSigners,incidentTransport,statisticsPython:c.statisticsPython??'python3',closureSettings:c.closureSettings??{},closurePins:c.closurePins??{},statisticsModulePath:c.statisticsModulePath});
 await writeFile(c.outputPath,`${JSON.stringify(envelope)}\n`,{flag:'wx',mode:0o600});
 return {status:'signed',bundleDigest:rsiDigest(envelope)};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
 try{console.log(JSON.stringify(await finalizeCli(process.argv[2])));}catch(error){console.error(JSON.stringify({status:'refused',reason:/^campaign_[a-z_]+$/.test(error.message)?error.message:'campaign_finalization_failed'}));process.exitCode=1;}
}
