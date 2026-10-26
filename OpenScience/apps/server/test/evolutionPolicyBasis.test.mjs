import assert from 'node:assert/strict';
import { test } from 'node:test';
import { policyBasisFixture as fixture, activatePolicyFixture as activate } from './helpers/evolutionPolicyBasisFixture.mjs';

test('public confirmation and explicitly typed repository calibration seal exact historical revisions', async () => {
  const f = await fixture(), sealed = await f.basis.seal(f.input);
  assert.equal(sealed.status, 'sealed');
  assert.equal((await f.basis.check(sealed.validationRefs)).usable, true);
  const row = f.tasks[0];
  await f.service.save('task', row.id, { ...row.payload, pool: 'development', feedbackCount: 1, uses: [{ reason: 'confirmation-result' }], reservedFor: 'candidate' }, row);
  await f.service.save('confirmation-batch', f.batch.id, { ...f.batch.payload, status: 'complete', result: { passed: true } }, f.batch);
  assert.equal((await f.basis.check(sealed.validationRefs)).usable, true, 'accounting does not alter the evidence observed before confirmation');
});

test('a source correction withdraws only a dependent public basis; private triggers and newer versions alone do not', async () => {
  const f = await fixture(), { validationRefs } = await f.basis.seal(f.input);
  f.notices.set('doi:10.1234/unrelated', { state: 'changed', changes: [{ kind: 'retraction' }] });
  await f.service.save('signal-summary', 'private-trigger', { state: 'inactive' });
  assert.equal((await f.basis.check(validationRefs)).usable, true);
  f.notices.set('doi:10.1234/paper-0', { state: 'changed', changes: [{ kind: 'new_version' }] });
  assert.equal((await f.basis.check(validationRefs)).usable, true);
  f.notices.set('doi:10.1234/paper-0', { state: 'changed', changes: [{ kind: 'correction' }] });
  assert.deepEqual(await f.basis.check(validationRefs), { usable: false, knownInvalid: true, reason: 'public-basis-source-changed' });
});

test('changing current task truth or source bytes cannot be excused by the preserved historical revision', async () => {
  for (const what of ['task', 'source', 'calibration']) {
    const f = await fixture(), { validationRefs } = await f.basis.seal(f.input);
    if (what === 'task') await f.service.save('task', f.tasks[0].id, { ...f.tasks[0].payload, expected: 'Changed truth' }, f.tasks[0]);
    if (what === 'source') await f.service.save('resource-asset', f.sources[0].id, { ...f.sources[0].payload, text: 'Changed bytes' }, f.sources[0]);
    if (what === 'calibration') f.cases[0].answer = 'Changed calibration reference';
    assert.equal((await f.basis.check(validationRefs)).usable, false, what);
  }
});

test('missing or forged source pins and an unproven repair cannot become a sealed GEO policy basis', async () => {
  const f = await fixture();
  const task = f.tasks[0];
  await f.service.save('task', task.id, { ...task.payload, sourceAssetRef: { id: 'other-owner-private-source', revision: 1, payloadHash: 'a'.repeat(64) } }, task);
  assert.notEqual((await f.basis.seal(f.input)).status, 'sealed');
  const g = await fixture(); g.input.mission.payload.sources = ['repair'];
  assert.deepEqual(await g.basis.seal(g.input), { status: 'waiting', reason: 'public-baseline-reproduction-required' });
});

test('serving checks the authoritative verdict identity and suspends a withdrawn basis without reviving it on replay', async () => {
  const f = await fixture(), { policy } = await activate(f);
  assert.equal((await f.basis.readActive()).revisionId, `${policy.id}:${policy.revision}`);
  f.notices.set('doi:10.1234/paper-0', { state: 'changed', changes: [{ kind: 'retraction' }] });
  assert.equal(await f.basis.readActive(), null);
  const suspended = await f.service.get(policy.id);
  assert.equal(suspended.payload.status, 'suspended');
  f.notices.clear();
  assert.equal(await f.basis.readActive(), null, 'removing a notice does not republish the old verdict');
  assert.equal((await f.service.get(policy.id)).revision, suspended.revision);
});

