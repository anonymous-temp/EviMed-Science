// A correction case rests on frozen facts and a source document. When the person's consent is withdrawn the case can no longer be
// replayed: it is left out of an export and a replay and counted, and the other cases go on (2026-10-10, B1-consent).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { VcrAccess } from '../src/vcrAccess.mjs';
import { createVcrCorrectionCases, correctionPartition } from '../src/vcrCorrectionCases.mjs';
import { VcrDataPlane } from '../src/vcrDataPlane.mjs';
import { VcrDataStore } from '../src/vcrDataStore.mjs';
import { VcrErasureStore } from '../src/vcrErasureStore.mjs';
import { VcrMatchStore } from '../src/vcrMatchStore.mjs';
import { VcrStore } from '../src/vcrStore.mjs';
import { assessSubject } from '../src/vcrMatching.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { streamOf } from './helpers/vcrIntakeData.mjs';

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && 'A local PostgreSQL is required.' };
let database, isolated, root, store, matchStore, dataStore, plane, service, study, criteria;
const people = {};
const AS_OF = '2026-09-28T00:00:00Z';
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, 'casewithdraw');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 5000 });
  store = new VcrStore({ database }); await store.ready();
  matchStore = new VcrMatchStore({ database }); dataStore = new VcrDataStore({ database });
  const access = new VcrAccess({ store: dataStore });
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcr-case-withdraw-'));
  plane = new VcrDataPlane({ store: dataStore, access, config: { vcrDataPlaneDir: root }, erasure: new VcrErasureStore({ database, matchStore }) });
  study = await store.createStudy({ userId: 'alice', projectId: 'case-withdraw', name: 'Synthetic correction cases', dataTier: 'T1' });
  const source = await dataStore.createSource({ userId: 'alice', studyId: study.id, name: 'Charts', format: 'json', allowedUses: ['vcr'] });
  const protocol = await store.saveProtocolVersion({ studyId: study.id, userId: 'alice', title: 'P1', criteria: [
    { kind: 'inclusion', criterionType: 'other', requirement: { op: 'compare', variable: 'sex', comparator: 'eq', value: 'female' } }] });
  criteria = await matchStore.listCriteria({ studyId: study.id, protocolVersionId: protocol.id });
  // Two people, one on each side of the split, found by the keys the plane gives them.
  for (let n = 0; n < 40 && Object.keys(people).length < 2; n += 1) {
    const text = `Chart ${n}. Sex: F.`;
    const upload = await plane.storeUpload({ actor: 'alice', studyId: study.id, sourceId: source.id, name: 'chart.txt', role: 'document', subject: `person-${n}`, stream: streamOf(text) });
    const subjectKey = upload.file.detail.subjectKey, side = correctionPartition(study.id, subjectKey);
    if (people[side]) continue;
    const start = text.lastIndexOf('F');
    const fact = await matchStore.saveFact({ studyId: study.id, userId: 'alice', fact: { subjectKey, variable: 'sex', value: 'F', polarity: 'affirmed', visibleAt: '2026-09-01T00:00:00Z', surface: 'F',
      source: { documentId: upload.file.id, start, end: start + 1, quote: 'F' }, extractedBy: 'model' } });
    const assessment = assessSubject({ studyId: study.id, protocolVersionId: protocol.id, subjectKey, asOf: AS_OF, criteria, facts: [fact], documents: { [upload.file.id]: { text } } });
    const saved = await matchStore.saveAssessment({ userId: 'alice', assessment });
    await matchStore.overrideJudgment({ studyId: study.id, userId: 'alice', assessmentId: saved.id, criterionId: criteria[0].id, state: 'unknown', by: 'alice' });
    people[side] = { subjectKey, fileId: upload.file.id };
  }
  assert.equal(Object.keys(people).length, 2);
  await dataStore.createGrant({ userId: 'alice', sourceId: source.id, studyId: study.id, grantee: 'alice', purposes: ['vcr'] });
  service = createVcrCorrectionCases({ store, matchStore, dataPlane: plane, access });
});
after(async () => { await database?.close(); await isolated?.drop(); if (root) await fs.rm(root, { recursive: true, force: true }); });

test('a case whose source was withdrawn is left out of an export and a replay and counted, and the other cases go on', options, async () => {
  const whole = await service.exportDataset({ studyId: study.id, principal: 'alice' });
  assert.equal(whole.cases.length, 2);
  assert.equal(whole.selection.withdrawn, undefined, 'a dataset with no withdrawal reads as it always did');
  assert.equal((await service.replay({ studyId: study.id, principal: 'alice', datasetId: whole.datasetId })).evaluated, 1);

  // The development person withdraws consent: their facts were frozen into a case, so they are redacted and not deleted.
  const withdrawn = await plane.withdrawSubject({ studyId: study.id, subjectKey: people.development.subjectKey, actor: 'alice' });
  assert.deepEqual([withdrawn.files, withdrawn.factsRedacted, withdrawn.factsRemoved], [1, 1, 0]);
  const fresh = await service.exportDataset({ studyId: study.id, principal: 'alice' });
  assert.deepEqual(fresh.cases.map(row => row.partition), ['held_out']);
  assert.equal(fresh.selection.withdrawn, 1, 'and counted');
  // The dataset exported before still reads and replays: the case that rests on the withdrawn source is the one left out.
  assert.equal((await service.readDataset({ studyId: study.id, principal: 'alice', datasetId: whole.datasetId })).cases.length, 2);
  const report = await service.replay({ studyId: study.id, principal: 'alice', datasetId: whole.datasetId });
  assert.equal(report.evaluated, 1);
  assert.equal(report.withdrawn, 1, 'the case of the withdrawn person is the one left out; the held-out person is still replayed');
  assert.doesNotMatch(JSON.stringify([fresh, report]), /Chart \d|person-\d/);

  // The held-out person withdraws too: nothing is left to replay, and that is said as such rather than as a changed input.
  await plane.withdrawSubject({ studyId: study.id, subjectKey: people.held_out.subjectKey, actor: 'alice' });
  const none = await service.exportDataset({ studyId: study.id, principal: 'alice' });
  assert.deepEqual([none.cases.length, none.selection.withdrawn], [0, 2]);
  await assert.rejects(service.replay({ studyId: study.id, principal: 'alice', datasetId: whole.datasetId }), { code: 'vcr_evaluation_holdout_unavailable' });
});
