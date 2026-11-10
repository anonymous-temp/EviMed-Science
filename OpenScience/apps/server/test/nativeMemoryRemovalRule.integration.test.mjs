import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeIntegration } from './helpers/nativeFixture.mjs';
import { nativeFileId } from '../src/nativeMemoryStore.mjs';
import { NativeMemoryWorker } from '../src/nativeMemoryWorker.mjs';

const { fixture, options } = nativeIntegration();
const old = '2026-01-01T00:00:00.000Z';
const fresh = '2099-01-01T00:00:00.000Z';

for (const removal of ['forget', 'page-edit', 'page-delete']) {
  test(`${removal}: two removed files cannot return as a project filename/title from the same old conversation; a later restatement is learnable`, options, async t => {
    const f = await fixture(t);
    const fact = 'My weekly report title is M-41633.';
    const a = f.seed('preferences/self/title.md', `- ${fact}`, { type: 'preferences' });
    const b = f.seed('projects/m-41633 project.md', `# M-41633 project\n- ${fact}`, { type: 'project_context' });
    for (const uri of [a, b]) {
      if (removal === 'page-edit') await f.store.update(f.userId, nativeFileId(uri), { value: '- New value.', expectedVersion: (await f.store.getRecord(f.userId, nativeFileId(uri))).version });
      else await f.store.remove(f.userId, nativeFileId(uri), { keepText: removal === 'forget', actor: 'user' });
    }
    const uri = `${f.root}/projects/m-41633_研发项目.md`;
    const body = '# M-41633 project\n## M-41633\n- Goal: M-41633\n- Retained independent fact.';
    f.stub.extract = () => ({ adds: [{ uri, memory_type: 'project_context', after: body }] });
    await f.commitConversation('same', [{ role: 'user', text: fact, at: old }, { role: 'user', text: 'Please forget that.', at: fresh }]);
    await f.worker.processCommits({ userId: f.userId });
    assert.equal(await f.sessions.read(f.userId, uri), null);
    const files = await f.overlay.files(f.userId);
    const neutral = [...files.values()].find(file => file.uri.includes('/memory-'));
    assert.ok(neutral, 'independent content survives under a neutral name');
    assert.equal(neutral.body, '- Retained independent fact.');
    assert.ok((await f.overlay.removals(f.userId)).length, 'refusal never erases the removal');
    await f.commitConversation('same', [{ role: 'user', text: fact, at: old }, { role: 'user', text: fact, at: fresh }]);
    await f.worker.processCommits({ userId: f.userId });
    assert.equal(await f.sessions.read(f.userId, uri), body, 'only the message after removal authorizes relearning');
    // A late old extraction still cannot use that later authorization globally.
    await f.commitConversation('old-delayed', [{ role: 'user', text: fact, at: old }]);
    await f.worker.processCommits({ userId: f.userId });
    assert.equal(await f.sessions.read(f.userId, uri), null);
  });
}

test('a no-hard-token paraphrase uses the rejection judge with only messages after removal', options, async t => {
  const f = await fixture(t);
  await f.overlay.reject(f.userId, 'preferences', `${f.root}/preferences/old.md`, ['Prefers tables for comparisons.']);
  const uri = `${f.root}/people/new.md`;
  f.stub.extract = () => ({ adds: [{ uri, memory_type: 'people', after: '- Likes comparisons presented as tables.' }] });
  const requests = [];
  const judge = { same: async request => { requests.push(request); return { same: new Map([[0, request.candidates[0].removed[0].fingerprint]]), stated: new Set([0]) }; } };
  const worker = new NativeMemoryWorker({ ...f, rejectionJudge: judge });
  await f.commitConversation('old', [{ role: 'user', text: 'Please put comparisons in tables.', at: old }]);
  await worker.processCommits({ userId: f.userId });
  assert.equal(await f.sessions.read(f.userId, uri), null);
  assert.deepEqual(requests[0].said, []);
  await f.commitConversation('new', [{ role: 'user', text: 'Please put comparisons in tables.', at: fresh }]);
  await worker.processCommits({ userId: f.userId });
  assert.equal(await f.sessions.read(f.userId, uri), '- Likes comparisons presented as tables.');
});

test('consolidation cannot merge a removed value into another category, including a heading', options, async t => {
  const f = await fixture(t);
  await f.overlay.reject(f.userId, 'preferences', `${f.root}/preferences/title.md`, ['Report title M-41633.']);
  const uri = f.seed('projects/m-41633_研发项目.md', '# M-41633\n- M-41633\n- Independent goal.', { type: 'project_context' });
  await f.worker.ingestConsolidation(f.userId, { taskId: 'merge', adds: [uri] });
  assert.equal(await f.sessions.read(f.userId, uri), null);
  const kept = [...(await f.overlay.files(f.userId)).values()].find(file => file.uri.includes('/memory-'));
  assert.equal(kept?.body, '- Independent goal.');
});

