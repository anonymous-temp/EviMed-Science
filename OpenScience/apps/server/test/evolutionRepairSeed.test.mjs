import {publishConfirmed} from './helpers/confirmedEvolutionPublication.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { evolutionRepairSeed } from '../src/evolutionRepairSeed.mjs';
test('first repair attempt seeds exact certified parent bytes and passes isolation before dispatch', async () => {
  const bytes = { 'SKILL.md': '# Method', 'scripts/method.py': 'original bytes' }, requested = [], filtered = [];
  const dependencies = { service: { get: async () => ({ id: 'parent', payload: { artifactDigest: 'sha256:old', revision: 3 } }) }, supply: { candidateForEvaluation: async pin => { requested.push(pin); return { files: bytes, entrypoint: 'scripts/method.py:method', dependencies: [], digest: 'sha256:old', revision: 3 }; } }, isolation: { filter: async (...args) => { filtered.push(args); return args[2]; } } };
  const card = { repairOf: { toolId: 'parent', artifactDigest: 'sha256:old' }, parentToolIds: ['parent'] }, identity = { userId: 'owner', projectId: 'repair' };
  const seed = await evolutionRepairSeed(dependencies, card, identity);
  assert.deepEqual(seed.files, bytes);
  assert.deepEqual(requested, [{ id: 'parent', digest: 'sha256:old', revision: 3 }]);
  assert.deepEqual(filtered[0].slice(0, 2), [identity, 'previous-development-candidate']);
  await assert.rejects(evolutionRepairSeed(dependencies, { ...card, repairOf: { toolId: 'parent', artifactDigest: 'sha256:new' } }, identity));
  assert.equal(await evolutionRepairSeed(dependencies, {}, identity), null);
});

test('public boundary failure prevents hidden evaluation and publication even for a single self-tested candidate', async () => {
  const { createEvolutionBuilder } = await import('../src/evolutionBuild.mjs');
  let hidden = 0, published = 0;
  const builder = createEvolutionBuilder({ dispatch: async () => ({ id:'candidate', publicationKind: 'isolated-tool', entrypoint:'scripts/a.py:a', files: { 'SKILL.md':'Public instructions', 'scripts/a.py': 'code' } }), verification: { verify: async () => ({ ok: true }) }, validateDevelopment: async () => ({ ok: false, status: 'repair', issues: [{ code: 'development_refusal_missing', caseId: 'negative-probability' }] }), evaluator: { evaluate: async () => { hidden++; return { ok: true }; } }, publisher: { publish: async () => { published++; } } });
  const result = await builder.build({ id: 'card' });
  assert.equal(result.status, 'repair');
  assert.deepEqual(result.feedback.issueCodes, ['development_refusal_missing']);
  assert.equal(hidden, 0);
  assert.equal(published, 0);
});

test('certified parent seeds real isolated public boundary execution with unchanged source family', async t => {
  const { spawnSync } = await import('node:child_process');
  const image = 'docker.m.daocloud.io/library/python:3.12-slim-bookworm';
  if (spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }).status !== 0) return t.skip('Pinned local executor image unavailable');
  const fs = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path');
  const { createPlatformSkillSupply } = await import('../src/platformSkillSupply.mjs');
  const { createEvolutionVerificationController } = await import('../src/evolutionVerificationController.mjs');
  const { createEvolutionDevelopmentValidation } = await import('../src/evolutionDevelopmentValidation.mjs');
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repair-parent-real-'));
  const config = { dataDir, evolutionEnabled: true, runtimeContainerBin: 'docker', runtimeContainerImage: image }, supply = createPlatformSkillSupply(config), controller = createEvolutionVerificationController(config);
  try {
    const files = { 'SKILL.md': '# Public boundary method', 'scripts/calculate.py': 'def calculate(value):\n if value < 0: raise ValueError("Negative value unsupported")\n return {"result":value*2}\n' };
    const publication = await publishConfirmed(supply,{ id: 'parent', publicationKind: 'isolated-tool', entrypoint: 'scripts/calculate.py:calculate', files }, { card: { toolKind: 'calculation' }, evaluation: { ok: true, verificationLevel: 'V2' }, activate: false });
    const seed = await evolutionRepairSeed({ service: { get: async () => ({ id: 'parent', payload: { artifactDigest: publication.digest, revision: publication.revision } }) }, supply, isolation: { filter: async (_identity, _kind, value) => value } }, { repairOf: { toolId: 'parent', artifactDigest: publication.digest }, parentToolIds: ['parent'] }, { userId: 'owner', projectId: 'repair' });
    assert.deepEqual(seed.files, files);
    const validator = createEvolutionDevelopmentValidation({ controller: { execVerify: (body, options) => controller.execute(body, options) } });
    const contract = { cases: [{ id: 'numeric', input: { value: 3 }, expected: { result: 6 }, absoluteTolerance: 0 }, { id: 'negative', input: { value: -1 }, expectedRefusal: true }] };
    const passed = await validator.validate(seed, { contract });
    assert.equal(passed.ok, true);
    assert.ok(passed.executions.every(row => row.executed && row.passed));
    const failed = await validator.validate({ ...seed, files: { ...files, 'scripts/calculate.py': 'def calculate(value):\n return {"result":value*2}\n' } }, { contract });
    assert.equal(failed.ok, false);
    assert.ok(failed.issues.some(issue => issue.caseId === 'negative'));
  } finally { await controller.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
});
