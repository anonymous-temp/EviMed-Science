import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { foreignDeliverableIds, withoutOtherSessionsFiles } from '../src/runArtifactAttribution.mjs';
import { workspaceChangedFiles } from '../src/runWorkspaceChanges.mjs';

const started = '2026-11-01T10:00:00.000Z';
const ended = '2026-11-01T10:10:00.000Z';
const run = (id, sessionId, item, more = {}) => ({ id, sessionId, startedAt: started, finishedAt: ended,
  nativeTurn: { startSeq: 1 }, nativeWorkflow: { plan: { written: true, items: [{ id: item }] }, submissions: [], delegates: [] }, ...more });

test('only overlapping, independently owned deliverable IDs are excluded', () => {
  const current = run('r1', 's1', 'statistics');
  const peers = [run('r2', 's2', 'adr'), run('r3', 's3', 'selection'),
    run('old', 's4', 'reused', { startedAt: '2026-11-01T09:00:00Z', finishedAt: '2026-11-01T09:10:00Z' })];
  assert.deepEqual([...foreignDeliverableIds(current, peers)].sort(), ['adr', 'selection']);
  assert.deepEqual([...foreignDeliverableIds(current, [run('r2', 's2', 'statistics')])], [], 'a shared ID is ambiguous, not foreign-only');
  assert.deepEqual([...foreignDeliverableIds(current, [run('r2', 's2', 'old-plan', { nativeWorkflow: { plan: { written: false, items: [{ id: 'old-plan' }] }, submissions: [], delegates: [] } })])], [], 'a read-only stale projection is not ownership proof');
  assert.deepEqual([...foreignDeliverableIds(current, [run('r2', 's2', 'adr', { nativeWorkflow: { plan: { written: false, items: [{ id: 'adr' }] }, writtenPlanIds: ['adr'], submissions: [], delegates: [] } })])], ['adr'], 'a previous witnessed write remains evidence after status');
});

test('ordinary workspace scanning excludes known foreign directories before its file limit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'run-ownership-'));
  try {
    await mkdir(path.join(root, 'deliverables', 'a-foreign'), { recursive: true });
    await mkdir(path.join(root, 'deliverables', 'z-own'), { recursive: true });
    for (let i = 0; i < 70; i += 1) await writeFile(path.join(root, 'deliverables', 'a-foreign', `${i}.csv`), 'v\n1\n');
    await writeFile(path.join(root, 'deliverables', 'z-own', 'result.csv'), 'v\n2\n');
    const files = await workspaceChangedFiles(root, { since: Date.now() - 10000, excludedDeliverableIds: new Set(['a-foreign']) });
    assert.deepEqual(files, ['deliverables/z-own/result.csv']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('overlap depends on the run intervals, not an old directory or an unknown start', async () => {
  const { overlappingRuns } = await import('../src/runArtifactAttribution.mjs');
  const current = run('r1', 's1', 'statistics');
  const old = run('r2', 's2', 'old', { startedAt: '2026-11-01T09:00:00Z', finishedAt: '2026-11-01T09:30:00Z' });
  const future = run('r3', 's3', 'later', { startedAt: '2026-11-01T10:11:00Z', finishedAt: null });
  const overlap = run('r4', 's4', 'peer', { startedAt: '2026-11-01T10:05:00Z', finishedAt: null });
  assert.deepEqual(overlappingRuns(current, [current, old, future, overlap]).map((item) => item.id), ['r4']);
});

test('a witnessed accepted submission is ownership evidence without a surviving plan', () => {
  const current = run('r1', 's1', 'statistics');
  const peer = run('r2', 's2', 'unused', { nativeWorkflow: { plan: null,
    submissions: [{ id: 'adr', accepted: { contractKind: 'adr-analysis-report' } }], delegates: [] } });
  assert.deepEqual([...foreignDeliverableIds(current, [peer])], ['adr']);
  assert.deepEqual([...foreignDeliverableIds({ ...current, nativeWorkflow: { ...current.nativeWorkflow,
    submissions: [{ id: 'adr', accepted: {} }] } }, [peer])], [], 'an ID witnessed by both runs remains ambiguous');
});

test('with another conversation at work, a changed file is the run\'s only when the run names it', () => {
  const files = ['deliverables/sglt2/report.md', 'deliverables/glp1/table.md', 'charts/plot.png'];
  const assistants = [{ parts: [{ type: 'tool', tool: 'bash', input: { command: 'cat > deliverables/sglt2/report.md' } }, { type: 'text', text: 'chart at plot.png' }] }];
  assert.deepEqual(withoutOtherSessionsFiles(files, [{ id: 'other' }], assistants), ['deliverables/sglt2/report.md', 'charts/plot.png']);
  assert.deepEqual(withoutOtherSessionsFiles(files, [], assistants), files, 'nobody else at work: every file is the run\'s and nothing is read');
  assert.deepEqual(withoutOtherSessionsFiles([], [{ id: 'other' }], assistants), []);
  assert.deepEqual(withoutOtherSessionsFiles(files, [{ id: 'other' }], [{ parts: [{ type: 'tool', input: { command: 'python3 build.py' } }] }]), files, 'a run that names none of them says nothing');
});
