import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeMemoryStore } from '../src/nativeMemoryStore.mjs';
import { contentHash, lineFingerprint } from '../src/nativeMemoryOverlay.mjs';
import { MemoryHistory, MemoryHistoryLedger } from '../src/memoryHistory.mjs';

const user = { id: 'u1' }, project = { id: 'named', userId: user.id };
const root = 'viking://user/u1', uri = `${root}/memories/preferences/format.md`;
const body = '- Use metric units.\n- Keep answers short.';

// The same in-memory sessions/overlay boundary as nativeMemoryReads; no database or model.
function fixture(enabled = true) {
  const files = new Map([[uri, body]]), rejections = [], revisions = [], historyCalls = [];
  const historyRows = [];
  let historyFailure = false, historyWriteFailure = false, inTransaction = false, failScan = 1;
  const database = {
    query: async (sql, values) => {
      assert.match(sql, /INSERT INTO evimed_memory.history_message_rejections/);
      const [owner, , , type, fingerprint] = values;
      // Model the deployed composite FK, including the parent owner and type.
      if (!rejections.some(row => row.owner === owner && row.type === type && row.lines.some(line => lineFingerprint(line) === fingerprint))) {
        throw Object.assign(new Error('history_message_rejections foreign key'), { code: '23503' });
      }
      historyRows.push(values);
      if (historyWriteFailure) throw new Error('history write unavailable');
      return { rows: [] };
    },
    transaction: async operation => {
      const savedRejections = structuredClone(rejections), savedRows = structuredClone(historyRows), savedRevisions = structuredClone(revisions);
      inTransaction = true;
      try { return await operation(database); }
      catch (error) {
        rejections.splice(0, rejections.length, ...savedRejections);
        historyRows.splice(0, historyRows.length, ...savedRows);
        revisions.splice(0, revisions.length, ...savedRevisions);
        throw error;
      } finally { inTransaction = false; }
    },
    withTransactionClient: async (_client, operation) => operation(),
  };
  const sessions = { configured: true, engineUser: () => 'u1', userRoot: () => root, memoryRoot: () => `${root}/memories`,
    read: async (_owner, target) => { assert.equal(inTransaction, false, 'engine reads stay outside the rejection transaction'); return files.get(target) ?? null; },
    replace: async (_owner, target, text) => { files.set(target, text); return true; },
    remove: async (_owner, target) => files.delete(target), rebuildMemoryDirectory: async () => {} };
  const overlay = { configured: true, files: async () => new Map(), originsOf: async () => new Map(),
    reject: async (owner, type, target, lines, options) => rejections.push({ owner, type, uri: target, lines, options }),
    claimForgetIntent: async (owner, type, target, lines) => {
      const fresh = lines.filter(line => !rejections.some(row => row.owner === owner && row.type === type && row.lines.some(prior => lineFingerprint(prior) === lineFingerprint(line))));
      if (fresh.length) rejections.push({ owner, type, uri: target, lines: fresh });
      return fresh;
    },
    addRevision: async row => { revisions.push(row); return { ...row, id: 'revision', changedAt: '2026-11-12' }; },
    queueSummaryInvalidation: async () => [], completeSummaryInvalidation: async () => {},
    upsertFile: async () => {}, setSources: async () => {}, syncOrigins: async () => {}, removeFile: async () => {} };
  const store = new NativeMemoryStore({ sessions, overlay, forgetTargetsEnabled: enabled });
  store.files = async () => [...files].filter(([target]) => target.startsWith(`${root}/memories/`)).map(([target, text]) => ({ uri: target, body: text, hash: contentHash(text), type: 'preferences', projectId: null }));
  const ledger = new MemoryHistoryLedger({ database, overlay });
  ledger.migrate = async () => {};
  ledger.forgetScanPending = async () => false;
  const history = new MemoryHistory({ config: { memoryHistorySearchEnabled: true }, ledger });
  history.ensureSourceCopies = async context => { context.ownerCreatedAt = '2026-01-01'; };
  // The store's legacy context has no owner stamp; model that lookup separately.
  const query = database.query;
  database.query = async (sql, values) => sql.startsWith('SELECT created_at') ? { rows: [{ stamp: '2026-01-01' }] } : query(sql, values);
  history.search = async ({ query: text }) => {
    assert.equal(inTransaction, false, 'history scanning stays outside the rejection transaction');
    historyCalls.push({ lines: [text] });
    if (historyFailure && historyCalls.length === failScan) throw new Error('history unavailable');
    return [{ origin: { archiveUri: `${root}/sessions/dsh-original/history/archive_001` },
      originalMessages: [{ sourceRole: 'user', text }] }];
  };
  history.retireWriteSessions = async () => {};
  history.drainDeletes = async () => {};
  store.history = history;
  store.rejectionJudge = { same: async ({ candidates }) => ({ same: new Set(candidates.map((_row, index) => index)) }) };
  return { store, files, rejections, revisions, historyCalls, historyRows, ledger,
    failHistory: (value, scan = 1) => { historyFailure = value; failScan = scan; }, failHistoryWrite: value => { historyWriteFailure = value; } };
}

