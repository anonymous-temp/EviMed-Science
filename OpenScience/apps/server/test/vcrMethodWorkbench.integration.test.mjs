import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { before, after, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { composeVcr } from '../src/vcrComposition.mjs';
import { createVcrRoutes } from '../src/vcrRoutes.mjs';
import { vcrScenarioHash } from '../src/vcrJobs.mjs';
import { vcrComputedOutputHash } from '../src/vcrEngineClient.mjs';
import { VcrOrchestrator, vcrProgramSteps } from '../src/vcrOrchestrator.mjs';
import { createVcrWorkerLoops } from '../src/vcrWorker.mjs';
import { ProductDocuments } from '../src/productStore.mjs';
import { ProductJobs } from '../src/productJobs.mjs';
import { SourceService } from '../src/sourceService.mjs';
import { createVcrModelSources } from '../src/vcrModelSources.mjs';
import { createVcrCurveEvidence } from '../src/vcrCurveEvidence.mjs';
import { VcrEvidenceStore } from '../src/vcrEvidenceStore.mjs';
import { furnishCalculation } from '../../../scripts/ops/walk-fixture/vcr.mjs';
import { FIELD_MAP, cohortCsv } from './helpers/vcrIntakeData.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
const options = { skip: !databaseUrl && 'OPEN_SCIENCE_TEST_POSTGRES_URL is not configured' };
let isolated, database, composed, plane;
const config = { vcrEnabled: true, vcrAudience: 'all', operatorUsers: [], vcrPreviewUsers: [] };
const user = { id: 'workbench-owner' };
before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, 'vcrworkbench');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 5, databaseConnectionTimeoutMs: 3000 });
  await database.migrate();
  plane = await fs.mkdtemp(path.join(os.tmpdir(), 'vcr-workbench-'));
  await fs.chmod(plane, 0o700);
  composed = composeVcr({ config: { ...config, vcrDataPlaneDir: plane }, productDatabase: database });
  await composed.store.ready();
});
after(async () => { await database?.close(); if (isolated) await isolated.drop(); if (plane) await fs.rm(plane, { recursive: true, force: true }); });

async function request(url, method = 'GET', body = null, who = user) {
  const routes = createVcrRoutes({ store: { async ensureSessionUser() { return { user: who }; }, async assertCsrf() {} },
    vcrStore: composed.store, service: composed.service, jobs: composed.jobs, config, maxJsonBytes: 65536, audit: async () => {},
    projects: { async create(_owner, name) { return { id: `project-${Date.now()}-${Math.random()}`, name }; }, async bindSession() { throw new Error('Calculation must not bind a specialist'); } } });
  const chunks = [];
  const res = Object.assign(new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } }), {
    writeHead() { return this; },
  });
  const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), { url, method, headers: { 'content-type': 'application/json' } });
  await routes(req, res);
  return JSON.parse(Buffer.concat(chunks).toString()).data;
}

function binary(treatmentRate = .6) {
  return { design: { nTreat: 20, nControl: 20 }, endpoint: { type: 'binary' }, truth: { controlRate: .4, treatmentRate } };
}

function engine() {
  const known = new Map();
  return {
    configured: () => true,
    async submit(job) { known.set(job.jobId, job); return { jobId: job.jobId, accepted: true }; },
    async status() { return { state: 'succeeded', progress: { done: 40, total: 40 }, cpuSeconds: 1 }; },
    async result(id) {
      const job = known.get(id);
      const population = job.method === 'population.scenario';
      const quality = job.method === 'population.quality';
      const csv = population ? `age,female\n${job.seed === 999 ? 80 : 61.2},0\n55.9,1\n70.4,0\n` : 'patientId,arm,y\n' + Array.from({ length: 40 }, (_, i) => `vp_${i + 1},${i < 20 ? 0 : 1},${i < 20 ? +(i < 9) : +(i < 31)}`).join('\n') + '\n';
      const tableName = population ? "population" : "virtual-patients";
      const location = `derived/${job.studyId}/${id}/${tableName}.csv`;
      await fs.mkdir(path.dirname(path.join(plane, location)), { recursive: true });
      await fs.writeFile(path.join(plane, location), csv);
      const result = { jobId: id, protocolVersion: 1, status: 'succeeded', method: job.method, methodVersion: job.methodVersion,
        scenarioHash: vcrScenarioHash(job.scenario), seed: job.seed, replicates: job.replicates ?? null, conclusion: 'estimable',
        counts: { realPatients: 0, generatedRecords: quality ? 0 : 40 }, measures: [], diagnostics: quality ? { quality: { fidelity: { global: { sPMSE: .02 } }, disclosure: { replicationRatio: 0 } } } : {},
        tables: quality ? [] : [{ name: tableName, location, sha256: createHash('sha256').update(csv).digest('hex'), rows: 40 }],
        manifest: { engineVersion: '1.0.0', rVersion: 'R 4.3.3', packageLockHash: 'b'.repeat(64), startedAt: '2026-10-20T00:00:00Z', finishedAt: '2026-10-20T00:00:01Z', cpuSeconds: 1 } };
      result.manifest.outputHash = vcrComputedOutputHash(result);
      return { result, signed: true, refused: false };
    },
  };
}

