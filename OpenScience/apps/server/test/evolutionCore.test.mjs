import test from 'node:test';
import assert from 'node:assert/strict';
import { EvolutionService } from '../src/evolutionService.mjs';
import { EvolutionDecisions, evolutionRetirementNotice } from '../src/evolutionDecisions.mjs';
import { EvolutionMaintenance } from '../src/evolutionMaintenance.mjs';
import { evolutionRunGap } from '../src/evolutionIntegration.mjs';
import { createEvolutionFeedback } from '../src/evolutionFeedback.mjs';
import { createEvolutionServingWorker } from '../src/evolutionServingWorker.mjs';
import { evolutionJobQueue, evolutionServiceFixture as fixture, seedCard, seedTool } from './helpers/evolutionServiceFixture.mjs';

const quiet = { error() {} };
test('a digest retry sends the frozen snapshot of its text, not what was found since', async () => {
  const f = fixture(), d = new EvolutionDecisions({ service: f.service, notifications: f.service.notifications });
  await seedTool(f.service, { id: 'first-tool', track: 'M', name: 'First tool', artifactDigest: 'first' });
  await d.digest(); const body = f.notices.at(-1).body;
  assert.match(body, /First tool V0/);
  await seedTool(f.service, { id: 'late-tool', track: 'M', name: 'Late tool', artifactDigest: 'late' });
  await d.digest(); assert.equal(f.notices.at(-1).body, body); assert.doesNotMatch(body, /Late tool/);
});

test('monthly catch-up evaluates completed months and passes previous metrics once', async () => {
  const f = fixture(), calls = [];
  const maintenance = new EvolutionMaintenance({ service: f.service, callbacks: { monthlyMetrics: async (month, context) => { calls.push({ month, context }); return { month, completed: true }; } } });
  await maintenance.monthly({ month: '2026-10', metricsMonth: '2026-08', metricsOnly: true });
  await maintenance.monthly({ month: '2026-10', metricsMonth: '2026-09', metricsOnly: true });
  await maintenance.monthly({ month: '2026-10', metricsMonth: '2026-09', metricsOnly: true });
  assert.equal(calls.length, 2); assert.equal(calls[1].context.previous.month, '2026-08');
  await assert.rejects(maintenance.monthly({ metricsMonth: '2026-10' }), /completed calendar month/);
});
test('retirement callback interruption stays durable and housekeeping retries idempotently', async () => {
  const f = fixture(); f.service.jobs = evolutionJobQueue(f); let attempts = 0; const withdrawn = new Set();
  const tool = await seedTool(f.service, { id: 'interrupted-retirement', track: 'M', artifactDigest: 'pin' });
  const maintenance = new EvolutionMaintenance({ service: f.service, callbacks: { notifyAffected: async ({toolId}) => { withdrawn.add(toolId); if (++attempts === 1) throw new Error('Notification interruption'); } } });
  await assert.rejects(maintenance.retire(tool, 'sequential-harm'), /interruption/);
  assert.equal((await f.service.get(tool.id)).payload.retirement.state, 'pending');
  const worker = createEvolutionServingWorker({ service: f.service, integration: {}, decisions: new EvolutionDecisions({ service: f.service }), maintenance, config: { evolutionEnabled: true }, logger: quiet });
  await worker.tick();
  const recovery = f.jobs.find(job => job.payload.action === 'retirement-reconcile'); assert.ok(recovery);
  assert.deepEqual([recovery.state, recovery.result.retirement], ['succeeded', 'complete']);
  assert.equal((await f.service.get(tool.id)).payload.retirement.state, 'complete');
  await maintenance.retire(await f.service.get(tool.id), 'again'); assert.equal(attempts,2); assert.equal(withdrawn.size,1);
  await worker.close();
});
test('the next morning reports what was achieved after the previous digest', async () => {
  const f = fixture(), d = new EvolutionDecisions({ service: f.service });
  await d.digest(); f.advance(6 * 3600000);
  await seedTool(f.service, { id: 'afternoon-tool', track: 'M', name: 'Afternoon tool', artifactDigest: 'afternoon' });
  f.advance(18 * 3600000); const next = await d.digest();
  assert.deepEqual(next.payload.achievements.map(row => row.id), ['afternoon-tool']);
  assert.match(f.notices.at(-1).body, /Afternoon tool V0/);
  f.advance(86400000); assert.equal((await d.digest()).payload.achievements.length, 0);
});

