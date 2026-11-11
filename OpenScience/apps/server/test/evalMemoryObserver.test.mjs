import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../../../evals/general-tasks/runner/eval-memory-observer.mjs';

test('the registry observer stops sampling before its injected service is disposed', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'memory-observer-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previous = process.env.EVAL_MEMORY_TOOLS_FILE;
  process.env.EVAL_MEMORY_TOOLS_FILE = path.join(dir, 'tools.json');
  t.after(() => {
    if (previous === undefined) delete process.env.EVAL_MEMORY_TOOLS_FILE;
    else process.env.EVAL_MEMORY_TOOLS_FILE = previous;
  });
  t.mock.timers.enable({ apis: ['setInterval'] });
  let disposed = false, stop, reads = 0;
  apply({ tools: { definitions() {
    if (disposed) throw new Error('injected tools service is disposed');
    reads++;
    return [{ name: 'remember' }];
  } }, effect: setup => { stop = setup(); } });
  t.mock.timers.tick(500);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'tools.json'), 'utf8')).names, ['remember']);
  stop(); disposed = true;
  assert.doesNotThrow(() => t.mock.timers.tick(1000));
  assert.equal(reads, 2);
});
