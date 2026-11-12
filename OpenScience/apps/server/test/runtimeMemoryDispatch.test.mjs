import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentRunStore } from '../src/agentRuns.mjs';
import { HttpError } from '../src/security.mjs';
import { RuntimeManager } from '../src/runtimeManager.mjs';
import { withProjectStorageMutation } from '../src/security.mjs';
import { withSessionPromptAdmission } from '../src/runtimePromptAdmission.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(enabled = true) {
  const project = { userId: 'owner', id: 'memory-dispatch' }, manager = new RuntimeManager({ memoryRuntimeLockIsolationEnabled: enabled, runtimePromptAdmissionTimeoutMs: 2000 });
  manager.runtimes.set(manager.key(project), {});
  manager.runtimeGeneration = () => 'generation';
  manager.contextPolicyFor = async () => ({ kind: 'owned' });
  for (const method of ['assertInteractiveRuntimeAvailable', 'assertPersonalSkillPromptGeneration', 'refreshCapsuleMethods',
    'writePromptAttendance', 'enforceProjectQuota', 'assertContextPolicyGeneration', 'beginProxy', 'endProxy']) manager[method] = async () => {};
  return { project, manager };
}

test('gateway source receipts can append while dispatch awaits the kernel, and the same session stays fenced', async () => {
  const { project, manager } = fixture(), entered = deferred(), ack = deferred();
  let receiptWritten = false, competingEntered = false;
  manager.callKernel = async (_runtime, _project, method) => {
    if (method !== 'session/prompt') return {};
    // server.sourceReceipt -> AgentRuns.recordLearning takes this exact lock.
    const receipt = withProjectStorageMutation(project, async () => { receiptWritten = true; });
    let timer;
    try {
      await Promise.race([receipt, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('memory receipt waited on the prompt acknowledgement')), 100); })]);
      entered.resolve(); await ack.promise;
    } finally { clearTimeout(timer); }
    return {};
  };
  const pending = manager.dispatchAdmittedPrompt(project, 'root', { text: 'Hello', unattended: false });
  let competitor;
  try {
    await Promise.race([entered.promise, pending]);
    assert.equal(receiptWritten, true);
    competitor = withSessionPromptAdmission(manager, project, 'root', async () => { competingEntered = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(competingEntered, false);
  } finally { ack.resolve(); await pending; await competitor; }
});

test('different dispatched sessions can both await acknowledgements after their final ledger checks', async () => {
  const { project, manager } = fixture(), ack = deferred(), ready = [deferred(), deferred()];
  manager.callKernel = async (_runtime, _project, method, args) => {
    if (method === 'session/prompt') { ready[Number(args.request.sessionId.slice(-1))].resolve(); await ack.promise; }
    return {};
  };
  const pending = [0, 1].map(index => manager.dispatchAdmittedPrompt(project, `root${index}`, { text: 'Hello', unattended: false }));
  let timer;
  try {
    await Promise.race([Promise.all(ready.map(item => item.promise)), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('different sessions waited for another acknowledgement')), 100);
    })]);
  } finally { clearTimeout(timer); ack.resolve(); await Promise.all(pending); }
});


