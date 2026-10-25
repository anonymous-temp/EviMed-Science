import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { methodContentDigest } from '@evimed/domain';
import { GeoContextProvenance } from '../src/geoContextProvenance.mjs';
import { ContextItemAuthorization, contextPolicyIdentity } from '../src/geoContextItems.mjs';
import { createNativeInputFixture } from './helpers/geoNativeInputFixture.mjs';
import { normalizeTranscript } from '../src/dshRuntimeAdapter.mjs';
import { BODY, frontmatter } from './helpers/handbookFixture.mjs';
const skillText=()=>['---',...Object.entries(frontmatter).flatMap(([key,value])=>typeof value==='object'?[`${key}:`,...Object.entries(value).map(([field,item])=>`  ${field}: ${JSON.stringify(item)}`)]:[`${key}: ${JSON.stringify(value)}`]),'---',BODY].join('\n');
const options={skip:!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL,timeout:60000};
const sha256=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const f=await createNativeInputFixture(t,4), request=f.request('correction');
  request.content=[{type:'text',text:'Always preserve the denominator.'}];
  const frame=await f.prepare(request);
  await f.execute(request,frame,async()=>{await f.journal.beforeForward(request);f.journal.observe(request,{state:'accepted',authority:'native-mux'});});
  const transcript=normalizeTranscript('root',[{type:'turn/start',seq:0,data:{turn:1}},{type:'user/message',seq:1,data:{source:{kind:'user',rpcId:request.requestId},content:request.content}},{type:'turn/end',seq:2,data:{reason:{kind:'completed'}}}]);
  const run={id:'source-run',userId:'owner',projectId:f.project.id,sessionId:'root',nativeTurn:{startSeq:0},kernelRequestIds:[request.requestId],automated:false};
  const policies={forProject:async project=>project.id===f.project.id?f.policy:{kind:'owned',ownerId:project.userId,controlProjectId:project.id}};
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
test('production producer preserves two safe body revisions and independently verifies accepted editor input',options,async t=>{
  const f=await fixture(t),observation=await f.provenance.observeRun(f.project,f.run);
  assert.equal(observation.complete,true);assert.deepEqual(observation.actors.map(actor=>actor.id),['editor']);
  assert.equal(observation.humanText,'Always preserve the denominator.');
  const first=await f.create();assert.equal(await f.items.method(f.policy,first),true);
  const second=await f.create('lesson',first,{body:BODY+'\nPreserve every denominator.'});
  assert.equal(await f.items.method(f.policy,second),true);
  const receipts=await f.documents.list('owner','geo-plan-context',{filter:{recordType:'geo-context-producer-proof'}});
  assert.equal(receipts.items.length,2);assert.ok(receipts.items.every(row=>!JSON.stringify(row.payload).includes('Always preserve')));
  await f.store.removeMember({geoId:f.geo.id,userId:'editor'});
  assert.equal(await f.items.method(f.policy,second),true,'Accepted historical work retains its original actor after membership changes');
});
test('unproved legacy history, automated source and body mutation do not acquire shared proof',options,async t=>{
  const f=await fixture(t),first=await f.create();
  assert.equal(await f.items.method(f.policy,{...first,payload:{...first.payload,body:'Changed without a producer'}}),false);
  f.run.automated=true;
  await assert.rejects(f.create('automated'),{code:'geo_learning_source_unverified'});
  f.run.automated=false;
  const legacy=await f.documents.put('owner','method','legacy',{...first.payload,frontmatter:{...frontmatter,name:'legacy'}},{expectedRevision:0});
  await assert.rejects(f.create('legacy',legacy),{code:'geo_learning_target_unverified'});
});
test('scoped method library refuses foreign bodies before hydration or ranking',options,async t=>{
  const f=await fixture(t),good=await f.create();
  await f.documents.put('owner','method','foreign',{...good.payload,provenance:{runId:'foreign-run',sourceProjectId:'other'}},{expectedRevision:0});
  const get=f.documents.get.bind(f.documents);f.documents.get=async(user,kind,id,...rest)=>{if(kind==='method'&&id==='foreign')assert.fail('Foreign body hydration');return get(user,kind,id,...rest);};
  assert.deepEqual((await f.provenance.scopedMethods('owner',f.policy)).map(row=>row.id),['lesson']);
});

