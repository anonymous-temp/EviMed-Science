import assert from 'node:assert/strict';
import test from 'node:test';
import { annotateSyntheticUser, normalizeSyntheticUser } from '../run/cases.mjs';
import { assertCase } from '../run/sets.mjs';
import { createMemoryClient } from '../run/lab.mjs';
import { ingestLiveSession, snapshotDiff } from '../run/liveTurns.mjs';
import { parseArguments, assertResumeCompatible } from '../run/run.mjs';

const at = '2026-01-01T00:00:00.000Z';
const session = { sessionId: 's001', at, project: null, messages: [
  { role: 'user', text: 'Earlier turn.' }, { role: 'assistant', text: 'Earlier reply.' },
  { role: 'user', text: 'Erase that.', liveTurn: 'forget' }, { role: 'assistant', text: 'RECORDED REPLY' },
  { role: 'user', text: 'Continue working.' }, { role: 'assistant', text: 'Other recorded reply.' },
] };
const snapshot = files => ({ files, metrics: { files: Object.keys(files).length, chars: 1 } });

test('synthetic structural offsets mark only the request and keep plant identities and values out of Case', () => {
  const raw = { userKey: 'X01', sessions: [session], questions: [{ qid: 'q1', afterSession: 1, asOf: at, text: 'Recall?' }] };
  const normalize = () => normalizeSyntheticUser(raw, { set: 'synthetic-users', split: 'dev', dirName: 'X01' });
  const skeleton = { plants: [{ id: 'DO-NOT-LEAK', category: 'forget', question: 'Recall?', anchor: 'HIDDEN-VALUE' }] };
  const schedule = { sessions: [{ id: 's001', index: 1 }], events: [{ plantId: 'DO-NOT-LEAK', kind: 'forget', session: 1, messageIndex: 2 }] };
  const item = annotateSyntheticUser(normalize(), skeleton, schedule);
  assert.equal(item.sessions[0].messages[2].liveTurn, 'forget');
  assert.equal(item.questions[0].category, 'forget');
  assert.equal(item.sessions[0].messages.filter(m => m.liveTurn).length, 1);
  assert.doesNotMatch(JSON.stringify(item), /DO-NOT-LEAK|HIDDEN-VALUE/);
  assertCase(item);
  delete schedule.events[0].messageIndex;
  const missing = annotateSyntheticUser(normalize(), skeleton, schedule);
  assert.equal(missing.meta.unlocatedLiveTurns, 1);
  assert.equal(missing.sessions[0].messages.some(m => m.liveTurn), false);
  schedule.events[0].messageIndex = 3;
  assert.throws(() => annotateSyntheticUser(normalize(), skeleton, schedule), /invalid forget messageIndex/);
});

test('live memory permits real JSON-RPC forget while remember and ordinary questions stay read-only', async () => {
  const calls = [];
  const memory = createMemoryClient({ base: 'http://gateway.invalid', token: 'test', executeForget: true,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body); calls.push(body);
      return { status: 200, headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ id: body.id, result: { content: [{ type: 'text', text: 'Real deletion' }] } }) };
    } });
  assert.equal((await memory.callTool('forget', { uri: 'viking://file' })).isError, false);
  assert.equal((await memory.callTool('remember', {})).isError, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'tools/call');
  assert.equal(calls[0].params.name, 'forget');
  assert.equal((await createMemoryClient({ base: 'http://gateway.invalid', token: 'test' }).callTool('forget', {})).isError, true);
});

async function replay(called) {
  const ingested = [], rows = [], order = [];
  let removed = false, answers = 0;
  const lab = {
    async ingestSession(user, value, options) { ingested.push(structuredClone(value)); order.push('settle'); return { sessionId: value.sessionId }; },
    async snapshot() { return snapshot(removed ? {} : { 'notes/fact.md': 'old fact' }); },
    memoryFor(user, options) { assert.equal(options.executeForget, true); return {}; },
  };
  const persist = async row => { const held = rows.findIndex(r => r.turnId === row.turnId); if (held < 0) rows.push(row); else rows[held] = row; };
  const answer = async input => {
    answers++; order.push('live');
    assert.equal(input.conversation.length, 2);
    assert.equal(input.question, 'Erase that.');
    assert.equal(input.asOf, '2026-01-01T00:00:02.000Z');
    removed = called;
    return { answer: 'ACTUAL REPLY', toolCalls: called ? [{ name: 'mcp__openviking__forget', executed: true,
      args: { uri: 'viking://file' }, blocks: ['Deleted'], isError: false }] : [], usage: {} };
  };
  const input = { lab, user: {}, session, caseId: 'X01', answer, records: rows, persist };
  await ingestLiveSession(input);
  assert.deepEqual(order, ['settle', 'live', 'settle']);
  assert.equal(ingested[0].messages.length, 2);
  assert.equal(ingested[1].messages[3].text, 'ACTUAL REPLY');
  assert.equal(ingested[1].messages[5].text, 'Other recorded reply.');
  assert.doesNotMatch(JSON.stringify(ingested), /RECORDED REPLY/);
  assert.equal(rows[0].forgetCalled, called);
  assert.equal(rows[0].state, 'settled');
  assert.deepEqual(rows[0].snapshotDiff, called ? { 'notes/fact.md': { before: 'old fact', after: null } } : {});
  await ingestLiveSession(input);
  assert.equal(answers, 1, 'resume never repeats the live mutation');
  rows[0].state = 'running';
  await assert.rejects(ingestLiveSession(input), /live_turn_incomplete/);
}
test('live replay settles the prefix, replaces one reply, records real calls and resumes without repeating them', () => replay(true));
test('model inaction is measured without forcing a forget call', () => replay(false));

test('snapshot diff distinguishes added, modified and removed files', () => {
  assert.deepEqual(snapshotDiff(snapshot({ a: 'old', b: 'same', c: 'gone' }), snapshot({ a: 'new', b: 'same', d: 'added' })),
    { a: { before: 'old', after: 'new' }, c: { before: 'gone', after: null }, d: { before: null, after: 'added' } });
});

test('opt-in is recorded and cannot change while resuming', () => {
  const base = ['--set', 'synthetic-users', '--split', 'dev', '--data', '/d', '--out', '/r', '--engine-url', 'http://localhost:1',
    '--engine-key-file', '/k', '--database-url-file', '/d', '--deepseek-key-file', '/k'];
  assert.equal(parseArguments(base).liveTurns, '');
  assert.equal(parseArguments([...base, '--live-turns', 'forget', '--question-category', 'forget']).liveTurns, 'forget');
  assert.throws(() => parseArguments([...base, '--live-turns', 'anything']), /--live-turns is forget/);
  assert.throws(() => parseArguments([...base, '--live-turns', 'forget', '--ingest-only']), /needs product replay/);
  assert.throws(() => assertResumeCompatible({ arm: 'product', set: 's', split: 'dev', options: { liveTurns: 'forget' } },
    { arm: 'product', set: 's', split: 'dev' }), /different live turns/);
});

