import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeIntegration } from './helpers/nativeFixture.mjs';
import { lineFingerprint, contentHash } from '../src/nativeMemoryOverlay.mjs';
import { nativeFileId } from '../src/nativeMemoryStore.mjs';
import { NativeMemoryObservations } from '../src/nativeMemoryObservations.mjs';
import { NativeMemoryWorker } from '../src/nativeMemoryWorker.mjs';

const { fixture: baseFixture, options } = nativeIntegration();
// These fixtures explicitly assert their project fact. Meaning is supplied by the test oracle;
// production requires the model's checked assertion witness instead of token containment.
async function fixture(t) {
  const f = await baseFixture(t);
  const judge = { same: async ({ candidates, said = [] }) => ({
    same: new Map(candidates.map((candidate, index) => [index, candidate.removed[0].fingerprint])),
    stated: new Set(said.some(text => ['Project M-41633.', 'My weekly report title is M-41633.'].includes(text))
      ? candidates.map((_candidate, index) => index) : []),
    witnesses: new Map(candidates.map((_candidate, index) => [index, said.findIndex(text => ['Project M-41633.', 'My weekly report title is M-41633.'].includes(text))])),
  }) };
  f.worker.rejectionJudge = judge; f.worker.verification.rejectionJudge = judge;
  return f;
}
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
    const neutral = [...files.values()].find(file => /\/[a-f0-9]{24}\.md$/.test(file.uri) && file.body.includes('Retained independent fact.'));
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
  const judge = { same: async request => { requests.push(request); return { same: new Map([[0, request.candidates[0].removed[0].fingerprint]]), stated: new Set([0]), witnesses: new Map([[0, 0]]) }; } };
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
  const kept = [...(await f.overlay.files(f.userId)).values()].find(file => /\/[a-f0-9]{24}\.md$/.test(file.uri));
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

test('an unbound remember-tool user-role argument cannot manufacture human reauthorization', options, async t => {
  const f = await fixture(t);
  const fact = 'Project M-41633.';
  await f.overlay.reject(f.userId, 'preferences', `${f.root}/preferences/old.md`, [fact]);
  const uri = `${f.root}/projects/restated.md`;
  f.stub.extract = () => ({ adds: [{ uri, memory_type: 'project_context', after: fact }] });
  await f.commitConversation('remember', [{ role: 'user', text: fact, at: fresh }], { engineSession: 'mcp-store-restated', origin: 'tool' });
  await f.worker.processCommits({ userId: f.userId });
  assert.equal(await f.sessions.read(f.userId, uri), null);
});

test('a stale engine before-image cannot classify an edited-out value as unchanged, and a later statement gets fresh provenance', options, async t => {
  const f = await fixture(t);
  const before = '- Project M-41633.\n- Independent goal.';
  const uri = f.seed('projects/partial.md', before, { type: 'project_context' });
  const id = nativeFileId(uri);
  await f.store.update(f.userId, id, { value: '- Independent goal.', expectedVersion: (await f.store.getRecord(f.userId, id)).version });
  f.stub.extract = () => ({ updates: [{ uri, memory_type: 'project_context', before, after: `${before}\n- Other work.` }] });
  await f.commitConversation('stale', [{ role: 'user', text: 'Project M-41633.', at: old }]);
  await f.worker.processCommits({ userId: f.userId });
  assert.equal(await f.sessions.read(f.userId, uri), '- Independent goal.\n- Other work.');
  const restated = await f.commitConversation('restated', [{ role: 'user', text: 'Project M-41633.', at: fresh }]);
  await f.worker.processCommits({ userId: f.userId });
  assert.match(await f.sessions.read(f.userId, uri), /M-41633/);
  const origins = (await f.overlay.originsOf(f.userId, [uri])).get(uri);
  assert.equal(origins.get(lineFingerprint('Project M-41633.')).archiveUri, restated.archive_uri);
});


test('an unchanged observation can be promoted from a later demonstration after removal', options, async t => {
  const f = await fixture(t), fact = 'Project M-41633.';
  const first = await f.commitConversation('first-choice', [{ role: 'user', text: fact, at: old }]);
  const later = await f.commitConversation('later-choice', [{ role: 'user', text: fact, at: fresh }]);
  await f.worker.processCommits({ userId: f.userId });
  const note = f.seed('observations/project.md', fact, { type: 'observations' });
  await f.overlay.upsertFile({ userId: f.userId, uri: note, memoryType: 'observations', body: fact });
  await f.overlay.syncOrigins(f.userId, note, { after: fact, origin: { archiveUri: first.archive_uri, engineSession: first.session } });
  for (const [commit, change] of [[first, 'added'], [later, 'updated']]) {
    await f.overlay.addRevision({ userId: f.userId, uri: note, memoryType: 'observations', actor: 'engine', change,
      after: fact, engineSession: commit.session, archiveUri: commit.archive_uri });
  }
  await f.overlay.reject(f.userId, 'project_context', `${f.root}/projects/old.md`, [fact]);
  const uri = `${f.root}/preferences/new-choice.md`;
  f.stub.extract = () => ({ adds: [{ uri, memory_type: 'preferences', after: fact }] });
  const promoter = new NativeMemoryObservations({ overlay: f.overlay, sessions: f.sessions,
    keepRepeatedChoice: (userId, choice, origins) => f.store.keepRepeatedChoice(userId, choice, origins) });
  assert.equal((await promoter.promote(f.userId)).promoted, 1);
  await f.worker.processCommits({ userId: f.userId });
  assert.equal(await f.sessions.read(f.userId, uri), fact);
});


