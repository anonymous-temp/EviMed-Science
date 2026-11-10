import assert from 'node:assert/strict';
import test from 'node:test';
import { MEMORY_SUMMARY_NAMES, memorySummaryDirectories, withMemorySummaryInvalidation } from '../src/nativeMemorySummaries.mjs';
import { withNativeMemoryWrite } from '../src/nativeMemoryWriteFence.mjs';
import { NativeMemoryVerification } from '../src/nativeMemoryVerification.mjs';
import { nativeIntegration } from './helpers/nativeFixture.mjs';

const { fixture, options } = nativeIntegration();
const marker = 'P19-REMOVED';
function summaries(f, uri) {
  const directories = memorySummaryDirectories(uri, f.root);
  for (const directory of directories) for (const name of MEMORY_SUMMARY_NAMES) f.stub.files.set(`${directory}/${name}`, marker);
  return directories;
}
async function clean(f, directories) {
  for (const directory of directories) for (const name of MEMORY_SUMMARY_NAMES) assert.equal(f.stub.files.get(`${directory}/${name}`)?.includes(marker) ?? false, false, `${directory}/${name}`);
  assert.deepEqual(await f.overlay.pendingSummaryInvalidations(f.userId), []);
  const rebuilt = f.stub.requests.filter(r => r.path === '/api/v1/content/reindex');
  for (const directory of directories) assert.ok(rebuilt.some(r => r.body.uri === directory && r.body.recursive === false && r.body.wait === true));
}

for (const path of ['forget', 'page-edit', 'page-delete']) test(`${path} invalidates both summaries through every ancestor`, options, async t => {
  const f = await fixture(t), uri = f.seed('preferences/corrections/deep/fact.md', `- ${marker}\n- Keep green folders.`, { type: 'corrections' });
  const directories = summaries(f, uri);
  const record = (await f.store.records(f.userId)).find(candidate => candidate.uri === uri);
  if (path === 'forget') await f.store.forget({ id: f.userId }, { id: 'default' }, uri);
  else if (path === 'page-delete') await f.store.remove(f.userId, record.id);
  else await f.store.update(f.userId, record.id, { value: 'Keep green folders.', expectedVersion: record.version });
  await clean(f, directories);
});

test('conversation source deletion invalidates summaries of removed and edited derived files', options, async t => {
  const f = await fixture(t, { extract: ({ user }) => ({ adds: [
    { uri: `viking://user/${user}/memories/entities/deep/source.md`, memory_type: 'entities', after: `- ${marker}` },
  ] }) });
  await f.commitConversation('source', [{ role: 'user', text: marker }], { projectId: 'default' });
  await f.worker.processCommits({ userId: f.userId });
  const uri = `${f.root}/entities/deep/source.md`, directories = summaries(f, uri);
  await f.store.removeConversationSource(f.userId, 'default', ['session_source']);
  assert.equal(await f.sessions.read(f.userId, uri), null);
  await clean(f, directories);
});

for (const whole of [false, true]) test(`worker refused-line cleanup ${whole ? 'deletes' : 'rewrites'} with ancestor invalidation`, options, async t => {
  const f = await fixture(t, { extract: ({ user }) => ({ adds: [{ uri: `viking://user/${user}/memories/entities/deep/fact.md`, memory_type: 'entities', after: `- ${marker}${whole ? '' : '\n- Keep green folders.'}` }] }) });
  const uri = `${f.root}/entities/deep/fact.md`;
  await f.overlay.reject(f.userId, 'entities', uri, [marker]);
  await f.commitConversation('refused', [{ role: 'user', text: 'Other unrelated information.' }]);
  const directories = summaries(f, uri);
  await f.worker.processCommits({ userId: f.userId });
  assert.equal((await f.sessions.read(f.userId, uri))?.includes(marker) ?? false, false);
  await clean(f, directories);
});

test('verifier correction invalidates summaries and retains its undoable revision', options, async t => {
  const f = await fixture(t), uri = f.seed('entities/deep/fact.md', `- ${marker}\n- Keep green folders.`, { type: 'entities' }), directories = summaries(f, uri);
  const verification = new NativeMemoryVerification({ config: f.config, sessions: f.sessions, overlay: f.overlay });
  await verification.write(f.userId, { uri, type: 'entities', body: await f.sessions.read(f.userId, uri) }, '- Corrected statement.\n- Keep green folders.', 'verified correction');
  await clean(f, directories);
  assert.ok((await f.overlay.revisionsOf(f.userId, uri))[0].before.includes(marker));
});

for (const change of ['delete', 'update']) test(`consolidation ${change} ingests ancestor cleanup before completing`, options, async t => {
  const f = await fixture(t), uri = f.seed('entities/deep/fact.md', `- ${marker}`, { type: 'entities' }), directories = summaries(f, uri);
  await f.overlay.upsertFile({ userId: f.userId, uri, memoryType: 'entities', body: `- ${marker}` });
  if (change === 'delete') f.stub.files.delete(uri); else f.stub.files.set(uri, '- Keep green folders.');
  await f.worker.ingestConsolidation(f.userId, { taskId: `p19-${change}-task`, deletes: change === 'delete' ? [uri] : [], updates: change === 'update' ? [uri] : [] });
  await clean(f, directories);
});