test('calculation creation, named configurations, exact persisted job results and composition table reads stay connected', options, async () => {
  const created = await request('/api/vcr/studies', 'POST', { name: 'Binary calculation', purpose: 'calculation' });
  const study = await composed.store.studyById(created.id);
  assert.equal(study.status, 'active');
  assert.equal(study.purpose, 'calculation');
  assert.deepEqual(created.requested, []);
  assert.equal(created.sessionId, null);
  let conversationResolutions = 0;
  composed.service.attach({ conversations: { async resolve() { conversationResolutions++; throw new Error('Must not bind a calculation to a specialist on read'); } } });
  assert.equal((await composed.service.studyView(user, study.id)).conversation.sessionId, null);
  assert.equal(conversationResolutions, 0, 'reading a calculation never enters the specialist session resolver');

  assert.ok(Object.values(vcrProgramSteps(study.steps, study.purpose)).every(step => !step.requested));
  assert.ok(Object.values(vcrProgramSteps({ definition: { status: 'done', requested: false } }, 'calculation')).every(step => !step.requested));
  assert.ok(Object.values(vcrProgramSteps({ definition: { status: 'done', requested: false } })).every(step => step.requested));
  const prefix = `/api/vcr/studies/${study.id}`;
  const configuration = await request(`${prefix}/method-configurations`, 'POST', { method: 'patients.binary', name: 'Response calculation', scenario: binary() });
  assert.equal(configuration.objectKind, 'patient_set');
  assert.equal(configuration.version, 1);
  const retries = await Promise.all(Array.from({ length: 8 }, () => request(`${prefix}/method-configurations`, 'POST', {
    method: 'patients.binary', name: 'Response calculation', scenario: binary() })));
  assert.ok(retries.every(retry => retry.subjectId === configuration.subjectId && retry.version === 1), 'lost-response and concurrent retries do not create extra versions or exhaust the connection pool');

  assert.deepEqual(await request(`${prefix}/method-configurations`, 'POST', { method: 'patients.binary', name: 'Response calculation', scenario: binary(), subjectId: configuration.subjectId }), configuration);
  const mockEngine = engine();
  composed.jobs.engine = mockEngine;
  const first = await request(`${prefix}/jobs`, 'POST', { kind: 'generate_patients_binary', scenario: binary(), subjectId: configuration.subjectId, inputs: [] });
  const [claimed] = await composed.jobs.claim();
  assert.equal(claimed.id, first.id, 'active calculation jobs are claimable');
  await composed.jobs.advance(claimed);
  assert.equal((await composed.jobs.advance(claimed)).action, 'finished');
  const firstRead = await request(`${prefix}/jobs/${first.id}/result`);
  assert.equal(firstRead.result.subjectId, configuration.subjectId);
  assert.equal(firstRead.records.available, true);
  assert.equal(firstRead.records.rows, 40);
  assert.doesNotMatch(JSON.stringify(firstRead), /derived\//);
  assert.deepEqual(firstRead.records.calibration.rows.map(row => [row.declared, row.generated]), [[.4, .45], [.6, .55]]);
  let dispatched = 0, reviews = 0;
  const orchestrator = new VcrOrchestrator({ store: composed.store, jobs: composed.jobs,
    dispatchRun: async () => { dispatched++; return { runId: 'unexpected', sessionId: null }; },
    queueReviews: async () => { reviews++; } });
  const completedJob = await composed.jobs.get(study.id, first.id);
  await orchestrator.noteRuntimeJob(study, completedJob.checkpoint, completedJob);
  await orchestrator.onJobFinished({ job: completedJob, result: await composed.store.result(study.id, firstRead.result.id) });
  assert.deepEqual(await orchestrator.advance(study.id), { skipped: 'calculation' });
  await createVcrWorkerLoops({ jobs: composed.jobs, orchestrator, store: composed.store }).orchestrator();
  assert.equal(dispatched, 0);
  assert.equal(reviews, 0);
  assert.deepEqual((await composed.store.studyById(study.id)).steps, study.steps, 'job completion and worker ticks do not add programme waiting states or definition work');
  const repeated = await request(`${prefix}/jobs`, 'POST', { kind: 'generate_patients_binary', scenario: binary(), subjectId: configuration.subjectId, inputs: [], seed: 99 });
  const [repeatedClaim] = await composed.jobs.claim();
  await composed.jobs.advance(repeatedClaim); await composed.jobs.advance(repeatedClaim);
  assert.equal((await request(`${prefix}/jobs/${repeated.id}/result`)).result.subjectId, configuration.subjectId);
  assert.deepEqual(await request(`${prefix}/jobs/${first.id}/result`), firstRead, 'same-subject reruns retain exact earlier execution and results');
  const patientsTab = await composed.service.tab(user, study.id, 'patients');
  assert.ok(patientsTab.records, 'real composition attaches table reader to service');
  const secondConfiguration = await request(`${prefix}/method-configurations`, 'POST', { method: 'patients.binary', name: 'Response calculation', scenario: binary(.7), subjectId: configuration.subjectId });
  assert.equal(secondConfiguration.version, 2);
  const second = await request(`${prefix}/jobs`, 'POST', { kind: 'generate_patients_binary', scenario: binary(.7), subjectId: secondConfiguration.subjectId, inputs: [] });
  const [next] = await composed.jobs.claim();
  await composed.jobs.advance(next); await composed.jobs.advance(next);
  const secondRead = await request(`${prefix}/jobs/${second.id}/result`);
  assert.notEqual(secondRead.result.id, firstRead.result.id);
  assert.deepEqual(secondRead.records.calibration.rows.map(row => [row.declared, row.generated]), [[.4, .45], [.7, .55]]);
  assert.deepEqual(await request(`${prefix}/jobs/${first.id}/result`), firstRead, 'later study result never replaces historical job result');
  assert.equal((await composed.jobs.configuration(study.id, first.id)).subjectId, configuration.subjectId);
  const other = await composed.store.createStudy({ userId: user.id, projectId: 'another-study', purpose: 'calculation' });
  await assert.rejects(request(`/api/vcr/studies/${other.id}/jobs/${first.id}/result`), { code: 'vcr_job_not_found' });
  await assert.rejects(request(`${prefix}/jobs/${first.id}/result`, 'GET', null, { id: 'foreign-user' }), { code: 'vcr_study_not_found' });
  await assert.rejects(request(`/api/vcr/studies/${other.id}/method-configurations`, 'POST', { method: 'patients.binary', name: 'Foreign subject', scenario: binary(), subjectId: configuration.subjectId }), { code: 'vcr_simulate_subject_unknown' });
  await assert.rejects(request(`${prefix}/method-configurations`, 'POST', { method: 'patients.binary', name: 'Foreign model', scenario: binary(), modelId: 'unknown_model' }), { code: 'not_found' });
  await assert.rejects(request(`${prefix}/method-configurations`, 'POST', { method: 'patients.binary', name: 'Invalid settings', scenario: { ...binary(), invented: true } }), { code: 'vcr_job_scenario_invalid' });
  await assert.rejects(request(`${prefix}/jobs`, 'POST', { kind: 'weight_comparator', scenario: { covariates: ['age'], endpoint: { type: 'continuous' }, outcomeColumn: 'y' }, inputs: [] }), { code: 'vcr_simulate_subject_required' });
  assert.deepEqual(await request(`${prefix}/method-configurations`, 'POST', { method: 'profile.snapshot', name: 'Snapshot profile', scenario: {} }), { subjectId: null, objectKind: null, version: null });
  await assert.rejects(request(`${prefix}/method-configurations`, 'POST', { method: 'matching.evaluate', name: 'Matching', scenario: {} }), { code: 'vcr_job_kind_invalid' });
  await request(prefix, 'PATCH', { action: 'auto' });
  assert.ok(Object.values((await composed.store.studyById(study.id)).steps).every(step => !step.requested));
  const comparator = await request(`${prefix}/method-configurations`, 'POST', { method: 'comparator.entropy_balance', name: 'Weighting', scenario: { covariates: ['age'], endpoint: { type: 'continuous' }, outcomeColumn: 'y' } });
  assert.equal((await composed.store.comparatorDesigns(study.id)).find(row => row.id === comparator.subjectId).name, 'Weighting');
  const evalue = await request(`${prefix}/method-configurations`, 'POST', { method: 'comparator.evalue', name: 'Sensitivity', scenario: { riskRatio: 1.5 } });
  assert.equal((await composed.store.comparatorDesigns(study.id)).find(row => row.id === evalue.subjectId).estimand, null, 'a method with no estimand does not invent ATT');
  const gridScenario = { design: { kind: 'two_arm_fixed', nTreat: 150, nControl: 150 }, endpoint: { type: 'time_to_event' },
    truth: { hazardRatio: .7, controlMedian: 6 }, analysis: { method: 'logrank', alpha: .025, sided: 1 }, accrual: { kind: 'uniform', duration: 12, followup: 12 }, performance: ['power'],
    designs: [{ kind: 'two_arm_fixed', nTreat: 150, nControl: 150 }], truths: [{ hazardRatio: .7, controlMedian: 6 }] };
  const grid = await request(`${prefix}/method-configurations`, 'POST', { method: 'design.grid', name: 'Power alternatives', scenario: gridScenario });
  assert.equal((await composed.store.latestDesignGrid(study.id)).name, 'Power alternatives');
  assert.deepEqual(await request(`${prefix}/method-configurations`, 'POST', { method: 'design.grid', name: 'Power alternatives', scenario: gridScenario }), grid);


  await assert.rejects(request(`${prefix}/jobs`, 'POST', { kind: 'weight_comparator', subjectId: comparator.subjectId, scenario: { covariates: ['age'], endpoint: { type: 'continuous' }, outcomeColumn: 'y' }, inputs: [] }), { code: 'vcr_job_scenario_invalid' });
  await composed.store.query(`INSERT INTO evimed_vcr.patient_sets (id, study_id, user_id, version, name, scenario)
    SELECT 'pts_history_' || $1 || g, $1, $2, (SELECT coalesce(max(version),0) FROM evimed_vcr.patient_sets WHERE study_id=$1) + g,
      'Other configuration ' || g, $3::jsonb FROM generate_series(1,205) g`, [study.id, user.id, JSON.stringify(binary(.5))]);
  assert.deepEqual(await request(`${prefix}/method-configurations`, 'POST', { method: 'patients.binary', name: 'Response calculation', scenario: binary() }), configuration,
    'a lost initial response can recover a configuration older than the list page');
  const historicalRun = await request(`${prefix}/jobs`, 'POST', { kind: 'generate_patients_binary', scenario: binary(), subjectId: configuration.subjectId, inputs: [], seed: 1234 });
  await request(`${prefix}/jobs/${historicalRun.id}/cancel`, 'POST', {});
  const file = (await composed.store.result(study.id, firstRead.result.id)).tables[0];
  await fs.rm(path.join(plane, file.location));
  const missing = await request(`${prefix}/jobs/${first.id}/result`);
  assert.equal(missing.result.id, firstRead.result.id);
  assert.equal(missing.records.available, false);
  assert.equal(missing.records.state, 'unavailable');
});


test('the composed population tab reads its persisted result table without a programme observer', options, async () => {
  const created = await request('/api/vcr/studies', 'POST', { name: 'Population calculation', purpose: 'calculation' });
  const prefix = `/api/vcr/studies/${created.id}`;
  const scenario = { n: 3, population: { variables: [{ name: 'age', family: 'normal', mean: 60, sd: 10 }] } };
  const prepared = await request(`${prefix}/method-configurations`, 'POST', { method: 'population.scenario', name: 'Age distribution', scenario });
  composed.jobs.engine = engine();
  const queued = await request(`${prefix}/jobs`, 'POST', { kind: 'generate_population', subjectId: prepared.subjectId, scenario, inputs: [] });
  const [claimed] = await composed.jobs.claim();
  await composed.jobs.advance(claimed); await composed.jobs.advance(claimed);
  const result = await request(`${prefix}/jobs/${queued.id}/result`);
  assert.equal(result.records.rows, 3);
  const tab = await composed.service.tab(user, created.id, 'population');
  assert.equal(tab.records.rows, 3);
  assert.ok(tab.profile.length);
  assert.equal((await composed.service.listStudies(user)).studies.find(study => study.id === created.id).purpose, 'calculation');
  assert.equal((await composed.service.studyViewOf(await composed.store.studyById(created.id))).purpose, 'calculation');
});


test('two source-bound model versions retain their configuration and exact result calibration across account-owned reuse', options, async () => {
  await database.query("INSERT INTO evimed_control.users (id,name,auth_type) VALUES ($1,'Method owner','development')", [user.id]);
  await database.query("INSERT INTO evimed_control.projects (user_id,id,name,quota_bytes) VALUES ($1,'method-source-project','Sources',1048576)", [user.id]);
  const sourceStudy = await composed.store.createStudy({ userId: user.id, projectId: 'method-source-project', name: 'Sources' });
  const target = await composed.store.createStudy({ userId: user.id, projectId: 'method-target-project', name: 'Calculations', purpose: 'calculation' });
  const productJobs = new ProductJobs(database);
  const sources = new SourceService(new ProductDocuments(database), productJobs);
  composed.service.attach({ modelSources: createVcrModelSources({ sources }) });
  composed.jobs.engine = engine();
  const prefix = `/api/vcr/studies/${target.id}`;
  const answers = [];
  for (const [index, treatmentRate] of [[1, .6], [2, .5]]) {
    const text = `Control response was 40%; intervention response was ${treatmentRate * 100}%.`;
    const { source } = await sources.register(user.id, { projectId: 'method-source-project', connector: { type: 'upload', id: 'library' },
      path: `knowledge-base/trial-${index}.txt`, sha256: createHash('sha256').update(text).digest('hex'), size: text.length, mimeType: 'text/plain', mtime: '2026-10-20T00:00:00Z' });
    // This fixture processes immediately even when the local host clock leads PostgreSQL.
    await productJobs.bringForward(user.id, `ingest:${source.id}:generation:${source.payload.generation}`);
    const ingest = await productJobs.claim(['ingest'], 'workbench-source-fixture', { leaseMs: 3000 });
    await sources.beginIngestion(user.id, source.id, { generation: source.payload.generation, job: ingest });
    await sources.freezeCapture(ingest, { text, summary: 'Trial source', extractor: { name: 'fixture', version: '1', parser: 'fallback' }, units: [{ id: 'page1', unitType: 'page', status: 'extracted', itemIds: [] }] });
    const preview = await composed.service.modelSourcePreview(user, sourceStudy.id, source.id);
    const model = await composed.service.adoptModel(user, { studyId: sourceStudy.id, name: 'Response reference', version: String(index), card: {
      literatureSource: preview, executionProfile: 'patients.binary', parameterBindings: [
        { field: 'truth.controlRate', candidateId: preview.parameters[0].id }, { field: 'truth.treatmentRate', candidateId: preview.parameters[1].id },
      ] } });
    const scenario = binary(treatmentRate);
    const prepared = await request(`${prefix}/method-configurations`, 'POST', { method: 'patients.binary', name: 'Reference calculation', scenario, modelId: model.id,
      ...(answers.length ? { subjectId: answers[0].prepared.subjectId } : {}) });
    const queued = await request(`${prefix}/jobs`, 'POST', { kind: 'generate_patients_binary', subjectId: prepared.subjectId, scenario, modelId: model.id, inputs: [] });
    const [claimed] = await composed.jobs.claim();
    await composed.jobs.advance(claimed); await composed.jobs.advance(claimed);
    const answer = await request(`${prefix}/jobs/${queued.id}/result`);
    assert.deepEqual(answer.execution.sourceModel, { id: model.id, version: String(index) });
    assert.deepEqual(answer.records.calibration.rows.map(row => [row.declared, row.generated]), [[.4, .45], [treatmentRate, .55]]);
    answers.push({ prepared, jobId: queued.id, answer, sourceId: source.id });
  }
  assert.notEqual(answers[0].prepared.subjectId, answers[1].prepared.subjectId);
  assert.deepEqual(await request(`${prefix}/jobs/${answers[0].jobId}/result`), answers[0].answer);
  await assert.rejects(composed.service.modelSourcePreview(user, target.id,
    answers[0].sourceId), { code: 'source_not_found' });
});


test('population quality references and assesses an existing population without replacing its definition, generation or profile', options, async () => {
  const created = await request('/api/vcr/studies', 'POST', { name: 'Population quality', purpose: 'calculation' });
  const study = await composed.store.studyById(created.id);
  const scenario = { n: 3, population: { variables: [{ name: 'age', family: 'normal', mean: 60, sd: 10 }] } };
  const population = await composed.store.savePopulation({ studyId: study.id, userId: user.id, name: 'Retained population', kind: 'scenario',
    definition: scenario, counts: { eligible: 3 }, profile: { retained: true }, allowedUses: ['design'] });
  const prefix = `/api/vcr/studies/${study.id}`;
  composed.jobs.engine = engine();
  const generation = await request(`${prefix}/jobs`, 'POST', { kind: 'generate_population', subjectId: population.id, scenario, inputs: [] });
  let [claimed] = await composed.jobs.claim();
  await composed.jobs.advance(claimed); await composed.jobs.advance(claimed);
  const original = await composed.store.latestPopulation(study.id);
  const originalResult = await composed.store.result(study.id, original.resultId);
  const dataPlane = composed.dataPlane;
  async function trainingSnapshot(name) {
    const source = await dataPlane.registerSource({ userId: user.id, studyId: study.id, name, ownerParty: 'Research team', allowedUses: ['vcr'] });
    await dataPlane.storeUpload({ actor: user.id, studyId: study.id, sourceId: source.id, name: 'training.csv', stream: Readable.from(['ID,AGE\n1,61\n2,56\n3,70\n']) });
    const proposed = await dataPlane.proposeFieldMap({ actor: user.id, studyId: study.id, sourceId: source.id, columns: [
      { table: 'training.csv', column: 'ID', role: 'subject_key', identifier: true },
      { table: 'training.csv', column: 'AGE', role: 'covariate', alias: 'age', concept: 'age' },
    ] });
    await dataPlane.confirmFieldMap({ actor: user.id, studyId: study.id, sourceId: source.id, hash: proposed.hash });
    return (await dataPlane.freezeSnapshot({ userId: user.id, studyId: study.id, sourceId: source.id })).snapshot;
  }
  const training = await trainingSnapshot('Training');
  const holdout = await trainingSnapshot('Holdout');
  const intake = (await composed.service.tab(user, study.id, 'data')).intake;
  const trainingInput = intake.snapshots.find(row => row.id === training.id).qualityInputs[0];
  const holdoutInput = intake.snapshots.find(row => row.id === holdout.id).qualityInputs[0];
  assert.ok(trainingInput.columns.includes('age'));
  assert.equal(trainingInput.inputId, `${training.id}:subject`);
  assert.equal(intake.snapshots.find(row => row.id === training.id).qualityInputs.length, 1, 'derived subject inputs hide raw references the quality resolver would ignore');
  assert.deepEqual(trainingInput.columnLabels, { age: 'AGE' });
  assert.doesNotMatch(JSON.stringify(intake.snapshots), /location|derived\//);
  let qualityBasis = (await composed.service.tab(user, study.id, 'population')).versions.find(row => row.id === population.id).generationInput;
  assert.ok(qualityBasis);
  let qualityScenario = { trainingInputId: trainingInput.inputId, holdoutInputId: holdoutInput.inputId, syntheticInputId: qualityBasis.inputId };
  const qualityInputs = [{ kind: 'snapshot', id: training.id }, { kind: 'snapshot', id: holdout.id }];
  await assert.rejects(request(`${prefix}/method-configurations`, 'POST', { method: 'population.quality', name: 'Quality', scenario: qualityScenario }), { code: 'vcr_simulate_subject_required' });
  const prepared = await request(`${prefix}/method-configurations`, 'POST', { method: 'population.quality', name: 'Quality', subjectId: population.id, scenario: qualityScenario });
  assert.equal(prepared.subjectId, population.id);
  assert.deepEqual(await composed.store.latestPopulation(study.id), original, 'preparing a quality check does not revise the population');
  {
    const queued = await request(`${prefix}/jobs`, 'POST', { kind: 'population_quality', subjectId: population.id, scenario: qualityScenario, inputs: qualityInputs, qualityBasis });
    [claimed] = await composed.jobs.claim();
    await composed.jobs.advance(claimed);
    const transactionBeforeRetry = composed.store.transaction.bind(composed.store);
    let finishReady, releaseFinish, retryReady;
    const finishPaused = new Promise(resolve => { finishReady = resolve; });
    const finishGate = new Promise(resolve => { releaseFinish = resolve; });
    const retryStarted = new Promise(resolve => { retryReady = resolve; });
    let finishPid, retryPid;
    composed.store.transaction = operation => transactionBeforeRetry(client => operation({ async query(sql, values) {
      if (/SELECT p\.result_id/.test(sql)) {
        finishPid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        finishReady(); await finishGate;
      }
      if (/INSERT INTO evimed_vcr\.jobs/.test(sql)) {
        retryPid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        retryReady();
      }
      return client.query(sql, values);
    } }));
    const finishing = composed.jobs.advance(claimed);
    let retrying;
    try {
      await finishPaused;
      retrying = request(`${prefix}/jobs`, 'POST', { kind: 'population_quality', subjectId: population.id, scenario: qualityScenario, inputs: qualityInputs, qualityBasis });
      await retryStarted;
      let blockers = [];
      for (let pass = 0; pass < 100; pass++) {
        blockers = (await database.query('SELECT pg_blocking_pids($1) AS blockers', [retryPid])).rows[0].blockers;
        if (blockers.includes(finishPid)) break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.ok(blockers.includes(finishPid), 'PostgreSQL confirms the identical enqueue waits on the completing quality job');
      releaseFinish();
      const [finished, retried] = await Promise.all([finishing, retrying]);
      assert.equal(finished.action, 'finished');
      assert.equal(retried.id, queued.id, 'the retry returns the same finished job without a population/job lock cycle');
      assert.equal(retried.state, 'succeeded');
    } finally {
      releaseFinish();
      await Promise.allSettled([finishing, retrying]);
      composed.store.transaction = transactionBeforeRetry;
    }
    const assessment = await request(`${prefix}/jobs/${queued.id}/result`);
    assert.equal(assessment.result.kind, 'population_quality');
    assert.equal(assessment.result.subjectId, population.id);
    const assessed = await composed.store.latestPopulation(study.id);
    const { quality: _beforeQuality, ...before } = original;
    const { quality, ...after } = assessed;
    assert.deepEqual(after, before, 'completed evaluation preserves generation pointer, definition, counts, profile and allowed uses');
    assert.equal(quality.disclosure.replicationRatio, 0);
    assert.deepEqual(await composed.store.result(study.id, original.resultId), originalResult, 'quality does not supersede or rewrite the generated result');
    assert.equal((await composed.service.tab(user, study.id, 'population')).records.rows, 3);
    assert.equal(quality.assessmentResultId, assessment.result.id);
    assert.deepEqual((await composed.jobs.configuration(study.id, queued.id)).qualityBasis, qualityBasis);
    assert.equal((await composed.jobs.configuration(study.id, queued.id)).qualityBasisAvailable, true);
    const executionInputs = (await database.query('SELECT inputs FROM evimed_vcr.executions WHERE job_id=$1', [queued.id])).rows[0].inputs;
    assert.deepEqual(executionInputs.map(entry => entry.id).sort(), [trainingInput.inputId, holdoutInput.inputId, qualityBasis.inputId].sort());
    for (const entry of executionInputs) {
      const bytes = await fs.readFile(path.join(plane, entry.location));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.hash);
    }
    for (const forged of [{ ...qualityBasis, sha256: 'b'.repeat(64) }, { ...qualityBasis, table: 'virtual-patients' }, { ...qualityBasis, location: '/etc/passwd' }]) {
      await assert.rejects(request(`${prefix}/jobs`, 'POST', { kind: 'population_quality', subjectId: population.id, scenario: qualityScenario, inputs: qualityInputs, qualityBasis: forged }));
    }
    await assert.rejects(request(`${prefix}/jobs`, 'POST', { kind: 'population_quality', subjectId: population.id, scenario: qualityScenario, inputs: [{ kind: 'snapshot_file', id: training.id, location: '/etc/passwd' }], qualityBasis }));
    await assert.rejects(request(`${prefix}/jobs`, 'POST', { kind: 'population_quality', subjectId: population.id, scenario: { ...qualityScenario, syntheticInputId: trainingInput.inputId }, inputs: qualityInputs, qualityBasis }), { code: 'vcr_derived_table_missing' });
    await assert.rejects(request(`${prefix}/jobs`, 'POST', { kind: 'generate_population', subjectId: population.id, scenario, inputs: [], qualityBasis }), { code: 'vcr_job_scenario_invalid' });
    const otherStudy = await composed.store.createStudy({ userId: user.id, projectId: 'quality-foreign-study', purpose: 'calculation' });
    await assert.rejects(request(`/api/vcr/studies/${otherStudy.id}/jobs`, 'POST', { kind: 'population_quality', subjectId: population.id, scenario: qualityScenario, inputs: qualityInputs, qualityBasis }), { code: 'vcr_simulate_subject_unknown' });
    const otherPopulation = await composed.store.savePopulation({ studyId: otherStudy.id, userId: user.id, name: 'Foreign population', kind: 'scenario', definition: scenario });
    await assert.rejects(request(`${prefix}/jobs`, 'POST', { kind: 'population_quality', subjectId: population.id, scenario: qualityScenario, inputs: qualityInputs,
      qualityBasis: { ...qualityBasis, populationId: otherPopulation.id } }), { code: 'vcr_job_scenario_invalid' });

    const historicalGeneration = await request(`${prefix}/jobs/${generation.id}/result`);
    const nextGeneration = await request(`${prefix}/jobs`, 'POST', { kind: 'generate_population', subjectId: population.id, scenario, inputs: [], seed: 999 });
    [claimed] = await composed.jobs.claim();
    await composed.jobs.advance(claimed);
    // A valid selection can become stale after the INSERT but before the transaction's locked recheck.
    const transactionBeforeStale = composed.store.transaction.bind(composed.store);
    let insertedReady, releaseInsert;
    const insertedPaused = new Promise(resolve => { insertedReady = resolve; });
    const insertGate = new Promise(resolve => { releaseInsert = resolve; });
    let rolledBackId;
    composed.store.transaction = operation => transactionBeforeStale(client => operation({ async query(sql, values) {
      const result = await client.query(sql, values);
      if (/INSERT INTO evimed_vcr\.jobs/.test(sql) && values[3] === 'population_quality' && values[10] === 988) {
        rolledBackId = result.rows[0].id; insertedReady(); await insertGate;
      }
      return result;
    } }));
    const staleEnqueue = request(`${prefix}/jobs`, 'POST', { kind: 'population_quality', subjectId: population.id,
      scenario: qualityScenario, inputs: qualityInputs, qualityBasis, seed: 988 });
    try {
      await insertedPaused;
      assert.equal(await composed.store.job(study.id, rolledBackId), null, 'a newly inserted job remains invisible before its current-generation recheck');
      await composed.jobs.advance(claimed);
      releaseInsert();
      await assert.rejects(staleEnqueue, { code: 'vcr_derived_table_missing' });
    } finally {
      releaseInsert();
      await Promise.allSettled([staleEnqueue]);
      composed.store.transaction = transactionBeforeStale;
    }
    assert.equal(await composed.store.job(study.id, rolledBackId), null, 'the stale-generation refusal rolls the entire inserted job back');
    assert.equal(Number((await database.query('SELECT count(*) AS n FROM evimed_vcr.audit WHERE object=$1', [rolledBackId])).rows[0].n), 0);
    const regenerated = await composed.store.latestPopulation(study.id);
    const regeneratedResult = await composed.store.result(study.id, regenerated.resultId);
    assert.notEqual(regeneratedResult.tables[0].sha256, originalResult.tables[0].sha256);
    assert.deepEqual(regenerated.quality, {}, 'a new generation invalidates the prior generation quality attachment');
    assert.deepEqual(await request(`${prefix}/jobs/${generation.id}/result`), historicalGeneration);
    assert.deepEqual(await request(`${prefix}/jobs/${queued.id}/result`), assessment);

    // Pause a real engine completion after its quality basis is locked, then complete another generation concurrently.
    assert.equal((await composed.jobs.configuration(study.id, queued.id)).qualityBasisAvailable, false);
    await assert.rejects(request(`${prefix}/jobs`, 'POST', { kind: 'population_quality', subjectId: population.id, scenario: qualityScenario, inputs: qualityInputs, qualityBasis }), { code: 'vcr_derived_table_missing' });
    qualityBasis = (await composed.service.tab(user, study.id, 'population')).versions.find(row => row.id === population.id).generationInput;
    qualityScenario = { ...qualityScenario, syntheticInputId: qualityBasis.inputId };
    const qualityRace = await request(`${prefix}/jobs`, 'POST', { kind: 'population_quality', subjectId: population.id, scenario: qualityScenario, inputs: qualityInputs, qualityBasis, seed: 991 });
    const generationRace = await request(`${prefix}/jobs`, 'POST', { kind: 'generate_population', subjectId: population.id, scenario, inputs: [], seed: 992 });
    const concurrencyBefore = composed.jobs.config.vcrMaxConcurrentJobs;
    composed.jobs.config.vcrMaxConcurrentJobs = 2;
    const racing = await composed.jobs.claim({ limit: 2 });
    const qualityClaim = racing.find(job => job.id === qualityRace.id);
    const generationClaim = racing.find(job => job.id === generationRace.id);
    assert.ok(qualityClaim && generationClaim);
    await composed.jobs.advance(qualityClaim); await composed.jobs.advance(generationClaim);
    let locked, release, updating;
    const qualityLocked = new Promise(resolve => { locked = resolve; });
    const releaseQuality = new Promise(resolve => { release = resolve; });
    const generationUpdating = new Promise(resolve => { updating = resolve; });
    const recordResult = composed.store.recordResult.bind(composed.store);
    let qualityPid, generationPid;
    composed.store.recordResult = async (input, options_) => {
      const client = options_.client;
      const pid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      if (input.kind === 'population_quality') qualityPid = pid; else if (input.kind === 'population') generationPid = pid;
      return recordResult(input, { client: { async query(sql, values) {
        if (input.kind === 'population' && /UPDATE evimed_vcr\.populations SET result_id/.test(sql)) updating();
        const result = await client.query(sql, values);
        if (input.kind === 'population_quality' && /SELECT p\.result_id/.test(sql)) { locked(); await releaseQuality; }
        return result;
      } } });
    };
    const finishingQuality = composed.jobs.advance(qualityClaim);
    let finishingGeneration;
    try {
      await qualityLocked;
      finishingGeneration = composed.jobs.advance(generationClaim);
      await generationUpdating;
      let blockers = [];
      for (let attempt = 0; attempt < 40; attempt++) {
        blockers = (await composed.store.query('SELECT pg_blocking_pids($1) AS blockers', [generationPid])).rows[0].blockers;
        if (blockers.includes(qualityPid)) break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.ok(blockers.includes(qualityPid), 'PostgreSQL confirms generation waits on the quality transaction population-row lock');
    } finally {
      release();
      await finishingQuality;
      if (finishingGeneration) await finishingGeneration;
      composed.store.recordResult = recordResult;
      composed.jobs.config.vcrMaxConcurrentJobs = concurrencyBefore;
    }
    const raced = await composed.store.latestPopulation(study.id);
    assert.deepEqual(raced.quality, {}, 'the generation committing after quality invalidates the obsolete attachment atomically');
    assert.equal(raced.resultId, (await request(`${prefix}/jobs/${generationRace.id}/result`)).result.id);
    assert.equal((await request(`${prefix}/jobs/${qualityRace.id}/result`)).result.kind, 'population_quality');
    assert.deepEqual(await request(`${prefix}/jobs/${generation.id}/result`), historicalGeneration);
    assert.deepEqual(await request(`${prefix}/jobs/${queued.id}/result`), assessment);
    assert.equal((await request(`${prefix}/jobs/${nextGeneration.id}/result`)).result.id, regeneratedResult.id);

    // Identical bytes from a later generation still have a different identity, on the public and internal paths.
    for (const mode of ["public", "internal", "legacy-derived"]) {
      const internal = mode !== "public";
      qualityBasis = (await composed.service.tab(user, study.id, 'population')).versions.find(row => row.id === population.id).generationInput;
      qualityScenario = { ...qualityScenario, syntheticInputId: qualityBasis.inputId };
      const oldBasis = qualityBasis;
      const waitingQuality = internal ? (await composed.jobs.enqueue({ studyId: study.id, userId: user.id, kind: 'population_quality',
        scenario: qualityScenario, inputs: qualityInputs, internal: true, derived: [{ resultId: qualityBasis.resultId, table: qualityBasis.table }],
        detail: { subjectId: population.id }, seed: mode === 'legacy-derived' ? 2005 : 2003 })).job
        : await request(`${prefix}/jobs`, 'POST', { kind: 'population_quality', subjectId: population.id, scenario: qualityScenario, inputs: qualityInputs, qualityBasis, seed: 2001 });
      const identicalGeneration = await request(`${prefix}/jobs`, 'POST', { kind: 'generate_population', subjectId: population.id, scenario, inputs: [], seed: mode === 'legacy-derived' ? 2006 : internal ? 2004 : 2002 });
      composed.jobs.config.vcrMaxConcurrentJobs = 2;
      try {
        const both = await composed.jobs.claim({ limit: 2 });
        const newer = both.find(job => job.id === identicalGeneration.id);
        const waiting = both.find(job => job.id === waitingQuality.id);
        if (mode === 'legacy-derived') await database.query("UPDATE evimed_vcr.jobs SET checkpoint=checkpoint-'qualityAttachmentResultId' WHERE id=$1", [waitingQuality.id]);
        await composed.jobs.advance(newer); await composed.jobs.advance(newer);
        const newBasis = (await composed.service.tab(user, study.id, 'population')).versions.find(row => row.id === population.id).generationInput;
        assert.equal(newBasis.sha256, oldBasis.sha256);
        assert.notEqual(newBasis.resultId, oldBasis.resultId);
        await composed.jobs.advance(waiting); await composed.jobs.advance(waiting);
        const independent = await request(`${prefix}/jobs/${waitingQuality.id}/result`);
        assert.equal(independent.result.kind, 'population_quality');
        assert.deepEqual(independent.result.diagnostics.qualityAttachment, { attached: false, sourceResultId: oldBasis.resultId, reason: 'generation_changed' });
        assert.deepEqual((await composed.store.latestPopulation(study.id)).quality, {});
        assert.deepEqual((await composed.jobs.configuration(study.id, waitingQuality.id)).qualityBasis, oldBasis);
        assert.equal((await composed.jobs.configuration(study.id, waitingQuality.id)).qualityBasisAvailable, false);
      } finally { composed.jobs.config.vcrMaxConcurrentJobs = concurrencyBefore; }
    }



  }
});


test('quality input options use real raw aliases and frozen file order, and respect seals and source grants', options, async () => {
  const created = await request('/api/vcr/studies', 'POST', { name: 'Raw inputs', purpose: 'calculation' });
  const study = await composed.store.studyById(created.id);
  const dataPlane = composed.dataPlane;
  const source = await dataPlane.registerSource({ userId: user.id, studyId: study.id, name: 'Raw training', ownerParty: 'Research team', allowedUses: ['vcr'] });
  await dataPlane.storeUpload({ actor: user.id, studyId: study.id, sourceId: source.id, name: 'raw.csv', stream: Readable.from(['年龄,col_1\n60,10\n70,12\n80,13\n']) });
  const proposed = await dataPlane.proposeFieldMap({ actor: user.id, studyId: study.id, sourceId: source.id, columns: [
    { table: 'raw.csv', column: '年龄', role: 'other', concept: 'age' },
    { table: 'raw.csv', column: 'col_1', role: 'other', concept: 'measurement' },
  ] });
  await dataPlane.confirmFieldMap({ actor: user.id, studyId: study.id, sourceId: source.id, hash: proposed.hash });
  const { snapshot } = await dataPlane.freezeSnapshot({ userId: user.id, studyId: study.id, sourceId: source.id });
  const visible = async () => (await composed.service.tab(user, study.id, 'data')).intake.snapshots.find(row => row.id === snapshot.id).qualityInputs;
  const [option] = await visible();
  assert.equal(option.kind, 'snapshot_file');
  assert.equal(option.inputId, `${snapshot.id}:1`);
  assert.deepEqual(option.columns, ['col_1', 'col_1_2']);
  assert.deepEqual(option.columnLabels, { col_1: '年龄', col_1_2: 'col_1' });
  const resolved = await dataPlane.resolveEngineInputs({ studyId: study.id, snapshotId: snapshot.id, principal: user.id, method: 'population.quality', purpose: 'vcr' });
  assert.equal(resolved[0].id, option.inputId);
  const header = (await fs.readFile(path.join(plane, resolved[0].location), 'utf8')).split('\n')[0].split(',');
  assert.ok(option.columns.every(column => header.includes(column)));
  await database.query("UPDATE evimed_vcr.studies SET intended_use='specified_analysis' WHERE id=$1", [study.id]);
  await dataPlane.store.sealStudySnapshots({ studyId: study.id, snapshotIds: [snapshot.id], fields: ['年龄', 'col_1'], actor: user.id });
  assert.deepEqual(await visible(), []);
  await assert.rejects(dataPlane.resolveEngineInputs({ studyId: study.id, snapshotId: snapshot.id, principal: user.id, method: 'population.quality', purpose: 'vcr' }));
  await database.query("UPDATE evimed_vcr.studies SET intended_use='exploratory' WHERE id=$1", [study.id]);
  await dataPlane.store.liftStudySeal({ studyId: study.id, at: new Date().toISOString(), actor: user.id });
  await database.query('UPDATE evimed_vcr.sources SET user_id=$1 WHERE id=$2', ['partner-owner', source.id]);
  assert.deepEqual(await visible(), []);
  await assert.rejects(dataPlane.resolveEngineInputs({ studyId: study.id, snapshotId: snapshot.id, principal: user.id, method: 'population.quality', purpose: 'vcr' }));
  const grant = await dataPlane.store.createGrant({ sourceId: source.id, studyId: study.id, userId: 'partner-owner', grantee: user.id,
    fields: ['年龄'], fieldMode: 'allow', purposes: ['vcr'], actor: 'partner-owner' });
  assert.deepEqual((await visible())[0].columns, ['col_1']);
  assert.deepEqual((await visible())[0].columnLabels, { col_1: '年龄' });
  await dataPlane.store.revokeGrant({ grantId: grant.id, studyId: study.id, actor: 'partner-owner' });
  assert.deepEqual(await visible(), []);
  const other = await composed.store.createStudy({ userId: user.id, projectId: 'other-raw-study', purpose: 'calculation' });
  await assert.rejects(dataPlane.resolveEngineInputs({ studyId: other.id, snapshotId: snapshot.id, principal: user.id, method: 'population.quality', purpose: 'vcr' }), { code: 'vcr_snapshot_not_found' });
});


test('owned curve reconstruction prepares, queues and reopens the exact comparator binding with real preserved files', options, async () => {
  const study = await composed.store.createStudy({ userId: user.id, projectId: 'reconstruction-binding', name: 'Curve comparator', dataTier: 'T2', intendedUse: 'exploratory' });
  const prefix = `/api/vcr/studies/${study.id}`;
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/L1sAAAAASUVORK5CYII=', 'base64');
  await fs.writeFile(path.join(plane, 'curve.png'), image);
  const curves = createVcrCurveEvidence({ store: new VcrEvidenceStore({ database }), studyStore: composed.store,
    access: composed.access, resolveProject: async () => ({ workspaceDir: plane }) });
  const previousVerifier = composed.jobs.curveVerifier;
  composed.jobs.curveVerifier = curves.curveVerifier;
  const receipt = await curves.recordSelection({ studyId: study.id, principal: user.id, imageArtifactId: 'curve.png',
    points: { curve: [{ time: 0, surv: 1 }, { time: 12, surv: .5 }], riskTable: [{ time: 0, atRisk: 100 }, { time: 12, atRisk: 50 }] } });
  const csv = 'time,status,arm\n1,1,0\n12,0,0\n';
  const hash = createHash('sha256').update(csv).digest('hex');
  const transport = engine();
  const baseResult = transport.result.bind(transport);
  transport.result = async id => {
    const answer = await baseResult(id);
    answer.result.counts = { realPatients: 0, reconstructedPseudoPatients: 2 };
    answer.result.tables = [{ name: 'reconstructed-ipd', sha256: hash, rows: 2 }];
    answer.result.manifest.outputHash = vcrComputedOutputHash(answer.result);
    return answer;
  };
  transport.downloadTable = async (_id, _name, target) => { await fs.writeFile(target.destination, csv, { mode: target.mode }); };
  composed.jobs.engine = transport;
  try {
    const reconstructed = await composed.jobs.enqueue({ studyId: study.id, userId: user.id, kind: 'reconstruct_km', scenario: { provenance: { receiptId: receipt.id } } });
    const [claim] = await composed.jobs.claim();
    await composed.jobs.advance(claim); await composed.jobs.advance(claim);
    assert.equal((await composed.jobs.get(study.id, reconstructed.job.id)).state, 'succeeded');
    const result = (await composed.jobs.resultOf(study.id, reconstructed.job.id));
    assert.ok(result);
    await database.query(`INSERT INTO evimed_vcr.results(id,study_id,user_id,kind,created_at)
      SELECT 'unrelated_' || n, $1, $2, 'patient_set', now()+interval '1 second' FROM generate_series(1,501) n`, [study.id, user.id]);
    const choices = (await request(`${prefix}/jobs`)).reconstructionResults;
    assert.deepEqual({ resultId: choices[0].resultId, version: choices[0].version, method: choices[0].method, table: choices[0].table },
      { resultId: result.id, version: result.version, method: 'evidence.reconstruct_km', table: 'reconstructed-ipd' });
    assert.deepEqual(choices[0].source, { kind: 'curve_image', origin: receipt.origin });
    assert.doesNotMatch(JSON.stringify(choices), /location|sha256|derived\//);
    const source = await composed.dataPlane.registerSource({ userId: user.id, studyId: study.id, name: 'Treatment cohort', ownerParty: 'Research team', allowedUses: ['vcr'] });
    await composed.dataPlane.storeUpload({ actor: user.id, studyId: study.id, sourceId: source.id, name: 'cohort.csv', stream: Readable.from([cohortCsv()]) });
    const proposed = await composed.dataPlane.proposeFieldMap({ actor: user.id, studyId: study.id, sourceId: source.id, columns: FIELD_MAP.filter(column => column.table === 'cohort.csv') });
    await composed.dataPlane.confirmFieldMap({ actor: user.id, studyId: study.id, sourceId: source.id, hash: proposed.hash });
    const { snapshot } = await composed.dataPlane.freezeSnapshot({ userId: user.id, studyId: study.id, sourceId: source.id });
    const scenario = { covariates: ['age'], targets: { age: 60 }, endpoint: { type: 'time_to_event' }, timeUnit: 'months' };
    const prepare = { method: 'comparator.maic_time_to_event', name: 'Reconstructed comparator', scenario, reconstructionResultId: result.id };
    const prepared = await request(`${prefix}/method-configurations`, 'POST', prepare);
    assert.equal(prepared.reconstructionResultId, result.id);
    assert.deepEqual(prepared.scenario, scenario);
    assert.deepEqual(await request(`${prefix}/method-configurations`, 'POST', { ...prepare, subjectId: prepared.subjectId }), prepared);
    const payload = { kind: 'maic_time_to_event_comparator', subjectId: prepared.subjectId, scenario, reconstructionResultId: result.id, inputs: [{ kind: 'snapshot', id: snapshot.id }] };
    const queued = await request(`${prefix}/jobs`, 'POST', payload);
    assert.equal((await request(`${prefix}/jobs`, 'POST', payload)).id, queued.id);
    const original = await composed.store.one("SELECT scenario, inputs FROM evimed_vcr.jobs WHERE study_id=$1 AND id=$2", [study.id, queued.id]);
    assert.equal(original.scenario.pseudoIpdInputId, `${result.id}:reconstructed-ipd`);
    assert.equal(original.inputs.find(input => input.valueSource === 'reconstructed').hash, hash);
    const history = await request(`${prefix}/jobs/${queued.id}/configuration`);
    assert.equal(history.reconstructionResultId, result.id);
    assert.equal(history.reconstructionResultAvailable, true);
    assert.deepEqual(history.scenario, scenario);
    await database.query("UPDATE evimed_vcr.jobs SET checkpoint=checkpoint-'reconstructionResultId' WHERE id=$1", [queued.id]);
    assert.equal((await request(`${prefix}/jobs/${queued.id}/configuration`)).reconstructionResultId, result.id, 'legacy history recovers only the exact frozen reconstructed input');
    await assert.rejects(request(`${prefix}/jobs`, 'POST', { ...payload, scenario: { ...scenario, pseudoIpdInputId: 'forged' } }), { code: 'vcr_job_scenario_invalid' });
    await assert.rejects(request(`${prefix}/jobs`, 'POST', { ...payload, derived: [] }), { code: 'vcr_payload_invalid' });
    const foreign = await composed.store.createStudy({ userId: user.id, projectId: 'other-reconstruction', name: 'Other' });
    await assert.rejects(request(`/api/vcr/studies/${foreign.id}/method-configurations`, 'POST', prepare), { code: 'vcr_derived_table_missing' });
    await assert.rejects(request(`${prefix}/method-configurations`, 'POST', { ...prepare, reconstructionResultId: snapshot.id }), { code: 'vcr_derived_table_missing' });
    await assert.rejects(request(`${prefix}/method-configurations`, 'POST', { ...prepare, method: 'patients.binary', scenario: binary() }), { code: 'vcr_job_scenario_invalid' });
    await assert.rejects(request(`${prefix}/method-configurations`, 'POST', { ...prepare, scenario: { ...scenario, pseudoIpdInputId: 'caller-selected' } }), { code: 'vcr_job_scenario_invalid' });
    await assert.rejects(request(`${prefix}/jobs`, 'POST', { ...payload, reconstructionResultId: undefined }), { code: 'vcr_job_scenario_invalid' });
    const foreignSource = await composed.dataPlane.registerSource({ userId: user.id, studyId: foreign.id, name: 'Other cohort', ownerParty: 'Research team', allowedUses: ['vcr'] });
    await composed.dataPlane.storeUpload({ actor: user.id, studyId: foreign.id, sourceId: foreignSource.id, name: 'cohort.csv', stream: Readable.from([cohortCsv()]) });
    const foreignMap = await composed.dataPlane.proposeFieldMap({ actor: user.id, studyId: foreign.id, sourceId: foreignSource.id, columns: FIELD_MAP.filter(column => column.table === 'cohort.csv') });
    await composed.dataPlane.confirmFieldMap({ actor: user.id, studyId: foreign.id, sourceId: foreignSource.id, hash: foreignMap.hash });
    const foreignFrozen = await composed.dataPlane.freezeSnapshot({ userId: user.id, studyId: foreign.id, sourceId: foreignSource.id });
    await assert.rejects(request(`${prefix}/jobs`, 'POST', { ...payload, inputs: [{ kind: 'snapshot', id: foreignFrozen.snapshot.id }] }));
    await database.query("UPDATE evimed_vcr.results SET tables='[]'::jsonb WHERE id=$1", [result.id]);
    await assert.rejects(request(`${prefix}/jobs`, 'POST', payload), { code: 'vcr_derived_table_missing' });
    await database.query('UPDATE evimed_vcr.results SET tables=$2::jsonb WHERE id=$1', [result.id, JSON.stringify(result.tables)]);
    const retained = result.tables.find(table => table.name === 'reconstructed-ipd');
    await fs.appendFile(path.join(plane, retained.location), 'changed');
    await assert.rejects(request(`${prefix}/jobs`, 'POST', payload), { code: 'vcr_derived_table_missing' });
    assert.equal((await request(`${prefix}/jobs/${queued.id}/configuration`)).reconstructionResultAvailable, false);
    await fs.writeFile(path.join(plane, retained.location), csv);
    await database.query("UPDATE evimed_vcr.executions SET method='patients.binary' WHERE id=$1", [result.executionId]);
    await assert.rejects(request(`${prefix}/jobs`, 'POST', payload), { code: 'vcr_derived_table_unsupported' });
    await database.query("UPDATE evimed_vcr.executions SET method='evidence.reconstruct_km',receipt='{}'::jsonb WHERE id=$1", [result.executionId]);
    await assert.rejects(request(`${prefix}/jobs`, 'POST', payload), { code: 'vcr_curve_provenance_unavailable' });
    const anchored = await request(`${prefix}/method-configurations`, 'POST', { method: prepare.method, name: 'Published anchored comparator',
      scenario: { ...scenario, anchored: true, aggregateEstimate: .1, aggregateSe: .2 } });
    assert.ok(anchored.subjectId);
    assert.equal(anchored.reconstructionResultId, undefined);
    const anchoredQueued = await request(`${prefix}/jobs`, 'POST', { ...payload, subjectId: anchored.subjectId, reconstructionResultId: undefined,
      scenario: { ...scenario, anchored: true, aggregateEstimate: .1, aggregateSe: .2 } });
    assert.ok(anchoredQueued.id);
    await database.query("UPDATE evimed_vcr.executions SET receipt='{\"signed\":true}'::jsonb WHERE id=$1", [result.executionId]);
    await database.query('DELETE FROM evimed_vcr.curve_extractions WHERE id=$1', [receipt.id]);
    await assert.rejects(request(`${prefix}/jobs`, 'POST', payload), { code: 'vcr_curve_provenance_unavailable' });
  } finally { composed.jobs.curveVerifier = previousVerifier; }
});


test('the UI fixture owns a genuine calculation and two immutable synthetic job/configuration/result histories', options, async () => {
  const fixture = await furnishCalculation({ vcr: composed, store: { createProject: async () => ({ id: 'synthetic-ui-calculation-fixture' }) } }, user);
  const study = await composed.store.studyById(fixture.studyId);
  assert.equal(study.purpose, 'calculation');
  assert.equal((await request(`/api/vcr/studies/${study.id}`)).purpose, 'calculation');
  assert.equal(fixture.jobs.length, 2);
  const histories = await request(`/api/vcr/studies/${study.id}/jobs`);
  assert.equal(histories.jobs.length, 2);
  const frozen = [];
  for (let index = 0; index < 2; index++) {
    const base = `/api/vcr/studies/${study.id}/jobs/${fixture.jobs[index]}`;
    const configuration = await request(`${base}/configuration`);
    const result = await request(`${base}/result`);
    frozen.push(configuration);
    assert.equal(configuration.subjectId, fixture.configurations[index]);
    assert.equal(configuration.scenario.truth.treatmentRate, [0.6, 0.7][index]);
    assert.equal(result.result.id, fixture.results[index]);
    assert.equal(result.result.diagnostics.syntheticUiFixture, true);
    assert.equal(result.result.diagnostics.engineExecuted, false);
    assert.equal(histories.jobs.find(job => job.id === fixture.jobs[index]).state, 'succeeded');
  }
  assert.deepEqual(await request(`/api/vcr/studies/${study.id}/jobs/${fixture.jobs[0]}/configuration`), frozen[0]);
  assert.deepEqual((await composed.store.patientSets(study.id)).map(row => row.version), [2, 1]);
  await assert.rejects(request(`/api/vcr/studies/${study.id}`, 'GET', null, { id: 'foreign-ui-reader' }), { code: 'vcr_study_not_found', status: 404 });
  await assert.rejects(request('/api/vcr/studies/study-that-does-not-exist'), { code: 'vcr_study_not_found', status: 404 });
});
