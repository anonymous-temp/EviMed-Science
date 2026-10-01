import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { VcrStore } from '../src/vcrStore.mjs';
import { VcrMatchStore } from '../src/vcrMatchStore.mjs';
import { VcrDataStore } from '../src/vcrDataStore.mjs';
import { VcrDataPlane } from '../src/vcrDataPlane.mjs';
import { VcrAccess } from '../src/vcrAccess.mjs';
import { assessSubject, VCR_MATCHING_VOCABULARY_VERSION } from '../src/vcrMatching.mjs';
import { createVcrCorrectionCases, correctionPartition } from '../src/vcrCorrectionCases.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && 'A local PostgreSQL is required.' };
let database, isolated, root, store, matchStore, dataStore, plane, access, service, study, source, grant, criteria;
const docs = [];
const AS_OF = '2026-09-28T00:00:00Z';
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, 'corrections');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 5000 });
  store = new VcrStore({ database }); await store.ready();
  matchStore = new VcrMatchStore({ database }); dataStore = new VcrDataStore({ database });
  access = new VcrAccess({ store: dataStore });
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcr-correction-private-'));
  plane = new VcrDataPlane({ store: dataStore, access, config: { vcrDataPlaneDir: root } });
  study = await store.createStudy({ userId: 'alice', projectId: 'cases', name: 'Synthetic correction cases', dataTier: 'T1' });
  await database.query("INSERT INTO evimed_vcr.members(study_id,user_id,role) VALUES($1,'reviewer','clinical_reviewer')", [study.id]);
  source = await dataStore.createSource({ userId: 'provider', studyId: study.id, name: 'Private charts', format: 'json', allowedUses: ['vcr'] });
  const protocol = await store.saveProtocolVersion({ studyId: study.id, userId: 'alice', title: 'P1', criteria: [
    { kind: 'inclusion', criterionType: 'other', requirement: { op: 'compare', variable: 'sex', comparator: 'eq', value: 'female' } },
  ] });
  criteria = await matchStore.listCriteria({ studyId: study.id, protocolVersionId: protocol.id });
  const subjects = ['development', 'held_out'].map(partition => {
    for (let n = 0; n < 100; n++) { const id = `subject-${n}`; if (correctionPartition(study.id, id) === partition) return id; }
    throw new Error('No deterministic partition fixture');
  });
  for (const [index, subjectKey] of subjects.entries()) {
    const id = `sfl_case${index}`; const text = `PHI_CANARY_NAME_${index}. Sex: F.`; const start = text.lastIndexOf('F');
    const filename = path.join(root, `${id}.txt`); await fs.writeFile(filename, text);
    const sha = createHash('sha256').update(text).digest('hex');
    await database.query(`INSERT INTO evimed_vcr.source_files(id,source_id,study_id,user_id,role,name,format,location,sha256,bytes,detail)
      VALUES($1,$2,$3,'provider','document','private.txt','txt',$4,$5,$6,$7::jsonb)`, [id, source.id, study.id, filename, sha, Buffer.byteLength(text), JSON.stringify({ subjectKey, visibleAt: '2026-09-01T00:00:00Z' })]);
    const fact = await matchStore.saveFact({ studyId: study.id, userId: 'alice', fact: { subjectKey, variable: 'sex', value: 'F', polarity: 'affirmed', visibleAt: '2026-09-01T00:00:00Z', surface: 'F',
      source: { documentId: id, start, end: start + 1, quote: 'F', vocabularyVersion: 'unsupported-source-version' }, extractedBy: 'model' } });
    const baseline = assessSubject({ studyId: study.id, protocolVersionId: protocol.id, subjectKey, asOf: AS_OF, criteria,
      facts: [fact], documents: { [id]: { text } } });
    // Preserve the pre-version-check decision reproduced by the C2-25 red test.
    baseline.judgments[0].state = 'satisfied'; baseline.summary = 'eligible';
    const saved = await matchStore.saveAssessment({ userId: 'alice', assessment: baseline });
    await matchStore.saveFact({ studyId: study.id, userId: 'alice', fact: { ...fact, source: { ...fact.source, vocabularyVersion: VCR_MATCHING_VOCABULARY_VERSION } } });
    await matchStore.overrideJudgment({ studyId: study.id, userId: 'alice', assessmentId: saved.id, criterionId: criteria[0].id, state: 'unknown', by: 'alice', note: 'PHI_CANARY_PRIVATE_NOTE' });
    docs.push({ id, filename, text, fact, saved, subjectKey });
  }
  service = createVcrCorrectionCases({ store, matchStore, dataPlane: plane, access });
});
after(async () => { await database?.close(); await isolated?.drop(); if (root) await fs.rm(root, { recursive: true, force: true }); });

