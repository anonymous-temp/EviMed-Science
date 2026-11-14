import assert from 'node:assert/strict';
import test from 'node:test';
import { historyChunks, historySearchText, MemoryHistoryLimitError } from '../src/memoryHistory.mjs';
// a provider-key shape for the masking checks, built at run time so the source holds no credential literal
const FAKE_PROVIDER_KEY = ['sk', 'abcdefghijklmnop' + 'qrstuvwxyz123456'].join('-');

test('history keeps only sanitized user and assistant text with source dates, roles and adjacent turns', () => {
  const chunks = historyChunks([
    { role: 'system', content: 'system instruction' },
    { role: 'user', content: `Kidney project: reach Alice at alice@example.org, token ${FAKE_PROVIDER_KEY}`, created_at: '2026-11-01T10:00:00Z' },
    { role: 'tool', content: 'secret tool result' },
    { role: 'assistant', parts: [{ type: 'text', text: 'I suggest checking the trial design.' }, { type: 'tool_call', text: 'do not keep' }] },
    { role: 'user', content: '<evimed-brief>injected context</evimed-brief>' },
  ]);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0].messages.map(m => m.sourceRole), ['user', 'assistant']);
  assert.equal(chunks[0].messages[0].date, '2026-11-01T10:00:00.000Z');
  assert.equal(chunks[0].messages[1].date, null);
  assert.equal(chunks[0].messages[1].confirmed, false);
  assert.ok(chunks[0].text.includes('alice@example.org'));
  assert.doesNotMatch(chunks[0].text, /abcdefghijklmnopqrstuvwxyz|tool result|injected context|do not keep/);
});

test('exchange chunks are bounded and carry adjacent context without promoting it to confirmed fact', () => {
  const chunks = historyChunks(Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `topic ${i}: ${'x'.repeat(900)}` })));
  assert.ok(chunks.length > 5);
  assert.ok(chunks.every(c => c.text.length <= 6000 && c.messages.length <= 6));
  assert.ok(chunks.every(c => c.messages.every(m => m.contextOnly === true && m.confirmed === false)));
  assert.ok(chunks.some((c, i) => i > 0 && c.messages.some(m => chunks[i - 1].messages.some(p => p.index === m.index))));
});

test('history prose names dates, speaker, link and historical context; unknown time stays unknown', () => {
  const text = historySearchText([{ conversationTitle: 'Kidney trial', conversationUrl: '/app/projects/p?session=session_a', messages: [{ sourceRole: 'assistant', date: null, text: 'Maybe use a crossover design.', contextOnly: true, confirmed: false }] }]);
  assert.match(text, /Kidney trial/); assert.match(text, /assistant/); assert.match(text, /unknown/); assert.match(text, /\/app\/projects/);
  assert.match(text, /context|历史/);
});


test('source-count, fragment and chunk capacity failures have a dedicated local error type', () => {
  const isLimit = limit => error => error instanceof MemoryHistoryLimitError && error.limit === limit;
  assert.throws(() => historyChunks(Array.from({length:1001},()=>({role:'user',content:'A normal message.'}))),isLimit('source_messages'));
  assert.throws(() => historyChunks([{role:'user',content:'界'.repeat(1_800_001)}]),isLimit('fragments'));
  assert.throws(() => historyChunks(Array.from({length:1000},(_,index)=>({role:index%2?'assistant':'user',content:'A normal message.'}))),isLimit('chunks'));
  assert.ok(!(new Error('memory_history_archive_too_large') instanceof MemoryHistoryLimitError));
});

test('forget origin lookup uses the verified owner namespace without inventing a default project', async () => {
  const { MemoryHistory } = await import('../src/memoryHistory.mjs');
  const context = { kind: 'owned', ownerId: 'u1', ownerCreatedAt: '2026-01-01', namespaceId: 'u1', userRoot: 'viking://user/u1' };
  const uri = `${context.userRoot}/memories/preferences/format.md`, searched = [], fenced = [];
  const service = new MemoryHistory({ config: { memoryHistorySearchEnabled: true },
    contexts: { forProject: async () => { throw new Error('memory_scope_denied: no default project'); },
      forUri: async (owner, target) => { assert.equal(owner, 'u1'); assert.equal(target, uri); return context; } },
    ledger: { database: { transaction: async run => run({}), withTransactionClient: async (_client, run) => run() },
      overlay: { originsOf: async () => new Map() }, rejectMessages: async (...args) => fenced.push(args) },
    resolveSource: async () => { throw new Error('no fabricated project source'); },
    resourcesFor: () => ({ searchHistory: async (_owner, root) => { searched.push(root); return []; } }) });
  service.ensureSourceCopies = async () => {};
  await service.rejectRemoved(context, { uri, type: 'preferences' }, ['Use metric units.'], null);
  assert.equal(searched.length, 1); assert.equal(fenced.length, 1);
  assert.match(searched[0], /^viking:\/\/user\/u1\/resources\/history\/[a-f0-9]{24}$/);
  await assert.rejects(service.search({ user: { id: 'u1' }, project: { id: 'missing', userId: 'u1' }, query: 'units' }), /memory_scope_denied/);
});

