import assert from 'node:assert/strict';
import test from 'node:test';
import { mergePeopleFiles, undoPeopleMerge, redirectPeopleWrites } from '../src/nativeMemoryPeopleStore.mjs';
import { personPairId } from '../src/nativeMemoryPeople.mjs';
import { lineFingerprint } from '../src/nativeMemoryOverlay.mjs';
const root = 'viking://user/u-123456789012345678901234/memories';
const a = `${root}/people/王阿姨.md`, b = `${root}/people/小王阿姨.md`;
const first = '# 王阿姨\n## 2026-10-01\n- Weight: 50 kg\n- Likes tea.';
const second = '# 小王阿姨\n## 2026-11-01\n- Weight: 55 kg\n- Likes tea.';
function fixture() {
  const bytes = new Map([[a, first], [b, second]]), revisions = [], merges = [], metadata = new Map(), origins = new Map();
  let failRemoval = false;
  for (const [uri, body] of bytes) {
    metadata.set(uri, { uri, body, projectId: null, sensitive: false });
    origins.set(uri, new Map(body.split('\n').filter(line => line.startsWith('-')).map(line => [lineFingerprint(line.replace(/^- /, '')), { archiveUri: `archive-${uri === a ? 'a' : 'b'}`, engineSession: 'dsh-original' }])));
  }
  const sessions = { memoryRoot: () => root, read: async (_user, uri) => bytes.get(uri) ?? null,
    replace: async (_user, uri, text) => { bytes.set(uri, text); },
    remove: async (_user, uri) => { if (failRemoval && uri === b) throw new Error('remove unavailable'); return bytes.delete(uri); },
    setTags: async () => {}, rebuildMemoryDirectory: async () => {} };
  const overlay = { personMerges: async () => merges.filter(row => row.state !== 'undone'),
    recordPersonMerge: async (_user, revisionId, snapshot) => merges.push({ revisionId, keepUri: snapshot.keep.uri, mergeUri: snapshot.merge.uri, snapshot: structuredClone(snapshot), state: 'pending' }),
    settlePersonMerge: async (_user, id, state) => { merges.find(row => row.revisionId === id).state = state; },
    addRevision: async row => { const saved = { ...row, id: String(revisions.length + 1) }; revisions.push(saved); return saved; },
    markUndone: async (_user, id) => { revisions.find(row => row.id === id).undoneAt = 'now'; },
    queueSummaryInvalidation: async () => [], completeSummaryInvalidation: async () => {},
    upsertFile: async row => { metadata.set(row.uri, row); }, files: async () => metadata,
    removeFile: async (_user, uri) => { metadata.delete(uri); origins.delete(uri); },
    originsOf: async () => origins, syncOrigins: async (_user, uri) => { origins.set(uri, new Map()); },
    inheritOrigins: async (_user, uri, lines) => { origins.set(uri, new Map([...lines].map(([print, sources]) => [print, { ...sources[0], sources }]))); },
  };
  const snapshot = uri => ({ ...metadata.get(uri), origins: [...origins.get(uri)] });
  const deps = { userId: 'test-user', overlay, context: { sessions }, keep: snapshot(a), merge: snapshot(b), engineSession: 'dsh-current' };
  return { ...deps, deps, bytes, revisions, merges, metadata, origins, failRemoval: value => { failRemoval = value; } };
}
test('one merge revision retires the source through normal removal and one undo restores both exact bodies and origins', async () => {
  const f = fixture(), beforeOrigins = structuredClone(f.origins);
  await mergePeopleFiles(f.deps);
  assert.equal(f.revisions.length, 1);
  assert.equal(f.revisions[0].engineSession, undefined, 'the confirming conversation is not a source of the moved facts');
  assert.equal(f.merges[0].snapshot.confirmationSession, 'dsh-current');
  assert.equal(f.bytes.has(b), false); assert.equal(f.metadata.has(b), false);
  assert.match(f.bytes.get(a), /Weight: 50 kg/); assert.match(f.bytes.get(a), /Weight: 55 kg/);
  assert.equal(f.origins.get(a).get(lineFingerprint('Likes tea.')).sources.length, 2, 'an exact duplicate retains both sources');
  await undoPeopleMerge({ ...f.deps, operation: f.merges[0] });
  assert.equal(f.bytes.get(a), first); assert.equal(f.bytes.get(b), second);
  for (const [uri, rows] of beforeOrigins) for (const [print, origin] of rows) {
    assert.equal(f.origins.get(uri).get(print).archiveUri, origin.archiveUri);
  }
  assert.equal(f.merges[0].state, 'undone'); assert.equal(f.revisions[0].undoneAt, 'now');
});
test('a failed retirement keeps a durable before-image; retry is one revision and undo refuses changed or scrubbed snapshots', async () => {
  const f = fixture(); f.failRemoval(true);
  await assert.rejects(mergePeopleFiles(f.deps), /remove unavailable/);
  assert.equal(f.merges[0].state, 'pending'); assert.equal(f.revisions.length, 1);
  f.failRemoval(false); await mergePeopleFiles(f.deps);
  assert.equal(f.revisions.length, 1);
  f.bytes.set(a, `${f.bytes.get(a)}\n- A later edit.`);
  await assert.rejects(undoPeopleMerge({ ...f.deps, operation: f.merges[0] }), /changed/);
  f.merges[0].snapshot = null;
  await assert.rejects(undoPeopleMerge({ ...f.deps, operation: f.merges[0] }), /privacy deletion/);
});
test('later extraction at the confirmed retired path reaches the keeper, with source origins, but a near name never does', async () => {
  const f = fixture(); await mergePeopleFiles(f.deps);
  const body = '# 小王阿姨\n## 2026-11-14\n- Likes walking.';
  f.bytes.set(b, body); f.metadata.set(b, { uri: b, body, projectId: null, sensitive: false });
  f.origins.set(b, new Map([[lineFingerprint('Likes walking.'), { archiveUri: 'archive-later', engineSession: 'dsh-later' }]]));
  const unrelated = `${root}/people/大王阿姨.md`;
  f.bytes.set(unrelated, '# 大王阿姨\n- Another person.');
  await redirectPeopleWrites({ ...f.deps, uris: [b, unrelated] });
  assert.match(f.bytes.get(a), /2026-11-14\n- Likes walking/);
  assert.equal(f.bytes.has(b), false); assert.equal(f.bytes.has(unrelated), true);
  assert.equal(f.origins.get(a).get(lineFingerprint('Likes walking.')).archiveUri, 'archive-later');
});