test('a failed history scan activates no rejection and leaves a whole-file forget retryable', async () => {
  const f = fixture(); f.failHistory(true);
  await assert.rejects(f.store.forget(user, project, uri), /history unavailable/);
  assert.equal(f.files.get(uri), body);
  assert.deepEqual(f.rejections, []);
  assert.deepEqual(f.revisions, []);
  f.failHistory(false);
  assert.deepEqual(await f.store.forget(user, project, uri), { removed: true });
  assert.equal(f.files.has(uri), false);
  assert.equal(f.revisions.length, 1);
});

test('line forget reuses the edit revision and rejects only exact normalized removed lines', async () => {
  const f = fixture();
  const result = await f.store.forget(user, project, uri, { lines: ['  * USE  metric units. (as of 2026-11-12)'] , engineSession: 'dsh-turn' });
  assert.equal(result.removed, true); assert.equal(result.removedLines, 1);
  assert.equal(f.files.get(uri), '- Keep answers short.');
  assert.deepEqual(f.rejections.flatMap(row => row.lines).map(lineFingerprint), [lineFingerprint('Use metric units.')]);
  assert.deepEqual(f.historyCalls[0].lines, ['Use metric units.']);
  assert.equal(f.revisions[0].before, body); assert.equal(f.revisions[0].after, '- Keep answers short.');
  assert.match(f.revisions[0].reason, /^forgotten in a conversation/); assert.equal(f.revisions[0].actor, 'conversation'); assert.equal(f.revisions[0].engineSession, 'dsh-turn');
});

test('one missing line refuses the entire selection and returns available lines for retry', async () => {
  const f = fixture();
  const result = await f.store.forget(user, project, uri, { lines: ['Use metric units.', 'short answers'] });
  assert.equal(result.removed, false);
  assert.deepEqual(result.missingLines, ['short answers']);
  assert.deepEqual(result.availableLines, ['Use metric units.', 'Keep answers short.']);
  assert.equal(f.files.get(uri), body); assert.deepEqual(f.rejections, []);
});

for (const lines of [undefined, [], ['Use metric units.', 'Keep answers short.']]) {
  test(`whole-file forget still removes every line (${JSON.stringify(lines)})`, async () => {
    const f = fixture();
    assert.equal((await f.store.forget(user, project, uri, { lines })).removed, true);
    assert.equal(f.files.has(uri), false);
  });
}

test('partial removal failure keeps the target and rejection inactive until retry', async () => {
  const f = fixture(); f.failHistory(true);
  await assert.rejects(f.store.forget(user, project, uri, { lines: ['Use metric units.'] }), /history unavailable/);
  assert.equal(f.files.get(uri), body); assert.deepEqual(f.rejections, []);
  f.failHistory(false);
  await f.store.forget(user, project, uri, { lines: ['Use metric units.'] });
  assert.equal(f.files.get(uri), '- Keep answers short.');
});

test('a history-only statement gets the existing rejection and revision, without an engine deletion', async () => {
  const f = fixture();
  const result = await f.store.forget(user, project, null, { statement: 'My old project is M-41633.', engineSession: 'dsh-turn' });
  assert.equal(result.removed, false); assert.equal(result.historyRejected, true);
  assert.deepEqual([...f.files], [[uri, body]]);
  assert.deepEqual(f.rejections[0].lines, ['My old project is M-41633.']);
  assert.equal(f.historyCalls.length, 1); assert.equal(f.revisions[0].engineSession, 'dsh-turn');
  assert.equal(f.revisions[0].change, 'deleted'); assert.match(f.revisions[0].reason, /^forgotten in a conversation/);
});