test('shared leads discard researcher prose and tenant events retain owner/project', async () => {
  const f = fixture(); const lead = await f.service.addLead({ track: 'U', source: 'autopilot', gapCode: 'connector', code: 'private patient narrative', method: 'private secret', userId: 'alice', projectId: 'a', sourceEventId: 'e1' });
  assert.equal(lead.payload.code, 'connector'); assert.equal(lead.payload.method, undefined);
  assert.equal((await f.service.list('lead-occurrence', 'alice')).length, 1, 'the occurrence is the researcher\'s own record'); assert.equal((await f.service.list('lead-occurrence')).length, 0);
  assert.doesNotMatch(JSON.stringify([lead, ...f.rows.values()]), /private (patient|secret)/);
  const event = await f.service.ingestEvent({ id: 'e', type: 'dataset-ready', userId: 'alice', projectId: 'a' });
  assert.equal(event.projectId, 'a'); assert.equal(await f.service.get(event.id), null);
  assert.equal((await f.service.ingestEvent({ id: 'e', type: 'dataset-ready', userId: 'alice', projectId: 'a' })).revision, 1);
});

test('a card is delivered once, expires into its conservative option only when due, and a late answer overrides it', async () => {
  const f = fixture(); const executions = [];
  const d = new EvolutionDecisions({ service: f.service, callbacks: { execute: async (input) => executions.push(input.option) } });
  const one = await d.deliver(await seedCard(f.service, '1')); await d.deliver(one);
  assert.equal(f.notices.length, 1);
  await d.expire(one.id); assert.equal(executions.length, 0, 'not due yet');
  f.advance(86400001); const expired = await d.expire(one.id);
  assert.deepEqual([expired.payload.selected, expired.payload.source, executions], ['hold', 'conservative', ['hold']]);
  // The person's late answer supersedes the default; it overrules the recommendation only when it is another option, and the latest answer is the one that counts.
  const late = await d.resolve(one.id, { expectedRevision: expired.revision, option: 'go' });
  assert.deepEqual([late.payload.selected, late.payload.source, late.payload.overridden, late.payload.history.length], ['go', 'user', false, 2]);
  const changed = await d.resolve(one.id, { expectedRevision: late.revision, option: 'hold' });
  assert.deepEqual([changed.payload.overridden, changed.payload.history.length], [true, 3]);
  await assert.rejects(d.resolve(one.id, { expectedRevision: expired.revision, option: 'hold' }), /changed/);
});

test('waiters require matching project and idempotent registration', async () => {
  const f = fixture(); let woke = 0; f.service.callbacks.wakeAgenda = async () => { woke++; }; f.service.callbacks.waiterOwners = async () => ['alice'];
  const input = { userId: 'alice', projectId: 'a', agendaId: 'agenda', toolId: 't', requirementId: 'r', dataRequirements: { schema: { fields: [] } } };
  await seedTool(f.service,{id:'t',track:'M',artifactDigest:'d'}); await f.service.waitFor(input); await f.service.waitFor(input);
  await f.service.resolveWaiters({ type: 'dataset-ready', userId: 'alice', projectId: 'b', dataset: { semanticsChecksPassed: true } }); assert.equal(woke, 0);
  await f.service.resolveWaiters({ type: 'dataset-ready', id: 'data', userId: 'alice', projectId: 'a', dataset: { semanticsChecksPassed: true } }); assert.equal(woke, 0);
  const check=f.jobs.find(job=>job.kind==='evolution-self-check'); assert.equal(check.payload.projectId,'a');
  await f.service.completeSelfCheck(check.payload,{id:'check',payload:{status:'passed'}}); assert.equal(woke,1);
});

