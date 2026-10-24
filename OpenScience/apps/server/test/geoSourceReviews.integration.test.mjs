import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../src/config.mjs';
import { PostgresStore } from '../src/store.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { GeoStore, canonicalJson } from '../src/geoStore.mjs';
import { GeoService } from '../src/geoService.mjs';
import { GeoSignals } from '../src/geoSignals.mjs';
import { GeoSignalResults } from '../src/geoSignalResults.mjs';
import { GeoPlanContext } from '../src/geoPlanContext.mjs';
import { ResultProvenanceService } from '../src/resultProvenanceService.mjs';
import { GeoSourceReviews, summarizeGeoSourceReviews } from '../src/geoSourceReviews.mjs';
import { GeoSignalInputs } from '../src/geoSignalInputs.mjs';
import { GeoArticleResults } from '../src/geoArticleResults.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const options = { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'Disposable PostgreSQL required' };

test('actual captured review bytes need an exact bound request and accepted target successors', options, async t => {
  const isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'sourcereview');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'geo-source-review-'));
  const config = loadConfig({ dataDir, databaseUrl: isolated.url, stateStore: 'postgres', devAuth: true, geoEnabled: true, geoAudience: 'all' });
  const accounts = new PostgresStore(config);
  t.after(async () => { await accounts.database.close(); await isolated.drop(); await rm(dataDir, { recursive: true, force: true }); });
  const user = await accounts.devUser(), control = await accounts.requireProject(user, 'default');
  await mkdir(control.workspaceDir, { recursive: true }); await mkdir(control.metaDir, { recursive: true });
  const store = new GeoStore({ database: accounts.database }); await store.ready();
  const project = await store.createProject({ userId: user.id, projectId: control.id, engines: ['deepseek'], coverageDays: 90 });
  const documents = new ProductDocuments(accounts.database), service = new GeoService({ store, config });
  const runs = [], results = new ResultProvenanceService({ documents, config, authorizeProject: async (actor, id) => accounts.requireProject(await accounts.userById(actor), id) });
  const signals = new GeoSignals({ store, documents, service, runs: async () => runs, resultForRun: async () => ({ present: true }) }); service.signals = signals;
  const contexts = new GeoPlanContext({ documents, store, service, authorizeSession: async () => {}, runs: async () => runs });
  const bridge = new GeoSignalResults({ signals, contexts, results, controlProject: async () => control });
  const reader = new GeoSourceReviews({ bridge, results, store });
  signals.sourceReviewForRun = (project, signal, run, targets) => reader.forRun(project, signal, run, targets);
  const inputs = new GeoSignalInputs({ contexts, service, store, articles: new GeoArticleResults({ store, service, results, revisions: null, documents, cards: null, parser: null }) });
  const run = { id: 'review-run', sessionId: 'review-session', kernelRequestIds: ['review-request'], status: 'succeeded' };
  const capture = async (relativePath, content, producer = run, supersedesVersionId = undefined) => {
    await mkdir(path.dirname(path.join(control.workspaceDir, relativePath)), { recursive: true });
    await writeFile(path.join(control.workspaceDir, relativePath), content);
    return results.captureFile({ userId: user.id, project: control, relativePath, producer: { kind: 'tool', runId: producer.id, sessionId: producer.sessionId }, supersedesVersionId });
  };
  const before = await capture('original.md', '# Original source statement', { id: 'old', sessionId: run.sessionId });
  const [articleId] = await store.registerArticles(user.id, project.id, [{ path: before.path, layer: 'popular', title: 'Original', claimIds: [], gate: 'unverified', safety: 'open', contentSha256: before.digest, runId: 'old' }]);
  await store.linkArticleVersion(project.id, articleId, { version: before });
  const finding = { id: 'finding', statement: 'Original finding '.repeat(600), sourceRef: 'source' };
  await store.writeValue(user.id, project.id, { findings: [finding] }, 'old');
  const [claim] = await store.upsertClaims(user.id, project.id, [{ claimKey: 'claim-key', statement: 'Original claim', quote: 'Original', sourceRef: 'source', runId: 'old' }]);
  const targets = [
    { key: 'article', type: 'article', id: articleId, version: before.versionId, digest: before.digest },
    { key: 'finding', type: 'finding', id: finding.id, version: null, digest: hash(finding) },
    { key: 'claim', type: 'claim', id: claim.id, version: claim.version, digest: 'preserved' },
    { key: 'unchanged', type: 'finding', id: 'unchanged', version: null, digest: 'preserved' },
    { key: 'untouched', type: 'finding', id: 'untouched', version: null, digest: 'preserved' },
  ];
  const signal = await signals.record(project, { kind: 'source_changed', objectKey: 'source', eventVersion: 'first', title: 'Source correction', basis: { notice: { id: 'source' }, targets, profileVersionAtDetection: 1 } });
  const staged = await contexts.stage(user, project.id, { mode: 'signal', signalId: signal.id, expectedSignalRevision: 1, requestKey: 'stage', sessionId: run.sessionId, intent: 'review', focusRefs: targets.slice(0, 4).map(target => target.key) });
  const request = { sessionId: run.sessionId, requestId: run.kernelRequestIds[0], content: [{ type: 'text', text: 'Review these exact source changes.' }], geoPlanContext: { referenceId: staged.referenceId } };
  await assert.rejects(inputs.read(project, { planContextRef: staged.referenceId }), error => error.status === 404);
  await contexts.prepare(user, control, request); await store.transaction(() => contexts.bind(user, control, request)); runs.push(run);
  const index = await inputs.read(project, { planContextRef: staged.referenceId, limit: 2 });
  assert.equal(index.total, 4); assert.equal(index.more, true);
  await assert.rejects(inputs.read(project, { planContextRef: staged.referenceId, targetKey: 'untouched' }), error => error.status === 404);
  await assert.rejects(inputs.read({ ...project, projectId: 'foreign' }, { planContextRef: staged.referenceId }), error => error.status === 404);
  assert.equal((await reader.forRun(project, signal, run, targets)).records.length, 0);
  const after = await capture('revised.md', '# Corrected statement', run, before.versionId);
  const profile = await store.writeValue(user.id, project.id, { findings: [{ ...finding, statement: 'Updated finding' }] }, run.id);
  const [nextClaim] = await store.upsertClaims(user.id, project.id, [{ claimKey: 'claim-key', statement: 'Updated claim', quote: 'Updated', sourceRef: 'source', runId: run.id }]);
  const review = { signalId: signal.id, basisDigest: signal.payload.basisDigest, contextRef: staged.referenceId, targets: [
    { targetKey: 'article', outcome: 'updated', reason: 'Updated against the changed source.', after: { resultVersionId: after.versionId } },
    { targetKey: 'finding', outcome: 'updated', reason: 'Changed finding is preserved.', after: { profileVersion: profile.version } },
    { targetKey: 'claim', outcome: 'updated', reason: 'Changed claim is preserved.', after: { claimId: nextClaim.id } },
    { targetKey: 'unchanged', outcome: 'no_change_needed', reason: 'This exact scope is unchanged by the notice.' },
    { targetKey: 'untouched', outcome: 'no_change_needed', reason: 'A forged out-of-focus result.' },
  ] };
  const file = await capture('deliverables/review/geo-value.json', JSON.stringify({ sourceChanges: [{ id: 'source', review }] }));
  const partial = await reader.forRun(project, signal, run, targets);
  assert.equal(partial.records.length, 4); assert.ok(partial.issues.includes('review_target_invalid'));
  assert.equal(partial.records.find(row => row.targetKey === 'article').outcome, 'update_proposed');
  assert.equal(partial.records.find(row => row.targetKey === 'article').warning, 'successor_unconfirmed');
  assert.equal(partial.records.find(row => row.targetKey === 'finding').after.version, profile.version);
  assert.equal(partial.records.find(row => row.targetKey === 'claim').after.id, nextClaim.id);
  await store.linkArticleVersion(project.id, articleId, { version: after, expectedHeadVersionId: before.versionId, requestId: run.kernelRequestIds[0] });
  const accepted = await reader.forRun(project, signal, run, targets), summary = summarizeGeoSourceReviews(targets, [{ sourceReview: accepted }]);
  assert.equal(summary.state, 'partial'); assert.equal(summary.handled, 4); assert.equal(summary.remaining, 1);
  assert.equal(summary.records.find(row => row.targetKey === 'article').after.version, after.versionId);
  assert.ok(accepted.records.every(row => row.artifact.versionId === file.versionId && row.verification === 'reported_review'));
  const detail = await signals.detail(user, project.id, signal.id);
  assert.equal(detail.state, 'pending'); assert.equal(detail.executionState, 'completed'); assert.equal(detail.businessOutcome.remaining, 1);
  const chunks = [], digests = new Set();
  for (let offset = 0; ; offset++) {
    const page = await inputs.read(project, { planContextRef: staged.referenceId, targetKey: 'finding', limit: 1, offset });
    chunks.push(...page.items.map(item => item.text)); digests.add(page.textDigest);
    if (!page.more) break;
  }
  assert.equal(digests.size, 1); assert.deepEqual(JSON.parse(chunks.join('')), finding);
  const originalArticle = await inputs.read(project, { planContextRef: staged.referenceId, targetKey: 'article' });
  assert.equal(originalArticle.items[0].text, '# Original source statement');
  assert.equal(originalArticle.target.version, before.versionId);
  await assert.rejects(reader.forRun(project, signal, { ...run, id: 'unrelated' }, targets), error => error.status === 404);
  const tampered = structuredClone(review); tampered.contextRef = 'another-context';
  await capture('deliverables/foreign/geo-value.json', JSON.stringify({ sourceChanges: [{ id: 'source', review: tampered }] }));
  assert.equal((await reader.forRun(project, signal, run, targets)).records.length, 4);
  const conflict = structuredClone(review); conflict.targets = [{ targetKey: 'unchanged', outcome: 'uncertain', reason: 'New contradictory review.' }];
  const conflictingFile = await capture('deliverables/conflict/geo-value.json', JSON.stringify({ sourceChanges: [{ id: 'source', review: conflict }] }));
  assert.equal((await reader.forRun(project, signal, run, targets)).records.find(row => row.targetKey === 'unchanged').warning, 'conflicting_review_results');
  const actualRaw = results.raw.bind(results);
  results.raw = async (...args) => { if (args[2] === conflictingFile.versionId) throw new Error('Temporary preserved byte failure'); return actualRaw(...args); };
  const retained = await reader.forRun(project, signal, run, targets);
  assert.equal(retained.availability, 'unknown'); assert.equal(retained.records.length, 4);
  assert.equal(retained.records.find(record => record.targetKey === 'article').after.version, after.versionId);
  assert.equal(retained.records.find(record => record.targetKey === 'article').artifact.versionId, file.versionId);
  const blocked = await signals.detail(user, project.id, signal.id);
  assert.equal(blocked.sourceReview.records.find(record => record.targetKey === 'article').artifact.versionId, file.versionId);
  assert.equal(blocked.sourceReview.state, 'unknown');
  const successorContext = await contexts.stage(user, project.id, { mode: 'signal', signalId: signal.id, expectedSignalRevision: 1,
    requestKey: 'fresh-review', sessionId: run.sessionId, intent: 'review', focusRefs: targets.map(target => target.key), previousContextRef: staged.referenceId });
  const successorRun = { ...run, id: 'fresh-review-run', kernelRequestIds: ['fresh-review-request'], startedAt: new Date().toISOString() };
  const successorRequest = { sessionId: run.sessionId, requestId: successorRun.kernelRequestIds[0], content: [{ type: 'text', text: 'Recheck every preserved target.' }], geoPlanContext: { referenceId: successorContext.referenceId } };
  await contexts.prepare(user, control, successorRequest); await store.transaction(() => contexts.bind(user, control, successorRequest)); runs.push(successorRun);
  await capture('deliverables/fresh-review/geo-value.json', JSON.stringify({ sourceChanges: [{ id: 'source', review: {
    signalId: signal.id, basisDigest: signal.payload.basisDigest, contextRef: successorContext.referenceId,
    targets: targets.map(target => ({ targetKey: target.key, outcome: 'no_change_needed', reason: 'Re-reviewed this exact frozen version.' })),
  } }] }), successorRun);
  const recovered = await signals.detail(user, project.id, signal.id);
  assert.equal(recovered.sourceReview.state, 'handled'); assert.equal(recovered.sourceReview.remaining, 0);
  assert.equal(recovered.state, 'completed');
  assert.equal(recovered.attempts.find(attempt => attempt.runId === run.id).sourceReview.availability, 'unknown');
  results.raw = actualRaw;
});

