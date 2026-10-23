import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { ProductDocuments, ProductJobs } from '../src/productStore.mjs';
import { EvolutionService } from '../src/evolutionService.mjs';
import { createEvolutionMissions } from '../src/evolutionMissions.mjs';
import { createSourceChanges } from '../src/sourceChanges.mjs';
import { createModuleEvolutionPolicies } from '../src/moduleEvolutionPolicies.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { policyBasisFixture, activatePolicyFixture } from './helpers/evolutionPolicyBasisFixture.mjs';

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
const options = { skip: !url && 'A disposable localhost PostgreSQL database is required' };
async function fixture(t) {
  const isolated = await createGeoTestDatabase(url, 'publicbasis');
  const database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 8, databaseConnectionTimeoutMs: 3000 });
  t.after(async () => { await database.close(); await isolated.drop(); });
  const ownerId = `basis_${randomUUID()}`;
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Public basis fixture','development')", [ownerId]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'evimed-evolution','Evolution',1048576)", [ownerId]);
  const documents = new ProductDocuments(database), jobs = new ProductJobs(database);
  const service = new EvolutionService({ documents, jobs, ownerId });
  const changes = createSourceChanges({ documents, ownerUserId: ownerId });
  const f = await policyBasisFixture({ providedService: service, sourceChanges: changes });
  service.callbacks.policyBasis = f.basis;
  const missions = createEvolutionMissions({ service, policy: {}, map: {}, taskPool: {}, signals: {}, config: {} });
  const policies = createModuleEvolutionPolicies({ readPolicy: () => f.basis.readActive(), validateRevision: (_module, revision) => f.basis.revisionUsable(revision) });
  const retract = () => changes.record('doi:10.1234/paper-0', { kind: 'retraction', noticeIdentifier: '10.1234/notice', date: '2026-10-24' }, { assertedBy: 'crossref' });
  return { ...f, database, changes, missions, policies, retract };
}

test('Postgres: public dependency pins publish once and keep exact historical task and source revisions', options, async t => {
  const f = await fixture(t), active = await activatePolicyFixture(f, { publish: f.missions.publish });
  assert.equal(active.publication.status, 'published');
  assert.equal(active.policy.revision, 1);
  assert.deepEqual(await f.missions.publish('geo', f.input.candidate, { verdictId: active.verdict.id }), active.publication);
  const task = f.tasks[0];
  await f.service.save('task', task.id, { ...task.payload, feedbackCount: 1, pool: 'development', uses: [{ reason: 'confirmation-result' }] }, task);
  await f.service.save('confirmation-batch', f.batch.id, { ...f.batch.payload, status: 'complete', result: { passed: true } }, f.batch);
  const read = await f.policies.resolve('geo', {});
  assert.equal(read.revisionId, active.publication.revisionId);
  assert.deepEqual(read.policy, f.input.candidate.policy);
  assert.equal(await f.policies.revisionUsable('geo', read.revisionId), true);
  assert.equal((await f.basis.reconcile()).currency, 'unknown', 'no network status check was performed');
});

test('Postgres: a recorded retraction suspends serving and delayed dispatch; replay does not reactivate it', options, async t => {
  const f = await fixture(t), active = await activatePolicyFixture(f, { publish: f.missions.publish });
  await f.retract();
  const rejected = await f.missions.publish('geo', f.input.candidate, { verdictId: active.verdict.id });
  assert.equal(rejected.reason, 'public-basis-source-changed');
  const row = await f.service.get(active.policy.id);
  assert.equal(row.payload.status, 'suspended');
  assert.match((await f.policies.resolve('geo', {})).revisionId, /^default:/);
  assert.equal(await f.policies.revisionUsable('geo', active.publication.revisionId), false);
  assert.equal((await f.service.documents.history(await f.service.owner(), 'knowledge', row.id, { limit: 10 })).some(entry => entry.payload.status === 'active'), true);
  await f.missions.publish('geo', f.input.candidate, { verdictId: active.verdict.id });
  assert.equal((await f.service.get(row.id)).revision, row.revision);
});

test('Postgres: a source notice committed before activation is read inside its publication fence', options, async t => {
  const f = await fixture(t), active = await activatePolicyFixture(f);
  const row = await f.service.get(active.policy.id);
  await f.service.save('module-policy', row.id, { ...row.payload, status: 'suspended' }, row);
  await f.retract();
  const result = await f.missions.publish('geo', f.input.candidate, { verdictId: active.verdict.id });
  assert.equal(result.status, 'review');
  assert.equal((await f.service.get(row.id)).payload.status, 'suspended');
});

test('Postgres: source-feed writes serialize behind a publication snapshot and invalidate its next serving read', options, async t => {
  const f = await fixture(t);
  const active = await activatePolicyFixture(f);
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const publication = f.basis.stable(async () => { entered(); await held; return f.basis.inspectPolicy(active.policy); });
  await ready;
  let committed = false;
  const notice = f.retract().then(value => { committed = true; return value; });
  try { await delay(30); assert.equal(committed, false, 'the notice must not cross a held source-feed snapshot'); }
  finally { release(); }
  assert.equal((await publication).usable, true);
  await notice;
  assert.equal(await f.basis.readActive(), null);
});