for (const statement of ['The previous examination was benign.', 'My old project is M-41633.']) {
  test(`an empty history search still activates the undoable statement rejection (${statement})`, async () => {
    const f = fixture();
    f.store.history.search = async ({ query }) => {
      assert.equal(query, statement);
      f.historyCalls.push({ lines: [query] });
      return [];
    };
    f.store.rejectionJudge = { same: async () => { assert.fail('no candidate needs a semantic judgement'); } };
    const result = await f.store.forget(user, project, null, { statement });
    assert.deepEqual(result, { removed: false, historyRejected: true });
    assert.equal(f.historyCalls.length, 1);
    assert.deepEqual(f.rejections[0].lines, [statement]);
    assert.equal(f.revisions.length, 1);
    assert.equal(f.revisions[0].before, statement);
    assert.equal(f.revisions[0].change, 'deleted');
    assert.deepEqual(f.historyRows, [], 'an empty result does not invent a source-message hash');
    assert.deepEqual([...f.files], [[uri, body]]);
  });
}

test('a failed durable scan record rolls back the statement rejection and remains retryable', async () => {
  const f = fixture(); f.failHistory(true);
  f.ledger.queueForgetScan = async () => { throw new Error('history unavailable'); };
  await assert.rejects(f.store.forget(user, project, null, { statement: 'Old project.' }), /history unavailable/);
  assert.deepEqual(f.rejections, []); assert.deepEqual(f.revisions, []);
  f.failHistory(false);
  assert.equal((await f.store.forget(user, project, null, { statement: 'Old project.' })).historyRejected, true);
});

test('targeted forgetting is opt-in and refuses unsupported arguments rather than deleting a whole file', async () => {
  const f = fixture(false);
  for (const [target, options] of [[uri, { lines: ['Use metric units.'] }], [null, { statement: 'Old project.' }]]) {
    await assert.rejects(f.store.forget(user, project, target, options), error => error.code === 'memory_payload_invalid');
  }
  assert.equal(f.files.get(uri), body); assert.deepEqual(f.rejections, []);
  assert.deepEqual(await f.store.forget(user, project, uri), { removed: true });
});

test('targeted forget keeps the existing namespace and live-context checks for files and history statements', async () => {
  const f = fixture();
  const owned = { kind: 'owned', ownerId: user.id, namespaceId: 'own', projectId: project.id };
  const shared = { ...owned, kind: 'geo-project', namespaceId: 'shared', projectId: 'shared' };
  f.store.memoryContexts = { forUri: async () => owned, forProject: async () => shared,
    assertLive: async () => { throw Object.assign(new Error('revoked'), { code: 'memory_scope_denied' }); } };
  owned.sessions = { memoryRoot: () => `${root}/memories` };
  await assert.rejects(f.store.forget(user, { id: 'shared', userId: user.id }, uri, { lines: ['Use metric units.'] }), error => error.code === 'memory_scope_denied');
  await assert.rejects(f.store.forget(user, { id: 'shared', userId: user.id }, null, { statement: 'Old project.', context: shared }), error => error.code === 'memory_scope_denied');
  assert.equal(f.files.get(uri), body); assert.deepEqual(f.rejections, []);
});

test('a wrapped or decorated history statement retains one undoable rejection fingerprint', async () => {
  const f = fixture();
  await f.store.forget(user, project, null, { statement: '- My old\n  project is M-41633.' });
  assert.deepEqual(f.rejections[0].lines, ['My old project is M-41633.']);
  assert.equal(f.revisions[0].before, 'My old project is M-41633.');
});

test('history-only forget cannot claim success without the history service', async () => {
  const f = fixture(); f.store.history = null;
  await assert.rejects(f.store.forget(user, project, null, { statement: 'Old project.' }), error => error.code === 'memory_engine_unavailable');
  assert.deepEqual(f.rejections, []); assert.deepEqual(f.revisions, []);
});


test('the history fake refuses a child hash without its exact rejection parent', async () => {
  const f = fixture();
  await assert.rejects(f.ledger.rejectMessages({ ownerId: user.id, ownerCreatedAt: '2026-01-01', namespaceId: 'u1' },
    'preferences', lineFingerprint('Use metric units.'), [{ archiveUri: `${root}/sessions/dsh-original/history/archive_001`, text: 'Use metric units.' }]),
  error => error.code === '23503');
  assert.deepEqual(f.historyRows, []);
});

test('a later-line scan failure leaves no earlier hash or active rejection, and retry completes', async () => {
  const f = fixture(); f.failHistory(true, 2);
  await assert.rejects(f.store.forget(user, project, uri), /history unavailable/);
  assert.equal(f.historyCalls.length, 2);
  assert.equal(f.files.get(uri), body);
  assert.deepEqual(f.rejections, []); assert.deepEqual(f.historyRows, []); assert.deepEqual(f.revisions, []);
  f.failHistory(false);
  assert.equal((await f.store.forget(user, project, uri)).removed, true);
  assert.equal(f.historyRows.length, 2);
});

