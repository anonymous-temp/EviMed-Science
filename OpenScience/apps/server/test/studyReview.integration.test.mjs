import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { ProductJobs } from '../src/productJobs.mjs';
import { migrateProductStore } from '../src/productPersistence.mjs';
import { ReviewService } from '../src/reviewService.mjs';
import { ReviewWorker } from '../src/reviewWorker.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && 'A local test PostgreSQL is required.' };
let database, isolated, jobs;
const calls = [];
const config = { reviewEnabled: true, reviewModel: 'configured-reviewer', reviewApiBase: 'https://review.invalid', dashscopeApiKey: 'test-key',
  reviewEditorTimeoutMs: 1000, reviewThinkingBudget: 100, reviewMaxOutputTokens: 1000 };
const identity = { userId: 'alice', projectId: 'project' };
const input = (role = 'clinical', suffix = '') => ({ subjectRef: { kind: 'vcr', studyId: `study${suffix}` }, role,
  // Each suffix is its own bytes: the same bytes asked of the same reviewer are answered from the project's own earlier answer
  // (`StudyReviews.#answeredBefore`), so a test that wants a model call, a refusal or a stale lease needs a snapshot of its own.
  nodes: ['assumption:response@1', 'result:trial@1'], frozenInput: { report: `Response probability is 0.25.${suffix ? ` (${suffix})` : ''}`, evidence: [], assumptions: [{ key: 'response', version: 1, value: 0.25 }] },
  deterministic: { findings: [], references: { checked: 0 }, numbers: { checked: 1 } } });
const answer = (value = { findings: [{ kind: 'none', location: '', evidence: '', fix: '' }], checklist: [], acceptance: [] }) => new Response(
  `data: ${JSON.stringify({ id: 'request-actual', model: 'actual-reviewer-2026', choices: [{ delta: { content: JSON.stringify(value) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`,
  { status: 200, headers: { 'content-type': 'text/event-stream' } });
function service(fetchImpl = async (_url, request) => { calls.push(JSON.parse(request.body)); return answer(); }) {
  const instance = new ReviewService({ config, database, jobs, store: {}, fetchImpl });
  instance.registerStudyReviewAdapter('vcr', { persist: async () => {} });
  return instance;
}
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, 'studyreview');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 8, databaseConnectionTimeoutMs: 5000 });
  await migrateProductStore(database); jobs = new ProductJobs(database);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ('alice','Alice','development')");
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ('alice','project','Study',1048576)");
  await service().ready();
});
after(async () => { await database?.close(); await isolated?.drop(); });

test('durable role reviews dedupe, use fresh context and preserve actual model and usage', options, async () => {
  const first = service();
  const requests = await Promise.all(Array.from({ length: 4 }, () => first.requestStudyReview(identity, input())));
  assert.equal(new Set(requests.map(row => row.reviewId)).size, 1);
  await first.requestStudyReview(identity, input('statistical'));
  const restarted = service(); await restarted.ready();
  const worker = new ReviewWorker({ service: restarted });
  restarted.processReplyChecks = async () => 0;
  await worker.tick(); await worker.tick();
  const rows = (await database.query('SELECT * FROM evimed_review.reviews ORDER BY created_at')).rows;
  assert.equal(rows.length, 2); assert.ok(rows.every(row => row.status === 'done'));
  assert.ok(rows.every(row => row.model === 'actual-reviewer-2026' && row.usage.completionTokens === 20));
  assert.equal(calls.length, 2);
  for (const call of calls) { assert.deepEqual(call.messages.map(message => message.role), ['system', 'user']); assert.ok(!call.messages.some(message => message.role === 'assistant')); }
  // Both reviewers are told the same thing and shown the same snapshot first, so the second call finds all of it in the provider's prefix
  // cache; only the closing line — which reviewer this is, and what to look at — differs, and neither is shown the other's answer.
  assert.equal(calls[0].messages[0].content, calls[1].messages[0].content);
  const [clinicalMessage, statisticalMessage] = calls.map(call => call.messages[1].content);
  const [clinicalSnapshot, clinicalRole] = clinicalMessage.split('\n\n本次你的角色：');
  const [statisticalSnapshot, statisticalRole] = statisticalMessage.split('\n\n本次你的角色：');
  assert.ok(clinicalSnapshot.length > 100 && clinicalSnapshot === statisticalSnapshot, 'the same snapshot leads the user message for both roles');
  assert.match(clinicalRole, /^临床审稿人/); assert.match(statisticalRole, /^统计方法审稿人/);
  assert.notEqual(rows[0].subject.role, rows[1].subject.role);
  assert.equal(rows[0].configuration.model, 'configured-reviewer');
  // A closed schema is not an essay: the reviewer does not think, and is not given room to.
  for (const call of calls) { assert.equal(call.enable_thinking, false); assert.ok(call.max_tokens <= 1000); }
  assert.equal(rows[0].configuration.revision, 'study-review-v2');
  assert.equal(rows[0].configuration.thinkingBudget, 0);
});

