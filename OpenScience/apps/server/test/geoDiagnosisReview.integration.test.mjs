import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { GeoMeasureStore } from '../src/geoMeasureStore.mjs';
import { GeoStore } from '../src/geoStore.mjs';
import { GeoService } from '../src/geoService.mjs';
import { createGeoDiagnosisReview } from '../src/geoDiagnosisReview.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { seedGeoProject } from './helpers/geoMeasureFixtures.mjs';

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
const options = { skip: !url && 'A disposable localhost PostgreSQL database is required' };
let isolated, database, store, review, project, service;
const claim = { id: 'review_geo_claim_0', key: 'label', version: 1, quote: 'Adults only.', statement: 'Adults only.', sourceRef: 'label:2026', population: 'Adults', elements: { form: 'tablet' } };
const wrong = { text: 'All ages may use it.', verdict: 'wrong', claimId: claim.id, claimKey: claim.key, evidence: claim.quote, errorType: 'dropped_condition', topic: 'indication', severity: 'S3' };
let nextVerdict = 'correct', calls = 0, omitStatements = false, omitCitations = false;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, 'georeview');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 8, databaseConnectionTimeoutMs: 3000 });
  store = new GeoMeasureStore(database); await store.ready();
  await seedGeoProject(database, { id: 'review_geo', userId: 'review_owner', projectId: 'review_project', engines: ['deepseek'],
    groups: [{ id: 'review_group', pool: 'P2' }], questions: [{ id: 'review_question', groupId: 'review_group', text: 'Who can use it?' }], claims: [claim] });
  project = await store.project('review_geo');
  await database.query(`INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,set_version,engines,ref)
    VALUES('review_round','review_owner','review_geo','baseline','done',1,'{deepseek}',$1::jsonb)`, [JSON.stringify({ evaluationBasis: { claims: [claim], product: {}, competitors: [], owned: {}, careFlags: [] } })]);
  await database.query(`INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,status,answer_text)
    VALUES('review_snapshot','review_owner','review_geo','review_round','review_question','deepseek','valid',$1)`, [wrong.text]);
  await database.query("UPDATE evimed_geo.snapshots SET citations='[{\"url\":\"https://example.com/label\"}]'::jsonb WHERE id='review_snapshot'");
  await store.writeFacts({ id: 'review_snapshot', userId: project.userId, geoProjectId: project.id }, { parserVersion: 'geo-parse-test', judgedAt: '2026-10-24T01:00:00Z', statements: [wrong], assessmentBasis: [claim], checks: { citations: [{ url: 'https://example.com/label', statement: wrong.text, exists: true, supports: 'no', evidence: 'Adults only.' }] } });
  review = createGeoDiagnosisReview({ database, store, judge: { available: true, judge: async () => {
    calls += 1;
    return { statements: omitStatements ? [] : [{ ...wrong, verdict: nextVerdict }], checks: { clinicalApplicability:{schemaVersion:1,rubric:'geo-clinical-applicability-v1',status:'applicable',quote:wrong.text,reason:'Clinical assertion.',validated:true}, offLabel: [], omittedSafety: [], citations: omitCitations ? [] : [{ url: 'https://example.com/label', statement: wrong.text, exists: null, supports: null, evidence: null }], judgementCoverage: { status: 'complete' } }, recommendations: [], entities: [], dropped: [] };
  } } });
  service = new GeoService({ store: new GeoStore({ database }), config: { geoEnabled: true, geoAudience: 'all' } });
  service.diagnosisReview = review;
});
after(async () => { await database?.close(); await isolated?.drop(); });
async function input(key = 'request_first') {
  return { snapshotId: 'review_snapshot', statement: wrong.text, claimId: claim.id, assessmentVersion: (await review.read(project, 'review_snapshot')).assessmentVersion, note: 'Please check the actual conditions.', requestKey: key };
}

test('feedback persists once and does not change the original verdict before the leased recheck', options, async () => {
  const feedback = await input();
  const submitted = await review.submit(project, feedback);
  assert.equal((await review.submit(project, feedback)).id, submitted.id);
  const saved = await review.read(project, 'review_snapshot');
  assert.equal(saved.feedback.length, 1); assert.equal(saved.feedback[0].status, 'queued');
  assert.equal(saved.current.statements[0].verdict, 'wrong'); assert.equal(calls, 0);
  await assert.rejects(review.submit(project, { ...feedback, requestKey: 'request_stale', assessmentVersion: 'a'.repeat(64) }), e => e.status === 409);
  await assert.rejects(review.submit(project, { ...feedback, note: 'Changed feedback.' }), e => e.status === 409);
});

