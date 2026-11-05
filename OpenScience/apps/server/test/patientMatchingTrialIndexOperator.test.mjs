import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { UsageLedger } from '../src/usageLedger.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { parseTrialIndexArguments, createTrialIndexBudgetLedger, runTrialIndexBuild, redactOperatorDatabaseErrors, createTrialIndexPacer } from '../../../deploy/patient-matching/build-trial-index.mjs';

const digest = `sha256:${'a'.repeat(64)}`;
const script = fileURLToPath(new URL('../../../deploy/patient-matching/build-trial-index.mjs', import.meta.url));

async function fixture(t, { expected = 2001 } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'matching-index-operator-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const manifestPath = path.join(directory, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify({ collectionId: 'public-test', recordsPath: '/protected/public.ndjson', recordsSha256: 'b'.repeat(64), expectedRecords: expected }), { mode: 0o600 });
  const rows = [], envelopes = [], events = [];
  let permitted = true, serial = Promise.resolve(), paid = 0;
  const database = {
    async query(sql, parameters = []) {
      if (sql.includes('FROM evimed_control.projects')) {
        assert.deepEqual(parameters, ['owner', 'project']);
        return { rows: permitted ? [{ id: 'project' }] : [] };
      }
      if (sql.includes('pg_advisory_xact_lock')) { events.push('lock'); return { rows: [] }; }
      if (sql.includes('AS committed')) {
        return { rows: [{ committed: rows.filter(row => row.userId === parameters[0] && row.projectId === parameters[1] && row.taskId === parameters[2])
          .reduce((sum, row) => sum + (row.status === 'released' ? 0 : row.status === 'settled' ? row.actualCost : row.estimatedCost), 0) }] };
      }
      throw new Error('Unexpected query');
    },
    transaction(work) { const pending = serial.then(() => work(database)); serial = pending.catch(() => {}); return pending; },
    withTransactionClient: (_client, work) => work(),
  };
  const ledger = {
    async health() { events.push('ledger'); },
    async reserveModel(input) { events.push('reserve'); rows.push({ ...input, status: 'reserved' }); return { id: input.id }; },
    async settleModel(userId, id, input) { const row = rows.find(value => value.userId === userId && value.id === id); Object.assign(row, { status: 'settled', actualCost: input.actualCost }); },
    async release(userId, id) { rows.find(row => row.userId === userId && row.id === id).status = 'released'; },
    async markUncertain(userId, id) { rows.find(row => row.userId === userId && row.id === id).status = 'uncertain'; },
  };
  const createModels = ({ config, usageLedger, authorize }) => {
    assert.equal(config.requireDurableUsageLedger, true);
    assert.equal(config.patientMatchingProfile.reasoningModel, 'deepseek-flash');
    assert.equal(config.patientMatchingProfile.proEscalation, false);
    assert.equal(config.patientMatchingProfile.embeddingDimensions, 1024);
    return { dimensions: 1024, embeddingProfileDigest: digest, async embed(envelope) {
      await authorize(envelope, { operation: 'embedding', destination: new URL(config.patientMatchingProfile.embeddingApiBase).origin });
      const reserved = await usageLedger.reserveModel({ id: `call-${rows.length}`, userId: 'owner', projectId: 'project', taskId: envelope.input.taskId,
        module: 'patient-matching', purpose: 'kernel', operation: 'patient-matching-embedding', currency: 'CNY', estimatedCost: 1 });
      paid++;
      await usageLedger.settleModel('owner', reserved.id, { actualCost: 1 });
      return { status: 'complete' };
    } };
  };
  const createResource = async ({ models, authorize }) => ({ async build(envelope) {
    envelopes.push(envelope);
    await authorize(envelope);
    try { await models.embed({ ...envelope, input: { ...envelope.input, texts: ['Public trial projection'] } }); }
    catch { return { status: 'unsupported', data: { code: 'provider-body-or-private-key-must-not-escape' } }; }
    const indexed = Math.min(envelope.input.offset + 1000, expected), state = indexed === expected ? 'ready' : 'building';
    return { status: state === 'ready' ? 'complete' : 'partial', data: { indexed, expected, state, generation: digest, dimensions: 1024, embeddingProfileDigest: digest } };
  } });
  return { options: { database, ledger, manifestPath, actorId: 'owner', projectId: 'project' }, createModels, createResource, rows, envelopes, events,
    paid: () => paid, deny: () => { permitted = false; } };
}