test('actual sequential harm retires with retained version', async () => {
  const f = fixture(), proposals = []; const m = new EvolutionMaintenance({ service: f.service, callbacks: { proposeReview: async input => proposals.push(input) } });
  await seedTool(f.service,{ id: 't', track: 'M', artifactDigest: 'd', holdoutCases: [{ id: 'a', sha256: 'hash' }] });
  // Runs with no account behind them are counted and are not retirement evidence (evolutionHarmTest.test.mjs holds the procedure).
  for (let i = 0; i < 3; i++) await m.observe('t', { runId: `r${i}`, invoked: true, outcome: 'rejected' });
  assert.equal((await f.service.get('t')).payload.status, 'active'); assert.equal((await f.service.get('t')).payload.usage.runs, 3);
  for (let i = 0; i < 4; i++) { f.advance(1); await m.observe('t', { runId: `account-run-${i}`, userId: `researcher-${i}`, invoked: true, outcome: 'rejected' }); }
  assert.equal((await f.service.get('t')).payload.status, 'active'); assert.equal(proposals.length, 1);
  await m.executeReview({ subjectId: proposals[0].subjectId, option: 'retire', actionId: 'retire-action' });
  assert.equal((await f.service.get('t')).payload.status, 'retired'); assert.equal((await f.service.get('t')).payload.retirement.reason, 'sequential-harm');
});

test('a switched-off worker and a maintenance hold claim nothing', async () => {
  const f = fixture(); let claims = 0; f.service.jobs.claim = async () => { claims++; return null; };
  const config = { evolutionEnabled: false }; let permitted = true;
  const worker = createEvolutionServingWorker({ service: f.service, integration: {}, config, logger: quiet, canRun: async () => permitted });
  await worker.tick(); assert.equal(claims, 0, 'switched off');
  config.evolutionEnabled = true; permitted = false; await worker.tick(); assert.equal(claims, 0, 'held by maintenance');
  permitted = true; await worker.tick(); assert.equal(claims, 1, 'and it does claim once both allow it');
  await worker.close();
});

test('directional cards await daily delivery, the overflow is decided without the operator, and a digest retries a failed first notification', async () => {
  const f = fixture(); const actions = [];
  const d = new EvolutionDecisions({ service: f.service, callbacks: { execute: async input => actions.push([input.option, input.source]) } });
  for (let i = 0; i < 5; i++) await seedCard(f.service, `batch${i}`);
  // A one-way door among the overflow takes its conservative option, never the recommended one.
  await seedCard(f.service, 'one-way', { decisionClass: 'C', options: [{ id: 'send', label: '发送', operation: 'external-send' }, { id: 'hold', label: '保留', operation: 'wait' }], recommended: 'send', conservative: 'hold' });
  assert.equal(f.notices.length, 0);
  const original = f.service.notifications.create;
  let failDigest = true;
  f.service.notifications.create = async (owner, input) => {
    if (input.title === '进化日报' && failDigest) { failDigest = false; throw new Error('Delivery unavailable'); }
    return original(owner, input);
  };
  await assert.rejects(d.digest(), /Delivery unavailable/);
  assert.equal(f.notices.length, 3);
  const delivered = await d.digest();
  assert.equal(f.notices.length, 4); assert.equal(delivered.payload.decisions.length, 3); assert.deepEqual(actions, [['go', 'autonomous'], ['go', 'autonomous'], ['hold', 'conservative']]);
  const cards = await f.service.list('decision');
  assert.equal(cards.filter(row => row.payload.deliveredAt).length, 3);
});
test('close waits for the job in flight, and a closed worker claims nothing more', async () => {
  const f = fixture(); let started, release, finished = false, claims = 0;
  const ready = new Promise(resolve => { started = resolve; }), hold = new Promise(resolve => { release = resolve; });
  f.service.jobs.claim = async () => ++claims === 1 ? { id: 'j', kind: 'evolution-event', userId: 'operator', payload: { eventId: 'e', eventOwnerId: 'operator' }, leaseToken: 'lease' } : null;
  f.service.jobs.renew = async () => true; f.service.jobs.finish = async () => { finished = true; return {}; };
  await f.service.save('event', 'e', { type: 'researcher-feedback', status: 'queued' });
  const worker = createEvolutionServingWorker({ service: f.service, integration: { consume: async () => { started(); await hold; } }, config: { evolutionEnabled: true }, logger: quiet });
  const pending = worker.tick(); await ready;
  let closed = false; const closing = worker.close().then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(closed, false, 'close waits for the job to finish');
  release(); await closing; await pending;
  assert.equal(finished, true); assert.equal(worker.status().running, false);
  assert.equal(await worker.tick(), null); assert.equal(claims, 1, 'nothing is claimed after close');
});
test('actual call and card reads count independently while harm remains per run', async () => {
  const f=fixture(); const maintenance=new EvolutionMaintenance({service:f.service});
  await seedTool(f.service,{id:'call-tool',track:'M',artifactDigest:'calls'});
  await maintenance.observe('call-tool',{runId:'run',retrieved:true,retrievalId:'read-one'});
  await maintenance.observe('call-tool',{runId:'run',retrieved:true,retrievalId:'read-one'});
  for (const callId of ['one','two','two']) await maintenance.observe('call-tool',{runId:'run',callId,invoked:true,outcome:'pending'});
  let row=await f.service.get('call-tool'); assert.equal(row.payload.usage.executionCount,2); assert.equal(row.payload.usage.retrieved,1); assert.equal(row.payload.usage.runs,0);
  await maintenance.observe('call-tool',{runId:'run',invoked:true,outcome:'accepted'});
  row=await f.service.get('call-tool'); assert.equal(row.payload.usage.runs,1); assert.equal(row.payload.usage.succeeded,2);
});

