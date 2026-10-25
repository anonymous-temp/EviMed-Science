import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {methodContentDigest} from '@evimed/domain';
import {GeoContextProvenance} from '../src/geoContextProvenance.mjs';
import {ContextItemAuthorization,contextPolicyIdentity} from '../src/geoContextItems.mjs';
import {createNativeInputFixture} from './helpers/geoNativeInputFixture.mjs';
import {normalizeTranscript} from '../src/dshRuntimeAdapter.mjs';
import {BODY,frontmatter} from './helpers/handbookFixture.mjs';
import {LearningService} from '../src/learningService.mjs';
import {GeoSharedContext} from '../src/geoSharedContext.mjs';
import {ProductJobs} from '../src/productJobs.mjs';
import {HandbookConsolidation} from '../src/handbookConsolidation.mjs';
import {registry} from './helpers/handbookFixture.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
async function fixture(t,poolMax=4) {
 const f=await createNativeInputFixture(t,poolMax),runs=[],transcripts=new Map();
 const p=new GeoContextProvenance({documents:f.documents,contextPolicies:new GeoSharedContext({database:f.db,documents:f.documents}),
  nativeInputs:f.journal,resolveProject:async()=>f.project,resolveSourceRun:async(owner,project,id)=>owner==='owner'&&project===f.project.id?runs.find(r=>r.id===id)??null:null,
  readTranscript:async(_,run)=>transcripts.get(run.id),historicalContextReceipt:async(_,ref)=>ref==='launch-fixture'?{state:'launched',referenceId:ref,digest:'1'.repeat(64),generation:'generation',policy:contextPolicyIdentity(f.policy)}:null});
 const items=new ContextItemAuthorization({documents:f.documents,contextPolicies:p.contextPolicies,resolveSourceRun:p.resolveSourceRun,verifyAcceptedContext:x=>p.verifyAcceptedContext(x),verifyMergedAncestor:x=>p.verifyMergedAncestor(x)});p.contextItems=items;
 async function source(id,actor='editor') {
  const request=f.request(id);request.sessionId='root';request.content=[{type:'text',text:`Preserve the independent check from ${id}.`}];
  const frame=await f.prepare(request,f.users[actor]);
  await f.execute(request,frame,async()=>{await f.journal.beforeForward(request);f.journal.observe(request,{state:'accepted',authority:'native-mux'});});
  const seq=runs.length*3;
  const transcript=normalizeTranscript('root',[{type:'turn/start',seq,data:{turn:runs.length+1}},{type:'user/message',seq:seq+1,data:{source:{kind:'user',rpcId:id},content:request.content}},{type:'turn/end',seq:seq+2,data:{reason:{kind:'completed'}}}]);
  const run={id,userId:'owner',projectId:f.project.id,sessionId:'root',nativeTurn:{startSeq:seq},kernelRequestIds:[id],automated:false,status:'succeeded',effectiveAgentId:'geo-content'};
  runs.push(run);transcripts.set(id,transcript);return run;
 }
 async function method(id,run,body=BODY,extra={}) {
  const payload={recordType:'learned-method',status:'approved',frontmatter:{...frontmatter,name:id},body,dependencies:[],provenance:{runId:run.id,sourceProjectId:f.project.id,sourceProjectIds:[f.project.id]},...extra};
  payload.contentDigest=methodContentDigest(payload,sha);
  return p.write('owner','method',id,payload,{expectedRevision:0});
 }
 return {...f,p,items,runs,transcripts,source,method};
}