test('operator help opens no database and argument selection is explicit and bounded', () => {
  const result = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0); assert.match(result.stdout, /default: 10/); assert.equal(result.stderr, '');
  const required = ['--manifest', '/manifest', '--postgres-config', '/postgres', '--provider-config', '/provider', '--actor-id', 'owner', '--project-id', 'project'];
  assert.equal(parseTrialIndexArguments(required).maxCostCny, 10);
  assert.equal(parseTrialIndexArguments([...required, '--account-max-cost-cny', '500']).accountMaxCostCny, 500);
  for (const extra of [['--max-cost-cny', '0'], ['--max-cost-cny', 'NaN'], ['--max-cost-cny', '1e300'], ['--offset', '-1'], ['--unknown', 'secret'], ['--actor-id', 'other']]) {
    assert.throws(() => parseTrialIndexArguments([...required, ...extra]), { code: 'trial_index_arguments_invalid' });
  }
});

test('build uses privileged chunks of 1000 and the pinned Flash/1024 profile, without patient input', async t => {
  const f = await fixture(t), progress = [];
  const result = await runTrialIndexBuild({ ...f.options, onProgress: value => progress.push(value) }, f);
  assert.equal(result.status, 'complete'); assert.equal(result.indexed, 2001); assert.equal(result.committedCny, 3);
  assert.deepEqual(f.envelopes.map(envelope => envelope.input.offset), [0, 1000, 2000]);
  for (const envelope of f.envelopes) {
    assert.equal(envelope.operatorBuild, true);
    assert.deepEqual(envelope.scope, { tenantId: 'owner', actorId: 'owner', projectId: 'project' });
    assert.deepEqual(Object.keys(envelope.input).sort(), ['offset', 'taskId']);
  }
  assert.equal(progress.length, 3); assert.equal(f.paid(), 3);
});

test('budget stop is before the next dispatch, survives resume and keeps original resource attribution', async t => {
  const f = await fixture(t);
  const first = await runTrialIndexBuild({ ...f.options, maxCostCny: 1 }, f);
  assert.equal(first.status, 'stopped'); assert.equal(first.code, 'trial_index_budget_exhausted');
  assert.equal(first.offset, 1000); assert.equal(first.indexed, 1000); assert.equal(f.paid(), 1);
  const resumed = await runTrialIndexBuild({ ...f.options, maxCostCny: 1, offset: 1000 }, f);
  assert.equal(resumed.taskId, first.taskId); assert.equal(resumed.code, 'trial_index_budget_exhausted'); assert.equal(f.paid(), 1);
  const continued = await runTrialIndexBuild({ ...f.options, maxCostCny: 3, offset: 1000 }, f);
  assert.equal(continued.status, 'complete'); assert.equal(continued.committedCny, 3); assert.equal(f.paid(), 3);
});

test('an unrelated, missing or revoked account/project cannot begin another paid chunk', async t => {
  const f = await fixture(t);
  f.deny();
  await assert.rejects(runTrialIndexBuild(f.options, f), { code: 'trial_index_project_access_denied' });
  assert.equal(f.events.length, 0); assert.equal(f.paid(), 0);
  const g = await fixture(t);
  const stopped = await runTrialIndexBuild({ ...g.options, onProgress: () => g.deny() }, g);
  assert.equal(stopped.status, 'stopped'); assert.equal(g.paid(), 1);
});

test('first unsupported result or interruption stops without retry and reports no raw error payload', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const interrupted = await runTrialIndexBuild({ ...f.options, signal: controller.signal, onProgress: () => controller.abort() }, f);
  assert.equal(interrupted.status, 'interrupted'); assert.equal(f.paid(), 1); assert.equal(interrupted.offset, 1000);
  const stopped = await runTrialIndexBuild(f.options, { createModels: f.createModels, createResource: async () => ({ build: async () => ({ status: 'unsupported', data: { secret: 'RAW_PROVIDER_BODY' } }) }) });
  assert.equal(stopped.code, 'trial_index_build_unsupported'); assert.doesNotMatch(JSON.stringify(stopped), /RAW_PROVIDER_BODY/);
});

test('ledger fence serializes concurrent estimates and rejects foreign attribution', async t => {
  const f = await fixture(t);
  const bounded = createTrialIndexBudgetLedger({ ...f.options, taskId: 'fixed-build', maxCostCny: 1 });
  const input = { id: 'first', userId: 'owner', projectId: 'project', taskId: 'fixed-build', module: 'patient-matching', purpose: 'kernel', operation: 'patient-matching-embedding', currency: 'CNY', estimatedCost: 0.6 };
  const result = await Promise.allSettled([bounded.reserveModel(input), bounded.reserveModel({ ...input, id: 'second' })]);
  assert.deepEqual(result.map(value => value.status), ['fulfilled', 'rejected']);
  assert.equal(bounded.exhausted(), true); assert.equal(f.rows.length, 1); assert.equal(await bounded.committed(), 0.6);
  await assert.rejects(bounded.reserveModel({ ...input, projectId: 'foreign' }), { code: 'trial_index_ledger_scope_invalid' });
  f.rows[0].status = 'uncertain'; assert.equal(await bounded.committed(), 0.6);
  f.rows[0].status = 'released'; assert.equal(await bounded.committed(), 0);
});

