import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeIntegration } from './helpers/nativeFixture.mjs';
import { lineFingerprint } from '../src/nativeMemoryOverlay.mjs';
import { nativeMemoryCounters } from '../src/nativeMemoryMetrics.mjs';

const { fixture, options } = nativeIntegration();
const allergy = '- 对青霉素过敏（重要用药安全信息）(as of 2026-11-14)';
const swimming = '- 每周三晚上去游泳 (as of 2026-11-14)';
const coffee = '- 早上习惯喝黑咖啡 (as of 2026-11-14)';
const key = '- 家里备用钥匙放在蓝色鞋柜第二层 (as of 2026-11-14)';
const initial = ['# 用户', allergy, swimming, coffee, key].join('\n');
const forgotten = ['# 用户', allergy, coffee, key].join('\n');
const lost = ['# 用户', allergy, coffee].join('\n');

for (const enabled of [false, true]) for (const robust of [false, true]) {
  test(`FT13 real commit/store: targeted forget, unexplained rewrite, origins and undo (enabled=${enabled}, robust=${robust})`, options, async t => {
    const f = await fixture(t, { config: { memoryKeepUnexplainedLinesEnabled: enabled,
      memoryPastedInstructionCheckEnabled: robust, memoryPastedInstructionRobustEnabled: robust } });
    if (robust) f.worker.pastedInstructionJudge = { check: async () => new Set() };
    const uri = `${f.root}/profile.md`;
    f.stub.extract = () => ({ adds: [{ uri, after: initial }] });
    await f.commitConversation('remember', [{ role: 'user', text: initial, at: '2026-11-14T00:00:00.000Z' }]);
    await f.worker.processCommits({ userId: f.userId });
    const keyPrint = lineFingerprint(key.slice(2));
    const origin = (await f.overlay.originsOf(f.userId, [uri])).get(uri).get(keyPrint);
    assert.ok(origin.archiveUri);
    f.store.forgetTargetsEnabled = true;
    const removed = await f.store.forget({ id: f.userId }, { id: 'default', userId: f.userId }, uri,
      { engineSession: 'dsh-session_forget', lines: [swimming.slice(2)] });
    assert.equal(removed.removedLines, 1);
    assert.equal(await f.sessions.read(f.userId, uri), forgotten);
    const forgetRevision = (await f.overlay.revisionsOf(f.userId, uri))[0];
    assert.equal(forgetRevision.actor, 'conversation');
    assert.equal(forgetRevision.reason, 'forgotten in a conversation');
    f.stub.extract = () => ({ updates: [{ uri, before: forgotten, after: lost }] });
    const commit = await f.commitConversation('forget', [{ role: 'user', text: '我每周三晚上去游泳这条，帮我从记忆里忘掉吧，别的都别动。', at: '2026-11-14T00:01:00.000Z' }]);
    await f.worker.processCommits({ userId: f.userId });
    const expected = enabled ? forgotten : lost;
    assert.equal(await f.sessions.read(f.userId, uri), expected);
    assert.equal((await f.overlay.file(f.userId, uri)).body, expected);
    const revisions = await f.overlay.admissionRevisions(f.userId, commit.archive_uri);
    assert.equal(revisions.length, 1, 'one accepted revision, no corrective platform revision');
    assert.equal(revisions[0].actor, 'engine');
    assert.equal(revisions[0].reason, '');
    assert.equal(revisions[0].before, forgotten);
    assert.equal(revisions[0].after, expected);
    const ledger = await f.overlay.commit(f.userId, commit.archive_uri);
    assert.equal(ledger.operations, 1);
    assert.deepEqual(ledger.extraction.memoryTypes, []);
    assert.equal(ledger.extraction.fromTask, false);
    if (enabled) assert.deepEqual((await f.overlay.originsOf(f.userId, [uri])).get(uri).get(keyPrint), origin);
    assert.equal(nativeMemoryCounters().unexplainedDeletions.restored, enabled ? 1 : 0);
    // Re-reading the original engine diff cannot duplicate a revision or relabel the restored line.
    await f.worker.ingest(ledger, JSON.parse(await f.sessions.read(f.userId, `${commit.archive_uri}/memory_diff.json`)));
    assert.equal((await f.overlay.admissionRevisions(f.userId, commit.archive_uri)).length, 1);
    assert.equal(await f.sessions.read(f.userId, uri), expected);
    const archived = (await f.store.forgotten(f.userId)).find(record => record.value === '每周三晚上去游泳');
    assert.ok(archived, 'the tool forget remains individually undoable after an engine revision');
    await f.store.update(f.userId, archived.id, { status: 'active', expectedVersion: archived.version });
    const restored = await f.sessions.read(f.userId, uri);
    assert.ok(restored.includes(swimming));
    assert.equal(restored.includes(key), enabled);
    if (enabled) assert.deepEqual((await f.overlay.originsOf(f.userId, [uri])).get(uri).get(keyPrint), origin);
  });
}