test('correction cursors retain numeric audit order across decimal boundaries', options, async () => {
  const paged = await store.createStudy({ userId: 'alice', projectId: 'case-pages', name: 'Case pages', dataTier: 'T1' });
  await database.query(`INSERT INTO evimed_vcr.audit(study_id,user_id,actor,action,object,detail)
    SELECT $1,'alice','alice','vcr.judgment.override','fixture',jsonb_build_object('evaluationCase',
      jsonb_build_object('inputDigest','digest-'||n,'caseId','case-'||n)) FROM generate_series(1,110) n`, [paged.id]);
  const expected = (await database.query("SELECT id::text FROM evimed_vcr.audit WHERE study_id=$1 AND action='vcr.judgment.override' ORDER BY evimed_vcr.audit.id", [paged.id])).rows.map(row => row.id);
  let after = '0'; const seen = [];
  for (;;) {
    const page = await matchStore.correctionCases({ studyId: paged.id, after, limit: 1 });
    seen.push(page.nextCursor);
    if (!page.more) break;
    after = page.nextCursor;
  }
  assert.deepEqual(seen, expected, 'String ordering must not skip cases when the cursor passes 99.');
});

test('concurrent corrections of separate assessments retain one subject group and split', options, async () => {
  const subjectKey = 'concurrent-corrections';
  const assessments = [];
  for (const asOf of ['2026-09-27T00:00:00Z', '2026-09-28T00:00:00Z']) assessments.push(await matchStore.saveAssessment({ userId: 'alice',
    assessment: assessSubject({ studyId: study.id, protocolVersionId: criteria[0].protocolVersionId, subjectKey, asOf, criteria, facts: [] }) }));
  await Promise.all(assessments.map(assessment => matchStore.overrideJudgment({ studyId: study.id, userId: 'alice',
    assessmentId: assessment.id, criterionId: criteria[0].id, state: 'not_satisfied', by: 'alice' })));
  const cases = (await database.query("SELECT detail->'evaluationCase' AS item FROM evimed_vcr.audit WHERE study_id=$1 AND action='vcr.judgment.override' AND detail#>>'{evaluationCase,assessmentId}'=ANY($2::text[])",
    [study.id, assessments.map(row => row.id)])).rows.map(row => row.item);
  assert.equal(cases.length, 2); assert.equal(new Set(cases.map(item => item.groupId)).size, 1);
  assert.ok(cases.every(item => item.partition === correctionPartition(study.id, subjectKey)));
  await database.query("DELETE FROM evimed_vcr.audit WHERE study_id=$1 AND action='vcr.judgment.override' AND detail#>>'{evaluationCase,assessmentId}'=ANY($2::text[])", [study.id, assessments.map(row => row.id)]);
});

test('correction datasets require real actor source permission and export reference-only frozen cases', options, async () => {
  await assert.rejects(service.exportDataset({ studyId: study.id, principal: 'alice' }));
  grant = await dataStore.createGrant({ userId: 'provider', sourceId: source.id, studyId: study.id, grantee: 'alice', purposes: ['vcr'] });
  const dataset = await service.exportDataset({ studyId: study.id, principal: 'alice' });
  assert.equal(dataset.cases.length, 2); assert.ok(dataset.cases.some(row => row.partition === 'held_out'));
  assert.ok(dataset.cases.some(row => row.partition === 'development'));
  assert.doesNotMatch(JSON.stringify(dataset), /PHI_CANARY|unsupported-source-version|documentId.*private|vcr-correction-private|"surface"|"quote"|"subjectKey"/);
  assert.ok(dataset.cases.every(row => row.originalState === 'satisfied' && row.expectedState === 'unknown'));
  assert.ok(dataset.cases.every(row => row.inputs.facts.length === 1), 'Facts extracted after the assessment cannot enter its correction snapshot.');
  await matchStore.saveAssessment({ userId: 'alice', assessment: { ...docs[0].saved, judgments: [{ ...docs[0].saved.judgments[0], state: 'not_satisfied' }] } });
  const unchanged = await service.readDataset({ studyId: study.id, principal: 'alice', datasetId: dataset.datasetId });
  assert.equal(unchanged.cases.find(row => row.assessmentId === docs[0].saved.id).originalState, 'satisfied');
  await assert.rejects(service.readDataset({ studyId: study.id, principal: 'reviewer', datasetId: dataset.datasetId }), error => error.status === 403);
  await assert.rejects(service.readDataset({ studyId: study.id, principal: 'outsider', datasetId: dataset.datasetId }), error => error.status === 404);
});

