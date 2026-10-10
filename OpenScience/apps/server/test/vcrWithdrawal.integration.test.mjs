// Withdrawal of consent, the deletion of a document an evaluation was frozen on, and the retirement of a projection that missed an
// identifier (2026-10-10 owner rulings; OpenMed review E-17, D-vcr §8): the text goes, the hashes and the audit trail stay, a frozen
// evaluation keeps its hashes and reads as withdrawn. The flow runs through the composed module on PostgreSQL.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { composeVcr, vcrMatchingExecutor } from '../src/vcrComposition.mjs';
import { deploymentCloudPermission, projectionHash } from '../src/vcrCloudProjection.mjs';
import { createVcrCloudEgress } from '../src/vcrCloudEgress.mjs';
import { shredPlaneFile } from '../src/vcrDataPlane.mjs';
import { vcrRuntimeWrite } from '../src/vcrGateway.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { streamOf } from './helpers/vcrIntakeData.mjs';

const options = { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'An isolated test PostgreSQL is required' };
const origin = 'https://api.example.org';
const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');
let database, isolated, directory, vcr;
before(async () => {
  if (options.skip) return;
  isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'vcrwithdraw');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vcr-withdraw-'));
  vcr = composeVcr({ config: { vcrEnabled: true, vcrAudience: 'all', vcrDataPlaneDir: directory, deepseekBaseUrl: origin, vcrProviderAgreements: true }, productDatabase: database });
  await vcr.store.ready();
});
after(async () => { await database?.close(); await isolated?.drop(); if (directory) await fs.rm(directory, { recursive: true, force: true }); });

const consent = '患者本人可理解研究内容并签署知情同意';
const CHART_1 = `患者王小明，电话 13812345678。年龄 62 岁，肌酐 1.2 mg/dL。${consent}。`;
const CHART_2 = '复查：肌酐 1.4 mg/dL；否认心梗史。BMI 22。';
const CHART_S2 = `年龄 44 岁。${consent}。`;
const criteria = [
  { kind: 'inclusion', criterionType: 'demographic', sourceText: 'Age >= 18', requirement: { op: 'compare', variable: 'age', comparator: 'gte', value: 18 } },
  { kind: 'inclusion', criterionType: 'consent_capacity', sourceText: consent, requirement: { op: 'language', key: 'consent', text: consent } },
];
const write = (target, what, items) => vcrRuntimeWrite({ study: target, store: vcr.store, service: vcr.service, what, items, documents: vcr.documents,
  matching: vcr.matching, matchStore: vcr.matchStore, orchestrator: null, report: () => {} });
const spanOf = (text, quote) => ({ start: text.indexOf(quote), end: text.indexOf(quote) + quote.length, quote });
const exists = async location => fs.stat(path.join(directory, location)).then(() => true, () => false);