for (const scenario of ['normal', 'interrupted-withdrawn-trigger', 'stale-round-verdict', 'interrupted-audit']) test(`Postgres: confirmation coordinator preserves first answers and publication under ${scenario}`, options, async t => {
  // Scores and source texts in this regression are synthetic; this exercises the coordinator, not a scientific gain claim.
  const { createEvolutionTaskPool } = await import('../src/evolutionTaskPool.mjs');
  const f = await fixture(t), taskPool = createEvolutionTaskPool({ service: f.service });
  const auditOnly = scenario === 'interrupted-audit', interrupted = scenario !== 'normal';
  let finishCalls = 0, publishCalls = 0;
  const finish = taskPool.finish;
  taskPool.finish = async (...args) => { finishCalls++; if (interrupted && finishCalls === 1) throw new Error('Simulated interruption after verdict persistence'); return finish(...args); };
  await f.service.save('signal-summary', 'trigger', { state: 'active', generation: 'original' });
  for (const [index, row] of f.tasks.entries()) {
    await f.service.save('task', row.id, { ...row.payload, firstPublicAt: '2026-10-03T00:00:00Z', firstPublicEvidenceId: `chronology-${index}`,
      equivalentVariant: { question: `Equivalent fixture question ${index}` }, abstentionExpected: index === 0, epoch: 'fixture' }, row);
  }
  const candidate = { ...f.input.candidate, frozenAt: '2026-10-02T00:00:00Z', proposal: { mechanisms: ['fixture-mechanism'] } };
  await f.service.save('archive', candidate.id, { moduleId: 'geo', candidate, status: 'frozen' });
  const initial = f.input.mission;
  await f.service.save('mission', initial.id, { ...initial.payload, candidate, ...(scenario === 'stale-round-verdict' ? { verdictId: 'prior-round-verdict', round: 2 } : {}), status: 'frozen', dependencies: [], kind: auditOnly ? 'transfer-audit' : 'research', auditOnly, epoch: 'fixture', triggerRefs: [{ id: 'trigger', generation: 'original' }],
    modelReleasedAt: '2026-10-01T00:00:00Z', successConditions: { slices: [] } }, initial);
  let measuredCalls = 0;
  const missions = createEvolutionMissions({ service: f.service, policy: {}, map: {}, taskPool, signals: {}, config: {}, adapters: { geo: {
    enabled: true, evaluatorVersion: 'synthetic-test', evaluate: async input => {
      measuredCalls++;
      const units = [];
      for (const item of input.batch) for (const suffix of ['', ':equivalent']) {
        units.push(await input.checkpointUnit(`${item.id}${suffix}`, async () => ({ id: `${item.id}${suffix}`, groupId: item.id, sourceHash: item.sourceHash,
          score: input.role === 'candidate' ? 0.9 : 0.8, deterministicPassed: true })));
      }
      return { status: 'measured', units, evidenceTier: 'exact', pool: 'confirmation', costCny: 1, contextBytes: 100 };
    }, publish: (value, result) => { publishCalls++; return f.missions.publish('geo', value, result); },
  } } });
  if (interrupted) {
    await assert.rejects(missions.run({ missionId: initial.id }), /Simulated interruption/);
    assert.equal((await f.service.get(initial.id)).payload.verdictId, scenario === 'stale-round-verdict' ? 'prior-round-verdict' : undefined);
    if (!auditOnly) {
      const trigger = await f.service.get('trigger');
      await f.service.save('signal-summary', trigger.id, { ...trigger.payload, state: 'inactive' }, trigger);
    }
  }
  const result = await missions.run({ missionId: initial.id });
  assert.equal(result.payload.status, 'complete', JSON.stringify(result.payload));
  assert.equal(finishCalls, interrupted ? 2 : 1);
  assert.equal(publishCalls, auditOnly ? 0 : 1);
  assert.equal(result.payload.confirmedPromotions, auditOnly ? 0 : 1);
  if (!auditOnly) assert.equal(result.payload.publication.status, 'published');
  assert.equal(measuredCalls, 4);
  const verdict = await f.service.get(result.payload.verdictId);
  assert.equal((await f.basis.check(verdict.payload.validationRefs)).usable, true);
  if (auditOnly) {
    assert.match((await f.policies.resolve('geo', {})).revisionId, /^default:/);
    assert.equal((await f.service.get(candidate.id)).payload.status, 'audited');
    assert.equal((await f.basis.validateVerdict(verdict, candidate)).usable, false, 'audit verdicts never activate');
    return;
  }
  assert.equal((await f.policies.resolve('geo', {})).revisionId, result.payload.publication.revisionId);
  await f.retract();
  assert.match((await f.policies.resolve('geo', {})).revisionId, /^default:/);
  assert.equal((await f.service.get(candidate.id)).payload.status, 'suspended');
  assert.equal(measuredCalls, 4);
});

test('Postgres: restoring deleted required evidence cannot silently revive a suspended policy', options, async t => {
  const f = await fixture(t), active = await activatePolicyFixture(f, { publish: f.missions.publish });
  const source = f.sources[0], owner = await f.service.owner();
  const deleted = await f.service.documents.remove(owner, 'knowledge', source.id, source.revision);
  assert.equal(await f.basis.readActive(), null);
  assert.equal((await f.service.get(active.policy.id)).payload.status, 'suspended');
  await f.service.documents.restore(owner, 'knowledge', source.id, deleted.revision);
  assert.equal(await f.basis.readActive(), null);
  assert.equal(await f.basis.revisionUsable(active.publication.revisionId), false);
  assert.equal((await f.missions.publish('geo', f.input.candidate, { verdictId: active.verdict.id })).status, 'review');
});


test('Postgres: deleting the candidate archive permanently suspends its policy until reconfirmation', options, async t => {
  const f = await fixture(t), active = await activatePolicyFixture(f, { publish: f.missions.publish });
  const archive = await f.service.get(f.input.candidate.id), owner = await f.service.owner();
  const deleted = await f.service.documents.remove(owner, 'knowledge', archive.id, archive.revision);
  assert.equal(await f.basis.readActive(), null);
  assert.equal((await f.service.get(active.policy.id)).payload.status, 'suspended');
  await f.service.documents.restore(owner, 'knowledge', archive.id, deleted.revision);
  assert.equal(await f.basis.readActive(), null);
});
