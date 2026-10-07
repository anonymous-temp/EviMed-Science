import test from 'node:test';
import assert from 'node:assert/strict';
import { EvolutionService } from '../src/evolutionService.mjs';
import { EvolutionDecisions, evolutionEvaluationDigest, evolutionDecisionReviewProof } from '../src/evolutionDecisions.mjs';
import { recordResearchPromotion } from '../src/evolutionResearchPromotion.mjs';
import { EvolutionMaintenance, evolutionRetrievalBenchmark, evolutionRetrievalScore, evolutionReplayDisposition } from '../src/evolutionMaintenance.mjs';
import { EvolutionWorker } from '../src/evolutionWorker.mjs';

function fixture() {
  const rows = new Map(); const jobs = []; const notices = [];
  let time = new Date('2026-10-04T00:00:00Z');
  const documents = {
    async get(owner, kind, id) { return structuredClone(rows.get(`${owner}:${kind}:${id}`) ?? null); },
    async list(owner, kind, { filter }) { return { items: [...rows.entries()].filter(([key, row]) => key.startsWith(`${owner}:${kind}:`) && row.payload.recordType === filter.recordType).map(([, row]) => structuredClone(row)), nextCursor: null }; },
    async put(owner, kind, id, payload, { expectedRevision, projectId }) {
      const key = `${owner}:${kind}:${id}`; const old = rows.get(key);
      if ((old?.revision ?? 0) !== expectedRevision) throw Object.assign(new Error('CAS conflict'), { code: 'product_revision_conflict' });
      const row = { id, payload: structuredClone(payload), projectId, revision: expectedRevision + 1, createdAt: old?.createdAt ?? time.toISOString(), updatedAt: time.toISOString() }; rows.set(key, row); return structuredClone(row);
    },
  };
  const service = new EvolutionService({ documents, ownerId: 'operator', now: () => time,
    jobs: { async enqueue(owner, kind, payload, options) { const existing = jobs.find((job) => job.key === options.idempotencyKey); if (existing) return existing; const job = { owner, kind, payload, key: options.idempotencyKey }; jobs.push(job); return job; } },
    notifications: { async create(owner, input) { const row = { id: `n${notices.length}`, owner, ...input }; notices.push(row); return row; } },
  });
  return { service, rows, jobs, notices, advance(ms) { time = new Date(time.getTime() + ms); } };
}
const proposal = (id, extra = {}) => ({ subjectId: id, category: 'research-direction', title: '选择研究方向', body: '已尝试两条路径', directional: true, attemptedPaths: ['first', 'second'], options: [{ id: 'go', label: '继续' }, { id: 'hold', label: '保留' }], recommended: 'go', conservative: 'hold', ...extra });