/** A study with two subjects: S1 (two documents, one with a reviewed projection) and S2 (one), an evaluation frozen on all facts, and the referrals it made. */
async function fixture() {
  const target = await vcr.store.createStudy({ userId: 'owner', projectId: `prj_${Math.random().toString(16).slice(2)}`, name: 'Synthetic withdrawal test', question: 'q', dataTier: 'T0' });
  const source = await vcr.dataPlane.registerSource({ userId: 'owner', studyId: target.id, name: 'Synthetic notes' });
  const upload = async (text, subject) => (await vcr.dataPlane.storeUpload({ actor: 'owner', studyId: target.id, sourceId: source.id, name: 'note.txt', role: 'document', subject, stream: streamOf(text) })).file;
  const doc1 = await upload(CHART_1, 'WITHDRAWN-REAL-ID'), doc2 = await upload(CHART_2, 'WITHDRAWN-REAL-ID'), docS2 = await upload(CHART_S2, 'KEPT-REAL-ID');
  const s1 = doc1.detail.subjectKey, s2 = docS2.detail.subjectKey;
  assert.equal(doc2.detail.subjectKey, s1);
  const names = [CHART_1.indexOf('王小明'), CHART_1.indexOf('13812345678')];
  const projection = await vcr.dataPlane.createDocumentProjection({ studyId: target.id, documentId: doc1.id, actor: 'owner', sourceHash: projectionHash(CHART_1),
    spans: [{ start: names[0], end: names[0] + 3, kind: 'person' }, { start: names[1], end: names[1] + 11, kind: 'contact' }], attestation: 'Reviewed synthetic canary' });
  target.cloudContext = { runId: 'run_withdraw', sessionId: 'session_withdraw' };
  const projected = (await vcr.documents.subjectDocuments(target, { subjectKey: s1, documentId: doc1.id })).document;
  assert.equal(projected.id, projection.id);
  const ageQuote = '年龄 62 岁';
  const facts = await write(target, 'fact', [
    { subjectKey: s1, variable: 'age', value: 62, unit: 'year', documentId: projection.id, quote: ageQuote, surface: '62' },
    { subjectKey: s1, variable: 'creatinine', value: 1.4, unit: 'mg/dL', documentId: doc2.id, ...spanOf(CHART_2, '肌酐 1.4 mg/dL'), surface: '1.4' },
    { subjectKey: s2, variable: 'age', value: 44, unit: 'year', documentId: docS2.id, quote: '年龄 44 岁', surface: '44' },
  ]);
  assert.equal(facts.ids.length, 3, JSON.stringify(facts.issues));
  await write(target, 'criteria', [{ criteria }]);
  const judged = await write(target, 'language_judgment', [
    { subjectKey: s1, criterionKey: 'consent', state: 'satisfied', evidence: [{ documentId: projection.id, ...spanOf(projected.text, consent), quote: consent }] },
    { subjectKey: s2, criterionKey: 'consent', state: 'satisfied', evidence: [{ documentId: docS2.id, ...spanOf(CHART_S2, consent), quote: consent }] },
  ]);
  assert.equal(judged.ids.length, 2, JSON.stringify(judged.issues));
  const built = await vcr.matching.matchScenario(target);
  assert.equal(built.ok, true);
  const job = { id: 'job_withdraw_1', studyId: target.id, kind: 'match_criteria', scenario: built.scenario, inputs: built.inputs, scenarioHash: 'c'.repeat(64), seed: 1 };
  const result = await vcrMatchingExecutor({ matchStore: vcr.matchStore, store: vcr.store, documents: vcr.documents })({ job, onProgress: async () => {} });
  assert.deepEqual(result.assessments.map(row => [row.subjectKey, row.summary]).sort(), [[s1, 'eligible'], [s2, 'eligible']].sort());
  await vcr.matching.onJobFinished({ action: 'finished', state: 'succeeded', job: { id: job.id, studyId: target.id, kind: 'match_criteria', state: 'succeeded' }, engineResult: result });
  // A fact written after the evaluation froze its inputs: no evaluation used it.
  const late = await write(target, 'fact', [{ subjectKey: s1, variable: 'bmi', value: 22, unit: 'kg/m2', documentId: doc2.id, ...spanOf(CHART_2, 'BMI 22'), surface: '22' }]);
  assert.equal(late.ids.length, 1, JSON.stringify(late.issues));
  return { target, source, doc1, doc2, docS2, s1, s2, projection, job, built, factIds: facts.ids, lateId: late.ids[0] };
}

