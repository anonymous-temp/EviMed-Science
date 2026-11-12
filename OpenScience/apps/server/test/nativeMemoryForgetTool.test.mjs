import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeMemoryStore } from '../src/nativeMemoryStore.mjs';
import { contentHash, lineFingerprint } from '../src/nativeMemoryOverlay.mjs';

const user = { id: 'u1' }, project = { id: 'named', userId: user.id };
const root = 'viking://user/u1', uri = `${root}/memories/preferences/format.md`;
const body = '- Use metric units.\n- Keep answers short.';

// The same in-memory sessions/overlay boundary as nativeMemoryReads; no database or model.
function fixture(enabled = true) {
  const files = new Map([[uri, body]]), rejections = [], revisions = [], historyCalls = [];
  let historyFailure = false;
  const sessions = { configured: true, engineUser: () => 'u1', userRoot: () => root, memoryRoot: () => `${root}/memories`,
    read: async (_owner, target) => files.get(target) ?? null,
    replace: async (_owner, target, text) => { files.set(target, text); return true; },
    remove: async (_owner, target) => files.delete(target), rebuildMemoryDirectory: async () => {} };
  const overlay = { configured: true, files: async () => new Map(), originsOf: async () => new Map(),
    reject: async (_owner, type, target, lines, options) => rejections.push({ type, uri: target, lines, options }),
    addRevision: async row => { revisions.push(row); return { ...row, id: 'revision', changedAt: '2026-11-12' }; },
    queueSummaryInvalidation: async () => [], completeSummaryInvalidation: async () => {},
    upsertFile: async () => {}, setSources: async () => {}, syncOrigins: async () => {}, removeFile: async () => {} };
  const store = new NativeMemoryStore({ sessions, overlay, forgetTargetsEnabled: enabled });
  store.files = async () => [...files].map(([target, text]) => ({ uri: target, body: text, hash: contentHash(text), type: 'preferences', projectId: null }));
  store.history = {
    rejectRemoved: async (_context, file, lines) => { if (historyFailure) throw new Error('history unavailable'); historyCalls.push({ file, lines }); },
    retireWriteSessions: async () => {}, drainDeletes: async () => {},
  };
  return { store, files, rejections, revisions, historyCalls, failHistory: value => { historyFailure = value; } };
}

test('a failed history scan activates no rejection and leaves a whole-file forget retryable', async () => {
  const f = fixture(); f.failHistory(true);
  await assert.rejects(f.store.forget(user, project, uri), /history unavailable/);
  assert.equal(f.files.get(uri), body);
  assert.deepEqual(f.rejections, []);
  assert.deepEqual(f.revisions, []);
  f.failHistory(false);
  assert.deepEqual(await f.store.forget(user, project, uri), { removed: true });
  assert.equal(f.files.has(uri), false);
  assert.equal(f.revisions.length, 1);
});

test('line forget reuses the edit revision and rejects only exact normalized removed lines', async () => {
  const f = fixture();
  const result = await f.store.forget(user, project, uri, { lines: ['  * USE  metric units. (as of 2026-11-12)'] , engineSession: 'dsh-turn' });
  assert.equal(result.removed, true); assert.equal(result.removedLines, 1);
  assert.equal(f.files.get(uri), '- Keep answers short.');
  assert.deepEqual(f.rejections.flatMap(row => row.lines).map(lineFingerprint), [lineFingerprint('Use metric units.')]);
  assert.deepEqual(f.historyCalls[0].lines, ['Use metric units.']);
  assert.equal(f.revisions[0].before, body); assert.equal(f.revisions[0].after, '- Keep answers short.');
  assert.equal(f.revisions[0].actor, 'conversation'); assert.equal(f.revisions[0].engineSession, 'dsh-turn');
});

test('one missing line refuses the entire selection and returns available lines for retry', async () => {
  const f = fixture();
  const result = await f.store.forget(user, project, uri, { lines: ['Use metric units.', 'short answers'] });
  assert.equal(result.removed, false);
  assert.deepEqual(result.missingLines, ['short answers']);
  assert.deepEqual(result.availableLines, ['Use metric units.', 'Keep answers short.']);
  assert.equal(f.files.get(uri), body); assert.deepEqual(f.rejections, []);
});

for (const lines of [undefined, [], ['Use metric units.', 'Keep answers short.']]) {
  test(`whole-file forget still removes every line (${JSON.stringify(lines)})`, async () => {
    const f = fixture();
    assert.equal((await f.store.forget(user, project, uri, { lines })).removed, true);
    assert.equal(f.files.has(uri), false);
  });
}

test('partial removal failure keeps the target and rejection inactive until retry', async () => {
  const f = fixture(); f.failHistory(true);
  await assert.rejects(f.store.forget(user, project, uri, { lines: ['Use metric units.'] }), /history unavailable/);
  assert.equal(f.files.get(uri), body); assert.deepEqual(f.rejections, []);
  f.failHistory(false);
  await f.store.forget(user, project, uri, { lines: ['Use metric units.'] });
  assert.equal(f.files.get(uri), '- Keep answers short.');
});

test('a history-only statement gets the existing rejection and revision, without an engine deletion', async () => {
  const f = fixture();
  const result = await f.store.forget(user, project, null, { statement: 'My old project is M-41633.', engineSession: 'dsh-turn' });
  assert.equal(result.removed, false); assert.equal(result.historyRejected, true);
  assert.deepEqual([...f.files], [[uri, body]]);
  assert.deepEqual(f.rejections[0].lines, ['My old project is M-41633.']);
  assert.equal(f.historyCalls.length, 1); assert.equal(f.revisions[0].engineSession, 'dsh-turn');
  assert.equal(f.revisions[0].change, 'deleted');
});

test('a history-only failure is retryable without an active rejection or a success revision', async () => {
  const f = fixture(); f.failHistory(true);
  await assert.rejects(f.store.forget(user, project, null, { statement: 'Old project.' }), /history unavailable/);
  assert.deepEqual(f.rejections, []); assert.deepEqual(f.revisions, []);
  f.failHistory(false);
  assert.equal((await f.store.forget(user, project, null, { statement: 'Old project.' })).historyRejected, true);
});

test('targeted forgetting is opt-in and refuses unsupported arguments rather than deleting a whole file', async () => {
  const f = fixture(false);
  for (const [target, options] of [[uri, { lines: ['Use metric units.'] }], [null, { statement: 'Old project.' }]]) {
    await assert.rejects(f.store.forget(user, project, target, options), error => error.code === 'memory_payload_invalid');
  }
  assert.equal(f.files.get(uri), body); assert.deepEqual(f.rejections, []);
  assert.deepEqual(await f.store.forget(user, project, uri), { removed: true });
});
