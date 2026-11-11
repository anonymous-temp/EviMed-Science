import assert from 'node:assert/strict';
import test from 'node:test';
import { MEMORY_SAFETY_NOTES_ANCHOR as anchor } from '@evimed/domain';
import { ResidentProfiles } from '../src/residentProfile.mjs';
import { createLabResidentProfiles } from '../../../evals/capsule-proving/run/lab.mjs';
import { nativeIntegration } from './helpers/nativeFixture.mjs';
import { nativeFileId } from '../src/nativeMemoryStore.mjs';

const { fixture, options } = nativeIntegration();
const body = (label, note) => `# ${label}\n## Before treatment ${anchor}\n- ${note}\n## Work\n- Private work detail.`;

test('dedicated safety history uses ordinary sensitive, project, source-deletion and owner boundaries', options, async t => {
  const f = await fixture(t);
  for (const name of ['visible', 'sensitive', 'other-project', 'source-deleted']) {
    const text = `# ${name}\nReported history ${name}.`;
    const uri = f.seed(`safety_notes/${name}.md`, text, { type: 'safety_notes' });
    await f.overlay.upsertFile({ userId: f.userId, uri, memoryType: 'safety_notes', body: text,
      sensitive: name === 'sensitive', projectId: name === 'other-project' ? 'another-project' : null });
  }
  f.store.sourceDeletion = {
    hiddenMemoryUris: async () => [`${f.root}/safety_notes/source-deleted.md`],
    redactRecords: async (_id, rows) => rows,
  };
  assert.deepEqual((await f.store.safetyNotes(f.userId, 'default')).map(file => file.relPath), ['safety_notes/visible.md']);
  f.store.sourceDeletion.redactRecords = async (_id, rows) => rows.map(row => ({ ...row, value: '' }));
  assert.deepEqual(await f.store.safetyNotes(f.userId, 'default'), [], 'a raw safety body cannot bypass source redaction');
});

test('P29: native worker settles a dedicated safety file; page edits, undo, deletion and removal fences apply', options, async t => {
  const f = await fixture(t, { config: { memorySafetyNotesEnabled: true } });
  const uri = `${f.root}/safety_notes/child.md`;
  const text = '# Child\n## Extractor chooses this title\n- Child: reported reaction to penicillin S-417.';
  f.stub.extract = () => ({ adds: [{ uri, memory_type: 'safety_notes', after: text }] });
  await f.commitConversation('safety', [{ role: 'user', text, at: '2026-01-01T00:00:00Z' }]);
  await f.worker.processCommits({ userId: f.userId });
  assert.ok(f.sessions.memoryTypes.includes('safety_notes'));
  const page = await f.store.profile(f.userId);
  const record = page.records.find(row => row.uri === uri);
  assert.equal(record.nativeType, 'safety_notes');
  assert.equal(record.kind, 'note');
  assert.equal((await f.store.safetyNotes(f.userId, 'default'))[0].body, text);
  const edited = await f.store.update(f.userId, record.id, { value: '# Child\nReported reaction details corrected.', expectedVersion: record.version });
  assert.equal((await f.store.safetyNotes(f.userId, 'default'))[0].body, edited.value);
  await f.store.undo(f.userId, record.id, { expectedVersion: edited.version });
  assert.equal((await f.store.safetyNotes(f.userId, 'default'))[0].body, text);
  await f.store.remove(f.userId, nativeFileId(uri), { keepText: true, actor: 'user' });
  assert.deepEqual(await f.store.safetyNotes(f.userId, 'default'), []);
  await f.commitConversation('delayed-safety', [{ role: 'user', text, at: '2026-01-01T00:00:00Z' }]);
  await f.worker.processCommits({ userId: f.userId });
  assert.equal(await f.sessions.read(f.userId, uri), null, 'old extraction cannot restore deleted safety history');
  assert.deepEqual(await f.store.safetyNotes(f.userId, 'default'), []);
  assert.ok((await f.overlay.removals(f.userId)).length);
  const forgotten = (await f.store.forgotten(f.userId)).find(row => row.uri === uri);
  await f.store.update(f.userId, forgotten.id, { status: 'active', expectedVersion: forgotten.version });
  assert.equal((await f.store.safetyNotes(f.userId, 'default'))[0].body, text, 'the person can restore the forgotten safety file');
});

