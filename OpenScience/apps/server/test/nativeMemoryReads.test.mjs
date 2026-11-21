// What reading an account's native memory costs the engine (r19-walkfix): the memory page asks for the list, a project's overview and the
// changes at once, and each of them read every file. A stub engine with a latency counts what reaches it.
import assert from "node:assert/strict";
import { test } from "node:test";

import { unzipSync } from 'fflate';
import { NativeMemoryStore, nativeFileId } from "../src/nativeMemoryStore.mjs";
import { NativeMemoryOverlay, contentHash, lineFingerprint } from '../src/nativeMemoryOverlay.mjs';
import { reconcileMemoryNames } from '../src/nativeMemoryNames.mjs';

const ROOT = "viking://user/u1/memories";

/** An engine of `count` files, each read taking `delay` ms; counts listings and reads. */
function engine({ count = 20, delay = 5 } = {}) {
  const files = new Map(Array.from({ length: count }, (_unused, index) => [`${ROOT}/preferences/p${index}.md`, { body: `- 偏好 ${index}`, modTime: `2026-10-18T01:00:${String(index).padStart(2, "0")}.000Z` }]));
  const calls = { tree: 0, read: 0, replace: 0 };
  const sessions = {
    configured: true,
    engineUser: () => 'u1',
    userRoot: () => 'viking://user/u1',
    memoryRoot: () => ROOT,
    async tree() {
      calls.tree += 1;
      return [...files].map(([uri, file]) => ({ uri, relPath: uri.slice(ROOT.length + 1), isDir: false, size: Buffer.byteLength(file.body), modTime: file.modTime, tags: [] }));
    },
    async read(_user, uri) {
      calls.read += 1;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return files.get(uri)?.body ?? null;
    },
    async replace(_user, uri, text) {
      calls.replace += 1;
      files.set(uri, { body: text, modTime: files.get(uri)?.modTime ?? "" });
      return true;
    },
    async remove(_user, uri) { return files.delete(uri); },
    async rebuildMemoryDirectory() {},
  };
  const overlay = {
    configured: true,
    files: async () => new Map(),
    revisionsOfMany: async () => new Map(), attributionCommits: async () => new Map(),
    sources: async () => [],
    queueSummaryInvalidation: async () => [], completeSummaryInvalidation: async () => {},
    reject: async () => {}, unreject: async () => {}, addRevision: async () => {}, upsertFile: async () => {}, setSources: async () => {}, syncOrigins: async () => {}, originsOf: async () => new Map(),
  };
  return { files, calls, store: new NativeMemoryStore({ sessions: /** @type {any} */ (sessions), overlay: /** @type {any} */ (overlay) }) };
}

test("three reads of one account that overlap are one read of the engine", async () => {
  const { store, calls } = engine({ count: 20 });
  const [profile, overview, again] = await Promise.all([store.files("u1"), store.files("u1"), store.records("u1")]);
  assert.equal(profile.length, 20);
  assert.equal(overview, profile, "the second caller shared the first's read");
  assert.equal(again.length, 20);
  assert.equal(calls.tree, 1, "one listing");
  assert.equal(calls.read, 20, "one read per file, not three");
});

test("a read that begins after another has ended is its own, but a file that has not changed is not read again", async () => {
  const { store, calls, files } = engine({ count: 10 });
  await store.files("u1");
  assert.equal(calls.read, 10);
  await store.files("u1");
  assert.equal(calls.tree, 2, "the listing is always the engine's");
  assert.equal(calls.read, 10, "no file moved, so no file was read");
  // The engine changes one file (its modTime moves): that file, and only that file, is read.
  const uri = `${ROOT}/preferences/p3.md`;
  files.set(uri, { body: "- 偏好 3，改过了", modTime: "2026-10-18T02:00:00.000Z" });
  const read = await store.files("u1");
  assert.equal(calls.read, 11);
  assert.equal(read.find((file) => file.uri === uri)?.body, "- 偏好 3，改过了");
  // A file the engine no longer lists is forgotten with it.
  files.delete(uri);
  assert.equal((await store.files("u1")).length, 9);
});

test("an engine without a modTime is read every time: nothing is kept that cannot be told from what changed", async () => {
  const { store, calls, files } = engine({ count: 4 });
  for (const [uri, file] of files) files.set(uri, { ...file, modTime: /** @type {any} */ (null) });
  await store.files("u1");
  await store.files("u1");
  assert.equal(calls.read, 8);
});