for (const moved of [false, true]) test(`whole-file engine deletion is accepted line by line (moved=${moved})`, options, async t => {
  const f = await fixture(t, { config: { memoryKeepUnexplainedLinesEnabled: true } });
  const uri = `${f.root}/notes/old.md`, destination = `${f.root}/notes/new.md`;
  f.stub.extract = () => ({ adds: [{ uri, after: key }] });
  await f.commitConversation('initial', [{ role: 'user', text: key }]);
  await f.worker.processCommits({ userId: f.userId });
  const origin = (await f.overlay.originsOf(f.userId, [uri])).get(uri).get(lineFingerprint(key.slice(2)));
  f.stub.extract = () => ({ deletes: [{ uri, deleted_content: key }], adds: moved ? [{ uri: destination, after: key }] : [] });
  const commit = await f.commitConversation('deletion', [{ role: 'user', text: 'Hello.' }]);
  await f.worker.processCommits({ userId: f.userId });
  assert.equal(await f.sessions.read(f.userId, uri), moved ? null : key);
  const [revision] = (await f.overlay.admissionRevisions(f.userId, commit.archive_uri)).filter(row => row.uri === uri);
  assert.equal(revision.change, moved ? 'deleted' : 'updated');
  assert.equal(revision.after, moved ? null : key);
  if (!moved) assert.deepEqual((await f.overlay.originsOf(f.userId, [uri])).get(uri).get(lineFingerprint(key.slice(2))), origin);
  else assert.equal(await f.sessions.read(f.userId, destination), key);
});

test('a stale extraction never overwrites a later engine body', options, async t => {
  const f = await fixture(t, { config: { memoryKeepUnexplainedLinesEnabled: true } });
  const uri = f.seed('profile.md', forgotten);
  f.stub.extract = () => ({ updates: [{ uri, before: forgotten, after: lost }] });
  await f.commitConversation('stale', [{ role: 'user', text: 'Hello.' }]);
  f.stub.files.set(uri, '# Later independent profile');
  await f.worker.processCommits({ userId: f.userId });
  assert.equal(await f.sessions.read(f.userId, uri), '# Later independent profile');
});

/** @type {{name:string,before:string,after:string,expected:string,message:string,role?:string,outcome:'restored'|'kept_deleted_replaced'|'kept_deleted_grounded'}[]} */
const revisedRules = [
  { name: 'd1 district update in place', before: `- 住在小店区\n${allergy}`, after: `- 住在迎泽区\n${allergy}`,
    expected: `- 住在迎泽区\n${allergy}`, message: '我搬到迎泽区了', outcome: 'kept_deleted_replaced' },
  { name: 'd2 district update appended across an unchanged anchor', before: `- 住在小店区\n${allergy}`, after: `${allergy}\n- 住在迎泽区`,
    expected: `${allergy}\n- 住在迎泽区`, message: '我搬到迎泽区了', outcome: 'kept_deleted_replaced' },
  { name: 'd3 earlier-value wrapper', before: `- 青\n${allergy}`, after: `${allergy}\n- 红（曾为：青）`,
    expected: `${allergy}\n- 红（曾为：青）`, message: '你好。', outcome: 'kept_deleted_replaced' },
  { name: 'e user coffee grounds', before: `${coffee}\n${allergy}`, after: allergy,
    expected: allergy, message: '我已经不喝咖啡了', outcome: 'kept_deleted_grounded' },
  { name: 'unrelated deletion and addition in separate hunks', before: `${key}\n${allergy}`, after: `${allergy}\n- 周末参加陶艺课程`,
    expected: `${key}\n${allergy}\n- 周末参加陶艺课程`, message: '你好。', outcome: 'restored' },
  ...['我的', '了的'].map(text => ({ name: `stop-set overlap ${text}`, before: `- ${text}\n${allergy}`, after: allergy,
    expected: `- ${text}\n${allergy}`, message: text, outcome: /** @type {const} */ ('restored') })),
  ...['assistant', 'tool'].map(role => ({ name: `${role} coffee text is not grounds`, before: `${coffee}\n${allergy}`, after: allergy,
    expected: `${coffee}\n${allergy}`, message: '我已经不喝咖啡了', role, outcome: /** @type {const} */ ('restored') })),
];