test('model failure and empty output stay visible with deterministic findings and no delivery gate', options, async () => {
  for (const [suffix, fetcher] of [['unavailable', async () => new Response('{}', { status: 503 })], ['empty', async () => answer({ findings: [], checklist: [], acceptance: [] })]]) {
    const instance = service(fetcher);
    const pending = input('clinical', suffix);
    pending.deterministic.findings.push({ kind: 'numeric_untraced', location: 'result:trial@1', evidence: '0.25', fix: '', message: 'Stored result hash is missing.' });
    const requested = await instance.requestStudyReview(identity, pending);
    await instance.processStudyReviews('test-review-worker');
    const row = (await database.query('SELECT * FROM evimed_review.reviews WHERE id=$1', [requested.reviewId])).rows[0];
    assert.equal(row.status, 'failed'); assert.ok(row.error_code);
    assert.equal(row.deterministic.findings.length, 1);
    assert.equal((await database.query('SELECT count(*) FROM evimed_review.findings WHERE review_id=$1', [row.id])).rows[0].count, '1');
  }
});

test('expired worker cannot attach a stale completion after a successor claimed the review', options, async () => {
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const old = service(async () => { started(); await blocked; return answer({ findings: [{ kind: 'wording', location: 'report', evidence: 'Response probability', fix: 'Explain this value.' }], checklist: [], acceptance: [] }); });
  const requested = await old.requestStudyReview(identity, input('clinical', 'lease'));
  const oldWork = old.processStudyReviews('old-worker'); await entered;
  await database.query("UPDATE evimed_product.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE payload->>'reviewId'=$1", [requested.reviewId]);
  await service().processStudyReviews('new-worker'); release(); await oldWork;
  const findings = (await database.query('SELECT * FROM evimed_review.findings WHERE review_id=$1', [requested.reviewId])).rows;
  assert.equal(findings.length, 0);
  assert.equal((await database.query('SELECT status FROM evimed_review.reviews WHERE id=$1', [requested.reviewId])).rows[0].status, 'done');
});