test('protected manifest and environment-independent profile fail before paid calls', async t => {
  const f = await fixture(t);
  await fs.chmod(f.options.manifestPath, 0o666);
  await assert.rejects(runTrialIndexBuild(f.options, f), { code: 'trial_index_configuration_invalid' });
  await fs.chmod(f.options.manifestPath, 0o600);
  const link = `${f.options.manifestPath}.link`; await fs.symlink(f.options.manifestPath, link);
  await assert.rejects(runTrialIndexBuild({ ...f.options, manifestPath: link }, f), { code: 'trial_index_configuration_invalid' });
  await assert.rejects(runTrialIndexBuild({ ...f.options, config: { vcrMatchModel: 'deepseek-pro' } }, f), { code: 'patient_matching_flash_required' });
  assert.equal(f.paid(), 0);
});

test('operator database event diagnostics cannot print connection URLs or server error bodies', () => {
  const pool = new EventEmitter(), client = new EventEmitter(), diagnostics = [];
  pool.on('error', error => diagnostics.push(`${error.code} ${error.message}`));
  redactOperatorDatabaseErrors({ pool });
  pool.emit('connect', client);
  client.on('error', error => diagnostics.push(`${error.code} ${error.message}`));
  for (const emitter of [pool, client]) emitter.emit('error', Object.assign(new Error('postgres://secret-user:private-password@host/server-body'), { code: 'RAW_DATABASE_BODY' }));
  assert.deepEqual(diagnostics, Array(2).fill('trial_index_database_unavailable The selected database is unavailable.'));
});

test('shared campaign guard reserves before the durable ledger and releases an undispatched refusal', async t => {
  const f = await fixture(t), events = [];
  const campaignBudget = { reserve: async value => events.push(['reserve-campaign', value]), settle: async value => events.push(['settle-campaign', value]) };
  const input = { id: 'campaign-call', userId: 'owner', projectId: 'project', taskId: 'fixed-build', module: 'patient-matching', purpose: 'kernel', operation: 'patient-matching-embedding', currency: 'CNY', estimatedCost: 0.6 };
  const ledger = { ...f.options.ledger, reserveModel: async () => { events.push(['reserve-ledger']); throw new Error('account cap'); } };
  const bounded = createTrialIndexBudgetLedger({ ...f.options, ledger, taskId: 'fixed-build', maxCostCny: 1, campaignBudget });
  await assert.rejects(bounded.reserveModel(input));
  assert.deepEqual(events.map(row => row[0]), ['reserve-campaign', 'reserve-ledger', 'settle-campaign']);
  assert.equal(events[2][1].costCny, 0);
  const denied = createTrialIndexBudgetLedger({ ...f.options, taskId: 'fixed-build', maxCostCny: 1, campaignBudget: { reserve: async () => { throw new Error('campaign cap'); } } });
  await assert.rejects(denied.reserveModel(input), { code: 'trial_index_budget_exhausted' });
  assert.equal(f.rows.length, 0);
});

test('bounded concurrent chunks never duplicate offsets and stop siblings after the first unsupported result', async t => {
  const f = await fixture(t, { expected: 5001 });
  let active = 0, maximum = 0;
  const createResource = async dependencies => {
    const resource = await f.createResource(dependencies);
    return { async build(envelope) {
      active++; maximum = Math.max(maximum, active);
      try { await new Promise(resolve => setImmediate(resolve)); return await resource.build(envelope); }
      finally { active--; }
    } };
  };
  const ready = await runTrialIndexBuild({ ...f.options, concurrency: 4 }, { createModels: f.createModels, createResource });
  assert.equal(ready.status, 'complete'); assert.equal(maximum, 4);
  assert.deepEqual(f.envelopes.map(envelope => envelope.input.offset).sort((a, b) => a - b), [0, 1000, 2000, 3000, 4000, 5000]);
  const attempted = [], aborted = [];
  const stopped = await runTrialIndexBuild({ ...f.options, concurrency: 4 }, { createModels: f.createModels, createResource: async () => ({
    async build(envelope) {
      const offset = envelope.input.offset; attempted.push(offset);
      if (offset === 0) return { status: 'unsupported' };
      return new Promise((_resolve, reject) => {
        envelope.signal.addEventListener('abort', () => { aborted.push(offset); reject(envelope.signal.reason); }, { once: true });
      });
    },
  }) });
  assert.equal(stopped.status, 'stopped'); assert.equal(stopped.offset, 0);
  assert.deepEqual(attempted, [0, 1000, 2000, 3000]); assert.deepEqual(aborted.sort((a, b) => a - b), [1000, 2000, 3000]);
});