test('digest retry freezes resources and reports actual engine denominators', async () => {
  const f = fixture(), d = new EvolutionDecisions({ service: f.service, notifications: f.service.notifications });
  await d.propose(proposal('first-resource', { resourceOnly: true }));
  await f.service.save('evaluation', 'actual-evaluation', { at: f.service.now().toISOString(), units: [{ capabilityId: 'meta-analysis', type: 'research', fullResearchReproductionValid: false, allStagesValid: true }, { capabilityId: 'meta-analysis', type: 'research', fullResearchReproductionValid: true }] });
  await d.digest(); const body = f.notices.at(-1).body;
  assert.match(body, /meta-analysis 完整研究复现：1\/2/); assert.match(body, /药物警戒体检：当日未运行/);
  const late = await d.propose(proposal('late-resource', { resourceOnly: true }));
  await d.digest(); assert.equal(f.notices.at(-1).body, body);
  assert.equal((await f.service.get(late.id)).payload.resourceReportedAt, undefined);
  assert.deepEqual(evolutionEvaluationDigest({ id: 'unknown', payload: {} }).capabilityIds, []);
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
test('release replay dependency gaps do not retire; actual wrong numbers repair protected coverage', async () => {
  const f=fixture(),directions=[];
  const maintenance=new EvolutionMaintenance({service:f.service,callbacks:{proposeReview:async input=>directions.push(input)}});
  const tool=await f.service.registerTool({id:'replay-tool',track:'M',artifactDigest:'pin',holdoutCases:[{id:'case',sha256:'hash'}]});
  await f.service.save('dossier','original-replay-card',{toolId:tool.id,goal:'Calculate the preserved method',methodId:'method',track:'M'});
  assert.equal((await maintenance.releaseReplay(tool,{ok:false,status:'waiting_resource',resourceCode:'dependency_missing',failedCaseIds:[]},'release1')).disposition,'resource');
  assert.equal((await f.service.get(tool.id)).payload.status,'active');
  assert.equal((await maintenance.releaseReplay(tool,{ok:false,status:'repair',assessments:[{independent:true,passed:false,exposed:false,retracted:false,reason:'candidate_execution_failed'}]},'release2')).disposition,'resource');
  // One started-and-failed execution, or two that never started, are still not a verdict on the tool.
  const failedRun=(replicate,candidateStarted)=>({caseId:'case',replicate,independent:true,passed:false,exposed:false,retracted:false,reason:'candidate_execution_failed',candidateStarted});
  assert.equal(evolutionReplayDisposition({ok:false,status:'repair',assessments:[failedRun(0,true),failedRun(1,false)]}),'resource');
  assert.equal(evolutionReplayDisposition({ok:false,status:'repair',assessments:[failedRun(0,false),failedRun(1,false)]}),'resource');
  assert.equal(evolutionReplayDisposition({ok:false,status:'waiting_resource',assessments:[failedRun(0,true),failedRun(1,true)]}),'resource');
  assert.equal(evolutionReplayDisposition({ok:false,status:'repair',assessments:[failedRun(0,true),failedRun(1,true)]}),'execution-regression');
  const wrong={ok:false,status:'repair',failedCaseIds:['case'],evaluatorHash:'hash',assessments:[{caseId:'case',independent:true,passed:false,exposed:false,retracted:false,reason:'outside_reference_tolerance'}]};
  const review=await maintenance.releaseReplay(await f.service.get(tool.id),wrong,'release3');assert.equal(review.protectedCoverage,true);
  assert.equal((await f.service.get(tool.id)).payload.maintenanceState,'deprecating');assert.equal((await f.service.get(tool.id)).payload.status,'active');
  const repair=await maintenance.executeReview({subjectId:review.reviewId,option:'repair',actionId:'actual-repair-action'});
  const card=await f.service.get(repair.payload.dossierId);assert.deepEqual(card.payload.parentToolIds,[tool.id]);assert.equal(card.payload.repairOf.artifactDigest,'pin');
  await maintenance.executeReview({subjectId:review.reviewId,option:'repair',actionId:'actual-repair-action'});assert.equal(f.jobs.filter(job=>job.kind==='evolution-build').length,1);
  await f.service.registerTool({id:'alternate-tool',track:'M',artifactDigest:'other',holdoutCases:[{id:'case',sha256:'hash'}]});
  const redundant=await maintenance.releaseReplay(await f.service.get(tool.id),wrong,'release4');assert.equal(redundant.protectedCoverage,false);
  assert.equal((await f.service.get(tool.id)).payload.status,'retired');assert.ok(directions.some(row=>row.recommended==='repair'));
});
test('retirement callback interruption stays durable and housekeeping retries idempotently', async () => {
  const f = fixture(); let attempts = 0; const withdrawn = new Set();
  const tool = await f.service.registerTool({ id: 'interrupted-retirement', track: 'M', artifactDigest: 'pin' });
  const maintenance = new EvolutionMaintenance({ service: f.service, callbacks: { notifyAffected: async ({toolId}) => { withdrawn.add(toolId); if (++attempts === 1) throw new Error('Notification interruption'); } } });
  await assert.rejects(maintenance.retire(tool, 'sequential-harm'), /interruption/);
  assert.equal((await f.service.get(tool.id)).payload.retirement.state, 'pending');
  const worker = new EvolutionWorker({ service: f.service, maintenance }); await worker.housekeeping();
  const recovery = f.jobs.find(job => job.payload.action === 'retirement-reconcile'); assert.ok(recovery);
  const result = await worker.perform({kind:recovery.kind,payload:recovery.payload}); assert.equal(result.retirement.payload.retirement.state,'complete');
  await maintenance.retire(await f.service.get(tool.id), 'again'); assert.equal(attempts,2); assert.equal(withdrawn.size,1);
});
test('the next morning reports actual evaluations completed after the previous digest', async () => {
  const f = fixture(), d = new EvolutionDecisions({ service: f.service });
  await d.digest(); f.advance(6 * 3600000);
  await f.service.save('evaluation', 'afternoon-score', { at: f.service.now().toISOString(), units: [{ capabilityId: 'adr-analysis', type: 'method', allStagesValid: true }] });
  f.advance(18 * 3600000); const next = await d.digest();
  assert.equal(next.payload.evaluationSummaries[0].evaluationId, 'afternoon-score');
  assert.match(f.notices.at(-1).body, /adr-analysis 方法算例：1\/1/);
  f.advance(86400000); assert.equal((await d.digest()).payload.evaluationSummaries.length, 0);
});

test('five independent reproduced papers require actual pinned calls and cannot count repeated cycles', async () => {
  const f = fixture(); await f.service.registerTool({ id: 'research-tool', track: 'E', artifactDigest: 'pin' });
  const units = [];
  for (let paper = 0; paper < 5; paper++) for (let replicate = 0; replicate < 2; replicate++) {
    const run = `run-${paper}-${replicate}`;
    units.push({ type: 'research', group: 'time-holdout', caseId: `case-${paper}`, variant: 0, publishedPaperId: `10.1234/paper${paper}`, producerRunId: run, producerProjectId: 'eval', goldSourceHash: 'a'.repeat(64), fullResearchReproductionValid: true, codeVerified:true,verificationProof:{kind:'isolated-independent-replay',replicates:2,proofHash:'f'.repeat(64),sourceHash:'a'.repeat(64)}, independent: true, retracted: false, exposureTier: 'unexposed' });
    await f.service.save('use', run, { projectId: 'eval', runId: run, toolId: 'research-tool', digest: 'pin', result: { ok: true } }, null, 'operator');
  }
  const input = { service: f.service, userId: 'operator', toolId: 'research-tool', artifactDigest: 'pin', report: { units }, canonicalize:async id=>({verified:true,canonicalId:String(id).replace(/^doi:/,'')}) };
  assert.equal((await recordResearchPromotion({ ...input, report: { units: units.map(row => ({ ...row, exposureTier: 'unknown' })) } })).papers, 0);
  assert.equal((await recordResearchPromotion({ ...input, report: { units: units.slice(0, 2), excluded: [{ ...units[0], producerRunId: 'excluded-run', exposureTier: 'exposed' }] } })).papers, 0);
  assert.equal((await recordResearchPromotion({...input,report:{units:units.map(row=>({...row,codeVerified:false,verificationProof:undefined}))}})).papers,0);
  assert.equal((await recordResearchPromotion(input)).validationLevel, 'V3');
  assert.equal((await recordResearchPromotion(input)).papers, 5);
  assert.equal((await f.service.list('research-proof')).length, 5);
});

test('V3 counts the papers a tool failed beside the ones it reproduced', async () => {
  const { reproductionRateLowerBound } = await import('../src/evolutionResearchPromotion.mjs');
  // Five of five is the least that qualifies; a failure among six does not; it takes seven of eight.
  assert.ok(Math.abs(reproductionRateLowerBound(5, 5) - 0.05 ** (1 / 5)) < 1e-9);
  assert.ok(reproductionRateLowerBound(5, 6) < 0.5 && reproductionRateLowerBound(6, 7) < 0.5 && reproductionRateLowerBound(7, 8) >= 0.5 && reproductionRateLowerBound(5, 100) < 0.03);
  const f = fixture(); await f.service.registerTool({ id: 'research-tool', track: 'E', artifactDigest: 'pin' });
  const cycle = async (papers, valid) => {
    const units = [];
    for (const paper of papers) for (let replicate = 0; replicate < 2; replicate++) {
      const run = `run-${paper}-${replicate}-${valid}`;
      units.push({ type: 'research', group: 'holdout', caseId: `case-${paper}`, variant: 0, publishedPaperId: `10.1234/paper${paper}`, producerRunId: run, producerProjectId: 'eval', goldSourceHash: 'a'.repeat(64), fullResearchReproductionValid: valid,
        ...(valid ? { codeVerified: true, verificationProof: { kind: 'isolated-independent-replay', replicates: 2, proofHash: 'f'.repeat(64), sourceHash: 'a'.repeat(64) } } : { codeVerified: false }), independent: true, retracted: false, exposureTier: 'unexposed' });
      await f.service.save('use', run, { projectId: 'eval', runId: run, toolId: 'research-tool', digest: 'pin', result: { ok: true } }, null, 'operator');
    }
    return recordResearchPromotion({ service: f.service, userId: 'operator', toolId: 'research-tool', artifactDigest: 'pin', report: { units }, canonicalize: async id => ({ verified: true, canonicalId: String(id) }) });
  };
  // Twenty papers the tool did not reproduce used to leave no trace at all.
  const failures = await cycle(Array.from({ length: 20 }, (_, index) => `f${index}`), false);
  assert.deepEqual({ papers: failures.papers, attempted: failures.attempted, failed: failures.failed, status: failures.status }, { papers: 0, attempted: 20, failed: 20, status: 'waiting' });
  // Then five it did: five passes ever was V3. It is 5 of 25 now, and it is not.
  const five = await cycle([1, 2, 3, 4, 5], true);
  assert.deepEqual({ papers: five.papers, attempted: five.attempted, failed: five.failed, status: five.status, level: five.validationLevel }, { papers: 5, attempted: 25, failed: 20, status: 'waiting', level: 'V0' });
  assert.ok(five.reproductionRateLowerBound < 0.1);
  // Trying a failed paper again cannot turn its first measured outcome into a pass.
  const retried = await cycle(['f0', 'f1', 'f2'], true);
  assert.deepEqual({ papers: retried.papers, failed: retried.failed }, { papers: 5, failed: 20 });
  const tool = await f.service.get('research-tool'), assessment = tool.payload.assessments.find(row => row.kind === 'research');
  assert.deepEqual({ papers: assessment.papers, passed: assessment.passed, failures: assessment.failureIds.length }, { papers: 5, passed: false, failures: 20 });
});

test('shared leads discard researcher prose and tenant events retain owner/project', async () => {
  const f = fixture(); const lead = await f.service.addLead({ track: 'U', source: 'autopilot', gapCode: 'connector', code: 'private patient narrative', method: 'private secret' });
  assert.equal(lead.payload.code, 'connector'); assert.equal(lead.payload.method, undefined);
  const event = await f.service.ingestEvent({ id: 'e', type: 'dataset-ready', userId: 'alice', projectId: 'a' });
  assert.equal(event.projectId, 'a'); assert.equal(await f.service.get(event.id), null);
  assert.equal((await f.service.ingestEvent({ id: 'e', type: 'dataset-ready', userId: 'alice', projectId: 'a' })).revision, 1);
});

test('independent unpublished self assertions cannot promote; two hidden cases promote V2', async () => {
  const f = fixture(); await f.service.registerTool({ id: 'tool', track: 'M', validationLevel: 'V4', artifactDigest: 'a' });
  assert.equal((await f.service.get('tool')).payload.validationLevel, 'V0');
  await assert.rejects(f.service.recordAssessment('tool', { id: 'bad', passed: true }), /independent/);
  for (const id of ['a', 'b']) await f.service.recordAssessment('tool', { id, caseId: id, kind: 'published-case', independent: true, passed: true, exposed: false, retracted: false });
  assert.equal((await f.service.get('tool')).payload.validationLevel, 'V2');
});

test('three cards daily, replay once, C overflow conservative, expiry refresh review and late override', async () => {
  const f = fixture(); const executions = []; const review = [];
  const d = new EvolutionDecisions({ service: f.service, callbacks: { refresh: async () => ({ family: 'one', recommended: 'go' }), review: async (input) => { review.push(input); return { family: 'two', independent: true, recommended: 'go' }; }, execute: async (input) => executions.push(input.option) } });
  const proposed = await d.propose(proposal('1')); const one = await d.deliver(proposed); await d.propose(proposal('1'));
  await d.deliver(await d.propose(proposal('2'))); await d.deliver(await d.propose(proposal('3')));
  await d.propose(proposal('4')); const c = await d.propose(proposal('5', { externalSend: true }));
  assert.equal(f.notices.length, 3); assert.equal(c.payload.selected, 'hold'); assert.equal(executions[0], 'go');
  await d.expire(one.id); assert.equal(review.length, 0);
  f.advance(86400001); const expired = await d.expire(one.id); assert.equal(review.length, 1); assert.equal(expired.payload.source, 'default');
  const late = await d.resolve(one.id, { expectedRevision: expired.revision, option: 'hold' });
  assert.equal(late.payload.overridden, true); assert.equal(late.payload.history.length, 2);
  await assert.rejects(d.resolve(one.id, { expectedRevision: expired.revision, option: 'go' }), /changed/);
});

test('expiry rejects same-family review and resource ask appears once in digest', async () => {
  const f = fixture(); const d = new EvolutionDecisions({ service: f.service, callbacks: { refresh: async () => ({ family: 'x' }), review: async () => ({ independent: true, family: 'x' }), execute: async () => ({}) } });
  const card = await d.deliver(await d.propose(proposal('x'))); f.advance(86400001);
  // A same-family review is never accepted; the card says so, is asked again, and meanwhile nothing was executed on its strength.
  const waiting = await d.expire(card.id);
  assert.equal(waiting.payload.status, 'pending'); assert.equal(waiting.payload.expiry.state, 'review-unavailable'); assert.equal(waiting.payload.expiry.code, 'evolution_review_invalid');
  await d.propose(proposal('resource', { resourceOnly: true })); await d.digest(); f.advance(86400000); const next = await d.digest(); assert.equal(next.payload.resources.length, 0);
});

test('waiters require matching project and idempotent registration', async () => {
  const f = fixture(); let woke = 0; f.service.callbacks.wakeAgenda = async () => { woke++; }; f.service.callbacks.waiterOwners = async () => ['alice'];
  const input = { userId: 'alice', projectId: 'a', agendaId: 'agenda', toolId: 't', requirementId: 'r', dataRequirements: { schema: { fields: [] } } };
  await f.service.registerTool({id:'t',track:'M',artifactDigest:'d'}); await f.service.waitFor(input); await f.service.waitFor(input);
  await f.service.resolveWaiters({ type: 'dataset-ready', userId: 'alice', projectId: 'b', dataset: { semanticsChecksPassed: true } }); assert.equal(woke, 0);
  await f.service.resolveWaiters({ type: 'dataset-ready', id: 'data', userId: 'alice', projectId: 'a', dataset: { semanticsChecksPassed: true } }); assert.equal(woke, 0);
  const check=f.jobs.find(job=>job.kind==='evolution-self-check'); assert.equal(check.payload.projectId,'a');
  await f.service.completeSelfCheck(check.payload,{id:'check',payload:{status:'passed'}}); assert.equal(woke,1);
});

test('actual sequential harm retires with retained version; merge needs every source case', async () => {
  const f = fixture(), proposals = []; const m = new EvolutionMaintenance({ service: f.service, callbacks: { proposeReview: async input => proposals.push(input) } });
  await f.service.registerTool({ id: 't', track: 'M', artifactDigest: 'd', holdoutCases: [{ id: 'a', sha256: 'hash' }] });
  // Runs with no account behind them are counted and are not retirement evidence (evolutionHarmTest.test.mjs holds the procedure).
  for (let i = 0; i < 3; i++) await m.observe('t', { runId: `r${i}`, invoked: true, outcome: 'rejected' });
  assert.equal((await f.service.get('t')).payload.status, 'active'); assert.equal((await f.service.get('t')).payload.usage.runs, 3);
  for (let i = 0; i < 4; i++) { f.advance(1); await m.observe('t', { runId: `account-run-${i}`, userId: `researcher-${i}`, invoked: true, outcome: 'rejected' }); }
  assert.equal((await f.service.get('t')).payload.status, 'active'); assert.equal(proposals.length, 1);
  await m.executeReview({ subjectId: proposals[0].subjectId, option: 'retire', actionId: 'retire-action' });
  assert.equal((await f.service.get('t')).payload.status, 'retired'); assert.equal((await f.service.get('t')).payload.retirement.reason, 'sequential-harm');
  await assert.rejects(m.merge(['t'], { id: 'new', track: 'M' }), /every parent case/);
});

test('worker default off and maintenance canRun stop claims', async () => {
  const f = fixture(); let claims = 0; f.service.jobs.claim = async () => { claims++; return null; };
  const worker = new EvolutionWorker({ service: f.service, config: { evolutionEnabled: false } }); await worker.tick();
  worker.config.evolutionEnabled = true; worker.canRun = () => false; await worker.tick(); assert.equal(claims, 0);
});

test('directional cards await daily delivery and digest retries a failed first notification', async () => {
  const f = fixture(); const actions = [];
  const d = new EvolutionDecisions({ service: f.service, callbacks: { execute: async input => actions.push(input.option) } });
  for (let i = 0; i < 5; i++) await d.propose(proposal(`batch${i}`));
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
  assert.equal(f.notices.length, 4); assert.equal(delivered.payload.decisions.length, 3); assert.deepEqual(actions, ['go', 'go']);
  const cards = await f.service.list('decision');
  assert.equal(cards.filter(row => row.payload.deliveredAt).length, 3);
});

test('close aborts active callback and waits for the durable retry result', async () => {
  const f = fixture(); let started;
  const ready = new Promise(resolve => { started = resolve; });
  let failed = false;
  f.service.jobs.claim = async kinds => kinds.includes('evolution-build') ? { id: 'j', kind: 'evolution-build', userId: 'operator', payload: {}, leaseToken: 'lease' } : null;
  f.service.jobs.fail = async () => { failed = true; return {}; };
  f.service.jobs.renew = async () => true;
  const worker = new EvolutionWorker({service: f.service, config: {evolutionEnabled: true}, callbacks: { build: async (payload, {signal}) => { started(); await new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('Aborted')), {once: true}); }); } }});
  const pending = worker.tick(); await ready; await worker.close(); await pending;
  assert.equal(failed, true); assert.equal(worker.running, false); assert.equal(worker.timer, null);
});