test('the platform-generated neutral filename is checked too, including a removed quoted name and an opaque identifier', options, async t => {
  const f = await fixture(t);
  const uri = `${f.root}/projects/Memory_project.md`;
  const firstName = contentHash(`${uri}:0`).slice(0, 24);
  await f.overlay.reject(f.userId, 'preferences', `${f.root}/preferences/old.md`, ['Project "Memory".']);
  await f.overlay.reject(f.userId, 'decisions', `${f.root}/decisions/old.md`, [`Project identifier "${firstName}".`]);
  f.seed('projects/Memory_project.md', '- Independent fact.', { type: 'project_context' });
  await f.worker.ingestConsolidation(f.userId, { taskId: 'neutral-name', adds: [uri] });
  assert.equal(await f.sessions.read(f.userId, uri), null);
  const safe = `${f.root}/projects/${contentHash(`${uri}:1`).slice(0, 24)}.md`;
  assert.equal(await f.sessions.read(f.userId, safe), '- Independent fact.');
  assert.equal(await f.sessions.read(f.userId, `${f.root}/projects/${firstName}.md`), null);
});

test('conversation withdrawal records observation-only removal authority before an old demonstration can be promoted', options, async t => {
  const f = await fixture(t), fact = 'Project M-41633.';
  const note = `${f.root}/observations/project.md`;
  f.stub.extract = ({ session }) => session.includes('source-a')
    ? { adds: [{ uri: note, memory_type: 'observations', after: fact }] }
    : { updates: [{ uri: note, memory_type: 'observations', before: fact, after: fact }] };
  await f.commitConversation('source-a', [{ role: 'user', text: fact, at: old }], { projectId: 'default' });
  const other = await f.commitConversation('source-b', [{ role: 'user', text: fact, at: old }], { projectId: 'default' });
  await f.worker.processCommits({ userId: f.userId });
  assert.equal((await f.store.files(f.userId)).length, 0, 'observation notes stay outside public memory readers');
  await f.store.removeConversationSource(f.userId, 'default', ['session_source-a']);
  assert.ok((await f.overlay.removals(f.userId)).some(row => row.memoryType === 'observations'));
  const uri = `${f.root}/preferences/old-choice.md`;
  f.stub.extract = () => ({ adds: [{ uri, memory_type: 'preferences', after: fact }] });
  await f.store.keepRepeatedChoice(f.userId, fact, [{ archiveUri: other.archive_uri }]);
  await f.worker.processCommits({ userId: f.userId });
  assert.equal(await f.sessions.read(f.userId, uri), null, 'an old independent archive cannot renew the withdrawn content');
  await f.commitConversation('fresh-choice', [{ role: 'user', text: fact, at: fresh }], { projectId: 'default' });
  await f.worker.processCommits({ userId: f.userId });
  assert.equal(await f.sessions.read(f.userId, uri), fact, 'a new statement still authorizes relearning');
});

test('a page edit uses the same safe-name rule rather than reintroducing a removed name through its fallback prefix', options, async t => {
  const f = await fixture(t);
  const uri = f.seed('preferences/Edited_note.md', 'Project "Edited".', { type: 'preferences' });
  const firstName = contentHash(`${uri}:0`).slice(0, 24);
  await f.overlay.reject(f.userId, 'decisions', `${f.root}/decisions/old.md`, [`Project identifier "${firstName}".`]);
  const id = nativeFileId(uri);
  await f.store.update(f.userId, id, { value: '- Independent replacement.', expectedVersion: (await f.store.getRecord(f.userId, id)).version });
  assert.equal(await f.sessions.read(f.userId, uri), null);
  assert.equal(await f.sessions.read(f.userId, `${f.root}/preferences/${firstName}.md`), null);
  const safe = `${f.root}/preferences/${contentHash(`${uri}:1`).slice(0, 24)}.md`;
  assert.equal(await f.sessions.read(f.userId, safe), '- Independent replacement.');
});

