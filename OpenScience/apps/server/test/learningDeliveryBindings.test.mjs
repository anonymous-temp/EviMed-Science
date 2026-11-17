import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { readLearningDeliveryBindings } from '../src/learningDeliveryBindings.mjs';

test('delivery snapshots bind actual bytes, respect primary deliveries, and refuse escapes, links and removed versions', async t => {
  const root = await mkdtemp(path.join(process.cwd(), '.late-binding-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceDir = path.join(root, 'workspace'); await mkdir(workspaceDir);
  await writeFile(path.join(workspaceDir, 'report.md'), 'version one');
  await writeFile(path.join(workspaceDir, 'scratch.py'), 'print(1)');
  await symlink(path.join(workspaceDir, 'report.md'), path.join(workspaceDir, 'link.md'));
  const project = { workspaceDir };
  const run = { outputFiles: ['report.md', 'scratch.py'], presentedFiles: ['report.md'] };
  assert.deepEqual(await readLearningDeliveryBindings(project, { ...run, finishedAt: new Date(Date.now() - 60_000).toISOString() }, { atDelivery: true }), [], 'never backfill a delivery with bytes changed after its end');
  const first = await readLearningDeliveryBindings(project, run);
  assert.equal(first.length, 1); assert.equal(first[0].path, 'report.md');
  await writeFile(path.join(workspaceDir, 'report.md'), 'version two');
  assert.notEqual((await readLearningDeliveryBindings(project, run))[0].sha256, first[0].sha256);
  assert.deepEqual(await readLearningDeliveryBindings(project, { outputFiles: ['link.md', '../outside.md', '/absolute.md', 'missing.md'] }), []);
  await rm(path.join(workspaceDir, 'report.md'));
  assert.deepEqual(await readLearningDeliveryBindings(project, run), []);
});
