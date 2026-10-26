import test from 'node:test';
import assert from 'node:assert/strict';
import { runCampaign } from '../campaign_runner.mjs';
test('unbound runner performs no checkpoint or consumer effects', async () => {
 let touched = false;
 const result = await runCampaign({ configuration: {}, store: {withCampaign(){touched=true;}}, manifest: {} });
 assert.equal(result.reason, 'campaign_host_unavailable'); assert.equal(touched,false);
});
import { digest } from '../campaign_runner.mjs';
const configuration={host:{provider:'alibaba',purpose:'rsi-lab',instanceId:'i-lab',region:'cn-shanghai'},transport:{endpoint:'https://oss-cn-shanghai.aliyuncs.com',region:'cn-shanghai',incidentBucket:'lab-input',bundleBucket:'lab-output'},signer:{keyId:'kms-lab',publicKeySha256:'a'.repeat(64)},authority:{role:'rsi-lab',accountId:'lab-test',dataDir:'/srv/rsi-lab',databaseRole:'rsi_lab'},budget:{campaignCny:1000,monthCny:30000},providers:{deepseekFlash:{provider:'deepseek',model:'deepseek-flash',credentialRef:'lab:deepseek'},qwenMax:{provider:'dashscope',model:'qwen3.8-max',credentialRef:'lab:qwen'}}};
function fixture() {
 const registration={baselineThreshold:85,thresholds:[85]};
 const pool={complete:true,day:'2026-10-25',window:{start:'2026-10-25T00:00:00Z',end:'2026-10-26T00:00:00Z'},rows:[],events:{},genreFloors:{},congressActive:false,preprintPlaces:2,preprintMinScore:80,scoreVersion:'current',labels:[]};
 const target={surface:'frontier-selection',dependencyDigest:'a'.repeat(64),baselineRevision:'baseline'};
 const manifest={schemaVersion:1,id:'fixture',surface:'frontier-selection',candidateKind:'policy',claim:'efficiency',automated:true,createdAt:'2026-10-26T00:00:00Z',deadline:'2026-10-27T00:00:00Z',budget:{campaignCny:1000,monthCny:30000},models:Object.fromEntries(['solver','improver','reviewer'].map(x=>[x,{provider:'deepseek',model:'deepseek-flash'}])),target,registration:{digest:digest(registration),procedure:'frontier-v1',claim:'efficiency'},data:{classification:'synthetic',sources:['development','confirmation'].map(role=>({id:role,digest:digest(pool),role,exposure:'synthetic'}))}};
 let state=null,writes=0;
 return {...benignCampaignFixture(),configuration,attestLab:async()=>({role:'rsi_lab',database:'evimed_rsi_lab',hostInstanceId:'i-lab',hostPurpose:'rsi-lab'}),now:()=> '2026-10-26T01:00:00Z',store:{withCampaign:async(id,fn)=>fn({read:()=>structuredClone(state),write:async x=>{state=structuredClone(x);writes++;}})},state:()=>state,writes:()=>writes};
}
test('synthetic lifecycle completes actual consumer stages and resumes without execution',async()=>{const f=fixture();const first=await runCampaign(f);assert.equal(first.status,'completed');assert.equal(first.qualification,'not-qualified');assert.equal(first.checkpoint.automated,true);const writes=f.writes();assert.deepEqual(await runCampaign(f),first);assert.equal(f.writes(),writes);});
test('changed input is refused before resume',async()=>{const f=fixture();await runCampaign(f);f.inputs.registration.thresholds=[90];assert.equal((await runCampaign(f)).reason,'campaign_registration_changed');});
test('producer tampering and uncertain stage park',async()=>{for(const uncertain of [false,true]){const f=fixture();await runCampaign(f);const stage=f.state().stages.development;if(uncertain)stage.status='running';else stage.result=[];assert.equal((await runCampaign(f)).reason,uncertain?'campaign_stage_uncertain':'campaign_checkpoint_tampered');}});
test('deadline, cancellation and isolation are explicit non-completions',async()=>{const f=fixture();assert.equal((await runCampaign({...f,signal:{aborted:true}})).reason,'campaign_cancelled');assert.equal((await runCampaign({...f,now:()=> '2026-10-28T00:00:00Z'})).reason,'campaign_deadline_expired');assert.equal((await runCampaign({...f,attestLab:async()=>({})})).reason,'campaign_isolation_unverified');});
test('incomplete consumer cannot complete campaign',async()=>{const f=fixture();f.inputs.sources.development.complete=false;f.manifest.data.sources[0].digest=digest(f.inputs.sources.development);assert.equal((await runCampaign(f)).reason,'campaign_consumer_failed');assert.equal(f.state().stages.development.status,'failed');});
import {benignCampaignFixture} from '../profiles/benign_fixture.mjs';
test('nonempty independent benign pools execute through same orchestrator',async()=>{const f=fixture();Object.assign(f,benignCampaignFixture());const result=await runCampaign(f);assert.equal(result.status,'completed');assert.equal(result.checkpoint.stages.development.result[0].overall.count,1);assert.deepEqual(result.checkpoint.stages.confirmation.result[0].selectedIds,['synthetic-confirm']);});
import {evaluateStatistics} from '../campaign_runner.mjs';
test('statistics subprocess errors are unknown measurements',async()=>{const result=await evaluateStatistics({});assert.equal(result.decision,'unknown');assert.ok(!Object.hasOwn(result,'quality'));});
test('development rejects bad candidate but freezes one preregistered winner before confirmation',async()=>{const f=fixture();Object.assign(f,benignCampaignFixture());f.inputs.registration.thresholds=[85,100];f.inputs.registration.selection={objective:'precision-desc',tieBreak:'threshold-asc'};f.manifest.registration.digest=digest(f.inputs.registration);const result=await runCampaign(f);assert.equal(result.status,'completed');assert.equal(result.checkpoint.frozenPolicy.threshold,85);assert.equal(result.checkpoint.stages.confirmation.result.length,1);});
import {frontierConsumerIdentity} from '../frontier_selection.mjs';
test('actual finite-corpus observations reach fixed statistics with trusted cost receipts',async()=>{
 const f=fixture();f.statisticsPython=process.env.RSI_TEST_PYTHON;f.statisticsModulePath=new URL('../../../../.evimed-local/toolchains/rsi-python',import.meta.url).pathname;const corpus=f.inputs.sources.confirmation;
 const registration={procedure:{id:'rsi-paired-source-v3',digest_codec:'rfc8785-sha256-v1',test_alpha_fraction:.5,minimum_slice_groups:30},version:1,paid_cost_budget:1000,consumer_id:(await frontierConsumerIdentity()).implementationSha256,corpus_digest:digest(corpus),mode:'deterministic',groups:[{id:'g',family:'frontier',failure_slice:true,rowIds:['synthetic-confirm'],sourceRoot:'synthetic-synthetic-confirm'}],G_target:1,claims:{efficiency:.05},expires_at:'2026-10-27T00:00:00+00:00',cost_identity:'owner-metered-total-normalized-cny',families:{frontier:{margin:.03,repeats:1,score_type:'bounded-continuous',pilot_rationale:'Benign finite synthetic fixture only',forms:{original:1}}}};
 f.inputs.registration.statistics=registration;f.manifest.registration.digest=digest(f.inputs.registration);
 f.attestEvaluation=async request=>({...request,costProvenance:{type:'measured-normalized-cny',receiptId:'local-test-measurement',complete:true},costs:['baseline','candidate'].map(arm=>({group:'g',arm,form:'original',repeat:0,cost:arm==='baseline'?1:.7})),receipt:{deterministic_qualification:{type:'trusted-deterministic-finite-corpus',qualification_id:'local-test-only',externally_verified:true,consumer_id:registration.consumer_id,corpus_digest:registration.corpus_digest}}});
 const result=await runCampaign(f);assert.equal(result.qualification,'qualified',JSON.stringify(result.checkpoint.evaluation));assert.equal(result.checkpoint.evaluation.scope,'synthetic-finite-corpus-only');assert.equal(result.checkpoint.evaluatorReceipt.frozenPolicyDigest,result.checkpoint.frozenPolicyDigest);
});
test('exposed or overlapping real confirmation roots refuse before consumer',async()=>{for(const exposed of [false,true]){const f=fixture();f.manifest.data.classification='public';f.manifest.data.sources[1].exposure=exposed?'exposed':'sealed';f.inputs.registration.sourceRoots={development:['synthetic-synthetic-dev','same'],confirmation:['synthetic-synthetic-confirm','same']};f.manifest.registration.digest=digest(f.inputs.registration);assert.equal((await runCampaign(f)).reason,'campaign_confirmation_not_independent');}});
test('malformed input returns actionable unqualified outcome',async()=>{const f=fixture();f.inputs=null;assert.equal((await runCampaign(f)).reason,'campaign_inputs_missing');});
import {signedEvaluatorReceipt} from '../campaign_runner.mjs';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {canonicalRsiJson} from '../../../apps/server/src/rsiCampaignBundle.mjs';
test('owner public-key profile verifies signed bound evaluator receipts and rejects tampering',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rsi-signed-test-'));const {publicKey,privateKey}=generateKeyPairSync('ed25519');
 const request={binding:'b',frozenPolicyDigest:'f',corpusDigest:'c',registrationDigest:'r'};
 const payload={...request,type:'rsi-evaluator-receipt-v1',expiresAt:'2026-10-27T00:00:00Z',scope:'synthetic-lifecycle-only'};
 const envelope={payload,signature:sign(null,Buffer.from(canonicalRsiJson(payload)),privateKey).toString('base64')};
 const profile={publicKeyPath:join(dir,'public.pem'),receiptPath:join(dir,'receipt.json'),publicKeySha256:createHash('sha256').update(publicKey.export({format:'der',type:'spki'})).digest('hex')};
 try {await writeFile(profile.publicKeyPath,publicKey.export({format:'pem',type:'spki'}));await writeFile(profile.receiptPath,JSON.stringify(envelope));const attest=await signedEvaluatorReceipt(profile,()=> '2026-10-26T00:00:00Z');assert.equal((await attest(request)).scope,'synthetic-lifecycle-only');await assert.rejects(attest({...request,binding:'changed'}));envelope.payload.corpusDigest='tampered';await writeFile(profile.receiptPath,JSON.stringify(envelope));await assert.rejects(signedEvaluatorReceipt(profile,()=> '2026-10-26T00:00:00Z'));}finally{await rm(dir,{recursive:true,force:true});}
});
