import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeMemoryWorker } from '../src/nativeMemoryWorker.mjs';

function worker(given = {}) {
  const asked = [];
  const worker = new NativeMemoryWorker({ config: {}, memorySettings: {}, sessions: {},
    overlay: { async openCommits(input) { asked.push(input); return []; } }, ...given });
  return { worker, asked };
}

test('default native commit scheduling uses the database clock that created due times', async () => {
  const f = worker();
  await f.worker.processCommits({ userId: 'owner' });
  assert.equal(f.asked[0].now, null, 'a host clock behind PostgreSQL must not hide an already-due failed archive');
});

test('an explicitly injected evaluation clock retains exact replay backoff control', async () => {
  const at = new Date('2026-11-01T00:00:00Z'); const f = worker({ now: () => at });
  await f.worker.processCommits({ userId: 'owner' });
  assert.equal(f.asked[0].now, at);
});
