import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const load = () => import('../src/sourceConversationStorage.mjs');
const header = (id, extra = {}) => ({ id, version: 4, createdAt: 1, cwd: '/workspace', isSeeded: false, delegationDepth: 0, ...extra });

test('the pinned layout encodes UTF-16 and distinguishes absent cwd from slash cwd', async () => {
  const { sourceSessionRelativePath } = await load();
  assert.equal(sourceSessionRelativePath(header('a/~😀', { cwd: 'C:\\研究//workspace' })), '--C-~7814~7A76-workspace--/a~002F~007E~D83D~DE00');
  assert.equal(sourceSessionRelativePath(header('..', { cwd: undefined })), '_no-cwd/~002E~002E');
  assert.equal(sourceSessionRelativePath(header('a', { cwd: '/' })), '--root--/a');
});

test('managed children follow their native origin recursively while independent forks survive', async () => {
  const { sourceClosure } = await load();
  const rows = [header('a'), header('child', { origin: 'subagent', parentSession: 'a' }),
    header('grandchild', { origin: 'subagent', parentSession: 'child' }), header('fork', { parentSession: 'a', isSeeded: true })];
  assert.deepEqual(sourceClosure(rows, 'a').map(row => row.id).sort(), ['a', 'child', 'grandchild']);
  assert.throws(() => sourceClosure([...rows, header('a', { createdAt: 2 })], 'a'), /identity/);
});

test('purge removes only proven directories and matching native references, and retries safely', async () => {
  const { captureSourceStorage, purgeSourceStorage, sourceSessionRelativePath } = await load();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'source-storage-'));
  try {
    const paths = { sessions: path.join(root, 'sessions'), storages: path.join(root, 'storages') };
    const rows = [header('a'), header('child', { origin: 'subagent', parentSession: 'a' }), header('b'), header('fork', { parentSession: 'a', isSeeded: true })];
    for (const row of rows) { const dir = path.join(paths.sessions, sourceSessionRelativePath(row)); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, 'session.v4.jsonl.zstd'), 'synthetic native bytes'); }
    const workspaces = { w: { path: '/workspace', title: 'kept', sessionIds: ['a', 'child', 'b', 'fork'], createdAt: 1, updatedAt: 2 } };
    let global = { initialized: true, workspaceIds: ['w'], archivedSessionIds: ['a', 'b'], pinnedSessionIds: ['child', 'fork'] };
    const cache = Object.fromEntries(rows.map(row => [row.id, { title: row.id }]));
    const native = {
      headers: async () => { const found = []; for (const row of rows) if (await fs.stat(path.join(paths.sessions, sourceSessionRelativePath(row))).catch(() => null)) found.push(row); return found; },
      scrubReferences: async ids => { for (const id of ids) delete cache[id]; for (const row of Object.values(workspaces)) row.sessionIds = row.sessionIds.filter(id => !ids.has(id)); global = { ...global, archivedSessionIds: global.archivedSessionIds.filter(id => !ids.has(id)), pinnedSessionIds: global.pinnedSessionIds.filter(id => !ids.has(id)) }; },
    };
    const frozen = await captureSourceStorage(paths, 'a', native);
    assert.equal(frozen.root.id, 'a');
    assert.deepEqual(frozen.sessions.map(row => row.id).sort(), ['a', 'child']);
    assert.deepEqual((await purgeSourceStorage(paths, frozen, native)).removedSessionIds.sort(), ['a', 'child']);
    assert.deepEqual(workspaces.w.sessionIds, ['b', 'fork']); assert.deepEqual(Object.keys(cache).sort(), ['b', 'fork']);
    assert.deepEqual(global.archivedSessionIds, ['b']); assert.deepEqual(global.pinnedSessionIds, ['fork']);
    assert.deepEqual((await purgeSourceStorage(paths, frozen, native)).removedSessionIds.sort(), ['a', 'child']);
    assert.equal(await fs.readFile(path.join(paths.sessions, sourceSessionRelativePath(rows[2]), 'session.v4.jsonl.zstd'), 'utf8'), 'synthetic native bytes');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('changed root identities, duplicate physical copies and symlinked source trees refuse purge', async () => {
  const { captureSourceStorage, purgeSourceStorage, sourceSessionRelativePath } = await load();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'source-storage-'));
  try {
    const paths = { sessions: path.join(root, 'sessions'), storages: path.join(root, 'storages') };
    const a = header('a'); let rows = [a];
    const dir = path.join(paths.sessions, sourceSessionRelativePath(a)); await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'session.v4.jsonl.zstd'), 'original');
    const native = { headers: async () => rows, scrubReferences: async () => {} };
    const frozen = await captureSourceStorage(paths, 'a', native);
    rows = [header('a', { createdAt: 2 })];
    await assert.rejects(purgeSourceStorage(paths, frozen, native), /identity/);
    rows = [a]; await fs.mkdir(path.join(paths.sessions, '--other--', 'a'), { recursive: true });
    await assert.rejects(captureSourceStorage(paths, 'a', native), /identity/);
    await fs.rm(path.join(paths.sessions, '--other--'), { recursive: true });
    await fs.symlink(root, path.join(dir, 'escape'));
    await assert.rejects(purgeSourceStorage(paths, frozen, native), /symbolic|unsafe/);
    assert.equal(await fs.readFile(path.join(dir, 'session.v4.jsonl.zstd'), 'utf8'), 'original');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
