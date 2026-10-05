// An optional extension failing never withholds unrelated research (review of 「循证进化」,
// 2026-10-05, S1). One bad file under <data>/.openscience/platform-skills/ used to fail every
// tenant's runtime start and every dispatch on a live runtime: an `active.json` that does not parse,
// a generation altered after it was written (its hash is deterministic, so it never healed), and two
// first starts racing to build the same generation (the second `rename` meets a non-empty directory
// and Linux answers ENOTEMPTY, not EEXIST).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPlatformSkillSupply, verifyPlatformSkillGeneration, platformSkillGenerationRoot } from '../src/platformSkillSupply.mjs';
import { RuntimeManager } from '../src/runtimeManager.mjs';

const options = { card: { toolKind: 'workflow' }, evaluation: { ok: true, verificationLevel: 'V0', smokePassed: true } };
const skill = (id, capability = 'statistics') => ({ id, publicationKind: 'skill', capabilityIds: [capability],
  files: { 'SKILL.md': `---\nname: ${id}\ndescription: Workflow ${id}.\n---\n\nUse the method.` } });

async function withSupply(run) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'platform-resilience-'));
  const reports = [];
  try { await run({ dataDir, reports, supply: createPlatformSkillSupply({ dataDir, evolutionEnabled: true }, { report: (code) => reports.push(code) }), config: { dataDir, evolutionEnabled: true } }); }
  finally { await fs.rm(dataDir, { recursive: true, force: true }); }
}

test('an active.json that does not parse falls back to the last verified generation, or to none, and says so', async () => {
  await withSupply(async ({ dataDir, supply, reports }) => {
    const activeFile = path.join(dataDir, '.openscience', 'platform-skills', 'active.json');
    await supply.publish(skill('one'), options);
    assert.equal(await supply.prepareForRuntime({ capabilityId: 'other' }), null, 'a scope with no tools has none');
    const good = await supply.prepareForRuntime({ capabilityId: 'statistics' });
    assert.equal(good.pins.length, 1);
    await fs.writeFile(activeFile, '[{"id":"one",');                 // truncated, as a crash would leave it
    const fallback = await supply.selectForRuntime({ capabilityId: 'statistics' });
    assert.deepEqual([fallback.degraded, fallback.generation.reference.generationHash], [true, good.reference.generationHash], 'the last verified generation');
    const unseen = await supply.selectForRuntime({ capabilityId: 'never-asked' });
    assert.deepEqual([unseen.degraded, unseen.generation], [true, null], 'and with none to fall back to, none');
    assert.equal((await supply.prepareForRuntime({ capabilityId: 'never-asked' })), null, 'a start is not refused');
    assert.deepEqual(reports, ['platform_skill_selection_failed'], 'reported once for the operator, not once per start');
    const status = supply.status();
    assert.equal(status.failures >= 3, true);
    assert.equal(status.fallbacks, 1);
    assert.equal(status.lastFailure.code, 'platform_skill_selection_failed');
  });
});

test('a generation altered after it was written is moved aside and rebuilt, not a permanent failure', async () => {
  await withSupply(async ({ config, supply, reports }) => {
    const first = await supply.publish(skill('one'), options);
    const generation = await supply.prepareForRuntime({ capabilityId: 'statistics' });
    const file = path.join(platformSkillGenerationRoot(config, generation.reference), 'skills', first.nativeName, 'SKILL.md');
    await fs.chmod(file, 0o644); await fs.writeFile(file, 'changed after the fact'); await fs.chmod(file, 0o444);
    await assert.rejects(verifyPlatformSkillGeneration(config, generation.reference), 'it really is corrupt');
    const healed = await supply.prepareForRuntime({ capabilityId: 'statistics' });
    assert.equal(healed.reference.generationHash, generation.reference.generationHash, 'the same content-addressed generation');
    assert.ok((await verifyPlatformSkillGeneration(config, healed.reference)).pins.length === 1);
    assert.equal(supply.status().rebuilt, 1);
    assert.ok(reports.includes('platform_skill_generation_rebuilt'));
    const aside = await fs.readdir(path.join(config.dataDir, '.openscience', 'platform-skills', 'quarantine'));
    assert.equal(aside.length, 1, 'the altered copy is kept, never deleted');
  });
});