async function handbook(t,label,poolMax=4) {
 const f=await fixture(t,poolMax),a=await f.source(label+'-source-a'),b=await f.source(label+'-source-b','editor2'),c=await f.source(label+'-source-c');
 const jobs=new ProductJobs(f.db),learning=new LearningService({documents:f.documents,jobs,contextProvenance:f.p});let publications=0;
 const loop=new HandbookConsolidation({learning,jobs,registry,contextProvenance:f.p,resolveSourceRun:f.p.resolveSourceRun,onApplied:()=>publications++});
 const make=(run,body,files=undefined)=>({frontmatter:{...frontmatter,name:label},body,...(files?{files}:{}),capabilityId:'geo-content',
  provenance:{runId:run.id,sourceProjectId:f.project.id,sourceProjectIds:[f.project.id],derivedFrom:'reviewer'}});
 const claim=()=>jobs.claim(['consolidate'],label+'-worker',{leaseMs:60000});
 const input1=make(a,BODY,{'scripts/original.mjs':'export const preserve=1;'}),candidate1=await learning.recordHandbookCandidate('owner',input1),job1=await claim();
 const result1=await loop.run({job:job1});assert.equal(result1.disposition,'applied');
 const old=await f.documents.get('owner','method',result1.handbookId);
 const input2=make(b,BODY+'\nKeep all original numerator values.',{'scripts/original.mjs':'export const preserve=2;'}),candidate2=await learning.recordHandbookCandidate('owner',input2),job2=await claim();
 assert.equal(candidate1.id,candidate2.id);
 return {...f,a,b,c,jobs,learning,loop,make,claim,input1,input2,candidate1,candidate2,job1,job2,old,publications:()=>publications};
}

test('QUALITY: eight successive applications retain exact authority with measured query cost',{timeout:60000},async t=>{
 const f=await handbook(t,'quality-generations'),costs=[],query=f.db.query.bind(f.db);let total=0;
 f.db.query=async(...args)=>{total++;return query(...args);};
 for(let generation=2;generation<=8;generation++){
  const start=performance.now(),before=total;
  let candidate=f.candidate2,job=f.job2;
  if(generation>2){candidate=await f.learning.recordHandbookCandidate('owner',f.make([f.a,f.b,f.c][(generation-1)%3],BODY+'\nKeep the independently preserved check number '+generation+'.'));job=await f.claim();}
  const generationQueries=total-before,applyStart=performance.now(),applyBefore=total;const result=await f.loop.run({job});const applyQueries=total-applyBefore,applyMs=Math.round(performance.now()-applyStart);assert.equal(result.disposition,'applied','Generation '+generation);
  const authorizationStart=performance.now(),current=await f.documents.get('owner','method',f.old.id);assert.equal(current.payload.contentDigest,candidate.payload.contentDigest);
  assert.equal(await f.items.handbook(f.policy,current),true,'Generation '+generation+' remains a live authorized root');
  const cost={generation,queries:total-before,generationQueries,applicationQueries:applyQueries,authorizationQueries:total-before-generationQueries-applyQueries,applicationMs:applyMs,authorizationMs:Math.round(performance.now()-authorizationStart),ms:Math.round(performance.now()-start)};costs.push(cost);console.log('COST',JSON.stringify(cost));
 }
 assert.ok(costs.at(-1).authorizationQueries<500,'Eight-generation authorization query budget');
 assert.ok(costs.at(-1).applicationQueries<2000,'Eight-generation application query budget');
 for(const stage of ['authorizationQueries','applicationQueries'])assert.ok(costs.at(-1)[stage]<costs[2][stage]*2.2,'Generations four to eight remain near linear: '+stage);
});