test('actual call and card reads count independently while harm remains per run', async () => {
  const f=fixture(); const maintenance=new EvolutionMaintenance({service:f.service});
  await f.service.registerTool({id:'call-tool',track:'M',artifactDigest:'calls'});
  await maintenance.observe('call-tool',{runId:'run',retrieved:true,retrievalId:'read-one'});
  await maintenance.observe('call-tool',{runId:'run',retrieved:true,retrievalId:'read-one'});
  for (const callId of ['one','two','two']) await maintenance.observe('call-tool',{runId:'run',callId,invoked:true,outcome:'pending'});
  let row=await f.service.get('call-tool'); assert.equal(row.payload.usage.executionCount,2); assert.equal(row.payload.usage.retrieved,1); assert.equal(row.payload.usage.runs,0);
  await maintenance.observe('call-tool',{runId:'run',invoked:true,outcome:'accepted'});
  row=await f.service.get('call-tool'); assert.equal(row.payload.usage.runs,1); assert.equal(row.payload.usage.succeeded,2);
});

test('monthly overlap proposals never bypass replay and retrieval evaluation needs actual selections', async () => {
  const f=fixture(); const proposals=[]; const maintenance=new EvolutionMaintenance({service:f.service,callbacks:{proposeReview:async input=>proposals.push(input)}});
  for (const id of ['same-one','same-two']) await f.service.registerTool({id,track:'M',artifactDigest:id,name:'Cohort model',description:'Cohort model',holdoutCases:[{id:'reference',sha256:'immutable'}]});
  f.advance(31*86400000); const report=await maintenance.monthly(); await maintenance.monthly(); assert.equal(report.payload.reviews.length,2);
  assert.ok(proposals.some(item=>item.category==='tool-merge')); assert.equal((await f.service.get('same-one')).payload.status,'active');
  const benchmark=evolutionRetrievalBenchmark(await f.service.tools()); assert.equal(benchmark.length,1); assert.equal(evolutionRetrievalScore(benchmark,[]).selectionAccuracy,null);
  assert.equal(evolutionRetrievalScore(benchmark,[{caseId:benchmark[0].id,toolId:'wrong'}]).selectionAccuracy,0);
  assert.equal(evolutionRetrievalScore(benchmark,[{caseId:benchmark[0].id,toolId:'same-two'}]).selectionAccuracy,1);
  assert.equal(f.jobs.filter(job=>job.payload.action==='retrieval-selection').length,1);
});

