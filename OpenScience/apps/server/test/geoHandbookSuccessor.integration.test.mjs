import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { methodContentDigest } from '@evimed/domain';
import {GeoSharedContext} from '../src/geoSharedContext.mjs';
import { GeoContextProvenance } from '../src/geoContextProvenance.mjs';
import { ContextItemAuthorization, contextPolicyIdentity } from '../src/geoContextItems.mjs';
import { createNativeInputFixture } from './helpers/geoNativeInputFixture.mjs';
import { normalizeTranscript } from '../src/dshRuntimeAdapter.mjs';
import { BODY, frontmatter } from './helpers/handbookFixture.mjs';
const options={skip:!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL,timeout:60000};
const sha256=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const f=await createNativeInputFixture(t,4), request=f.request('correction');
  request.content=[{type:'text',text:'Always preserve the denominator.'}];
  const frame=await f.prepare(request);
  await f.execute(request,frame,async()=>{await f.journal.beforeForward(request);f.journal.observe(request,{state:'accepted',authority:'native-mux'});});
  const transcript=normalizeTranscript('root',[{type:'turn/start',seq:0,data:{turn:1}},{type:'user/message',seq:1,data:{source:{kind:'user',rpcId:request.requestId},content:request.content}},{type:'turn/end',seq:2,data:{reason:{kind:'completed'}}}]);
  const run={id:'source-run',userId:'owner',projectId:f.project.id,sessionId:'root',nativeTurn:{startSeq:0},kernelRequestIds:[request.requestId],automated:false};
  const policies=new GeoSharedContext({database:f.db,documents:f.documents});
  const provenance=new GeoContextProvenance({documents:f.documents,contextPolicies:policies,nativeInputs:f.journal,
    resolveProject:async()=>f.project,resolveSourceRun:async(_owner,project,id)=>project===run.projectId&&id===run.id?run:null,
    readTranscript:async()=>transcript,historicalContextReceipt:async(_project,referenceId)=>referenceId==='launch-fixture'?{state:'launched',referenceId,digest:'1'.repeat(64),generation:'generation',policy:contextPolicyIdentity(f.policy)}:null});
  const items=new ContextItemAuthorization({documents:f.documents,contextPolicies:policies,resolveSourceRun:provenance.resolveSourceRun,verifyAcceptedContext:input=>provenance.verifyAcceptedContext(input)});
  provenance.contextItems=items;
  items.verifyMergedAncestor=input=>provenance.verifyMergedAncestor(input);
  const create=async(name='lesson',previous=null,extra={})=>{
    const payload={recordType:'learned-method',status:'approved',frontmatter:{...frontmatter,name},body:BODY,dependencies:[],provenance:{runId:run.id,sourceProjectId:run.projectId,sourceProjectIds:[run.projectId]},...extra};
    payload.contentDigest=methodContentDigest(payload,sha256);
    return provenance.write('owner','method',name,payload,{expectedRevision:previous?.revision??0,projectId:null});
  };
  return {...f,run,transcript,provenance,items,create};
}

const {HandbookConsolidation}=await import('../src/handbookConsolidation.mjs');
const {LearningService}=await import('../src/learningService.mjs');
const {registry}=await import('./helpers/handbookFixture.mjs');

