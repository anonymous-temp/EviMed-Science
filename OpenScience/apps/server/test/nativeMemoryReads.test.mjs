// What reading an account's native memory costs the engine (r19-walkfix): the memory page asks for the list, a project's overview and the
// changes at once, and each of them read every file. A stub engine with a latency counts what reaches it.
import assert from "node:assert/strict";
import { test } from "node:test";

import { unzipSync } from 'fflate';
import { NativeMemoryStore } from "../src/nativeMemoryStore.mjs";
import { NativeMemoryOverlay, lineFingerprint } from '../src/nativeMemoryOverlay.mjs';

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

test('a file heading is its visible title, rather than a stale filename after correction', async () => {
  const { files, store } = engine({ count: 0, delay: 0 });
  files.set(`${ROOT}/people/old-label.md`, { body: '# Current name\n- Independent fact.', modTime: '2026-11-17' });
  const [record] = await store.records('u1');
  assert.equal(record.summary, 'Current name');
  assert.match(record.value, /Independent fact/);
});


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