test('a recheck has a new assessment head while preserving the original judgment and feedback on reload', options, async () => {
  assert.deepEqual(await review.tick(), { processed: 1 });
  const saved = await review.read(project, 'review_snapshot');
  assert.equal(saved.current.statements[0].verdict, 'correct');
  assert.equal(saved.current.checks.citations[0].supports, 'no', 'unchecked replacement fields cannot erase the preserved page contradiction');
  assert.equal(saved.feedback[0].original.verdict, 'wrong'); assert.equal(saved.feedback[0].status, 'succeeded');
  assert.ok(saved.history.some(row => row.assessment.statements[0].verdict === 'wrong'));
  assert.ok(saved.history.some(row => row.assessment.statements[0].verdict === 'correct'));
  const assessment = (await database.query("SELECT payload FROM evimed_product.documents WHERE payload->>'recordType'='geo-assessment'")).rows[0].payload;
  assert.equal(assessment.contributions.length, 0, 'the old wrong-learning contribution is withdrawn in the same facts transaction');
  nextVerdict = 'wrong';
  await review.submit(project, await input('request_recurrence'));
  assert.deepEqual(await review.tick(), { processed: 1 });
  assert.equal((await review.read(project, 'review_snapshot')).current.statements[0].verdict, 'wrong');
});

test('another tenant cannot read or mutate this feedback and viewer mutation is forbidden', options, async () => {
  await assert.rejects(review.read({ ...project, userId: 'another_owner' }, 'review_snapshot'), e => e.status === 404);
  await assert.rejects(service.readDiagnosisReview({ id: 'another_owner' }, project.id, 'review_snapshot'), e => e.status === 404);
  const prior = service.requireProject.bind(service);
  service.requireProject = async (_user, _id, ability = 'read') => {
    if (ability !== 'read') throw Object.assign(new Error('Forbidden'), { status: 403 });
    return project;
  };
  await assert.rejects(service.submitDiagnosisFeedback({ id: 'viewer' }, project.id, await input('viewer_request')), e => e.status === 403);
  service.requireProject = prior;
});

test('a second queued review cannot overwrite a newer assessment head', options, async () => {
  const first = await input('concurrent_first');
  await review.submit(project, first);
  await review.submit(project, { ...first, requestKey: 'concurrent_second' });
  const before = calls;
  assert.deepEqual(await review.tick(), { processed: 1 });
  assert.deepEqual(await review.tick(), { processed: 0, failed: 1 });
  assert.equal(calls - before, 1, 'the stale queued feedback is rejected before any judge call');
  const saved = await review.read(project, 'review_snapshot');
  assert.equal(saved.feedback.find(row => row.error?.code === 'geo_assessment_changed').status, 'failed');
  assert.equal(saved.original.statements[0].verdict, 'wrong');
});


test('an incomplete recheck retains the defensible prior statement instead of silently treating it as corrected', options, async () => {
  omitStatements = true; omitCitations = true;
  await review.submit(project, await input('incomplete_review'));
  assert.deepEqual(await review.tick(), { processed: 1 });
  const saved = await review.read(project, 'review_snapshot');
  assert.equal(saved.current.statements[0].verdict, 'wrong');
  assert.equal(saved.current.checks.judgementCoverage.status, 'partial');
  assert.equal(saved.current.checks.clinicalApplicability.status,'unknown');
  assert.equal(saved.current.checks.clinicalApplicability.validated,false);
  assert.equal(saved.original.statements[0].verdict, 'wrong');
});

test('a recheck retains exact unchanged cited-page verification instead of replacing it with unchecked fields', options, async () => {
  const saved = await review.read(project, 'review_snapshot');
  const citation = saved.current.checks.citations.find(row => row.url === 'https://example.com/label' && row.statement === wrong.text);
  assert.ok(citation, 'the unchanged preserved citation remains in the current assessment');
  assert.equal(citation.exists, true);
  assert.equal(citation.supports, 'no');
  assert.equal(citation.evidence, 'Adults only.');
  assert.ok(citation.retainedFromAssessment, 'retained evidence names the judgment from which it came');
});

