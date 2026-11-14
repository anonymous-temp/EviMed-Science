import assert from 'node:assert/strict';
import test from 'node:test';
import { MEMORY_SUMMARY_NAMES, memorySummaryDirectories, withMemorySummaryInvalidation, drainMemorySummaryInvalidations } from '../src/nativeMemorySummaries.mjs';

const root = 'viking://user/test/memories';
function fixture() {
  const files = new Map(), pending = new Map(), calls = [];
  let generation = 0;
  const overlay = {
    async queueSummaryInvalidation(_user, directories) {
      const tickets = directories.map(directory => ({ directory, generation: String(++generation) }));
      for (const ticket of tickets) pending.set(ticket.directory, ticket.generation);
      calls.push('queued'); return tickets;
    },
    async pendingSummaryInvalidations() { return [...pending].map(([directory, pendingGeneration]) => ({ directory, generation: pendingGeneration })); },
    async completeSummaryInvalidation(_user, tickets) {
      for (const ticket of tickets) if (pending.get(ticket.directory) === ticket.generation) pending.delete(ticket.directory);
    },
  };
  const sessions = {
    memoryRoot: () => root,
    async remove(_user, uri, options) { calls.push(`delete:${uri}`); assert.equal(options.wait, true); files.delete(uri); },
    async rebuildMemoryDirectory(_user, directory) { calls.push(`rebuild:${directory}`); },
  };
  return { sessions, overlay, files, pending, calls };
}

test('ancestor chain is bottom-up, bounded by the exact memory root, including root files', () => {
  assert.deepEqual(memorySummaryDirectories(`${root}/preferences/corrections/nested/a.md`, root), [`${root}/preferences/corrections/nested`, `${root}/preferences/corrections`, `${root}/preferences`, root]);
  assert.deepEqual(memorySummaryDirectories(`${root}/profile.md`, root), [root]);
  assert.deepEqual(memorySummaryDirectories(root, root), [root]);
  for (const uri of [`${root}-other/a.md`, 'viking://user/other/memories/a.md', `${root}/../a.md`]) assert.throws(() => memorySummaryDirectories(uri, root));
});

test('queue precedes mutation, all sidecars leave before bottom-up semantic rebuild, acknowledgement is last', async () => {
  const f = fixture(), uri = `${root}/entities/deep/a.md`, directories = memorySummaryDirectories(uri, root);
  for (const directory of directories) for (const name of MEMORY_SUMMARY_NAMES) f.files.set(`${directory}/${name}`, 'REMOVED');
  f.files.set(`${root}/preferences/.overview.md`, 'unrelated');
  const result = await withMemorySummaryInvalidation(f.sessions, f.overlay, 'test', uri, async () => { f.calls.push('mutation'); return 42; });
  assert.equal(result, 42);
  assert.deepEqual(f.calls.slice(0, 2), ['queued', 'mutation']);
  const firstRebuild = f.calls.findIndex(call => call.startsWith('rebuild:'));
  assert.equal(firstRebuild, 2 + 2 * directories.length);
  assert.deepEqual(f.calls.slice(firstRebuild), directories.map(directory => `rebuild:${directory}`));
  assert.deepEqual([...f.files], [[`${root}/preferences/.overview.md`, 'unrelated']]);
  assert.equal(f.pending.size, 0);
});

for (const phase of ['mutation', 'delete', 'rebuild']) test(`a ${phase} failure leaves durable maintenance for idempotent crash recovery`, async () => {
  const f = fixture(), uri = `${root}/entities/a.md`;
  const remove = f.sessions.remove, rebuild = f.sessions.rebuildMemoryDirectory;
  if (phase === 'delete') f.sessions.remove = async () => { throw new Error('offline'); };
  if (phase === 'rebuild') f.sessions.rebuildMemoryDirectory = async () => { throw new Error('offline'); };
  await assert.rejects(withMemorySummaryInvalidation(f.sessions, f.overlay, 'test', uri, async () => { if (phase === 'mutation') throw new Error('offline'); }));
  assert.equal(f.pending.size, 2);
  f.sessions.remove = remove; f.sessions.rebuildMemoryDirectory = rebuild;
  assert.equal(await drainMemorySummaryInvalidations(f.sessions, f.overlay, 'test'), 2);
  assert.equal(await drainMemorySummaryInvalidations(f.sessions, f.overlay, 'test'), 0);
});