async function handbookFixture(t) {
 const f=await fixture(t);Object.assign(f.run,{effectiveAgentId:'geo-content',status:'succeeded'});
 const {ProductJobs}=await import('../src/productJobs.mjs');
 const jobs=new ProductJobs(f.documents.database),queued=[];
 const enqueue=jobs.enqueue.bind(jobs);jobs.enqueue=async(...args)=>{const job=await enqueue(...args);queued.push(job);return job;};
 const claim=()=>jobs.claim(['consolidate'],'handbook-probe',{leaseMs:60000});
 const learning=new LearningService({documents:f.documents,jobs,contextProvenance:f.provenance});
 const input={frontmatter:{...frontmatter,name:'quality-handbook'},body:BODY,capabilityId:'geo-content',
 provenance:{runId:f.run.id,sourceProjectId:f.project.id,sourceProjectIds:[f.project.id],derivedFrom:'reviewer'}};
 const candidate=await learning.recordHandbookCandidate('owner',input);
 const loop=new HandbookConsolidation({learning,jobs,registry,contextProvenance:f.provenance,resolveSourceRun:f.provenance.resolveSourceRun});
 const job=await claim(),first=await loop.run({job});assert.equal(first.disposition,'applied');
 return {...f,loop,learning,candidate,input,queued,job,first,claim,jobs};
}
test('QUALITY: valid successive shared handbook candidate cannot replace own prior handbook',options,async t=>{
 const f=await handbookFixture(t);
 assert.equal(await f.items.handbook(f.policy,await f.documents.get('owner','method',f.first.handbookId)),true);
 const candidate=await f.learning.recordHandbookCandidate('owner',{...f.input,body:BODY+'\nKeep each original numerator too.'});
 assert.equal(candidate.id,f.candidate.id,'The actual candidate producer uses the same own-scope id');
 assert.equal(await f.provenance.authorize(f.policy,'method',candidate),true,'The new own-scope candidate has an authentic producer and retained own source');
 const result=await f.loop.run({job:await f.claim()});
 assert.equal(result.disposition,'applied');
 const current=await f.documents.get('owner','method',f.first.handbookId);
 assert.equal(current.payload.contentDigest,candidate.payload.contentDigest);assert.equal(await f.items.handbook(f.policy,current),true);
});

async function successor(f,text='Preserve each original numerator too.'){
 const previous=await f.documents.get('owner','method',f.first.handbookId);
 const candidate=await f.learning.recordHandbookCandidate('owner',{...f.input,body:BODY+'\n'+text});
 return {previous,candidate,job:await f.claim()};
}

test('real ProductJobs successors keep historical baselines private and replay the applied generation without another write',options,async t=>{
 const f=await handbookFixture(t),next=await successor(f);
 assert.equal(await f.items.handbook(f.policy,next.previous),false,'V1 is stale as ordinary current context once candidate V2 exists');
 const result=await f.loop.run({job:next.job}),current=await f.documents.get('owner','method',result.handbookId);
 assert.equal(result.disposition,'applied');assert.equal(await f.items.handbook(f.policy,current),true);
 assert.equal(await f.items.handbook(f.policy,next.previous),false);assert.equal(await f.items.method(f.policy,current),false);
 const proof=await f.provenance.proofFor('owner','method',current),receipt=await f.documents.get('owner','geo-plan-context',proof.handbookApplicationRef);
 assert.ok(receipt.payload.baselineVersions.some(row=>row.payload.contentDigest===next.previous.payload.contentDigest));
 assert.ok(proof.parents.some(row=>row.id===f.candidate.id&&row.contentDigest===next.candidate.payload.contentDigest));
 assert.ok(proof.parents.some(row=>row.id===next.previous.id&&row.contentDigest===next.previous.payload.contentDigest));
 const count=(await f.provenance.rows('owner','geo-plan-context',{recordType:'geo-context-handbook-application'},null)).length;
 const replay=await f.loop.run({job:next.job});assert.equal(replay.disposition,'applied');assert.equal(replay.jobCompleted,false);
 assert.equal((await f.documents.get('owner','method',current.id)).revision,current.revision);
 assert.equal((await f.provenance.rows('owner','geo-plan-context',{recordType:'geo-context-handbook-application'},null)).length,count);
 const third=await successor(f,'Keep numerator, denominator and original units.');
 assert.equal((await f.loop.run({job:third.job})).disposition,'applied');
 assert.equal(await f.items.handbook(f.policy,await f.documents.get('owner','method',current.id)),true);
});