for (const [label, target, options] of [
  ['file', uri, {}], ['line', uri, { lines: ['Use metric units.'] }], ['statement', null, { statement: 'Old project.' }],
]) test(`a failed history hash write rolls back its rejection and leaves ${label} forgetting retryable`, async () => {
  const f = fixture(); f.failHistoryWrite(true);
  await assert.rejects(f.store.forget(user, project, target, options), /history write unavailable/);
  assert.equal(f.files.get(uri), body);
  assert.deepEqual(f.rejections, []); assert.deepEqual(f.historyRows, []); assert.deepEqual(f.revisions, []);
  f.failHistoryWrite(false);
  const result = await f.store.forget(user, project, target, options);
  assert.ok(result.removed || result.historyRejected);
  assert.ok(f.historyRows.length > 0); assert.equal(f.revisions.length, 1);
});

test('a heading-only file uses the same fingerprint for its parent rejection and history hashes', async () => {
  const f = fixture(); f.files.set(uri, '# Use metric units.');
  assert.equal((await f.store.forget(user, project, uri)).removed, true);
  assert.ok(f.historyRows.every(row => row[4] === lineFingerprint('Use metric units.')));
});

test('session obligations stay unpersisted on an archive failure and are written with their parent on retry', async () => {
  const f = fixture(), archiveUri = `${root}/sessions/mcp-store-original/history/archive_001`;
  f.ledger.overlay.originsOf = async () => new Map([[uri, new Map([[lineFingerprint('Use metric units.'), { archiveUri }]])]]);
  f.ledger.overlay.commit = async () => ({ sourceSession: 'dsh-source' });
  f.files.set(`${archiveUri}/messages.jsonl`, 'invalid JSON');
  await assert.rejects(f.store.forget(user, project, uri), SyntaxError);
  assert.deepEqual(f.rejections, []); assert.deepEqual(f.historyRows, []); assert.deepEqual(f.revisions, []);
  assert.equal(f.files.get(uri), body);
  f.files.set(`${archiveUri}/messages.jsonl`, JSON.stringify({ role: 'user', content: 'Use metric units.' }));
  assert.equal((await f.store.forget(user, project, uri)).removed, true);
  assert.ok(f.historyRows.some(row => row[5] === `${root}/sessions/dsh-source` && row[6] === lineFingerprint('')));
  assert.ok(f.historyRows.some(row => row[5] === archiveUri && row[6] === lineFingerprint('Use metric units.')));
});


test('a repeated statement and overlapping settle batch record each fingerprint only once', async () => {
  const f = fixture();
  await f.store.forget(user, project, null, { statement: 'My old project is M-41633.' });
  await f.store.forget(user, project, null, { statement: 'My old project is M-41633.' });
  await f.store.recordForgetIntent(user.id, { sessions: { memoryRoot: () => `${root}/memories` } }, null,
    ['My old project is M-41633.', 'The other project is N-49223.']);
  assert.equal(f.revisions.length, 2);
  assert.deepEqual(f.revisions.map(row => row.before), ['My old project is M-41633.', 'The other project is N-49223.']);
  assert.equal(f.rejections.flatMap(row => row.lines).length, 2);
});


test('formatting-only statements are rejected before any privacy mutation', async () => {
  const f = fixture();
  await assert.rejects(f.store.forget(user, project, null, { statement: '# (as of 2026-11-12)' }), error => error.code === 'memory_payload_invalid');
  assert.deepEqual(f.rejections, []); assert.deepEqual(f.revisions, []); assert.deepEqual(f.historyCalls, []);
});

test('unavailable semantic matching records a statement and an undo-bound scan before answering', async () => {
  const f = fixture(), scans = [];
  f.ledger.queueForgetScan = async (context, type, fingerprint) => scans.push({ context, type, fingerprint });
  f.ledger.forgetScanPending = async () => scans.length > 0;
  f.store.rejectionJudge = { same: async () => { throw Object.assign(new Error('unavailable'), { code: 'memory_history_privacy_unavailable' }); } };
  const answer = await f.store.forget(user, project, null, { statement: 'Use metric units.' });
  assert.equal(answer.historyRejected, true);
  assert.equal(answer.historyScanPending, true);
  assert.equal(f.rejections.length, 1);
  assert.equal(f.revisions.length, 1);
  assert.equal(scans.length, 1);
  assert.equal(scans[0].fingerprint, lineFingerprint('Use metric units.'));
  assert.equal(f.files.get(uri), body);
});