for (const at of [old, fresh]) {
  test(`promotion and replay use original message time (${at === old ? 'refused' : 'relearned'}), never the synthetic user message`, options, async t => {
    const f = await fixture(t);
    const fact = 'Project M-41633.';
    const uri = `${f.root}/preferences/self/project.md`;
    await f.overlay.reject(f.userId, 'project_context', `${f.root}/projects/old.md`, [fact]);
    const original = await f.commitConversation('origin', [{ role: 'user', text: fact, at }]);
    await f.worker.processCommits({ userId: f.userId });
    f.stub.extract = () => ({ adds: [{ uri, memory_type: 'preferences', after: fact }] });
    const promotion = await f.store.keepRepeatedChoice(f.userId, fact, [{ archiveUri: original.archive_uri }]);
    f.stub.files.set(`${promotion.archiveUri}/messages.jsonl`, JSON.stringify({ role: 'user', content: fact, created_at: fresh }));
    await f.worker.processCommits({ userId: f.userId });
    assert.equal(await f.sessions.read(f.userId, uri), at === old ? null : fact);
    const replay = await f.commitConversation('replay', [{ role: 'user', text: fact, at: fresh }], { engineSession: 'evimed-replay-promotion', origin: 'replay' });
    await f.overlay.markReplayed(f.userId, promotion.archiveUri, replay.archive_uri);
    await f.worker.processCommits({ userId: f.userId });
    assert.equal(await f.sessions.read(f.userId, uri), at === old ? null : fact);
  });
}

test('verification corrections cannot restore a removed value under different words or a new heading', options, async t => {
  const f = await fixture(t);
  await f.overlay.reject(f.userId, 'preferences', `${f.root}/preferences/old.md`, ['Project M-41633.']);
  const uri = f.seed('projects/neutral.md', '- Independent goal.', { type: 'project_context' });
  const file = { uri, type: 'project_context', body: '- Independent goal.' };
  assert.equal(await f.worker.verification.write(f.userId, file, '# M-41633\n- Independent goal.', 'verification_corrected'), false);
  assert.equal(await f.sessions.read(f.userId, uri), file.body);
});

test('consolidation keeps a restatement through its original line origins', options, async t => {
  const f = await fixture(t);
  const fact = 'Project M-41633.';
  await f.overlay.reject(f.userId, 'preferences', `${f.root}/preferences/old.md`, [fact]);
  const original = await f.commitConversation('new-origin', [{ role: 'user', text: fact, at: fresh }]);
  await f.worker.processCommits({ userId: f.userId });
  const from = f.seed('preferences/new.md', fact, { type: 'preferences' });
  await f.overlay.upsertFile({ userId: f.userId, uri: from, memoryType: 'preferences', body: fact });
  await f.overlay.syncOrigins(f.userId, from, { after: fact, origin: { archiveUri: original.archive_uri } });
  await f.sessions.remove(f.userId, from);
  const uri = f.seed('projects/merged.md', `# M-41633\n- Goal: M-41633`, { type: 'project_context' });
  await f.worker.ingestConsolidation(f.userId, { taskId: 'merge-restated', adds: [uri], deletes: [from] });
  assert.equal(await f.sessions.read(f.userId, uri), '# M-41633\n- Goal: M-41633');
});

test('removal authority has no first-page limit and keeps hard tokens beyond the old text truncation', options, async t => {
  const f = await fixture(t);
  const lines = Array.from({ length: 510 }, (_, n) => `Removed project R-${10000 + n}.`);
  lines.push(`${'Ordinary prose. '.repeat(40)}M-41633`);
  await f.overlay.reject(f.userId, 'preferences', `${f.root}/preferences/old.md`, lines);
  assert.equal((await f.overlay.removals(f.userId)).length, 511);
  const uri = f.seed('projects/new.md', '- M-41633\n- R-10509', { type: 'project_context' });
  await f.worker.ingestConsolidation(f.userId, { taskId: 'merge-many', adds: [uri] });
  assert.equal(await f.sessions.read(f.userId, uri), null);
});

test('a fresh explicit remember-tool message remains a human restatement without a conversation binding', options, async t => {
  const f = await fixture(t);
  const fact = 'Project M-41633.';
  await f.overlay.reject(f.userId, 'preferences', `${f.root}/preferences/old.md`, [fact]);
  const uri = `${f.root}/projects/restated.md`;
  f.stub.extract = () => ({ adds: [{ uri, memory_type: 'project_context', after: fact }] });
  await f.commitConversation('remember', [{ role: 'user', text: fact, at: fresh }], { engineSession: 'mcp-store-restated', origin: 'tool' });
  await f.worker.processCommits({ userId: f.userId });
  assert.equal(await f.sessions.read(f.userId, uri), fact);
});