for(const damage of ['foreign-baseline','retired-baseline','deleted-baseline','baseline-body','baseline-files','missing-proof','foreign-candidate','retired-candidate','deleted-candidate','source-run','source-capability','source-actor','candidate-history-bytes','wrong-capability','wrong-source-proof','missing-source-version','source-policy','missing-prior-application'])test(`handbook replacement refuses ${damage} before evaluating an invalid baseline`,options,async t=>{
 const f=await handbookFixture(t),next=await successor(f);let evaluated=0;f.loop.evaluate=async()=>{evaluated++;assert.fail('Invalid replacement input reached evaluation');};
 if(damage==='foreign-baseline')await f.documents.put('owner','method',next.previous.id,{...next.previous.payload,source:{...next.previous.payload.source,projectId:'foreign-project'}},{expectedRevision:next.previous.revision});
 if(damage==='retired-baseline')await f.documents.put('owner','method',next.previous.id,{...next.previous.payload,status:'retired'},{expectedRevision:next.previous.revision});
 if(damage==='deleted-baseline')await f.documents.remove('owner','method',next.previous.id,next.previous.revision);
 if(damage==='baseline-body')await f.documents.put('owner','method',next.previous.id,{...next.previous.payload,body:'Unauthenticated old baseline bytes.'},{expectedRevision:next.previous.revision});
 if(damage==='baseline-files')await f.documents.put('owner','method',next.previous.id,{...next.previous.payload,files:{'scripts/foreign.mjs':'export const bad = true;'}},{expectedRevision:next.previous.revision});
 if(damage==='missing-proof'){
  const proofId=f.provenance.proofId('owner','method',next.previous.id,next.previous.payload),row=await f.documents.get('owner','geo-plan-context',proofId);
  await f.documents.remove('owner','geo-plan-context',proofId,row.revision);
 }
 if(damage==='foreign-candidate')await f.documents.put('owner','method',next.candidate.id,{...next.candidate.payload,provenance:{...next.candidate.payload.provenance,sourceProjectId:'foreign-project'}},{expectedRevision:next.candidate.revision});
 if(damage==='retired-candidate')await f.documents.put('owner','method',next.candidate.id,{...next.candidate.payload,status:'retired'},{expectedRevision:next.candidate.revision});
 if(damage==='deleted-candidate')await f.documents.remove('owner','method',next.candidate.id,next.candidate.revision);
 if(damage==='source-run')f.run.automated=true;
 if(damage==='source-capability')f.run.effectiveAgentId='meta-analysis';
 if(damage==='source-actor'){
  const proof=await f.provenance.proofFor('owner','method',next.candidate),input=await f.documents.get('owner','geo-plan-context',proof.sources[0].inputReceiptRefs[0]);
  await f.documents.put('owner','geo-plan-context',input.id,{...input.payload,actor:{...input.payload.actor,id:'editor2'}},{expectedRevision:input.revision,projectId:f.project.id});
 }
 if(damage==='wrong-capability')await f.documents.put('owner','method',next.previous.id,{...next.previous.payload,capabilityId:'meta-analysis'},{expectedRevision:next.previous.revision});
 if(damage==='wrong-source-proof'){
  const id=f.provenance.proofId('owner','method',next.previous.id,next.previous.payload),row=await f.documents.get('owner','geo-plan-context',id);
  await f.documents.put('owner','geo-plan-context',id,{...row.payload,parents:row.payload.parents.map(pin=>pin.id===next.candidate.id?{...pin,proofRef:'gcp_'+ '0'.repeat(64)}:pin)},{expectedRevision:row.revision,projectId:f.project.id});
 }
 if(damage==='missing-source-version'){
  const proof=await f.provenance.proofFor('owner','method',next.previous),pin=proof.parents.find(row=>row.id===next.candidate.id);
  await f.documents.database.query("DELETE FROM evimed_product.revisions WHERE user_id=$1 AND kind='method' AND id=$2 AND revision=$3",['owner',next.candidate.id,pin.revision]);
 }
 if(damage==='source-policy'){
  const policy=await f.documents.get('owner','geo-plan-context',f.policy.referenceId);
  await f.documents.put('owner','geo-plan-context',policy.id,policy.payload,{expectedRevision:policy.revision,projectId:f.project.id});
 }
 if(damage==='missing-prior-application'){
  const proof=await f.provenance.proofFor('owner','method',next.previous),receipt=await f.documents.get('owner','geo-plan-context',proof.handbookApplicationRef);
  await f.documents.remove('owner','geo-plan-context',receipt.id,receipt.revision);
 }
 if(damage==='candidate-history-bytes'){
  const proof=await f.provenance.proofFor('owner','method',next.previous),pin=proof.parents.find(row=>row.id===f.candidate.id);
  await f.documents.database.query("UPDATE evimed_product.revisions SET payload=jsonb_set(payload,'{body}',to_jsonb($4::text)) WHERE user_id=$1 AND kind='method' AND id=$2 AND revision=$3",['owner',f.candidate.id,pin.revision,'Corrupted preserved candidate bytes.']);
 }
 let result;try{result=await f.loop.run({job:next.job});}catch(error){assert.ok(['geo_learning_source_unverified','handbook_candidate_unavailable','geo_handbook_baseline_unverified','memory_scope_denied'].includes(error.code),error.code);}
 assert.notEqual(result?.disposition,'applied');assert.equal(evaluated,0);
 assert.equal((await f.documents.get('owner','method',next.previous.id,{includeDeleted:true})).payload.contentDigest,next.previous.payload.contentDigest);
});