test('deferred scan reads a bounded frozen archive batch, excludes later restatements and retries without partial completion', async () => {
  const { MemoryHistory } = await import('../src/memoryHistory.mjs');
  const root = 'viking://user/u1', reads = [], finishes = [];
  const scan = { id: 'scan', owner_id: 'u1', owner_created_at: '2026-01-01', namespace_id: 'u1', user_root: root,
    memory_type: 'notes', fingerprint: 'fingerprint', text: 'Use metric units.', cutoff: new Date('2026-11-14'),
    archives: Array.from({ length: 6 }, (_, index) => `${root}/sessions/dsh-${index}/history/archive_001`), cursor: 0, claim: 'lease' };
  let unavailable = true;
  const context = { ownerId: 'u1', ownerCreatedAt: scan.owner_created_at, namespaceId: 'u1', userRoot: root,
    sessions: { read: async (_owner, uri) => { reads.push(uri); return [
      {role:'user',content:'I prefer metric measures.',created_at:'2026-11-01'},
      {role:'user',content:'I prefer metric measures.',created_at:'2026-11-15'},
    ].map(message => JSON.stringify(message)).join('\n'); } } };
  const queued = [scan];
  const ledger = { claimForgetScans: async () => queued.splice(0,1), finishForgetScan: async (...args) => finishes.push(args) };
  const service = new MemoryHistory({ config: {}, ledger, contexts: { forUri: async () => context },
    rejectionJudge: { same: async ({ candidates }) => {
      if (unavailable) throw new Error('offline');
      assert.equal(candidates.length, 1, 'later authorization is outside the frozen withdrawal');
      return { same: new Map([[0,'fingerprint']]) };
    } } });
  await service.drainForgetScans();
  assert.deepEqual(finishes[0], [scan, [], 0, true]);
  unavailable = false; reads.length = 0; queued.push(scan);
  await service.drainForgetScans();
  assert.equal(reads.length, 4);
  assert.equal(finishes[1][1].length, 4);
  assert.equal(finishes[1][2], 4);
  scan.cursor = 4; queued.push(scan);
  await service.drainForgetScans();
  assert.equal(finishes[2][1].length, 2);
  assert.equal(finishes[2][2], 6);
});


test('durable maintenance counts reach worker status and the existing metrics registry', async () => {
  const { MemoryHistory } = await import('../src/memoryHistory.mjs');
  const { nativeMemoryMetricFamilies } = await import('../src/nativeMemoryMetrics.mjs');
  const maintenance = { summary_rebuilds: 2, forget_scans: 3, forget_scan_retries: 1 };
  const service = new MemoryHistory({ config: {}, ledger: { archiveCoverage: async () => ({ maintenance }) } });
  await service.refreshMaintenance();
  assert.deepEqual(service.status().maintenance, maintenance);
  const gauge = nativeMemoryMetricFamilies().find(family => family.name === 'open_science_native_memory_maintenance_pending');
  assert.deepEqual(Object.fromEntries(gauge.series.map(sample => [sample.labels.kind, sample.value])), maintenance);
});

test('late archive discovery is queued before indexing and an unfinished scan keeps its chunks unpublished', async () => {
  const { MemoryHistory } = await import('../src/memoryHistory.mjs');
  const root = 'viking://user/u1', archiveUri = `${root}/sessions/dsh-late/history/archive_001`, calls = [];
  const context = { ownerId: 'u1', ownerCreatedAt: '2026-01-01', namespaceId: 'u1', userRoot: root,
    sessions: { read: async () => JSON.stringify({ role: 'user', content: 'An earlier fact.', created_at: '2026-01-02T00:00:00Z' }) } };
  const ledger = {
    registerWriteMessages: async () => {},
    queueLateForgetArchive: async (...args) => calls.push(args), boundRejections: async () => [],
    startArchive: async () => ({ state: 'queued' }), forgetArchivePending: async () => true,
    finishArchive: async (_commit, _context, state, result) => calls.push({ state, ...result }),
  };
  const service = new MemoryHistory({ config: { memoryHistorySearchEnabled: true, memoryForgetTargetsEnabled: true }, ledger });
  service.indexArchive = async () => { throw new Error('unscanned text must not reach indexing'); };
  assert.deepEqual(await service.ingestArchive({ archiveUri, engineSession: 'dsh-late' }, context), { state: 'queued', reason: 'forget_scan_pending' });
  assert.deepEqual(calls[0], [context, archiveUri, '2026-01-02T00:00:00.000Z']);
  assert.deepEqual(calls[1], { state: 'queued', reason: 'forget_scan_pending' });
});

test('native derived reader withdraws pre-existing copies and inherited paraphrases without deleting undo bytes', async () => {
  const { MemoryHistory } = await import('../src/memoryHistory.mjs');
  const { lineFingerprint } = await import('../src/nativeMemoryOverlay.mjs');
  const statement = 'My old project is M-41633.', uri = 'viking://user/u1/memories/notes/a.md';
  let removed = true;
  const overlay = {removals:async()=>removed?[{fingerprint:lineFingerprint(statement),text:statement,rejectedAt:'2026-01-01'}]:[],
    originsOf:async()=>new Map([[uri,new Map([[lineFingerprint('A derived preference.'),{archiveUri:'old-archive'}]])]])};
  const history = new MemoryHistory({config:{},contexts:{},ledger:{overlay,derivedSourcesRejected:async(_context,refs)=>removed&&refs.archives.includes('old-archive')}});
  const context = {kind:'owned',ownerId:'u1',namespaceId:'u1'};
  const body = `${statement}\nA derived preference.\nAn independent fact.`;
  assert.equal(await history.fenceNativeBody(context,uri,body),'An independent fact.');
  removed = false;
  assert.equal(await history.fenceNativeBody(context,uri,body),body);
});