test('per-call execution failures remain distinct from accepted run feedback', async () => {
  const f=fixture(),maintenance=new EvolutionMaintenance({service:f.service});
  await seedTool(f.service,{id:'feedback-tool',track:'M',artifactDigest:'feedback'});
  for (const [callId,executionOk] of [['failed',false],['passed',true]]) await maintenance.observe('feedback-tool',{runId:'feedback-run',callId,executionOk,invoked:true,outcome:'pending'});
  await f.service.save('use','feedback-use',{projectId:'research',runId:'feedback-run',toolId:'feedback-tool'},null,'alice');
  const feedback=createEvolutionFeedback({service:f.service,maintenance});
  const adopted={id:'adopted',userId:'alice',projectId:'research',runId:'feedback-run',trigger:'deliverable-adopted',occurredAt:'2026-10-04T01:00:00Z'};
  await feedback.observeFeedback(adopted);await feedback.observeFeedback(adopted);
  let tool=await f.service.get('feedback-tool');assert.equal(tool.payload.usage.executionSucceeded,1);assert.equal(tool.payload.usage.executionFailed,1);assert.equal(tool.payload.usage.succeeded,1);assert.equal(tool.payload.usage.runs,1);
  await maintenance.observe('feedback-tool',{runId:'feedback-run',invoked:true,outcome:'pending'});assert.equal((await maintenance.observationOf('feedback-tool','feedback-run')).outcome,'accepted');
  await feedback.observeFeedback({...adopted,id:'restyled',trigger:'result-corrected',detail:{kind:'presentation'}});assert.equal((await maintenance.observationOf('feedback-tool','feedback-run')).outcome,'accepted');
  await feedback.observeFeedback({...adopted,id:'changed-analysis',occurredAt:'2026-10-04T02:00:00Z',trigger:'result-corrected',detail:{kind:'analytic'}});
  tool=await f.service.get('feedback-tool');assert.equal(tool.payload.usage.corrected,1);assert.equal(tool.payload.usage.succeeded,0);assert.equal((await maintenance.observationOf('feedback-tool','feedback-run')).outcome,'rejected');assert.equal(tool.payload.observations,undefined);
  assert.equal((await feedback.observeFeedback({...adopted,id:'foreign',projectId:'other'})).observed,0);
});

