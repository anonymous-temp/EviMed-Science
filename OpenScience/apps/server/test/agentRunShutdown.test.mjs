import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { AgentRunStore } from '../src/agentRuns.mjs';
import { awaitBackgroundMonitor } from './helpers/awaitBackgroundMonitor.mjs';

for (const observation of ['monitor', 'reconciliation']) test(`shutdown waits for a terminal ${observation} completion hook before releasing project storage`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'run-shutdown-'));
  const project = { id: 'p', userId: 'u', rootDir: root, metaDir: path.join(root, '.openscience'), workspaceDir: path.join(root, 'workspace') };
  await mkdir(project.workspaceDir, { recursive: true });
  await mkdir(project.metaDir, { recursive: true });
  let enterHook;
  let releaseHook;
  let enterCloseProject;
  const hookEntered = new Promise(resolve => { enterHook = resolve; });
  const hookRelease = new Promise(resolve => { releaseHook = resolve; });
  const projectClosed = new Promise(resolve => { enterCloseProject = resolve; });
  let hookFinished = false;
  let historyReads = 0;
  const store = new AgentRunStore({ get: async () => ({ sessionId: 's', mode: 'open-domain', agentId: null, agentVersion: null, runtimeAgent: null }) }, {
    model: 'deepseek/deepseek-v4-flash', monitorIntervalMs: 60_000, monitorMaxPolls: 1,
    readSessionHistory: async () => {
      historyReads += 1;
      if (historyReads === 1) return [];
      throw Object.assign(new Error('gone'), { status: 409, code: 'runtime_not_running' });
    },
    onRunFinished: async () => {
      enterHook();
      await hookRelease;
      await writeFile(path.join(project.metaDir, 'completion-hook.json'), '{}\n');
      hookFinished = true;
    },
  });
  let closing;
  let monitor;
  try {
    const scheduleMonitor = store.scheduleMonitor.bind(store);
    if (observation === 'reconciliation') store.scheduleMonitor = () => {};
    const run = await store.start(project, { sessionId: 's' });
    store.scheduleMonitor = scheduleMonitor;
    monitor = observation === 'monitor' ? store.monitors.get(run.id)?.promise : store.reconcileSession(project, 's', run.id);
    await awaitBackgroundMonitor(hookEntered);
    assert.equal((await store.list(project)).find(row => row.id === run.id)?.status, 'failed');
    const closeProject = store.closeProject.bind(store);
    store.closeProject = async (...args) => {
      const result = await closeProject(...args);
      enterCloseProject();
      return result;
    };
    closing = store.closeAll();
    await awaitBackgroundMonitor(projectClosed);
    const state = await Promise.race([closing.then(() => 'closed'), nextTurn('pending')]);
    assert.equal(state, 'pending', 'terminal ledger state does not mean its completion hook has settled');
    const readsBefore = historyReads;
    store.scheduleMonitor(project, 'late-monitor');
    assert.equal(store.monitors.has('late-monitor'), false, 'shutdown admits no new monitor');
    const reconcilesBefore = store.reconciles.size;
    const late = store.reconcileSession(project, 's', 'late-run');
    assert.equal(store.reconciles.size, reconcilesBefore, 'shutdown admits no new reconciliation');
    assert.equal(await late, null);
    assert.equal(historyReads, readsBefore);
    releaseHook();
    await closing;
    assert.equal(hookFinished, true);
    assert.equal(store.monitors.size, 0);
  } finally {
    releaseHook();
    await monitor;
    await closing;
    await store.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});