test('VCR adapter uses current stored versions, preserves optional human identity and shows failures without stopping exports', options, async () => {
  const { VcrStore } = await import('../src/vcrStore.mjs');
  const { VcrService } = await import('../src/vcrService.mjs');
  const { createVcrReviewAdapter } = await import('../src/vcrReview.mjs');
  const { vcrReviewIsCurrent, vcrCurrentNodes } = await import('../src/vcrViews.mjs');
  const store = new VcrStore({ database }); await store.ready();
  const study = await store.createStudy({ userId: 'alice', projectId: 'project', name: 'Independent reviews', question: 'Describe uncertainty.' });
  await store.saveDefinition({ userId: 'alice', studyId: study.id, pico: {}, estimand: {}, endpointType: 'binary' });
  await store.saveAssumption({ userId: 'alice', studyId: study.id, key: 'rate', name: 'Rate', pointValue: 0.25, valueSource: 'assumed', sourceKind: 'scenario' });
  const vcr = { store, service: new VcrService({ store, config: { vcrMinCell: 5 } }) };
  const reviewer = service(); const adapter = createVcrReviewAdapter({ vcr, reviewService: reviewer });
  const first = await adapter.queue(study.id); assert.equal(first.length, 2);
  await reviewer.processStudyReviews('vcr-review-worker'); await reviewer.processStudyReviews('vcr-review-worker');
  let reviews = await store.reviews(study.id);
  assert.equal(reviews.length, 2); assert.ok(reviews.every(row => row.reviewerKind === 'ai' && row.status === 'done' && row.reviewer === ''));
  assert.ok(reviews.every(row => row.provenance.model === 'actual-reviewer-2026' && row.provenance.configuration.model === 'configured-reviewer'));
  const same = await adapter.queue(study.id); assert.deepEqual(same.map(row => row.reviewId), first.map(row => row.reviewId));
  const human = await store.addReview({ studyId: study.id, userId: 'alice', kind: 'clinical', nodes: first[0].nodes, reviewer: 'alice' });
  assert.equal(human.reviewerKind, 'human'); assert.equal(human.reviewer, 'alice');
  await store.saveAssumption({ userId: 'alice', studyId: study.id, key: 'rate', name: 'Rate', pointValue: 0.8, valueSource: 'assumed', sourceKind: 'scenario' });
  const current = vcrCurrentNodes({ study, assumptions: await store.assumptions(study.id), definition: await store.latestDefinition(study.id) });
  assert.equal(vcrReviewIsCurrent(reviews[0], { results: [], current }), false);
  const changed = await adapter.queue(study.id); assert.notEqual(changed[0].reviewId, first[0].reviewId);
  const unavailable = createVcrReviewAdapter({ vcr, reviewService: null }); await unavailable.queue(study.id);
  reviews = await store.reviews(study.id); assert.ok(reviews.some(row => row.status === 'failed' && row.provenance.error === 'review_disabled'));
  const exported = await store.createExport({ userId: 'alice', studyId: study.id, kind: 'study_package' }); assert.ok(exported.id);
});

test('final expired lease is visible after restart and does not remain pending forever', options, async () => {
  const instance = service();
  const requested = await instance.requestStudyReview(identity, input('clinical', 'exhausted'));
  await database.query("UPDATE evimed_product.jobs SET status='running',attempts=max_attempts,lease_token='old',lease_expires_at=clock_timestamp()-interval '1 second' WHERE payload->>'reviewId'=$1", [requested.reviewId]);
  await instance.studyReviews.reconcileExhausted();
  const row = (await database.query('SELECT status,error_code FROM evimed_review.reviews WHERE id=$1', [requested.reviewId])).rows[0];
  assert.equal(row.status, 'failed'); assert.equal(row.error_code, 'review_interrupted');
});

test('a changed reviewer configuration creates a separate review and identity-less response is never attested', options, async () => {
  const one = service(); const request = input('clinical', 'identity');
  const first = await one.requestStudyReview(identity, request);
  const two = service(); two.config = { ...config, reviewModel: 'another-reviewer' };
  const second = await two.requestStudyReview(identity, request);
  assert.notEqual(first.reviewId, second.reviewId);
  const missing = service(async () => new Response('data: {"choices":[{"delta":{"content":"{\\"findings\\":[{\\"kind\\":\\"none\\"}],\\"checklist\\":[],\\"acceptance\\":[]}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":20}}\n\ndata: [DONE]\n\n', { status: 200 }));
  while (await missing.processStudyReviews('identity-worker')) { /* Drain only this isolated test database's queue. */ }
  const row = (await database.query('SELECT status,error_code,model FROM evimed_review.reviews WHERE id=$1', [first.reviewId])).rows[0];
  assert.equal(row.status, 'failed'); assert.equal(row.error_code, 'review_model_identity_missing'); assert.equal(row.model, null);
});

