import test from 'node:test';
import assert from 'node:assert/strict';
import { control } from './control.mjs';

test('memory-off arms need no native-commit schema to finish', async () => {
  const prior = process.env.OPEN_SCIENCE_MEMORY_ENABLED;
  process.env.OPEN_SCIENCE_MEMORY_ENABLED = 'false';
  try {
    const result = await control({}, 'lxMemoryState', { userId: 'baseline' });
    assert.equal(result.disabled, true);
    assert.deepEqual(result.commits, []);
  } finally {
    if (prior === undefined) delete process.env.OPEN_SCIENCE_MEMORY_ENABLED;
    else process.env.OPEN_SCIENCE_MEMORY_ENABLED = prior;
  }
});

test('enabled memory failures remain visible instead of becoming empty evidence', async () => {
  const prior = process.env.OPEN_SCIENCE_MEMORY_ENABLED;
  process.env.OPEN_SCIENCE_MEMORY_ENABLED = 'true';
  try {
    const app = { nativeMemoryWorker: { status: () => ({}) }, store: { database: { query: async () => { throw new Error('schema missing'); } } } };
    await assert.rejects(control(app, 'lxMemoryState', { userId: 'learning' }), /schema missing/);
  } finally {
    if (prior === undefined) delete process.env.OPEN_SCIENCE_MEMORY_ENABLED;
    else process.env.OPEN_SCIENCE_MEMORY_ENABLED = prior;
  }
});