test('feedback beyond the first page remains reachable and assessment history counts distinct judgments', options, async () => {
  const { ProductDocuments } = await import('../src/productStore.mjs');
  const documents = new ProductDocuments(database);
  const before = await review.read(project, 'review_snapshot');
  for (let index = 0; index < 4; index += 1) await review.submit(project, await input(`history_page_${index}`));
  const headRow = (await database.query("SELECT id FROM evimed_product.documents WHERE payload->>'recordType'='geo-assessment' AND payload->>'snapshotId'='review_snapshot'")).rows[0];
  let head = await documents.get(project.userId, 'knowledge', headRow.id);
  for (let index = 0; index < 4; index += 1) head = await documents.put(project.userId, 'knowledge', head.id, { ...head.payload, state: index % 2 ? 'active' : 'suspended' }, { expectedRevision: head.revision, projectId: project.projectId });
  const first = await review.read(project, 'review_snapshot', { feedbackLimit: 2, historyLimit: 2 });
  assert.equal(first.feedback.length, 2);
  assert.equal(first.feedbackPage.total, before.feedback.length + 4);
  assert.equal(first.feedbackPage.more, true);
  assert.equal(first.historyPage.total, new Set(before.history.map(row => row.version)).size);
  assert.equal(first.history.length, 2);
  const next = await review.read(project, 'review_snapshot', { feedbackLimit: 2, historyLimit: 2, feedbackBefore: first.feedbackPage.nextBefore, historyBefore: first.historyPage.nextBefore });
  assert.ok(next.feedback.every(row => !first.feedback.some(prior => prior.id === row.id)));
  assert.ok(next.history.every(row => !first.history.some(prior => prior.version === row.version)));
  const allFeedback = new Set(first.feedback.map(row => row.id));
  let cursor = first.feedbackPage.nextBefore;
  while (cursor) {
    const page = await review.read(project, 'review_snapshot', { feedbackLimit: 2, feedbackBefore: cursor });
    for (const row of page.feedback) allFeedback.add(row.id);
    cursor = page.feedbackPage.nextBefore;
  }
  assert.equal(allFeedback.size, first.feedbackPage.total);
  const boundary = await input('boundary_feedback');
  for (let index = first.feedbackPage.total; index < 101; index += 1) await review.submit(project, { ...boundary, requestKey: `feedback_boundary_${index}` });
  const capped = await review.read(project, 'review_snapshot');
  assert.equal(capped.feedback.length, 100);
  assert.equal(capped.feedbackPage.total, 101);
  assert.equal(capped.feedbackPage.more, true);
  const final = await review.read(project, 'review_snapshot', { feedbackBefore: capped.feedbackPage.nextBefore });
  assert.equal(final.feedback.length, 1);
  assert.equal(final.feedbackPage.more, false);
  assert.equal(new Set([...capped.feedback, ...final.feedback].map(row => row.id)).size, 101);
});