test('post-completion hook retries after restart and repeated request retains completed findings', options, async () => {
  const instance = service(async () => answer({ findings: [{ kind: 'wording', location: 'report', evidence: 'Response probability', fix: 'Explain the assumption.' }], checklist: [], acceptance: [] }));
  let notifications = 0;
  instance.registerStudyReviewAdapter('vcr', { persist: async () => {}, completed: async () => { notifications++; throw new Error('Transient hook failure'); } });
  const requested = await instance.requestStudyReview(identity, input('clinical', 'notification'));
  await instance.processStudyReviews('notification-worker');
  assert.ok(notifications > 0);
  const restarted = service(); let saved;
  restarted.registerStudyReviewAdapter('vcr', { persist: async (_client, row) => { saved = row; }, completed: async () => { notifications++; } });
  await restarted.studyReviews.notifyCompleted();
  await restarted.requestStudyReview(identity, input('clinical', 'notification'));
  assert.equal(saved.findings.length, 1);
  assert.equal((await database.query('SELECT completion_notified FROM evimed_review.reviews WHERE id=$1', [requested.reviewId])).rows[0].completion_notified, true);
});

test('restarted study review refuses provider drift before any model request and preserves its frozen configuration', options, async () => {
  const original = service();
  const requested = await original.requestStudyReview(identity, input('clinical', 'provider-drift'));
  const frozen = (await database.query('SELECT configuration,frozen_input FROM evimed_review.reviews WHERE id=$1', [requested.reviewId])).rows[0];
  let sent = 0;
  const restarted = service(async () => { sent++; return answer(); });
  restarted.config = { ...config, reviewApiBase: 'https://different-provider.invalid' };
  await restarted.ready(); await restarted.processStudyReviews('provider-drift-worker');
  const saved = (await database.query('SELECT status,error_code,configuration,frozen_input,model,usage FROM evimed_review.reviews WHERE id=$1', [requested.reviewId])).rows[0];
  assert.equal(sent, 0); assert.equal(saved.status, 'failed'); assert.equal(saved.error_code, 'review_configuration_changed');
  assert.deepEqual(saved.configuration, frozen.configuration); assert.deepEqual(saved.frozen_input, frozen.frozen_input);
  assert.equal(saved.model, null); assert.deepEqual(saved.usage, {});
  const replacement = await restarted.requestStudyReview(identity, input('clinical', 'provider-drift'));
  assert.notEqual(replacement.reviewId, requested.reviewId);
  await restarted.processStudyReviews('provider-drift-worker'); assert.equal(sent, 1);
});