test('editor correction lesson runs the real scoped distillation producer and materializes verified attachment bytes',options,async t=>{
  const f=await fixture(t);
  const {LearningService}=await import(process.env.N12_LEARNING_MODULE ?? '../src/learningService.mjs');
  const {LearningTriggers}=await import('../src/learningTriggers.mjs');
  const {MethodDistillationRuns}=await import('../src/methodDistillationRuns.mjs');
  const {persistRunTranscript}=await import('../src/runTranscripts.mjs');
  const {materializeCapsuleMethods}=await import('../src/capsuleMethods.mjs');
  const {learnedMethodDirectoryName}=await import('../src/learnedMethodMount.mjs');
  const fs=await import('node:fs/promises'),path=await import('node:path');
  Object.assign(f.run,{status:'succeeded',effectiveAgentId:'geo-content',corrections:1,steers:[{text:'Always preserve the denominator.',requestId:'correction'}],transcript:{completeness:'complete'}});
  await persistRunTranscript({project:f.project,run:f.run,sessions:[{sessionId:f.run.sessionId,parentSessionId:null,label:'root',transcript:f.transcript}]});
  const queued=[],jobs={enqueue:async(userId,kind,payload,opts)=>{const job={id:`job-${queued.length}`,userId,kind,payload,...opts};queued.push(job);return job;}};
  const learning=new LearningService({documents:f.documents,jobs,contextProvenance:f.provenance});
  const triggers=new LearningTriggers({jobs,agentRuns:{list:async()=>[f.run],runWorkflowProjection:async()=>null},contextProvenance:f.provenance});
  assert.deepEqual((await triggers.afterRun(f.project,f.run)).queued,['correction']);
  assert.equal(queued[0].payload.contextPolicy.controlProjectId,f.project.id);
  let input;
  const skill=skillText();
  const distillation=new MethodDistillationRuns({learning,jobs,contextProvenance:f.provenance,
    dispatch:async request=>{input=request.input;return {runId:'distiller',sessionId:'distiller-session'};},
    readResult:async()=>({status:'succeeded',output:{skill,candidate:{operation:'create',files:{'scripts/denominator.txt':'print("denominator")'},evidence:[{runId:f.run.id,seqRange:[1,1],quote:'Always preserve the denominator.'}]}}})});
  const result=await distillation.execute({job:queued[0],project:f.project,run:f.run});
  assert.equal(result.operation,'create');assert.equal(input.relatedMethods.length,0);
  const method=await learning.getMethod('owner',result.methodId);
  assert.equal(await f.items.method(f.policy,method),true);
  assert.equal(method.payload.provenance.evidence[0].quote,'Always preserve the denominator.');
  const amended=await learning.amendMethod('owner',method.id,{expectedRevision:method.revision,frontmatter:method.payload.frontmatter,
    body:method.payload.body+'\nKeep each population tied to its source.',files:method.payload.files,provenance:method.payload.provenance});
  const approved=await learning.approve('owner',amended.id,{expectedRevision:amended.revision});
  assert.equal(await f.items.method(f.policy,approved),true,'Both original and amended producer bodies remain usable');
  assert.ok(queued.filter(job=>job.kind==='consolidate').every(job=>job.payload.sourceProjectId===f.project.id));
  const directory=path.join(f.project.workspaceDir,'accepted-methods');
  await materializeCapsuleMethods({capsules:null,learning,project:f.project,directory,contextPolicy:f.policy,contextItems:f.items,maxPromptBytes:100000});
  assert.equal(await fs.readFile(path.join(directory,learnedMethodDirectoryName(method.id),'scripts/denominator.txt'),'utf8'),'print("denominator")');
});
test('foreign name collision creates a scoped candidate and preserves foreign revision and bytes',options,async t=>{
  const f=await fixture(t),{LearningService}=await import(process.env.N12_LEARNING_MODULE ?? '../src/learningService.mjs'),{MethodDistillationRuns}=await import('../src/methodDistillationRuns.mjs');
  const {learnedMethodId}=await import(process.env.N12_LEARNING_MODULE ?? '../src/learningService.mjs');
  const id=learnedMethodId(frontmatter.name);
  const foreign=await f.documents.put('owner','method',id,{recordType:'learned-method',status:'approved',frontmatter,body:'Foreign private method',dependencies:[],contentDigest:'sha256:'+'a'.repeat(64),provenance:{runId:'foreign',sourceProjectId:'other'}},{expectedRevision:0});
  const learning=new LearningService({documents:f.documents,contextProvenance:f.provenance});
  const distillation=new MethodDistillationRuns({learning,contextProvenance:f.provenance,dispatch:async()=>assert.fail('No model'),readResult:async()=>assert.fail('No model')});
  const get=f.documents.get.bind(f.documents);f.documents.get=async(user,kind,named,...args)=>{if(kind==='method'&&named===id)assert.fail('Foreign name collision body read');return get(user,kind,named,...args);};
  const result=await distillation.applyCandidate({userId:'owner',projectId:f.project.id,payload:{trigger:'correction'}},f.run,{skill:skillText(),candidate:{operation:'create'}});
  assert.notEqual(result.methodId,id);assert.equal((await get('owner','method',id)).revision,foreign.revision);assert.equal((await get('owner','method',id)).payload.body,foreign.payload.body);
});

