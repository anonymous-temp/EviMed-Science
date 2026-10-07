import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {before, after, test} from 'node:test';
import {ControlPlaneDatabase} from '../src/controlPlaneDatabase.mjs';
import {ProductDocuments, ProductJobs} from '../src/productStore.mjs';
import {NotificationService} from '../src/notificationService.mjs';
import {UsageLedger} from '../src/usageLedger.mjs';
import {EvolutionService} from '../src/evolutionService.mjs';
import {AutopilotService} from '../src/autopilotService.mjs';
import {EvolutionIntegration, evolutionDatasetMetadata} from '../src/evolutionIntegration.mjs';
import {EvolutionMaintenance} from '../src/evolutionMaintenance.mjs';
import {EvolutionDecisions} from '../src/evolutionDecisions.mjs';
const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
if (url) { const parsed = new URL(url); assert.ok(['localhost','127.0.0.1','::1'].includes(parsed.hostname)); assert.match(parsed.pathname, /evimed_test/); }
const options = {skip: !url && 'A disposable localhost test database is required'};
const owner = `evolution_${randomUUID()}`, researcher = `evolution_${randomUUID()}`;
let database, documents, jobs, service, notifications, ledger;
before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({databaseUrl: url, databasePoolMax: 8, databaseConnectionTimeoutMs: 2000});
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Evolution operator','development'),($2,'Evolution researcher','development')", [owner,researcher]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,'evimed-evolution','Evolution',1048576),($1,'eval-paper-test','Evaluation',1048576),($1,'research','Research',1048576),($2,'research','Research',1048576)",[owner,researcher]);
  documents = new ProductDocuments(database); jobs = new ProductJobs(database); notifications = new NotificationService(database); ledger = new UsageLedger(database);
  service = new EvolutionService({documents,jobs,notifications,ownerId: owner});
});
after(async () => {if (database) {await database.query('DELETE FROM evimed_control.users WHERE id=ANY($1::text[])',[[owner,researcher]]); await database.close();}});

test('PostgreSQL lead races deduplicate and researcher events never cross tenant scope', options, async () => {
  const input = {track:'M',source:'runtime-failure',gapCode:'method-missing',code:'private_identifier',method:'private prose'};
  const rows = await Promise.all(Array.from({length:5},()=>service.addLead(input)));
  assert.equal(new Set(rows.map(row=>row.id)).size,1); assert.equal((await documents.history(owner,'knowledge',rows[0].id)).length,1);
  assert.equal(rows[0].payload.method,undefined); assert.equal(rows[0].payload.code,'method-missing');
  const event = await service.ingestEvent({id:'private-event',type:'dataset-ready',userId:researcher,projectId:'research',dataset:{fields:[]}});
  assert.equal(await service.get(event.id),null); assert.equal((await service.get(event.id,researcher)).projectId,'research');
  const queued = await database.query("SELECT count(*)::integer AS n FROM evimed_product.jobs WHERE user_id=$1 AND kind='evolution-scout'",[owner]); assert.equal(queued.rows[0].n,1);
});
test('persisted tenant events recover interrupted enqueue without exposing their payload', options, async () => {
  const original = service.enqueue;
  service.enqueue = async () => { throw new Error('Injected enqueue interruption'); };
  const event = { id: 'interrupted-private-event', type: 'dataset-ready', userId: researcher, projectId: 'research', privateText: 'tenant-only text' };
  try { await assert.rejects(service.ingestEvent(event), /interruption/); } finally { service.enqueue = original; }
  assert.equal((await service.reconcileQueued()).recovered, 1);
  assert.equal((await service.reconcileQueued()).recovered, 0);
  const record = (await service.list('event', researcher)).find(row => row.payload.id === event.id);
  const queued = await database.query("SELECT payload FROM evimed_product.jobs WHERE user_id=$1 AND idempotency_key=$2", [owner, `evolution:${record.id}`]);
  assert.deepEqual(queued.rows[0].payload, { eventId: record.id, eventOwnerId: researcher });
  assert.equal(await service.get(record.id), null);
  await service.ingestEvent(event);
  assert.equal((await database.query("SELECT count(*)::integer AS n FROM evimed_product.jobs WHERE user_id=$1 AND idempotency_key=$2", [owner, `evolution:${record.id}`])).rows[0].n, 1);
});
test('PostgreSQL concurrent direction proposals deliver only three once and retain late override history', options, async () => {
  const calls=[]; const decisions = new EvolutionDecisions({service,callbacks:{execute:async action=>{calls.push(action.actionId); return {option:action.option};}}});
  const input = id=>({subjectId:id,category:'track',title:'Choose direction',body:'Two paths tried.',directional:true,attemptedPaths:['a','b'],recommended:'go',conservative:'hold',options:[{id:'go',label:'Continue'},{id:'hold',label:'Keep'}]});
  await Promise.all(Array.from({length:5},(_,i)=>decisions.propose(input(`direction${i}`))));
  await decisions.digest(); const cards = (await service.list('decision')).filter(row=>row.payload.deliveredAt&&row.payload.decisionClass==='B'); assert.equal(cards.length,3);
  const counts=await database.query("SELECT count(*)::integer AS n FROM evimed_inbox.notifications WHERE user_id=$1 AND notice_type='review'",[owner]); assert.equal(counts.rows[0].n,3);
  const card=cards[0]; const chosen=await decisions.resolve(card.id,{expectedRevision:card.revision,option:'go'}); const changed=await decisions.resolve(card.id,{expectedRevision:chosen.revision,option:'hold'});
  assert.equal(changed.payload.history.length,2); assert.equal(changed.payload.overridden,true); await assert.rejects(decisions.resolve(card.id,{expectedRevision:chosen.revision,option:'go'}),{code:'product_revision_conflict'});
});
function request(userId,projectId,purpose,estimatedCost,dailyLimit=1) {const id=randomUUID();return {id,userId,projectId,purpose,estimatedCost,dailyLimit,weeklyLimit:0,model:'deepseek-v4-flash',priceVersion:'evimed-reference-2026-09-05',currency:'CNY',requestFingerprint:createHash('sha256').update(id).digest('hex')};}
test('evolution reservations share their own budget across internal projects and do not spend a researcher cap', options, async () => {
  await ledger.reserveModel(request(owner,'evimed-evolution','evolution',0.6));
  await assert.rejects(ledger.reserveModel(request(owner,'eval-paper-test','evolution',0.6)),{code:'usage_budget_exceeded'});
  await ledger.reserveModel(request(owner,'research','kernel',0.6));
  await ledger.reserveModel(request(researcher,'research','kernel',0.6));
  assert.equal((await ledger.summary(owner,{purposes:['evolution']})).reservedCalls,1);
  assert.equal((await ledger.summary(researcher,{purposes:['evolution']})).totalCalls,0);
  await assert.rejects(ledger.reserveModel(request(researcher,'evimed-evolution','evolution',0.1)),{code:'23503'});
});

