import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { lineFingerprint } from '../src/nativeMemoryOverlay.mjs';
import { MEMORY_SAFETY_NOTES_ANCHOR as anchor } from '@evimed/domain';
import { MemoryHistory, MemoryHistoryLedger } from '../src/memoryHistory.mjs';
import { ResidentProfiles } from '../src/residentProfile.mjs';
import { createLabResidentProfiles } from '../../../evals/capsule-proving/run/lab.mjs';
import { nativeIntegration } from './helpers/nativeFixture.mjs';
import { nativeFileId } from '../src/nativeMemoryStore.mjs';

const { fixture, options } = nativeIntegration();
const body = (label, note) => `# ${label}\n## Before treatment ${anchor}\n- ${note}\n## Work\n- Private work detail.`;

test('dedicated safety history uses ordinary sensitive, project, source-deletion and owner boundaries', options, async t => {
  const f = await fixture(t);
  for (const name of ['visible', 'sensitive', 'other-project', 'source-deleted']) {
    const text = `# ${name}\nReported history ${name}.`;
    const uri = f.seed(`safety_notes/${name}.md`, text, { type: 'safety_notes' });
    await f.overlay.upsertFile({ userId: f.userId, uri, memoryType: 'safety_notes', body: text,
      sensitive: name === 'sensitive', projectId: name === 'other-project' ? 'another-project' : null });
  }
  f.store.sourceDeletion = {
    hiddenMemoryUris: async () => [`${f.root}/safety_notes/source-deleted.md`],
    redactRecords: async (_id, rows) => rows,
  };
  assert.deepEqual((await f.store.safetyNotes(f.userId, 'default')).map(file => file.relPath).sort(), ['safety_notes/other-project.md', 'safety_notes/visible.md']);
  f.store.sourceDeletion.redactRecords = async (_id, rows) => rows.map(row => ({ ...row, value: '' }));
  assert.deepEqual(await f.store.safetyNotes(f.userId, 'default'), [], 'a raw safety body cannot bypass source redaction');
});

test('P29: native worker settles a dedicated safety file; page edits, undo, deletion and removal fences apply', options, async t => {
  const f = await fixture(t, { config: { memorySafetyNotesEnabled: true } });
  const uri = `${f.root}/safety_notes/child.md`;
  const text = '# Child\n## Extractor chooses this title\n- Child: reported reaction to penicillin S-417.';
  f.stub.extract = () => ({ adds: [{ uri, memory_type: 'safety_notes', after: text }] });
  await f.commitConversation('safety', [{ role: 'user', text, at: '2026-01-01T00:00:00Z' }]);
  await f.worker.processCommits({ userId: f.userId });
  assert.ok(f.sessions.memoryTypes.includes('safety_notes'));
  const page = await f.store.profile(f.userId);
  const record = page.records.find(row => row.uri === uri);
  assert.equal(record.nativeType, 'safety_notes');
  assert.equal(record.kind, 'note');
  assert.equal((await f.store.safetyNotes(f.userId, 'default'))[0].body, text);
  const edited = await f.store.update(f.userId, record.id, { value: '# Child\nReported reaction details corrected.', expectedVersion: record.version });
  assert.equal((await f.store.safetyNotes(f.userId, 'default'))[0].body, edited.value);
  await f.store.undo(f.userId, record.id, { expectedVersion: edited.version });
  assert.equal((await f.store.safetyNotes(f.userId, 'default'))[0].body, text);
  await f.store.remove(f.userId, nativeFileId(uri), { keepText: true, actor: 'user' });
  assert.deepEqual(await f.store.safetyNotes(f.userId, 'default'), []);
  await f.commitConversation('delayed-safety', [{ role: 'user', text, at: '2026-01-01T00:00:00Z' }]);
  await f.worker.processCommits({ userId: f.userId });
  assert.equal(await f.sessions.read(f.userId, uri), null, 'old extraction cannot restore deleted safety history');
  assert.deepEqual(await f.store.safetyNotes(f.userId, 'default'), []);
  assert.ok((await f.overlay.removals(f.userId)).length);
  const forgotten = (await f.store.forgotten(f.userId)).find(row => row.uri === uri);
  await f.store.update(f.userId, forgotten.id, { status: 'active', expectedVersion: forgotten.version });
  assert.equal((await f.store.safetyNotes(f.userId, 'default'))[0].body, text, 'the person can restore the forgotten safety file');
});