test('dependency withdrawal and historical shared origin cannot be laundered into ordinary consolidation',options,async t=>{
  const f=await fixture(t),dependency=await f.create('dependency');
  const dependent=await f.create('dependent',null,{dependencies:[{name:'dependency',digest:dependency.payload.contentDigest}]});
  assert.equal(await f.items.method(f.policy,dependent),true);
  await f.documents.put('owner','method',dependency.id,{...dependency.payload,status:'retired'},{expectedRevision:dependency.revision});
  assert.equal(await f.items.method(f.policy,dependent),false);
  const old=await f.create('mixed-history');
  await f.documents.put('owner','method',old.id,{...old.payload,provenance:{sourceProjectId:'other',runId:'foreign'}},{expectedRevision:old.revision});
  const get=f.documents.get.bind(f.documents);f.documents.get=async(user,kind,id,...args)=>{if(kind==='method'&&id===old.id)assert.fail('Historical shared body read in ordinary scope');return get(user,kind,id,...args);};
  assert.ok(!(await f.provenance.scopedMethods('owner')).some(row=>row.id===old.id));
});
test('shared routine counts only its project before deciding the third clean trajectory',options,async t=>{
  const f=await fixture(t),{LearningEvidence}=await import('../src/learningEvidence.mjs');
  const now=new Date('2026-10-25T00:00:00Z'),shape=[{format:'docx',structure:'report'}];
  Object.assign(f.run,{status:'succeeded',effectiveAgentId:'geo-content',finishedAt:now.toISOString(),outputFiles:['report.docx']});
  let queues=0;
  const evidence=new LearningEvidence({contextProvenance:f.provenance,now:()=>now,resolveProject:async()=>f.project,
    agentRuns:{list:async()=>[f.run]},jobs:{},triggers:{refusalFor:async()=>null,resetInstantOf:async()=>null,guestInfluenced:async()=>false,queue:async()=>{queues++;return true;}},
    feedback:{learningEvidenceOf:async()=>[{detail:{evidence:'silent',shape}}],cleanSettledRuns:async()=>[
      {runId:'foreign-1',projectId:'other',shape,at:now.toISOString()},{runId:'foreign-2',projectId:'other',shape,at:now.toISOString()}]}});
  assert.equal((await evidence.settle({job:{userId:'owner',projectId:f.project.id,payload:{runId:f.run.id}}})).routine,false);
  assert.equal(queues,0);
});

