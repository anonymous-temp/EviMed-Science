import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeMemoryStore } from '../src/nativeMemoryStore.mjs';
import { NativeMemoryWorker } from '../src/nativeMemoryWorker.mjs';
import { lineFingerprint } from '../src/nativeMemoryOverlay.mjs';
import { nativeMemoryCounters, resetNativeMemoryMetrics } from '../src/nativeMemoryMetrics.mjs';
const root = 'viking://user/u/memories', uri = `${root}/profile.md`, text = 'I swim on Wednesday evenings.';
function fixture() {
  resetNativeMemoryMetrics();
  const rows = ['1','2'].map(id => ({ id, uri, memoryType: 'profile', before: `- ${text}`, after: null, changedAt: '2026-11-15', pendingFingerprints: new Set([lineFingerprint(text)]), unfoundedFingerprints: new Set([lineFingerprint(text)]) }));
  const files = new Map(), revisions = [], rejected = [];
  const sessions = { configured: true, userRoot: () => 'viking://user/u', memoryRoot: () => root, engineUser: () => 'u',
    read: async (_user, target) => files.get(target) ?? null, replace: async (_user, target, body) => files.set(target, body), remove: async (_user, target) => files.delete(target), rebuildMemoryDirectory: async () => {}, setTags: async () => {} };
  const overlay = { configured: true, pendingCommits: async () => [], forgetRequestCommits: async () => [], files: async () => new Map([...files].map(([key, body]) => [key, { body }])),
    pendingInstructionRevisions: async () => rows.filter(row => !row.undoneAt), unfoundedInstructionRevisions: async () => rows.filter(row => !row.undoneAt),
    revision: async (_user, id) => rows.find(row => row.id === id), markUndone: async (_user, id) => { rows.find(row => row.id === id).undoneAt = 'done'; },
    addRevision: async row => { revisions.push(row); return row; }, upsertFile: async () => {}, syncOrigins: async () => {},
    unreject: async () => { throw Error('automatic recovery must not lift a forget'); }, removals: async () => [], removalOrigins: async () => [],
    queueSummaryInvalidation: async () => [], completeSummaryInvalidation: async () => {},
    resolveInstructionRevision: async (_user, id) => { rows.find(row => row.id === id).undoneAt = 'done'; },
  };
  const store = new NativeMemoryStore({ sessions, overlay, forgetTargetsEnabled: true });
  store.instructionWriteCheck = async (_user, _file, body) => body;
  store.files = async () => [];
  store.recordForgetIntent = async (_user, _context, _archive, lines) => { rejected.push(...lines); return false; };
  store.history = { ledger: { pendingForgetScans: async () => [] } };
  return { store, files, rows, revisions, rejected, sessions, overlay };
}

test('duplicate holds show one pending line', async () => {
  const f = fixture();
  assert.deepEqual((await f.store.pending('u')).map(row => row.text), [text]);
});

test('worker releases no-source holds with one restore and never lifts rejection authority', async () => {
  const f = fixture();
  const worker = new NativeMemoryWorker({ config: {}, sessions: f.sessions, overlay: f.overlay, memorySettings: {}, nativeMemory: f.store });
  await worker.reviewPendingInstructionWrites('u');
  assert.match(f.files.get(uri), /Wednesday/);
  assert.equal(f.revisions.length, 1);
  assert.equal((await f.store.pending('u')).length, 0);
  await worker.reviewPendingInstructionWrites('u');
  assert.equal(f.revisions.length, 1);
  assert.equal(nativeMemoryCounters().pastedInstructionChecks.source_released, 2);
});

for (const targeted of [{ lines: [text] }, { statement: text }]) test(`forget reaches held lines (${Object.keys(targeted)[0]})`, async () => {
  const f = fixture();
  const result = await f.store.forget({ id: 'u' }, { id: 'default', userId: 'u' }, targeted.lines ? uri : null, targeted);
  assert.equal(result.removed, true);
  assert.deepEqual(f.rejected, [text]);
  assert.equal((await f.store.pending('u')).length, 0);
  assert.equal(f.files.size, 0);
});

test('bound remember waits for readable source and retries when the conversation commit arrives', async () => {
  const f = fixture(); let landed = false;
  f.overlay.commitsOfSession = async () => landed ? [{ archiveUri: 'source' }] : [];
  const worker = new NativeMemoryWorker({ config: {}, sessions: f.sessions, overlay: f.overlay, memorySettings: {} });
  worker.verification.readInstructionSources = async (_user, sources) => sources.length ? [{ role: 'user', text }] : [];
  const commit = { userId: 'u', origin: 'tool', sourceSession: 'dsh-native' };
  assert.equal(await worker.instructionSourceReady(commit, { sessions: f.sessions }), false);
  assert.equal(f.files.size, 0);
  landed = true;
  assert.equal(await worker.instructionSourceReady(commit, { sessions: f.sessions }), true);
  assert.equal(await worker.instructionSourceReady({ ...commit, sourceSession: null }, { sessions: f.sessions }), true);
});

test('repair selection requires two keep receipts with no source and refuses conflicting positive evidence', async () => {
  const { unfoundedInstructionKeys } = await import('../src/nativeMemoryOverlay.mjs');
  const key = { uri, fingerprint: lineFingerprint(text) };
  const keep = { pendingKeys: [key], receipts: [{ sources: [], reviews: [[{ decision: 'keep', message: null }], [{ decision: 'keep', message: null }]] }] };
  assert.equal(unfoundedInstructionKeys([keep]).get(uri).has(key.fingerprint), true);
  assert.equal(unfoundedInstructionKeys([{ ...keep, receipts: [{ ...keep.receipts[0], sources: ['real-source'] }] }]).size, 0);
  const positive = { ...keep, receipts: [{ sources: ['real-source'], reviews: [[{ decision: 'material_instruction', message: 0 }], [{ decision: 'keep', message: null }]] }] };
  assert.equal(unfoundedInstructionKeys([keep, positive]).get(uri).size, 0);
});

test('automatic release preserves later live lines and does not restore a forgotten line', async () => {
  const f = fixture(); f.files.set(uri, '- Keep this newer fact.');
  f.overlay.removals = async () => [{ fingerprint: lineFingerprint(text), text, rejectedAt: '2026-11-15' }];
  await f.store.releaseUnfoundedInstructionHolds('u');
  assert.equal(f.files.get(uri), '- Keep this newer fact.');
  assert.equal(f.revisions.length, 0);
  assert.equal((await f.store.pending('u')).length, 0);
});

test('held forget reports unfinished history scans instead of claiming full completion', async () => {
  const f = fixture();
  f.store.recordForgetIntent = async () => true;
  const result = await f.store.forget({ id: 'u' }, { id: 'default', userId: 'u' }, null, { statement: text });
  assert.equal(result.removed, true);
  assert.equal(result.historyScanPending, true);
});