test('written people/profile sections reach product and lab resident paths with privacy, deletion and project boundaries intact', options, async t => {
  const f = await fixture(t);
  const bodies = {
    'people/father.md': body('父亲', '用户说青霉素过敏。'),
    'profile.md': body('用户', '用户说阿司匹林后喘息。'),
    'people/private.md': body('Hidden person', 'Hidden safety detail.'),
    'people/deleted.md': body('Deleted person', 'Deleted safety detail.'),
    'people/other.md': body('Other project', 'Other project safety.'),
    'people/colleague.md': '# Colleague\n- Uses spreadsheets.',
  };
  for (const [rel, text] of Object.entries(bodies)) {
    const type = rel === 'profile.md' ? 'profile' : 'people';
    const uri = f.seed(rel, text, { type });
    await f.overlay.upsertFile({ userId: f.userId, uri, memoryType: type, body: text,
      sensitive: rel === 'people/private.md', projectId: rel === 'people/other.md' ? 'other-project' : null });
  }
  f.store.sourceDeletion = {
    hiddenMemoryUris: async () => [`${f.root}/people/deleted.md`],
    redactRecords: async (_id, rows) => rows,
  };
  const config = { ...f.config, memorySafetyNotesEnabled: true };
  const product = new ResidentProfiles({ config, store: f.memorySettings, safetyNotes: (u, p) => f.store.safetyNotes(u, p) });
  const scope = { projectId: 'default', sessionId: null, attended: true };
  const rendered = await product.forDispatch(f.userId, scope);
  assert.match(rendered.text, /父亲.*青霉素过敏/);
  assert.match(rendered.text, /用户.*阿司匹林后喘息/);
  assert.doesNotMatch(rendered.text, /Hidden|Deleted|Other project|Private work|spreadsheets/);
  assert.equal(rendered.memories.length, 2);
  assert.ok(rendered.memories.every(memo => memo.originalSources.length > 0));
  const lab = createLabResidentProfiles({ config, memorySettings: f.memorySettings, nativeMemory: f.store });
  assert.equal((await lab.forDispatch(f.userId, scope)).text, rendered.text, 'lab memory.residentBlock uses the product provider/render path');
  f.store.sourceDeletion.redactRecords = async (_id, rows) => rows.filter(row => row.nativeType !== 'profile')
    .map(row => ({ ...row, value: row.value.replace('用户说青霉素过敏。', '') }));
  assert.equal((await product.forDispatch(f.userId, scope)).text, '', 'redacted safety statements cannot be resurrected from the raw section');
  await f.memorySettings.updateSettings(f.userId, { recallPaused: true });
  assert.equal((await lab.forDispatch(f.userId, scope)).text, '');
});

test('switch off and non-health accounts remain identical through the database-backed store', options, async t => {
  const f = await fixture(t);
  const uri = f.seed('people/colleague.md', '# Colleague\n- Works on reports.', { type: 'people' });
  await f.overlay.upsertFile({ userId: f.userId, uri, memoryType: 'people', body: '# Colleague\n- Works on reports.' });
  const make = enabled => createLabResidentProfiles({ config: { ...f.config, memorySafetyNotesEnabled: enabled }, memorySettings: f.memorySettings, nativeMemory: f.store });
  const scope = { projectId: 'default', sessionId: null };
  assert.equal((await make(true).forDispatch(f.userId, scope)).text, (await make(false).forDispatch(f.userId, scope)).text);
  assert.equal((await make(true).forDispatch(f.userId, scope)).text, '');
});