test('integrate and hourly sleep partition protected methods before related ranking and model input',options,async t=>{
  const f=await fixture(t),{MethodConsolidation}=await import('../src/methodConsolidation.mjs');
  const first=await f.create('shared-one');await f.create('shared-two');
  await f.documents.put('owner','method','ordinary',{...first.payload,frontmatter:{...frontmatter,name:'ordinary'},provenance:{sourceProjectId:'other',runId:'ordinary-run'}},{expectedRevision:0});
  const inputs=[];
  const learning={documents:f.documents,listMethods:async()=>assert.fail('Whole-account body list'),getMethod:async(user,id)=>f.documents.get(user,'method',id),
    retirementProposals:async(_user,opts)=>{assert.ok(Array.isArray(opts.items));return [];},recordDecided:async()=>null};
  const consolidation=new MethodConsolidation({learning,contextProvenance:f.provenance,dispatch:async request=>{inputs.push(request.input);return {runId:'local-distiller'};},
    readResult:async()=>({status:'succeeded',output:{assignments:[]}})});
  const get=f.documents.get.bind(f.documents);let denyOrdinary=true;
  f.documents.get=async(user,kind,id,...args)=>{if(denyOrdinary&&kind==='method'&&id==='ordinary')assert.fail('Foreign integrate body read');return get(user,kind,id,...args);};
  await consolidation.integrate({job:{id:'integrate',userId:'owner',projectId:'_learning',payload:{methodId:first.id,sourceProjectId:f.project.id}}});
  assert.ok(inputs.every(input=>input.methods.every(method=>method.id.startsWith('shared-'))));
  denyOrdinary=false;inputs.length=0;
  const result=await consolidation.sleep({job:{id:'hourly',userId:'owner',projectId:'_learning',payload:{action:'sleep'}}});
  assert.equal(result.partitions.length,2);
  assert.ok(inputs.every(input=>input.methods.every(method=>method.id.startsWith('shared-'))||input.methods.every(method=>method.id==='ordinary')));
});

test('private applied handbook freezes candidate source and dependencies without cross-project same-name replacement',options,async t=>{
  const f=await fixture(t),{HandbookConsolidation,capabilityHandbookId}=await import('../src/handbookConsolidation.mjs');
  const {LearningService}=await import(process.env.N12_LEARNING_MODULE ?? '../src/learningService.mjs'),{registry}=await import('./helpers/handbookFixture.mjs');
  f.run.effectiveAgentId='geo-content';f.run.status='succeeded';
  const candidate=await f.create('handbook-candidate',null,{recordType:'handbook-candidate',status:'candidate',capabilityId:'geo-content',candidateRevision:1,
    provenance:{runId:f.run.id,sourceProjectId:f.project.id,sourceProjectIds:[f.project.id],derivedFrom:'reviewer'}});
  const foreignId=capabilityHandbookId('geo-content','handbook-candidate');
  const foreign=await f.documents.put('owner','method',foreignId,{recordType:'capability-handbook',status:'active',body:'Foreign handbook',source:{projectId:'other'}},{expectedRevision:0});
  const jobs={finishWithLease:async(_owner,_id,_lease,result,operation)=>f.documents.database.transaction(client=>f.documents.database.withTransactionClient(client,async()=>{await operation(client);return {result};}))};
  const learning=new LearningService({documents:f.documents,jobs,contextProvenance:f.provenance});
  let publications=0;
  const handbooks=new HandbookConsolidation({learning,jobs,registry,contextProvenance:f.provenance,resolveSourceRun:f.provenance.resolveSourceRun,onApplied:()=>publications++});
  const result=await handbooks.run({job:{id:'handbook-job',userId:'owner',leaseToken:'lease',payload:{candidateId:candidate.id,candidateDigest:candidate.payload.contentDigest}}});
  assert.equal(result.disposition,'applied');assert.notEqual(result.handbookId,foreignId);assert.equal(publications,0);
  assert.equal((await f.documents.get('owner','method',foreignId)).revision,foreign.revision);
  const applied=await f.documents.get('owner','method',result.handbookId);
  assert.equal(await f.items.handbook(f.policy,applied),true);
});

test('merge retirement needs structured producer receipt and later withdrawal invalidates descendant',options,async t=>{
  const f=await fixture(t),first=await f.create('merge-first'),second=await f.create('merge-second');
  const merged=await f.create('merged',null,{provenance:{runId:f.run.id,sourceProjectId:f.project.id,sourceProjectIds:[f.project.id],consolidatedBy:'consolidate:merge-job',
    mergedFrom:[{methodId:first.id,digest:first.payload.contentDigest},{methodId:second.id,digest:second.payload.contentDigest}]}});
  assert.equal(await f.items.method(f.policy,merged),true);
  const retired=await f.provenance.retireMerged('owner',first,merged,{proposedBy:'consolidate:merge-job',reason:'Absorbed into the exact merged method.'});
  assert.equal(await f.items.method(f.policy,merged),true);
  assert.equal(await f.items.method(f.policy,retired),false,'Retired methods are never context roots');
  const revised=await f.create('merged',merged,{...merged.payload,body:merged.payload.body+'\nRetain each source denominator.'});
  assert.equal(await f.items.method(f.policy,revised),true,'A safe revised descendant retains the exact original merge proof');
  await f.documents.put('owner','method',retired.id,{...retired.payload,statusReason:'Safety withdrawal'},{expectedRevision:retired.revision});
  assert.equal(await f.items.method(f.policy,revised),false);
});