test('a valid basis for one candidate cannot validate another verdict, changed result or policy text', async () => {
  for (const what of ['candidate', 'receipt', 'policy']) {
    const f = await fixture(), { verdict, policy } = await activate(f);
    if (what === 'candidate') assert.equal((await f.basis.validateVerdict({ ...verdict, payload: { ...verdict.payload, candidateId: 'another' } }, f.input.candidate)).usable, false);
    if (what === 'receipt') assert.equal((await f.basis.validateVerdict({ ...verdict, payload: { ...verdict.payload, measured: { units: [{ score: 99 }] } } }, f.input.candidate)).usable, false);
    if (what === 'policy') {
      await f.service.save('module-policy', policy.id, { ...policy.payload, policy: { supplements: [{ capabilityId: 'geo-content', text: 'Unmeasured new instructions.' }] } }, policy);
      assert.equal(await f.basis.readActive(), null);
    }
  }
});

test('a withdrawn private trigger permits only its own already sealed public verdict to resume', async () => {
  const { createEvolutionMissions } = await import('../src/evolutionMissions.mjs');
  for (const changed of [false, true]) {
    const f = await fixture(), active = await activate(f);
    await f.service.save('signal-summary', 'private-trigger', { state: 'inactive', generation: 'old' });
    const mission = f.input.mission;
    await f.service.save('mission', mission.id, { ...mission.payload, status: 'waiting_resource', candidate: f.input.candidate,
      verdictId: active.verdict.id, triggerRefs: [{ id: 'private-trigger', generation: 'old' }] }, mission);
    if (changed) f.notices.set('doi:10.1234/paper-0', { state: 'changed', changes: [{ kind: 'retraction' }] });
    f.service.callbacks.policyBasis = f.basis;
    const missions = createEvolutionMissions({ service: f.service, policy: {}, map: {}, taskPool: {}, signals: {}, config: { evolutionSearchPaused: true } });
    const result = await missions.run({ missionId: mission.id });
    assert.equal(result.payload.status, changed ? 'waiting_resource' : 'paused');
    if (changed) assert.equal(result.payload.reason, 'source-trigger-withdrawn');
  }
});

test('withdrawn confirmation dependencies and cached verdicts stop before curation or evaluator calls', async () => {
  const { createEvolutionMissions } = await import('../src/evolutionMissions.mjs');
  const { evolutionKey } = await import('../src/evolutionService.mjs');
  for (const cached of [false, true]) {
    const f = await fixture();
    if (cached) {
      const { verdict } = await activate(f);
      await f.service.save('candidate-verdict', `evolution-verdict-${evolutionKey([f.input.candidate.id, f.batch.id])}`, verdict.payload);
    }
    const mission = f.input.mission;
    await f.service.save('mission', mission.id, { ...mission.payload, status: 'frozen', epoch: 'fixture', candidate: f.input.candidate, dependencies: [], kind: 'research', successConditions: {} }, mission);
    const row = f.tasks[0];
    await f.service.save('task', row.id, { ...row.payload, validationState: 'withdrawn' }, row);
    let preparation = 0, evaluation = 0;
    f.service.callbacks.policyBasis = f.basis;
    f.service.callbacks.prepareModuleTasks = async () => { preparation++; return { status: 'waiting' }; };
    const missions = createEvolutionMissions({ service: f.service, policy: {}, map: {}, signals: {}, config: {},
      taskPool: { findBatch: async () => f.batch }, adapters: { geo: { enabled: true, evaluate: async () => { evaluation++; } } } });
    const result = await missions.run({ missionId: mission.id });
    assert.equal(result.payload.reason, 'public-basis-withdrawn');
    assert.equal(preparation, 0); assert.equal(evaluation, 0);
  }
});

