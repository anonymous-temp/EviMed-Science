import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { migrateProductStore } from '../src/productPersistence.mjs';
import { composeVcr } from '../src/vcrComposition.mjs';
import { createVcrDataIntake } from '../src/vcrDataIntake.mjs';
import { createVcrUploadReceipts } from '../src/vcrUploadReceipts.mjs';
import { createVcrGatewayHandler, vcrRuntimeWrite } from '../src/vcrGateway.mjs';
import { createWebApiApp } from '../src/server.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const options = { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'Owned local PostgreSQL required', timeout: 30_000 };
let isolated, database, dir, vcr, receipts, intake, documents;
const origin = { userId: 'owner', projectId: 'project', rootSessionId: 'root', runId: 'automated-run', callId: 'call' };
let project;
before(async () => {
  if (options.skip) return;
  isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'vcrintake');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await migrateProductStore(database);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ('owner','Owner','development'),('other','Other','development')");
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ('owner','project','Project',10000000)");
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vcr-conversation-intake-'));
  project = { userId: 'owner', id: 'project', baseDir: path.join(dir, 'project') };
  await fs.mkdir(project.baseDir);
  vcr = composeVcr({ productDatabase: database, config: { vcrEnabled: true, vcrAudience: 'all', vcrDataPlaneDir: path.join(dir, 'plane') } });
  await vcr.store.ready();
  documents = new ProductDocuments(database);
  receipts = createVcrUploadReceipts({ documents, sources: { list: async () => ({ items: [] }), get: async () => null } });
  intake = createVcrDataIntake({ store: vcr.store, dataStore: vcr.dataStore, dataPlane: vcr.dataPlane, sources: receipts, resolveProject: async () => project });
  vcr.dataIntake = intake;
});
after(async () => { await database?.close(); await isolated?.drop(); if (dir) await fs.rm(dir, { recursive: true, force: true }); });
const csv = 'PERSON,AGE\n' + Array.from({ length: 80 }, (_, i) => `original-${i},${40 + i}`).join('\n') + '\n';
const count = async table => Number((await database.query(`SELECT count(*) AS n FROM evimed_vcr.${table} WHERE user_id='owner'`)).rows[0].n);
async function call(operation, body) {
  const handler = createVcrGatewayHandler({ vcrEnabled: true }, { assertActiveModelGatewayToken: () => ({ userId: 'owner', projectId: 'project' }) },
    { vcr, resolveInvocation: async () => origin });
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method: 'POST', url: `/internal/vcr/v1/${operation}`, headers: { authorization: 'Bearer fixture', 'x-evimed-execution-context': 'verified-fixture' } });
  let status, json;
  await handler(req, { writeHead: code => { status = code; }, end: bytes => { json = JSON.parse(bytes); } });
  return { status, json };
}
test('contracts and matching schemas are available before a task exists and persist no scientific object', options, async () => {
  assert.equal(await count('studies'), 0);
  for (const [what, data] of [['patient_set', {}], ['decision', { question: 'syntax?' }]]) {
    assert.equal((await call('write', { what, data })).json.data.ok, false);
    assert.equal(await count('studies'), 0, 'an empty scientific probe creates no task scope');
  }
  const discovery = await call('read', { what: 'contracts' });
  assert.equal(discovery.status, 200);
  assert.deepEqual(discovery.json.data.writes.decision.required, ['question', 'chosen', 'rationale']);
  assert.ok(discovery.json.data.dataIntake.import_documents.required.includes('subjectColumn'));
  const matching = await call('read', { what: 'matching', filter: { kind: 'contract' } });
  assert.ok(matching.json.data.protocolWrite);
  assert.equal(await count('studies'), 0);
  const invalid = await call('write', { what: 'made_up', data: {} });
  assert.equal(invalid.status, 400);
  assert.equal(await count('studies'), 0);
});
test('ordinary authenticated file API persists an immutable original receipt without publishing or learning a knowledge source', options, async () => {
  const app = createWebApiApp({ dataDir: path.join(dir, 'http-app'), runtimeMode: 'mock', devAuth: false, authMode: 'local',
    bootstrapUser: '', bootstrapPassword: '', stateStore: 'postgres', requireSharedStateStore: true, databaseUrl: isolated.url,
    vcrEnabled: true, vcrAudience: 'all', vcrDataPlaneDir: path.join(dir, 'http-plane'), vcrPollMs: 3_600_000 });
  try {
    await app.store.createUser('http_uploader', 'test-only-password', 'Uploader');
    const address = await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'http_uploader', password: 'test-only-password' }) });
    const auth = await login.json();
    const headers = { 'content-type': 'application/json', cookie: login.headers.get('set-cookie').split(';')[0], 'x-open-science-csrf': auth.data.csrfToken };
    const response = await fetch(`${base}/api/files/upload`, { method: 'POST', headers, body: JSON.stringify({ path: 'baseline.csv', data: csv }) });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.ok(body.data.vcrInput.sourceId.startsWith('upl_'));
    const row = await documents.get('http_uploader', 'preferences', body.data.vcrInput.sourceId);
    assert.equal(row.payload.recordType, 'vcr-upload-original');
    assert.equal((await documents.list('http_uploader', 'source', { projectId: row.projectId, limit: 20 })).items.length, 0);
    const user = await app.store.userById('http_uploader');
    const owned = await app.store.requireProject(user, row.projectId);
    assert.equal(await fs.readFile(path.join(owned.baseDir, row.payload.paths[0]), 'utf8'), csv);
    assert.equal((await fetch(`${base}/api/files/upload`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'forged.csv', data: csv }) })).status, 401);
    await app.researchSessions.put(owned, 'upload_root', { mode: 'open-domain' });
    const nativeOrigin = { userId: user.id, projectId: owned.id, rootSessionId: 'upload_root', runId: 'automated-fixture', callId: 'call' };
    const study = await app.vcr.store.taskContext(nativeOrigin);
    const imported = await app.vcr.dataIntake(study, { action: 'import', ...body.data.vcrInput }, nativeOrigin);
    assert.equal(imported.state, 'uploaded');
    // The knowledge-base upload path still uses its own authenticated SourceService record, not the receipt ledger.
    const knowledge = await fetch(`${base}/api/files/upload`, { method: 'POST', headers,
      body: JSON.stringify({ root: 'base', path: 'knowledge-base/baseline.csv', data: csv }) });
    assert.equal(knowledge.status, 200);
    const source = (await app.sourceService.list(user.id, { projectId: owned.id, limit: 20 })).items[0];
    assert.ok(source.id.startsWith('src_'));
    const sourceImport = await app.vcr.dataIntake(study, { action: 'import', sourceId: source.id,
      generation: source.payload.generation, sha256: source.payload.fingerprint.sha256 }, nativeOrigin);
    assert.equal(sourceImport.state, 'uploaded');
  } finally { await app.close(); }
});
test('authenticated upload -> real map -> frozen snapshot -> population binds exact saved ids, with no cloud grant', options, async () => {
  const handle = await receipts.record(project, { name: 'baseline.csv', bytes: Buffer.from(csv) });
  const available = await call('read', { what: 'data_intake' });
  assert.equal(available.json.data.uploads[0].sourceId, handle.sourceId);
  assert.equal(await count('studies'), 0);
  const imported = await call('write', { what: 'data_intake', data: { action: 'import', ...handle } });
  assert.equal(imported.status, 200, JSON.stringify(imported));
  const sourceId = imported.json.data.sourceId;
  const study = await vcr.store.taskContext(origin, { create: false });
  const again = await intake(study, { action: 'import', ...handle }, origin);
  assert.equal(again.sourceId, sourceId);
  const proposed = await intake(study, { action: 'propose_map', sourceId, columns: [
    { table: 'source.csv', column: 'PERSON', role: 'subject_key', identifier: true },
    { table: 'source.csv', column: 'AGE', role: 'covariate', alias: 'age', concept: 'age', unit: 'year', type: 'integer' },
  ] }, origin);
  assert.equal(proposed.ok, true);
  await assert.rejects(intake(study, { action: 'freeze', sourceId, hash: proposed.hash }, origin), { code: 'vcr_field_map_unconfirmed' });
  await intake(study, { action: 'confirm_map', sourceId, hash: proposed.hash }, origin);
  assert.equal((await vcr.dataStore.sourceInStudy(study.id, sourceId)).fieldMapConfirmedBy, 'run:automated-run');
  await assert.rejects(intake(study, { action: 'freeze', sourceId, hash: 'changed' }, origin), { code: 'vcr_intake_map_changed' });
  const frozen = await intake(study, { action: 'freeze', sourceId, hash: proposed.hash }, origin);
  const snapshot = await vcr.dataStore.getSnapshot(frozen.snapshotId);
  assert.ok((await vcr.dataStore.listFieldMaps(snapshot.id)).every(row => row.reviewState === 'ai_set'));
  assert.equal(snapshot.rowCount, 80);
  assert.equal((await vcr.dataStore.listAnalysisTables({ studyId: study.id })).find(row => row.shape === 'subject').rowCount, 80);
  const saved = await vcrRuntimeWrite({ store: vcr.store, service: vcr.service, study, what: 'population', data: {
    name: 'Source cohort', kind: 'real', snapshotId: frozen.snapshotId, definition: { rules: [] },
  } });
  assert.equal(saved.ok, true);
  assert.equal((await vcr.store.populations(study.id))[0].snapshotId, frozen.snapshotId);
  assert.equal(JSON.stringify(frozen).includes('location'), false);
  const source = await vcr.dataStore.sourceInStudy(study.id, sourceId);
  assert.equal(source.cloudPermission?.state === 'allowed', false, 'intake cannot issue cloud permission');
  const changed = await intake(study, { action: 'propose_map', sourceId, columns: [
    { table: 'source.csv', column: 'PERSON', role: 'subject_key', identifier: true },
    { table: 'source.csv', column: 'AGE', role: 'covariate', alias: 'age_updated', unit: 'year' },
  ] }, origin);
  await intake(study, { action: 'confirm_map', sourceId, hash: changed.hash }, origin);
  const readback = await intake.read(study, {}, origin);
  const readiness = readback.dataSources.find(row => row.sourceId === sourceId);
  assert.deepEqual(readiness.missingPrerequisites, ['frozen_snapshot'], 'a historical snapshot cannot stand for a changed confirmed map');
  assert.equal(readiness.snapshots.find(row => row.snapshotId === frozen.snapshotId).currentMap, false);
});
test('empty scientific probes create neither patient sets nor decision rows', options, async () => {
  const study = await vcr.store.taskContext(origin, { create: false });
  const before = [await count('patient_sets'), await count('decisions')];
  for (const [what, data] of [['patient_set', {}], ['decision', { question: 'schema probe' }]]) {
    const result = await vcrRuntimeWrite({ store: vcr.store, service: vcr.service, study, what, data });
    assert.equal(result.ok, false);
    assert.deepEqual(result.ids, []);
  }
  assert.deepEqual([await count('patient_sets'), await count('decisions')], before);
  const valid = await vcrRuntimeWrite({ store: vcr.store, service: vcr.service, study, what: 'decision', data: {
    question: 'Which cohort source should the analysis use?', chosen: { source: 'The frozen baseline table' },
    rationale: 'Its inclusion criteria and baseline measurement time match the prespecified population.',
  } });
  assert.equal(valid.ok, true, 'substantive scientific choices remain writable');
  assert.equal(await count('decisions'), before[1] + 1);
});
test('cross-account/project, changed bytes, source generation and arbitrary paths are refused before patient admission', options, async () => {
  const study = await vcr.store.taskContext(origin, { create: false });
  const handle = await receipts.record(project, { name: 'sensitive.csv', bytes: Buffer.from(csv), sessionId: 'root' });
  const baseline = await count('sources');
  await assert.rejects(intake(study, { action: 'import', ...handle, generation: 2 }, origin));
  await assert.rejects(intake(study, { action: 'import', ...handle, sha256: 'a'.repeat(64) }, origin));
  await assert.rejects(intake(study, { action: 'import', ...handle }, { ...origin, userId: 'other' }));
  await assert.rejects(intake(study, { action: 'import', ...handle }, { ...origin, projectId: 'other' }));
  await assert.rejects(intake(study, { action: 'import', sourceId: '../runtime.csv', generation: 1, sha256: handle.sha256 }, origin));
  const row = await documents.get('owner', 'preferences', handle.sourceId);
  const full = path.join(project.baseDir, row.payload.paths[0]);
  await fs.writeFile(full, Buffer.alloc(Buffer.byteLength(csv), 65));
  await assert.rejects(intake(study, { action: 'import', ...handle }, origin), { code: 'vcr_intake_source_changed' });
  await fs.rm(full);
  await fs.symlink('/etc/hosts', full);
  await assert.rejects(intake(study, { action: 'import', ...handle }, origin));
  assert.equal(await count('sources'), baseline);
});
test('native uploads stay discoverable before pagination and explicit owned references can be reused in another root', options, async () => {
  const target = { ...origin, rootSessionId: 'paging_root' };
  const targetStudy = await vcr.store.taskContext(target);
  const initial = (await receipts.list('owner', { projectId: project.id, sessionId: target.rootSessionId, limit: 50 })).items.length;
  const own = [];
  for (let i = 0; i < 7; i++) own.push(await receipts.record(project, { name: `own-${i}.csv`, sessionId: target.rootSessionId, bytes: Buffer.from(`id,age\n${i},60\n`) }));
  for (let i = 0; i < 25; i++) await receipts.record(project, { name: `other-${i}.csv`, sessionId: 'sibling_root', bytes: Buffer.from(`id,age\n${i},58\n`) });
  const found = new Set();
  let filter = { limit: 3 }, first;
  do {
    const page = await intake.read(targetStudy, filter, target);
    first ??= page;
    assert.ok(page.uploads.length <= 3);
    for (const upload of page.uploads) {
      assert.ok(!found.has(upload.sourceId), 'continuation must not restart the first page');
      found.add(upload.sourceId);
    }
    filter = page.nextRead?.filter;
  } while (filter);
  assert.ok(own.every(upload => found.has(upload.sourceId)), 'sibling uploads cannot push this root off discovery');
  assert.equal(found.size, own.length + initial, 'only current-root and existing project-level receipts are listed');
  assert.ok(first.nextCursor);
  const sibling = { ...origin, rootSessionId: 'reuse_root' };
  const siblingStudy = await vcr.store.taskContext(sibling);
  const selected = await intake.read(siblingStudy, { sourceId: own[0].sourceId }, sibling);
  assert.equal(selected.uploads[0].sourceId, own[0].sourceId);
  assert.equal((await intake(siblingStudy, { action: 'import', ...own[0] }, sibling)).state, 'uploaded');
  const foreignProject = { ...sibling, projectId: 'another_project' };
  await assert.rejects(intake.read(siblingStudy, { sourceId: own[0].sourceId }, foreignProject));
  await assert.rejects(intake.read(siblingStudy, { cursor: 'bad' }, sibling), { code: 'vcr_read_filter_invalid' });
});
test('freeze binds the requested confirmed map through the snapshot transaction despite concurrent edits or withdrawal during profiling', options, async () => {
  const raceOrigin = { ...origin, rootSessionId: 'freeze_race' };
  const study = await vcr.store.taskContext(raceOrigin);
  const handle = await receipts.record(project, { name: 'freeze-race.csv', bytes: Buffer.from(csv) });
  const { sourceId } = await intake(study, { action: 'import', ...handle }, raceOrigin);
  const columns = [
    { table: 'source.csv', column: 'PERSON', role: 'subject_key', identifier: true },
    { table: 'source.csv', column: 'AGE', role: 'covariate', alias: 'age', unit: 'year' },
  ];
  const setMap = async mapping => {
    const proposed = await intake(study, { action: 'propose_map', sourceId, columns: mapping }, raceOrigin);
    await intake(study, { action: 'confirm_map', sourceId, hash: proposed.hash }, raceOrigin);
    return proposed.hash;
  };
  const a = await setMap(columns);
  const originalProfiler = vcr.dataPlane.profiler;
  const duringProfile = async (hash, mutation, expectedCode) => {
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    const resume = new Promise(resolve => { release = resolve; });
    let first = true;
    vcr.dataPlane.profiler = async input => {
      if (first) { first = false; entered(); await resume; }
      return originalProfiler(input);
    };
    const pending = intake(study, { action: 'freeze', sourceId, hash }, raceOrigin);
    const refused = assert.rejects(pending, { code: expectedCode });
    try { await started; await mutation(); }
    finally { release(); }
    try { await refused; }
    finally { vcr.dataPlane.profiler = originalProfiler; }
    assert.equal((await vcr.dataStore.listSnapshots({ studyId: study.id })).length, 0);
  };
  let b;
  await duringProfile(a, async () => { b = await setMap(columns.map(row => row.column === 'AGE' ? { ...row, alias: 'age_years' } : row)); }, 'vcr_field_map_changed');
  await assert.rejects(intake(study, { action: 'freeze', sourceId, hash: a }, raceOrigin), { code: 'vcr_intake_map_changed' });
  await duringProfile(b, () => vcr.dataPlane.proposeFieldMap({ actor: 'owner', studyId: study.id, sourceId,
    columns: columns.map(row => row.column === 'AGE' ? { ...row, alias: 'age_years' } : row) }), 'vcr_field_map_unconfirmed');
  b = await setMap(columns);
  await duringProfile(b, () => vcr.dataStore.setSourceStatus({ sourceId, status: 'withdrawn', actor: 'owner' }), 'vcr_source_withdrawn');
});
test('upload continuation preserves PostgreSQL timestamp precision and does not skip tied-millisecond originals', options, async () => {
  // Current product schema uses millisecond precision; preserve exact strings for deployments retaining richer timestamps too.
  await database.query('ALTER TABLE evimed_product.documents ALTER COLUMN created_at TYPE timestamptz');
  const target = { ...origin, rootSessionId: 'microsecond_root' };
  const study = await vcr.store.taskContext(target);
  const originals = [];
  for (const suffix of ['900', '800', '700']) {
    const handle = await receipts.record(project, { name: `micro-${suffix}.csv`, sessionId: target.rootSessionId, bytes: Buffer.from(`id,age\n${suffix},60\n`) });
    originals.push(handle);
    await database.query("UPDATE evimed_product.documents SET created_at=$2::timestamptz WHERE user_id='owner' AND kind='preferences' AND id=$1",
      [handle.sourceId, `2100-01-01 00:00:00.000${suffix}+00`]);
  }
  const found = [];
  let filter = { limit: 1 };
  do {
    const page = await intake.read(study, filter, target);
    found.push(...page.uploads.map(row => row.sourceId));
    filter = page.nextRead?.filter;
  } while (filter);
  assert.deepEqual(found.slice(0, originals.length), originals.map(row => row.sourceId));
});
test('batch matching imports original subject narratives from owned CSV and never manufactures subject ids', options, async () => {
  const study = await vcr.store.taskContext(origin, { create: false });
  const handle = await receipts.record(project, { name: 'cases.csv', bytes: Buffer.from('case_id,narrative\nP01,Original age 62\nP02,Original age 58\n') });
  const done = await intake(study, { action: 'import_documents', ...handle, subjectColumn: 'case_id', textColumn: 'narrative' }, origin);
  assert.equal(done.documents.length, 2);
  assert.ok(done.documents.every(row => row.subjectKey && row.subjectKey !== 'P01' && row.subjectKey !== 'P02'));
  assert.equal(new Set(done.documents.map(row => row.subjectKey)).size, 2);
  const again = await intake(study, { action: 'import_documents', ...handle, subjectColumn: 'case_id', textColumn: 'narrative' }, origin);
  assert.deepEqual(again.documents, done.documents);
  const duplicate = await receipts.record(project, { name: 'duplicate.csv', bytes: Buffer.from('case_id,narrative\nP01,A\nP01,B\n') });
  await assert.rejects(intake(study, { action: 'import_documents', ...duplicate, subjectColumn: 'case_id', textColumn: 'narrative' }, origin));
  await assert.rejects(vcr.documents.runtimeRead({ ...study, cloudContext: { runId: 'automated-run', sessionId: 'root' } }, done.documents[0]),
    { code: 'vcr_cloud_processing_not_authorized' }, 'preservation is not a cloud grant');
});
