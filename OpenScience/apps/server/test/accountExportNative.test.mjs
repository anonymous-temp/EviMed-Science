import assert from 'node:assert/strict';
import test from 'node:test';
import { withAccountExportSnapshot, appendAccountStateArchiveEntry } from '../src/accountExport.mjs';
import { projectNativeMemoryAccountData } from '../src/nativeMemoryAccountExport.mjs';
import { lineFingerprint } from '../src/nativeMemoryOverlay.mjs';
import { userRootUri } from '../src/openVikingLayout.mjs';

const root = userRootUri('owner');
const forgotten = 'PRIVATE WITHDRAWN WORDS 79218';
const uri = `${root}/memories/notes/${forgotten}.md`;
const at = '2026-11-14T00:00:00.000Z';
/** @param {Record<string, unknown>} [patch] */
const revision = (patch = {}) => ({ id: '1', uri, memoryType: 'notes', change: 'updated', actor: 'user',
  reason: 'edited on the memory page', before: 'Editable original', after: 'Editable replacement', changedAt: at, undoneAt: null, ...patch });
/** @param {Record<string, unknown>} [patch] */
const input = (patch = {}) => ({ commits: [], revisions: [], admissions: [], imports: [], rejections: [], ...patch });
/** @param {Parameters<typeof projectNativeMemoryAccountData>[0]} data */
const project = data => projectNativeMemoryAccountData(data, [root]);

test('forget requests and completion receipts carry only facts, dates, kinds and statuses', () => {
  const result = project(input({ commits: [{ createdAt: at, updatedAt: at, state: 'completed', forgetRequests: { state: 'completed',
    requests: [{ quote: forgotten, requestMessage: { at, text: forgotten }, status: 'completed', removed: 1,
      candidates: [{ uri, type: 'notes', text: forgotten }], intents: [forgotten], targetReview: [{ text: forgotten }] }],
    claims: [{ quote: forgotten, message: 2, turnMessage: 0 }], falseClaims: 1 } }] }));
  assert.equal(result.forgetRequests.length, 1);
  assert.deepEqual(result.forgetRequests[0].requests[0], { at, targetKinds: ['notes', 'unstored-intent'], status: 'completed', removed: 1, alreadyRemoved: 0, toolRemoved: 0 });
  assert.equal(result.forgetRequests[0].completionReceipts.length, 1);
  assert.equal(JSON.stringify(result).includes(forgotten), false);
});

test('rejected edit text is withheld while undo receipts and inactive held lines remain', () => {
  const result = project(input({ revisions: [revision(), revision({ id: '2', change: 'deleted', reason: 'forgotten on the memory page', before: forgotten }),
    revision({ id: '3', reason: 'deleted on the memory page', before: forgotten }),
    revision({ id: '4', actor: 'platform', reason: 'rejected_line', before: forgotten }),
    revision({ id: '5', actor: 'platform', reason: 'pasted_instruction_pending', before: `Kept\nHeld instruction\n${forgotten}`, after: 'Kept' }),
    revision({ id: '6', undoneAt: at, before: 'Already undone' }), revision({ id: '7', sourceDeletedText: true, before: forgotten })],
    rejections: [{ memoryType: 'notes', fingerprint: lineFingerprint(forgotten), text: forgotten, origin: 'forget' },
      { memoryType: 'notes', fingerprint: lineFingerprint('Editable original'), text: 'Editable original', origin: 'edit' }] }));
  assert.equal(result.revisions[0].before, '');
  assert.equal(result.revisions[0].undoable, true);
  assert.equal(result.revisions[1].undoable, true);
  for (const index of [1, 2, 3, 5, 6]) assert.equal(result.revisions[index].before, undefined);
  assert.deepEqual(result.revisions[4].heldLines, ['Held instruction']);
  assert.equal(result.revisions[4].inEffect, false);
  assert.equal(JSON.stringify(result).includes(forgotten), false, 'even a filename must not restore withdrawn text');
  assert.equal(project(input({revisions:[revision()]})).revisions[0].before, 'Editable original', 'lifting the edit rejection restores its export without deleting undo data');
});