test('staged V2 tools cannot be discovered or wake agendas until activation', async () => {
  const f=fixture();let woke=0;f.service.callbacks.waiterOwners=async()=>['alice'];f.service.callbacks.wakeAgenda=async()=>{woke++;};
  await seedTool(f.service,{id:'staged-tool',track:'M',status:'staged',validationLevel:'V2',artifactDigest:'staged-pin'});
  await f.service.waitFor({userId:'alice',projectId:'research',agendaId:'agenda',kind:'tool',toolId:'staged-tool'});
  await f.service.resolveWaiters({type:'tool-ready',toolId:'staged-tool'});
  assert.equal(woke,0);assert.equal((await f.service.availableTools()).length,0);
  const row=await f.service.get('staged-tool');await f.service.save('tool',row.id,{...row.payload,status:'active'},row);
  await f.service.resolveWaiters({type:'tool-ready',toolId:'staged-tool'});assert.equal(woke,1);assert.equal((await f.service.availableTools()).length,1);
});
test('a concluded harm test is not restarted: later corrections are counted and do not retire', async () => {
  // This case used to assert the opposite ("completed clear epochs cannot hide later harm"): a fresh test
  // after every concluded one. That restart is what retired a harmless tool 33% of the time by 100 runs.
  const f=fixture(),proposals=[],maintenance=new EvolutionMaintenance({service:f.service,callbacks:{proposeReview:async input=>proposals.push(input)}});
  await seedTool(f.service,{id:'epoch-tool',track:'M',artifactDigest:'epochs'});
  for(let index=0;index<40;index++){f.advance(1);await maintenance.observe('epoch-tool',{runId:`clear-${index}`,userId:`researcher-${index}`,callId:`call-${index}`,executionOk:true,invoked:true,outcome:'accepted',feedbackEventId:`adopt-${index}`});}
  let tool=await f.service.get('epoch-tool');assert.equal(tool.payload.usage.harmState,'clear');assert.equal(tool.payload.usage.harmEpochs,undefined);assert.equal(tool.payload.usage.harm.trials.length,3);
  for(let index=0;index<6;index++){f.advance(1);await maintenance.observe('epoch-tool',{runId:`later-${index}`,userId:`late-researcher-${index}`,callId:`later-call-${index}`,executionOk:false,invoked:true,outcome:'pending'});}
  for(let index=0;index<6;index++)await maintenance.observe('epoch-tool',{runId:`later-${index}`,userId:`late-researcher-${index}`,invoked:true,outcome:'rejected',corrected:true,feedbackEventId:`returned-${index}`});
  tool=await f.service.get('epoch-tool');assert.equal(tool.payload.status,'active');assert.equal(tool.payload.usage.harmState,'clear');assert.equal(proposals.length,0);
  assert.equal(tool.payload.usage.runs,46);assert.equal(tool.payload.usage.corrected,6);
});

test('measured failed self-check is a label; incomplete execution never authorizes wake', async () => {
  const input={waiterId:'waiter',userId:'owner',projectId:'project',datasetId:'dataset',toolId:'tool',sourceEventId:'source'};
  let wakes=0,saved;
  const service={get:async()=>({id:'waiter',projectId:'project',payload:{status:'waiting',projectId:'project'}}),callbacks:{wakeAgenda:async({event})=>{wakes++;assert.equal(event.selfCheckStatus,'failed');return{resumed:true};}},save:async(...args)=>{saved=args;},now:()=>new Date(),wakeWait:EvolutionService.prototype.wakeWait};
  const complete=(payload)=>EvolutionService.prototype.completeSelfCheck.call(service,input,{id:'check',payload});
  assert.equal((await complete({status:'failed'})).resumed,false);
  assert.equal((await complete({status:'pending',measurementCompleted:true})).resumed,false);
  assert.equal(wakes,0);
  assert.equal((await complete({status:'failed',measurementCompleted:true})).resumed,true);
  assert.equal(wakes,1);assert.equal(saved[2].status,'resolved');
  service.callbacks.wakeAgenda=async()=>({resumed:false});
  assert.equal((await complete({status:'failed',measurementCompleted:true})).resumed,false);
});

test('stable method wait survives unknown future artifact identity and ignores unrelated tools in the same capability',async()=>{
  const f=fixture();let wakes=0;f.service.callbacks.wakeAgenda=async()=>{wakes++;return{resumed:true};};
  const wait=await f.service.waitFor({userId:'researcher',projectId:'project',agendaId:'agenda',kind:'tool',methodId:'missing-method',capabilityId:'statistics'});
  await f.service.save('tool','unrelated',{status:'active',validationLevel:'V2',methodId:'other',capabilityIds:['statistics']});
  await f.service.resolveWaiters({type:'tool-ready',toolId:'unrelated',userId:'researcher',projectId:'project'});assert.equal(wakes,0);
  await f.service.save('tool','future-pin',{status:'active',validationLevel:'V2',methodId:'missing-method',capabilityIds:['statistics']});
  await f.service.resolveWaiters({type:'tool-ready',toolId:'future-pin',userId:'researcher',projectId:'project'});assert.equal(wakes,1);
  assert.equal((await f.service.get(wait.id,'researcher')).payload.status,'resolved');
});