test('report-only changes invalidate export reviews and stale completion cannot schedule repair', options, async () => {
  const { VcrStore } = await import('../src/vcrStore.mjs');
  const { VcrService } = await import('../src/vcrService.mjs');
  const { createVcrReviewAdapter } = await import('../src/vcrReview.mjs');
  const store = new VcrStore({ database }); await store.ready();
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ('alice','report-project','Report',1048576)");
  const study = await store.createStudy({ userId: 'alice', projectId: 'report-project', name: 'Report revision', question: 'Describe uncertainty.' });
  await store.saveDefinition({ userId: 'alice', studyId: study.id, pico: {}, estimand: {}, endpointType: 'binary' });
  const research = new VcrService({ store, config: {} });
  const model = await research.reportModel(study);
  const exported = await store.createExport({ userId: 'alice', studyId: study.id, kind: 'study_package', cover: { results: model, reports: [{ section: 'main', template: 'Original claim.' }] } });
  let repairs = 0;
  const vcr = { store, service: research, orchestrator: { requestReviewRepair: async () => { repairs++; } } };
  const reviewer = service(async () => answer({ findings: [{ kind: 'wording', location: 'main', evidence: 'Original claim.', fix: 'Clarify uncertainty.' }], checklist: [], acceptance: [] }));
  const adapter = createVcrReviewAdapter({ vcr, reviewService: reviewer });
  const first = await adapter.queue(study.id, { exportId: exported.id });
  await reviewer.processStudyReviews('report-revision-worker');
  assert.equal(repairs, 0);
  await store.updateExportCover(exported.id, cover => ({ ...cover, reports: [{ section: 'main', template: 'Revised claim.' }] }));
  await reviewer.processStudyReviews('report-revision-worker');
  assert.equal(repairs, 0, 'The second old review cannot repair new report prose.');
  const view = await research.studyViewOf(study);
  assert.ok(view.review.records.filter(row => first.some(record => record.reviewId === row.platformReviewId)).every(row => row.state === 'changed_after_review'));
  const next = await adapter.queue(study.id, { exportId: exported.id });
  assert.notEqual(next[0].reviewId, first[0].reviewId);
  assert.notEqual(next[0].subjectRef.reportRevision, first[0].subjectRef.reportRevision);
  const before = next[0].subjectRef.reportRevision;
  await store.updateExportCover(exported.id, cover => ({ ...cover, documentExportId: 'asynchronous-conversion', reviews: [{ status: 'running' }],
    results: { ...cover.results, review: { records: [{ status: 'running' }] } } }));
  const unchanged = await adapter.queue(study.id, { exportId: exported.id });
  assert.equal(unchanged[0].subjectRef.reportRevision, before);
  assert.equal(unchanged[0].reviewId, next[0].reviewId);
  await reviewer.processStudyReviews('report-revision-worker'); await reviewer.processStudyReviews('report-revision-worker');
  const copy = await store.createExport({ userId: 'alice', studyId: study.id, kind: 'study_package', cover: { results: model, reports: [{ section: 'main', template: 'Original claim.' }] } });
  await adapter.queue(study.id, { exportId: copy.id });
  await reviewer.processStudyReviews('report-revision-worker');
  assert.equal(repairs, 0, 'Identical prose in another export cannot supply the missing second role.');
  await reviewer.processStudyReviews('report-revision-worker');
  assert.equal(repairs, 1, 'Repair is requested only after both roles for this exact report finish.');
});