test('pending admissions and offers carry owned input, terminal and withdrawn rows do not resurrect it', () => {
  const admissions = ['queued', 'submitting', 'pending', 'failed', 'uncertain', 'suspended', 'completed', 'cancelled'].map(state =>
    ({ candidateId: state, revision: 1, state, pendingText: ['completed', 'cancelled'].includes(state) ? forgotten : `Own ${state}`, createdAt: at }));
  admissions.push({ candidateId: 'withdrawn', revision: 1, state: 'pending', pendingText: forgotten, error: 'source_conversation_deleted', createdAt: at });
  const result = project(input({ admissions, imports: [{ id: 'offered', state: 'offered', createdAt: at, statements: [{ text: 'Own import', sensitivity: 'ordinary', ticked: true }] },
    { id: 'saved', state: 'saved', statements: [{ text: forgotten }] }], rejections: [] }));
  assert.equal(result.admissions[0].text, 'Own queued');
  for (const row of result.admissions.slice(6)) assert.equal(row.text, undefined);
  assert.equal(result.imports[0].statements[0].text, 'Own import');
  assert.equal(result.imports[1].statements, undefined);
  assert.equal(JSON.stringify(result).includes(forgotten), false);
});

test('privacy fingerprints redact retained input across categories without exporting the rejection text', () => {
  const result = project(input({ admissions: [{ state: 'queued', pendingText: `Keep this\n${forgotten}` }],
    imports: [{ state: 'offered', statements: [{ text: forgotten }, { text: 'Retained import' }] }],
    revisions: [revision({ before: `Independent edit\n${forgotten}`, after: 'Next edit' })],
    rejections: [{ memoryType: 'profile', fingerprint: lineFingerprint(forgotten), text: forgotten, origin: null }] }));
  assert.equal(result.admissions[0].text, 'Keep this');
  assert.equal(result.imports[0].statements.length, 1);
  assert.equal(result.revisions[0].before, 'Independent edit');
  assert.equal(JSON.stringify(result).includes(forgotten), false);
});

test('source-withdrawn fingerprints also suppress pending inputs, while namespace removals stay exact', () => {
  const projectRoot = 'viking://user/gp-' + 'a'.repeat(24);
  const result = projectNativeMemoryAccountData(input({ revisions: [revision({ uri: `${projectRoot}/memories/notes/one.md` }), revision()],
    admissions: [{ state: 'pending', pendingText: 'Deleted source line' }],
    imports: [{ state: 'offered', statements: [{ text: 'Deleted source line' }] }],
    rejections: [{ memoryType: 'gp-' + 'a'.repeat(24) + ':notes', fingerprint: lineFingerprint('Editable original'), text: 'Editable original', origin: 'forget' }],
    sourceRejections: [{ fingerprint: lineFingerprint('Deleted source line') }] }), [root, projectRoot]);
  assert.equal(result.revisions[0].before, '');
  assert.equal(result.revisions[1].before, 'Editable original', 'project removals must not redact personal input');
  assert.equal(result.admissions[0].text, '');
  assert.deepEqual(result.imports[0].statements, []);
});