test('durable resource wait wakes the exact agenda, while researcher pause and foreign project remain untouched', options, async () => {
  const autopilot = new AutopilotService({documents,jobs});
  const running = new Set();
  autopilot.schedule = async (userId, agendaId, {requestId, trigger}) => {assert.equal(trigger,'wake'); running.add(`${userId}:${agendaId}:${requestId}`); return {job: {id:requestId}};};
  const integration = new EvolutionIntegration({service,autopilot});
  service.callbacks.wakeAgenda = input=>integration.wakeAgenda(input);
  await service.registerTool({id:'integration-tool',track:'M',toolKind:'workflow',smokePassed:true,artifactDigest:'fixed',capabilityIds:['statistical-analysis']});
  for (const id of ['waiting','paused']) {
    await documents.put(researcher,'agenda',id,{title:'Cohort study',enabled:false,status:'paused',plannerStop:{kind:id==='waiting'?'needs_input':'researcher_pause'},evolutionWaiting:{sourceEpisodeId:'episode'}},{expectedRevision:0,projectId:'research'});
    await service.waitFor({userId:researcher,projectId:'research',agendaId:id,sourceEpisodeId:'episode',kind:'tool',toolId:'integration-tool'});
  }
  const event={id:'tool-new',type:'tool-ready',toolId:'integration-tool',userId:researcher,projectId:'foreign'};
  await service.resolveWaiters(event); assert.equal(running.size,0);
  await service.resolveWaiters({...event,projectId:'research'}); assert.equal(running.size,1);
  await service.resolveWaiters({...event,projectId:'research'}); assert.equal(running.size,1);
  assert.equal((await documents.get(researcher,'agenda','waiting')).payload.enabled,true);
  assert.equal((await documents.get(researcher,'agenda','paused')).payload.enabled,false);
  const waits=await service.list('waiter',researcher); assert.equal(waits.find(row=>row.payload.agendaId==='paused').payload.status,'waiting');
});

test('data integration publishes field metadata without patient rows or examples', async () => {
  const metadata=evolutionDatasetMetadata({tables:[{variables:[{name:'age',facts:{type:{value:'integer'}},values:['private'] }],rows:[{patient:'private'}],facts:{observationUnit:{value:'person'}}}],patientRows:[{id:'secret'}],samples:['secret'],lastCheck:{checkedAt:'2026-10-04',clean:[{}],findings:[],notChecked:[]},bindings:[{sha256:'hash'}]});
  assert.equal(metadata.fields[0].name,'age'); assert.equal(metadata.semanticsChecksPassed,true); assert.ok(!JSON.stringify(metadata).includes('private')); assert.ok(!JSON.stringify(metadata).includes('secret'));
});