test('isolation off retains the previous acknowledgement fence; rejected final checks never send', async () => {
  const { project, manager } = fixture(false), entered = deferred(), ack = deferred();
  let receiptWritten = false, prompts = 0;
  manager.callKernel = async (_runtime, _project, method) => {
    if (method === 'session/prompt') { prompts++; entered.resolve(); await ack.promise; }
    return {};
  };
  const pending = manager.dispatchAdmittedPrompt(project, 'root', { text: 'Hello', unattended: false });
  await entered.promise;
  const receipt = withProjectStorageMutation(project, async () => { receiptWritten = true; });
  try { await new Promise(resolve => setImmediate(resolve)); assert.equal(receiptWritten, false); }
  finally { ack.resolve(); await pending; await receipt; }
  manager.config.memoryRuntimeLockIsolationEnabled = true;
  await assert.rejects(manager.dispatchAdmittedPrompt(project, 'root', { text: 'Hello', unattended: false,
    beforePrompt: async () => { throw new Error('superseded'); } }), /superseded/);
  assert.equal(prompts, 1, 'failed final checks still precede every wire send');
  // This same case must also prove that switching on releases the ledger.
  manager.callKernel = async (_runtime, _project, method) => {
    if (method === 'session/prompt') await withProjectStorageMutation(project, async () => { receiptWritten = true; });
    return {};
  };
  receiptWritten = false;
  await manager.dispatchAdmittedPrompt(project, 'next', { text: 'Hello', unattended: false });
  assert.equal(receiptWritten, true);

});


for (const code of ['runtime_prompt_admission_busy', 'memory_context_publication_busy']) test(`${code} rejects the real run immediately and releases its session for retry`, async t => {
  const { manager, project } = fixture();
  const root = await mkdtemp(path.join(tmpdir(), 'dispatch-refusal-'));
  Object.assign(project, { rootDir: root, workspaceDir: path.join(root, 'workspace'), metaDir: path.join(root, 'meta') });
  await mkdir(project.workspaceDir); await mkdir(project.metaDir);
  const binding = { sessionId: 'root', mode: 'open-domain', agentId: null, agentVersion: null, runtimeAgent: null };
  const ledger = new AgentRunStore({ get: async () => binding }, { model: 'fixture', readSessionHistory: async () => [] });
  ledger.scheduleMonitor = () => {};
  t.after(async () => { await ledger.closeProject(project); await rm(root, { recursive: true, force: true }); });
  let busy = true, sent = 0;
  manager.ensureContextPolicyGeneration = async () => {
    if (busy && code === 'memory_context_publication_busy') throw new HttpError(409, code, 'Busy');
    return { pending: false };
  };
  manager.pluginService = { withAdmission: async (_project, operation) => {
    if (busy && code === 'runtime_prompt_admission_busy') throw new HttpError(409, code, 'Busy');
    return operation();
  } };
  manager.callKernel = async () => { sent++; return {}; };
  const dispatch = dispatchId => ledger.dispatch(project, { sessionId: 'root', dispatchId }, () => manager.dispatchPrompt(project, 'root', { text: 'Hello' }));
  await assert.rejects(dispatch('first'), { code, definitivelyRejected: true });
  const [failed] = await ledger.list(project);
  assert.equal(failed.status, 'failed'); assert.equal(failed.dispatchStatus, 'rejected'); assert.equal(sent, 0);
  busy = false;
  const retry = await dispatch('retry');
  assert.equal(retry.dispatchStatus, 'accepted'); assert.notEqual(retry.id, failed.id);
});


test('a stop admission failure still writes the real durable intent before cancellation can proceed', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'stop-admission-failure-'));
  const project = { userId: 'owner', id: 'project', rootDir: root, workspaceDir: path.join(root, 'workspace'), metaDir: path.join(root, 'meta') };
  await mkdir(project.workspaceDir); await mkdir(project.metaDir);
  const binding = { sessionId: 'root', mode: 'open-domain', agentId: null, agentVersion: null, runtimeAgent: null };
  const ledger = new AgentRunStore({ get: async () => binding }, { model: 'fixture', readSessionHistory: async () => [],
    withPromptAdmission: async () => { throw new HttpError(409, 'runtime_prompt_admission_busy', 'Admission unavailable'); } });
  t.after(async () => { await ledger.closeProject(project); await rm(root, { recursive: true, force: true }); });
  const { run } = await ledger.reserveRun(project, binding, { baselineCursor: null });
  assert.equal(await ledger.noteStopRequest(project, { sessionId: binding.sessionId }), run.id);
  assert.equal(await ledger.promptStopRequested(project, binding.sessionId, run.id), true);
});