test('all accepted actors survive derivation and unknown extra human-shaped input cannot teach',options,async t=>{
  const f=await fixture(t),request=f.request('second-author'),frame=await f.prepare(request,f.users.editor2);
  await f.execute(request,frame,async()=>{await f.journal.beforeForward(request);f.journal.observe(request,{state:'accepted',authority:'native-mux'});});
  const second=normalizeTranscript('root',[{type:'turn/start',seq:0,data:{turn:1}},{type:'user/message',seq:2,data:{source:{kind:'user',rpcId:request.requestId},content:request.content}}]).messages[0];
  const transcript={...f.transcript,messages:[...f.transcript.messages,second]};
  f.provenance.readTranscript=async()=>transcript;f.run.kernelRequestIds.push(request.requestId);
  const observation=await f.provenance.observeRun(f.project,f.run);
  assert.deepEqual(new Set(observation.actors.map(actor=>actor.id)),new Set(['editor','editor2']));
  const method=await f.create('two-authors'),proof=await f.provenance.proofFor('owner','method',method);
  assert.equal(proof.sources[0].inputs.length,2);
  transcript.messages.push({...second,seq:3,sourceRequestId:'unattributed'});
  await assert.rejects(f.create('unknown-extra-input'),{code:'geo_learning_source_unverified'});
});

test('real feedback SQL scopes clean peers before the 200-row family limit',options,async t=>{
  const f=await fixture(t),{FeedbackEvents}=await import(process.env.N12_FEEDBACK_MODULE ?? '../src/feedbackEvents.mjs'),{LearningEvidence}=await import('../src/learningEvidence.mjs');
  await f.accounts.createProject(f.users.owner,'other','Other');
  const feedback=new FeedbackEvents({database:f.db}),scope='geo-content',shape=[{format:'docx',structure:'report'}];
  const base=Date.parse('2026-10-25T00:00:00Z');
  for(let i=0;i<205;i++)await feedback.recordLearningEvidence('owner',{runId:`peer-${i}`,projectId:i<2?f.project.id:'other',key:'settled',
    detail:{evidence:'silent',scope,sessionId:'root',at:new Date(base+i*1000).toISOString(),shape}});
  const window={scope,from:new Date(base-1000),to:new Date(base+1000000)};
  assert.equal((await feedback.cleanSettledRuns('owner',window)).length,200);
  assert.deepEqual((await feedback.cleanSettledRuns('owner',{...window,projectId:f.project.id})).map(row=>row.runId),['peer-0','peer-1']);
  Object.assign(f.run,{status:'succeeded',effectiveAgentId:scope,finishedAt:new Date(base+300000).toISOString(),outputFiles:['report.docx']});
  let queued=0;
  const evidence=new LearningEvidence({feedback,contextProvenance:f.provenance,resolveProject:async()=>f.project,agentRuns:{list:async()=>[f.run]},jobs:{},readShapes:async()=>({'report.docx':shape[0]}),
    now:()=>new Date(base+400000),triggers:{refusalFor:async()=>null,resetInstantOf:async()=>null,guestInfluenced:async()=>false,queue:async()=>{queued++;return true;}}});
  assert.equal((await evidence.settle({job:{userId:'owner',projectId:f.project.id,payload:{runId:f.run.id}}})).routine,true);assert.equal(queued,1);
});