test('a review of a repair or a merge is the offline lab\'s: serving answers it deferred and writes nothing',async()=>{
  const f=fixture();await seedTool(f.service,{id:'published',artifactDigest:'immutable',track:'M'});
  await f.service.save('maintenance-review','public-review',{kind:'public-boundary-regression',parentToolIds:['published'],executions:[{caseId:'public-negative',executed:true,passed:false}]});
  const maintenance=new EvolutionMaintenance({service:f.service});
  for(const option of ['repair','merge']){const answer=await maintenance.executeReview({subjectId:'public-review',actionId:`lab-${option}`,option});assert.deepEqual([answer.status,answer.code],['deferred','evolution_offline_only'],option);}
  assert.deepEqual(f.jobs,[]);assert.equal((await f.service.dossiers()).length,0);assert.equal((await f.service.get('published')).payload.status,'active');
});
test('late maintenance keep restores exact retirement pin and merge parents without overwriting newer branches',async()=>{
 const {service}=fixture();const pins=[];
 const maintenance=new EvolutionMaintenance({service,callbacks:{restorePin:async pin=>pins.push(pin),notifyAffected:async()=>{}}});
 await seedTool(service,{id:'restore-parent',track:'M',artifactDigest:'restore-pin',revision:2});
 let parent=await service.get('restore-parent');
 parent=await service.save('tool',parent.id,{...parent.payload,status:'retired',retirement:{reason:'monthly-direction-review',state:'complete'}},parent);
 const review=await service.save('maintenance-review','restore-review',{kind:'retirement',parentToolIds:[parent.id]});
 await maintenance.executeReview({id:'decision1',subjectId:review.id,option:'keep',actionId:'latekeep1'});
 assert.equal((await service.get(parent.id)).payload.status,'active');assert.deepEqual(pins[0],{id:parent.id,digest:'restore-pin',revision:2});
 await seedTool(service,{id:'restore-merged',track:'M',artifactDigest:'merged-pin',lineage:{parents:[parent.id]}});
 parent=await service.get(parent.id);await service.save('tool',parent.id,{...parent.payload,status:'alias',replacedBy:'restore-merged'},parent);
 const mergeReview=await service.save('maintenance-review','restore-merge-review',{kind:'merge',parentToolIds:[parent.id]});
 await maintenance.executeReview({id:'decision2',subjectId:mergeReview.id,option:'keep',actionId:'latekeep2'});
 assert.equal((await service.get(parent.id)).payload.status,'active');assert.equal((await service.get('restore-merged')).payload.status,'retired');
 parent=await service.get(parent.id);await service.save('tool',parent.id,{...parent.payload,status:'alias',replacedBy:'newer-branch'},parent);
 await assert.rejects(maintenance.executeReview({id:'decision2',subjectId:mergeReview.id,option:'keep',actionId:'latekeep3'}),error=>error.code==='evolution_evaluation_invalid');
 parent=await service.get(parent.id);await service.save('tool',parent.id,{...parent.payload,status:'retired',replacedBy:null,retirement:{reason:'published-replay-regression'}},parent);
 await assert.rejects(maintenance.executeReview({id:'decision1',subjectId:review.id,option:'keep',actionId:'latekeep4'}),error=>error.code==='evolution_evaluation_invalid');
});

test('restoration failure compensates pin and retries; a later harm retirement is reversible only by its own review',async()=>{
 const {service}=fixture();let fail=true,activated=0,deactivated=0;const proposals=[];
 const maintenance=new EvolutionMaintenance({service,callbacks:{restorePin:async()=>{activated++;if(fail)throw Error('activation interrupted');},retirePin:async()=>{deactivated++;},notifyAffected:async()=>{},proposeReview:async input=>proposals.push(input)}});
 await seedTool(service,{id:'epoch-tool',track:'M',artifactDigest:'epoch-pin'});
 await maintenance.retire(await service.get('epoch-tool'),'monthly-direction-review');
 const review=await service.save('maintenance-review','epoch-review',{kind:'retirement',parentToolIds:['epoch-tool']});
 const action={id:'epoch-decision',subjectId:review.id,option:'keep',actionId:'epoch-restore'};
 await assert.rejects(maintenance.executeReview(action),/interrupted/);assert.equal(deactivated,1);
 assert.equal((await service.get(review.id)).payload.restoration.state,'pending');
 fail=false;await maintenance.executeReview(action);assert.equal(activated,2);
 for(let index=0;index<4;index++) await maintenance.observe('epoch-tool',{runId:`actual-harm-${index}`,userId:`researcher-${index}`,invoked:true,callId:`actual-call-${index}`,outcome:'rejected',feedbackEventId:`actual-feedback-${index}`,at:`2026-10-05T00:00:0${index}.000Z`});
 assert.equal(proposals.length,1);await maintenance.executeReview({subjectId:proposals[0].subjectId,option:'retire',actionId:'harm-retire'});
 const row=await service.get('epoch-tool');assert.equal(row.payload.retirement.reason,'sequential-harm');
 assert.equal(row.payload.retirementHistory[0].reason,'monthly-direction-review');
 // The monthly review that once restored this tool cannot undo a retirement it did not decide.
 await assert.rejects(maintenance.executeReview({...action,actionId:'wrong-restore'}),error=>error.code==='evolution_evaluation_invalid');
 assert.equal((await maintenance.executeReview({id:'harm-decision',subjectId:proposals[0].subjectId,option:'keep',actionId:'harm-keep'})).state,'restored');
 assert.equal((await service.get('epoch-tool')).payload.status,'active');
});