test('semantic rebuild uses the native bounded API and refuses incomplete or failed maintenance', async () => {
  const { OpenVikingSessions } = await import('../src/openVikingSessions.mjs');
  const calls = [];
  let result = { status: 'completed', failed_records: 0, queue_status: {} };
  const sessions = new OpenVikingSessions({ configured: true, request: async input => { calls.push(input); return { result }; } });
  const directory = `${sessions.memoryRoot('test')}/entities`;
  assert.equal(await sessions.rebuildMemoryDirectory('test', directory), true);
  assert.deepEqual(calls[0].body, { uri: directory, mode: 'semantic_and_vectors', recursive: false, wait: true });
  assert.equal(calls[0].path, '/api/v1/content/reindex');
  assert.equal(calls[0].userId, 'test');
  for (const invalid of [null, { status: 'running' }, { status: 'completed', failed_records: 1 }, { status: 'completed', queue_status: { Semantic: { error_count: 1 } } }]) {
    result = invalid;
    await assert.rejects(sessions.rebuildMemoryDirectory('test', directory), { code: 'memory_summary_rebuild_failed' });
  }
  await assert.rejects(sessions.rebuildMemoryDirectory('test', 'viking://user/other/memories/entities'), { code: 'memory_scope_denied' });
});

test('deferred mode withdraws every ancestor sidecar before answering and coalesces work across restart', async () => {
  const f = fixture(), uri = `${root}/notes/a.md`;
  f.overlay.deferredSummaryRebuildEnabled = true;
  for (const directory of memorySummaryDirectories(uri, root)) for (const name of MEMORY_SUMMARY_NAMES) f.files.set(`${directory}/${name}`, 'removed');
  f.sessions.rebuildMemoryDirectory = async () => { throw new Error('rebuild must not delay the answer'); };
  await withMemorySummaryInvalidation(f.sessions, f.overlay, 'test', uri, async () => { f.files.set(uri, 'retained'); });
  assert.deepEqual([...f.files], [[uri, 'retained']]);
  assert.equal(f.pending.size, 2);
  await withMemorySummaryInvalidation(f.sessions, f.overlay, 'test', uri, async () => { f.files.set(uri, 'newer retained'); });
  assert.equal(f.pending.size, 2);
  await assert.rejects(drainMemorySummaryInvalidations(f.sessions, f.overlay, 'test'), /rebuild must not delay/);
  assert.equal(f.pending.size, 2);
  // A new worker has only the persistent tickets and current engine bytes.
  const restarted = { ...f.sessions, rebuildMemoryDirectory: async (_user, directory) => {
    f.files.set(`${directory}/.overview.md`, f.files.get(uri));
  } };
  assert.equal(await drainMemorySummaryInvalidations(restarted, f.overlay, 'test'), 2);
  assert.equal(f.files.get(`${root}/.overview.md`), 'newer retained');
  assert.equal(await drainMemorySummaryInvalidations(restarted, f.overlay, 'test'), 0);
});

test('late extraction bytes cannot recall a withdrawn line before settlement, and settled reauthorization stays visible', async () => {
  const { fenceWithdrawnMemoryBody } = await import('../src/nativeMemorySummaries.mjs');
  const { lineFingerprint } = await import('../src/nativeMemoryOverlay.mjs');
  let settled = '- Keep green folders.';
  const overlay = { deferredSummaryRebuildEnabled: true,
    removals: async () => [{ fingerprint: lineFingerprint('Old booking.'), text: 'Old booking.' }],
    file: async () => ({ body: settled }) };
  const late = '- Old booking.\n- Keep green folders.\n- New unrelated fact.';
  assert.equal(await fenceWithdrawnMemoryBody(overlay, 'test', `${root}/notes/a.md`, late), '- Keep green folders.\n- New unrelated fact.');
  settled = late;
  assert.equal(await fenceWithdrawnMemoryBody(overlay, 'test', `${root}/notes/a.md`, late), late);
  settled = '';
  assert.equal(await fenceWithdrawnMemoryBody(overlay, 'test', `${root}/notes/a.md`, '- Old booking.'), null);
  overlay.deferredSummaryRebuildEnabled = false;
  assert.equal(await fenceWithdrawnMemoryBody(overlay, 'test', `${root}/notes/a.md`, late), late);
});