test('merge verification checks every source case without activating a tool or aliases', async () => {
  const f=fixture();
  for (const id of ['parent-a','parent-b']) await f.service.registerTool({id,track:'M',artifactDigest:id,holdoutCases:[{id,sha256:id}]});
  const maintenance=new EvolutionMaintenance({service:f.service,callbacks:{replayCases:async({cases})=>({independent:true,passedCaseIds:cases.map(item=>item.id)})}});
  const verified=await maintenance.verifyMerge(['parent-a','parent-b'],{id:'merged',track:'M'});assert.equal(verified.cases.length,2);
  assert.equal(await f.service.get('merged'),null);assert.equal((await f.service.get('parent-a')).payload.status,'active');
  await f.service.registerTool({id:'merged',track:'M',artifactDigest:'merged'});
  const merged=await maintenance.merge(['parent-a','parent-b'],{id:'merged',track:'M',artifactDigest:'merged',status:'ready'});assert.equal(merged.payload.holdoutCases.length,2);
  assert.equal((await f.service.get('parent-a')).payload.status,'alias');
});

test('per-call execution failures remain distinct from accepted run feedback', async () => {
  const {createEvolutionFeedback}=await import('../src/evolutionFeedback.mjs');
  const f=fixture(),maintenance=new EvolutionMaintenance({service:f.service});
  await f.service.registerTool({id:'feedback-tool',track:'M',artifactDigest:'feedback'});
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
  await f.service.registerTool({id:'staged-tool',track:'M',status:'staged',artifactDigest:'staged-pin'});
  await f.service.waitFor({userId:'alice',projectId:'research',agendaId:'agenda',kind:'tool',toolId:'staged-tool'});
  for (const id of ['a','b']) await f.service.recordAssessment('staged-tool',{id,caseId:id,kind:'published-case',independent:true,passed:true,exposed:false,retracted:false});
  assert.equal(woke,0);assert.equal((await f.service.availableTools()).length,0);
  assert.equal((await f.service.registerTool({id:'staged-tool',track:'M',status:'staged',artifactDigest:'staged-pin'})).payload.validationLevel,'V2');
  const row=await f.service.get('staged-tool');await f.service.save('tool',row.id,{...row.payload,status:'active'},row);
  await f.service.resolveWaiters({type:'tool-ready',toolId:'staged-tool'});assert.equal(woke,1);assert.equal((await f.service.availableTools()).length,1);
});