test('daily autonomous digest reports every category and retains at most three highlights',async()=>{
 const f=fixture();const decisions=new EvolutionDecisions({service:f.service,notifications:f.service.notifications,callbacks:{execute:async()=>({state:'complete'})}});
 const categories=['implementation','tool-repair','tool-merge','tool-retire'];
 for(let index=0;index<6;index++) await decisions.execute(await seedCard(f.service,`autonomous-${index}`,{category:categories[index%4],directional:false,decisionClass:'A',title:`Highlighted decision ${index}`}),'go','autonomous');
 const manual=await seedCard(f.service,'manual-decision',{category:'manual-only',title:'Manually selected item'});
 await decisions.resolve(manual.id,{expectedRevision:manual.revision,option:'hold'});
 await decisions.digest();const body=f.notices.at(-1).body;
 for(const [index,label] of ['工具研发方向','工具修复','工具合并','工具退役'].entries()) assert.ok(body.includes(`${label}：${index<2?2:1} 项`));
 for(const category of categories) assert.equal(body.includes(category),false,'an internal category identifier is not text for the operator');
 assert.equal((body.match(/Highlighted decision/g)??[]).length,3);
 assert.equal(body.includes('manual-only'),false);assert.equal(body.includes('Manually selected item'),false);
});
test('one failing wake is recorded on its own wait and never stops the waits behind it', async () => {
  const f=fixture();f.service.callbacks.waiterOwners=async()=>['alice','bob'];
  const seen=[];
  f.service.callbacks.wakeAgenda=async({agendaId})=>{
    seen.push(agendaId);
    if(agendaId==='deleted')throw Object.assign(new Error('Research agenda is unavailable.'),{status:404,code:'autopilot_agenda_not_found'});
    if(agendaId==='broken')throw Object.assign(new Error('provider said: secret prose'),{code:'Some Provider Text'});
    return {resumed:true};
  };
  await f.service.save('tool','new-tool',{status:'active',validationLevel:'V2',methodId:'m',capabilityIds:['statistics']});
  for(const [userId,agendaId] of [['alice','deleted'],['alice','broken'],['alice','fine'],['bob','fine-too']])
    await f.service.waitFor({userId,projectId:'p',agendaId,kind:'tool',methodId:'m',capabilityId:'statistics'});
  const resolved=await f.service.resolveWaiters({type:'tool-ready',toolId:'new-tool'});
  assert.deepEqual(seen.sort(),['broken','deleted','fine','fine-too']);
  assert.equal(resolved.length,2,'the waits behind a failing one are woken');
  const state=async(userId,agendaId)=>(await f.service.list('waiter',userId)).find(row=>row.payload.agendaId===agendaId).payload;
  const broken=await state('alice','broken');
  assert.equal(broken.status,'waiting');assert.equal(broken.wakeFailure.code,'evolution_wake_failed','only a closed code is kept, never the error text');
  assert.equal(JSON.stringify(broken).includes('secret prose'),false);
  const deleted=await state('alice','deleted');
  assert.equal(deleted.status,'closed');assert.equal(deleted.closedReason,'autopilot_agenda_not_found');
});

