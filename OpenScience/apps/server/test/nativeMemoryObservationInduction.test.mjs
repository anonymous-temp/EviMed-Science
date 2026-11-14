import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeMemoryObservations } from '../src/nativeMemoryObservations.mjs';
const root = 'viking://user/test/memories';
const choice = { kind: 'format', scope: 'results tables', choice: 'Markdown', subject: 'work' };
const bullet = row => `- Choice: ${JSON.stringify(row)}`;
function fixture(entries, enabled = true) {
  const files = new Map(entries.map(entry => [`${root}/observations/${entry.name}.md`, bullet(entry.choice ?? choice)]));
  const calls = [];
  const overlay = {
    observationFiles: async () => [...files.keys()].map(uri => ({ uri })),
    revisionsOf: async (_user, uri) => entries.filter(entry => uri.endsWith(`/${entry.name}.md`)).map(entry => ({ actor: 'engine', change: entry.before ? 'updated' : 'added',
      engineSession: entry.session, archiveUri: `viking://user/test/sessions/${entry.session}/history/archive_001`,
      after: bullet(entry.choice ?? choice), before: entry.before ?? null, changedAt: '2026-11-14T12:00:00Z' })),
    conversationOf: async (_user, session) => session.replace('replay-', ''), originsOf: async () => new Map(),
    queueSummaryInvalidation: async () => [], completeSummaryInvalidation: async () => {}, addRevision: async () => {}, removeFile: async () => {},
  };
  const sessions = { memoryRoot: () => root, read: async (_user, uri) => {
    const source = entries.find(entry => entry.date && uri.endsWith(`/sessions/${entry.session}/history/archive_001/messages.jsonl`));
    return source ? JSON.stringify({ role: 'user', created_at: source.date, content: 'Use Markdown.' }) : files.get(uri) ?? null;
  },
    remove: async (_user, uri) => files.delete(uri), rebuildMemoryDirectory: async () => {} };
  const observations = new NativeMemoryObservations({ overlay, sessions, inductionEnabled: enabled,
    keepRepeatedChoice: async (...args) => { calls.push(args); return { archiveUri: 'promotion' }; } });
  return { observations, calls, files };
}
test('same typed choice in unrelated filenames promotes once with real conversation count and dates', async () => {
  const f = fixture([{ name: 'backpack', session: 'a' }, { name: 'mixed-models', session: 'b' }]);
  assert.equal((await f.observations.promote('user')).promoted, 1);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0][3], { choice, count: 2, dates: [] });
  assert.equal(f.calls[0][2].length, 2);
  assert.equal(f.files.size, 0);
});
test('same conversation, replay, distinct choices and excluded subjects never supply two demonstrations', async () => {
  for (const entries of [
    [{ name: 'a', session: 'one' }, { name: 'b', session: 'one' }],
    [{ name: 'a', session: 'one' }, { name: 'b', session: 'replay-one' }],
    [{ name: 'a', session: 'one' }, { name: 'b', session: 'two', choice: { ...choice, choice: 'CSV' } }],
    ...['person', 'health', 'money', 'belief'].map(subject => [{ name: 'a', session: 'one', choice: { ...choice, subject } }, { name: 'b', session: 'two', choice: { ...choice, subject } }]),
  ]) {
    const f = fixture(entries);
    assert.equal((await f.observations.promote('user')).promoted, 0);
    assert.equal(f.calls.length, 0);
  }
});
test('switch off preserves filename counting', async () => {
  const f = fixture([{ name: 'backpack', session: 'a' }, { name: 'mixed-models', session: 'b' }], false);
  assert.equal((await f.observations.promote('user')).promoted, 0);
});

test('carried-forward old choices and a contrary choice cannot create a new inference', async () => {
  const carried = fixture([{ name: 'first', session: 'a' }, { name: 'second', session: 'b', before: bullet(choice) }]);
  assert.equal((await carried.observations.promote('user')).promoted, 0);
  const contrary = fixture([{ name: 'first', session: 'a' }, { name: 'second', session: 'b' },
    { name: 'third', session: 'c', choice: { ...choice, choice: 'CSV' } }]);
  assert.equal((await contrary.observations.promote('user')).promoted, 0);
});
test('dates come from user messages, not processing time', async () => {
  const f = fixture([{ name: 'first', session: 'a', date: '2026-09-01T12:00:00Z' }, { name: 'second', session: 'b', date: '2026-09-03T12:00:00Z' }]);
  assert.equal((await f.observations.promote('user')).promoted, 1);
  assert.deepEqual(f.calls[0][3].dates, ['2026-09-01', '2026-09-03']);
});