// The real engine's single-write endpoint slugs a space-bearing extraction path. A partial duplicate
// cleanup used to create an underscore sibling without a diff; the second forget deleted only the original.
test('remember-tool plant then forget uses exact writes for duplicate cleanup and creates no normalized sibling; undo retains the original path', options, async t => {
  const f = await fixture(t);
  const fact = 'Project M-41633.';
  const note = `${f.root}/notes/project.md`, uri = `${f.root}/projects/m-41633 project.md`;
  const body = `# M-41633 project\n- Keep this: ${fact}\n- Independent goal.`;
  f.stub.extract = ({ session }) => session.startsWith('mcp-store-')
    ? { adds: [{ uri, memory_type: 'project_context', after: body }] }
    : { adds: [{ uri: note, memory_type: 'notes', after: `- ${fact}` }] };
  await f.commitConversation('plant', [{ role: 'user', text: fact, at: old }]);
  await f.commitConversation('remember', [{ role: 'user', text: fact, at: old }], { engineSession: 'mcp-store-plant', origin: 'tool' });
  await f.worker.processCommits({ userId: f.userId });
  const normalized = uri.replaceAll(' ', '_');
  await f.store.forget({ id: f.userId }, { id: 'default', userId: f.userId }, note);
  assert.equal(await f.sessions.read(f.userId, normalized), null);
  assert.ok(f.stub.sent('DELETE', '/api/v1/fs').some(call => call.query.uri === note && call.query.wait === 'true'), 'forget waits for native index maintenance');
  assert.ok(f.stub.sent('POST', '/api/v1/content/batch-write').some(call => call.body.operations.some(op => op.uri === uri)), 'duplicate cleanup exercised the exact-path write');
  await f.store.forget({ id: f.userId }, { id: 'default', userId: f.userId }, uri);
  assert.equal(await f.sessions.read(f.userId, uri), null);
  assert.equal(await f.sessions.read(f.userId, normalized), null);
  assert.ok(!(await f.sessions.tree(f.userId, f.root, { levelLimit: 10 })).some(node => node.uri === normalized));
  await f.store.undo(f.userId, nativeFileId(uri));
  assert.ok((await f.sessions.read(f.userId, uri)).includes('M-41633'), 'explicit undo restores the requested memory');
  assert.equal(await f.sessions.read(f.userId, normalized), null, 'undo cannot create an untracked sibling either');
});

for (const path of ['m-41633_project', 'ｍ＿４１６３３', 'm 41633']) {
  test(`remember commit in flight across removal refuses normalized filename, heading and body (${path}), then permits a new statement`, options, async t => {
    const f = await fixture(t), fact = 'Project M-41633.';
    const original = f.seed('notes/project.md', `- ${fact}`, { type: 'notes' });
    const uri = `${f.root}/projects/${path}.md`, body = '# M-41633\n- M-41633\n- Independent goal.';
    f.stub.extract = () => ({ adds: [{ uri, memory_type: 'project_context', after: body }] });
    const commit = await f.commitConversation('in-flight', [{ role: 'user', text: fact, at: old }], { engineSession: 'mcp-store-in-flight', origin: 'tool' });
    const diffUri = `${commit.archive_uri}/memory_diff.json`, diff = f.stub.files.get(diffUri);
    f.stub.files.delete(diffUri); f.stub.files.delete(uri);
    f.stub.tasks.get(commit.task_id).public.status = 'running';
    await f.store.forget({ id: f.userId }, { id: 'default', userId: f.userId }, original);
    f.stub.files.set(uri, body); f.stub.files.set(diffUri, diff);
    f.stub.tasks.get(commit.task_id).public.status = 'completed';
    await f.worker.processCommits({ userId: f.userId });
    assert.equal(await f.sessions.read(f.userId, uri), null);
    assert.ok([...(await f.overlay.files(f.userId)).values()].some(file => file.body === '- Independent goal.'), 'independent content remains');
    await f.commitConversation('new', [{ role: 'user', text: fact, at: fresh }], { engineSession: 'mcp-store-restatement', origin: 'tool' });
    await f.worker.processCommits({ userId: f.userId });
    assert.equal(await f.sessions.read(f.userId, uri), null, 'a synthetic tool message alone is not human authorship');
    await f.database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','Test',1048576)", [f.userId]);
    f.stub.extract = () => ({});
    const human = await f.commitConversation('human-restatement', [{ role: 'user', text: fact, at: fresh }], { projectId: 'default' });
    f.stub.extract = () => ({ adds: [{ uri, memory_type: 'project_context', after: body }] });
    const bound = await f.commitConversation('bound-restatement', [{ role: 'user', text: fact, at: fresh }],
      { projectId: 'default', engineSession: 'mcp-store-bound-restatement', origin: 'tool' });
    await f.overlay.recordCommit({ userId: f.userId, archiveUri: bound.archive_uri, engineSession: bound.session,
      sourceSession: human.session, projectId: 'default', origin: 'tool', taskId: bound.task_id });
    await f.worker.processCommits({ userId: f.userId });
    assert.equal(await f.sessions.read(f.userId, uri), body, 'the original later human assertion authorizes its bound remember copy');
  });
}

