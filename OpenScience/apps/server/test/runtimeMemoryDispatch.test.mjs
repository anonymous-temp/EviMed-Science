import test from 'node:test';
import assert from 'node:assert/strict';
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
});