test('snapshot assembly budgets and projects every capsule store before handing archive bytes to its caller', async t => {
  const held = input({ commits: [{ createdAt: at, forgetRequests: { state: 'completed', requests: [{ quote: forgotten, status: 'completed', candidates: [{ type: 'notes', text: forgotten }] }], claims: [] } }],
    revisions: [revision(), revision({ id: 'source', sourceDeletedText: false, before: 'SOURCE WITHDRAWN', after: 'SOURCE WITHDRAWN' })],
    admissions: [{ state: 'queued', candidateId: 'own', pendingText: 'My pending input' }],
    imports: [{ state: 'offered', statements: [{ text: 'My offered import' }] }] });
  const nativeRows = { native_commits: held.commits, native_revisions: held.revisions, native_admissions: held.admissions, native_imports: held.imports,
    native_rejections: held.rejections };
  /** @type {[string, unknown[]][]} */
  const queries = [];
  let transactionOpen = false, inSnapshot = false, sourceRedacted = false;
  const client = {
    /** @param {string} sql @param {unknown[]} [values] */
    query: async (sql, values = []) => {
    assert.ok(transactionOpen, 'every snapshot query requires the held transaction');
    queries.push([sql, values]);
    if (sql.startsWith('SELECT count(*)')) return { rows: [{ rows: '1', bytes: '1' }] };
    if (sql.includes('FOR SHARE') && sql.includes('FROM evimed_control.users')) return { rows: [{ id: 'owner', sameGeneration: true, accountCreatedAt: at }] };
    for (const [table, rows] of Object.entries(nativeRows)) if (sql.startsWith('SELECT ') && sql.includes(`FROM evimed_memory.${table} `)) return { rows };
    return { rows: [], rowCount: 0 };
  } };
  const database = {
    /** @param {string} sql @param {unknown[]} [values] */
    query: async (sql, values = []) => {
      if (!transactionOpen) {
        assert.ok(!sql.startsWith('SELECT ') || sql === "SELECT 1 FROM evimed_memory.native_markers WHERE name='project-stamps-v1'"
          || sql === "SELECT to_regclass('evimed_control.projects') IS NOT NULL AS ok", 'snapshot reads cannot run outside the transaction');
        return { rows: [], rowCount: 0 };
      }
      assert.ok(inSnapshot, 'service queries must borrow the snapshot client');
      return client.query(sql, values);
    },
    transaction: async (/** @type {(bound: typeof client) => Promise<unknown>} */ work) => {
      transactionOpen = true;
      try { return await work(client); } finally { transactionOpen = false; }
    },
    withTransactionClient: async (/** @type {typeof client} */ bound, /** @type {() => Promise<unknown>} */ work) => {
      assert.ok(transactionOpen, 'The database client is not owned by this transaction.');
      assert.equal(bound, client, 'The database client is not owned by this transaction.');
      const previous = inSnapshot; inSnapshot = true;
      try { return await work(); } finally { inSnapshot = previous; }
    },
  };
  const readServiceState = async () => {
    assert.ok(inSnapshot && transactionOpen);
    await database.query('SELECT * FROM evimed_source_deletion.conversations WHERE user_id=$1', ['owner']);
  };
  const nativeMemory = { contexts: { all: async () => { await readServiceState(); return [{ userRoot: root }]; }, assertKnown: readServiceState },
    sourceDeletion: { assertAccountExportSafe: readServiceState, historyFingerprints: async () => { await readServiceState(); return new Map(); },
      redactRevisions: async (/** @type {string} */ _owner, /** @type {import("../src/nativeMemoryAccountExport.mjs").NativeExportRow[]} */ rows) => { await readServiceState(); sourceRedacted = true;
        return rows.map(row => row.id === 'source' ? { ...row, before: null, after: null, sourceDeletedText: true } : row); } } };
  const entries = await withAccountExportSnapshot(database, { id: 'owner', accountCreatedAt: at }, {}, async snapshot => {
    assert.ok(transactionOpen, 'archive collection stays inside the account-deletion lock');
    await snapshot.withDatabaseSnapshot(readServiceState);
    return appendAccountStateArchiveEntry([], snapshot.data, {});
  }, { nativeMemory });
  assert.equal(transactionOpen, false);
  await assert.rejects(database.withTransactionClient(client, async () => {}), /not owned by this transaction/);
  const bytes = entries[0].data, state = JSON.parse(bytes.toString());
  for (const section of ['forgetRequests', 'revisions', 'admissions', 'imports']) await t.test(section, () => {
    assert.ok(Array.isArray(state.nativeMemory?.[section]), `${section} is missing from the actual archive entry`);
    assert.ok(state.nativeMemory[section].length > 0, `${section} has no own-content projection`);
  });
  assert.ok(sourceRedacted);
  assert.equal(state.nativeMemory.forgetRequests.length, 1);
  assert.equal(state.nativeMemory.revisions[0].before, 'Editable original');
  assert.equal(state.nativeMemory.admissions[0].text, 'My pending input');
  assert.equal(state.nativeMemory.imports[0].statements[0].text, 'My offered import');
  for (const privateText of [forgotten, 'SOURCE WITHDRAWN']) assert.equal(bytes.includes(Buffer.from(privateText)), false);
  for (const table of Object.keys(nativeRows)) assert.ok(queries.some(([sql]) => sql.startsWith('SELECT count(*)') && sql.includes(`FROM evimed_memory.${table} `)), table);
  for (const [sql, values] of queries.filter(([sql]) => sql.startsWith('SELECT ') && !sql.startsWith('SELECT count(*)') && /FROM evimed_memory.native_(commits|revisions) /.test(sql))) {
    assert.deepEqual(values, ['owner', [root]]);
    assert.ok(sql.includes('user_id=$1') && sql.includes('unnest($2::text[])'));
  }
  await assert.rejects(withAccountExportSnapshot(database, { id: 'owner', accountCreatedAt: at }, {}, async () => {}, { nativeMemory, maxRows: 1 }), { code: 'archive_too_large' });
});

test('AL8 raw account files omit every generated memory projection while retaining conversations and authored files', async () => {
  const {accountMemoryProjection} = await import('../src/accountExport.mjs');
  for (const name of ['workspace/.evimed-brief/memory.md', 'workspace/.evimed-brief/sessions/s/context.md',
    'workspace/.evimed-capsule/profile.md', 'workspace/.evimed-run/state.json']) assert.equal(accountMemoryProjection(name), true, name);
  assert.equal(accountMemoryProjection('workspace/report.md'), false);
  assert.equal(accountMemoryProjection('runtime/container-runtime/dsh-home/sessions/s/session.jsonl'), false);
});