test('summary ticket survives engine mutation plus caller rollback; the worker retries after restart', options, async t => {
  const f = await fixture(t), uri = f.seed('entities/deep/fact.md', marker, { type: 'entities' }), directories = summaries(f, uri);
  const request = f.sessions.rebuildMemoryDirectory.bind(f.sessions);
  f.sessions.rebuildMemoryDirectory = async () => { throw new Error('engine offline'); };
  await assert.rejects(f.database.transaction(async () => {
    await f.overlay.noteRegistered(f.userId); // The caller may already hold its native account row.
    return withMemorySummaryInvalidation(f.sessions, f.overlay, f.userId, uri, () => f.sessions.remove(f.userId, uri));
  }));
  assert.equal(await f.sessions.read(f.userId, uri), null);
  assert.equal((await f.overlay.pendingSummaryInvalidations(f.userId)).length, directories.length);
  f.sessions.rebuildMemoryDirectory = request;
  await f.worker.drainSummaryInvalidations(f.userId);
  await clean(f, directories);
});

test('an old acknowledgement cannot clear a newer concurrent mutation', options, async t => {
  const f = await fixture(t), directory = `${f.root}/entities`;
  const first = await f.overlay.queueSummaryInvalidation(f.userId, [directory]);
  const second = await f.overlay.queueSummaryInvalidation(f.userId, [directory]);
  await f.overlay.completeSummaryInvalidation(f.userId, first);
  assert.deepEqual(await f.overlay.pendingSummaryInvalidations(f.userId), second);
  await f.overlay.completeSummaryInvalidation(f.userId, second);
});

test('worker maintenance cannot overtake an active writer', options, async t => {
  const f = await fixture(t);
  await f.overlay.queueSummaryInvalidation(f.userId, [f.root]);
  await withNativeMemoryWrite(f.database, f.userId, async () => {
    await assert.rejects(f.worker.drainSummaryInvalidations(f.userId), { code: 'memory_source_cleanup_busy' });
    assert.equal((await f.overlay.pendingSummaryInvalidations(f.userId)).length, 1);
  });
  await f.worker.drainSummaryInvalidations(f.userId);
});

for (const path of ['reset', 'project-delete']) test(`${path} invalidates surviving ancestor summaries`, options, async t => {
  const f = await fixture(t), uri = f.seed('entities/deep/fact.md', marker, { type: 'entities', tags: ['project=project-a'] }), directories = summaries(f, uri);
  await f.overlay.upsertFile({ userId: f.userId, uri, memoryType: 'entities', body: marker, projectId: 'project-a' });
  if (path === 'reset') await f.store.reset(f.userId); else await f.store.deleteProject(f.userId, 'project-a');
  assert.equal(await f.sessions.read(f.userId, uri), null);
  // Recursive removals take child sidecars with them; only surviving ancestors need reindexing.
  for (const directory of directories) for (const name of MEMORY_SUMMARY_NAMES) assert.equal(f.stub.files.has(`${directory}/${name}`), false);
  assert.deepEqual(await f.overlay.pendingSummaryInvalidations(f.userId), []);
});

test('observation promotion removes its ancestor summaries through the same helper', options, async t => {
  const { NativeMemoryObservations } = await import('../src/nativeMemoryObservations.mjs');
  const f = await fixture(t), uri = f.seed('observations/style.md', `- ${marker}`, { type: 'observations' }), directories = summaries(f, uri);
  await f.overlay.upsertFile({ userId: f.userId, uri, memoryType: 'observations', body: `- ${marker}` });
  for (const session of ['dsh-session_one', 'dsh-session_two']) await f.overlay.addRevision({ userId: f.userId, uri, memoryType: 'observations', change: 'updated', actor: 'engine', before: '', after: `- ${marker}`, engineSession: session });
  const observations = new NativeMemoryObservations({ sessions: f.sessions, overlay: f.overlay, keepRepeatedChoice: async () => {} });
  const result = await observations.promote(f.userId);
  assert.equal(result.promoted, 1);
  await clean(f, directories);
});

test('extraction deletes and rewrites invalidate summaries even when the engine performed the mutation', options, async t => {
  const f = await fixture(t), uri = f.seed('entities/deep/fact.md', marker, { type: 'entities' });
  const commit = await f.commitConversation('engine', [{ role: 'user', text: 'Independent.' }]);
  for (const operation of ['updates', 'deletes']) {
    const directories = summaries(f, uri);
    if (operation === 'updates') f.stub.files.set(uri, '- Keep green folders.'); else f.stub.files.delete(uri);
    await f.worker.ingest(await f.overlay.commit(f.userId, commit.archive_uri), { operations: { [operation]: [{ uri, before: marker, after: '- Keep green folders.', deleted_content: marker }] } });
    await clean(f, directories);
  }
});

test('a refused-file deletion keeps its commit pending until crash recovery clears the summaries', options, async t => {
  const f = await fixture(t, { extract: ({ user }) => ({ adds: [{ uri: `viking://user/${user}/memories/entities/deep/fact.md`, memory_type: 'entities', after: `- ${marker}` }] }) });
  const uri = `${f.root}/entities/deep/fact.md`;
  await f.overlay.reject(f.userId, 'entities', uri, [marker]);
  const committed = await f.commitConversation('crash', [{ role: 'user', text: 'Unrelated.' }]);
  summaries(f, uri);
  const rebuild = f.sessions.rebuildMemoryDirectory.bind(f.sessions);
  f.sessions.rebuildMemoryDirectory = async () => { throw new Error('maintenance unavailable'); };
  assert.equal(await f.worker.processCommits({ userId: f.userId }), 0);
  assert.equal(await f.sessions.read(f.userId, uri), null);
  assert.equal(await f.worker.processCommits({ userId: f.userId }), 0, 'a retry cannot complete just because the deleted file is now absent');
  assert.equal((await f.overlay.commit(f.userId, committed.archive_uri)).state, 'pending');
  f.sessions.rebuildMemoryDirectory = rebuild;
  await f.worker.drainSummaryInvalidations(f.userId);
  assert.equal(await f.worker.processCommits({ userId: f.userId }), 1);
  assert.equal((await f.overlay.commit(f.userId, committed.archive_uri)).state, 'completed');
});