test('two first starts that both build the same generation both succeed', async () => {
  await withSupply(async ({ supply }) => {
    await supply.publish(skill('one'), options);
    // Every start after a publish rebuilds the all-tools search generation; hold both renames until both have staged.
    const original = fs.rename;
    let arrived = 0; const waiters = [];
    fs.rename = async (from, to) => {
      if (String(from).includes(`${path.sep}staging${path.sep}`)) {
        arrived += 1; await new Promise((resolve) => { waiters.push(resolve); if (arrived >= 2) waiters.forEach((release) => release()); });
      }
      return original(from, to);
    };
    try {
      const [a, b] = await Promise.all([supply.prepareForRuntime({ id: 'a' }), supply.prepareForRuntime({ id: 'b' })]);
      assert.ok(a && b, 'neither start fails');
      assert.equal(a.reference.generationHash, b.reference.generationHash);
      assert.equal(arrived, 2, 'both really did stage the same generation');
      assert.equal(supply.status().failures, 0, 'and nothing is reported: it is not a failure');
    } finally { fs.rename = original; }
  });
});

test('the runtime manager starts without platform skills when the supply cannot answer, and a live runtime keeps what it has', async () => {
  const manager = new RuntimeManager({ dataDir: os.tmpdir(), evolutionEnabled: true, runtimeMode: 'kernel', runtimeSandboxMode: 'docker' });
  const failures = [];
  manager.platformSkillSupply = { prepareForRuntime: async () => { throw new Error('active.json unreadable'); }, noteFailure: (code) => failures.push(code) };
  const project = { id: 'p', userId: 'u' };
  assert.deepEqual(await manager.selectPlatformSkills(project, 'statistics'), { generation: null, degraded: true });
  assert.deepEqual(failures, ['platform_skill_selection_failed']);
  // A dispatch on a running runtime must not throw or restart it to "adopt" nothing.
  const mounted = { reference: { generationHash: 'a'.repeat(64) }, pins: [] };
  manager.runtimes.set(manager.key(project), { platformSkillGeneration: mounted });
  assert.deepEqual(await manager.setPlatformSkillScope(project, 'statistics'), { adopted: false });
  assert.equal(manager.runtimes.get(manager.key(project)).platformSkillGeneration, mounted);
  // No supply at all (the module is off) is simply nothing.
  manager.platformSkillSupply = null;
  assert.deepEqual(await manager.selectPlatformSkills(project, 'statistics'), { generation: null, degraded: false });
});

test('with no platform tool mounted a dispatch keeps no scope entry and a run observes nothing', async () => {
  const { createPlatformSkillTelemetry } = await import('../src/platformSkillTelemetry.mjs');
  const manager = new RuntimeManager({ dataDir: os.tmpdir(), runtimeMode: 'kernel', runtimeSandboxMode: 'docker' });
  assert.deepEqual(await manager.setPlatformSkillScope({ id: 'p', userId: 'u' }, 'statistics'), { adopted: false });
  assert.equal(manager.platformSkillScopes.size, 0, 'the map is not grown by a module that is off');
  for (const pins of [[], undefined, null]) {
    const telemetry = createPlatformSkillTelemetry(pins);
    assert.deepEqual(telemetry.observe({ type: 'tool/call', callId: 'c1', tool: 'bash', input: { command: 'ls' } }), []);
    assert.deepEqual(telemetry.observe({ type: 'tool/result', callId: 'c1', tool: 'bash', status: 'completed', output: '{}' }), []);
  }
});