test('a withdrawn task or source cannot reserve a new GEO confirmation batch', async () => {
  const { createEvolutionTaskPool } = await import('../src/evolutionTaskPool.mjs');
  for (const target of ['task', 'source']) {
    const f = await fixture(), pool = createEvolutionTaskPool({ service: f.service });
    for (const [index, row] of f.tasks.entries()) await f.service.save('task', row.id, { ...row.payload, reservedHidden: true,
      equivalentVariant: { question: 'Equivalent fixture' }, abstentionExpected: index === 0 }, row);
    const row = await f.service.get(target === 'task' ? f.tasks[1].id : f.sources[1].id);
    await f.service.save(target === 'task' ? 'task' : 'resource-asset', row.id, { ...row.payload, validationState: 'withdrawn' }, row);
    const batch = await pool.assemble({ candidateId: 'new-candidate', moduleId: 'geo', epoch: 'test', minimum: 30 });
    assert.equal(batch.id, null); assert.equal(batch.payload.availableGroups, 29);
    assert.ok((await f.service.list('task')).every(item => !item.payload.reservedFor));
  }
});

test('a public repair receipt retains its executed input but cannot admit smoke after that source is withdrawn', async () => {
  const { createHash } = await import('node:crypto');
  const { canonicalJson } = await import('@evimed/domain');
  const { createEvolutionMissions, evolutionFailureReproductionHash } = await import('../src/evolutionMissions.mjs');
  const digest = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
  const { evolutionRecordPin } = await import('../src/evolutionRecordPins.mjs');
  const f = await fixture(), initial = f.input.mission, baseline = initial.payload.baseline, task = f.tasks[0];
  const results = [{ units: [{ id: task.id, score: 0 }] }, { units: [{ id: task.id, score: 0 }] }];
  for (const [index, result] of results.entries()) await f.service.save('failure-replay', `receipt-attempt-${index}`, { result, taskRef: evolutionRecordPin(task) });
  const proof = { missionId: initial.id, moduleId: 'geo', baselineHash: digest(baseline), taskId: task.id, taskRef: evolutionRecordPin(task),
    sourceRoot: task.payload.sourceRoot, sourceHash: task.payload.sourceHash, scope: 'public', independent: true, executed: true,
    baselineFailed: true, referenceVerified: true, executionReceiptHash: digest(results) };
  const receipt = await f.service.save('failure-reproduction', 'receipt', { ...proof, receiptHash: evolutionFailureReproductionHash(proof) });
  const mission = await f.service.save('mission', initial.id, { ...initial.payload, status: 'ready', dependencies: [], kind: 'repair', sources: ['repair'],
    failureReproductionReceiptId: receipt.id, preparedCandidateState: { candidate: f.input.candidate, baseline } }, initial);
  assert.equal((await f.basis.checkReproduction({ mission, baseline, receipt })).usable, true);
  const changedTask = await f.service.save('task', task.id, { ...task.payload, expected: 'Changed scientific truth' }, task);
  assert.equal((await f.basis.checkReproduction({ mission, baseline, receipt })).usable, false);
  await f.service.save('task', task.id, task.payload, changedTask);
  assert.equal((await f.basis.checkReproduction({ mission, baseline, receipt })).usable, true);
  f.notices.set(task.payload.sourceRoot, { state: 'changed', changes: [{ kind: 'correction' }] });
  f.service.callbacks.policyBasis = f.basis;
  let calls = 0;
  f.service.callbacks.prepareModuleTasks = async () => { calls++; return { status: 'ready' }; };
  const missions = createEvolutionMissions({ service: f.service, policy: {}, map: {}, signals: {}, config: {}, taskPool: {},
    adapters: { geo: { enabled: true, smoke: async () => { calls++; } } } });
  const result = await missions.run({ missionId: mission.id });
  assert.equal(result.payload.reason, 'public-basis-source-changed'); assert.equal(calls, 0);
});
