import assert from 'node:assert/strict';
import test from 'node:test';
import { MEMORY_SAFETY_NOTES_ANCHOR as anchor } from '@evimed/domain';
import { ResidentProfiles } from '../src/residentProfile.mjs';
import { createLabResidentProfiles } from '../../../evals/capsule-proving/run/lab.mjs';
import { nativeIntegration } from './helpers/nativeFixture.mjs';

const { fixture, options } = nativeIntegration();
const body = (label, note) => `# ${label}\n## Before treatment ${anchor}\n- ${note}\n## Work\n- Private work detail.`;

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