test('a concluded harm test is not restarted: later corrections are counted and do not retire', async () => {
  // This case used to assert the opposite ("completed clear epochs cannot hide later harm"): a fresh test
  // after every concluded one. That restart is what retired a harmless tool 33% of the time by 100 runs.
  const f=fixture(),proposals=[],maintenance=new EvolutionMaintenance({service:f.service,callbacks:{proposeReview:async input=>proposals.push(input)}});
  await f.service.registerTool({id:'epoch-tool',track:'M',artifactDigest:'epochs'});
  for(let index=0;index<40;index++){f.advance(1);await maintenance.observe('epoch-tool',{runId:`clear-${index}`,userId:`researcher-${index}`,callId:`call-${index}`,executionOk:true,invoked:true,outcome:'accepted',feedbackEventId:`adopt-${index}`});}
  let tool=await f.service.get('epoch-tool');assert.equal(tool.payload.usage.harmState,'clear');assert.equal(tool.payload.usage.harmEpochs,undefined);assert.equal(tool.payload.usage.harm.trials.length,3);
  for(let index=0;index<6;index++){f.advance(1);await maintenance.observe('epoch-tool',{runId:`later-${index}`,userId:`late-researcher-${index}`,callId:`later-call-${index}`,executionOk:false,invoked:true,outcome:'pending'});}
  for(let index=0;index<6;index++)await maintenance.observe('epoch-tool',{runId:`later-${index}`,userId:`late-researcher-${index}`,invoked:true,outcome:'rejected',corrected:true,feedbackEventId:`returned-${index}`});
  tool=await f.service.get('epoch-tool');assert.equal(tool.payload.status,'active');assert.equal(tool.payload.usage.harmState,'clear');assert.equal(proposals.length,0);
  assert.equal(tool.payload.usage.runs,46);assert.equal(tool.payload.usage.corrected,6);
});

