// What this file pinned about a run's observed egress left with the proof (the online experiment engine was deleted, 2026-11-04). Two rules of the
// run ledger it also pinned stand, and are held here: a dispatch is durable and never prompts twice, and a run's learning record stays bounded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentRunStore } from '../src/agentRuns.mjs';

const fixture = async (label) => {
  const root = await mkdtemp(path.join(tmpdir(), `run-ledger-${label}-`));
  const project = { id: `ledger-${label}`, userId: 'operator', rootDir: root, workspaceDir: path.join(root, 'workspace'), metaDir: path.join(root, '.openscience') };
  await mkdir(project.workspaceDir); await mkdir(project.metaDir);
  const session = { sessionId: `session-${label}`, mode: 'open-domain', agentId: null, agentVersion: null, runtimeAgent: null };
  const create = () => { const store = new AgentRunStore({ get: async () => session }, { model: 'deepseek/deepseek-v4-flash', readSessionHistory: async () => [] }); store.scheduleMonitor = () => {}; return store; };
  return { root, project, session, create };
};

test('a durable dispatch prompts once, and a preserved dispatch is resumed without a second prompt', async () => {
  const { root, project, session, create } = await fixture('dispatch');
  const store = create(), order = [];
  try {
    const run = await store.dispatch(project, { sessionId: session.sessionId, dispatchId: 'actual-dispatch' }, async (_binding, actual) => { order.push(['prompt', actual.id]); return { accepted: true }; });
    assert.deepEqual(order, [['prompt', run.id]]);
    const resumed = await store.dispatch(project, { sessionId: session.sessionId, dispatchId: 'actual-dispatch' }, async () => { throw new Error('A preserved dispatch must never prompt twice'); });
    assert.equal(resumed.id, run.id);
    assert.equal(order.length, 1);
  } finally { await store.closeProject(project); await rm(root, { recursive: true, force: true }); }
});

test('a run\'s learning record stays one event through cumulative compaction and is restored after a restart', async () => {
  const { root, project, session, create } = await fixture('compaction');
  const store = create(), compactedAt = '2026-10-05T02:00:00Z';
  try {
    const run = await store.dispatch(project, { sessionId: session.sessionId, dispatchId: 'compaction-dispatch' }, async (_binding, actual) => {
      await store.recordLearning(project, actual.id, { mountedSkills: ['actual-prior-skill'] });
      assert.deepEqual((await store.list(project)).find(row => row.id === actual.id).mountedSkills, ['actual-prior-skill']);
      await store.recordLearning(project, actual.id, { appendCompaction: { at: compactedAt, kind: 'actual-compaction' } });
      return { accepted: true };
    });
    for (let index = 0; index < 4; index++) await store.recordLearning(project, run.id, { mountedSkills: ['actual-final-skill'] });
    const events = (await readFile(path.join(project.metaDir, 'runs.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events.filter(event => event.event === 'learning' && event.id === run.id).length, 1, 'cumulative gauge compaction remains bounded');
    const restarted = create();
    try {
      const restored = (await restarted.list(project)).find(row => row.id === run.id);
      assert.deepEqual(restored.mountedSkills, ['actual-final-skill']);
    } finally { await restarted.closeProject(project); }
  } finally { await store.closeProject(project); await rm(root, { recursive: true, force: true }); }
});