for(const retry of [false,true])test(`real ABA recurrence has a distinct generation and exact immutable predecessor proof (retry=${retry})`,{timeout:60000},async t=>{
 const f=await handbook(t,'recurrence-'+retry,retry?1:4);assert.equal((await f.loop.run({job:f.job2})).disposition,'applied');
 const oldCandidateRef=f.p.proofId('owner','method',f.candidate2.id,f.candidate2.payload),oldCandidateProof=await f.documents.get('owner','geo-plan-context',oldCandidateRef);
 const oldHandbook=await f.documents.get('owner','method',f.old.id),oldHandbookRef=f.p.proofId('owner','method',oldHandbook.id,oldHandbook.payload),oldHandbookProof=await f.documents.get('owner','geo-plan-context',oldHandbookRef);
 const middle=await f.learning.recordHandbookCandidate('owner',f.make(f.c,BODY+'\nPreserve the intervening instruction.',f.input2.files));assert.equal((await f.loop.run({job:await f.claim()})).disposition,'applied');
 const middleHandbook=await f.documents.get('owner','method',f.old.id);
 const restored=await f.learning.recordHandbookCandidate('owner',f.input2),normal=await f.claim();assert.ok(normal);assert.notEqual(normal.id,f.job2.id);
 let job=normal;
 if(retry){await f.jobs.finishWithLease('owner',normal.id,normal.leaseToken,{disposition:'stale'},async()=>{});const queued=await f.learning.enqueueHandbook('owner',restored,{retryOf:normal.id});job=await f.claim();assert.equal(job.id,queued.id);}
 let evaluations=0;f.loop.evaluate=async request=>{evaluations++;return {...request.binding,verdict:'non_inferior',report:'Local recurrence comparison.'};};
 const obsolete=await f.loop.run({job:f.job2});assert.equal(obsolete.disposition,'stale');assert.equal(evaluations,0);
 const newCandidateRef=f.p.proofId('owner','method',restored.id,restored.payload);assert.notEqual(newCandidateRef,oldCandidateRef);
 assert.ok(await f.p.descendsFromProof(f.policy,restored,f.p.proofId('owner','method',middle.id,middle.payload)));
 assert.equal((await f.loop.run({job})).disposition,'applied');assert.equal(evaluations,1);
 const current=await f.documents.get('owner','method',f.old.id);assert.equal(current.payload.contentDigest,oldHandbook.payload.contentDigest);assert.equal(await f.items.handbook(f.policy,current),true);
 const proof=await f.p.proofFor('owner','method',current);assert.ok(proof.parents.some(pin=>pin.id===middleHandbook.id&&pin.revision===middleHandbook.revision));assert.ok(proof.parents.some(pin=>pin.id===restored.id&&pin.proofRef===newCandidateRef));
 assert.notEqual(f.p.proofId('owner','method',current.id,current.payload),oldHandbookRef);
 assert.deepEqual(await f.documents.get('owner','geo-plan-context',oldCandidateRef),oldCandidateProof);assert.deepEqual(await f.documents.get('owner','geo-plan-context',oldHandbookRef),oldHandbookProof);
 const latest=await f.documents.get('owner','method',restored.id),telemetry=await f.documents.put('owner','method',latest.id,{...latest.payload,updatedAt:'2030-01-01T00:00:00.000Z'},{expectedRevision:latest.revision});
 const repeated=await f.learning.recordHandbookCandidate('owner',f.input2);assert.equal(repeated.revision,telemetry.revision);assert.equal(repeated.payload.candidateRevision,restored.payload.candidateRevision);
 assert.equal((await f.learning.enqueueHandbook('owner',repeated)).id,normal.id);assert.equal(await f.claim(),null);
 assert.equal((await f.loop.run({job})).jobCompleted,false);assert.equal(evaluations,1);assert.equal((await f.documents.get('owner','method',current.id)).revision,current.revision);
 f.a.automated=true;assert.equal(await f.items.handbook(f.policy,current),false,'No positive cache crosses requests');
});