test('written people/profile sections reach product and lab resident paths with privacy, deletion and project boundaries intact', options, async t => {
  const f = await fixture(t);
  const bodies = {
    'people/father.md': body('父亲', '用户说青霉素过敏。'),
    'profile.md': body('用户', '用户说阿司匹林后喘息。'),
    'people/private.md': body('Hidden person', 'Hidden safety detail.'),
    'people/deleted.md': body('Deleted person', 'Deleted safety detail.'),
    'people/other.md': body('Other project', 'Other project safety.'),
    'people/colleague.md': '# Colleague\n- Uses spreadsheets.',
  };
  for (const [rel, text] of Object.entries(bodies)) {
    const type = rel === 'profile.md' ? 'profile' : 'people';
    const uri = f.seed(rel, text, { type });
    await f.overlay.upsertFile({ userId: f.userId, uri, memoryType: type, body: text,
      sensitive: rel === 'people/private.md', projectId: rel === 'people/other.md' ? 'other-project' : null });
  }
  f.store.sourceDeletion = {
    hiddenMemoryUris: async () => [`${f.root}/people/deleted.md`],
    redactRecords: async (_id, rows) => rows,
  };
  const config = { ...f.config, memorySafetyNotesEnabled: true };
  const product = new ResidentProfiles({ config, store: f.memorySettings, safetyNotes: (u, p) => f.store.safetyNotes(u, p) });
  const scope = { projectId: 'default', sessionId: null, attended: true };
  const rendered = await product.forDispatch(f.userId, scope);
  assert.match(rendered.text, /父亲.*青霉素过敏/);
  assert.match(rendered.text, /用户.*阿司匹林后喘息/);
  assert.doesNotMatch(rendered.text, /Hidden|Deleted|Other project|Private work|spreadsheets/);
  assert.equal(rendered.memories.length, 2);
  assert.ok(rendered.memories.every(memo => memo.originalSources.length > 0));
  const lab = createLabResidentProfiles({ config, memorySettings: f.memorySettings, nativeMemory: f.store });
  assert.equal((await lab.forDispatch(f.userId, scope)).text, rendered.text, 'lab memory.residentBlock uses the product provider/render path');
  f.store.sourceDeletion.redactRecords = async (_id, rows) => rows.filter(row => row.nativeType !== 'profile')
    .map(row => ({ ...row, value: row.value.replace('用户说青霉素过敏。', '') }));
  assert.equal((await product.forDispatch(f.userId, scope)).text, '', 'redacted safety statements cannot be resurrected from the raw section');
  await f.memorySettings.updateSettings(f.userId, { recallPaused: true });
  assert.equal((await lab.forDispatch(f.userId, scope)).text, '');
});

test('switch off and non-health accounts remain identical through the database-backed store', options, async t => {
  const f = await fixture(t);
  const uri = f.seed('people/colleague.md', '# Colleague\n- Works on reports.', { type: 'people' });
  await f.overlay.upsertFile({ userId: f.userId, uri, memoryType: 'people', body: '# Colleague\n- Works on reports.' });
  const make = enabled => createLabResidentProfiles({ config: { ...f.config, memorySafetyNotesEnabled: enabled }, memorySettings: f.memorySettings, nativeMemory: f.store });
  const scope = { projectId: 'default', sessionId: null };
  assert.equal((await make(true).forDispatch(f.userId, scope)).text, (await make(false).forDispatch(f.userId, scope)).text);
  assert.equal((await make(true).forDispatch(f.userId, scope)).text, '');
  const marked = body('Parent', 'Reported allergy.');
  const markedUri = f.seed('people/parent.md', marked, { type: 'people' });
  await f.overlay.upsertFile({ userId: f.userId, uri: markedUri, memoryType: 'people', body: marked });
  assert.match((await make(true).forDispatch(f.userId, scope)).text, /Reported allergy/);
  assert.equal((await make(false).forDispatch(f.userId, scope)).text, '', 'switch off preserves the pre-safety bytes even with health history');
  let reads = 0;
  const disabled = new ResidentProfiles({ config: { ...f.config, memorySafetyNotesEnabled: false }, store: f.memorySettings,
    safetyNotes: async () => { reads++; throw new Error('must not read'); } });
  assert.equal((await disabled.forDispatch(f.userId, scope)).text, '');
  assert.equal(reads, 0);
});