test("a write forgets the account's bodies, so the page reads back what it just wrote — even where the engine's clock did not move", async () => {
  const { store, calls, files } = engine({ count: 3 });
  // Keep this cache test independent of the removed-identifier filename migration.
  const original = `${ROOT}/preferences/p0.md`, uri = `${ROOT}/preferences/format.md`;
  files.set(uri, files.get(original)); files.delete(original);
  const record = (await store.records("u1")).find(candidate => candidate.uri === uri);
  assert.equal(calls.read, 3);
  const modTime = files.get(uri)?.modTime ?? "";
  // The engine rewrites the file at the same instant and the same length: only the store's own write can tell the cache the body is old.
  await store.update("u1", record.id, { value: "- 偏好 Z", expectedVersion: record.version });
  files.set(uri, { body: "- 偏好 Z", modTime });
  assert.equal(Buffer.byteLength("- 偏好 Z"), Buffer.byteLength("- 偏好 0"), "the same size, the same modTime");
  const read = (await store.files("u1")).find((file) => file.uri === uri);
  assert.equal(read?.body, "- 偏好 Z");
  assert.equal(calls.read, 7, "3 initial reads, 1 compare-and-swap read inside the write (under the lease), 3 by update's getRecord after the cache was invalidated");
});

test("a read that was under way when a write happened is not shared with the readers after it", async () => {
  const { store, calls } = engine({ count: 6, delay: 20 });
  const before = store.files("u1");
  // A write begins (the store counts it), then another reader arrives: it gets a read of its own.
  await store.remember("u1", { text: "记一下" }).catch(() => null);
  const after = store.files("u1");
  assert.notEqual(await before, await after);
  assert.equal(calls.tree, 2);
});

test('deferred-mode search excludes private undo before-images while the explicit record view retains them', async () => {
  const { store } = engine({ count: 0 });
  const record = { id: 'record', uri: `${ROOT}/notes/a.md`, value: 'Kept fact.', summary: 'Notes', revisions: [{ value: 'Withdrawn fact.' }] };
  store.records = async () => [record];
  store.overlay.deferredSummaryRebuildEnabled = true;
  const answer = await store.search('u1', '');
  assert.doesNotMatch(JSON.stringify(answer), /Withdrawn fact/);
  assert.match(JSON.stringify(answer), /Kept fact/);
  assert.equal((await store.records('u1'))[0].revisions[0].value, 'Withdrawn fact.');
  store.overlay.deferredSummaryRebuildEnabled = false;
  assert.equal((await store.search('u1', '')).items[0].revisions[0].value, 'Withdrawn fact.');
});

