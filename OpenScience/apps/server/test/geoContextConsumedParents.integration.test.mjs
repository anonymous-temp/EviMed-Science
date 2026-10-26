import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {methodContentDigest} from '@evimed/domain';
import {GeoContextProvenance} from '../src/geoContextProvenance.mjs';
import {ContextItemAuthorization,contextPolicyIdentity} from '../src/geoContextItems.mjs';
import {createNativeInputFixture} from './helpers/geoNativeInputFixture.mjs';
import {normalizeTranscript} from '../src/dshRuntimeAdapter.mjs';
import {BODY,frontmatter} from './helpers/methodSkillFixture.mjs';
import {LearningService,learnedMethodId} from '../src/learningService.mjs';
import {MethodConsolidation} from '../src/methodConsolidation.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
async function fixture(t) {
 const f=await createNativeInputFixture(t,4),runs=[],transcripts=new Map();
 const p=new GeoContextProvenance({documents:f.documents,contextPolicies:{forProject:async project=>project.id===f.project.id?f.policy:{kind:'owned',ownerId:project.userId,controlProjectId:project.id}},
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
const skill=(fm,body)=>['---',...Object.entries(fm).flatMap(([k,v])=>typeof v==='object'?[`${k}:`,...Object.entries(v).map(([a,b])=>`  ${a}: ${JSON.stringify(b)}`)]:[`${k}: ${JSON.stringify(v)}`]),'---',body].join('\n');
test('shared method readers reject invalid hydrated bytes',{skip:!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL},async t=>{
 const f=await fixture(t),run=await f.source('bytes-case'),good=await f.method('bytes-method',run);
 const bad=await f.documents.put('owner','method',good.id,{...good.payload,body:good.payload.body+'\nUnproved altered instruction.'},{expectedRevision:good.revision});
 assert.equal(await f.items.method(f.policy,bad),false);
 const returned=await f.p.methodFor('owner',good.id,f.policy);
 assert.equal(returned,null,'Hydrated bytes require the same authority as selected metadata');
});

test('consolidation retains every actual builder input even when the output names only a subset',{skip:!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL},async t=>{
 const f=await fixture(t),runA=await f.source('source-a'),runB=await f.source('source-b','editor2');
 const a=await f.method('method-a',runA),b=await f.method('method-b',runB,BODY+'\nPreserve the source-b-specific check.');
 const learning=new LearningService({documents:f.documents,contextProvenance:f.p});
 let readIds=[];
 const consolidation=new MethodConsolidation({learning,contextProvenance:f.p,dispatch:async({input})=>{readIds=input.methods.map(m=>m.id);return {runId:'local-builder'};},
  readResult:async()=>({status:'succeeded',output:{revisions:[{operation:'amend',methodId:a.id,baseDigest:a.payload.contentDigest,assignment:'subset-case',skill:skill(a.payload.frontmatter,a.payload.body+'\nPreserve the source-b-specific check.')}]}})});
 const result=await consolidation.buildGroup({id:'proof-amend',userId:'owner',projectId:'_learning',payload:{sourceProjectId:f.project.id}},[a,b],{assignments:[{ASSIGNMENT:'subset-case',RELATION_TYPE:'subset',SKILLS:[a.id,b.id],WIDER:a.id,REASON:'Use the independent source-b check in the wider method.'}]});
 assert.equal(result.applied,1);assert.deepEqual(readIds,[a.id,b.id]);
 let amended=await learning.getMethod('owner',a.id);amended=await learning.approve('owner',a.id,{expectedRevision:amended.revision});
 const proof=await f.p.proofFor('owner','method',amended);
 assert.deepEqual(new Set(proof.sources.map(s=>s.runId)),new Set(['source-a','source-b']));
 assert.deepEqual(new Set(proof.sources.flatMap(s=>s.actors.map(a=>a.id))),new Set(['editor','editor2']));
 assert.equal(await f.items.method(f.policy,amended),true);
 runB.automated=true;
 assert.equal(await f.items.method(f.policy,b),false,'Source B is now independently invalid');
 assert.equal(await f.items.method(f.policy,amended),false,'Source withdrawal reaches every derived body that consumed it');
});


test('distillation retains actual related bodies even when the output omits dependencies',{skip:!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL},async t=>{
 const f=await fixture(t),a=await f.source('distill-source-a'),b=await f.source('distill-source-b','editor2');
 const related=await f.method('related-b',b,BODY+'\nKeep the distinct related-b procedure.');
 const {persistRunTranscript}=await import('../src/runTranscripts.mjs');
 await persistRunTranscript({project:f.project,run:a,sessions:[{sessionId:'root',parentSessionId:null,label:'root',transcript:f.transcripts.get(a.id)}]});
 const {MethodDistillationRuns}=await import('../src/methodDistillationRuns.mjs');
 const learning=new LearningService({documents:f.documents,contextProvenance:f.p});
 let reads=[];
 const distill=new MethodDistillationRuns({learning,contextProvenance:f.p,dispatch:async({input})=>{reads=input.relatedMethods.map(m=>m.id);assert.ok(input.relatedMethods[0].body.includes('distinct related-b procedure'));return {runId:'local-distiller',sessionId:'local'};},
  readResult:async()=>({status:'succeeded',output:{skill:skill({...frontmatter,name:'created-with-related-b'},BODY+'\nKeep the distinct related-b procedure.'),candidate:{operation:'create',evidence:[{runId:a.id,seqRange:[1,1],quote:'Preserve the independent check'}]}}})});
 const result=await distill.execute({job:{id:'distill-with-related',userId:'owner',projectId:f.project.id,payload:{trigger:'correction'}},project:f.project,run:a});
 assert.deepEqual(reads,[related.id]);assert.equal(result.operation,'create');
 const created=await learning.getMethod('owner',result.methodId),proof=await f.p.proofFor('owner','method',created);
 assert.deepEqual(new Set(proof.sources.map(s=>s.runId)),new Set([a.id,b.id]));assert.ok(proof.parents.some(parent=>parent.id===related.id));
 b.automated=true;assert.equal(await f.items.method(f.policy,related),false);assert.equal(await f.items.method(f.policy,created),false);
});

const localOnly={skip:!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL};
test('corrupt hydrated consolidation subjects never reach the builder',localOnly,async t=>{
 const f=await fixture(t),run=await f.source('corrupt-caller'),a=await f.method('corrupt-a',run);
 const bad=await f.documents.put('owner','method',a.id,{...a.payload,body:a.payload.body+'\nUnproved check.'},{expectedRevision:a.revision});
 let calls=0;
 const consolidation=new MethodConsolidation({learning:new LearningService({documents:f.documents,contextProvenance:f.p}),contextProvenance:f.p,
  dispatch:async()=>{calls++;return {runId:'must-not-run'};},readResult:async()=>({status:'succeeded',output:{}})});
 await assert.rejects(()=>consolidation.buildGroup({id:'corrupt-subject',userId:'owner',payload:{sourceProjectId:f.project.id}},[bad],
  {assignments:[{ASSIGNMENT:'corrupt',RELATION_TYPE:'abstract_pattern',SKILLS:[bad.id]}]}),{code:'geo_learning_target_unverified'});
 assert.equal(calls,0);
});

test('an abstract create retains all supplied bodies beyond its declared assignment and dependency list',localOnly,async t=>{
 const f=await fixture(t),a=await f.method('abstract-a',await f.source('abstract-source-a')),
  b=await f.method('abstract-b',await f.source('abstract-source-b','editor2')),
  c=await f.method('abstract-c',await f.source('abstract-source-c'),BODY+'\nThe check supplied outside the declared assignment.');
 const learning=new LearningService({documents:f.documents,contextProvenance:f.p}),id=learnedMethodId('derived-abstract');
 const consolidation=new MethodConsolidation({learning,contextProvenance:f.p,dispatch:async()=>({runId:'abstract-local'}),
  readResult:async()=>({status:'succeeded',output:{revisions:[{operation:'create',methodId:id,assignment:'abstract',dependencies:[],
   skill:skill({...frontmatter,name:'derived-abstract'},BODY+'\nThe check supplied outside the declared assignment.')}]}})});
 const result=await consolidation.buildGroup({id:'abstract-proof',userId:'owner',payload:{sourceProjectId:f.project.id}},[a,b,c],
  {assignments:[{ASSIGNMENT:'abstract',RELATION_TYPE:'abstract_pattern',SKILLS:[a.id,b.id],REASON:'Extract the shared procedure.'}]});
 assert.equal(result.applied,1);
 const created=await learning.getMethod('owner',id),proof=await f.p.proofFor('owner','method',created);
 assert.deepEqual(new Set(proof.parents.map(p=>p.id)),new Set([a.id,b.id,c.id]));
 assert.deepEqual(new Set(proof.sources.map(s=>s.runId)),new Set(['abstract-source-a','abstract-source-b','abstract-source-c']));
 assert.equal(await f.items.method(f.policy,created),true);
 const corrupted=await f.documents.put('owner','method',c.id,{...c.payload,body:c.payload.body+'\nChanged without a new proof.'},{expectedRevision:c.revision});
 assert.equal(await f.items.method(f.policy,corrupted),false);
 assert.equal(await f.items.method(f.policy,created),false,'A consumed parent is checked after hydration through the bounded closure');
});

test('a supplied source retired after generation cannot be applied or revived on retry',localOnly,async t=>{
 const f=await fixture(t),a=await f.method('stale-a',await f.source('stale-source-a')),
  b=await f.method('stale-b',await f.source('stale-source-b','editor2'));
 const learning=new LearningService({documents:f.documents,contextProvenance:f.p});let dispatches=0,retired=false;
 const consolidation=new MethodConsolidation({learning,contextProvenance:f.p,dispatch:async()=>{dispatches++;return {runId:'stale-local'};},
  readResult:async()=>{
   if(!retired){await f.documents.put('owner','method',b.id,{...b.payload,status:'retired'},{expectedRevision:b.revision});retired=true;}
   return {status:'succeeded',output:{revisions:[{operation:'amend',methodId:a.id,baseDigest:a.payload.contentDigest,assignment:'stale',skill:skill(a.payload.frontmatter,BODY+'\nCopied from a withdrawn input.')}]}};
  }});
 const job={id:'stale-proof',userId:'owner',payload:{sourceProjectId:f.project.id}},decision={assignments:[{ASSIGNMENT:'stale',RELATION_TYPE:'subset',SKILLS:[a.id,b.id],WIDER:a.id,REASON:'Keep both checks.'}]};
 await assert.rejects(()=>consolidation.buildGroup(job,[a,b],decision),{code:'geo_learning_input_stale'});
 assert.equal((await learning.getMethod('owner',a.id)).revision,a.revision);
 await assert.rejects(()=>consolidation.buildGroup(job,[a,b],decision),{code:'geo_learning_target_unverified'});
 assert.equal(dispatches,1);
});

async function distillerFixture(t,label,output) {
 const f=await fixture(t),run=await f.source(label+'-a'),related=await f.method(label+'-b',await f.source(label+'-b-source','editor2'));
 const {persistRunTranscript}=await import('../src/runTranscripts.mjs');
 await persistRunTranscript({project:f.project,run,sessions:[{sessionId:'root',parentSessionId:null,label:'root',transcript:f.transcripts.get(run.id)}]});
 const {MethodDistillationRuns}=await import('../src/methodDistillationRuns.mjs');
 const learning=new LearningService({documents:f.documents,contextProvenance:f.p});let calls=0,pending=true;
 const distill=new MethodDistillationRuns({learning,contextProvenance:f.p,dispatch:async({dispatchId})=>{assert.match(dispatchId,/-gcp1$/u);calls++;return {runId:label+'-model',sessionId:'model-root'};},
  readResult:async()=>pending?{status:'pending'}:{status:'succeeded',output:output??{skill:skill({...frontmatter,name:label+'-created'},BODY),candidate:{operation:'create',dependencies:[]}}}});
 const request={job:{id:label,userId:'owner',projectId:f.project.id,payload:{trigger:'correction'}},project:f.project,run};
 return {...f,run,related,learning,distill,request,ready:()=>{pending=false;},calls:()=>calls};
}

test('a resumed distillation adopts only its identical first input and proof set',localOnly,async t=>{
 const f=await distillerFixture(t,'resume-identical');
 assert.equal((await f.distill.execute(f.request)).state,'pending');
 f.ready();const result=await f.distill.execute(f.request);
 assert.equal(result.operation,'create');assert.equal(f.calls(),2);
 const created=await f.learning.getMethod('owner',result.methodId),proof=await f.p.proofFor('owner','method',created);
 assert.ok(proof.parents.some(parent=>parent.id===f.related.id&&parent.revision===f.related.revision));
 assert.equal(await f.items.method(f.policy,created),true);
});

test('a pending dispatch refuses a different current related input before re-dispatch or result adoption',localOnly,async t=>{
 const f=await distillerFixture(t,'resume-changed');
 assert.equal((await f.distill.execute(f.request)).state,'pending');
 await f.documents.put('owner','method',f.related.id,{...f.related.payload,status:'retired'},{expectedRevision:f.related.revision});
 f.ready();await assert.rejects(()=>f.distill.execute(f.request),{code:'geo_learning_input_stale'});
 assert.equal(f.calls(),1);
 assert.equal((await f.documents.list('owner','method')).items.length,1);
});

test('a source revised after dispatch cannot be replaced by its new body when the old output arrives',localOnly,async t=>{
 const f=await distillerFixture(t,'dispatch-race');
 assert.equal((await f.distill.execute(f.request)).state,'pending');
 const originalRead=f.distill.readResult;
 f.ready();f.distill.readResult=async identity=>{
  const payload={...f.related.payload,body:f.related.payload.body+'\nA later independently proven revision.'};payload.contentDigest=methodContentDigest(payload,sha);
  await f.p.write('owner','method',f.related.id,payload,{expectedRevision:f.related.revision});
  return originalRead(identity);
 };
 await assert.rejects(()=>f.distill.execute(f.request),{code:'geo_learning_input_stale'});
 assert.equal((await f.documents.list('owner','method')).items.length,1);
});

test('consumed-parent closures survive safe self-prior changes and reject a parent changed during the final closure comparison',localOnly,async t=>{
 const f=await distillerFixture(t,'closure-race');f.ready();
 const result=await f.distill.execute(f.request),created=await f.learning.getMethod('owner',result.methodId);
 const safe=await f.learning.amendMethod('owner',created.id,{expectedRevision:created.revision,frontmatter:created.payload.frontmatter,
  body:created.payload.body+'\nA preserved local verification.',provenance:{...created.payload.provenance,runId:f.run.id}});
 const approved=await f.learning.approve('owner',safe.id,{expectedRevision:safe.revision});
 assert.equal(await f.items.method(f.policy,approved),true,'Self-prior proofs remain valid after a later safe amendment');
 const compare=f.documents.matchesSnapshots.bind(f.documents);let mutated=false,completeClosure=false;
 f.documents.matchesSnapshots=async(owner,snapshots,options)=>{
  if(!mutated&&snapshots.some(row=>row.id===approved.id)&&snapshots.some(row=>row.id===f.related.id)){
   completeClosure=true;mutated=true;
   await f.documents.put('owner','method',f.related.id,{...f.related.payload,status:'retired'},{expectedRevision:f.related.revision});
  }
  return compare(owner,snapshots,options);
 };
 assert.equal(await f.items.method(f.policy,approved),false);
 assert.equal(completeClosure,true,'Every actual consumed parent participates in the same final comparison');
});

test('the first dispatch binding cannot be replaced after a policy generation changes',localOnly,async t=>{
 const f=await fixture(t),input={action:'fixed',relatedMethods:[]};
 const ref=await f.p.freezeInput('owner',f.policy,'fixed-policy-dispatch',input,[]);
 assert.ok(ref);
 await assert.rejects(()=>f.p.freezeInput('owner',{...f.policy,revision:f.policy.revision+1},'fixed-policy-dispatch',input,[]),{code:'geo_learning_input_stale'});
});

test('generated merge bodies retain only the exact recorded retirement exception across safe self-prior versions',localOnly,async t=>{
 const f=await fixture(t),a=await f.method('generated-merge-a',await f.source('generated-merge-source-a')),
  b=await f.method('generated-merge-b',await f.source('generated-merge-source-b','editor2'));
 const learning=new LearningService({documents:f.documents,contextProvenance:f.p}),id=learnedMethodId('generated-merge');
 const consolidation=new MethodConsolidation({learning,contextProvenance:f.p,dispatch:async()=>({runId:'merge-local'}),
  readResult:async()=>({status:'succeeded',output:{revisions:[{operation:'create',methodId:id,assignment:'merge',skill:skill({...frontmatter,name:'generated-merge'},BODY)}]}})});
 assert.equal((await consolidation.buildGroup({id:'generated-merge-proof',userId:'owner',payload:{sourceProjectId:f.project.id}},[a,b],
  {assignments:[{ASSIGNMENT:'merge',RELATION_TYPE:'merge',SKILLS:[a.id,b.id],REASON:'Keep all checks in one reusable method.'}]})).applied,1);
 let target=await learning.getMethod('owner',id);
 const retiredA=await f.p.retireMerged('owner',a,target,{proposedBy:'consolidate:generated-merge-proof',reason:'Recorded exact merge.'});
 const retiredB=await f.p.retireMerged('owner',b,target,{proposedBy:'consolidate:generated-merge-proof',reason:'Recorded exact merge.'});
 assert.equal(await f.items.method(f.policy,retiredA),false,'A retired source never becomes a context root');
 assert.equal(await f.items.method(f.policy,target),true);
 target=await learning.amendMethod('owner',id,{expectedRevision:target.revision,frontmatter:target.payload.frontmatter,
  body:target.payload.body+'\nOne additional local verification.',provenance:target.payload.provenance});
 target=await learning.approve('owner',id,{expectedRevision:target.revision});
 assert.equal(await f.items.method(f.policy,target),true,'A safe self-prior version retains the exact merge proof');
 await f.documents.put('owner','method',b.id,{...retiredB.payload,statusReason:'A later independent withdrawal.'},{expectedRevision:retiredB.revision});
 assert.equal(await f.items.method(f.policy,target),false,'A later withdrawal does not inherit the earlier merge exception');
});

test('shared-part factoring keeps the created dependency and rewritten consumer immediately usable',localOnly,async t=>{
 const f=await fixture(t),a=await f.method('factor-input-a',await f.source('factor-source-a')),
  b=await f.method('factor-input-b',await f.source('factor-source-b','editor2'));

 const factorName='independent-shared-factor',factorId=learnedMethodId(factorName),factorFm={...frontmatter,name:factorName};
 const factorDigest=methodContentDigest({frontmatter:factorFm,body:BODY},sha);
 const amendedFm={...a.payload.frontmatter,metadata:{...a.payload.frontmatter.metadata,depends_on:`${factorName}@${factorDigest}`}};
 const learning=new LearningService({documents:f.documents,contextProvenance:f.p});
 const cons=new MethodConsolidation({learning,contextProvenance:f.p,dispatch:async()=>({runId:'local-factor-builder'}),readResult:async()=>({status:'succeeded',output:{revisions:[
  {operation:'create',methodId:factorId,assignment:'factor',dependencies:[],skill:skill(factorFm,BODY)},
  {operation:'amend',methodId:a.id,baseDigest:a.payload.contentDigest,assignment:'factor',dependencies:[{name:factorName,digest:factorDigest}],skill:skill(amendedFm,a.payload.body+'\nReuse the shared denominator verification.')}
 ]}})});
 const result=await cons.buildGroup({id:'factor-batch',userId:'owner',payload:{sourceProjectId:f.project.id}},[a,b],
  {assignments:[{ASSIGNMENT:'factor',RELATION_TYPE:'shared_part',SKILLS:[a.id,b.id],REASON:'Factor shared denominator verification and reuse the exact result.'}]});
 assert.equal(result.applied,2);
 const factor=await learning.getMethod('owner',factorId);let rewritten=await learning.getMethod('owner',a.id);
 rewritten=await learning.approve('owner',a.id,{expectedRevision:rewritten.revision});
 assert.equal(factor.payload.status,'approved');assert.equal(rewritten.payload.status,'approved');
 assert.equal(await f.items.method(f.policy,factor),true,'The factor remains usable after this exact same-result transformation');
 assert.equal(await f.items.method(f.policy,rewritten),true,'The rewritten consumer can use the factor without a false historical cycle');
});

async function compoundFixture(t,{both=true,telemetry=false,transitive=false}={}) {
 const f=await fixture(t),c=await f.method('compound-c',await f.source('compound-source-c'),BODY+'\nAn actual undeclared source-c check.'),
  a0=await f.method('compound-a',await f.source('compound-source-a'),BODY,transitive?{dependencies:[{name:c.payload.frontmatter.name,digest:c.payload.contentDigest}]}:{}),
  b=await f.method('compound-b',await f.source('compound-source-b','editor2'));
 const a=telemetry?await f.documents.put('owner','method',a0.id,{...a0.payload,loadCount:1},{expectedRevision:a0.revision,telemetry:true}):a0;
 const learning=new LearningService({documents:f.documents,contextProvenance:f.p});let calls=0,notices=0;
 learning.onMountChange=()=>notices++;
 const factorName='compound-factor',factorId=learnedMethodId(factorName),fm={...frontmatter,name:factorName},factorDigest=methodContentDigest({frontmatter:fm,body:BODY},sha);
 const revisions=[{operation:'create',methodId:factorId,assignment:'factor',dependencies:[],skill:skill(fm,BODY)},...[a,...both?[b]:[]].map(row=>({operation:'amend',methodId:row.id,baseDigest:row.payload.contentDigest,assignment:'factor',
  dependencies:[{name:factorName,digest:factorDigest}],skill:skill({...row.payload.frontmatter,metadata:{...row.payload.frontmatter.metadata,depends_on:`${factorName}@${factorDigest}`}},BODY+'\nUse the exact shared verification.') }))];
 const cons=new MethodConsolidation({learning,contextProvenance:f.p,dispatch:async()=>{calls++;return {runId:'compound-local'};},readResult:async()=>({status:'succeeded',output:{revisions}})});
 const members=[a,b,...transitive?[]:[c]],job={id:'compound-batch',userId:'owner',payload:{sourceProjectId:f.project.id}},decision={assignments:[{ASSIGNMENT:'factor',RELATION_TYPE:'shared_part',SKILLS:[a.id,b.id],REASON:'Factor shared verification while preserving every consumed source.'}]};
 const execute=()=>cons.buildGroup(job,members,decision);
 const outputs=async()=>Promise.all([factorId,a.id,...both?[b.id]:[]].map(id=>f.documents.get('owner','method',id)));
 return {...f,a,b,c,factorId,learning,cons,job,decision,members,revisions,execute,outputs,calls:()=>calls,notices:()=>notices};
}
async function approveOutputs(f) {
 const rows=[];
 for(let row of await f.outputs()) {
  if(row.payload.status==='candidate')row=await f.learning.approve('owner',row.id,{expectedRevision:row.revision});
  rows.push(row);
 }
 return rows;
}

test('compound factoring applies two consumers atomically with exact telemetry-gap pins and an undeclared third source',localOnly,async t=>{
 const f=await compoundFixture(t,{telemetry:true});
 assert.equal((await f.documents.history('owner','method',f.a.id)).some(row=>row.revision===f.a.revision),false);
 assert.equal((await f.execute()).applied,3);assert.equal(f.notices(),1);
 const outputs=await approveOutputs(f);
 for(const row of outputs)assert.equal(await f.items.method(f.policy,row),true,row.id);
 const proof=await f.p.proofFor('owner','method',outputs[0]),receipt=(await f.documents.get('owner','geo-plan-context',proof.compoundApplicationRef)).payload;
 assert.deepEqual(new Set(proof.sources.map(source=>source.runId)),new Set(['compound-source-a','compound-source-b','compound-source-c']));
 assert.deepEqual(new Set(proof.parents.map(parent=>parent.id)),new Set([f.a.id,f.b.id,f.c.id]));
 assert.ok(receipt.inputClosure.some(row=>row.id===f.a.id&&row.revision===f.a.revision));
 assert.equal(receipt.outputs.length,3);
 const before=outputs.map(row=>row.revision),calls=f.calls(),notices=f.notices();
 assert.equal((await f.execute()).applied,3);assert.equal(f.calls(),calls,'A committed same-result retry performs no new dispatch');assert.equal(f.notices(),notices);
 assert.deepEqual((await f.outputs()).map(row=>row.revision),before);
});

for(const damage of ['retire','delete','body','attachment','foreign','foreign-history','actor','independent'])test(`compound certified historical inputs refuse later ${damage}`,localOnly,async t=>{
 const f=await compoundFixture(t);await f.execute();const outputs=await approveOutputs(f),a=outputs[1];
 if(damage==='retire')await f.documents.put('owner','method',a.id,{...a.payload,status:'retired'},{expectedRevision:a.revision});
 if(damage==='delete')await f.documents.remove('owner','method',a.id,a.revision);
 if(damage==='body')await f.documents.put('owner','method',a.id,{...a.payload,body:a.payload.body+'\nUnproven bytes.'},{expectedRevision:a.revision});
 if(damage==='attachment')await f.documents.put('owner','method',a.id,{...a.payload,files:{'scripts/new.mjs':'export const bad = true;'}},{expectedRevision:a.revision});
 if(damage==='foreign'||damage==='foreign-history') {
  const bad=await f.documents.put('owner','method',a.id,{...a.payload,provenance:{...a.payload.provenance,sourceProjectIds:[f.project.id,'foreign-project']}},{expectedRevision:a.revision});
  if(damage==='foreign-history')await f.documents.put('owner','method',a.id,a.payload,{expectedRevision:bad.revision});
 }
 if(damage==='actor') {
  const source=(await f.p.proofFor('owner','method',outputs[0])).sources.find(row=>row.runId==='compound-source-c');
  const input=await f.documents.get('owner','geo-plan-context',source.inputReceiptRefs[0]);
  await f.documents.put('owner','geo-plan-context',input.id,{...input.payload,actor:{...input.payload.actor,id:'editor2'}},{expectedRevision:input.revision,projectId:f.project.id});
 }
 if(damage==='independent') {
  const payload={...a.payload,body:a.payload.body+'\nAn independent later source revision.'};payload.contentDigest=methodContentDigest(payload,sha);
  await f.p.write('owner','method',a.id,payload,{expectedRevision:a.revision});
 }
 for(const id of [f.factorId,f.b.id])assert.equal(await f.items.method(f.policy,await f.documents.get('owner','method',id)),false,`${damage}: ${id}`);
});

for(const corruption of ['missing','altered','wrong-policy','wrong-output'])test(`compound history has no authority with a ${corruption} receipt`,localOnly,async t=>{
 const f=await compoundFixture(t);await f.execute();const rows=await approveOutputs(f),proof=await f.p.proofFor('owner','method',rows[0]);
 const receipt=await f.documents.get('owner','geo-plan-context',proof.compoundApplicationRef);
 if(corruption==='missing')await f.documents.remove('owner','geo-plan-context',receipt.id,receipt.revision);
 else {
  const payload=structuredClone(receipt.payload);
  if(corruption==='altered')payload.inputs.pop();
  if(corruption==='wrong-policy')payload.controlProjectId='foreign-project';
  if(corruption==='wrong-output')payload.outputs[0].after.contentDigest='a'.repeat(64);
  await f.documents.put('owner','geo-plan-context',receipt.id,payload,{expectedRevision:receipt.revision,projectId:f.project.id});
 }
 assert.equal(await f.items.method(f.policy,rows[0]),false);
});

for(const failAfter of [1,2])test(`compound failure after ${failAfter} successful writes rolls back bodies, proofs, receipt and mount notification`,localOnly,async t=>{
 const f=await compoundFixture(t),write=f.p.write.bind(f.p);let writes=0;
 f.p.write=async(...args)=>{if(writes===failAfter)throw new Error('injected compound write failure');const row=await write(...args);writes++;return row;};
 await assert.rejects(f.execute(),/injected compound write failure/);
 assert.equal(await f.documents.get('owner','method',f.factorId),null);
 assert.equal((await f.documents.get('owner','method',f.a.id)).revision,f.a.revision);
 assert.equal((await f.documents.get('owner','method',f.b.id)).revision,f.b.revision);
 assert.equal((await f.p.rows('owner','geo-plan-context',{recordType:'geo-context-compound-application'},null)).length,0);
 assert.equal(f.notices(),0);
 f.p.write=write;assert.equal((await f.execute()).applied,3,'The same stored result remains reusable after full rollback');
 assert.equal(f.notices(),1);
});

test('a transitive actual input withdrawn during final compound authorization rolls the entire application back',localOnly,async t=>{
 const f=await compoundFixture(t,{transitive:true}),compare=f.documents.matchesSnapshots.bind(f.documents);let changed=false;
 f.documents.matchesSnapshots=async(owner,snapshots,options)=>{
  if(!changed&&snapshots.some(row=>row.id===f.factorId)&&snapshots.some(row=>row.id===f.c.id)
   &&(await f.p.rows('owner','geo-plan-context',{recordType:'geo-context-compound-application'},null)).length){
   changed=true;const c=await f.documents.get('owner','method',f.c.id);
   await f.documents.put('owner','method',c.id,{...c.payload,status:'retired'},{expectedRevision:c.revision});
  }
  return compare(owner,snapshots,options);
 };
 await assert.rejects(f.execute(),{code:'geo_learning_compound_invalid'});
 assert.equal(changed,true);assert.equal(await f.documents.get('owner','method',f.factorId),null);assert.equal(f.notices(),0);
 assert.equal((await f.documents.get('owner','method',f.c.id)).payload.status,'approved','The failed transaction also rolls back its test-owned withdrawal');
});

test('compound certificates cannot bypass a live kind/id cycle or become a historical root authority',localOnly,async t=>{
 const f=await compoundFixture(t);await f.execute();const rows=await approveOutputs(f);
 assert.equal(await f.items.authorize(f.policy,'method',rows[0],new Set([`method:${rows[0].id}`])),false);
 assert.equal(await f.items.authorize(f.policy,'method',rows[0],new Set(),{kind:'compound-current',referenceId:'gca_fabricated'}),false);
 assert.equal(await f.items.method(f.policy,f.a),false,'A historical input is never a current mountable root');
 const before=f.items.maxWork;f.items.maxWork=1;
 assert.equal(await f.items.method(f.policy,rows[0]),false,'A compound certificate retains the shared authorization work budget');f.items.maxWork=before;
});

test('compound frozen closure retains a transitive input omitted from all model-supplied root members',localOnly,async t=>{
 const f=await compoundFixture(t,{transitive:true});await f.execute();const rows=await approveOutputs(f);
 const proof=await f.p.proofFor('owner','method',rows[0]),receipt=(await f.documents.get('owner','geo-plan-context',proof.compoundApplicationRef)).payload;
 assert.equal(proof.parents.some(parent=>parent.id===f.c.id),false,'C was ancestry of A rather than an actual direct builder input');
 assert.equal(receipt.inputClosure.some(row=>row.id===f.c.id),true);
 for(const row of rows)assert.equal(await f.items.method(f.policy,row),true);
 await f.documents.put('owner','method',f.c.id,{...f.c.payload,status:'retired'},{expectedRevision:f.c.revision});
 for(const row of rows)assert.equal(await f.items.method(f.policy,await f.documents.get('owner','method',row.id)),false);
});

test('compound exact output proofs remain valid through approval, display and telemetry revisions without history rows',localOnly,async t=>{
 const f=await compoundFixture(t);await f.execute();let rows=await approveOutputs(f);
 rows=await Promise.all(rows.map(row=>f.documents.put('owner','method',row.id,{...row.payload,display:{title:'A reader label'},loadCount:7},{expectedRevision:row.revision,telemetry:true})));
 for(const row of rows){
  assert.equal((await f.documents.history('owner','method',row.id)).some(version=>version.revision===row.revision),false);
  assert.equal(await f.items.method(f.policy,row),true);
 }
 const notices=f.notices(),calls=f.calls();assert.equal((await f.execute()).applied,3);assert.equal(f.calls(),calls);assert.equal(f.notices(),notices);
});

test('one hourly job applies and stamps both independent groups before the next hourly pass',localOnly,async t=>{
 const f=await fixture(t),a=await f.method('multi-a',await f.source('multi-a')),
  b=await f.method('multi-b',await f.source('multi-b','editor2')),
  c=await f.method('multi-c',await f.source('multi-c')),
  d=await f.method('multi-d',await f.source('multi-d','editor2'));
 const learning=new LearningService({documents:f.documents,contextProvenance:f.p}),requests=new Map();let builders=0;
 const factor=(members)=>members.some(row=>row.id===a.id)?'multi-factor-first':'multi-factor-second';
 const cons=new MethodConsolidation({learning,contextProvenance:f.p,similarity:{pairs:async()=>[{a:a.id,b:b.id,overlap:2},{a:c.id,b:d.id,overlap:2}]},
  dispatch:async request=>{const runId='local-'+requests.size;requests.set(runId,request);if(request.input.action==='build')builders++;return {runId};},
  readResult:async({runId})=>{const req=requests.get(runId),members=req.input.methods,name=factor(members);return {status:'succeeded',output:req.input.action==='decide'?{assignments:[{ASSIGNMENT:name,RELATION_TYPE:'abstract_pattern',SKILLS:members.map(row=>row.id)}]}:{revisions:[{operation:'create',assignment:name,methodId:learnedMethodId(name),skill:skill({...frontmatter,name},BODY),dependencies:[]}]}};}});
 const job={id:'one-hourly-job',userId:'owner',projectId:'_learning',payload:{sourceProjectId:f.project.id}};
 const result=await cons.sleep({job});
 assert.equal(result.groupsFormed,2);assert.equal(result.builds,2);assert.equal(builders,2);
 assert.ok(await f.documents.get('owner','method',learnedMethodId('multi-factor-first')));assert.ok(await f.documents.get('owner','method',learnedMethodId('multi-factor-second')));
 assert.ok((await f.documents.get('owner','method',c.id)).payload.learning.decided,'The failed group was nevertheless stamped decided');
 const retry=await cons.sleep({job:{...job,id:'next-hourly-job'}});assert.equal(retry.skippedUnchanged,2);assert.equal(retry.builds,0);
});


async function hourlyGroupsFixture(t,{failSecond=false,failSecondApply=false}={}) {
 const f=await fixture(t),a=await f.method('hourly-a',await f.source('hourly-a')),
  b=await f.method('hourly-b',await f.source('hourly-b','editor2')),
  c=await f.method('hourly-c',await f.source('hourly-c')),
  d=await f.method('hourly-d',await f.source('hourly-d','editor2'));
 const learning=new LearningService({documents:f.documents,contextProvenance:f.p}),requests=new Map(),builders=[],decisions=[],noops=[];let failed=false;
 const put=f.documents.put.bind(f.documents);
 if(failSecondApply)f.documents.put=async(user,kind,id,payload,options)=>{
  if(payload.recordType==='geo-context-compound-application'&&payload.outputs.some(row=>row.id===learnedMethodId('hourly-factor-second'))&&!failed){failed=true;throw new Error('Second group application failed');}
  return put(user,kind,id,payload,options);
 };
 const factor=members=>members.some(row=>row.id===a.id)?'hourly-factor-first':'hourly-factor-second';
 const cons=new MethodConsolidation({learning,contextProvenance:f.p,onNoop:(reason,count=1)=>noops.push({reason,count}),similarity:{pairs:async()=>[{a:a.id,b:b.id,overlap:2},{a:c.id,b:d.id,overlap:2}]},
  dispatch:async request=>{
   const runId='hourly-local-'+requests.size;requests.set(runId,request);
   (request.input.action==='build'?builders:decisions).push(request);
   return {runId};
  },
  readResult:async({runId})=>{
   const req=requests.get(runId),members=req.input.methods,name=factor(members);
   if(req.input.action==='build'&&name==='hourly-factor-second'&&failSecond&&!failed){failed=true;return {status:'failed'};}
   return {status:'succeeded',output:req.input.action==='decide'?{assignments:[{ASSIGNMENT:name,RELATION_TYPE:'abstract_pattern',SKILLS:members.map(row=>row.id),REASON:'Extract an unchanged check.'}]}
    :{revisions:[{operation:'create',assignment:name,methodId:learnedMethodId(name),skill:skill({...frontmatter,name},BODY),dependencies:[]}]}};
  }});
 const job={id:'hourly-multi-group',userId:'owner',projectId:'_learning',payload:{sourceProjectId:f.project.id}};
 return {...f,a,b,c,d,learning,cons,job,builders,decisions,noops};
}

test('an hourly failed second group stays unstamped and succeeds next hour beside the first completed group',localOnly,async t=>{
 const f=await hourlyGroupsFixture(t,{failSecond:true});
 const first=await f.cons.sleep({job:f.job});assert.equal(first.builds,1);assert.equal(f.noops.find(item=>item.reason==='build_failed')?.count,1);
 for(const id of [f.c.id,f.d.id])assert.equal((await f.documents.get('owner','method',id)).payload.learning?.decided??null,null);
 assert.equal(await f.documents.get('owner','method',learnedMethodId('hourly-factor-second')),null);
 const second=await f.cons.sleep({job:{...f.job,id:'hourly-multi-next'}});
 assert.equal(second.builds,1);assert.equal(second.skippedUnchanged,1);
 assert.ok(await f.documents.get('owner','method',learnedMethodId('hourly-factor-second')));
 for(const id of [f.c.id,f.d.id])assert.ok((await f.documents.get('owner','method',id)).payload.learning.decided);
 assert.equal(f.builders.length,3);assert.equal(new Set(f.builders.map(request=>request.dispatchId)).size,2,'An unfinished group retains the exact original logical dispatcher identity');
 const third=await f.cons.sleep({job:{...f.job,id:'hourly-multi-final'}});assert.equal(third.skippedUnchanged,2);assert.equal(third.builds,0);
});

test('one job commits disjoint compound groups and adopts their exact original or successor inputs independently',localOnly,async t=>{
 const first=await compoundFixture(t);await first.execute();await approveOutputs(first);
 const a=await first.method('disjoint-a',await first.source('disjoint-source-a')),b=await first.method('disjoint-b',await first.source('disjoint-source-b','editor2'));
 const id=learnedMethodId('disjoint-created'),decision={assignments:[{ASSIGNMENT:'disjoint',RELATION_TYPE:'abstract_pattern',SKILLS:[a.id,b.id]}]};
 let dispatches=0;
 const second=new MethodConsolidation({learning:first.learning,contextProvenance:first.p,dispatch:async()=>{dispatches++;return {runId:'disjoint-builder'};},
  readResult:async()=>({status:'succeeded',output:{revisions:[{operation:'create',methodId:id,assignment:'disjoint',skill:skill({...frontmatter,name:'disjoint-created'},BODY)}]}})});
 assert.equal((await second.buildGroup(first.job,[a,b],decision)).applied,1);
 assert.equal((await first.p.rows('owner','geo-plan-context',{recordType:'geo-context-compound-application',producerJobId:first.job.id},null)).length,2);
 const current=await Promise.all(first.members.map(row=>first.documents.get('owner','method',row.id)));
 assert.equal((await first.cons.buildGroup(first.job,current,first.decision)).applied,3);
 assert.equal(first.calls(),1);
 assert.equal((await second.buildGroup(first.job,[a,b],decision)).applied,1);assert.equal(dispatches,1);
 assert.equal(await first.items.method(first.policy,await first.documents.get('owner','method',id)),true);
});

test('same-group replay refuses changed decision, damaged supplied bytes, reduced membership and unrelated successor proofs',localOnly,async t=>{
 const f=await compoundFixture(t);await f.execute();await approveOutputs(f);
 await assert.rejects(()=>f.cons.buildGroup(f.job,f.members,{assignments:[{...f.decision.assignments[0],REASON:'A different original decision.'}]}),{code:'geo_learning_input_stale'});
 const damaged=f.members.map(row=>({...row,payload:{...row.payload}}));damaged[0].payload.body+='\nA substituted purported original body.';
 await assert.rejects(()=>f.cons.buildGroup(f.job,damaged,f.decision),{code:'geo_learning_input_stale'});
 await assert.rejects(()=>f.cons.buildGroup(f.job,f.members.slice(0,2),f.decision),{code:'geo_learning_input_stale'});
 const extra=await f.method('unexpected-extra',await f.source('unexpected-extra-source'));
 await assert.rejects(()=>f.cons.buildGroup(f.job,[...f.members,extra],f.decision),{code:'geo_learning_input_stale'});
 const current=await f.documents.get('owner','method',f.a.id),payload={...current.payload,body:current.payload.body+'\nA later independent generation.'};payload.contentDigest=methodContentDigest(payload,sha);
 await f.p.write('owner','method',current.id,payload,{expectedRevision:current.revision});
 await assert.rejects(()=>f.execute(),{code:'geo_learning_compound_invalid'});
 assert.equal(f.calls(),1,'Every stale replay is rejected before another dispatcher request');
});

test('a resumed sleep adopts its exact already-committed successor group before another decision or build',localOnly,async t=>{
 const f=await compoundFixture(t);await f.execute();await approveOutputs(f);
 const current=await Promise.all(f.members.map(row=>f.documents.get('owner','method',row.id)));
 f.cons.similarity={pairs:async()=>[{a:current[0].id,b:current[1].id,overlap:2},{a:current[1].id,b:current[2].id,overlap:2}]};
 const result=await f.cons.sleep({job:f.job});assert.equal(result.builds,1);assert.equal(f.calls(),1,'The process-group replay precedes both model steps');
 for(const row of current)assert.ok((await f.documents.get('owner','method',row.id)).payload.learning.decided);
});

test('a second group transaction failure preserves the first receipt and leaves the second retryable without a completion stamp',localOnly,async t=>{
 const f=await hourlyGroupsFixture(t,{failSecondApply:true});
 const first=await f.cons.sleep({job:f.job});assert.equal(first.builds,1);
 assert.equal((await f.p.rows('owner','geo-plan-context',{recordType:'geo-context-compound-application',producerJobId:f.job.id},null)).length,1);
 assert.equal((await f.documents.get('owner','method',f.c.id)).payload.learning?.decided??null,null);
 assert.equal((await f.documents.get('owner','method',f.d.id)).payload.learning?.decided??null,null);
 assert.equal(await f.documents.get('owner','method',learnedMethodId('hourly-factor-second')),null);
 const next=await f.cons.sleep({job:{...f.job,id:'hourly-after-rollback'}});
 assert.equal(next.builds,1);assert.equal(next.skippedUnchanged,1);
 assert.ok(await f.documents.get('owner','method',learnedMethodId('hourly-factor-second')));
 assert.equal(new Set(f.builders.map(row=>row.dispatchId)).size,2);
});

for(const damage of ['frozen-input','frozen-input-digest','committed-output'])test(`group replay refuses ${damage} substitution without dispatching again`,localOnly,async t=>{
 const f=await compoundFixture(t);await f.execute();const outputs=await approveOutputs(f),proof=await f.p.proofFor('owner','method',outputs[0]);
 const receipt=(await f.documents.get('owner','geo-plan-context',proof.compoundApplicationRef)).payload;
 if(damage.startsWith('frozen-input')){
  const input=await f.documents.get('owner','geo-plan-context',receipt.generationInputRef);
  await f.documents.put('owner','geo-plan-context',input.id,{...input.payload,...damage==='frozen-input'?{parents:input.payload.parents.slice(0,2)}:{inputDigest:'0'.repeat(64)}},{expectedRevision:input.revision,projectId:f.project.id});
 }else{
  const row=outputs[0];await f.documents.put('owner','method',row.id,{...row.payload,files:{'scripts/corrupted.mjs':'export const forged = true;'}},{expectedRevision:row.revision});
 }
 await assert.rejects(f.execute(),{code:damage.startsWith('frozen-input')?'geo_learning_input_stale':'geo_learning_compound_invalid'});
 assert.equal(f.calls(),1);
});

test('a lost completion stamp is repaired next hour by adopting the exact paid group result rather than recreating its output',localOnly,async t=>{
 const f=await hourlyGroupsFixture(t),stamp=f.learning.recordDecided.bind(f.learning);let drop=true;
 f.learning.recordDecided=async(...args)=>{if(drop)throw new Error('The optional completion stamp was unavailable');return stamp(...args);};
 assert.equal((await f.cons.sleep({job:f.job})).builds,2);
 for(const id of [f.a.id,f.b.id,f.c.id,f.d.id])assert.equal((await f.documents.get('owner','method',id)).payload.learning?.decided??null,null);
 const calls=f.builders.length;drop=false;
 const next=await f.cons.sleep({job:{...f.job,id:'hourly-after-lost-stamp'}});
 assert.equal(next.builds,2);assert.equal(f.builders.length,calls,'A cross-job exact result adoption never requests another builder');
 const receipts=await f.p.rows('owner','geo-plan-context',{recordType:'geo-context-compound-application'},null);assert.equal(receipts.length,2,'Adoption does not manufacture another application receipt');
 for(const id of [f.a.id,f.b.id,f.c.id,f.d.id])assert.ok((await f.documents.get('owner','method',id)).payload.learning.decided);
 const later=await f.cons.sleep({job:{...f.job,id:'hourly-after-repaired-stamp'}});assert.equal(later.skippedUnchanged,2);assert.equal(later.builds,0);
});

test('cross-job group adoption requires the exact original decision and does not consume a different newly requested result',localOnly,async t=>{
 const f=await compoundFixture(t);await f.execute();await approveOutputs(f);
 const members=await Promise.all(f.members.map(row=>f.documents.get('owner','method',row.id))),name='a-different-group-result',id=learnedMethodId(name);
 let calls=0;
 const decision={assignments:[{ASSIGNMENT:'new-intent',RELATION_TYPE:'abstract_pattern',SKILLS:members.map(row=>row.id),REASON:'A new independent result requested by a different job.'}]};
 const cons=new MethodConsolidation({learning:f.learning,contextProvenance:f.p,dispatch:async()=>{calls++;return {runId:'new-intent-model'};},
  readResult:async()=>({status:'succeeded',output:{revisions:[{operation:'create',methodId:id,assignment:'new-intent',skill:skill({...frontmatter,name},BODY),dependencies:[]}]}})});
 const result=await cons.buildGroup({...f.job,id:'genuinely-new-job'},members,decision);
 assert.equal(result.applied,1);assert.equal(calls,1);assert.ok(await f.documents.get('owner','method',id));
 assert.equal(await f.items.method(f.policy,await f.documents.get('owner','method',id)),true);
});