test('held-out replay uses the actual evaluator without gold-label injection and rechecks grants/hash/window/seal', options, async () => {
  const dataset = await service.exportDataset({ studyId: study.id, principal: 'alice' });
  const report = await service.replay({ studyId: study.id, principal: 'alice', datasetId: dataset.datasetId });
  assert.equal(report.partition, 'held_out'); assert.equal(report.evaluated, 1); assert.equal(report.matched, 1);
  assert.equal(report.cases[0].predicted, 'unknown'); assert.equal(report.cases[0].original, 'satisfied');
  assert.doesNotMatch(JSON.stringify(report), /PHI_CANARY|"subjectKey"|"surface"|"quote"/);
  await database.query("UPDATE evimed_vcr.grants SET fields=ARRAY['sex'] WHERE id=$1", [grant.id]);
  await assert.rejects(service.replay({ studyId: study.id, principal: 'alice', datasetId: dataset.datasetId }), { code: 'vcr_evaluation_input_restricted' });
  await database.query("UPDATE evimed_vcr.grants SET fields='{}',revoked_at=now() WHERE id=$1", [grant.id]);
  await assert.rejects(service.readDataset({ studyId: study.id, principal: 'alice', datasetId: dataset.datasetId }));
  await database.query('UPDATE evimed_vcr.grants SET revoked_at=NULL WHERE id=$1', [grant.id]);
  await database.query("UPDATE evimed_vcr.sources SET visible_window='{" + '"end":"2000-01-01"' + "}'::jsonb WHERE id=$1", [source.id]);
  await assert.rejects(service.replay({ studyId: study.id, principal: 'alice', datasetId: dataset.datasetId }));
  await database.query("UPDATE evimed_vcr.sources SET visible_window='{}'::jsonb WHERE id=$1", [source.id]);
  await fs.writeFile(docs[0].filename, 'changed document');
  await assert.rejects(service.readDataset({ studyId: study.id, principal: 'alice', datasetId: dataset.datasetId }));
  await fs.writeFile(docs[0].filename, docs[0].text);
  await database.query("UPDATE evimed_vcr.studies SET outcome_seal='{" + '"required":true' + "}'::jsonb WHERE id=$1", [study.id]);
  await assert.rejects(service.replay({ studyId: study.id, principal: 'alice', datasetId: dataset.datasetId }), { code: 'vcr_evaluation_input_restricted' });
});

test('contrary correction labels remain mismatches and a subject never crosses the held-out split', options, async () => {
  await database.query("UPDATE evimed_vcr.studies SET outcome_seal='{}'::jsonb WHERE id=$1", [study.id]);
  const held = docs.find(item => correctionPartition(study.id, item.subjectKey) === 'held_out');
  const priorDataset = await service.exportDataset({ studyId: study.id, principal: 'alice' });
  await matchStore.overrideJudgment({ studyId: study.id, userId: 'alice', assessmentId: held.saved.id, criterionId: criteria[0].id, state: 'satisfied', by: 'alice' });
  const dataset = await service.exportDataset({ studyId: study.id, principal: 'alice' });
  const versions = dataset.cases.filter(item => item.assessmentId === held.saved.id);
  assert.equal(versions.length, 1, 'Repeated correction versions do not inflate the case count.');
  assert.equal(versions[0].groupId, priorDataset.cases.find(item => item.assessmentId === held.saved.id).groupId);
  assert.ok(versions.every(item => item.partition === 'held_out'));
  const report = await service.replay({ studyId: study.id, principal: 'alice', datasetId: dataset.datasetId });
  assert.ok(report.cases.some(item => item.expected === 'satisfied' && item.predicted === 'unknown' && !item.matched));
  assert.equal((await service.replay({ studyId: study.id, principal: 'alice', datasetId: priorDataset.datasetId })).matched, 1, 'Earlier exported labels remain immutable.');
  const other = await store.createStudy({ userId: 'alice', projectId: 'other-cases', name: 'Other study', dataTier: 'T1' });
  await assert.rejects(service.readDataset({ studyId: other.id, principal: 'alice', datasetId: dataset.datasetId }), { code: 'vcr_evaluation_dataset_not_found' });
  await database.query("UPDATE evimed_vcr.matching_facts SET value='\"M\"'::jsonb WHERE id=$1", [held.fact.id]);
  await assert.rejects(service.readDataset({ studyId: study.id, principal: 'alice', datasetId: dataset.datasetId }), { code: 'vcr_evaluation_input_changed' });
});