test('handbook lease publication uses its real owned transaction client for proof, history and closure reads',options,async t=>{
 const f=await handbookFixture(t),next=await successor(f),finish=f.jobs.finishWithLease.bind(f.jobs),query=f.documents.database.query.bind(f.documents.database);let expected=null,observed=0;
 f.jobs.finishWithLease=(owner,id,lease,result,operation)=>finish(owner,id,lease,result,async client=>{expected=client;try{return await operation(client);}finally{expected=null;}});
 f.documents.database.query=async(...args)=>{
  if(expected&&/evimed_product\.(?:documents|revisions)/u.test(args[0])){assert.equal(f.documents.database.transactionScope()?.client,expected);observed++;}
  return query(...args);
 };
 assert.equal((await f.loop.run({job:next.job})).disposition,'applied');assert.ok(observed>20,'Actual history/proof/current closure queries ran in the lease client');
});

for(const failure of ['body','proof','receipt'])test(`real handbook lease rolls back candidate disposition and replacement after ${failure} persistence failure`,options,async t=>{
 const f=await handbookFixture(t),next=await successor(f),put=f.documents.put.bind(f.documents);let failed=false;
 f.documents.put=async(user,kind,id,payload,opts)=>{
  const match=failure==='body'?payload.recordType==='capability-handbook':failure==='proof'?payload.recordType==='geo-context-producer-proof'&&payload.documentId===next.previous.id:payload.recordType==='geo-context-handbook-application';
  if(match&&!failed){failed=true;throw new Error('Handbook persistence failure');}return put(user,kind,id,payload,opts);
 };
 await assert.rejects(f.loop.run({job:next.job}),/Handbook persistence failure/);
 assert.equal((await f.documents.get('owner','method',next.previous.id)).revision,next.previous.revision);
 const candidate=await f.documents.get('owner','method',next.candidate.id);assert.notEqual(candidate.payload.dispositions[next.candidate.payload.contentDigest]?.disposition,'applied');
 assert.equal((await f.jobs.get('owner',next.job.id)).status,'running');
 f.documents.put=put;assert.equal((await f.loop.run({job:next.job})).disposition,'applied');
});

test('metadata-to-baseline hydration race never evaluates the replacement head as the admitted old baseline',options,async t=>{
 const f=await handbookFixture(t),next=await successor(f),get=f.documents.get.bind(f.documents);let changed=false,evaluated=0;
 f.loop.evaluate=async()=>{evaluated++;assert.fail('A changed baseline reached evaluation');};
 f.documents.get=async(user,kind,id,opts)=>{
  if(!changed&&kind==='method'&&id===next.previous.id&&opts?.expectedRevision===next.previous.revision){
   changed=true;await f.documents.put(user,kind,id,{...next.previous.payload,body:'A different unproved current body.'},{expectedRevision:next.previous.revision});
  }
  return get(user,kind,id,opts);
 };
 const result=await f.loop.run({job:next.job});assert.equal(result.reason,'handbook_baseline_scope_invalid');assert.equal(evaluated,0);assert.equal(changed,true);
});