test('worker resource failures are bounded, deduplicated and stop automatic daily scout spending', async () => {
  const f=fixture(),decisions=new EvolutionDecisions({service:f.service,callbacks:{execute:async()=>({state:'waiting'})}});
  const worker=new EvolutionWorker({service:f.service,decisions,maintenance:{},config:{releaseId:'acceptance-release',sourceRevision:'a'.repeat(40)}});
  await worker.resourceWait({kind:'evolution-scout'},Object.assign(new Error('private narrative'),{code:'provider_unavailable'}));
  await worker.resourceWait({kind:'evolution-scout'},Object.assign(new Error('private narrative'),{code:'provider_unavailable'}));
  await worker.housekeeping();await worker.housekeeping();
  assert.equal((await f.service.list('failure')).length,1);assert.equal((await f.service.list('decision')).length,1);
  assert.ok(!JSON.stringify(await f.service.list('failure')).includes('private narrative'));assert.equal(f.jobs.filter(job=>job.kind==='evolution-scout').length,0);
  assert.equal(f.jobs.filter(job=>job.payload.action==='release-replay').length,1);
});
test('compute-only self-check claims retain budget and concurrency without requiring a new DSH slot', async () => {
  const scopes=[];
  const client={query:async query=>({rows:query.includes('count(*)')?[{count:0}]:[]})};
  const service={list:async()=>[],jobs:{claim:async(kinds,_worker,{admission,candidateAdmission})=>{scopes.push(kinds);const candidate={userId:'owner',id:'check',kind:'evolution-self-check',payload:{},leaseToken:'lease'};return await admission(client)&&await candidateAdmission(client,candidate)?candidate:null;},renew:async()=>true,finish:async()=>({status:'done'})},completeSelfCheck:async()=>{}};
  const worker=new EvolutionWorker({service,config:{evolutionEnabled:true},callbacks:{dailyCost:async()=>1,admitRuntime:async(_client,{kinds})=>kinds.every(kind=>kind==='evolution-self-check'),selfCheck:async()=>({payload:{status:'passed'}})}});
  worker.housekeeping=async()=>{};
  assert.equal((await worker.tick({kinds:['evolution-self-check']})).status,'done');
  assert.deepEqual(scopes,[['evolution-self-check']]);
  await assert.rejects(worker.tick({kinds:['unknown']}),/Unknown evolution job subset/);
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

test('public boundary maintenance repairs expose only executed public failed case identities and preserve the original',async()=>{
  const f=fixture();await f.service.addDossier({id:'original',goal:'Original method',feedback:{passed:true}});
  await f.service.save('tool','published',{dossierId:'original',artifactDigest:'immutable'});
  await f.service.save('maintenance-review','public-review',{kind:'public-boundary-regression',parentToolIds:['published'],executions:[{caseId:'public-negative',executed:true,passed:false},{caseId:'public-control',executed:true,passed:true},{caseId:'not-executed',executed:false,passed:false}]});
  const maintenance=new EvolutionMaintenance({service:f.service});
  await maintenance.executeReview({subjectId:'public-review',actionId:'repair',option:'repair'});
  const repair=(await f.service.dossiers()).find(row=>row.id!=='original');
  assert.deepEqual(repair.payload.feedback,{passed:false,failedCaseIds:['public-negative'],issueCodes:['public_development_case_failed']});
  assert.match(repair.payload.goal,/public input-boundary regression/);assert.equal((await f.service.get('original')).payload.feedback.passed,true);
});

test('late maintenance keep restores exact retirement pin and merge parents without overwriting newer branches',async()=>{
 const {service}=fixture();const pins=[];
 const maintenance=new EvolutionMaintenance({service,callbacks:{restorePin:async pin=>pins.push(pin),notifyAffected:async()=>{}}});
 await service.registerTool({id:'restore-parent',track:'M',artifactDigest:'restore-pin',revision:2});
 let parent=await service.get('restore-parent');
 parent=await service.save('tool',parent.id,{...parent.payload,status:'retired',retirement:{reason:'monthly-direction-review',state:'complete'}},parent);
 const review=await service.save('maintenance-review','restore-review',{kind:'retirement',parentToolIds:[parent.id]});
 await maintenance.executeReview({id:'decision1',subjectId:review.id,option:'keep',actionId:'latekeep1'});
 assert.equal((await service.get(parent.id)).payload.status,'active');assert.deepEqual(pins[0],{id:parent.id,digest:'restore-pin',revision:2});
 await service.registerTool({id:'restore-merged',track:'M',artifactDigest:'merged-pin',lineage:{parents:[parent.id]}});
 parent=await service.get(parent.id);await service.save('tool',parent.id,{...parent.payload,status:'alias',replacedBy:'restore-merged'},parent);
 const mergeReview=await service.save('maintenance-review','restore-merge-review',{kind:'merge',parentToolIds:[parent.id]});
 await maintenance.executeReview({id:'decision2',subjectId:mergeReview.id,option:'keep',actionId:'latekeep2'});
 assert.equal((await service.get(parent.id)).payload.status,'active');assert.equal((await service.get('restore-merged')).payload.status,'retired');
 parent=await service.get(parent.id);await service.save('tool',parent.id,{...parent.payload,status:'alias',replacedBy:'newer-branch'},parent);
 await assert.rejects(maintenance.executeReview({id:'decision2',subjectId:mergeReview.id,option:'keep',actionId:'latekeep3'}),error=>error.code==='evolution_evaluation_invalid');
 parent=await service.get(parent.id);await service.save('tool',parent.id,{...parent.payload,status:'retired',replacedBy:null,retirement:{reason:'published-replay-regression'}},parent);
 await assert.rejects(maintenance.executeReview({id:'decision1',subjectId:review.id,option:'keep',actionId:'latekeep4'}),error=>error.code==='evolution_evaluation_invalid');
});

test('decision review requires actual provider-reported independent model identity',()=>{
 assert.equal(evolutionDecisionReviewProof({reviewProvider:'dashscope'},{model:'qwen3',modelReported:false}).independent,false);
 assert.equal(evolutionDecisionReviewProof({reviewProvider:'dashscope'},{model:'deepseek-flash',modelReported:true}).independent,false);
 assert.equal(evolutionDecisionReviewProof({reviewProvider:'dashscope'},{model:'qwen3',modelReported:true}).independent,true);
});

test('restoration failure compensates pin and retries; a later harm retirement is reversible only by its own review',async()=>{
 const {service}=fixture();let fail=true,activated=0,deactivated=0;const proposals=[];
 const maintenance=new EvolutionMaintenance({service,callbacks:{restorePin:async()=>{activated++;if(fail)throw Error('activation interrupted');},retirePin:async()=>{deactivated++;},notifyAffected:async()=>{},proposeReview:async input=>proposals.push(input)}});
 await service.registerTool({id:'epoch-tool',track:'M',artifactDigest:'epoch-pin'});
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
 for(let index=0;index<6;index++) await decisions.propose(proposal(`autonomous-${index}`,{category:categories[index%4],directional:false,title:`Highlighted decision ${index}`}));
 const manual=await decisions.propose(proposal('manual-decision',{category:'manual-only',title:'Manually selected item'}));
 await decisions.resolve(manual.id,{expectedRevision:manual.revision,option:'hold'});
 await decisions.digest();const body=f.notices.at(-1).body;
 for(const [index,label] of ['工具研发方向','工具修复','工具合并','工具退役'].entries()) assert.ok(body.includes(`${label}：${index<2?2:1} 项`));
 for(const category of categories) assert.equal(body.includes(category),false,'an internal category identifier is not text for the operator');
 assert.equal((body.match(/Highlighted decision/g)??[]).length,3);
 assert.equal(body.includes('manual-only'),false);assert.equal(body.includes('Manually selected item'),false);
});

test('actual imported engine units appear as method cases, never complete research',()=>{
 const summary=evolutionEvaluationDigest({id:'imported',payload:{scope:'deterministic-method-only',summary:{scored:true,methodCases:10,passed:8},units:Array.from({length:10},(_,index)=>({type:'method',capabilityId:'meta-analysis',allStagesValid:index<8}))}});
 assert.ok(summary.lines[0].includes('方法算例：8/10 有效'));
 assert.equal(summary.lines[0].includes('完整研究'),false);
});

test('J12 proposes only semantically same tools with actual overlapping cases, retaining lexical fallback', async () => {
  for (const relation of ['same', 'related', 'different', 'fallback']) {
    const f = fixture();
    const maintenance = new EvolutionMaintenance({ service: f.service, judgeService: { judge: async site => { assert.equal(site, 'J12'); return relation === 'fallback' ? { outcome: 'fallback' } : { outcome: 'settled', value: { relation } }; } } });
    for (const id of ['one', 'two']) await f.service.registerTool({ id, track: 'M', artifactDigest: id, name: 'Cohort model', description: 'Cohort model', holdoutCases: [{ id: 'reference', sha256: 'immutable' }] });
    f.advance(31 * 86400000);
    const result = await maintenance.monthly();
    const reviews = await Promise.all(result.payload.reviews.map(id => f.service.get(id)));
    assert.equal(reviews.some(row => row.payload.kind === 'merge'), ['same', 'fallback'].includes(relation));
    assert.equal((await f.service.get('one')).payload.status, 'active');
    assert.equal((await f.service.get('two')).payload.status, 'active');
  }
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
  const { evolutionRetirementNotice } = await import('../src/evolutionDecisions.mjs');
  const notice = evolutionRetirementNotice({ name: '调查加权分析', toolId: 'tool-survey-0a1b2c', reason: 'sequential-harm' });
  assert.match(notice.body, /“调查加权分析”已停用，原因：使用中连续出现需要纠正的结果/);
  assert.doesNotMatch(notice.body, /tool-survey|sequential-harm/);
  assert.match(evolutionRetirementNotice({ toolId: 'x', reason: 'an-unnamed-code' }).body, /“科研工具”已停用，原因：不再满足验证要求/);
});

test('only a run that could not use a tool or engine is a lead for the module; a spent budget, a stop or an outage is not', async () => {
  const { evolutionRunGap } = await import('../src/evolutionIntegration.mjs');
  assert.equal(evolutionRunGap({ errorCode: 'runtime_tool_error' }), 'method-implementation');
  for (const errorCode of ['usage_budget_exceeded', 'runtime_spend_limit_reached', 'runtime_stopped', 'runtime_session_error', 'autopilot_daily_budget_spent', 'canceled', undefined, null])
    assert.equal(evolutionRunGap({ errorCode }), null, String(errorCode));
});
