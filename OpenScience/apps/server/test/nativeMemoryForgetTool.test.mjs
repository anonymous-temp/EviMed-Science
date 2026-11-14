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
  const overlay = { configured: true,
    removalOrigins: async () => [],
    removals: async () => rejections.flatMap(row => row.lines.map(text => ({fingerprint:lineFingerprint(text),text,rejectedAt:'2026-11-14'}))),
    recordInstructionCheck: async () => {}, files: async () => new Map(), originsOf: async () => new Map(),
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

test('alias-scoped duplicate cleanup still removes an exact copy from a different person file', async () => {
  const f = fixture();
  const copied = '王阿姨喜欢散步。', first = `${root}/memories/people/王阿姨.md`, other = `${root}/memories/people/大王阿姨.md`;
  f.files.clear();
  f.files.set(first, `# 王阿姨\n- Confirmed aliases: ["王阿姨","小王阿姨"]\n- ${copied}\n- Likes tea.`);
  f.files.set(other, `# 大王阿姨\n- 大王阿姨喜欢散步。\n- ${copied}`);
  f.store.personAliasHintEnabled = true;
  f.store.rawFiles = async () => [...f.files].filter(([target]) => target.startsWith(`${root}/memories/`))
    .map(([target, text]) => ({ uri: target, body: text, hash: contentHash(text), type: 'people', projectId: null }));
  f.store.files = f.store.rawFiles;
  const file = (await f.store.rawFiles(user.id)).find(row => row.uri === first);
  await f.store.forgetLines(user.id, file, [copied]);
  assert.ok(!f.files.get(other).split('\n').includes(`- ${copied}`), 'the exact withdrawn copy must leave every file');
  assert.match(f.files.get(other), /大王阿姨喜欢散步/);
});

test('FT12 a line kept through a lines forget stays kept after later unrelated forgets; a later removal concerning it still applies', async () => {
  const f = fixture(), receipts = new Map();
  const overlay = /** @type {any} */ (f.store.overlay);
  overlay.recordInstructionCheck = async (/** @type {string} */ _owner, /** @type {string} */ key, /** @type {unknown} */ value, { replace = false } = {}) => {
    if (replace || !receipts.has(key)) receipts.set(key, value);
  };
  overlay.instructionCheck = async (/** @type {string} */ _owner, /** @type {string} */ key) => receipts.get(key) ?? null;
  const metric = lineFingerprint('Use metric units.'), flight = lineFingerprint('My flight was delayed four hours last week.');
  // Model a kept line whose only recorded source is withdrawn whole by the removals in `withdrawing`.
  const withdrawing = new Set([metric]);
  f.ledger.derivedSourcesRejected = async (_context, _refs, { covered = [] } = {}) => [...withdrawing].some(print => !covered.includes(print));
  assert.equal((await f.store.forget(user, project, uri, { lines: ['Use metric units.'] })).removedLines, 1);
  await f.store.forget(user, project, null, { statement: 'My flight was delayed four hours last week.' });
  const context = /** @type {any} */ ({ kind: 'owned', ownerId: user.id });
  assert.equal(await f.store.history.fenceNativeBody(context, uri, f.files.get(uri)), '- Keep answers short.',
    'the person kept this line; an unrelated later forget does not take that decision back');
  withdrawing.add(flight);
  assert.equal(await f.store.history.fenceNativeBody(context, uri, f.files.get(uri)), null, 'a later removal is judged on its own');
});


test('AL8 statement forget physically removes normalized copies without origins and keeps neighbours', async () => {
  const f = fixture();
  f.store.overlay.deferredSummaryRebuildEnabled = true;
  f.store.rawFiles = f.store.files;
  f.ledger.queueMemorySweep = async () => {};
  const other = `${root}/memories/notes/imported.md`;
  f.files.set(other, '- USE metric units. (as of 2026-11-12)\n- I am allergic to penicillin.');
  await f.store.forget(user, project, null, { statement: 'Use metric units.' });
  assert.equal(f.files.get(uri), '- Keep answers short.');
  assert.equal(f.files.get(other), '- I am allergic to penicillin.');
  assert.ok(f.revisions.every(row => /\[act:[a-f0-9]{12}\]/.test(row.reason)), 'one undo act');
});

test('AL8 deferred sweep searches other files, freezes eight candidates, retries and never accepts malformed pairs', async () => {
  const f = fixture();
  f.store.overlay.deferredSummaryRebuildEnabled = true;
  f.store.rawFiles = f.store.files;
  const other = `${root}/memories/notes/legacy.md`;
  f.files.set(other, '- Measures should use the metric system.\n- I am allergic to penicillin.\n'
    + Array.from({length:12}, (_, index) => `- Unrelated neighbour ${index}.`).join('\n'));
  f.store.sessions.find = async () => [{uri:other}];
  f.ledger.saveMemorySweep = async (_scan, sweep) => { saved = structuredClone(sweep); return live; };
  let saved, live = true, calls = 0;
  f.store.history.search = async () => [];
  const act = 'abcdef123456';
  f.rejections.push({lines:['Use metric units.']});
  const scan = {owner_id:'u1',user_root:root,memory_sweep:{act,removed:[lineFingerprint('Use metric units.')],files:[{uri:other,hash:contentHash(f.files.get(other))}]}};
  f.store.rejectionJudge = {same:async request => {
    calls++;
    assert.equal(request.requireAvailable, true);
    assert.ok(request.candidates.length <= 8);
    if (calls === 1) throw new Error('offline');
    return {same:new Map(request.candidates.map((candidate,index) => [index,
      candidate.text.startsWith('Measures') ? lineFingerprint('Use metric units.') : 'unoffered-fingerprint']))};
  }};
  await assert.rejects(f.store.sweepForgottenMemory(scan), /offline/);
  assert.equal(saved.candidates.length, 8);
  assert.match(f.files.get(other), /Measures/);
  scan.memory_sweep = saved;
  await f.store.sweepForgottenMemory(scan);
  assert.doesNotMatch(f.files.get(other), /Measures/);
  assert.match(f.files.get(other), /allergic|neighbour/);
  assert.equal(saved.done, true);
  assert.ok(f.revisions.every(row => row.reason.includes(`[act:${act}]`)));
  live = false;
  await f.store.sweepForgottenMemory(scan);
  assert.equal(calls, 2, 'undo cancels a leased scan before judging');
});

test('AL8 immediate equality cleanup does not hide a paraphrase in the same other file from its deferred sweep', async () => {
  const f = fixture(), other = `${root}/memories/notes/twice.md`;
  f.store.overlay.deferredSummaryRebuildEnabled = true;
  f.store.rawFiles = f.store.files;
  f.store.history.search = async () => [];
  f.store.sessions.find = async () => [{uri:other}];
  f.files.set(other, '- Use metric units.\n- Measures should use the metric system.\n- I am allergic to penicillin.');
  let sweep;
  f.ledger.queueMemorySweep = async (_context, _type, _print, value) => { sweep = structuredClone(value); };
  f.ledger.saveMemorySweep = async () => true;
  await f.store.forget(user,project,null,{statement:'Use metric units.'});
  f.store.rejectionJudge = {same:async request => ({same:new Map(request.candidates.flatMap((candidate,index) =>
    candidate.text.startsWith('Measures') ? [[index,lineFingerprint('Use metric units.')]] : []))})};
  await f.store.sweepForgottenMemory({owner_id:'u1',user_root:root,memory_sweep:sweep});
  assert.equal(f.files.get(other), '- I am allergic to penicillin.');
});

test('AL8 a repeated statement keeps its undo act and a delayed sweep never selects a later file version', async () => {
  const f = fixture(), queued = [], other = `${root}/memories/notes/later.md`;
  f.store.overlay.deferredSummaryRebuildEnabled = true;
  f.store.rawFiles = f.store.files;
  f.store.history.search = async () => [];
  f.store.overlay.revisionsOf = async (_owner, target) => f.revisions.filter(row=>row.uri===target).reverse();
  f.ledger.queueMemorySweep = async (_context,_type,_print,sweep) => queued.push(structuredClone(sweep));
  f.ledger.saveMemorySweep = async () => true;
  f.files.set(other,'- Measures should use the metric system.');
  await f.store.forget(user,project,null,{statement:'Use metric units.'});
  await f.store.forget(user,project,null,{statement:'Use metric units.'});
  assert.equal(queued[0].act,queued[1].act);
  f.files.set(other,'- Measures should use the metric system.\n- A later independent edit.');
  f.store.sessions.find = async () => [{uri:other}];
  f.store.rejectionJudge = {same:async()=>{assert.fail('a later version is outside the frozen withdrawal');}};
  await f.store.sweepForgottenMemory({owner_id:'u1',user_root:root,memory_sweep:queued[1]});
  assert.match(f.files.get(other),/Measures/);
});