for(const change of ['actor','run','run-capability','proof','historical-bytes','historical-capability'])test(`request-owned reuse rechecks ${change} before accepting the complete closure`,{timeout:60000},async t=>{
 const f=await handbook(t,'final-recheck-'+change);assert.equal((await f.loop.run({job:f.job2})).disposition,'applied');
 const head=await f.documents.get('owner','method',f.old.id),finish=f.items.finish.bind(f.items);let changed=false;
 f.items.finish=async(policy,traversal)=>{
  if(!changed&&traversal.snapshots.has('method:'+head.id)){
   changed=true;
   if(change==='run')f.a.automated=true;
   if(change==='run-capability')f.a.effectiveAgentId='meta-analysis';
   if(change==='actor'){
    const proof=await f.p.proofFor('owner','method',head),source=proof.sources.find(row=>row.runId===f.a.id),input=await f.documents.get('owner','geo-plan-context',source.inputReceiptRefs[0]);
    await f.documents.put('owner','geo-plan-context',input.id,{...input.payload,actor:{...input.payload.actor,id:'editor2'}},{expectedRevision:input.revision,projectId:f.project.id});
   }
   if(change==='proof'){
    const reference=f.p.proofId('owner','method',f.candidate1.id,f.candidate1.payload),row=await f.documents.get('owner','geo-plan-context',reference);
    await f.documents.put('owner','geo-plan-context',reference,{...row.payload,complete:false},{expectedRevision:row.revision,projectId:f.project.id});
   }
   if(change==='historical-bytes'||change==='historical-capability')await f.db.query("UPDATE evimed_product.revisions SET payload=jsonb_set(payload,$4::text[],to_jsonb($5::text)) WHERE user_id=$1 AND kind='method' AND id=$2 AND revision=$3",['owner',f.candidate1.id,f.candidate1.revision,[change==='historical-bytes'?'body':'capabilityId'],'corrupted historical input']);
  }
  return finish(policy,traversal);
 };
 assert.equal(await f.items.handbook(f.policy,head),false);assert.equal(changed,true);
});

test('a recurrence superseded by a further recurrence during evaluation cannot stamp the newer generation', {timeout:60000},async t=>{
 const f=await handbook(t,'recurrence-race');await f.loop.run({job:f.job2});
 await f.learning.recordHandbookCandidate('owner',f.make(f.c,BODY+'\nPreserve the intervening instruction.'));await f.loop.run({job:await f.claim()});
 const baseline=await f.documents.get('owner','method',f.old.id),candidate=await f.learning.recordHandbookCandidate('owner',f.input2),job=await f.claim();let latest,evaluations=0;
 f.loop.evaluate=async request=>{
  evaluations++;await f.learning.recordHandbookCandidate('owner',f.make(f.a,BODY+'\nPreserve the next intervening instruction.'));
  latest=await f.learning.recordHandbookCandidate('owner',f.input2);
  return {...request.binding,verdict:'non_inferior',report:'Local stale-generation comparison.'};
 };
 const stale=await f.loop.run({job});assert.equal(stale.disposition,'stale');assert.equal(stale.jobCompleted,true);assert.equal(evaluations,1);
 const queued=await f.documents.get('owner','method',candidate.id);assert.equal(queued.revision,latest.revision);assert.equal(queued.payload.dispositions[latest.payload.contentDigest].state,'queued');
 assert.equal((await f.documents.get('owner','method',f.old.id)).revision,baseline.revision);
 assert.equal((await f.loop.run({job:await f.claim()})).disposition,'stale');assert.equal(evaluations,1);
 f.loop.evaluate=null;assert.equal((await f.loop.run({job:await f.claim()})).disposition,'applied');
 assert.equal(await f.items.handbook(f.policy,await f.documents.get('owner','method',f.old.id)),true);
});

test('ABA application receipt failure rolls back and the same leased result can succeed without changing old proofs', {timeout:60000},async t=>{
 const f=await handbook(t,'recurrence-rollback');await f.loop.run({job:f.job2});
 await f.learning.recordHandbookCandidate('owner',f.make(f.c,BODY+'\nPreserve the intervening instruction.'));await f.loop.run({job:await f.claim()});
 const baseline=await f.documents.get('owner','method',f.old.id),candidate=await f.learning.recordHandbookCandidate('owner',f.input2),job=await f.claim(),put=f.documents.put.bind(f.documents);let failed=false;
 f.documents.put=async(user,kind,id,payload,opts)=>{if(!failed&&payload.recordType==='geo-context-handbook-application'){failed=true;throw new Error('Receipt persistence failed');}return put(user,kind,id,payload,opts);};
 await assert.rejects(f.loop.run({job}),/Receipt persistence failed/u);
 assert.equal((await f.documents.get('owner','method',f.old.id)).revision,baseline.revision);assert.equal((await f.documents.get('owner','method',candidate.id)).revision,candidate.revision);
 assert.equal((await f.loop.run({job})).disposition,'applied');assert.equal(await f.items.handbook(f.policy,await f.documents.get('owner','method',f.old.id)),true);
});
