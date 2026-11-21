import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { migrateSafetyNotes, safetySelections, withdrawSafetyProjection } from '../src/memorySafetyMigration.mjs';
import { contentHash, lineFingerprint } from '../src/nativeMemoryOverlay.mjs';

const root = 'viking://user/owner/memories';
function scene(type = 'people') {
  const uri = root + (type === 'profile' ? '/profile.md' : '/people/owner.md');
  const text = '# Account owner\n- I report a reaction dated October 1.\n  Only when X is present.\n- I dislike coffee.';
  const files = new Map([[uri, { uri, type, body: text, hash: contentHash(text), contentHash: contentHash(text), projectId: 'first' }]]);
  const bindings = new Map(), decisions = new Set(), removals = [], hidden = [];
  const settings = { learningPaused: false, pausedProjects: [] };
  let calls = 0, writes = 0;
  const deps = {
    config: { memorySafetyNotesEnabled: true, memorySafetyNotesMigrationEnabled: true },
    settings: { settings: async () => settings },
    store: { files: async (_user, { uris }) => uris.map(uri => files.get(uri)).filter(Boolean),
      records: async (_user, { files: [file] }) => (type === 'profile' ? file.body.split('\n').map(line => line.replace(/^[-#] /, '').trim()) : [file.body])
        .map(value => ({ value, updatedAt: '2026-10-01' })) },
    overlay: { files: async () => files, claimSafetyScan: async () => ({ cursor: '' }), noteSafetyScan: async () => {}, sensitiveUris: async () => hidden,
      removals: async () => removals, instructionCheck: async (_u, key) => decisions.has(key),
      originsOf: async () => new Map(), inheritOrigins: async () => {}, bindSafetySource: async (_u, uri, binding) => bindings.set(uri, binding),
      upsertFile: async () => {}, recordInstructionCheck: async (_u, key) => decisions.add(key) },
    sessions: { settings: async () => ({ memoryTypes: ['safety_notes'] }), memoryRoot: () => root, tree: async () => [...files.values()], read: async (_u, uri) => files.get(uri)?.body ?? null,
      replace: async (_u, uri, body) => { writes++; files.set(uri, { uri, body }); } },
    classify: async () => { calls++; return [[2,3]]; },
  };
  return { uri, text, deps, bindings, decisions, removals, hidden, files, settings, counts: () => [calls, writes],
    run: () => migrateSafetyNotes(deps, 'owner') };
}

test('only valid complete source ranges can be materialized', () => {
  for (const ranges of [null, 'replacement text', [[0,1]], [[1,4]], [[2,1]], [[2,2],[2,2]], [[1,1]], [[1.5,2]]])
    assert.throws(() => safetySelections(['# A','Original','Exception'], ranges));
  assert.deepEqual(safetySelections(['# A','Original','  Except X'], [[2,2]]), [['Original','  Except X']]);
  assert.deepEqual(safetySelections(['# A','Original','Exception'], [[2,3]]), [['Original','Exception']]);
});

for (const type of ['people','profile']) test(type + ' migration is source-bound and idempotent after a partial write', async () => {
  const f = scene(type);
  const save = f.deps.overlay.recordInstructionCheck;
  f.deps.overlay.recordInstructionCheck = async () => { throw new Error('unavailable'); };
  await assert.rejects(f.run(), /unavailable/);
  f.deps.overlay.recordInstructionCheck = save;
  await f.run();
  await f.run();
  assert.deepEqual(f.counts(), [2,1]);
  const [[uri, binding]] = f.bindings;
  assert.ok(uri.startsWith(root + '/safety_notes/legacy-'));
  assert.equal(binding.uri, f.uri); assert.equal(binding.updatedAt, '2026-10-01');
  assert.deepEqual(binding.lineHashes, f.text.split('\n').slice(1,3).map(line => createHash('sha256').update(line).digest('hex')));
  assert.equal(f.files.get(uri).body, f.text.split('\n').slice(0,3).join('\n'));
});

test('previously withdrawn, paused, hidden and shared records never reach the classifier', async () => {
  for (const gate of ['rejected','paused','project','hidden','shared','off','limited']) {
    const f = scene();
    if (gate === 'rejected') f.removals.push({ text: 'I report a reaction dated October 1.', fingerprint: lineFingerprint('I report a reaction dated October 1.') });
    if (gate === 'paused') f.settings.learningPaused = true;
    if (gate === 'project') f.settings.pausedProjects = ['first'];
    if (gate === 'hidden') f.hidden.push(f.uri);
    if (gate === 'shared') f.files.get(f.uri).uri = f.uri.replace('/owner/', '/shared/');
    if (gate === 'off') f.deps.config.memorySafetyNotesMigrationEnabled = false;
    if (gate === 'limited') f.deps.overlay.claimSafetyScan = async () => false;
    await f.run();
    assert.deepEqual(f.counts(), [0,0], gate);
  }
});

test('a withdrawal or source change during classification cannot publish a stale result', async () => {
  for (const change of ['rejected', 'edited', 'hidden', 'deleted', 'paused']) {
    const f = scene();
    f.deps.classify = async () => {
      if (change === 'rejected') f.removals.push({ fingerprint: 'withheld' });
      if (change === 'edited') f.files.get(f.uri).body += ' changed';
      if (change === 'hidden') f.hidden.push(f.uri);
      if (change === 'deleted') f.files.delete(f.uri);
      if (change === 'paused') f.settings.learningPaused = true;
      return [[2,3]];
    };
    await f.run(); assert.equal(f.bindings.size, 0, change); assert.equal(f.decisions.size, 0, change);
  }
});

test('withdrawal removes the bound statement and its exception while preserving independently added facts', async () => {
  const f = scene(); await f.run();
  const [[uri, binding]] = f.bindings;
  const copy = f.files.get(uri).body;
  const changed = f.text.replace('  Only when X is present.', '');
  assert.equal(withdrawSafetyProjection(f.text, f.text, binding, copy), null);
  assert.equal(withdrawSafetyProjection(f.text, changed, binding, copy).body, '');
  assert.equal(withdrawSafetyProjection(f.text, null, binding, copy + '\n- Independent history.').body,
    '# Account owner\n- Independent history.');
});