test('a wake that waits for budget resolves its wait, and one the researcher holds back keeps it', async () => {
  const f=fixture();f.service.callbacks.waiterOwners=async()=>['alice'];
  const answers={deferred:{resumed:true,deferred:'autopilot_daily_budget_spent'},held:{resumed:false,held:'pause-thread'},gone:{resumed:false,closed:'autopilot_agenda_gone'}};
  f.service.callbacks.wakeAgenda=async({agendaId})=>answers[agendaId];
  await f.service.save('tool','new-tool',{status:'active',validationLevel:'V2',methodId:'m',capabilityIds:['statistics']});
  for(const agendaId of Object.keys(answers))await f.service.waitFor({userId:'alice',projectId:'p',agendaId,kind:'tool',methodId:'m',capabilityId:'statistics'});
  await f.service.resolveWaiters({type:'tool-ready',toolId:'new-tool'});
  const state=async agendaId=>(await f.service.list('waiter','alice')).find(row=>row.payload.agendaId===agendaId).payload;
  assert.equal((await state('deferred')).status,'resolved');assert.equal((await state('deferred')).wakeDeferred,'autopilot_daily_budget_spent');
  assert.equal((await state('held')).status,'waiting');
  assert.equal((await state('gone')).status,'closed');
});

test('a failing wake after a measured self-check does not fail the check', async () => {
  const f=fixture();
  const wait=await f.service.waitFor({userId:'alice',projectId:'p',agendaId:'agenda',kind:'data',toolId:'tool'});
  f.service.callbacks.wakeAgenda=async()=>{throw Object.assign(new Error('x'),{status:402,code:'usage_budget_exceeded'});};
  const done=await f.service.completeSelfCheck({waiterId:wait.id,userId:'alice',projectId:'p',datasetId:'d',toolId:'tool',sourceEventId:'e'},{id:'check',payload:{status:'passed'}});
  assert.equal(done.resumed,false);
  assert.equal((await f.service.get(wait.id,'alice')).payload.status,'waiting');
});

test('a retirement notice names the tool and the reason in words, never the identifier or the code', async () => {
  const notice = evolutionRetirementNotice({ name: '调查加权分析', toolId: 'tool-survey-0a1b2c', reason: 'sequential-harm' });
  assert.match(notice.body, /“调查加权分析”已停用，原因：使用中连续出现需要纠正的结果/);
  assert.doesNotMatch(notice.body, /tool-survey|sequential-harm/);
  assert.match(evolutionRetirementNotice({ toolId: 'x', reason: 'an-unnamed-code' }).body, /“科研工具”已停用，原因：不再满足验证要求/);
});

test('only a run that could not use a tool or engine is a lead for the module; a spent budget, a stop or an outage is not', async () => {
  assert.equal(evolutionRunGap({ errorCode: 'runtime_tool_error' }), 'method-implementation');
  for (const errorCode of ['usage_budget_exceeded', 'runtime_spend_limit_reached', 'runtime_stopped', 'runtime_session_error', 'autopilot_daily_budget_spent', 'canceled', undefined, null])
    assert.equal(evolutionRunGap({ errorCode }), null, String(errorCode));
});

test('a tool that failed inside a run that finished is the same gap, read from the notice the run carries today (review D-E20)', async () => {
  // `runtime_tool_error` is no longer written (2026-10-04): a tool failure a run did not get past is now a `run_tool_failed` notice on a run that
  // finished, so the gap read from the error code alone never fired again.
  const notice = code => ({ code, text: 'Research tool adr_case_query failed 2 time(s) and no later call of it succeeded.' });
  assert.equal(evolutionRunGap({ status: 'succeeded', errorCode: null, qualityNotices: [notice('run_side_notice'), notice('run_tool_failed')] }), 'method-implementation');
  for (const code of ['run_tool_unavailable', 'review_unavailable', 'capsule_unavailable', 'run_side_notice'])
    assert.equal(evolutionRunGap({ status: 'succeeded', qualityNotices: [notice(code)] }), null, `${code} is not a tool that failed (an unmounted tool is a missing tool of its own)`);
  assert.equal(evolutionRunGap({ status: 'succeeded', qualityNotices: [] }), null);
  assert.equal(evolutionRunGap({ status: 'succeeded' }), null);
  assert.equal(evolutionRunGap({ status: 'failed', errorCode: 'runtime_stopped', qualityNotices: [notice('run_side_notice')] }), null);
});