test('dataset opportunities are owner scoped, replay stable, and incomplete metadata stays an observation', options, async () => {
  const integration = new EvolutionIntegration({service,autopilot:{}});
  await service.registerTool({id:'data-match-tool',track:'M',toolKind:'workflow',smokePassed:true,name:'Cohort checker',artifactDigest:'data-match-v1',dataRequirements:{schema:{fields:[{name:'age',type:'number',unit:'a'}]}}});
  const event={id:'dataset-version-one',type:'dataset-ready',userId:researcher,projectId:'research',datasetId:'cohort',dataset:{fields:[{name:'age',type:'number',unit:'a'}],semanticsChecksPassed:true,sourceVersions:[{sha256:'source-hash'}]}};
  await integration.consume(event); await integration.consume(event);
  const opportunities=(await service.opportunities(researcher)).filter(row=>row.payload.toolId==='data-match-tool');
  assert.equal(opportunities.length,1); assert.equal(opportunities[0].projectId,'research');
  assert.deepEqual(opportunities[0].payload.taskTypes,['data-prospecting']); assert.equal(await service.get(opportunities[0].id,owner),null);
  await integration.consume({...event,id:'dataset-version-two',dataset:{fields:[{name:'age',type:'number'}],semanticsChecksPassed:true}});
  assert.equal((await service.opportunities(researcher)).filter(row=>row.payload.toolId==='data-match-tool').length,1);
  const observations=(await service.list('observation',researcher)).filter(row=>row.payload.toolId==='data-match-tool');
  assert.equal(observations.length,1); assert.equal(observations[0].projectId,'research'); assert.ok(observations[0].payload.reasons.includes('unit:age:unknown'));
});

test('prospective registrations freeze exact questions and do not claim evaluation without public provenance', options, async () => {
  const integration = new EvolutionIntegration({service,autopilot:{}});
  const frozen = await integration.freezeProspective({toolId:'data-match-tool',artifactDigest:'data-match-v1',question:'Preregistered aggregate question',prediction:{effectDirection:'positive'},targetIdentity:'doi:10.1234/future',modelReleaseEvidenceId:'release-record',modelReleasedAt:'2026-01-01T00:00:00Z',preRegisteredProtocol:{outcome:'aggregate effect',tolerance:0.1}});
  const repeated = await integration.freezeProspective({toolId:'data-match-tool',artifactDigest:'data-match-v1',question:'Preregistered aggregate question',prediction:{effectDirection:'positive'},targetIdentity:'doi:10.1234/future',modelReleaseEvidenceId:'release-record',modelReleasedAt:'2026-01-01T00:00:00Z',preRegisteredProtocol:{outcome:'aggregate effect',tolerance:0.1}});
  assert.equal(repeated.payload.frozenAt,frozen.payload.frozenAt); assert.equal(repeated.payload.questionHash,frozen.payload.questionHash);
  await integration.consume({id:'new-publication',type:'frontier-publication',paper:{id:'future-paper',identity:'doi:10.1234/future',publishedAt:'2026-12-01T00:00:00Z'}});
  const found=await service.get(frozen.id); assert.equal(found.payload.status,'waiting-provenance'); assert.equal(found.payload.exposed,null);
  assert.equal((await service.list('observation')).filter(row=>row.payload.paperId==='future-paper').every(row=>row.payload.caseGroup==='development'),true);
});

test('post-cutoff meta opportunities preserve published analyses and need exact source evidence', options, async () => {
  const integration=new EvolutionIntegration({service,autopilot:{}});
  const event={id:'meta-update',type:'meta-evidence-update',userId:researcher,projectId:'research',originalMeta:{sourceId:'meta-source',sha256:'original-bytes',questionId:'question-one',searchCutoff:'2026-01-01T00:00:00Z'},newEvidence:{sourceId:'trial-source',sha256:'trial-bytes',questionId:'question-one',firstPublicAt:'2026-02-01T00:00:00Z',firstPublicEvidenceId:'preprint-receipt'}};
  const found=await integration.consume(event); assert.equal(found.payload.basis.originalSha256,'original-bytes'); assert.match(found.payload.prompt,/保留原始/);
  const unknown=await integration.consume({...event,newEvidence:{...event.newEvidence,sourceId:'another-trial',questionId:'different-question'}}); assert.equal(unknown.payload.status,'waiting'); assert.equal(unknown.payload.recordType,'evolution-observation');
});

test('daily source-fact producer observes preserved syntheses without inventing cutoff or sharing source prose', options, async () => {
  await documents.put(researcher,'source','meta-control-source',{fingerprint:{sha256:'frozen-meta-hash'},docType:'published-paper'},{expectedRevision:0,projectId:'research'});
  await documents.put(researcher,'knowledge','understanding:meta-control-source:g1',{recordType:'source-understanding',status:'current',sourceId:'meta-control-source',generation:1,output:{docType:'published-paper',summary:'private patient research question',slots:{design:{state:'known',value:'systematic review and meta-analysis',evidence:[{unitId:'frozen-unit',start:0,end:35}]}}}},{expectedRevision:0,projectId:'research'});
  service.callbacks.waiterOwners=async()=>[researcher];
  const integration=new EvolutionIntegration({service,autopilot:{}});
  const result=await integration.consume({type:'source-facts-scan'}); assert.equal(result.observed,1);
  const rows=(await service.list('observation',researcher)).filter(row=>row.payload.sourceId==='meta-control-source');
  assert.equal(rows.length,1); assert.equal(rows[0].payload.status,'waiting'); assert.ok(rows[0].payload.missingFacts.includes('verified-search-cutoff'));
  assert.equal(rows[0].payload.sourceSha256,'frozen-meta-hash'); assert.ok(!JSON.stringify(rows[0]).includes('private patient'));
  assert.equal(await service.get(rows[0].id,owner),null); await integration.consume({type:'source-facts-scan'});
  assert.equal((await service.list('observation',researcher)).filter(row=>row.payload.sourceId==='meta-control-source').length,1);
});