test('a subject withdraws consent: their text is overwritten, the rows and hashes stay, a frozen evaluation reads as withdrawn, nobody contacts them', options, async () => {
  const f = await fixture();
  const { target, doc1, doc2, docS2, s1, s2, projection } = f;
  const textLocation = (await vcr.dataStore.getSourceFile(target.id, doc1.id)).location;
  const aliasInPlane = path.join(directory, 'alias-of-chart-1');
  await fs.link(path.join(directory, textLocation), aliasInPlane);
  const referralBefore = (await vcr.matchStore.listReferrals({ studyId: target.id })).find(row => row.subjectKey === s1);
  assert.ok(referralBefore && !['withdrawn', 'screen_failed'].includes(referralBefore.state));
  const manifest = await vcr.store.one('SELECT location, projection_hash, manifest_hash FROM evimed_vcr.document_projections WHERE id=$1', [projection.id]);
  const assessmentBefore = (await vcr.matchStore.listAssessments({ studyId: target.id, subjectKey: s1 }))[0];
  const judgmentsBefore = (await vcr.matchStore.getAssessment(assessmentBefore.id, target.id)).judgments;
  assert.ok(judgmentsBefore.some(judgment => judgment.evidence.some(item => item.quote === consent)), 'the evaluation quoted the chart');

  const report = await vcr.dataPlane.withdrawSubject({ studyId: target.id, subjectKey: s1, actor: 'owner', reason: 'patient request' });
  assert.deepEqual([report.files, report.projections, report.referralsClosed], [2, 1, 1]);
  assert.equal(report.factsRemoved, 1, 'the fact no evaluation used is deleted');
  assert.equal(report.factsRedacted, 2, 'the facts the evaluation was frozen on keep their rows');
  assert.equal(report.judgmentsRedacted, 1);
  assert.equal(report.filesFailed, undefined);

  // The words are gone from the disk: what shared the bytes reads zeros, the files are removed, the other subject's file stays.
  assert.ok((await fs.readFile(aliasInPlane)).every(byte => byte === 0), 'overwritten in place before it was removed');
  await fs.rm(aliasInPlane);
  assert.equal(await exists(textLocation), false);
  assert.equal(await exists((await vcr.dataStore.getSourceFile(target.id, doc2.id)).location), false);
  assert.equal(await exists(manifest.location), false);
  assert.equal(await exists((await vcr.dataStore.getSourceFile(target.id, docS2.id)).location), true);
  assert.equal((await vcr.dataPlane.documentText({ studyId: target.id, documentId: docS2.id, principal: 'owner' })).text, CHART_S2);

  // The ledger keeps what they were: rows, hashes, and the moment the text went.
  const file = await vcr.store.one('SELECT sha256, erased_at FROM evimed_vcr.source_files WHERE id=$1', [doc1.id]);
  assert.equal(file.sha256, sha(CHART_1));
  assert.ok(file.erased_at);
  const retired = await vcr.store.one('SELECT projection_hash, manifest_hash, retired_at, purged_at FROM evimed_vcr.document_projections WHERE id=$1', [projection.id]);
  assert.deepEqual([retired.projection_hash, retired.manifest_hash], [manifest.projection_hash, manifest.manifest_hash]);
  assert.ok(retired.retired_at && retired.purged_at);

  // Nothing reads them any more, by any door.
  await assert.rejects(vcr.dataPlane.documentText({ studyId: target.id, documentId: doc1.id, principal: 'owner' }), { code: 'vcr_document_withdrawn', status: 410 });
  await assert.rejects(vcr.dataPlane.documentText({ studyId: target.id, documentId: projection.id, principal: 'owner' }), { code: 'vcr_projection_unavailable' });
  assert.equal((await vcr.documents.subjectDocuments(target, { subjectKey: s1, documentId: doc1.id })).available, false);
  assert.deepEqual((await vcr.dataPlane.listDocuments({ studyId: target.id, principal: 'owner', subjectKey: s1 })), []);
  assert.deepEqual(await vcr.matchStore.candidateSubjects({ studyId: target.id }), [s2], 'they are on no roster');
  await assert.rejects(vcr.matching.matchScenario(target, { subjectKeys: [s1] }), { code: 'vcr_subject_not_found' });

  // A run is told so and given nothing to work on; the study holds nobody of that name any more, so nothing more is written about them.
  const closed = await vcr.documents.subjectDocuments(target, { subjectKey: s1, documentId: doc1.id });
  assert.deepEqual([closed.available, closed.code, closed.message], [false, 'vcr_document_withdrawn', '这份病历已撤回，文本已清除；其他工作可以继续。']);
  const seen = await vcr.matching.runtimeRead(target, { subjectKey: s1 });
  assert.deepEqual([seen.withdrawn, seen.assessment, seen.facts, seen.requests], [true, null, [], []]);
  assert.deepEqual((await vcr.matching.runtimeRead(target, {})).subjects.map(row => row.subjectKey), [s2], 'and the run is not handed them to work on');
  assert.equal(await vcr.matchStore.holdsSubject(target.id, s1), false);
  const refused = await write(target, 'fact', [{ subjectKey: s1, variable: 'age', value: 62, unit: 'year', documentId: doc1.id, quote: '年龄 62 岁', surface: '62' }]);
  assert.equal(refused.ids.length, 0);

  // The facts and judgments a frozen evaluation used keep their ids; their words, and nothing else, are gone.
  const kept = await vcr.matchStore.matchingFactsByIds(target.id, f.factIds);
  const age = kept.find(fact => fact.variable === 'age' && fact.subjectKey === s1);
  assert.ok(age.withdrawn?.digest, 'the digest it was frozen under is kept');
  assert.equal(age.value, 62, 'a number is a record, not a repetition of it');
  assert.equal(age.surface, '');
  assert.equal(age.source.quote, undefined);
  assert.equal(age.source.quoteHash, sha('年龄 62 岁'));
  assert.ok(age.source.documentId && age.source.start != null, 'its locator stays');
  assert.deepEqual((await vcr.matchStore.matchingFactsByIds(target.id, [f.lateId])), [], 'the fact nobody used is deleted');
  assert.equal(kept.find(fact => fact.subjectKey === s2).withdrawn, undefined, 'another subject is untouched');
  assert.deepEqual((await vcr.matchStore.listFacts({ studyId: target.id, subjectKey: s1 })), [], 'a withdrawn fact is no evidence for a new evaluation');

  // The frozen evaluation keeps its hashes and reads as withdrawn; its quotes are the hash of what they said.
  const assessment = await vcr.matchStore.getAssessment(assessmentBefore.id, target.id);
  assert.equal(assessment.summary, assessmentBefore.summary);
  const quotes = assessment.judgments.flatMap(judgment => judgment.evidence);
  assert.ok(quotes.length > 0 && quotes.every(item => item.quote === '' && item.withdrawn === true && /^[a-f0-9]{64}$/.test(item.quoteHash)));
  assert.ok(quotes.some(item => item.quoteHash === sha(consent)));
  assert.ok(!JSON.stringify(assessment).includes('王小明') && !JSON.stringify(assessment).includes(consent));
  const marks = await vcr.erasure.assessmentMarks(target.id, [assessmentBefore.id]);
  assert.equal(marks.get(assessmentBefore.id).cause, 'withdrawn');
  const tab = await vcr.service.tab({ id: 'owner' }, target.id, 'matching', {});
  assert.equal(tab.candidates.find(candidate => candidate.id === s1).basis, 'withdrawn');
  assert.equal(tab.candidates.find(candidate => candidate.id === s2).basis, undefined);
  assert.equal(tab.candidates.at(-1).id, s1, 'listed after the people who can still be asked');
  assert.equal((await vcr.matchStore.assessmentTallies(target.id)).eligible, 1, 'and not counted among the candidates');

  // A batch frozen before the withdrawal still verifies: the withdrawn subject is unavailable, the other is evaluated.
  const continued = await vcr.matching.matchScenario(target, { snapshotId: f.built.inputs.find(input => input.id.startsWith('matching:snapshot:')).id.slice('matching:snapshot:'.length), offset: 0 });
  const second = await vcrMatchingExecutor({ matchStore: vcr.matchStore, store: vcr.store, documents: vcr.documents })({
    job: { id: 'job_withdraw_2', studyId: target.id, kind: 'match_criteria', scenario: continued.scenario, inputs: continued.inputs }, onProgress: async () => {} });
  assert.deepEqual(second.assessments.map(row => row.subjectKey), [s2]);
  assert.equal(second.diagnostics.errors, 1);
  assert.deepEqual(second.diagnostics.errorCodes, ['vcr_subject_withdrawn']);

  // Their referral closed as 退出, so nobody contacts them.
  const referralAfter = (await vcr.matchStore.listReferrals({ studyId: target.id })).find(row => row.subjectKey === s1);
  assert.equal(referralAfter.state, 'withdrawn');
  assert.equal((await vcr.matchStore.listReferralEvents(referralAfter.id)).at(-1).note, '知情同意已撤回');

  // The audit trail keeps the hashes and counts and never a word.
  const audits = await vcr.store.rows("SELECT action, object, detail FROM evimed_vcr.audit WHERE study_id=$1 AND action IN ('subject.withdraw','source.file.erase','document.projection.retire')", [target.id]);
  assert.deepEqual(audits.map(row => row.action).sort(), ['document.projection.retire', 'source.file.erase', 'source.file.erase', 'subject.withdraw']);
  assert.ok(audits.some(row => row.action === 'source.file.erase' && row.object === doc1.id && row.detail.sha256 === sha(CHART_1)));
  assert.ok(!JSON.stringify(audits).includes('王小明') && !JSON.stringify(audits).includes('13812345678'));

  // The conversation that read them is still a clinical one, and asking again overwrites what is left and says the same.
  assert.equal(await vcr.store.hasClinicalContext('owner', target.projectId, [{ sessionId: 'session_withdraw' }]), true);
  const again = await vcr.dataPlane.withdrawSubject({ studyId: target.id, subjectKey: s1, actor: 'owner' });
  assert.deepEqual([again.files, again.projections, again.factsRedacted], [2, 1, 0]);
  await assert.rejects(vcr.dataPlane.withdrawSubject({ studyId: target.id, subjectKey: 'P_never_heard_of', actor: 'owner' }), { code: 'vcr_subject_not_found' });
});