test('profile H1 is a visible editable row; forgetting the title preserves neighbours and rejects its old text', async () => {
  const { files, store } = engine({ count: 0, delay: 0 });
  const uri = `${ROOT}/profile.md`, rejected = [], revisions = [];
  store.overlay.addRevision = async row => { const revision = { ...row, id: `r${revisions.length}`, changedAt: '2026-11-17' }; revisions.push(revision); return revision; };
  store.overlay.forgottenRevisions = async () => revisions.filter(row => row.reason.startsWith('forgotten') && !row.undoneAt).reverse();
  store.overlay.revisionsOf = async () => revisions;
  store.overlay.revisionsOfMany = async () => new Map([[uri, [...revisions].reverse()]]);
  store.overlay.markUndone = async (_user, id) => { revisions.find(row => row.id === id).undoneAt = '2026-11-17'; };
  files.set(uri, { body: '# Mara Santos\n## Work\n- Works in design.', modTime: '2026-11-17' });
  store.overlay.reject = async (_user, _type, _uri, lines) => rejected.push(...lines);
  let records = await store.records('u1');
  const title = records.find(row => row.value === 'Mara Santos');
  assert.ok(title?.document, 'the ordinary row and drawer can reach the title');
  assert.equal(records.length, 2);
  const edited = await store.update('u1', title.id, { expectedVersion: title.version, value: 'Mara Chen' });
  assert.equal(edited.value, 'Mara Chen');
  assert.equal(edited.origin, 'manual', 'an edited title carries its real provenance into recall and export');
  assert.match(files.get(uri).body, /^# Mara Chen\n/);
  assert.ok(rejected.includes('Mara Santos'));
  await store.remove('u1', edited.id, { keepText: true });
  assert.doesNotMatch(files.get(uri).body, /Mara/);
  assert.match(files.get(uri).body, /Works in design/);
  assert.ok(rejected.includes('Mara Chen'));
  records = await store.records('u1');
  assert.equal(records.length, 1);
  const forgotten = (await store.forgotten('u1')).find(row => row.value === 'Mara Chen');
  assert.ok(forgotten, 'the forgotten drawer can reach and restore the title');
  const restored = await store.update('u1', forgotten.id, { status: 'active', expectedVersion: forgotten.version });
  assert.equal(restored.value, 'Mara Chen');
  assert.match(files.get(uri).body, /^# Mara Chen\n/);
  assert.doesNotMatch(files.get(uri).body, /Mara Santos/);
});

test('a profile H1 and its exact name bullet are one visible fact and forget and restore together', async () => {
  for (const target of ['title', 'bullet', 'conversation']) {
    const { files, store } = engine({ count: 0, delay: 0 });
    store.profileNameDedupeEnabled = true;
    const uri = `${ROOT}/profile.md`, rejected = [], revisions = [];
    const body = '# 林舟\n- 姓名：林舟 (as of 2026-11-17)\n- 喜欢游泳 (as of 2026-11-17)';
    store.overlay.addRevision = async row => { const revision = { ...row, id: `r${revisions.length}`, changedAt: '2026-11-17' }; revisions.push(revision); return revision; };
    store.overlay.forgottenRevisions = async () => revisions.filter(row => row.reason.startsWith('forgotten') && !row.undoneAt).reverse();
    store.overlay.revisionsOf = async () => revisions;
    store.overlay.revisionsOfMany = async () => new Map([[uri, [...revisions].reverse()]]);
    store.overlay.markUndone = async (_user, id) => { revisions.find(row => row.id === id).undoneAt = '2026-11-17'; };
    store.overlay.reject = async (_user, _type, _uri, lines) => rejected.push(...lines);
    files.set(uri, { body, modTime: '2026-11-17' });
    const records = await store.records('u1');
    assert.deepEqual(records.map(row => row.value).sort(), ['喜欢游泳', '林舟'].sort());
    const id = target === 'title' ? records.find(row => row.value === '林舟').id
      : `${nativeFileId(uri)}_${lineFingerprint('姓名：林舟').slice(0, 12)}`;
    if (target === 'conversation') {
      await store.forgetLines('u1', (await store.files('u1'))[0], ['姓名：林舟']);
    } else await store.remove('u1', id, { keepText: true });
    assert.equal(files.get(uri).body, '- 喜欢游泳 (as of 2026-11-17)');
    assert.ok(rejected.includes('林舟')); assert.ok(rejected.some(row => row.startsWith('姓名：林舟')));
    const forgotten = await store.forgotten('u1');
    assert.equal(forgotten.length, 1); assert.equal(forgotten[0].value, '林舟');
    await store.update('u1', forgotten[0].id, { status: 'active', expectedVersion: forgotten[0].version });
    assert.equal(files.get(uri).body, body);
    assert.equal((await store.records('u1')).filter(row => row.value === '林舟').length, 1);
    assert.ok(revisions[0].undoneAt);
  }
});

test('duplicate profile names are opt-in and ambiguous or structural titles keep independent rows', async () => {
  const { store, files } = engine({ count: 0, delay: 0 }), uri = `${ROOT}/profile.md`;
  files.set(uri, { body: '# 林舟\n- 姓名林舟\n- 昵称：小舟', modTime: '1' });
  assert.deepEqual((await store.records('u1')).map(row => row.value), ['林舟', '姓名林舟', '昵称：小舟']);
  store.profileNameDedupeEnabled = true;
  assert.deepEqual((await store.records('u1')).map(row => row.value), ['林舟', '昵称：小舟']);
  for (const title of ['# Profile', '# 林舟\n# 林川']) {
    files.set(uri, { body: `${title}\n- 姓名林舟`, modTime: title });
    assert.ok((await store.records('u1')).some(row => row.value === '姓名林舟'));
  }
});

test('profile and preference values use the newer revision, read with an earlier label and reconcile without rejection', async () => {
  for (const newer of ['profile', 'preference']) {
    const { files, store } = engine({ count: 0, delay: 0 });
    const profile = `${ROOT}/profile.md`, preference = `${ROOT}/preferences/language.md`, rejected = [];
    Object.assign(store, { preferenceReconcileEnabled: true, preferenceJudge: { available: true, overlaps: async () => [{ profile: 0, preference: 0 }] } });
    store.overlay.reject = async (...args) => rejected.push(args);
    files.set(profile, { body: `# 用户\n- 回答一律用中文 (as of ${newer === 'profile' ? '2026-11-03' : '2026-11-01'})`, modTime: newer === 'profile' ? '2026-11-03' : '2026-11-01' });
    files.set(preference, { body: '- 回答一律用英文\n- 表格不超过五列', modTime: newer === 'preference' ? '2026-11-03' : '2026-11-01' });
    const records = await store.records('u1');
    const old = records.find(row => row.uri === (newer === 'profile' ? preference : profile));
    assert.deepEqual(old.earlierValues, [newer === 'profile' ? '回答一律用英文' : '回答一律用中文']);
    assert.match(await store.preferenceRecallText('u1', old.uri, old.value), /\[earlier value\]/);
    assert.deepEqual((await store.reconcilePreferences('u1')).removed, 1);
    assert.doesNotMatch(files.get(old.uri).body, /回答一律用/);
    assert.match(files.get(newer === 'profile' ? profile : preference).body, /回答一律用/);
    if (newer === 'profile') assert.match(files.get(preference).body, /表格不超过五列/);
    assert.deepEqual(rejected, [], 'platform reconciliation is not a forget or a ban on the old words');
  }
  const { files, store } = engine({ count: 0, delay: 0 }), rejected = [];
  const profile = `${ROOT}/profile.md`, preference = `${ROOT}/preferences/language.md`;
  Object.assign(store, { preferenceReconcileEnabled: true, preferenceJudge: { available: true, overlaps: async () => [{ profile: 0, preference: 0 }] } });
  store.overlay.reject = async (...args) => rejected.push(args);
  store.overlay.forgetText = async () => {}; store.overlay.removeFile = async () => {};
  files.set(profile, { body: '# 用户\n- 回答一律用中文', modTime: '2026-11-03' });
  files.set(preference, { body: '- 回答一律用英文', modTime: '2026-11-01' });
  await store.reconcilePreferences('u1');
  assert.equal(files.has(preference), false, 'an empty old preference file is retired');
  assert.deepEqual(rejected, [], 'retiring that file still creates no withdrawal authority');
});

test('two superseded statements in one profile produce one rewrite and retain the other statements', async () => {
  const { files, store, calls } = engine({ count: 0, delay: 0 }), profile = `${ROOT}/profile.md`, preference = `${ROOT}/preferences/work.md`;
  files.set(profile, { body: '# User\n- Chinese\n- Five columns\n- Likes tea', modTime: '2026-11-01' });
  files.set(preference, { body: '- English\n- Three columns', modTime: '2026-11-20' });
  Object.assign(store, { preferenceReconcileEnabled: true, preferenceJudge: { available: true,
    overlaps: async () => [{ profile: 0, preference: 0 }, { profile: 1, preference: 1 }] } });
  assert.deepEqual(await store.reconcilePreferences('u1', [preference]), { removed: 2 });
  assert.equal(files.get(profile).body, '# User\n- Likes tea');
  assert.equal(files.get(preference).body, '- English\n- Three columns');
  assert.equal(calls.replace, 1);
});

test('a concurrent withdrawal of the proposed current value makes the judged rewrite inapplicable', async () => {
  const { files, store, calls } = engine({ count: 0, delay: 0 }), profile = `${ROOT}/profile.md`, preference = `${ROOT}/preferences/work.md`;
  files.set(profile, { body: '# User\n- Chinese', modTime: '2026-11-01' });
  files.set(preference, { body: '- English', modTime: '2026-11-20' });
  Object.assign(store, { preferenceReconcileEnabled: true, preferenceJudge: { available: true, overlaps: async () => {
    files.delete(preference); return [{ profile: 0, preference: 0 }];
  } } });
  assert.deepEqual(await store.reconcilePreferences('u1'), { removed: 0 });
  assert.equal(files.get(profile).body, '# User\n- Chinese');
  assert.equal(files.has(preference), false);
  assert.equal(calls.replace, 0);
});

test('unrelated profile edits do not promote an old preference and sensitive or project facts never reach the judge', async () => {
  const { files, store } = engine({ count: 0, delay: 0 }), profile = `${ROOT}/profile.md`, current = `${ROOT}/preferences/work.md`;
  files.set(profile, { body: '# Mara\n- Chinese (as of 2026-01-01)\n- Swims', modTime: '2026-11-20' });
  files.set(current, { body: '- English', modTime: '2026-11-01' });
  const meta = new Map();
  for (const [name, flags] of [['sensitive', { sensitive: true }], ['project', { projectId: 'other' }]]) {
    const uri = `${ROOT}/preferences/${name}.md`;
    files.set(uri, { body: '- Private', modTime: '2026-11-05' }); meta.set(uri, flags);
  }
  store.overlay.files = async () => meta;
  let seen;
  Object.assign(store, { preferenceReconcileEnabled: true, preferenceJudge: { available: true, overlaps: async input => {
    seen = input; return [{ profile: input.profile.indexOf('Chinese'), preference: 0 }];
  } } });
  const records = await store.records('u1');
  assert.deepEqual(seen.profile.sort(), ['Chinese', 'Swims']);
  assert.deepEqual(seen.preferences, ['English']);
  assert.deepEqual(records.find(row => row.value === 'Chinese').earlierValues, ['Chinese']);
  assert.deepEqual(await store.reconcilePreferences('u1', [`${ROOT}/notes/else.md`]), { removed: 0 });
  assert.equal(await store.preferenceRecallText('u1', profile, files.get(profile).body), '# Mara\n- [earlier value] Chinese (as of 2026-01-01)\n- Swims');
});

test('people cards offer only unconfirmed name hints on the page and honour a distinct-person decision', async () => {
  const { files, store } = engine({ count: 0, delay: 0 });
  Object.assign(store, { personAliasHintEnabled: true, personMergeEnabled: true });
  const a = `${ROOT}/people/王阿姨.md`, b = `${ROOT}/people/小王阿姨.md`, other = `${ROOT}/people/陈主任.md`;
  files.set(a, { body: '# 王阿姨\n- Likes tea.', modTime: '2026-11-17' });
  files.set(b, { body: '# 小王阿姨\n- Likes walking.', modTime: '2026-11-17' });
  files.set(other, { body: '# 陈主任\n- Works nearby.', modTime: '2026-11-17' });
  const records = await store.records('u1');
  assert.deepEqual(records.find(row => row.uri === a).possibleSamePerson.map(row => row.label), ['小王阿姨']);
  assert.deepEqual(records.find(row => row.uri === other).possibleSamePerson, []);
  const { personPairId } = await import('../src/nativeMemoryPeople.mjs');
  store.personEdges.dismissed = async () => new Set([personPairId(a, b)]);
  assert.deepEqual((await store.records('u1')).find(row => row.uri === a).possibleSamePerson, []);
});

test('homophones can prompt confirmation while sensitive, withdrawn and other-project names stay out', async () => {
  const { files, store } = engine({ count: 0, delay: 0 });
  Object.assign(store, { personAliasHintEnabled: true, personMergeEnabled: true });
  const metadata = new Map();
  store.overlay.files = async () => metadata;
  for (const [name, meta] of [['林舟', {}], ['临洲', {}], ['琳周', { sensitive: true }], ['邻州', { projectId: 'other' }], ['林周', {}]]) {
    const uri = `${ROOT}/people/${name}.md`;
    files.set(uri, { body: `# ${name}\n- Likes tea.`, modTime: '2026-11-21' }); metadata.set(uri, meta);
  }
  store.sourceDeletion = { hiddenMemoryUris: async () => [`${ROOT}/people/林周.md`], redactRecords: async (_u, records) => records };
  const records = await store.records('u1');
  assert.deepEqual(records.find(row => row.summary === '林舟').possibleSamePerson.map(row => row.label), ['临洲']);
  assert.equal(files.size, 5);
});

test('a file heading is its visible title, rather than a stale filename after correction', async () => {
  const { files, store } = engine({ count: 0, delay: 0 });
  files.set(`${ROOT}/people/old-label.md`, { body: '# Current name\n- Independent fact.', modTime: '2026-11-17' });
  const [record] = await store.records('u1');
  assert.equal(record.summary, 'Current name');
  assert.match(record.value, /Independent fact/);
});

for (const name of ['Edited_note', 'edited_note']) for (const first of ['edit', 'reconcile']) {
  test(`safe page rename with ${name} runs ${first} first without restoring a withdrawn path`, async () => {
    const { files, store } = engine({ count: 0, delay: 0 });
    const uri = `${ROOT}/preferences/${name}.md`, sibling = `${ROOT}/preferences/EDITED NOTE.md`;
    const rejectedName = contentHash(`${uri}:0`).slice(0, 24);
    const safe = `${ROOT}/preferences/${contentHash(`${uri}:1`).slice(0, 24)}.md`;
    const removals = [{ text: `Project identifier "${rejectedName}".`, fingerprint: 'prior' }];
    const metadata = new Map();
    for (const [index, path] of [uri, sibling].entries()) {
      files.set(path, { body: 'Project "Edited".', modTime: '2026-11-17' });
      metadata.set(path, { uri: path, body: 'Project "Edited".', createdAt: String(index) });
    }
    const overlay = store.overlay;
    overlay.files = async () => new Map(metadata);
    overlay.removals = async () => removals;
    overlay.reject = async (_user, _type, _uri, lines) => removals.push(...lines.map(text => ({ text, fingerprint: lineFingerprint(text) })));
    overlay.upsertFile = async row => metadata.set(row.uri, row);
    overlay.removeFile = async (_user, path) => metadata.delete(path);
    overlay.inheritOrigins = async () => {};
    const reconcile = () => reconcileMemoryNames({ userId: 'u1', context: { sessions: store.sessions }, overlay });
    const edit = async () => {
      const record = (await store.records('u1')).find(row => row.uri === uri);
      await store.update('u1', record.id, { value: '- Independent replacement.', expectedVersion: record.version });
    };
    if (first === 'edit') { await edit(); await reconcile(); }
    else { await reconcile(); await edit(); }
    assert.equal(files.has(uri), false);
    assert.equal(files.has(`${ROOT}/preferences/${rejectedName}.md`), false);
    assert.equal(files.get(safe)?.body, '- Independent replacement.');
  });
}


test('neutral profile headings never become records or targets, including title-only files and old forgets', async () => {
  for (const title of ['用户', 'User']) {
    const { files, store } = engine({ count: 0, delay: 0 });
    const uri = `${ROOT}/profile.md`;
    files.set(uri, { body: `# ${title}`, modTime: '2026-11-17' });
    assert.deepEqual(await store.records('u1'), []);
    assert.deepEqual((await store.search('u1', '')).items, []);
    store.overlay.memoryForgetBody = async (_user, _uri, body) => body;
    const pack = unzipSync(await store.exportPack('u1'));
    assert.deepEqual(JSON.parse(Buffer.from(pack['manifest.json']).toString()).files, []);
    store.overlay.forgottenRevisions = async () => [{ id: 'legacy', uri, change: 'updated', reason: 'forgotten', actor: 'user',
      before: `# ${title}\n- Designs reports.`, after: '- Designs reports.' }];
    assert.deepEqual(await store.forgotten('u1'), []);
  }
});

test('source history includes named profile titles but excludes the neutral scaffold', async () => {
  const { store } = engine({ count: 0 });
  const uri = `${ROOT}/profile.md`;
  store.overlay.sourceRevisions = async () => [
    { uri, before: '# User\n- Independent B.', after: '# Private A\n- Independent B.' },
    { uri: `${ROOT}/notes/a.md`, before: '', after: '# Notes\n- Source A fact.' },
  ];
  store.overlay.consolidationRevisions = async () => [];
  const contributions = await store.sourceHistoryContributions('u1', 'default', ['a'], 'viking://user/u1');
  assert.deepEqual(contributions.map(row => row.lines), [['# Private A'], ['Source A fact.']]);
  store.overlay.consolidationRevisions = async () => [{ uri, before: '# Private A\n- Independent B.', after: '# Reworded A\n- Independent B.' }];
  assert.equal((await store.sourceHistoryContributions('u1', 'default', ['a'], 'viking://user/u1')).at(-1).unverifiedRoot, 'viking://user/u1');
});

test('source cleanup removes its identity row and preserves an independent identity-only profile', async () => {
  const { lineFingerprint } = await import('../src/nativeMemoryOverlay.mjs');
  for (const removeTitle of [true, false]) {
    const { store, files } = engine({ count: 0, delay: 0 });
    const uri = `${ROOT}/profile.md`, scrubbed = [];
    files.set(uri, { body: '# Named person\n- Body preference.', modTime: '2026-11-17' });
    Object.assign(store.overlay, {
      sourceRevisions: async () => [], consolidationRevisions: async () => [], revisionsOf: async () => [],
      conversationOf: async (_user, session) => session.slice(4), projectOfSession: async () => null,
      withdrawConversationSource: async () => [], pendingSummaryInvalidations: async () => [],
      scrubLines: async (_user, _uri, lines) => scrubbed.push(...lines),
      originsOf: async () => new Map([[uri, new Map([
        [lineFingerprint('# Named person'), { engineSession: removeTitle ? 'dsh-a' : 'dsh-b', projectId: 'default' }],
        [lineFingerprint('Body preference.'), { engineSession: removeTitle ? 'dsh-b' : 'dsh-a', projectId: 'default' }],
      ])]]),
    });
    await store.removeConversationSource('u1', 'default', ['a']);
    assert.equal(files.get(uri)?.body, removeTitle ? '- Body preference.' : '# Named person');
    assert.deepEqual(scrubbed, [removeTitle ? '# Named person' : 'Body preference.']);
  }
});

for (const { sourceOwnsTitle, heading } of [
  { sourceOwnsTitle: false, heading: '  # Facts  \r' },
  { sourceOwnsTitle: true, heading: '# Private A' },
  { sourceOwnsTitle: true, heading: '# Facts' },
]) {
  test(`source cleanup ${sourceOwnsTitle ? 'scrubs its name' : 'preserves a foreign heading byte for byte'} (${heading.trim()}) in current and retained revisions`, async () => {
    const { store, files } = engine({ count: 0, delay: 0 });
    const uri = `${ROOT}/profile.md`;
    const before = sourceOwnsTitle ? '' : `${heading}\n\n\n`;
    const sourceBody = sourceOwnsTitle ? `${heading}\n- Source A.` : `${before}- Source A.`;
    const body = `${sourceBody}\n- Independent B.\n`;
    const revisions = [
      { id: '1', uri, before, after: sourceBody, engineSession: 'dsh-a', reason: '' },
      { id: '2', uri, before: sourceBody, after: body, engineSession: 'dsh-b', reason: '' },
    ];
    // Exercise the real revision scrubber; the adapter only stores its SQL reads/writes.
    const overlay = new NativeMemoryOverlay({ database: {
      transaction: async () => {},
      query: async (sql, values) => {
        if (sql.startsWith('SELECT 1 FROM evimed_memory.native_markers')) return { rows: [{}] };
        if (sql.startsWith('SELECT id, before, after FROM evimed_memory.native_revisions')) return { rows: revisions.map(row => ({ ...row })) };
        if (sql.startsWith('UPDATE evimed_memory.native_revisions SET before=$3')) {
          const row = revisions.find(row => row.id === values[1]);
          Object.assign(row, { before: values[2], after: values[3], reason: `${row.reason} [source-deleted]` });
          return { rows: [] };
        }
        if (sql.startsWith('UPDATE evimed_memory.native_person_merges SET snapshot=NULL')) return { rows: [] };
        assert.fail(`Unexpected revision SQL: ${sql}`);
      },
    } });
    const origins = new Map([
      [lineFingerprint(heading), { engineSession: sourceOwnsTitle ? 'dsh-a' : 'dsh-b', projectId: 'default' }],
      [lineFingerprint('Source A.'), { engineSession: 'dsh-a', projectId: 'default' }],
      [lineFingerprint('Independent B.'), { engineSession: 'dsh-b', projectId: 'default' }],
    ]);
    Object.assign(store.overlay, {
      sourceRevisions: async () => revisions.filter(row => row.engineSession === 'dsh-a'),
      consolidationRevisions: async () => [], revisionsOf: async () => [],
      conversationOf: async (_user, session) => session?.slice(4), projectOfSession: async () => null,
      withdrawConversationSource: async () => [], pendingSummaryInvalidations: async () => [],
      originsOf: async () => new Map([[uri, origins]]),
      scrubLines: overlay.scrubLines.bind(overlay),
      addRevision: async row => { const revision = { ...row, id: String(revisions.length + 1) }; revisions.push(revision); return revision; },
    });
    files.set(uri, { body, modTime: '2026-11-17' });
    const contributions = await store.sourceHistoryContributions('u1', 'default', ['a'], 'viking://user/u1');
    assert.deepEqual(contributions[0].lines, sourceOwnsTitle ? [heading, 'Source A.'] : ['Source A.']);
    await store.removeConversationSource('u1', 'default', ['a']);
    const expected = `${before}- Independent B.\n`;
    assert.equal(files.get(uri).body, expected);
    const scrubbedSource = sourceOwnsTitle ? '' : `${heading}\n\n`;
    assert.deepEqual(revisions.map(({ before: prior, after }) => [prior, after]), [
      [before, scrubbedSource], [scrubbedSource, expected], [expected, expected],
    ]);
    assert.doesNotMatch(JSON.stringify(revisions), /Private A|Source A\./);
  });
}

test('an identical admission committing at the same moment is read back instead of failing on the engine-session index', async () => {
  const row = { user_id: 'u', candidate_id: 'stated:x', candidate_revision: 1, engine_session: 'evimed-stated-x', project_id: null,
    pending_text: 'Use metric units.', external_source: null, state: 'pending', phase: 'queued', record_ids: [], created_at: new Date(0), updated_at: new Date(0) };
  const collision = constraint => Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505', constraint });
  const overlayWith = failures => {
    let inserts = 0;
    const overlay = new NativeMemoryOverlay({ database: { transaction: async () => {}, query: async sql => {
      if (!sql.startsWith('INSERT INTO evimed_memory.native_admissions')) return { rows: [{}] };
      inserts += 1;
      if (failures.length) throw failures.shift();
      return { rows: [row] };
    } } });
    return { overlay, inserts: () => inserts };
  };
  const input = { candidateId: 'stated:x', revision: 1, engineSession: 'evimed-stated-x', text: 'Use metric units.' };
  const raced = overlayWith([collision('native_admissions_user_id_engine_session_key')]);
  assert.equal((await raced.overlay.queueAdmission('u', input)).candidateId, 'stated:x');
  assert.equal(raced.inserts(), 2);
  // A second collision is not a race with a twin: the first error is raised, once.
  const first = collision('native_admissions_user_id_engine_session_key');
  const stuck = overlayWith([first, collision('native_admissions_user_id_engine_session_key')]);
  await assert.rejects(stuck.overlay.queueAdmission('u', input), error => error === first);
  assert.equal(stuck.inserts(), 2);
  // Any other constraint is never retried.
  const other = overlayWith([collision('native_admissions_pkey')]);
  await assert.rejects(other.overlay.queueAdmission('u', input), error => error.constraint === 'native_admissions_pkey');
  assert.equal(other.inserts(), 1);
});

test('native ZIP titles map only filtered headings to opaque paths', async () => {
  const { files, store } = engine({ count: 0, delay: 0 });
  files.set(`${ROOT}/notes/private-withdrawn-name.md`, { body: '# Private withdrawn name\n- Keep this detail.', modTime: '' });
  files.set(`${ROOT}/notes/plan.md`, { body: '# Research plan\n- Keep the schedule.', modTime: '' });
  store.overlay.memoryForgetBody = async (_user, _uri, body) => body.replace(/^# Private withdrawn name\n/, '');
  const zip = unzipSync(await store.exportPack('u1'));
  const manifest = JSON.parse(Buffer.from(zip['manifest.json']).toString());
  const titles = JSON.parse(Buffer.from(zip[manifest.titles]).toString());
  assert.equal(titles.schemaVersion, 1);
  assert.deepEqual(titles.files.map(entry => entry.path), manifest.files.map(entry => entry.path));
  for (const { path, title } of titles.files) {
    assert.match(path, /^memories\/[a-f0-9]{24}\.md$/);
    const body = Buffer.from(zip[path]).toString();
    assert.equal(title, body.includes('Keep the schedule.') ? 'Research plan' : null);
  }
  assert.doesNotMatch(Object.entries(zip).map(([path, bytes]) => `${path}\n${Buffer.from(bytes)}`).join('\n'), /private[- ]withdrawn[- ]name/i);
});