test('completed retained VCR packages automatically review and dispatch one independent report revision while preserving original exports', options, async () => {
  const { VcrStore } = await import('../src/vcrStore.mjs');
  const { VcrService } = await import('../src/vcrService.mjs');
  const { VcrJobs } = await import('../src/vcrJobs.mjs');
  const { VcrOrchestrator } = await import('../src/vcrOrchestrator.mjs');
  const { createVcrReviewAdapter } = await import('../src/vcrReview.mjs');
  const store = new VcrStore({ database }); await store.ready();
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ('alice','automatic-review-project','Automatic review',1048576)");
  const study = await store.createStudy({ userId: 'alice', projectId: 'automatic-review-project', name: 'Retained report', question: '' });
  await store.saveDefinition({ userId: 'alice', studyId: study.id, pico: {}, estimand: {}, endpointType: 'binary' });
  await store.setStep(study.id, 'definition', { requested: true });
  const research = new VcrService({ store, config: {} });
  const dispatched = [], conversions = [];
  let adapter;
  const orchestrator = new VcrOrchestrator({ store, jobs: new VcrJobs({ store, config: {}, engine: {} }),
    config: { vcrEnabled: true, vcrAudience: 'all' }, queueReviews: (id, input) => adapter.queue(id, input),
    queueExport: async (_user, _study, row) => { conversions.push(row.id); return { id: 'retained-conversion' }; },
    dispatchRun: async input => { dispatched.push(input); return { runId: `run_auto_${dispatched.length}`, sessionId: `session_auto_${dispatched.length}` }; } });
  const reviewer = service(async () => answer({ findings: [{ kind: 'wording', location: 'main', evidence: 'Original claim.', fix: 'Clarify uncertainty.' }], checklist: [], acceptance: [] }));
  adapter = createVcrReviewAdapter({ vcr: { store, service: research, orchestrator }, reviewService: reviewer });
  const requested = await orchestrator.requestExport({ id: study.userId }, study, 'study_package');
  assert.equal(dispatched.length, 1);
  const { vcrRuntimeWrite: writeReport } = await import('../src/vcrGateway.mjs');
  const written = await writeReport({ store, service: research, orchestrator, study, what: 'report', items: null,
    data: { kind: 'study_package', template: 'Original claim.' } });
  assert.deepEqual(written.issues, []);
  await store.updateExportCover(requested.export.id, cover => ({ ...cover, documentExportId: 'original-word-pdf' }));
  const original = await store.exportRow(study.id, requested.export.id);
  await orchestrator.onRunFinished({ userId: study.userId, id: study.projectId }, { id: requested.runId, dispatchId: dispatched[0].dispatchId, status: 'succeeded' });
  assert.deepEqual(conversions, [original.id]);
  assert.equal((await store.reviews(study.id)).length, 2, 'Both roles are queued from completion without a second user request.');
  await reviewer.processStudyReviews('auto-review-worker');
  assert.equal(dispatched.length, 1, 'The other independent role must finish.');
  await reviewer.processStudyReviews('auto-review-worker');
  assert.equal(dispatched.length, 2);
  assert.equal(dispatched[1].reason, 'vcr:review-repair');
  assert.match(dispatched[1].brief, /Original claim\./);
  assert.match(dispatched[1].brief, /Clarify uncertainty\./);
  assert.match(dispatched[1].brief, /Do not rerun engines or invent inputs\./);
  const exports = await store.exports(study.id);
  const revision = exports.find(row => row.cover.revisionOf === original.id);
  assert.ok(revision); assert.notEqual(revision.id, original.id);
  assert.equal(revision.cover.documentExportId, undefined);
  const { reviewDocumentRefresh: pendingConversion, ...retainedCover } = (await store.exportRow(study.id, original.id)).cover;
  assert.equal(pendingConversion.state, 'pending');
  assert.deepEqual(retainedCover, original.cover);
  const records = await store.reviews(study.id);
  const completed = records.filter(row => row.provenance.subjectRef?.exportId === original.id);
  const again = await orchestrator.requestReviewRepair(study.id, { exportId: original.id, sourceDigest: completed[0].provenance.inputDigest, reviewIds: completed.map(row => row.platformReviewId) });
  assert.equal(again.queued, false);
  assert.equal(dispatched.length, 2, 'Retries and both completion hooks cannot start another revision.');
  await orchestrator.onRunFinished({ userId: study.userId, id: study.projectId }, { id: 'run_auto_2', dispatchId: dispatched[1].dispatchId, status: 'failed' });
  assert.equal((await store.exportRow(study.id, revision.id)).state, 'failed');
  assert.equal((await store.exportRow(study.id, original.id)).state, 'ready');
  const { reviewDocumentRefresh: _refresh, ...afterFailedRepair } = (await store.exportRow(study.id, original.id)).cover;
  assert.deepEqual(afterFailedRepair, original.cover, 'Failed advice repair never discards the original Word/PDF binding.');
});

