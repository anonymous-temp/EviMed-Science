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
  nodes: ['assumption:response@1', 'result:trial@1'], frozenInput: { report: 'Response probability is 0.25.', evidence: [], assumptions: [{ key: 'response', version: 1, value: 0.25 }] },
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
  assert.notEqual(calls[0].messages[0].content, calls[1].messages[0].content);
  assert.notEqual(rows[0].subject.role, rows[1].subject.role);
  assert.equal(rows[0].configuration.model, 'configured-reviewer');
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