test('matched upload performs preserved known-effect checks before PostgreSQL agenda wake', options, async () => {
  const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
  const {createEvolutionSelfCheck}=await import('../src/evolutionSelfCheck.mjs');
  const {EvolutionWorker}=await import('../src/evolutionWorker.mjs');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'evolution-self-check-'));
  try {
    const bytes=Buffer.from(`age\n${Array.from({length:30},(_,index)=>index+20).join('\n')}\n`); await fs.writeFile(path.join(root,'cohort.csv'),bytes);
    const hash=createHash('sha256').update(bytes).digest('hex');
    await service.registerTool({id:'uploaded-check-tool',track:'U',artifactDigest:'plasmode-pin',toolKind:'workflow',smokePassed:true,
      dataRequirements:{schema:{fields:[{name:'age',type:'number',unit:'a'}]}},selfCheck:{kind:'linear-effect',covariates:['age'],knownEffect:2,tolerance:0.01,negativeControl:true}});
    const asset={bindings:[{path:'cohort.csv',sha256:hash,bytes:bytes.length,rows:30,columns:[{name:'age'}]}]};
    await documents.put(researcher,'knowledge','uploaded-semantics',{recordType:'dataset-semantics',asset},{expectedRevision:0,projectId:'research'});
    const autopilot=new AutopilotService({documents,jobs}); let started=0;
    autopilot.schedule=async(_userId,_agendaId,{trigger})=>{assert.equal(trigger,'wake');started++;return{job:{id:'started-after-self-check'}};};
    const integration=new EvolutionIntegration({service,autopilot}); service.callbacks.wakeAgenda=input=>integration.wakeAgenda(input);
    await documents.put(researcher,'agenda','uploaded-agenda',{title:'Data study',enabled:false,status:'paused',plannerStop:{kind:'needs_input'},evolutionWaiting:{sourceEpisodeId:'uploaded-episode'}},{expectedRevision:0,projectId:'research'});
    await service.waitFor({userId:researcher,projectId:'research',agendaId:'uploaded-agenda',sourceEpisodeId:'uploaded-episode',kind:'data',toolId:'uploaded-check-tool',dataRequirements:{schema:{fields:[{name:'age',type:'number',unit:'a'}]}}});
    const event={id:'uploaded-version',type:'dataset-ready',userId:researcher,projectId:'research',datasetId:'cohort',dataset:{fields:[{name:'age',type:'number',unit:'a'}],semanticsChecksPassed:true}};
    await service.resolveWaiters(event); assert.equal(started,0);
    const queue=(await database.query("SELECT payload FROM evimed_product.jobs WHERE user_id=$1 AND kind='evolution-self-check' AND payload->>'datasetId'='cohort' AND payload->>'sourceEventId'='uploaded-version'",[owner])).rows;
    assert.equal(queue.length,1); const input=queue[0].payload; assert.equal(input.projectId,'research');
    let calculations=0;
    const checker=createEvolutionSelfCheck({service,dataSemantics:{get:async(userId,projectId)=>{assert.equal(userId,researcher);assert.equal(projectId,'research');const row=await documents.get(userId,'knowledge','uploaded-semantics');return{revision:row.revision,asset:row.payload.asset};}},
      store:{userById:async id=>({id}),requireProject:async(user,id)=>({id,userId:user.id,workspaceDir:root})},controller:{execVerify:async()=>{throw new Error('Unexpected executor branch');}},
      supply:{prepareForRuntime:async()=>({pins:[{id:'uploaded-check-tool',digest:'plasmode-pin',revision:1,publicationKind:'isolated-tool'}]}),executeIsolated:async(project,{args})=>{calculations++;const residuals=args.rows.map(row=>({exposure:row.__evolution_exposure,residual:row.__evolution_outcome-row.age/100}));const average=group=>group.reduce((sum,row)=>sum+row.residual,0)/group.length;return{estimate:average(residuals.filter(row=>row.exposure===1))-average(residuals.filter(row=>row.exposure===0))};}}});
    const worker=new EvolutionWorker({service,decisions:{},maintenance:{},callbacks:{selfCheck:payload=>checker.run(payload)}});
    const result=await worker.perform({kind:'evolution-self-check',payload:input}); assert.equal(result.payload.status,'passed');assert.equal(calculations,2);assert.equal(started,1);
    await worker.perform({kind:'evolution-self-check',payload:input});assert.equal(calculations,2);assert.equal(started,1);
    assert.equal((await documents.get(researcher,'agenda','uploaded-agenda')).payload.enabled,true); assert.equal(await service.get(result.id,owner),null);
    assert.ok(!JSON.stringify(result.payload).includes('__evolution_outcome'));assert.equal(result.payload.empiricalEvidence,false);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

test('existing durable feedback events settle only actual tenant tool use and replay once', options, async () => {
  const {FeedbackEvents}=await import('../src/feedbackEvents.mjs');const {createEvolutionFeedback}=await import('../src/evolutionFeedback.mjs');const {EvolutionMaintenance}=await import('../src/evolutionMaintenance.mjs');
  const maintenance=new EvolutionMaintenance({service});const consumer=createEvolutionFeedback({service,maintenance});service.callbacks.observeFeedback=event=>consumer.observeFeedback(event);
  const integration=new EvolutionIntegration({service,autopilot:{}});
  await service.registerTool({id:'actual-feedback-tool',track:'M',artifactDigest:'feedback-pin'});
  await maintenance.observe('actual-feedback-tool',{runId:'feedback-real-run',callId:'feedback-real-call',executionOk:true,invoked:true,outcome:'pending'});
  await service.save('use','feedback-real-use',{projectId:'research',runId:'feedback-real-run',toolId:'actual-feedback-tool'},null,researcher);
  const feedback=new FeedbackEvents({database,onRecorded:async event=>{await integration.publish({id:`feedback:${event.id}`,type:'researcher-feedback',userId:event.userId,projectId:event.projectId,runId:event.runId,sourceFeedbackId:event.id,trigger:event.trigger,correctionKind:event.detail?.kind??null,occurredAt:event.occurredAt});}});
  const input={trigger:'deliverable-adopted',subject:{type:'deliverable',id:'feedback-real-run:report.md'},projectId:'research',runId:'feedback-real-run'};
  const original=await feedback.record(researcher,input);await feedback.record(researcher,input);
  const events=(await service.list('event',researcher)).filter(row=>row.payload.sourceFeedbackId===original.event.id);assert.equal(events.length,1);
  // What is recorded about the run lives in the run's own record, no longer in an array on the tool's (F16).
  const observations=async()=>(await service.list('observation')).filter(row=>row.payload.toolId==='actual-feedback-tool');
  const snapshot=async()=>({tool:await service.get('actual-feedback-tool'),observations:await observations()});
  await integration.consume(events[0].payload);
  const settled=await snapshot();
  assert.equal(settled.tool.payload.usage.runs,1);assert.equal(settled.tool.payload.usage.executionSucceeded,1);assert.equal(settled.tool.payload.observations,undefined);
  // The use is one record, counted once, with its outcome and the feedback that settled it.
  assert.equal(settled.observations.length,1);
  assert.deepEqual({runId:settled.observations[0].payload.runId,outcome:settled.observations[0].payload.outcome,invoked:settled.observations[0].payload.invoked,calls:settled.observations[0].payload.callIds,feedback:settled.observations[0].payload.feedbackEventId},
    {runId:'feedback-real-run',outcome:'accepted',invoked:true,calls:['feedback-real-call'],feedback:original.event.id});
  assert.equal((await maintenance.observationOf('actual-feedback-tool','feedback-real-run')).outcome,'accepted');
  // One researcher's first judged run is one trial of the tool's harm test, kept without the researcher's identity.
  assert.deepEqual(settled.tool.payload.usage.harm.trials.map(trial=>[trial.runId,trial.outcome]),[['feedback-real-run','accepted']]);
  assert.doesNotMatch(JSON.stringify([settled.tool.payload,settled.observations[0].payload]),new RegExp(researcher));
  // A replay of the same event changes nothing: not a counter, not a revision, not the run's record.
  await integration.consume(events[0].payload);
  assert.deepEqual(await snapshot(),settled);
  const entries=(await service.list('feedback',researcher)).filter(row=>row.payload.toolId==='actual-feedback-tool');assert.equal(entries.length,1);assert.equal(await service.get(entries[0].id,owner),null);
  // Nor does the same event replayed under another account, which never used the tool in that run.
  assert.deepEqual(await consumer.observeFeedback({...original.event,id:'foreign-replay',userId:owner}),{observed:0});
  assert.deepEqual(await snapshot(),settled);assert.equal((await service.get('actual-feedback-tool')).payload.usage.runs,1);
});

test('PostgreSQL: runs calling one tool at the same moment are all counted, each in its own record', options, async () => {
  const maintenance=new EvolutionMaintenance({service});
  await service.registerTool({id:'busy-tool',track:'M',artifactDigest:'busy-pin'});
  // Forty runs at once, against the real ledger's revision conflicts and a pool of eight connections. On an in-memory
  // double this passed with optimistic retries alone; on PostgreSQL 14 of the 40 were refused and their counts lost.
  const settled=await Promise.allSettled(Array.from({length:40},(_,index)=>maintenance.observe('busy-tool',{runId:`busy-run-${index}`,userId:`busy-account-${index}`,callId:`busy-call-${index}`,invoked:true,executionOk:index%4!==0,outcome:'pending'})));
  assert.deepEqual(settled.filter(item=>item.status==='rejected').map(item=>item.reason?.code??item.reason?.message),[]);
  let tool=await service.get('busy-tool');
  assert.deepEqual({invoked:tool.payload.usage.invoked,succeeded:tool.payload.usage.executionSucceeded,failed:tool.payload.usage.executionFailed,runs:tool.payload.usage.runs},{invoked:40,succeeded:30,failed:10,runs:0});
  const records=(await service.list('observation')).filter(row=>row.payload.toolId==='busy-tool');
  assert.equal(records.length,40);assert.equal(new Set(records.map(row=>row.payload.runId)).size,40);
  // One run making many calls, some of them at once and two reported twice.
  await Promise.all(Array.from({length:12},(_,index)=>maintenance.observe('busy-tool',{runId:'busy-loop',userId:'busy-looper',callId:`loop-call-${index%10}`,invoked:true,executionOk:true,outcome:'pending'})));
  for(let call=10;call<60;call++)await maintenance.observe('busy-tool',{runId:'busy-loop',userId:'busy-looper',callId:`loop-call-${call}`,invoked:true,executionOk:true,outcome:'pending'});
  tool=await service.get('busy-tool');
  assert.equal(tool.payload.usage.invoked,100);assert.equal(tool.payload.usage.executionSucceeded,90);
  assert.equal((await maintenance.observationOf('busy-tool','busy-loop')).callIds.length,60);
  assert.ok(Buffer.byteLength(JSON.stringify(tool.payload))<16*1024);
});

test('PostgreSQL: two server processes counting one tool at once lose nothing, and a run record is never left without its count', options, async () => {
  // A second pool and service stand for a second API process: its callers do not share this one's in-process queue,
  // so only the database-side lock orders the two.
  const otherDatabase=new ControlPlaneDatabase({databaseUrl:url,databasePoolMax:4,databaseConnectionTimeoutMs:5000});
  try{
    const otherService=new EvolutionService({documents:new ProductDocuments(otherDatabase),jobs:new ProductJobs(otherDatabase),notifications,ownerId:owner});
    const here=new EvolutionMaintenance({service}),there=new EvolutionMaintenance({service:otherService});
    await service.registerTool({id:'shared-tool',track:'M',artifactDigest:'shared-pin'});
    // The second process has started and prepared its schema before it serves, as a process does. (A pool whose very first
    // product-store call arrives during other writers' transactions can deadlock on the ledger's lazy schema preparation:
    // that is the ledger's, with or without this module, and is not what this case measures.)
    assert.equal((await otherService.get('shared-tool')).id,'shared-tool');
    const settled=await Promise.allSettled(Array.from({length:40},(_,index)=>(index%2?here:there).observe('shared-tool',{runId:`shared-run-${index}`,userId:`shared-account-${index}`,callId:`shared-call-${index}`,invoked:true,executionOk:true,outcome:'pending'})));
    assert.deepEqual(settled.filter(item=>item.status==='rejected').map(item=>item.reason?.code??item.reason?.message),[]);
    // The same run reported by both processes at once is still one run and one call.
    await Promise.all([here,there,here,there].map(side=>side.observe('shared-tool',{runId:'shared-same-run',userId:'shared-same',callId:'shared-same-call',invoked:true,executionOk:true,outcome:'pending'})));
    let tool=await service.get('shared-tool');
    assert.deepEqual({invoked:tool.payload.usage.invoked,succeeded:tool.payload.usage.executionSucceeded},{invoked:41,succeeded:41});
    assert.equal((await service.list('observation')).filter(row=>row.payload.toolId==='shared-tool').length,41);
    // The run's record and the tool's counters are one write. Here the tool's record is filled to just under the ledger's
    // 256 KiB limit, so an update that adds a harm trial to it is refused: the run's record must not stay behind uncounted.
    tool=await service.save('tool','shared-tool',{...tool.payload,filler:'x'.repeat(262_144-Buffer.byteLength(JSON.stringify({...tool.payload,recordType:'evolution-tool',filler:''}))-8)},tool);
    await assert.rejects(here.observe('shared-tool',{runId:'refused-run',userId:'refused-account',callId:'refused-call',invoked:true,executionOk:true,outcome:'accepted',feedbackEventId:'refused-feedback'}),{code:'product_document_too_large'});
    assert.equal(await here.observationOf('shared-tool','refused-run'),null);
    assert.equal((await service.get('shared-tool')).payload.usage.invoked,41);
    assert.equal((await service.list('observation')).filter(row=>row.payload.toolId==='shared-tool').length,41);
  }finally{await otherDatabase.close();}
});

test('PostgreSQL: a count made inside a held transaction joins it and does not wait behind this process\'s own queue', {...options,timeout:20000}, async () => {
  const maintenance=new EvolutionMaintenance({service});
  await service.registerTool({id:'nested-tool',track:'M',artifactDigest:'nested-pin'});
  let outside;
  await database.transaction(client=>database.withTransactionClient(client,async()=>{
    await maintenance.observe('nested-tool',{runId:'nested-run',userId:'nested-account',callId:'nested-call-1',invoked:true,executionOk:true,outcome:'pending'});
    // A caller outside this transaction arrives now and has to wait for it to commit. The second count inside must
    // not queue behind that caller, or neither could ever finish.
    outside=database.withoutTransactionClient(()=>maintenance.observe('nested-tool',{runId:'outside-run',userId:'outside-account',callId:'outside-call',invoked:true,executionOk:true,outcome:'pending'}));
    await new Promise(resolve=>setTimeout(resolve,100));
    await maintenance.observe('nested-tool',{runId:'nested-run',userId:'nested-account',callId:'nested-call-2',invoked:true,executionOk:true,outcome:'pending'});
  }));
  await outside;
  const tool=await service.get('nested-tool');
  assert.deepEqual({invoked:tool.payload.usage.invoked,succeeded:tool.payload.usage.executionSucceeded},{invoked:3,succeeded:3});
  assert.deepEqual((await maintenance.observationOf('nested-tool','nested-run')).callIds,['nested-call-1','nested-call-2']);
});

test('PostgreSQL: use is counted without writing history; a change in the harm test is content and is kept', options, async () => {
  const maintenance=new EvolutionMaintenance({service});
  const registered=await service.registerTool({id:'history-tool',track:'M',artifactDigest:'history-pin'});
  for(let call=0;call<50;call++)await maintenance.observe('history-tool',{runId:'history-run',userId:'history-account',callId:`history-call-${call}`,invoked:true,executionOk:true,outcome:'pending'});
  let tool=await service.get('history-tool');
  assert.equal(tool.payload.usage.invoked,50);
  // The ledger keeps a revision of every content change. Fifty calls are not fifty versions of the tool, nor of the run's
  // record (the learned-methods loop counts use the same way): one row each, their creation.
  assert.equal((await documents.history(owner,'knowledge','history-tool')).length,1);
  assert.equal((await documents.history(owner,'knowledge',maintenance.observationId(tool,'history-run'))).length,1);
  assert.equal(tool.updatedAt,registered.updatedAt,'being used is not a change of the tool');
  assert.ok(tool.revision>registered.revision,'a counter update still moves the revision, so a writer that read before it conflicts');
  // Three researchers judge their first results: three trials, and the test reads clear. That is what the tool's record says, so it is history.
  for(const account of ['a','b','c']){
    await maintenance.observe('history-tool',{runId:`judged-${account}`,userId:`judge-${account}`,callId:`judged-call-${account}`,invoked:true,executionOk:true,outcome:'pending'});
    await maintenance.observe('history-tool',{runId:`judged-${account}`,userId:`judge-${account}`,invoked:true,outcome:'accepted',feedbackEventId:`judged-feedback-${account}`});
  }
  tool=await service.get('history-tool');
  assert.deepEqual({state:tool.payload.usage.harm.state,trials:tool.payload.usage.harm.trials.length,harmState:tool.payload.usage.harmState},{state:'clear',trials:3,harmState:'clear'});
  const history=await documents.history(owner,'knowledge','history-tool');
  assert.equal(history.length,4);assert.notEqual(tool.updatedAt,registered.updatedAt);
  assert.deepEqual(history.map(row=>row.payload.usage.harm?.trials?.length??0).sort(),[0,1,2,3]);
});

 test('PostgreSQL immutable descriptor retries ignore JSONB key order but reject changed requirements', options, async () => {
  const input = {id:'jsonb-immutable-tool',track:'M',artifactDigest:'jsonb-pin',capabilityIds:['statistical-analysis'],dataRequirements:{schema:{fields:[{name:'age',type:'number',unit:'a'}]}}};
  await service.registerTool(input);
  const stored = await service.get(input.id);
  assert.deepEqual(stored.payload.dataRequirements,input.dataRequirements);
  const retry = await service.registerTool({...input,dataRequirements:{schema:{fields:[{unit:'a',type:'number',name:'age'}]}}});
  assert.equal(retry.revision,stored.revision);
  await assert.rejects(service.registerTool({...input,dataRequirements:{schema:{fields:[{unit:'d',type:'number',name:'age'}]}}}),error=>error.code==='evolution_version_immutable');
});

test('PostgreSQL late keep recovers partial activation under nested lifecycle locks and preserves revisions',options,async()=>{
 const id='pg-restoration-tool';await service.registerTool({id,track:'M',artifactDigest:'pg-restoration-pin',revision:7});
 let fail=true;const pins=[],retired=[];
 const maintenance=new EvolutionMaintenance({service,callbacks:{restorePin:async pin=>{pins.push(pin);if(fail)throw Error('Injected pin activation interruption');},retirePin:async toolId=>retired.push(toolId),notifyAffected:async()=>{}}});
 await maintenance.retire(await service.get(id),'monthly-direction-review');
 const retiredRow=await service.get(id);
 const review=await service.save('maintenance-review','pg-restoration-review',{kind:'retirement',parentToolIds:[id]});
 const action={id:'pg-restoration-decision',subjectId:review.id,option:'keep',actionId:'pg-late-keep'};
 await assert.rejects(maintenance.executeReview(action),/activation interruption/);
 assert.deepEqual(retired,[id]);assert.equal((await service.get(review.id)).payload.restoration.state,'pending');
 assert.equal((await service.get(id)).revision,retiredRow.revision);
 fail=false;await maintenance.executeReview(action);
 const restored=await service.get(id);assert.equal(restored.payload.status,'active');assert.equal(restored.payload.revision,7);
 assert.equal(restored.payload.artifactDigest,'pg-restoration-pin');assert.equal(restored.payload.restorationHistory.length,1);
 assert.deepEqual(pins[1],{id,digest:'pg-restoration-pin',revision:7});
 const history=await documents.history(owner,'knowledge',id);
 assert.ok(history.some(row=>row.payload.status==='retired'));assert.ok(history.length>=4);
 await maintenance.executeReview(action);assert.equal((await service.get(id)).revision,restored.revision);
 await service.registerTool({id:'pg-restoration-merged',track:'M',artifactDigest:'pg-merge-pin',revision:8,lineage:{parents:[id]}});
 await service.save('tool',id,{...restored.payload,status:'alias',replacedBy:'pg-restoration-merged'},restored);
 const merge=await service.save('maintenance-review','pg-restoration-merge-review',{kind:'merge',parentToolIds:[id]});
 await maintenance.executeReview({id:'pg-merge-decision',subjectId:merge.id,option:'keep',actionId:'pg-merge-late-keep'});
 assert.equal((await service.get(id)).payload.status,'active');assert.equal((await service.get('pg-restoration-merged')).payload.status,'retired');
});

test('actual daily reservation rejection below fifty durably defers and resumes the same PostgreSQL job without exhausting attempts or changing its checkpoint', options, async () => {
 const {EvolutionWorker}=await import('../src/evolutionWorker.mjs');
 const budgetOwner=`budget_${randomUUID()}`;
 await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Budget fixture','development')",[budgetOwner]);
 try {
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,'evimed-evolution','Evolution',1048576)",[budgetOwner]);
  const budgetService=new EvolutionService({documents,jobs,ownerId:budgetOwner});
  const held=request(budgetOwner,'evimed-evolution','evolution',49.95,50);await ledger.reserveModel(held);
  const checkpoint={completedSourceHash:'immutable-control-checkpoint',finishedStages:['extraction']};
  const queued=await jobs.enqueue(budgetOwner,'evolution-evaluate',{checkpoint},{idempotencyKey:budgetOwner,maxAttempts:3});
  const originalPayload=JSON.stringify(queued.payload);
  let ready=false,waits=0;
  const worker=new EvolutionWorker({service:budgetService,config:{evolutionEnabled:true,evolutionDailyBudgetCny:50,evolutionMaxJobAttempts:3},callbacks:{
   dailyCost:async client=>Number((await client.query("SELECT coalesce(sum(reserved_cost),0) AS cost FROM evimed_usage.model_requests WHERE user_id=$1 AND purpose='evolution' AND status='reserved'",[budgetOwner])).rows[0].cost),
   admitRuntime:async(_client,{job})=>job.id===queued.id,
   evaluate:async payload=>{assert.equal(JSON.stringify(payload),originalPayload);if(!ready)await ledger.reserveModel(request(budgetOwner,'evimed-evolution','evolution',0.10,50));return{checkpointRecovered:true};},
  }});
  worker.housekeeping=async()=>{};worker.resourceWait=async()=>{waits++;};
  for(let i=0;i<4;i++){
   const before=new Date();const result=await worker.tick({kinds:['evolution-evaluate']});
   assert.equal(result.id,queued.id);assert.equal(result.status,'queued');assert.equal(result.attempts,0);assert.equal(result.leaseToken,null);assert.equal(result.error.code,'usage_budget_exceeded');
   assert.equal(JSON.stringify(result.payload),originalPayload);assert.ok(Date.parse(result.runAfter)>=before.getTime()+3590000);
   const reserved=await database.query("SELECT count(*)::integer AS n, sum(reserved_cost)::text AS cost FROM evimed_usage.model_requests WHERE user_id=$1",[budgetOwner]);assert.equal(reserved.rows[0].n,1);assert.equal(Number(reserved.rows[0].cost),49.95);
   await database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp() WHERE user_id=$1 AND id=$2",[budgetOwner,queued.id]);
  }
  // Model the real rolling-window capacity returning without fabricating any model settlement.
  await ledger.release(budgetOwner,held.id,'fixture_provider_not_dispatched');ready=true;
  const finished=await worker.tick({kinds:['evolution-evaluate']});assert.equal(finished.id,queued.id);assert.equal(finished.status,'succeeded');assert.equal(finished.attempts,1);assert.equal(finished.result.checkpointRecovered,true);assert.equal(waits,0);
 } finally {await database.query('DELETE FROM evimed_control.users WHERE id=$1',[budgetOwner]);}
});

test('a run is completed from its own records of tool use, read by filter and not from the account\'s whole history', options, async () => {
  for (const runId of ['filter-run-1', 'filter-run-2', 'filter-run-2']) await service.save('use', `evolution-use-${runId}-${randomUUID()}`, { userId: researcher, projectId: 'research', runId, toolId: 'any-tool' }, null, researcher);
  const all = await service.list('use', researcher);
  assert.ok(all.length >= 3);
  const second = await service.list('use', researcher, { runId: 'filter-run-2' });
  assert.equal(second.length, 2);
  assert.ok(second.every(row => row.payload.runId === 'filter-run-2'));
  assert.deepEqual(await service.list('use', researcher, { runId: 'never-ran' }), []);
});
