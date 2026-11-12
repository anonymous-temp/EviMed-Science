import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeManager } from '../src/runtimeManager.mjs';
import { wireRefusal } from '../src/dshRuntimeAdapter.mjs';

const notYet = () => wireRefusal(502, { code: 'runtime_wire_protocol_mismatch', message: 'Kernel answered HTTP 404 for patientMatching/status.' }, 'patientMatching/status', 'http_404');
const status = { enabled: true, skill: 'patient-matching', tools: [] };

function manager(answers, generation = () => 'g1') {
  const calls = [];
  return { calls, runtimeGeneration: generation, callKernel: async (_runtime, _project, method) => {
    calls.push(method); const next = answers.shift();
    if (next instanceof Error) throw next; return next;
  } };
}

test('a status route the kernel has not registered yet is waited out on the same runtime', async () => {
  const fake = manager([notYet(), notYet(), status]);
  assert.deepEqual(await RuntimeManager.prototype.patientMatchingStatus.call(fake, {}, {}, 'g1', 5000), status);
  assert.deepEqual(fake.calls, ['patientMatching/status', 'patientMatching/status', 'patientMatching/status']);
});

test('the wait ends at its limit, on any other refusal, and when the runtime was replaced', async () => {
  await assert.rejects(RuntimeManager.prototype.patientMatchingStatus.call(manager([notYet(), notYet(), notYet()]), {}, {}, 'g1', 0), /HTTP 404/);
  const other = wireRefusal(502, { code: 'runtime_wire_protocol_mismatch', message: 'Kernel answered HTTP 500 for patientMatching/status.' }, 'patientMatching/status', 'http_500');
  const failing = manager([other, status]);
  await assert.rejects(RuntimeManager.prototype.patientMatchingStatus.call(failing, {}, {}, 'g1', 5000), /HTTP 500/);
  assert.equal(failing.calls.length, 1);
  const replaced = manager([notYet(), status], () => 'g2');
  await assert.rejects(RuntimeManager.prototype.patientMatchingStatus.call(replaced, {}, {}, 'g1', 5000), /HTTP 404/);
  assert.equal(replaced.calls.length, 1);
});