test('the store independently refuses disabled, foreign, non-people, identical and cross-project targets', async () => {
  const { NativeMemoryStore } = await import('../src/nativeMemoryStore.mjs');
  const f = fixture(), user = { id: 'test-user' }, project = { id: 'default', userId: user.id };
  Object.assign(f.context.sessions, { engineUser: () => 'u-123456789012345678901234', userRoot: () => root.slice(0, -'/memories'.length) });
  f.overlay.otherProjectUris = async () => [];
  const store = new NativeMemoryStore({ sessions: f.context.sessions, overlay: f.overlay });
  store.files = async () => [...f.metadata.values()].map(file => ({ ...file, type: 'people' }));
  const call = (keep = a, merge = b) => store.people(user, project, { a: keep, b: merge, distinct: false, engineSession: 'dsh-current' });
  await assert.rejects(call(), /not enabled/);
  store.personMergeEnabled = true;
  await assert.rejects(call(a, a), /different/);
  await assert.rejects(call(a.replace('/people/', '/notes/')), /scope/);
  await assert.rejects(call(a.replace('u-123456789012345678901234', 'u-999999999999999999999999')), /context/);
  f.metadata.get(b).projectId = 'another-project';
  await assert.rejects(call(), /different project scopes/);
  f.metadata.get(b).projectId = null;
  const decisions = [];
  store.personEdges.set = async (...args) => { decisions.push(args); return { hidden: true }; };
  await store.people(user, project, { a, b, distinct: true, engineSession: 'dsh-current' });
  assert.deepEqual(decisions, [[user.id, personPairId(a, b), true]]);
  assert.equal(f.revisions.length, 0); assert.equal(f.bytes.get(a), first); assert.equal(f.bytes.get(b), second);
});

test('a redirected exact duplicate still transfers its new origin before the source is retired', async () => {
  const f = fixture(); await mergePeopleFiles(f.deps);
  f.bytes.set(b, second); f.metadata.set(b, { uri: b, body: second, projectId: null, sensitive: false });
  f.origins.set(b, new Map([[lineFingerprint('Weight: 55 kg'), { archiveUri: 'archive-new-confirmation', engineSession: 'dsh-later' }]]));
  await redirectPeopleWrites({ ...f.deps, uris: [b] });
  assert.ok(f.origins.get(a).get(lineFingerprint('Weight: 55 kg')).sources.some(source => source.archiveUri === 'archive-new-confirmation'));
  assert.equal(f.bytes.has(b), false);
});