test('a deletion request for a document an evaluation was frozen on erases its text and keeps the evaluation; one nobody used is deleted as before', options, async () => {
  const f = await fixture();
  const { target, doc1, doc2, s1 } = f;
  const unused = await vcr.dataPlane.storeUpload({ actor: 'owner', studyId: target.id, sourceId: f.source.id, name: 'later.txt', role: 'document', subject: 'WITHDRAWN-REAL-ID', stream: streamOf('晚到的一页。') });
  assert.deepEqual(await vcr.dataPlane.removeUpload({ studyId: target.id, fileId: unused.file.id, actor: 'owner' }), { removed: true, fileId: unused.file.id });
  assert.equal(await vcr.dataStore.getSourceFile(target.id, unused.file.id), null, 'a document nobody used is gone with its row');

  const location = (await vcr.dataStore.getSourceFile(target.id, doc2.id)).location;
  const removed = await vcr.dataPlane.removeUpload({ studyId: target.id, fileId: doc2.id, actor: 'owner' });
  assert.equal(removed.removed, true);
  assert.equal(removed.erased, true);
  assert.equal(await exists(location), false);
  const row = await vcr.dataStore.getSourceFile(target.id, doc2.id);
  assert.ok(row.erasedAt && row.sha256 === sha(CHART_2), 'the row and its hash stay');
  await assert.rejects(vcr.dataPlane.documentText({ studyId: target.id, documentId: doc2.id, principal: 'owner' }), { code: 'vcr_document_withdrawn' });
  // Only what was read from that document is gone: the same subject's other chart is read, and they are still a candidate.
  assert.equal((await vcr.dataPlane.documentText({ studyId: target.id, documentId: doc1.id, principal: 'owner' })).text, CHART_1);
  assert.ok((await vcr.matchStore.candidateSubjects({ studyId: target.id })).includes(s1));
  const facts = await vcr.matchStore.matchingFactsByIds(target.id, f.factIds);
  assert.ok(facts.find(fact => fact.variable === 'creatinine').withdrawn?.digest);
  assert.equal(facts.find(fact => fact.variable === 'age' && fact.subjectKey === s1).withdrawn, undefined);
  const assessment = (await vcr.matchStore.listAssessments({ studyId: target.id, subjectKey: s1 }))[0];
  assert.equal((await vcr.erasure.assessmentMarks(target.id, [assessment.id])).get(assessment.id).cause, 'withdrawn');
  // A snapshot's data file is still its own record: the old refusal stands for it.
  const table = await vcr.dataPlane.storeUpload({ actor: 'owner', studyId: target.id, sourceId: f.source.id, name: 'cohort.csv', role: 'data', stream: streamOf('PATIENT_NO,AGE\nHZ-1,60\n') });
  assert.equal(table.created, true);
});