test('a newer candidate arriving during evaluation makes the older successor stale and applies only its own later generation',options,async t=>{
 const f=await handbookFixture(t),next=await successor(f);let enter,release;
 const entered=new Promise(resolve=>{enter=resolve;}),held=new Promise(resolve=>{release=resolve;});
 f.loop.evaluate=async request=>{enter();await held;return {...request.binding,verdict:'non_inferior',report:'Local deterministic comparison.'};};
 const first=f.loop.run({job:next.job});await entered;
 const thirdCandidate=await f.learning.recordHandbookCandidate('owner',{...f.input,body:BODY+'\nA newer legitimate handbook generation.'});
 release();const stale=await first;assert.equal(stale.disposition,'stale');assert.equal(stale.reason,'handbook_candidate_changed');
 assert.equal((await f.documents.get('owner','method',next.previous.id)).payload.contentDigest,next.previous.payload.contentDigest);
 f.loop.evaluate=null;const applied=await f.loop.run({job:await f.claim()});assert.equal(applied.disposition,'applied');
 const current=await f.documents.get('owner','method',next.previous.id);assert.equal(current.payload.contentDigest,thirdCandidate.payload.contentDigest);assert.equal(await f.items.handbook(f.policy,current),true);
});

test('source withdrawal during evaluation refuses publication and leaves the old baseline intact',options,async t=>{
 const f=await handbookFixture(t),next=await successor(f);
 f.loop.evaluate=async request=>{f.run.automated=true;return {...request.binding,verdict:'non_inferior',report:'Local deterministic comparison.'};};
 await assert.rejects(f.loop.run({job:next.job}),{code:'geo_learning_source_unverified'});
 assert.equal((await f.documents.get('owner','method',next.previous.id)).revision,next.previous.revision);
 assert.notEqual((await f.documents.get('owner','method',next.candidate.id)).payload.dispositions[next.candidate.payload.contentDigest]?.disposition,'applied');
});

test('a genuine lease lost after application work rolls back the new handbook, proof and certificate',options,async t=>{
 const f=await handbookFixture(t),next=await successor(f),finish=f.jobs.finishWithLease.bind(f.jobs);
 f.jobs.finishWithLease=(owner,id,lease,result,operation)=>finish(owner,id,lease,result,async client=>{
  await operation(client);await client.query("UPDATE evimed_product.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND id=$2",[owner,id]);
 });
 await assert.rejects(f.loop.run({job:next.job}),{code:'product_job_lease_lost'});
 assert.equal((await f.documents.get('owner','method',next.previous.id)).revision,next.previous.revision);
 assert.notEqual((await f.documents.get('owner','method',next.candidate.id)).payload.dispositions[next.candidate.payload.contentDigest]?.disposition,'applied');
 assert.equal((await f.provenance.rows('owner','geo-plan-context',{recordType:'geo-context-handbook-application'},null)).length,1);
});

test('a transitive closure withdrawal during final handbook validation rolls back the lease publication',options,async t=>{
 const f=await handbookFixture(t),next=await successor(f),compare=f.documents.matchesSnapshots.bind(f.documents);let changed=false;
 f.documents.matchesSnapshots=async(owner,snapshots,opts)=>{
  if(!changed&&snapshots.some(row=>row.id===next.previous.id&&row.revision>next.previous.revision)){
   changed=true;const candidate=await f.documents.get('owner','method',next.candidate.id);
   await f.documents.put('owner','method',candidate.id,{...candidate.payload,status:'retired'},{expectedRevision:candidate.revision});
  }
  return compare(owner,snapshots,opts);
 };
 await assert.rejects(f.loop.run({job:next.job}),{code:'geo_handbook_baseline_unverified'});assert.equal(changed,true);
 assert.equal((await f.documents.get('owner','method',next.previous.id)).revision,next.previous.revision);
 assert.equal((await f.documents.get('owner','method',next.candidate.id)).payload.status,'candidate');
});