test('coverage keeps unhandled and uncertain scope separate from completed attempts and useful prior work', () => {
  const targets = [{ key: 'one' }, { key: 'two' }, { key: 'three' }];
  const older = { sourceReview: { records: [{ targetKey: 'one', outcome: 'updated' }, { targetKey: 'two', outcome: 'no_change_needed' }] } };
  const newer = { status: 'failed', sourceReview: { records: [{ targetKey: 'two', outcome: 'uncertain' }] } };
  const result = summarizeGeoSourceReviews(targets, [newer, older]);
  assert.equal(result.handled, 1); assert.equal(result.remaining, 2); assert.equal(result.uncertain, 1); assert.equal(result.unhandled, 1);
  assert.equal(summarizeGeoSourceReviews([], []).state, 'unknown');
  assert.equal(summarizeGeoSourceReviews(targets, [{ sourceReview: { availability: 'unknown' } }, older]).state, 'unknown');
  const unavailable = { sourceReview: { availability: 'unknown', selectedTargetKeys: ['one', 'two'], records: [{ targetKey: 'one', outcome: 'updated', artifact: { versionId: 'kept' } }] } };
  const partial = summarizeGeoSourceReviews(targets, [{ sourceReview: { availability: 'available', records: [{ targetKey: 'one', outcome: 'no_change_needed' }] } }, unavailable]);
  assert.equal(partial.state, 'unknown'); assert.equal(partial.handled, 1); assert.equal(partial.remaining, 2);
  assert.equal(partial.records.find(record => record.targetKey === 'two').availability, 'unknown');
  assert.equal(partial.records.find(record => record.targetKey === 'three').outcome, 'unhandled');
});