test('legacy line migration survives retries, travels and follows an exact source withdrawal', options, async t => {
  const f = await fixture(t, { config: { memorySafetyNotesEnabled: true, memorySafetyNotesMigrationEnabled: true, memorySourceEnvelopeEnabled: true } });
  f.store.sourceEnvelopeEnabled = true;
  f.worker.nativeMemory = f.store;
  await f.sessions.setLearning(f.userId, true);
  const source = '# Owner\n- Old reported reaction, only after exposure.\n- A different hobby.';
  const uri = f.seed('people/owner.md', source, { type: 'people', tags: ['project=first'] });
  await f.overlay.upsertFile({ userId: f.userId, uri, memoryType: 'people', projectId: 'first', body: source });
  const statement = 'Old reported reaction, only after exposure.';
  const receipt = { kind: 'user_statement', speaker: 'user', subject: 'self', conditions: 'preserved', personalFact: true };
  await f.overlay.syncOrigins(f.userId, uri, { after: source, origin: { projectId: 'first' },
    statementSources: { [lineFingerprint(statement)]: { lineDigest: createHash('sha256').update(statement).digest('hex'), source: receipt } } });
  let calls = 0;
  f.worker.classifySafety = async (_u, _uri, lines) => { calls++; return lines.includes(source.split('\n')[1]) ? [[2,2]] : []; };
  await Promise.all([f.worker.migrateSafety(f.userId), f.worker.migrateSafety(f.userId)]);
  assert.equal(calls, 1);
  const [copy] = await f.store.safetyNotes(f.userId, 'second');
  assert.equal(copy.sourceUri, uri); assert.equal(copy.type, 'safety_notes');
  assert.deepEqual(copy.statementSources, [{ text: statement, source: receipt }]);
  assert.ok(copy.body.includes('only after exposure')); assert.ok(!copy.body.includes('hobby'));
  await f.store.forgetLines(f.userId, (await f.store.files(f.userId, { uris: [uri] }))[0], ['Old reported reaction, only after exposure.']);
  assert.equal(await f.sessions.read(f.userId, copy.uri), null);
  assert.match(await f.sessions.read(f.userId, uri), /different hobby/);
  // Simulate an old extractor writing the withdrawn words again after cleanup.
  const replay = source + '\n- An unrelated fresh note changes the file digest.';
  await f.sessions.replace(f.userId, uri, replay);
  await f.overlay.upsertFile({ userId: f.userId, uri, memoryType: 'people', body: replay });
  await f.overlay.database.query('UPDATE evimed_memory.native_accounts SET safety_scan_at=NULL WHERE user_id=$1', [f.userId]);
  await f.worker.migrateSafety(f.userId);
  assert.equal(await f.sessions.read(f.userId, copy.uri), null);
  assert.equal(calls, 1);
});