test('real multistage job persistence proves both the engine stage and recorded aggregate for review', options, async () => {
  const { VcrStore } = await import('../src/vcrStore.mjs');
  const { VcrJobs, vcrScenarioHash } = await import('../src/vcrJobs.mjs');
  const { vcrComputedOutputHash } = await import('../src/vcrEngineClient.mjs');
  const { buildVcrReviewInput } = await import('../src/vcrReview.mjs');
  const { vcrReportModel } = await import('../src/vcrRender.mjs');
  const store = new VcrStore({ database }); await store.ready();
  const study = await store.createStudy({ userId: 'alice', projectId: 'multi-stage-project', name: 'Multistage trace', intendedUse: 'specified_analysis' });
  const submitted = new Map();
  const engine = { configured: () => true,
    async submit(job) { submitted.set(job.jobId, job); return { jobId: job.jobId, accepted: true }; },
    async status() { return { state: 'succeeded', cpuSeconds: 1, progress: { done: 1, total: 1 } }; },
    async result(id) {
      const job = submitted.get(id);
      const result = { jobId: id, protocolVersion: 1, status: 'succeeded', method: job.method, methodVersion: job.methodVersion,
        scenarioHash: vcrScenarioHash(job.scenario), seed: job.seed, replicates: job.replicates ?? null, conclusion: 'estimable',
        counts: { realPatients: 0, events: 138, effectiveSampleSize: null, generatedRecords: 3600000 },
        measures: job.method === 'design.analytic' ? [{ name: 'required_events', value: 138, simulated: false, source: 'calculated' }]
          : [{ name: 'power', value: 0.812, simulated: true, mcse: 0.0031, source: 'synthetic' }],
        diagnostics: {}, tables: [], manifest: { engineVersion: '1.0.0', rVersion: 'R 4.3.3', packageLockHash: 'b'.repeat(64),
          startedAt: '2026-09-28T10:00:00Z', finishedAt: '2026-09-28T10:00:01Z', cpuSeconds: 1 } };
      result.manifest.outputHash = vcrComputedOutputHash(result);
      return { result, signed: true, refused: false };
    },
  };
  const work = new VcrJobs({ store, engine, config: { vcrJobCpuSeconds: 600, vcrStudyCpuBudget: 1200, vcrMaxConcurrentJobs: 1, vcrLeaseMs: 900000 } });
  const common = { endpoint: { type: 'time_to_event' }, truth: { hazardRatio: 0.7, controlMedian: 6 } };
  for (const stage of ['analytic', 'simulation']) {
    const scenario = stage === 'analytic' ? { ...common, design: { kind: 'two_arm_fixed' }, analysis: { alpha: 0.025, power: 0.9, sided: 1 } }
      : { ...common, design: { kind: 'two_arm_fixed', nTreat: 150, nControl: 150 }, analysis: { method: 'logrank', alpha: 0.025, sided: 1 },
        accrual: { kind: 'uniform', duration: 12, followup: 12 }, performance: ['power'] };
    await work.enqueue({ studyId: study.id, userId: study.userId, kind: stage === 'analytic' ? 'design_analytic' : 'design_simulation', scenario,
      cpuSecondsLimit: 60, idempotencyKey: `multistage:${stage}`, detail: { subjectId: 'scenario-s', resultKind: 'trial_scenario', stage } });
    const [claimed] = await work.claim({ limit: 1 }); assert.ok(claimed);
    await work.advance(claimed); await work.advance(claimed);
  }
  const results = await store.results(study.id, 'trial_scenario');
  assert.equal(results.length, 1); assert.equal(results[0].measures.length, 2);
  const executions = await store.rows('SELECT * FROM evimed_vcr.executions WHERE study_id=$1', [study.id]);
  const last = executions.find(row => row.id === results[0].executionId);
  assert.notEqual(vcrComputedOutputHash(results[0]), last.output_hash, 'The aggregate differs from the final engine stage.');
  const trace = () => buildVcrReviewInput({ model: vcrReportModel({ study, results }), results, executions, evidence: [], reports: [], forModel: value => value });
  assert.ok(!trace().deterministic.findings.some(row => row.kind === 'number_untraced'));
  const originalValue = results[0].measures[0].value;
  results[0].measures[0].value = 999;
  assert.ok(trace().deterministic.findings.some(row => row.kind === 'number_untraced'), 'Tampering with the stored numerical aggregate is still caught.');
  results[0].measures[0].value = originalValue;
  results[0].diagnostics.stageResults.analytic.measures[0].value = 999;
  assert.ok(trace().deterministic.findings.some(row => row.kind === 'number_untraced'), 'Named-stage numerical diagnostics are also bound.');
});

test('a study snapshot hashes the JSON shape persisted across its worker boundary', options, async () => {
  const review = service();
  const request = input('clinical', '-optional-field');
  request.frozenInput.optional = undefined;
  const record = await review.requestStudyReview(identity, request);
  await review.processStudyReviews('optional-field-worker');
  const row = (await database.query('SELECT status,error_code,frozen_input FROM evimed_review.reviews WHERE id=$1', [record.reviewId])).rows[0];
  assert.equal(row.status, 'done', JSON.stringify(row));
  assert.equal(row.error_code, null);
  assert.equal(Object.hasOwn(row.frozen_input, 'optional'), false);
});