test('consumed shared follow-up keeps canonical input trace through real cleaner, correction lesson and distillation',options,async t=>{
  const f=await fixture(t),{FeedbackEvents}=await import('../src/feedbackEvents.mjs'),{LearningEvidence}=await import('../src/learningEvidence.mjs');
  const {LearningTriggers}=await import('../src/learningTriggers.mjs'),{LearningService}=await import('../src/learningService.mjs'),{MethodDistillationRuns}=await import('../src/methodDistillationRuns.mjs');
  const {persistRunTranscript}=await import('../src/runTranscripts.mjs');
  const request=f.request('follow-up');request.content=[{type:'text',text:'Please show every original denominator.'}];
  const frame=await f.prepare(request,f.users.editor2);
  await f.execute(request,frame,async()=>{await f.journal.beforeForward(request);f.journal.observe(request,{state:'accepted',authority:'native-mux'});});
  const transcript=normalizeTranscript('root',[{type:'turn/start',seq:0,data:{turn:1}},{type:'user/message',seq:1,data:{source:{kind:'user',rpcId:'correction'},content:[{type:'text',text:'Always preserve the denominator.'}]}},{type:'turn/end',seq:2,data:{reason:{kind:'completed'}}},
    {type:'turn/start',seq:3,data:{turn:2}},{type:'user/message',seq:4,data:{source:{kind:'user',rpcId:request.requestId},content:request.content}},{type:'turn/end',seq:5,data:{reason:{kind:'completed'}}}]);
  Object.assign(f.run,{status:'succeeded',effectiveAgentId:'geo-content',transcript:{completeness:'complete'}});
  const second={...f.run,id:'follow-up-run',nativeTurn:{startSeq:3},kernelRequestIds:[request.requestId]};
  f.provenance.resolveSourceRun=async(_owner,_project,id)=>[f.run,second].find(run=>run.id===id)??null;
  f.provenance.readTranscript=async()=>transcript;
  f.items.resolveSourceRun=f.provenance.resolveSourceRun;
  await persistRunTranscript({project:f.project,run:f.run,sessions:[{sessionId:'root',parentSessionId:null,label:'root',transcript}]});
  const feedback=new FeedbackEvents({database:f.db}),queued=[];
  const jobs={enqueue:async(userId,kind,payload,opts)=>{const job={userId,kind,payload,id:'lesson-job',...opts};queued.push(job);return job;}};
  const agentRuns={list:async()=>[f.run,second],runWorkflowProjection:async()=>null};
  const triggers=new LearningTriggers({jobs,agentRuns,contextProvenance:f.provenance});
  const evidence=new LearningEvidence({feedback,jobs,agentRuns,triggers,contextProvenance:f.provenance,
    judge:{available:true,read:async({message,methods})=>{assert.equal(message,request.content[0].text);assert.deepEqual(methods,[]);return JSON.stringify({verdict:'correction',rule:message,quote:message,concerns:[]});}}});
  triggers.evidence=evidence;
  await triggers.afterRun(f.project,second);
  const events=await feedback.learningEvidenceOf('owner',f.run.id),event=events.find(row=>row.detail.evidence==='follow-up');
  assert.deepEqual(event.detail.sourceRunIds,[f.run.id,second.id]);assert.equal(event.detail.inputReceiptRefs.length,2);
  const lesson=queued.find(job=>job.kind==='distill');assert.ok(lesson);assert.deepEqual(lesson.payload.sourceRunIds,[f.run.id,second.id]);assert.equal(lesson.payload.feedback[0].detail.inputReceiptRefs.length,2);
  const learning=new LearningService({documents:f.documents,contextProvenance:f.provenance});
  const distiller=new MethodDistillationRuns({learning,contextProvenance:f.provenance,dispatch:async({input})=>{assert.ok(input.corrections.some(correction=>correction.text===request.content[0].text));return {runId:'local',sessionId:'local'};},
    readResult:async()=>({status:'succeeded',output:{skill:skillText(),candidate:{operation:'create',evidence:[{runId:second.id,seqRange:[4,4],quote:request.content[0].text}]}}})});
  const result=await distiller.execute({job:lesson,project:f.project,run:f.run});
  const method=await learning.getMethod('owner',result.methodId),proof=await f.provenance.proofFor('owner','method',method);
  assert.deepEqual(new Set(proof.sources.map(source=>source.runId)),new Set([f.run.id,second.id]));
  assert.equal(await f.items.method(f.policy,method),true);
  const count=queued.length;second.automated=true;await triggers.afterRun(f.project,second);assert.equal(queued.length,count);
});
