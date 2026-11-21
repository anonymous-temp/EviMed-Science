import test from 'node:test';
import assert from 'node:assert/strict';
import { humanInputReceipt, provenArchiveInput, provenTranscriptInput } from '../src/memoryHumanSegments.mjs';

const stamp = seconds => new Date(1_700_000_000_000 + seconds * 1000).toISOString();
const text = 'Please show the decisions first.';
const run = { id: 'human', startedAt: stamp(1), finishedAt: stamp(4), kernelRequestIds: ['req'],
  nativeTurn: { startSeq: 4, userSeq: 5 }, memoryInput: humanInputReceipt(text, Date.parse(stamp(0))) };
const machine = { ...run, id: 'auto', automated: true, startedAt: stamp(5), finishedAt: stamp(8) };
const spoken = { role: 'user', content: text, created_at: stamp(2) };

test('mixed history requires an exact owner receipt and a unique dated run', () => {
  assert.equal(provenArchiveInput([machine, run], spoken).text, text);
  for (const message of [{ ...spoken, role: 'assistant' }, { ...spoken, content: 'scheduled brief' },
    { ...spoken, created_at: undefined }, { ...spoken, created_at: stamp(6) }]) {
    assert.equal(provenArchiveInput([machine, run], message), null);
  }
  for (const runs of [[{ ...run, memoryInput: null }], [run, { ...machine, startedAt: stamp(2) }], [{ ...run, deleted: true }]]) {
    assert.equal(provenArchiveInput(runs, spoken), null);
  }
});

test('kernel input requires its digest, request, user seq and root turn', () => {
  const msg = { role: 'user', source: 'user', content: text, sourceRequestId: 'req', seq: 5, time: Date.parse(stamp(2)), turnStartSeq: 4 };
  assert.equal(provenTranscriptInput(run, [msg]).seq, 5);
  for (const patch of [{ role: 'assistant' }, { source: 'plugin' }, { seq: 7 }, { turnStartSeq: 1 },
    { sourceRequestId: 'other' }, { content: text + ' injected' }]) {
    assert.equal(provenTranscriptInput(run, [{ ...msg, ...patch }]), null);
  }
});