test('a projection that missed an identifier is retired and purged, what was quoted from it goes with it, and a newer one is chosen', options, async () => {
  const f = await fixture();
  const { target, doc1, s1, projection } = f;
  // The first projection masked the name and the phone; build the one that missed the phone, and read from it.
  const missed = await vcr.dataPlane.createDocumentProjection({ studyId: target.id, documentId: doc1.id, actor: 'owner', sourceHash: projectionHash(CHART_1),
    spans: [{ start: CHART_1.indexOf('王小明'), end: CHART_1.indexOf('王小明') + 3, kind: 'person' }], attestation: 'Reviewed, phone missed' });
  assert.notEqual(missed.id, projection.id);
  const read = (await vcr.documents.subjectDocuments(target, { subjectKey: s1, documentId: doc1.id })).document;
  assert.equal(read.id, missed.id, 'the newest projection is the one served');
  assert.ok(read.text.includes('13812345678'), 'and it still holds the phone number');
  const phoneQuote = '电话 13812345678';
  const written = await write(target, 'fact', [{ subjectKey: s1, variable: 'phone_on_file', value: 'yes', documentId: missed.id, ...spanOf(read.text, phoneQuote), surface: '13812345678' }]);
  assert.equal(written.ids.length, 1, JSON.stringify(written.issues));
  const manifestLocation = (await vcr.store.one('SELECT location FROM evimed_vcr.document_projections WHERE id=$1', [missed.id])).location;
  assert.equal(await exists(manifestLocation), true);

  const report = await vcr.dataPlane.retireProjection({ studyId: target.id, projectionId: missed.id, actor: 'owner', reason: 'phone number missed' });
  assert.deepEqual([report.files, report.projections, report.factsRemoved, report.factsRedacted], [0, 1, 1, 0], 'the quote taken from it is deleted (no evaluation used it)');
  assert.equal(await exists(manifestLocation), false, 'its text is overwritten and removed');
  const row = await vcr.store.one('SELECT retired_at, purged_at, projection_hash FROM evimed_vcr.document_projections WHERE id=$1', [missed.id]);
  assert.ok(row.retired_at && row.purged_at && row.projection_hash === missed.projectionHash);
  // Not served by its id, as the newest of its document, or to a replay.
  await assert.rejects(vcr.dataPlane.projectionText({ studyId: target.id, documentId: missed.id, principal: 'owner', cloudContext: target.cloudContext }, true), { code: 'vcr_projection_unavailable' });
  await assert.rejects(vcr.dataPlane.documentText({ studyId: target.id, documentId: missed.id, principal: 'owner' }), { code: 'vcr_projection_unavailable' });
  // The first projection (the one that masked the phone) is the newest that is still live, and is chosen.
  const chosen = (await vcr.documents.subjectDocuments(target, { subjectKey: s1, documentId: doc1.id })).document;
  assert.equal(chosen.id, projection.id);
  assert.ok(!chosen.text.includes('13812345678'));
  // Asked again, it finds nothing more to take out; a name that is no projection of the study is not made up. The conversation that
  // read the retired text is still a clinical one, and its next model call is not refused for having read it.
  const again = await vcr.dataPlane.retireProjection({ studyId: target.id, projectionId: missed.id, actor: 'owner' });
  assert.deepEqual([again.projections, again.factsRemoved], [1, 0]);
  await assert.rejects(vcr.dataPlane.retireProjection({ studyId: target.id, projectionId: `prj_${'0'.repeat(48)}`, actor: 'owner' }), { code: 'vcr_projection_unavailable' });
  assert.equal(await vcr.store.hasClinicalContext('owner', target.projectId, [{ sessionId: 'session_withdraw' }]), true);
  const egress = createVcrCloudEgress({ store: vcr.store, resolveSession: async caller => caller.sessionId, destinations: () => [origin],
    deployment: () => deploymentCloudPermission({ deepseekBaseUrl: origin, vcrProviderAgreements: true }) });
  await egress({ userId: 'owner', projectId: target.projectId, sessionId: 'session_withdraw' }, { messages: ['x'] });
  // With none live, the document goes out as it stands, and a re-reviewed projection revives the same id.
  await vcr.dataPlane.retireProjection({ studyId: target.id, projectionId: projection.id, actor: 'owner' });
  const raw = (await vcr.documents.subjectDocuments(target, { subjectKey: s1, documentId: doc1.id })).document;
  assert.equal(raw.id, doc1.id);
  const revived = await vcr.dataPlane.createDocumentProjection({ studyId: target.id, documentId: doc1.id, actor: 'owner', sourceHash: projectionHash(CHART_1),
    spans: [{ start: CHART_1.indexOf('王小明'), end: CHART_1.indexOf('王小明') + 3, kind: 'person' }], attestation: 'Reviewed again' });
  assert.equal(revived.id, missed.id);
  assert.equal((await vcr.documents.subjectDocuments(target, { subjectKey: s1, documentId: doc1.id })).document.id, missed.id);
});

