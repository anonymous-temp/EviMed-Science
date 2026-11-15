import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { OpenVikingEngine } from '../src/openVikingEngine.mjs';
import { OPENVIKING_MEMORY_TYPES, OPENVIKING_SKILL_NAMES } from '../src/openVikingLayout.mjs';

function fixture() {
  let time = 0, healthy = false, compileOk = true;
  const timers = new Map(), probes = [];
  let compileGate = null;
  const skill = 'pinned skill';
  const digest = createHash('sha256').update(skill).digest('hex');
  const client = { configured: true, account: 'test',
    status: async () => ({ connected: healthy, version: 'vtest' }),
    request: async ({ path }) => {
      if (path.includes('/memory-templates/')) throw { upstreamStatus: 400 };
      if (path.endsWith('/settings')) return { result: { memory_policy: { memory_types: [...OPENVIKING_MEMORY_TYPES] } } };
      if (path === '/api/v1/content/download') return { bytes: Buffer.from(skill) };
      if (path.endsWith('/capabilities')) return { result: { configured: true, can_create: true } };
      if (path === '/api/v1/compile') { probes.push(time); if (compileGate) await compileGate; return { result: { task_id: 'probe' } }; }
      if (path === '/api/v1/tasks/probe') return { result: { status: 'failed', error: compileOk ? 'no files' : 'lock acquire timed out' } };
      return { result: {} };
    },
  };
  const engine = new OpenVikingEngine({ client, config: { openVikingModelKey: 'test', openVikingEngineCheckMs: 600_000 },
    pin: { version: 'test', skills: Object.fromEntries(OPENVIKING_SKILL_NAMES.map(name => [name, { installedSha256: digest, sourceSha256: digest }])) },
    readSkill: async () => skill, now: () => new Date(time), wait: async () => {},
    setTimer: (fn, ms) => { const timer = { fn, ms }; timers.set(timer, timer); return timer; },
    clearTimer: timer => timers.delete(timer),
  });
  return { engine, probes, blockCompile: () => { let release; compileGate = new Promise(resolve => { release = resolve; }); return () => release(); }, setHealthy: value => { healthy = value; }, setCompile: value => { compileOk = value; },
    delay: () => [...timers.values()][0]?.ms,
    advance: async () => { const timer = [...timers.values()][0]; assert.ok(timer); timers.delete(timer); time += timer.ms; timer.fn(); await engine.running; await new Promise(resolve => setImmediate(resolve)); },
    at: value => { time = value; },
  };
}

test('failed startup retries after 15 seconds, then uses configured cadence after recovery', async () => {
  const f = fixture();
  f.engine.start(); await f.engine.running; await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.delay(), 15_000);
  f.setHealthy(true);
  await f.advance();
  assert.equal(f.engine.status().ok, true);
  assert.equal(f.delay(), 600_000);
  f.engine.close(); assert.equal(f.delay(), undefined);
});

test('failure backoff is 15, 30, 60, 120, 240 and capped at 300 seconds', async () => {
  const f = fixture(); f.engine.start(); await f.engine.running; await new Promise(resolve => setImmediate(resolve));
  for (const delay of [15, 30, 60, 120, 240, 300, 300]) { assert.equal(f.delay(), delay * 1_000); await f.advance(); }
  f.engine.close();
});

test('compile probes are at least 60 seconds apart, and never gate native memory', async () => {
  const f = fixture(); f.setHealthy(true); f.setCompile(false);
  await f.engine.check();
  assert.equal(f.engine.ready('nativeMemory').ok, true);
  assert.equal(f.engine.ready('knowledge').ok, false);
  for (const time of [15_000, 45_000, 59_999]) { f.at(time); await f.engine.check(); }
  assert.deepEqual(f.probes, [0]);
  f.at(60_000); await f.engine.check(); assert.deepEqual(f.probes, [0, 60_000]);
  f.setCompile(true); f.at(120_000); await f.engine.check(); assert.equal(f.engine.ready('knowledge').ok, true);
});


test('native memory facts become visible while the unrelated compile probe is still running', async () => {
  const f = fixture(); f.setHealthy(true); const release = f.blockCompile();
  const checking = f.engine.check(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.engine.ready('nativeMemory').ok, true);
  assert.equal(f.engine.ready('knowledge').ok, false);
  release(); await checking;
  assert.equal(f.engine.ready('knowledge').ok, true);
});
