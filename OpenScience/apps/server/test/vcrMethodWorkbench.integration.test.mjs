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
  const qualityScenario = { trainingInputId: 'quality_training:subject', syntheticInputId: 'quality_synthetic:subject' };
  await assert.rejects(request(`${prefix}/method-configurations`, 'POST', { method: 'population.quality', name: 'Quality', scenario: qualityScenario }), { code: 'vcr_simulate_subject_required' });
  const prepared = await request(`${prefix}/method-configurations`, 'POST', { method: 'population.quality', name: 'Quality', subjectId: population.id, scenario: qualityScenario });
  assert.equal(prepared.subjectId, population.id);
  assert.deepEqual(await composed.store.latestPopulation(study.id), original, 'preparing a quality check does not revise the population');
  const oldPlane = composed.jobs.dataPlane;
  let syntheticHash = originalResult.tables[0].sha256;
  composed.jobs.dataPlane = { async resolveEngineInputs() { return [
    { kind: 'analysis_table', id: 'quality_training:subject', shape: 'subject', location: 'snapshots/quality_training/subject.csv', hash: 'a'.repeat(64), valueSource: 'observed' },
    { kind: 'analysis_table', id: 'quality_synthetic:subject', shape: 'subject', location: 'snapshots/quality_synthetic/subject.csv', hash: syntheticHash, valueSource: 'synthetic' },
  ]; } };
  try {
    const queued = await request(`${prefix}/jobs`, 'POST', { kind: 'population_quality', subjectId: population.id, scenario: qualityScenario, inputs: [{ kind: 'snapshot', id: 'quality_training' }] });
    [claimed] = await composed.jobs.claim();
    await composed.jobs.advance(claimed); await composed.jobs.advance(claimed);
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
    syntheticHash = 'b'.repeat(64);
    const differentData = await request(`${prefix}/jobs`, 'POST', { kind: 'population_quality', subjectId: population.id, scenario: qualityScenario, inputs: [{ kind: 'snapshot', id: 'quality_training' }], seed: 987 });
    [claimed] = await composed.jobs.claim();
    await composed.jobs.advance(claimed); await composed.jobs.advance(claimed);
    assert.notEqual((await request(`${prefix}/jobs/${differentData.id}/result`)).result.id, assessment.result.id);
    assert.deepEqual((await composed.store.latestPopulation(study.id)).quality, quality, 'an assessment of a different input hash cannot replace this population attachment');
    const historicalGeneration = await request(`${prefix}/jobs/${generation.id}/result`);
    const nextGeneration = await request(`${prefix}/jobs`, 'POST', { kind: 'generate_population', subjectId: population.id, scenario, inputs: [], seed: 999 });
    [claimed] = await composed.jobs.claim();
    await composed.jobs.advance(claimed); await composed.jobs.advance(claimed);
    const regenerated = await composed.store.latestPopulation(study.id);
    const regeneratedResult = await composed.store.result(study.id, regenerated.resultId);
    assert.notEqual(regeneratedResult.tables[0].sha256, originalResult.tables[0].sha256);
    assert.deepEqual(regenerated.quality, {}, 'a new generation invalidates the prior generation quality attachment');
    assert.deepEqual(await request(`${prefix}/jobs/${generation.id}/result`), historicalGeneration);
    assert.deepEqual(await request(`${prefix}/jobs/${queued.id}/result`), assessment);

    // Pause a real engine completion after its quality basis is locked, then complete another generation concurrently.
    syntheticHash = regeneratedResult.tables[0].sha256;
    const qualityRace = await request(`${prefix}/jobs`, 'POST', { kind: 'population_quality', subjectId: population.id, scenario: qualityScenario, inputs: [{ kind: 'snapshot', id: 'quality_training' }], seed: 991 });
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


  } finally { composed.jobs.dataPlane = oldPlane; }
});