test('a captured baseline telemetry revision without history remains an exact private predecessor pin',options,async t=>{
 const f=await handbookFixture(t),old=await f.documents.get('owner','method',f.first.handbookId);
 const moved=await f.documents.put('owner','method',old.id,{...old.payload,observations:[]},{expectedRevision:old.revision,telemetry:true});
 assert.equal((await f.documents.history('owner','method',old.id)).some(row=>row.revision===moved.revision),false);
 const next=await successor(f);assert.equal((await f.loop.run({job:next.job})).disposition,'applied');
 const current=await f.documents.get('owner','method',old.id);assert.equal(await f.items.handbook(f.policy,current),true);
 const proof=await f.provenance.proofFor('owner','method',current),receipt=await f.documents.get('owner','geo-plan-context',proof.handbookApplicationRef);
 assert.ok(receipt.payload.baselineVersions.some(row=>row.revision===moved.revision));
 assert.equal(await f.items.handbook(f.policy,moved),false);
});

for(const damage of ['missing-application','altered-application','original-actor','historical-candidate-body'])test(`published successor refuses a later ${damage} change`,options,async t=>{
 const f=await handbookFixture(t),next=await successor(f);await f.loop.run({job:next.job});
 const current=await f.documents.get('owner','method',next.previous.id),proof=await f.provenance.proofFor('owner','method',current);
 if(damage==='missing-application'||damage==='altered-application'){
  const receipt=await f.documents.get('owner','geo-plan-context',proof.handbookApplicationRef);
  if(damage==='missing-application')await f.documents.remove('owner','geo-plan-context',receipt.id,receipt.revision);
  else await f.documents.put('owner','geo-plan-context',receipt.id,{...receipt.payload,capabilityId:'foreign-capability'},{expectedRevision:receipt.revision,projectId:f.project.id});
 }
 if(damage==='original-actor'){
  const input=await f.documents.get('owner','geo-plan-context',proof.sources[0].inputReceiptRefs[0]);
  await f.documents.put('owner','geo-plan-context',input.id,{...input.payload,actor:{...input.payload.actor,id:'editor2'}},{expectedRevision:input.revision,projectId:f.project.id});
 }
 if(damage==='historical-candidate-body'){
  const original=(await f.provenance.proofFor('owner','method',next.previous)).parents.find(row=>row.id===next.candidate.id);
  await f.documents.database.query("UPDATE evimed_product.revisions SET payload=jsonb_set(payload,'{body}',to_jsonb($4::text)) WHERE user_id=$1 AND kind='method' AND id=$2 AND revision=$3",['owner',next.candidate.id,original.revision,'Altered original source candidate bytes.']);
 }
 assert.equal(await f.items.handbook(f.policy,current),false);
});

test('an independent handbook body revision with its own proof is not the exact source-candidate baseline',options,async t=>{
 const f=await handbookFixture(t),old=await f.documents.get('owner','method',f.first.handbookId),payload={...old.payload,body:BODY+'\nAn independent body without the original candidate bond.'};
 payload.contentDigest=methodContentDigest(payload,sha256);
 await f.provenance.write('owner','method',old.id,payload,{expectedRevision:old.revision});
 const next=await successor(f);let evaluated=0;f.loop.evaluate=async()=>{evaluated++;assert.fail('Unrelated handbook body reached evaluation');};
 const result=await f.loop.run({job:next.job});assert.equal(result.reason,'handbook_baseline_scope_invalid');assert.equal(evaluated,0);
});

test('a valid same-body producer proof changed during evaluation is stale rather than recaptured as the evaluated source',options,async t=>{
 const f=await handbookFixture(t),next=await successor(f);
 f.loop.evaluate=async request=>{
  const current=await f.documents.get('owner','method',next.candidate.id);
  await f.provenance.write('owner','method',current.id,{...current.payload,provenance:{...current.payload.provenance,interpretation:'A different legitimate review context.'}},{expectedRevision:current.revision});
  return {...request.binding,verdict:'non_inferior',report:'Local deterministic comparison.'};
 };
 const result=await f.loop.run({job:next.job});assert.equal(result.disposition,'stale');assert.equal(result.reason,'handbook_candidate_changed');
 assert.equal((await f.documents.get('owner','method',next.previous.id)).revision,next.previous.revision);
});