for (const deferred of [false, true]) test('a targeted withdrawal retracts extracted and unindexed safety echoes, deferred=' + deferred, options, async t => {
  const f = await fixture(t, { config: { memorySafetyNotesEnabled: true, memorySafetyNotesMigrationEnabled: true } });
  f.stub.requireExistingBatchRoot = true;
  f.overlay.deferredSummaryRebuildEnabled = deferred;
  f.store.forgetTargetsEnabled = true;
  f.store.history = new MemoryHistory({ config: f.config,
    ledger: new MemoryHistoryLedger({ database: f.database, overlay: f.overlay, client: f.sessions.client }),
    contexts: null, resolveSource: async () => null, eligible: async () => true, admitMessage: async () => true });
  f.worker.nativeMemory = f.store;
  await f.sessions.setLearning(f.userId, true);
  const statement = 'I reported an iohexol allergy.';
  const fresh = 'I reported a latex allergy.';
  const source = '# Owner\n- ' + statement + '\n- I prefer coffee.';
  const uri = f.seed('people/old.md', source, { type: 'people' });
  await f.overlay.upsertFile({ userId: f.userId, uri, memoryType: 'people', body: source });
  f.worker.classifySafety = async (_u, _uri, lines) => lines.includes('- ' + statement) ? [[2,2]] : [];
  await f.worker.migrateSafety(f.userId);
  const [copy] = await f.store.safetyNotes(f.userId, 'second');
  const engineUri = f.root + '/safety_notes/owner.md';
  const echo = 'I had an allergic reaction to iohexol.';
  const judge = { same: async ({ candidates }) => ({ same: new Map(candidates.flatMap((row, i) =>
    row.text === 'Owner\n' + echo
      ? [[i, row.removed[0].fingerprint]] : [])), stated: new Set() }) };
  f.worker.rejectionJudge = judge;
  const mixed = '# Owner\n- ' + fresh + '\n- ' + echo;
  f.stub.extract = () => ({ adds: [{ uri: engineUri, memory_type: 'safety_notes', after: mixed }] });
  await f.commitConversation('latex', [{ role: 'user', text: fresh }], { projectId: 'first' });
  await f.worker.processCommits({ userId: f.userId });
  const origins = (await f.overlay.originsOf(f.userId, [engineUri])).get(engineUri);
  assert.equal(origins.get(lineFingerprint(echo)).sources[0].safetyProjectionUri, copy.uri);
  assert.equal(origins.get(lineFingerprint(fresh)).engineSession, 'dsh-session_latex');
  await f.overlay.upsertFile({ userId: f.userId, uri, memoryType: 'people', sensitive: true });
  assert.ok(!(await f.store.safetyNotes(f.userId, 'second')).some(row => row.uri === engineUri));
  await f.overlay.upsertFile({ userId: f.userId, uri, memoryType: 'people', sensitive: false });
  const unindexed = f.seed('safety_notes/unsettled.md', '# Owner\n- ' + statement, { type: 'safety_notes' });
  const other = f.seed('safety_notes/other.md', '# Other person\n- My sister reported an iohexol reaction.', { type: 'safety_notes' });
  const result = await f.store.forget({ id: f.userId }, { id: 'first' }, uri, { lines: [statement] });
  assert.equal(result.removedLines, 1);
  const resident = createLabResidentProfiles({ config: f.config, memorySettings: f.memorySettings, nativeMemory: f.store });
  for (const repeat of [false, true]) {
    if (repeat) {
      await f.database.query("UPDATE evimed_memory.native_accounts SET safety_scan_at=clock_timestamp()-interval '301 seconds' WHERE user_id=$1", [f.userId]);
      await f.worker.migrateSafety(f.userId);
    }
    assert.equal(await f.sessions.read(f.userId, copy.uri), null);
    assert.equal(await f.sessions.read(f.userId, unindexed), null);
    assert.equal(await f.sessions.read(f.userId, engineUri), '# Owner\n- ' + fresh);
    assert.match(await f.sessions.read(f.userId, other), /iohexol/);
    assert.match(await f.sessions.read(f.userId, uri), /coffee/);
    const opening = await resident.forDispatch(f.userId, { projectId: 'second', sessionId: null, attended: true });
    assert.match(opening.text, /latex/);
    assert.doesNotMatch(opening.text, /iohexol/);
  }
});

test('an interrupted legacy write with no engine bytes loses both orphan rows even after its source disappears', options, async t => {
  const f = await fixture(t, { config: { memorySafetyNotesEnabled: true, memorySafetyNotesMigrationEnabled: true } });
  f.worker.nativeMemory = f.store;
  await f.sessions.setLearning(f.userId, true);
  const uri = f.root + '/safety_notes/legacy-abandoned.md';
  await f.overlay.bindSafetySource(f.userId, uri, { uri: f.root + '/people/departed.md', sourceHash: 'old', lineHashes: [] });
  await f.overlay.inheritOrigins(f.userId, uri, new Map([[lineFingerprint('orphan'), [{ projectId: 'first' }]]]));
  await f.worker.migrateSafety(f.userId);
  assert.equal(await f.overlay.file(f.userId, uri), null);
  assert.equal((await f.overlay.originsOf(f.userId, [uri])).size, 0);
  await f.sessions.ensureTypeDirectory(f.userId, 'safety_notes');
  await f.sessions.ensureTypeDirectory(f.userId, 'safety_notes');
});