test('fixed pacer starts at most two requests per second and admits at most 800000 estimated tokens per minute', async () => {
  let instant = 0;
  const starts = [], waits = [];
  const pacer = createTrialIndexPacer({ now: () => instant, sleep: async milliseconds => { waits.push(milliseconds); instant += milliseconds; },
    fetchImpl: async () => { starts.push(instant); return new Response('offline'); } });
  await Promise.all(Array.from({ length: 4 }, () => pacer.fetch('https://provider.test')));
  assert.deepEqual(starts, [0, 500, 1000, 1500]);
  assert.equal(pacer.snapshot().dispatchedRequests, 4);
  const beforeWindow = instant;
  for (let index = 0; index < 4; index++) await pacer.beforeModel({ input: { texts: ['a'.repeat(800000)] } });
  assert.equal(instant - beforeWindow, 60000);
  assert.deepEqual(waits, [500, 500, 500, 60000]);
  assert.equal(pacer.snapshot().admittedEstimatedTokens, 4 * (200000 + 512));
});

test('abort cancels a queued pacing wait before provider dispatch and before model billing work', async () => {
  let sleeping;
  const reachedSleep = new Promise(resolve => { sleeping = resolve; });
  const controller = new AbortController();
  let dispatches = 0;
  const pacer = createTrialIndexPacer({ now: () => 0,
    sleep: (_milliseconds, signal) => new Promise((_resolve, reject) => {
      sleeping(); signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }), fetchImpl: async () => { dispatches++; return new Response('offline'); } });
  await pacer.fetch('https://provider.test');
  const queued = pacer.fetch('https://provider.test', { signal: controller.signal });
  await reachedSleep; controller.abort(new Error('operator interruption'));
  await assert.rejects(queued, /operator interruption/);
  assert.equal(dispatches, 1); assert.equal(pacer.snapshot().dispatchedRequests, 1);
  let modelOrBillingCalls = 0;
  const admit = createTrialIndexPacer({ now: () => 0 });
  await assert.rejects((async () => { await admit.beforeModel({ input: { texts: ['public trial'] }, signal: controller.signal }); modelOrBillingCalls++; })(), /operator interruption/);
  assert.equal(modelOrBillingCalls, 0);
});

test('real PostgreSQL resource build and ledger cap reuse stored vectors without a paid provider', {
  skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'An isolated local PostgreSQL with pgvector is required',
}, async t => {
  const isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'matchingoperator');
  const database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 5, databaseConnectionTimeoutMs: 2000 });
  t.after(async () => { await database.close(); await isolated.drop(); });
  await database.query('CREATE EXTENSION vector');
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('owner','Operator test','development')");
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES('owner','project','Operator test',1000000)");
  const f = await fixture(t, { expected: 21 }), recordsPath = path.join(path.dirname(f.options.manifestPath), 'public.ndjson');
  const bytes = Array.from({ length: 21 }, (_, index) => JSON.stringify({ registryId: `NCT${String(index).padStart(8, '0')}`, text: `Public trial ${index}` })).join('\n');
  await fs.writeFile(recordsPath, bytes, { mode: 0o600 });
  await fs.writeFile(f.options.manifestPath, JSON.stringify({ collectionId: 'operator-test', recordsPath, recordsSha256: createHash('sha256').update(bytes).digest('hex'), expectedRecords: 21 }));
  let calls = 0;
  const options = { ...f.options, database, ledger: new UsageLedger(database), config: { dashscopeApiKey: 'nonsecret-offline-fixture' }, accountMaxCostCny: 500,
    fetchImpl: async (_url, request) => {
      calls++;
      const body = JSON.parse(request.body);
      return Response.json({ model: body.model, usage: { total_tokens: 1000 }, data: body.input.map((_, index) => ({ index, embedding: Array(1024).fill(0.5) })) });
    } };
  const capped = await runTrialIndexBuild({ ...options, maxCostCny: 0.00000001 });
  assert.equal(capped.code, 'trial_index_budget_exhausted'); assert.equal(calls, 0);
  const ready = await runTrialIndexBuild(options);
  assert.equal(ready.status, 'complete'); assert.equal(ready.indexed, 21); assert.equal(calls, 2);
  const reused = await runTrialIndexBuild(options);
  assert.equal(reused.generation, ready.generation); assert.equal(reused.status, 'complete'); assert.equal(calls, 2);
  const rows = (await database.query('SELECT purpose,module,status FROM evimed_usage.model_requests')).rows;
  assert.equal(rows.length, 2); assert.ok(rows.every(row => row.purpose === 'kernel' && row.module === 'patient-matching' && row.status === 'settled'));
});