for (const scenario of revisedRules) test(`FT13b real commit/store: ${scenario.name}`, options, async t => {
  const f = await fixture(t, { config: { memoryKeepUnexplainedLinesEnabled: true } });
  const uri = `${f.root}/profile.md`;
  f.stub.extract = () => ({ adds: [{ uri, after: scenario.before }] });
  await f.commitConversation('initial', [{ role: 'user', text: scenario.before }]);
  await f.worker.processCommits({ userId: f.userId });
  const origins = (await f.overlay.originsOf(f.userId, [uri])).get(uri);
  f.stub.extract = () => ({ updates: [{ uri, before: scenario.before, after: scenario.after }] });
  const commit = await f.commitConversation('change', [
    { role: 'user', text: '你好。' }, { role: scenario.role ?? 'user', text: scenario.message },
  ]);
  await f.worker.processCommits({ userId: f.userId });
  assert.equal(await f.sessions.read(f.userId, uri), scenario.expected);
  assert.equal((await f.overlay.file(f.userId, uri)).body, scenario.expected);
  const revisions = await f.overlay.admissionRevisions(f.userId, commit.archive_uri);
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].actor, 'engine');
  assert.equal(revisions[0].before, scenario.before);
  assert.equal(revisions[0].after, scenario.expected);
  assert.equal(nativeMemoryCounters().unexplainedDeletions[scenario.outcome], 1);
  if (scenario.outcome === 'restored') {
    const print = lineFingerprint(scenario.before.split('\n')[0].slice(2));
    assert.deepEqual((await f.overlay.originsOf(f.userId, [uri])).get(uri).get(print), origins.get(print));
  }
});

for (const change of ['add', 'update']) test(`FT13b: related ${change} in another file cannot explain a deletion`, options, async t => {
  const f = await fixture(t, { config: { memoryKeepUnexplainedLinesEnabled: true } });
  const uri = `${f.root}/profile.md`, other = `${f.root}/notes/other.md`;
  const prior = `- 住在小店区\n${allergy}`;
  const otherBefore = '- 周末参加陶艺课程', otherAfter = `${otherBefore}\n- 住在迎泽区`;
  f.stub.extract = () => ({ adds: [{ uri, after: prior }, ...(change === 'update' ? [{ uri: other, after: otherBefore }] : [])] });
  await f.commitConversation('initial', [{ role: 'user', text: prior }]);
  await f.worker.processCommits({ userId: f.userId });
  f.stub.extract = () => ({ updates: [{ uri, before: prior, after: allergy },
    ...(change === 'update' ? [{ uri: other, before: otherBefore, after: otherAfter }] : [])],
  adds: change === 'add' ? [{ uri: other, after: otherAfter }] : [] });
  const commit = await f.commitConversation('change', [{ role: 'user', text: '你好。' }]);
  await f.worker.processCommits({ userId: f.userId });
  assert.equal(await f.sessions.read(f.userId, uri), prior);
  assert.equal(await f.sessions.read(f.userId, other), otherAfter);
  const revisions = (await f.overlay.admissionRevisions(f.userId, commit.archive_uri)).filter(row => row.uri === uri);
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].after, prior);
  assert.equal(nativeMemoryCounters().unexplainedDeletions.restored, 1);
});