test('same-id, same-word versions require an exact statement identity and unreviewed variants remain preserved', options, async () => {
  const { geoStatementAssessmentIdentity } = await import('@evimed/domain');
  const first = { ...wrong, claimVersion: 1, applicability: { population: 'Adults', elements: { form: 'tablet' }, inLabel: true, validUntil: null, evidenceLevel: null } };
  const firstClaim = { ...claim, inLabel: true, validUntil: null, evidenceLevel: null };
  const secondClaim = { ...firstClaim, version: 2, population: 'Children', elements: { form: 'solution' }, quote: 'Only children may use the solution.' };
  const second = { ...first, claimVersion: 2, evidence: secondClaim.quote, applicability: { ...first.applicability, population: 'Children', elements: { form: 'solution' } } };
  await database.query("UPDATE evimed_geo.rounds SET ref=$1::jsonb WHERE id='review_round'", [JSON.stringify({ evaluationBasis: { claims: [firstClaim, secondClaim], product: {}, competitors: [], owned: {}, careFlags: [] } })]);
  await database.query(`INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,status,answer_text) VALUES('version_review','review_owner','review_geo','review_round','review_question','deepseek','valid',$1)`, [wrong.text]);
  await store.writeFacts({ id: 'version_review', userId: project.userId, geoProjectId: project.id }, { statements: [first, second], checks: { judgementCoverage: { status: 'complete' } }, judgedAt: '2026-10-24T01:00:00Z', assessmentBasis: [firstClaim, secondClaim] });
  const aliases = [];
  const focused = createGeoDiagnosisReview({ database, store, judge: { available: true, judge: async input => { aliases.push(input.reviewFeedback.claim); return ({ statements: [{ ...first, verdict: 'correct' }], checks: { clinicalApplicability:{schemaVersion:1,rubric:'geo-clinical-applicability-v1',status:'applicable',quote:first.text,reason:'Clinical assertion.',validated:true}, citations: [], offLabel: [], omittedSafety: [], judgementCoverage: { status: 'complete' } }, dropped: [], entities: [], recommendations: [] }); } } });
  const version = (await focused.read(project, 'version_review')).assessmentVersion;
  const request = { snapshotId: 'version_review', statement: first.text, claimId: first.claimId, assessmentVersion: version, note: 'Only the adult statement.', requestKey: 'ambiguous_legacy' };
  await assert.rejects(focused.submit(project, request), error => error.status === 409);
  await focused.submit(project, { ...request, requestKey: 'precise_statement', statementIdentity: geoStatementAssessmentIdentity(first) });
  // Use this factory's evaluator for all jobs, without relying on unrelated queued requests.
  for (let index = 0; index < 110; index += 1) {
    await focused.tick();
    if ((await focused.read(project, 'version_review')).feedback[0]?.status === 'succeeded') break;
  }
  const saved = await focused.read(project, 'version_review');
  assert.equal(saved.current.checks.clinicalApplicability.status,'unknown');
  assert.equal(saved.current.checks.clinicalApplicability.validated,false);
  assert.equal(saved.feedback[0].status, 'succeeded');
  assert.ok(saved.current.statements.some(row => row.claimVersion === 2 && row.verdict === 'wrong'));
  assert.equal(saved.current.checks.judgementCoverage.status, 'partial');
  assert.equal(aliases.at(-1), 'C1');
  await focused.submit(project, { ...request, assessmentVersion: saved.assessmentVersion, requestKey: 'precise_second_statement', statementIdentity: geoStatementAssessmentIdentity(second) });
  assert.deepEqual(await focused.tick(), { processed: 1 });
  assert.equal(aliases.at(-1), 'C2');
});

test('versioned clinical applicability survives the N08 assessment head/history and a partial replacement becomes unknown',options,async()=>{
  const {buildJudgeInput,verifyJudgement,factsOf}=await import('../src/geoJudge.mjs');
  const answer='Open the help menu.';
  const source={owner:{userId:project.userId,projectId:project.projectId},product:{},competitors:[],claims:[],careFlags:[],question:{text:'Help',pool:'P2'},answer,links:[]};
  const judged=verifyJudgement({assessmentComplete:true,statements:[],clinicalApplicability:{schemaVersion:1,rubric:'geo-clinical-applicability-v1',status:'not_applicable',quote:answer,reason:'Only a navigation instruction.'}},buildJudgeInput(source),source);
  const snapshot={id:'applicability_review',status:'valid',answerText:answer,citations:[]};
  await database.query(`INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,status,answer_text) VALUES($1,$2,$3,'review_round','review_question','deepseek','valid',$4)`,[snapshot.id,project.userId,project.id,answer]);
  const original=factsOf({snapshot,judged,registry:[],countedOwned:{},at:new Date(),claims:[]}).facts;
  await store.writeFacts({id:snapshot.id,userId:project.userId,geoProjectId:project.id},original);
  const first=await review.read(project,snapshot.id);assert.equal(first.current.checks.clinicalApplicability.status,'not_applicable');
  const replacement=factsOf({snapshot,judged:{...judged,checks:{...judged.checks,judgementCoverage:{...judged.checks.judgementCoverage,status:'partial'}}},registry:[],countedOwned:{},at:new Date(),claims:[]}).facts;
  const {preserveGeoAssessment}=await import('../src/geoLearningSignals.mjs');
  await database.transaction(client=>preserveGeoAssessment({database,client,snapshotId:snapshot.id,facts:replacement}));
  const next=await review.read(project,snapshot.id);assert.equal(next.current.checks.clinicalApplicability.status,'unknown');
  assert.equal(next.original.checks.clinicalApplicability.status,'not_applicable');assert.ok(next.history.some(row=>row.assessment.checks.clinicalApplicability.status==='not_applicable'));
});