for (const operation of ['adds', 'updates']) {
  test(`a ${operation === 'adds' ? 'created or renamed' : 'rewritten'} file cannot carry a removed token only in its normalized filename`, options, async t => {
    const f = await fixture(t);
    await f.overlay.reject(f.userId, 'notes', `${f.root}/notes/project.md`, ['Project M-41633.']);
    const uri = `${f.root}/projects/项目_ｍ＿４１６３３.md`;
    if (operation === 'updates') {
      f.seed('projects/项目_ｍ＿４１６３３.md', '- Previous independent fact.', { type: 'project_context' });
      await f.overlay.upsertFile({ userId: f.userId, uri, memoryType: 'project_context', body: '- Previous independent fact.' });
    }
    f.stub.extract = () => ({ [operation]: [{ uri, memory_type: 'project_context', ...(operation === 'updates' ? { before: '- Previous independent fact.' } : {}), after: '- Independent goal.' }] });
    await f.commitConversation('filename-only', [{ role: 'user', text: 'Work on an independent goal.', at: old }], { engineSession: 'mcp-store-filename-only', origin: 'tool' });
    await f.worker.processCommits({ userId: f.userId });
    assert.equal(await f.sessions.read(f.userId, uri), null);
    assert.ok([...(await f.overlay.files(f.userId)).values()].some(file => file.body === '- Independent goal.'));
  });
}

test('explicit undo lifts every filename spelling introduced by its own forget, preserving other removals', options, async t => {
  const f = await fixture(t);
  const uri = f.seed('projects/项目_ｍ＿４１６３３.md', '# Project\n- Independent goal.', { type: 'project_context' });
  await f.overlay.reject(f.userId, 'notes', `${f.root}/notes/other.md`, ['Unrelated project Q-53214.']);
  await f.store.remove(f.userId, nativeFileId(uri), { keepText: true });
  assert.ok((await f.overlay.removals(f.userId)).some(row => row.memoryType === 'project_context'));
  await f.store.undo(f.userId, nativeFileId(uri));
  assert.ok((await f.overlay.removals(f.userId)).every(row => row.memoryType !== 'project_context'));
  assert.ok((await f.overlay.removals(f.userId)).some(row => row.text.includes('q-53214')));
  assert.equal(await f.sessions.read(f.userId, uri), '# Project\n- Independent goal.');
});

test('a relearned filename keeps its dated original authority through an unrelated later update', options, async t => {
  const f = await fixture(t), uri = `${f.root}/projects/m-41633 project.md`;
  await f.overlay.reject(f.userId, 'notes', `${f.root}/notes/project.md`, ['Project M-41633.']);
  f.stub.extract = () => ({ adds: [{ uri, memory_type: 'project_context', after: '- Independent goal.' }] });
  await f.commitConversation('restated-name', [{ role: 'user', text: 'Project M-41633.', at: fresh }]);
  await f.worker.processCommits({ userId: f.userId });
  assert.equal(await f.sessions.read(f.userId, uri), '- Independent goal.');
  const next = '- Independent goal.\n- Another detail.';
  f.stub.extract = () => ({ updates: [{ uri, memory_type: 'project_context', before: '- Independent goal.', after: next }] });
  await f.commitConversation('unrelated', [{ role: 'user', text: 'Another detail.', at: old }]);
  await f.worker.processCommits({ userId: f.userId });
  assert.equal(await f.sessions.read(f.userId, uri), next);
});

test('root profile edits and undo use its canonical single-write path while typed directory files keep exact batch writes', options, async t => {
  const f = await fixture(t), uri = f.seed('profile.md', '# User\n- Fixed desk is J-16577 (as of 2026-11-11)', { type: 'profile' });
  const record = (await f.store.records(f.userId)).find(row => row.value.includes('J-16577'));
  await f.store.update(f.userId, record.id, { value: 'Fixed desk has changed.', expectedVersion: record.version });
  assert.ok(!(await f.sessions.read(f.userId, uri)).includes('J-16577'));
  assert.ok(f.stub.sent('POST', '/api/v1/content/write').some(call => call.body.uri === uri));
  assert.ok(!f.stub.sent('POST', '/api/v1/content/batch-write').some(call => call.body.root_uri === f.root));
  await f.store.undo(f.userId, nativeFileId(uri));
  assert.ok((await f.sessions.read(f.userId, uri)).includes('J-16577'));
});