test('the overwrite replaces a file in place, refuses a symlink and a location outside the plane, and says when nothing was there', options, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vcr-shred-'));
  try {
    await fs.mkdir(path.join(dir, 'studies', 'std_x', 'documents'), { recursive: true });
    const location = 'studies/std_x/documents/a.txt';
    await fs.writeFile(path.join(dir, location), 'x'.repeat(200_000));
    await fs.link(path.join(dir, location), path.join(dir, 'alias'));
    assert.equal(await shredPlaneFile(dir, location), true);
    assert.deepEqual([...new Set(await fs.readFile(path.join(dir, 'alias')))], [0]);
    assert.equal((await fs.stat(path.join(dir, 'alias'))).size, 200_000);
    assert.equal(await shredPlaneFile(dir, location), false, 'asked again, nothing was there');
    await fs.writeFile(path.join(dir, 'outside.txt'), 'keep');
    await fs.symlink(path.join(dir, 'outside.txt'), path.join(dir, 'studies/std_x/documents/link.txt'));
    await assert.rejects(shredPlaneFile(dir, 'studies/std_x/documents/link.txt'));
    assert.equal(await fs.readFile(path.join(dir, 'outside.txt'), 'utf8'), 'keep', 'a symlink is never followed');
    await assert.rejects(shredPlaneFile(dir, '../elsewhere.txt'), { code: 'vcr_data_plane_location_outside' });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
