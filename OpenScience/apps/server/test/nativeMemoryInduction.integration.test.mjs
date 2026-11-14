// Real PostgreSQL overlay, worker, store, source fences and HTTP engine client; only extraction is stubbed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeIntegration } from './helpers/nativeFixture.mjs';
import { NativeMemoryStore, nativeFileId } from '../src/nativeMemoryStore.mjs';
import { NativeMemoryWorker } from '../src/nativeMemoryWorker.mjs';
const { fixture, options } = nativeIntegration();
const choice = { kind: 'format', scope: 'results tables', choice: 'Markdown', subject: 'work' };
const note = `- Choice: ${JSON.stringify(choice)}`;
const inference = '- Results tables: Markdown [Inferred from behaviour; 2 conversations; dates: 2026-11-12, 2026-11-14]\n' + note;
async function scene(t, config = {}) {
  const f = await fixture(t, { config: { memoryObservationInductionEnabled: true, memoryPersonAliasHintEnabled: true, ...config } });
  const store = new NativeMemoryStore({ ...f, personAliasHintEnabled: true, forgetTargetsEnabled: true });
  const worker = new NativeMemoryWorker({ ...f, nativeMemory: store });
  return { ...f, store, worker };
}
test('cross-topic induction reaches the native preference, retains original sources, and undo fences it', options, async t => {
  const f = await scene(t);
  const preference = `${f.root}/preferences/self/results.md`;
  f.stub.extract = ({ session, messages }) => {
    if (session.startsWith('evimed-promote-')) {
      const words = messages.map(message => message.parts.map(part => part.text).join('')).join('\n');
      assert.match(words, /Inferred from behaviour/);
      assert.doesNotMatch(words, /以后默认这样做/);
      return { adds: [{ uri: preference, memory_type: 'preferences', after: inference }] };
    }
    return { adds: [{ uri: `${f.root}/observations/${session}.md`, memory_type: 'observations', after: note }] };
  };
  await f.commitConversation('a', [{ role: 'user', text: 'Use Markdown for the results table.', at: '2026-11-12T12:00:00Z' }]);
  await f.worker.processCommits({ userId: f.userId });
  assert.equal(await f.sessions.read(f.userId, preference), null);
  await f.commitConversation('b', [{ role: 'user', text: 'Use Markdown for the results table.', at: '2026-11-14T12:00:00Z' }]);
  await f.worker.processCommits({ userId: f.userId });
  await f.worker.processCommits({ userId: f.userId });
  assert.equal(await f.sessions.read(f.userId, preference), inference);
  const promotion = (await f.overlay.commitsOf(f.userId)).find(commit => commit.origin === 'promotion');
  const sources = await f.overlay.removalOrigins(f.userId, [promotion.archiveUri]);
  assert.equal(new Set(sources.map(source => source.engineSession)).size, 2);
  await f.store.undo(f.userId, nativeFileId(preference));
  assert.equal(await f.sessions.read(f.userId, preference), null);
  assert.ok((await f.overlay.removals(f.userId)).some(row => row.text.includes('inferred from behaviour')));
});
test('explicit user identity confirmation merges files in code, preserves alias and both histories', options, async t => {
  const f = await scene(t);
  const first = f.seed('people/王阿姨.md', '# 王阿姨\n- 王阿姨喜欢散步。', { type: 'people' });
  const other = f.seed('people/小王阿姨.md', '# 小王阿姨\n- 小王阿姨喜欢读书。', { type: 'people' });
  const before = await f.sessions.read(f.userId, first);
  const after = `${before}\n- Confirmed aliases: ["王阿姨","小王阿姨"]\n- Alias confirmation: "王阿姨和小王阿姨是同一个人"`;
  // Extraction only adds the confirmation to one card: the real worker/store must perform the cross-file merge.
  f.stub.extract = () => ({ updates: [{ uri: first, memory_type: 'people', before, after }] });
  await f.commitConversation('confirm', [{ role: 'user', text: '王阿姨和小王阿姨是同一个人' }]);
  await f.worker.processCommits({ userId: f.userId });
  assert.equal(await f.sessions.read(f.userId, other), null);
  const merged = await f.sessions.read(f.userId, first);
  assert.match(merged, /Confirmed aliases/); assert.match(merged, /喜欢散步/); assert.match(merged, /喜欢读书/);
  assert.ok((await f.overlay.revisionsOf(f.userId, other)).some(revision => revision.reason === 'explicit person alias merge'));
});
test('near names and assistant assertions cannot authorize merging or confirmed-alias fences', options, async t => {
  for (const role of ['user', 'assistant']) {
    const f = await scene(t);
    const first = f.seed('people/大王阿姨.md', '# 大王阿姨\n- Likes walking.', { type: 'people' });
    const other = f.seed('people/小王阿姨.md', '# 小王阿姨\n- Likes reading.', { type: 'people' });
    const before = await f.sessions.read(f.userId, first);
    const after = `${before}\n- Confirmed aliases: ["大王阿姨","小王阿姨"]\n- Alias confirmation: "大王阿姨和小王阿姨是同一个人"`;
    f.stub.extract = () => ({ updates: [{ uri: first, memory_type: 'people', before, after }] });
    await f.commitConversation('unconfirmed', [{ role, text: role === 'assistant' ? '大王阿姨和小王阿姨是同一个人' : '大王阿姨喜欢散步，小王阿姨喜欢读书' }]);
    await f.worker.processCommits({ userId: f.userId });
    assert.notEqual(await f.sessions.read(f.userId, other), null);
    assert.doesNotMatch(await f.sessions.read(f.userId, first), /Confirmed aliases/);
  }
});
test('targeted forget fences confirmed name variants and removes an alias duplicate, leaving a confusable person intact', options, async t => {
  const f = await scene(t);
  const first = f.seed('people/王阿姨.md', '# 王阿姨\n- Confirmed aliases: ["王阿姨","小王阿姨"]\n- 王阿姨喜欢散步。\n- Likes tea.', { type: 'people' });
  const other = f.seed('people/小王阿姨.md', '# 小王阿姨\n- 小王阿姨喜欢散步。\n- Likes reading.', { type: 'people' });
  const distinct = f.seed('people/大王阿姨.md', '# 大王阿姨\n- 大王阿姨喜欢散步。', { type: 'people' });
  const file = (await f.store.rawFiles(f.userId)).find(row => row.uri === first);
  await f.store.forgetLines(f.userId, file, ['王阿姨喜欢散步。']);
  assert.doesNotMatch(await f.sessions.read(f.userId, first), /喜欢散步/);
  assert.doesNotMatch(await f.sessions.read(f.userId, other), /喜欢散步/);
  assert.match(await f.sessions.read(f.userId, distinct), /喜欢散步/);
  const removals = await f.overlay.removals(f.userId);
  assert.ok(removals.some(row => row.text === '小王阿姨喜欢散步。'));
  await f.store.undo(f.userId, nativeFileId(first));
  assert.match(await f.sessions.read(f.userId, first), /喜欢散步/);
  assert.match(await f.sessions.read(f.userId, other), /喜欢散步/);
  assert.ok(!(await f.overlay.removals(f.userId)).some(row => row.text === '小王阿姨喜欢散步。'));
});

for (const explicit of [false, true]) test(`a ${explicit ? 'stated preference' : 'single contrary choice'} withdraws an inference through the removal fence`, options, async t => {
  const f = await scene(t);
  const uri = f.seed('preferences/self/results.md', inference, { type: 'preferences' });
  const next = { ...choice, choice: 'CSV' };
  f.stub.extract = () => ({ adds: [{ uri: `${f.root}/${explicit ? 'preferences/self/stated' : 'observations/contrary'}.md`,
    memory_type: explicit ? 'preferences' : 'observations', after: `- ${explicit ? 'Stated choice' : 'Choice'}: ${JSON.stringify(next)}` }] });
  await f.commitConversation('contrary', [{ role: 'user', text: explicit ? 'From now on use CSV for results tables.' : 'Use CSV for this results table.' }]);
  await f.worker.processCommits({ userId: f.userId });
  assert.doesNotMatch(await f.sessions.read(f.userId, uri) ?? '', /Inferred from behaviour/);
  assert.ok((await f.overlay.removals(f.userId)).some(row => row.text.includes('inferred from behaviour')));
  await f.store.undo(f.userId, nativeFileId(uri));
  assert.match(await f.sessions.read(f.userId, uri), /Inferred from behaviour/);
});
